import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app import stability as st


DU_RLF = """\
2026-08-11T09:15:01.100000 [METRICS ] Scheduler UE ue=0 metrics: pusch_snr_db=12.4 \
pusch_rsrp_db=-88.0 dl_error_rate=31% ul_error_rate=44% dl_brate= 100bps ul_brate=1.00kbps \
f2f3f4_invalid_csis=99 f2f3f4_invalid_harqs=0 pusch_invalid_harqs=0
2026-08-11T09:15:02.000000 [MAC     ] [I] ue=0: RLF detected. Cause: 100 consecutive undecoded CSIs
2026-08-11T09:15:02.001000 [DU-MNG  ] [I] RLF detected with cause "MAC max KOs reached". Timer of 5000 msec started.
2026-08-11T09:15:07.002000 [DU-MNG  ] [I] RLF timer expired with cause="MAC max KOs reached". Requesting a UE release...
2026-08-11T09:15:07.003000 [DU-F1   ] [I] Tx PDU du=0 cu_ue=0 du_ue=0: UEContextReleaseRequest
"""

DU_COMMANDED = """\
2026-08-19T13:56:17.900000 [METRICS ] Scheduler UE ue=0 metrics: pusch_snr_db=34.2 \
pusch_rsrp_db=-51.6 dl_error_rate=0% ul_error_rate=0% dl_brate= 224bps ul_brate=4.86kbps \
f2f3f4_invalid_csis=50 f2f3f4_invalid_harqs=0 pusch_invalid_harqs=0
2026-08-19T13:56:18.418591 [DU-F1   ] [I] Rx PDU du=0 ue=0 cu_ue=0 du_ue=0: UEContextReleaseCommand
2026-08-19T13:56:18.704877 [DU-F1   ] [I] ue=0 c-rnti=0x4601 du_ue=0 cu_ue=0: F1 UE context removed.
2026-08-19T13:56:19.848227 [DU-F1   ] [I] Tx PDU du=0 cu_ue=0 du_ue=0: UEContextReleaseComplete
"""

UE_DROPPED = """\
[PHY]    Resynchronizing RX by 800 samples
[NAS]    Registration Accept
[NAS]    ioctl() failed
[NAS]    NR_NAS_CONN_RELEASE_IND
[RRC]    RRC moved into IDLE state
[PHY]    Resynchronizing RX by 335696 samples
"""


def make_run(**logs):
    tmp = TemporaryDirectory()
    d = Path(tmp.name)
    for name, text in logs.items():
        (d / f"{name}.log").write_text(text)
    return tmp, d


