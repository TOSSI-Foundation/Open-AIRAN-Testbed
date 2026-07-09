import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import batching as bt


class Chunks(unittest.TestCase):
    def test_it_divides_evenly(self):
        self.assertEqual(list(bt.chunks([1, 2, 3, 4], 2)), [[1, 2], [3, 4]])

    def test_the_last_batch_is_short_not_padded(self):
        self.assertEqual(list(bt.chunks([1, 2, 3], 2)), [[1, 2], [3]])

    def test_order_is_preserved(self):
        got = [x for c in bt.chunks(list(range(10)), 3) for x in c]
        self.assertEqual(got, list(range(10)))

    def test_a_batch_larger_than_the_work_is_one_batch(self):
        self.assertEqual(list(bt.chunks([1, 2], 64)), [[1, 2]])

    def test_nothing_to_do_yields_nothing(self):
        self.assertEqual(list(bt.chunks([], 8)), [])

    def test_a_batch_of_one_is_the_unbatched_path(self):
        self.assertEqual(list(bt.chunks([1, 2, 3], 1)), [[1], [2], [3]])

    def test_a_nonsense_batch_size_is_refused(self):
        with self.assertRaises(ValueError):
            list(bt.chunks([1, 2], 0))


class SliceRx(unittest.TestCase):

    def test_a_is_sliced_on_axis_zero(self):
        a = np.arange(2 * 1 * 3 * 1 * 4 * 1).reshape(2, 1, 3, 1, 4, 1)
        got = bt.slice_rx(a, 1, "a")
        self.assertEqual(got.shape, (1, 1, 3, 1, 4, 1))
        self.assertTrue(np.array_equal(got[0], a[1]))

    def test_tau_is_sliced_on_axis_zero(self):
        tau = np.arange(2 * 3 * 4).reshape(2, 3, 4)
        got = bt.slice_rx(tau, 1, "tau")
        self.assertEqual(got.shape, (1, 3, 4))
        self.assertTrue(np.array_equal(got[0], tau[1]))

    def test_interactions_is_sliced_on_axis_one(self):
        inter = np.arange(5 * 2 * 3 * 4).reshape(5, 2, 3, 4)
        got = bt.slice_rx(inter, 1, "interactions")
        self.assertEqual(got.shape, (5, 1, 3, 4))
        self.assertTrue(np.array_equal(got[:, 0], inter[:, 1]))

    def test_slicing_the_wrong_axis_would_give_a_different_answer(self):
        inter = np.arange(5 * 2 * 3 * 4).reshape(5, 2, 3, 4)
        right = bt.slice_rx(inter, 1, "interactions")
        wrong = np.take(inter, [1], axis=0)
        self.assertNotEqual(right.shape, wrong.shape)

    def test_rank_is_preserved(self):
        for kind, shape in (("a", (3, 1, 2, 1, 4, 1)), ("tau", (3, 2, 4)),
                            ("interactions", (5, 3, 2, 4))):
            arr = np.zeros(shape)
            self.assertEqual(bt.slice_rx(arr, 0, kind).ndim, len(shape), kind)

    def test_an_out_of_range_receiver_is_an_error(self):
        with self.assertRaises(IndexError):
            bt.slice_rx(np.zeros((2, 1, 1, 1, 1, 1)), 5, "a")

    def test_an_unknown_kind_is_refused(self):
        with self.assertRaises(ValueError):
            bt.slice_rx(np.zeros((2, 2)), 0, "mystery")

    def test_an_array_too_flat_to_hold_the_axis_is_refused(self):
        with self.assertRaises(ValueError):
            bt.slice_rx(np.zeros(3), 0, "interactions")


class Names(unittest.TestCase):
    def test_names_are_prefixed_so_they_cannot_collide(self):
        names = bt.batch_names(3)
        self.assertEqual(len(set(names)), 3)
        for n in names:
            self.assertTrue(n.startswith("_b"))
            self.assertNotEqual(n, "rx")

    def test_none_wanted_is_none_made(self):
        self.assertEqual(bt.batch_names(0), [])


class Plan(unittest.TestCase):

    def test_it_counts_the_batches(self):
        p = bt.plan(100, 64)
        self.assertEqual(p["batches"], 2)
        self.assertEqual(p["last_batch"], 36)

    def test_an_exact_fit_has_a_full_last_batch(self):
        p = bt.plan(128, 64)
        self.assertEqual(p["batches"], 2)
        self.assertEqual(p["last_batch"], 64)

    def test_a_batch_of_one_reports_itself_as_unbatched(self):
        self.assertFalse(bt.plan(50, 1)["batched"])
        self.assertTrue(bt.plan(50, 64)["batched"])

    def test_a_single_position_is_not_batched_however_large_the_batch(self):
        self.assertFalse(bt.plan(1, 64)["batched"])

    def test_no_work_is_no_batches(self):
        p = bt.plan(0, 64)
        self.assertEqual(p["batches"], 0)
        self.assertEqual(p["last_batch"], 0)

    def test_negative_work_is_refused(self):
        with self.assertRaises(ValueError):
            bt.plan(-1)

    def test_the_default_sits_in_the_measured_basin(self):
        self.assertEqual(bt.DEFAULT_BATCH, 8)

    def test_the_default_is_inside_the_useful_range(self):
        self.assertGreaterEqual(bt.DEFAULT_BATCH, 4)
        self.assertLessEqual(bt.DEFAULT_BATCH, 16)

    def test_batching_is_still_worth_doing_at_the_default(self):
        self.assertTrue(bt.plan(50, bt.DEFAULT_BATCH)["batched"])


class Budget(unittest.TestCase):

    def test_a_batch_gets_a_budget_for_every_receiver_in_it(self):
        out = bt.budget_for({"samples_per_src": 1_000_000}, 8)
        self.assertEqual(out["samples_per_src"], 8_000_000)

    def test_it_scales_by_the_receivers_present_not_the_batch_size_asked_for(self):
        self.assertEqual(bt.budget_for({"samples_per_src": 1_000_000}, 7)["samples_per_src"],
                         7_000_000)

    def test_one_receiver_is_left_alone(self):
        out = bt.budget_for({"samples_per_src": 1_000_000}, 1)
        self.assertEqual(out["samples_per_src"], 1_000_000)

    def test_not_batching_is_left_alone(self):
        out = bt.budget_for({"samples_per_src": 1_000_000}, 4, batched=False)
        self.assertEqual(out["samples_per_src"], 1_000_000)

    def test_it_carries_the_other_switches_through_untouched(self):
        sp = {"samples_per_src": 1000, "diffraction": True, "seed": 42, "los": False}
        out = bt.budget_for(sp, 4)
        self.assertTrue(out["diffraction"])
        self.assertEqual(out["seed"], 42)
        self.assertIs(out["los"], False)

    def test_it_does_not_mutate_what_it_was_given(self):
        sp = {"samples_per_src": 1_000_000}
        bt.budget_for(sp, 8)
        bt.budget_for(sp, 8)
        self.assertEqual(sp["samples_per_src"], 1_000_000)

    def test_the_default_budget_is_assumed_when_none_was_given(self):
        self.assertEqual(bt.budget_for({}, 2)["samples_per_src"], 2_000_000)

    def test_no_parameters_at_all_is_not_a_crash(self):
        self.assertEqual(bt.budget_for(None, 2)["samples_per_src"], 2_000_000)


if __name__ == "__main__":
    unittest.main()
