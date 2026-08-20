import json
import math
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from tempfile import TemporaryDirectory

from app import calibration as cal


class UeSinrSampling(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _log(self, text):
        p = self.dir / "ue1_nue.log"
        p.write_text(text)
        return p

    def test_a_real_line_with_its_ansi_codes(self):
        p = self._log("\x1b[0m[NR_PHY] RI = 1 i1 = 0.0.0, i2 = 0, SINR = 77 dB, CQI = 15\n")
        out = cal.ue_sinr_sample(p)
        self.assertEqual(out["sinr"], 77.0)
        self.assertEqual(out["cqi"], 15)

    def test_the_latest_value_wins(self):
        p = self._log("SINR = 70 dB, CQI = 9\nSINR = 41 dB, CQI = 5\nSINR = 12 dB, CQI = 2\n")
        self.assertEqual(cal.ue_sinr_sample(p)["sinr"], 12.0)
        self.assertEqual(cal.ue_sinr_sample(p)["in_tail"], 3)

    def test_negative_and_fractional(self):
        p = self._log("SINR = -3.5 dB, CQI = 1\n")
        self.assertEqual(cal.ue_sinr_sample(p)["sinr"], -3.5)

    def test_a_reading_with_no_cqi(self):
        p = self._log("SINR = 20 dB\n")
        self.assertEqual(cal.ue_sinr_sample(p), {"sinr": 20.0, "cqi": None, "in_tail": 1})

    def test_nothing_reported_yet_is_none_not_zero(self):
        p = self._log("[UTIL] running in SA mode\n[NR_RRC] SIB1 decoded\n")
        self.assertIsNone(cal.ue_sinr_sample(p))

    def test_a_missing_log_is_none(self):
        self.assertIsNone(cal.ue_sinr_sample(self.dir / "absent.log"))

    def test_only_the_tail_of_a_long_log_is_read(self):
        p = self._log("SINR = 1 dB, CQI = 1\n" + ("filler line\n" * 40000)
                      + "SINR = 55 dB, CQI = 12\n")
        out = cal.ue_sinr_sample(p, tail_bytes=4096)
        self.assertEqual(out["sinr"], 55.0)
        self.assertEqual(out["in_tail"], 1)


class Timestamps(unittest.TestCase):
    def test_epoch_passes_through(self):
        self.assertEqual(cal.to_epoch(1787038981.475), 1787038981.475)

    def test_the_iso_form_the_du_writes(self):
        self.assertIsInstance(cal.to_epoch("2026-08-18T07:08:28.603921"), float)

    def test_unusable_values(self):
        for v in (None, "", "yesterday", {}):
            self.assertIsNone(cal.to_epoch(v))

    def test_a_half_written_line_costs_only_itself(self):
        with TemporaryDirectory() as t:
            p = Path(t) / "s.jsonl"
            p.write_text('{"t": 1, "gain_db": -100}\n{"t": 2, "gain_db":\n')
            self.assertEqual(len(cal.load_series(p)), 1)


class Alignment(unittest.TestCase):

    @staticmethod
    def _tel(points):
        return [{"t": t, "gain_db": g} for t, g in points]

    @staticmethod
    def _kpi(points):
        return [{"t": t, "dl_olla": v} for t, v in points]

    def test_each_left_sample_takes_the_nearest_right_one(self):
        left = self._tel([(100.0, -90.0), (110.0, -95.0)])
        right = self._kpi([(99.0, 1.0), (112.0, 2.0)])
        out = cal.align_nearest(left, right, left_key="gain_db", right_key="dl_olla",
                                tolerance_s=5)
        self.assertEqual([(p["x"], p["y"]) for p in out], [(-90.0, 1.0), (-95.0, 2.0)])

    def test_a_sample_with_nothing_near_enough_is_dropped(self):
        left = self._tel([(100.0, -90.0), (500.0, -70.0)])
        right = self._kpi([(101.0, 1.0)])
        out = cal.align_nearest(left, right, left_key="gain_db", right_key="dl_olla",
                                tolerance_s=20)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["x"], -90.0)

    def test_the_tolerance_is_honoured_exactly(self):
        left = self._tel([(100.0, -90.0)])
        right = self._kpi([(120.0, 1.0)])
        self.assertEqual(len(cal.align_nearest(left, right, left_key="gain_db",
                                               right_key="dl_olla", tolerance_s=20)), 1)
        self.assertEqual(len(cal.align_nearest(left, right, left_key="gain_db",
                                               right_key="dl_olla", tolerance_s=19)), 0)

    def test_it_matches_backwards_as_well_as_forwards(self):
        left = self._tel([(100.0, -90.0)])
        right = self._kpi([(95.0, 7.0), (130.0, 9.0)])
        out = cal.align_nearest(left, right, left_key="gain_db", right_key="dl_olla",
                                tolerance_s=20)
        self.assertEqual(out[0]["y"], 7.0)

    def test_nulls_on_either_side_are_skipped(self):
        left = self._tel([(100.0, -90.0)]) + [{"t": 101.0, "gain_db": None}]
        right = self._kpi([(100.0, 1.0)]) + [{"t": 101.0, "dl_olla": None}]
        out = cal.align_nearest(left, right, left_key="gain_db", right_key="dl_olla",
                                tolerance_s=5)
        self.assertEqual(len(out), 1)

    def test_an_empty_side_produces_nothing(self):
        self.assertEqual(cal.align_nearest([], [], left_key="a", right_key="b"), [])
        self.assertEqual(
            cal.align_nearest(self._tel([(1.0, -1.0)]), [], left_key="gain_db",
                              right_key="dl_olla"), [])

    def test_the_two_clock_forms_join(self):
        from datetime import datetime
        iso = "2026-08-18T07:08:28"
        epoch = datetime.fromisoformat(iso).timestamp()
        out = cal.align_nearest([{"t": epoch, "gain_db": -90.0}],
                                [{"t": iso, "dl_olla": 3.0}],
                                left_key="gain_db", right_key="dl_olla", tolerance_s=1)
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["y"], 3.0)


