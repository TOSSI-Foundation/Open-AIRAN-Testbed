from __future__ import annotations

import csv
import io
import json
import math
from pathlib import Path
from typing import Optional

from . import calibration as cal

COLUMNS = (
    {"key": "run_id", "role": "key", "why": "which run this row came from"},
    {"key": "scene_id", "role": "key", "why": "which scene"},
    {"key": "geometry_sha", "role": "key",
     "why": "the scene fingerprint, so rows cannot be pooled across edited geometry"},
    {"key": "odu_sha", "role": "key",
     "why": "the DU build; the uplink columns mean different things across it"},
    {"key": "t", "role": "key", "why": "epoch seconds of the channel update"},
    {"key": "seq", "role": "key", "why": "the publisher sequence number"},
    {"key": "group", "role": "key",
     "why": "the traced position, quantised. Split on this, not on rows"},

    {"key": "gain_db", "role": "feature", "unit": "dB",
     "why": "traced path gain at this position"},
    {"key": "paths", "role": "feature", "unit": "count",
     "why": "how many propagation paths the solve found"},
    {"key": "pos_x", "role": "feature", "unit": "m", "why": "receiver east, ENU"},
    {"key": "pos_y", "role": "feature", "unit": "m", "why": "receiver north, ENU"},
    {"key": "dist_m", "role": "feature", "unit": "m",
     "why": "straight-line distance to the serving transmitter, including height"},

    {"key": "los", "role": "feature", "unit": "bool",
     "why": "whether any unobstructed path exists - the thing a gain figure cannot say"},
    {"key": "rms_delay_spread_s", "role": "feature", "unit": "s",
     "why": "how smeared in time the link is"},
    {"key": "first_arrival_s", "role": "feature", "unit": "s",
     "why": "propagation delay of the earliest path; closely tied to dist_m, not independent"},
    {"key": "strongest_share", "role": "feature", "unit": "fraction",
     "why": "how much of the power the dominant path carries"},
    {"key": "strongest_bounces", "role": "feature", "unit": "count",
     "why": "how many interactions the dominant path took"},
    {"key": "n_paths_traced", "role": "feature", "unit": "count",
     "why": "propagation paths found, counted once each rather than per antenna port"},
    {"key": "n_specular", "role": "feature", "unit": "count", "why": "mirror reflections"},
    {"key": "n_refraction", "role": "feature", "unit": "count", "why": "wall crossings"},
    {"key": "n_diffraction", "role": "feature", "unit": "count", "why": "edge bending"},
    {"key": "n_diffuse", "role": "feature", "unit": "count", "why": "rough scattering"},

    {"key": "ue_sinr_db", "role": "label", "unit": "dB",
     "why": "what the modem measured on the downlink"},
    {"key": "ue_cqi", "role": "label", "unit": "index", "why": "what the modem reported"},
    {"key": "dl_mcs", "role": "label", "unit": "index",
     "why": "what the scheduler decided the downlink could carry"},
    {"key": "dl_bler", "role": "label", "unit": "%", "why": "downlink block error rate"},
    {"key": "dl_ok", "role": "label", "unit": "count", "why": "blocks that landed"},
    {"key": "dl_nok", "role": "label", "unit": "count", "why": "blocks that did not"},
    {"key": "dl_kbps", "role": "label", "unit": "kbps", "why": "downlink rate carried"},
    {"key": "dl_prbs", "role": "label", "unit": "count", "why": "resource blocks allocated"},

    {"key": "applied_db", "role": "excluded", "unit": "dB",
     "why": "anchored to the strongest gain seen so far in the run and clipped at "
            "max_drop_db, so it encodes the running order rather than the geometry"},
    {"key": "dl_olla", "role": "excluded", "unit": "dB",
     "why": "the cell adapting to the errors that appear in the labels; it already "
            "contains the answer"},
    {"key": "rsrp_db", "role": "excluded", "unit": "dBm",
     "why": "uplink; carries the scene only on a DU build that filters the reverse link"},
    {"key": "snr_db", "role": "excluded", "unit": "dB",
     "why": "uplink; same caveat as rsrp_db"},
)

