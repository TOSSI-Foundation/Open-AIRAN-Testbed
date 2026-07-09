#!/usr/bin/env python3
from __future__ import annotations

import csv
import io
import math
from typing import Optional, Sequence, Tuple

import numpy as np

THERMAL_DBM_HZ = -173.98
DEFAULT_NOISE_FIGURE_DB = 7.0

COHERENCE_LEVELS = (0.5, 0.9)

_EPS = 1e-30

DELAY_DECIMALS_S = 12
GAIN_DECIMALS_DB = 2
SHARE_DECIMALS = 4


def _round_s(v):
    return None if v is None else round(float(v), DELAY_DECIMALS_S)


def noise_dbm_per_subcarrier(subcarrier_spacing_hz: float,
                             noise_figure_db: float = DEFAULT_NOISE_FIGURE_DB) -> float:
    return THERMAL_DBM_HZ + 10.0 * np.log10(max(subcarrier_spacing_hz, _EPS)) + noise_figure_db


def _link_matrix(h: np.ndarray, rx: int, tx: int) -> np.ndarray:
    if h.ndim != 6:
        raise ValueError("expected the CFR as [num_rx, num_rx_ant, num_tx, num_tx_ant, "
                         f"time, subcarrier]; got {h.shape}")
    block = h[rx, :, tx, :, 0, :]
    return np.moveaxis(block, -1, 0)


def coherence_bandwidth(hf: np.ndarray, subcarrier_spacing_hz: float,
                        levels=COHERENCE_LEVELS) -> dict:
    nf = hf.shape[0]
    if nf < 2:
        return {f"bc_{int(l*100)}_hz": None for l in levels}

    x = hf.reshape(nf, -1)
    denom = np.mean(np.abs(x) ** 2, axis=0)
    keep = denom > _EPS
    if not np.any(keep):
        return {f"bc_{int(l*100)}_hz": None for l in levels}
    x = x[:, keep]
    denom = denom[keep]

    max_lag = nf - 1
    corr = np.empty(max_lag + 1)
    for lag in range(max_lag + 1):
        c = np.mean(x[lag:] * np.conj(x[:nf - lag]), axis=0) / denom
        corr[lag] = float(np.abs(np.mean(c)))
    if corr[0] > 0:
        corr = corr / corr[0]

    out = {}
    for level in levels:
        below = np.nonzero(corr < level)[0]
        out[f"bc_{int(level*100)}_hz"] = (float(below[0] * subcarrier_spacing_hz)
                                          if below.size else None)
    return out


def _effective_rank(sv: np.ndarray) -> float:
    p = sv ** 2
    total = p.sum()
    if total <= _EPS:
        return 0.0
    p = p / total
    p = p[p > _EPS]
    return float(np.exp(-np.sum(p * np.log(p))))


