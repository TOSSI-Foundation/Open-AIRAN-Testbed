#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OAI_SRC_DIR:-$WORKSPACE/OAI-RAN}"
BIN="$SRC/cmake_targets/ran_build/build/nr-softmodem"

case "${1:?verb}" in
deps)   execute_sh "cd '$SRC/cmake_targets' && sudo ./build_oai -I" ;;
build)
    need_dir "$SRC" "$SRC missing -- run make install STACK=$STACK"
    execute_sh "cd '$SRC/cmake_targets' && sudo ./build_oai --gNB --ninja \
        ${OAI_FH_TARGET:+-t $OAI_FH_TARGET} \
        ${XRAN_LOCATION:+--cmake-opt -Dxran_LOCATION=$XRAN_LOCATION}"
    ;;
configure)
    [ -n "${GNB_CFG:-}" ] || die "$STACK.conf sets no GNB_CFG"
    need_file "$SRC/$GNB_CFG" "gNB config $SRC/$GNB_CFG not found"
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    tmux_start oai-gnb "cd '$(dirname "$BIN")' && sudo env NFAPI_TRACE_LEVEL=${NFAPI_TRACE:-info} '$BIN' -O '$SRC/$GNB_CFG' ${OAI_GNB_ARGS:---nfapi PNF}"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop oai-gnb ;;
status) is_up oai-gnb && echo up || echo down ;;
*) die "oai-gnb: unknown verb '$1'" ;;
esac
