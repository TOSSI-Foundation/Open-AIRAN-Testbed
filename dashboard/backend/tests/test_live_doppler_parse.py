import sys
import unittest
from pathlib import Path

_APP = Path(__file__).resolve().parents[1]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from app.sionna_bridge import _parse_live_line as parse

APPROACHING = ("[live] seq=1046  pos=(48,5)  gain=  -88.3dB  applied=- 4.0dB  paths= 8  "
               "trace=   33ms  doppler=+164Hz spread=0.1Hz coh=3370ms")
RECEDING = ("[live] seq=   3  pos=(245,-6)  gain=  -84.3dB  applied=- 0.0dB  paths= 8  "
            "trace=   31ms  doppler=-163Hz spread=0.1Hz coh=1212ms STALE x2")
STEADY = ("[live] seq=   9  pos=(76,3)  gain=  -87.8dB  applied=- 3.5dB  paths= 8  "
          "trace=   43ms  doppler=+120Hz spread=0.0Hz  steady")
STATIONARY = ("[live] seq=   0  pos=(316,-26)  gain= -93.0dB  applied=- 0.0dB  paths=33  "
              "trace=   93ms")


class Offset(unittest.TestCase):

    def test_an_approaching_receiver_keeps_its_sign(self):
        self.assertEqual(parse(APPROACHING)["doppler_hz"], 164.0)

    def test_a_receding_receiver_keeps_its_sign(self):
        self.assertEqual(parse(RECEDING)["doppler_hz"], -163.0)

    def test_the_two_are_opposite(self):
        self.assertLess(parse(RECEDING)["doppler_hz"], 0)
        self.assertGreater(parse(APPROACHING)["doppler_hz"], 0)


class SpreadAndCoherence(unittest.TestCase):

    def test_spread_and_coherence_come_through(self):
        s = parse(RECEDING)
        self.assertEqual(s["doppler_spread_hz"], 0.1)
        self.assertEqual(s["coherence_ms"], 1212.0)

    def test_staleness_is_read_when_the_publisher_flags_it(self):
        self.assertEqual(parse(RECEDING)["staleness"], 2.0)

    def test_a_channel_that_is_not_smearing_says_so_instead_of_going_blank(self):
        s = parse(STEADY)
        self.assertTrue(s["doppler_steady"])
        self.assertNotIn("coherence_ms", s)
        self.assertEqual(s["doppler_hz"], 120.0)

    def test_no_staleness_when_the_publisher_did_not_flag_it(self):
        self.assertNotIn("staleness", parse(APPROACHING))


class Unaffected(unittest.TestCase):

    def test_a_stationary_receiver_reports_no_doppler_at_all(self):
        s = parse(STATIONARY)
        for k in ("doppler_hz", "doppler_spread_hz", "coherence_ms", "staleness"):
            self.assertNotIn(k, s)

    def test_the_fields_that_were_already_parsed_still_are(self):
        s = parse(APPROACHING)
        self.assertEqual(s["seq"], 1046)
        self.assertEqual(s["gain_db"], -88.3)
        self.assertEqual(s["paths"], 8)
        self.assertEqual(s["trace_ms"], 33)
        self.assertEqual(s["pos"], [48.0, 5.0])

    def test_a_line_carrying_no_telemetry_is_still_nothing(self):
        self.assertIsNone(parse("[live] publishing on tcp://127.0.0.1:5566"))


if __name__ == "__main__":
    unittest.main()
