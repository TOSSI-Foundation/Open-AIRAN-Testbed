#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"
BIN="$SRC/${OCUDU_BUILD_DIR:-build}/apps/cu/ocu"

case "${1:?verb}" in
deps|build) : ;;
configure)
    [ -n "${CU_CFG:-}" ] || die "$STACK.conf sets no CU_CFG"
    for _cfg in $CU_CFG; do
        need_file "$(ocudu_cfg "$_cfg")" "CU config $(ocudu_cfg "$_cfg") not found"
    done
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    CFG_FLAGS=""; for _c in $CU_CFG; do CFG_FLAGS="$CFG_FLAGS -c '$(ocudu_cfg "$_c")'"; done
    if [[ " $COMPONENTS " == *" core5g "* ]]; then
        _ov="$(core_overlays)" || die "cannot point the CU at the core (see above)"
        for _c in $_ov; do CFG_FLAGS="$CFG_FLAGS -c '$_c'"; done
    fi
    tmux_start ocudu-cu "cd '$SRC' && sudo ${CU_TASKSET:+taskset -c $CU_TASKSET} '$BIN'$CFG_FLAGS"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop ocudu-cu ;;
status) is_up ocudu-cu && echo up || echo down ;;
*) die "ocudu-cu: unknown verb '$1'" ;;
esac
