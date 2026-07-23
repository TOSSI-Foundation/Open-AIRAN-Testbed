from __future__ import annotations

import json
import zipfile
import os
import re
import time
from pathlib import Path

from fastapi import Depends, APIRouter, Request
from fastapi.responses import FileResponse, JSONResponse

from . import sionna_bridge as sb

from .auth import require_user  # noqa: E402

router = APIRouter(prefix="/api/channel", tags=["channel"],
                   dependencies=[Depends(require_user)])

EXPORTS = Path(os.environ.get("TOSSI_EXPORTS", sb.WORK / "_exports"))
EXPORTS.mkdir(parents=True, exist_ok=True)

EXPORT_TIMEOUT = int(os.environ.get("TOSSI_EXPORT_TIMEOUT", "1800"))

MAX_SUBCARRIERS = 8192

_SAFE_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


def _bad(msg: str, code: int = 400):
    return JSONResponse({"ok": False, "error": msg}, status_code=code)


async def _json(req: Request) -> dict:
    try:
        return await req.json()
    except Exception:
        return {}


SCRATCH_TTL_S = 3600


def _sweep_scratch() -> None:
    now = time.time()
    for p in EXPORTS.glob(".*"):
        try:
            if p.is_file() and now - p.stat().st_mtime > SCRATCH_TTL_S:
                p.unlink()
        except OSError:
            pass


def _export_path(name: str) -> Path | None:
    if not name or not _SAFE_NAME.match(name):
        return None
    p = (EXPORTS / name).resolve()
    try:
        p.relative_to(EXPORTS.resolve())
    except ValueError:
        return None
    return p if p.is_file() else None


def _run_export(job, d: Path, out: Path, opts: dict) -> dict:
    pkg = d / "package.json"
    xml = d / "scene" / "scene.xml"
    if not pkg.exists():
        raise RuntimeError("this scene has no package.json to trace from")
    if not xml.exists():
        raise RuntimeError("this scene has not been built yet - build it before exporting")

    cmd = [sb.SIONNA_PY, str(sb.SCENE_BUILDER / "channel_export.py"), str(pkg),
           "--scene", str(xml), "--out", str(out), "--json",
           "--srate", str(opts["srate"]),
           "--max-depth", str(opts["max_depth"]),
           "--subcarriers", str(opts["subcarriers"]),
           "--subcarrier-spacing", str(opts["subcarrier_spacing_hz"])]
    if opts.get("reverse_direction"):
        cmd.append("--reverse-direction")
    cmd.append("--normalize-delays" if opts.get("normalize_delays", True)
               else "--no-normalize-delays")
    if opts.get("kpi"):
        cmd.append("--kpi")
    if opts.get("noise_figure_db") is not None:
        cmd += ["--noise-figure-db", str(opts["noise_figure_db"])]
    if opts.get("tx"):
        cmd += ["--tx", str(opts["tx"])]
    cmd += sb._solver_flags(sb.sionna_params(d))

    tail = sb._stream(job, cmd, EXPORT_TIMEOUT)
    try:
        return json.loads(tail.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError("the exporter produced no result; see the job log")


def _given(body: dict, key: str, default):
    v = body.get(key)
    return default if v is None or v == "" else v


def clean_export_opts(body: dict, default_max_depth: int = 5):
    try:
        subcarriers = int(_given(body, "subcarriers", 0))
        spacing = float(_given(body, "subcarrier_spacing_hz", 30e3))
        max_depth = int(_given(body, "max_depth", default_max_depth))
        srate = float(_given(body, "srate", 61.44e6))
    except (TypeError, ValueError):
        return "subcarriers, subcarrier_spacing_hz, max_depth and srate must be numbers"

    if not 0 <= subcarriers <= MAX_SUBCARRIERS:
        return f"subcarriers must be 0..{MAX_SUBCARRIERS} (0 skips the frequency response)"
    if not 0 < spacing <= 1e6:
        return "subcarrier_spacing_hz must be greater than 0 and at most 1 MHz"
    if not 0 <= max_depth <= 12:
        return "max_depth must be 0..12"
    if srate <= 0:
        return "srate must be positive"
    if body.get("kpi") and subcarriers <= 0:
        return ("link KPIs are reduced from the frequency response, so subcarriers "
                "must be greater than 0")

    return {
        "subcarriers": subcarriers,
        "subcarrier_spacing_hz": spacing,
        "max_depth": max_depth,
        "srate": srate,
        "reverse_direction": bool(body.get("reverse_direction")),
        "normalize_delays": bool(body.get("normalize_delays", True)),
        "kpi": bool(body.get("kpi")),
        "tx": body.get("tx"),
    }


@router.post("/scenes/{scene_id}/export")
async def export_channel(scene_id: str, req: Request):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)

    opts = clean_export_opts(body, int(sb.sionna_params(d).get("max_depth", 5)))
    if isinstance(opts, str):
        return _bad(opts)

    direction = "ul" if opts["reverse_direction"] else "dl"
    stamp = time.strftime("%Y%m%d-%H%M%S")
    scratch = bool(body.get("scratch"))
    name = f"{scene_id}_{direction}_{stamp}.npz"
    out = EXPORTS / (f".{name}" if scratch else name)

    job = sb.submit("channel-export", f"channel {direction} · {scene_id}",
                    lambda j: {**_run_export(j, d, out, opts),
                               "scene_id": scene_id, "name": out.name,
                               "download": f"/api/channel/exports/{out.name}"},
                    scene_id=scene_id)
    return await sb._job_response_async(job, body, extra={"scene_id": scene_id})


