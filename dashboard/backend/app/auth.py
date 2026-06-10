from __future__ import annotations

import os
from pathlib import Path

from fastapi import Header, HTTPException

SESSIONS: dict[str, str] = {}

_PW_FILE = Path(__file__).resolve().parents[3] / "var" / "dashboard" / "password"
SHARED_PASSWORD = (os.environ.get("TOSSI_PASSWORD")
                   or (_PW_FILE.read_text().strip() if _PW_FILE.is_file() else "") or "tossi")


def _open_mode() -> bool:
    return os.environ.get("TOSSI_OPEN", "").strip().lower() in ("1", "true", "yes")


def user_from_token(authorization: str | None) -> str | None:
    if not authorization:
        return None
    parts = authorization.split()
    token = parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else authorization
    return SESSIONS.get(token)


def require_user(authorization: str | None = Header(default=None)) -> str:
    if _open_mode():
        return "open-mode"
    user = user_from_token(authorization)
    if not user:
        raise HTTPException(
            status_code=401,
            detail="authentication required - POST /api/login for a token",
        )
    return user
