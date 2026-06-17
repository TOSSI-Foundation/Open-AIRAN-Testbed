from __future__ import annotations

import json
import os
import shlex
import shutil
import re
import signal
import subprocess
import threading
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException
from fastapi.responses import FileResponse
import yaml

from . import ml_info, topology
from .auth import require_user

REPO = Path(os.environ.get("TOSSI_REPO", Path(__file__).resolve().parents[3]))
AUTO = REPO / "automation"
VAR = REPO / "var"
JOBS_DIR = VAR / "dashboard" / "jobs"

ACTIONS = {
    "check": ["check"],
    "install": ["install"],
    "build": ["build"],
    "deploy": ["deploy"],
    "all": ["all"],
    "stop": ["stop"],
    "killall": ["killall"],
    "train": ["train"],
}

NAME = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
ENV_KEY = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
ENV_VAL = re.compile(r"^[A-Za-z0-9_.,:/@=+\-\[\] ]{0,256}$")
ENV_DENY = {"STACK", "MAKEFLAGS", "MAKEFILES", "SHELL", "PATH", "LD_PRELOAD", "WORKSPACE"}

GROUPS = [
    ("5G Core", lambda s: s.startswith("core-")),
    ("AI-RAN", lambda s: s.startswith("ai-ran")),
    ("Simulation", lambda s: s.startswith(("rfsim", "sionna", "multi-ue"))),
    ("FAPI split", lambda s: "xfapi" in s),
    ("Acceleration", lambda s: any(k in s for k in ("gpu", "acc100", "aerial"))),
    ("Radio & RAN", lambda s: True),
]

router = APIRouter(prefix="/api/deploy", tags=["deploy"], dependencies=[Depends(require_user)])


def group_of(name: str) -> str:
    return next(g for g, match in GROUPS if match(name))


def parse_conf_text(text: str) -> dict:
    desc = next((m.group(1) for m in re.finditer(r"^#\s*desc:\s*(.+)$", text, re.M)), "")
    doc = next((m.group(0) for m in re.finditer(r"https://\S+", text)), "")
    return {"desc": desc.strip(), "doc": doc.rstrip(".,)")}


SHOW_VARS = ("COMPONENTS", "START_ORDER", "NEEDS", "OCUDU_BRANCH", "OAI_BRANCH", "OCUDU_APP",
             "OCUDU_APP_DIR", "OCUDU_CFG", "CU_CFG", "OCUDU_LOW_CFG", "UE_CFG", "GNB_CFG",
             "OAI_GNB_ARGS", "CMAKE_OPTS", "OCUDU_TARGETS", "UE_BUILD_ARGS", "XFAPI_MODE",
             "XFAPI_CFG", "AERIAL_CFG", "NUM_UES", "SIONNA_PUB",
             "CORE_COMPOSE", "PTP_PROFILE", "FH_IF", "USRP_TYPE", "GNB_ID", "HOSTS", "RFSIM_BW",
             "OCUDU_SRC_DIR", "ML_OVERLAY", "OAI_SRC_DIR", "WORKSPACE", "RADIO", "RADIO_CFG",
             "PTP_CFG", "PTP_IF", "UE_CFG", "CORE_COMPOSE", "ML_MODE", "ML_MODEL", "ML_TRAIN",
             "GNB_SPLIT", "OCUDU_BUILD_DIR", "ML_EXTRA_CFG", "CORE",
             "CORE_AMF_ADDR", "CORE_PLMN", "CORE_TAC", "CORE_SST", "CORE_SD", "CORE_CFG_MODE")


def hosts(env: dict) -> dict:
    out = {}
    for c in env.get("COMPONENTS", "").split():
        h = env.get("HOST_" + c.upper().replace("-", "_"), "")
        if h and h not in ("local", "localhost"):
            out[c] = h
    return out
