import unittest

from fastapi import HTTPException

from app import deploy_bridge as d


class Boundary(unittest.TestCase):
    def test_overrides_must_be_upper_snake_with_safe_values(self):
        self.assertEqual(d.clean_env({"NUM_UES": "8", "UE_EXTRA_ARGS": "--uicc0.nssai_sd 0xffffff"}),
                         {"NUM_UES": "8", "UE_EXTRA_ARGS": "--uicc0.nssai_sd 0xffffff"})
        for bad in ({"num_ues": "8"}, {"STACK": "x"}, {"PATH": "/tmp"}, {"X": "a;rm -rf /"},
                    {"X": "$(id)"}, {"X": "`id`"}, {"X": "a|b"}, {"X": "a\nb"}):
            with self.assertRaises(HTTPException, msg=bad):
                d.clean_env(bad)

    def test_make_gets_an_argv_never_a_shell_string(self):
        argv = d.make_argv("ai-ran-bsr", "all", {"SIM_UE": "1"})
        self.assertEqual(argv, ["make", "--no-print-directory", "all", "STACK=ai-ran-bsr", "SIM_UE=1"])

    def test_unknown_stacks_and_traversal_are_refused(self):
        for bad in ("nope", "../etc", "ai-ran-bsr/../../x", "A-UPPER"):
            with self.assertRaises(HTTPException):
                d.known_stack(bad)


class Parsing(unittest.TestCase):
    def test_header_gives_description_and_doc_link(self):
        got = d.parse_conf_text("# desc: ML BSR periodicity\n# https://tossi.org/docs/x/.\nA=1\n")
        self.assertEqual(got, {"desc": "ML BSR periodicity", "doc": "https://tossi.org/docs/x/"})

    def test_status_rows(self):
        text = ("COMPONENT    STATE    PID      LOG\n"
                "core5g       up       f798ab /x/core5g.log\n"
                "ocudu        down     -        /x/ocudu.log\n")
        self.assertEqual(d.parse_status(text), [
            {"name": "core5g", "state": "up", "pid": "f798ab"},
            {"name": "ocudu", "state": "down", "pid": None}])

    def test_groups(self):
        self.assertEqual([d.group_of(s) for s in ("ai-ran-csi", "rfsim-multi-ue",
                                                  "oai-l1-xfapi-ocudu-l2", "ocudu-prach-gpu", "ocudu-split8-usrp")],
                         ["AI-RAN", "Simulation", "FAPI split", "Acceleration", "Radio & RAN"])


class RealStack(unittest.TestCase):
    def test_a_stack_loads_through_the_automation(self):
        v = d.stack_vars("rfsim-multi-ue")
        self.assertNotIn("error", v, v)
        self.assertEqual(v["ocudu_branch"], "rfsim")
        self.assertEqual(v["oai_branch"], "rfsim_ocudu")
        self.assertIn("rfsim-ue", v["components"])


if __name__ == "__main__":
    unittest.main()


class Settings(unittest.TestCase):

    def setUp(self):
        import tempfile
        from pathlib import Path
        self.tmp = Path(tempfile.mkdtemp())
        self.orig = d.OVR_DIR
        d.OVR_DIR = self.tmp

    def tearDown(self):
        d.OVR_DIR = self.orig

    def test_round_trip_keeps_spaces_and_drops_empties(self):
        d.write_settings("ai-ran-bsr", {"UE_EXTRA_ARGS": "--a 1 --b 2", "EMPTY": ""})
        self.assertEqual(d.read_settings("ai-ran-bsr"), {"UE_EXTRA_ARGS": "--a 1 --b 2"})

    def test_config_paths_must_be_real_config_files_in_allowed_roots(self):
        for bad in ({"RADIO_CFG": "/etc/hostname"}, {"OCUDU_CFG": "/etc/passwd"}, {"X": "$(id)"}):
            with self.assertRaises(HTTPException, msg=bad):
                d.save_settings("ai-ran-bsr", {"settings": bad})

    def test_only_files_the_stack_uses_can_be_opened(self):
        for bad in ("/etc/passwd", str(d.REPO / "Makefile"), "../../etc/shadow"):
            with self.assertRaises(HTTPException):
                d.read_file("ai-ran-bsr", bad)

    def test_knobs_come_from_the_conf(self):
        self.assertIn("RADIO", [k["key"] for k in d.knobs("ai-ran-bsr")])


class MultiHost(unittest.TestCase):
    def test_hosts_from_env(self):
        env = {"COMPONENTS": "ptp xfapi ocudu oai-gnb", "HOST_OAI_GNB": "seven@server5", "HOST_XFAPI": "local"}
        self.assertEqual(d.hosts(env), {"oai-gnb": "seven@server5"})

    def test_stack_knob_beats_shared_one(self):
        mode = [k for k in d.knobs("ai-ran-mcs") if k["key"] == "ML_MODE"]
        self.assertEqual([k["choices"] for k in mode], [["collect", "closed-loop"]])


class BuildState(unittest.TestCase):
    def test_states(self):
        import tempfile
        from pathlib import Path
        from unittest import mock
        with tempfile.TemporaryDirectory() as t, mock.patch.object(d, "VAR", Path(t)):
            job = lambda state, at: [{"stack": "s", "action": "build", "state": state, "started": at, "ended": at}]  # noqa: E731
            self.assertEqual(d.build_state("s", [])["state"], "none")
            self.assertEqual(d.build_state("s", job("running", 1))["state"], "building")
            self.assertEqual(d.build_state("s", job("ok", 1))["state"], "none")
            (Path(t) / "run" / "s").mkdir(parents=True)
            (Path(t) / "run" / "s" / "built").write_text("ptp ocudu")
            self.assertEqual(d.build_state("s", [])["state"], "built")
            self.assertEqual(d.build_state("s", job("failed", 9e12))["state"], "failed")


class Orphans(unittest.TestCase):
    def test_restart_keeps_running_jobs_visible_and_cancellable(self):
        import json, subprocess, tempfile, time
        from pathlib import Path
        from unittest import mock
        p = subprocess.Popen(["sleep", "30"], start_new_session=True)
        try:
            with tempfile.TemporaryDirectory() as t, mock.patch.object(d, "JOBS_DIR", Path(t)), mock.patch.dict(d._jobs, clear=True):
                j = {"id": "20261014-131314-abcdef", "stack": "s", "action": "train", "env": {}, "user": "u",
                     "cmd": "make", "state": "running", "rc": None, "started": 1.0, "ended": None, "pgid": p.pid}
                (Path(t) / f"{j['id']}.json").write_text(json.dumps(j))
                (Path(t) / "20261014-131315-abcdef.json").write_text(json.dumps({**j, "id": "20261014-131315-abcdef", "pgid": 999999}))
                states = {v["id"]: v["state"] for v in d.jobs()}
                self.assertEqual(states, {j["id"]: "orphaned", "20261014-131315-abcdef": "lost"})
                self.assertEqual(d.active_job()["id"], j["id"])
                d.cancel(j["id"])
                time.sleep(0.2)
                self.assertIsNotNone(p.poll())
                self.assertIsNone(d.active_job())
        finally:
            p.kill()
