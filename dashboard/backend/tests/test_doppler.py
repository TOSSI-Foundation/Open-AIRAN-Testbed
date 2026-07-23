import sys
import unittest
from pathlib import Path

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import doppler


class Spread(unittest.TestCase):

    def test_a_still_receiver_has_no_spread(self):
        self.assertEqual(doppler.rms_spread_hz([0.0, 0.0, 0.0], [1.0, 1.0, 1.0]), 0.0)

    def test_one_path_has_no_spread_however_shifted(self):
        self.assertEqual(doppler.rms_spread_hz([200.0], [1.0]), 0.0)

    def test_it_weights_by_power_rather_than_counting_paths(self):
        even = doppler.rms_spread_hz([-100.0, 100.0], [1.0, 1.0])
        lopsided = doppler.rms_spread_hz([-100.0, 100.0], [1.0, 1e-9])
        self.assertAlmostEqual(even, 100.0, places=6)
        self.assertLess(lopsided, 1.0)

    def test_two_equal_paths_spread_about_their_weighted_centre(self):
        self.assertAlmostEqual(doppler.rms_spread_hz([0.0, 200.0], [1.0, 1.0]), 100.0, places=6)

    def test_pathless_and_mismatched_inputs_give_nothing(self):
        self.assertIsNone(doppler.rms_spread_hz([], []))
        self.assertIsNone(doppler.rms_spread_hz([1.0, 2.0], [1.0]))

    def test_zero_power_paths_are_ignored_not_counted(self):
        self.assertAlmostEqual(
            doppler.rms_spread_hz([0.0, 200.0, 9999.0], [1.0, 1.0, 0.0]), 100.0, places=6)

    def test_all_powerless_gives_nothing(self):
        self.assertIsNone(doppler.rms_spread_hz([1.0, 2.0], [0.0, 0.0]))


class MaxShift(unittest.TestCase):

    def test_it_is_a_magnitude_so_approaching_and_receding_rank_together(self):
        self.assertEqual(doppler.max_shift_hz([-300.0, 100.0]), 300.0)

    def test_theory_bounds_what_was_measured(self):
        self.assertLessEqual(174.7, doppler.theoretical_max_hz(15.0, 3.5e9))

    def test_the_bound_matches_the_textbook_value(self):
        self.assertAlmostEqual(doppler.theoretical_max_hz(15.0, 3.5e9), 175.12, places=1)

    def test_direction_of_travel_does_not_change_the_bound(self):
        self.assertEqual(doppler.theoretical_max_hz(-15.0, 3.5e9),
                         doppler.theoretical_max_hz(15.0, 3.5e9))


class Coherence(unittest.TestCase):

    def test_a_wider_spread_decorrelates_sooner(self):
        self.assertLess(doppler.coherence_time_s(400.0), doppler.coherence_time_s(50.0))

    def test_a_static_channel_has_no_coherence_time_rather_than_an_infinite_one(self):
        self.assertIsNone(doppler.coherence_time_s(0.0))
        self.assertIsNone(doppler.coherence_time_s(None))


class Staleness(unittest.TestCase):

    def test_publishing_faster_than_the_channel_changes_keeps_up(self):
        self.assertLess(doppler.staleness(0.1, 0.01), 1.0)

    def test_publishing_slower_than_the_channel_changes_does_not(self):
        self.assertGreater(doppler.staleness(0.003, 1.0), 1.0)

    def test_it_counts_coherence_times_per_update(self):
        self.assertAlmostEqual(doppler.staleness(0.5, 2.0), 4.0)

    def test_a_still_receiver_has_no_staleness(self):
        self.assertIsNone(doppler.staleness(None, 1.0))


class VelocityFromStep(unittest.TestCase):

    def test_it_comes_from_the_step_actually_taken(self):
        v = doppler.velocity_from_step([0, 0, 0], [10, 0, 0], 2.0)
        self.assertEqual(v, [5.0, 0.0, 0.0])

    def test_it_keeps_the_direction_of_travel(self):
        self.assertEqual(doppler.velocity_from_step([0, 0, 0], [0, -6, 0], 2.0),
                         [0.0, -3.0, 0.0])

    def test_holding_position_is_not_moving(self):
        self.assertEqual(doppler.velocity_from_step([5, 5, 1], [5, 5, 1], 1.0), [0.0, 0.0, 0.0])

    def test_a_nonsensical_interval_is_not_a_division_by_zero(self):
        self.assertEqual(doppler.velocity_from_step([0, 0, 0], [1, 0, 0], 0.0), [0.0, 0.0, 0.0])


