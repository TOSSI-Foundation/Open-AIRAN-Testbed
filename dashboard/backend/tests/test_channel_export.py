import json
import zipfile
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import numpy as np

from app import channel_bridge as cb


def err(v):
    return isinstance(v, str)


class CleanExportOpts(unittest.TestCase):

    def test_an_empty_request_is_the_default_export(self):
        o = cb.clean_export_opts({})
        self.assertFalse(err(o))
        self.assertEqual(o["subcarriers"], 0)
        self.assertEqual(o["subcarrier_spacing_hz"], 30e3)
        self.assertEqual(o["srate"], 61.44e6)
        self.assertFalse(o["reverse_direction"])
        self.assertTrue(o["normalize_delays"])

    def test_the_scenes_own_max_depth_is_the_default(self):
        self.assertEqual(cb.clean_export_opts({}, 7)["max_depth"], 7)


    def test_a_zero_subcarrier_spacing_is_refused_not_replaced(self):
        out = cb.clean_export_opts({"subcarrier_spacing_hz": 0})
        self.assertTrue(err(out))
        self.assertIn("subcarrier_spacing_hz", out)

    def test_a_max_depth_of_zero_is_honoured_not_replaced(self):
        o = cb.clean_export_opts({"max_depth": 0}, 5)
        self.assertFalse(err(o))
        self.assertEqual(o["max_depth"], 0)

    def test_a_zero_srate_is_refused_not_replaced(self):
        self.assertTrue(err(cb.clean_export_opts({"srate": 0})))

    def test_omitted_and_blank_both_fall_back(self):
        for body in ({}, {"subcarrier_spacing_hz": None}, {"subcarrier_spacing_hz": ""}):
            o = cb.clean_export_opts(body)
            self.assertFalse(err(o), body)
            self.assertEqual(o["subcarrier_spacing_hz"], 30e3)


    def test_subcarrier_range(self):
        self.assertFalse(err(cb.clean_export_opts({"subcarriers": 0})))
        self.assertFalse(err(cb.clean_export_opts({"subcarriers": cb.MAX_SUBCARRIERS})))
        self.assertTrue(err(cb.clean_export_opts({"subcarriers": cb.MAX_SUBCARRIERS + 1})))
        self.assertTrue(err(cb.clean_export_opts({"subcarriers": -1})))

    def test_spacing_range(self):
        self.assertFalse(err(cb.clean_export_opts({"subcarrier_spacing_hz": 15e3})))
        self.assertFalse(err(cb.clean_export_opts({"subcarrier_spacing_hz": 1e6})))
        self.assertTrue(err(cb.clean_export_opts({"subcarrier_spacing_hz": 1e6 + 1})))
        self.assertTrue(err(cb.clean_export_opts({"subcarrier_spacing_hz": -30e3})))

    def test_max_depth_range(self):
        self.assertFalse(err(cb.clean_export_opts({"max_depth": 12})))
        self.assertTrue(err(cb.clean_export_opts({"max_depth": 13})))
        self.assertTrue(err(cb.clean_export_opts({"max_depth": -1})))

    def test_values_that_are_not_numbers(self):
        for body in ({"subcarriers": "lots"}, {"srate": "fast"}, {"max_depth": []}):
            self.assertTrue(err(cb.clean_export_opts(body)), body)

    def test_numeric_strings_are_accepted(self):
        o = cb.clean_export_opts({"subcarriers": "128", "subcarrier_spacing_hz": "15000"})
        self.assertEqual(o["subcarriers"], 128)
        self.assertEqual(o["subcarrier_spacing_hz"], 15e3)

    def test_direction_and_normalisation_are_flags(self):
        o = cb.clean_export_opts({"reverse_direction": True, "normalize_delays": False})
        self.assertTrue(o["reverse_direction"])
        self.assertFalse(o["normalize_delays"])


