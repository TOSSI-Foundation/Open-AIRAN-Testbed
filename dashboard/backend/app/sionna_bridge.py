from __future__ import annotations

import asyncio
import base64
import json
import bisect
import math
import os
import queue
import re
import shutil
import subprocess
import signal
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable, Optional

from fastapi import Depends, APIRouter, File, Request, UploadFile
from fastapi.responses import JSONResponse, Response

_ZMQ_BIND = re.compile(r"^tcp://[\w.\-]+:\d{1,5}$")

from .auth import require_user  # noqa: E402

router = APIRouter(prefix="/api/map", tags=["sionna-map"],
                   dependencies=[Depends(require_user)])

DASH_DIR = Path(__file__).resolve().parents[2]
REPO = DASH_DIR.parent


def _resolve_module_dir() -> Path:
    env = os.environ.get("TOSSI_SIONNA_MAP")
    candidates = [Path(env)] if env else []
    candidates += [DASH_DIR / "sionna-map", REPO / "sionna-map"]
    for c in candidates:
        if (c / "scene_builder" / "build_scene.py").exists():
            return c.resolve()
    return (DASH_DIR / "sionna-map").resolve()


MODULE = _resolve_module_dir()
SCENE_BUILDER = MODULE / "scene_builder"
WORK = Path(os.environ.get("TOSSI_WORK_DIR", DASH_DIR / "backend" / "work"))
WORK.mkdir(parents=True, exist_ok=True)


def _resolve_live_channel() -> Optional[Path]:
    env = os.environ.get("TOSSI_LIVE_CHANNEL")
    candidates = [Path(env)] if env else []
    candidates += [REPO / "OCUDU-RAN" / "utils" / "sionna" / "live_channel.py"]
    for c in candidates:
        if c.exists():
            return c.resolve()
    return None


LIVE_CHANNEL = _resolve_live_channel()

FLATTEN_CHANNEL = (LIVE_CHANNEL.parent / "flatten_channel.py") if LIVE_CHANNEL else None

_DEFAULT_DU_DIRS = os.pathsep.join([
    str(REPO.parent / "rfsim_stack" / "OCUDU-RAN" / "configs"),
    str(REPO / "OCUDU-RAN" / "configs"),
])
DU_CONFIG_DIRS = [Path(p) for p in os.environ.get(
    "TOSSI_DU_CONFIG_DIRS", _DEFAULT_DU_DIRS).split(os.pathsep) if p]

MODELS_DIR = Path(os.environ.get("TOSSI_MODELS_DIR", WORK / "_models"))
MODELS_DIR.mkdir(parents=True, exist_ok=True)
MODEL_SUFFIXES = {".ply", ".obj", ".glb", ".gltf", ".stl", ".dae", ".zae",
                  ".off", ".3mf", ".step", ".stp", ".ifc"}
COMPANION_SUFFIXES = {".bin", ".png", ".jpg", ".jpeg", ".webp", ".ktx2"}
MAX_MODEL_BYTES = int(os.environ.get("TOSSI_MAX_MODEL_MB", "64")) * 1024 * 1024

SIONNA_PY = os.environ.get("TOSSI_SIONNA_PYTHON", os.path.expanduser("~/sionna-rt-env/bin/python3"))

BUILD_TIMEOUT = int(os.environ.get("TOSSI_BUILD_TIMEOUT", "600"))
TRACE_TIMEOUT = int(os.environ.get("TOSSI_TRACE_TIMEOUT", "900"))
COVERAGE_TIMEOUT = int(os.environ.get("TOSSI_COVERAGE_TIMEOUT", "1800"))


def _sionna_ready() -> bool:
    return os.path.exists(SIONNA_PY) and (SCENE_BUILDER / "build_scene.py").exists()


MAX_LOG_LINES = 400
MAX_JOBS = 100


class Job:

    def __init__(self, kind: str, scene_id: Optional[str], label: str):
        self.id = f"job_{uuid.uuid4().hex[:10]}"
        self.kind = kind
        self.scene_id = scene_id
        self.label = label
        self.state = "queued"
        self.pct = 0
        self.message = "Queued"
        self.log: deque[str] = deque(maxlen=MAX_LOG_LINES)
        self.result: Any = None
        self.error: Optional[str] = None
        self.created = time.time()
        self.started: Optional[float] = None
        self.ended: Optional[float] = None
        self.done_event = threading.Event()
        self.cancelled = False
        self.proc: Optional[subprocess.Popen] = None
        self._lock = threading.Lock()

    def cancel(self) -> bool:
        with self._lock:
            if self.state in ("done", "failed", "cancelled"):
                return False
            self.cancelled = True
            proc = self.proc
        if proc and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
        return True

    def emit(self, line: str) -> None:
        line = line.rstrip("\n")
        if not line:
            return
        with self._lock:
            self.log.append(line)
            self.message = line[:200]

    def set(self, *, pct: Optional[int] = None, message: Optional[str] = None) -> None:
        with self._lock:
            if pct is not None:
                self.pct = max(0, min(100, pct))
            if message is not None:
                self.message = message

    def elapsed(self) -> float:
        end = self.ended if self.ended else time.time()
        return round(end - self.started, 2) if self.started else 0.0

    def to_dict(self, with_log: bool = True) -> dict:
        with self._lock:
            d = {
                "job_id": self.id, "kind": self.kind, "scene_id": self.scene_id,
                "label": self.label, "state": self.state, "pct": self.pct,
                "message": self.message, "error": self.error, "result": self.result,
                "created": self.created, "elapsed_s": self.elapsed(),
            }
            if with_log:
                d["log"] = list(self.log)
        return d


_jobs: "dict[str, Job]" = {}
_jobs_order: deque = deque(maxlen=MAX_JOBS)
_jobs_lock = threading.Lock()
_job_queue: "queue.Queue[tuple[Job, Callable[[Job], Any]]]" = queue.Queue()


def _worker_loop() -> None:
    while True:
        job, fn = _job_queue.get()
        if job.cancelled:
            job.state = "cancelled"
            job.set(message="Cancelled before it started")
            job.ended = time.time()
            job.done_event.set()
            _job_queue.task_done()
            continue
        job.state = "running"
        job.started = time.time()
        job.set(pct=5, message="Starting…")
        try:
            job.result = fn(job)
            job.state = "done"
            job.set(pct=100)
        except Exception as exc:  # noqa: BLE001 — surfaced to the UI verbatim
            if job.cancelled:
                job.state = "cancelled"
                job.set(message="Cancelled")
            else:
                job.state = "failed"
                job.error = str(exc)[:4000]
                job.set(message=f"Failed: {str(exc)[:160]}")
        finally:
            job.ended = time.time()
            job.done_event.set()
            _job_queue.task_done()


_worker = threading.Thread(target=_worker_loop, name="sionna-jobs", daemon=True)
_worker.start()


def submit(kind: str, label: str, fn: Callable[[Job], Any], scene_id: Optional[str] = None) -> Job:
    job = Job(kind, scene_id, label)
    with _jobs_lock:
        _jobs[job.id] = job
        if len(_jobs_order) == _jobs_order.maxlen and _jobs_order:
            _jobs.pop(_jobs_order[0], None)
        _jobs_order.append(job.id)
    job.set(message=f"Queued ({_job_queue.qsize()} ahead)" if _job_queue.qsize() else "Queued")
    _job_queue.put((job, fn))
    return job


def _stream(job: Job, cmd: list[str], timeout: int, on_line: Optional[Callable[[str], None]] = None) -> str:
    proc = subprocess.Popen(
        cmd, cwd=str(SCENE_BUILDER),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, bufsize=1,
    )
    job.proc = proc
    out_chunks: list[str] = []

    def pump_err() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            job.emit(line)
            if on_line:
                on_line(line)

    err_thread = threading.Thread(target=pump_err, daemon=True)
    err_thread.start()

    deadline = time.time() + timeout
    try:
        for line in proc.stdout:  # type: ignore[union-attr]
            out_chunks.append(line)
            job.emit(line)
            if on_line:
                on_line(line)
            if time.time() > deadline:
                proc.kill()
                raise TimeoutError(f"stage exceeded {timeout}s")
        proc.wait(timeout=max(1, int(deadline - time.time())))
    except subprocess.TimeoutExpired:
        proc.kill()
        raise TimeoutError(f"stage exceeded {timeout}s") from None
    finally:
        err_thread.join(timeout=2)
        job.proc = None

    if job.cancelled:
        raise RuntimeError("cancelled")
    if proc.returncode != 0:
        tail = "\n".join(list(job.log)[-12:])
        raise RuntimeError(f"exited with code {proc.returncode}.\n{tail}")
    return "".join(out_chunks)


def _scene_dir(scene_id: str) -> Optional[Path]:
    if not scene_id or scene_id.startswith("_") or not re.fullmatch(r"[A-Za-z0-9._-]+", scene_id):
        return None
    d = (WORK / scene_id).resolve()
    if d.parent != WORK.resolve() or not d.is_dir():
        return None
    return d


def _read_meta(d: Path) -> dict:
    try:
        return json.loads((d / "meta.json").read_text())
    except Exception:
        return {}


def _write_meta(d: Path, **fields: Any) -> dict:
    meta = _read_meta(d)
    meta.update(fields)
    (d / "meta.json").write_text(json.dumps(meta, indent=2))
    return meta


def _scene_summary(d: Path) -> dict:
    meta = _read_meta(d)
    scene_xml = d / "scene" / "scene.xml"

    if not meta.get("city") and (d / "package.json").exists():
        try:
            pkg = json.loads((d / "package.json").read_text())
            backfill = {"scene_id": d.name, "created": d.stat().st_mtime, **_package_stats(pkg)}
            if scene_xml.exists():
                backfill["state"] = "built"
                backfill["nof_meshes"] = len(list((d / "scene" / "meshes").glob("*.ply")))
            if (d / "coverage.json").exists() and "coverage_stats" not in meta:
                backfill["coverage_stats"] = json.loads((d / "coverage.json").read_text()).get("stats")
            meta = _write_meta(d, **backfill)
        except Exception:
            pass

    meta.update({
        "scene_id": d.name,
        "built": scene_xml.exists(),
        "has_coverage": (d / "coverage.json").exists(),
        "has_package": (d / "package.json").exists(),
    })
    meta.pop("coverage_overlay", None)
    return meta


def _package_stats(pkg: dict) -> dict:
    manifest = pkg.get("manifest", pkg) or {}
    buildings = (pkg.get("buildings") or {}).get("features", []) if isinstance(pkg, dict) else []
    nodes = manifest.get("nodes", []) or []
    bbox = manifest.get("bbox") or {}
    return {
        "city": manifest.get("city"),
        "nof_buildings": len(buildings),
        "nof_gnb": sum(1 for n in nodes if n.get("type") in ("gnb", "tower")),
        "nof_ue": sum(1 for n in nodes if n.get("type") == "ue"),
        "size_m": bbox.get("size_m"),
        "origin_lonlat": (manifest.get("crs") or {}).get("origin_lonlat"),
        "nof_edits": len(manifest.get("building_edits", []) or []),
    }


@router.get("/health")
def health() -> dict:
    return {
        "available": _sionna_ready(),
        "python": SIONNA_PY,
        "module": str(MODULE),
        "scene_builder": str(SCENE_BUILDER),
        "work_dir": str(WORK),
        "live_channel": str(LIVE_CHANNEL) if LIVE_CHANNEL else None,
        "live_available": bool(LIVE_CHANNEL) and _sionna_ready(),
        "models_dir": str(MODELS_DIR),
        "du_config_dirs": [str(d) for d in DU_CONFIG_DIRS],
        "nof_du_configs": len(_du_paths()),
        "max_taps": 64,
        "max_model_mb": MAX_MODEL_BYTES // 1024 // 1024,
        "queue_depth": _job_queue.qsize(),
    }


