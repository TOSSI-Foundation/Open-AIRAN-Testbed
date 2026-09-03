import csv
import io
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app import dataset as ds


class Schema(unittest.TestCase):

    def test_every_column_declares_a_role(self):
        for c in ds.COLUMNS:
            self.assertIn(c["role"], ("key", "feature", "label", "excluded"), c["key"])
            self.assertTrue(c.get("why"), c["key"])

    def test_the_traced_side_is_the_feature_side(self):
        self.assertIn("gain_db", ds.FEATURE_KEYS)
        self.assertIn("paths", ds.FEATURE_KEYS)
        self.assertIn("dist_m", ds.FEATURE_KEYS)

    def test_applied_db_is_not_a_feature(self):
        self.assertIn("applied_db", ds.EXCLUDED_KEYS)
        self.assertNotIn("applied_db", ds.FEATURE_KEYS)
        why = next(c["why"] for c in ds.COLUMNS if c["key"] == "applied_db")
        self.assertIn("running order", why)

    def test_the_outer_loop_offset_is_a_label_not_a_feature(self):
        self.assertIn("dl_olla", ds.EXCLUDED_KEYS)
        self.assertNotIn("dl_olla", ds.FEATURE_KEYS)

    def test_the_uplink_columns_are_not_features(self):
        for k in ("rsrp_db", "snr_db"):
            self.assertIn(k, ds.EXCLUDED_KEYS)

    def test_nothing_measured_leaked_into_the_features(self):
        measured = {"ue_sinr_db", "ue_cqi", "dl_mcs", "dl_bler", "dl_ok", "dl_nok",
                    "dl_kbps", "dl_prbs", "dl_olla", "rsrp_db", "snr_db", "applied_db"}
        self.assertEqual(measured & set(ds.FEATURE_KEYS), set())

    def test_features_and_labels_do_not_overlap(self):
        self.assertEqual(set(ds.FEATURE_KEYS) & set(ds.LABEL_KEYS), set())

    def test_the_shipped_schema_says_what_to_train_on(self):
        s = ds.schema()
        self.assertEqual(set(s["features"]), set(ds.FEATURE_KEYS))
        self.assertIn("Train on", s["note"])


