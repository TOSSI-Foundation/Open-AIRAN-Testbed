import math
import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import radiomap as rm


def centres(ny, nx, size=10.0, x0=0.0, y0=0.0):
    ys, xs = np.mgrid[0:ny, 0:nx]
    cc = np.zeros((ny, nx, 3))
    cc[..., 0] = x0 + xs * size
    cc[..., 1] = y0 + ys * size
    return cc


class ToDb(unittest.TestCase):
    def test_it_converts(self):
        self.assertAlmostEqual(rm.to_db([1.0])[0], 0.0)
        self.assertAlmostEqual(rm.to_db([0.001])[0], -30.0)

    def test_an_unreached_cell_is_nan_not_minus_infinity(self):
        out = rm.to_db([0.0, 1.0])
        self.assertTrue(math.isnan(out[0]))
        self.assertFalse(math.isinf(out[0]))
        self.assertEqual(out[1], 0.0)

    def test_a_map_of_nothing_averages_to_nothing_not_to_zero(self):
        out = rm.to_db(np.zeros((4, 4)))
        self.assertTrue(np.isnan(out).all())
        self.assertEqual(rm.summarise(out)["cells_served"], 0)
        self.assertIsNone(rm.summarise(out)["median_db"])


class BestServer(unittest.TestCase):
    def test_it_picks_the_strongest(self):
        vals = np.array([[[1.0, 5.0]], [[3.0, 2.0]]])
        idx, val = rm.best_server(vals)
        self.assertEqual(idx.tolist(), [[1, 0]])
        self.assertEqual(val.tolist(), [[3.0, 5.0]])

    def test_an_unreached_cell_is_not_attributed_to_transmitter_zero(self):
        vals = np.zeros((3, 2, 2))
        idx, val = rm.best_server(vals)
        self.assertTrue((idx == -1).all())
        self.assertTrue(np.isnan(val).all())

    def test_a_partly_covered_map_keeps_both_answers(self):
        vals = np.zeros((2, 1, 2))
        vals[1, 0, 0] = 4.0
        idx, val = rm.best_server(vals)
        self.assertEqual(idx.tolist(), [[1, -1]])
        self.assertEqual(val[0, 0], 4.0)
        self.assertTrue(math.isnan(val[0, 1]))

    def test_a_single_transmitter_map_is_accepted(self):
        idx, val = rm.best_server(np.array([[1.0, 0.0]]))
        self.assertEqual(idx.tolist(), [[0, -1]])

    def test_a_wrong_shape_is_refused(self):
        with self.assertRaises(ValueError):
            rm.best_server(np.zeros((2, 2, 2, 2)))


class Edges(unittest.TestCase):
    def test_it_finds_the_boundary_between_two_cells(self):
        assoc = np.array([[0, 0, 1, 1]])
        e = rm.association_edges(assoc)
        self.assertEqual(e.tolist(), [[False, True, True, False]])

    def test_a_uniform_map_has_no_boundaries(self):
        self.assertFalse(rm.association_edges(np.zeros((3, 3), dtype=int)).any())

    def test_the_rim_of_a_coverage_hole_is_not_a_handover_boundary(self):
        assoc = np.array([[0, 0, -1, -1]])
        self.assertFalse(rm.association_edges(assoc).any())

    def test_the_grid_does_not_wrap(self):
        assoc = np.array([[0, 0, 0, 1]])
        e = rm.association_edges(assoc)
        self.assertFalse(e[0, 0], "column 0 must not neighbour column 3")
        self.assertTrue(e[0, 2] and e[0, 3])

    def test_it_works_vertically_too(self):
        assoc = np.array([[0], [0], [1]])
        e = rm.association_edges(assoc)
        self.assertEqual(e.ravel().tolist(), [False, True, True])


