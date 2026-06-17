from __future__ import annotations

import asyncio
import codecs
import fcntl
import json
import os
import pty
import re
import signal
import socket
import struct
import subprocess
import termios
import time
import uuid
from pathlib import Path

from fastapi import APIRouter, Body, Depends, HTTPException, WebSocket

from . import deploy_bridge as d
from .auth import require_user, user_from_token, _open_mode

router = APIRouter(prefix="/api/hosts", tags=["hosts"])
REG = d.VAR / "dashboard" / "hosts.json"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-o", "StrictHostKeyChecking=accept-new"]
PUBKEY = next((p for p in (Path.home() / ".ssh").glob("id_*.pub")), None) if (Path.home() / ".ssh").is_dir() else None
ADDR = re.compile(r"^[A-Za-z0-9.:-]{1,253}$")
USER = re.compile(r"^[a-z_][a-z0-9_-]{0,31}$")

SPECS = r'''
echo "hostname=$(hostname)"
echo "arch=$(uname -m)"
echo "kernel=$(uname -r)"
echo "os=$( . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME")"
echo "cpu=$(grep -m1 'model name' /proc/cpuinfo | cut -d: -f2- | sed 's/^ *//' || lscpu | sed -n 's/^Model name: *//p')"
echo "cores=$(nproc)"
echo "isolated=$(tr ' ' '\n' </proc/cmdline | sed -n 's/^isolcpus=//p' | sed 's/^[a-z_,]*,\([0-9]\)/\1/')"
echo "mem_gb=$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo)"
echo "hugepages_gb=$(awk '/Hugetlb/{printf "%d", $2/1048576}' /proc/meminfo)"
echo "disk_free_gb=$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)"
# a failing nvidia-smi prints its error on stdout: only a clean exit counts as a GPU.
# Per GPU: "name (N GB)" and "util% · used/total GB" (memory is [N/A] on unified-memory boxes)
g=$(nvidia-smi --query-gpu=name,memory.total,memory.used,utilization.gpu --format=csv,noheader,nounits 2>/dev/null) || g=""
echo "gpus=$(printf '%s\n' "$g" | awk -F', *' 'NF{printf "%s%s", (n++?";":""), $1; if ($2+0) printf " (%d GB)", ($2+512)/1024}')"
echo "gpu_use=$(printf '%s\n' "$g" | awk -F', *' 'NF{printf "%s%s%%", (n++?";":""), $4+0; if ($2+0) printf " · %.1f/%d GB", $3/1024, ($2+512)/1024}')"
echo "gpu_driver=$( [ -n "$g" ] && nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1)"
echo "cuda=$( [ -n "$g" ] && nvidia-smi 2>/dev/null | sed -n 's/.*CUDA Version: *\([0-9.]*\).*/\1/p' | head -1)"
# Can this box train: a python whose PyTorch sees the GPU -- python3, else (GPU boxes only)
# a venv/conda env under $HOME. Run from / so a script in $HOME cannot shadow a module.
torch=""; tpy=""
for p in python3 $( [ -n "$g" ] && ls -d "$HOME"/*/bin/python3 "$HOME"/*/*/bin/python3 "$HOME"/*conda*/envs/*/bin/python 2>/dev/null | head -30); do
    t=$(cd / && timeout 20 "$p" -c 'import torch; print(torch.__version__, "cuda" if torch.cuda.is_available() else "cpu")' 2>/dev/null | tail -1) || continue
    case "$t" in *cuda) torch="$t"; tpy="$p"; break ;; *" cpu") [ -z "$torch" ] && { torch="$t"; tpy="$p"; } ;; esac
done
echo "torch=$torch"
echo "torch_python=$tpy"
echo "dpdk=$(pkg-config --modversion libdpdk 2>/dev/null)"
echo "vfio_nics=$(for x in /sys/bus/pci/drivers/vfio-pci/0000:*; do [ -e "$x" ] && basename "$x"; done 2>/dev/null | paste -sd,)"
echo "nics=$(for x in /sys/class/net/*/device/driver; do [ -e "$x" ] && echo "$(basename "$(dirname "$(dirname "$x")")"):$(basename "$(readlink -f "$x")")"; done 2>/dev/null | paste -sd,)"
echo "ptp=$( (command -v ptp4l || pgrep -x ptp4l) >/dev/null 2>&1 && echo yes)"
echo "acc=$(lspci 2>/dev/null | grep -ciE 'acc100|acc200|processing accelerators')"
echo "docker=$(command -v docker >/dev/null && echo yes)"
echo "stacks=$(tmux ls -F '#{session_name}' 2>/dev/null | grep -v '^studio-' | paste -sd,)"
'''


