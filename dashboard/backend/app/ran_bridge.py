from __future__ import annotations

import errno
import os
import pty
import re
import signal
import pathlib
import socket
import subprocess
from datetime import datetime
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, Request

from .auth import require_user
from fastapi.responses import JSONResponse

from . import calibration
from . import sionna_bridge

router = APIRouter(prefix="/api/ran", tags=["ran"],
                   dependencies=[Depends(require_user)])

ROOT = Path(__file__).resolve().parents[3]

RAN_ROOT = Path(os.environ.get("TOSSI_RAN_ROOT", ROOT.parent / "rfsim_stack"))
OCUDU = Path(os.environ.get("TOSSI_OCUDU", RAN_ROOT / "OCUDU-RAN"))
OAI = Path(os.environ.get("TOSSI_OAI", RAN_ROOT / "OAI-RAN"))

OCU_BIN = OCUDU / "build" / "apps" / "cu" / "ocu"
ODU_BIN = OCUDU / "build" / "apps" / "du" / "odu"
CONFIGS = OCUDU / "configs"
GNB_BIN = Path(os.environ.get("TOSSI_GNB_BIN", OCUDU / "build" / "apps" / "gnb" / "gnb"))
UE_SERVER_SH = Path(os.environ.get("TOSSI_UE_SERVER_SH", "/tmp/ue_sd.sh"))
GNB1_CONFIG = Path(os.environ.get("TOSSI_GNB1_CONFIG", CONFIGS / "gnb1_ho_meas.yaml"))
GNB2_CONFIG = Path(os.environ.get("TOSSI_GNB2_CONFIG", CONFIGS / "gnb2_ho_meas.yaml"))

CU_CONFIG = Path(os.environ.get("TOSSI_CU_CONFIG", CONFIGS / "cu_sionna_rfsim.yml"))

DU_CONFIG = Path(os.environ.get("TOSSI_DU_CONFIG",
                                CONFIGS / "du_sionna_rfsim_n78_40mhz.yaml"))

_ZMQ_ENDPOINT = re.compile(r"^tcp://[\w.\-]+:\d{1,5}$")
MUE = OAI / "multi_ue_sim"
RUN_NUE = MUE / "run_nue.sh"
UE_LOG = MUE / "logs" / "ue1_nue.log"
UE_SERVER_LOG = Path(os.environ.get("TOSSI_UE_SERVER_LOG", "/tmp/ue_server.log"))