_SHOW = r'''
set -u; . "$1/lib/includes.sh" >/dev/null; load_stack >/dev/null; shift
for v in "$@" $(compgen -v HOST_); do printf '%s=%s\0' "$v" "${!v:-}"; done
'''


def stack_env(name: str) -> dict:
    r = subprocess.run(["bash", "-c", _SHOW, "show", str(AUTO), *SHOW_VARS],
                       env={**os.environ, "STACK": name}, capture_output=True, text=True, timeout=15)
    if r.returncode != 0:
        return {"error": (r.stderr or r.stdout).strip()[-300:]}
    return dict(kv.split("=", 1) for kv in r.stdout.split("\0") if "=" in kv)


def stack_vars(name: str) -> dict:
    env = stack_env(name)
    if "error" in env:
        return env
    cs = env["COMPONENTS"].split()
    uses = lambda prefix: any(c.startswith(prefix) for c in cs)   # noqa: E731
    return {"components": cs, "start_order": env["START_ORDER"].split(), "needs": env["NEEDS"].split(),
            "ocudu_branch": env["OCUDU_BRANCH"] if uses("ocudu") else "",
            "oai_branch": env["OAI_BRANCH"] if uses("oai-") else "", "env": env,
            "hosts": hosts(env), "trainable": bool(env.get("ML_TRAIN"))}


_cache: dict = {"at": 0.0, "stacks": []}


def list_stacks(force: bool = False) -> list[dict]:
    if not force and time.time() - _cache["at"] < 30:
        return _cache["stacks"]
    out = []
    for conf in sorted((AUTO / "stacks").glob("*.conf")):
        name = conf.stem
        out.append({"name": name, "group": group_of(name),
                    **parse_conf_text(conf.read_text(errors="replace")), **stack_vars(name)})
    _cache.update(at=time.time(), stacks=out)
    return out


def known_stack(name: str) -> str:
    if not NAME.match(name) or not (AUTO / "stacks" / f"{name}.conf").is_file():
        raise HTTPException(404, f"no such stack '{name}'")
    return name


def running_on() -> dict[str, list[str]]:
    from .hosts import probe
    by = probe()
    out: dict[str, list[str]] = {}
    for t, p in by.items():
        for s in p["sessions"]:
            out.setdefault(s, []).append(t)
    for st in list_stacks():
        env = st.get("env") or {}
        if env.get("COMPONENTS") == "core5g":
            core = env.get("CORE") or "oai-cn5g"
            out[st["name"]] = [t for t, p in by.items() if core in p["cores"]]
    return {k: v for k, v in out.items() if v}


def running_sessions() -> set[str]:
    return set(running_on())


def build_state(stack: str, recent: list[dict]) -> dict:
    mark = VAR / "run" / stack / "built"
    at = mark.stat().st_mtime if mark.is_file() else None
    job = next((j for j in recent if j["stack"] == stack and j["action"] in ("build", "all")), None)
    if job and job["state"] == "running":
        return {"state": "building", "at": job["started"]}
    if job and job["state"] in ("failed", "cancelled") and (at is None or job["started"] > at):
        return {"state": "failed", "at": job.get("ended") or job["started"]}
    if at:
        return {"state": "built", "at": at}
    return {"state": "none", "at": None}


@router.get("/stacks")
def stacks(refresh: bool = False):
    live = running_on()
    recent = jobs(200)
    return {"repo": str(REPO), "groups": [g for g, _ in GROUPS],
            "stacks": [{**s, "running": s["name"] in live, "running_on": live.get(s["name"], []),
                        "build": build_state(s["name"], recent)} for s in list_stacks(refresh)]}


def clean_env(env: dict | None) -> dict:
    out = {}
    for k, v in (env or {}).items():
        v = str(v)
        if not ENV_KEY.match(k) or k in ENV_DENY:
            raise HTTPException(400, f"override '{k}' is not allowed")
        if not ENV_VAL.match(v):
            raise HTTPException(400, f"override {k} has characters that are not allowed")
        out[k] = v
    return out


