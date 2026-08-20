from __future__ import annotations

import json
import math
import re
from datetime import datetime
from pathlib import Path
from typing import Optional

UE_SINR_RE = re.compile(r"SINR\s*=?\s*(-?\d+(?:\.\d+)?)\s*dB(?:.*?CQI\s*=?\s*(\d+))?")

UPLINK_FILTER_FROM = "2026-08-17T08:54:00"

DEFAULT_TOLERANCE_S = 20.0

MIN_POINTS = 6


_LAST_UE_LOG_SIZE: dict = {}


def ue_sinr_sample(log_path, tail_bytes: int = 262144,
                   require_fresh: bool = False) -> Optional[dict]:
    try:
        p = Path(log_path)
        size = p.stat().st_size
        if require_fresh:
            key = str(p)
            prev = _LAST_UE_LOG_SIZE.get(key)
            if prev is not None and size == prev:
                return None
            _LAST_UE_LOG_SIZE[key] = size
        with p.open("rb") as f:
            if size > tail_bytes:
                f.seek(size - tail_bytes)
            blob = f.read().decode("utf-8", errors="ignore")
    except OSError:
        return None

    last = None
    count = 0
    for m in UE_SINR_RE.finditer(blob):
        last = m
        count += 1
    if last is None:
        return None
    return {
        "sinr": float(last.group(1)),
        "cqi": int(last.group(2)) if last.group(2) else None,
        "in_tail": count,
    }


def to_epoch(value) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    try:
        return datetime.fromisoformat(str(value)).timestamp()
    except (ValueError, TypeError):
        return None


def load_series(path) -> list[dict]:
    try:
        text = Path(path).read_text(errors="ignore")
    except OSError:
        return []
    out = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out


NO_PATH_FLOOR_DB = -200.0

RLF_ATTENUATION_HINT_DB = 37.0


def is_traced(value) -> bool:
    return isinstance(value, (int, float)) and value > NO_PATH_FLOOR_DB


def align_nearest(left: list[dict], right: list[dict], *, left_key: str, right_key: str,
                  tolerance_s: float = DEFAULT_TOLERANCE_S,
                  left_time: str = "t", right_time: str = "t",
                  unique_right: bool = False) -> list[dict]:
    rows = []
    for s in right:
        t = to_epoch(s.get(right_time))
        v = s.get(right_key)
        if t is not None and v is not None:
            rows.append((t, float(v)))
    rows.sort()
    if not rows:
        return []

    times = [t for t, _ in rows]
    out = []
    for s in left:
        lt = to_epoch(s.get(left_time))
        lv = s.get(left_key)
        if lt is None or lv is None:
            continue
        best_i, best_d = None, None
        lo, hi = 0, len(times) - 1
        while lo <= hi:
            mid = (lo + hi) // 2
            if times[mid] < lt:
                lo = mid + 1
            else:
                hi = mid - 1
        for i in (hi, lo):
            if 0 <= i < len(times):
                d = abs(times[i] - lt)
                if best_d is None or d < best_d:
                    best_i, best_d = i, d
        if best_i is None or best_d > tolerance_s:
            continue
        out.append({"t": lt, "x": float(lv), "y": rows[best_i][1], "dt": best_d,
                    "_r": best_i})

    if unique_right:
        keep: dict = {}
        for p in out:
            cur = keep.get(p["_r"])
            if cur is None or p["dt"] < cur["dt"]:
                keep[p["_r"]] = p
        out = sorted(keep.values(), key=lambda p: p["t"])

    for p in out:
        del p["_r"]
    return out


