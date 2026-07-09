from __future__ import annotations

from typing import Iterator, Sequence

import numpy as np

DEFAULT_BATCH = 8

RX_AXIS = {"a": 0, "tau": 0, "interactions": 1, "vertices": 2}


def budget_for(sp, n_receivers, *, batched=True):
    out = dict(sp or {})
    if batched and n_receivers > 1:
        out["samples_per_src"] = int(out.get("samples_per_src", 1000000)) * int(n_receivers)
    return out


def chunks(items: Sequence, size: int = DEFAULT_BATCH) -> Iterator[list]:
    if size < 1:
        raise ValueError(f"batch size must be at least 1, got {size}")
    items = list(items)
    for i in range(0, len(items), size):
        yield items[i:i + size]


def batch_names(count: int, prefix: str = "_b") -> list[str]:
    return [f"{prefix}{i}" for i in range(count)]


def slice_rx(array, index: int, kind: str):
    if kind not in RX_AXIS:
        raise ValueError(f"unknown array kind {kind!r}; expected one of {sorted(RX_AXIS)}")
    a = np.asarray(array)
    axis = RX_AXIS[kind]
    if a.ndim <= axis:
        raise ValueError(f"{kind} has {a.ndim} dimensions, too few to hold a receiver axis "
                         f"at {axis}")
    if not 0 <= index < a.shape[axis]:
        raise IndexError(f"receiver {index} is outside {kind} with {a.shape[axis]} receivers")
    return np.take(a, [index], axis=axis)


def plan(n_positions: int, size: int = DEFAULT_BATCH) -> dict:
    if n_positions < 0:
        raise ValueError("n_positions must not be negative")
    size = max(1, int(size))
    n_batches = (n_positions + size - 1) // size
    return {
        "positions": n_positions,
        "batch_size": size,
        "batches": n_batches,
        "last_batch": (n_positions % size) or (size if n_positions else 0),
        "batched": size > 1 and n_positions > 1,
    }