BUNDLE_TIMEOUT = int(os.environ.get("TOSSI_BUNDLE_TIMEOUT", "900"))


def _traced_gains(d: Path) -> tuple:
    try:
        meta = json.loads((d / "meta.json").read_text())
    except (OSError, ValueError):
        return {}, {}
    gains, paths = {}, {}
    for link in ((meta.get("trace") or {}).get("links") or []):
        name = link.get("ue") or link.get("rx")
        if not name:
            continue
        g = link.get("gain_db")
        if isinstance(g, (int, float)):
            gains[str(name)] = round(float(g), 2)
        n = link.get("paths")
        if isinstance(n, int):
            paths[str(name)] = n
    return gains, paths


def _bundle_facts(p: Path) -> dict:
    try:
        with zipfile.ZipFile(p) as z:
            name = next((n for n in z.namelist() if n.endswith("manifest.json")), None)
            if not name:
                return {}
            m = json.loads(z.read(name))
    except (OSError, ValueError, KeyError, zipfile.BadZipFile):
        return {}
    out = {}
    for key in ("city", "link_gain_db", "link_paths"):
        if m.get(key):
            out[key] = m[key]
    if isinstance(m.get("nof_meshes"), int):
        out["nof_meshes"] = m["nof_meshes"]
    return out


def _run_bundle(job, scene_id: str, d: Path, out: Path, opts: dict) -> dict:
    pkg = d / "package.json"
    if not pkg.exists():
        raise RuntimeError("this scene has no package.json to export from")
    if not (d / "scene" / "scene.xml").exists():
        raise RuntimeError("this scene has not been built yet - build it before bundling")

    from . import provenance
    prov_path = out.with_suffix(".prov.json")
    prov_path.write_text(json.dumps(provenance.run_provenance(d)))

    cmd = [sb.SIONNA_PY, str(sb.SCENE_BUILDER / "bundle.py"), str(pkg),
           "--scene-dir", str(d / "scene"), "--out", str(out), "--json",
           "--srate", str(opts["srate"]),
           "--max-depth", str(opts["max_depth"]),
           "--subcarriers", str(opts["subcarriers"]),
           "--subcarrier-spacing", str(opts["subcarrier_spacing_hz"]),
           "--provenance", str(prov_path)]
    cmd.append("--normalize-delays" if opts.get("normalize_delays", True)
               else "--no-normalize-delays")
    if opts.get("tx"):
        cmd += ["--tx", str(opts["tx"])]
    cmd += sb._solver_flags(sb.sionna_params(d))

    gains, npaths = _traced_gains(d)
    if gains:
        cmd += ["--link-gain-db", json.dumps(gains)]
    if npaths:
        cmd += ["--link-paths", json.dumps(npaths)]

    try:
        tail = sb._stream(job, cmd, BUNDLE_TIMEOUT)
    finally:
        prov_path.unlink(missing_ok=True)
    try:
        return json.loads(tail.strip().splitlines()[-1])
    except (ValueError, IndexError):
        raise RuntimeError("the bundler produced no result; see the job log")


