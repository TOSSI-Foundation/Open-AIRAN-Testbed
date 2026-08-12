import unittest

from app import handover as ho


def series(points, dt=1.0, t0=1000.0):
    return [{"t": t0 + i * dt, "rss": p} for i, p in enumerate(points)]


class Baseline(unittest.TestCase):

    def test_no_change_no_switch(self):
        s = series([{"A": -80, "B": -90}] * 10)
        self.assertEqual(ho.naive_switches(s), [])

    def test_a_crossing_is_a_switch(self):
        s = series([{"A": -80, "B": -90}] * 3 + [{"A": -90, "B": -80}] * 3)
        out = ho.naive_switches(s)
        self.assertEqual(len(out), 1)
        self.assertEqual((out[0]["from"], out[0]["to"]), ("A", "B"))

    def test_jitter_produces_a_switch_every_time_it_crosses(self):
        s = series([{"A": -80, "B": -81}, {"A": -81, "B": -80}] * 6)
        self.assertGreater(len(ho.naive_switches(s)), 8)


class Entering(unittest.TestCase):

    def test_a_clear_sustained_win_hands_over(self):
        s = series([{"A": -80, "B": -95}] * 3 + [{"A": -95, "B": -75}] * 6)
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=2.0)
        self.assertEqual(out["n_events"], 1)
        e = out["events"][0]
        self.assertEqual((e["from"], e["to"]), ("A", "B"))
        self.assertGreaterEqual(e["held_s"], 2.0)

    def test_a_margin_inside_the_hysteresis_does_nothing(self):
        s = series([{"A": -80, "B": -95}] * 3 + [{"A": -80, "B": -78}] * 20)
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=1.0)
        self.assertEqual(out["n_events"], 0)
        self.assertGreater(out["n_naive_switches"], 0)

    def test_a_margin_just_past_the_hysteresis_does_fire(self):
        s = series([{"A": -80, "B": -95}] * 3 + [{"A": -80, "B": -76.5}] * 20)
        self.assertEqual(ho.a3_events(s, hysteresis_db=3.0,
                                      time_to_trigger_s=1.0)["n_events"], 1)

    def test_the_offset_shifts_the_threshold(self):
        s = series([{"A": -80, "B": -95}] * 3 + [{"A": -80, "B": -76}] * 20)
        self.assertEqual(ho.a3_events(s, hysteresis_db=3.0, offset_db=0.0,
                                      time_to_trigger_s=1.0)["n_events"], 1)
        self.assertEqual(ho.a3_events(s, hysteresis_db=3.0, offset_db=5.0,
                                      time_to_trigger_s=1.0)["n_events"], 0)

    def test_the_serving_cell_can_be_stated_rather_than_inferred(self):
        s = series([{"A": -80, "B": -70}] * 10)
        self.assertEqual(ho.a3_events(s, serving="B", hysteresis_db=3.0,
                                      time_to_trigger_s=1.0)["n_events"], 0)
        self.assertEqual(ho.a3_events(s, serving="A", hysteresis_db=3.0,
                                      time_to_trigger_s=1.0)["n_events"], 1)


class TimeToTrigger(unittest.TestCase):

    def test_a_brief_excursion_fires_nothing(self):
        s = series([{"A": -80, "B": -95}] * 4 + [{"A": -80, "B": -60}]
                   + [{"A": -80, "B": -95}] * 4)
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=3.0)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["n_naive_switches"], 2)

    def test_the_timer_resets_when_the_condition_breaks(self):
        s = series([{"A": -80, "B": -60}] * 2 + [{"A": -80, "B": -95}]
                   + [{"A": -80, "B": -60}] * 2 + [{"A": -80, "B": -95}] * 3)
        self.assertEqual(ho.a3_events(s, hysteresis_db=3.0,
                                      time_to_trigger_s=4.0)["n_events"], 0)

    def test_a_longer_trigger_time_suppresses_a_shorter_win(self):
        s = series([{"A": -80, "B": -60}] * 3 + [{"A": -80, "B": -95}] * 5)
        self.assertEqual(ho.a3_events(s, time_to_trigger_s=1.0,
                                      hysteresis_db=3.0)["n_events"], 1)
        self.assertEqual(ho.a3_events(s, time_to_trigger_s=5.0,
                                      hysteresis_db=3.0)["n_events"], 0)

    def test_the_same_journey_sampled_twice_as_often_gives_the_same_answer(self):
        slow = series([{"A": -80, "B": -95}] * 2 + [{"A": -95, "B": -70}] * 4, dt=3.0)
        fast = series([{"A": -80, "B": -95}] * 6 + [{"A": -95, "B": -70}] * 12, dt=1.0)
        a = ho.a3_events(slow, hysteresis_db=3.0, time_to_trigger_s=2.0)
        b = ho.a3_events(fast, hysteresis_db=3.0, time_to_trigger_s=2.0)
        self.assertEqual(a["n_events"], b["n_events"])
        self.assertEqual(a["final_serving"], b["final_serving"])