def linear_fit(pairs: list[dict]) -> dict:
    n = len(pairs)
    if n < 2:
        return {"n": n, "slope": None, "intercept": None, "r2": None,
                "residual_std": None, "usable": False}
    xs = [p["x"] for p in pairs]
    ys = [p["y"] for p in pairs]
    mx = sum(xs) / n
    my = sum(ys) / n
    sxx = sum((x - mx) ** 2 for x in xs)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    syy = sum((y - my) ** 2 for y in ys)

    if sxx <= 0:
        return {"n": n, "slope": None, "intercept": None, "r2": None,
                "residual_std": None, "usable": False,
                "why": "the traced gain does not vary across this run"}

    slope = sxy / sxx
    intercept = my - slope * mx
    resid = [y - (slope * x + intercept) for x, y in zip(xs, ys)]
    ss_res = sum(r * r for r in resid)
    r2 = 1.0 - ss_res / syy if syy > 0 else None
    resid_std = math.sqrt(ss_res / (n - 2)) if n > 2 else None

    return {
        "n": n,
        "slope": slope,
        "intercept": intercept,
        "r2": r2,
        "residual_std": resid_std,
        "x_range": [min(xs), max(xs)],
        "y_range": [min(ys), max(ys)],
        "x_span": max(xs) - min(xs),
        "y_span": max(ys) - min(ys),
        "distinct_x": len(set(round(x, 6) for x in xs)),
        "distinct_y": len(set(round(y, 6) for y in ys)),
        "usable": (n >= MIN_POINTS and (max(xs) - min(xs)) > 0
                   and len(set(round(y, 6) for y in ys)) >= 3),
    }


def uplink_is_filtered(run: dict) -> dict:
    prov = ((run.get("params") or {}).get("provenance") or {})
    odu = ((prov.get("stack") or {}).get("binaries") or {}).get("odu") or {}
    built = odu.get("built")
    if built:
        return {"filtered": built >= UPLINK_FILTER_FROM, "source": "recorded",
                "odu_built": built, "odu_sha": odu.get("sha256_short")}

    started = run.get("started")
    if started:
        iso = datetime.fromtimestamp(float(started)).strftime("%Y-%m-%dT%H:%M:%S")
        return {"filtered": iso >= UPLINK_FILTER_FROM, "source": "inferred from run start",
                "run_started": iso}
    return {"filtered": None, "source": "unknown"}


COMPARISONS = (
    {"key": "sinr", "series": "ue_kpi", "label": "UE SINR (downlink)",
     "unit": "dB", "expect": "correlated",
     "note": "the modem measuring the channel the scene applied"},
    {"key": "dl_olla", "series": "kpi", "label": "DL outer-loop offset",
     "unit": "dB", "expect": "correlated",
     "note": "the cell walking its downlink estimate up and down on HARQ feedback"},
    {"key": "dl_mcs", "series": "kpi", "label": "DL MCS",
     "unit": "index", "expect": "correlated",
     "note": "what the scheduler decided the downlink could carry"},
    {"key": "dl_bler", "series": "kpi", "label": "DL block error rate",
     "unit": "%", "expect": "correlated",
     "note": "how often the downlink failed"},
    {"key": "rsrp_db", "series": "kpi", "label": "PUSCH RSRP (uplink)",
     "unit": "dBm", "expect": "depends on build",
     "note": "uplink: evidence on a build that filters the reverse link, a control otherwise"},
    {"key": "snr_db", "series": "kpi", "label": "PUSCH SNR (uplink)",
     "unit": "dB", "expect": "depends on build",
     "note": "uplink: evidence on a build that filters the reverse link, a control otherwise"},
)


LAG_SEARCH_S = 8
LAG_TOLERANCE_S = 6.0


def estimate_lag(left: list[dict], right: list[dict], *, left_key: str, right_key: str,
                 search_s: int = LAG_SEARCH_S,
                 tolerance_s: float = LAG_TOLERANCE_S) -> dict:
    curve = []
    best = None
    for shift in range(-int(search_s), int(search_s) + 1):
        moved = [dict(s, t=to_epoch(s.get("t")) + shift) for s in right
                 if to_epoch(s.get("t")) is not None]
        pairs = align_nearest(left, moved, left_key=left_key, right_key=right_key,
                              tolerance_s=tolerance_s)
        fit = linear_fit(pairs)
        if fit.get("r2") is None:
            continue
        row = {"shift_s": shift, "n": fit["n"], "slope": fit["slope"], "r2": fit["r2"]}
        curve.append(row)
        if best is None or fit["r2"] > best["r2"]:
            best = row
    return {"best": best, "curve": curve}


