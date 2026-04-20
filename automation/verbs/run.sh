#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

cmd="${1:-status}"; shift || true

case "$cmd" in
attach)
    tmux has-session -t "$(session)" 2>/dev/null || die "no tmux session '$(session)' -- is the stack deployed?"
    exec tmux attach -t "$(session)"
    ;;
status)
    if tmux has-session -t "$(session)" 2>/dev/null; then
        log "tmux session '$(session)': $(tmux list-panes -t "$(session):0" -F '#{pane_title}' 2>/dev/null | tr '\n' ' ')"
        log "attach with: make attach STACK=$STACK   (or tmux attach -t $(session))"
    fi
    printf '%-12s %-8s %-8s %s\n' COMPONENT STATE PID LOG
    for c in $START_ORDER; do
        h="$(host_of "$c")"
        if [ -n "$h" ]; then
            printf '%-12s %-8s %-8s %s\n' "$c" "$(is_up "$c" && echo up || echo down)" "@$h" "$h:$(remote_repo)/var/run/$STACK/$c.log"
        elif is_up "$c"; then
            printf '%-12s %-8s %-8s %s\n' "$c" up "$(cat "$(pidfile "$c")" 2>/dev/null || echo -)" "$(logfile "$c")"
        else
            printf '%-12s %-8s %-8s %s\n' "$c" down - "$(logfile "$c")"
        fi
    done
    ;;
logs)
    follow=""; [ "${1:-}" = "-f" ] && { follow="-f"; shift; }
    c="${1:?usage: run.sh logs [-f] <component>}"
    h="$(host_of "$c")"
    [ -n "$h" ] && ssh_split "$h"; exec $TOSSI_SSH ${follow:+-t} ${SSH_P:+-p "$SSH_P"} "$SSH_H" "tail $follow -n 200 '$(remote_repo)/var/run/$STACK/$c.log'"
    tail $follow -n 200 "$(logfile "$c")"
    ;;
stop)
    rev=""; for c in $START_ORDER; do rev="$c $rev"; done
    for c in $rev; do
        is_up "$c" || [ "$c:${CORE:-}" = core5g:sd-core ] || continue
        log "stop $c"
        component "$c" stop || warn "$c did not stop cleanly"
    done
    tmux kill-session -t "$(session)" 2>/dev/null || true
    run_end stopped
    ;;
killall)
    rev=""; for c in $START_ORDER; do rev="$c $rev"; done
    for c in $rev; do component "$c" stop 2>/dev/null || true; done
    for n in ocu odu odu_low odu_high gnb nr-uesoftmodem nr-softmodem \
             xfapi_main ptp4l phc2sys cuphycontroller_scf; do
        pids=$(pgrep -x "$n" 2>/dev/null | tr '\n' ' ')
        [ -n "$pids" ] && { warn "killing leftover $n: $pids"; sudo kill -9 $pids 2>/dev/null; }
    done
    tmux kill-session -t "$(session)" 2>/dev/null
    rm -f "$RUNDIR"/*.pid "$RUNDIR"/*.pane
    run_end stopped
    log "$STACK: all components stopped, tmux session gone"
    ;;
restart)
    c="${1:?usage: run.sh restart <component>}"
    component "$c" stop || true
    component "$c" start
    ;;
*)  die "usage: run.sh status | attach | logs [-f] <c> | stop | killall | restart <c>" ;;
esac
