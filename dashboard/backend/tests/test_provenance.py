import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app import provenance as pv


class Digests(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.dir = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)

    def test_a_known_digest(self):
        p = self.dir / "x.bin"
        p.write_bytes(b"abc")
        self.assertEqual(
            pv.sha256_file(p),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")

    def test_file_and_bytes_agree(self):
        p = self.dir / "x.bin"
        p.write_bytes(b"the quick brown fox")
        self.assertEqual(pv.sha256_file(p), pv.sha256_bytes(b"the quick brown fox"))

    def test_a_file_larger_than_one_chunk(self):
        data = bytes(range(256)) * 8192
        p = self.dir / "big.bin"
        p.write_bytes(data)
        self.assertEqual(pv.sha256_file(p), pv.sha256_bytes(data))

    def test_a_missing_file_is_none_not_an_error(self):
        self.assertIsNone(pv.sha256_file(self.dir / "absent"))

    def test_short_is_a_prefix(self):
        h = "0123456789abcdef" * 4
        self.assertEqual(pv.short(h), "0123456789ab")
        self.assertEqual(pv.short(h, 6), "012345")
        self.assertIsNone(pv.short(None))


class SceneFingerprint(unittest.TestCase):

    PACKAGE = {
        "manifest": {
            "version": 1,
            "city": "New Delhi",
            "buildings": {"source": "overture", "release": "2026-07-22.0",
                          "layer": "building"},
            "bbox": {"min_lon": 77.2, "min_lat": 28.6},
            "crs": {"type": "ENU", "origin_lonlat": [77.22, 28.61]},
        },
        "buildings": {"type": "FeatureCollection", "features": []},
    }

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.scene = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        (self.scene / "scene" / "meshes").mkdir(parents=True)
        (self.scene / "package.json").write_text(json.dumps(self.PACKAGE))
        (self.scene / "scene" / "scene.xml").write_text("<scene/>")
        for i in range(3):
            (self.scene / "scene" / "meshes" / f"b{i}.ply").write_text(f"ply {i}")

    def test_it_reports_every_part(self):
        f = pv.scene_fingerprint(self.scene)
        self.assertEqual(f["nof_meshes"], 3)
        for k in ("geometry_sha256", "package_sha256", "meshes_sha256", "scene_xml_sha256"):
            self.assertIsNotNone(f[k], k)

    def test_where_the_geometry_came_from_is_carried_too(self):
        src = pv.scene_fingerprint(self.scene)["source"]
        self.assertEqual(src["provider"], "overture")
        self.assertEqual(src["release"], "2026-07-22.0")
        self.assertEqual(src["city"], "New Delhi")
        self.assertEqual(src["manifest_version"], 1)

    def test_the_same_contents_hash_the_same(self):
        self.assertEqual(pv.scene_fingerprint(self.scene)["geometry_sha256"],
                         pv.scene_fingerprint(self.scene)["geometry_sha256"])

    def test_editing_the_package_changes_the_hash(self):
        before = pv.scene_fingerprint(self.scene)
        pkg = json.loads(json.dumps(self.PACKAGE))
        pkg["manifest"]["city"] = "Dubai"
        (self.scene / "package.json").write_text(json.dumps(pkg))
        after = pv.scene_fingerprint(self.scene)
        self.assertNotEqual(before["package_sha256"], after["package_sha256"])
        self.assertNotEqual(before["geometry_sha256"], after["geometry_sha256"])
        self.assertEqual(before["meshes_sha256"], after["meshes_sha256"])

    def test_editing_one_mesh_changes_the_hash(self):
        before = pv.scene_fingerprint(self.scene)
        (self.scene / "scene" / "meshes" / "b1.ply").write_text("ply edited")
        after = pv.scene_fingerprint(self.scene)
        self.assertNotEqual(before["meshes_sha256"], after["meshes_sha256"])
        self.assertEqual(before["package_sha256"], after["package_sha256"])

    def test_adding_a_mesh_changes_the_hash(self):
        before = pv.scene_fingerprint(self.scene)
        (self.scene / "scene" / "meshes" / "b3.ply").write_text("ply 3")
        after = pv.scene_fingerprint(self.scene)
        self.assertNotEqual(before["meshes_sha256"], after["meshes_sha256"])
        self.assertEqual(after["nof_meshes"], 4)

    def test_renaming_a_mesh_changes_the_hash(self):
        before = pv.scene_fingerprint(self.scene)
        (self.scene / "scene" / "meshes" / "b1.ply").rename(
            self.scene / "scene" / "meshes" / "zz.ply")
        self.assertNotEqual(before["meshes_sha256"],
                            pv.scene_fingerprint(self.scene)["meshes_sha256"])

    def test_a_scene_with_nothing_built_yet(self):
        empty = self.scene / "unbuilt"
        empty.mkdir()
        f = pv.scene_fingerprint(empty)
        self.assertEqual(f["nof_meshes"], 0)
        self.assertIsNone(f["meshes_sha256"])
        self.assertIsNotNone(f["geometry_sha256"])

    def test_an_unreadable_package_does_not_raise(self):
        (self.scene / "package.json").write_text("{not json")
        self.assertEqual(pv.scene_fingerprint(self.scene)["source"], {})


class Sealing(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.scene = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        (self.scene / "scene" / "meshes").mkdir(parents=True)
        (self.scene / "package.json").write_text('{"manifest": {"city": "X"}}')
        (self.scene / "scene" / "scene.xml").write_text("<scene/>")
        (self.scene / "scene" / "meshes" / "a.ply").write_text("ply")
        stub = mock.patch.object(pv, "stack_identity", return_value={"stubbed": True})
        stub.start()
        self.addCleanup(stub.stop)

    def test_the_first_look_seals_it(self):
        out = pv.verify(self.scene)
        self.assertTrue(out["first_seal"])
        self.assertTrue(out["matches"])
        self.assertTrue((self.scene / pv.SEAL_NAME).exists())

    def test_an_untouched_scene_keeps_matching(self):
        pv.verify(self.scene)
        again = pv.verify(self.scene)
        self.assertFalse(again["first_seal"])
        self.assertTrue(again["matches"])
        self.assertEqual(again["changed"], [])

    def test_a_changed_mesh_is_reported_against_the_seal(self):
        pv.verify(self.scene)
        (self.scene / "scene" / "meshes" / "a.ply").write_text("ply edited")
        out = pv.verify(self.scene)
        self.assertFalse(out["matches"])
        self.assertIn("meshes_sha256", out["changed"])

    def test_a_changed_package_is_reported(self):
        pv.verify(self.scene)
        (self.scene / "package.json").write_text('{"manifest": {"city": "Y"}}')
        out = pv.verify(self.scene)
        self.assertFalse(out["matches"])
        self.assertIn("package_sha256", out["changed"])

    def test_resealing_accepts_the_new_contents(self):
        pv.verify(self.scene)
        (self.scene / "scene" / "scene.xml").write_text("<scene rebuilt=1/>")
        self.assertFalse(pv.verify(self.scene)["matches"])
        pv.seal(self.scene)
        self.assertTrue(pv.verify(self.scene)["matches"])

    def test_the_seal_is_a_sidecar_not_part_of_the_geometry(self):
        before = pv.scene_fingerprint(self.scene)["geometry_sha256"]
        pv.seal(self.scene)
        self.assertEqual(pv.scene_fingerprint(self.scene)["geometry_sha256"], before)

    def test_a_corrupt_seal_is_treated_as_absent(self):
        (self.scene / pv.SEAL_NAME).write_text("{not json")
        self.assertIsNone(pv.read_seal(self.scene))
        self.assertTrue(pv.verify(self.scene)["first_seal"])


class StackIdentity(unittest.TestCase):
    def test_binary_identity_of_something_absent(self):
        out = pv.binary_identity(Path("/nonexistent/odu"))
        self.assertFalse(out["exists"])
        self.assertNotIn("sha256", out)

    def test_binary_identity_of_a_real_file(self):
        with TemporaryDirectory() as t:
            p = Path(t) / "odu"
            p.write_bytes(b"binary")
            out = pv.binary_identity(p)
            self.assertTrue(out["exists"])
            self.assertEqual(out["bytes"], 6)
            self.assertEqual(out["sha256"], pv.sha256_bytes(b"binary"))
            self.assertEqual(out["sha256_short"], out["sha256"][:12])

    def test_a_rebuild_is_a_different_identity(self):
        with TemporaryDirectory() as t:
            p = Path(t) / "odu"
            p.write_bytes(b"build one")
            first = pv.binary_identity(p)["sha256"]
            p.write_bytes(b"build two, longer")
            self.assertNotEqual(pv.binary_identity(p)["sha256"], first)

    def test_git_identity_of_something_that_is_not_a_repo(self):
        with TemporaryDirectory() as t:
            out = pv.git_identity(Path(t))
            self.assertFalse(out["is_repo"])
            self.assertNotIn("commit", out)

    def test_the_stack_names_every_tree_and_binary(self):
        with TemporaryDirectory() as t:
            fake = Path(t)
            with mock.patch.object(pv, "REPOS", {k: fake for k in
                                                 ("platform", "dashboard", "ocudu", "oai")}), \
                 mock.patch.object(pv, "BINARIES", {"odu": fake / "odu", "ocu": fake / "ocu"}), \
                 mock.patch.object(pv, "env_versions", return_value={}):
                s = pv.stack_identity()
        self.assertEqual(set(s["repos"]), {"platform", "dashboard", "ocudu", "oai"})
        self.assertEqual(set(s["binaries"]), {"odu", "ocu"})
        self.assertIn("sionna_python", s)


if __name__ == "__main__":
    unittest.main()


class LookingDoesNotSeal(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.d = Path(self._tmp.name)
        (self.d / "package.json").write_text('{"city": "New Delhi"}')
        (self.d / "scene").mkdir()
        (self.d / "scene" / "scene.xml").write_text("<scene/>")

    def test_it_reports_without_writing_a_seal(self):
        got = pv.verify(self.d, seal_if_missing=False)
        self.assertFalse(got["sealed"])
        self.assertIsNone(got["matches"])
        self.assertFalse((self.d / pv.SEAL_NAME).exists())

    def test_matches_is_none_not_true(self):
        self.assertIsNone(pv.verify(self.d, seal_if_missing=False)["matches"])

    def test_the_default_still_seals(self):
        got = pv.verify(self.d)
        self.assertTrue(got["sealed"])
        self.assertTrue(got["first_seal"])
        self.assertTrue((self.d / pv.SEAL_NAME).exists())

    def test_once_sealed_a_look_reports_the_seal(self):
        pv.seal(self.d)
        got = pv.verify(self.d, seal_if_missing=False)
        self.assertTrue(got["sealed"])
        self.assertTrue(got["matches"])

    def test_a_look_still_catches_a_change(self):
        pv.seal(self.d)
        (self.d / "scene" / "scene.xml").write_text("<scene changed=\"1\"/>")
        got = pv.verify(self.d, seal_if_missing=False)
        self.assertFalse(got["matches"])
        self.assertIn("scene_xml_sha256", got["changed"])
