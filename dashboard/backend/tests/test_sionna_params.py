import unittest

from app import sionna_bridge as sb


def err(v):
    return isinstance(v, str)


class CleanSionna(unittest.TestCase):

    def test_defaults_are_all_accepted(self):
        out = sb._clean_sionna(dict(sb.SIONNA_DEFAULTS))
        self.assertFalse(err(out))
        self.assertEqual(out["max_depth"], sb.SIONNA_DEFAULTS["max_depth"])

    def test_a_typo_is_refused_rather_than_stored(self):
        out = sb._clean_sionna({"max_dept": 5})
        self.assertTrue(err(out))
        self.assertIn("unknown setting", out)

    def test_none_is_kept_as_none(self):
        out = sb._clean_sionna({"num_taps": None, "freq_hz": None})
        self.assertIsNone(out["num_taps"])
        self.assertIsNone(out["freq_hz"])


    def test_sixty_four_taps_is_the_ceiling(self):
        self.assertFalse(err(sb._clean_sionna({"num_taps": 64})))

    def test_sixty_five_taps_is_refused_and_says_why(self):
        out = sb._clean_sionna({"num_taps": 65})
        self.assertTrue(err(out))
        self.assertIn("64", out)

    def test_the_old_128_cap_would_not_pass_today(self):
        self.assertTrue(err(sb._clean_sionna({"num_taps": 118})))
        self.assertTrue(err(sb._clean_sionna({"num_taps": 128})))

    def test_zero_taps_is_not_a_channel(self):
        self.assertTrue(err(sb._clean_sionna({"num_taps": 0})))
        self.assertTrue(err(sb._clean_sionna({"num_taps": -1})))


    def test_max_depth_range(self):
        self.assertFalse(err(sb._clean_sionna({"max_depth": 0})))
        self.assertFalse(err(sb._clean_sionna({"max_depth": 12})))
        self.assertTrue(err(sb._clean_sionna({"max_depth": 13})))
        self.assertTrue(err(sb._clean_sionna({"max_depth": -1})))

    def test_max_drop_db_range(self):
        self.assertFalse(err(sb._clean_sionna({"max_drop_db": 35.0})))
        self.assertTrue(err(sb._clean_sionna({"max_drop_db": 201})))
        self.assertTrue(err(sb._clean_sionna({"max_drop_db": -1})))

    def test_array_dimensions_are_bounded(self):
        self.assertFalse(err(sb._clean_sionna({"array_rows": 8, "array_cols": 1})))
        self.assertTrue(err(sb._clean_sionna({"array_rows": 9})))
        self.assertTrue(err(sb._clean_sionna({"array_cols": 0})))

    def test_only_patterns_sionna_knows(self):
        for p in sorted(sb._PATTERNS):
            self.assertFalse(err(sb._clean_sionna({"array_pattern": p})))
            self.assertFalse(err(sb._clean_sionna({"rx_pattern": p})))
        self.assertTrue(err(sb._clean_sionna({"array_pattern": "parabolic"})))
        self.assertTrue(err(sb._clean_sionna({"rx_pattern": "parabolic"})))

    def test_only_polarisations_sionna_knows(self):
        for p in sorted(sb._POLS):
            self.assertFalse(err(sb._clean_sionna({"array_pol": p})))
        self.assertTrue(err(sb._clean_sionna({"array_pol": "X"})))
        self.assertTrue(err(sb._clean_sionna({"rx_pol": "circular"})))

    def test_values_are_coerced_to_their_declared_type(self):
        out = sb._clean_sionna({"los": 1, "max_depth": "5", "max_drop_db": "35"})
        self.assertIs(out["los"], True)
        self.assertEqual(out["max_depth"], 5)
        self.assertEqual(out["max_drop_db"], 35.0)

    def test_a_value_that_cannot_be_coerced_is_refused(self):
        out = sb._clean_sionna({"max_depth": "deep"})
        self.assertTrue(err(out))
        self.assertIn("max_depth", out)


class SolverFlags(unittest.TestCase):

    def setUp(self):
        self.flags = sb._solver_flags(dict(sb.SIONNA_DEFAULTS))

    def test_every_interaction_is_stated_either_way(self):
        for name in ("los", "specular", "diffuse", "refraction",
                     "diffraction", "edge-diffraction"):
            self.assertTrue(
                "--{}".format(name) in self.flags or "--no-{}".format(name) in self.flags,
                "{} not stated".format(name))

    def test_defaults_map_to_the_right_polarity(self):
        self.assertIn("--los", self.flags)
        self.assertIn("--specular", self.flags)
        self.assertIn("--refraction", self.flags)
        self.assertIn("--no-diffuse", self.flags)
        self.assertIn("--no-diffraction", self.flags)
        self.assertIn("--no-edge-diffraction", self.flags)

    def test_turning_one_off_flips_only_that_one(self):
        p = dict(sb.SIONNA_DEFAULTS)
        p["los"] = False
        out = sb._solver_flags(p)
        self.assertIn("--no-los", out)
        self.assertIn("--specular", out)

    def test_the_seed_is_always_passed(self):
        self.assertIn("--seed", self.flags)
        self.assertEqual(self.flags[self.flags.index("--seed") + 1],
                         str(sb.SIONNA_DEFAULTS["seed"]))

    def test_max_depth_leads(self):
        self.assertEqual(self.flags[0], "--max-depth")

    def test_optional_overrides_are_omitted_when_unset(self):
        for flag in ("--array-rows", "--array-cols", "--freq-hz", "--num-taps"):
            self.assertNotIn(flag, self.flags)

    def test_optional_overrides_appear_when_set(self):
        p = dict(sb.SIONNA_DEFAULTS)
        p.update({"array_rows": 4, "array_cols": 2, "num_taps": 16})
        out = sb._solver_flags(p)
        self.assertEqual(out[out.index("--array-rows") + 1], "4")
        self.assertEqual(out[out.index("--array-cols") + 1], "2")
        self.assertEqual(out[out.index("--num-taps") + 1], "16")

    def test_synthetic_array_is_only_mentioned_when_disabled(self):
        self.assertNotIn("--no-synthetic-array", self.flags)
        p = dict(sb.SIONNA_DEFAULTS)
        p["synthetic_array"] = False
        self.assertIn("--no-synthetic-array", sb._solver_flags(p))


if __name__ == "__main__":
    unittest.main()