def _parse(text: str) -> dict:
    out = {}
    for line in text.splitlines():
        k, sep, v = line.partition("=")
        if sep and re.fullmatch(r"[a-z_]+", k):
            out[k] = v.strip()
    for k in ("cores", "mem_gb", "hugepages_gb", "disk_free_gb", "acc"):
        out[k] = int(out[k]) if out.get(k, "").isdigit() else 0
    for k in ("gpus", "gpu_use"):
        out[k] = [x for x in out.get(k, "").split(";") if x]
    for k in ("vfio_nics", "nics", "stacks"):
        out[k] = [x for x in re.split(r"[;,]", out.get(k, "")) if x]
    return out


def local_specs() -> dict:
    r = subprocess.run(["bash", "-c", SPECS], capture_output=True, text=True, timeout=20)
    return _parse(r.stdout)


def _target(h: dict) -> str:
    port = int(h.get("port") or 22)
    return f"{h['user']}@{h['address']}" + (f":{port}" if port != 22 else "")


def _dest(h: dict) -> list[str]:
    return ["-p", str(h.get("port") or 22), f"{h['user']}@{h['address']}"]


def load() -> list[dict]:
    try:
        return json.loads(REG.read_text())
    except (OSError, ValueError):
        return []


def save(hosts: list[dict]) -> None:
    REG.parent.mkdir(parents=True, exist_ok=True)
    REG.write_text(json.dumps(hosts, indent=1))
    REG.chmod(0o600)


def find(hid: str) -> dict:
    h = next((h for h in load() if h["id"] == hid), None)
    if not h:
        raise HTTPException(404, "no such server")
    return h


_primary_cache: dict = {"at": 0.0, "specs": {}}


def primary(fresh: bool = False) -> dict:
    if fresh or time.time() - _primary_cache["at"] > 60:
        _primary_cache.update(at=time.time(), specs=local_specs())
    return {"id": "primary", "nickname": socket.gethostname(), "address": _local_ip(), "user": os.environ.get("USER", ""),
            "primary": True, "specs": _primary_cache["specs"], "test": {"ping_ms": 0, "ssh": True, "sudo": True, "at": time.time()}}


def gpu_host() -> dict | None:
    def score(h: dict) -> tuple:
        sp = h.get("specs") or {}
        torch = sp.get("torch") or ""
        mem = sum(int(m.group(1)) for g in sp.get("gpus", []) for m in [re.search(r"\((\d+) GB\)", g)] if m)
        busy = max((int(m.group(1)) for u in sp.get("gpu_use", []) for m in [re.match(r"(\d+)%", u)] if m), default=0)
        return ("cuda" in torch, bool(torch), -busy // 25, mem, bool(h.get("primary")))
    cands = sorted((h for h in [primary(), *load()] if (h.get("specs") or {}).get("torch")
                    and (h.get("primary") or (h.get("test") or {}).get("ssh"))), key=score, reverse=True)
    for h in cands:
        if h.get("primary") or subprocess.run([*SSH, "-o", "ConnectTimeout=3", *_dest(h), "true"],
                                              capture_output=True, timeout=8).returncode == 0:
            return h
    return None


def _local_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("10.255.255.255", 1))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"