def make_argv(stack: str, action: str, env: dict) -> list[str]:
    return ["make", "--no-print-directory", *ACTIONS[action], f"STACK={stack}",
            *(f"{k}={v}" for k, v in env.items())]


class Job:
    def __init__(self, stack: str, action: str, env: dict, user: str):
        self.id = time.strftime("%Y%m%d-%H%M%S-") + uuid.uuid4().hex[:6]
        self.stack, self.action, self.env, self.user = stack, action, env, user
        self.argv = make_argv(stack, action, env)
        self.log = JOBS_DIR / f"{self.id}.log"
        self.started, self.ended, self.rc = time.time(), None, None
        self.proc: subprocess.Popen | None = None

    @property
    def state(self) -> str:
        if self.rc is None:
            return "running"
        return "ok" if self.rc == 0 else ("cancelled" if self.rc < 0 else "failed")

    def view(self) -> dict:
        return {"id": self.id, "stack": self.stack, "action": self.action, "env": self.env,
                "user": self.user, "cmd": " ".join(self.argv), "state": self.state, "rc": self.rc,
                "started": self.started, "ended": self.ended, "pgid": self.proc.pid if self.proc else None}


_jobs: dict[str, Job] = {}
_lock = threading.Lock()


def _run(job: Job) -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)
    with open(job.log, "wb") as out:
        out.write(f"$ {' '.join(job.argv)}\n".encode())
        out.flush()
        job.proc = subprocess.Popen(job.argv, cwd=REPO, stdout=out, stderr=subprocess.STDOUT,
                                    stdin=subprocess.DEVNULL, start_new_session=True)
        (JOBS_DIR / f"{job.id}.json").write_text(json.dumps(job.view()))
        job.rc = job.proc.wait()
    job.ended = time.time()
    (JOBS_DIR / f"{job.id}.json").write_text(json.dumps(job.view()))


def _alive(pgid: int | None) -> bool:
    try:
        return bool(pgid) and os.killpg(pgid, 0) is None
    except OSError:
        return False


def active_job() -> dict | None:
    j = next((j for j in _jobs.values() if j.state == "running"), None)
    return j.view() if j else next((v for v in _load_finished() if v["state"] == "orphaned"), None)


@router.post("/stacks/{stack}/{action}")
def start(stack: str, action: str, body: dict = Body(default={}), user: str = Depends(require_user)):
    known_stack(stack)
    if action not in ACTIONS:
        raise HTTPException(404, f"unknown action '{action}'")
    env = clean_env(body.get("env"))
    if action == "train" and "TRAIN_HOST" not in env and "TRAIN_HOST" not in read_settings(stack):
        from . import hosts
        g = hosts.gpu_host()
        if g and not g.get("primary"):
            env["TRAIN_HOST"] = hosts._target(g)
        py = ((g or {}).get("specs") or {}).get("torch_python", "")
        if py and py != "python3" and "TRAIN_PY" not in env:
            env["TRAIN_PY"] = py
    with _lock:
        busy = active_job()
        if busy:
            extra = " -- left by a dashboard restart; cancel it in Job log" if busy["state"] == "orphaned" else ""
            raise HTTPException(409, f"{busy['action']} {busy['stack']} is still running ({busy['id']}){extra}")
        job = Job(stack, action, env, user)
        _jobs[job.id] = job
    threading.Thread(target=_run, args=(job,), daemon=True).start()
    return job.view()


def _load_finished() -> list[dict]:
    if not JOBS_DIR.is_dir():
        return []
    out = []
    for f in JOBS_DIR.glob("*.json"):
        try:
            v = json.loads(f.read_text())
        except (OSError, ValueError):
            continue
        if v.get("state") == "running" and v["id"] not in _jobs:
            v["state"] = "orphaned" if _alive(v.get("pgid")) else "lost"
        out.append(v)
    return out


