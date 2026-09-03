from __future__ import annotations

import json
import re
import shutil
import time
import uuid
from fnmatch import fnmatch
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse

from . import deploy_bridge as d
from . import ml_info
from .auth import require_user

router = APIRouter(prefix="/api/lake", tags=["lake"], dependencies=[Depends(require_user)])
RUNS = d.VAR / "runs"
MODELS = d.VAR / "models"
FEATURE_OF = {"bsr": "bsr_ml", "mcs": "ml_mcs", "csi": "csi_ml", "slice": "slice_ml"}
_rows_cache: dict[tuple[str, float], tuple[int, list[str]]] = {}


def _stacks() -> list[dict]:
    return [s for s in d.list_stacks() if "error" not in s]


def _feature(stack: dict) -> str | None:
    ov = (stack.get("env") or {}).get("ML_OVERLAY", "")
    return FEATURE_OF.get(ov.split("_")[0]) if ov else None


def _csv_shape(p: Path) -> tuple[int, list[str]]:
    key = (str(p), p.stat().st_mtime)
    if key not in _rows_cache:
        with open(p, "rb") as f:
            head = f.readline().decode(errors="replace").strip()
            rows = sum(1 for _ in f)
        _rows_cache[key] = (rows, [c for c in head.split(",") if c])
    return _rows_cache[key]


def _file(p: Path, stack: str, run: str | None, feature: str | None = None) -> dict:
    st = p.stat()
    out = {"path": str(p), "name": p.name, "bytes": st.st_size, "mtime": st.st_mtime, "stack": stack, "run": run,
           "kind": "csv" if p.suffix == ".csv" else "log" if p.suffix in (".log", ".txt") else "other"}
    if out["kind"] == "csv":
        out["rows"], cols = _csv_shape(p)
        out["columns"] = len(cols)
        out["feature"] = feature or next((n for n, f in ml_info.FEATURES.items() if fnmatch(p.name, f["glob"])), None)
    return out


def _run(stack: str, rdir: Path) -> dict | None:
    try:
        meta = json.loads((rdir / "meta.json").read_text())
    except (OSError, ValueError):
        return None
    files = [_file(p, stack, rdir.name) for sub in ("data", "logs") for p in sorted((rdir / sub).glob("*")) if p.is_file()]
    if meta.get("outcome") == "running" and stack not in d.running_sessions():
        meta["outcome"] = "ended"
    end = meta.get("ended") or time.time()
    return {**meta, "type": "stack", "duration_s": round(end - meta["started"]), "files": files,
            "csvs": sum(1 for f in files if f["kind"] == "csv"), "rows": sum(f.get("rows", 0) for f in files),
            "logs": sum(1 for f in files if f["kind"] == "log")}


def stack_runs(stack: str) -> list[dict]:
    base = RUNS / stack
    runs = [r for r in (_run(stack, p) for p in sorted(base.glob("*"), reverse=True) if p.is_dir()) if r] if base.is_dir() else []
    return runs


def loose(stack: dict) -> list[dict]:
    in_runs = {p.name for p in (RUNS / stack["name"]).glob("*/data/*")} if (RUNS / stack["name"]).is_dir() else set()
    out = []
    feat = _feature(stack)
    src = (stack.get("env") or {}).get("OCUDU_SRC_DIR")
    if feat and src and (Path(src) / "ml" / "datasets").is_dir():
        glob = ml_info.FEATURES[feat]["glob"]
        out += [_file(p, stack["name"], None, feat) for p in sorted((Path(src) / "ml" / "datasets").rglob(glob)) if p.name not in in_runs]
    vd = d.VAR / "datasets" / stack["name"]
    if vd.is_dir():
        out += [_file(p, stack["name"], None) for p in sorted(vd.rglob("*")) if p.is_file() and p.name not in in_runs]
    return out


def _allowed(path: str) -> Path:
    p = Path(path).resolve()
    roots = [RUNS, d.VAR / "datasets", MODELS] + [Path(s["env"]["OCUDU_SRC_DIR"]) / "ml" / "datasets"
                                                   for s in _stacks() if (s.get("env") or {}).get("OCUDU_SRC_DIR")]
    if not p.is_file() or not any(p == r.resolve() or r.resolve() in p.parents for r in roots):
        raise HTTPException(404, "not a data lake file")
    return p


