from __future__ import annotations

import threading
import time
from collections import deque
from pathlib import Path
from typing import Callable, Optional

from . import mobility

STEER_FILE = Path("/tmp/tossi_live_steer")

DEFAULT_INTERVAL_S = 2.0


def clear_steer_file() -> None:
    try:
        STEER_FILE.unlink()
    except OSError:
        pass


class Steering:

    def __init__(self) -> None:
        self.controller: Optional[mobility.Controller] = None
        self.policy: Optional[str] = None
        self.params: dict = {}
        self.started: Optional[float] = None
        self.interval: float = DEFAULT_INTERVAL_S
        self.n_positions: int = 0
        self.decisions: deque = deque(maxlen=200)
        self.reads: int = 0
        self.silent: int = 0
        self.errors: int = 0
        self.last_error: Optional[str] = None
        self._thread: Optional[threading.Thread] = None
        self._stop: Optional[threading.Event] = None
        self._lock = threading.Lock()


    def is_running(self) -> bool:
        return bool(self._thread and self._thread.is_alive())

    def start(self, policy: str, *, n_positions: int, read_sinr: Callable[[], Optional[float]],
              still_live: Callable[[], bool], params: Optional[dict] = None,
              seed: int = 0, start_index: int = 0,
              interval_s: float = DEFAULT_INTERVAL_S) -> dict:
        if policy not in mobility.POLICIES:
            raise ValueError(f"unknown policy '{policy}'; have {sorted(mobility.POLICIES)}")
        if n_positions < 2:
            raise ValueError("a route needs at least two positions to steer along")
        self.stop()

        with self._lock:
            self.controller = mobility.Controller(
                policy, n_positions=int(n_positions), steer_path=STEER_FILE,
                params=dict(params or {}), seed=int(seed), start_index=int(start_index))
            self.policy = policy
            self.params = dict(params or {})
            self.n_positions = int(n_positions)
            self.interval = max(0.2, float(interval_s))
            self.started = time.time()
            self.decisions = deque(maxlen=200)
            self.reads = 0
            self.silent = 0
            self.errors = 0
            self.last_error = None
            self._stop = threading.Event()
            self._thread = threading.Thread(
                target=self._loop, args=(read_sinr, still_live),
                name="tossi-steering", daemon=True)
            self._thread.start()
        return self.status()

    def stop(self) -> None:
        if self._stop:
            self._stop.set()
        t = self._thread
        if t and t.is_alive():
            t.join(timeout=3)
        self._thread = None
        clear_steer_file()


    def _loop(self, read_sinr: Callable[[], Optional[float]],
              still_live: Callable[[], bool]) -> None:
        stop = self._stop
        while stop is not None and not stop.is_set():
            if not still_live():
                break
            try:
                sinr = read_sinr()
            except Exception as exc:
                sinr = None
                self.errors += 1
                self.last_error = f"{type(exc).__name__}: {exc}"[:200]

            kpi = {"ue_sinr_db": sinr} if sinr is not None else None
            if sinr is None:
                self.silent += 1
            else:
                self.reads += 1

            try:
                row = self.controller.step(kpi)
            except Exception:
                break
            self.decisions.append({"t": time.time(), **row})
            stop.wait(self.interval)
        clear_steer_file()


    def status(self) -> dict:
        c = self.controller
        recent = list(self.decisions)[-25:]
        actions: dict = {}
        for d in recent:
            actions[d["action"]] = actions.get(d["action"], 0) + 1
        return {
            "running": self.is_running(),
            "policy": self.policy,
            "params": self.params,
            "n_positions": self.n_positions,
            "interval_s": self.interval,
            "started": self.started,
            "index": c.index if c else None,
            "steps": len(c.track) if c else 0,
            "readings": self.reads,
            "silent": self.silent,
            "errors": self.errors,
            "last_error": self.last_error,
            "recent_actions": actions,
            "decisions": recent,
            "steer_file": str(STEER_FILE),
        }


STEERING = Steering()