@router.post("/build")
async def build(req: Request):
    body = await _json(req)
    pkg = body.get("package") or (body if ("manifest" in body or "crs" in body) else None)
    if not pkg:
        return _bad("empty body — expected a Scene Package")
    if not _sionna_ready():
        return _bad(f"Sionna python not found at {SIONNA_PY}. Set TOSSI_SIONNA_PYTHON.", 503)

    stats = _package_stats(pkg)
    fetch_overture = bool(body.get("fetch_overture", False))
    if stats["nof_buildings"] == 0 and not fetch_overture:
        return _bad("This area has no buildings. Zoom in until buildings render and draw the "
                    "area box over them — or enable 'fetch from Overture' to pull complete "
                    "footprints server-side.")
    if fetch_overture and not (pkg.get("manifest", pkg) or {}).get("bbox"):
        return _bad("fetching from Overture needs a drawn area (the manifest has no bbox)")
    site = (pkg.get("manifest", pkg) or {}).get("site") or None
    site_dir = None
    if site:
        site_dir = _site_dir(site.get("id") if isinstance(site, dict) else None)
        if site_dir is None:
            return _bad(f"this scene uses the site model '{(site or {}).get('id')}', which is not "
                        f"on this server (expected {SITES_DIR}/<id>/site.json)")
    vegetation = bool(body.get("vegetation", True)) and site_dir is not None \
        and (site_dir / "trees.json").is_file()

    scene_id = time.strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]
    d = WORK / scene_id
    d.mkdir(parents=True, exist_ok=True)
    (d / "package.json").write_text(json.dumps(pkg))
    _write_meta(d, scene_id=scene_id, created=time.time(), state="building", **stats)

    try:
        min_area = _bounded(body, "min_area", 8.0, 0.0, 100_000.0, float)
    except ValueError as exc:
        return _bad(str(exc))
    ground = str(body.get("ground_material", "very_dry_ground"))
    if ground not in VALID_GROUND:
        return _bad(f"unknown ground material '{ground}'; expected one of {sorted(VALID_GROUND)}")
    terrain = bool(body.get("terrain", False))

    _apply_gnb_configs(d)
    cmd = [SIONNA_PY, "-u", str(SCENE_BUILDER / "build_scene.py"), str(d / "package.json"),
           "--out", str(d / "scene"), "--build",
           "--min-area", str(min_area), "--ground-material", ground,
           "--models-dir", str(MODELS_DIR)]
    if terrain:
        cmd.append("--terrain")
    if fetch_overture:
        cmd.append("--fetch-overture")
    if site_dir is not None:
        cmd += ["--site-dir", str(site_dir)]
    if vegetation:
        cmd.append("--vegetation")

    def work(job: Job) -> dict:
        job.set(pct=15, message="Fetching footprints from Overture…" if fetch_overture
                else f"Extruding {stats['nof_buildings']} buildings…")
        _stream(job, cmd, BUILD_TIMEOUT)
        scene_xml = d / "scene" / "scene.xml"
        if not scene_xml.exists():
            raise RuntimeError("build finished but scene.xml was not produced")
        nof_meshes = len(list((d / "scene" / "meshes").glob("*.ply")))
        extruded = _grep_int(job.log, r"buildings extruded\s*:\s*(\d+)")
        skipped = _grep_int(job.log, r"skipped \(tiny/replaced/bad\):\s*(\d+)")
        res = {"scene_id": scene_id, "scene_xml": str(scene_xml), "nof_meshes": nof_meshes,
               "buildings_extruded": extruded, "buildings_skipped": skipped,
               "min_area": min_area, "ground_material": ground, "terrain": terrain,
               "fetch_overture": fetch_overture,
               "custom_models": _grep_int(job.log, r"custom models\s*:\s*(\d+)"),
               "site": site_dir.name if site_dir is not None else None,
               "vegetation": vegetation,
               "trees": _grep_int(job.log, r"trees\s*:\s*(\d+)")}
        _write_meta(d, state="built", built_at=time.time(), **res)
        job.set(message=f"Scene built — {extruded} buildings, {nof_meshes} meshes")
        return res

    job = submit("build", f"Build scene ({stats['nof_buildings']} buildings)", work, scene_id)
    return await _job_response_async(job, body, extra={"scene_id": scene_id})


@router.post("/trace")
async def trace(req: Request):
    body = await _json(req)
    d = _scene_dir(body.get("scene_id", ""))
    if not d or not (d / "scene" / "scene.xml").exists():
        return _bad("unknown scene_id (build first)", 404)
    if not _sionna_ready():
        return _bad("Sionna environment unavailable", 503)

    du_path = _resolve_du(body.get("du_config", ""))
    du = _parse_du(du_path) if du_path else {}
    try:
        srate = float(body.get("srate") or du.get("srate_hz") or 61.44e6)
        max_depth = _bounded(body, "max_depth", 5, 0, 10, int)
    except ValueError as exc:
        return _bad(str(exc))
    if not 1e5 <= srate <= 1e10:
        return _bad(f"srate {srate} Hz is out of range")

    _apply_gnb_configs(d)
    sp = sionna_params(d)
    cmd = [SIONNA_PY, "-u", str(SCENE_BUILDER / "run_scene.py"), str(d / "package.json"),
           "--scene", str(d / "scene" / "scene.xml"),
           "--srate", str(srate), "--json"] + _solver_flags({**sp, "max_depth": max_depth})
    if body.get("tx") not in (None, ""):
        cmd += ["--tx", str(body["tx"])]
    route_step = None
    if body.get("route_step_m") not in (None, ""):
        try:
            route_step = _bounded(body, "route_step_m", 25.0, 5.0, 200.0, float)
        except ValueError as exc:
            return _bad(str(exc))
        cmd += ["--route-step-m", str(route_step)]

    def work(job: Job) -> dict:
        job.set(pct=20, message="Loading scene and ray tracing…")
        out = _stream(job, cmd, TRACE_TIMEOUT)
        try:
            res = json.loads(out.strip().splitlines()[-1])
        except Exception as exc:
            raise RuntimeError(f"could not parse trace result: {exc}") from None
        if route_step is not None:
            tmp = d / "route_trace.json.tmp"
            tmp.write_text(json.dumps(res))
            os.replace(tmp, d / "route_trace.json")
            _write_meta(d, route_traced_at=time.time(), route_step_m=route_step)
            n = len((res.get("route") or {}).get("points") or [])
            job.set(message=f"Traced the route — {n} positions")
            return {"route_traced": True, "positions": n, "route": res.get("route")}
        _write_meta(d, trace=res, traced_at=time.time())
        gains = ", ".join(f"{l['ue']} {l['gain_db']:.1f} dB" for l in res.get("links", []))
        job.set(message=f"Traced — {gains}" if gains else "Traced")
        return res

    job = submit("trace", "Ray-trace link budget", work, d.name)
    return await _job_response_async(job, body)


@router.post("/coverage")
async def coverage(req: Request):
    body = await _json(req)
    d = _scene_dir(body.get("scene_id", ""))
    if not d or not (d / "scene" / "scene.xml").exists():
        return _bad("unknown scene_id (build first)", 404)
    if not _sionna_ready():
        return _bad("Sionna environment unavailable", 503)

    out = d / "coverage.json"
    try:
        samples = _bounded(body, "samples", 300_000, 1_000, 100_000_000, int)
        cell_size = _bounded(body, "cell_size", 5.0, 0.5, 100.0, float)
        max_depth = _bounded(body, "max_depth", 3, 0, 10, int)
        vmin = _bounded(body, "vmin", -140.0, -300.0, 0.0, float)
        vmax = _bounded(body, "vmax", -60.0, -300.0, 0.0, float)
    except ValueError as exc:
        return _bad(str(exc))
    if vmin >= vmax:
        return _bad(f"vmin ({vmin}) must be below vmax ({vmax})")

    size_m = (_read_meta(d).get("size_m") or [0, 0])
    if size_m and size_m[0] and size_m[1]:
        cells = (float(size_m[0]) / cell_size) * (float(size_m[1]) / cell_size)
        if cells > 4_000_000:
            return _bad(f"cell size {cell_size} m over a {int(size_m[0])}×{int(size_m[1])} m scene "
                        f"means {int(cells):,} cells. Use a larger cell size or a smaller area.")
    _apply_gnb_configs(d)
    sp = sionna_params(d)
    cmd = [SIONNA_PY, "-u", str(SCENE_BUILDER / "coverage.py"), str(d / "package.json"),
           "--scene", str(d / "scene" / "scene.xml"), "--out", str(out),
           "--samples", str(samples), "--cell-size", str(cell_size),
           "--vmin", str(vmin), "--vmax", str(vmax)] + _solver_flags(
               {**sp, "max_depth": max_depth}, for_coverage=True) + [
           "--rr-depth", str(sp["rr_depth"]), "--rr-prob", str(sp["rr_prob"])] + (
           ["--stop-threshold", str(sp["stop_threshold"])] if sp.get("stop_threshold") is not None else [])

    def work(job: Job) -> dict:
        job.set(pct=15, message=f"Solving radio map ({samples:,} samples/tx)…")
        _stream(job, cmd, COVERAGE_TIMEOUT)
        if not out.exists():
            raise RuntimeError("coverage finished but no overlay was written")
        overlay = json.loads(out.read_text())
        st = overlay.get("stats", {})
        _write_meta(d, coverage_stats=st, coverage_at=time.time(),
                    coverage_params={"samples": samples, "cell_size": cell_size,
                                     "max_depth": max_depth, "vmin": vmin, "vmax": vmax})
        job.set(message=f"Coverage — {st.get('covered_cells')}/{st.get('total_cells')} cells")
        return {"scene_id": d.name, "stats": st, "overlay": overlay}

    job = submit("coverage", f"Coverage map ({samples:,} samples)", work, d.name)
    return await _job_response_async(job, body)


