import sys
import unittest
from pathlib import Path

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import linkkpi


def detail(**over):
    pth = {"kinds": ["specular"], "bounces": 1, "los": False,
           "delay_s": 7.64101e-07, "gain_db": -87.44, "share": 0.46, "points": []}
    pth.update(over)
    return {"num_paths": 1, "paths": [pth]}


class Distance(unittest.TestCase):

    def test_it_measures_along_the_path_when_geometry_was_traced(self):
        d = detail(points=[[0, 0, 0], [100, 0, 0], [100, 100, 0]])
        row = linkkpi.path_rows(d)[0]
        self.assertEqual(row["distance_m"], 200.0)
        self.assertEqual(row["distance_from"], "vertices")

    def test_a_bounce_makes_the_path_longer_than_the_separation(self):
        straight = linkkpi.path_rows(detail(points=[[0, 0, 0], [300, 0, 0]]))[0]
        bounced = linkkpi.path_rows(detail(points=[[0, 0, 0], [150, 90, 0], [300, 0, 0]]))[0]
        self.assertGreater(bounced["distance_m"], straight["distance_m"])

    def test_without_geometry_the_delay_gives_the_length(self):
        d = detail(points=[], delay_s=1e-06)
        row = linkkpi.path_rows(d, delays_normalized=False)[0]
        self.assertAlmostEqual(row["distance_m"], 299.792, places=2)
        self.assertEqual(row["distance_from"], "delay")

    def test_a_normalised_delay_is_an_excess_not_a_distance(self):
        row = linkkpi.path_rows(detail(points=[], delay_s=0.0), delays_normalized=True)[0]
        self.assertEqual(row["distance_m"], 0.0)
        self.assertEqual(row["distance_from"], "delay_excess")

    def test_geometry_beats_the_delay_fallback(self):
        d = detail(points=[[0, 0, 0], [50, 0, 0]], delay_s=0.0)
        row = linkkpi.path_rows(d, delays_normalized=True)[0]
        self.assertEqual(row["distance_from"], "vertices")
        self.assertEqual(row["distance_m"], 50.0)

    def test_a_single_vertex_is_not_a_path(self):
        row = linkkpi.path_rows(detail(points=[[0, 0, 0]], delay_s=1e-06),
                                delays_normalized=False)[0]
        self.assertEqual(row["distance_from"], "delay")

    def test_no_geometry_and_no_delay_leaves_it_blank(self):
        row = linkkpi.path_rows(detail(points=[], delay_s=None))[0]
        self.assertIsNone(row["distance_m"])
        self.assertEqual(row["distance_from"], "")


class ReceivedPower(unittest.TestCase):

    def test_it_is_the_transmit_power_plus_the_path_gain(self):
        row = linkkpi.path_rows(detail(gain_db=-87.44), tx_power_dbm=43.0)[0]
        self.assertAlmostEqual(row["rss_dbm"], -44.44, places=2)

    def test_an_unknown_transmitter_leaves_it_empty_rather_than_assumed(self):
        self.assertIsNone(linkkpi.path_rows(detail())[0]["rss_dbm"])

    def test_an_unknown_gain_leaves_it_empty_too(self):
        self.assertIsNone(linkkpi.path_rows(detail(gain_db=None), tx_power_dbm=43.0)[0]["rss_dbm"])


class Rows(unittest.TestCase):

    def test_the_interaction_sequence_is_kept_in_order(self):
        row = linkkpi.path_rows(detail(kinds=["specular", "refraction"]))[0]
        self.assertEqual(row["kinds"], "specular|refraction")

    def test_an_unobstructed_path_is_named_rather_than_left_blank(self):
        row = linkkpi.path_rows(detail(kinds=[], los=True, bounces=0))[0]
        self.assertEqual(row["kinds"], "los")
        self.assertTrue(row["los"])

    def test_vertices_are_one_row_not_several(self):
        row = linkkpi.path_rows(detail(points=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]))[0]
        self.assertEqual(row["vertices_enu"], "1.00,2.00,3.00;4.00,5.00,6.00")

    def test_rank_follows_the_order_path_detail_chose(self):
        d = {"num_paths": 2, "paths": [detail()["paths"][0], detail(gain_db=-94.0)["paths"][0]]}
        self.assertEqual([r["rank"] for r in linkkpi.path_rows(d)], [0, 1])

    def test_nothing_traced_is_no_rows(self):
        self.assertEqual(linkkpi.path_rows({"num_paths": 0, "paths": []}), [])


class Csv(unittest.TestCase):

    def test_it_has_a_header_and_one_line_per_path(self):
        d = {"num_paths": 2, "paths": [detail()["paths"][0], detail(gain_db=-94.0)["paths"][0]]}
        lines = linkkpi.paths_csv(d).strip().splitlines()
        self.assertEqual(len(lines), 3)
        self.assertEqual(lines[0], ",".join(linkkpi.PATH_CSV_COLUMNS))

    def test_embedded_geometry_does_not_break_the_columns(self):
        import csv as _csv
        import io
        d = detail(points=[[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]])
        rows = list(_csv.DictReader(io.StringIO(linkkpi.paths_csv(d))))
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["vertices_enu"], "1.00,2.00,3.00;4.00,5.00,6.00")
        self.assertEqual(rows[0]["gain_db"], "-87.44")

    def test_an_empty_solve_still_writes_the_header(self):
        out = linkkpi.paths_csv({"num_paths": 0, "paths": []})
        self.assertEqual(out.strip(), ",".join(linkkpi.PATH_CSV_COLUMNS))

    def test_the_normalisation_flag_reaches_the_rows(self):
        d = detail(points=[], delay_s=0.0)
        self.assertIn("delay_excess", linkkpi.paths_csv(d, delays_normalized=True))
        self.assertNotIn("delay_excess", linkkpi.paths_csv(d, delays_normalized=False))


if __name__ == "__main__":
    unittest.main()