class Rows(unittest.TestCase):

    TX = [515.83, -20.0, 43.0]

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.run = Path(self._tmp.name)
        self.scene = self.run / "scene_dir"
        self.scene.mkdir()
        self.addCleanup(self._tmp.cleanup)
        (self.scene / "package.json").write_text(json.dumps({"manifest": {"nodes": [
            {"type": "gnb", "name": "gNB-n3", "enu_m": self.TX},
            {"type": "ue", "name": "UE-n4", "enu_m": [326.92, -10.14, 1.5]}]}}))

    def _write(self, name, rows):
        (self.run / name).write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def _run_meta(self, odu_built="2026-08-17T08:54:01"):
        return {"id": "20260819-064141-fda64d", "scene_id": "scene-1",
                "params": {"provenance": {
                    "scene": {"geometry_short": "c050670cc46f"},
                    "stack": {"binaries": {"odu": {"built": odu_built,
                                                   "sha256_short": "8e5290603758"}}}}}}

    def _good_run(self, n=30, lag=0):
        tel, kpi, ue = [], [], []
        anchor = None
        for i in range(n):
            t = 1000.0 + i * 3.0
            leg = abs(((i % 12) - 6) / 6.0)
            gain = -110.0 + 20.0 * (1.0 - leg)
            anchor = gain if anchor is None else max(anchor, gain)
            applied = min(max(0.0, anchor - gain), 35.0)
            tel.append({"t": t, "seq": i, "gain_db": round(gain, 1),
                        "applied_db": round(applied, 1), "paths": 2,
                        "pos": [329.0 - leg * 200.0, -10.0]})
            kpi.append({"t": t + lag, "ue": 0, "dl_mcs": 3 + (i % 5), "dl_bler": 0.0,
                        "dl_ok": 16, "dl_nok": 0, "dl_kbps": 6.84, "dl_prbs": 100,
                        "dl_olla": 0.007, "rsrp_db": -40.0, "snr_db": 44.0})
            for sub in range(3):
                ue.append({"t": t + sub + lag, "sinr": round(77.0 - applied), "cqi": 12})
        self._write("telemetry.jsonl", tel)
        self._write("kpi.jsonl", kpi)
        self._write("ue_kpi.jsonl", ue)

    def test_a_complete_run_produces_a_row_per_update(self):
        self._good_run()
        out = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)
        self.assertEqual(len(out["rows"]), 30)
        self.assertEqual(sum(out["dropped"].values()), 0)

    def test_every_row_carries_its_provenance(self):
        self._good_run()
        r = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)["rows"][0]
        self.assertEqual(r["run_id"], "20260819-064141-fda64d")
        self.assertEqual(r["geometry_sha"], "c050670cc46f")
        self.assertEqual(r["odu_sha"], "8e5290603758")

    def test_distance_is_computed_from_the_transmitter(self):
        import math
        self._good_run()
        rows = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)["rows"]
        for r in rows[:5]:
            expect = math.dist([r["pos_x"], r["pos_y"], 0.0], self.TX)
            self.assertAlmostEqual(r["dist_m"], round(expect, 2), places=2)

    def test_distance_moves_as_the_receiver_does(self):
        self._good_run()
        d = [r["dist_m"] for r in
             ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)["rows"]]
        self.assertGreater(max(d) - min(d), 50.0)
        self.assertGreater(len(set(d)), 5)

    def test_distance_is_absent_rather_than_wrong_without_a_scene(self):
        self._good_run()
        r = ds.build_rows(self.run, self._run_meta())["rows"][0]
        self.assertIsNone(r["dist_m"])

    def test_labels_come_from_both_the_cell_and_the_modem(self):
        self._good_run()
        r = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)["rows"][0]
        self.assertIsNotNone(r["dl_mcs"])
        self.assertIsNotNone(r["ue_sinr_db"])
        self.assertEqual(r["ue_cqi"], 12)

    def test_a_row_with_no_cell_reading_is_dropped_not_half_written(self):
        self._good_run(n=10)
        self._write("kpi.jsonl", [{"t": 1000.0, "ue": 0, "dl_mcs": 3}])
        out = ds.build_rows(self.run, self._run_meta(), tolerance_s=5, scene_dir=self.scene)
        self.assertGreater(out["dropped"]["no_cell_reading"], 0)
        for r in out["rows"]:
            self.assertIsNotNone(r["dl_mcs"])

    def test_a_row_with_no_modem_reading_is_dropped(self):
        self._good_run(n=10)
        (self.run / "ue_kpi.jsonl").write_text("")
        out = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)
        self.assertEqual(out["rows"], [])
        self.assertEqual(out["dropped"]["no_modem_reading"], 10)

    def test_an_update_without_a_position_is_dropped(self):
        self._good_run(n=5)
        tel = ds.cal.load_series(self.run / "telemetry.jsonl")
        tel[2].pop("pos")
        self._write("telemetry.jsonl", tel)
        out = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)
        self.assertEqual(out["dropped"]["no_position"], 1)
        self.assertEqual(len(out["rows"]), 4)

    def test_the_lag_is_estimated_and_recorded(self):
        self._good_run(lag=3)
        out = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)
        self.assertIn("estimated", out["lag_source"])
        self.assertLess(out["lag_s"], 0)
        self.assertGreaterEqual(out["lag_s"], -6)
        self.assertGreater(out["lag_r2"], 0.9)

    def test_a_caller_can_pin_the_lag(self):
        self._good_run()
        out = ds.build_rows(self.run, self._run_meta(), lag_s=-2, scene_dir=self.scene)
        self.assertEqual(out["lag_s"], -2.0)
        self.assertIn("given by the caller", out["lag_source"])

    def test_correcting_the_lag_changes_which_label_a_row_gets(self):
        self._good_run(n=20, lag=6)
        naive = ds.build_rows(self.run, self._run_meta(), lag_s=0, tolerance_s=20,
                              scene_dir=self.scene)["rows"]
        fixed = ds.build_rows(self.run, self._run_meta(), tolerance_s=20,
                              scene_dir=self.scene)["rows"]
        self.assertNotEqual([r["ue_sinr_db"] for r in naive],
                            [r["ue_sinr_db"] for r in fixed])

    def test_the_uplink_era_travels_with_the_dataset(self):
        self._good_run()
        old = ds.build_rows(self.run, self._run_meta("2026-08-08T08:24:02"),
                            scene_dir=self.scene)
        self.assertFalse(old["uplink"]["filtered"])

    def test_an_empty_run_does_not_raise(self):
        out = ds.build_rows(self.run, self._run_meta(), scene_dir=self.scene)
        self.assertEqual(out["rows"], [])


class Serialisation(unittest.TestCase):
    ROWS = [{k: 1 for k in ds.ALL_KEYS}, {k: None for k in ds.ALL_KEYS}]

    def test_csv_has_every_column_in_a_stable_order(self):
        text = ds.to_csv(self.ROWS)
        header = next(csv.reader(io.StringIO(text)))
        self.assertEqual(header, list(ds.ALL_KEYS))

    def test_csv_round_trips(self):
        rows = list(csv.DictReader(io.StringIO(ds.to_csv(self.ROWS))))
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["gain_db"], "1")

    def test_a_row_missing_a_key_still_writes(self):
        text = ds.to_csv([{"gain_db": -100.0}])
        rows = list(csv.DictReader(io.StringIO(text)))
        self.assertEqual(rows[0]["gain_db"], "-100.0")
        self.assertEqual(rows[0]["dl_mcs"], "")

    def test_jsonl_is_one_object_per_line_with_every_column(self):
        lines = ds.to_jsonl(self.ROWS).strip().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(set(json.loads(lines[0])), set(ds.ALL_KEYS))