class Summary(unittest.TestCase):

    def real(self):
        return doppler.summarise([174.7, -167.5, 20.0], [1e-9, 1e-11, 1e-10],
                                 speed_mps=15.0, carrier_hz=3.5e9, interval_s=1.0)

    def test_it_reports_that_a_second_is_far_too_slow_at_road_speed(self):
        s = self.real()
        self.assertFalse(s["keeping_up"])
        self.assertGreater(s["staleness"], 100)
        self.assertLess(s["coherence_time_s"], 0.01)

    def test_the_measured_peak_stays_under_the_theoretical_one(self):
        s = self.real()
        self.assertLessEqual(s["max_shift_hz"], s["theoretical_max_hz"])

    def test_a_still_receiver_is_not_reported_as_failing_to_keep_up(self):
        s = doppler.summarise([0.0, 0.0], [1.0, 1.0], speed_mps=0.0,
                             carrier_hz=3.5e9, interval_s=1.0)
        self.assertIsNone(s["keeping_up"])
        self.assertIsNone(s["coherence_time_s"])

    def test_a_fast_enough_publisher_keeps_up(self):
        s = doppler.summarise([174.7, -167.5, 20.0], [1e-9, 1e-11, 1e-10],
                              speed_mps=15.0, carrier_hz=3.5e9, interval_s=0.0014)
        self.assertTrue(s["keeping_up"])

    def test_it_carries_the_interval_it_judged_against(self):
        self.assertEqual(self.real()["update_interval_s"], 1.0)


class Offset(unittest.TestCase):

    def test_paths_shifted_together_are_an_offset_and_not_a_spread(self):
        shifts, powers = [-159.0, -159.4], [0.2852, 0.7148]
        self.assertAlmostEqual(doppler.mean_shift_hz(shifts, powers), -159.29, places=1)
        self.assertLess(doppler.rms_spread_hz(shifts, powers), 0.5)

    def test_paths_shifted_apart_are_a_spread_around_no_offset(self):
        shifts, powers = [-100.0, 100.0], [1.0, 1.0]
        self.assertAlmostEqual(doppler.mean_shift_hz(shifts, powers), 0.0, places=6)
        self.assertAlmostEqual(doppler.rms_spread_hz(shifts, powers), 100.0, places=6)

    def test_the_offset_is_weighted_by_power_like_the_spread_is(self):
        self.assertAlmostEqual(
            doppler.mean_shift_hz([-160.0, 400.0], [1.0, 1e-9]), -160.0, places=3)

    def test_the_offset_keeps_its_sign(self):
        self.assertLess(doppler.mean_shift_hz([-160.0], [1.0]), 0)
        self.assertGreater(doppler.mean_shift_hz([160.0], [1.0]), 0)

    def test_a_still_receiver_has_no_offset(self):
        self.assertAlmostEqual(doppler.mean_shift_hz([0.0, 0.0], [1.0, 1.0]), 0.0, places=9)

    def test_nothing_to_average_gives_nothing(self):
        self.assertIsNone(doppler.mean_shift_hz([], []))
        self.assertIsNone(doppler.mean_shift_hz([1.0, 2.0], [0.0, 0.0]))

    def test_the_summary_carries_both(self):
        s = doppler.summarise([-159.0, -159.4], [0.2852, 0.7148], speed_mps=13.9,
                              carrier_hz=3.5e9, interval_s=2.0)
        self.assertLess(s["mean_shift_hz"], -100)
        self.assertLess(s["rms_spread_hz"], 0.5)

    def test_the_staleness_verdict_follows_the_spread_not_the_offset(self):
        offset_only = doppler.summarise([-159.0, -159.0], [1.0, 1.0], speed_mps=13.9,
                                        carrier_hz=3.5e9, interval_s=0.01)
        smeared = doppler.summarise([-300.0, 300.0], [1.0, 1.0], speed_mps=13.9,
                                    carrier_hz=3.5e9, interval_s=0.01)
        self.assertTrue(offset_only["keeping_up"])
        self.assertFalse(smeared["keeping_up"])

    def test_the_offset_stays_within_the_theoretical_bound(self):
        s = doppler.summarise([-159.0, -159.4], [0.2852, 0.7148], speed_mps=13.909,
                              carrier_hz=3.5e9, interval_s=2.0)
        self.assertLessEqual(abs(s["mean_shift_hz"]), s["theoretical_max_hz"])


if __name__ == "__main__":
    unittest.main()
