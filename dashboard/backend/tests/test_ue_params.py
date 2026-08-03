import unittest

from app import sionna_bridge as sb


def err(v):
    return isinstance(v, str)


class CleanUe(unittest.TestCase):

    def test_defaults_are_all_accepted(self):
        self.assertFalse(err(sb._clean_ue(dict(sb.UE_DEFAULTS))))

    def test_a_typo_is_refused(self):
        out = sb._clean_ue({"n_rbs": 106})
        self.assertTrue(err(out))
        self.assertIn("unknown setting", out)

    def test_blank_clears_rather_than_failing(self):
        out = sb._clean_ue({"n_rb": "", "ue_cpus": ""})
        self.assertIsNone(out["n_rb"])
        self.assertEqual(out["ue_cpus"], "")


    def test_no_sd_is_the_top_of_the_range(self):
        self.assertFalse(err(sb._clean_ue({"sd": 16777215})))
        self.assertTrue(err(sb._clean_ue({"sd": 16777216})))
        self.assertTrue(err(sb._clean_ue({"sd": -1})))

    def test_n_rb_range(self):
        self.assertFalse(err(sb._clean_ue({"n_rb": 106})))
        self.assertFalse(err(sb._clean_ue({"n_rb": 11})))
        self.assertFalse(err(sb._clean_ue({"n_rb": 273})))
        self.assertTrue(err(sb._clean_ue({"n_rb": 10})))
        self.assertTrue(err(sb._clean_ue({"n_rb": 274})))


    def test_imsi_must_be_fifteen_digits(self):
        self.assertFalse(err(sb._clean_ue({"imsi_base": "001010000000002"})))
        self.assertTrue(err(sb._clean_ue({"imsi_base": "00101000000000"})))
        self.assertTrue(err(sb._clean_ue({"imsi_base": "0010100000000021"})))
        self.assertTrue(err(sb._clean_ue({"imsi_base": "00101000000000x"})))

    def test_key_and_opc_must_be_32_hex(self):
        good = "fec86ba6eb707ed08905757b1bb44b8f"
        self.assertFalse(err(sb._clean_ue({"key": good})))
        self.assertFalse(err(sb._clean_ue({"opc": good.upper()})))
        self.assertTrue(err(sb._clean_ue({"key": good[:31]})))
        self.assertTrue(err(sb._clean_ue({"opc": good[:-1] + "g"})))


    def test_ue_count_range(self):
        self.assertFalse(err(sb._clean_ue({"n_ues": 1})))
        self.assertFalse(err(sb._clean_ue({"n_ues": 16})))
        self.assertTrue(err(sb._clean_ue({"n_ues": 0})))
        self.assertTrue(err(sb._clean_ue({"n_ues": 17})))

    def test_ssb_range(self):
        self.assertFalse(err(sb._clean_ue({"ssb": 0})))
        self.assertFalse(err(sb._clean_ue({"ssb": 63})))
        self.assertTrue(err(sb._clean_ue({"ssb": 64})))

    def test_move_is_one_of_two_words(self):
        self.assertFalse(err(sb._clean_ue({"move": "static"})))
        self.assertFalse(err(sb._clean_ue({"move": "route"})))
        self.assertTrue(err(sb._clean_ue({"move": "orbit"})))

    def test_speed_is_a_plausible_ground_speed(self):
        self.assertFalse(err(sb._clean_ue({"speed_mps": 1.4})))
        self.assertFalse(err(sb._clean_ue({"speed_mps": 13.9})))
        self.assertTrue(err(sb._clean_ue({"speed_mps": 0.05})))
        self.assertTrue(err(sb._clean_ue({"speed_mps": 61})))

    def test_stagger_range(self):
        self.assertFalse(err(sb._clean_ue({"stagger_s": 0})))
        self.assertFalse(err(sb._clean_ue({"stagger_s": 60})))
        self.assertTrue(err(sb._clean_ue({"stagger_s": 61})))


    def test_cpu_lists_take_only_digits_commas_and_dashes(self):
        for good in ("7-20", "4,5,6", "1-6,16", "7"):
            self.assertFalse(err(sb._clean_ue({"ue_cpus": good})), good)
        for bad in ("7; rm -rf /", "$(id)", "7 20", "`whoami`", "all"):
            self.assertTrue(err(sb._clean_ue({"ue_cpus": bad})), bad)
            self.assertTrue(err(sb._clean_ue({"proxy_cpus": bad})), bad)

    def test_a_value_that_cannot_be_coerced_is_refused(self):
        out = sb._clean_ue({"n_ues": "several"})
        self.assertTrue(err(out))
        self.assertIn("n_ues", out)


if __name__ == "__main__":
    unittest.main()