@router.post("/scenes/{scene_id}/bundle")
async def bundle_scene(scene_id: str, req: Request):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)

    opts = clean_export_opts(body, int(sb.sionna_params(d).get("max_depth", 5)))
    if isinstance(opts, str):
        return _bad(opts)

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = EXPORTS / f"{scene_id}_bundle_{stamp}.zip"

    job = sb.submit("scene-bundle", f"bundle · {scene_id}",
                    lambda j: {**_run_bundle(j, scene_id, d, out, opts),
                               "scene_id": scene_id, "name": out.name,
                               "download": f"/api/channel/exports/{out.name}"},
                    scene_id=scene_id)
    return await sb._job_response_async(job, body, extra={"scene_id": scene_id})


@router.get("/scenes/{scene_id}/exports")
def list_exports(scene_id: str):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    out = []
    _sweep_scratch()
    for p in sorted(EXPORTS.glob(f"{scene_id}_*"), reverse=True):
        if p.suffix not in (".npz", ".zip") or not p.is_file():
            continue
        st = p.stat()
        row = {"name": p.name, "bytes": st.st_size, "created": st.st_mtime,
               "kind": "bundle" if p.suffix == ".zip" else "channel",
               "download": f"/api/channel/exports/{p.name}"}
        if row["kind"] == "bundle":
            row.update(_bundle_facts(p))
        if row["kind"] == "channel":
            row["direction"] = "uplink" if "_ul_" in p.name else "downlink"
            csv = p.with_suffix("").with_name(p.stem + "_paths.csv")
            if csv.is_file():
                row["paths"] = f"/api/channel/exports/{csv.name}"
                row["paths_bytes"] = csv.stat().st_size
        out.append(row)
    return {"ok": True, "scene_id": scene_id, "exports": out,
            "traced_at": sb._read_meta(d).get("traced_at")}


@router.get("/exports/{name}")
def download_export(name: str):
    p = _export_path(name)
    if p is None:
        return _bad("unknown export", 404)
    kind = "text/csv" if p.suffix == ".csv" else "application/octet-stream"
    return FileResponse(p, media_type=kind, filename=p.name)


@router.delete("/exports/{name}")
def delete_export(name: str):
    p = _export_path(name)
    if p is None:
        return _bad("unknown export", 404)
    p.unlink()
    if p.suffix == ".npz":
        p.with_suffix("").with_name(p.stem + "_paths.csv").unlink(missing_ok=True)
    return {"ok": True, "deleted": name}


KPI_SUBCARRIERS = 512
KPI_SPACING_HZ = 30e3

KPI_NOISE_FIGURE_DB = 7.0
NOISE_FIGURE_RANGE = (0.0, 30.0)


@router.post("/scenes/{scene_id}/linkkpi")
async def link_kpis(scene_id: str, req: Request):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    body = await _json(req)

    body = {**body, "kpi": True,
            "subcarriers": _given(body, "subcarriers", KPI_SUBCARRIERS),
            "subcarrier_spacing_hz": _given(body, "subcarrier_spacing_hz", KPI_SPACING_HZ)}
    opts = clean_export_opts(body, int(sb.sionna_params(d).get("max_depth", 5)))
    if isinstance(opts, str):
        return _bad(opts)

    lo, hi = NOISE_FIGURE_RANGE
    try:
        nf = float(_given(body, "noise_figure_db", KPI_NOISE_FIGURE_DB))
    except (TypeError, ValueError):
        return _bad("noise_figure_db must be a number in dB")
    if not (lo <= nf <= hi):
        return _bad(f"noise_figure_db must be between {lo:.0f} and {hi:.0f} dB")
    opts["noise_figure_db"] = nf

    tmp = EXPORTS / f".kpi_{scene_id}_{int(time.time())}.npz"

    def work(job):
        try:
            res = _run_export(job, d, tmp, opts)
        finally:
            tmp.unlink(missing_ok=True)
            tmp.with_suffix("").with_name(tmp.stem + "_paths.csv").unlink(missing_ok=True)
        out = {"scene_id": scene_id, "kpis": res.get("kpis") or [],
               "direction": res.get("direction"),
               "num_subcarriers": res.get("num_subcarriers"),
               "subcarrier_spacing_hz": res.get("subcarrier_spacing_hz")}
        meta = sb._read_meta(d)
        sb._write_meta(
            d,
            link_kpis=out,
            link_kpis_at=time.time(),
            link_kpis_of=meta.get("traced_at"),
            link_kpis_nf=opts.get("noise_figure_db"),
        )
        return out

    job = sb.submit("link-kpi", f"link KPIs · {scene_id}", work, scene_id=scene_id)
    return await sb._job_response_async(job, body, extra={"scene_id": scene_id})