class Fit(unittest.TestCase):

    @staticmethod
    def _pairs(xy):
        return [{"x": x, "y": y} for x, y in xy]

    def test_a_line_recovers_its_own_slope(self):
        f = cal.linear_fit(self._pairs([(x, 3.0 * x + 5.0) for x in range(10)]))
        self.assertAlmostEqual(f["slope"], 3.0, places=9)
        self.assertAlmostEqual(f["intercept"], 5.0, places=9)
        self.assertAlmostEqual(f["r2"], 1.0, places=9)
        self.assertAlmostEqual(f["residual_std"], 0.0, places=9)
        self.assertTrue(f["usable"])

    def test_a_negative_slope(self):
        f = cal.linear_fit(self._pairs([(x, -2.0 * x) for x in range(8)]))
        self.assertAlmostEqual(f["slope"], -2.0, places=9)

    def test_scatter_lowers_r2_without_moving_the_slope_much(self):
        pts = [(x, 2.0 * x + (1.0 if x % 2 else -1.0)) for x in range(20)]
        f = cal.linear_fit(self._pairs(pts))
        self.assertAlmostEqual(f["slope"], 2.0, delta=0.05)
        self.assertLess(f["r2"], 1.0)
        self.assertGreater(f["r2"], 0.9)
        self.assertGreater(f["residual_std"], 0.5)

    def test_pure_noise_gives_no_correlation(self):
        import random
        rng = random.Random(11)
        pts = [(float(x), rng.gauss(0.0, 1.0)) for x in range(200)]
        f = cal.linear_fit(self._pairs(pts))
        self.assertLess(abs(f["r2"]), 0.05)

    def test_a_static_run_is_refused_rather_than_fitted(self):
        f = cal.linear_fit(self._pairs([(-100.0, y) for y in range(10)]))
        self.assertIsNone(f["slope"])
        self.assertFalse(f["usable"])
        self.assertIn("does not vary", f["why"])

    def test_too_few_points_is_not_usable(self):
        f = cal.linear_fit(self._pairs([(1.0, 1.0), (2.0, 2.0), (3.0, 3.0)]))
        self.assertIsNotNone(f["slope"])
        self.assertFalse(f["usable"])
        self.assertLess(f["n"], cal.MIN_POINTS)

    def test_nothing_at_all(self):
        f = cal.linear_fit([])
        self.assertEqual(f["n"], 0)
        self.assertFalse(f["usable"])

    def test_the_spans_are_reported(self):
        f = cal.linear_fit(self._pairs([(0.0, 10.0), (30.0, 40.0), (10.0, 20.0)]))
        self.assertEqual(f["x_span"], 30.0)
        self.assertEqual(f["y_span"], 30.0)


