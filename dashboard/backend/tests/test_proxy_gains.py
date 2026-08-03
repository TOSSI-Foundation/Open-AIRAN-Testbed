import importlib.util
import os
import pathlib
import sys
import tempfile
import unittest

_ROOT = pathlib.Path(__file__).resolve().parents[3]
PROXY = str(_ROOT / "OAI-RAN" / "multi_ue_sim" / "proxy" / "zmq_proxy.py")

if not os.path.exists(PROXY):
    raise unittest.SkipTest(f"the ZMQ proxy is not at {PROXY}")
try:
    import zmq  # noqa: F401
except ImportError:
    raise unittest.SkipTest("pyzmq is not installed in this interpreter")

spec = importlib.util.spec_from_file_location("zp", PROXY)
zp = importlib.util.module_from_spec(spec)
sys.argv = ["zmq_proxy"]
spec.loader.exec_module(zp)


def write(ue, cell, value):
    with open(f"/tmp/proxy_ue_gain_{ue}_{cell}", "w") as f:
        f.write(str(value))


def clear(ues=3, cells=3):
    for i in range(1, ues + 1):
        for c in range(cells):
            try:
                os.unlink(f"/tmp/proxy_ue_gain_{i}_{c}")
            except OSError:
                pass


class ReadGains(unittest.TestCase):
    def setUp(self):
        clear()
        self.addCleanup(clear)
        self.p = zp.Proxy.__new__(zp.Proxy)

    def test_it_reads_an_amplitude_per_cell(self):
        write(1, 0, 1.0)
        write(1, 1, 0.25)
        self.assertEqual(self.p._read_gains(1, 2), [[1.0, 0.25]])

    def test_a_cell_nobody_has_mentioned_is_still_transmitting(self):
        write(1, 0, 1.0)
        self.assertEqual(self.p._read_gains(1, 2), [[1.0, 1.0]])

    def test_a_ue_nobody_has_mentioned_hears_every_cell(self):
        self.assertEqual(self.p._read_gains(1, 2), [[1.0, 1.0]])

    def test_a_cell_can_be_muted_on_purpose(self):
        write(1, 1, 0.0)
        self.assertEqual(self.p._read_gains(1, 2), [[1.0, 0.0]])

    def test_the_dashboard_handover_convention_still_means_what_it_meant(self):
        write(1, 0, 0.0)
        write(1, 1, 1.0)
        self.assertEqual(self.p._read_gains(1, 2), [[0.0, 1.0]])

    def test_negative_amplitudes_are_clamped(self):
        write(1, 0, -5.0)
        self.assertEqual(self.p._read_gains(1, 2)[0][0], 0.0)

    def test_garbage_reads_as_silence_rather_than_raising(self):
        with open("/tmp/proxy_ue_gain_1_0", "w") as f:
            f.write("not a number")
        self.assertEqual(self.p._read_gains(1, 2), [[1.0, 1.0]])

    def test_each_ue_gets_its_own_row(self):
        write(1, 0, 1.0); write(1, 1, 0.1)
        write(2, 0, 0.2); write(2, 1, 1.0)
        self.assertEqual(self.p._read_gains(2, 2), [[1.0, 0.1], [0.2, 1.0]])


if __name__ == "__main__":
    unittest.main()