@router.get("/jobs")
def jobs(limit: int = 30):
    seen = {j.id: j.view() for j in _jobs.values()}
    for v in _load_finished():
        seen.setdefault(v["id"], v)
    return sorted(seen.values(), key=lambda v: v["started"], reverse=True)[:max(1, min(limit, 200))]


def _job_or_404(job_id: str) -> tuple[dict, Path]:
    if not re.match(r"^[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$", job_id):
        raise HTTPException(404, "no such job")
    if job_id in _jobs:
        return _jobs[job_id].view(), _jobs[job_id].log
    v = next((v for v in _load_finished() if v["id"] == job_id), None)
    if not v:
        raise HTTPException(404, "no such job")
    return v, JOBS_DIR / f"{job_id}.log"


@router.get("/jobs/{job_id}")
def job(job_id: str, offset: int = 0):
    view, log = _job_or_404(job_id)
    data = b""
    if log.is_file():
        with open(log, "rb") as f:
            f.seek(max(0, offset))
            data = f.read(512 * 1024)
    return {**view, "offset": max(0, offset) + len(data),
            "log": re.sub(r"\x1b\[[0-9;]*m", "", data.decode(errors="replace"))}


@router.post("/jobs/{job_id}/cancel")
def cancel(job_id: str):
    j = _jobs.get(job_id)
    if j and j.state == "running" and j.proc:
        os.killpg(j.proc.pid, signal.SIGTERM)
        return j.view()
    view, _ = _job_or_404(job_id)
    if view["state"] != "orphaned":
        raise HTTPException(409, "job is not running")
    for sig in (signal.SIGCONT, signal.SIGTERM):
        os.killpg(view["pgid"], sig)
    view.update(state="cancelled", rc=-15, ended=time.time())
    (JOBS_DIR / f"{job_id}.json").write_text(json.dumps(view))
    return view


STATUS_ROW = re.compile(r"^(\S+)\s+(up|down)\s+(\S+)\s+(\S+)$")


def parse_status(text: str) -> list[dict]:
    rows = []
    for line in text.splitlines():
        m = STATUS_ROW.match(line.strip())
        if m and m.group(1) != "COMPONENT":
            rows.append({"name": m.group(1), "state": m.group(2),
                         "pid": None if m.group(3) == "-" else m.group(3)})
    return rows


@router.get("/stacks/{stack}/status")
def status(stack: str):
    known_stack(stack)
    r = subprocess.run(["make", "--no-print-directory", "-s", "status", f"STACK={stack}"], cwd=REPO,
                       capture_output=True, text=True, timeout=30)
    return {"stack": stack, "components": parse_status(r.stdout),
            "running": stack in (on := running_on()), "running_on": on.get(stack, [])}


@router.get("/stacks/{stack}/logs/{component}")
def logs(stack: str, component: str, lines: int = 200):
    known_stack(stack)
    if not NAME.match(component):
        raise HTTPException(404, "no such component")
    f = VAR / "run" / stack / f"{component}.log"
    env = stack_env(stack)
    if component in hosts(env):
        r = subprocess.run(["automation/verbs/run.sh", "logs", component], cwd=REPO, env={**os.environ, "STACK": stack},
                           capture_output=True, text=True, timeout=20)
        text = re.sub(r"\x1b\[[0-9;]*m", "", r.stdout or r.stderr)
        return {"component": component, "log": "\n".join(text.splitlines()[-max(1, min(lines, 2000)):])}
    if not f.is_file():
        return {"component": component, "log": ""}
    text = f.read_bytes()[-256 * 1024:].decode(errors="replace")
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    return {"component": component, "log": "\n".join(text.splitlines()[-max(1, min(lines, 2000)):])}


@router.get("/stacks/{stack}/results")
def results(stack: str):
    known_stack(stack)
    base = VAR / "datasets" / stack
    runs = []
    if base.is_dir():
        for d in sorted((p for p in base.iterdir() if p.is_dir()), reverse=True)[:50]:
            runs.append({"run": d.name, "files": [{"name": f.name, "bytes": f.stat().st_size}
                                                   for f in sorted(d.iterdir()) if f.is_file()]})
    return {"stack": stack, "runs": runs}


