import sys
import unittest
from pathlib import Path
from unittest import mock

_APP = Path(__file__).resolve().parents[1]
if str(_APP) not in sys.path:
    sys.path.insert(0, str(_APP))

from app import ran_bridge as rb


def log(lines):
    return mock.patch.object(rb, "_read_log", lambda *a, **k: lines)


OVERFLOW = "2026-08-21T07:02:57 [RF      ] [W] Real-time failure in RF: overflow"
WAITING = "2026-08-21T07:02:57 [zmq:rx:0:0] [I] Waiting for reading samples. Completed 0 of 30720 samples."
SERVING = "2026-08-21T07:02:57 [MAC-NR  ] [I] ue=0 rnti=0x4601 DL harq"


class Wedged(unittest.TestCase):

    def test_a_radio_overflowing_continuously_is_wedged(self):
        with log([OVERFLOW] * 200):
            self.assertTrue(rb._du_is_wedged())

    def test_an_idle_du_waiting_for_a_proxy_is_not(self):
        with log([WAITING] * 200):
            self.assertFalse(rb._du_is_wedged())

    def test_a_du_serving_a_ue_is_not(self):
        with log([SERVING] * 200):
            self.assertFalse(rb._du_is_wedged())

    def test_a_handful_of_overflows_is_a_hiccup_not_a_wedge(self):
        with log([SERVING] * 195 + [OVERFLOW] * 5):
            self.assertFalse(rb._du_is_wedged())

    def test_a_wedge_among_other_noise_is_still_found(self):
        with log(([OVERFLOW] * 3 + [WAITING]) * 50):
            self.assertTrue(rb._du_is_wedged())

    def test_only_the_recent_tail_counts(self):
        with log([OVERFLOW] * 500 + [SERVING] * 200):
            self.assertFalse(rb._du_is_wedged())

    def test_an_empty_or_missing_log_is_not_a_wedge(self):
        for empty in ([], None, ""):
            with log(empty):
                self.assertFalse(rb._du_is_wedged())

    def test_a_string_log_is_handled_as_well_as_a_list(self):
        with log("\n".join([OVERFLOW] * 200)):
            self.assertTrue(rb._du_is_wedged())


class Thresholds(unittest.TestCase):

    def test_the_window_is_short_enough_to_be_about_now(self):
        self.assertLessEqual(rb.WEDGE_TAIL_LINES, 500)

    def test_it_takes_more_than_one_overflow(self):
        self.assertGreater(rb.WEDGE_MIN_OVERFLOWS, 1)


if __name__ == "__main__":
    unittest.main()