def calibrate(run_dir, run: Optional[dict] = None,
              tolerance_s: float = DEFAULT_TOLERANCE_S,
              x_key: str = "gain_db") -> dict:
    run_dir = Path(run_dir)
    run = run or {}
    telemetry = load_series(run_dir / "telemetry.jsonl")
    series = {
        "kpi": load_series(run_dir / "kpi.jsonl"),
        "ue_kpi": load_series(run_dir / "ue_kpi.jsonl"),
    }

    ul = uplink_is_filtered(run)
    traced = [s.get(x_key) for s in telemetry if is_traced(s.get(x_key))]
    telemetry = [s for s in telemetry if is_traced(s.get(x_key))]
    x_span = (max(traced) - min(traced)) if traced else 0.0

    results = []
    for c in COMPARISONS:
        right = series.get(c["series"]) or []
        pairs = align_nearest(telemetry, right, left_key=x_key, right_key=c["key"],
                              tolerance_s=tolerance_s, unique_right=True)
        fit = linear_fit(pairs)
        role = c["expect"]
        if c["key"] in ("rsrp_db", "snr_db"):
            role = ("correlated" if ul.get("filtered") else
                    "control" if ul.get("filtered") is False else "unknown")
        lag = None
        aligned_fit = None
        aligned_pairs = None
        if fit.get("n", 0) >= MIN_POINTS and fit.get("distinct_y", 0) >= 3:
            lag = estimate_lag(telemetry, right, left_key=x_key, right_key=c["key"])
            if lag.get("best") and lag["best"]["shift_s"] != 0:
                shift = lag["best"]["shift_s"]
                moved = [dict(s, t=to_epoch(s.get("t")) + shift) for s in right
                         if to_epoch(s.get("t")) is not None]
                aligned_pairs = align_nearest(telemetry, moved, left_key=x_key,
                                              right_key=c["key"],
                                              tolerance_s=LAG_TOLERANCE_S,
                                              unique_right=True)
                aligned_fit = linear_fit(aligned_pairs)

        results.append({
            **{k: c[k] for k in ("key", "series", "label", "unit", "note")},
            "role": role,
            "available": bool(right),
            "fit": fit,
            "lag": lag,
            "aligned_fit": aligned_fit,
            "pairs": aligned_pairs if aligned_pairs is not None else pairs,
            "pairs_are_lag_corrected": aligned_pairs is not None,
            "pairs_fit": aligned_fit if aligned_pairs is not None else fit,
        })

    applied = [s.get("applied_db") for s in telemetry if s.get("applied_db") is not None]

    ended_in_rlf = False
    meas = series["ue_kpi"] or series["kpi"]
    if meas and telemetry:
        t_tel = [to_epoch(s.get("t")) for s in telemetry]
        t_meas = [to_epoch(s.get("t")) for s in meas]
        t_tel = [t for t in t_tel if t]
        t_meas = [t for t in t_meas if t]
        if t_tel and t_meas:
            ended_in_rlf = (max(t_tel) - max(t_meas)) > 60.0
    applied_span = (max(applied) - min(applied)) if applied else None
    clipped = bool(applied and applied_span is not None
                   and x_span - applied_span > 1.0)

    notes = []
    if not series["ue_kpi"]:
        notes.append("No UE SINR series. The UE log carries no timestamps, so a downlink "
                     "comparison cannot be recovered from a finished run - it has to be "
                     "sampled while the run is live.")
    if x_span < 1.0:
        notes.append("The traced gain barely varies across this run (%.2f dB). A "
                     "calibration needs the receiver to move." % x_span)
    if clipped:
        note = ("The tracer varied by %.1f dB but only %.1f dB reached the radio - the "
                "applied loss is clipped by max_drop_db. Nothing measured can track the "
                "traced channel beyond the clip, so raise max_drop_db before reading "
                "anything into a flat fit." % (x_span, applied_span))
        if applied_span is not None and applied_span >= RLF_ATTENUATION_HINT_DB - 10.0:
            note += (" Note that the link has been seen to fail near %.0f dB of applied "
                     "attenuation while carrying traffic; past that the UE drops and the "
                     "walk ends early, which truncates the fit rather than widening it."
                     % RLF_ATTENUATION_HINT_DB)
        notes.append(note)
    if ended_in_rlf:
        notes.append("This run ended in radio link failure: the measured series stops before "
                     "the traced one, so the fit covers only the part of the route the UE was "
                     "still attached for. Telemetry keeps arriving either way - the tracer "
                     "does not need a UE - so a short fit here is a truncated run, not "
                     "necessarily a weak correlation.")
    if applied_span is not None and applied_span < 3.0:
        notes.append("Only %.1f dB of loss ever reached the radio. That is unlikely to move "
                     "a modem sitting near the top of its range." % applied_span)

    return {
        "telemetry_samples": len(telemetry),
        "kpi_samples": len(series["kpi"]),
        "ue_kpi_samples": len(series["ue_kpi"]),
        "traced_span_db": x_span,
        "applied_span_db": applied_span,
        "applied_clipped": clipped,
        "tolerance_s": tolerance_s,
        "uplink": ul,
        "comparisons": results,
        "notes": notes,
    }