class UplinkEra(unittest.TestCase):

    def test_a_recorded_binary_is_used_when_present(self):
        run = {"params": {"provenance": {"stack": {"binaries": {
            "odu": {"built": "2026-08-17T08:54:01", "sha256_short": "8e5290603758"}}}}}}
        out = cal.uplink_is_filtered(run)
        self.assertTrue(out["filtered"])
        self.assertEqual(out["source"], "recorded")
        self.assertEqual(out["odu_sha"], "8e5290603758")

    def test_an_older_binary_had_a_clean_uplink(self):
        run = {"params": {"provenance": {"stack": {"binaries": {
            "odu": {"built": "2026-08-08T08:24:02"}}}}}}
        self.assertFalse(cal.uplink_is_filtered(run)["filtered"])

    def test_a_run_without_provenance_falls_back_to_when_it_started(self):
        import datetime as dt
        old = dt.datetime(2026, 8, 12, 10, 0, 0).timestamp()
        out = cal.uplink_is_filtered({"started": old})
        self.assertFalse(out["filtered"])
        self.assertIn("inferred", out["source"])

    def test_nothing_to_go_on(self):
        self.assertIsNone(cal.uplink_is_filtered({})["filtered"])


class Report(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.run = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, rows):
        (self.run / name).write_text("\n".join(json.dumps(r) for r in rows) + "\n")

    def _moving_run(self):
        tel, kpi, ue = [], [], []
        for i in range(30):
            t = 1000.0 + i * 3.0
            gain = -110.0 + i
            tel.append({"t": t, "seq": i, "gain_db": gain, "applied_db": 0.0, "paths": 2})
            kpi.append({"t": t + 0.4, "ue": 0, "dl_olla": 0.5 * gain + 60.0,
                        "dl_mcs": 3, "dl_bler": 0.0, "rsrp_db": -40.0, "snr_db": 44.0})
            ue.append({"t": t + 0.2, "sinr": gain + 150.0, "cqi": 12})
        self._write("telemetry.jsonl", tel)
        self._write("kpi.jsonl", kpi)
        self._write("ue_kpi.jsonl", ue)

    def test_a_moving_run_produces_a_usable_downlink_fit(self):
        self._moving_run()
        rep = cal.calibrate(self.run, {"started": 1787000000.0})
        dl = next(c for c in rep["comparisons"] if c["key"] == "sinr")
        self.assertTrue(dl["fit"]["usable"])
        self.assertAlmostEqual(dl["fit"]["slope"], 1.0, places=6)
        self.assertAlmostEqual(dl["fit"]["r2"], 1.0, places=6)
        self.assertEqual(dl["role"], "correlated")

    def test_the_traced_span_is_reported(self):
        self._moving_run()
        self.assertAlmostEqual(cal.calibrate(self.run)["traced_span_db"], 29.0, places=6)

    def test_a_static_run_is_called_out_rather_than_fitted(self):
        tel = [{"t": 1000.0 + i, "gain_db": -100.0} for i in range(20)]
        kpi = [{"t": 1000.0 + i, "dl_olla": 0.01 * i} for i in range(20)]
        self._write("telemetry.jsonl", tel)
        self._write("kpi.jsonl", kpi)
        rep = cal.calibrate(self.run)
        self.assertLess(rep["traced_span_db"], 1.0)
        self.assertTrue(any("barely varies" in n for n in rep["notes"]))
        olla = next(c for c in rep["comparisons"] if c["key"] == "dl_olla")
        self.assertFalse(olla["fit"]["usable"])

    def test_a_missing_downlink_series_is_explained(self):
        tel = [{"t": 1000.0 + i, "gain_db": -100.0 + i} for i in range(20)]
        self._write("telemetry.jsonl", tel)
        rep = cal.calibrate(self.run)
        self.assertEqual(rep["ue_kpi_samples"], 0)
        self.assertTrue(any("no timestamps" in n for n in rep["notes"]))
        dl = next(c for c in rep["comparisons"] if c["key"] == "sinr")
        self.assertFalse(dl["available"])

    def test_the_uplink_is_a_control_on_an_older_build(self):
        self._moving_run()
        run = {"params": {"provenance": {"stack": {"binaries": {
            "odu": {"built": "2026-08-08T08:24:02"}}}}}}
        rep = cal.calibrate(self.run, run)
        for key in ("rsrp_db", "snr_db"):
            c = next(x for x in rep["comparisons"] if x["key"] == key)
            self.assertEqual(c["role"], "control")

    def test_the_uplink_is_evidence_on_a_filtering_build(self):
        self._moving_run()
        run = {"params": {"provenance": {"stack": {"binaries": {
            "odu": {"built": "2026-08-17T08:54:01"}}}}}}
        rep = cal.calibrate(self.run, run)
        c = next(x for x in rep["comparisons"] if x["key"] == "rsrp_db")
        self.assertEqual(c["role"], "correlated")

    def test_an_empty_run_directory_does_not_raise(self):
        rep = cal.calibrate(self.run)
        self.assertEqual(rep["telemetry_samples"], 0)
        self.assertTrue(all(not c["fit"]["usable"] for c in rep["comparisons"]))


