from __future__ import annotations

import math
from typing import Optional, Sequence

import numpy as np

NO_COVERAGE = float("nan")

_EDGE_TOLERANCE = 1.0000001


def to_db(linear) -> np.ndarray:
    a = np.asarray(linear, dtype=float)
    out = np.full(a.shape, NO_COVERAGE)
    good = a > 0
    out[good] = 10.0 * np.log10(a[good])
    return out


DBW_TO_DBM = 30.0


def to_dbm(watts):
    return to_db(watts) + DBW_TO_DBM


def best_server(values) -> tuple[np.ndarray, np.ndarray]:
    a = np.asarray(values, dtype=float)
    if a.ndim == 2:
        v = a
        idx = np.where(np.isnan(v) | (v <= 0), -1, 0)
        return idx, v
    if a.ndim != 3:
        raise ValueError(f"expected (num_tx, ny, nx) or (ny, nx), got {a.shape}")

    reached = np.isfinite(a) & (a > 0)
    any_reached = reached.any(axis=0)
    filled = np.where(reached, a, -np.inf)
    idx = np.argmax(filled, axis=0)
    val = np.take_along_axis(filled, idx[None], axis=0)[0]
    idx = np.where(any_reached, idx, -1)
    val = np.where(any_reached, val, NO_COVERAGE)
    return idx, val


def at_serving(values, serving_idx):
    a = np.asarray(values, dtype=float)
    idx = np.asarray(serving_idx)
    if a.ndim == 2:
        a = a[None]
    if a.ndim != 3:
        raise ValueError(f"expected (num_tx, ny, nx) or (ny, nx), got {a.shape}")
    if idx.shape != a.shape[1:]:
        raise ValueError(f"serving index {idx.shape} does not match the grid {a.shape[1:]}")

    served = idx >= 0
    safe = np.where(served, idx, 0)
    out = np.take_along_axis(a, safe[None], axis=0)[0]
    return np.where(served, out, NO_COVERAGE)


def association_edges(assoc) -> np.ndarray:
    a = np.asarray(assoc)
    if a.ndim != 2:
        raise ValueError(f"expected (ny, nx), got {a.shape}")
    edge = np.zeros(a.shape, dtype=bool)
    served = a >= 0
    for axis, shift in ((0, 1), (0, -1), (1, 1), (1, -1)):
        nb = np.roll(a, shift, axis=axis)
        nb_served = np.roll(served, shift, axis=axis)
        differs = served & nb_served & (nb != a)
        if axis == 0:
            differs[0 if shift == 1 else -1, :] = False
        else:
            differs[:, 0 if shift == 1 else -1] = False
        edge |= differs
    return edge


DEFAULT_MARGIN_DB = 3.0


def contested(values, margin_db: float = DEFAULT_MARGIN_DB) -> dict:
    a = np.asarray(values, dtype=float)
    if a.ndim == 2:
        a = a[None]
    if a.ndim != 3:
        raise ValueError(f"expected (num_tx, ny, nx) or (ny, nx), got {a.shape}")

    reached = np.isfinite(a) & (a > 0)
    n_reached = reached.sum(axis=0)
    filled = np.where(reached, a, 0.0)

    if a.shape[0] == 1:
        top1 = filled[0]
        top2 = np.zeros_like(top1)
    else:
        part = np.sort(filled, axis=0)
        top1, top2 = part[-1], part[-2]

    both = n_reached >= 2
    with np.errstate(divide="ignore", invalid="ignore"):
        margin = 10.0 * np.log10(np.where(both & (top2 > 0), top1 / np.where(top2 > 0, top2, 1.0),
                                          np.inf))
    is_contested = both & (margin < float(margin_db))
    return {
        "contested": is_contested,
        "sole": n_reached == 1,
        "firm": (n_reached >= 1) & ~is_contested,
        "unserved": n_reached == 0,
        "margin_db": np.where(n_reached >= 1, margin, NO_COVERAGE),
        "threshold_db": float(margin_db),
        "cells_contested": int(is_contested.sum()),
        "cells_served": int((n_reached >= 1).sum()),
    }


def cell_index_at(cell_centers, x: float, y: float) -> Optional[tuple[int, int]]:
    cc = np.asarray(cell_centers, dtype=float)
    if cc.ndim != 3 or cc.shape[2] < 2:
        raise ValueError(f"expected (ny, nx, 3) cell centres, got {cc.shape}")
    if cc.shape[0] == 0 or cc.shape[1] == 0:
        return None

    d2 = (cc[..., 0] - float(x)) ** 2 + (cc[..., 1] - float(y)) ** 2
    flat = int(np.argmin(d2))
    r, c = divmod(flat, cc.shape[1])

    limit = _max_inside_distance(cc)
    if limit is not None and math.sqrt(float(d2[r, c])) > limit * _EDGE_TOLERANCE:
        return None
    return r, c


