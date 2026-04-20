#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

ONLY=""; case "${1:-}" in --only=*) ONLY="${1#--only=}" ;; esac
[ -z "$ONLY" ] && [ -z "${DRYRUN:-}" ] && rm -f "$RUNDIR/built"

for c in $COMPONENTS; do
    [ -n "$ONLY" ] && [ "$ONLY" != "$c" ] && continue
    log "build $c"
    if component "$c" build 2>&1 | tee "$RUNDIR/build-$c.log"; then
        ok "$c built"
    else
        die "$c failed to build -- see $RUNDIR/build-$c.log"
    fi
done
[ -n "$ONLY" ] && [[ " $COMPONENTS " != *" $ONLY "* ]] && die "'$ONLY' is not in COMPONENTS ($COMPONENTS)"
[ -z "$ONLY" ] && [ -z "${DRYRUN:-}" ] && echo "$COMPONENTS" > "$RUNDIR/built"
log "$STACK built"