class Scatter(unittest.TestCase):

    PAIRS = [{"x": float(i), "y": 2.0 * i + 1.0} for i in range(12)]

    def test_it_parses_as_xml(self):
        fit = cal.linear_fit(self.PAIRS)
        svg = cal.svg_scatter(self.PAIRS, fit, x_label="traced gain (dB)", y_label="SINR (dB)")
        root = ET.fromstring(svg)
        self.assertTrue(root.tag.endswith("svg"))

    def test_every_point_is_drawn(self):
        fit = cal.linear_fit(self.PAIRS)
        svg = cal.svg_scatter(self.PAIRS, fit, x_label="x", y_label="y")
        root = ET.fromstring(svg)
        circles = [e for e in root.iter() if e.tag.endswith("circle")]
        self.assertEqual(len(circles), len(self.PAIRS))

    def test_the_labels_appear(self):
        fit = cal.linear_fit(self.PAIRS)
        svg = cal.svg_scatter(self.PAIRS, fit, x_label="traced gain (dB)", y_label="SINR (dB)")
        self.assertIn("traced gain (dB)", svg)
        self.assertIn("SINR (dB)", svg)

    def test_nothing_matched_says_so_instead_of_drawing_axes(self):
        svg = cal.svg_scatter([], cal.linear_fit([]), x_label="x", y_label="y")
        ET.fromstring(svg)
        self.assertIn("no matched samples", svg)

    def test_a_single_point_does_not_divide_by_zero(self):
        pairs = [{"x": 5.0, "y": 7.0}]
        svg = cal.svg_scatter(pairs, cal.linear_fit(pairs), x_label="x", y_label="y")
        ET.fromstring(svg)

    def test_points_all_at_one_value_do_not_divide_by_zero(self):
        pairs = [{"x": 5.0, "y": 7.0} for _ in range(5)]
        svg = cal.svg_scatter(pairs, cal.linear_fit(pairs), x_label="x", y_label="y")
        ET.fromstring(svg)


if __name__ == "__main__":
    unittest.main()