class PingPong(unittest.TestCase):

    def test_straight_back_is_a_ping_pong(self):
        s = (series([{"A": -80, "B": -95}] * 2)
             + series([{"A": -95, "B": -70}] * 2, t0=1002.0)
             + series([{"A": -70, "B": -95}] * 3, t0=1004.0))
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=1.0)
        self.assertEqual(out["n_events"], 2)
        self.assertEqual(out["n_ping_pongs"], 1)

    def test_a_late_return_is_not_a_ping_pong(self):
        events = [{"t": 1000.0, "from": "A", "to": "B"},
                  {"t": 1100.0, "from": "B", "to": "A"}]
        self.assertEqual(ho.ping_pongs(events, window_s=5.0), [])

    def test_a_three_cell_tour_is_not_a_ping_pong(self):
        events = [{"t": 1000.0, "from": "A", "to": "B"},
                  {"t": 1001.0, "from": "B", "to": "C"}]
        self.assertEqual(ho.ping_pongs(events), [])

    def test_hysteresis_is_what_removes_them(self):
        s = series([{"A": -80, "B": -81}, {"A": -81, "B": -80}] * 10)
        loose = ho.a3_events(s, hysteresis_db=0.0, time_to_trigger_s=0.0)
        tight = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=2.0)
        self.assertGreater(loose["n_events"], 5)
        self.assertEqual(tight["n_events"], 0)


class MissingReadings(unittest.TestCase):
    def test_a_cell_reporting_nothing_is_not_a_cell_at_a_floor(self):
        s = series([{"A": -80, "B": None}] * 10)
        self.assertEqual(ho.a3_events(s)["n_events"], 0)

    def test_the_serving_cell_going_quiet_decides_nothing(self):
        s = series([{"A": -80, "B": -95}] * 2 + [{"A": None, "B": -95}] * 3
                   + [{"A": -80, "B": -95}] * 2)
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=1.0)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["final_serving"], "A")

    def test_an_empty_series(self):
        out = ho.a3_events([])
        self.assertEqual(out["n_events"], 0)
        self.assertIsNone(out["final_serving"])

    def test_a_single_cell_can_never_hand_over(self):
        s = series([{"A": -80}] * 20)
        out = ho.a3_events(s)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["final_serving"], "A")

    def test_readings_out_of_order_are_sorted_first(self):
        s = series([{"A": -80, "B": -95}] * 2 + [{"A": -95, "B": -70}] * 4)
        shuffled = [s[3], s[0], s[5], s[1], s[4], s[2]]
        self.assertEqual(ho.a3_events(shuffled, hysteresis_db=3.0,
                                      time_to_trigger_s=2.0)["n_events"], 1)


class ThreeCells(unittest.TestCase):
    def test_the_strongest_ripe_neighbour_wins(self):
        s = series([{"A": -80, "B": -95, "C": -95}] * 2
                   + [{"A": -80, "B": -70, "C": -65}] * 4)
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=2.0)
        self.assertEqual(out["events"][0]["to"], "C")

    def test_a_neighbour_that_disappears_loses_its_timer(self):
        s = (series([{"A": -80, "B": -60}] * 2)
             + series([{"A": -80}] * 2, t0=1002.0)
             + series([{"A": -80, "B": -60}] * 2, t0=1004.0))
        self.assertEqual(ho.a3_events(s, hysteresis_db=3.0,
                                      time_to_trigger_s=3.0)["n_events"], 0)


