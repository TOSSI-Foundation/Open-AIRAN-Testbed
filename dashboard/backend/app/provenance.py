from __future__ import annotations

import hashlib
import json
import os
import subprocess
import time
from pathlib import Path
from typing import Optional

from fastapi import Depends, APIRouter
from fastapi.responses import JSONResponse

from . import sionna_bridge as sb

from .auth import require_user  # noqa: E402

router = APIRouter(prefix="/api/provenance", tags=["provenance"],
                   dependencies=[Depends(require_user)])

REPO = sb.REPO
DASH_DIR = sb.DASH_DIR

REPOS = {
    "platform": REPO,
    "dashboard": DASH_DIR,
    "ocudu": Path(os.environ.get("TOSSI_OCUDU", REPO / "OCUDU-RAN")),
    "oai": Path(os.environ.get("TOSSI_OAI", REPO / "OAI-RAN")),
}

BINARIES = {
    "odu": REPOS["ocudu"] / "build" / "apps" / "du" / "odu",
    "ocu": REPOS["ocudu"] / "build" / "apps" / "cu" / "ocu",
}

SEAL_NAME = "_provenance.json"

_CHUNK = 1 << 20
_cache: dict = {}


def _bad(msg: str, code: int = 400):
    return JSONResponse({"ok": False, "error": msg}, status_code=code)


