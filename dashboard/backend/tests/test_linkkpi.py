import math
import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import linkkpi as lk


def cfr(values, num_sc=8):
    v = np.asarray(values, dtype=np.complex64)
    n_tx_ant = v.size
    h = np.zeros((1, 1, 1, n_tx_ant, 1, num_sc), dtype=np.complex64)
    for i in range(n_tx_ant):
        h[0, 0, 0, i, 0, :] = v[i]
    return h


class NoiseFloor(unittest.TestCase):
    def test_thermal_noise_over_one_subcarrier(self):
        n0 = lk.noise_dbm_per_subcarrier(30e3, noise_figure_db=7.0)
        self.assertAlmostEqual(n0, -173.98 + 10 * math.log10(30e3) + 7.0, places=6)
        self.assertAlmostEqual(n0, -122.21, places=2)

    def test_wider_subcarriers_collect_more_noise(self):
        a = lk.noise_dbm_per_subcarrier(15e3)
        b = lk.noise_dbm_per_subcarrier(30e3)
        self.assertAlmostEqual(b - a, 10 * math.log10(2), places=6)

    def test_noise_figure_adds_directly(self):
        base = lk.noise_dbm_per_subcarrier(30e3, noise_figure_db=0.0)
        self.assertAlmostEqual(lk.noise_dbm_per_subcarrier(30e3, 5.0) - base, 5.0, places=6)


class BeamCases(unittest.TestCase):

    KW = dict(tx_power_dbm=43.0, subcarrier_spacing_hz=30e3, noise_figure_db=7.0)

    def test_a_single_port_has_nothing_to_gain(self):
        k = lk.link_kpis(cfr([1.0]), **self.KW)
        self.assertAlmostEqual(k["beamforming_gain_db"], 0.0, places=9)
        self.assertAlmostEqual(k["array_gain_ceiling_db"], 0.0, places=9)
        self.assertEqual(k["num_tx_ant"], 1)

    def test_identical_ports_are_already_matched(self):
        k = lk.link_kpis(cfr([1.0, 1.0, 1.0, 1.0]), **self.KW)
        self.assertAlmostEqual(k["beamforming_gain_db"], 0.0, places=6)
        self.assertAlmostEqual(k["array_gain_ceiling_db"], 10 * math.log10(4), places=9)

    def test_a_channel_that_nulls_the_uniform_beam(self):
        k = lk.link_kpis(cfr([1.0, -1.0, 1.0, -1.0]), **self.KW)
        self.assertIsNone(k["beamforming_gain_db"])
        self.assertGreater(k["snr_db"]["mrt"], 0.0)

    def test_a_hand_computed_gain(self):
        k = lk.link_kpis(cfr([1.0, 1.0, 0.0, 0.0]), **self.KW)
        self.assertAlmostEqual(k["beamforming_gain_db"], 10 * math.log10(2.0), places=6)

    def test_snr_matches_the_link_budget_by_hand(self):
        k = lk.link_kpis(cfr([1.0], num_sc=8), **self.KW)
        expect = 43.0 - 10 * math.log10(8) - lk.noise_dbm_per_subcarrier(30e3, 7.0)
        self.assertAlmostEqual(k["snr_db"]["mrt"], expect, places=6)

    def test_spectral_efficiency_is_shannon(self):
        k = lk.link_kpis(cfr([1.0], num_sc=8), **self.KW)
        snr = 10 ** (k["snr_db"]["mrt"] / 10.0)
        self.assertAlmostEqual(k["spectral_efficiency_bps_hz"]["mrt"],
                               math.log2(1 + snr), places=5)

    def test_no_csi_loses_exactly_the_array_gain(self):
        h = cfr([1.0, 1.0, 1.0, 1.0], num_sc=4)
        k = lk.link_kpis(h, **self.KW)
        snr_mrt = 10 ** (k["snr_db"]["mrt"] / 10.0)
        se_expected = math.log2(1 + snr_mrt / 4.0)
        self.assertAlmostEqual(k["spectral_efficiency_bps_hz"]["no_csi"], se_expected, places=5)

    def test_matched_weights_are_never_worse(self):
        rng = np.random.default_rng(7)
        for _ in range(20):
            v = rng.normal(size=4) + 1j * rng.normal(size=4)
            k = lk.link_kpis(cfr(v), **self.KW)
            self.assertGreaterEqual(k["snr_db"]["mrt"] + 1e-9, k["snr_db"]["uniform_beam"])

    def test_throughput_is_efficiency_times_the_grid(self):
        k = lk.link_kpis(cfr([1.0], num_sc=64), **self.KW)
        bw = 64 * 30e3
        self.assertAlmostEqual(k["bandwidth_hz"], bw, places=6)
        self.assertAlmostEqual(k["throughput_mbps"]["mrt"],
                               k["spectral_efficiency_bps_hz"]["mrt"] * bw / 1e6, places=6)

    def test_a_dead_link_reports_zero_rather_than_raising(self):
        k = lk.link_kpis(cfr([0.0, 0.0, 0.0, 0.0]), **self.KW)
        self.assertAlmostEqual(k["spectral_efficiency_bps_hz"]["mrt"], 0.0, places=9)
        self.assertEqual(k["effective_rank"], 0.0)


