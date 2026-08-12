from __future__ import annotations

from typing import Optional

DEFAULT_HYSTERESIS_DB = 3.0
DEFAULT_TIME_TO_TRIGGER_S = 0.64
DEFAULT_OFFSET_DB = 0.0

PING_PONG_WINDOW_S = 5.0

MAX_GAP_S = 10.0

SERVING_LOST_AFTER_S = 5.0


def _best(rss: dict, prefer: Optional[str] = None) -> Optional[str]:
    named = [(v, k) for k, v in (rss or {}).items() if v is not None]
    if not named:
        return None
    top = max(v for v, _ in named)
    tied = [k for v, k in named if v == top]
    if prefer is not None and prefer in tied:
        return prefer
    return sorted(tied)[0] if len(tied) > 1 else tied[0]


def naive_switches(series: list[dict]) -> list[dict]:
    out, serving = [], None
    for s in series:
        rss = s.get("rss") or {}
        if serving is not None and rss.get(serving) is None:
            continue
        best = _best(rss, prefer=serving)
        if best is None:
            continue
        if serving is None:
            serving = best
            continue
        if best != serving:
            out.append({"t": s.get("t"), "from": serving, "to": best})
            serving = best
    return out


def a3_events(series: list[dict], *,
              hysteresis_db: float = DEFAULT_HYSTERESIS_DB,
              offset_db: float = DEFAULT_OFFSET_DB,
              time_to_trigger_s: float = DEFAULT_TIME_TO_TRIGGER_S,
              serving: Optional[str] = None,
              max_gap_s: float = MAX_GAP_S,
              serving_lost_after_s: float = SERVING_LOST_AFTER_S) -> dict:
    events: list[dict] = []
    serving_track: list[dict] = []
    recoveries: list[dict] = []
    gaps: list[dict] = []
    entered_at: dict = {}
    serving_last_heard: Optional[float] = None
    prev_t: Optional[float] = None

    ordered = [s for s in series if s.get("t") is not None]
    ordered.sort(key=lambda s: float(s["t"]))

    for s in ordered:
        t = float(s["t"])
        rss = s.get("rss") or {}

        if prev_t is not None and (t - prev_t) > max_gap_s:
            if entered_at:
                entered_at.clear()
            gaps.append({"from_t": prev_t, "to_t": t, "gap_s": round(t - prev_t, 3)})
            if serving_last_heard is not None:
                serving_last_heard = None
        prev_t = t

        if serving is None:
            serving = _best(rss)
            if serving is None:
                continue
            serving_last_heard = t if rss.get(serving) is not None else None

        mp = rss.get(serving)

        if mp is None:
            lost_for = None if serving_last_heard is None else (t - serving_last_heard)
            alt = _best({k: v for k, v in rss.items() if k != serving})
            if (lost_for is not None and lost_for >= serving_lost_after_s and alt is not None):
                recoveries.append({
                    "t": t, "from": serving, "to": alt,
                    "to_dbm": rss[alt],
                    "silent_s": round(lost_for, 3),
                    "reason": "serving cell stopped reporting",
                })
                serving = alt
                serving_last_heard = t
                entered_at.clear()
                serving_track.append({"t": t, "serving": serving, "rss": rss.get(serving)})
                continue
            if serving_last_heard is None:
                serving_last_heard = t
            serving_track.append({"t": t, "serving": serving, "rss": None})
            continue

        serving_last_heard = t

        for name, mn in rss.items():
            if name == serving or mn is None:
                continue
            if mn - hysteresis_db > mp + offset_db:
                entered_at.setdefault(name, t)
            else:
                entered_at.pop(name, None)
        for name in list(entered_at):
            if name == serving or name not in rss:
                entered_at.pop(name, None)

        ripe = [(rss[name], name) for name, since in entered_at.items()
                if t - since >= time_to_trigger_s and rss.get(name) is not None]
        if ripe:
            target = max(ripe)[1]
            events.append({
                "t": t, "from": serving, "to": target,
                "from_dbm": mp, "to_dbm": rss[target],
                "margin_db": round(rss[target] - mp, 2),
                "held_s": round(t - entered_at[target], 3),
            })
            previous = serving
            serving = target
            entered_at.pop(target, None)
            entered_at.pop(previous, None)

        serving_track.append({"t": t, "serving": serving, "rss": rss.get(serving)})

    naive = naive_switches(ordered)
    pings = ping_pongs(events)
    return {
        "events": events,
        "serving": serving_track,
        "final_serving": serving,
        "n_events": len(events),
        "n_naive_switches": len(naive),
        "naive_switches": naive,
        "ping_pongs": pings,
        "n_ping_pongs": len(pings),
        "recoveries": recoveries,
        "n_recoveries": len(recoveries),
        "gaps": gaps,
        "n_gaps": len(gaps),
        "params": {
            "hysteresis_db": hysteresis_db,
            "offset_db": offset_db,
            "time_to_trigger_s": time_to_trigger_s,
            "max_gap_s": max_gap_s,
            "serving_lost_after_s": serving_lost_after_s,
        },
    }


