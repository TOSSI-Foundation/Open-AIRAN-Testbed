import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

from app import ran_bridge as rb


UE_LINE = (
    "2026-08-18T07:43:36.145757 [METRICS ] Scheduler UE ue=0 pci=1 rnti=0x4601 metrics: "
    "cqi=n/a dl_ri=n/a dl_mcs=3 dl_brate=6.84kbps dl_nof_ok=16 dl_nof_nok=0 "
    "dl_error_rate=0% dl_bs=0 dl_nof_prbs=100 dl_olla=0.007 pusch_snr_db=44.8 "
    "pusch_rsrp_db=-33.9 ul_ri=1 ul_mcs=25 ul_brate=35.7kbps ul_nof_ok=8 ul_nof_nok=0 "
    "ul_error_rate=0% ul_nof_prbs=63 bsr=0 sr_count=8 f2f3f4_invalid_csis=35 ul_olla=0 "
    "ta=-85ns last_phr=38"
)

UE_LINE_PADDED = (
    "2026-08-18T07:43:50.336669 [METRICS ] Scheduler UE ue=0 pci=1 rnti=0x4601 metrics: "
    "cqi=n/a dl_ri=n/a dl_mcs=3 dl_brate= 224bps dl_nof_ok=1 dl_nof_nok=0 "
    "dl_error_rate=0% dl_bs=0 dl_nof_prbs=2 dl_olla=0.008 pusch_snr_db=40.0 "
    "pusch_rsrp_db=-33.9 ul_ri=1 ul_mcs=27 ul_brate=4.86kbps ul_nof_ok=1 ul_nof_nok=0 "
    "ul_error_rate=0% ul_nof_prbs=5 bsr=0 sr_count=1"
)

CELL_LINE = (
    "2026-08-18T07:43:18.836169 [METRICS ] Scheduler cell pci=1 metrics: "
    "total_dl_brate= 0.0bps total_ul_brate= 0.0bps nof_prbs=106 nof_dl_slots=1253 "
    "nof_ues=0 mean_latency=4usec max_latency=48usec"
)


class ParseUeMetrics(unittest.TestCase):

    def test_reads_every_field_off_a_real_line(self):
        s = rb._parse_ue_metrics(UE_LINE)
        self.assertIsNotNone(s)
        self.assertEqual(s["ue"], 0)
        self.assertEqual(s["pci"], 1)
        self.assertEqual(s["rnti"], "0x4601")
        self.assertEqual(s["t"], "2026-08-18T07:43:36.145757")
        self.assertEqual(s["dl_mcs"], 3)
        self.assertEqual(s["ul_mcs"], 25)
        self.assertEqual(s["dl_prbs"], 100)
        self.assertEqual(s["ul_prbs"], 63)
        self.assertEqual(s["dl_ok"], 16)
        self.assertEqual(s["dl_nok"], 0)
        self.assertEqual(s["dl_olla"], 0.007)
        self.assertEqual(s["snr_db"], 44.8)
        self.assertEqual(s["rsrp_db"], -33.9)
        self.assertEqual(s["dl_bler"], 0.0)
        self.assertEqual(s["ul_bler"], 0.0)

    def test_na_is_not_zero(self):
        s = rb._parse_ue_metrics(UE_LINE)
        self.assertIsNone(s["cqi"])

    def test_kbps_unit_is_read_not_assumed(self):
        s = rb._parse_ue_metrics(UE_LINE)
        self.assertEqual(s["dl_kbps"], 6.84)
        self.assertEqual(s["ul_kbps"], 35.7)

    def test_padded_small_rate_survives(self):
        s = rb._parse_ue_metrics(UE_LINE_PADDED)
        self.assertIsNotNone(s)
        self.assertEqual(s["dl_kbps"], 0.224)
        self.assertEqual(s["ul_kbps"], 4.86)
        self.assertEqual(s["dl_prbs"], 2)

    def test_rate_scale_covers_every_unit_the_du_emits(self):
        self.assertEqual(rb._RATE_SCALE[""], 1e-3)
        self.assertEqual(rb._RATE_SCALE["k"], 1.0)
        self.assertEqual(rb._RATE_SCALE["M"], 1e3)
        self.assertEqual(rb._RATE_SCALE["G"], 1e6)

    def test_cell_line_is_not_a_ue(self):
        self.assertIsNone(rb._parse_ue_metrics(CELL_LINE))

    def test_unrelated_lines_are_ignored(self):
        self.assertIsNone(rb._parse_ue_metrics(""))
        self.assertIsNone(rb._parse_ue_metrics("2026-08-18T07:43:18 [DU-F1] F1 Setup: done"))


