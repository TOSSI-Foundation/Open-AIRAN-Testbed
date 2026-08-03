import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app import mobility as mo


def readings(sinrs):
    return [None if s is None else {"ue_sinr_db": s} for s in sinrs]


class Patrol(unittest.TestCase):

    def test_it_walks_forward(self):
        out = mo.run_policy("patrol", readings([None] * 4), n_positions=10)
        self.assertEqual([t["index"] for t in out["track"]], [1, 2, 3, 4])

    def test_it_turns_round_at_the_end(self):
        out = mo.run_policy("patrol", readings([None] * 5), n_positions=3, start_index=1)
        self.assertEqual([t["index"] for t in out["track"]], [2, 1, 0, 1, 2])

    def test_a_route_of_one_point_goes_nowhere(self):
        out = mo.run_policy("patrol", readings([None] * 3), n_positions=1)
        self.assertEqual([t["index"] for t in out["track"]], [0, 0, 0])
        self.assertEqual(out["actions"], {mo.DONE: 3})

    def test_it_ignores_the_measurements_entirely(self):
        good = mo.run_policy("patrol", readings([70] * 5), n_positions=10)
        bad = mo.run_policy("patrol", readings([10] * 5), n_positions=10)
        self.assertEqual([t["index"] for t in good["track"]],
                         [t["index"] for t in bad["track"]])


class HoldAbove(unittest.TestCase):

    def test_a_good_link_keeps_walking(self):
        out = mo.run_policy("hold_above", readings([70] * 5), n_positions=10,
                            params={"floor_db": 55})
        self.assertEqual([t["index"] for t in out["track"]], [1, 2, 3, 4, 5])

    def test_it_stops_where_the_link_gives_out(self):
        out = mo.run_policy("hold_above", readings([70, 70, 40, 40, 40]),
                            n_positions=10, params={"floor_db": 55})
        self.assertEqual([t["index"] for t in out["track"]], [1, 2, 2, 2, 2])
        self.assertEqual(out["actions"][mo.HOLD], 3)

    def test_it_resumes_when_the_link_comes_back(self):
        out = mo.run_policy("hold_above", readings([70, 40, 40, 70, 70]),
                            n_positions=10, params={"floor_db": 55})
        self.assertEqual([t["index"] for t in out["track"]], [1, 1, 1, 2, 3])

    def test_it_reacted(self):
        out = mo.run_policy("hold_above", readings([70, 70, 40, 40]), n_positions=10,
                            params={"floor_db": 55})
        self.assertFalse(mo.differs_from_patrol(out, 10)["same_as_patrol"])

    def test_a_link_that_never_drops_gives_the_patrol_track(self):
        out = mo.run_policy("hold_above", readings([70] * 6), n_positions=10,
                            params={"floor_db": 55})
        d = mo.differs_from_patrol(out, 10)
        self.assertTrue(d["same_as_patrol"])
        self.assertIn("did not react", d["note"])


class SeekCoverage(unittest.TestCase):

    def test_it_retreats_when_the_link_drops(self):
        out = mo.run_policy("seek_coverage", readings([70, 70, 70, 40, 40]),
                            n_positions=10, params={"floor_db": 55, "ceiling_db": 62})
        self.assertEqual([t["index"] for t in out["track"]], [1, 2, 3, 2, 1])
        self.assertEqual(out["track"][-1]["action"], mo.REVERSE)

    def test_two_thresholds_are_what_stop_it_pacing(self):
        alternating = readings([70, 50, 58, 50, 58, 50])
        wide = mo.run_policy("seek_coverage", alternating, n_positions=20, start_index=10,
                             params={"floor_db": 55, "ceiling_db": 62})
        actions = [t["action"] for t in wide["track"]]
        self.assertEqual(actions[0], mo.ADVANCE)
        self.assertTrue(all(a == mo.REVERSE for a in actions[1:]), actions)
        reversals = sum(1 for a, b in zip(actions, actions[1:]) if a != b)
        self.assertEqual(reversals, 1)

    def test_a_single_threshold_would_pace(self):
        alternating = readings([70, 50, 58, 50, 58, 50])
        narrow = mo.run_policy("seek_coverage", alternating, n_positions=20, start_index=10,
                               params={"floor_db": 55, "ceiling_db": 55})
        actions = [t["action"] for t in narrow["track"]]
        reversals = sum(1 for a, b in zip(actions, actions[1:]) if a != b)
        self.assertGreater(reversals, 1, actions)

    def test_it_resumes_once_past_the_ceiling(self):
        out = mo.run_policy("seek_coverage", readings([70, 70, 40, 40, 70]),
                            n_positions=10, params={"floor_db": 55, "ceiling_db": 62})
        self.assertEqual(out["track"][-1]["action"], mo.ADVANCE)

    def test_it_cannot_retreat_past_the_start(self):
        out = mo.run_policy("seek_coverage", readings([40, 40, 40]), n_positions=10,
                            start_index=0, params={"floor_db": 55})
        self.assertEqual([t["index"] for t in out["track"]], [0, 0, 0])
        self.assertEqual(out["track"][-1]["action"], mo.HOLD)