@router.get("")
def hosts(user: str = Depends(require_user)):
    g = gpu_host()
    return {"primary": primary(), "hosts": load(), "trains_ml": g["id"] if g else None,
            "pubkey": PUBKEY.read_text().strip() if PUBKEY else None, "pubkey_path": str(PUBKEY) if PUBKEY else None}


@router.post("")
def add_host(body: dict = Body(...), user: str = Depends(require_user)):
    nick = str(body.get("nickname", "")).strip()[:40]
    addr, login = str(body.get("address", "")).strip(), str(body.get("user", "")).strip()
    try:
        port = int(body.get("port") or 22)
    except (TypeError, ValueError):
        port = 0
    if not nick or not ADDR.fullmatch(addr) or not USER.fullmatch(login) or not 0 < port < 65536:
        raise HTTPException(400, "nickname, a valid address, user name and port are required")
    if any(h["address"] == addr and h["user"] == login and int(h.get("port") or 22) == port for h in load()):
        raise HTTPException(409, f"{login}@{addr}:{port} is already added")
    if body.get("auth") == "password":
        if not PUBKEY:
            raise HTTPException(500, "this server has no SSH key (~/.ssh/id_*.pub) to install -- run ssh-keygen")
        r = subprocess.run(["sshpass", "-e", "ssh-copy-id", "-i", str(PUBKEY), "-o", "StrictHostKeyChecking=accept-new",
                            "-o", "ConnectTimeout=8", "-p", str(port), f"{login}@{addr}"],
                           env={**os.environ, "SSHPASS": str(body.get("password", ""))}, capture_output=True, text=True, timeout=40)
        if r.returncode != 0:
            raise HTTPException(400, f"could not install the key: {(r.stderr or r.stdout).strip()[-300:]}")
    h = {"id": uuid.uuid4().hex[:8], "nickname": nick, "address": addr, "user": login, "port": port, "added": time.time()}
    hs = load()
    hs.append(h)
    save(hs)
    return test_host(h["id"], user)


@router.post("/{hid}/test")
def test_host(hid: str, user: str = Depends(require_user)):
    if hid == "primary":
        return primary(fresh=True)
    h = find(hid)
    t: dict = {"at": time.time()}
    p = subprocess.run(["ping", "-c", "3", "-i", "0.2", "-W", "1", h["address"]], capture_output=True, text=True, timeout=10)
    m = re.search(r"= [\d.]+/([\d.]+)/", p.stdout)
    t["ping_ms"] = float(m.group(1)) if m else None
    s = subprocess.run([*SSH, *_dest(h), "bash", "-s"], input="sudo -n true && echo sudo=yes\n" + SPECS,
                       capture_output=True, text=True, timeout=40)
    t["ssh"] = s.returncode == 0 or "hostname=" in s.stdout
    t["error"] = "" if t["ssh"] else (s.stderr.strip().splitlines() or ["ssh failed"])[-1][:200]
    specs = _parse(s.stdout) if t["ssh"] else h.get("specs", {})
    t["sudo"] = specs.pop("sudo", "") == "yes" if t["ssh"] else False
    hs = load()
    for x in hs:
        if x["id"] == hid:
            x["test"], x["specs"] = t, specs
            h = x
    save(hs)
    return h


@router.patch("/{hid}")
def rename_host(hid: str, body: dict = Body(...), user: str = Depends(require_user)):
    hs = load()
    for x in hs:
        if x["id"] == hid:
            x["nickname"] = str(body.get("nickname", x["nickname"])).strip()[:40] or x["nickname"]
    save(hs)
    return find(hid)


@router.delete("/{hid}")
def remove_host(hid: str, user: str = Depends(require_user)):
    h = find(hid)
    used = [s for s in placements() if h["id"] in placements()[s]]
    if used:
        raise HTTPException(409, f"{h['nickname']} runs part of {', '.join(used)} -- move those first")
    save([x for x in load() if x["id"] != hid])
    return {"deleted": hid}