def svg_scatter(pairs: list[dict], fit: dict, *, x_label: str, y_label: str,
                width: int = 560, height: int = 360) -> str:
    pad_l, pad_b, pad_t, pad_r = 62, 46, 16, 14
    if not pairs:
        return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}">'
                f'<text x="{width/2}" y="{height/2}" text-anchor="middle" '
                f'font-family="sans-serif" font-size="13" fill="#888">no matched samples'
                f'</text></svg>')

    xs = [p["x"] for p in pairs]
    ys = [p["y"] for p in pairs]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    if x1 == x0:
        x0, x1 = x0 - 1, x1 + 1
    if y1 == y0:
        y0, y1 = y0 - 1, y1 + 1
    pw = width - pad_l - pad_r
    ph = height - pad_t - pad_b

    def sx(x):
        return pad_l + (x - x0) / (x1 - x0) * pw

    def sy(y):
        return pad_t + ph - (y - y0) / (y1 - y0) * ph

    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
             f'viewBox="0 0 {width} {height}" font-family="system-ui, sans-serif">',
             f'<rect width="{width}" height="{height}" fill="none"/>']

    for i in range(5):
        gx = pad_l + pw * i / 4
        gy = pad_t + ph * i / 4
        parts.append(f'<line x1="{gx:.1f}" y1="{pad_t}" x2="{gx:.1f}" y2="{pad_t+ph}" '
                     f'stroke="#e6e6e6" stroke-width="1"/>')
        parts.append(f'<line x1="{pad_l}" y1="{gy:.1f}" x2="{pad_l+pw}" y2="{gy:.1f}" '
                     f'stroke="#e6e6e6" stroke-width="1"/>')
        parts.append(f'<text x="{gx:.1f}" y="{pad_t+ph+16}" text-anchor="middle" '
                     f'font-size="10" fill="#666">{x0 + (x1-x0)*i/4:.1f}</text>')
        parts.append(f'<text x="{pad_l-6}" y="{pad_t+ph - ph*i/4 + 3:.1f}" '
                     f'text-anchor="end" font-size="10" fill="#666">'
                     f'{y0 + (y1-y0)*i/4:.1f}</text>')

    if fit.get("slope") is not None:
        ya = fit["slope"] * x0 + fit["intercept"]
        yb = fit["slope"] * x1 + fit["intercept"]
        parts.append(f'<line x1="{sx(x0):.1f}" y1="{max(pad_t, min(pad_t+ph, sy(ya))):.1f}" '
                     f'x2="{sx(x1):.1f}" y2="{max(pad_t, min(pad_t+ph, sy(yb))):.1f}" '
                     f'stroke="#c2410c" stroke-width="2"/>')

    for p in pairs:
        parts.append(f'<circle cx="{sx(p["x"]):.1f}" cy="{sy(p["y"]):.1f}" r="3.1" '
                     f'fill="#0e7490" fill-opacity="0.72"/>')

    parts.append(f'<text x="{pad_l+pw/2:.0f}" y="{height-8}" text-anchor="middle" '
                 f'font-size="11" fill="#333">{x_label}</text>')
    parts.append(f'<text x="14" y="{pad_t+ph/2:.0f}" text-anchor="middle" font-size="11" '
                 f'fill="#333" transform="rotate(-90 14 {pad_t+ph/2:.0f})">{y_label}</text>')

    if fit.get("r2") is not None:
        parts.append(f'<text x="{pad_l+pw-4}" y="{pad_t+13}" text-anchor="end" '
                     f'font-size="11" fill="#333">slope {fit["slope"]:.3f} · '
                     f'r2 {fit["r2"]:.3f} · n {fit["n"]}</text>')

    parts.append("</svg>")
    return "".join(parts)
