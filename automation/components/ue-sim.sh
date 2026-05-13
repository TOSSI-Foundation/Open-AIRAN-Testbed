#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="$WORKSPACE/OAI-RAN/multi_ue_sim"
BIN="$SRC/dashboard/target/release/ue-sim"

case "${1:?verb}" in
deps)
    execute pip3 install --user pyzmq numpy
    command -v cargo >/dev/null || die "multi-ue-sim needs the rust toolchain: https://rustup.rs"
    ;;
build)
    need_dir "$SRC" "$SRC missing -- run make install STACK=$STACK"
    execute_sh "cd '$SRC/dashboard' && cargo build --release"
    ;;
configure)
    execute_sh "cd '$SRC' && bash provision_subscribers.sh ${NUM_UES:-10}"
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    log "dashboard is interactive -- press 's' to start UEs, 'q' to quit"
    execute_sh "cd '$SRC' && IMSI_BASE='${IMSI_BASE}' PROXY_WAVE_SIZE='${PROXY_WAVE_SIZE}' \
        PROXY_WAVE_DELAY_S='${PROXY_WAVE_DELAY_S}' N_RB='${N_RB}' \
        '$BIN' monitor --num-ues '${NUM_UES:-10}'"
    ;;
stop)   execute_sh "pkill -f 'ue-sim monitor' || true" ;;
status) pgrep -f "ue-sim monitor" >/dev/null && echo up || echo down ;;
*) die "ue-sim: unknown verb '$1'" ;;
esac