class Rank(unittest.TestCase):

    def test_a_single_receive_port_can_only_carry_one(self):
        k = lk.link_kpis(cfr([1.0, 0.5, 0.25, 0.1]),
                         tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertEqual(k["max_rank"], 1)
        self.assertAlmostEqual(k["effective_rank"], 1.0, places=9)

    def test_a_condition_number_is_withheld_when_it_would_be_meaningless(self):
        k = lk.link_kpis(cfr([1.0, 1.0]), tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertIsNone(k["condition_number"])

    def test_two_equal_streams_give_a_rank_of_two(self):
        h = np.zeros((1, 2, 1, 2, 1, 4), dtype=np.complex64)
        h[0, 0, 0, 0, 0, :] = 1.0
        h[0, 1, 0, 1, 0, :] = 1.0
        k = lk.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertEqual(k["max_rank"], 2)
        self.assertAlmostEqual(k["effective_rank"], 2.0, places=6)
        self.assertAlmostEqual(k["condition_number"], 1.0, places=6)

    def test_an_unbalanced_pair_ranks_below_two(self):
        h = np.zeros((1, 2, 1, 2, 1, 4), dtype=np.complex64)
        h[0, 0, 0, 0, 0, :] = 1.0
        h[0, 1, 0, 1, 0, :] = 0.05
        k = lk.link_kpis(h, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertLess(k["effective_rank"], 1.2)
        self.assertAlmostEqual(k["condition_number"], 20.0, places=4)


class CoherenceBandwidth(unittest.TestCase):

    def test_a_flat_channel_never_decorrelates(self):
        out = lk.coherence_bandwidth(np.ones((16, 1, 1), dtype=np.complex64), 30e3)
        self.assertIsNone(out["bc_50_hz"])
        self.assertIsNone(out["bc_90_hz"])

    def test_a_grid_too_narrow_to_measure(self):
        out = lk.coherence_bandwidth(np.ones((1, 1, 1), dtype=np.complex64), 30e3)
        self.assertIsNone(out["bc_50_hz"])

    def test_an_uncorrelated_channel_decorrelates_immediately(self):
        rng = np.random.default_rng(3)
        h = (rng.normal(size=(512, 1, 1)) + 1j * rng.normal(size=(512, 1, 1))).astype(np.complex64)
        out = lk.coherence_bandwidth(h, 30e3)
        self.assertIsNotNone(out["bc_50_hz"])
        self.assertLessEqual(out["bc_50_hz"], 4 * 30e3)

    def test_a_longer_echo_narrows_the_coherence_bandwidth(self):
        scs, nf = 30e3, 1024
        f = np.arange(nf) * scs

        def two_tap(delay_s):
            h = 1.0 + np.exp(-2j * np.pi * f * delay_s)
            return h.reshape(nf, 1, 1).astype(np.complex64)

        short = lk.coherence_bandwidth(two_tap(0.5e-6), scs)["bc_50_hz"]
        long = lk.coherence_bandwidth(two_tap(4e-6), scs)["bc_50_hz"]
        self.assertIsNotNone(short)
        self.assertIsNotNone(long)
        self.assertLess(long, short)

    def test_the_ninety_percent_width_is_never_wider_than_the_fifty(self):
        rng = np.random.default_rng(11)
        h = (rng.normal(size=(256, 1, 1)) + 1j * rng.normal(size=(256, 1, 1))).astype(np.complex64)
        out = lk.coherence_bandwidth(h, 30e3)
        if out["bc_50_hz"] is not None and out["bc_90_hz"] is not None:
            self.assertLessEqual(out["bc_90_hz"], out["bc_50_hz"])


class DelaySpread(unittest.TestCase):

    @staticmethod
    def _paths(delays, powers, n_tx_ant=1):
        n = len(delays)
        tau = np.array(delays, dtype=np.float64).reshape(1, 1, n)
        a = np.zeros((1, 1, 1, n_tx_ant, n, 1), dtype=np.complex64)
        for i, p in enumerate(powers):
            a[0, 0, 0, 0, i, 0] = math.sqrt(p)
        return tau, a

    def test_a_single_path_has_no_spread(self):
        tau, a = self._paths([1e-6], [1.0])
        out = lk.rms_delay_spread(tau, a)
        self.assertAlmostEqual(out["rms_delay_spread_s"], 0.0, places=15)
        self.assertAlmostEqual(out["mean_delay_s"], 1e-6, places=12)

    def test_two_equal_paths_by_hand(self):
        tau, a = self._paths([0.0, 100e-9], [1.0, 1.0])
        out = lk.rms_delay_spread(tau, a)
        self.assertAlmostEqual(out["mean_delay_s"], 50e-9, places=15)
        self.assertAlmostEqual(out["rms_delay_spread_s"], 50e-9, places=15)
        self.assertEqual(out["num_paths"], 2)

    def test_power_weighting_pulls_the_mean(self):
        tau, a = self._paths([0.0, 100e-9], [0.99, 0.01])
        out = lk.rms_delay_spread(tau, a)
        self.assertAlmostEqual(out["mean_delay_s"], 1e-9, places=15)

    def test_the_broadcast_delay_form_is_accepted(self):
        tau, a = self._paths([0.0, 100e-9], [1.0, 1.0], n_tx_ant=4)
        wide = np.broadcast_to(tau[:, None, :, None, :], (1, 1, 1, 4, 2)).copy()
        self.assertAlmostEqual(lk.rms_delay_spread(wide, a)["rms_delay_spread_s"],
                               lk.rms_delay_spread(tau, a)["rms_delay_spread_s"], places=15)

    def test_a_solve_that_found_nothing(self):
        tau = np.zeros((1, 1, 0))
        a = np.zeros((1, 1, 1, 1, 0, 1), dtype=np.complex64)
        out = lk.rms_delay_spread(tau, a)
        self.assertIsNone(out["rms_delay_spread_s"])
        self.assertEqual(out["num_paths"], 0)


class TensorShape(unittest.TestCase):
    def test_the_cfr_layout_is_required(self):
        with self.assertRaises(ValueError):
            lk.link_kpis(np.ones((4, 4), dtype=np.complex64),
                         tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)

    def test_a_named_link_is_selected_out_of_a_multi_device_tensor(self):
        h = np.zeros((2, 1, 3, 1, 1, 4), dtype=np.complex64)
        h[1, 0, 2, 0, 0, :] = 2.0
        weak = lk.link_kpis(h, rx=0, tx=0, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        strong = lk.link_kpis(h, rx=1, tx=2, tx_power_dbm=43.0, subcarrier_spacing_hz=30e3)
        self.assertEqual(weak["spectral_efficiency_bps_hz"]["mrt"], 0.0)
        self.assertGreater(strong["spectral_efficiency_bps_hz"]["mrt"], 0.0)
        self.assertAlmostEqual(strong["path_gain_db"], 10 * math.log10(4.0), places=5)


if __name__ == "__main__":
    unittest.main()


class InteractionNames(unittest.TestCase):

    def test_the_codes_are_the_ones_sionna_uses(self):
        self.assertEqual(lk.INTERACTION_NONE, 0)
        self.assertEqual(lk.INTERACTION_SPECULAR, 1)
        self.assertEqual(lk.INTERACTION_DIFFUSE, 2)
        self.assertEqual(lk.INTERACTION_REFRACTION, 4)
        self.assertEqual(lk.INTERACTION_DIFFRACTION, 8)

    def test_each_code_names_itself(self):
        self.assertEqual(lk.interaction_name(0), "none")
        self.assertEqual(lk.interaction_name(1), "specular")
        self.assertEqual(lk.interaction_name(2), "diffuse")
        self.assertEqual(lk.interaction_name(4), "refraction")
        self.assertEqual(lk.interaction_name(8), "diffraction")

    def test_a_combined_bounce_names_every_part(self):
        self.assertEqual(lk.interaction_name(5), "specular+refraction")

    def test_an_unknown_code_says_so_rather_than_guessing(self):
        self.assertIn("unknown", lk.interaction_name(64))


class PathDetail(unittest.TestCase):

    @staticmethod
    def _solve(kinds_per_path, delays, powers, depth=5):
        n = len(kinds_per_path)
        inter = np.zeros((depth, 1, 1, n), dtype=np.uint32)
        for i, kinds in enumerate(kinds_per_path):
            for d, k in enumerate(kinds):
                inter[d, 0, 0, i] = k
        tau = np.array(delays, dtype=np.float64).reshape(1, 1, n)
        a = np.zeros((1, 1, 1, 1, n, 1), dtype=np.complex64)
        for i, p in enumerate(powers):
            a[0, 0, 0, 0, i, 0] = math.sqrt(p)
        return inter, tau, a

    def test_a_direct_path_is_line_of_sight(self):
        inter, tau, a = self._solve([[]], [1e-6], [1.0])
        out = lk.path_detail(inter, tau, a)
        self.assertTrue(out["los"])
        self.assertEqual(out["paths"][0]["bounces"], 0)
        self.assertEqual(out["paths"][0]["kinds"], [])
        self.assertEqual(out["interaction_counts"], {})

    def test_the_new_delhi_link_is_not_line_of_sight(self):
        inter, tau, a = self._solve([[4, 4], [4, 4, 1]], [646e-9, 648.22e-9], [1.0, 0.5])
        out = lk.path_detail(inter, tau, a)
        self.assertFalse(out["los"])
        self.assertEqual(out["interaction_counts"], {"specular": 1, "refraction": 4})
        self.assertEqual([p["bounces"] for p in out["paths"]], [2, 3])
        self.assertEqual(out["paths"][0]["kinds"], ["refraction", "refraction"])
        self.assertEqual(out["paths"][1]["kinds"], ["refraction", "refraction", "specular"])

    def test_one_unobstructed_path_makes_the_link_line_of_sight(self):
        inter, tau, a = self._solve([[1, 1], []], [1e-6, 0.5e-6], [1.0, 1e-6])
        out = lk.path_detail(inter, tau, a)
        self.assertTrue(out["los"])

    def test_paths_are_listed_strongest_first(self):
        inter, tau, a = self._solve([[1], [], [1, 1]], [3e-6, 1e-6, 2e-6], [0.2, 1.0, 0.5])
        out = lk.path_detail(inter, tau, a)
        gains = [p["gain_db"] for p in out["paths"]]
        self.assertEqual(gains, sorted(gains, reverse=True))
        self.assertTrue(out["paths"][0]["los"])

    def test_shares_account_for_all_the_power(self):
        inter, tau, a = self._solve([[], [1]], [1e-6, 2e-6], [0.75, 0.25])
        out = lk.path_detail(inter, tau, a)
        self.assertAlmostEqual(sum(p["share"] for p in out["paths"]), 1.0, places=6)
        self.assertAlmostEqual(out["paths"][0]["share"], 0.75, places=6)

    def test_the_first_arrival_is_the_earliest_not_the_strongest(self):
        inter, tau, a = self._solve([[1], []], [5e-6, 2e-6], [1.0, 0.01])
        out = lk.path_detail(inter, tau, a)
        self.assertAlmostEqual(out["first_arrival_s"], 2e-6, places=12)

    def test_only_the_strongest_are_listed_but_all_are_counted(self):
        n = 40
        inter, tau, a = self._solve([[1]] * n, [i * 1e-8 for i in range(n)],
                                    [1.0 / (i + 1) for i in range(n)])
        out = lk.path_detail(inter, tau, a, top_n=5)
        self.assertEqual(out["num_paths"], n)
        self.assertEqual(out["num_paths_listed"], 5)
        self.assertEqual(out["interaction_counts"]["specular"], n)

    def test_a_solve_that_found_nothing(self):
        inter = np.zeros((5, 1, 1, 0), dtype=np.uint32)
        tau = np.zeros((1, 1, 0))
        a = np.zeros((1, 1, 1, 1, 0, 1), dtype=np.complex64)
        out = lk.path_detail(inter, tau, a)
        self.assertFalse(out["los"])
        self.assertEqual(out["num_paths"], 0)
        self.assertIsNone(out["first_arrival_s"])
        self.assertEqual(out["paths"], [])

    def test_a_named_link_is_selected_out_of_a_multi_device_solve(self):
        inter = np.zeros((5, 2, 3, 2), dtype=np.uint32)
        inter[0, 1, 2, :] = 4
        tau = np.full((2, 3, 2), 1e-6)
        a = np.zeros((2, 1, 3, 1, 2, 1), dtype=np.complex64)
        a[0, 0, 0, 0, :, 0] = 1.0
        a[1, 0, 2, 0, :, 0] = 1.0
        direct = lk.path_detail(inter, tau, a, rx=0, tx=0)
        other = lk.path_detail(inter, tau, a, rx=1, tx=2)
        self.assertTrue(direct["los"])
        self.assertFalse(other["los"])
        self.assertEqual(other["interaction_counts"], {"refraction": 2})

    def test_a_link_the_solver_found_nothing_for_is_not_line_of_sight(self):
        inter = np.zeros((5, 2, 1, 2), dtype=np.uint32)
        tau = np.full((2, 1, 2), 1e-6)
        a = np.zeros((2, 1, 1, 1, 2, 1), dtype=np.complex64)
        a[1, 0, 0, 0, :, 0] = 1.0
        empty = lk.path_detail(inter, tau, a, rx=0, tx=0)
        self.assertFalse(empty["los"])
        self.assertEqual(empty["num_paths"], 0)
        self.assertIsNone(empty["first_arrival_s"])

    def test_padding_from_a_batched_solve_is_not_counted(self):
        inter = np.zeros((5, 1, 1, 3), dtype=np.uint32)
        inter[0, 0, 0, 0] = 4
        inter[0, 0, 0, 1] = 4
        tau = np.full((1, 1, 3), 1e-6)
        a = np.zeros((1, 1, 1, 1, 3, 1), dtype=np.complex64)
        a[0, 0, 0, 0, 0, 0] = 1.0
        a[0, 0, 0, 0, 1, 0] = 0.5
        out = lk.path_detail(inter, tau, a)
        self.assertEqual(out["num_paths"], 2)
        self.assertFalse(out["los"], "the empty slot must not read as a clear path")
        self.assertEqual(out["interaction_counts"], {"refraction": 2})

    def test_the_array_layout_is_required(self):
        with self.assertRaises(ValueError):
            lk.path_detail(np.zeros((5, 2)), np.zeros((1, 1, 2)),
                           np.zeros((1, 1, 1, 1, 2, 1), dtype=np.complex64))


class ReportedPrecision(unittest.TestCase):

    def test_delays_are_quoted_to_the_picosecond(self):
        inter = np.zeros((5, 1, 1, 1), dtype=np.uint32)
        tau = np.array([[[2.2180870473675895e-09]]])
        a = np.ones((1, 1, 1, 1, 1, 1), dtype=np.complex64)
        out = lk.path_detail(inter, tau, a)
        self.assertEqual(out["paths"][0]["delay_s"], 2.218e-09)

    def test_two_delays_a_femtosecond_apart_report_the_same(self):
        inter = np.zeros((5, 1, 1, 1), dtype=np.uint32)
        a = np.ones((1, 1, 1, 1, 1, 1), dtype=np.complex64)
        first = lk.path_detail(inter, np.array([[[2.2180302039487287e-09]]]), a)
        second = lk.path_detail(inter, np.array([[[2.2180870473675895e-09]]]), a)
        self.assertEqual(first["paths"][0]["delay_s"], second["paths"][0]["delay_s"])

    def test_gains_a_thousandth_of_a_db_apart_report_the_same(self):
        inter = np.zeros((5, 1, 1, 1), dtype=np.uint32)
        tau = np.zeros((1, 1, 1))

        def gain_of(scale):
            a = np.full((1, 1, 1, 1, 1, 1), scale, dtype=np.complex64)
            return lk.path_detail(inter, tau, a)["paths"][0]["gain_db"]

        self.assertEqual(gain_of(1.0), gain_of(1.0 * 10 ** (0.001 / 20)))

    def test_the_delay_spread_is_rounded_too(self):
        tau = np.array([[[0.0, 100.0000004e-9]]])
        a = np.zeros((1, 1, 1, 1, 2, 1), dtype=np.complex64)
        a[0, 0, 0, 0, :, 0] = 1.0
        out = lk.rms_delay_spread(tau, a)
        self.assertEqual(out["rms_delay_spread_s"], round(out["rms_delay_spread_s"], 12))

    def test_a_missing_spread_stays_missing(self):
        tau = np.zeros((1, 1, 0))
        a = np.zeros((1, 1, 1, 1, 0, 1), dtype=np.complex64)
        self.assertIsNone(lk.rms_delay_spread(tau, a)["rms_delay_spread_s"])


class RayGeometry(unittest.TestCase):

    TX = [515.83, -20.0, 43.0]
    RX = [326.92, -10.14, 1.5]

    def _solve(self, kinds, verts, depth=5):
        inter = np.zeros((depth, 1, 1, 1), dtype=np.uint32)
        v = np.zeros((depth, 1, 1, 1, 3), dtype=np.float32)
        for d, k in enumerate(kinds):
            inter[d, 0, 0, 0] = k
        for d, pt in enumerate(verts):
            v[d, 0, 0, 0] = pt
        return v, inter

    def test_a_direct_path_is_two_points(self):
        v, inter = self._solve([], [])
        pts = lk.ray_points(v, inter, self.TX, self.RX)
        self.assertEqual(pts, [self.TX, self.RX])

    def test_the_real_two_bounce_path(self):
        v, inter = self._solve([4, 4], [[502.18, -19.29, 40.0], [497.86, -19.06, 39.05]])
        pts = lk.ray_points(v, inter, self.TX, self.RX)
        self.assertEqual(len(pts), 4)
        self.assertEqual(pts[0], self.TX)
        self.assertEqual(pts[-1], self.RX)
        self.assertEqual(pts[1], [502.18, -19.29, 40.0])

    def test_the_unused_slots_are_not_drawn(self):
        v, inter = self._solve(
            [4, 4],
            [[502.18, -19.29, 40.0], [497.86, -19.06, 39.05],
             [515.83, -20.0, 43.0],
             [515.83, -20.0, -43.0]])
        pts = lk.ray_points(v, inter, self.TX, self.RX)
        self.assertEqual(len(pts), 4)
        self.assertNotIn([515.83, -20.0, -43.0], pts)
        self.assertEqual(sum(1 for p in pts if p == self.TX), 1)

    def test_a_ground_bounce_keeps_its_zero_height(self):
        v, inter = self._solve([4, 4, 1], [[503.1, -19.33, 40.0], [497.86, -19.06, 38.77],
                                           [333.29, -10.47, 0.0]])
        pts = lk.ray_points(v, inter, self.TX, self.RX)
        self.assertEqual(len(pts), 5)
        self.assertEqual(pts[3], [333.29, -10.47, 0.0])

    def test_a_path_using_every_slot(self):
        v, inter = self._solve([1, 1, 1, 1, 1], [[float(i), 0.0, 1.0] for i in range(5)])
        self.assertEqual(len(lk.ray_points(v, inter, self.TX, self.RX)), 7)

    def test_coordinates_come_back_at_centimetre_precision(self):
        v, inter = self._solve([1], [[1.23456789, 2.3456789, 3.456789]])
        self.assertEqual(lk.ray_points(v, inter, self.TX, self.RX)[1],
                         [1.23, 2.35, 3.46])

    def test_the_array_layout_is_required(self):
        inter = np.zeros((5, 1, 1, 1), dtype=np.uint32)
        with self.assertRaises(ValueError):
            lk.ray_points(np.zeros((5, 1, 1, 1)), inter, self.TX, self.RX)

    def test_path_detail_carries_geometry_when_asked(self):
        v, inter = self._solve([4, 4], [[502.18, -19.29, 40.0], [497.86, -19.06, 39.05]])
        tau = np.array([[[0.0]]])
        a = np.ones((1, 1, 1, 1, 1, 1), dtype=np.complex64)
        with_geo = lk.path_detail(inter, tau, a, vertices=v,
                                  tx_position=self.TX, rx_position=self.RX)
        self.assertIn("points", with_geo["paths"][0])
        self.assertEqual(len(with_geo["paths"][0]["points"]), 4)

    def test_path_detail_omits_geometry_when_not_asked(self):
        v, inter = self._solve([4, 4], [[502.18, -19.29, 40.0], [497.86, -19.06, 39.05]])
        tau = np.array([[[0.0]]])
        a = np.ones((1, 1, 1, 1, 1, 1), dtype=np.complex64)
        self.assertNotIn("points", lk.path_detail(inter, tau, a)["paths"][0])