class ReportCadence(unittest.TestCase):

    @staticmethod
    def _samples(offsets):
        base = datetime(2026, 8, 18, 7, 43, 0)
        return [{"t": (base + timedelta(seconds=o)).isoformat()} for o in offsets]

    def test_gap_is_the_median_not_the_mean(self):
        s = self._samples([0, 1, 2, 300, 301])
        self.assertEqual(rb._report_gap_s(s), 1.0)

    def test_too_few_samples_to_tell(self):
        self.assertIsNone(rb._report_gap_s([]))
        self.assertIsNone(rb._report_gap_s(self._samples([0])))
        self.assertIsNone(rb._report_gap_s(self._samples([0, 1])))

    def test_unparseable_timestamps_do_not_raise(self):
        self.assertIsNone(rb._report_gap_s([{"t": "not a time"}, {"t": None}, {}]))

    def test_realtime_du_keeps_the_old_floor(self):
        self.assertEqual(rb._fresh_window_s(self._samples([0, 1, 2, 3, 4])),
                         rb.KPI_FRESH_MIN_S)

    def test_slow_du_gets_a_window_that_scales(self):
        s = self._samples([0, 16.6, 33.2, 49.8, 66.4])
        self.assertEqual(rb._fresh_window_s(s), 41.5)

    def test_no_cadence_falls_back_to_the_floor(self):
        self.assertEqual(rb._fresh_window_s([]), rb.KPI_FRESH_MIN_S)

    def test_age_of_a_missing_or_broken_timestamp(self):
        self.assertIsNone(rb._age_s(None))
        self.assertIsNone(rb._age_s(""))
        self.assertIsNone(rb._age_s("yesterday"))

    def test_freshness_uses_the_window_it_is_given(self):
        recent = (datetime.now() - timedelta(seconds=10)).isoformat()
        self.assertFalse(rb._is_fresh(recent, 4.0))
        self.assertTrue(rb._is_fresh(recent, 41.5))
        self.assertFalse(rb._is_fresh(None, 41.5))


class LineCounting(unittest.TestCase):
    def test_count_counts_lines_not_occurrences(self):
        lines = ["a b", "b b", "c"]
        self.assertEqual(rb._count(["b"], lines), 2)
        self.assertEqual(rb._count(["a", "c"], lines), 2)
        self.assertEqual(rb._count(["zzz"], lines), 0)

    def test_two_patterns_matching_one_line_both_count(self):
        self.assertEqual(rb._count(["a", "b"], ["a b"]), 2)

    def test_last_index_reports_the_final_match(self):
        lines = ["hit", "miss", "hit", "miss"]
        self.assertEqual(rb._last_index(["hit"], lines), 2)
        self.assertEqual(rb._last_index(["absent"], lines), -1)
        self.assertEqual(rb._last_index(["hit"], []), -1)


LADDER = [
    "[NR_PHY] pbch decoded sucessfully",
    "[NR_RRC] SIB1 decoded",
    "[NR_MAC] RAR-Msg2 decoded",
    "[NR_RRC] RRCSetupComplete",
    "[NAS] Registration Accept",
    "[PHY] SINR = 77 dB, CQI = 15",
]


class FakeRun:

    def __init__(self, stdout=""):
        self.stdout = stdout
        self.returncode = 0