_PROBE = r"""tmux list-panes -a -F '#{session_name} #{pane_pid}' 2>/dev/null | while read -r s p; do pgrep -P "$p" >/dev/null && echo "S $s"; done | sort -u
[ "$(docker inspect -f '{{.State.Running}}' oai-amf 2>/dev/null)" = true ] && echo 'C oai-cn5g'
sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml -n aether-5gc get pods --no-headers 2>/dev/null | grep -q ' Running ' && echo 'C sd-core'
true"""
_probe_cache: dict = {"at": 0.0, "by": {}}


def probe() -> dict:
    if time.time() - _probe_cache["at"] < 15:
        return _probe_cache["by"]
    from concurrent.futures import ThreadPoolExecutor

    def one(h: dict) -> tuple[str, dict]:
        argv = ["bash", "-c", _PROBE] if h.get("primary") else [*SSH, "-o", "ConnectTimeout=3", *_dest(h), _PROBE]
        try:
            out = subprocess.run(argv, capture_output=True, text=True, timeout=6).stdout
        except subprocess.TimeoutExpired:
            out = ""
        lines = [ln.split(" ", 1) for ln in out.splitlines() if " " in ln]
        return _target(h), {"sessions": {v for k, v in lines if k == "S" and not v.startswith("studio-")},
                            "cores": {v for k, v in lines if k == "C"}, "primary": bool(h.get("primary"))}

    hs = [primary()] + [h for h in load() if (h.get("test") or {}).get("ssh")]
    with ThreadPoolExecutor(len(hs)) as ex:
        by = dict(ex.map(one, hs))
    _probe_cache.update(at=time.time(), by=by)
    return by


def remote_sessions() -> set[str]:
    return {s for p in probe().values() if not p["primary"] for s in p["sessions"]}


HARD = {
    "gpu": lambda s: bool(s.get("gpus")), "cuda": lambda s: bool(s.get("gpus")), "aerial": lambda s: bool(s.get("gpus")),
    "dpdk": lambda s: bool(s.get("dpdk")), "nic": lambda s: bool(s.get("vfio_nics")) or any(
        n.endswith((":mlx5_core", ":ice", ":iavf")) for n in s.get("nics", [])),
    "hugepages": lambda s: s.get("hugepages_gb", 0) > 0, "ptp": lambda s: s.get("ptp") == "yes",
    "bbdev": lambda s: s.get("acc", 0) > 0,
}


def _by_target() -> dict:
    return {_target(h): h for h in load()}


def placements() -> dict[str, list[str]]:
    out = {}
    tgt = _by_target()
    for s in d.list_stacks():
        settings = d.read_settings(s["name"])
        placed = {k[5:]: v for k, v in settings.items() if k.startswith("HOST_") and v not in ("", "local")}
        ids = {tgt[v]["id"] if v in tgt else v for v in placed.values()}
        left = any(c.upper().replace("-", "_") not in placed for c in s.get("components", []))
        out[s["name"]] = sorted(ids | ({"primary"} if left or not ids else set()))
    return out


def rank(stack: str) -> list[dict]:
    env = d.stack_env(stack)
    needs = env.get("NEEDS", "").split()
    running = d.running_sessions()
    where = placements()
    busy = {hid for s, ids in where.items() if s in running and s != stack for hid in ids}
    out = []
    for h in [primary(), *load()]:
        s = h.get("specs") or {}
        missing = [n for n in needs if n in HARD and not HARD[n](s)]
        reachable = h.get("primary") or (h.get("test") or {}).get("ssh")
        score = 0 if missing or not reachable else 100
        reasons = [f"no {m}" for m in missing] + ([] if reachable else ["not reachable -- Test it"])
        if score:
            if h["id"] in busy:
                score -= 30; reasons.append("runs another stack")
            if s.get("gpus") and not any(n in ("gpu", "cuda", "aerial") for n in needs):
                score -= 20; reasons.append("keeps its GPU free")
            if h.get("primary"):
                score += 5
            score += min(s.get("cores", 0), 64) // 8
        out.append({"id": h["id"], "nickname": h["nickname"], "score": score, "fits": score > 0, "reasons": reasons})
    return sorted(out, key=lambda x: -x["score"])