FEATURE_KEYS = tuple(c["key"] for c in COLUMNS if c["role"] == "feature")
LABEL_KEYS = tuple(c["key"] for c in COLUMNS if c["role"] == "label")
EXCLUDED_KEYS = tuple(c["key"] for c in COLUMNS if c["role"] == "excluded")
ALL_KEYS = tuple(c["key"] for c in COLUMNS)

_FROM_KPI = {
    "dl_mcs": "dl_mcs", "dl_bler": "dl_bler", "dl_ok": "dl_ok", "dl_nok": "dl_nok",
    "dl_kbps": "dl_kbps", "dl_prbs": "dl_prbs", "dl_olla": "dl_olla",
    "rsrp_db": "rsrp_db", "snr_db": "snr_db",
}
_FROM_UE = {"ue_sinr_db": "sinr", "ue_cqi": "cqi"}

_FROM_ENRICHED = ("los", "rms_delay_spread_s", "first_arrival_s",
                  "strongest_share", "strongest_bounces", "n_paths_traced",
                  "n_specular", "n_refraction", "n_diffraction", "n_diffuse")


def _tx_position(run: dict, scene_dir: Optional[Path]) -> Optional[list]:
    if scene_dir is None:
        return None
    try:
        pkg = json.loads((scene_dir / "package.json").read_text())
        manifest = pkg.get("manifest", pkg)
        for n in manifest.get("nodes", []) or []:
            if n.get("type") in ("gnb", "tower"):
                return [float(v) for v in n["enu_m"]]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return None


def _shifted(series: list[dict], shift_s: float) -> list[dict]:
    out = []
    for s in series:
        t = cal.to_epoch(s.get("t"))
        if t is not None:
            out.append(dict(s, t=t + shift_s))
    return out


def _nearest_index(times: list[float], t: float):
    lo, hi = 0, len(times) - 1
    while lo <= hi:
        mid = (lo + hi) // 2
        if times[mid] < t:
            lo = mid + 1
        else:
            hi = mid - 1
    best, best_d = None, None
    for i in (hi, lo):
        if 0 <= i < len(times):
            d = abs(times[i] - t)
            if best_d is None or d < best_d:
                best, best_d = i, d
    return best, best_d


UE_TOLERANCE_S = 4.0


def build_rows(run_dir, run: Optional[dict] = None, *,
               tolerance_s: float = cal.DEFAULT_TOLERANCE_S,
               ue_tolerance_s: float = UE_TOLERANCE_S,
               lag_s: Optional[float] = None,
               scene_dir: Optional[Path] = None,
               enriched: Optional[dict] = None) -> dict:
    run_dir = Path(run_dir)
    run = run or {}
    telemetry = cal.load_series(run_dir / "telemetry.jsonl")
    kpi = cal.load_series(run_dir / "kpi.jsonl")
    ue = cal.load_series(run_dir / "ue_kpi.jsonl")

    if lag_s is None:
        est = cal.estimate_lag(telemetry, ue, left_key="applied_db", right_key="sinr")
        lag_s = float((est.get("best") or {}).get("shift_s") or 0.0)
        lag_source = "estimated against UE SINR"
        lag_r2 = (est.get("best") or {}).get("r2")
    else:
        lag_s = float(lag_s)
        lag_source = "given by the caller"
        lag_r2 = None

    kpi_s = sorted(_shifted(kpi, lag_s), key=lambda s: s["t"])
    ue_s = sorted(_shifted(ue, lag_s), key=lambda s: s["t"])
    kpi_t = [s["t"] for s in kpi_s]
    ue_t = [s["t"] for s in ue_s]

    by_pos = ((enriched or {}).get("positions") or {})

    prov = ((run.get("params") or {}).get("provenance") or {})
    geo = ((prov.get("scene") or {}).get("geometry_short"))
    odu = (((prov.get("stack") or {}).get("binaries") or {}).get("odu") or {}).get("sha256_short")
    tx = _tx_position(run, scene_dir)

    rows, dropped = [], {"no_cell_reading": 0, "no_modem_reading": 0, "no_position": 0}
    for s in telemetry:
        t = cal.to_epoch(s.get("t"))
        if t is None:
            continue
        ki, kd = _nearest_index(kpi_t, t)
        ui, ud = _nearest_index(ue_t, t)
        if ki is None or kd > tolerance_s:
            dropped["no_cell_reading"] += 1
            continue
        if ui is None or ud > ue_tolerance_s:
            dropped["no_modem_reading"] += 1
            continue

        pos = s.get("pos") or []
        if len(pos) < 2:
            dropped["no_position"] += 1
            continue

        row = {
            "run_id": run.get("id"), "scene_id": run.get("scene_id"),
            "geometry_sha": geo, "odu_sha": odu,
            "t": round(t, 3), "seq": s.get("seq"),
            "gain_db": s.get("gain_db"), "paths": s.get("paths"),
            "pos_x": float(pos[0]), "pos_y": float(pos[1]),
            "group": group_key(pos),
            "applied_db": s.get("applied_db"),
        }
        if tx is not None:
            row["dist_m"] = round(math.dist([float(pos[0]), float(pos[1]), 0.0],
                                            [tx[0], tx[1], tx[2]]), 2)
        else:
            row["dist_m"] = None

        hit = by_pos.get("{:.2f},{:.2f}".format(float(pos[0]), float(pos[1])))
        for key in _FROM_ENRICHED:
            row[key] = hit.get(key) if hit else None

        k, u = kpi_s[ki], ue_s[ui]
        for out_key, src in _FROM_KPI.items():
            row[out_key] = k.get(src)
        for out_key, src in _FROM_UE.items():
            row[out_key] = u.get(src)
        rows.append(row)

    return {
        "rows": rows,
        "dropped": dropped,
        "lag_s": lag_s,
        "lag_source": lag_source,
        "lag_r2": lag_r2,
        "tolerance_s": tolerance_s,
        "ue_tolerance_s": ue_tolerance_s,
        "enriched": bool(by_pos),
        "enriched_positions": len(by_pos),
        "uplink": cal.uplink_is_filtered(run),
    }