@router.get("/stacks/{stack}/results/{run}/{name}")
def result_file(stack: str, run: str, name: str):
    known_stack(stack)
    if not NAME.match(run) or not NAME.match(name):
        raise HTTPException(404, "no such file")
    f = VAR / "datasets" / stack / run / name
    if not f.is_file():
        raise HTTPException(404, "no such file")
    return FileResponse(f, filename=f"{stack}-{run}-{name}")


@router.get("/stacks/{stack}/topology")
def stack_topology(stack: str):
    known_stack(stack)
    env = stack_env(stack)
    if "error" in env:
        raise HTTPException(500, env["error"])
    conf = (AUTO / "stacks" / f"{stack}.conf").read_text(errors="replace")
    if stack in running_sessions():
        env = live_env(stack, env)
    return {**topology.build(stack, env), **parse_conf_text(conf), "group": group_of(stack)}


def live_env(stack: str, env: dict) -> dict:
    order = env.get("START_ORDER", "").split()
    extra = sorted(p.stem for p in (VAR / "run" / stack).glob("*.pid") if p.stem not in order)
    return {**env, "START_ORDER": " ".join(order + extra)} if extra else env


_topo_cache: dict = {"at": 0.0, "all": []}


@router.get("/topology")
def all_topologies(refresh: bool = False):
    if refresh or time.time() - _topo_cache["at"] > 30:
        out = []
        for conf in sorted((AUTO / "stacks").glob("*.conf")):
            env = stack_env(conf.stem)
            if "error" not in env and env.get("COMPONENTS") != "core5g":
                out.append({**topology.build(conf.stem, env), **parse_conf_text(conf.read_text(errors="replace")),
                            "group": group_of(conf.stem)})
        _topo_cache.update(at=time.time(), all=out)
    live = running_sessions()
    out = []
    for t in _topo_cache["all"]:
        if t["stack"] in live:
            env = live_env(t["stack"], stack_env(t["stack"]))
            t = {**t, **topology.build(t["stack"], env)}
        out.append({**t, "running": t["stack"] in live})
    return {"groups": [g for g, _ in GROUPS], "stacks": out}


def _ocudu_src(stack: str) -> tuple[Path, dict]:
    known_stack(stack)
    env = stack_env(stack)
    if "error" in env:
        raise HTTPException(500, env["error"])
    if "ocudu" not in env["COMPONENTS"].split():
        raise HTTPException(404, f"{stack} runs no OCUDU DU")
    return Path(env["OCUDU_SRC_DIR"]), env


@router.get("/stacks/{stack}/ml")
def stack_ml(stack: str):
    src, env = _ocudu_src(stack)
    out = ml_info.summary(src, VAR, stack, env)
    j = active_job()
    out["lifecycle"] = {"mode": env.get("ML_MODE") or "collect", "trainable": bool(env.get("ML_TRAIN")),
                        "training": bool(j and j["stack"] == stack and j["action"] == "train"),
                        "model": ml_info.model_file(src, env["ML_MODEL"]) if env.get("ML_MODEL") else None}
    return out


@router.get("/stacks/{stack}/datasets")
def stack_datasets(stack: str):
    src, env = _ocudu_src(stack)
    cfg = ml_info.merged_config(src, env.get("OCUDU_CFG", ""))
    feats = [n for n in ml_info.FEATURES if isinstance(cfg.get(n), dict)]
    features = [ml_info.feature_state(n, cfg[n]) for n in feats]
    for f in features:
        f["model_file"] = ml_info.model_file(src, f["model"])
    return {"stack": stack, "features": features, "datasets": ml_info.datasets(src, VAR, stack, feats)}


def _dataset(stack: str, key: str) -> Path:
    src, _ = _ocudu_src(stack)
    p = ml_info.dataset_path(src, VAR, stack, key)
    if not p:
        raise HTTPException(404, "no such dataset")
    return p