@router.get("/placement/{stack}")
def placement(stack: str, user: str = Depends(require_user)):
    d.known_stack(stack)
    return {"stack": stack, "current": placements().get(stack, ["primary"]), "ranking": rank(stack)}


@router.post("/placement/{stack}")
def place(stack: str, body: dict = Body(...), user: str = Depends(require_user)):
    d.known_stack(stack)
    hid = body.get("host", "primary")
    target = "" if hid == "primary" else _target(find(hid))
    settings = {k: v for k, v in d.read_settings(stack).items() if not k.startswith("HOST_")}
    if target:
        for c in d.stack_env(stack).get("COMPONENTS", "").split():
            settings["HOST_" + c.upper().replace("-", "_")] = target
    d.save_settings(stack, {"settings": settings})
    return placement(stack, user)


@router.websocket("/{hid}/terminal")
async def terminal(ws: WebSocket, hid: str, token: str = "", session: str = ""):
    if not (_open_mode() or user_from_token(token)):
        await ws.close(code=4401)
        return
    from .users import role_of
    if not _open_mode() and role_of(user_from_token(token)) == "viewer":
        await ws.close(code=4403)
        return
    await ws.accept()
    name = f"studio-{session}" if SESSION.fullmatch(session or "") else ""
    keep = f"tmux new-session -A -s {name} 2>/dev/null || exec bash -l" if name else ""
    if hid == "primary":
        argv = ["bash", "-lc", keep] if keep else ["bash", "-l"]
    else:
        try:
            argv = ["ssh", "-tt", "-o", "StrictHostKeyChecking=accept-new", *_dest(find(hid)), *([keep] if keep else [])]
        except HTTPException:
            await ws.close(code=4404)
            return
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(str(Path.home()))
        os.execvpe(argv[0], argv, {**os.environ, "TERM": "xterm-256color"})
    loop = asyncio.get_running_loop()
    out: asyncio.Queue[bytes] = asyncio.Queue()
    def on_output():
        data = _read(fd)
        if not data:
            loop.remove_reader(fd)
        out.put_nowait(data)
    loop.add_reader(fd, on_output)

    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")

    async def pump():
        while (data := await out.get()):
            await ws.send_text(dec.decode(data))
        await ws.close()

    task = asyncio.create_task(pump())
    try:
        while True:
            msg = await ws.receive_text()
            if msg.startswith('{"resize"'):
                cols, rows = json.loads(msg)["resize"]
                fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", int(rows), int(cols), 0, 0))
            else:
                os.write(fd, msg.encode())
    except Exception:
        pass
    finally:
        loop.remove_reader(fd)
        task.cancel()
        os.close(fd)
        await loop.run_in_executor(None, _reap, pid)


SESSION = re.compile(r"^[A-Za-z0-9_-]{1,40}$")


@router.delete("/{hid}/sessions/{session}")
def end_session(hid: str, session: str, user: str = Depends(require_user)):
    if not SESSION.fullmatch(session):
        raise HTTPException(404, "no such session")
    cmd = ["tmux", "kill-session", "-t", f"studio-{session}"]
    argv = cmd if hid == "primary" else [*SSH, *_dest(find(hid)), " ".join(cmd)]
    subprocess.run(argv, capture_output=True, timeout=15)
    return {"ended": session}


def _reap(pid: int) -> None:
    for sig, wait in ((signal.SIGHUP, 1.0), (signal.SIGTERM, 1.0), (signal.SIGKILL, 5.0)):
        try:
            os.killpg(pid, sig)
        except OSError:
            pass
        end = time.time() + wait
        while time.time() < end:
            try:
                if os.waitpid(pid, os.WNOHANG)[0]:
                    return
            except ChildProcessError:
                return
            time.sleep(0.05)


def _read(fd: int) -> bytes:
    try:
        return os.read(fd, 65536)
    except OSError:
        return b""
