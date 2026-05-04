#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="$WORKSPACE/xFAPI"
MODE="${XFAPI_MODE:?stack must set XFAPI_MODE}"

case "${1:?verb}" in
deps) : ;;
build)
    need_dir "$SRC" "$SRC missing -- run make fetch STACK=$STACK"
    need_dir "$OAI_SRC_DIR/nfapi" "$OAI_SRC_DIR/nfapi missing -- run make fetch STACK=$STACK"
    execute "$SRC/sync_nfapi.sh" "$OAI_SRC_DIR"
    execute_sh "cd '$SRC' && . ./setup_env.sh && ./build_xfapi.sh --mode=$MODE"
    ;;
configure)
    [ -n "${XFAPI_CFG:-}" ] || die "$STACK.conf sets no XFAPI_CFG"
    need_file "$SRC/conf/$XFAPI_CFG" "config $SRC/conf/$XFAPI_CFG not found"
    ;;
start)
    tmux_start xfapi "cd '$SRC' && sudo ./bin/xfapi_main --cfgfile 'conf/$XFAPI_CFG'"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop xfapi ;;
status) is_up xfapi && echo up || echo down ;;
*) die "xfapi: unknown verb '$1'" ;;
esac