@router.post("/jobs/{job_id}/cancel")
def job_cancel(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return _bad("unknown job_id", 404)
    return {"ok": True, "cancelled": job.cancel(), "state": job.state}


@router.get("/jobs")
def jobs():
    with _jobs_lock:
        ids = list(_jobs_order)
    return [_jobs[i].to_dict(with_log=False) for i in reversed(ids) if i in _jobs]


@router.get("/jobs/{job_id}")
def job_detail(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return _bad("unknown job_id", 404)
    return job.to_dict()


@router.get("/scenes")
def scenes():
    out = []
    for d in sorted(WORK.iterdir(), reverse=True):
        if d.is_dir() and not d.name.startswith("_"):
            out.append(_scene_summary(d))
    return out


@router.get("/scenes/{scene_id}")
def scene_detail(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    return _scene_summary(d)


@router.get("/scenes/{scene_id}/package")
def scene_package(scene_id: str):
    d = _scene_dir(scene_id)
    if not d or not (d / "package.json").exists():
        return _bad("unknown scene_id", 404)
    return json.loads((d / "package.json").read_text())


@router.get("/scenes/{scene_id}/config")
def scene_config(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    meta = _read_meta(d)
    return {
        "ok": True,
        "scene_id": scene_id,
        "name": meta.get("name"),
        "du_config": meta.get("du_config"),
        "overrides": meta.get("config_overrides", {}),
    }


@router.post("/scenes/{scene_id}/config")
async def scene_config_set(scene_id: str, req: Request):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)
    fields: dict = {}
    if "du_config" in body:
        fields["du_config"] = body["du_config"]
    if "overrides" in body:
        fields["config_overrides"] = body["overrides"] or {}
    if "name" in body:
        name = str(body.get("name") or "").strip()
        if len(name) > 80:
            return _bad("name is too long (80 characters)")
        fields["name"] = name or None
    if not fields:
        return _bad("nothing to set (send name, du_config and/or overrides)")
    _write_meta(d, **fields)
    return {"ok": True, "scene_id": scene_id, **fields}


@router.get("/scenes/{scene_id}/route-trace")
def scene_route_trace(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    f = d / "route_trace.json"
    if not f.is_file():
        return _bad("no route trace for this scene yet", 404)
    return json.loads(f.read_text())


@router.get("/scenes/{scene_id}/coverage")
def scene_coverage(scene_id: str):
    d = _scene_dir(scene_id)
    if not d or not (d / "coverage.json").exists():
        return _bad("no coverage for this scene", 404)
    return {"ok": True, "scene_id": scene_id, "overlay": json.loads((d / "coverage.json").read_text())}


@router.post("/scenes/{scene_id}/snapshot")
async def scene_snapshot_set(scene_id: str, req: Request):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)
    src = str(body.get("image") or "")
    if "," in src:
        src = src.split(",", 1)[1]
    try:
        raw = base64.b64decode(src, validate=True)
    except Exception:
        return _bad("image must be a base64 data URL")
    if not raw:
        return _bad("empty image")
    if len(raw) > 4_000_000:
        return _bad("snapshot is too large (4 MB)")
    is_jpeg = raw[:3] == b"\xff\xd8\xff"
    is_png = raw[:8] == b"\x89PNG\r\n\x1a\n"
    if not (is_jpeg or is_png):
        return _bad("snapshot must be a JPEG or PNG image")
    (d / ("snapshot.png" if is_png else "snapshot.jpg")).write_bytes(raw)
    stale = d / ("snapshot.jpg" if is_png else "snapshot.png")
    if stale.exists():
        try:
            stale.unlink()
        except OSError:
            pass
    _write_meta(d, snapshot_at=time.time())
    return {"ok": True, "scene_id": scene_id, "bytes": len(raw)}


@router.get("/scenes/{scene_id}/thumb")
def scene_thumb(scene_id: str, metric: str = "rss"):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)

    for _name, _mime in (("snapshot.jpg", "image/jpeg"), ("snapshot.png", "image/png")):
        snap = d / _name
        if snap.exists():
            try:
                return Response(content=snap.read_bytes(), media_type=_mime,
                                headers={"Cache-Control": "no-cache"})
            except OSError:
                break

    if not (d / "coverage.json").exists():
        return _bad("no coverage or snapshot for this scene", 404)
    try:
        cov = json.loads((d / "coverage.json").read_text())
    except (OSError, ValueError) as exc:
        return _bad(f"could not read the overlay: {exc}", 500)
    images = cov.get("images") or {}
    uri = images.get(metric) or cov.get("image") or images.get("rss") or images.get("path_gain")
    if not isinstance(uri, str) or "," not in uri:
        return _bad("this scene's overlay carries no image", 404)
    try:
        raw = base64.b64decode(uri.split(",", 1)[1])
    except Exception:
        return _bad("the overlay image could not be decoded", 500)
    return Response(content=raw, media_type="image/png",
                    headers={"Cache-Control": "public, max-age=300"})


@router.delete("/scenes/{scene_id}")
def scene_delete(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    if LIVE.scene_id == scene_id and LIVE.is_running():
        return _bad("this scene is streaming a live channel — stop it first", 409)
    shutil.rmtree(d, ignore_errors=True)
    return {"ok": True, "deleted": scene_id}


def _du_paths() -> list[Path]:
    out: list[Path] = []
    for d in DU_CONFIG_DIRS:
        if d.is_dir():
            out += sorted(p for p in d.iterdir()
                          if p.suffix in (".yml", ".yaml") and p.name.startswith("du"))
    return out


def _resolve_du(path_str: str) -> Optional[Path]:
    if not path_str:
        return None
    p = Path(path_str).resolve()
    for d in DU_CONFIG_DIRS:
        try:
            if p.is_file() and p.is_relative_to(d.resolve()):
                return p
        except (AttributeError, ValueError):
            if p.is_file() and str(p).startswith(str(d.resolve())):
                return p
    return None


def _parse_du(path: Path) -> dict:
    try:
        p = subprocess.run(
            [SIONNA_PY, str(SCENE_BUILDER / "orchestrate.py"), "--du-config", str(path), "--json"],
            cwd=str(SCENE_BUILDER), capture_output=True, text=True, timeout=30)
        if p.returncode == 0 and p.stdout.strip():
            return json.loads(p.stdout.strip().splitlines()[-1])
    except Exception:
        pass
    return {}


@router.get("/du-configs")
def du_configs():
    out = []
    for p in _du_paths():
        du = _parse_du(p)
        out.append({
            "path": str(p), "name": p.name,
            "srate_hz": du.get("srate_hz"), "bw_mhz": du.get("bw_mhz"),
            "dl_arfcn": du.get("dl_arfcn"), "dl_freq_hz": du.get("dl_freq_hz"),
            "live_bind": du.get("live_bind"),
            "sionna_driver": "sionna" in p.read_text(errors="ignore") if p.is_file() else False,
            "readable": bool(du),
        })
    return out


def _scene_cfg_dir(d: Path) -> Path:
    return d / "configs"


def _resolve_cfg(path_str: str) -> Optional[Path]:
    p = _resolve_du(path_str)
    if p is not None:
        return p
    if not path_str:
        return None
    q = Path(path_str).resolve()
    try:
        rel = q.relative_to(WORK.resolve())
    except ValueError:
        return None
    if len(rel.parts) != 3 or rel.parts[1] != "configs" or q.suffix.lower() not in (".yml", ".yaml"):
        return None
    return q if q.is_file() else None


@router.post("/scenes/{scene_id}/gnb-config")
async def scene_gnb_config(scene_id: str, req: Request):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)
    node = str(body.get("node_id", "")).strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,32}", node):
        return _bad("node_id must be plain (letters, digits, dash, underscore)")
    base = _resolve_cfg(str(body.get("base", ""))) or _resolve_du(str(_read_meta(d).get("du_config") or ""))
    if base is None:
        paths = _du_paths()
        base = paths[0] if paths else None
    if base is None:
        return _bad("no DU config to copy from — set one for this scene first", 400)
    cfg_dir = _scene_cfg_dir(d)
    cfg_dir.mkdir(parents=True, exist_ok=True)
    dest = cfg_dir / f"du_{node}.yaml"
    created = not dest.exists()
    if created:
        dest.write_text(base.read_text(errors="replace"))
    return {"ok": True, "scene_id": scene_id, "node_id": node, "path": str(dest),
            "name": dest.name, "created": created, "copied_from": str(base)}


@router.get("/scenes/{scene_id}/du-configs")
def scene_du_configs(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    out = du_configs()
    cfg_dir = _scene_cfg_dir(d)
    if cfg_dir.is_dir():
        for p in sorted(cfg_dir.iterdir()):
            if p.suffix.lower() not in (".yml", ".yaml"):
                continue
            du = _parse_du(p)
            out.append({
                "path": str(p), "name": p.name,
                "node_id": p.stem[3:] if p.stem.startswith("du_") else None,
                "scene_local": True,
                "srate_hz": du.get("srate_hz"), "bw_mhz": du.get("bw_mhz"),
                "dl_arfcn": du.get("dl_arfcn"), "dl_freq_hz": du.get("dl_freq_hz"),
                "live_bind": du.get("live_bind"),
                "sionna_driver": "sionna" in p.read_text(errors="ignore"),
                "readable": bool(du),
            })
    return out


def _cell_from_cfg(path: Path) -> dict:
    du = _parse_du(path)
    if not du:
        return {}
    out: dict = {}
    if du.get("dl_freq_hz"):
        out["freq_hz"] = float(du["dl_freq_hz"])
    if du.get("bw_mhz"):
        out["bw_mhz"] = float(du["bw_mhz"])
    if du.get("srate_hz"):
        out["srate_hz"] = float(du["srate_hz"])
    try:
        import yaml as _yaml
        doc = _yaml.safe_load(path.read_text(errors="replace")) or {}
        cell = doc.get("cell_cfg") or {}
        if cell.get("nof_antennas_dl"):
            out["antennas_dl"] = int(cell["nof_antennas_dl"])
        if cell.get("band"):
            out["band"] = int(cell["band"])
        if cell.get("pci") is not None:
            out["pci"] = int(cell["pci"])
    except Exception:
        pass
    return out


def _node_key(n: dict) -> str:
    nid = str(n.get("id") or "").strip()
    if nid:
        return nid
    name = str(n.get("name") or "")
    return name.rsplit("-", 1)[-1] if "-" in name else name


def _apply_gnb_configs(d: Path) -> list:
    pkg_path = d / "package.json"
    cfg_dir = _scene_cfg_dir(d)
    if not pkg_path.is_file() or not cfg_dir.is_dir():
        return []
    try:
        pkg = json.loads(pkg_path.read_text())
    except Exception:
        return []
    manifest = pkg.get("manifest", pkg)
    applied = []
    changed = False
    for n in manifest.get("nodes", []):
        if n.get("type") not in ("gnb", "tower"):
            continue
        cfg = cfg_dir / f"du_{_node_key(n)}.yaml"
        if not cfg.is_file():
            continue
        cell = _cell_from_cfg(cfg)
        if not cell:
            continue
        rf = n.setdefault("rf", {})
        if cell.get("freq_hz"):
            rf["freq_hz"] = cell["freq_hz"]
            changed = True
        if cell.get("band"):
            rf["band"] = cell["band"]
            changed = True
        if cell.get("antennas_dl"):
            rf.setdefault("array", {})
            rf["array"]["rows"] = 1
            rf["array"]["cols"] = int(cell["antennas_dl"])
            changed = True
        rf["config_file"] = cfg.name
        applied.append({"node": _node_key(n), "config": cfg.name, **cell})
    if changed:
        pkg_path.write_text(json.dumps(pkg))
    return applied


SIONNA_DEFAULTS: dict = {
    "max_depth": 5,
    "los": True,
    "specular_reflection": True,
    "diffuse_reflection": True,
    "refraction": True,
    "diffraction": True,
    "edge_diffraction": True,
    "array_pattern": "tr38901",
    "array_pol": "V",
    "array_rows": None,
    "array_cols": None,
    "rx_pattern": "iso",
    "rx_pol": "V",
    "freq_hz": None,
    "num_taps": None,
    "max_drop_db": 45.0,
    "normalize": True,
    "normalize_delays": True,
    "samples_per_src": 1000000,
    "max_num_paths_per_src": 1000000,
    "synthetic_array": True,
    "seed": 42,
    "rr_depth": -1,
    "rr_prob": 0.95,
    "stop_threshold": None,
}

_SIONNA_BOOL = {"los", "specular_reflection", "diffuse_reflection", "refraction",
                "diffraction", "edge_diffraction", "normalize", "normalize_delays",
                "synthetic_array"}
_SIONNA_INT = {"max_depth", "array_rows", "array_cols", "num_taps", "samples_per_src",
               "max_num_paths_per_src", "seed", "rr_depth"}
_SIONNA_FLOAT = {"max_drop_db", "rr_prob", "stop_threshold", "freq_hz"}
_SIONNA_STR = {"array_pattern", "array_pol", "rx_pattern", "rx_pol"}
_PATTERNS = {"iso", "dipole", "hw_dipole", "tr38901"}
_POLS = {"V", "H", "VH", "cross"}


def sionna_params(d: Path) -> dict:
    out = dict(SIONNA_DEFAULTS)
    stored = _read_meta(d).get("sionna") or {}
    for k, v in stored.items():
        if k in out:
            out[k] = v
    return out


_ITU_BANDS_GHZ = {
    "concrete": (1.0, 100.0), "brick": (1.0, 40.0), "plasterboard": (1.0, 100.0),
    "wood": (0.001, 100.0), "glass": (0.1, 100.0), "ceiling_board": (1.0, 100.0),
    "chipboard": (1.0, 100.0), "plywood": (1.0, 40.0), "marble": (1.0, 60.0),
    "floorboard": (50.0, 100.0), "metal": (1.0, 100.0),
    "very_dry_ground": (1.0, 10.0), "medium_dry_ground": (1.0, 10.0),
    "wet_ground": (1.0, 10.0),
}


def _scene_freq_limits(d) -> tuple:
    try:
        xml = (d / "scene" / "scene.xml").read_text(errors="ignore")
    except Exception:
        return 1.0, 10.0, "ground material"
    import re as _re
    lo, hi, who = 0.0, 1e9, None
    for n in set(_re.findall(r'<bsdf[^>]*id="([a-z_]+)"', xml)):
        band = _ITU_BANDS_GHZ.get(n)
        if not band:
            continue
        lo = max(lo, band[0])
        if band[1] < hi:
            hi, who = band[1], n
    if who is None:
        return 1.0, 10.0, "ground material"
    return lo, hi, who


def _clean_sionna(body: dict, scene_dir=None):
    out: dict = {}
    for k, v in body.items():
        if k not in SIONNA_DEFAULTS:
            return f"unknown setting '{k}'"
        if v is None:
            out[k] = None
            continue
        try:
            if k in _SIONNA_BOOL:
                out[k] = bool(v)
            elif k in _SIONNA_INT:
                out[k] = int(v)
            elif k in _SIONNA_FLOAT:
                out[k] = float(v)
            elif k in _SIONNA_STR:
                out[k] = str(v)
        except (TypeError, ValueError):
            return f"'{k}' is not a valid value"
    if out.get("array_pattern") and out["array_pattern"] not in _PATTERNS:
        return f"array_pattern must be one of {sorted(_PATTERNS)}"
    if out.get("rx_pattern") and out["rx_pattern"] not in _PATTERNS:
        return f"rx_pattern must be one of {sorted(_PATTERNS)}"
    if out.get("array_pol") and out["array_pol"] not in _POLS:
        return f"array_pol must be one of {sorted(_POLS)}"
    if out.get("rx_pol") and out["rx_pol"] not in _POLS:
        return f"rx_pol must be one of {sorted(_POLS)}"
    if out.get("max_depth") is not None and not (0 <= out["max_depth"] <= 10):
        return "max_depth must be 0..10 (every solve stage clamps to 10)"
    if out.get("num_taps") is not None and not (1 <= out["num_taps"] <= 64):
        return "num_taps must be 1..64 (the DU wire format caps at 64)"
    if out.get("max_drop_db") is not None and not (0 <= out["max_drop_db"] <= 200):
        return "max_drop_db must be 0..200"
    if out.get("freq_hz"):
        f_ghz = float(out["freq_hz"]) / 1e9
        if not (0.001 <= f_ghz <= 1000.0):
            return "carrier must be 0.001..1000 GHz (0 means take it from the gNB config)"
        if scene_dir is not None:
            lo, hi, who = _scene_freq_limits(scene_dir)
            if not (lo <= f_ghz <= hi):
                return (f"carrier {f_ghz:g} GHz is outside {lo:g}-{hi:g} GHz, the range "
                        f"ITU-R P2040 defines '{who}' over. This scene is built from that "
                        f"material, so Sionna cannot solve it at {f_ghz:g} GHz.")
    for k in ("array_rows", "array_cols"):
        if out.get(k) is not None and not (1 <= out[k] <= 8):
            return f"{k} must be 1..8"
    if out.get("rr_depth") is not None and not (-1 <= out["rr_depth"] <= 10):
        return ("rr_depth must be -1..10 (-1 lets Sionna choose; above max_depth's own "
                "limit of 10 the roulette depth can never be reached)")
    if out.get("rr_prob") is not None and not (0.0 <= out["rr_prob"] <= 1.0):
        return "rr_prob must be 0..1 - it is the probability a weak ray survives"
    for k in ("samples_per_src", "max_num_paths_per_src"):
        if out.get(k) is not None and not (1_000 <= out[k] <= 100_000_000):
            return f"{k} must be 1000..100000000"
    return out


@router.get("/scenes/{scene_id}/sionna")
def scene_sionna(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    return {"ok": True, "scene_id": scene_id, "params": sionna_params(d),
            "defaults": SIONNA_DEFAULTS}


@router.post("/scenes/{scene_id}/sionna")
async def scene_sionna_set(scene_id: str, req: Request):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)
    if body.get("reset"):
        _write_meta(d, sionna={})
        return {"ok": True, "scene_id": scene_id, "params": sionna_params(d)}
    cleaned = _clean_sionna({k: v for k, v in body.items() if k != "reset"}, scene_dir=d)
    if isinstance(cleaned, str):
        return _bad(cleaned)
    stored = dict(_read_meta(d).get("sionna") or {})
    stored.update(cleaned)
    _write_meta(d, sionna=stored)
    return {"ok": True, "scene_id": scene_id, "params": sionna_params(d)}


def _solver_flags(p: dict, for_coverage: bool = False) -> list:
    out = ["--max-depth", str(p["max_depth"])]
    for key, flag in (("los", "los"), ("specular_reflection", "specular"),
                      ("diffuse_reflection", "diffuse"), ("refraction", "refraction"),
                      ("diffraction", "diffraction"), ("edge_diffraction", "edge-diffraction")):
        out.append(f"--{flag}" if p.get(key) else f"--no-{flag}")
    out += ["--array-pattern", str(p["array_pattern"]), "--array-pol", str(p["array_pol"]),
            "--rx-pattern", str(p["rx_pattern"]), "--rx-pol", str(p["rx_pol"]),
            "--seed", str(p["seed"])]
    if not for_coverage:
        out += ["--samples-per-src", str(p["samples_per_src"]),
                "--max-paths-per-src", str(p["max_num_paths_per_src"])]
    if not p.get("synthetic_array"):
        out.append("--no-synthetic-array")
    for k, flag in (("array_rows", "--array-rows"), ("array_cols", "--array-cols"),
                    ("freq_hz", "--freq-hz"), ("num_taps", "--num-taps")):
        if p.get(k) is not None:
            out += [flag, str(p[k])]
    return out


UE_FIXED = {"band": 78, "freq_hz": 3489420000.0, "numerology": 1, "sst": 1, "dnn": "oai"}

def _default_cpus() -> tuple:
    n = os.cpu_count() or 0
    if n < 12:
        return "", ""
    top = n - 1
    return f"7-{top - 2}", f"{top - 1}-{top}"


_DEF_UE_CPUS, _DEF_PROXY_CPUS = _default_cpus()

UE_DEFAULTS: dict = {
    "n_ues": 1,
    "n_rb": None,
    "sd": 16777215,
    "imsi_base": "001010000000002",
    "key": "fec86ba6eb707ed08905757b1bb44b8f",
    "opc": "C42449363BBAD02B66D16BC975D77CC1",
    "ssb_scan": None,
    "ssb": 0,
    "tq_sampling": False,
    "ue_cpus": _DEF_UE_CPUS,
    "proxy_cpus": _DEF_PROXY_CPUS,
    "ue_rt_prio": None,
    "stagger_s": 1.5,
    "move": "static",
    "speed_mps": 1.4,
    "loop_route": True,
}

_PRB = {
    15: {5: 25, 10: 52, 15: 79, 20: 106, 25: 133, 30: 160, 40: 216, 50: 270},
    30: {5: 11, 10: 24, 15: 38, 20: 51, 25: 65, 30: 78, 40: 106, 50: 133,
         60: 162, 70: 189, 80: 217, 90: 245, 100: 273},
    60: {10: 11, 15: 18, 20: 24, 25: 31, 30: 38, 40: 51, 50: 65, 60: 79,
         70: 93, 80: 107, 90: 121, 100: 135},
}


def prb_for(bw_mhz, scs_khz):
    try:
        return _PRB[int(scs_khz)][int(bw_mhz)]
    except (KeyError, TypeError, ValueError):
        return None


UE_DERIVED = ("imsi_base", "sd", "key", "opc", "ue_cpus", "proxy_cpus")


def ue_params(d: Path) -> dict:
    out = dict(UE_DEFAULTS)
    stored = _read_meta(d).get("ue") or {}
    for k, v in stored.items():
        if k in out and k not in UE_DERIVED:
            out[k] = v
    ue_cpus, proxy_cpus = _default_cpus()
    out["ue_cpus"], out["proxy_cpus"] = ue_cpus, proxy_cpus
    return out


def _du_cell_of_scene(d: Path) -> dict:
    meta = _read_meta(d)
    p = _resolve_cfg(str(meta.get("du_config") or ""))
    if p is None:
        paths = _du_paths()
        p = paths[0] if paths else None
    if p is None:
        return {}
    cell = _cell_from_cfg(p)
    try:
        import yaml as _yaml
        doc = _yaml.safe_load(p.read_text(errors="replace")) or {}
        scs = (doc.get("cell_cfg") or {}).get("common_scs")
        if scs:
            cell["scs_khz"] = int(scs)
    except Exception:
        pass
    cell["config"] = p.name
    return cell


def _path_len(points) -> float:
    return round(sum(
        math.dist(points[i], points[i + 1]) for i in range(len(points) - 1)), 1)


def _scene_route(d: Path):
    try:
        pkg = json.loads((d / "package.json").read_text())
    except (OSError, ValueError):
        return []
    manifest = pkg.get("manifest", pkg)
    for n in manifest.get("nodes", []) or []:
        if n.get("type") != "ue":
            continue
        pts = n.get("route_points_enu")
        if isinstance(pts, list) and len(pts) >= 2:
            return [[float(v) for v in p] for p in pts]
        r = n.get("route_enu")
        if isinstance(r, dict) and r.get("start") and r.get("end"):
            return [[float(v) for v in r["start"]], [float(v) for v in r["end"]]]
    return []


def walk_route(points, steps: int):
    pts = [[float(v) for v in q] for q in points]
    if len(pts) < 2:
        return pts[:1]
    seg = [math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)]
    total = sum(seg)
    if total <= 0:
        return pts[:1]
    cum, acc = [0.0], 0.0
    for s in seg:
        acc += s
        cum.append(acc)
    n = max(2, int(steps))
    out = []
    for i in range(n):
        d = total * i / (n - 1)
        j = min(bisect.bisect_right(cum, d) - 1, len(seg) - 1)
        j = max(j, 0)
        t = (d - cum[j]) / seg[j] if seg[j] > 0 else 0.0
        out.append([round(pts[j][k] + t * (pts[j + 1][k] - pts[j][k]), 2) for k in range(3)])
    return out


def ue_effective(d: Path) -> dict:
    p = ue_params(d)
    cell = _du_cell_of_scene(d)
    derived = prb_for(cell.get("bw_mhz"), cell.get("scs_khz"))
    n_rb = int(p["n_rb"]) if p.get("n_rb") else (derived or 106)
    ssb_scan = p["ssb_scan"]
    if ssb_scan is None:
        ssb_scan = 0 if n_rb == 51 else 1
    carrier_mismatch = bool(cell.get("freq_hz")
                            and abs(float(cell["freq_hz"]) - UE_FIXED["freq_hz"]) > 1e6)
    route = _scene_route(d)
    stored = _read_meta(d).get("ue") or {}
    implied = "move" not in stored and len(route) >= 2
    move_eff = "route" if implied else p["move"]
    return {
        **p,
        "move_effective": move_eff,
        "move_implied": implied,
        "route_points": len(route),
        "route_len_m": _path_len(route),
        "n_rb_effective": n_rb,
        "n_rb_derived": derived,
        "ssb_scan_effective": int(bool(ssb_scan)),
        "cell": cell,
        "fixed": UE_FIXED,
        "carrier_mismatch": carrier_mismatch,
    }


_UE_INT = {"n_ues", "n_rb", "sd", "ssb", "ue_rt_prio", "ssb_scan"}
_UE_STR = {"imsi_base", "key", "opc", "ue_cpus", "proxy_cpus", "move"}


def _clean_ue(body: dict):
    out: dict = {}
    for k, v in body.items():
        if k not in UE_DEFAULTS:
            return f"unknown setting '{k}'"
        if k in UE_DERIVED:
            continue
        if v is None or v == "":
            out[k] = None if k not in _UE_STR else ""
            continue
        try:
            if k in _UE_INT:
                out[k] = int(v)
            elif k in ("stagger_s", "speed_mps"):
                out[k] = float(v)
            elif k in ("tq_sampling", "loop_route"):
                out[k] = bool(v)
            else:
                out[k] = str(v).strip()
        except (TypeError, ValueError):
            return f"'{k}' is not a valid value"
    if out.get("n_ues") is not None and not (1 <= out["n_ues"] <= 16):
        return "n_ues must be 1..16"
    if out.get("n_rb") is not None and not (11 <= out["n_rb"] <= 273):
        return "n_rb must be 11..273"
    if out.get("sd") is not None and not (0 <= out["sd"] <= 16777215):
        return "sd must be 0..16777215 (0xffffff means 'no SD')"
    if out.get("ssb") is not None and not (0 <= out["ssb"] <= 63):
        return "ssb must be 0..63"
    if out.get("stagger_s") is not None and not (0 <= out["stagger_s"] <= 60):
        return "stagger_s must be 0..60"
    if out.get("move") and out["move"] not in ("static", "route"):
        return "move must be 'static' or 'route'"
    if out.get("speed_mps") is not None and not (0.1 <= out["speed_mps"] <= 60):
        return "speed_mps must be 0.1..60 (0.1 m/s to 216 km/h)"
    if out.get("imsi_base") and not re.fullmatch(r"\d{15}", out["imsi_base"]):
        return "imsi_base must be 15 digits"
    for k in ("key", "opc"):
        if out.get(k) and not re.fullmatch(r"[0-9a-fA-F]{32}", out[k]):
            return f"{k} must be 32 hex characters"
    for k in ("ue_cpus", "proxy_cpus"):
        if out.get(k) and not re.fullmatch(r"[0-9,\-]{1,32}", out[k]):
            return f"{k} must be a CPU list like 7-20 or 4,5,6"
    return out


@router.get("/scenes/{scene_id}/ue")
def scene_ue(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    return {"ok": True, "scene_id": scene_id, "params": ue_params(d),
            "effective": ue_effective(d), "defaults": UE_DEFAULTS}


@router.post("/scenes/{scene_id}/ue")
async def scene_ue_set(scene_id: str, req: Request):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)
    if body.get("reset"):
        _write_meta(d, ue={})
        return {"ok": True, "scene_id": scene_id, "params": ue_params(d),
                "effective": ue_effective(d)}
    cleaned = _clean_ue({k: v for k, v in body.items() if k != "reset"})
    if isinstance(cleaned, str):
        return _bad(cleaned)
    stored = dict(_read_meta(d).get("ue") or {})
    stored.update(cleaned)
    _write_meta(d, ue=stored)
    return {"ok": True, "scene_id": scene_id, "params": ue_params(d),
            "effective": ue_effective(d)}


@router.get("/scenes/{scene_id}/radio")
def scene_radio(scene_id: str):
    d = _scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    pkg_path = d / "package.json"
    if not pkg_path.is_file():
        return {"ok": True, "scene_id": scene_id, "transmitters": []}
    try:
        pkg = json.loads(pkg_path.read_text())
    except Exception:
        return _bad("this scene's package could not be read")
    manifest = pkg.get("manifest", pkg)
    cfg_dir = _scene_cfg_dir(d)
    out = []
    for n in manifest.get("nodes", []):
        if n.get("type") not in ("gnb", "tower"):
            continue
        cfg = cfg_dir / f"du_{_node_key(n)}.yaml"
        cell = _cell_from_cfg(cfg) if cfg.is_file() else {}
        rf = n.get("rf") or {}
        out.append({
            "id": _node_key(n), "name": n.get("name"),
            "config": cfg.name if cfg.is_file() else None,
            "from_config": {
                "freq_hz": cell.get("freq_hz"), "band": cell.get("band"),
                "antennas_dl": cell.get("antennas_dl"), "bw_mhz": cell.get("bw_mhz"),
                "pci": cell.get("pci"),
            },
            "from_design": {
                "tx_power_dbm": rf.get("tx_power_dbm"),
                "azimuth_deg": rf.get("azimuth_deg"),
                "downtilt_deg": rf.get("downtilt_deg"),
                "height_agl_m": n.get("height_agl_m"),
            },
        })
    return {"ok": True, "scene_id": scene_id, "transmitters": out}


@router.get("/du-configs/text")
def du_config_text(path: str = ""):
    p = _resolve_cfg(path)
    if p is None:
        return _bad("unknown config (must be one of the configured DU config files)", 404)
    try:
        return {"ok": True, "path": str(p), "name": p.name, "text": p.read_text(errors="replace")}
    except OSError as exc:
        return _bad(f"could not read {p.name}: {exc}")


@router.post("/du-configs/text")
async def du_config_save(req: Request):
    body = await _json(req)
    p = _resolve_cfg(str(body.get("path", "")))
    if p is None:
        return _bad("unknown config (must be one of the configured DU config files)", 404)
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        return _bad("text is required")
    if len(text) > 512_000:
        return _bad("that file is too large to save from the browser")
    try:
        import yaml as _yaml
        _yaml.safe_load(text)
    except Exception as exc:
        return _bad(f"not valid YAML: {str(exc)[:200]}")
    try:
        bak = p.with_suffix(p.suffix + ".bak")
        if not bak.exists():
            bak.write_text(p.read_text(errors="replace"))
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(text)
        tmp.replace(p)
    except OSError as exc:
        return _bad(f"could not save {p.name}: {exc}")
    return {"ok": True, "path": str(p), "name": p.name, "backup": str(bak)}


SITES_DIR = Path(os.environ.get("TOSSI_SITES_DIR", WORK / "_sites"))
SITE_FILES = {"buildings.pmtiles": "application/vnd.pmtiles",
              "buildings.geojson": "application/geo+json",
              "trees.json": "application/json",
              "site.json": "application/json"}
_SITE_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")


def _site_dir(site_id) -> Optional[Path]:
    if not isinstance(site_id, str) or not _SITE_ID.match(site_id):
        return None
    d = SITES_DIR / site_id
    return d if (d / "site.json").is_file() else None


@router.get("/sites")
def sites():
    out = []
    for d in (sorted(SITES_DIR.iterdir()) if SITES_DIR.is_dir() else []):
        if not _SITE_ID.match(d.name) or not (d / "site.json").is_file():
            continue
        try:
            s = json.loads((d / "site.json").read_text())
        except (OSError, ValueError):
            continue
        out.append({"id": d.name, "name": s.get("name") or d.name, "bbox": s.get("site"),
                    "built": s.get("built"), "attribution": s.get("attribution"),
                    "building_parts": s.get("building_parts"),
                    "trees": (s.get("trees_inventory_alive") or 0) + (s.get("trees_lidar") or 0)})
    return {"sites": out}


_SITE_MODEL = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(bin|skm|ply|png|jpg)$")


@router.get("/sites/{site_id}/models/{name}")
def site_model_file(site_id: str, name: str):
    d = _site_dir(site_id)
    if d is None or not _SITE_MODEL.match(name):
        return _bad("unknown site model", 404)
    p = d / "models" / name
    if not p.is_file():
        return _bad("no such model", 404)
    media = {"bin": "application/octet-stream", "skm": "application/octet-stream", "ply": "application/octet-stream",
             "png": "image/png", "jpg": "image/jpeg"}[name.rsplit(".", 1)[1]]
    return Response(content=p.read_bytes(), media_type=media, headers={"Cache-Control": "no-cache"})


@router.get("/sites/{site_id}/{name}")
def site_file(site_id: str, name: str, req: Request):
    d = _site_dir(site_id)
    if d is None or name not in SITE_FILES:
        return _bad("unknown site file", 404)
    p = d / name
    if not p.is_file():
        return _bad(f"{name} has not been built for this site", 404)
    size = p.stat().st_size
    headers = {"Accept-Ranges": "bytes", "Cache-Control": "no-cache",
               "ETag": f'"{int(p.stat().st_mtime)}-{size}"'}
    rng = (req.headers.get("range") or "").strip()
    if rng:
        m = re.match(r"^bytes=(\d*)-(\d*)$", rng)
        if not m or (m.group(1) == "" and m.group(2) == ""):
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        if m.group(1) == "":
            start, end = max(0, size - int(m.group(2))), size - 1
        else:
            start = int(m.group(1))
            end = min(size - 1, int(m.group(2))) if m.group(2) else size - 1
        if start >= size or start > end:
            return Response(status_code=416, headers={"Content-Range": f"bytes */{size}"})
        with open(p, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        return Response(content=data, status_code=206, media_type=SITE_FILES[name], headers=headers)
    return Response(content=p.read_bytes(), media_type=SITE_FILES[name], headers=headers)


@router.get("/models")
def models():
    out = []
    for p in sorted(MODELS_DIR.rglob("*")) if MODELS_DIR.is_dir() else []:
        if p.is_file() and p.suffix.lower() in MODEL_SUFFIXES:
            rel = p.relative_to(MODELS_DIR).as_posix()
            out.append({"name": rel, "size": p.stat().st_size, "uploaded": p.stat().st_mtime})
    return out


@router.post("/models")
async def model_upload(file: UploadFile = File(...)):
    raw = (file.filename or "").replace("\\", "/").strip("/")
    parts = [p for p in raw.split("/") if p not in ("", ".")]
    if not parts or any(not re.fullmatch(r"[A-Za-z0-9._-]+", p) or p == ".." for p in parts):
        return _bad("file name must be plain (letters, digits, dot, dash, underscore)")
    if len(parts) > 4:
        return _bad("model folders may be at most four levels deep")
    name = "/".join(parts)
    suffix = Path(name).suffix.lower()
    if suffix not in MODEL_SUFFIXES and suffix not in COMPANION_SUFFIXES:
        return _bad(f"unsupported model type; expected one of {sorted(MODEL_SUFFIXES)}")
    data = await file.read()
    if len(data) > MAX_MODEL_BYTES:
        return _bad(f"model is {len(data)//1024//1024} MB; the limit is {MAX_MODEL_BYTES//1024//1024} MB")
    if not data:
        return _bad("empty file")
    dest = MODELS_DIR / name
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return {"ok": True, "name": name, "size": len(data),
            "companion": suffix in COMPANION_SUFFIXES}


_SHAPE_SRC = r"""
import json, sys
sys.path.insert(0, sys.argv[3])
import numpy as np
from meshload import load_mesh
try:
    m = load_mesh(sys.argv[1])
except Exception as exc:
    print(json.dumps({"error": str(exc)[:400]})); raise SystemExit
v = np.asarray(m.vertices, dtype=float)
# Which way is up in the file. glTF says +Y, most CAD and mesh formats say +Z, and no
# reader can tell from the numbers alone — a model read on the wrong axis lies on its back
# and reports its depth as its height. Converting Y-up to Z-up is a +90 deg turn about X.
if len(sys.argv) > 2 and sys.argv[2] == "y" and v.size:
    v = np.column_stack([v[:, 0], -v[:, 2], v[:, 1]])
if v.size == 0:
    print(json.dumps({"error": "the file has no geometry"})); raise SystemExit
xy = np.unique(np.round(v[:, :2], 3), axis=0)
xy = xy[np.lexsort((xy[:, 1], xy[:, 0]))]
def half(pts):
    out = []
    for p in pts:
        while len(out) >= 2:
            (ax, ay), (bx, by) = out[-2], out[-1]
            if (bx - ax) * (p[1] - ay) - (by - ay) * (p[0] - ax) > 1e-12:
                break
            out.pop()
        out.append(tuple(p))
    return out
hull = half(xy)[:-1] + half(xy[::-1])[:-1] if len(xy) >= 3 else [tuple(p) for p in xy]
if len(hull) > 60:                      # plenty for a footprint; keeps the payload small
    step = len(hull) / 60.0
    hull = [hull[int(i * step)] for i in range(60)]
c = np.mean(np.asarray(hull), axis=0) if hull else np.zeros(2)
lo, hi = v.min(axis=0), v.max(axis=0)
print(json.dumps({
    "points": [[round(p[0] - c[0], 3), round(p[1] - c[1], 3)] for p in hull],
    "height_m": round(float(hi[2] - lo[2]), 2),
    "size": [round(float(hi[0] - lo[0]), 2), round(float(hi[1] - lo[1]), 2),
             round(float(hi[2] - lo[2]), 2)],
}))
"""


@router.get("/models/{name:path}/shape")
def model_shape(name: str, request: Request):
    p = _model_path(name)
    if p is None:
        return _bad("bad model name")
    if not p.is_file():
        return _bad("unknown model", 404)
    up = "y" if str(request.query_params.get("up", "")).lower() == "y" else "z"
    cache = p.with_name(p.name + (".shape-y.json" if up == "y" else ".shape.json"))
    if cache.is_file() and cache.stat().st_mtime >= p.stat().st_mtime:
        try:
            return json.loads(cache.read_text())
        except Exception:
            pass
    if not os.path.exists(SIONNA_PY):
        return _bad(f"mesh reader not available ({SIONNA_PY} missing)", 503)
    try:
        r = subprocess.run([SIONNA_PY, "-c", _SHAPE_SRC, str(p), up, str(SCENE_BUILDER)],
                           capture_output=True, text=True, timeout=90)
    except subprocess.TimeoutExpired:
        return _bad("the model took too long to read", 504)
    if r.returncode != 0:
        return _bad("could not read the model: " + (r.stderr or "").strip()[-160:], 415)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
    except Exception:
        return _bad("could not read the model", 415)
    if out.get("error"):
        return _bad(out["error"], 415)
    try:
        cache.write_text(json.dumps(out))
    except Exception:
        pass
    return out


_MESH_SRC = r"""
import json, sys, struct
sys.path.insert(0, sys.argv[3])
import numpy as np
from meshload import load_mesh
m = load_mesh(sys.argv[1])
v = np.asarray(m.vertices, dtype=float)
if len(sys.argv) > 2 and sys.argv[2] == "y" and v.size:
    v = np.column_stack([v[:, 0], -v[:, 2], v[:, 1]])
    m.vertices = v
target = int(sys.argv[4])
if len(m.faces) > target:
    try:
        m = m.simplify_quadric_decimation(face_count=target)
    except Exception:
        pass                                   # too detailed, but still correct
v = np.asarray(m.vertices, dtype=np.float64)
f = np.asarray(m.faces, dtype=np.int64)
xy = v[:, :2]
c = np.array([(xy[:, 0].max() + xy[:, 0].min()) / 2.0, (xy[:, 1].max() + xy[:, 1].min()) / 2.0])
v = v - np.array([c[0], c[1], v[:, 2].min()])  # centred in plan, standing on zero
tri = v[f]                                     # (F, 3, 3)
n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
ln = np.linalg.norm(n, axis=1, keepdims=True)
n = np.divide(n, np.where(ln == 0, 1, ln))
pos = tri.reshape(-1, 3).astype(np.float32)
nrm = np.repeat(n, 3, axis=0).astype(np.float32)
out = sys.stdout.buffer
out.write(struct.pack("<II", 0x534D4553, len(pos)))    # 'SMES', vertex count
out.write(pos.tobytes()); out.write(nrm.tobytes())
out.flush()
"""


@router.get("/models/{name:path}/mesh")
def model_mesh(name: str, request: Request):
    p = _model_path(name)
    if p is None:
        return _bad("bad model name")
    if not p.is_file():
        return _bad("unknown model", 404)
    up = "y" if str(request.query_params.get("up", "")).lower() == "y" else "z"
    faces = max(2000, min(120000, int(request.query_params.get("faces", "45000") or 45000)))
    cache = p.with_name(f"{p.name}.mesh-{up}-{faces}.bin")
    if not (cache.is_file() and cache.stat().st_mtime >= p.stat().st_mtime):
        if not os.path.exists(SIONNA_PY):
            return _bad(f"mesh reader not available ({SIONNA_PY} missing)", 503)
        try:
            r = subprocess.run([SIONNA_PY, "-c", _MESH_SRC, str(p), up, str(SCENE_BUILDER), str(faces)],
                               capture_output=True, timeout=300)
        except subprocess.TimeoutExpired:
            return _bad("the model took too long to read", 504)
        if r.returncode != 0 or len(r.stdout) < 8:
            return _bad("could not read the model: "
                        + (r.stderr or b"").decode("utf-8", "replace").strip()[-160:], 415)
        cache.write_bytes(r.stdout)
    return Response(content=cache.read_bytes(), media_type="application/octet-stream",
                    headers={"Cache-Control": "no-cache"})


@router.delete("/models/{name:path}")
def model_delete(name: str):
    p = _model_path(name)
    if p is None:
        return _bad("bad model name")
    if not p.is_file():
        return _bad("unknown model", 404)
    p.unlink()
    return {"ok": True, "deleted": name}


EDITS_FILE = Path(os.environ.get("TOSSI_BUILDING_EDITS", WORK / "_building_edits.json"))
HEIGHTS_FILE = Path(os.environ.get("TOSSI_HEIGHTS_FILE", WORK / "_building_heights.json"))
_edits_lock = threading.Lock()
BUILDING_ID_RE = re.compile(r"[A-Za-z0-9._:-]{1,128}")
MODEL_NAME_RE = re.compile(r"[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+){0,4}")


def _model_path(name: str):
    if not name or not MODEL_NAME_RE.fullmatch(name) or ".." in name.split("/"):
        return None
    p = (MODELS_DIR / name).resolve()
    try:
        p.relative_to(MODELS_DIR.resolve())
    except ValueError:
        return None
    return p
VALID_OPS = {"set_height", "delete", "replace_with_model", "replace_with_building"}


def _read_edits() -> dict:
    try:
        data = json.loads(EDITS_FILE.read_text())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    try:
        old = json.loads(HEIGHTS_FILE.read_text())
        if isinstance(old, dict) and old:
            return {k: {"op": "set_height", "height_m": float(v)} for k, v in old.items()}
    except Exception:
        pass
    return {}


def _write_edits(d: dict) -> None:
    tmp = EDITS_FILE.with_name(EDITS_FILE.name + ".tmp")
    tmp.write_text(json.dumps(d, indent=1, sort_keys=True))
    tmp.replace(EDITS_FILE)


def _clean_edit(e: dict):
    op = str(e.get("op", ""))
    if op not in VALID_OPS:
        return f"unknown op '{op}'; expected one of {sorted(VALID_OPS)}"
    if op == "delete":
        return {"op": op}
    if op == "set_height":
        try:
            h = _bounded(e, "height_m", None, 0.5, 1000.0, float)
        except ValueError as exc:
            return str(exc)
        if h is None:
            return "height_m is required"
        return {"op": op, "height_m": h}

    if op == "replace_with_building":
        rings = e.get("rings")
        if rings is None and isinstance(e.get("ring"), list):
            rings = [e["ring"]]
        if not isinstance(rings, list) or not (1 <= len(rings) <= 50):
            return "rings must be a list of 1..50 rings"
        clean_rings = []
        for ring in rings:
            if not isinstance(ring, list) or len(ring) < 3 or len(ring) > 500:
                return "each ring must be a list of 3..500 [lon, lat] points"
            clean = []
            for pt in ring:
                if (not isinstance(pt, list) or len(pt) != 2
                        or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in pt)
                        or not (-180.0 <= pt[0] <= 180.0) or not (-90.0 <= pt[1] <= 90.0)):
                    return "rings must contain [lon, lat] pairs"
                clean.append([float(pt[0]), float(pt[1])])
            clean_rings.append(clean)
        try:
            h = _bounded(e, "height_m", None, 0.5, 1000.0, float)
        except ValueError as exc:
            return str(exc)
        if h is None:
            return "height_m is required"
        return {"op": op, "rings": clean_rings, "ring": clean_rings[0], "height_m": h}

    model = str(e.get("model", ""))
    if not MODEL_NAME_RE.fullmatch(model) or Path(model).suffix.lower() not in MODEL_SUFFIXES:
        return f"model must be an uploaded mesh file name{sorted(MODEL_SUFFIXES)}"
    anchor = e.get("anchor_lonlat")
    if (not isinstance(anchor, list) or len(anchor) != 2
            or not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in anchor)
            or not (-180.0 <= anchor[0] <= 180.0) or not (-90.0 <= anchor[1] <= 90.0)):
        return "anchor_lonlat must be [lon, lat]"
    out = {"op": op, "model": model,
           "anchor_lonlat": [float(anchor[0]), float(anchor[1])]}
    out["up_axis"] = "y" if str(e.get("up_axis", "z")).lower() == "y" else "z"
    try:
        out["rotation_deg"] = _bounded(e, "rotation_deg", 0.0, -360.0, 360.0, float)
        out["scale"] = _bounded(e, "scale", 1.0, 0.01, 1000.0, float)
        out["height_offset_m"] = _bounded(e, "height_offset_m", 0.0, -500.0, 500.0, float)
    except ValueError as exc:
        return str(exc)
    return out


