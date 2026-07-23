import ast
import json
import sys
import unittest
import zipfile
from pathlib import Path
from tempfile import TemporaryDirectory

_SB = Path(__file__).resolve().parents[2] / "sionna-map" / "scene_builder"
if str(_SB) not in sys.path:
    sys.path.insert(0, str(_SB))

import bundle as bd


CONFIG = {
    "freq": 3489420000.0,
    "rows": 1, "cols": 4, "nof_tx_ant": 4,
    "tx_pattern": "tr38901", "tx_pol": "V",
    "rx_pattern": "iso", "rx_pol": "V",
    "tx_placements": [{"name": "gNB-n3", "position": [515.83, -20.0, 43.0],
                       "orientation": [0.0, -0.10472, 0.0], "power_dbm": 43.0}],
    "rx_placements": [{"name": "UE-n4", "position": [326.92, -10.14, 1.5]}],
}

SOLVER_SP = {"los": True, "specular": True, "diffuse": False, "refraction": True,
             "diffraction": False, "edge_diffraction": False, "synthetic_array": True,
             "samples_per_src": 1000000, "max_paths_per_src": 1000000, "seed": 42}


class PythonLiterals(unittest.TestCase):

    def test_booleans_are_python(self):
        self.assertEqual(bd.py_literal(True), "True")
        self.assertEqual(bd.py_literal(False), "False")
        self.assertNotIn("true", bd.py_literal({"los": True}))

    def test_none_is_python(self):
        self.assertEqual(bd.py_literal(None), "None")
        self.assertNotIn("null", bd.py_literal({"x": None}))

    def test_a_nested_structure_round_trips(self):
        value = {"a": [1, 2.5, True, None], "b": {"c": "text", "d": False}}
        self.assertEqual(ast.literal_eval(bd.py_literal(value)), value)

    def test_a_device_list_round_trips(self):
        self.assertEqual(ast.literal_eval(bd.py_literal(CONFIG["tx_placements"])),
                         CONFIG["tx_placements"])


class GeneratedScript(unittest.TestCase):

    def _script(self, **kw):
        args = dict(num_subcarriers=128, subcarrier_spacing_hz=30e3,
                    normalize_delays=True, max_depth=5, sp=SOLVER_SP)
        args.update(kw)
        script, solver = bd.build_script(CONFIG, args["num_subcarriers"],
                                         args["subcarrier_spacing_hz"],
                                         args["normalize_delays"],
                                         args["max_depth"], args["sp"])
        return script, solver

    def test_it_parses_as_python(self):
        script, _ = self._script()
        ast.parse(script)

    def test_it_compiles(self):
        script, _ = self._script()
        compile(script, "load_scene.py", "exec")

    def test_no_json_booleans_survive_into_the_source(self):
        script, _ = self._script()
        tree = ast.parse(script)
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)}
        for bad in ("true", "false", "null"):
            self.assertNotIn(bad, names)

    def test_the_carrier_and_devices_are_in_it(self):
        script, _ = self._script()
        self.assertIn("3489420000.0", script)
        self.assertIn("gNB-n3", script)
        self.assertIn("UE-n4", script)
        self.assertIn("515.83", script)

    def test_the_solver_switches_are_all_stated(self):
        _, solver = self._script()
        for key in ("max_depth", "los", "specular_reflection", "diffuse_reflection",
                    "refraction", "diffraction", "edge_diffraction", "synthetic_array",
                    "samples_per_src", "max_num_paths_per_src", "seed"):
            self.assertIn(key, solver)
        self.assertEqual(solver["seed"], 42)
        self.assertIs(solver["diffuse_reflection"], False)

    def test_switches_flow_through_rather_than_being_defaulted(self):
        sp = dict(SOLVER_SP, diffuse=True, los=False, seed=7)
        _, solver = self._script(sp=sp)
        self.assertIs(solver["diffuse_reflection"], True)
        self.assertIs(solver["los"], False)
        self.assertEqual(solver["seed"], 7)

    def test_no_subcarriers_still_produces_a_valid_script(self):
        script, _ = self._script(num_subcarriers=0)
        ast.parse(script)
        self.assertIn("NUM_SUBCARRIERS = 0", script)

    def test_the_script_references_nothing_outside_its_directory(self):
        script, _ = self._script()
        self.assertIn("HERE", script)
        self.assertNotIn("/home/", script)
        self.assertNotIn("backend/work", script)


