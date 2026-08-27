from __future__ import annotations

import json
import os
import shutil
import sqlite3
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Optional

ROOT = Path(__file__).resolve().parents[1]
RUNS_DIR = Path(os.environ.get("TOSSI_RUNS", ROOT / "work" / "_runs"))
DB_PATH = RUNS_DIR / "runs.db"

VIDEO_FPS = 4
SAMPLE_INTERVAL_S = 1.0

LOG_SNAPSHOT_INTERVAL_S = 60.0

_LOCK = threading.Lock()


def _connect() -> sqlite3.Connection:
    RUNS_DIR.mkdir(parents=True, exist_ok=True)
    cx = sqlite3.connect(DB_PATH, timeout=10)
    cx.row_factory = sqlite3.Row
    cx.execute("PRAGMA journal_mode=WAL")
    cx.execute(
        """CREATE TABLE IF NOT EXISTS runs (
             id           TEXT PRIMARY KEY,
             scene_id     TEXT,
             scene_name   TEXT,
             label        TEXT,
             started      REAL NOT NULL,
             ended        REAL,
             state        TEXT NOT NULL,
             du_config    TEXT,
             params       TEXT,
             summary      TEXT,
             -- Which stack produced this run: 'sim' for a Simulation session.
             kind         TEXT NOT NULL DEFAULT 'sim'
           )"""
    )
    cols = {r["name"] for r in cx.execute("PRAGMA table_info(runs)")}
    if "kind" not in cols:
        cx.execute("ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'sim'")
    cx.execute("CREATE INDEX IF NOT EXISTS runs_started ON runs (started DESC)")
    cx.execute("CREATE INDEX IF NOT EXISTS runs_kind ON runs (kind, started DESC)")
    return cx


def run_dir(run_id: str) -> Path:
    return RUNS_DIR / run_id


def _row_to_dict(r: sqlite3.Row) -> dict:
    d = dict(r)
    for k in ("params", "summary"):
        try:
            d[k] = json.loads(d[k]) if d[k] else {}
        except (TypeError, ValueError):
            d[k] = {}
    d["duration_s"] = round((d["ended"] or time.time()) - d["started"], 1)
    p = run_dir(d["id"])
    d["has_video"] = (p / "movement.mp4").exists()
    d["frames"] = len(list((p / "frames").glob("*.jpg"))) if (p / "frames").is_dir() else 0
    return d


def _write_log_files(d: Path, logs: Optional[dict]) -> list[str]:
    out = []
    for name, lines in (logs or {}).items():
        if not lines:
            continue
        try:
            (d / f"{name}.log").write_text("\n".join(lines) + "\n")
            out.append(name)
        except OSError:
            pass
    return out


def write_logs(run_id: str, sources: dict) -> list[str]:
    getter = (sources or {}).get("logs")
    if not getter:
        return []
    try:
        logs = getter()
    except Exception:
        return []
    d = run_dir(run_id)
    if not d.is_dir():
        return []
    return _write_log_files(d, logs)


class Recorder:

    def __init__(self) -> None:
        self.run_id: Optional[str] = None
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        self._sources: dict = {}

    def is_recording(self) -> bool:
        return self.run_id is not None

    def start(self, run_id: str, sources: dict) -> None:
        self.stop()
        self.run_id = run_id
        self._sources = sources
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=3)
        self._thread = None
        self.run_id = None

    def _loop(self) -> None:
        rid = self.run_id
        if not rid:
            return
        d = run_dir(rid)
        d.mkdir(parents=True, exist_ok=True)
        seen_kpi: set = set()
        seen_seq: set = set()
        next_logs = 0.0
        while not self._stop.is_set():
            if time.monotonic() >= next_logs:
                next_logs = time.monotonic() + LOG_SNAPSHOT_INTERVAL_S
                write_logs(rid, self._sources)
            try:
                kpi = (self._sources.get("kpi") or dict)()
                with (d / "kpi.jsonl").open("a") as f:
                    for ue in kpi.get("ues", []):
                        for s in ue.get("samples", []):
                            key = (s.get("ue"), s.get("t"))
                            if key in seen_kpi or not s.get("t"):
                                continue
                            seen_kpi.add(key)
                            f.write(json.dumps(s) + "\n")
            except Exception:
                pass
            try:
                sample = (self._sources.get("ue_sinr") or dict)()
                if sample:
                    sample["t"] = time.time()
                    with (d / "ue_kpi.jsonl").open("a") as f:
                        f.write(json.dumps(sample) + "\n")
            except Exception:
                pass
            try:
                live = (self._sources.get("live") or dict)()
                with (d / "telemetry.jsonl").open("a") as f:
                    for s in live.get("samples", []):
                        if s.get("seq") in seen_seq:
                            continue
                        seen_seq.add(s["seq"])
                        f.write(json.dumps(s) + "\n")
            except Exception:
                pass
            self._stop.wait(SAMPLE_INTERVAL_S)


RECORDER = Recorder()


def open_run_id() -> Optional[str]:
    with _connect() as cx:
        r = cx.execute(
            "SELECT id FROM runs WHERE state='recording' ORDER BY started DESC LIMIT 1"
        ).fetchone()
    return r[0] if r else None


