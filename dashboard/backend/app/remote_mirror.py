from __future__ import annotations

import shlex
import subprocess
import threading
import time
from pathlib import Path
from typing import Optional

DIR = Path(__file__).resolve().parents[3] / "var" / "dashboard" / "remote_mirror"
GO_FILE = "/tmp/tossi_live_go"
FIRST_BYTES = 2_000_000
STEP_BYTES = 4_000_000

_PROBE = r"""
for f in {files}; do
  n="${{f%%=*}}"; p="${{f#*=}}"; p="${{p/#\~/$HOME}}"
  s=$(sudo -n stat -c %s "$p" 2>/dev/null || stat -c %s "$p" 2>/dev/null || echo -1)
  echo "@@F $n $s"
done
for x in ocu odu nr-uesoftmodem; do pgrep -x "$x" >/dev/null && echo "@@P $x"; done
pgrep -f live_channel.py >/dev/null && echo "@@P publisher"
[ -e {go} ] && echo "@@G"
ip=$(sudo -n ip netns exec ue1 ip -4 -o addr show oaitun_ue1 2>/dev/null | grep -o 'inet [0-9.]*' | cut -d' ' -f2)
[ -n "$ip" ] && echo "@@I $ip"
sudo -n ss -np --sctp 2>/dev/null | grep ESTAB | grep -q 38412 && echo "@@N"
docker ps --format '{{{{.Names}}}}' 2>/dev/null | grep -qx oai-amf && echo "@@C"
echo "@@END"
"""


class Mirror:
    def __init__(self) -> None:
        self.active = False
        self.label = ""
        self.ssh: list[str] = []
        self.files: dict[str, str] = {}
        self.state: dict = {}
        self._off: dict[str, int] = {}
        self._stop = threading.Event()
        self._lock = threading.Lock()

    def path(self, name: str) -> Path:
        return DIR / name

    def _argv(self, cmd: str) -> list[str]:
        return [*self.ssh, cmd] if self.ssh else ["bash", "-c", cmd]

    def run(self, cmd: str, timeout: int = 20) -> subprocess.CompletedProcess:
        return subprocess.run(self._argv(cmd), capture_output=True, text=True, timeout=timeout)

    def begin(self, ssh_argv: list[str], files: dict[str, str], label: str) -> None:
        self.end()
        DIR.mkdir(parents=True, exist_ok=True)
        for n in files:
            self.path(n).write_text("")
        with self._lock:
            self.ssh, self.files, self.label = list(ssh_argv), dict(files), label
            self._off = {}
            self.state = {"at": 0.0, "procs": set(), "go": False, "ue_ip": None, "ngap": False, "core": False,
                          "reachable": None, "publisher": False}
            self.active = True
        self._stop = threading.Event()
        threading.Thread(target=self._loop, args=(self._stop,), name="remote-mirror", daemon=True).start()

    def end(self) -> None:
        self._stop.set()
        with self._lock:
            self.active = False

    def go(self, on: bool) -> None:
        try:
            self.run(f"touch {GO_FILE}" if on else f"rm -f {GO_FILE}", timeout=10)
            self.state["go"] = on
        except Exception:
            pass

    def _loop(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self._poll()
            except Exception as e:                       # noqa: BLE001 - keep mirroring
                self.state["reachable"] = False
                self.state["error"] = str(e)[:200]
            stop.wait(1.0)

    def _poll(self) -> None:
        listed = " ".join(shlex.quote(f"{n}={p}") for n, p in self.files.items())
        r = self.run(_PROBE.format(files=listed, go=GO_FILE), timeout=15)
        if "@@END" not in r.stdout:
            self.state["reachable"] = False
            return
        sizes, procs, st = {}, set(), {"go": False, "ue_ip": None, "ngap": False, "core": False}
        for ln in r.stdout.splitlines():
            parts = ln.split()
            if not parts:
                continue
            if parts[0] == "@@F" and len(parts) == 3:
                sizes[parts[1]] = int(parts[2]) if parts[2].lstrip("-").isdigit() else -1
            elif parts[0] == "@@P":
                procs.add(parts[1])
            elif parts[0] == "@@G":
                st["go"] = True
            elif parts[0] == "@@I" and len(parts) == 2:
                st["ue_ip"] = parts[1]
            elif parts[0] == "@@N":
                st["ngap"] = True
            elif parts[0] == "@@C":
                st["core"] = True
        for name, size in sizes.items():
            self._fetch(name, size)
        self.state.update(st, procs=procs, publisher="publisher" in procs, reachable=True, at=time.time())

    def _fetch(self, name: str, size: int) -> None:
        if size < 0:
            return
        off = self._off.get(name)
        if name == "rays.json":
            if off == size:
                return
            r = self.run(f"cat {self.files[name]} 2>/dev/null", timeout=15)
            if r.returncode == 0 and r.stdout.strip():
                tmp = self.path(name).with_suffix(".tmp")
                tmp.write_text(r.stdout)
                tmp.replace(self.path(name))
            self._off[name] = size
            return
        if off is None or size < off:
            off = max(0, size - FIRST_BYTES)
            self.path(name).write_text("")
        if size == off:
            self._off[name] = off
            return
        n = min(size - off, STEP_BYTES)
        f = self.files[name]
        r = subprocess.run(self._argv(f"(sudo -n tail -c +{off + 1} {f} 2>/dev/null || tail -c +{off + 1} {f}) | head -c {n}"),
                           capture_output=True, timeout=30)
        if r.returncode == 0 and r.stdout:
            with self.path(name).open("ab") as fh:
                fh.write(r.stdout)
            self._off[name] = off + len(r.stdout)


MIRROR = Mirror()


def ssh_argv(host: dict) -> list[str]:
    from .hosts import SSH, _dest
    return [] if host.get("primary") else [*SSH, *_dest(host)]


def find_host(target: str) -> Optional[dict]:
    from .hosts import _target, load, primary
    p = primary()
    if target in ("", "primary", _target(p)):
        return p
    return next((h for h in load() if _target(h) == target), None)
