import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from app import report as rp


def fit(**kw):
    base = {"n": 99, "slope": 0.96, "intercept": 130.0, "r2": 0.944,
            "distinct_x": 23, "x_span": 20.1, "y_span": 20.0, "usable": True}
    base.update(kw)
    return base


class Verdicts(unittest.TestCase):

    def test_a_strong_fit_says_so(self):
        v = rp.fit_verdict(fit())
        self.assertEqual(v["verdict"], "strong")
        self.assertTrue(v["usable"])
        self.assertIn("predicts the measurement", v["claim"])

    def test_a_weak_fit_is_not_dressed_up(self):
        v = rp.fit_verdict(fit(r2=0.25))
        self.assertEqual(v["verdict"], "weak")
        self.assertIn("does not explain", v["claim"])

    def test_a_middling_fit_is_neither(self):
        v = rp.fit_verdict(fit(r2=0.62))
        self.assertEqual(v["verdict"], "partial")
        self.assertIn("something else", v["claim"])

    def test_too_few_points_is_not_a_result_however_good_the_r2(self):
        v = rp.fit_verdict(fit(n=6, r2=0.99, distinct_x=4))
        self.assertEqual(v["verdict"], "insufficient")
        self.assertFalse(v["usable"])
        self.assertTrue(v["claim"].startswith("Not enough here"))
        self.assertIn("6 paired samples", v["claim"])
        self.assertNotIn("0.99", v["claim"])

    def test_a_fit_over_few_distinct_positions_is_fitting_those_positions(self):
        v = rp.fit_verdict(fit(distinct_x=3))
        self.assertEqual(v["verdict"], "insufficient")
        self.assertIn("distinct", v["claim"])

    def test_no_dynamic_range_means_the_slope_means_nothing(self):
        v = rp.fit_verdict(fit(x_span=1.2))
        self.assertEqual(v["verdict"], "insufficient")
        self.assertIn("too little", v["claim"])

    def test_a_slope_far_from_one_is_agreement_in_shape_not_in_value(self):
        v = rp.fit_verdict(fit(slope=0.45))
        self.assertEqual(v["verdict"], "strong")
        self.assertTrue(v["slope_off_scale"])
        self.assertIn("not 1", v["claim"])

    def test_a_slope_near_one_carries_no_such_warning(self):
        v = rp.fit_verdict(fit(slope=0.96))
        self.assertFalse(v["slope_off_scale"])
        self.assertNotIn("not 1", v["claim"])

    def test_no_fit_at_all(self):
        for bad in (None, {}, {"n": None}):
            v = rp.fit_verdict(bad)
            self.assertFalse(v["usable"])
            self.assertEqual(v["verdict"], "none")


class AbsentIsNotZero(unittest.TestCase):

    def test_a_missing_number_renders_as_a_dash(self):
        self.assertEqual(rp._fmt(None), "—")

    def test_zero_renders_as_zero(self):
        self.assertEqual(rp._fmt(0.0), "0.0")
        self.assertNotEqual(rp._fmt(0.0), rp._fmt(None))

    def test_a_section_is_present_with_numbers_or_absent_with_a_reason(self):
        absent = rp._section("X", available=False, why="nothing was recorded")
        self.assertFalse(absent["available"])
        self.assertEqual(absent["why"], "nothing was recorded")
        self.assertNotIn("value", absent)

    def test_an_absent_section_always_has_a_reason_even_if_none_was_given(self):
        self.assertTrue(rp._section("X", available=False)["why"])

    def test_a_channel_with_no_updates_is_absent_not_zero(self):
        with TemporaryDirectory() as tmp:
            sec = rp._channel({"telemetry_samples": 0}, Path(tmp))
        self.assertFalse(sec["available"])
        self.assertNotIn("updates", sec)

    def test_a_run_still_recording_reports_the_channel_it_has(self):
        with TemporaryDirectory() as tmp:
            d = Path(tmp)
            with (d / "telemetry.jsonl").open("w") as f:
                for i in range(5):
                    f.write(json.dumps({"t": 1000.0 + i, "gain_db": -100.0 - i,
                                        "paths": 2}) + "\n")
            sec = rp._channel({}, d)
        self.assertTrue(sec["available"])
        self.assertEqual(sec["updates"], 5)
        self.assertTrue(sec["from_live_file"])
        self.assertIn("-104.0", sec["gain"])

    def test_a_finished_run_prefers_its_summary(self):
        with TemporaryDirectory() as tmp:
            sec = rp._channel({"telemetry_samples": 138,
                               "gain_db": {"min": -110.4, "max": -90.3, "avg": -97.7,
                                           "n": 138}}, Path(tmp))
        self.assertEqual(sec["updates"], 138)
        self.assertNotIn("from_live_file", sec)

    def test_html_renders_a_missing_value_as_not_recorded(self):
        row = rp._rows([("Label", None)])
        self.assertIn("not recorded", row)
        self.assertNotIn(">0<", row)


class Headline(unittest.TestCase):

    def _agreement(self, comparisons):
        out = []
        for label, f in comparisons:
            out.append({"label": label, "unit": "dB", "role": "result", "lag_s": None,
                        "lag_corrected": False, "fit": f, "verdict": rp.fit_verdict(f),
                        "note": None})
        ranked = sorted(out, key=lambda c: (c["verdict"]["usable"], c["fit"].get("r2") or -1),
                        reverse=True)
        return ranked[0]

    def test_an_unusable_fit_does_not_lead_however_high_its_r2(self):
        head = self._agreement([
            ("thin", fit(n=6, r2=0.99, distinct_x=4)),
            ("real", fit(n=99, r2=0.94)),
        ])
        self.assertEqual(head["label"], "real")

    def test_among_usable_fits_the_strongest_leads(self):
        head = self._agreement([("a", fit(r2=0.61)), ("b", fit(r2=0.94))])
        self.assertEqual(head["label"], "b")


