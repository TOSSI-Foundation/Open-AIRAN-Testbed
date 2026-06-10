from __future__ import annotations

import asyncio
import json
import math
import os
import secrets
import time
from pathlib import Path

from fastapi import Depends, FastAPI, Header, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import data
from . import scenes as scenes_mod
from . import runs as runs_mod
from .sionna_bridge import MODULE as SIONNA_MAP_DIR, router as sionna_router
from .ran_bridge import router as ran_router
from .channel_bridge import router as channel_router
from .provenance import router as provenance_router
from .runs_bridge import router as runs_router
from .deploy_bridge import router as deploy_router  # noqa: E402
from .agents import router as agents_router  # noqa: E402
from .hosts import router as hosts_router  # noqa: E402
from .lake import router as lake_router  # noqa: E402
from .studio import router as studio_router  # noqa: E402

app = FastAPI(title="TOSSI Platform API (placeholder)", version="0.1.0")


_VIEWER_OK = {"/api/login", "/api/logout", "/api/users/me/password"}


@app.middleware("http")
async def _viewers_read_only(request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.url.path.startswith("/api/") \
            and request.url.path not in _VIEWER_OK:
        from .auth import user_from_token
        from .users import role_of
        if role_of(user_from_token(request.headers.get("authorization"))) == "viewer":
            return JSONResponse({"ok": False, "error": "view only", "detail": "view only"}, status_code=403)
    return await call_next(request)

_DEV_ORIGINS = [
    "http://localhost:5173", "http://127.0.0.1:5173",
]
_cors_env = os.environ.get("TOSSI_CORS_ORIGINS", "").strip()
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_env.split(",") if o.strip()] or _DEV_ORIGINS,
    allow_methods=["*"],
    allow_headers=["*"],
)

STATE: dict = {"intents": [], "run_overrides": {}}

from .auth import SESSIONS, require_user  # noqa: E402
from . import users  # noqa: E402
from .terrain_tiles import router as terrain_router  # noqa: E402
from .auth import user_from_token as _user_from_token  # noqa: E402


@app.get("/api/health")
def health():
    return {"ok": True, "service": "tossi-dashboard", "ts": time.time()}


@app.post("/api/login")
async def login(req: Request):
    body = await _json(req)
    username = str(body.get("username", "")).strip()
    password = str(body.get("password", ""))
    if not username:
        return JSONResponse({"ok": False, "error": "Username is required."}, status_code=400)
    if not users.check(username, password):
        return JSONResponse({"ok": False, "error": "Wrong username or password."}, status_code=401)
    token = secrets.token_urlsafe(24)
    SESSIONS[token] = username
    return {"ok": True, "token": token, "user": username}


@app.post("/api/logout")
def logout(authorization: str | None = Header(default=None)):
    parts = (authorization or "").split()
    token = parts[1] if len(parts) == 2 else (authorization or "")
    SESSIONS.pop(token, None)
    return {"ok": True}


@app.get("/api/me")
def me(authorization: str | None = Header(default=None)):
    user = _user_from_token(authorization)
    if not user:
        return JSONResponse({"ok": False, "error": "Not authenticated."}, status_code=401)
    role = users.role_of(user)
    if not role:
        return JSONResponse({"ok": False, "error": "Not authenticated."}, status_code=401)
    return {"user": user, "role": role}


def _scenes_collection() -> list[dict]:
    real = scenes_mod.list_scenes()
    return real if real else data.SCENES


def _runs_collection() -> list[dict]:
    real = runs_mod.list_runs()
    return real if real else data.RUNS


def _collections() -> dict:
    c = dict(data.COLLECTIONS)
    c["scenes"] = _scenes_collection()
    c["runs"] = _runs_collection()
    return c


@app.get("/api/collections", dependencies=[Depends(require_user)])
def collections():
    return _collections()


@app.get("/api/collection/{name}", dependencies=[Depends(require_user)])
def collection(name: str):
    if name == "scenes":
        return _scenes_collection()
    if name == "runs":
        return _runs_collection()
    if name in data.COLLECTIONS:
        return data.COLLECTIONS[name]
    return JSONResponse({"error": f"unknown collection '{name}'"}, status_code=404)