class Comparison(unittest.TestCase):

    def test_a_prediction_close_in_time_matches(self):
        pred = [{"t": 1000.0, "from": "A", "to": "B"}]
        act = [{"t": 1002.0, "from": "A", "to": "B"}]
        out = ho.compare(pred, act, tolerance_s=5.0)
        self.assertEqual(out["n_matched"], 1)
        self.assertEqual(out["matched"][0]["offset_s"], 2.0)
        self.assertEqual(out["median_offset_s"], 2.0)

    def test_too_far_apart_is_not_a_match(self):
        out = ho.compare([{"t": 1000.0}], [{"t": 1030.0}], tolerance_s=5.0)
        self.assertEqual(out["n_matched"], 0)
        self.assertEqual(len(out["predicted_not_seen"]), 1)
        self.assertEqual(len(out["actual_not_predicted"]), 1)

    def test_one_real_handover_cannot_absolve_two_predictions(self):
        pred = [{"t": 1000.0}, {"t": 1001.0}]
        out = ho.compare(pred, [{"t": 1000.5}], tolerance_s=5.0)
        self.assertEqual(out["n_matched"], 1)
        self.assertEqual(len(out["predicted_not_seen"]), 1)

    def test_the_two_failure_directions_are_reported_apart(self):
        out = ho.compare([{"t": 1000.0}], [{"t": 2000.0}], tolerance_s=5.0)
        self.assertEqual(len(out["predicted_not_seen"]), 1)
        self.assertEqual(len(out["actual_not_predicted"]), 1)
        self.assertNotIn("accuracy", out)

    def test_nothing_predicted_and_nothing_happened(self):
        out = ho.compare([], [])
        self.assertEqual(out["n_matched"], 0)
        self.assertIsNone(out["median_offset_s"])

    def test_the_nearest_actual_is_the_one_claimed(self):
        pred = [{"t": 1000.0}]
        act = [{"t": 1004.0}, {"t": 1000.5}]
        out = ho.compare(pred, act, tolerance_s=5.0)
        self.assertEqual(out["matched"][0]["offset_s"], 0.5)


if __name__ == "__main__":
    unittest.main()


class ActualFromLogs(unittest.TestCase):

    def test_an_intra_du_trigger_is_an_event(self):
        lines = ["2026-08-19T06:41:06.047910 [CU-CP  ] [I] ue=0: Trigger intra-CU "
                 "(intra-DU) handover on du=0"]
        out = ho.parse_actual(lines)
        self.assertEqual(out["n_events"], 1)
        self.assertEqual(out["events"][0]["ue"], 0)
        self.assertEqual(out["events"][0]["t"], "2026-08-19T06:41:06.047910")

    def test_an_inter_du_trigger_is_an_event(self):
        lines = ["2026-08-19T06:41:07.000000 [CU-CP  ] [I] ue=1: Trigger intra-CU "
                 "(inter-DU) handover from source_du=0 to target_du=1"]
        self.assertEqual(ho.parse_actual(lines)["n_events"], 1)

    def test_an_inter_cu_request_is_an_event(self):
        lines = ["2026-08-19T06:41:08.000000 [CU-CP  ] [D] ue=2: Requesting inter CU "
                 "handover. No local DU/cell with pci=7 found"]
        self.assertEqual(ho.parse_actual(lines)["n_events"], 1)

    def test_the_default_that_stops_everything_is_reported(self):
        lines = ["2026-08-19T06:41:09.000000 [CU-CP  ] [D] ue=0: Ignoring better "
                 "neighbor pci=2"] * 4
        out = ho.parse_actual(lines)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["n_suppressed"], 4)
        self.assertEqual(out["suppression_reasons"],
                         {"measurement handover disabled": 4})

    def test_a_slice_mismatch_is_a_different_reason(self):
        lines = ["2026-08-19T06:41:10.000000 [CU-CP  ] [I] ue=0: Handover suppressed: "
                 "target pci=2 (nci=0x19b0) does not support all of the UE's active slices"]
        out = ho.parse_actual(lines)
        self.assertEqual(out["suppression_reasons"],
                         {"target does not support the UE slices": 1})

    def test_a_line_counts_once(self):
        lines = ["2026-08-19T06:41:06.000000 [CU-CP  ] [I] ue=0: Trigger intra-CU "
                 "(intra-DU) handover on du=0"]
        out = ho.parse_actual(lines)
        self.assertEqual(out["n_events"] + out["n_suppressed"], 1)

    def test_ordinary_lines_are_ignored(self):
        lines = ["2026-08-19T06:39:30.285598 [CU      ] [W] CPU15 scaling governor",
                 "2026-08-19T06:41:06.047910 [DU-F1   ] [I] F1 Setup: completed"]
        out = ho.parse_actual(lines)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["n_suppressed"], 0)

    def test_an_empty_log(self):
        self.assertEqual(ho.parse_actual([])["n_events"], 0)
        self.assertEqual(ho.parse_actual(None)["n_events"], 0)

    def test_it_admits_it_is_unverified(self):
        self.assertFalse(ho.parse_actual([])["verified_against_a_real_handover"])