class ClippedApplication(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.run = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _telemetry(self, rows):
        (self.run / "telemetry.jsonl").write_text(
            "\n".join(json.dumps(r) for r in rows) + "\n")

    def test_clipping_is_detected_and_named(self):
        self._telemetry([{"t": 1000.0 + i, "gain_db": -111.0 + i * 0.7,
                          "applied_db": min(10.0, i * 0.34)} for i in range(30)])
        rep = cal.calibrate(self.run)
        self.assertTrue(rep["applied_clipped"])
        self.assertAlmostEqual(rep["applied_span_db"], 10.0, delta=0.5)
        self.assertTrue(any("clipped by max_drop_db" in n for n in rep["notes"]))

    def test_an_unclipped_run_is_not_flagged(self):
        self._telemetry([{"t": 1000.0 + i, "gain_db": -110.0 + i,
                          "applied_db": float(i)} for i in range(30)])
        rep = cal.calibrate(self.run)
        self.assertFalse(rep["applied_clipped"])
        self.assertFalse(any("clipped" in n for n in rep["notes"]))

    def test_almost_no_applied_loss_is_called_out(self):
        self._telemetry([{"t": 1000.0 + i, "gain_db": -110.0 + i,
                          "applied_db": 0.0 if i < 20 else 1.3} for i in range(30)])
        rep = cal.calibrate(self.run)
        self.assertTrue(any("unlikely to move a modem" in n for n in rep["notes"]))

    def test_telemetry_without_an_applied_column(self):
        self._telemetry([{"t": 1000.0 + i, "gain_db": -110.0 + i} for i in range(10)])
        rep = cal.calibrate(self.run)
        self.assertIsNone(rep["applied_span_db"])
        self.assertFalse(rep["applied_clipped"])


class Independence(unittest.TestCase):

    @staticmethod
    def _pairs(xy):
        return [{"x": x, "y": y} for x, y in xy]

    def test_distinct_counts_are_reported(self):
        f = cal.linear_fit(self._pairs([(1.0, 5.0), (2.0, 5.0), (3.0, 7.0), (4.0, 9.0)]))
        self.assertEqual(f["distinct_x"], 4)
        self.assertEqual(f["distinct_y"], 3)

    def test_a_fit_standing_on_two_readings_is_not_usable(self):
        pts = [(float(i), 5.0 if i < 30 else 9.0) for i in range(60)]
        f = cal.linear_fit(self._pairs(pts))
        self.assertEqual(f["n"], 60)
        self.assertEqual(f["distinct_y"], 2)
        self.assertFalse(f["usable"])

    def test_enough_distinct_readings_is_usable(self):
        f = cal.linear_fit(self._pairs([(float(i), float(i % 5)) for i in range(30)]))
        self.assertGreaterEqual(f["distinct_y"], 3)
        self.assertTrue(f["usable"])


class Lag(unittest.TestCase):

    @staticmethod
    def _delayed(shift_s, n=80, noise=0.0):
        import random
        rng = random.Random(4)
        tel, meas = [], []
        for i in range(n):
            t = 1000.0 + i
            applied = 10.0 + 8.0 * math.sin(i / 9.0)
            tel.append({"t": t, "applied_db": applied})
            meas.append({"t": t + shift_s,
                         "sinr": 70.0 - applied + (rng.gauss(0, noise) if noise else 0.0)})
        return tel, meas

    def test_a_known_delay_is_recovered(self):
        tel, meas = self._delayed(3)
        out = cal.estimate_lag(tel, meas, left_key="applied_db", right_key="sinr")
        self.assertEqual(out["best"]["shift_s"], -3)

    def test_the_recovered_slope_is_the_real_one(self):
        tel, meas = self._delayed(2)
        out = cal.estimate_lag(tel, meas, left_key="applied_db", right_key="sinr")
        self.assertAlmostEqual(out["best"]["slope"], -1.0, delta=0.05)
        self.assertGreater(out["best"]["r2"], 0.95)

    def test_no_delay_is_found_when_there_is_none(self):
        tel, meas = self._delayed(0)
        self.assertEqual(cal.estimate_lag(tel, meas, left_key="applied_db",
                                          right_key="sinr")["best"]["shift_s"], 0)

    def test_the_whole_curve_comes_back(self):
        tel, meas = self._delayed(2)
        out = cal.estimate_lag(tel, meas, left_key="applied_db", right_key="sinr")
        shifts = [r["shift_s"] for r in out["curve"]]
        self.assertIn(-2, shifts)
        self.assertGreater(len(out["curve"]), 10)

    def test_ignoring_a_lag_understates_the_relationship(self):
        tel, meas = [], []
        for i in range(80):
            t = 1000.0 + i
            applied = 20.0 if (i // 3) % 2 else 0.0
            tel.append({"t": t, "applied_db": applied})
            meas.append({"t": t + 3, "sinr": 70.0 - applied})
        naive = cal.linear_fit(cal.align_nearest(tel, meas, left_key="applied_db",
                                                 right_key="sinr", tolerance_s=6))
        best = cal.estimate_lag(tel, meas, left_key="applied_db", right_key="sinr")["best"]

        self.assertAlmostEqual(best["slope"], -1.0, delta=0.05)

        self.assertGreater(abs(naive["slope"] - (-1.0)), 0.5)

    def test_noise_does_not_invent_a_lag(self):
        tel, meas = self._delayed(0, noise=0.4)
        out = cal.estimate_lag(tel, meas, left_key="applied_db", right_key="sinr")
        self.assertIn(out["best"]["shift_s"], (-1, 0, 1))

    def test_nothing_to_correlate(self):
        out = cal.estimate_lag([], [], left_key="applied_db", right_key="sinr")
        self.assertIsNone(out["best"])
        self.assertEqual(out["curve"], [])


class OneVotePerMeasurement(unittest.TestCase):

    def _dense(self, n, start=1000.0):
        return [{"t": start + i * 0.1, "gain_db": -80.0 - i * 0.01} for i in range(n)]

    def test_each_measurement_is_used_once(self):
        tel = self._dense(200)
        meas = [{"t": 1000.0 + i * 5.0, "sinr": 60.0 + i} for i in range(4)]
        dense = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                  tolerance_s=3.0)
        once = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                 tolerance_s=3.0, unique_right=True)
        self.assertGreater(len(dense), len(meas))
        self.assertEqual(len(once), len(meas))
        self.assertEqual(len(once), len({p["y"] for p in once}))

    def test_it_keeps_the_closest_traced_sample(self):
        tel = [{"t": 1000.0, "gain_db": -70.0},
               {"t": 1001.9, "gain_db": -75.0},
               {"t": 1004.0, "gain_db": -80.0}]
        meas = [{"t": 1002.0, "sinr": 55.0}]
        got = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                tolerance_s=3.0, unique_right=True)
        self.assertEqual(len(got), 1)
        self.assertAlmostEqual(got[0]["x"], -75.0)

    def test_unmatched_are_still_dropped_not_stretched(self):
        tel = [{"t": 1000.0, "gain_db": -70.0}]
        meas = [{"t": 1099.0, "sinr": 55.0}]
        self.assertEqual(cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                           tolerance_s=3.0, unique_right=True), [])

    def test_the_default_is_unchanged(self):
        tel = self._dense(50)
        meas = [{"t": 1000.0, "sinr": 60.0}]
        got = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                tolerance_s=99.0)
        self.assertEqual(len(got), 50)

    def test_no_bookkeeping_leaks_into_the_pairs(self):
        tel = self._dense(20)
        meas = [{"t": 1000.5, "sinr": 60.0}]
        for p in cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                   tolerance_s=9.0, unique_right=True):
            self.assertEqual(set(p), {"t", "x", "y", "dt"})


