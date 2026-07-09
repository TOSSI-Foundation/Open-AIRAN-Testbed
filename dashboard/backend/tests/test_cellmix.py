import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import cellmix as cm


class Mixing(unittest.TestCase):
    def test_one_cell_at_unity_is_the_cell(self):
        a = np.array([1 + 2j, 3 - 1j], dtype=np.complex64)
        self.assertTrue(np.allclose(cm.mix([a], [1.0]), a))

    def test_two_cells_add(self):
        a = np.array([1 + 0j, 2 + 0j], dtype=np.complex64)
        b = np.array([10 + 0j, 20 + 0j], dtype=np.complex64)
        self.assertTrue(np.allclose(cm.mix([a, b], [1.0, 1.0]), [11, 22]))

    def test_gains_are_linear_amplitudes_not_decibels(self):
        a = np.array([2 + 0j], dtype=np.complex64)
        b = np.array([2 + 0j], dtype=np.complex64)
        self.assertTrue(np.allclose(cm.mix([a, b], [1.0, 0.5]), [3.0]))

    def test_a_gain_of_zero_removes_a_cell_without_removing_it(self):
        a = np.array([1 + 0j, 1 + 0j], dtype=np.complex64)
        b = np.array([9 + 0j, 9 + 0j], dtype=np.complex64)
        out = cm.mix([a, b], [1.0, 0.0])
        self.assertTrue(np.allclose(out, a))
        self.assertEqual(out.shape, a.shape)

    def test_phase_is_preserved(self):
        a = np.array([1 + 0j], dtype=np.complex64)
        b = np.array([-1 + 0j], dtype=np.complex64)
        self.assertTrue(np.allclose(cm.mix([a, b], [1.0, 1.0]), [0]))

    def test_the_output_keeps_the_wire_dtype(self):
        for dt in (np.complex64, np.int16):
            a = np.ones(4, dtype=dt)
            self.assertEqual(cm.mix([a, a], [1.0, 0.0]).dtype, dt, str(dt))


class Int16Overflow(unittest.TestCase):

    def test_two_loud_cells_clip_instead_of_wrapping(self):
        a = np.array([20000, -20000], dtype=np.int16)
        b = np.array([20000, -20000], dtype=np.int16)
        out = cm.mix([a, b], [1.0, 1.0])
        self.assertEqual(out.dtype, np.int16)
        self.assertEqual(out[0], cm.INT16_MAX, "must clip, not wrap to negative")
        self.assertEqual(out[1], cm.INT16_MIN)

    def test_a_quiet_mix_is_untouched(self):
        a = np.array([1000, -1000], dtype=np.int16)
        out = cm.mix([a, a], [1.0, 1.0])
        self.assertEqual(list(out), [2000, -2000])

    def test_clipping_is_reported_rather_than_discovered(self):
        a = np.array([30000, 100, 100, 100], dtype=np.int16)
        out = cm.mix([a, a], [1.0, 1.0])
        self.assertAlmostEqual(cm.clipped_fraction(out, np.int16), 0.25)

    def test_a_clean_mix_reports_no_clipping(self):
        a = np.array([100, 100], dtype=np.int16)
        out = cm.mix([a, a], [1.0, 1.0])
        self.assertEqual(cm.clipped_fraction(out, np.int16), 0.0)

    def test_float_mixes_never_report_clipping(self):
        a = np.array([1e9 + 0j], dtype=np.complex64)
        self.assertEqual(cm.clipped_fraction(cm.mix([a], [1.0]), np.complex64), 0.0)


class Alignment(unittest.TestCase):

    def test_unequal_lengths_are_refused(self):
        a = np.zeros(4, dtype=np.complex64)
        b = np.zeros(5, dtype=np.complex64)
        with self.assertRaises(ValueError) as e:
            cm.mix([a, b], [1.0, 1.0])
        self.assertIn("same instant", str(e.exception))

    def test_mixed_dtypes_are_refused(self):
        with self.assertRaises(ValueError):
            cm.mix([np.zeros(4, dtype=np.complex64), np.zeros(4, dtype=np.int16)], [1.0, 1.0])

    def test_a_gain_per_cell_is_required(self):
        a = np.zeros(4, dtype=np.complex64)
        with self.assertRaises(ValueError):
            cm.mix([a, a], [1.0])

    def test_nothing_to_mix_is_refused(self):
        with self.assertRaises(ValueError):
            cm.mix([], [])


class Budget(unittest.TestCase):

    def test_a_chunk_knows_how_long_it_is(self):
        self.assertAlmostEqual(cm.budget_ms(240000, 61.44e6), 3.90625, places=4)
        self.assertAlmostEqual(cm.budget_ms(30720, 61.44e6), 0.5, places=6)

    def test_a_nonsense_rate_is_refused(self):
        with self.assertRaises(ValueError):
            cm.budget_ms(1000, 0)

    def test_more_cells_than_can_be_mixed_in_time_are_refused(self):
        a = np.zeros(4, dtype=np.complex64)
        n = cm.MAX_MIXABLE_CELLS + 1
        with self.assertRaises(ValueError) as e:
            cm.mix([a] * n, [1.0] * n)
        self.assertIn("measured limit", str(e.exception))

    def test_the_limit_allows_the_case_this_was_built_for(self):
        self.assertGreaterEqual(cm.MAX_MIXABLE_CELLS, 2)


if __name__ == "__main__":
    unittest.main()
