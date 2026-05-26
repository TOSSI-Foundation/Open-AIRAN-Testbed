# knob: RADIO zmq|liteon Radio front-end -- zmq: simulated, no RF; liteon: LiteOn O-RU over Open Fronthaul 7.2
# knob: ML_MODE collect|shadow|closed-loop ML mode
# knob: GNB_SPLIT cu-du|monolithic gNB layout (RADIO=liteon) -- cu-du: CU + 7.2 DU over F1; monolithic: one gnb
# config: ML_EXTRA_CFG Extra ML overlays -- a new feature's own overlays (e.g. se_shadow.yml), after the stack's
# config: RADIO_CFG Radio gNB config (RADIO=liteon) -- the RU's gNB yml (VF, RU MAC, cell); a DU yml for cu-du
COMPONENTS="ocudu-cu ocudu core5g"
START_ORDER="core5g ocudu-cu ocudu"
NEEDS="zmq"

OAI_BRANCH=develop
CMAKE_OPTS="-DDU_SPLIT_TYPE=SPLIT_8"
OCUDU_TARGETS="ocu odu_split_8"
OCUDU_APP=odu
OCUDU_APP_DIR=du_split_8
ML_MODE="${ML_MODE:-collect}"
ML_MODE_CFG=""
[ "$ML_MODE" != collect ] && ML_MODE_CFG="$ROOT/configs/ai-ran/${ML_OVERLAY%_collect.yml}_$ML_MODE.yml"
OCUDU_CFG="du_liteon_zmq.yaml $ROOT/configs/ai-ran/$ML_OVERLAY $ML_MODE_CFG ${ML_EXTRA_CFG:-}"
CU_CFG="cu.yml"

OCUDU_ENV="OCUDU_INJECT_ENABLE=0"
CU_TASKSET="${CU_TASKSET:-1-2}"
OCUDU_TASKSET="${OCUDU_TASKSET:-3-8}"

HEALTH="ocudu-cu:(====.*started) ocudu:(====.*started)"

RADIO="${RADIO:-zmq}"
if [ "$RADIO" = liteon ]; then
    COMPONENTS="ptp ocudu core5g"
    START_ORDER="core5g ptp ocudu"
    NEEDS="dpdk hugepages nic ptp"
    OCUDU_BUILD_DIR=build_72
    CMAKE_OPTS="-DDU_SPLIT_TYPE=SPLIT_7_2 -DENABLE_DPDK=True -DASSERT_LEVEL=MINIMAL"
    RADIO_CFG="${RADIO_CFG:-${RADIO_EXAMPLE:-radio-config-not-set.yml}}"
    OCUDU_CFG="$RADIO_CFG $ROOT/configs/ai-ran/$ML_OVERLAY $ML_MODE_CFG ${ML_EXTRA_CFG:-} $ROOT/configs/ai-ran/metrics.yml"
    if [ -z "${GNB_SPLIT:-}" ]; then
        case "$RADIO_CFG" in /*) _rc="$RADIO_CFG" ;; *) _rc="${OCUDU_SRC_DIR:-}/configs/$RADIO_CFG" ;; esac
        GNB_SPLIT=monolithic; grep -qs '^f1ap:' "$_rc" && GNB_SPLIT=cu-du
    fi
    if [ "$GNB_SPLIT" = cu-du ]; then
        COMPONENTS="ptp ocudu-cu ocudu core5g"
        START_ORDER="core5g ptp ocudu-cu ocudu"
        OCUDU_APP=odu
        OCUDU_APP_DIR=du_split_7_2
        OCUDU_TARGETS="ocu odu_split_7_2"
        HEALTH_CU="ocudu-cu:(====.*started) "
    else
        OCUDU_APP=gnb
        OCUDU_APP_DIR=gnb
        OCUDU_TARGETS=gnb
        CU_CFG=""
        HEALTH_CU=""
    fi
    OCUDU_TASKSET=""
    KERNEL_PROFILE=ran-72
    PTP_PROFILE=falcon
    PTP_IF="${PTP_IF:-${IF:-}}"
    HEALTH="ptp:(master.offset|rms) ${HEALTH_CU}ocudu:(====.*started)"
fi