@router.get("/building-edits")
def building_edits() -> dict:
    return _read_edits()


@router.post("/building-edits")
async def building_edit_save(req: Request):
    body = await _json(req)
    bid = str(body.get("id", ""))
    if not BUILDING_ID_RE.fullmatch(bid):
        return _bad("bad building id")
    edit = body.get("edit") if isinstance(body.get("edit"), dict) else body
    cleaned = _clean_edit(edit)
    if isinstance(cleaned, str):
        return _bad(cleaned)
    with _edits_lock:
        d = _read_edits()
        d[bid] = cleaned
        _write_edits(d)
    return {"ok": True, "id": bid, "edit": cleaned, "count": len(d)}


@router.delete("/building-edits/{bid}")
def building_edit_forget(bid: str):
    if not BUILDING_ID_RE.fullmatch(bid):
        return _bad("bad building id")
    with _edits_lock:
        d = _read_edits()
        existed = d.pop(bid, None) is not None
        _write_edits(d)
    return {"ok": True, "removed": existed, "count": len(d)}


_LIVE_FIELDS = {
    "seq": re.compile(r"seq=\s*(-?\d+)"),
    "gain_db": re.compile(r"gain=\s*(-?[\d.]+)\s*dB"),
    "applied_db": re.compile(r"applied=-\s*(-?[\d.]+)\s*dB"),
    "attenuation_db": re.compile(r"attenuation=\s*(-?[\d.]+)\s*dB"),
    "paths": re.compile(r"paths=\s*(\d+)"),
    "trace_ms": re.compile(r"trace=\s*(\d+)\s*ms"),
    "doppler_hz": re.compile(r"doppler=\s*([-+]?[\d.]+)\s*Hz"),
    "doppler_spread_hz": re.compile(r"spread=\s*(-?[\d.]+)\s*([mu\u00b5]?)Hz"),
    "coherence_ms": re.compile(r"coh=\s*([\d.]+)\s*ms"),
    "staleness": re.compile(r"STALE\s*x\s*([\d.]+)"),
}
_LIVE_POS = re.compile(r"pos=\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)")
_LIVE_T = re.compile(r"\bt=(\d{9,}\.?\d*)")


