from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from .auth import SHARED_PASSWORD, require_user

ROLES = ("admin", "operator", "viewer")
FILE = Path(__file__).resolve().parents[3] / "var" / "dashboard" / "users.json"
NAME = re.compile(r"^[A-Za-z0-9._-]{1,32}$")
_lock = threading.Lock()


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def _entry(role: str, password: str) -> dict:
    salt = secrets.token_hex(16)
    return {"role": role, "salt": salt, "hash": _hash(password, salt), "created": time.time()}


def load() -> dict:
    with _lock:
        if not FILE.is_file():
            _save({"admin": _entry("admin", SHARED_PASSWORD)})
        return json.loads(FILE.read_text())


def _save(users: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(users, indent=1))
    os.chmod(tmp, 0o600)
    os.replace(tmp, FILE)


def check(name: str, password: str) -> bool:
    u = load().get(name)
    return bool(u) and hmac.compare_digest(u["hash"], _hash(password, u["salt"]))


def role_of(name: str | None) -> str | None:
    if name == "open-mode":
        return "admin"
    return (load().get(name or "") or {}).get("role")


def _password(p) -> str:
    p = str(p or "")
    if len(p) < 6:
        raise HTTPException(400, "password: at least 6 characters")
    return p


def _admins(users: dict) -> int:
    return sum(1 for u in users.values() if u["role"] == "admin")


router = APIRouter(prefix="/api/users", tags=["users"])


def require_admin(user: str = Depends(require_user)) -> str:
    if role_of(user) != "admin":
        raise HTTPException(403, "admin only")
    return user


@router.get("")
def list_users(user: str = Depends(require_user)):
    if role_of(user) == "viewer":
        raise HTTPException(403, "admin page: not for viewers")
    return {"me": user, "role": role_of(user), "roles": list(ROLES),
            "users": [{"name": n, "role": u["role"], "created": u.get("created")} for n, u in sorted(load().items())]}


@router.post("")
def add_user(body: dict = Body(...), me: str = Depends(require_admin)):
    name, role = str(body.get("name", "")).strip(), str(body.get("role", "viewer"))
    if not NAME.match(name):
        raise HTTPException(400, "name: letters, digits, . _ - (max 32)")
    if role not in ROLES:
        raise HTTPException(400, f"role: one of {', '.join(ROLES)}")
    users = load()
    if name in users:
        raise HTTPException(409, f"{name} exists")
    users[name] = _entry(role, _password(body.get("password")))
    with _lock:
        _save(users)
    return list_users(me)


@router.patch("/{name}")
def edit_user(name: str, body: dict = Body(...), me: str = Depends(require_admin)):
    users = load()
    if name not in users:
        raise HTTPException(404, f"no user {name}")
    if "role" in body:
        role = str(body["role"])
        if role not in ROLES:
            raise HTTPException(400, f"role: one of {', '.join(ROLES)}")
        if users[name]["role"] == "admin" and role != "admin" and _admins(users) == 1:
            raise HTTPException(400, "the last admin keeps the role")
        users[name]["role"] = role
    if body.get("password"):
        users[name].update({k: v for k, v in _entry(users[name]["role"], _password(body["password"])).items() if k != "created"})
    with _lock:
        _save(users)
    return list_users(me)


@router.delete("/{name}")
def remove_user(name: str, me: str = Depends(require_admin)):
    users = load()
    if name not in users:
        raise HTTPException(404, f"no user {name}")
    if users[name]["role"] == "admin" and _admins(users) == 1:
        raise HTTPException(400, "the last admin cannot be removed")
    del users[name]
    with _lock:
        _save(users)
    from .auth import SESSIONS
    for t in [t for t, u in SESSIONS.items() if u == name]:
        SESSIONS.pop(t, None)
    return list_users(me)


@router.post("/me/password")
def own_password(body: dict = Body(...), me: str = Depends(require_user)):
    if not check(me, str(body.get("current", ""))):
        raise HTTPException(403, "current password is wrong")
    users = load()
    users[me].update({k: v for k, v in _entry(users[me]["role"], _password(body.get("password"))).items() if k != "created"})
    with _lock:
        _save(users)
    return {"ok": True}
