from __future__ import annotations

import math
from typing import Optional, Sequence

import numpy as np

_COHERENCE_K = 1.0 / (2.0 * math.pi)


def rms_spread_hz(shifts, powers) -> Optional[float]:
    f = np.asarray(shifts, dtype=float).ravel()
    p = np.asarray(powers, dtype=float).ravel()
    if f.size == 0 or f.size != p.size:
        return None
    ok = np.isfinite(f) & np.isfinite(p) & (p > 0)
    if not ok.any():
        return None
    f, p = f[ok], p[ok]
    total = p.sum()
    if total <= 0:
        return None
    mean = float((p * f).sum() / total)
    var = float((p * (f - mean) ** 2).sum() / total)
    return math.sqrt(max(var, 0.0))


def mean_shift_hz(shifts, powers) -> Optional[float]:
    f = np.asarray(shifts, dtype=float).ravel()
    p = np.asarray(powers, dtype=float).ravel()
    if f.size == 0 or f.size != p.size:
        return None
    ok = np.isfinite(f) & np.isfinite(p) & (p > 0)
    if not ok.any():
        return None
    f, p = f[ok], p[ok]
    total = p.sum()
    if total <= 0:
        return None
    return float((p * f).sum() / total)


def max_shift_hz(shifts) -> Optional[float]:
    f = np.asarray(shifts, dtype=float).ravel()
    f = f[np.isfinite(f)]
    return None if f.size == 0 else float(np.abs(f).max())


def theoretical_max_hz(speed_mps: float, carrier_hz: float) -> float:
    return abs(float(speed_mps)) * float(carrier_hz) / 299792458.0


def coherence_time_s(spread_hz: Optional[float]) -> Optional[float]:
    if spread_hz is None or spread_hz <= 0:
        return None
    return _COHERENCE_K / float(spread_hz)


def staleness(coherence_s: Optional[float], interval_s: float) -> Optional[float]:
    if coherence_s is None or coherence_s <= 0 or interval_s <= 0:
        return None
    return float(interval_s) / float(coherence_s)


def velocity_from_step(here: Sequence[float], nxt: Sequence[float],
                       interval_s: float) -> list[float]:
    a = np.asarray(here, dtype=float).ravel()[:3]
    b = np.asarray(nxt, dtype=float).ravel()[:3]
    if a.size < 3 or b.size < 3 or not (interval_s > 0):
        return [0.0, 0.0, 0.0]
    return [float(v) for v in (b - a) / float(interval_s)]


def summarise(shifts, powers, *, speed_mps: float, carrier_hz: float,
              interval_s: float) -> dict:
    moving = abs(float(speed_mps)) > 0.0
    spread = rms_spread_hz(shifts, powers)
    coh = coherence_time_s(spread)
    stale = staleness(coh, interval_s)
    mean = mean_shift_hz(shifts, powers)
    return {
        "speed_mps": round(float(speed_mps), 3),
        "mean_shift_hz": None if mean is None else round(mean, 2),
        "max_shift_hz": (lambda m: None if m is None else round(m, 2))(max_shift_hz(shifts)),
        "theoretical_max_hz": round(theoretical_max_hz(speed_mps, carrier_hz), 2),
        "rms_spread_hz": None if spread is None else round(spread, 2),
        "coherence_time_s": None if coh is None else coh,
        "update_interval_s": float(interval_s),
        "updates_per_coherence_time": (None if stale is None or stale <= 0
                                       else round(1.0 / stale, 3)),
        "staleness": None if stale is None else round(stale, 2),
        "keeping_up": (None if not moving
                       else (True if stale is None else bool(stale <= 1.0))),
    }