def _parse_live_line(line: str) -> Optional[dict]:
    if "seq=" not in line:
        return None
    m_t = _LIVE_T.search(line)
    sample: dict = {"t": float(m_t.group(1)) if m_t else time.time()}
    for name, rx in _LIVE_FIELDS.items():
        m = rx.search(line)
        if not m:
            continue
        if name in ("seq", "paths", "trace_ms"):
            sample[name] = int(m.group(1))
        elif name == "doppler_spread_hz":
            scale = {"m": 1e-3, "u": 1e-6, "\u00b5": 1e-6}.get(m.group(2) or "", 1.0)
            sample[name] = float(m.group(1)) * scale
        else:
            sample[name] = float(m.group(1))
    if "seq" not in sample:
        return None
    if "steady" in line and "coherence_ms" not in sample:
        sample["doppler_steady"] = True
    m = _LIVE_POS.search(line)
    if m:
        sample["pos"] = [float(m.group(1)), float(m.group(2))]
    if "applied_db" not in sample and "attenuation_db" in sample:
        sample["applied_db"] = sample["attenuation_db"]
    return sample


class LiveChannel:

    STATE_DIR = WORK / "_live"
    RAYS_FILE = STATE_DIR / "rays.json"
    PID_FILE = STATE_DIR / "channel.pid"
    OUT_FILE = STATE_DIR / "channel.out"
    META_FILE = STATE_DIR / "channel.json"

    def __init__(self) -> None:
        self.proc: Optional[subprocess.Popen] = None
        self.adopted_pid: Optional[int] = None
        self.scene_id: Optional[str] = None
        self.started: Optional[float] = None
        self.params: dict = {}
        self.log: deque[str] = deque(maxlen=200)
        self.route: Optional[dict] = None
        self.samples: deque[dict] = deque(maxlen=120)
        self.last: dict = {}
        self.seq = 0
        self.exit_code: Optional[int] = None
        self._lock = threading.Lock()
        self._tail_stop: Optional[threading.Event] = None


    @staticmethod
    def _pid_alive(pid: Optional[int]) -> bool:
        if not pid:
            return False
        try:
            cmdline = Path(f"/proc/{pid}/cmdline").read_bytes()
        except OSError:
            return False
        return b"live_channel.py" in cmdline

    def adopt(self) -> bool:
        try:
            pid = int(self.PID_FILE.read_text().strip())
        except (OSError, ValueError):
            return False
        if not self._pid_alive(pid):
            self.PID_FILE.unlink(missing_ok=True)
            return False
        try:
            meta = json.loads(self.META_FILE.read_text())
        except (OSError, ValueError):
            meta = {}
        with self._lock:
            self.adopted_pid = pid
            self.scene_id = meta.get("scene_id")
            self.params = meta.get("params") or {}
            self.route = meta.get("route")
            self.started = meta.get("started") or time.time()
            self.exit_code = None
        self._start_tail(from_start=True)
        return True

    def pid(self) -> Optional[int]:
        if self.proc is not None:
            return self.proc.pid
        return self.adopted_pid

    def is_running(self) -> bool:
        if self.remote:
            return bool(MIRROR.active and MIRROR.state.get("publisher"))
        if self.proc is not None:
            return self.proc.poll() is None
        return self._pid_alive(self.adopted_pid)

    remote: Optional[dict] = None

    def remote_begin(self, target: str, scene_id: str, params: dict, route: Optional[dict], on_stop) -> None:
        with self._lock:
            self.remote = {"target": target, "on_stop": on_stop}
            self.proc, self.adopted_pid = None, None
            self.log.clear(); self.samples.clear(); self.last = {}; self.seq = 0; self.exit_code = None
            self.scene_id, self.params, self.route, self.started = scene_id, params, route, time.time()
            self.OUT_FILE = MIRROR.path("channel.out")
            self.RAYS_FILE = MIRROR.path("rays.json")
        self._start_tail(from_start=True)

    def remote_end(self) -> None:
        with self._lock:
            self.remote = None
            for k in ("OUT_FILE", "RAYS_FILE"):
                self.__dict__.pop(k, None)
        if self._tail_stop is not None:
            self._tail_stop.set()

    def _start_tail(self, from_start: bool = False) -> None:
        if self._tail_stop is not None:
            self._tail_stop.set()
        stop = threading.Event()
        self._tail_stop = stop
        threading.Thread(target=self._tail, args=(stop, from_start), daemon=True).start()

    def _tail(self, stop: threading.Event, from_start: bool) -> None:
        try:
            fh = self.OUT_FILE.open("r")
        except OSError:
            return
        if not from_start:
            fh.seek(0, 2)
        try:
            while not stop.is_set():
                line = fh.readline()
                if not line:
                    if not self.is_running() and not self.remote:
                        break
                    try:
                        cut = self.OUT_FILE.stat().st_size < fh.tell()
                    except OSError:
                        cut = False
                    if cut:
                        fh.seek(0)
                        with self._lock:
                            self.log.clear(); self.samples.clear(); self.last = {}; self.seq = 0
                        continue
                    stop.wait(0.2)
                    continue
                line = line.rstrip("\n")
                if not line:
                    continue
                sample = _parse_live_line(line)
                with self._lock:
                    self.log.append(line)
                    if sample:
                        self.samples.append(sample)
                        self.last = sample
                        self.seq = sample["seq"]
        finally:
            fh.close()
            with self._lock:
                if self.proc is not None:
                    self.exit_code = self.proc.poll()

    def start(self, cmd: list[str], scene_id: str, params: dict) -> None:
        with self._lock:
            self.log.clear()
            self.samples.clear()
            self.last = {}
            self.seq = 0
            self.exit_code = None
            self.scene_id = scene_id
            self.params = params
            self.started = time.time()
        self.STATE_DIR.mkdir(parents=True, exist_ok=True)
        self.adopted_pid = None
        out = self.OUT_FILE.open("w")
        try:
            self.proc = subprocess.Popen(
                cmd, cwd=str(SCENE_BUILDER),
                stdout=out, stderr=subprocess.STDOUT, text=True,
                start_new_session=True,
            )
        finally:
            out.close()
        try:
            self.PID_FILE.write_text(str(self.proc.pid))
            self.META_FILE.write_text(json.dumps({
                "scene_id": scene_id, "params": params, "route": self.route,
                "started": self.started, "pid": self.proc.pid}))
        except OSError:
            pass
        self._start_tail()

    def stop(self, timeout: float = 5.0) -> bool:
        if self.remote:
            fn = self.remote.get("on_stop")
            if fn:
                fn()
            return True
        if not self.is_running():
            self.proc = None
            self.adopted_pid = None
            self.PID_FILE.unlink(missing_ok=True)
            return False
        if self._tail_stop is not None:
            self._tail_stop.set()

        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait(timeout=timeout)
        else:
            pid = self.adopted_pid
            try:
                os.kill(pid, signal.SIGTERM)
                deadline = time.time() + timeout
                while time.time() < deadline and self._pid_alive(pid):
                    time.sleep(0.1)
                if self._pid_alive(pid):
                    os.kill(pid, signal.SIGKILL)
            except (OSError, TypeError):
                pass

        self.proc = None
        self.adopted_pid = None
        self.PID_FILE.unlink(missing_ok=True)
        return True

    def status(self) -> dict:
        with self._lock:
            return {
                "running": self.is_running(),
                "scene_id": self.scene_id,
                "params": self.params,
                "uptime_s": round(time.time() - self.started, 1) if self.started else 0,
                "updates": self.seq + 1 if self.last else 0,
                "last": self.last,
                "samples": list(self.samples),
                "log": list(self.log)[-40:],
                "exit_code": self.exit_code,
                "remote": (self.remote or {}).get("target"),
            }