@router.get("/stacks/{stack}/datasets/preview")
def dataset_preview(stack: str, id: str, n: int = 15):
    return ml_info.preview(_dataset(stack, id), max(1, min(n, 100)))


@router.get("/stacks/{stack}/datasets/download")
def dataset_download(stack: str, id: str):
    p = _dataset(stack, id)
    return FileResponse(p, filename=f"{stack}-{p.name}")


OVR_DIR = VAR / "overrides"
CFG_EXT = (".yml", ".yaml", ".conf", ".cfg")
CONFIG_SLOTS = [
    ("RADIO_CFG", "Radio gNB config", "ocudu"),
    ("OCUDU_CFG", "OCUDU DU / gNB configs", "ocudu"),
    ("ML_EXTRA_CFG", "Extra ML overlays", "ocudu"),
    ("CU_CFG", "OCUDU CU configs", "ocudu"),
    ("OCUDU_LOW_CFG", "OCUDU DU-low config", "ocudu"),
    ("UE_CFG", "UE config", "oai"),
    ("GNB_CFG", "OAI gNB config", "oai"),
    ("CORE_COMPOSE", "5G core compose file", "abs"),
    ("PTP_CFG", "PTP config", "abs"),
]
SLOT_KEYS = {k for k, _, _ in CONFIG_SLOTS}
BUILD_KEYS = ("OCUDU_SRC_DIR", "OCUDU_BUILD_DIR", "CMAKE_OPTS", "OCUDU_TARGETS", "COMPONENTS")


CORE_KEYS = {"CORE": r"oai-cn5g|sd-core|external", "CORE_CFG_MODE": r"default|custom|files", "CORE_AMF_ADDR": r"[A-Za-z0-9.:-]{1,253}",
             "CORE_PLMN": r"\d{5,6}", "CORE_TAC": r"\d{1,8}", "CORE_SST": r"\d{1,3}", "CORE_SD": r"[0-9A-Fa-f]{6}"}


_CORE_DEFAULTS = r"""
. "$AUTO/lib/includes.sh"; load_stack
for k in oai-cn5g sd-core; do
    ( CORE=$k; CORE_CFG_MODE=default; core_settings
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$k" "$CORE_AMF_ADDR" "$CORE_PLMN" "$CORE_TAC" "$CORE_SST" "$CORE_SD" )
done
"""


def core_defaults(stack: str) -> dict:
    r = subprocess.run(["bash", "-c", _CORE_DEFAULTS], env={**os.environ, "STACK": stack, "AUTO": str(AUTO)},
                       capture_output=True, text=True, timeout=20)
    out = {}
    for line in r.stdout.splitlines():
        k, amf, plmn, tac, sst, sd = (line.split("\t") + [""] * 6)[:6]
        out[k] = {"CORE_AMF_ADDR": amf, "CORE_PLMN": plmn, "CORE_TAC": tac, "CORE_SST": sst, "CORE_SD": sd}
    return out


def read_settings(stack: str) -> dict:
    f = OVR_DIR / f"{stack}.env"
    out = {}
    if f.is_file():
        for line in f.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                try:
                    out[k.strip()] = " ".join(shlex.split(v))
                except ValueError:
                    out[k.strip()] = v
    return out


def write_settings(stack: str, settings: dict) -> None:
    OVR_DIR.mkdir(parents=True, exist_ok=True)
    body = "".join(f"{k}={shlex.quote(v)}\n" for k, v in sorted(settings.items()) if v != "")
    (OVR_DIR / f"{stack}.env").write_text(
        f"# {stack}: settings saved from the dashboard; read by automation/lib/includes.sh\n" + body)


def allowed_root(p: Path) -> bool:
    p = p.resolve()
    return any(r in p.parents for r in (Path.home().resolve(), REPO.resolve()))


