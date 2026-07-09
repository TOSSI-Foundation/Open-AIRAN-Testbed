import asyncio
import math
import sys
import threading
import time
import unittest
from pathlib import Path

_DASH = Path(__file__).resolve().parents[2]
for p in (_DASH / "backend", _DASH / "sionna-map" / "scene_builder"):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

import rf
from app import sionna_bridge as sb


def boresight(az_deg, dt_deg):
    a, b, _ = rf.orientation_rad({"azimuth_deg": az_deg, "downtilt_deg": dt_deg})
    return (math.cos(a) * math.cos(b), math.sin(a) * math.cos(b), -math.sin(b))


class Pointing(unittest.TestCase):

    def assertDir(self, got, want):
        for g, w in zip(got, want):
            self.assertAlmostEqual(g, w, places=6)

    def test_compass_azimuths(self):
        self.assertDir(boresight(0, 0), (0, 1, 0))
        self.assertDir(boresight(90, 0), (1, 0, 0))
        self.assertDir(boresight(180, 0), (0, -1, 0))
        self.assertDir(boresight(270, 0), (-1, 0, 0))

    def test_downtilt_points_down(self):
        self.assertLess(boresight(0, 6)[2], 0)
        self.assertAlmostEqual(boresight(0, 6)[2], -math.sin(math.radians(6)), places=6)


class NonBlockingWait(unittest.TestCase):

    def test_waiting_for_a_job_leaves_the_event_loop_free(self):
        class FakeJob:
            id, state = "j1", "running"
            done_event = threading.Event()
            def to_dict(self):
                return {"job_id": self.id, "state": self.state}

        job = FakeJob()

        def finish():
            time.sleep(0.5)
            job.state = "done"
            job.done_event.set()

        async def main():
            ticks = 0
            async def ticker():
                nonlocal ticks
                while not job.done_event.is_set():
                    ticks += 1
                    await asyncio.sleep(0.05)
            threading.Thread(target=finish).start()
            r, _ = await asyncio.gather(sb._job_response_async(job, {"wait": True}), ticker())
            return r, ticks

        r, ticks = asyncio.run(main())
        self.assertTrue(r["ok"])
        self.assertGreater(ticks, 5)


if __name__ == "__main__":
    unittest.main()
