#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="$OAI_SRC_DIR/multi_ue_sim"
BIN="$OAI_SRC_DIR/cmake_targets/ran_build/build/nr-uesoftmodem"
N="${NUM_UES:-1}"

ue_settings
UE_SD_INT=16777215; [ -n "$UE_SD" ] && UE_SD_INT=$((16#$UE_SD))

case "${1:?verb}" in
deps|build) : ;;
configure) need_file "$SRC/run_nue.sh" "$SRC/run_nue.sh missing -- is OAI on develop?" ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    tmux_start nue "cd '$SRC' && sudo env UE_BIN='$BIN' N_RB='${N_RB:-51}' SD='$UE_SD_INT' NSSAI_SST='$UE_SST' \
        ${UE_IMSI_BASE:+IMSI_BASE=$UE_IMSI_BASE} ${UE_KEY:+KEY=$UE_KEY} ${UE_OPC:+OPC=$UE_OPC} ${UE_DNN:+DNN=$UE_DNN} \
        ${UE_FREQ:+FREQ=$UE_FREQ} ${UE_CPUS:+UE_CPUS=$UE_CPUS} bash run_nue.sh $N && for i in \$(seq 20); do p=\$(pgrep -nx nr-uesoftmodem) && break; sleep 0.5; done; [ -n \"\$p\" ] && tail --pid=\$p -F logs/ue1_nue.log"
    log "pane 'nue' in tmux session '$(session)' -- UE 1 is netns ue1 (sudo ip netns exec ue1 ...)"
    ;;
stop)
    tmux_stop nue
    execute_sh "cd '$SRC' && sudo bash run_nue.sh $N --stop >/dev/null 2>&1; true"
    ;;
status) is_up nue && echo up || echo down ;;
*) die "nue: unknown verb '$1'" ;;
esac