class BundleContents(unittest.TestCase):

    MANIFEST = {
        "city": "New Delhi",
        "buildings": {"source": "overture", "release": "2026-07-22.0"},
        "nodes": [
            {"type": "gnb", "name": "gNB-n3", "enu_m": [515.83, -20.0, 43.0]},
            {"type": "ue", "name": "UE-n4", "enu_m": [326.92, -10.14, 1.5]},
        ],
    }

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.addCleanup(self._tmp.cleanup)
        self.scene = self.root / "scene"
        (self.scene / "meshes").mkdir(parents=True)
        (self.scene / "scene.xml").write_text('<scene version="2.1.0"/>')
        for i in range(4):
            (self.scene / "meshes" / f"b{i}-concrete.ply").write_text(f"ply {i}")

    def _build(self, **kw):
        out = self.root / "bundle.zip"
        args = dict(srate_hz=61.44e6, max_depth=5, sp=SOLVER_SP, num_subcarriers=128,
                    subcarrier_spacing_hz=30e3, normalize_delays=True,
                    log=lambda *a: None)
        args.update(kw)
        res = bd.export_bundle(self.MANIFEST, self.scene, out, **args)
        return out, res

    def test_every_member_is_present(self):
        out, res = self._build()
        with zipfile.ZipFile(out) as z:
            names = set(z.namelist())
        self.assertIn("scene.xml", names)
        self.assertIn("load_scene.py", names)
        self.assertIn("manifest.json", names)
        self.assertIn("README.md", names)
        self.assertEqual(sum(1 for n in names if n.startswith("meshes/")), 4)
        self.assertEqual(res["nof_meshes"], 4)

    def test_the_packaged_script_compiles(self):
        out, _ = self._build()
        with zipfile.ZipFile(out) as z:
            compile(z.read("load_scene.py").decode(), "load_scene.py", "exec")

    def test_the_manifest_describes_what_was_packaged(self):
        out, _ = self._build()
        with zipfile.ZipFile(out) as z:
            m = json.loads(z.read("manifest.json"))
        self.assertEqual(m["format"], "sionna-scene-bundle")
        self.assertEqual(m["city"], "New Delhi")
        self.assertEqual(m["nof_meshes"], 4)
        self.assertEqual(len(m["transmitters"]), 1)
        self.assertEqual(len(m["receivers"]), 1)
        self.assertEqual(m["solver"]["seed"], 42)
        self.assertIn("ENU", m["coordinates"])

    def test_a_provenance_record_travels_with_it(self):
        out, _ = self._build(provenance={"scene": {"geometry_short": "c050670cc46f"}})
        with zipfile.ZipFile(out) as z:
            m = json.loads(z.read("manifest.json"))
            readme = z.read("README.md").decode()
        self.assertEqual(m["provenance"]["scene"]["geometry_short"], "c050670cc46f")
        self.assertIn("c050670cc46f", readme)

    def test_the_measured_gain_is_recorded_for_checking_against(self):
        out, _ = self._build(link_gain_db=[{"ue": "UE-n4", "tx": "gNB-n3", "gain_db": -124.56}])
        with zipfile.ZipFile(out) as z:
            m = json.loads(z.read("manifest.json"))
        self.assertEqual(m["link_gain_db"][0]["gain_db"], -124.56)

    def test_the_path_count_is_recorded_beside_the_gain(self):
        out, _ = self._build(link_gain_db={"UE-n4": -124.56}, link_paths={"UE-n4": 33})
        with zipfile.ZipFile(out) as z:
            m = json.loads(z.read("manifest.json"))
        self.assertEqual(m["link_paths"]["UE-n4"], 33)

    def test_an_untraced_bundle_records_neither(self):
        out, _ = self._build()
        with zipfile.ZipFile(out) as z:
            m = json.loads(z.read("manifest.json"))
        self.assertNotIn("link_gain_db", m)
        self.assertNotIn("link_paths", m)

    def test_the_readme_asks_for_a_check_only_when_there_is_one(self):
        traced, _ = self._build(link_gain_db={"UE-n4": -124.56})
        with zipfile.ZipFile(traced) as z:
            said = z.read("README.md").decode()
        self.assertIn("should match the", said)

        out, _ = self._build()
        with zipfile.ZipFile(out) as z:
            said = z.read("README.md").decode()
        self.assertIn("There is no", said)
        self.assertNotIn("should match the", said)

    def test_mesh_paths_inside_the_zip_stay_relative(self):
        out, _ = self._build()
        with zipfile.ZipFile(out) as z:
            for n in z.namelist():
                self.assertFalse(n.startswith("/"), n)
                self.assertNotIn("..", n)

    def test_an_unbuilt_scene_is_refused(self):
        (self.scene / "scene.xml").unlink()
        with self.assertRaises(SystemExit):
            self._build()


if __name__ == "__main__":
    unittest.main()
