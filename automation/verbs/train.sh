#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

[ -n "${ML_TRAIN:-}" ] || die "$STACK has no ML model to train"
SRC="$OCUDU_SRC_DIR"
need_dir "$SRC/ml/training" "$SRC/ml/training not found -- make install STACK=$STACK"
execute mkdir -p "$SRC/$(dirname "$ML_MODEL")" "$VARDIR/ml/$STACK"
log "train $STACK in $SRC"
log "$ML_TRAIN"
CSVS=""
if [ -n "${TRAIN_SET:-}" ]; then
    need_file "$TRAIN_SET" "TRAIN_SET $TRAIN_SET not found"
    while IFS= read -r f; do [ -n "$f" ] && { need_file "$f" "dataset $f not found"; CSVS="$CSVS '$f'"; }; done < "$TRAIN_SET"
    log "training on $(grep -c . "$TRAIN_SET") selected dataset(s)"
fi

[ -n "${TRAIN_PY:-}" ] && ML_TRAIN="${ML_TRAIN/#python3 /$TRAIN_PY }"
if [ -n "${TRAIN_HOST:-}" ]; then
    ssh_split "$TRAIN_HOST"; R="tossi-train/$STACK"; E="$TOSSI_SSH${SSH_P:+ -p $SSH_P}"
    log "train on $TRAIN_HOST (~/$R)"
    [ -n "${DRYRUN:-}" ] && { printf '   [dryrun] sync ml/ + datasets, run %s there, copy results back\n' "$ML_TRAIN"; exit 0; }
    rssh "$TRAIN_HOST" "mkdir -p '$R/data' '$R/var'" || die "cannot ssh to $TRAIN_HOST"
    execute rsync -a --delete -e "$E" "$SRC/ml/" "$SSH_H:$R/ml/"
    RCSVS=""; n=0
    while IFS= read -r f; do
        [ -n "$f" ] || continue
        n=$((n + 1)); dst="data/$n-$(basename "$f")"
        execute rsync -a -e "$E" "$f" "$SSH_H:$R/$dst"; RCSVS="$RCSVS '$dst'"
    done < "${TRAIN_SET:-/dev/null}"
    rssh "$TRAIN_HOST" "cd '$R' && nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | sed 's/^/   gpu: /'; ${ML_TRAIN//"$VARDIR/"/var/}$RCSVS" \
        || die "training failed on $TRAIN_HOST (python deps there? TRAIN_PY=<a python with them>)"
    execute rsync -a -u -e "$E" --exclude 'datasets/' "$SSH_H:$R/ml/" "$SRC/ml/"
    execute rsync -a -e "$E" "$SSH_H:$R/var/" "$VARDIR/"
    ok "model written: $SRC/$ML_MODEL (trained on $TRAIN_HOST)"
    exit 0
fi
execute_sh "cd '$SRC' && $ML_TRAIN$CSVS"
ok "model written: $SRC/$ML_MODEL"