@router.get("/runs")
def runs(limit: int = 200):
    out = [{k: v for k, v in r.items() if k != "files"} for s in _stacks() for r in stack_runs(s["name"])]
    try:
        from . import runs_store
        for r in runs_store.list_runs(limit):
            if r.get("kind") == "ntn":
                continue
            out.append({"type": "simulation", "id": r["id"], "stack": r.get("scene_name") or r.get("scene_id") or "simulation",
                        "started": r["started"], "ended": r.get("ended"), "outcome": r.get("state"),
                        "duration_s": round(r.get("duration_s") or 0), "csvs": 0, "rows": 0,
                        "logs": len((r.get("summary") or {}).get("logs") or []), "user": None, "hosts": {}})
    except Exception:
        pass
    return {"runs": sorted(out, key=lambda r: -r["started"])[:limit]}


@router.get("/overview")
def overview():
    out = []
    for s in _stacks():
        rs, lo = stack_runs(s["name"]), loose(s)
        files = [f for r in rs for f in r["files"]] + lo
        if not files and not rs:
            continue
        out.append({"stack": s["name"], "group": s.get("group"), "runs": len(rs), "csvs": sum(1 for f in files if f["kind"] == "csv"),
                    "rows": sum(f.get("rows", 0) for f in files), "bytes": sum(f["bytes"] for f in files),
                    "last": max([f["mtime"] for f in files] + [r["started"] for r in rs] or [0])})
    return {"stacks": sorted(out, key=lambda x: -x["last"])}


@router.get("/stack/{stack}")
def stack_lake(stack: str):
    s = next((s for s in _stacks() if s["name"] == stack), None)
    if not s:
        raise HTTPException(404, "no such stack")
    return {"stack": stack, "feature": _feature(s), "runs": stack_runs(stack), "loose": loose(s)}


@router.get("/datasets")
def datasets():
    out = []
    for s in _stacks():
        feat = _feature(s)
        for r in stack_runs(s["name"]):
            out += [{**f, "feature": f.get("feature") or feat} for f in r["files"] if f["kind"] == "csv"]
        out += [f for f in loose(s) if f["kind"] == "csv"]
    return {"datasets": sorted(out, key=lambda f: -f["mtime"])}


@router.get("/preview")
def preview(path: str, n: int = 15):
    p = _allowed(path)
    if p.suffix == ".csv":
        lines = p.read_text(errors="replace").splitlines()
        rows = [l.split(",") for l in lines[1:]]
        return {"kind": "csv", "columns": lines[0].split(",") if lines else [], "head": rows[:n],
                "tail": rows[-n:] if len(rows) > 2 * n else [], "rows": len(rows)}
    with open(p, "rb") as f:
        f.seek(max(0, p.stat().st_size - 200_000))
        text = f.read().decode(errors="replace")
    return {"kind": "text", "text": re.sub(r"\x1b\[[0-9;]*m", "", "\n".join(text.splitlines()[-400:]))}


@router.get("/download")
def download(path: str):
    p = _allowed(path)
    return FileResponse(p, filename=p.name)


@router.delete("/runs/{stack}/{run}")
def delete_run(stack: str, run: str):
    if not re.fullmatch(r"[\w.-]+", stack) or not re.fullmatch(r"\d{8}-\d{6}", run):
        raise HTTPException(404, "no such run")
    p = RUNS / stack / run
    if not p.is_dir():
        raise HTTPException(404, "no such run")
    if json.loads((p / "meta.json").read_text()).get("outcome") == "running" and stack in d.running_sessions():
        raise HTTPException(409, "that run is still going -- stop the stack first")
    shutil.rmtree(p)
    return {"deleted": run}


def _trained(s: dict) -> dict | None:
    env = s.get("env") or {}
    if not env.get("ML_MODEL") or not env.get("OCUDU_SRC_DIR"):
        return None
    p = Path(env["OCUDU_SRC_DIR"]) / env["ML_MODEL"]
    return {"id": f"trained:{s['name']}", "name": p.name, "stack": s["name"], "feature": _feature(s), "source": "trained",
            "path": str(p), "exists": p.is_file(), "bytes": p.stat().st_size if p.is_file() else 0,
            "mtime": p.stat().st_mtime if p.is_file() else None, "in_use_by": s["name"] if p.is_file() else None}


