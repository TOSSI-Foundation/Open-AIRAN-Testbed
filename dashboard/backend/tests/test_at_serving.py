import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import radiomap as rm


class AtServing(unittest.TestCase):
    def test_it_reads_the_serving_transmitter(self):
        vals = np.array([[[10.0, 20.0]], [[30.0, 40.0]]])
        idx = np.array([[1, 0]])
        self.assertEqual(rm.at_serving(vals, idx).tolist(), [[30.0, 20.0]])

    def test_the_max_would_have_been_higher(self):
        sinr = np.array([[[25.0]], [[5.0]]])
        idx = np.array([[1]])
        served = rm.at_serving(sinr, idx)[0, 0]
        naive = sinr.max(axis=0)[0, 0]
        self.assertEqual(served, 5.0)
        self.assertEqual(naive, 25.0)
        self.assertLess(served, naive, "the old behaviour was optimistic by construction")

    def test_an_unserved_cell_is_not_transmitter_zero(self):
        vals = np.array([[[10.0, 20.0]], [[30.0, 40.0]]])
        out = rm.at_serving(vals, np.array([[-1, 0]]))
        self.assertTrue(np.isnan(out[0, 0]))
        self.assertEqual(out[0, 1], 20.0)

    def test_a_single_transmitter_grid_is_accepted(self):
        out = rm.at_serving(np.array([[7.0, 8.0]]), np.array([[0, 0]]))
        self.assertEqual(out.tolist(), [[7.0, 8.0]])

    def test_a_mismatched_index_is_refused(self):
        with self.assertRaises(ValueError):
            rm.at_serving(np.zeros((2, 3, 4)), np.zeros((3, 5), dtype=int))

    def test_a_wrong_rank_is_refused(self):
        with self.assertRaises(ValueError):
            rm.at_serving(np.zeros((2, 2, 2, 2)), np.zeros((2, 2), dtype=int))

    def test_serving_and_best_server_agree_when_the_metric_is_the_one_chosen(self):
        pg = np.array([[[1.0, 5.0]], [[3.0, 2.0]]])
        idx, val = rm.best_server(pg)
        self.assertTrue(np.allclose(rm.at_serving(pg, idx), val))


class ServingIsChosenOnRss(unittest.TestCase):

    def test_rss_and_path_gain_can_pick_different_cells(self):
        pg = np.array([[[1.0]], [[10.0]]])
        rss = np.array([[[100.0]], [[10.0]]])
        by_pg, _ = rm.best_server(pg)
        by_rss, _ = rm.best_server(rss)
        self.assertEqual(by_pg.tolist(), [[1]])
        self.assertEqual(by_rss.tolist(), [[0]])
        self.assertNotEqual(by_pg.tolist(), by_rss.tolist())

    def test_they_agree_when_powers_match(self):
        pg = np.array([[[1.0, 9.0]], [[4.0, 2.0]]])
        rss = pg * 3.0
        self.assertEqual(rm.best_server(pg)[0].tolist(), rm.best_server(rss)[0].tolist())


if __name__ == "__main__":
    unittest.main()
