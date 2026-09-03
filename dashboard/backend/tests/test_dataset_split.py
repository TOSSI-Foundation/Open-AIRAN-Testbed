import sys
import unittest
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from app import dataset


class GroupKey(unittest.TestCase):
    def test_a_position_becomes_a_stable_key(self):
        self.assertEqual(dataset.group_key([329.0, -10.27]), "329.00,-10.27")

    def test_the_same_spot_on_a_later_lap_is_the_same_group(self):
        self.assertEqual(dataset.group_key([100.0, 5.0]), dataset.group_key([100.0, 5.0]))

    def test_it_rounds_to_centimetres_like_the_enrichment_does(self):
        self.assertEqual(dataset.group_key([1.234567, 2.0]), "1.23,2.00")

    def test_positions_a_metre_apart_are_different_groups(self):
        self.assertNotEqual(dataset.group_key([1.0, 0.0]), dataset.group_key([2.0, 0.0]))

    def test_a_missing_position_has_no_group(self):
        for bad in (None, [], [1.0]):
            self.assertIsNone(dataset.group_key(bad))

    def test_nonsense_does_not_raise(self):
        self.assertIsNone(dataset.group_key(["east", "north"]))


class SplitAdvice(unittest.TestCase):
    def test_it_counts_rather_than_asserts(self):
        rows = [{"group": "a"}, {"group": "a"}, {"group": "b"}, {"group": "b"}]
        out = dataset.split_advice(rows)
        self.assertEqual(out["rows"], 4)
        self.assertEqual(out["distinct_groups"], 2)
        self.assertEqual(out["rows_per_group"], 2.0)

    def test_repeated_positions_are_flagged_as_leaking(self):
        rows = [{"group": "a"}, {"group": "a"}, {"group": "b"}]
        self.assertTrue(dataset.split_advice(rows)["random_split_leaks"])

    def test_one_row_per_position_does_not_leak(self):
        rows = [{"group": "a"}, {"group": "b"}, {"group": "c"}]
        out = dataset.split_advice(rows)
        self.assertEqual(out["rows_per_group"], 1.0)
        self.assertFalse(out["random_split_leaks"])

    def test_rows_without_a_group_are_not_counted_as_one(self):
        rows = [{"group": "a"}, {"group": None}, {"group": None}]
        self.assertEqual(dataset.split_advice(rows)["distinct_groups"], 1)

    def test_nothing_to_split_says_nothing(self):
        out = dataset.split_advice([])
        self.assertEqual(out["distinct_groups"], 0)
        self.assertFalse(out["random_split_leaks"])

    def test_it_names_what_to_group_by(self):
        out = dataset.split_advice([{"group": "a"}])
        self.assertEqual(out["group_by"], "group")
        self.assertIn("memorisation", out["why"])


class Schema(unittest.TestCase):
    def test_the_schema_carries_the_split_rule(self):
        sp = dataset.schema().get("split")
        self.assertIsNotNone(sp)
        self.assertEqual(sp["group_by"], "group")

    def test_group_is_a_key_not_a_feature(self):
        col = [c for c in dataset.COLUMNS if c["key"] == "group"][0]
        self.assertEqual(col["role"], "key")
        self.assertNotIn("group", dataset.FEATURE_KEYS)


if __name__ == "__main__":
    unittest.main()