@app.get("/api/scenes", dependencies=[Depends(require_user)])
def scenes_list():
    return _scenes_collection()


@app.get("/api/runs", dependencies=[Depends(require_user)])
def runs_list():
    return _runs_collection()


@app.get("/api/runs/{run_id}/detail", dependencies=[Depends(require_user)])
def run_detail(run_id: str):
    r = runs_mod.get_run(run_id)
    if r is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return r


@app.get("/api/runs/{run_id}/overlay", dependencies=[Depends(require_user)])
def run_overlay(run_id: str):
    uri = runs_mod.overlay_data_uri(run_id)
    if not uri:
        return JSONResponse({"error": "no coverage overlay for this run"}, status_code=404)
    return {"run_id": run_id, "image": uri}


@app.get("/api/scenes/{scene_id}", dependencies=[Depends(require_user)])
def scene(scene_id: str):
    for s in _scenes_collection():
        if s["id"] == scene_id:
            return {**s, "viewer_asset_url": None}
    return JSONResponse({"error": "not found"}, status_code=404)


@app.post("/api/scenes/import/osm", dependencies=[Depends(require_user)])
async def import_osm(req: Request):
    body = await _json(req)
    return _record("scenes.import.osm", body, {"job_id": "job_9f21", "state": "running", "pct": 0})


@app.post("/api/scenes/import/file", dependencies=[Depends(require_user)])
async def import_file(req: Request):
    return _record("scenes.import.file", {}, {"job_id": "job_upl1", "state": "running"})


@app.post("/api/scenarios", dependencies=[Depends(require_user)])
async def create_scenario(req: Request):
    body = await _json(req)
    return _record("scenarios.create", body, {"id": "scn_new", "version": 1})


@app.post("/api/scenarios/{scenario_id}/validate", dependencies=[Depends(require_user)])
def validate_scenario(scenario_id: str):
    return {"scenario_id": scenario_id, "ok": True, "warnings": [], "errors": []}


@app.post("/api/runs", dependencies=[Depends(require_user)])
async def create_run(req: Request):
    body = await _json(req)
    return _record("runs.create", body, {"run_id": "RUN-NEW-0001", "state": "Queued"})


@app.post("/api/runs/{run_id}/start", dependencies=[Depends(require_user)])
def start_run(run_id: str):
    STATE["run_overrides"][run_id] = "Starting"
    return _record("runs.start", {"run_id": run_id}, {"run_id": run_id, "state": "Starting"})


@app.post("/api/runs/{run_id}/stop", dependencies=[Depends(require_user)])
def stop_run(run_id: str):
    STATE["run_overrides"][run_id] = "Completed"
    return _record("runs.stop", {"run_id": run_id}, {"run_id": run_id, "state": "Completed"})


@app.post("/api/runs/{run_id}/ue/{ue}/move", dependencies=[Depends(require_user)])
async def move_ue(run_id: str, ue: str, req: Request):
    body = await _json(req)
    return _record("runs.ue.move", {"run_id": run_id, "ue": ue, **body}, {"ok": True})


@app.post("/api/runs/{run_id}/channel-mode", dependencies=[Depends(require_user)])
async def channel_mode(run_id: str, req: Request):
    body = await _json(req)
    return _record("runs.channel_mode", {"run_id": run_id, **body}, {"ok": True})


@app.get("/api/runs/{run_id}/kpi", dependencies=[Depends(require_user)])
def run_kpi(run_id: str, metric: str = "throughput"):
    now = time.time()
    pts = [
        {"t_ns": int((now - (60 - i)) * 1e9), "value": round(50 + 40 * math.sin(i / 4), 2)}
        for i in range(60)
    ]
    return {"run_id": run_id, "metric": metric, "points": pts}