LIVE = LiveChannel()
try:
    if LIVE.adopt():
        ocudulog = None  # noqa: F841  (no logger here; the status endpoint reports it)
except Exception:
    pass


LIVE_GO_FILE = Path("/tmp/tossi_live_go")

from . import steering as _steering
from .remote_mirror import MIRROR


def _clear_go_flag() -> None:
    if MIRROR.active:
        MIRROR.go(False)
        return
    try:
        LIVE_GO_FILE.unlink()
    except Exception:
        pass


def _go_set() -> None:
    if MIRROR.active:
        MIRROR.go(True)
    else:
        LIVE_GO_FILE.touch()


def _go_on() -> bool:
    return bool(MIRROR.state.get("go")) if MIRROR.active else LIVE_GO_FILE.exists()


HOLD_MIN_GAIN_DB = -110.0


def _hold_walk_without_a_ue() -> None:
    from . import ran_bridge

    def _cells_scheduling() -> "bool | None":
        seen = False
        for which in (1, 2):
            try:
                lines = ran_bridge._gnb_lines_with_ue(which)
            except Exception:
                continue
            for ln in reversed(lines):
                if "Scheduler cell pci=" in ln and "nof_ues=" in ln:
                    seen = True
                    try:
                        n = int(ln.split("nof_ues=")[1].split()[0])
                    except (IndexError, ValueError):
                        break
                    if n > 0:
                        return True
                    break
        return False if seen else None
    ever_attached = False
    while LIVE.is_running():
        try:
            sched = _cells_scheduling()
            if sched is None:
                attached = bool((ran_bridge._ue_status() or {}).get("attached"))
            else:
                attached = sched
        except Exception:
            time.sleep(2.0)
            continue
        walking = _go_on()
        if attached:
            if not ever_attached:
                ever_attached = True
                print("[live] UE attached - the walk is now gated on the link", flush=True)
            if not walking:
                _go_set()
                print("[live] UE attached - releasing the walk", flush=True)
        elif ever_attached and walking:
            last = LIVE.last or {}
            paths = last.get("paths")
            gain = last.get("gain_db")
            unusable = gain is not None and float(gain) <= HOLD_MIN_GAIN_DB
            blacked_out = (paths is not None and int(paths) <= 0) or unusable
            if blacked_out:
                why = ("no paths here either" if (paths is not None and int(paths) <= 0)
                       else "%.1f dB here is too weak to attach to" % float(gain))
                print("[live] no UE, and %s - walking on to find coverage "
                      "rather than holding where nothing can attach" % why, flush=True)
            else:
                _clear_go_flag()
                print("[live] no UE attached - holding the receiver", flush=True)
        elif not ever_attached and not walking:
            _go_set()
            print("[live] no UE yet - walking until one attaches", flush=True)
        time.sleep(2.0)
    _clear_go_flag()