class Rendering(unittest.TestCase):

    def _report(self):
        return {
            "run_id": "20260819-064141-fda64d",
            "generated": "2026-08-20 07:00:00",
            "headline": "The traced channel predicts the measurement: r²=0.944 over 99 samples.",
            "sections": {
                "identity": rp._section("What this run was", available=True,
                                        run_id="r1", label=None, scene="s", du_config=None,
                                        state="complete", started="2026-08-19 06:41:41",
                                        duration_s=300.0, commits={"dashboard": "abc123"},
                                        dirty=[], scene_fingerprint="deadbeef"),
                "channel": rp._section("What the channel did", available=True, updates=138,
                                       gain="-110.4 to -90.3 dB", paths="2 to 2"),
                "radio": rp._section("What the radio measured", available=False,
                                     why="no modem samples were recorded"),
                "agreement": rp._section("Did the model predict reality", available=True,
                                         comparisons=[{"label": "UE SINR", "unit": "dB",
                                                       "role": "result", "lag_s": 2.0,
                                                       "lag_corrected": True,
                                                       "fit": fit(),
                                                       "verdict": rp.fit_verdict(fit()),
                                                       "note": None}],
                                         headline=None, tolerance_s=20.0,
                                         traced_span_db=20.1),
                "stability": rp._section("What ended the link", available=True, dropped=False,
                                         findings=["No release in any log."], shared_logs=[]),
            },
            "caveats": ["The run lasted 300 s."],
        }

    def test_it_is_self_contained(self):
        h = rp.render_html(self._report())
        for external in ("<script", "src=", "@import", "//fonts.", "http://", "https://"):
            self.assertNotIn(external, h, external)

    def test_an_absent_section_says_why_on_the_page(self):
        h = rp.render_html(self._report())
        self.assertIn("no modem samples were recorded", h)

    def test_the_headline_reaches_the_page(self):
        self.assertIn("r²=0.944", rp.render_html(self._report()))

    def test_caveats_are_rendered_whether_or_not_anyone_wants_them(self):
        h = rp.render_html(self._report())
        self.assertIn("Read these numbers with", h)
        self.assertIn("The run lasted 300 s.", h)

    def test_a_report_with_no_caveats_omits_the_box(self):
        r = self._report()
        r["caveats"] = []
        self.assertNotIn("Read these numbers with", rp.render_html(r))

    def test_content_is_escaped(self):
        r = self._report()
        r["headline"] = "<script>alert(1)</script>"
        h = rp.render_html(r)
        self.assertNotIn("<script>alert(1)</script>", h)
        self.assertIn("&lt;script&gt;", h)


class Caveats(unittest.TestCase):

    def _sections(self, **over):
        base = {
            "identity": rp._section("What this run was", available=True, duration_s=600.0,
                                    dirty=[], commits={}),
            "channel": rp._section("What the channel did", available=True, updates=1),
            "radio": rp._section("What the radio measured", available=True),
            "agreement": rp._section("Did the model predict reality", available=True,
                                     comparisons=[], headline=None),
            "stability": rp._section("What ended the link", available=True, dropped=False,
                                     findings=[], shared_logs=[]),
        }
        base.update(over)
        return base

    def test_a_still_recording_run_says_its_figures_are_partial(self):
        c = rp._caveats({"state": "recording"}, self._sections())
        self.assertTrue(any("still recording" in x for x in c))

    def test_a_short_run_is_flagged(self):
        s = self._sections(identity=rp._section("What this run was", available=True,
                                                duration_s=45.0, dirty=[], commits={}))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("45 s" in x for x in c))

    def test_a_long_run_is_not(self):
        c = rp._caveats({"state": "complete"}, self._sections())
        self.assertFalse(any("mostly describe bring-up" in x for x in c))

    def test_a_dirty_tree_undermines_the_commit_and_says_so(self):
        s = self._sections(identity=rp._section("What this run was", available=True,
                                                duration_s=600.0, dirty=["dashboard"],
                                                commits={"dashboard": "abc"}))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("Uncommitted changes" in x for x in c))

    def test_no_radio_means_nothing_here_is_evidence_about_a_radio(self):
        s = self._sections(radio=rp._section("What the radio measured", available=False,
                                             why="none"))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("only about what was traced" in x for x in c))

    def test_a_control_column_is_marked_as_not_citable(self):
        s = self._sections(agreement=rp._section(
            "Did the model predict reality", available=True, headline=None,
            comparisons=[{"label": "PUSCH RSRP", "role": "control", "lag_corrected": False,
                          "lag_s": None, "fit": fit(), "verdict": rp.fit_verdict(fit())}]))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("not a result" in x for x in c))

    def test_a_lag_correction_is_disclosed(self):
        s = self._sections(agreement=rp._section(
            "Did the model predict reality", available=True, headline=None,
            comparisons=[{"label": "UE SINR", "role": "result", "lag_corrected": True,
                          "lag_s": 2.0, "fit": fit(), "verdict": rp.fit_verdict(fit())}]))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("correcting a 2 s lag" in x for x in c))

    def test_shared_logs_are_disclosed(self):
        s = self._sections(stability=rp._section(
            "What ended the link", available=True, dropped=True, findings=[],
            shared_logs=["du", "cu"]))
        c = rp._caveats({"state": "complete"}, s)
        self.assertTrue(any("shared with every other run" in x for x in c))


class Missing(unittest.TestCase):
    def test_an_unknown_run_raises(self):
        with self.assertRaises(FileNotFoundError):
            rp.build("no-such-run")


if __name__ == "__main__":
    unittest.main()