class MissingLogs(unittest.TestCase):

    def test_an_unobserved_run_is_not_a_healthy_run(self):
        tmp, d = make_run()
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertIsNone(out["dropped"])
        self.assertNotEqual(out["dropped"], False)

    def test_it_says_which_logs_it_could_not_read(self):
        tmp, d = make_run()
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(sorted(out["missing"]), ["cu", "du", "ue"])
        self.assertIn("unobserved", " ".join(out["findings"]))

    def test_a_partial_run_still_reports_what_is_missing(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertTrue(out["dropped"])
        self.assertEqual(sorted(out["missing"]), ["cu", "ue"])
        self.assertIn("not ruled out", " ".join(out["findings"]))


class Direction(unittest.TestCase):

    def test_a_request_the_du_sent_is_the_radio_giving_up(self):
        tmp, d = make_run(du=DU_RLF, ue=UE_DROPPED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertTrue(out["du"]["du_initiated"])
        self.assertFalse(out["du"]["cu_initiated"])
        self.assertIn("radio gave up", " ".join(out["findings"]))

    def test_a_command_the_du_received_is_the_core_deciding(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertTrue(out["du"]["cu_initiated"])
        self.assertFalse(out["du"]["du_initiated"])
        self.assertEqual(out["du"]["release_commanded_at"], "2026-08-19T13:56:18.418591")
        self.assertIn("came from the core", " ".join(out["findings"]))

    def test_release_complete_is_not_mistaken_for_a_release_decision(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertFalse(out["du"]["du_initiated"])

    def test_no_release_at_all_reads_as_no_release(self):
        quiet = "2026-08-19T12:00:00.000000 [METRICS ] Scheduler slice pci=1 nof_ues=1\n"
        tmp, d = make_run(du=quiet)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertFalse(out["dropped"])
        self.assertIn("was not let go", " ".join(out["findings"]))


class RadioHealth(unittest.TestCase):

    def test_it_reads_the_link_state_at_the_release(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["health"]["pusch_snr_db"], 34.2)
        self.assertEqual(out["health"]["dl_error_rate"], 0.0)
        self.assertIn("radio was healthy", " ".join(out["findings"]))

    def test_the_failing_link_does_not_read_as_healthy(self):
        tmp, d = make_run(du=DU_RLF)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["health"]["pusch_snr_db"], 12.4)
        self.assertNotIn("radio was healthy", " ".join(out["findings"]))

    def test_an_n_a_reading_does_not_erase_a_measured_one(self):
        with_na = DU_COMMANDED.replace(
            "2026-08-19T13:56:18.418591",
            "2026-08-19T13:56:04.772245 [METRICS ] Scheduler UE ue=0 metrics: cqi=n/a "
            "pusch_snr_db=n/a dl_error_rate=0% ul_error_rate=0% dl_brate= 0bps ul_brate=0bps\n"
            "2026-08-19T13:56:18.418591")
        tmp, d = make_run(du=with_na)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["health"]["pusch_snr_db"], 34.2)
        self.assertTrue(out["health"]["measured_before_last_report"])
        self.assertIn("radio was healthy", " ".join(out["findings"]))

    def test_a_run_with_only_n_a_readings_admits_it(self):
        only_na = ("2026-08-19T13:56:04.000000 [METRICS ] Scheduler UE ue=0 metrics: "
                   "pusch_snr_db=n/a dl_error_rate=0% ul_error_rate=0%\n"
                   "2026-08-19T13:56:18.418591 [DU-F1   ] [I] Rx PDU du=0 ue=0: "
                   "UEContextReleaseCommand\n")
        tmp, d = make_run(du=only_na)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertIsNone(out["health"]["pusch_snr_db"])
        self.assertFalse(out["health"]["measured_before_last_report"])
        self.assertNotIn("radio was healthy", " ".join(out["findings"]))

    def test_health_is_read_as_of_the_release_not_afterwards(self):
        after = DU_COMMANDED + (
            "2026-08-19T14:30:00.000000 [METRICS ] Scheduler UE ue=0 metrics: "
            "pusch_snr_db=0.1 pusch_rsrp_db=-120.0 dl_error_rate=100% ul_error_rate=100% "
            "dl_brate= 0bps ul_brate=0bps\n")
        tmp, d = make_run(du=after)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["health"]["pusch_snr_db"], 34.2)


class Counters(unittest.TestCase):

    def test_it_finds_the_counter_that_was_climbing(self):
        tmp, d = make_run(du=DU_RLF)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["counters"]["csi"]["max"], 99)
        self.assertEqual(out["counters"]["harq"]["max"], 0)
        self.assertIn("csi (max 99)", " ".join(out["findings"]))

    def test_a_counter_well_short_of_its_limit_is_not_flagged(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertEqual(out["counters"]["csi"]["max"], 50)
        self.assertNotIn("near a release threshold", " ".join(out["findings"]))


class Sources(unittest.TestCase):

    def test_a_run_with_its_own_logs_uses_them(self):
        tmp, d = make_run(du=DU_RLF, ue=UE_DROPPED, cu="")
        self.addCleanup(tmp.cleanup)
        src = st.resolve_sources(d)
        for name in ("du", "ue", "cu"):
            self.assertTrue(src[name]["found"])
            self.assertFalse(src[name]["shared"], name)

    def test_falling_back_to_a_live_log_is_declared_as_shared(self):
        tmp, d = make_run(du=DU_COMMANDED)
        self.addCleanup(tmp.cleanup)
        fake = Path(tmp.name) / "live_ue.log"
        fake.write_text(UE_DROPPED)
        with mock.patch.object(st, "LIVE_UE_LOG", fake):
            src = st.resolve_sources(d)
            self.assertTrue(src["ue"]["shared"])
            out = st.diagnose(d)
        self.assertIn("shared by every run", " ".join(out["findings"]))

    def test_live_can_be_switched_off(self):
        tmp, d = make_run()
        self.addCleanup(tmp.cleanup)
        src = st.resolve_sources(d, live=False)
        self.assertFalse(any(s["found"] for s in src.values()))


class Resyncs(unittest.TestCase):

    def test_a_large_resync_after_the_release_exonerates_the_transport(self):
        tmp, d = make_run(du=DU_RLF, ue=UE_DROPPED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertIn("recovered from it", " ".join(out["findings"]))

    def test_the_startup_resync_is_not_counted_against_the_transport(self):
        tmp, d = make_run(ue=UE_DROPPED)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        small = [r for r in out["ue"]["resyncs"] if r["samples"] == 800][0]
        big = [r for r in out["ue"]["resyncs"] if r["samples"] == 335696][0]
        self.assertTrue(small["startup"])
        self.assertTrue(small["before_release"])
        self.assertFalse(big["before_release"])

    def test_a_healthy_run_marks_its_startup_resync(self):
        healthy = "[PHY]    Resynchronizing RX by 800 samples\n[NAS]    Registration Accept\n"
        tmp, d = make_run(ue=healthy)
        self.addCleanup(tmp.cleanup)
        out = st.diagnose(d, live=False)
        self.assertFalse(out["ue"]["dropped"])
        self.assertTrue(out["ue"]["resyncs"][0]["startup"])


if __name__ == "__main__":
    unittest.main()