def sha256_file(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while True:
                block = f.read(_CHUNK)
                if not block:
                    break
                h.update(block)
        return h.hexdigest()
    except OSError:
        return None


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def short(digest: Optional[str], n: int = 12) -> Optional[str]:
    return digest[:n] if digest else None


def _cached_hash(path: Path) -> Optional[str]:
    try:
        st = path.stat()
    except OSError:
        return None
    key = (str(path), st.st_size, st.st_mtime_ns)
    if key not in _cache:
        _cache[key] = sha256_file(path)
    return _cache[key]


def git_identity(repo: Path) -> dict:
    out = {"path": str(repo), "is_repo": (repo / ".git").exists()}
    if not out["is_repo"]:
        return out

    def _git(*args) -> Optional[str]:
        try:
            p = subprocess.run(["git", "-C", str(repo), *args],
                               capture_output=True, text=True, timeout=15)
            return p.stdout.strip() if p.returncode == 0 else None
        except (OSError, subprocess.SubprocessError):
            return None

    out["commit"] = _git("rev-parse", "HEAD")
    out["commit_short"] = short(out["commit"], 10)
    out["branch"] = _git("rev-parse", "--abbrev-ref", "HEAD")
    status = _git("status", "--porcelain")
    out["dirty"] = bool(status) if status is not None else None
    out["dirty_files"] = len(status.splitlines()) if status else 0
    return out


def binary_identity(path: Path) -> dict:
    try:
        st = path.stat()
    except OSError:
        return {"path": str(path), "exists": False}
    return {
        "path": str(path),
        "exists": True,
        "bytes": st.st_size,
        "mtime": st.st_mtime,
        "built": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
        "sha256": _cached_hash(path),
        "sha256_short": short(_cached_hash(path)),
    }


def env_versions() -> dict:
    key = ("env_versions", sb.SIONNA_PY)
    if key in _cache:
        return _cache[key]
    code = ("import json,importlib\n"
            "o={}\n"
            "for k,m in (('sionna_rt','sionna.rt'),('mitsuba','mitsuba'),"
            "('drjit','drjit'),('numpy','numpy')):\n"
            "    try: o[k]=str(getattr(importlib.import_module(m),'__version__','?'))\n"
            "    except Exception: o[k]='?'\n"
            "print(json.dumps(o))")
    out = {}
    try:
        p = subprocess.run([sb.SIONNA_PY, "-c", code],
                           capture_output=True, text=True, timeout=60)
        if p.returncode == 0 and p.stdout.strip():
            out = json.loads(p.stdout.strip().splitlines()[-1])
    except (OSError, subprocess.SubprocessError, ValueError):
        out = {}
    _cache[key] = out
    return out


def scene_fingerprint(scene_dir: Path) -> dict:
    pkg = scene_dir / "package.json"
    package_sha = sha256_file(pkg)

    mesh_dir = scene_dir / "scene" / "meshes"
    meshes = sorted(mesh_dir.glob("*.ply")) if mesh_dir.is_dir() else []
    roll = hashlib.sha256()
    for m in meshes:
        roll.update(m.name.encode())
        roll.update((sha256_file(m) or "").encode())
    meshes_sha = roll.hexdigest() if meshes else None

    xml = scene_dir / "scene" / "scene.xml"
    xml_sha = sha256_file(xml)

    combined = hashlib.sha256()
    for part in (package_sha, meshes_sha, xml_sha):
        combined.update((part or "-").encode())

    source = {}
    try:
        doc = json.loads(pkg.read_text())
        manifest = doc.get("manifest", doc)
        b = manifest.get("buildings") or {}
        source = {"provider": b.get("source"), "release": b.get("release"),
                  "layer": b.get("layer"), "city": manifest.get("city"),
                  "manifest_version": manifest.get("version"),
                  "bbox": manifest.get("bbox"), "crs": manifest.get("crs")}
    except (OSError, ValueError):
        pass

    return {
        "geometry_sha256": combined.hexdigest(),
        "geometry_short": short(combined.hexdigest()),
        "package_sha256": package_sha,
        "meshes_sha256": meshes_sha,
        "scene_xml_sha256": xml_sha,
        "nof_meshes": len(meshes),
        "source": source,
    }


def stack_identity() -> dict:
    return {
        "repos": {name: git_identity(path) for name, path in REPOS.items()},
        "binaries": {name: binary_identity(path) for name, path in BINARIES.items()},
        "env": env_versions(),
        "sionna_python": sb.SIONNA_PY,
    }


def seal(scene_dir: Path) -> dict:
    record = {
        "sealed_at": time.time(),
        "sealed_at_iso": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "fingerprint": scene_fingerprint(scene_dir),
        "stack": stack_identity(),
    }
    (scene_dir / SEAL_NAME).write_text(json.dumps(record, indent=2))
    return record


def read_seal(scene_dir: Path) -> Optional[dict]:
    try:
        return json.loads((scene_dir / SEAL_NAME).read_text())
    except (OSError, ValueError):
        return None


def verify(scene_dir: Path, *, seal_if_missing: bool = True) -> dict:
    current = scene_fingerprint(scene_dir)
    sealed = read_seal(scene_dir)
    if sealed is None:
        if not seal_if_missing:
            return {"sealed": False, "first_seal": False, "matches": None,
                    "fingerprint": current, "changed": []}
        record = seal(scene_dir)
        return {"sealed": True, "first_seal": True, "matches": True,
                "fingerprint": current, "changed": [], "record": record}

    was = sealed.get("fingerprint") or {}
    changed = [k for k in ("package_sha256", "meshes_sha256", "scene_xml_sha256")
               if was.get(k) != current.get(k)]
    return {
        "sealed": True,
        "first_seal": False,
        "matches": not changed,
        "changed": changed,
        "fingerprint": current,
        "sealed_fingerprint": was,
        "sealed_at_iso": sealed.get("sealed_at_iso"),
        "record": sealed,
    }


def run_provenance(scene_dir: Optional[Path]) -> dict:
    out = {"stack": stack_identity(), "recorded_at": time.time()}
    if scene_dir is not None:
        out["scene"] = scene_fingerprint(scene_dir)
    return out


@router.get("/stack")
def get_stack():
    return {"ok": True, **stack_identity()}


@router.get("/scenes/{scene_id}")
def get_scene(scene_id: str, check_only: bool = False):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    return {"ok": True, "scene_id": scene_id, **verify(d, seal_if_missing=not check_only)}


@router.post("/scenes/{scene_id}/seal")
def post_seal(scene_id: str):
    d = sb._scene_dir(scene_id)
    if not d:
        return _bad("unknown scene_id", 404)
    return {"ok": True, "scene_id": scene_id, "record": seal(d)}
