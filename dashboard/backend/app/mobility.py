from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Callable, Optional

DEFAULT_FLOOR_DB = 55.0
DEFAULT_CEILING_DB = 62.0

ADVANCE, HOLD, REVERSE, DONE = "advance", "hold", "reverse", "done"


def _clamp(i: int, n: int) -> int:
    return max(0, min(n - 1, i))


def _sinr(kpi: Optional[dict]) -> Optional[float]:
    if not kpi:
        return None
    v = kpi.get("ue_sinr_db", kpi.get("sinr"))
    return float(v) if v is not None else None


def patrol(*, index, direction, n_positions, kpi=None, params=None, rng=None) -> dict:
    if n_positions <= 1:
        return {"index": 0, "direction": direction, "action": DONE,
                "reason": "the route has nowhere to go"}
    nxt = index + direction
    if nxt >= n_positions or nxt < 0:
        direction = -direction
        nxt = index + direction
    return {"index": _clamp(nxt, n_positions), "direction": direction, "action": ADVANCE,
            "reason": "walking the route"}


def hold_above(*, index, direction, n_positions, kpi=None, params=None, rng=None) -> dict:
    params = params or {}
    floor = float(params.get("floor_db", DEFAULT_FLOOR_DB))
    sinr = _sinr(kpi)
    if sinr is None:
        return {"index": index, "direction": direction, "action": HOLD,
                "reason": "no measurement - holding rather than guessing"}
    if sinr < floor:
        return {"index": index, "direction": direction, "action": HOLD,
                "reason": f"sinr {sinr:.0f} below floor {floor:.0f} - holding"}
    out = patrol(index=index, direction=direction, n_positions=n_positions)
    out["reason"] = f"sinr {sinr:.0f} above floor {floor:.0f} - {out['reason']}"
    return out


def seek_coverage(*, index, direction, n_positions, kpi=None, params=None, rng=None) -> dict:
    params = params or {}
    floor = float(params.get("floor_db", DEFAULT_FLOOR_DB))
    ceiling = float(params.get("ceiling_db", DEFAULT_CEILING_DB))
    sinr = _sinr(kpi)
    if sinr is None:
        return {"index": index, "direction": direction, "action": HOLD,
                "reason": "no measurement - holding rather than guessing"}

    retreating = bool((params.get("state") or {}).get("retreating"))
    if sinr < floor:
        retreating = True
    elif retreating and sinr >= ceiling:
        retreating = False

    step = -1 if retreating else 1
    nxt = _clamp(index + step, n_positions)
    action = REVERSE if retreating else ADVANCE
    if retreating:
        why = (f"sinr {sinr:.0f} below floor {floor:.0f} - going back"
               if sinr < floor else
               f"sinr {sinr:.0f} under the ceiling {ceiling:.0f} - still going back")
    else:
        why = f"sinr {sinr:.0f} at or above ceiling {ceiling:.0f} - going on"

    if retreating and nxt == index:
        action, why = HOLD, f"sinr {sinr:.0f} poor, already at the start of the route"
    return {"index": nxt, "direction": step, "action": action, "reason": why,
            "state": {"retreating": retreating}}


def random_walk(*, index, direction, n_positions, kpi=None, params=None, rng=None) -> dict:
    rng = rng or random.Random(0)
    step = rng.choice((-1, 1))
    nxt = _clamp(index + step, n_positions)
    return {"index": nxt, "direction": step, "action": ADVANCE,
            "reason": f"random step {step:+d}"}


POLICIES: dict = {
    "patrol": patrol,
    "hold_above": hold_above,
    "seek_coverage": seek_coverage,
    "random_walk": random_walk,
}


def run_policy(policy: str, readings: list[Optional[dict]], *, n_positions: int,
               start_index: int = 0, direction: int = 1, params: Optional[dict] = None,
               seed: int = 0) -> dict:
    fn: Callable = POLICIES.get(policy)
    if fn is None:
        raise ValueError(f"unknown policy '{policy}'; have {sorted(POLICIES)}")

    rng = random.Random(seed)
    params = dict(params or {})
    index, track = start_index, []
    for i, kpi in enumerate(readings):
        out = fn(index=index, direction=direction, n_positions=n_positions,
                 kpi=kpi, params=params, rng=rng)
        if "state" in out:
            params["state"] = out["state"]
        index = out["index"]
        direction = out["direction"]
        track.append({"step": i, "index": index, "action": out["action"],
                      "reason": out["reason"],
                      "sinr_db": _sinr(kpi)})
    actions = {}
    for t in track:
        actions[t["action"]] = actions.get(t["action"], 0) + 1
    return {
        "policy": policy, "seed": seed, "params": params,
        "track": track,
        "final_index": index,
        "visited": sorted({t["index"] for t in track}),
        "n_visited": len({t["index"] for t in track}),
        "actions": actions,
    }


def differs_from_patrol(result: dict, n_positions: int) -> dict:
    baseline = run_policy("patrol", [None] * len(result["track"]),
                          n_positions=n_positions)
    same = [a["index"] for a in result["track"]] == [b["index"] for b in baseline["track"]]
    return {"same_as_patrol": same,
            "note": ("this policy produced the open-loop track - it did not react to anything"
                     if same else "this policy diverged from the open-loop walk")}


class Controller:

    def __init__(self, policy: str, *, n_positions: int, steer_path,
                 params: Optional[dict] = None, seed: int = 0, start_index: int = 0):
        if policy not in POLICIES:
            raise ValueError(f"unknown policy '{policy}'; have {sorted(POLICIES)}")
        self.policy = policy
        self.n_positions = int(n_positions)
        self.steer_path = Path(steer_path)
        self.params = dict(params or {})
        self.rng = random.Random(seed)
        self.index = int(start_index)
        self.direction = 1
        self.track: list = []

    def step(self, kpi: Optional[dict]) -> dict:
        out = POLICIES[self.policy](index=self.index, direction=self.direction,
                                    n_positions=self.n_positions, kpi=kpi,
                                    params=self.params, rng=self.rng)
        if "state" in out:
            self.params["state"] = out["state"]
        self.index = out["index"]
        self.direction = out["direction"]
        try:
            self.steer_path.write_text(str(self.index))
        except OSError:
            pass
        row = {"index": self.index, "action": out["action"], "reason": out["reason"],
               "sinr_db": _sinr(kpi)}
        self.track.append(row)
        return row

    def as_dict(self) -> dict:
        return {"policy": self.policy, "index": self.index, "steps": len(self.track),
                "track": self.track[-50:], "params": self.params}
