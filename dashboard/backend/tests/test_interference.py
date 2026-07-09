import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import linkkpi


def two_tx(gain_a=1e-6, gain_b=1e-6, nf=8):
    h = np.zeros((1, 1, 2, 2, 1, nf), dtype=complex)
    h[0, 0, 0, :, 0, :] = gain_a
    h[0, 0, 1, :, 0, :] = gain_b
    return h


class NoInterference(unittest.TestCase):

    def test_one_transmitter_reports_no_sinr_rather_than_a_copy_of_the_snr(self):
        h = np.ones((1, 1, 1, 2, 1, 8), dtype=complex) * 1e-6
        k = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertIsNone(k["sinr_db"])
        self.assertIsNone(k["interference_dbm_per_subcarrier"])
        self.assertEqual(k["interferers"], 0)

    def test_an_empty_interferer_list_changes_nothing(self):
        h = two_tx()
        a = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0)
        b = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0,
                              interferers=[])
        self.assertEqual(a["throughput_mbps"]["mrt"], b["throughput_mbps"]["mrt"])

    def test_the_serving_cell_cannot_interfere_with_itself(self):
        h = two_tx()
        k = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0,
                              interferers=[(0, 43.0)])
        self.assertIsNone(k["sinr_db"])
        self.assertEqual(k["interferers"], 0)


class WithInterference(unittest.TestCase):

    def test_an_equal_neighbour_costs_the_beamforming_gain(self):
        k = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0,
                              interferers=[(1, 43.0)])
        self.assertAlmostEqual(k["sinr_db"]["mrt"], 3.01, places=1)

    def test_a_quieter_neighbour_costs_proportionally_less(self):
        strong = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                                   tx=0, interferers=[(1, 43.0)])
        weak = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                                 tx=0, interferers=[(1, 33.0)])
        self.assertAlmostEqual(weak["sinr_db"]["mrt"] - strong["sinr_db"]["mrt"], 10.0, places=1)

    def test_interference_is_reported_in_the_same_units_as_the_noise(self):
        k = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0,
                              interferers=[(1, 43.0)])
        self.assertIsNotNone(k["interference_dbm_per_subcarrier"])
        self.assertGreater(k["interference_dbm_per_subcarrier"],
                           k["noise_dbm_per_subcarrier"])

    def test_the_rates_come_from_sinr_not_snr(self):
        clean = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, tx=0)
        noisy = linkkpi.link_kpis(two_tx(), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                                  tx=0, interferers=[(1, 43.0)])
        self.assertEqual(clean["snr_db"]["mrt"], noisy["snr_db"]["mrt"])
        self.assertLess(noisy["throughput_mbps"]["mrt"], clean["throughput_mbps"]["mrt"])

    def test_a_far_neighbour_barely_matters(self):
        k = linkkpi.link_kpis(two_tx(gain_b=1e-10), tx_power_dbm=43.0,
                              subcarrier_spacing_hz=30e3, tx=0, interferers=[(1, 43.0)])
        clean = linkkpi.link_kpis(two_tx(gain_b=1e-10), tx_power_dbm=43.0,
                                  subcarrier_spacing_hz=30e3, tx=0)
        self.assertLess(abs(k["sinr_db"]["mrt"] - clean["snr_db"]["mrt"]), 0.5)

    def test_a_swamped_link_is_reported_as_swamped(self):
        k = linkkpi.link_kpis(two_tx(gain_a=5e-8, gain_b=5e-6), tx_power_dbm=43.0,
                              subcarrier_spacing_hz=30e3, tx=0, interferers=[(1, 43.0)])
        self.assertGreater(k["snr_db"]["mrt"], 0)
        self.assertLess(k["sinr_db"]["mrt"], -30)
        self.assertLess(k["throughput_mbps"]["mrt"], 1.0)


if __name__ == "__main__":
    unittest.main()