def ping_pongs(events: list[dict], window_s: float = PING_PONG_WINDOW_S) -> list[dict]:
    out = []
    for a, b in zip(events, events[1:]):
        if b["to"] == a["from"] and b["from"] == a["to"] \
                and float(b["t"]) - float(a["t"]) <= window_s:
            out.append({"t": b["t"], "cell": b["to"], "away_s": round(float(b["t"]) - float(a["t"]), 3)})
    return out


def compare(predicted: list[dict], actual: list[dict],
            tolerance_s: float = 5.0) -> dict:
    remaining = sorted(range(len(actual)), key=lambda i: float(actual[i]["t"]))
    matched, missed_by_model = [], []
    used = set()

    for p in sorted(predicted, key=lambda e: float(e["t"])):
        best_i, best_d = None, None
        for i in remaining:
            if i in used:
                continue
            d = abs(float(actual[i]["t"]) - float(p["t"]))
            if d <= tolerance_s and (best_d is None or d < best_d):
                best_i, best_d = i, d
        if best_i is None:
            missed_by_model.append(p)
        else:
            used.add(best_i)
            matched.append({"predicted": p, "actual": actual[best_i],
                            "offset_s": round(float(actual[best_i]["t"]) - float(p["t"]), 3)})

    unpredicted = [actual[i] for i in remaining if i not in used]
    offsets = [m["offset_s"] for m in matched]
    offsets_sorted = sorted(offsets)
    median = (offsets_sorted[len(offsets_sorted) // 2] if offsets_sorted else None)

    return {
        "matched": matched,
        "predicted_not_seen": missed_by_model,
        "actual_not_predicted": unpredicted,
        "n_matched": len(matched),
        "n_predicted": len(predicted),
        "n_actual": len(actual),
        "median_offset_s": median,
        "tolerance_s": tolerance_s,
    }


import re as _re

_TS = _re.compile(r"^(\d{4}-\d\d-\d\dT[\d:.]+)")

_TRIGGERED = (
    _re.compile(r"ue=(\d+).*Trigger intra-CU \(intra-DU\) handover on du=(\S+)"),
    _re.compile(r"ue=(\d+).*Trigger intra-CU \(inter-DU\) handover from source_du=(\S+) "
                r"to target_du=(\S+)"),
    _re.compile(r"ue=(\d+).*Requesting inter CU handover.*pci=(\d+)"),
)

_SUPPRESSED = (
    ("measurement handover disabled",
     _re.compile(r"ue=(\d+).*Ignoring better neighbor pci=(\d+)")),
    ("target does not support the UE slices",
     _re.compile(r"ue=(\d+).*Handover suppressed: target pci=(\d+)")),
    ("no slice-compatible candidate",
     _re.compile(r"ue=(\d+).*CHO suppressed")),
    ("UE could not be reconfigured",
     _re.compile(r"ue=(\d+).*MeasurementReport ignored")),
)


def parse_actual(lines: list[str]) -> dict:
    events, suppressed = [], []
    for line in lines or []:
        ts = _TS.match(line)
        t = ts.group(1) if ts else None
        for rx in _TRIGGERED:
            m = rx.search(line)
            if m:
                events.append({"t": t, "ue": int(m.group(1)), "line": line.strip()[:200]})
                break
        else:
            for reason, rx in _SUPPRESSED:
                m = rx.search(line)
                if m:
                    suppressed.append({"t": t, "ue": int(m.group(1)), "reason": reason,
                                       "line": line.strip()[:200]})
                    break

    reasons = {}
    for s in suppressed:
        reasons[s["reason"]] = reasons.get(s["reason"], 0) + 1
    return {
        "events": events,
        "n_events": len(events),
        "suppressed": suppressed,
        "n_suppressed": len(suppressed),
        "suppression_reasons": reasons,
        "verified_against_a_real_handover": False,
        "provenance": ("patterns taken from OCUDU cu_cp/mobility_manager source; not yet "
                       "confirmed against an observed handover on this deployment"),
    }