class ExportNames(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self._orig = cb.EXPORTS
        cb.EXPORTS = self.dir
        self.addCleanup(lambda: setattr(cb, "EXPORTS", self._orig))
        (self.dir / "scene_dl_20260818.npz").write_bytes(b"x")

    def test_a_real_export_resolves(self):
        p = cb._export_path("scene_dl_20260818.npz")
        self.assertIsNotNone(p)
        self.assertEqual(p.name, "scene_dl_20260818.npz")

    def test_a_name_that_is_not_there(self):
        self.assertIsNone(cb._export_path("no_such_file.npz"))

    def test_nothing_escapes_the_export_directory(self):
        for name in ("../../../etc/passwd", "..", "/etc/passwd", "a/../../b",
                     "sub/dir.npz", "", "  "):
            self.assertIsNone(cb._export_path(name), name)

    def test_a_symlink_pointing_outside_is_refused(self):
        outside = self.dir.parent / "outside.npz"
        outside.write_bytes(b"secret")
        self.addCleanup(lambda: outside.unlink(missing_ok=True))
        try:
            (self.dir / "link.npz").symlink_to(outside)
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not available here")
        self.assertIsNone(cb._export_path("link.npz"))


class TauBroadcast(unittest.TestCase):

    @staticmethod
    def _broadcast(tau, n_rx_ant, n_tx_ant):
        if tau.ndim != 3:
            return tau
        num_rx, num_tx, num_paths = tau.shape
        out = tau[:, None, :, None, :]
        return np.broadcast_to(out, (num_rx, n_rx_ant, num_tx, n_tx_ant, num_paths)).copy()

    def test_shape_matches_the_coefficient_tensor(self):
        tau = np.zeros((2, 3, 5))
        out = self._broadcast(tau, n_rx_ant=1, n_tx_ant=4)
        self.assertEqual(out.shape, (2, 1, 3, 4, 5))

    def test_every_antenna_port_carries_the_same_delay(self):
        tau = np.arange(2 * 3 * 5, dtype=float).reshape(2, 3, 5)
        out = self._broadcast(tau, 2, 4)
        for r in range(2):
            for t in range(4):
                np.testing.assert_array_equal(out[:, r, :, t, :], tau)

    def test_the_real_shape_from_a_solved_scene(self):
        out = self._broadcast(np.zeros((1, 1, 2)), 1, 4)
        self.assertEqual(out.shape, (1, 1, 1, 4, 2))

    def test_an_already_broadcast_tensor_is_left_alone(self):
        tau = np.zeros((1, 1, 1, 4, 2))
        self.assertIs(self._broadcast(tau, 1, 4), tau)

    def test_the_result_is_writable(self):
        out = self._broadcast(np.zeros((1, 1, 2)), 1, 4)
        out[0, 0, 0, 0, 0] = 1.0
        self.assertEqual(out[0, 0, 0, 0, 0], 1.0)


if __name__ == "__main__":
    unittest.main()


class BundleFacts(unittest.TestCase):

    def _zip(self, manifest):
        d = Path(self._tmp.name)
        p = d / "s_bundle_x.zip"
        with zipfile.ZipFile(p, "w") as z:
            if manifest is not None:
                z.writestr("manifest.json", json.dumps(manifest))
            z.writestr("scene.xml", "<scene/>")
        return p

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_it_reports_what_the_manifest_recorded(self):
        p = self._zip({"city": "New Delhi", "nof_meshes": 621,
                       "link_gain_db": {"UE-n2": -84.07}, "link_paths": {"UE-n2": 33}})
        got = cb._bundle_facts(p)
        self.assertEqual(got["link_gain_db"], {"UE-n2": -84.07})
        self.assertEqual(got["link_paths"], {"UE-n2": 33})
        self.assertEqual(got["nof_meshes"], 621)
        self.assertEqual(got["city"], "New Delhi")

    def test_an_untraced_bundle_offers_no_gain(self):
        got = cb._bundle_facts(self._zip({"city": "New Delhi", "nof_meshes": 4}))
        self.assertNotIn("link_gain_db", got)
        self.assertNotIn("link_paths", got)

    def test_a_damaged_bundle_costs_a_row_not_the_listing(self):
        d = Path(self._tmp.name)
        bad = d / "broken.zip"
        bad.write_bytes(b"not a zip at all")
        self.assertEqual(cb._bundle_facts(bad), {})
        self.assertEqual(cb._bundle_facts(self._zip(None)), {})


class TracedFigures(unittest.TestCase):

    def _scene(self, meta):
        d = Path(self._tmp.name)
        (d / "meta.json").write_text(json.dumps(meta))
        return d

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_both_come_off_the_trace(self):
        d = self._scene({"trace": {"links": [
            {"ue": "UE-n2", "gain_db": -84.0712, "paths": 33}]}})
        gains, paths = cb._traced_gains(d)
        self.assertEqual(gains, {"UE-n2": -84.07})
        self.assertEqual(paths, {"UE-n2": 33})

    def test_an_untraced_scene_yields_nothing_to_claim(self):
        gains, paths = cb._traced_gains(self._scene({"trace": {"links": []}}))
        self.assertEqual((gains, paths), ({}, {}))

    def test_a_missing_meta_is_not_an_error(self):
        gains, paths = cb._traced_gains(Path(self._tmp.name) / "nope")
        self.assertEqual((gains, paths), ({}, {}))
