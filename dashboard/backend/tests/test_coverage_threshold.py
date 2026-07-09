import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import radiomap


class Dbm(unittest.TestCase):

    def test_one_watt_is_thirty_dbm(self):
        self.assertAlmostEqual(float(radiomap.to_dbm(np.array([1.0]))[0]), 30.0, places=9)

    def test_it_is_thirty_above_dbw(self):
        w = np.array([1e-9, 2.5e-11, 1.0])
        self.assertTrue(np.allclose(radiomap.to_dbm(w) - radiomap.to_db(w), 30.0))

    def test_the_recorded_map_lands_where_the_link_budget_says(self):
        self.assertAlmostEqual(float(radiomap.to_dbm(np.array([2.186e-11]))[0]), -76.6, places=1)

    def test_an_unreached_cell_stays_unknown(self):
        self.assertTrue(np.isnan(radiomap.to_dbm(np.array([0.0]))[0]))


class CoverageFraction(unittest.TestCase):

    def grid(self):
        return np.array([[-70.0, -80.0], [-100.0, np.nan]])

    def test_it_reports_area_and_served_separately(self):
        c = radiomap.coverage_fraction(self.grid(), -90.0)
        self.assertEqual(c["cells_total"], 4)
        self.assertEqual(c["cells_served"], 3)
        self.assertEqual(c["cells_above"], 2)
        self.assertAlmostEqual(c["fraction_of_served"], 2 / 3)
        self.assertAlmostEqual(c["fraction_of_area"], 0.5)

    def test_it_records_the_threshold_it_used(self):
        self.assertEqual(radiomap.coverage_fraction(self.grid(), -90.0)["threshold_db"], -90.0)

    def test_relaxing_the_threshold_covers_more(self):
        strict = radiomap.coverage_fraction(self.grid(), -90.0)["cells_above"]
        loose = radiomap.coverage_fraction(self.grid(), -105.0)["cells_above"]
        self.assertGreater(loose, strict)

    def test_a_cell_exactly_at_the_threshold_counts(self):
        c = radiomap.coverage_fraction(np.array([[-90.0]]), -90.0)
        self.assertEqual(c["cells_above"], 1)

    def test_a_map_nothing_reached_is_zero_not_an_error(self):
        c = radiomap.coverage_fraction(np.full((2, 2), np.nan), -90.0)
        self.assertEqual(c["cells_served"], 0)
        self.assertEqual(c["cells_above"], 0)


class ServingCell(unittest.TestCase):

    def test_coverage_is_read_at_the_serving_cell_not_the_best_one(self):
        sinr = np.array([[[1.0]], [[1000.0]]])
        serving = np.array([[0]])
        at = radiomap.at_serving(sinr, serving)
        self.assertAlmostEqual(float(radiomap.to_db(at)[0, 0]), 0.0, places=6)

    def test_an_unserved_cell_contributes_nothing(self):
        sinr = np.array([[[1.0]], [[1000.0]]])
        at = radiomap.at_serving(sinr, np.array([[-1]]))
        self.assertTrue(np.isnan(np.asarray(at, dtype=float)[0, 0]))


if __name__ == "__main__":
    unittest.main()
