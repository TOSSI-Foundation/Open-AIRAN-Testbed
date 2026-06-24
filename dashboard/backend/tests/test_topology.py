import unittest

from app import deploy_bridge as d
from app import topology


class EveryStack(unittest.TestCase):
    def test_well_formed_and_connected(self):
        for conf in sorted((d.AUTO / "stacks").glob("*.conf")):
            with self.subTest(stack=conf.stem):
                env = d.stack_env(conf.stem)
                self.assertNotIn("error", env)
                t = topology.build(conf.stem, env)
                ids = [n["id"] for n in t["nodes"]]
                self.assertEqual(len(ids), len(set(ids)), "duplicate node ids")
                run = env["START_ORDER"].split()
                for n in t["nodes"]:
                    if n["component"]:
                        self.assertIn(n["component"], run, f"{n['id']} owned by a component that never starts")
                    self.assertTrue(n["col"] in topology.COLS or n["under"] in ids, n)
                for e in t["edges"]:
                    self.assertIn(e["from"], ids)
                    self.assertIn(e["to"], ids)
                adj = {i: set() for i in ids}
                for e in t["edges"]:
                    adj[e["from"]].add(e["to"]); adj[e["to"]].add(e["from"])
                seen, todo = set(), [ids[0]]
                while todo:
                    x = todo.pop()
                    if x not in seen:
                        seen.add(x); todo.extend(adj[x])
                self.assertEqual(seen, set(ids), "disconnected nodes")


class Interfaces(unittest.TestCase):
    def test_split_with_cu_names_f1_and_n2(self):
        t = topology.build("x", {"START_ORDER": "core5g ocudu-cu ocudu", "OCUDU_APP": "odu", "NEEDS": "zmq"})
        self.assertEqual({(e["from"], e["to"], e["label"]) for e in t["edges"]},
                         {("cu", "core", "N2 · N3"), ("du", "cu", "F1-C · F1-U"), ("du", "ue", "ZMQ IQ")})

    def test_72_split_brings_an_ru_a_handset_and_ptp(self):
        t = topology.build("x", {"START_ORDER": "core5g ptp ocudu", "OCUDU_APP": "gnb", "NEEDS": "dpdk nic ptp"})
        self.assertEqual({n["id"] for n in t["nodes"] if n["external"]}, {"ru", "handset"})
        self.assertIn(("ptp", "ru", "PTP sync"), {(e["from"], e["to"], e["label"]) for e in t["edges"]})

    def test_xfapi_sides_follow_the_mode(self):
        t = topology.build("x", {"START_ORDER": "core5g xfapi ocudu oai-gnb", "OCUDU_APP": "odu",
                                 "XFAPI_MODE": "oai_ocudu", "OAI_GNB_ARGS": "--nfapi PNF", "NEEDS": ""})
        lab = {(e["from"], e["to"]): e["label"] for e in t["edges"]}
        self.assertEqual(lab[("du", "xfapi")], "FAPI · xSM shm")
        self.assertEqual(lab[("xfapi", "l1")], "nFAPI P5/P7")


if __name__ == "__main__":
    unittest.main()