class Silence(unittest.TestCase):

    def test_hold_above_holds_on_silence(self):
        out = mo.run_policy("hold_above", readings([70, None, None, 70]), n_positions=10)
        self.assertEqual([t["index"] for t in out["track"]], [1, 1, 1, 2])
        self.assertIn("no measurement", out["track"][1]["reason"])

    def test_seek_coverage_holds_on_silence(self):
        out = mo.run_policy("seek_coverage", readings([70, None, None, None]),
                            n_positions=10)
        self.assertEqual([t["index"] for t in out["track"]], [1, 1, 1, 1])
        for t in out["track"][1:]:
            self.assertEqual(t["action"], mo.HOLD)

    def test_silence_is_not_zero(self):
        quiet = mo.run_policy("seek_coverage", readings([None] * 4), n_positions=20,
                              start_index=10)
        zero = mo.run_policy("seek_coverage", readings([0.0] * 4), n_positions=20,
                             start_index=10)
        self.assertEqual([t["index"] for t in quiet["track"]], [10, 10, 10, 10])
        self.assertEqual([t["index"] for t in zero["track"]], [9, 8, 7, 6])
        self.assertNotEqual([t["index"] for t in quiet["track"]],
                            [t["index"] for t in zero["track"]])


class Replayability(unittest.TestCase):

    def test_the_same_readings_give_the_same_track(self):
        r = readings([70, 50, 45, 70, 70, 40])
        a = mo.run_policy("seek_coverage", r, n_positions=10)
        b = mo.run_policy("seek_coverage", r, n_positions=10)
        self.assertEqual([t["index"] for t in a["track"]],
                         [t["index"] for t in b["track"]])

    def test_a_random_policy_is_replayable_under_its_seed(self):
        r = readings([70] * 20)
        a = mo.run_policy("random_walk", r, n_positions=10, seed=7)
        b = mo.run_policy("random_walk", r, n_positions=10, seed=7)
        c = mo.run_policy("random_walk", r, n_positions=10, seed=8)
        self.assertEqual([t["index"] for t in a["track"]], [t["index"] for t in b["track"]])
        self.assertNotEqual([t["index"] for t in a["track"]], [t["index"] for t in c["track"]])

    def test_every_decision_says_why(self):
        out = mo.run_policy("seek_coverage", readings([70, 40, 40]), n_positions=10)
        for t in out["track"]:
            self.assertTrue(t["reason"])
            self.assertIn("sinr", t["reason"].lower())

    def test_an_unknown_policy_is_refused(self):
        with self.assertRaises(ValueError):
            mo.run_policy("teleport", readings([70]), n_positions=10)


class LiveController(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.steer = Path(self._tmp.name) / "steer"
        self.addCleanup(self._tmp.cleanup)

    def test_it_writes_the_step_the_publisher_will_read(self):
        c = mo.Controller("patrol", n_positions=10, steer_path=self.steer)
        c.step(None)
        self.assertEqual(self.steer.read_text(), "1")
        c.step(None)
        self.assertEqual(self.steer.read_text(), "2")

    def test_it_matches_the_offline_run(self):
        r = readings([70, 70, 40, 40, 70])
        offline = mo.run_policy("seek_coverage", r, n_positions=10)
        c = mo.Controller("seek_coverage", n_positions=10, steer_path=self.steer)
        live = [c.step(k)["index"] for k in r]
        self.assertEqual(live, [t["index"] for t in offline["track"]])

    def test_a_failed_write_does_not_stop_the_loop(self):
        c = mo.Controller("patrol", n_positions=10,
                          steer_path=Path("/nonexistent/dir/steer"))
        out = c.step(None)
        self.assertEqual(out["index"], 1)

    def test_an_unknown_policy_is_refused_at_construction(self):
        with self.assertRaises(ValueError):
            mo.Controller("teleport", n_positions=10, steer_path=self.steer)

    def test_the_track_is_reported_with_reasons(self):
        c = mo.Controller("hold_above", n_positions=10, steer_path=self.steer)
        for k in readings([70, 40, 40]):
            c.step(k)
        d = c.as_dict()
        self.assertEqual(d["steps"], 3)
        self.assertTrue(all(t["reason"] for t in d["track"]))


if __name__ == "__main__":
    unittest.main()