@app.post("/api/training/jobs", dependencies=[Depends(require_user)])
async def training_job(req: Request):
    body = await _json(req)
    return _record("training.jobs.create", body, {"job_id": "job_new", "state": "Queued"})


@app.post("/api/benchmarks", dependencies=[Depends(require_user)])
async def benchmark(req: Request):
    body = await _json(req)
    return _record("benchmarks.create", body, {"job_id": "bench_new", "state": "Queued"})


@app.post("/api/runs/{run_id}/report", dependencies=[Depends(require_user)])
def make_report(run_id: str):
    return _record("reports.create", {"run_id": run_id}, {"report_url": None, "state": "Generating"})


@app.get("/api/intents", dependencies=[Depends(require_user)])
def intents():
    return STATE["intents"]


@app.websocket("/ws")
async def ws(sock: WebSocket):
    await sock.accept()
    topics = sock.query_params.get("topics", "kpi,ue_state,status").split(",")
    run_id = sock.query_params.get("run_id", "RUN-2024-05-21-001")
    tick = 0
    try:
        await sock.send_json(
            {"topic": "status", "run_id": run_id, "stage": "running",
             "components": [{"name": n, "health": "up"} for n in ("core", "cu", "du", "radio")]}
        )
        while True:
            tick += 1
            t_ns = int(time.time() * 1e9)
            if "kpi" in topics:
                await sock.send_json({
                    "topic": "kpi", "run_id": run_id, "t_ns": t_ns,
                    "events": [
                        {"entity": "system", "entity_id": "cell-agg", "metric": "throughput_mbps",
                         "value": round(830 + 40 * math.sin(tick / 6), 1)},
                        {"entity": "system", "entity_id": "cell-agg", "metric": "sinr_db",
                         "value": round(18 + 3 * math.sin(tick / 5 + 1), 1)},
                        {"entity": "system", "entity_id": "cell-agg", "metric": "connected_ues",
                         "value": 1256 + (tick % 7) - 3},
                    ],
                })
            if "ue_state" in topics:
                await sock.send_json({
                    "topic": "ue_state", "run_id": run_id, "t_ns": t_ns,
                    "ues": [
                        {"id": r["id"], "state": r["state"], "cell": r["cell"], "sinr_db": r["sinr"]}
                        for r in data.UES_LIVE
                    ],
                })
            await asyncio.sleep(1.0)
    except WebSocketDisconnect:
        return
    except Exception:
        return


app.include_router(sionna_router)
app.include_router(deploy_router)
app.include_router(agents_router)
app.include_router(hosts_router)
app.include_router(lake_router)
app.include_router(studio_router)
app.include_router(users.router)
from .sim_bridge import router as sim_router  # noqa: E402
app.include_router(sim_router)
app.include_router(ran_router)
app.include_router(runs_router)
app.include_router(channel_router)
app.include_router(provenance_router)
app.include_router(terrain_router)


class RevalidatingStatic(StaticFiles):

    def file_response(self, *args, **kwargs):
        resp = super().file_response(*args, **kwargs)
        resp.headers["Cache-Control"] = "no-cache"
        return resp


if SIONNA_MAP_DIR.exists():
    app.mount("/sionna-map", RevalidatingStatic(directory=SIONNA_MAP_DIR, html=True), name="sionna-map")


DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    def spa(full_path: str):
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html", headers={"Cache-Control": "no-cache"})


async def _json(req: Request) -> dict:
    try:
        return await req.json()
    except Exception:
        return {}


def _record(kind: str, payload: dict, response: dict) -> dict:
    STATE["intents"].append({"kind": kind, "payload": payload, "ts": time.time()})
    STATE["intents"] = STATE["intents"][-200:]
    return {"ok": True, **response}


@app.on_event("startup")
def _close_orphan_runs() -> None:
    try:
        from .runs_store import close_orphans
        closed = close_orphans()
        if closed:
            print("closed %d orphaned run(s): %s" % (len(closed), ", ".join(closed)))
    except Exception as e:                # noqa: BLE001 - never block startup on bookkeeping
        print("orphan run sweep failed: %s" % e)
