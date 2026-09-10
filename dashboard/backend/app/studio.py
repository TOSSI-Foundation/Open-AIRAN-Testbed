from __future__ import annotations

import os
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from . import deploy_bridge as d
from .auth import require_user

router = APIRouter(prefix="/api/studio", tags=["studio"], dependencies=[Depends(require_user)])
SECRETS = d.VAR / "dashboard"
MAX_EDIT = 2 << 20


def roots() -> list[dict]:
    ws = Path(os.environ.get("WORKSPACE", Path.home() / "tossi-ran"))
    seen: dict[str, str] = {}
    for s in d.list_stacks():
        src = (s.get("env") or {}).get("OCUDU_SRC_DIR")
        if src and Path(src).is_dir():
            seen.setdefault(str(Path(src).resolve()), f"OCUDU · {Path(src).name}")
    for p, label in ((ws / "xFAPI", "xFAPI"), (ws / "OAI-RAN", "OAI-RAN"), (d.AUTO / "configs", "automation configs"),
                     (d.VAR / "configs", "edited configs")):
        if p.is_dir():
            seen.setdefault(str(p.resolve()), label)
    return [{"label": v, "path": k} for k, v in sorted(seen.items(), key=lambda kv: kv[1])]


def _inside(path: str) -> Path:
    p = Path(os.path.expanduser(path)).resolve()
    if p == SECRETS.resolve() or SECRETS.resolve() in p.parents:
        raise HTTPException(403, "not available here")
    if not any(p == Path(r["path"]) or Path(r["path"]) in p.parents for r in roots()):
        raise HTTPException(403, "outside the trees the stacks use")
    return p


@router.get("/roots")
def get_roots():
    return {"roots": roots()}


@router.get("/ls")
def ls(path: str):
    p = _inside(path)
    if not p.is_dir():
        raise HTTPException(404, "not a directory")
    out = []
    for e in sorted(p.iterdir(), key=lambda e: (not e.is_dir(), e.name.lower())):
        if e.name in (".git", "__pycache__", "node_modules"):
            continue
        try:
            st = e.stat()
        except OSError:
            continue
        out.append({"name": e.name, "path": str(e), "dir": e.is_dir(), "bytes": st.st_size, "mtime": st.st_mtime})
    return {"path": str(p), "entries": out[:2000]}


@router.get("/file")
def read(path: str):
    p = _inside(path)
    if not p.is_file():
        raise HTTPException(404, "no such file")
    if p.stat().st_size > MAX_EDIT:
        raise HTTPException(413, "over 2 MB -- open it in a terminal")
    raw = p.read_bytes()
    if b"\0" in raw[:8192]:
        raise HTTPException(415, "binary file")
    return {"path": str(p), "content": raw.decode(errors="replace"), "mtime": p.stat().st_mtime,
            "writable": os.access(p, os.W_OK)}


@router.put("/file")
def write(body: dict = Body(...)):
    p = _inside(str(body.get("path", "")))
    content = str(body.get("content", ""))
    if len(content.encode()) > MAX_EDIT:
        raise HTTPException(413, "over 2 MB")
    if body.get("mtime") and p.is_file() and abs(p.stat().st_mtime - float(body["mtime"])) > 1e-3:
        raise HTTPException(409, "the file changed on disk since you opened it -- reload it first")
    backup = None
    if p.is_file():
        backup = d.VAR / "config-backups" / f"{time.strftime('%Y%m%d-%H%M%S')}-{p.name}"
        backup.parent.mkdir(parents=True, exist_ok=True)
        backup.write_bytes(p.read_bytes())
    try:
        p.write_text(content)
    except PermissionError:
        raise HTTPException(403, f"{p} is not writable by the dashboard user (owned by {p.owner()})")
    return {"path": str(p), "mtime": p.stat().st_mtime, "backup": str(backup) if backup else None}
