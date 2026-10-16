from __future__ import annotations

import json
import re
import shlex
import subprocess
import threading
import time
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException

from . import deploy_bridge as d
from . import sionna_bridge as sb
from .auth import require_user
from .remote_mirror import MIRROR, find_host, ssh_argv

router = APIRouter(prefix="/api/sim", tags=["sim"], dependencies=[Depends(require_user)])

STACK = "sionna-rt-ocudu"
SIM = d.VAR / "dashboard" / "sim"
DU_MIRROR = SIM / "du"
ACTIVE = SIM / "active.json"
RAN = ("sionna", "ocudu-cu", "ocudu", "oai-nrue", "nue")


def _primary_target() -> str:
    from .hosts import _target, primary
    return _target(primary())


def _nick(target: str) -> str:
    h = find_host(target)
    return (h or {}).get("nickname") or target


def _safe(target: str) -> str:
    return re.sub(r"[^\w.-]", "_", target)


def _placement(hosts: dict) -> dict:
    env = d.stack_env(STACK)
    p = _primary_target()
    return {c: hosts.get(c) or p for c in env.get("COMPONENTS", "").split()}


def _key(pl: dict) -> str:
    return "|".join(f"{c}={pl[c]}" for c in sorted(pl) if c != "core5g")


@router.get("/deployments")
def deployments():
    entries: dict[str, dict] = {}
    for m in sorted((d.VAR / "runs" / STACK).glob("*/meta.json")):
        try:
            meta = json.loads(m.read_text())
        except (OSError, ValueError):
            continue
        if not (meta.get("up_at") or meta.get("outcome") in ("stopped", "running")):
            continue
        pl = _placement(meta.get("hosts") or {})
        e = entries.setdefault(_key(pl), {"id": _key(pl), "placement": pl, "runs": 0})
        e["runs"] += 1
        e["last"], e["user"] = meta.get("started"), meta.get("user")
    saved = _placement(d.hosts(d.stack_env(STACK)))
    on = d.running_on().get(STACK, [])
    out = []
    for e in sorted(entries.values(), key=lambda x: -(x.get("last") or 0)):
        servers = sorted({t for c, t in e["placement"].items() if c in RAN})
        e.update(servers=[{"target": t, "nickname": _nick(t)} for t in servers],
                 publisher=e["placement"].get("sionna"), current=_key(saved) == e["id"],
                 running=bool(on) and _key(saved) == e["id"])
        out.append(e)
    job = d.active_job()
    return {"stack": STACK, "deployments": out, "running": bool(on), "running_on": on,
            "job": job if job and job.get("stack") == STACK else None, "mirror": _mirror_view()}


def _remote(target: str) -> dict:
    h = find_host(target)
    if not h:
        raise HTTPException(404, f"no server {target} on the Servers page")
    return h


def _home(h: dict) -> str:
    if h.get("primary"):
        return str(Path.home())
    r = subprocess.run([*ssh_argv(h), "echo $HOME"], capture_output=True, text=True, timeout=15)
    home = r.stdout.strip()
    if r.returncode or not home.startswith("/"):
        raise HTTPException(502, f"cannot reach {h['nickname']}: {(r.stderr or r.stdout).strip()[-200:]}")
    return home


def _trees(h: dict) -> tuple[str, str]:
    env = d.stack_env(STACK)
    if h.get("primary"):
        return env["OCUDU_SRC_DIR"], env["OAI_SRC_DIR"]
    q = shlex.quote
    r = subprocess.run([*ssh_argv(h), f". ~/tossi-automation/automation/lib/includes.sh >/dev/null 2>&1; "
                        f"repo_src OCUDU-RAN {q(env['OCUDU_BRANCH'])}; repo_src OAI-RAN {q(env['OAI_BRANCH'])}"],
                       capture_output=True, text=True, timeout=20)
    out = r.stdout.split()
    if r.returncode or len(out) != 2:
        raise HTTPException(502, f"cannot read the stack's trees on {h['nickname']}: {(r.stderr or r.stdout).strip()[-200:]}")
    return out[0], out[1]


