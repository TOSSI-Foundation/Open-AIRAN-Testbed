from __future__ import annotations

import numpy as np

INT16_MIN, INT16_MAX = -32768, 32767

MAX_MIXABLE_CELLS = 3


def budget_ms(nof_samples: int, srate_hz: float) -> float:
    if srate_hz <= 0:
        raise ValueError("sample rate must be positive")
    return nof_samples / srate_hz * 1e3


def mix(chunks, gains, *, out=None):
    if len(chunks) == 0:
        raise ValueError("nothing to mix")
    if len(chunks) != len(gains):
        raise ValueError(f"{len(chunks)} chunk(s) and {len(gains)} gain(s)")
    if len(chunks) > MAX_MIXABLE_CELLS:
        raise ValueError(
            f"asked to mix {len(chunks)} cells; {MAX_MIXABLE_CELLS} is the measured limit that "
            "still leaves the relay time to do its own work")

    first = np.asarray(chunks[0])
    for c in chunks[1:]:
        c = np.asarray(c)
        if c.shape != first.shape:
            raise ValueError(f"chunks differ in length: {first.shape} vs {c.shape} - they are "
                             "not the same instant and must not be summed")
        if c.dtype != first.dtype:
            raise ValueError(f"chunks differ in dtype: {first.dtype} vs {c.dtype}")

    if first.dtype == np.int16:
        acc = np.multiply(first, gains[0], dtype=np.float32)
        for c, g in zip(chunks[1:], gains[1:]):
            acc += np.asarray(c) * np.float32(g)
        np.clip(acc, INT16_MIN, INT16_MAX, out=acc)
        return acc.astype(np.int16)

    if out is None:
        out = np.empty_like(first)
    np.multiply(first, first.dtype.type(gains[0]), out=out)
    for c, g in zip(chunks[1:], gains[1:]):
        out += np.asarray(c) * first.dtype.type(g)
    return out


def clipped_fraction(mixed, dtype) -> float:
    a = np.asarray(mixed)
    if dtype != np.int16:
        return 0.0
    n = int(np.count_nonzero((a <= INT16_MIN) | (a >= INT16_MAX)))
    return n / a.size if a.size else 0.0