LOG_DIR = Path(os.environ.get("TOSSI_RAN_LOGS", ROOT / "var" / "dashboard" / "ran_logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)


def _bad(msg: str, code: int = 400):
    return JSONResponse({"ok": False, "error": msg}, status_code=code)


async def _json(req: Request) -> dict:
    try:
        return await req.json()
    except Exception:
        return {}


def _alive(pid: Optional[int], name: str) -> bool:
    if not pid:
        return False
    try:
        out = subprocess.run(["ps", "-eo", "pgid=,comm="],
                             capture_output=True, text=True, timeout=6)
    except (OSError, subprocess.SubprocessError):
        return False
    for line in out.stdout.splitlines():
        parts = line.split(None, 1)
        if len(parts) == 2 and parts[0].strip() == str(pid) and parts[1].strip() == name:
            return True
    return False


def _adopt(name: str, bin_name: Optional[str] = None) -> Optional[int]:
    try:
        pid = int((LOG_DIR / f"{name}.pid").read_text().strip())
    except (OSError, ValueError):
        return None
    if _alive(pid, bin_name or name):
        return pid
    (LOG_DIR / f"{name}.pid").unlink(missing_ok=True)
    return None


class Proc:

    def __init__(self, name: str, bin_name: Optional[str] = None) -> None:
        self.bin_name = bin_name or name
        self.name = name
        self.proc: Optional[subprocess.Popen] = None
        self._pty_master: Optional[int] = None
        self._pty_stream = None
        self.started: Optional[float] = None
        self.exit_code: Optional[int] = None
        self.log_path = LOG_DIR / f"{name}.log"
        self.log: deque[str] = deque(maxlen=400)
        self._lock = threading.Lock()
        self.adopted_pid: Optional[int] = _adopt(name, self.bin_name)

    def _pid_path(self) -> Path:
        return LOG_DIR / f"{self.name}.pid"

    def pid(self) -> Optional[int]:
        if self.proc is not None:
            return self.proc.pid
        return self.adopted_pid

    def is_running(self) -> bool:
        if self.proc is not None:
            return self.proc.poll() is None
        if self.adopted_pid is not None:
            if _alive(self.adopted_pid, self.bin_name):
                return True
            self.adopted_pid = None
            self._pid_path().unlink(missing_ok=True)
        return False

    def _reader(self, proc: subprocess.Popen) -> None:
        stream = getattr(self, "_pty_stream", None) or proc.stdout
        try:
            for line in stream:  # type: ignore[union-attr]
                with self._lock:
                    self.log.append(line.rstrip("\n"))
        except OSError as exc:
            if exc.errno != errno.EIO:
                print(f"[{self.name}] reader stopped: {exc}", flush=True)
        finally:
            with self._lock:
                self.exit_code = proc.poll()

    def start(self, cmd: list[str], cwd: Path, env: Optional[dict] = None) -> None:
        with self._lock:
            self.log.clear()
            self.exit_code = None
            self.started = time.time()
        self._pty_master, pty_slave = pty.openpty()
        try:
            self.proc = subprocess.Popen(
                cmd, cwd=str(cwd),
                stdin=pty_slave, stdout=pty_slave, stderr=pty_slave,
                env={**os.environ, **(env or {})},
                start_new_session=True, close_fds=True,
            )
        finally:
            os.close(pty_slave)
        self.adopted_pid = None
        try:
            self._pid_path().write_text(str(self.proc.pid))
        except OSError:
            pass
        self._pty_stream = os.fdopen(self._pty_master, "r", buffering=1,
                                     errors="replace", closefd=False)
        threading.Thread(target=self._reader, args=(self.proc,), daemon=True).start()

    def send_console(self, line: str) -> tuple[bool, str]:
        proc = self.proc
        master = getattr(self, "_pty_master", None)
        if proc is None or master is None:
            return False, (f"no console for {self.name} - it was started outside this backend, "
                           "so restart it here before sending commands")
        if proc.poll() is not None:
            return False, f"{self.name} is not running"
        try:
            os.write(master, (line.rstrip("\n") + "\n").encode())
        except OSError as exc:
            return False, f"could not write to {self.name}: {exc}"
        return True, ""

    def _signal(self, sig: str, timeout: float = 6.0) -> None:
        target = self.pid()
        if target is None:
            return
        try:
            subprocess.run(["sudo", "kill", f"-{sig}", "--", f"-{target}"],
                           timeout=timeout, check=False)
        except Exception:
            pass

    def stop(self, timeout: float = 6.0) -> bool:
        if not self.is_running():
            self.proc = None
            self._pid_path().unlink(missing_ok=True)
            return False
        self._signal("TERM", timeout)
        if not self._wait(timeout):
            self._signal("KILL", timeout)
            self._wait(timeout)
        self.proc = None
        self.adopted_pid = None
        self._pid_path().unlink(missing_ok=True)
        return True

    def _wait(self, timeout: float) -> bool:
        if self.proc is not None:
            try:
                self.proc.wait(timeout=timeout)
                return True
            except subprocess.TimeoutExpired:
                return False
        deadline = time.time() + timeout
        while time.time() < deadline:
            if not _alive(self.adopted_pid, self.bin_name):
                return True
            time.sleep(0.2)
        return False

    def foreign(self) -> bool:
        return _pgrep(self.name) and not self.is_running()

    def tail(self, n: int = 40) -> list[str]:
        with self._lock:
            return list(self.log)[-n:]


GNB1 = Proc("gnb1", bin_name="gnb")
GNB2 = Proc("gnb2", bin_name="gnb")
UE_SRV = Proc("ue_server")

CU = Proc("ocu")
DU = Proc("odu")

APPS_DIR = OCUDU / "build" / "apps"
CU_LOG = APPS_DIR / "cu.log"
DU_LOG = APPS_DIR / "du.log"


def _mirrored(path: Path) -> Path:
    from .remote_mirror import MIRROR
    if not MIRROR.active:
        return path
    return {CU_LOG: MIRROR.path("cu.log"), DU_LOG: MIRROR.path("du.log"),
            UE_LOG: MIRROR.path("ue1_nue.log")}.get(path, path)


def _read_log(path: Path, n: int = 400) -> list[str]:
    path = _mirrored(path)
    try:
        return path.read_text(errors="ignore").splitlines()[-n:]
    except Exception:
        return []


def _count(patterns: list[str], lines: list[str]) -> int:
    return sum(1 for ln in lines for p in patterns if p in ln)


_SINR_RE = calibration.UE_SINR_RE

_RELEASE_MARKERS = ["RRC moved into IDLE state", "NR_NAS_CONN_RELEASE_IND"]


def _last_index(patterns: list[str], lines: list[str]) -> int:
    idx = -1
    for i, ln in enumerate(lines):
        if any(p in ln for p in patterns):
            idx = i
    return idx


_GO_FLAG = Path("/tmp/tossi_live_go")


def _live_ue_log() -> Path:
    from .remote_mirror import MIRROR
    if MIRROR.active:
        return MIRROR.path("ue1_nue.log")
    try:
        a = UE_LOG.stat().st_mtime if UE_LOG.exists() else -1.0
    except OSError:
        a = -1.0
    try:
        b = UE_SERVER_LOG.stat().st_mtime if UE_SERVER_LOG.exists() else -1.0
    except OSError:
        b = -1.0
    return UE_SERVER_LOG if b > a else UE_LOG


def _ue_status() -> dict:
    _log = _live_ue_log()
    if not _ue_running():
        return {"present": False}
    if not _log.exists():
        return {"present": False}
    try:
        lines = _log.read_text(errors="ignore").splitlines()
    except Exception:
        return {"present": False}

    sync = _count(["pbch decoded sucessfully", "PBCH decoded"], lines)
    sib = _count(["SIB1 decoded"], lines)
    rar = _count(["RAR-Msg2 decoded"], lines)
    rrc = _count(["RRCSetupComplete"], lines)
    reg = _count(["Registration Accept"], lines)

    stage = "searching"
    if reg:
        stage = "REGISTERED"
    elif rrc:
        stage = "RRC"
    elif rar:
        stage = "RAR"
    elif sib:
        stage = "SIB1"
    elif sync:
        stage = "SYNC"

    ip = None
    from .remote_mirror import MIRROR
    for argv in ([] if MIRROR.active else
                 (["sudo", "ip", "netns", "exec", "ue1", "ip", "-4", "addr", "show", "oaitun_ue1"],
                  ["ip", "-4", "addr", "show", "oaitun_ue1"])):
        try:
            p = subprocess.run(argv, capture_output=True, text=True, timeout=5)
            m = re.search(r"inet ([0-9.]+)", p.stdout)
            if m:
                ip = m.group(1)
                break
        except Exception:
            continue

    if MIRROR.active:
        ip = MIRROR.state.get("ue_ip")

    sinr_samples: list[dict] = []
    for ln in lines:
        m = _SINR_RE.search(ln)
        if m:
            sinr_samples.append({
                "sinr": float(m.group(1)),
                "cqi": int(m.group(2)) if m.group(2) else None,
            })
    sinr_samples = sinr_samples[-60:]
    last_sinr = sinr_samples[-1]["sinr"] if sinr_samples else None

    registered_now = _last_index(["Registration Accept"], lines) > _last_index(_RELEASE_MARKERS, lines)
    attached = bool(registered_now and ip)
    return {
        "present": True,
        "sync": sync, "sib1": sib, "rar": rar, "rrc": rrc, "reg": reg,
        "stage": stage, "ip": ip,
        "attached": attached,
        "sinr": last_sinr if attached else None,
        "sinr_last_seen": last_sinr,
        "sinr_stale": bool(last_sinr is not None and not attached),
        "sinr_samples": sinr_samples,
    }


_UE_METRICS = re.compile(r"\[METRICS\s*\]\s*Scheduler UE\s+ue=(\d+)\s+pci=(\d+)\s+rnti=(\S+)")
_KPI_NUM = {
    "rsrp_db": re.compile(r"pusch_rsrp_db=(-?[\d.]+)"),
    "snr_db": re.compile(r"pusch_snr_db=(-?[\d.]+)"),
    "cqi": re.compile(r"\bcqi=(\d+)"),
    "dl_mcs": re.compile(r"dl_mcs=(\d+)"),
    "ul_mcs": re.compile(r"ul_mcs=(\d+)"),
    "dl_prbs": re.compile(r"dl_nof_prbs=(\d+)"),
    "ul_prbs": re.compile(r"ul_nof_prbs=(\d+)"),
    "dl_bler": re.compile(r"dl_error_rate=([\d.]+)%"),
    "ul_bler": re.compile(r"ul_error_rate=([\d.]+)%"),
    "dl_olla": re.compile(r"dl_olla=([-\d.]+)"),
    "dl_ok": re.compile(r"dl_nof_ok=(\d+)"),
    "dl_nok": re.compile(r"dl_nof_nok=(\d+)"),
}
_KPI_RATE = {
    "dl_kbps": re.compile(r"dl_brate=\s*([\d.]+)\s*([kMG]?)bps"),
    "ul_kbps": re.compile(r"ul_brate=\s*([\d.]+)\s*([kMG]?)bps"),
}
_RATE_SCALE = {"": 1e-3, "k": 1.0, "M": 1e3, "G": 1e6}
_KPI_TS = re.compile(r"^(\d{4}-\d\d-\d\dT[\d:.]+)")


def _parse_ue_metrics(line: str) -> Optional[dict]:
    m = _UE_METRICS.search(line)
    if not m:
        return None
    out: dict = {"ue": int(m.group(1)), "pci": int(m.group(2)), "rnti": m.group(3)}
    ts = _KPI_TS.match(line)
    if ts:
        out["t"] = ts.group(1)
    for name, rx in _KPI_NUM.items():
        hit = rx.search(line)
        out[name] = (int(hit.group(1)) if name in ("cqi", "dl_mcs", "ul_mcs", "dl_prbs",
                                                   "ul_prbs", "dl_ok", "dl_nok")
                     else float(hit.group(1))) if hit else None
    for name, rx in _KPI_RATE.items():
        hit = rx.search(line)
        out[name] = round(float(hit.group(1)) * _RATE_SCALE[hit.group(2)], 3) if hit else None
    return out


KPI_FRESH_MIN_S = 4.0
KPI_FRESH_FACTOR = 2.5


def _age_s(ts) -> Optional[float]:
    if not ts:
        return None
    try:
        return max(0.0, round((datetime.now() - datetime.fromisoformat(str(ts))).total_seconds(), 1))
    except (ValueError, TypeError):
        return None


def _report_gap_s(samples: list[dict]) -> Optional[float]:
    ts = []
    for s in samples:
        try:
            ts.append(datetime.fromisoformat(str(s.get("t"))))
        except (ValueError, TypeError):
            continue
    gaps = sorted(g for g in ((b - a).total_seconds() for a, b in zip(ts, ts[1:])) if g > 0)
    if len(gaps) < 2:
        return None
    return gaps[len(gaps) // 2]


def _fresh_window_s(samples: list[dict]) -> float:
    gap = _report_gap_s(samples)
    return max(KPI_FRESH_MIN_S, round(gap * KPI_FRESH_FACTOR, 1)) if gap else KPI_FRESH_MIN_S


def _is_fresh(ts, window: float = KPI_FRESH_MIN_S) -> bool:
    a = _age_s(ts)
    return a is not None and a <= window


KPI_SCAN_START = 4000
KPI_SCAN_CAP = 400_000


def _kpi_series(want: int) -> dict:
    span = KPI_SCAN_START
    series: dict[int, list[dict]] = {}
    seen_lines = -1
    while True:
        lines = _read_log(DU_LOG, span) or DU.tail(span)
        if not lines:
            return {}
        series = {}
        for ln in lines:
            row = _parse_ue_metrics(ln)
            if row is not None:
                series.setdefault(row["ue"], []).append(row)
        best = max((len(v) for v in series.values()), default=0)
        if best >= want or len(lines) == seen_lines or span >= KPI_SCAN_CAP:
            return series
        seen_lines = len(lines)
        span *= 2


@router.get("/kpi")
def kpi(samples: int = 60):
    n = max(1, min(300, int(samples or 60)))
    series = _kpi_series(n)
    ues = []
    for ue_id in sorted(series):
        hist = series[ue_id][-n:]
        window = _fresh_window_s(series[ue_id])
        ues.append({"ue": ue_id, "last": hist[-1], "samples": hist,
                    "age_s": _age_s(hist[-1].get("t")),
                    "fresh": _is_fresh(hist[-1].get("t"), window),
                    "fresh_within_s": window})
    return {"ok": True, "du_running": DU.is_running() or _pgrep("odu"),
            "du_is_ours": DU.is_running(), "ues": ues}


def _pgrep(name: str) -> bool:
    from .remote_mirror import MIRROR
    if MIRROR.active:
        return name in MIRROR.state.get("procs", set())
    try:
        return subprocess.run(["pgrep", "-x", name], capture_output=True).returncode == 0
    except Exception:
        return False


def _kill_by_pid(pids: list, sig: str = "-TERM") -> int:
    killed = 0
    for pid in pids:
        r = subprocess.run(["sudo", "-A", "kill", sig, str(pid)],
                           env={**os.environ, "SUDO_ASKPASS": "/tmp/askpass.sh"},
                           capture_output=True, check=False)
        if r.returncode == 0:
            killed += 1
    return killed


def _pids_named(name: str) -> list:
    try:
        r = subprocess.run(["pgrep", "-x", name], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return []
    return [int(x) for x in r.stdout.split() if x.isdigit()]


def _pids_matching(pattern: str) -> list:
    try:
        r = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return []
    mine = {os.getpid(), os.getppid()}
    return [int(x) for x in r.stdout.split() if x.isdigit() and int(x) not in mine]


def _ue_running() -> bool:
    return _pgrep("nr-uesoftmodem")


def _core_up() -> bool:
    from .remote_mirror import MIRROR
    if MIRROR.active:
        return bool(MIRROR.state.get("core"))
    try:
        p = subprocess.run(["docker", "ps", "--format", "{{.Names}}"],
                           capture_output=True, text=True, timeout=5)
        names = p.stdout
        return all(c in names for c in ("oai-amf", "oai-smf", "oai-upf"))
    except Exception:
        return False


def sudo_can_run() -> dict:
    try:
        p = subprocess.run(["sudo", "-n", "-l"], capture_output=True, text=True, timeout=8)
    except (OSError, subprocess.SubprocessError):
        return {"ok": False, "why": "sudo could not be asked", "commands": {}}
    if p.returncode != 0:
        return {"ok": False, "why": "sudo needs a password for everything", "commands": {}}

    listed = p.stdout
    wanted = {"odu": str(ODU_BIN), "ocu": str(OCU_BIN), "run_nue": str(RUN_NUE)}
    blanket = "(ALL : ALL) NOPASSWD: ALL" in listed
    commands = {k: bool(blanket or v in listed) for k, v in wanted.items()}
    return {"ok": all(commands.values()), "commands": commands,
            "why": None if all(commands.values())
                   else "sudo does not permit: " + ", ".join(
                       k for k, v in commands.items() if not v)}


@router.get("/health")
def health():
    sudo = sudo_can_run()
    return {
        "ok": True,
        "core_up": _core_up(),
        "ocu": OCU_BIN.exists(),
        "odu": ODU_BIN.exists(),
        "cu_config": CU_CONFIG.exists(),
        "run_nue": RUN_NUE.exists(),
        "sudo": sudo["ok"],
        "sudo_detail": sudo,
        "auto_recover": auto_recover_state(),
        "paths": {"ocudu": str(OCUDU), "oai": str(OAI)},
    }


@router.post("/cu/start")
async def cu_start(req: Request):
    body = await _json(req)
    if not _core_up():
        return _bad("5G core is not up (docker: oai-amf/smf/upf)", 503)
    if not OCU_BIN.exists():
        return _bad(f"ocu binary not found at {OCU_BIN}", 503)
    if _pgrep("ocu"):
        return _bad("CU is already running"
                    + ("" if CU.is_running() else " — started outside this platform, "
                       "so stop it where you started it"), 409)

    cfg = CU_CONFIG
    want = (body.get("cu_config") or "").strip()
    if want:
        cand = pathlib.Path(want).resolve()
        try:
            inside = cand.is_file() and cand.is_relative_to(CU_CONFIG.parent.resolve())
        except AttributeError:
            inside = cand.is_file() and str(cand).startswith(str(CU_CONFIG.parent.resolve()))
        if not inside:
            return _bad(f"cu_config must be a file in {CU_CONFIG.parent}", 400)
        cfg = cand

    cmd = ["sudo", "taskset", "-c", "1-2", str(OCU_BIN), "-c", str(cfg)]
    CU.start(cmd, cwd=OCUDU / "build" / "apps")
    return {"ok": True, "started": "cu", "cu_config": str(cfg)}


def _sudo_keeps_env(name: str) -> bool:
    try:
        out = subprocess.run(["sudo", "-n", "-l"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return False
    return name in out.stdout


@router.post("/du/start")
async def du_start(req: Request):
    body = await _json(req)
    if not _pgrep("ocu"):
        return _bad("start the CU first", 409)
    if _pgrep("odu"):
        return _bad("DU is already running"
                    + ("" if DU.is_running() else " — started outside this platform, "
                       "so stop it where you started it"), 409)
    du_cfg = body.get("du_config") or str(DU_CONFIG)
    du_path = Path(du_cfg)
    if not du_path.is_absolute():
        du_path = CONFIGS / du_cfg
    if not du_path.exists():
        return _bad(f"DU config not found: {du_path}", 404)
    du_extra_env: dict = {}
    ul_snr = body.get("ul_noise_snr_db", os.environ.get("TOSSI_UL_NOISE_SNR_DB"))
    if ul_snr not in (None, "", False):
        try:
            ul_snr_v = float(ul_snr)
        except (TypeError, ValueError):
            return _bad("ul_noise_snr_db must be a number, in dB")
        if not 0 < ul_snr_v <= 60:
            return _bad("ul_noise_snr_db must be between 0 and 60 dB")
        du_extra_env["OCUDU_SIONNA_UL_SNR_DB"] = str(ul_snr_v)
    cmd = ["sudo", "env", "OCUDU_INJECT_ENABLE=0", "taskset", "-c", "1-6",
           str(ODU_BIN), "-c", str(du_path)]
    DU.start(cmd, cwd=OCUDU / "build" / "apps", env=du_extra_env)
    delivered = (ul_snr_v if (du_extra_env
                              and _sudo_keeps_env("OCUDU_SIONNA_UL_SNR_DB")) else None)
    note = None
    if du_extra_env and delivered is None:
        note = ("the uplink noise floor was not applied: sudo strips "
                "OCUDU_SIONNA_UL_SNR_DB. Add it to the env_keep list in "
                "/etc/sudoers.d/99-tossi-ran to enable it.")
    return {"ok": True, "started": "du", "du_config": str(du_path),
            "ul_noise_note": note,
            "ul_noise_snr_db": delivered}


WEDGE_TAIL_LINES = 200
WEDGE_MIN_OVERFLOWS = 20


def _du_is_wedged() -> bool:
    lines = _read_log(DU_LOG, WEDGE_TAIL_LINES) or DU.tail(WEDGE_TAIL_LINES)
    if not lines:
        return False
    if isinstance(lines, str):
        lines = lines.splitlines()
    return sum(1 for ln in lines[-WEDGE_TAIL_LINES:]
               if "Real-time failure in RF" in ln) >= WEDGE_MIN_OVERFLOWS


@router.post("/ue/start")
async def ue_start(req: Request):
    body = await _json(req)
    if not body.get("force") and _du_is_wedged():
        return _bad("the O-DU is stuck mid-read and is not producing downlink - its receive "
                    "channel is waiting for a reply the previous proxy never sent. Restart the "
                    "DU before starting a UE (stop UE, stop DU, start DU, start UE), or pass "
                    "force=true to start anyway.")
    if not RUN_NUE.exists():
        return _bad(f"run_nue.sh not found at {RUN_NUE}", 503)
    if _ue_running():
        return _bad("a UE is already running — stop it first", 409)
    p = dict(sionna_bridge.UE_DEFAULTS)
    eff = {}
    sid = body.get("scene_id")
    if sid:
        d = sionna_bridge._scene_dir(str(sid))
        if d:
            eff = sionna_bridge.ue_effective(d)
            p = {k: eff[k] for k in p}
            p["n_rb"] = eff["n_rb_effective"]
            p["ssb_scan"] = eff["ssb_scan_effective"]
    for a, b_ in (("n_ues", "n_ues"), ("sd", "sd"), ("n_rb", "n_rb"), ("cpus", "ue_cpus")):
        if body.get(a) not in (None, ""):
            p[b_] = body[a]
    n = int(p.get("n_ues") or 1)
    n_rb = str(p.get("n_rb") or 106)
    sd = str(p.get("sd") if p.get("sd") is not None else 16777215)
    cpus = str(p.get("ue_cpus") or "")
    ssb_scan = p.get("ssb_scan")
    if ssb_scan is None:
        ssb_scan = 0 if n_rb == "51" else 1
    env = {
        "N_RB": n_rb, "SD": sd, "UE_CPUS": cpus,
        "IMSI_BASE": str(p.get("imsi_base") or ""),
        "KEY": str(p.get("key") or ""),
        "OPC": str(p.get("opc") or ""),
        "SSB": str(p.get("ssb") if p.get("ssb") is not None else 0),
        "SSB_SCAN": str(int(bool(ssb_scan))),
        "TQ_SAMPLING": "1" if p.get("tq_sampling") else "0",
        "PROXY_CPUS": str(p.get("proxy_cpus") or ""),
        "STAGGER_S": str(p.get("stagger_s") if p.get("stagger_s") is not None else 1.5),
    }
    if p.get("ue_rt_prio") not in (None, ""):
        env["UE_RT_PRIO"] = str(p["ue_rt_prio"])

    cells = (body.get("ho_cells") or "").strip()
    if cells:
        pairs = [c for c in cells.split(";") if c.strip()]
        for pair in pairs:
            parts = [x.strip() for x in pair.split(",")]
            if len(parts) != 2 or not all(_ZMQ_ENDPOINT.match(x) for x in parts):
                return _bad(f"ho_cells entry {pair!r} must be 'tcp://host:port,tcp://host:port'")
        env["HO_CELLS"] = ";".join(p.strip() for p in pairs)
        if body.get("sum_cells"):
            env["PROXY_SUM_CELLS"] = "1"
    if body.get("proxy_rt") is not None:
        env["PROXY_RT"] = "1" if body.get("proxy_rt") else "0"
    elif body.get("sum_cells"):
        return _bad("sum_cells needs ho_cells: there is nothing to sum with one cell")
    env = {k: v for k, v in env.items() if v != ""}
    cmd = ["sudo", "env"] + [f"{k}={v}" for k, v in env.items()] + \
          ["bash", str(RUN_NUE), str(n)]
    start_log = LOG_DIR / "ue_start.log"
    try:
        fh = open(start_log, "w")
    except Exception:
        fh = subprocess.DEVNULL
    subprocess.Popen(cmd, cwd=str(MUE), stdout=fh, stderr=subprocess.STDOUT,
                     start_new_session=True)
    if fh is not subprocess.DEVNULL:
        fh.close()

    deadline = time.time() + 20.0
    while time.time() < deadline and not _ue_running():
        time.sleep(0.5)
    if not _ue_running():
        try:
            said = [ln.strip() for ln in start_log.read_text(errors="ignore").splitlines() if ln.strip()]
        except Exception:
            said = []
        why = " | ".join(said[-4:]) or "run_nue.sh exited without starting a UE and said nothing."
        return _bad("the UE did not start - " + why, 500)

    _set_ue_ours(True)
    threading.Thread(target=_keepalive_when_ready, args=(f"ue{n}",), daemon=True).start()
    return {"ok": True, "started": "ue", "n_ues": n, "sd": sd, "n_rb": n_rb,
            "env": {k: ("****" if k in ("KEY", "OPC") else v) for k, v in env.items()},
            "carrier_mismatch": bool(eff.get("carrier_mismatch"))}


LOG_SOURCES = {
    "cu": (lambda: CU_LOG, lambda n: CU.tail(n)),
    "du": (lambda: DU_LOG, lambda n: DU.tail(n)),
    "ue": (lambda: UE_LOG, lambda n: []),
    "proxy": (lambda: MUE / "logs" / "proxy.log", lambda n: []),
    "traffic": (lambda: MUE / "logs" / "traffic_nue.log", lambda n: []),
}


@router.get("/logs")
def logs(source: str = "du", lines: int = 400):
    src = (source or "").lower().strip()
    if src not in LOG_SOURCES:
        return _bad(f"source must be one of {', '.join(LOG_SOURCES)}")
    n = max(10, min(4000, int(lines or 400)))
    path_of, fallback = LOG_SOURCES[src]
    path = _mirrored(path_of())
    out = _read_log(path, n)
    from_file = bool(out)
    if not out:
        out = fallback(n)
    return {"ok": True, "source": src, "path": str(path), "exists": path.exists(),
            "from_file": from_file, "lines": out}


_FILTER_GAIN_RE = re.compile(r"Sionna \w+ filter:.*?\(([+-][0-9.]+) dB\)")


def _du_still_filtering(span: int = 400) -> bool:
    try:
        lines = _read_log(DU_LOG, span) or DU.tail(span)
    except Exception:
        return False
    for line in reversed(lines or []):
        m = _FILTER_GAIN_RE.search(line)
        if m:
            try:
                return abs(float(m.group(1))) > 0.05
            except ValueError:
                return False
    return False


_MAC_CELL_RE = re.compile(r"^([0-9-]{10}T[0-9:.]+).*MAC cell")
_SLOTS_PER_REPORT = 2000
_SLOT_S = 500e-6


def du_real_time_factor(span: int = 4000) -> Optional[float]:
    try:
        lines = _read_log(DU_LOG, span) or DU.tail(span)
    except Exception:
        return None
    stamps = []
    for line in lines or []:
        m = _MAC_CELL_RE.match(line)
        if m:
            try:
                stamps.append(datetime.fromisoformat(m.group(1)))
            except ValueError:
                continue
    if len(stamps) < 3:
        return None
    stamps = stamps[-6:]
    gaps = [(b - a).total_seconds() for a, b in zip(stamps, stamps[1:])]
    gaps = [g for g in gaps if g > 0]
    if not gaps:
        return None
    wall = sum(gaps) / len(gaps)
    return (_SLOTS_PER_REPORT * _SLOT_S) / wall


SLOW_DU_FACTOR = 0.60


def _du_detail(channel: bool, f1: bool, du_run: bool) -> Optional[str]:
    base = "channel" if channel else ("F1" if f1 else None)
    if not du_run:
        return base
    rtf = du_real_time_factor()
    if rtf is None or rtf >= SLOW_DU_FACTOR:
        return base
    slow = ("running at %.0f%% of real time — late samples decode as errors, so block "
            "error and round-trip here are partly the simulation, not the radio"
            % (100 * rtf))
    return f"{base} — {slow}" if base else slow


def _channel_live():
    try:
        st = sionna_bridge.LIVE.status()
    except Exception:
        return False, "cannot be read"
    if not st.get("running"):
        if _du_still_filtering():
            return False, ("publishing has stopped — the DU is still applying the last traced "
                           "channel, so readings are real but frozen")
        return False, "no channel is being published — the DU is passing samples through"
    n = st.get("updates") or 0
    if not n:
        return False, "publisher is up but has produced no update yet"
    last = st.get("last") or {}
    gain = last.get("gain_db")
    return True, (f"{n} updates" + (f", {gain:.1f} dB" if isinstance(gain, (int, float)) else ""))


@router.get("/status")
def status():
    cu_lines = _read_log(CU_LOG) or CU.tail(400)
    du_lines = _read_log(DU_LOG) or DU.tail(400)

    ngap = _sctp_estab() or _count(["NGAP", "Connection established"], cu_lines) > 0
    f1 = _count(["F1 Setup: Procedure completed", "F1 Setup ... completed",
                 "Procedure completed successfully"], du_lines) > 0
    channel = _count(["Sionna channel enabled", "live channel: subscribed",
                      "Sionna live channel"], du_lines) > 0

    ue = _ue_status()
    cu_run = _pgrep("ocu")
    du_run = _pgrep("odu")

    stages = [
        {"key": "core", "label": "Core", "ok": _core_up()},
        {"key": "cu", "label": "CU", "ok": cu_run, "detail": "NGAP" if ngap else None},
        {"key": "du", "label": "DU", "ok": du_run,
         "detail": _du_detail(channel, f1, du_run)},
        {"key": "channel", "label": "Channel", "ok": _channel_live()[0],
         "detail": _channel_live()[1]},
        {"key": "ue", "label": "UE", "ok": _ue_running(),
         "detail": (None if not _ue_running()
                    else ("dropped after " + str(ue.get("stage") or "attach")
                          if ue.get("present") and not ue.get("attached")
                          else (ue.get("stage") or None)))},
        {"key": "attached", "label": "Attached", "ok": bool(ue.get("attached")),
         "detail": (None if ue.get("attached")
                    else ("the receiver is held at its last position - the channel is still "
                          "publishing, so the UE has something to re-attach to"
                          if (_channel_live()[0] and not sionna_bridge._go_on())
                          else ("the receiver is walking with no link"
                                if _channel_live()[0] else None)))},
    ]

    return {
        "ok": True,
        "stages": stages,
        "cu": {"running": cu_run, "ngap": ngap, "exit_code": CU.exit_code,
               "log": (cu_lines[-30:] or CU.tail(30))},
        "du": {"running": du_run, "f1": f1, "channel": channel,
               "exit_code": DU.exit_code, "log": (du_lines[-30:] or DU.tail(30))},
        "ue": ue,
    }


def _sctp_estab() -> bool:
    from .remote_mirror import MIRROR
    if MIRROR.active:
        return bool(MIRROR.state.get("ngap"))
    try:
        p = subprocess.run(["sudo", "ss", "-np", "--sctp"],
                           capture_output=True, text=True, timeout=5)
        return "ESTAB" in p.stdout and "38412" in p.stdout
    except Exception:
        return False


_UL_KEEPALIVE: Optional[subprocess.Popen] = None
_UL_KEEPALIVE_LOCK = threading.Lock()

UL_KEEPALIVE_INTERVAL_S = "1"
UL_KEEPALIVE_BYTES = "56"


def _keepalive_when_ready(ns: str = "ue1", wait_s: float = 90.0) -> None:
    deadline = time.time() + wait_s
    while time.time() < deadline:
        if not _ue_running():
            return
        if (_ue_status() or {}).get("ip"):
            _start_ul_keepalive(ns)
            return
        time.sleep(2.0)


def _start_ul_keepalive(ns: str = "ue1") -> None:
    global _UL_KEEPALIVE
    with _UL_KEEPALIVE_LOCK:
        _stop_ul_keepalive_locked()
        try:
            _UL_KEEPALIVE = subprocess.Popen(
                ["sudo", "-A", "ip", "netns", "exec", ns,
                 "ping", "-I", "oaitun_ue1",
                 "-i", UL_KEEPALIVE_INTERVAL_S, "-s", UL_KEEPALIVE_BYTES,
                 "10.0.0.1"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL, start_new_session=True,
                env={**os.environ, "SUDO_ASKPASS": "/tmp/askpass.sh"},
            )
        except Exception as exc:
            _UL_KEEPALIVE = None
            print(f"[ran] uplink keepalive did not start: {exc}", flush=True)


def _stop_ul_keepalive_locked() -> None:
    global _UL_KEEPALIVE
    proc = _UL_KEEPALIVE
    _UL_KEEPALIVE = None
    if proc is None or proc.poll() is not None:
        return
    try:
        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
    except Exception:
        try:
            proc.terminate()
        except Exception:
            pass


def _stop_ul_keepalive() -> None:
    with _UL_KEEPALIVE_LOCK:
        _stop_ul_keepalive_locked()
    _kill_by_pid(_pids_matching(
        f"^ping -I oaitun_ue1 -i {UL_KEEPALIVE_INTERVAL_S} -s {UL_KEEPALIVE_BYTES}"))


@router.post("/ue/{n}/ping")
def ue_ping(n: int):
    ns = f"ue{n}"
    try:
        p = subprocess.run(
            ["sudo", "ip", "netns", "exec", ns, "ping", "-I", "oaitun_ue1",
             "-c", "5", "-w", "8", "8.8.8.8"],
            capture_output=True, text=True, timeout=15,
        )
    except subprocess.TimeoutExpired:
        return _bad("ping timed out", 504)
    out = p.stdout + p.stderr
    loss = None
    rtt = None
    m = re.search(r"(\d+(?:\.\d+)?)% packet loss", out)
    if m:
        loss = float(m.group(1))
    m = re.search(r"=\s*[\d.]+/([\d.]+)/", out)
    if m:
        rtt = float(m.group(1))
    return {"ok": p.returncode == 0, "loss_pct": loss, "avg_rtt_ms": rtt, "output": out[-1200:]}


@router.post("/cu/stop")
def cu_stop():
    return {"ok": True, "stopped": CU.stop()}


@router.post("/recover")
async def recover(req: Request):
    body = await _json(req)
    steps = []

    if _ue_running():
        if _ue_ours():
            try:
                steps.append({"ue_stop": _stop_ue()})
            except Exception as e:
                return _bad(f"could not stop the UE: {e}", 500)
        else:
            return _bad("a UE is running that this backend did not start - stop it where it "
                        "was started, since the teardown kills every nr-uesoftmodem", 409)

    du_cfg = body.get("du_config")
    steps.append({"du_stop": DU.stop()})
    time.sleep(3.0)

    r = await du_start(_FakeReq({"du_config": du_cfg} if du_cfg else {}))
    if isinstance(r, dict) and not r.get("ok", True):
        return _bad("the DU did not come back: %s" % r.get("error"), 502)
    if not isinstance(r, dict):
        return _bad("the DU did not come back", 502)
    steps.append({"du_start": r.get("du_config")})

    time.sleep(10.0)

    r = await ue_start(_FakeReq({k: v for k, v in body.items()
                                 if k in ("scene_id", "n_rb", "n_ues", "sd")}))
    if not isinstance(r, dict) or not r.get("ok", True):
        err = r.get("error") if isinstance(r, dict) else "unknown"
        return _bad("the DU is back but the UE did not start: %s" % err, 502)
    steps.append({"ue_start": r.get("n_rb")})

    return {"ok": True, "recovered": True, "steps": steps,
            "note": "the UE takes about half a minute to register - watch the ladder"}


class _FakeReq:

    def __init__(self, payload: dict):
        self._payload = payload

    async def json(self):
        return self._payload


AUTO_RECOVER = os.environ.get("TOSSI_AUTO_RECOVER", "").strip().lower() in ("1", "true", "yes")

AUTO_POLL_S = 5.0
CONSECUTIVE_HITS = 6
HEALTHY_SINR_DB = 10.0
COOLDOWN_S = 300.0

_auto_state = {"hits": 0, "last_recovery": 0.0, "running": False, "history": []}


def auto_recover_state() -> dict:
    return {"enabled": AUTO_RECOVER, "consecutive_hits": _auto_state["hits"],
            "last_recovery": _auto_state["last_recovery"] or None,
            "history": _auto_state["history"][-5:]}


def _tunnel_looks_dead() -> bool:
    if not _ue_running():
        return False
    u = _ue_status() or {}
    if not u.get("present") or u.get("attached"):
        return False
    if not u.get("sinr_stale"):
        return False
    if not u.get("ip"):
        return False
    last = u.get("sinr_last_seen")
    return last is not None and float(last) >= HEALTHY_SINR_DB


def _auto_recover_loop() -> None:
    while True:
        time.sleep(AUTO_POLL_S)
        try:
            if _auto_state["running"]:
                continue
            if not _tunnel_looks_dead():
                _auto_state["hits"] = 0
                continue
            _auto_state["hits"] += 1
            if _auto_state["hits"] < CONSECUTIVE_HITS:
                continue
            if time.time() - _auto_state["last_recovery"] < COOLDOWN_S:
                continue

            _auto_state["running"] = True
            _auto_state["hits"] = 0
            _auto_state["last_recovery"] = time.time()
            entry = {"at": time.time(), "ok": False, "error": None}
            try:
                import asyncio
                res = asyncio.run(recover(_FakeReq({})))
                entry["ok"] = bool(isinstance(res, dict) and res.get("ok"))
                if not entry["ok"] and isinstance(res, dict):
                    entry["error"] = res.get("error") or "recovery reported failure"
            except Exception as e:                       # noqa: BLE001 - a watchdog must not die
                entry["error"] = str(e)[:200]
            finally:
                _auto_state["history"].append(entry)
                _auto_state["running"] = False
        except Exception:                                # noqa: BLE001
            _auto_state["running"] = False


if AUTO_RECOVER:
    threading.Thread(target=_auto_recover_loop, name="ran-auto-recover", daemon=True).start()


@router.post("/du/stop")
def du_stop():
    return {"ok": True, "stopped": DU.stop()}


UE_MARKER = LOG_DIR / "ue.ours"


def _ue_ours() -> bool:
    if not UE_MARKER.exists():
        return False
    if not _ue_running():
        UE_MARKER.unlink(missing_ok=True)
        return False
    return True


def _set_ue_ours(on: bool) -> None:
    if on:
        try:
            UE_MARKER.write_text(str(time.time()))
        except OSError:
            pass
    else:
        UE_MARKER.unlink(missing_ok=True)


UE_OURS = False


def _stop_ue(timeout: float = 30.0) -> str:
    _stop_ul_keepalive()
    if not _ue_ours():
        return "skipped — no UE was started from here"
    subprocess.run(["sudo", "bash", str(RUN_NUE), "1", "--stop"],
                   cwd=str(MUE), timeout=timeout, check=False)
    _set_ue_ours(False)
    return "ue+proxy+netns stopped"


def _port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex(("127.0.0.1", port)) == 0


_UE_SERVER_FLAG = "rfsimulator.serveraddr server"


def _ue_server_pids() -> list:
    return _pids_matching(_UE_SERVER_FLAG)


def _ue_server_running() -> bool:
    return bool(UE_SRV.is_running() or _ue_server_pids())


def _port_4043_holder() -> str:
    if _ue_server_pids():
        return "handover"
    if _pids_named("odu") or _pids_named("nr-uesoftmodem"):
        return "raytrace"
    return "unknown" if _port_open(4043) else ""


def _handover_verdict(sent_at: str, timeout: float = 4.0) -> tuple[bool, str]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        for ln in list(CU.tail(600)) + list(_read_log(CU_LOG, 600) or []):
            if ("trigger handover" not in ln) and ("Handover triggered" not in ln):
                continue
            ts = _KPI_TS.match(ln)
            if ts and ts.group(1) < sent_at:
                continue
            said = ln.split("]", 1)[-1].strip()
            return ("Could not" not in ln), said
        time.sleep(0.05)
    return False, f"the CU did not answer within {timeout:.0f}s - check its log"


GNB_SCAN_START = 4000
GNB_SCAN_CAP = 200_000


def _gnb_lines(which: int, n: int = GNB_SCAN_START) -> list:
    try:
        return Path(f"/tmp/gnb{int(which)}.log").read_text(errors="ignore").splitlines()[-n:]
    except Exception:
        return []


WEDGE_AFTER_S = 45.0


def _gnb_log_age_s(which: int) -> "float | None":
    try:
        return max(0.0, time.time() - Path(f"/tmp/gnb{int(which)}.log").stat().st_mtime)
    except Exception:
        return None


def _gnb_wedged(which: int, running: bool) -> bool:
    if not running:
        return False
    age = _gnb_log_age_s(which)
    return age is not None and age > WEDGE_AFTER_S


def _gnb_lines_with_ue(which: int, want: int = 1) -> list:
    path = Path(f"/tmp/gnb{int(which)}.log")
    try:
        all_lines = path.read_text(errors="ignore").splitlines()
    except Exception:
        return []
    n = GNB_SCAN_START
    while True:
        window = all_lines[-n:]
        if sum(1 for ln in window if "Scheduler UE ue=" in ln) >= want:
            return window
        if n >= len(all_lines) or n >= GNB_SCAN_CAP:
            return window
        n *= 2


def _gnb_saw(which: int, patterns: list) -> int:
    try:
        text = Path(f"/tmp/gnb{int(which)}.log").read_text(errors="ignore")
    except Exception:
        return 0
    return sum(text.count(p) for p in patterns)


def _xn_up() -> bool:
    return any(_gnb_saw(n, ["XN Setup Procedure", "XnAP connection established"]) > 0
               for n in (1, 2))


_PCI_SEEN: dict = {}

_PCI_RE = re.compile(r"\bpci[=: ]\s*(\d+)", re.I)


def _pci_of(which: int, tail_pci=None):
    key = int(which)
    if tail_pci is not None:
        _PCI_SEEN[key] = tail_pci
        return tail_pci
    if key in _PCI_SEEN:
        return _PCI_SEEN[key]
    try:
        text = Path(f"/tmp/gnb{key}.log").read_text(errors="ignore")
    except Exception:
        return None
    found = None
    for m in _PCI_RE.finditer(text):
        found = int(m.group(1))
    if found is not None:
        _PCI_SEEN[key] = found
    return found


_ISO_HEAD = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d")

_UE_TAKEN_RE = re.compile(r"^(\S+).*MAC UE Creation")
_UE_DROPPED_RE = re.compile(r"^(\S+).*MAC UE Removal")


def _ue_held_since(which: int):
    try:
        lines = Path(f"/tmp/gnb{int(which)}.log").read_text(errors="ignore").splitlines()
    except Exception:
        return None
    took = dropped = None
    for ln in lines:
        m = _UE_TAKEN_RE.match(ln)
        if m:
            took = m.group(1)
            continue
        m = _UE_DROPPED_RE.match(ln)
        if m:
            dropped = m.group(1)
    if took is None:
        return None
    if dropped is not None and dropped >= took:
        return None
    return took


def _gnb_of(which: int) -> Proc:
    return GNB1 if int(which) == 1 else GNB2


@router.post("/ho/ue/start")
async def ho_ue_start(req: Request):
    if _ue_server_running():
        return _bad("this tab's UE is already listening on :4043", 409)
    if _pgrep("nr-uesoftmodem") or _port_open(4043):
        return _bad(
            "the Ray Trace stack is using :4043 - stop it on the Ray Trace tab "
            "(Stop all / cleanup), then start this one. The two cannot run together: "
            "there the DU listens and the UE dials in, here the UE listens and both "
            "cells dial into it.", 409)
    if not UE_SERVER_SH.exists():
        return _bad(f"{UE_SERVER_SH} not found", 503)

    proc = subprocess.run(["sudo", "-A", "bash", str(UE_SERVER_SH)],
                          capture_output=True, text=True, timeout=90,
                          env={**os.environ, "SUDO_ASKPASS": "/tmp/askpass.sh"})
    if proc.returncode != 0:
        return _bad((proc.stderr or proc.stdout or "the UE launcher failed").strip()[:300], 500)

    for _ in range(40):
        if _port_open(4043):
            return {"ok": True, "started": "ue_server", "port": 4043,
                    "note": "listening - start gnb1 and gnb2 now"}
        time.sleep(0.5)
    return _bad("the UE started but never listened on :4043", 500)


@router.post("/ho/gnb/{which}/start")
async def ho_gnb_start(which: int, req: Request):
    if which not in (1, 2):
        return _bad("gnb must be 1 or 2")
    gnb = _gnb_of(which)
    if gnb.is_running():
        return _bad(f"gnb{which} is already running", 409)
    if not _port_open(4043):
        return _bad("start the UE first - it is the rfsimulator server, and a gNB with "
                    "nothing to dial exits immediately", 409)

    cfg = GNB1_CONFIG if which == 1 else GNB2_CONFIG
    if not cfg.exists():
        return _bad(f"config not found: {cfg}", 503)

    gnb.start(["sudo", "-A", str(GNB_BIN), "-c", str(cfg)], cwd=GNB_BIN.parent,
              env={"SUDO_ASKPASS": "/tmp/askpass.sh"})
    return {"ok": True, "started": f"gnb{which}", "config": str(cfg)}


@router.post("/ho/gnb/{which}/stop")
async def ho_gnb_stop(which: int):
    if which not in (1, 2):
        return _bad("gnb must be 1 or 2")
    _PCI_SEEN.pop(int(which), None)
    return {"ok": True, "stopped": _gnb_of(which).stop()}


@router.post("/ho/stop")
async def ho_stop():
    _PCI_SEEN.clear()
    out = {"gnb1": GNB1.stop(), "gnb2": GNB2.stop()}
    time.sleep(1)
    out["ue"] = UE_SRV.stop()
    _kill_by_pid(_pids_named("nr-uesoftmodem"))
    return {"ok": True, **out}


def _reconnect_blocking(body: dict) -> None:
    import asyncio

    class _Req:
        async def json(self):
            b = dict(body)
            b.pop("wait", None)
            return b

    try:
        asyncio.run(ho_reconnect(_Req()))
    except Exception as exc:
        print(f"[reconnect] failed: {exc}", flush=True)


@router.post("/ho/reconnect")
async def ho_reconnect(req: Request):
    body = await _json(req)

    if body.get("wait") is False:
        threading.Thread(target=_reconnect_blocking, args=(dict(body),), daemon=True).start()
        return {"ok": True, "started": True,
                "note": "reconnecting - watch the serving cell; it takes about half a minute"}

    if not _ue_server_running() and (_pgrep("nr-uesoftmodem") or _port_open(4043)):
        return _bad(
            "the Ray Trace stack is using :4043 - stop it there first. The two stacks "
            "cannot run together: there the DU listens and the UE dials in, here the UE "
            "listens and both cells dial into it.", 409)

    steps = []

    restart_sionna = bool(body.get("restart_sionna"))
    sionna_was = None
    if restart_sionna:
        from . import sionna_bridge
        if sionna_bridge.LIVE.is_running():
            sionna_was = {"scene_id": sionna_bridge.LIVE.scene_id,
                          "params": dict(sionna_bridge.LIVE.params or {})}
            sionna_bridge.LIVE.stop()
            steps.append({"step": "stop sionna", "ok": True})
        else:
            steps.append({"step": "stop sionna", "ok": True, "was_running": False})

    for which in (1, 2):
        gnb = _gnb_of(which)
        _PCI_SEEN.pop(int(which), None)
        steps.append({"step": "stop gnb%d" % which, "ok": True,
                      "was_running": bool(gnb.stop())})

    strays = [p for p in _pids_named("gnb")]
    if strays:
        _kill_by_pid(strays, "-TERM")
        time.sleep(2.0)
        still = [p for p in _pids_named("gnb")]
        if still:
            _kill_by_pid(still, "-KILL")
            time.sleep(1.0)
        steps.append({"step": "clear stray gnb processes", "ok": not _pids_named("gnb"),
                      "killed": len(strays)})

    gone = False
    for _ in range(30):
        if not _pids_named("gnb"):
            gone = True
            break
        time.sleep(0.5)
    steps.append({"step": "wait for cells to exit", "ok": gone})
    if not gone:
        _kill_by_pid(_pids_named("gnb"), "-KILL")
        time.sleep(1.0)
        steps[-1]["ok"] = not _pids_named("gnb")

    if not UE_SERVER_SH.exists():
        return _bad(f"{UE_SERVER_SH} not found", 503)
    proc = subprocess.run(["sudo", "-A", "bash", str(UE_SERVER_SH)],
                          capture_output=True, text=True, timeout=90,
                          env={**os.environ, "SUDO_ASKPASS": "/tmp/askpass.sh"})
    if proc.returncode != 0:
        return _bad((proc.stderr or proc.stdout or "the UE launcher failed").strip()[:300], 500)

    listening = False
    for _ in range(40):
        if _port_open(4043):
            listening = True
            break
        time.sleep(0.5)
    steps.append({"step": "start UE", "ok": listening})
    if not listening:
        return {"ok": False, "steps": steps,
                "error": "the UE did not start listening on :4043 - the cells were not started"}

    for which in (1, 2):
        cfg = GNB1_CONFIG if which == 1 else GNB2_CONFIG
        if not cfg.exists():
            steps.append({"step": "start gnb%d" % which, "ok": False,
                          "error": f"config not found: {cfg}"})
            continue
        gnb = _gnb_of(which)
        gnb.start(["sudo", "-A", str(GNB_BIN), "-c", str(cfg)], cwd=GNB_BIN.parent,
                  env={"SUDO_ASKPASS": "/tmp/askpass.sh"})
        time.sleep(float(body.get("settle_s") or 4.0))
        steps.append({"step": "start gnb%d" % which, "ok": gnb.is_running(),
                      "config": str(cfg)})

    if restart_sionna and sionna_was and sionna_was.get("scene_id"):
        from . import sionna_bridge
        p = sionna_was["params"]
        try:
            r = sionna_bridge.LIVE.start(
                scene_id=sionna_was["scene_id"],
                **{k: p[k] for k in ("mode", "owner", "binds", "srate", "num_taps",
                                     "interval", "max_depth", "move_start", "laps")
                   if k in p})
            steps.append({"step": "start sionna", "ok": bool(r),
                          "scene_id": sionna_was["scene_id"]})
        except Exception as exc:
            steps.append({"step": "start sionna", "ok": False, "error": str(exc)[:200]})

    ok = all(s.get("ok") for s in steps)
    return {"ok": ok, "steps": steps,
            "note": ("the UE attaches on its own once a cell is radiating - watch the "
                     "serving cell" if ok else
                     "something did not come back; see steps")}


@router.get("/ho/status")
def ho_status():
    def cell(which: int, proc: Proc) -> dict:
        lines = _gnb_lines_with_ue(which) + list(proc.tail(200))
        rnti, pci, sched, last_t = None, None, 0, None
        for ln in lines:
            row = _parse_ue_metrics(ln)
            if row is not None:
                rnti, pci = row.get("rnti"), row.get("pci")
                last_t = row.get("t") or last_t
                sched += 1
        pci = _pci_of(which, pci)
        return {
            "running": proc.is_running(),
            "amf": _gnb_saw(which, ["NGSetupResponse", "Connected to AMF"]) > 0,
            "xn": _xn_up(),
            "rnti": rnti, "pci": pci, "scheduling": sched, "last_t": last_t,
            "wedged": _gnb_wedged(which, proc.is_running()),
            "last_log_age_s": _gnb_log_age_s(which),
            "holding_since": _ue_held_since(which),
        }

    g1, g2 = cell(1, GNB1), cell(2, GNB2)
    cands = [(n, g) for n, g in ((1, g1), (2, g2)) if g["running"] and g["holding_since"]]
    serving = max(cands, key=lambda c: c[1]["holding_since"])[0] if cands else None
    return {
        "ok": True,
        "ue_listening": _ue_server_running() and _port_open(4043),
        "ue_running": _ue_server_running(),
        "port_4043": _port_4043_holder(),
        "gnb1": g1, "gnb2": g2,
        "serving_pci": (g1 if serving == 1 else g2)["pci"] if serving else None,
        "serving_gnb": serving,
        "wedged_cells": [n for n, g in ((1, g1), (2, g2)) if g.get("wedged")],
    }


@router.post("/ho/trigger")
async def ho_trigger(req: Request):
    body = await _json(req)
    st = ho_status()
    src = st["serving_gnb"]
    if src is None:
        return _bad("no cell is scheduling the UE - is it attached?", 409)
    tgt = 2 if src == 1 else 1
    src_cell, tgt_cell = st[f"gnb{src}"], st[f"gnb{tgt}"]
    if not st[f"gnb{tgt}"]["running"]:
        return _bad(f"gnb{tgt} is not running - there is nowhere to hand over to", 409)

    rnti = str(body.get("rnti") or src_cell.get("rnti") or "")
    if not rnti:
        return _bad("could not read the UE's RNTI from the serving cell")
    rnti_bare = rnti[2:] if rnti.lower().startswith("0x") else rnti
    src_pci = int(src_cell.get("pci") or src)
    tgt_pci = int(tgt_cell.get("pci") or tgt)
    plmn = str(body.get("plmn") or "00101")
    tgt_gnb = int(body.get("tgt_gnb") or tgt)

    cmd = f"ho {src_pci} {rnti_bare} {tgt_pci} {plmn} {tgt_gnb}"
    proc = _gnb_of(src)
    sent_at = datetime.now().isoformat(timespec="milliseconds")
    ok, why = proc.send_console(cmd)
    if not ok:
        return _bad(why, 409)

    deadline = time.time() + 4.0
    while time.time() < deadline:
        for ln in proc.tail(400):
            if ("trigger handover" not in ln) and ("Handover triggered" not in ln):
                continue
            said = ln.split("]", 1)[-1].strip() or ln.strip()
            if "Could not" in ln:
                return _bad(f"{said} (sent: {cmd})", 409)
            return {"ok": True, "sent": cmd, "from_pci": src_pci, "to_pci": tgt_pci,
                    "rnti": rnti, "verdict": said,
                    "since": sent_at, "to_gnb": tgt,
                    "note": "accepted - the UE moves once the target answers over Xn"}
        time.sleep(0.05)
    return _bad(f"gnb{src} did not answer within 4s (sent: {cmd})", 504)


@router.get("/ho/outcome")
def ho_outcome(since: str = "", to_gnb: int = 0):
    if not since or to_gnb not in (1, 2):
        return {"ok": False, "error": "need since= and to_gnb=1|2"}

    src_n = 2 if to_gnb == 1 else 1
    try:
        tgt = Path(f"/tmp/gnb{to_gnb}.log").read_text(errors="ignore").splitlines()
        src = Path(f"/tmp/gnb{src_n}.log").read_text(errors="ignore").splitlines()
    except Exception as exc:
        return {"ok": False, "error": f"could not read the cell logs: {exc}"}

    cut = since[:23]

    def _stamped(lines: list) -> list:
        return [ln for ln in lines if _ISO_HEAD.match(ln)]

    tgt = [ln for ln in _stamped(tgt) if ln[:23] >= cut]
    src = [ln for ln in _stamped(src) if ln[:23] >= cut]

    def _window_end(lines: list) -> str:
        seen = 0
        for ln in lines:
            if "HandoverRequestAcknowledge" in ln and _ISO_HEAD.match(ln):
                seen += 1
                if seen > 1:
                    return ln[:23]
        return ""

    end = _window_end(tgt)
    if end:
        tgt = [ln for ln in tgt if ln[:23] < end]
        src = [ln for ln in src if ln[:23] < end]

    ATTEMPT_GRACE_S = 30.0
    firsts = [ln[:23] for ln in tgt
              if ("HandoverRequestAcknowledge" in ln or "MAC UE Creation" in ln)
              and _ISO_HEAD.match(ln)]
    started = min(firsts) if firsts else None
    if started:
        try:
            gap = (datetime.fromisoformat(started)
                   - datetime.fromisoformat(since[:23])).total_seconds()
        except ValueError:
            gap = 0.0
    if not started or gap > ATTEMPT_GRACE_S:
        return {"ok": True, "state": "unknown",
                "detail": ("No record of this handover in the cell logs - they are rewritten "
                           "when a cell restarts, so the evidence for it is gone.")}

    def when(lines, *needles):
        for ln in lines:
            if any(n in ln for n in needles) and _ISO_HEAD.match(ln):
                return ln[:23], ln.strip()
        return None, None

    t_ack, _ = when(tgt, "HandoverRequestAcknowledge")
    t_took, _ = when(tgt, "MAC UE Creation")
    t_norrc, _ = when(tgt, "Did not receive RRC Reconfiguration Complete")
    t_refused, l_refused = when(tgt, "HandoverPreparationFailure", "HandoverFailure")
    _, l_rlf = when(tgt, "RLF detected")
    if not l_rlf:
        _, l_rlf = when(src, "RLF detected")

    if t_took and (not t_norrc or t_norrc < t_took):
        detail = f"gNB {to_gnb} has the UE."
        if when(tgt, "PathSwitchRequestAcknowledge")[0]:
            detail += " The core switched the path to it."
        return {"ok": True, "state": "completed", "serving_gnb": to_gnb, "detail": detail}

    if t_norrc:
        why = (f"The UE never confirmed the move to gNB {to_gnb}, so that cell released it "
               "after its 3-second timer. The two cells agreed the handover between "
               "themselves - it was the phone that could not complete it, which makes this a "
               "radio failure rather than a signalling one.")
        if l_rlf:
            why += (" A radio link failure was logged too, which usually means the phone could "
                    "not decode the new cell from where it is standing.")
        return {"ok": True, "state": "failed", "serving_gnb": None,
                "reason": "no RRC Reconfiguration Complete", "detail": why}

    if t_refused:
        return {"ok": True, "state": "failed", "serving_gnb": None,
                "reason": "the target refused the handover",
                "detail": f"gNB {to_gnb} rejected it over Xn: {(l_refused or '')[-160:]}"}

    if t_ack:
        return {"ok": True, "state": "in_progress",
                "detail": (f"gNB {to_gnb} accepted over Xn and is waiting for the UE to appear "
                           "on it. With the Sionna channel on, the RAN clock runs well behind "
                           "wall clock, so its 3-second timer takes considerably longer here.")}

    return {"ok": True, "state": "in_progress",
            "detail": f"waiting for gNB {to_gnb} to answer over Xn"}


@router.post("/handover")
async def handover(req: Request):
    body = await _json(req)

    if not CU.is_running() and not _pgrep("ocu") and not _pgrep("gnb"):
        return _bad("start the CU first - there is nothing to send a handover to", 409)

    series = _kpi_series(4)
    rows = [rws[-1] for rws in series.values() if rws]
    if not rows:
        return _bad("no UE is attached - a handover needs one to move", 409)
    last = max(rows, key=lambda r: r.get("t") or "")

    rnti = str(body.get("rnti") or last.get("rnti") or "").strip()
    if not rnti:
        return _bad("could not read the UE's RNTI from the DU metrics")
    rnti_bare = rnti[2:] if rnti.lower().startswith("0x") else rnti

    src_pci = int(body.get("source_pci") or last.get("pci") or 1)
    tgt_pci = body.get("target_pci")
    if tgt_pci is None:
        tgt_pci = 2 if src_pci == 1 else 1
    tgt_pci = int(tgt_pci)
    if tgt_pci == src_pci:
        return _bad(f"the UE is already on pci {src_pci}")

    plmn = str(body.get("plmn") or "00101")
    tgt_gnb = int(body.get("target_gnb") or 1)

    cmd = f"ho {src_pci} {rnti_bare} {tgt_pci} {plmn} {tgt_gnb}"

    sent_at = datetime.now().isoformat(timespec="milliseconds")
    ok, why = CU.send_console(cmd)
    if not ok:
        return _bad(why, 409)

    took, verdict = _handover_verdict(sent_at)
    if not took:
        return _bad(f"{verdict} (sent: {cmd})", 409)

    return {"ok": True, "sent": cmd, "source_pci": src_pci, "target_pci": tgt_pci,
            "rnti": rnti, "verdict": verdict,
            "note": "the CU accepted it - the UE moves once the target answers over Xn"}


@router.post("/ue/stop")
def ue_stop():
    if not _ue_ours():
        return _bad("no UE was started from here — stop it where it was started, since "
                    "this teardown kills every nr-uesoftmodem on the machine", 409)
    try:
        note = _stop_ue()
    except Exception as e:
        return _bad(f"ue stop failed: {e}", 500)
    return {"ok": True, "stopped": "ue", "note": note}


@router.post("/cleanup")
async def cleanup(req: Request):
    body = await _json(req)
    keep_foreign = bool((body or {}).get("keep_foreign"))

    steps: list[str] = []
    left: list[str] = []

    try:
        steps.append(_stop_ue())
    except Exception as e:
        steps.append(f"ue stop: {e}")
    if not _ue_ours() and _ue_running():
        if keep_foreign:
            left.append("a UE (nr-uesoftmodem) not started from here")
        else:
            n_killed = _kill_by_pid(_pids_named("nr-uesoftmodem"))
            if n_killed and not _ue_running():
                steps.append("a UE not started from here was stopped")
            else:
                left.append("a UE (nr-uesoftmodem) would not stop")

    for label, proc in (("DU", DU), ("CU", CU)):
        if proc.is_running():
            proc.stop()
            steps.append(f"{label} stopped")
        elif proc.foreign():
            if keep_foreign:
                left.append(f"{label} ({proc.name}) not started from here")
                continue
            _kill_by_pid(_pids_named(proc.bin_name))
            for _ in range(20):
                if not _pgrep(proc.bin_name):
                    break
                time.sleep(0.25)
            if _pgrep(proc.bin_name):
                left.append(f"{label} ({proc.name}) would not stop")
            else:
                steps.append(f"{label} stopped (was not started from here)")

    if any(s.endswith("stopped") for s in steps):
        subprocess.run("sudo rm -f /tmp/ue_socket_* /tmp/ru_socket_* /dev/shm/vrtsim_channel",
                       shell=True, check=False)
        steps.append("stale sockets cleared")

    return {"ok": True, "steps": steps, "left_running": left}
