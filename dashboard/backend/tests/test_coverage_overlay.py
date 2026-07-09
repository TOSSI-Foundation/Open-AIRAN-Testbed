import base64
import io
import sys
import unittest
from pathlib import Path

import numpy as np

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import coverage as cov
import radiomap as rm


def decode(uri):
    from PIL import Image
    assert uri.startswith("data:image/png;base64,"), uri[:40]
    raw = base64.b64decode(uri.split(",", 1)[1])
    return np.array(Image.open(io.BytesIO(raw)).convert("RGBA"))


class Bands(unittest.TestCase):

    def test_contested_cells_are_drawn_opaque(self):
        c = np.array([[True, False]])
        img = decode(cov._render_bands(c, np.zeros((1, 2), bool)))
        self.assertGreater(img[0, 0, 3], 200, "a contested cell should be clearly visible")
        self.assertEqual(img[0, 1, 3], 0, "everything else is transparent")

    def test_sole_server_cells_are_drawn_but_faintly(self):
        so = np.array([[True]])
        img = decode(cov._render_bands(np.zeros((1, 1), bool), so))
        a = int(img[0, 0, 3])
        self.assertGreater(a, 0)
        self.assertLess(a, 160)

    def test_contested_wins_where_a_cell_is_both(self):
        img = decode(cov._render_bands(np.array([[True]]), np.array([[True]])))
        self.assertGreater(img[0, 0, 3], 200)

    def test_an_empty_map_is_fully_transparent(self):
        z = np.zeros((3, 3), bool)
        self.assertEqual(int(decode(cov._render_bands(z, z))[..., 3].sum()), 0)

    def test_the_two_states_are_told_apart_by_colour(self):
        c = decode(cov._render_bands(np.array([[True]]), np.zeros((1, 1), bool)))[0, 0]
        s = decode(cov._render_bands(np.zeros((1, 1), bool), np.array([[True]])))[0, 0]
        self.assertFalse(np.array_equal(c[:3], s[:3]),
                         "contested and sole-server must not render the same colour")


class Scales(unittest.TestCase):

    def test_every_metric_has_its_own_default_range(self):
        self.assertEqual(set(cov._DEFAULT_SCALE), {"path_gain", "rss", "sinr"})

    def test_the_ranges_are_not_all_the_same(self):
        self.assertNotEqual(cov._DEFAULT_SCALE["path_gain"], cov._DEFAULT_SCALE["sinr"])

    def test_each_range_is_ordered(self):
        for name, (lo, hi) in cov._DEFAULT_SCALE.items():
            self.assertLess(lo, hi, name)


class OverlayContract(unittest.TestCase):

    def sample(self, **over):
        pg = np.array([[[1e-9, 1e-12]], [[1.1e-9, 1e-30]]])
        bands = rm.contested(pg)
        out = {
            "type": "coverage_overlay", "metric": "path_gain",
            "image": "data:image/png;base64,AAA",
            "images": {"path_gain": "data:image/png;base64,AAA",
                       "rss": "data:image/png;base64,BBB",
                       "sinr": "data:image/png;base64,CCC"},
            "scales": {k: list(v) for k, v in cov._DEFAULT_SCALE.items()},
            "boundaries": cov._render_bands(bands["contested"], bands["sole"]),
            "contested": {
                "cells": bands["cells_contested"], "served": bands["cells_served"],
                "sole": int(bands["sole"].sum()), "margin_db": bands["threshold_db"],
                "judgeable_fraction": 1.0 - bands["sole"].sum() / bands["cells_served"],
            },
            "coordinates": [[0, 1], [1, 1], [1, 0], [0, 0]],
            "stats": {"covered_cells": 2, "total_cells": 2},
        }
        out.update(over)
        return out

    def test_the_default_metric_image_matches_the_top_level_one(self):
        ov = self.sample()
        self.assertEqual(ov["image"], ov["images"][ov["metric"]])

    def test_every_metric_has_an_image_and_a_scale(self):
        ov = self.sample()
        self.assertEqual(set(ov["images"]), set(ov["scales"]))

    def test_contested_reports_how_much_of_the_map_it_could_judge(self):
        c = self.sample()["contested"]
        self.assertIn("judgeable_fraction", c)
        self.assertGreaterEqual(c["judgeable_fraction"], 0.0)
        self.assertLessEqual(c["judgeable_fraction"], 1.0)

    def test_the_margin_is_carried_so_the_number_can_be_read(self):
        self.assertEqual(self.sample()["contested"]["margin_db"], rm.DEFAULT_MARGIN_DB)

    def test_a_single_transmitter_scene_offers_no_band(self):
        pg = np.array([[[1e-9, 1e-10]]])
        bands = rm.contested(pg)
        self.assertFalse(bands["contested"].any())


if __name__ == "__main__":
    unittest.main()
