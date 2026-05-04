#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"
BIN="$SRC/${OCUDU_BUILD_DIR:-build}/apps/${OCUDU_LOW_APP_DIR:-du}/odu_low"

case "${1:?verb}" in
deps|build) : ;;
configure)
    [ -n "${OCUDU_LOW_CFG:-}" ] || die "$STACK.conf sets no OCUDU_LOW_CFG"
    need_file "$SRC/configs/$OCUDU_LOW_CFG" "config $SRC/configs/$OCUDU_LOW_CFG not found"
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    tmux_start ocudu-low "cd '$SRC' && sudo '$BIN' -c 'configs/$OCUDU_LOW_CFG'"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop ocudu-low ;;
status) is_up ocudu-low && echo up || echo down ;;
*) die "ocudu-low: unknown verb '$1'" ;;
esac