def group_key(pos) -> Optional[str]:
    if not pos or len(pos) < 2:
        return None
    try:
        return f"{float(pos[0]):.2f},{float(pos[1]):.2f}"
    except (TypeError, ValueError):
        return None


def split_advice(rows: list[dict]) -> dict:
    groups = {r.get("group") for r in rows if r.get("group")}
    n_rows, n_groups = len(rows), len(groups)
    per = (n_rows / n_groups) if n_groups else 0.0
    return {
        "group_by": "group",
        "rows": n_rows,
        "distinct_groups": n_groups,
        "rows_per_group": round(per, 1),
        "random_split_leaks": bool(n_groups and per > 1.0),
        "why": ("A receiver is sampled repeatedly at each traced position, so rows sharing a "
                "`group` are the same geometry and the same channel. Splitting rows at random "
                "puts that geometry in train and test both, and the score that comes back "
                "measures memorisation. Group by `group`, or split by trajectory, transmitter "
                "or whole scene."),
    }


def schema() -> dict:
    return {
        "columns": list(COLUMNS),
        "features": list(FEATURE_KEYS),
        "labels": list(LABEL_KEYS),
        "excluded": list(EXCLUDED_KEYS),
        "note": ("Train on `features` only. The `excluded` columns are recorded for "
                 "traceability and each carries the reason it is not an input."),
        "split": {
            "group_by": "group",
            "why": ("Rows sharing a `group` were traced at the same position and are the same "
                    "geometry. A random row split puts them on both sides and the score "
                    "measures memorisation. Group by `group`, or split by trajectory, "
                    "transmitter, or whole scene."),
        },
    }


def to_csv(rows: list[dict]) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(ALL_KEYS), extrasaction="ignore")
    w.writeheader()
    for r in rows:
        w.writerow(r)
    return buf.getvalue()


def to_jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps({k: r.get(k) for k in ALL_KEYS}) + "\n" for r in rows)


def _sig(v, digits: int = 4):
    if v == 0 or not math.isfinite(v):
        return 0.0
    return round(v, -int(math.floor(math.log10(abs(v)))) + (digits - 1))


def coverage(rows: list[dict]) -> dict:
    out = {}
    for key in FEATURE_KEYS + LABEL_KEYS:
        vals = [r.get(key) for r in rows]
        present = [v for v in vals if v is not None]
        entry = {"present": len(present), "of": len(vals),
                 "distinct": len(set(present))}
        nums = [float(v) for v in present if isinstance(v, (int, float))]
        if nums:
            entry.update({"min": min(nums), "max": max(nums),
                          "span": _sig(max(nums) - min(nums))})
        out[key] = entry
    return out
