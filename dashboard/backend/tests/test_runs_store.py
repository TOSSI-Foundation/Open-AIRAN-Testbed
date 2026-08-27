import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app import runs_store as rs


TELEMETRY = [
    {"t": 1787038981.475001, "seq": 0, "gain_db": -108.5, "applied_db": 0.0,
     "paths": 2, "trace_ms": 1553, "pos": [329.0, -10.0]},
    {"t": 1787038982.190970, "seq": 1, "gain_db": -108.5, "applied_db": 0.0,
     "paths": 2, "trace_ms": 269, "pos": [329.0, -10.0]},
    {"t": 1787039088.283352, "seq": 54, "gain_db": -91.6, "applied_db": 1.3,
     "paths": 2, "trace_ms": 297, "pos": [189.0, -3.0]},
]

KPI = [
    {"ue": 0, "t": "2026-08-18T07:08:28.603921", "rsrp_db": -33.7, "snr_db": 44.9,
     "cqi": None, "dl_mcs": 3, "dl_kbps": 6.84},
    {"ue": 0, "t": "2026-08-18T07:08:42.802117", "rsrp_db": -34.8, "snr_db": 41.0,
     "cqi": None, "dl_mcs": 3, "dl_kbps": 0.224},
    {"ue": 0, "t": "2026-08-18T07:44:47.175662", "rsrp_db": None, "snr_db": None,
     "cqi": None, "dl_mcs": 0, "dl_kbps": 0.0},
]


class SeriesReading(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, rows, tail=""):
        p = self.dir / name
        p.write_text("\n".join(json.dumps(r) for r in rows) + "\n" + tail)
        return p

    def test_reads_every_row_in_order(self):
        got = rs._series(self._write("telemetry.jsonl", TELEMETRY))
        self.assertEqual(len(got), 3)
        self.assertEqual([r["seq"] for r in got], [0, 1, 54])
        self.assertEqual(got[-1]["gain_db"], -91.6)

    def test_a_missing_file_is_an_empty_series_not_an_error(self):
        self.assertEqual(rs._series(self.dir / "never_written.jsonl"), [])

    def test_a_half_written_final_line_costs_only_itself(self):
        got = rs._series(self._write("telemetry.jsonl", TELEMETRY, tail='{"t": 178703'))
        self.assertEqual(len(got), 3)

    def test_blank_lines_are_skipped(self):
        p = self.dir / "kpi.jsonl"
        p.write_text("\n".join([json.dumps(KPI[0]), "", json.dumps(KPI[1]), "  ", ""]))
        self.assertEqual(len(rs._series(p)), 2)

    def test_nulls_survive_as_nulls(self):
        got = rs._series(self._write("kpi.jsonl", KPI))
        self.assertIsNone(got[-1]["rsrp_db"])
        self.assertIsNone(got[-1]["snr_db"])
        self.assertEqual(got[-1]["dl_mcs"], 0)

    def test_an_empty_file_is_an_empty_series(self):
        p = self.dir / "empty.jsonl"
        p.write_text("")
        self.assertEqual(rs._series(p), [])


class SummaryStatistics(unittest.TestCase):

    @staticmethod
    def _stat(vals):
        vals = [v for v in vals if v is not None]
        if not vals:
            return None
        return {"min": round(min(vals), 1), "max": round(max(vals), 1),
                "avg": round(sum(vals) / len(vals), 1), "n": len(vals)}

    def test_traced_gain_across_a_real_run(self):
        s = self._stat([r["gain_db"] for r in TELEMETRY])
        self.assertEqual(s, {"min": -108.5, "max": -91.6, "avg": -102.9, "n": 3})

    def test_nulls_are_excluded_not_counted_as_zero(self):
        s = self._stat([r["rsrp_db"] for r in KPI])
        self.assertEqual(s["n"], 2)
        self.assertEqual(s["min"], -34.8)
        self.assertEqual(s["max"], -33.7)

    def test_a_series_of_nothing_but_nulls_has_no_statistics(self):
        self.assertIsNone(self._stat([None, None, None]))

    def test_an_empty_series_has_no_statistics(self):
        self.assertIsNone(self._stat([]))

    def test_a_single_reading_is_its_own_min_max_and_average(self):
        self.assertEqual(self._stat([-91.6]),
                         {"min": -91.6, "max": -91.6, "avg": -91.6, "n": 1})


class RunDirectories(unittest.TestCase):
    def test_a_run_id_maps_to_one_directory_under_the_store(self):
        d = rs.run_dir("20260818-074247-e349ab")
        self.assertEqual(d.name, "20260818-074247-e349ab")
        self.assertEqual(d.parent, rs.RUNS_DIR)


if __name__ == "__main__":
    unittest.main()
