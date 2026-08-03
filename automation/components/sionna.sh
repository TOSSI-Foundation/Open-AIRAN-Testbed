#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"
VENV="${SIONNA_VENV:-$HOME/sionna-rt-env}"

case "${1:?verb}" in
deps)
    execute_sh "python3 -m venv '$VENV'"
    execute_sh ". '$VENV/bin/activate' && python -m pip install --upgrade pip setuptools wheel && pip install sionna-rt"
    ;;
build) : ;;
configure)
    need_file "$SRC/${SIONNA_PUB:?}" "publisher $SIONNA_PUB not found -- is OCUDU on dev?"
    execute_sh ". '$VENV/bin/activate' && python -c \"import sionna.rt, mitsuba as mi; print('sionna-rt', sionna.rt.__version__, 'on', mi.variant() or 'auto')\""
    ;;
start)
    args="${SIONNA_ARGS:-}"
    if [ -n "${SIONNA_ARGS_FILE:-}" ]; then
        need_file "$SIONNA_ARGS_FILE" "publisher arguments $SIONNA_ARGS_FILE not found -- run the stack from the Simulation page again"
        args="$(cat "$SIONNA_ARGS_FILE")"
    fi
    tmux_start sionna "cd '$SRC' && . '$VENV/bin/activate' && ${SIONNA_SCENE_BUILDER:+SIONNA_SCENE_BUILDER='$SIONNA_SCENE_BUILDER'} python -u '$SIONNA_PUB' $args"
    log "pane 'sionna' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop sionna ;;
status) is_up sionna && echo up || echo down ;;
*) die "sionna: unknown verb '$1'" ;;
esac