class UeStatus(unittest.TestCase):

    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.log = Path(self._tmp.name) / "ue1_nue.log"
        self.addCleanup(self._tmp.cleanup)

    def _status(self, lines, ip="10.0.0.14", running=True):
        self.log.write_text("\n".join(lines) + "\n")
        out = "inet {}/24 scope global oaitun_ue1".format(ip) if ip else ""
        with mock.patch.object(rb, "UE_LOG", self.log), \
             mock.patch.object(rb, "_ue_running", return_value=running), \
             mock.patch.object(rb.subprocess, "run", return_value=FakeRun(out)):
            return rb._ue_status()

    def test_a_dead_ue_is_not_reported_from_a_surviving_log(self):
        s = self._status(LADDER, running=False)
        self.assertFalse(s["present"])

    def test_full_ladder_reaches_registered(self):
        s = self._status(LADDER)
        self.assertTrue(s["present"])
        self.assertEqual(s["stage"], "REGISTERED")
        self.assertEqual((s["sync"], s["sib1"], s["rar"], s["rrc"], s["reg"]), (1, 1, 1, 1, 1))
        self.assertEqual(s["ip"], "10.0.0.14")
        self.assertTrue(s["attached"])

    def test_partial_ladder_stops_where_it_stopped(self):
        self.assertEqual(self._status(LADDER[:1])["stage"], "SYNC")
        self.assertEqual(self._status(LADDER[:2])["stage"], "SIB1")
        self.assertEqual(self._status(LADDER[:3])["stage"], "RAR")
        self.assertEqual(self._status(LADDER[:4])["stage"], "RRC")

    def test_searching_when_nothing_has_happened(self):
        s = self._status(["[PHY] starting cell search"])
        self.assertEqual(s["stage"], "searching")
        self.assertFalse(s["attached"])

    def test_registration_without_a_tunnel_is_not_attached(self):
        s = self._status(LADDER, ip=None)
        self.assertIsNone(s["ip"])
        self.assertFalse(s["attached"])

    def test_a_ue_that_registered_then_dropped_is_not_attached(self):
        s = self._status(LADDER + ["[NR_RRC] RRC moved into IDLE state"])
        self.assertEqual(s["reg"], 1)
        self.assertFalse(s["attached"])

    def test_nas_release_also_ends_the_attachment(self):
        s = self._status(LADDER + ["[NAS] Received NR_NAS_CONN_RELEASE_IND: cause OTHER"])
        self.assertFalse(s["attached"])

    def test_reattaching_after_a_drop_counts_again(self):
        s = self._status(LADDER + ["[NR_RRC] RRC moved into IDLE state",
                                   "[NAS] Registration Accept"])
        self.assertTrue(s["attached"])

    def test_sinr_is_read_with_its_cqi(self):
        s = self._status(LADDER)
        self.assertEqual(s["sinr"], 77.0)
        self.assertEqual(s["sinr_samples"][-1], {"sinr": 77.0, "cqi": 15})
        self.assertFalse(s["sinr_stale"])

    def test_a_detached_ues_last_sinr_is_marked_stale(self):
        s = self._status(LADDER + ["[NR_RRC] RRC moved into IDLE state"])
        self.assertIsNone(s["sinr"])
        self.assertEqual(s["sinr_last_seen"], 77.0)
        self.assertTrue(s["sinr_stale"])

    def test_negative_and_fractional_sinr_parse(self):
        s = self._status(LADDER + ["[PHY] SINR = -3.5 dB, CQI = 2"])
        self.assertEqual(s["sinr"], -3.5)
        self.assertEqual(s["sinr_samples"][-1]["cqi"], 2)

    def test_sinr_without_a_cqi(self):
        s = self._status(LADDER + ["[PHY] SINR = 41 dB"])
        self.assertEqual(s["sinr_samples"][-1], {"sinr": 41.0, "cqi": None})

    def test_only_the_last_sixty_sinr_samples_are_kept(self):
        extra = ["[PHY] SINR = {} dB, CQI = 9".format(i) for i in range(100)]
        s = self._status(LADDER + extra)
        self.assertEqual(len(s["sinr_samples"]), 60)
        self.assertEqual(s["sinr"], 99.0)

    def test_a_missing_log_is_not_a_crash(self):
        with mock.patch.object(rb, "UE_LOG", Path("/nonexistent/ue.log")), \
             mock.patch.object(rb, "_ue_running", return_value=True):
            self.assertFalse(rb._ue_status()["present"])


if __name__ == "__main__":
    unittest.main()