def _sync_du(target: str) -> Path:
    h = _remote(target)
    ocudu, _ = _trees(h)
    dst = DU_MIRROR / _safe(target)
    dst.mkdir(parents=True, exist_ok=True)
    if h.get("primary"):
        src = Path(ocudu) / "configs"
        for f in src.glob("du*.y*ml") if src.is_dir() else []:
            (dst / f.name).write_bytes(f.read_bytes())
    else:
        rsh = " ".join(ssh_argv(h)[:-1])
        r = subprocess.run(["rsync", "-a", "--delete", "--include=du*.yml", "--include=du*.yaml", "--exclude=*",
                            "-e", rsh, f"{ssh_argv(h)[-1]}:{ocudu}/configs/", f"{dst}/"],
                           capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise HTTPException(502, f"could not read DU configs on {h['nickname']}: {r.stderr.strip()[-200:]}")
    if dst not in sb.DU_CONFIG_DIRS:
        sb.DU_CONFIG_DIRS.append(dst)
    return dst


@router.get("/du-configs")
def du_configs(target: str):
    dst = _sync_du(target)
    default = d.read_settings(STACK).get("OCUDU_CFG") or d.stack_env(STACK).get("OCUDU_CFG", "")
    return {"target": target, "default": Path(default).name,
            "configs": [{"name": f.name, "path": str(f), "default": f.name == Path(default).name}
                        for f in sorted(dst.glob("du*.y*ml"))]}


def _mirror_view() -> dict:
    st = MIRROR.state
    return {"active": MIRROR.active, "label": MIRROR.label, "reachable": st.get("reachable"),
            "age_s": round(time.time() - st["at"], 1) if st.get("at") else None,
            "procs": sorted(st.get("procs", set()))}


def _start_mirror(target: str, ocudu: str, oai: str, home: str, plan: dict) -> None:
    h = _remote(target)
    run = f"{home}/tossi-automation/var/run/{STACK}" if not h.get("primary") else str(d.VAR / "run" / STACK)
    MIRROR.begin(ssh_argv(h), {
        "channel.out": f"{run}/sionna.log", "rays.json": f"{run}/rays.json",
        "cu.log": f"{ocudu}/cu.log", "du.log": f"{ocudu}/du.log",
        "ue1_nue.log": f"{oai}/multi_ue_sim/logs/ue1_nue.log",
    }, _nick(target))
    sb.LIVE.remote_begin(target, plan["scene_id"], plan["params"], plan["route"], on_stop=_stop_job)
    threading.Thread(target=_walk_guards, args=(plan.get("move_start"),), daemon=True).start()


def _walk_guards(move_start) -> None:
    for _ in range(600):
        if not MIRROR.active:
            return
        if sb.LIVE.is_running():
            if move_start == "on_ip":
                threading.Thread(target=sb._release_on_ip, daemon=True).start()
            sb._hold_walk_without_a_ue()
            return
        time.sleep(1)


def _end_mirror() -> None:
    MIRROR.end()
    sb.LIVE.remote_end()
    ACTIVE.unlink(missing_ok=True)


def _stop_job(user: str = "simulation") -> dict:
    job = d.start(STACK, "stop", {}, user)
    def wait():
        while (j := d._jobs.get(job["id"])) and j.state == "running":
            time.sleep(2)
        _end_mirror()
    threading.Thread(target=wait, daemon=True).start()
    return job


@router.post("/run")
def run(body: dict = Body(...), user: str = Depends(require_user)):
    want = body.get("placement") or {}
    if not isinstance(want, dict) or "sionna" not in want:
        raise HTTPException(400, "placement: pick one of the deployments")
    known = {e["id"]: e for e in deployments()["deployments"]}
    pl = _placement(want)
    if _key(pl) not in known:
        raise HTTPException(400, "that placement has never come up for this stack")
    if d.active_job():
        raise HTTPException(409, "a job is running -- wait for it or cancel it")
    if d.running_on().get(STACK):
        raise HTTPException(409, f"{STACK} is already running -- stop it first")
    scene_id = str(body.get("scene_id") or "")
    sd = sb._scene_dir(scene_id)
    if not sd or not (sd / "scene" / "scene.xml").exists():
        raise HTTPException(404, "pick a built scene")

    target = pl["sionna"]
    h = _remote(target)
    home = _home(h)
    ocudu, oai = _trees(h)
    du_dir = _sync_du(target)
    du_path = Path(str(body.get("du_config") or ""))
    if not du_path.name:
        du_path = du_dir / (Path(d.read_settings(STACK).get("OCUDU_CFG") or d.stack_env(STACK).get("OCUDU_CFG", "")).name)
    du_path = (du_dir / du_path.name)
    if not du_path.is_file():
        raise HTTPException(400, f"{du_path.name} is not a DU config in the stack's tree on {h['nickname']}")

    base = (f"{home}/tossi-automation/var" if not h.get("primary") else str(d.VAR))
    sdir = str(sd) if h.get("primary") else f"{base}/scenes/{sd.name}"
    rays = f"{base}/run/{STACK}/rays.json"
    plan = sb._live_plan({**{k: body[k] for k in ("move_start", "loop_route", "laps", "speed_mps") if k in body},
                          "scene_id": sd.name, "du_config": str(du_path), "owner": "raytrace"},
                         remote={"scene_xml": f"{sdir}/scene/scene.xml", "rays_out": rays,
                                 "go_file": "/tmp/tossi_live_go"})
    if not isinstance(plan, dict):
        raise HTTPException(plan.status_code, json.loads(plan.body).get("error", "cannot stream this scene"))
    args = " ".join(shlex.quote(a) for a in plan["cmd"][3:])

    if h.get("primary"):
        Path(f"{d.VAR}/run/{STACK}").mkdir(parents=True, exist_ok=True)
        argfile = SIM / "publisher.args"
        SIM.mkdir(parents=True, exist_ok=True)
        argfile.write_text(args + "\n")
        argfile = str(argfile)
        builder = str(sb.SCENE_BUILDER)
    else:
        argv, rsh = ssh_argv(h), " ".join(ssh_argv(h)[:-1])
        dest = argv[-1]
        subprocess.run([*argv, f"mkdir -p {shlex.quote(sdir)} {shlex.quote(base)}/run/{STACK} {shlex.quote(base)}/scene_builder"], check=True, timeout=20)
        r = subprocess.run(["rsync", "-a", "--delete", "-e", rsh, f"{sd}/scene/", f"{dest}:{sdir}/scene/"],
                           capture_output=True, text=True, timeout=600)
        if r.returncode:
            raise HTTPException(502, f"could not copy the scene to {h['nickname']}: {r.stderr.strip()[-200:]}")
        argfile = f"{sdir}/publisher.args"
        builder = f"{base}/scene_builder"
        r = subprocess.run(["rsync", "-a", "-e", rsh, *(str(sb.SCENE_BUILDER / m) for m in ("linkkpi.py", "doppler.py")),
                            f"{dest}:{builder}/"], capture_output=True, text=True, timeout=60)
        if r.returncode:
            raise HTTPException(502, f"could not copy the ray tools to {h['nickname']}: {r.stderr.strip()[-200:]}")
        subprocess.run([*argv, f"cat > {shlex.quote(argfile)}"], input=args + "\n", text=True, check=True, timeout=20)
    if plan["move_start"] == "auto":
        (subprocess.run(["touch", "/tmp/tossi_live_go"]) if h.get("primary")
         else subprocess.run([*ssh_argv(h), "touch /tmp/tossi_live_go"], timeout=15))
    else:
        (subprocess.run(["rm", "-f", "/tmp/tossi_live_go"]) if h.get("primary")
         else subprocess.run([*ssh_argv(h), "rm -f /tmp/tossi_live_go"], timeout=15))

    s = d.read_settings(STACK)
    for c, t in pl.items():
        k = "HOST_" + c.upper().replace("-", "_")
        if t == _primary_target():
            s.pop(k, None)
        else:
            s[k] = t
    s["SIONNA_ARGS_FILE"] = argfile
    s["SIONNA_SCENE_BUILDER"] = builder
    s["OCUDU_CFG"] = du_path.name
    d.write_settings(STACK, s)
    d._cache["at"] = 0.0
    d._topo_cache["at"] = 0.0

    job = d.start(STACK, "deploy", {}, user)
    state = {"target": target, "ocudu": ocudu, "oai": oai, "home": home, "scene_id": sd.name,
             "params": plan["params"], "route": plan["route_info"], "move_start": plan["move_start"],
             "job": job["id"], "at": time.time()}
    SIM.mkdir(parents=True, exist_ok=True)
    ACTIVE.write_text(json.dumps(state))
    _start_mirror(target, ocudu, oai, home, state)
    return {"ok": True, "job": job, "target": target, "du_config": du_path.name,
            "warnings": plan["warnings"], "params": plan["params"]}


@router.post("/stop")
def stop(user: str = Depends(require_user)):
    if d.active_job():
        raise HTTPException(409, "a job is running -- wait for it or cancel it")
    return {"ok": True, "job": _stop_job(user)}


@router.get("/state")
def state():
    return {"mirror": _mirror_view(), "live": sb.LIVE.status().get("remote"),
            "running_on": d.running_on().get(STACK, [])}


def _resume() -> None:
    try:
        st = json.loads(ACTIVE.read_text())
    except (OSError, ValueError):
        return
    if d.running_on().get(STACK):
        _start_mirror(st["target"], st["ocudu"], st["oai"], st["home"], st)
    else:
        ACTIVE.unlink(missing_ok=True)


threading.Thread(target=_resume, name="sim-resume", daemon=True).start()