def _max_inside_distance(cc: np.ndarray) -> Optional[float]:
    ny, nx = cc.shape[0], cc.shape[1]
    dx = dy = None
    if nx > 1:
        dx = float(np.linalg.norm(cc[0, 1, :2] - cc[0, 0, :2]))
    if ny > 1:
        dy = float(np.linalg.norm(cc[1, 0, :2] - cc[0, 0, :2]))
    if dx is None and dy is None:
        return None
    dx = dx if dx is not None else dy
    dy = dy if dy is not None else dx
    return 0.5 * math.hypot(dx, dy)


def sample_at(grid, cell_centers, x: float, y: float) -> Optional[float]:
    at = cell_index_at(cell_centers, x, y)
    if at is None:
        return None
    v = float(np.asarray(grid, dtype=float)[at])
    return None if not math.isfinite(v) else v


def sample_track(grid, cell_centers, positions: Sequence[Sequence[float]]) -> list[Optional[float]]:
    return [sample_at(grid, cell_centers, p[0], p[1]) for p in positions]


def coverage_fraction(db_grid, threshold_db: float) -> dict:
    a = np.asarray(db_grid, dtype=float)
    served = np.isfinite(a)
    n_served = int(served.sum())
    n_total = int(a.size)
    above = int((a[served] >= threshold_db).sum()) if n_served else 0
    return {
        "threshold_db": float(threshold_db),
        "cells_total": n_total,
        "cells_served": n_served,
        "cells_above": above,
        "fraction_of_served": (above / n_served) if n_served else None,
        "fraction_of_area": (above / n_total) if n_total else None,
    }


def summarise(db_grid) -> dict:
    a = np.asarray(db_grid, dtype=float)
    v = a[np.isfinite(a)]
    if v.size == 0:
        return {"cells_served": 0, "min_db": None, "max_db": None, "median_db": None,
                "p05_db": None, "p95_db": None}
    return {
        "cells_served": int(v.size),
        "min_db": float(v.min()),
        "max_db": float(v.max()),
        "median_db": float(np.median(v)),
        "p05_db": float(np.percentile(v, 5)),
        "p95_db": float(np.percentile(v, 95)),
    }


def offset_against(grid, cell_centers, reference: Sequence[dict], *,
                   value_key: str = "gain_db") -> dict:
    diffs, paired = [], 0
    for s in reference:
        pos = s.get("pos") or s.get("position")
        ref = s.get(value_key)
        if not pos or len(pos) < 2 or ref is None:
            continue
        v = sample_at(grid, cell_centers, float(pos[0]), float(pos[1]))
        if v is None:
            continue
        paired += 1
        diffs.append(float(ref) - v)

    if not diffs:
        return {"n": 0, "mean_db": None, "median_db": None, "spread_db": None,
                "uniform": None, "value_key": value_key}
    a = np.asarray(diffs)
    spread = float(np.percentile(a, 95) - np.percentile(a, 5))
    return {
        "n": paired,
        "mean_db": float(a.mean()),
        "median_db": float(np.median(a)),
        "spread_db": spread,
        "uniform": bool(spread <= 6.0),
        "value_key": value_key,
    }


def compare_to_measured(grid, cell_centers, samples: Sequence[dict], *,
                        value_key: str = "sinr") -> dict:
    pairs, off_map, unreached, no_measure = [], 0, 0, 0
    for s in samples:
        pos = s.get("pos") or s.get("position")
        if not pos or len(pos) < 2:
            continue
        y = s.get(value_key)
        if y is None:
            no_measure += 1
            continue
        at = cell_index_at(cell_centers, float(pos[0]), float(pos[1]))
        if at is None:
            off_map += 1
            continue
        x = float(np.asarray(grid, dtype=float)[at])
        if not math.isfinite(x):
            unreached += 1
            continue
        pairs.append({"x": x, "y": float(y), "pos": [float(pos[0]), float(pos[1])]})

    return {
        "pairs": pairs,
        "n": len(pairs),
        "excluded": {"off_map": off_map, "unreached_cell": unreached,
                     "no_measurement": no_measure},
        "value_key": value_key,
    }
