#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"

case "${1:?verb}" in
deps|build) : ;;
configure) need_dir "$SRC" "$SRC missing -- run make install STACK=$STACK" ;;
start)
    out="$VARDIR/datasets/$STACK/$(date +%Y%m%d_%H%M%S)"
    args=""
    for a in "$SRC/${DATASET_DIR:-ml/datasets}" "${DATASET_GLOB:?stack must set DATASET_GLOB}" \
             "$out" "${COLLECT_SECS:-180}" "${DATASET_ANALYZE:+$SRC/$DATASET_ANALYZE}"; do
        args="$args $(printf %q "$a")"
    done
    tmux_start dataset "TRAFFIC_TARGET=${TRAFFIC_TARGET:-10.0.0.1} UE_NETNS=${UE_NETNS:-} '$ROOT/scripts/collect_dataset.sh'$args"
    log "pane 'dataset' in tmux session '$(session)' -- output: $out"
    ;;
stop)   tmux_stop dataset ;;
status) is_up dataset && echo up || echo down ;;
*) die "dataset: unknown verb '$1'" ;;
esac
