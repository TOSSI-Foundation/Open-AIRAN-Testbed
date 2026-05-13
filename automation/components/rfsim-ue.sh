#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"
H="./rfsim_multi_ue.sh"
DN="${RFSIM_DN:-192.168.70.129}"

case "${1:?verb}" in
deps|build) : ;;
configure) need_file "$SRC/$H" "$SRC/$H missing -- is OCUDU on rfsim?" ;;
start)
    out="$VARDIR/datasets/$STACK/$(date +%Y%m%d_%H%M%S)"
    execute mkdir -p "$out"
    tmux_start rfsim-ue "cd '$SRC' && sudo $H -k -D $DN && sudo $H -a '$OAI_SRC_DIR' \
        -n ${NUM_UES:-2} -b ${RFSIM_BW:-40} -s ${UE_STAGGER:-12} -t ${IPERF_SECS:-10} -D $DN \
        -o '$out/per_ue.csv' -O '$out/summary.txt' -F '$out/failed.log'"
    log "pane 'rfsim-ue' in tmux session '$(session)' -- report: $out"
    ;;
stop)
    tmux_stop rfsim-ue
    execute_sh "cd '$SRC' && sudo $H -k -D $DN >/dev/null 2>&1; true"
    ;;
status) is_up rfsim-ue && echo up || echo down ;;
*) die "rfsim-ue: unknown verb '$1'" ;;
esac