def resolve_cfg(token: str, base: str, env: dict) -> Path | None:
    if token.startswith("/"):
        return Path(token)
    root = {"ocudu": Path(env.get("OCUDU_SRC_DIR", "")) / "configs", "oai": Path(env.get("OAI_SRC_DIR", ""))}.get(base)
    return root / token if root else None


def stack_files(stack: str, env: dict) -> list[dict]:
    out = []
    for key, label, base in CONFIG_SLOTS:
        val = env.get(key, "")
        if not val:
            continue
        files = []
        for tok in val.split():
            p = resolve_cfg(tok, base, env)
            ok = bool(p and p.is_file())
            files.append({"given": tok, "path": str(p) if p else tok, "exists": ok,
                          "editable": ok and p.suffix in CFG_EXT and allowed_root(p) and p.stat().st_size < 1_000_000})
        out.append({"key": key, "label": label, "value": val, "files": files, "pick": base == "ocudu"})
    return out


def config_choices(stack: str, env: dict) -> list[str]:
    src = Path(env.get("OCUDU_SRC_DIR", "")) / "configs"
    names = sorted(p.name for p in src.glob("*") if p.suffix in CFG_EXT) if env.get("OCUDU_SRC_DIR") else []
    own = VAR / "configs" / stack
    return names + sorted(str(p) for p in own.glob("*") if p.suffix in CFG_EXT)


def knobs(stack: str) -> list[dict]:
    texts = [(AUTO / "stacks" / f"{stack}.conf").read_text(errors="replace")]
    texts += [(AUTO / "stacks" / m).read_text(errors="replace")
              for m in re.findall(r'\$ROOT/stacks/([\w.-]+\.sh)', texts[0]) if (AUTO / "stacks" / m).is_file()]
    out = []
    for t in texts:
        for m in re.finditer(r"^#\s*knob:\s*([A-Z][A-Z0-9_]*)\s+(\S+)\s+(.+)$", t, re.M):
            if any(k["key"] == m.group(1) for k in out):
                continue
            label, _, help_ = m.group(3).partition(" -- ")
            out.append({"key": m.group(1), "choices": m.group(2).split("|"), "label": label.strip(), "help": help_.strip()})
    return out


@router.get("/stacks/{stack}/configs")
def stack_configs(stack: str):
    known_stack(stack)
    env = stack_env(stack)
    if "error" in env:
        raise HTTPException(500, env["error"])
    saved = read_settings(stack)
    ks = knobs(stack)
    for k in ks:
        k["value"] = saved.get(k["key"]) or env.get(k["key"]) or k["choices"][0]
    comps = env.get("COMPONENTS", "").split()
    core = None
    if "core5g" in comps:
        kind = saved.get("CORE") or env.get("CORE") or "oai-cn5g"
        core = {"value": kind, "fixed": stack.startswith("core-"), "defaults": core_defaults(stack),
                "mode": saved.get("CORE_CFG_MODE") or ("custom" if kind == "external" else "default")}
    return {"stack": stack, "slots": stack_files(stack, env), "knobs": ks, "settings": saved, "core": core,
            "choices": config_choices(stack, env),
            "file": str(OVR_DIR / f"{stack}.env"), "source": ocudu_source(env)}


def ocudu_source(env: dict) -> dict | None:
    if not any(c.startswith("ocudu") for c in env.get("COMPONENTS", "").split()):
        return None
    ws, br = Path(env.get("WORKSPACE") or Path.home() / "tossi-ran"), env.get("OCUDU_BRANCH") or "dev"
    main = ws / "OCUDU-RAN"
    try:
        on = subprocess.run(["git", "-C", str(main), "rev-parse", "--abbrev-ref", "HEAD"],
                            capture_output=True, text=True, timeout=5).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        on = ""
    upstream = main if on == br or not main.exists() else ws / "worktrees" / f"OCUDU-RAN-{br}"
    return {"repo": "TOSSI-Foundation/OCUDU-RAN", "branch": br, "upstream": str(upstream),
            "upstream_exists": upstream.is_dir(), "using": env.get("OCUDU_SRC_DIR", "")}