def close_orphans() -> list[str]:
    closed = []
    with _connect() as cx:
        rows = cx.execute("SELECT id FROM runs WHERE state='recording'").fetchall()
    for (rid,) in rows:
        if RECORDER.run_id == rid and RECORDER.is_recording():
            continue
        try:
            stop_run(rid, {})
            closed.append(rid)
        except Exception:                 # noqa: BLE001 - one bad row must not block the rest
            continue
    return closed


def start_run(scene_id: Optional[str], scene_name: Optional[str], label: Optional[str],
              du_config: Optional[str], params: dict, sources: dict) -> dict:
    rid = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    d = run_dir(rid)
    (d / "frames").mkdir(parents=True, exist_ok=True)
    with _LOCK, _connect() as cx:
        cx.execute(
            "INSERT INTO runs (id, scene_id, scene_name, label, started, state, du_config,"
            " params, summary, kind) VALUES (?,?,?,?,?,?,?,?,?,?)",
            (rid, scene_id, scene_name, label, time.time(), "recording", du_config,
             json.dumps(params or {}), json.dumps({}), "sim"),
        )
    RECORDER.start(rid, sources)
    return {"id": rid, "state": "recording"}


def add_frame(run_id: str, data: bytes) -> int:
    d = run_dir(run_id) / "frames"
    if not d.is_dir():
        raise FileNotFoundError(run_id)
    n = len(list(d.glob("*.jpg")))
    (d / f"{n:05d}.jpg").write_bytes(data)
    return n + 1


def _series(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out = []
    for line in path.read_text(errors="ignore").splitlines():
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


def _make_video(d: Path) -> Optional[str]:
    frames = sorted((d / "frames").glob("*.jpg"))
    if len(frames) < 2 or not shutil.which("ffmpeg"):
        return None
    out = d / "movement.mp4"
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(VIDEO_FPS),
             "-i", str(d / "frames" / "%05d.jpg"),
             "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-pix_fmt", "yuv420p",
             str(out)],
            timeout=180, check=True, capture_output=True,
        )
        return out.name
    except Exception:
        return None


def stop_run(run_id: str, logs: dict, extra: Optional[dict] = None) -> dict:
    d = run_dir(run_id)
    if not d.is_dir():
        raise FileNotFoundError(run_id)
    if RECORDER.run_id == run_id:
        RECORDER.stop()

    _write_log_files(d, logs)

    kpi = _series(d / "kpi.jsonl")
    tel = _series(d / "telemetry.jsonl")

    def _stat(vals: list[float]) -> Optional[dict]:
        vals = [v for v in vals if v is not None]
        if not vals:
            return None
        return {"min": round(min(vals), 1), "max": round(max(vals), 1),
                "avg": round(sum(vals) / len(vals), 1), "n": len(vals)}

    summary = {
        "kpi_samples": len(kpi),
        "telemetry_samples": len(tel),
        "rsrp_db": _stat([s.get("rsrp_db") for s in kpi]),
        "snr_db": _stat([s.get("snr_db") for s in kpi]),
        "gain_db": _stat([s.get("gain_db") for s in tel]),
        "paths": _stat([s.get("paths") for s in tel]),
        "logs": sorted(p.stem for p in d.glob("*.log")),
    }
    if extra:
        summary.update(extra)
    video = _make_video(d)
    summary["video"] = video
    summary["frames"] = len(list((d / "frames").glob("*.jpg")))

    with _LOCK, _connect() as cx:
        cx.execute("UPDATE runs SET ended=?, state=?, summary=? WHERE id=?",
                   (time.time(), "complete", json.dumps(summary), run_id))
    return {"id": run_id, "state": "complete", "summary": summary}


def list_runs(limit: int = 50, kind: Optional[str] = None) -> list[dict]:
    n = max(1, min(500, limit))
    with _connect() as cx:
        if kind:
            rows = cx.execute(
                "SELECT * FROM runs WHERE kind=? ORDER BY started DESC LIMIT ?",
                (kind, n)).fetchall()
        else:
            rows = cx.execute("SELECT * FROM runs ORDER BY started DESC LIMIT ?",
                              (n,)).fetchall()
    return [_row_to_dict(r) for r in rows]


def count_runs() -> dict:
    with _connect() as cx:
        rows = cx.execute("SELECT kind, COUNT(*) AS n FROM runs GROUP BY kind").fetchall()
    return {r["kind"] or "sim": r["n"] for r in rows}


def get_run(run_id: str) -> Optional[dict]:
    with _connect() as cx:
        r = cx.execute("SELECT * FROM runs WHERE id=?", (run_id,)).fetchone()
    if not r:
        return None
    d = _row_to_dict(r)
    p = run_dir(run_id)
    d["kpi"] = _series(p / "kpi.jsonl")
    d["telemetry"] = _series(p / "telemetry.jsonl")
    return d


def read_log(run_id: str, source: str) -> Optional[list[str]]:
    if not source.isalnum():
        return None
    p = run_dir(run_id) / f"{source}.log"
    if not p.exists():
        return None
    return p.read_text(errors="ignore").splitlines()


def delete_run(run_id: str) -> bool:
    with _connect() as cx:
        cur = cx.execute("DELETE FROM runs WHERE id=?", (run_id,))
        gone = cur.rowcount > 0
    shutil.rmtree(run_dir(run_id), ignore_errors=True)
    return gone
