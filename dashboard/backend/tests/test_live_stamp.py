import sys
import time
import unittest
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from app.sionna_bridge import _parse_live_line as parse

STAMPED = ("[live] t=1787311662.668  seq=  13  pos=(-36,9)  gain=  -89.6dB  applied=- 5.3dB  "
           "paths= 8  trace=   32ms  doppler=-164Hz spread=30mHz coh=5300ms")
UNSTAMPED = ("[live] seq=  13  pos=(-36,9)  gain=  -89.6dB  applied=- 5.3dB  paths= 8  "
             "trace=   32ms")


class Stamp(unittest.TestCase):

    def test_the_publishers_stamp_is_used(self):
        self.assertEqual(parse(STAMPED)["t"], 1787311662.668)

    def test_a_reread_line_keeps_its_original_time(self):
        first = parse(STAMPED)["t"]
        time.sleep(0.01)
        self.assertEqual(parse(STAMPED)["t"], first)

    def test_spacing_between_lines_survives_parsing(self):
        a = parse("[live] t=1787311662.668  seq=13  gain= -89.6dB  paths=8  trace=32ms")
        b = parse("[live] t=1787311664.676  seq=14  gain= -90.0dB  paths=8  trace=38ms")
        self.assertAlmostEqual(b["t"] - a["t"], 2.008, places=3)

    def test_a_line_without_a_stamp_falls_back_to_now(self):
        self.assertLess(abs(parse(UNSTAMPED)["t"] - time.time()), 5)

    def test_the_stamp_is_not_mistaken_for_another_field(self):
        s = parse(STAMPED)
        self.assertEqual(s["seq"], 13)
        self.assertEqual(s["paths"], 8)
        self.assertEqual(s["trace_ms"], 32)

    def test_everything_else_on_the_line_still_parses(self):
        s = parse(STAMPED)
        self.assertEqual(s["gain_db"], -89.6)
        self.assertEqual(s["applied_db"], 5.3)
        self.assertEqual(s["pos"], [-36.0, 9.0])
        self.assertEqual(s["doppler_hz"], -164.0)


if __name__ == "__main__":
    unittest.main()