@router.put("/stacks/{stack}/settings")
def save_settings(stack: str, body: dict = Body(...)):
    known_stack(stack)
    settings = clean_env({k: v for k, v in (body.get("settings") or {}).items() if str(v).strip() != ""})
    for k, v in settings.items():
        if k in SLOT_KEYS:
            for tok in v.split():
                if tok.startswith("/"):
                    p = Path(tok)
                    if not p.is_file() or p.suffix not in CFG_EXT + (".yml",) or not allowed_root(p):
                        raise HTTPException(400, f"{k}: {tok} is not a config file under your home or this repo")
    for k, rx in CORE_KEYS.items():
        if settings.get(k) and not re.fullmatch(rx, settings[k]):
            raise HTTPException(400, f"{k}: '{settings[k]}' is not valid")
    tree = settings.get("OCUDU_TREE")
    if tree:
        p = Path(os.path.expanduser(tree))
        if not (p / "apps").is_dir() or not allowed_root(p):
            raise HTTPException(400, f"OCUDU_TREE: {tree} is not an OCUDU checkout under your home")
    if settings.get("OCUDU_PREBUILT", "no") not in ("yes", "no"):
        raise HTTPException(400, "OCUDU_PREBUILT must be yes or no")
    compiled = lambda e: [e.get(k) for k in BUILD_KEYS]   # noqa: E731
    before = compiled(stack_env(stack))
    write_settings(stack, settings)
    if compiled(stack_env(stack)) != before:
        (VAR / "run" / stack / "built").unlink(missing_ok=True)
    _cache["at"] = 0.0
    _topo_cache["at"] = 0.0
    return stack_configs(stack)


def _editable(stack: str, path: str) -> Path:
    env = stack_env(stack)
    for slot in stack_files(stack, env):
        for f in slot["files"]:
            if f["path"] == path and f["editable"]:
                return Path(path)
    raise HTTPException(403, "only config files this stack uses can be opened here")


@router.get("/stacks/{stack}/file")
def read_file(stack: str, path: str):
    known_stack(stack)
    p = _editable(stack, path)
    return {"path": str(p), "content": p.read_text(errors="replace"), "modified": p.stat().st_mtime}


@router.put("/stacks/{stack}/file")
def save_file(stack: str, body: dict = Body(...)):
    known_stack(stack)
    p = _editable(stack, body.get("path", ""))
    content = body.get("content")
    if not isinstance(content, str) or len(content) > 1_000_000:
        raise HTTPException(400, "content missing or too large")
    if p.suffix in (".yml", ".yaml"):
        try:
            yaml.safe_load(content)
        except yaml.YAMLError as e:
            raise HTTPException(400, f"not valid YAML: {e}")
    if body.get("as_copy"):
        slot = body.get("slot", "")
        if slot not in SLOT_KEYS:
            raise HTTPException(400, "as_copy needs the slot it belongs to")
        dest = VAR / "configs" / stack / p.name
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(content)
        env = stack_env(stack)
        settings = read_settings(stack)
        toks = [str(dest) if str(resolve_cfg(t, dict(CONFIG_SLOTS_BASE).get(slot, "abs"), env)) == str(p) else t
                for t in env.get(slot, "").split()]
        settings[slot] = " ".join(toks)
        write_settings(stack, settings)
        return {"saved": str(dest), "slot": slot, "value": settings[slot]}
    backup = VAR / "config-backups" / f"{time.strftime('%Y%m%d-%H%M%S')}-{p.name}"
    backup.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(p, backup)
    try:
        p.write_text(content)
    except PermissionError:
        raise HTTPException(403, f"{p} is not writable by the dashboard user")
    return {"saved": str(p), "backup": str(backup)}


CONFIG_SLOTS_BASE = [(k, b) for k, _, b in CONFIG_SLOTS]