if LIVE.is_running():
    threading.Thread(target=_hold_walk_without_a_ue, daemon=True).start()


def _release_on_ip() -> None:
    from . import ran_bridge
    while LIVE.is_running():
        if _go_on():
            return
        try:
            if (ran_bridge._ue_status() or {}).get("ip"):
                _go_set()
                print("[live] UE has an IP - releasing movement", flush=True)
                return
        except Exception:
            pass
        time.sleep(1.0)


@router.post("/live/start")
async def live_start(req: Request):
    body = await _json(req)
    if LIVE.is_running():
        held = str(((LIVE.status().get("params") or {}).get("owner") or "")).strip().lower()
        where = f" from the {held} tab" if held else ""
        return _bad(f"a live channel is already streaming{where} — stop it first", 409)
    if not LIVE_CHANNEL:
        return _bad("live_channel.py not found (set TOSSI_LIVE_CHANNEL)", 503)
    if not _sionna_ready():
        return _bad("Sionna environment unavailable", 503)
    plan = _live_plan(body)
    if isinstance(plan, JSONResponse):
        return plan
    cmd, d, params, route_info, move_start, warnings = (
        plan["cmd"], plan["d"], plan["params"], plan["route_info"], plan["move_start"], plan["warnings"])
    LIVE.route = route_info
    LIVE.start(cmd, d.name, params)
    time.sleep(0.6)
    if not LIVE.is_running():
        return _bad("live channel exited immediately:\n" + "\n".join(list(LIVE.log)[-10:]), 500)
    if move_start == "on_ip":
        threading.Thread(target=_release_on_ip, daemon=True).start()
    threading.Thread(target=_hold_walk_without_a_ue, daemon=True).start()
    return {"ok": True, "scene_id": d.name, "params": params,
            "warnings": warnings, "command": " ".join(cmd)}