class Contested(unittest.TestCase):

    def test_two_close_transmitters_make_a_cell_contested(self):
        vals = np.array([[[1.0]], [[1.2]]])
        self.assertTrue(rm.contested(vals)["contested"][0, 0])

    def test_a_clear_winner_is_not_contested(self):
        vals = np.array([[[1.0]], [[100.0]]])
        c = rm.contested(vals)
        self.assertFalse(c["contested"][0, 0])
        self.assertTrue(c["firm"][0, 0])

    def test_the_margin_is_configurable(self):
        vals = np.array([[[1.0]], [[3.0]]])
        self.assertFalse(rm.contested(vals, margin_db=3.0)["contested"][0, 0])
        self.assertTrue(rm.contested(vals, margin_db=6.0)["contested"][0, 0])

    def test_a_cell_only_one_transmitter_reached_is_sole_not_contested(self):
        vals = np.array([[[1.0]], [[0.0]]])
        c = rm.contested(vals)
        self.assertTrue(c["sole"][0, 0])
        self.assertFalse(c["contested"][0, 0])

    def test_an_unserved_cell_is_none_of_them(self):
        c = rm.contested(np.zeros((2, 1, 1)))
        self.assertTrue(c["unserved"][0, 0])
        self.assertFalse(c["contested"][0, 0])
        self.assertFalse(c["sole"][0, 0])
        self.assertEqual(c["cells_served"], 0)

    def test_a_single_transmitter_map_contests_nothing(self):
        c = rm.contested(np.array([[[1.0, 2.0]]]))
        self.assertFalse(c["contested"].any())
        self.assertTrue(c["sole"].all())

    def test_a_two_dimensional_grid_is_accepted_as_one_transmitter(self):
        c = rm.contested(np.array([[1.0, 2.0]]))
        self.assertEqual(c["contested"].shape, (1, 2))
        self.assertFalse(c["contested"].any())

    def test_counts_are_reported(self):
        vals = np.array([[[1.0, 1.0, 1.0]], [[1.1, 100.0, 0.0]]])
        c = rm.contested(vals)
        self.assertEqual(c["cells_contested"], 1)
        self.assertEqual(c["cells_served"], 3)

    def test_a_wrong_shape_is_refused(self):
        with self.assertRaises(ValueError):
            rm.contested(np.zeros((2, 2, 2, 2)))


class Sampling(unittest.TestCase):
    def setUp(self):
        self.cc = centres(3, 4, size=10.0)

    def test_a_point_lands_in_its_own_cell(self):
        self.assertEqual(rm.cell_index_at(self.cc, 0.0, 0.0), (0, 0))
        self.assertEqual(rm.cell_index_at(self.cc, 30.0, 20.0), (2, 3))

    def test_a_point_between_centres_takes_the_nearer(self):
        self.assertEqual(rm.cell_index_at(self.cc, 11.0, 0.0), (0, 1))
        self.assertEqual(rm.cell_index_at(self.cc, 9.0, 0.0), (0, 1))
        self.assertEqual(rm.cell_index_at(self.cc, 4.0, 0.0), (0, 0))

    def test_a_point_off_the_map_is_off_the_map(self):
        self.assertIsNone(rm.cell_index_at(self.cc, 500.0, 0.0))
        self.assertIsNone(rm.cell_index_at(self.cc, -60.0, -60.0))

    def test_just_outside_the_last_centre_is_still_inside_the_map(self):
        self.assertEqual(rm.cell_index_at(self.cc, 34.0, 24.0), (2, 3))

    def test_sample_returns_the_value(self):
        grid = np.arange(12, dtype=float).reshape(3, 4)
        self.assertEqual(rm.sample_at(grid, self.cc, 10.0, 0.0), 1.0)

    def test_sampling_an_unreached_cell_gives_nothing_not_zero(self):
        grid = np.full((3, 4), np.nan)
        self.assertIsNone(rm.sample_at(grid, self.cc, 0.0, 0.0))

    def test_sampling_off_the_map_gives_nothing(self):
        grid = np.zeros((3, 4))
        self.assertIsNone(rm.sample_at(grid, self.cc, 900.0, 900.0))

    def test_a_track_keeps_its_gaps(self):
        grid = np.arange(12, dtype=float).reshape(3, 4)
        out = rm.sample_track(grid, self.cc, [(0.0, 0.0), (900.0, 0.0), (10.0, 0.0)])
        self.assertEqual(out, [0.0, None, 1.0])

    def test_an_offset_grid_is_handled(self):
        cc = centres(2, 2, size=5.0, x0=1000.0, y0=-2000.0)
        self.assertEqual(rm.cell_index_at(cc, 1005.0, -2000.0), (0, 1))
        self.assertIsNone(rm.cell_index_at(cc, 0.0, 0.0))

    def test_a_rotated_grid_is_handled(self):
        cc = np.zeros((2, 2, 3))
        cc[0, 0, :2] = (0.0, 0.0)
        cc[0, 1, :2] = (7.07, 7.07)
        cc[1, 0, :2] = (-7.07, 7.07)
        cc[1, 1, :2] = (0.0, 14.14)
        self.assertEqual(rm.cell_index_at(cc, 7.0, 7.0), (0, 1))
        self.assertEqual(rm.cell_index_at(cc, -7.0, 7.0), (1, 0))