def link_kpis(h: np.ndarray, *, tx_power_dbm: float, subcarrier_spacing_hz: float,
              noise_figure_db: float = DEFAULT_NOISE_FIGURE_DB,
              rx: int = 0, tx: int = 0,
              interferers: Optional[Sequence[Tuple[int, float]]] = None) -> dict:
    hf = _link_matrix(h, rx, tx)
    nf, n_rx_ant, n_tx_ant = hf.shape

    n0_dbm = noise_dbm_per_subcarrier(subcarrier_spacing_hz, noise_figure_db)
    p_sc_dbm = tx_power_dbm - 10.0 * np.log10(max(nf, 1))
    p_over_n0 = 10.0 ** ((p_sc_dbm - n0_dbm) / 10.0)

    frob2 = np.sum(np.abs(hf) ** 2, axis=(1, 2))
    coherent = np.abs(np.sum(hf, axis=(1, 2))) ** 2 / max(n_tx_ant, 1)

    snr_mrt = p_over_n0 * frob2
    snr_uniform = p_over_n0 * coherent

    interf = np.zeros(nf)
    for j, p_dbm in (interferers or []):
        if int(j) == int(tx):
            continue
        hj = _link_matrix(h, rx, int(j))
        n_tx_j = hj.shape[2]
        p_j = 10.0 ** ((float(p_dbm) - 10.0 * np.log10(max(nf, 1))) / 10.0)
        interf += (p_j / max(n_tx_j, 1)) * np.sum(np.abs(hj) ** 2, axis=(1, 2))

    has_interf = bool(np.any(interf > 0.0))
    n0_lin = 10.0 ** (n0_dbm / 10.0)
    if has_interf:
        derate = n0_lin / (n0_lin + interf)
        sinr_mrt = snr_mrt * derate
        sinr_uniform = snr_uniform * derate
    else:
        sinr_mrt, sinr_uniform = snr_mrt, snr_uniform

    eye = np.eye(n_rx_ant)
    scale = p_over_n0 / max(n_tx_ant, 1)
    se_no_csi = np.empty(nf)
    sv_all = np.empty((nf, min(n_rx_ant, n_tx_ant)))
    for f in range(nf):
        hh = hf[f] @ hf[f].conj().T
        sign, logdet = np.linalg.slogdet(
            eye + scale * hh * (n0_lin / (n0_lin + interf[f]) if has_interf else 1.0))
        se_no_csi[f] = logdet / np.log(2.0) if sign > 0 else 0.0
        sv_all[f] = np.linalg.svd(hf[f], compute_uv=False)

    se_mrt = np.log2(1.0 + sinr_mrt)
    se_uniform = np.log2(1.0 + sinr_uniform)

    bandwidth_hz = nf * subcarrier_spacing_hz
    mean_mrt = float(np.mean(se_mrt))
    mean_uniform = float(np.mean(se_uniform))
    mean_no_csi = float(np.mean(se_no_csi))

    def _db(x):
        return float(10.0 * np.log10(x + _EPS))

    best_port = np.max(np.sum(np.abs(hf) ** 2, axis=1), axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        ratio = np.where(best_port > _EPS, frob2 / np.maximum(best_port, _EPS), np.nan)
    gain_db = float(_db(np.nanmean(ratio))) if np.any(np.isfinite(ratio)) else None

    eff_rank = float(np.mean([_effective_rank(sv_all[f]) for f in range(nf)]))
    smax = sv_all.max(axis=1)
    smin = sv_all.min(axis=1)
    if sv_all.shape[1] > 1:
        with np.errstate(divide="ignore", invalid="ignore"):
            cond = np.where(smin > _EPS, smax / np.maximum(smin, _EPS), np.inf)
        cond_mean = float(np.mean(cond[np.isfinite(cond)])) if np.any(np.isfinite(cond)) else None
    else:
        cond_mean = None

    return {
        "num_subcarriers": int(nf),
        "num_rx_ant": int(n_rx_ant),
        "num_tx_ant": int(n_tx_ant),
        "bandwidth_hz": float(bandwidth_hz),
        "subcarrier_spacing_hz": float(subcarrier_spacing_hz),
        "tx_power_dbm": float(tx_power_dbm),
        "noise_dbm_per_subcarrier": float(n0_dbm),
        "noise_figure_db": float(noise_figure_db),

        "snr_db": {
            "mrt": _db(float(np.mean(snr_mrt))),
            "uniform_beam": _db(float(np.mean(snr_uniform))),
        },
        "sinr_db": ({"mrt": _db(float(np.mean(sinr_mrt))),
                     "uniform_beam": _db(float(np.mean(sinr_uniform)))}
                    if has_interf else None),
        "interference_dbm_per_subcarrier": (_db(float(np.mean(interf)))
                                            if has_interf else None),
        "interferers": int(sum(1 for j, _ in (interferers or []) if int(j) != int(tx))),
        "spectral_efficiency_bps_hz": {
            "mrt": mean_mrt,
            "uniform_beam": mean_uniform,
            "no_csi": mean_no_csi,
        },
        "throughput_mbps": {
            "mrt": mean_mrt * bandwidth_hz / 1e6,
            "uniform_beam": mean_uniform * bandwidth_hz / 1e6,
            "no_csi": mean_no_csi * bandwidth_hz / 1e6,
        },
        "beamforming_gain_db": gain_db,
        "array_gain_ceiling_db": float(10.0 * np.log10(max(n_tx_ant, 1))),

        "effective_rank": eff_rank,
        "max_rank": int(min(n_rx_ant, n_tx_ant)),
        "condition_number": cond_mean,

        **coherence_bandwidth(hf, subcarrier_spacing_hz),

        "path_gain_db": _db(float(np.mean(frob2))),
    }


def _drop_antenna_axes(arr, ndim_with_ant, ant_axes):
    import numpy as _np
    a = _np.asarray(arr)
    if a.ndim != ndim_with_ant:
        return a
    for ax in sorted(ant_axes, reverse=True):
        if a.shape[ax] == 1:
            a = _np.squeeze(a, axis=ax)
    return a


def rms_delay_spread(tau: np.ndarray, a: np.ndarray) -> dict:
    tau = np.asarray(tau)
    a = np.asarray(a)
    if tau.ndim == 5:
        tau = _drop_antenna_axes(tau, 5, (3, 1))
    p = np.sum(np.abs(a) ** 2, axis=(1, 3, 5)) if a.ndim == 6 else np.abs(a) ** 2
    total = p.sum()
    if total <= _EPS or tau.size == 0:
        return {"rms_delay_spread_s": None, "mean_delay_s": None, "num_paths": 0}
    w = p / total
    mean = float(np.sum(w * tau))
    var = float(np.sum(w * (tau - mean) ** 2))
    return {
        "rms_delay_spread_s": _round_s(float(np.sqrt(max(var, 0.0)))),
        "mean_delay_s": _round_s(mean),
        "num_paths": int(np.sum(p > _EPS)),
    }


INTERACTION_NONE = 0
INTERACTION_SPECULAR = 1
INTERACTION_DIFFUSE = 2
INTERACTION_REFRACTION = 4
INTERACTION_DIFFRACTION = 8

_INTERACTION_NAMES = (
    (INTERACTION_SPECULAR, "specular"),
    (INTERACTION_DIFFUSE, "diffuse"),
    (INTERACTION_REFRACTION, "refraction"),
    (INTERACTION_DIFFRACTION, "diffraction"),
)


def interaction_name(code: int) -> str:
    code = int(code)
    if code == INTERACTION_NONE:
        return "none"
    names = [n for bit, n in _INTERACTION_NAMES if code & bit]
    return "+".join(names) if names else f"unknown({code})"


def ray_points(vertices, interactions, tx_position, rx_position, *,
               rx: int = 0, tx: int = 0, path: int = 0) -> list:
    vertices = np.asarray(vertices)
    interactions = np.asarray(interactions)
    if vertices.ndim != 5 or vertices.shape[-1] != 3:
        raise ValueError("expected vertices [depth, rx, tx, path, 3]; got "
                         f"{vertices.shape}")

    kinds = interactions[:, rx, tx, path]
    pts = [[float(v) for v in tx_position]]
    for d in range(vertices.shape[0]):
        if int(kinds[d]) == INTERACTION_NONE:
            break
        pts.append([round(float(v), 2) for v in vertices[d, rx, tx, path]])
    pts.append([float(v) for v in rx_position])
    return pts


def path_detail(interactions, tau, a, *, rx: int = 0, tx: int = 0, top_n: int = 15,
                vertices=None, tx_position=None, rx_position=None) -> dict:
    interactions = np.asarray(interactions)
    tau = np.asarray(tau)
    a = np.asarray(a)

    if interactions.ndim == 6 and tau.ndim == 5:
        interactions = _drop_antenna_axes(interactions, 6, (4, 2))
        tau = _drop_antenna_axes(tau, 5, (3, 1))
        if vertices is not None:
            vertices = _drop_antenna_axes(np.asarray(vertices), 7, (4, 2))

    if interactions.ndim != 4 or tau.ndim != 3:
        raise ValueError("expected interactions [depth, rx, tx, path] and tau [rx, tx, path]; "
                         f"got {interactions.shape} and {tau.shape}")

    inter = interactions[:, rx, tx, :]
    delays = tau[rx, tx, :]
    power = np.sum(np.abs(a[rx, :, tx, :, :, :]) ** 2, axis=(0, 1, 3))

    real = power > 0.0
    if real.size and not real.all():
        inter = inter[:, real]
        delays = delays[real]
        power = power[real]

    nof = int(delays.size)
    if nof == 0:
        return {"los": False, "num_paths": 0, "first_arrival_s": None,
                "interaction_counts": {}, "paths": []}

    bounces = np.sum(inter != INTERACTION_NONE, axis=0)
    los = bool(np.any(bounces == 0))

    counts = {}
    for bit, name in _INTERACTION_NAMES:
        n = int(np.sum((inter & bit) != 0))
        if n:
            counts[name] = n

    original = np.flatnonzero(real) if real.size else np.arange(0)
    order = np.argsort(power)[::-1][:max(int(top_n), 0)]
    total = float(power.sum())
    listed = []
    want_geometry = (vertices is not None and tx_position is not None
                     and rx_position is not None)
    for i in order:
        kinds = [interaction_name(c) for c in inter[:, i] if int(c) != INTERACTION_NONE]
        row = {
            "delay_s": _round_s(float(delays[i])),
            "gain_db": round(float(10.0 * np.log10(power[i] + _EPS)), GAIN_DECIMALS_DB),
            "share": round(float(power[i] / total), SHARE_DECIMALS) if total > _EPS else 0.0,
            "bounces": int(bounces[i]),
            "kinds": kinds,
            "los": bool(bounces[i] == 0),
        }
        if want_geometry:
            row["points"] = ray_points(vertices, interactions, tx_position, rx_position,
                                       rx=rx, tx=tx, path=int(original[i]))
        listed.append(row)

    return {
        "los": los,
        "num_paths": nof,
        "num_paths_listed": len(listed),
        "first_arrival_s": float(np.min(delays)) if nof else None,
        "interaction_counts": counts,
        "paths": listed,
    }


SPEED_OF_LIGHT_M_S = 299792458.0

PATH_CSV_COLUMNS = (
    "path", "rank", "kinds", "bounces", "los",
    "delay_s", "distance_m", "distance_from",
    "gain_db", "rss_dbm", "share",
    "vertices_enu",
)


def path_rows(detail: dict, *, tx_power_dbm: Optional[float] = None,
              delays_normalized: bool = False) -> list[dict]:
    rows = []
    for rank, pth in enumerate(detail.get("paths") or []):
        pts = pth.get("points") or []
        dist, source = None, ""
        if len(pts) >= 2:
            dist = 0.0
            for a, b in zip(pts, pts[1:]):
                dist += math.dist(a[:3], b[:3])
            source = "vertices"
        elif pth.get("delay_s") is not None:
            dist = float(pth["delay_s"]) * SPEED_OF_LIGHT_M_S
            source = "delay_excess" if delays_normalized else "delay"

        gain = pth.get("gain_db")
        rows.append({
            "path": rank,
            "rank": rank,
            "kinds": "|".join(pth.get("kinds") or []) or ("los" if pth.get("los") else ""),
            "bounces": pth.get("bounces"),
            "los": bool(pth.get("los")),
            "delay_s": pth.get("delay_s"),
            "distance_m": None if dist is None else round(dist, 3),
            "distance_from": source,
            "gain_db": gain,
            "rss_dbm": (None if (tx_power_dbm is None or gain is None)
                        else round(float(tx_power_dbm) + float(gain), 2)),
            "share": pth.get("share"),
            "vertices_enu": ";".join(",".join(f"{c:.2f}" for c in v[:3]) for v in pts),
        })
    return rows


def paths_csv(detail: dict, *, tx_power_dbm: Optional[float] = None,
              delays_normalized: bool = False) -> str:
    buf = io.StringIO()
    w = csv.DictWriter(buf, fieldnames=list(PATH_CSV_COLUMNS), extrasaction="ignore")
    w.writeheader()
    for row in path_rows(detail, tx_power_dbm=tx_power_dbm,
                         delays_normalized=delays_normalized):
        w.writerow(row)
    return buf.getvalue()
