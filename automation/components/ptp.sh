#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

PROFILE="${PTP_PROFILE:-falcon}"
RENDERED="$RUNDIR/ptp.cfg"

resolve_cfg() {
    [ -n "${PTP_IF:-}" ] || die "PTP needs an interface: make <target> STACK=$STACK IF=<iface>"
    if [ -z "${PTP_CFG:-}" ]; then
        PTP_CFG="$ROOT/configs/ptp/$([ "$PROFILE" = aerial ] && echo aerial.cfg || echo falcon-rx-e810.cfg)"
        if [ -t 0 ] && [ -z "${DRYRUN:-}" ] && [ -z "${PTP_ASSUME_DEFAULT:-}" ]; then
            echo "   PTP profile '$PROFILE' -> $(basename "$PTP_CFG")"
            read -r -p "   use it? [Y/n or path to your own cfg]: " ans
            case "$ans" in
                ""|y|Y|yes) ;;
                n|N|no) die "aborted -- rerun with PTP_CFG=/path/to/your.cfg" ;;
                *) [ -f "$ans" ] || die "no such config: $ans"; PTP_CFG="$ans" ;;
            esac
        fi
    fi
    need_file "$PTP_CFG" "ptp config $PTP_CFG not found"
}

case "${1:?verb}" in
deps)
    command -v ptp4l >/dev/null && command -v phc2sys >/dev/null \
        || execute sudo apt-get install -y linuxptp
    command -v tmux >/dev/null || execute sudo apt-get install -y tmux
    ;;
build) : ;;
configure)
    resolve_cfg
    execute mkdir -p "$(dirname "$RENDERED")"
    if [ -z "${DRYRUN:-}" ]; then
        { cat "$PTP_CFG"; printf '\n[%s]\nannounceReceiptTimeout 3\ndelay_mechanism E2E\nnetwork_transport L2\n' "$PTP_IF"; } > "$RENDERED"
    fi
    log "ptp: profile=$PROFILE iface=$PTP_IF cfg=$RENDERED"
    ;;
start)
    resolve_cfg
    if [ "$PROFILE" = aerial ]; then
        tmux_start ptp4l   "sudo ptp4l -f '$RENDERED' -m"
        tmux_start phc2sys "sleep 2; sudo phc2sys -s '$PTP_IF' -c CLOCK_REALTIME -n 24 -O 0 -R 256 -u 256 -m"
    else
        local_pid=$(pgrep -af '[p]tp4l' | grep -w -- "$PTP_IF" | awk '{print $1}' | head -1)
        if [ -n "$local_pid" ]; then
            exe=$(sudo readlink "/proc/$local_pid/exe"); cwd=$(sudo readlink "/proc/$local_pid/cwd")
            run_cfg=$(tr '\0' '\n' < "/proc/$local_pid/cmdline" | grep -A1 -x -- '-f' | tail -1)
            case "$run_cfg" in ""|/*) ;; *) run_cfg="$cwd/$run_cfg" ;; esac
            pmc_bin=$(command -v pmc || echo "$(dirname "$exe")/pmc")
            log "ptp4l already running on $PTP_IF (pid $local_pid) -- reusing it"
            tmux_start ptp4l "while :; do sudo '$pmc_bin' -u -b 0 ${run_cfg:+-f '$run_cfg'} 'GET TIME_STATUS_NP' | grep -E 'master_offset|gmPresent'; sleep 2; done"
        else
            tmux_start ptp4l "sudo ptp4l -i '$PTP_IF' -m -H -2 -s -f '$RENDERED'"
        fi
        if pgrep -x phc2sys >/dev/null; then
            log "phc2sys already running -- reusing it"
        else
            p2s=$(command -v phc2sys || echo "$(dirname "${exe:-/usr/sbin/x}")/phc2sys")
            tmux_start phc2sys "sleep 2; sudo '$p2s' -w -m -s '$PTP_IF' -R 8 -f '${run_cfg:-$RENDERED}'"
        fi
    fi
    cp "$(pidfile ptp4l)" "$(pidfile ptp)" 2>/dev/null || true
    ln -sf "$(logfile ptp4l)" "$(logfile ptp)" 2>/dev/null || true
    ;;
stop)
    tmux_stop ptp4l; tmux_stop phc2sys; rm -f "$(pidfile ptp)"
    ;;
status) is_up ptp && echo up || echo down ;;
*) die "ptp: unknown verb '$1'" ;;
esac