class Coverage(unittest.TestCase):
    def test_served_and_area_are_reported_separately(self):
        g = np.array([[-80.0, -80.0, np.nan, np.nan]])
        c = rm.coverage_fraction(g, -90.0)
        self.assertEqual(c["cells_served"], 2)
        self.assertEqual(c["cells_total"], 4)
        self.assertEqual(c["fraction_of_served"], 1.0)
        self.assertEqual(c["fraction_of_area"], 0.5)

    def test_an_empty_map_reports_none_not_zero(self):
        c = rm.coverage_fraction(np.full((2, 2), np.nan), -90.0)
        self.assertIsNone(c["fraction_of_served"])
        self.assertEqual(c["cells_above"], 0)

    def test_the_threshold_is_inclusive(self):
        c = rm.coverage_fraction(np.array([[-90.0]]), -90.0)
        self.assertEqual(c["cells_above"], 1)


class Summarise(unittest.TestCase):
    def test_unreached_cells_do_not_drag_the_average_down(self):
        g = np.array([[-70.0, -70.0, np.nan]])
        s = rm.summarise(g)
        self.assertEqual(s["cells_served"], 2)
        self.assertEqual(s["median_db"], -70.0)


class OffsetAgainst(unittest.TestCase):

    def setUp(self):
        self.cc = centres(2, 2, size=10.0)
        self.grid = np.array([[-120.0, -110.0], [-100.0, np.nan]])

    def test_a_constant_offset_is_found_and_called_uniform(self):
        ref = [{"pos": [0, 0], "gain_db": -105.0},
               {"pos": [10, 0], "gain_db": -95.0},
               {"pos": [0, 10], "gain_db": -85.0}]
        out = rm.offset_against(self.grid, self.cc, ref)
        self.assertEqual(out["n"], 3)
        self.assertAlmostEqual(out["mean_db"], 15.0)
        self.assertTrue(out["uniform"])

    def test_a_scattered_difference_is_not_offered_as_a_correction(self):
        ref = [{"pos": [0, 0], "gain_db": -119.0},
               {"pos": [10, 0], "gain_db": -80.0},
               {"pos": [0, 10], "gain_db": -101.0}]
        out = rm.offset_against(self.grid, self.cc, ref)
        self.assertFalse(out["uniform"])
        self.assertGreater(out["spread_db"], 6.0)

    def test_unreachable_and_off_map_points_are_skipped(self):
        ref = [{"pos": [0, 0], "gain_db": -105.0},
               {"pos": [10, 10], "gain_db": -50.0},
               {"pos": [900, 900], "gain_db": -50.0}]
        out = rm.offset_against(self.grid, self.cc, ref)
        self.assertEqual(out["n"], 1)

    def test_nothing_to_compare_reports_nothing(self):
        out = rm.offset_against(self.grid, self.cc, [])
        self.assertEqual(out["n"], 0)
        self.assertIsNone(out["mean_db"])
        self.assertIsNone(out["uniform"])


class CompareToMeasured(unittest.TestCase):
    def setUp(self):
        self.cc = centres(2, 2, size=10.0)
        self.grid = np.array([[-100.0, -90.0], [-80.0, np.nan]])

    def test_it_pairs_prediction_with_measurement(self):
        out = rm.compare_to_measured(self.grid, self.cc,
                                     [{"pos": [0, 0], "sinr": 40.0},
                                      {"pos": [10, 0], "sinr": 50.0}])
        self.assertEqual(out["n"], 2)
        self.assertEqual([p["x"] for p in out["pairs"]], [-100.0, -90.0])
        self.assertEqual([p["y"] for p in out["pairs"]], [40.0, 50.0])

    def test_what_the_map_could_not_speak_for_is_counted_not_dropped(self):
        out = rm.compare_to_measured(self.grid, self.cc, [
            {"pos": [0, 0], "sinr": 40.0},
            {"pos": [900, 900], "sinr": 41.0},
            {"pos": [10, 10], "sinr": 42.0},
            {"pos": [0, 10], "sinr": None},
        ])
        self.assertEqual(out["n"], 1)
        self.assertEqual(out["excluded"], {"off_map": 1, "unreached_cell": 1,
                                           "no_measurement": 1})

    def test_a_position_free_sample_is_skipped(self):
        out = rm.compare_to_measured(self.grid, self.cc, [{"sinr": 40.0}])
        self.assertEqual(out["n"], 0)

    def test_the_measured_key_can_be_chosen(self):
        out = rm.compare_to_measured(self.grid, self.cc,
                                     [{"pos": [0, 0], "rsrp_db": -55.0}],
                                     value_key="rsrp_db")
        self.assertEqual(out["n"], 1)
        self.assertEqual(out["pairs"][0]["y"], -55.0)


if __name__ == "__main__":
    unittest.main()