def _live_plan(body: dict, remote: Optional[dict] = None):
    scene_id = body.get("scene_id", "")
    d = _scene_dir(scene_id)
    if not d or not (d / "scene" / "scene.xml").exists():
        return _bad("unknown scene_id (build first)", 404)

    _apply_gnb_configs(d)
    sp = sionna_params(d)
    pkg = json.loads((d / "package.json").read_text())
    manifest = pkg.get("manifest", pkg)
    nodes = manifest.get("nodes", []) or []
    txs = [n for n in nodes if n.get("type") in ("gnb", "tower")]
    ues = [n for n in nodes if n.get("type") == "ue"]
    uep = ue_params(d)
    ueff = ue_effective(d)
    mode = body.get("mode") or ueff.get("move_effective") or "static"
    move_start = str(body.get("move_start") or uep.get("move_start") or "auto").lower()
    if move_start not in ("auto", "on_ip", "manual"):
        move_start = "auto"
    laps = 0
    if mode != "sweep" and (not txs or not ues):
        return _bad("the scene needs at least one gNB/tower and one UE to stream a channel")

    du_path = _resolve_du(body.get("du_config", ""))
    du = _parse_du(du_path) if du_path else {}
    warnings: list[str] = []
    if body.get("du_config") and not du_path:
        return _bad("du_config is not one of the known O-DU config files")
    if du_path and not du:
        warnings.append(f"could not read {du_path.name}; using the values supplied instead")

    srate = float(body.get("srate") or du.get("srate_hz") or 61.44e6)
    binds = body.get("binds")
    if binds is None:
        binds = [body.get("bind") or du.get("live_bind") or "tcp://127.0.0.1:5566"]
    elif isinstance(binds, str):
        binds = [binds]
    if not isinstance(binds, list) or not binds:
        return _bad("binds must be a non-empty list of ZeroMQ endpoints")
    binds = [str(b).strip() for b in binds]
    for b in binds:
        if not _ZMQ_BIND.match(b):
            return _bad(f"binds entry {b!r} must look like tcp://host:port")
    if len(binds) != len(set(binds)):
        return _bad("binds must be distinct - one endpoint per cell")
    bind = binds[0]

    manifest_freq = float((rf_block(manifest) or {}).get("freq_hz") or 0.0)
    du_freq = du.get("dl_freq_hz")
    if du_freq and manifest_freq and abs(du_freq - manifest_freq) > 1e6:
        warnings.append(
            f"scene carrier {manifest_freq/1e9:.5f} GHz differs from the DU's dl_arfcn "
            f"({du_freq/1e9:.5f} GHz) — the channel is traced at the scene's carrier")

    meta = _read_meta(d)
    tr = meta.get("trace") or {}
    taps = tr.get("taps") or {}
    if abs(float(tr.get("srate_hz") or 0.0) - srate) > 1.0:
        taps = {}
        if tr:
            warnings.append("the stored trace used a different sampling rate; tap budget recomputed")
    num_taps = int(body.get("num_taps") or sp.get("num_taps")
                   or taps.get("taps") or _derive_taps(manifest, srate))
    num_taps = max(1, min(64, num_taps))

    try:
        interval = _bounded(body, "interval", 1.0, 0.05, 3600.0, float)
        max_depth = _bounded(body, "max_depth", int(sp.get("max_depth", 5)), 0, 10, int)
    except ValueError as exc:
        return _bad(str(exc))

    cmd = [SIONNA_PY, "-u", str(LIVE_CHANNEL), "--bind", *binds,
           "--srate", str(srate), "--num-taps", str(num_taps),
           "--interval", str(interval), "--max-depth", str(max_depth),
           "--max-drop-db", str(sp.get("max_drop_db", 45.0)),
           "--rays-out", (remote or {}).get("rays_out") or str(LiveChannel.RAYS_FILE)]

    if not remote:
        try:
            LiveChannel.RAYS_FILE.unlink(missing_ok=True)
        except OSError:
            pass

    route_info = None
    if mode == "sweep":
        cmd.append("--sweep")
    else:
        tx_idx = _pick_tx_index(txs, body.get("tx"), tr)
        if tx_idx is None:
            return _bad(f"unknown tx '{body.get('tx')}'; scene has {[t.get('name') for t in txs]}")
        tx, ue = txs[tx_idx], ues[0]
        arr = (tx.get("rf") or {}).get("array") or {}
        cell = _cell_from_cfg(du_path) if du_path else {}
        ant = cell.get("antennas_dl") or du.get("antennas_dl")
        if not ant:
            rows = int(sp.get("array_rows") or arr.get("rows", 1))
            cols = int(sp.get("array_cols") or arr.get("cols", 1))
            ant = rows * cols
            warnings.append("no O-DU config to read the antenna count from; publishing "
                            f"{min(4, ant)} from the scene's array — if the radio has fewer, "
                            "the DU will discard every update")
        elif arr.get("rows") and int(arr["rows"]) * int(arr.get("cols", 1)) != int(ant):
            warnings.append(
                f"the cell has {ant} DL antenna(s) but the scene models "
                f"{int(arr['rows']) * int(arr.get('cols', 1))}; the channel is published for "
                f"{min(4, int(ant))} so the DU accepts it")
        n_tx_ant = max(1, min(4, int(ant)))
        cmd += ["--scene", (remote or {}).get("scene_xml") or str(d / "scene" / "scene.xml"),
                "--num-tx-ant", str(n_tx_ant)]

        multi = bool(body.get("multi_tx") or len(binds) > 1) and len(txs) > 1
        if len(binds) > 1 and len(txs) < len(binds):
            return _bad(f"{len(binds)} endpoints were given but the scene has {len(txs)} "
                        "transmitter(s) - there is no channel to publish on the extra ones")
        if multi:
            flat = [str(v) for t in txs for v in t["enu_m"]]
            cmd += ["--tx-positions", *flat,
                    "--tx-names", *[str(t.get("name") or f"tx{i}") for i, t in enumerate(txs)]]
            margin = body.get("handover_margin_db")
            if margin is not None:
                cmd += ["--handover-margin-db", str(float(margin))]
            if len(binds) > 1:
                warnings.append(
                    f"publishing a channel per cell: {len(binds)} endpoints for {len(txs)} "
                    "transmitters, each cell receiving its own site's propagation. Which cell "
                    "serves is the network's decision, not the publisher's.")
            else:
                warnings.append(
                    f"serving whichever of {len(txs)} transmitters is strongest; the receiver "
                    "will hand over as it moves. The DU still has one cell, so this is a "
                    "change of channel rather than a 3GPP handover.")
        else:
            cmd += ["--tx-position", *[str(v) for v in tx["enu_m"]]]
        route = _scene_route(d)
        if mode == "route" and len(route) >= 2:
            length = _path_len(route)
            speed = float(body.get("speed_mps") or uep.get("speed_mps") or 1.4)
            spacing = max(0.05, speed * interval)
            steps = int(body.get("steps") or 0) or int(round(length / spacing)) + 1
            steps = max(2, min(2000, steps))
            flat = [str(v) for p in route for v in p]
            cmd += ["--rx-start", *[str(v) for v in route[0]],
                    "--route-points", *flat, "--steps", str(steps), "--route"]
            loop = body.get("loop_route")
            if loop is None:
                loop = uep.get("loop_route", True)
            if loop:
                cmd.append("--loop-route")
            laps = body.get("laps")
            if laps is None:
                laps = uep.get("laps", 0)
            laps = max(0, min(1000, int(laps or 0)))
            if laps:
                cmd += ["--laps", str(laps)]
            if not remote:
                if move_start != "auto":
                    _clear_go_flag()
                else:
                    _go_set()
            cmd += ["--go-file", (remote or {}).get("go_file") or str(LIVE_GO_FILE)]
            if not remote:
                _steering.STEERING.stop()
                _steering.clear_steer_file()
                cmd += ["--steer-file", str(_steering.STEER_FILE)]
            if body.get("max_drop_db") is not None:
                cmd += ["--max-drop-db", str(float(body["max_drop_db"]))]
            route_info = {"corners": len(route), "length_m": length, "speed_mps": speed,
                          "steps": steps, "spacing_m": round(spacing, 2),
                          "lap_s": round(steps * interval, 1), "loop": bool(loop),
                          "positions": walk_route(route, steps), "corners_enu": route}
        else:
            if mode == "route":
                warnings.append("no route is drawn for this scene's UE — streaming from "
                                "where it stands instead")
                mode = "static"
            cmd += ["--rx-start", *[str(v) for v in ue["enu_m"]], "--static"]

    if mode != "route":
        move_start, laps = "auto", 0

    owner = str(body.get("owner") or "raytrace").strip().lower()
    if owner not in ("raytrace", "handover"):
        owner = "raytrace"

    params = {"mode": mode, "owner": owner,
              "move_start": move_start, "laps": laps,
              "route": {k: v for k, v in (route_info or {}).items()
                        if k not in ("positions", "corners_enu")} or None,
              "bind": bind, "binds": binds, "srate": srate, "num_taps": num_taps,
              "interval": interval, "clamped": bool(taps.get("clamped")),
              "du_config": du_path.name if du_path else None,
              "tx": tx["name"] if mode != "sweep" else None,
              "multi_tx": (sorted(t.get("name") or "" for t in txs)
                           if (mode != "sweep" and bool(body.get("multi_tx")) and len(txs) > 1)
                           else None),
              "warnings": warnings}
    return {"cmd": cmd, "d": d, "params": params, "route_info": route_info,
            "move_start": move_start, "warnings": warnings}


@router.get("/live/rays")
def live_rays():
    f = LIVE.RAYS_FILE
    try:
        raw = f.read_text()
    except OSError:
        return {"ok": True, "rays": None, "age_s": None}
    try:
        d = json.loads(raw)
    except ValueError:
        return {"ok": True, "rays": None, "age_s": None}
    t = d.get("t")
    return {"ok": True, "rays": d,
            "age_s": (round(time.time() - float(t), 2) if t else None)}


@router.get("/live/status")
def live_status():
    st = LIVE.status()
    p = st.get("params") or {}
    st["moving"] = True if (p.get("move_start") or "auto") == "auto" else _go_on()
    return st


@router.post("/live/steer/start")
async def live_steer_start(req: Request):
    body = await _json(req)
    if not LIVE.is_running():
        return _bad("no live channel is running - start one before steering it", 409)
    route = (LIVE.route or {})
    positions = route.get("positions") or []
    if len(positions) < 2:
        return _bad("this run has no walked route to steer along", 409)

    policy = str(body.get("policy") or "seek_coverage")
    params = {}
    for key in ("floor_db", "ceiling_db"):
        if body.get(key) is not None:
            params[key] = float(body[key])

    from . import calibration as _calibration, ran_bridge

    def read_sinr():
        sample = _calibration.ue_sinr_sample(ran_bridge.UE_LOG)
        return None if not sample else sample.get("sinr")

    try:
        st = _steering.STEERING.start(
            policy, n_positions=len(positions), read_sinr=read_sinr,
            still_live=LIVE.is_running, params=params,
            seed=int(body.get("seed") or 0),
            start_index=int(body.get("start_index") or 0),
            interval_s=float(body.get("interval_s")
                             or (LIVE.params or {}).get("interval")
                             or _steering.DEFAULT_INTERVAL_S))
    except ValueError as exc:
        return _bad(str(exc))
    return {"ok": True, **st}


@router.post("/live/steer/stop")
def live_steer_stop():
    was = _steering.STEERING.is_running()
    _steering.STEERING.stop()
    return {"ok": True, "was_running": was, **_steering.STEERING.status()}


@router.get("/live/steer/status")
def live_steer_status():
    return {"ok": True, **_steering.STEERING.status()}


@router.post("/live/move")
def live_move():
    if not LIVE.is_running():
        return _bad("no live channel is running", 409)
    p = LIVE.params or {}
    if (p.get("mode") or "") != "route":
        return _bad("this run has no route to walk", 409)
    if (p.get("move_start") or "auto") == "auto":
        return {"ok": True, "moving": True, "note": "this run already started on its own"}
    _go_set()
    return {"ok": True, "moving": True}


@router.get("/live/route")
def live_route():
    r = getattr(LIVE, "route", None)
    return {"ok": True, "running": LIVE.is_running(), "scene_id": LIVE.scene_id,
            "route": r}


def _flatten_du_channel(bind: str = "", srate_hz: float = 0.0) -> bool:
    if not FLATTEN_CHANNEL or not FLATTEN_CHANNEL.exists():
        return False
    bind = bind or "tcp://127.0.0.1:5566"
    srate_hz = srate_hz or 61.44e6
    try:
        r = subprocess.run([SIONNA_PY, str(FLATTEN_CHANNEL), bind, str(srate_hz)],
                           capture_output=True, text=True, timeout=25)
        return r.returncode == 0
    except Exception:
        return False


@router.post("/live/stop")
async def live_stop(req: Request):
    st = LIVE.status()
    params = st.get("params") or {}

    body = await _json(req)
    caller = str(body.get("owner") or "").strip().lower()
    holder = str(params.get("owner") or "").strip().lower()
    if (LIVE.is_running() and caller and holder and caller != holder
            and not body.get("force")):
        return _bad(f"that channel was started from the {holder} tab - stop it there, "
                    f"or pass force to take it", 409)

    was = LIVE.stop()
    _clear_go_flag()
    flattened = _flatten_du_channel(params.get("bind") or "",
                                    float(params.get("srate") or 0.0)) if was else False
    return {"ok": True, "stopped": was, "flattened": flattened}


async def _json(req: Request) -> dict:
    try:
        body = await req.json()
        return body if isinstance(body, dict) else {}
    except Exception:
        return {}


def _bad(msg: str, code: int = 400) -> JSONResponse:
    return JSONResponse({"ok": False, "error": msg}, status_code=code)


VALID_GROUND = {"very_dry_ground", "medium_dry_ground", "wet_ground", "concrete", "marble"}


def rf_block(manifest: dict) -> dict:
    for n in manifest.get("nodes", []) or []:
        if n.get("type") in ("gnb", "tower") and n.get("rf"):
            return n["rf"]
    return {}


def _derive_taps(manifest: dict, srate_hz: float) -> int:
    size = ((manifest.get("bbox") or {}).get("size_m")) or None
    diag = math.hypot(float(size[0]), float(size[1])) if size and len(size) == 2 else 500.0
    wanted = max(16, int(math.ceil((2.2 * diag / 299_792_458.0) * srate_hz)) + 8)
    return max(1, min(64, wanted))


def _pick_tx_index(txs: list, selector, trace_result: dict) -> Optional[int]:
    if selector not in (None, ""):
        for i, t in enumerate(txs):
            if t.get("name") == selector:
                return i
        try:
            i = int(selector)
        except (TypeError, ValueError):
            return None
        return i if 0 <= i < len(txs) else None
    best = ((trace_result.get("links") or [{}])[0]).get("best_tx")
    if best:
        for i, t in enumerate(txs):
            if t.get("name") == best:
                return i
    return 0


def _bounded(body: dict, key: str, default, lo, hi, cast):
    raw = body.get(key, default)
    if raw is None:
        return default
    try:
        v = cast(raw)
    except (TypeError, ValueError):
        raise ValueError(f"{key} must be a number, got {raw!r}") from None
    if v < lo or v > hi:
        raise ValueError(f"{key} must be between {lo} and {hi}, got {v}")
    return v


def _f(v: Any) -> Optional[float]:
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _grep_int(lines, pattern: str) -> Optional[int]:
    for line in reversed(list(lines)):
        m = re.search(pattern, line)
        if m:
            return int(m.group(1))
    return None


def _job_response(job: Job, body: dict, extra: Optional[dict] = None):
    extra = extra or {}
    if body.get("wait"):
        job.done_event.wait(timeout=float(body.get("wait_timeout", 1800)))
        d = job.to_dict()
        return {"ok": job.state == "done", **extra, **d}
    return {"ok": True, "job_id": job.id, "state": job.state, **extra}


async def _job_response_async(job: Job, body: dict, extra: Optional[dict] = None):
    if body.get("wait"):
        await asyncio.to_thread(job.done_event.wait, float(body.get("wait_timeout", 1800)))
        body = {**body, "wait_timeout": 0}
    return _job_response(job, body, extra)
