#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OAI_SRC_DIR:-$WORKSPACE/OAI-RAN}"
BIN="$SRC/cmake_targets/ran_build/build/nr-uesoftmodem"
UE_CONF="${UE_CFG:-}"; case "$UE_CONF" in ""|/*) ;; *) UE_CONF="$SRC/$UE_CONF" ;; esac

case "${1:?verb}" in
deps)   execute_sh "cd '$SRC/cmake_targets' && sudo ./build_oai -I" ;;
build)
    need_dir "$SRC" "$SRC missing -- run make install STACK=$STACK"
    execute_sh "cd '$SRC/cmake_targets' && ./build_oai ${UE_BUILD_ARGS:--c --ninja -w ZMQ --nrUE}"
    ;;
configure)
    [ -n "$UE_CONF" ] || { log "oai-nrue: no UE_CFG, build only"; exit 0; }
    need_file "$UE_CONF" "UE config $UE_CONF not found"
    execute mkdir -p "$WORKSPACE/uerun"
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    [ -n "$UE_CONF" ] || die "$STACK.conf sets no UE_CFG"
    ue_settings
    if [[ "${UE_ARGS:-}" != *uicc0* ]] && [ -n "$UE_IMSI_BASE" ]; then
        UE_ARGS="${UE_ARGS:-} --uicc0.imsi $UE_IMSI_BASE --uicc0.key $UE_KEY --uicc0.opc $UE_OPC"
        UE_ARGS="$UE_ARGS --uicc0.pdu_sessions.[0].dnn $UE_DNN --uicc0.nssai_sst $UE_SST --uicc0.pdu_sessions.[0].nssai_sst $UE_SST"
        [ -n "$UE_SD" ] && UE_ARGS="$UE_ARGS --uicc0.nssai_sd $((16#$UE_SD)) --uicc0.pdu_sessions.[0].nssai_sd $((16#$UE_SD))"
    fi
    tmux_start oai-nrue "cd '$WORKSPACE/uerun' && sudo '$BIN' -O '$UE_CONF' ${UE_ARGS:-}"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop oai-nrue ;;
status) is_up oai-nrue && echo up || echo down ;;
*) die "oai-nrue: unknown verb '$1'" ;;
esac
