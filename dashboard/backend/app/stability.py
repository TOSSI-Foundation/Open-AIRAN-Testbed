from __future__ import annotations

import re
from pathlib import Path
from typing import Optional

from .ran_bridge import CU_LOG as LIVE_CU_LOG, DU_LOG as LIVE_DU_LOG, UE_LOG as LIVE_UE_LOG

RLF_DETECTED = re.compile(r"RLF detected\. Cause: (.+?)\s*$")
RLF_TIMER = re.compile(r'RLF detected with cause "([^"]+)"\. Timer of (\d+) msec')
RLF_EXPIRED = re.compile(r'RLF timer expired with cause="([^"]+)"')

DU_RELEASE_REQ = re.compile(r"Tx PDU\b.*\bUEContextReleaseRequest")
DU_RELEASE_CMD = re.compile(r"Rx PDU\b.*\bUEContextReleaseCommand")
CU_RELEASE_RX = re.compile(r"Rx PDU du=\d+.*UEContextReleaseRequest")
INACTIVITY = re.compile(r"(?:BearerContext)?InactivityNotification")

UE_MARKERS = (
    ("registered", re.compile(r"Registration Accept")),
    ("ioctl_failed", re.compile(r"ioctl\(\) failed")),
    ("nas_release", re.compile(r"NR_NAS_CONN_RELEASE_IND")),
    ("rrc_idle", re.compile(r"RRC moved into IDLE state")),
)
UE_RESYNC = re.compile(r"Resynchronizing RX by (\d+)")

STARTUP_RESYNC_SAMPLES = 2000

KO_COUNTERS = {
    "csi": {"metric": "f2f3f4_invalid_csis",
            "config": "cell_cfg.pucch.max_consecutive_kos",
            "note": "undecodable CSI reports on PUCCH. This UE never sends a decodable one, "
                    "so the counter climbs on a healthy link"},
    "harq": {"metric": "f2f3f4_invalid_harqs",
             "config": "cell_cfg.pdsch.max_consecutive_kos",
             "note": "unacknowledged downlink blocks - a genuinely failing downlink"},
    "crc": {"metric": "pusch_invalid_harqs",
            "config": "cell_cfg.pusch.max_consecutive_kos",
            "note": "failed uplink CRCs - a genuinely failing uplink"},
}
_COUNTER_RX = {k: re.compile(v["metric"] + r"=(\d+)") for k, v in KO_COUNTERS.items()}

HEALTH_FIELDS = ("pusch_snr_db", "pusch_rsrp_db", "dl_error_rate", "ul_error_rate",
                 "dl_brate", "ul_brate")
_HEALTH_RX = {f: re.compile(rf"\b{f}=\s*([-\d.]+)") for f in HEALTH_FIELDS}

_TS = re.compile(r"^(\d{4}-\d\d-\d\dT[\d:.]+)")


def _ts(line: str) -> Optional[str]:
    m = _TS.match(line)
    return m.group(1) if m else None


def _lines(path: Path, limit: int = 200000) -> list[str]:
    try:
        return path.read_text(errors="ignore").splitlines()[-limit:]
    except OSError:
        return []


def resolve_sources(run_dir: Path, live: bool = True) -> dict:
    run_dir = Path(run_dir)
    out = {}
    for name, live_path in (("ue", LIVE_UE_LOG),
                            ("du", LIVE_DU_LOG),
                            ("cu", LIVE_CU_LOG)):
        own = run_dir / f"{name}.log"
        if own.exists():
            out[name] = {"path": str(own), "shared": False, "found": True}
        elif live and live_path.exists():
            out[name] = {"path": str(live_path), "shared": True, "found": True}
        else:
            out[name] = {"path": str(own), "shared": False, "found": False}
    return out


def ue_sequence(lines: list[str]) -> dict:
    first = {}
    resyncs = []
    for n, line in enumerate(lines, 1):
        for name, rx in UE_MARKERS:
            if rx.search(line):
                first.setdefault(name, n)
        m = UE_RESYNC.search(line)
        if m:
            resyncs.append({"line": n, "samples": int(m.group(1))})

    release_at = first.get("nas_release")
    for r in resyncs:
        r["before_release"] = release_at is not None and r["line"] < release_at
        r["startup"] = (r["samples"] <= STARTUP_RESYNC_SAMPLES
                        and (release_at is None or r["line"] < release_at))

    order = [k for _, k in sorted((v, k) for k, v in first.items())]
    return {"first_seen": first, "order": order, "resyncs": resyncs,
            "dropped": release_at is not None}


def du_cause(lines: list[str]) -> dict:
    detected, timer, expired = [], None, None
    requested = commanded = None
    for line in lines:
        m = RLF_DETECTED.search(line)
        if m:
            detected.append({"t": _ts(line), "cause": m.group(1).strip()})
        m = RLF_TIMER.search(line)
        if m and timer is None:
            timer = {"cause": m.group(1), "timer_ms": int(m.group(2))}
        m = RLF_EXPIRED.search(line)
        if m and expired is None:
            expired = {"cause": m.group(1)}
        if requested is None and DU_RELEASE_REQ.search(line):
            requested = _ts(line)
        if commanded is None and DU_RELEASE_CMD.search(line):
            commanded = _ts(line)
    return {"rlf_detected": detected, "rlf_timer": timer, "rlf_expired": expired,
            "release_requested_at": requested, "release_commanded_at": commanded,
            "du_initiated": requested is not None,
            "cu_initiated": commanded is not None}