class ServingCellLost(unittest.TestCase):

    def test_a_cell_that_never_returns_gives_the_ue_up(self):
        s = [{"t": i, "rss": {"A": None, "B": -50}} for i in range(8)]
        out = ho.a3_events(s, serving="A")
        self.assertEqual(out["final_serving"], "B")
        self.assertEqual(out["n_recoveries"], 1)

    def test_that_recovery_is_not_counted_as_an_a3_event(self):
        s = [{"t": i, "rss": {"A": None, "B": -50}} for i in range(8)]
        out = ho.a3_events(s, serving="A")
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["recoveries"][0]["reason"], "serving cell stopped reporting")

    def test_a_brief_silence_still_decides_nothing(self):
        s = ([{"t": 0, "rss": {"A": -80, "B": -95}}, {"t": 1, "rss": {"A": -80, "B": -95}}]
             + [{"t": 2, "rss": {"A": None, "B": -95}}]
             + [{"t": 3, "rss": {"A": -80, "B": -95}}])
        out = ho.a3_events(s, hysteresis_db=3.0, time_to_trigger_s=1.0)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["n_recoveries"], 0)
        self.assertEqual(out["final_serving"], "A")

    def test_nothing_to_move_to_is_not_a_recovery(self):
        s = [{"t": i, "rss": {"A": None}} for i in range(8)]
        out = ho.a3_events(s, serving="A")
        self.assertEqual(out["n_recoveries"], 0)
        self.assertEqual(out["final_serving"], "A")


class SamplingGaps(unittest.TestCase):

    def test_a_long_gap_does_not_mature_the_timer(self):
        s = [{"t": 0, "rss": {"A": -80, "B": -60}},
             {"t": 1000, "rss": {"A": -80, "B": -60}}]
        out = ho.a3_events(s, serving="A", time_to_trigger_s=5.0)
        self.assertEqual(out["n_events"], 0)
        self.assertEqual(out["n_gaps"], 1)

    def test_the_timer_restarts_after_the_gap(self):
        s = ([{"t": 0, "rss": {"A": -80, "B": -60}},
              {"t": 100, "rss": {"A": -80, "B": -60}}]
             + [{"t": 100 + i * 0.2, "rss": {"A": -80, "B": -60}} for i in range(1, 15)])
        out = ho.a3_events(s, serving="A", time_to_trigger_s=1.0)
        self.assertEqual(out["n_events"], 1)
        self.assertGreaterEqual(out["events"][0]["t"], 101.0)

    def test_ordinary_sampling_is_untouched(self):
        s = series([{"A": -80, "B": -60}] * 10)
        out = ho.a3_events(s, serving="A", time_to_trigger_s=1.0)
        self.assertEqual(out["n_gaps"], 0)
        self.assertEqual(out["n_events"], 1)


class TiesAndBaseline(unittest.TestCase):
    def test_an_exact_tie_does_not_depend_on_the_cell_name(self):
        self.assertEqual(ho._best({"gnb_a": -80, "gnb_z": -80}, prefer="gnb_a"), "gnb_a")
        self.assertEqual(ho._best({"gnb_a": -80, "gnb_z": -80}, prefer="gnb_z"), "gnb_z")

    def test_the_incumbent_keeps_a_tie(self):
        s = series([{"A": -80, "B": -80}] * 6)
        out = ho.a3_events(s, serving="A")
        self.assertEqual(out["final_serving"], "A")
        self.assertEqual(out["n_events"], 0)

    def test_the_baseline_ignores_a_silent_incumbent_too(self):
        s = [{"t": 0, "rss": {"A": -80, "B": -90}},
             {"t": 1, "rss": {"B": -85}},
             {"t": 2, "rss": {"A": -80, "B": -85}}]
        out = ho.a3_events(s)
        self.assertEqual(out["n_naive_switches"], 0)
        self.assertEqual(out["n_events"], 0)

    def test_a_real_crossing_is_still_a_naive_switch(self):
        s = series([{"A": -70, "B": -90}] * 3 + [{"A": -90, "B": -70}] * 3)
        self.assertEqual(len(ho.naive_switches(s)), 1)


class PingPongAcrossTriggerTimes(unittest.TestCase):

    def _round_trip(self, ttt):
        s, t = [], 0.0
        while t < 3.0:
            s.append({"t": round(t, 2), "rss": {"A": -90, "B": -70}})
            t += 0.2
        while t < 7.0:
            s.append({"t": round(t, 2), "rss": {"A": -70, "B": -90}})
            t += 0.2
        return ho.a3_events(s, serving="A", hysteresis_db=3.0, time_to_trigger_s=ttt)

    def test_a_short_trigger_time_sees_the_ping_pong(self):
        self.assertEqual(self._round_trip(0.64)["n_ping_pongs"], 1)

    def test_a_longer_trigger_time_sees_it_too(self):
        out = self._round_trip(2.0)
        self.assertEqual(out["n_events"], 2)
        self.assertEqual(out["n_ping_pongs"], 1)


class Provenance(unittest.TestCase):
    def test_the_log_patterns_say_they_are_unverified(self):
        out = ho.parse_actual([])
        self.assertFalse(out["verified_against_a_real_handover"])
        self.assertIn("not yet confirmed", out["provenance"])