class Coverage(unittest.TestCase):

    def test_a_constant_column_is_visible_as_constant(self):
        rows = [{"gain_db": -100.0, "dl_mcs": 3} for _ in range(20)]
        cov = ds.coverage(rows)
        self.assertEqual(cov["dl_mcs"]["distinct"], 1)
        self.assertEqual(cov["dl_mcs"]["span"], 0)

    def test_a_varying_column_reports_its_span(self):
        rows = [{"gain_db": -110.0 + i} for i in range(21)]
        cov = ds.coverage(rows)
        self.assertEqual(cov["gain_db"]["distinct"], 21)
        self.assertEqual(cov["gain_db"]["span"], 20.0)

    def test_absence_is_counted_not_averaged_over(self):
        rows = [{"gain_db": -100.0, "ue_cqi": None} for _ in range(10)]
        cov = ds.coverage(rows)
        self.assertEqual(cov["ue_cqi"]["present"], 0)
        self.assertEqual(cov["ue_cqi"]["of"], 10)
        self.assertNotIn("min", cov["ue_cqi"])


if __name__ == "__main__":
    unittest.main()


class Tolerances(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.run = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, rows):
        (self.run / name).write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def _run(self):
        tel, kpi, ue = [], [], []
        for i in range(20):
            t = 1000.0 + i * 3.0
            tel.append({"t": t, "seq": i, "gain_db": -110.0 + i, "applied_db": float(i),
                        "paths": 2, "pos": [329.0 - i * 4.0, -10.0]})
            for sub in range(3):
                ue.append({"t": t + sub, "sinr": 77.0 - i, "cqi": 12})
        for j in range(4):
            kpi.append({"t": 1000.0 + j * 16.6, "ue": 0, "dl_mcs": 3, "dl_bler": 0.0,
                        "dl_ok": 16, "dl_nok": 0, "dl_kbps": 6.8, "dl_prbs": 100,
                        "dl_olla": 0.0, "rsrp_db": -40.0, "snr_db": 44.0})
        self._write("telemetry.jsonl", tel)
        self._write("kpi.jsonl", kpi)
        self._write("ue_kpi.jsonl", ue)

    def test_the_modem_window_is_tighter_than_the_cell_window(self):
        self.assertLess(ds.UE_TOLERANCE_S, ds.cal.DEFAULT_TOLERANCE_S)

    def test_the_modem_reading_paired_is_a_near_one(self):
        self._run()
        out = ds.build_rows(self.run, {"id": "r"}, lag_s=0)
        self.assertTrue(out["rows"])
        for r in out["rows"]:
            expected = 77.0 - (r["seq"])
            self.assertAlmostEqual(r["ue_sinr_db"], expected, delta=1.0)

    def test_a_loose_modem_window_pairs_across_a_gap(self):
        self._run()
        ue = [s for s in ds.cal.load_series(self.run / "ue_kpi.jsonl")
              if not (1015.0 <= s["t"] <= 1042.0)]
        self._write("ue_kpi.jsonl", ue)

        tight = ds.build_rows(self.run, {"id": "r"}, lag_s=0)["rows"]
        loose = ds.build_rows(self.run, {"id": "r"}, lag_s=0, ue_tolerance_s=30.0)["rows"]

        self.assertGreater(len(loose), len(tight))

        def worst(rows):
            return max(abs(r["ue_sinr_db"] - (77.0 - r["seq"])) for r in rows)

        self.assertLessEqual(worst(tight), 2.0)
        self.assertGreaterEqual(worst(loose), 4.0)
        self.assertGreaterEqual(worst(loose), worst(tight) * 2)

    def test_both_windows_are_recorded_with_the_data(self):
        self._run()
        out = ds.build_rows(self.run, {"id": "r"}, lag_s=0)
        self.assertEqual(out["ue_tolerance_s"], ds.UE_TOLERANCE_S)
        self.assertEqual(out["tolerance_s"], ds.cal.DEFAULT_TOLERANCE_S)


class SpanReporting(unittest.TestCase):

    def test_a_tiny_but_real_span_is_not_reported_as_zero(self):
        rows = [{"rms_delay_spread_s": 1.92e-10 + i * 3e-11} for i in range(23)]
        cov = ds.coverage(rows)
        self.assertEqual(cov["rms_delay_spread_s"]["distinct"], 23)
        self.assertGreater(cov["rms_delay_spread_s"]["span"], 0.0)

    def test_a_microsecond_scale_span_survives(self):
        rows = [{"first_arrival_s": 6.4e-7 + i * 1e-7} for i in range(20)]
        self.assertGreater(ds.coverage(rows)["first_arrival_s"]["span"], 1e-6)

    def test_an_ordinary_span_is_unchanged(self):
        rows = [{"gain_db": -110.0 + i} for i in range(21)]
        self.assertEqual(ds.coverage(rows)["gain_db"]["span"], 20.0)

    def test_a_genuinely_constant_column_still_reads_zero(self):
        rows = [{"gain_db": -100.0} for _ in range(10)]
        self.assertEqual(ds.coverage(rows)["gain_db"]["span"], 0.0)