class PlottedFitMatchesPlottedPoints(unittest.TestCase):

    def _lagged(self, shift=3, n=80):
        tel, meas = [], []
        for i in range(n):
            t = 1000.0 + i
            applied = 20.0 if (i // 7) % 2 else 0.0
            tel.append({"t": t, "gain_db": -80.0 - applied})
            meas.append({"t": t + shift, "sinr": 70.0 - applied})
        return tel, meas

    def test_the_pair_that_is_returned_has_a_fit_that_describes_it(self):
        tel, meas = self._lagged()
        pairs = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                  tolerance_s=6, unique_right=True)
        fit = cal.linear_fit(pairs)
        xs = [p["x"] for p in pairs]
        ys = [p["y"] for p in pairs]
        my = sum(ys) / len(ys)
        syy = sum((y - my) ** 2 for y in ys)
        ss = sum((y - (fit["slope"] * x + fit["intercept"])) ** 2 for x, y in zip(xs, ys))
        self.assertAlmostEqual(1 - ss / syy, fit["r2"], places=9)

    def test_svg_scatter_accepts_the_aligned_fit(self):
        tel, meas = self._lagged()
        pairs = cal.align_nearest(tel, meas, left_key="gain_db", right_key="sinr",
                                  tolerance_s=6, unique_right=True)
        svg = cal.svg_scatter(pairs, cal.linear_fit(pairs), x_label="x", y_label="y")
        self.assertTrue(svg.lstrip().startswith("<svg"))
        self.assertNotIn("<script", svg)


