#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

sudo_prime
[ -f "$VARDIR/overrides/$STACK.env" ] && log "settings from var/overrides/$STACK.env: $(grep -oE '^[A-Z][A-Z0-9_]*' "$VARDIR/overrides/$STACK.env" | tr '\n' ' ')"
log "configure $STACK"
for c in $COMPONENTS; do
    component "$c" configure || die "$c: configure failed -- fix the above, nothing was started"
done

health_pat() {
    local c="$1" e
    for e in $HEALTH; do [ "${e%%:*}" = "$c" ] && { echo "${e#*:}"; return; }; done
}

log "start order: $START_ORDER"
run_begin
started=""
for c in $START_ORDER; do
    [ "$c" = core5g ] && [ "$COMPONENTS" != core5g ] && continue
    if is_up "$c"; then ok "$c already up$(h=$(host_of "$c"); echo "${h:+ on $h}")"; started="$c $started"; continue; fi
    log "start $c"
    if ! component "$c" start; then
        warn "$c failed to start -- rolling back: stopping $started"
        for r in $started; do component "$r" stop || true; done
        run_end failed
        die "$STACK did not come up"
    fi
    started="$c $started"
    pat="$(health_pat "$c")"
    if [ -n "$pat" ]; then
        wait_for "$c" "${HEALTH_TIMEOUT:-60}" "$pat" || {
            warn "rolling back: stopping $started"
            for r in $started; do component "$r" stop || true; done
            run_end failed
            die "$STACK did not come up"
        }
    fi
done
run_up

echo
"$ROOT/verbs/run.sh" status