@router.get("/models")
def models():
    out = [m for m in (_trained(s) for s in _stacks()) if m]
    for meta in sorted(MODELS.glob("*/meta.json")) if MODELS.is_dir() else []:
        try:
            out.append(json.loads(meta.read_text()))
        except ValueError:
            continue
    return {"models": out, "stacks": [s["name"] for s in _stacks() if (s.get("env") or {}).get("ML_MODEL")]}


@router.post("/models")
async def upload_model(file: UploadFile = File(...), name: str = Form(""), stack: str = Form(""), notes: str = Form("")):
    fname = Path(file.filename or "model").name
    if not re.fullmatch(r"[\w.+-]{1,120}", fname):
        raise HTTPException(400, "file name may only use letters, digits, . _ + -")
    mid = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4]
    dst = MODELS / mid
    dst.mkdir(parents=True)
    size = 0
    with open(dst / fname, "wb") as out:
        while chunk := await file.read(1 << 20):
            size += len(chunk)
            if size > 2 << 30:
                shutil.rmtree(dst)
                raise HTTPException(413, "models up to 2 GB")
            out.write(chunk)
    meta = {"id": mid, "name": name.strip()[:80] or fname, "file": fname, "path": str(dst / fname), "bytes": size,
            "mtime": time.time(), "stack": stack or None, "notes": notes.strip()[:500], "source": "uploaded", "exists": True,
            "in_use_by": None}
    (dst / "meta.json").write_text(json.dumps(meta, indent=1))
    return meta


@router.post("/models/{mid}/use")
def use_model(mid: str, body: dict):
    if not re.fullmatch(r"[\w-]+", mid) or not (MODELS / mid / "meta.json").is_file():
        raise HTTPException(404, "no such model")
    meta = json.loads((MODELS / mid / "meta.json").read_text())
    s = next((s for s in _stacks() if s["name"] == body.get("stack")), None)
    t = _trained(s) if s else None
    if not t:
        raise HTTPException(400, "that stack has no ML model slot")
    dst = Path(t["path"])
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.is_file():
        bak = d.VAR / "config-backups" / f"{time.strftime('%Y%m%d-%H%M%S')}-{dst.name}"
        bak.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(dst, bak)
    shutil.copy2(meta["path"], dst)
    meta["in_use_by"] = s["name"]
    (MODELS / mid / "meta.json").write_text(json.dumps(meta, indent=1))
    return {"model": meta, "installed_at": str(dst)}


@router.delete("/models/{mid}")
def delete_model(mid: str):
    if not re.fullmatch(r"[\w-]+", mid) or not (MODELS / mid).is_dir():
        raise HTTPException(404, "no such model")
    shutil.rmtree(MODELS / mid)
    return {"deleted": mid}


BENCH = d.VAR / "ml" / "benchmarks"


def record_benchmark(b: dict) -> dict:
    res = b.get("results") or []
    if not 2 <= len(res) <= 12 or sum(bool(r.get("model")) for r in res) != 1:
        raise ValueError("results: 2..12 predictors, exactly one with model=true")
    out = {"id": time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:4], "t": time.time(),
           "stack": str(b.get("stack", ""))[:60], "model": str(b.get("model", ""))[:80],
           "kind": "live" if b.get("kind") == "live" else "offline", "data": str(b.get("data", ""))[:200],
           "metric": str(b.get("metric") or "MAE")[:20], "unit": str(b.get("unit", ""))[:20],
           "lower_is_better": b.get("lower_is_better", True) is not False, "rows": int(b.get("rows") or 0),
           "results": [{"name": str(r["name"])[:80], "value": float(r["value"]), "model": bool(r.get("model")),
                        "note": str(r.get("note", ""))[:120]} for r in res],
           "notes": str(b.get("notes", ""))[:1000], "by": str(b.get("by", ""))[:40]}
    BENCH.mkdir(parents=True, exist_ok=True)
    (BENCH / f"{out['id']}.json").write_text(json.dumps(out, indent=1))
    return out


@router.get("/benchmarks")
def benchmarks():
    out = []
    for f in BENCH.glob("*.json") if BENCH.is_dir() else []:
        try:
            out.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue
    return {"benchmarks": sorted(out, key=lambda b: -b["t"])}


@router.delete("/benchmarks/{bid}")
def delete_benchmark(bid: str):
    f = BENCH / f"{bid}.json"
    if not re.fullmatch(r"[0-9]{8}-[0-9]{6}-[0-9a-f]{4}", bid) or not f.is_file():
        raise HTTPException(404, "no such benchmark")
    f.unlink()
    return {"deleted": bid}
