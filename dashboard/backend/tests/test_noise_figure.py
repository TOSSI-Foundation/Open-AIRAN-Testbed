import sys
import unittest
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import linkkpi
from app import channel_bridge as cb


class NoiseFloor(unittest.TestCase):

    def test_the_thermal_constant_is_kt_at_290_kelvin(self):
        import math
        self.assertAlmostEqual(linkkpi.THERMAL_DBM_HZ,
                               10 * math.log10(1.380649e-23 * 290.0 * 1000), places=2)

    def test_a_higher_noise_figure_raises_the_floor_one_for_one(self):
        a = linkkpi.noise_dbm_per_subcarrier(30e3, noise_figure_db=7.0)
        b = linkkpi.noise_dbm_per_subcarrier(30e3, noise_figure_db=12.0)
        self.assertAlmostEqual(b - a, 5.0, places=9)

    def test_the_default_floor_is_what_the_platform_has_been_reporting(self):
        self.assertAlmostEqual(linkkpi.noise_dbm_per_subcarrier(30e3), -122.209, places=3)

    def test_a_wider_subcarrier_collects_more_noise(self):
        narrow = linkkpi.noise_dbm_per_subcarrier(15e3)
        wide = linkkpi.noise_dbm_per_subcarrier(30e3)
        self.assertAlmostEqual(wide - narrow, 3.0103, places=3)


class Bounds(unittest.TestCase):

    def test_the_default_is_an_ordinary_handset(self):
        self.assertEqual(cb.KPI_NOISE_FIGURE_DB, 7.0)

    def test_the_range_excludes_what_can_only_be_a_typo(self):
        lo, hi = cb.NOISE_FIGURE_RANGE
        self.assertEqual((lo, hi), (0.0, 30.0))
        self.assertFalse(lo <= -5 <= hi)
        self.assertFalse(lo <= 99 <= hi)

    def test_ordinary_receivers_are_inside_it(self):
        lo, hi = cb.NOISE_FIGURE_RANGE
        for nf in (2.0, 7.0, 9.0, 12.0):
            self.assertTrue(lo <= nf <= hi, f"{nf} dB should be allowed")


class Reported(unittest.TestCase):

    def test_the_figure_used_travels_back_with_the_answer(self):
        import numpy as np
        h = np.ones((1, 1, 1, 2, 1, 4), dtype=complex) * 1e-6
        k = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                              noise_figure_db=9.0)
        self.assertEqual(k["noise_figure_db"], 9.0)
        self.assertAlmostEqual(k["noise_dbm_per_subcarrier"],
                               linkkpi.noise_dbm_per_subcarrier(30e3, 9.0), places=9)

    def test_a_noisier_receiver_reports_less_throughput(self):
        import numpy as np
        h = np.ones((1, 1, 1, 2, 1, 4), dtype=complex) * 1e-6
        quiet = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                                  noise_figure_db=2.0)
        noisy = linkkpi.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3,
                                  noise_figure_db=12.0)
        self.assertGreater(quiet["throughput_mbps"]["mrt"], noisy["throughput_mbps"]["mrt"])
        self.assertAlmostEqual(quiet["snr_db"]["mrt"] - noisy["snr_db"]["mrt"], 10.0, places=6)


if __name__ == "__main__":
    unittest.main()
