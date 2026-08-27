import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app import runs_store as rs


class WriteLogs(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.d = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._orig = rs.RUNS_DIR
        rs.RUNS_DIR = self.d
        self.addCleanup(lambda: setattr(rs, "RUNS_DIR", self._orig))
        (self.d / "run1").mkdir()

    def test_it_writes_what_the_source_gives_it(self):
        n = rs.write_logs("run1", {"logs": lambda: {"du": ["a", "b"], "cu": ["c"]}})
        self.assertEqual(sorted(n), ["cu", "du"])
        self.assertEqual((self.d / "run1" / "du.log").read_text(), "a\nb\n")
        self.assertEqual((self.d / "run1" / "cu.log").read_text(), "c\n")

    def test_an_empty_log_is_not_written(self):
        rs.write_logs("run1", {"logs": lambda: {"du": [], "cu": ["c"]}})
        self.assertFalse((self.d / "run1" / "du.log").exists())
        self.assertTrue((self.d / "run1" / "cu.log").exists())

    def test_a_source_that_raises_does_not_take_the_recorder_with_it(self):
        def boom():
            raise RuntimeError("log process is gone")
        self.assertEqual(rs.write_logs("run1", {"logs": boom}), [])

    def test_no_log_source_is_not_an_error(self):
        self.assertEqual(rs.write_logs("run1", {}), [])
        self.assertEqual(rs.write_logs("run1", None), [])

    def test_an_unknown_run_is_not_an_error(self):
        self.assertEqual(rs.write_logs("nope", {"logs": lambda: {"du": ["a"]}}), [])

    def test_a_later_snapshot_replaces_the_earlier_one(self):
        rs.write_logs("run1", {"logs": lambda: {"du": ["one"]}})
        rs.write_logs("run1", {"logs": lambda: {"du": ["one", "two"]}})
        self.assertEqual((self.d / "run1" / "du.log").read_text(), "one\ntwo\n")


class Interval(unittest.TestCase):
    def test_snapshots_are_far_rarer_than_samples(self):
        self.assertGreaterEqual(rs.LOG_SNAPSHOT_INTERVAL_S, 30 * rs.SAMPLE_INTERVAL_S)


class Diagnosable(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.d = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._orig = rs.RUNS_DIR
        rs.RUNS_DIR = self.d
        self.addCleanup(lambda: setattr(rs, "RUNS_DIR", self._orig))
        (self.d / "run1").mkdir()

    def test_an_abandoned_run_carries_its_own_evidence(self):
        from app import stability
        du = ["2026-08-19T13:56:18.418591 [DU-F1   ] [I] Rx PDU du=0 ue=0: "
              "UEContextReleaseCommand"]
        rs.write_logs("run1", {"logs": lambda: {"du": du}})

        out = stability.diagnose(self.d / "run1", live=False)
        self.assertTrue(out["dropped"])
        self.assertTrue(out["du"]["cu_initiated"])
        self.assertFalse(out["sources"]["du"]["shared"])


if __name__ == "__main__":
    unittest.main()