class PairsFitDescribesPairs(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.run = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def _write(self, name, rows):
        sep = chr(10)
        (self.run / name).write_text(sep.join(json.dumps(r) for r in rows) + sep)

    def _run(self, measurement_lag_s):
        tel, kpi, ue = [], [], []
        for i in range(60):
            t = 1000.0 + i
            gain = -110.0 + (i % 12) * 2.5
            tel.append({"t": t, "seq": i, "gain_db": gain, "applied_db": 0.0, "paths": 2})
            kpi.append({"t": t + measurement_lag_s, "ue": 0, "dl_olla": 0.5 * gain + 60.0,
                        "dl_mcs": 3, "dl_bler": 0.0, "rsrp_db": -40.0, "snr_db": 44.0})
            ue.append({"t": t + measurement_lag_s, "sinr": gain + 150.0, "cqi": 12})
        self._write("telemetry.jsonl", tel)
        self._write("kpi.jsonl", kpi)
        self._write("ue_kpi.jsonl", ue)
        return cal.calibrate(self.run, {"started": 1787000000.0})

    def _r2_of(self, pairs, fit):
        ys = [p["y"] for p in pairs]
        my = sum(ys) / len(ys)
        syy = sum((y - my) ** 2 for y in ys)
        ss = sum((p["y"] - (fit["slope"] * p["x"] + fit["intercept"])) ** 2 for p in pairs)
        return 1 - ss / syy

    def _check(self, rep):
        seen = 0
        for c in rep["comparisons"]:
            pairs, pf = c.get("pairs") or [], c.get("pairs_fit")
            self.assertIsNotNone(pf, c["label"])
            self.assertEqual(pf.get("n"), len(pairs), c["label"])
            if pf.get("slope") is None or len(pairs) < 3:
                continue
            ys = {p["y"] for p in pairs}
            if len(ys) < 2:
                continue
            self.assertAlmostEqual(self._r2_of(pairs, pf), pf["r2"], places=9,
                                   msg=c["label"])
            seen += 1
        return seen

    def test_it_holds_when_a_lag_is_found(self):
        rep = self._run(measurement_lag_s=3.0)
        self.assertGreater(self._check(rep), 0)
        self.assertTrue(any(c["pairs_are_lag_corrected"] for c in rep["comparisons"]))

    def test_it_holds_when_no_lag_is_found(self):
        rep = self._run(measurement_lag_s=0.0)
        self.assertGreater(self._check(rep), 0)

    def test_pairs_fit_is_the_aligned_one_whenever_pairs_are(self):
        for c in self._run(measurement_lag_s=3.0)["comparisons"]:
            if c["pairs_are_lag_corrected"]:
                self.assertIs(c["pairs_fit"], c["aligned_fit"], c["label"])
            else:
                self.assertIs(c["pairs_fit"], c["fit"], c["label"])
