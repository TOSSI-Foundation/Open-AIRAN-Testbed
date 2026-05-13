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
    if [ "${CORE:-oai-cn5g}" = sd-core ] && [[ "${UE_ARGS:-}" != *uicc0* ]]; then
        UE_ARGS="${UE_ARGS:-} --uicc0.imsi 001010100007500 --uicc0.key 5122250214c33e723a5dd523fc145fc0"
        UE_ARGS="$UE_ARGS --uicc0.opc 981d464c7c52eb6e5036234984ad0bcf --uicc0.dnn internet --uicc0.nssai_sst 1 --uicc0.nssai_sd 66051"
    fi
    tmux_start oai-nrue "cd '$WORKSPACE/uerun' && sudo '$BIN' -O '$UE_CONF' ${UE_ARGS:-}"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop oai-nrue ;;
status) is_up oai-nrue && echo up || echo down ;;
*) die "oai-nrue: unknown verb '$1'" ;;
esac