def radio_health(lines: list[str], before: Optional[str] = None) -> dict:
    last = latest = None
    for line in lines:
        if "pusch_snr_db" not in line:
            continue
        t = _ts(line)
        if before is not None and t is not None and t > before:
            break
        latest = line
        if _HEALTH_RX["pusch_snr_db"].search(line):
            last = line
    stale = last is not None and last is not latest
    if last is None:
        last, stale = latest, False
    if last is None:
        return {"found": False}
    out = {"found": True, "t": _ts(last), "measured_before_last_report": stale}
    for field, rx in _HEALTH_RX.items():
        m = rx.search(last)
        out[field] = float(m.group(1)) if m else None
    return out


def ko_counters(lines: list[str]) -> dict:
    out = {}
    for key, rx in _COUNTER_RX.items():
        vals = [int(m.group(1)) for m in (rx.search(l) for l in lines) if m]
        out[key] = {**KO_COUNTERS[key],
                    "max": max(vals) if vals else None,
                    "last": vals[-1] if vals else None,
                    "samples": len(vals)}
    return out


def diagnose(run_dir, live: bool = True) -> dict:
    run_dir = Path(run_dir)
    sources = resolve_sources(run_dir, live=live)
    ue = _lines(Path(sources["ue"]["path"])) if sources["ue"]["found"] else []
    du = _lines(Path(sources["du"]["path"])) if sources["du"]["found"] else []
    cu = _lines(Path(sources["cu"]["path"])) if sources["cu"]["found"] else []

    missing = [n for n, s in sources.items() if not s["found"]]
    shared = [n for n, s in sources.items() if s["found"] and s["shared"]]

    seq = ue_sequence(ue)
    cause = du_cause(du)
    counters = ko_counters(du)
    cu_relayed = any(CU_RELEASE_RX.search(l) for l in cu)
    inactivity = [_ts(l) for l in cu if INACTIVITY.search(l)]
    health = radio_health(du, before=cause["release_commanded_at"]
                          or cause["release_requested_at"])

    findings = []
    if not ue and not du:
        return {"dropped": None, "sources": sources, "missing": missing,
                "ue": seq, "du": cause, "counters": counters, "health": health,
                "cu_relayed_release": cu_relayed, "inactivity_notifications": inactivity,
                "findings": ["No log could be read for this run, so nothing can be said about "
                             "it. Logs are written into a run directory by stop_run and nowhere "
                             "else, so a run still recording - or one abandoned rather than "
                             "stopped - keeps none of its own. This is not a healthy run, it is "
                             "an unobserved one."]}

    released = seq["dropped"] or cause["du_initiated"] or cause["cu_initiated"]

    if shared:
        findings.append("Read from the live log(s) for " + ", ".join(shared) + ", which are "
                        "shared by every run on this stack - events outside this run's window "
                        "may appear.")

    if not released:
        findings.append("No release in any log that could be read: the UE was not let go "
                        "during the window these logs cover.")
    elif cause["du_initiated"]:
        findings.append("The DU asked for the release (Tx UEContextReleaseRequest at "
                        f"{cause['release_requested_at']}) - the radio gave up.")
        if cause["rlf_detected"]:
            findings.append("Radio link failure: "
                            + "; ".join(d["cause"] for d in cause["rlf_detected"][:3]))
        if cu_relayed:
            findings.append("The CU received it over F1 and forwarded it. The DU originated "
                            "it, whatever the architecture note says.")
    elif cause["cu_initiated"]:
        findings.append("The DU was ordered to release (Rx UEContextReleaseCommand at "
                        f"{cause['release_commanded_at']}) - it did not ask. The decision came "
                        "from the core, so the radio is not where to look.")
        if not cause["rlf_detected"]:
            findings.append("No RLF anywhere in the DU log, which is what raising "
                            "pucch.max_consecutive_kos was meant to achieve.")
        if health.get("found") and health.get("pusch_snr_db") is not None:
            findings.append(
                f"The radio was healthy when it happened: pusch_snr_db="
                f"{health['pusch_snr_db']}, dl_error_rate={health.get('dl_error_rate')}%, "
                f"ul_error_rate={health.get('ul_error_rate')}%.")
        if inactivity:
            findings.append(f"User-plane inactivity was reported at {inactivity[0]}. Raising "
                            "cu_cp.inactivity_timer moves this boundary; it does not remove "
                            "it. A run that generates no traffic will always reach it.")
        else:
            findings.append("No inactivity notification is visible - but the CU log is "
                            "block-buffered while the CU runs, so its last minutes are "
                            "usually still unflushed. Absent here is not the same as absent.")

    late = [r for r in seq["resyncs"] if not r["before_release"]]
    early = [r for r in seq["resyncs"] if r["before_release"]]
    if seq["dropped"] and late and not any(r["samples"] > STARTUP_RESYNC_SAMPLES
                                           for r in early):
        findings.append("Every large resynchronisation came after the release, so the "
                        "transport did not cause this drop - it recovered from it.")

    hot = [k for k, v in counters.items() if v["max"] is not None and v["max"] >= 90]
    if hot:
        findings.append("Counters that climbed near a release threshold: "
                        + ", ".join(f"{k} (max {counters[k]['max']})" for k in hot))

    if missing:
        findings.append("Not read, so not ruled out: " + ", ".join(missing) + ".")

    return {"dropped": bool(released), "sources": sources, "missing": missing,
            "ue": seq, "du": cause, "counters": counters, "health": health,
            "cu_relayed_release": cu_relayed, "inactivity_notifications": inactivity,
            "findings": findings}
