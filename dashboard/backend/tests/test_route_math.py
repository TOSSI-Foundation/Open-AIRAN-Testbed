import math
import unittest

from app import sionna_bridge as sb


class PathLength(unittest.TestCase):
    def test_straight_line(self):
        self.assertEqual(sb._path_len([[0, 0, 0], [3, 4, 0]]), 5.0)

    def test_sums_every_leg(self):
        self.assertEqual(sb._path_len([[0, 0, 0], [3, 4, 0], [3, 4, 12]]), 17.0)

    def test_height_counts(self):
        self.assertEqual(sb._path_len([[0, 0, 0], [0, 0, 9]]), 9.0)

    def test_degenerate_inputs_are_zero_not_an_error(self):
        self.assertEqual(sb._path_len([]), 0)
        self.assertEqual(sb._path_len([[1, 2, 3]]), 0)

    def test_rounded_to_a_tenth_of_a_metre(self):
        self.assertEqual(sb._path_len([[0, 0, 0], [1, 1, 0]]), 1.4)


class WalkRoute(unittest.TestCase):

    def test_endpoints_are_exact(self):
        out = sb.walk_route([[0, 0, 1.5], [100, 0, 1.5]], 5)
        self.assertEqual(out[0], [0.0, 0.0, 1.5])
        self.assertEqual(out[-1], [100.0, 0.0, 1.5])

    def test_step_count_is_honoured(self):
        for n in (2, 3, 12, 100):
            self.assertEqual(len(sb.walk_route([[0, 0, 0], [10, 0, 0]], n)), n)

    def test_spacing_is_even_along_a_straight_line(self):
        out = sb.walk_route([[0, 0, 0], [100, 0, 0]], 5)
        self.assertEqual([p[0] for p in out], [0.0, 25.0, 50.0, 75.0, 100.0])

    def test_spacing_is_even_across_a_corner(self):
        out = sb.walk_route([[0, 0, 0], [30, 0, 0], [30, 60, 0]], 10)
        gaps = [math.dist(out[i], out[i + 1]) for i in range(len(out) - 1)]
        for g in gaps:
            self.assertAlmostEqual(g, 10.0, places=1)

    def test_interpolates_in_three_dimensions(self):
        mid = sb.walk_route([[0, 0, 0], [10, 20, 30]], 3)[1]
        self.assertEqual(mid, [5.0, 10.0, 15.0])

    def test_fewer_than_two_points_is_a_standstill(self):
        self.assertEqual(sb.walk_route([], 5), [])
        self.assertEqual(sb.walk_route([[7, 8, 9]], 5), [[7.0, 8.0, 9.0]])

    def test_a_zero_length_route_is_a_standstill(self):
        self.assertEqual(sb.walk_route([[5, 5, 1], [5, 5, 1]], 8), [[5.0, 5.0, 1.0]])

    def test_steps_below_two_are_clamped(self):
        for n in (0, 1, -4):
            self.assertEqual(len(sb.walk_route([[0, 0, 0], [1, 0, 0]], n)), 2)

    def test_coordinates_come_back_rounded_to_the_centimetre(self):
        out = sb.walk_route([[0, 0, 0], [1, 0, 0]], 3)
        for p in out:
            for v in p:
                self.assertEqual(v, round(v, 2))

    def test_string_coordinates_are_accepted(self):
        out = sb.walk_route([["0", "0", "0"], ["10", "0", "0"]], 3)
        self.assertEqual(out[1], [5.0, 0.0, 0.0])


class PrbForBandwidth(unittest.TestCase):

    def test_the_cell_this_platform_actually_runs(self):
        self.assertEqual(sb.prb_for(40, 30), 106)

    def test_other_widths_at_30khz(self):
        self.assertEqual(sb.prb_for(10, 30), 24)
        self.assertEqual(sb.prb_for(20, 30), 51)
        self.assertEqual(sb.prb_for(100, 30), 273)

    def test_spacing_changes_the_answer(self):
        self.assertEqual(sb.prb_for(20, 15), 106)
        self.assertEqual(sb.prb_for(20, 30), 51)
        self.assertEqual(sb.prb_for(20, 60), 24)

    def test_pairs_the_standard_does_not_define(self):
        self.assertIsNone(sb.prb_for(5, 60))
        self.assertIsNone(sb.prb_for(60, 15))
        self.assertIsNone(sb.prb_for(37, 30))

    def test_missing_or_unusable_input(self):
        self.assertIsNone(sb.prb_for(None, 30))
        self.assertIsNone(sb.prb_for(40, None))
        self.assertIsNone(sb.prb_for("wide", 30))

    def test_numeric_strings_and_floats_are_accepted(self):
        self.assertEqual(sb.prb_for("40", "30"), 106)
        self.assertEqual(sb.prb_for(40.0, 30.0), 106)


if __name__ == "__main__":
    unittest.main()
