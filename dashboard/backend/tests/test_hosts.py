import unittest
from unittest import mock

from app import hosts as h

PRIMARY = {"id": "primary", "nickname": "seven", "primary": True,
           "specs": {"cores": 18, "gpus": [], "dpdk": "25.11", "vfio_nics": ["0000:51:11.0"], "hugepages_gb": 100, "ptp": "yes"}}
DGX = {"id": "dgx", "nickname": "dgx-spark", "user": "u", "address": "10.0.0.2", "test": {"ssh": True},
       "specs": {"cores": 20, "gpus": ["GB10"], "dpdk": "25.11", "vfio_nics": ["0000:01:00.0"], "hugepages_gb": 16, "ptp": "yes"}}


def ranked(needs):
    with mock.patch.object(h, "primary", lambda: PRIMARY), mock.patch.object(h, "load", lambda: [DGX]), \
         mock.patch.object(h.d, "stack_env", lambda s: {"NEEDS": needs}), mock.patch.object(h.d, "running_sessions", lambda: set()), \
         mock.patch.object(h, "placements", lambda: {}):
        return h.rank("s")


class Placement(unittest.TestCase):
    def test_gpu_stack_goes_to_the_gpu_box(self):
        r = ranked("gpu cuda ofed nic hugepages ptp dpdk aerial")
        self.assertEqual([x["nickname"] for x in r if x["fits"]], ["dgx-spark"])
        self.assertIn("no gpu", next(x for x in r if x["id"] == "primary")["reasons"])

    def test_other_stacks_stay_on_the_primary(self):
        r = ranked("zmq python3")
        self.assertEqual(r[0]["nickname"], "seven")
        self.assertIn("keeps its GPU free", r[1]["reasons"])

    def test_failed_nvidia_smi_is_not_a_gpu(self):
        out = h._parse("gpus=\ncores=8\n")
        self.assertEqual(out["gpus"], [])


if __name__ == "__main__":
    unittest.main()


class TrainHost(unittest.TestCase):
    def pick(self, hs, prim=None, ssh_rc=0):
        from unittest import mock
        prim = prim or {"id": "primary", "primary": True, "specs": {"torch": "2.5 cpu"}}
        with mock.patch.object(h, "primary", lambda fresh=False: prim), mock.patch.object(h, "load", lambda: hs), \
             mock.patch.object(h.subprocess, "run", lambda *a, **k: mock.Mock(returncode=ssh_rc)):
            g = h.gpu_host()
            return g and g["id"]

    def test_ranking(self):
        srv = lambda i, **sp: {"id": i, "user": "u", "address": "10.0.0." + str(len(i)), "specs": sp, "test": {"ssh": True}}  # noqa: E731
        no_torch = srv("a", gpus=["X (80 GB)"])
        busy = srv("bb", gpus=["A (16 GB)"], gpu_use=["95%"], torch="2 cuda")
        idle = srv("ccc", gpus=["B (16 GB)"], gpu_use=["3%"], torch="2 cuda")
        self.assertEqual(self.pick([no_torch]), "primary")
        self.assertEqual(self.pick([busy, idle]), "ccc")
        self.assertEqual(self.pick([busy, idle], ssh_rc=255), "primary")
        self.assertIsNone(self.pick([no_torch], prim={"id": "primary", "primary": True, "specs": {}}))
