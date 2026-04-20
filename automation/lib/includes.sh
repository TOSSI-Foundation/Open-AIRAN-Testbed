# shellcheck shell=bash
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VARDIR="$(dirname "$ROOT")/var"
# shellcheck source=versions.sh
. "$ROOT/lib/versions.sh"

RUNDIR="$VARDIR/run/${STACK:-global}"
STAMPDIR="$VARDIR/stamps"

_c() { [ -t 1 ] && printf '\033[%sm%s\033[0m' "$1" "$2" || printf '%s' "$2"; }
log()  { printf '%s %s\n' "$(_c '1;34' '==')" "$*"; }
warn() { printf '%s %s\n' "$(_c '1;33' '!!')" "$*" >&2; }
die()  { printf '%s %s\n' "$(_c '1;31' 'XX')" "$*" >&2; exit 1; }
ok()   { printf '   %s %s\n' "$(_c '1;32' 'ok')" "$*"; }
bad()  { printf '   %s %s\n' "$(_c '1;31' 'no')" "$*"; }

execute() {
    if [ -n "${DRYRUN:-}" ]; then printf '   [dryrun] %s\n' "$*"; return 0; fi
    [ -n "${VERBOSE:-}" ] && printf '   + %s\n' "$*"
    "$@" || die "failed (exit $?): $*"
}
execute_sh() {
    if [ -n "${DRYRUN:-}" ]; then printf '   [dryrun] %s\n' "$*"; return 0; fi
    [ -n "${VERBOSE:-}" ] && printf '   + %s\n' "$*"
    bash -c "$*" || die "failed (exit $?): $*"
}

require_root() { [ "$(id -u)" -eq 0 ] || die "$1 needs root: sudo $0 $*"; }

sudo_prime() {
    [ "$(id -u)" -eq 0 ] && return 0
    [ -n "${DRYRUN:-}" ] && return 0
    sudo -n true 2>/dev/null && return 0
    log "the next steps need root -- entering your sudo password once now"
    sudo -v || die "sudo is required for $(basename "$0")"
}

need_dir()  { [ -n "${DRYRUN:-}" ] && return 0; [ -d "$1" ] || die "$2"; }
need_file() { [ -n "${DRYRUN:-}" ] && return 0; [ -f "$1" ] || die "$2"; }
need_bin()  { [ -n "${DRYRUN:-}" ] && return 0; [ -x "$1" ] || die "$2"; }

list_stacks() {
    for f in "$ROOT"/stacks/*.conf; do
        [ -e "$f" ] || continue
        printf '  %-28s %s\n' "$(basename "$f" .conf)" \
            "$(sed -n 's/^# *desc: *//p' "$f" | head -1)"
    done
}

load_stack() {
    [ -n "${STACK:-}" ] || { echo "STACK= is required. available:"; list_stacks; exit 2; }
    local conf="$ROOT/stacks/$STACK.conf"
    [ -f "$conf" ] || { echo "no such stack '$STACK'. available:"; list_stacks; exit 2; }
    COMPONENTS=""; START_ORDER=""; NEEDS=""; CMAKE_OPTS=""; HOSTS="local"; HEALTH=""
    local ovr="$VARDIR/overrides/$STACK.env" keep="" k
    if [ -f "$ovr" ]; then
        for k in $(grep -oE '^[A-Z][A-Z0-9_]*=' "$ovr" | tr -d =); do
            [ -n "${!k:-}" ] && keep+="$(printf '%s=%q; ' "$k" "${!k}")"
        done
    fi
    eval "$(OCUDU_SRC_DIR=""; OAI_SRC_DIR=""
            [ -f "$ovr" ] && . "$ovr" >/dev/null 2>&1; eval "$keep"; . "$conf" >/dev/null 2>&1
            [ -f "$ovr" ] && . "$ovr" >/dev/null 2>&1; eval "$keep"
            printf 'OCUDU_BRANCH=%q OAI_BRANCH=%q OCUDU_TREE=%q' "${OCUDU_BRANCH:-dev}" "${OAI_BRANCH:-develop}" "${OCUDU_TREE:-}")"
    OCUDU_SRC_DIR="${OCUDU_TREE:-$(repo_src OCUDU-RAN "$OCUDU_BRANCH")}"
    OAI_SRC_DIR="$(repo_src OAI-RAN "$OAI_BRANCH")"
    # shellcheck source=/dev/null
    [ -f "$ovr" ] && . "$ovr"; eval "$keep"
    # shellcheck source=/dev/null
    . "$conf"
    # shellcheck source=/dev/null
    [ -f "$ovr" ] && . "$ovr"; eval "$keep"
    [ -n "$COMPONENTS" ] || die "$STACK.conf sets no COMPONENTS"
    START_ORDER="${START_ORDER:-$COMPONENTS}"
    if needs ptp && { [ -z "${PTP_IF:-}" ] || [ ! -e "/sys/class/net/$PTP_IF" ]; }; then
        k="$(pgrep -a ptp4l | sed -nE 's/.* -i +([^ ]+).*/\1/p' | head -1)"
        PTP_IF="${k:-${PTP_IF:-}}"
    fi
    export STACK COMPONENTS START_ORDER NEEDS CMAKE_OPTS HOSTS HEALTH WORKSPACE PTP_IF
    export OCUDU_SRC_DIR OAI_SRC_DIR
}

needs() { case " $NEEDS " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

repo_src() {
    local dir="$WORKSPACE/$1" br="$2" cur
    if [ -d "$dir/.git" ]; then
        cur=$(git -C "$dir" rev-parse --abbrev-ref HEAD 2>/dev/null)
        [ "$cur" = "$br" ] && { echo "$dir"; return; }
    elif [ ! -e "$dir" ]; then
        echo "$dir"; return
    fi
    echo "$WORKSPACE/worktrees/$1-$br"
}

ocudu_cfg() { case "$1" in /*) echo "$1" ;; *) echo "$SRC/configs/$1" ;; esac; }

TOSSI_SSH="${TOSSI_SSH:-ssh -o BatchMode=yes -o ConnectTimeout=8}"
ssh_split() { local a="${1##*@}"; case "$a" in *:*:*|*[!0-9]) SSH_H="$1"; SSH_P="" ;; *:*) SSH_H="${1%:*}"; SSH_P="${a##*:}" ;; *) SSH_H="$1"; SSH_P="" ;; esac; }
rssh() { ssh_split "$1"; shift; $TOSSI_SSH ${SSH_P:+-p "$SSH_P"} "$SSH_H" "$@"; }
host_of() {
    [ -n "${TOSSI_REMOTE:-}" ] && return 0
    local v; v="HOST_$(echo "$1" | tr 'a-z-' 'A-Z_')"
    case "${!v:-}" in ""|local|localhost) ;; *) echo "${!v}" ;; esac
}
remote_repo() { echo "${REMOTE_REPO:-tossi-automation}"; }
remote_sync() {
    local h="$1" r; r="$(remote_repo)"
    rssh "$h" "mkdir -p '$r/var/overrides'" || { bad "cannot ssh to $h"; return 1; }
    local e="$TOSSI_SSH${SSH_P:+ -p $SSH_P}"
    rsync -a --delete -e "$e" "$ROOT/" "$SSH_H:$r/automation/" || return 1
    [ -f "$VARDIR/overrides/$STACK.env" ] && rsync -a -e "$e" "$VARDIR/overrides/$STACK.env" "$SSH_H:$r/var/overrides/"
    return 0
}
on_host() {
    local h="$1"; shift
    rssh "$h" "cd '$(remote_repo)' && TOSSI_REMOTE=1 STACK='$STACK' DRYRUN='${DRYRUN:-}' VERBOSE='${VERBOSE:-}' automation/verbs/on_host.sh $(printf '%q ' "$@")"
}

component() {
    local name="$1" verb="$2"; shift 2
    if [ "$name" = core5g ] && [ "$COMPONENTS" != core5g ]; then
        log "core5g: the operator's, not $STACK's -- $verb skipped"
        return 0
    fi
    local h; h="$(host_of "$name")"
    if [ -n "$h" ]; then
        log "$name $verb on $h"
        [ -n "${DRYRUN:-}" ] && { printf '   [dryrun] on %s: %s %s\n' "$h" "$name" "$verb"; return 0; }
        remote_sync "$h" && on_host "$h" component "$name" "$verb" "$@"
        return
    fi
    local sh="$ROOT/components/$name.sh"
    [ -x "$sh" ] || die "no component script for '$name' ($sh)"
    STACK="$STACK" ROOT="$ROOT" "$sh" "$verb" "$@"
}

stamp_dir() { echo "$STAMPDIR/${STACK:-global}"; }
stamped() {
    local s; s="$(stamp_dir)/$1"
    [ -f "$s" ] && [ "$s" -nt "$ROOT/lib/versions.sh" ]
}
stamp() { [ -n "${DRYRUN:-}" ] && return 0; mkdir -p "$(stamp_dir)"; touch "$(stamp_dir)/$1"; }

session() { echo "${TMUX_SESSION:-$STACK}"; }
panefile() { echo "$RUNDIR/$1.pane"; }

tmux_start() {
    local name="$1" cmd="$2" s pane hold; s="$(session)"
    if [ -n "${DRYRUN:-}" ]; then printf '   [dryrun] tmux pane %s: %s\n' "$name" "$cmd"; return 0; fi
    command -v tmux >/dev/null || die "tmux is not installed (apt install tmux)"
    # shellcheck disable=SC2016
    hold='; printf "\n[%s exited: %s] press enter to close\n" '"'$name'"' $?; read -r'
    if tmux has-session -t "$s" 2>/dev/null; then
        pane=$(tmux split-window -t "$s:0" -P -F '#{pane_id}' "$cmd$hold")
        tmux select-layout -t "$s:0" tiled >/dev/null
    else
        pane=$(tmux new-session -d -s "$s" -n "$s" -P -F '#{pane_id}' "$cmd$hold")
        tmux set-option -t "$s" mouse on >/dev/null
        tmux set-option -t "$s" pane-border-status top >/dev/null
        tmux set-option -t "$s" pane-border-format " #{pane_title} " >/dev/null
    fi
    tmux select-pane -t "$pane" -T "$name" >/dev/null
    : > "$(logfile "$name")"
    tmux pipe-pane -o -t "$pane" "cat >> '$(logfile "$name")'"
    echo "$pane" > "$(panefile "$name")"
    tmux display-message -p -t "$pane" '#{pane_pid}' > "$(pidfile "$name")"
}

tmux_stop() {
    local name="$1" p pane; p="$(pidfile "$name")"; pane="$(cat "$(panefile "$name")" 2>/dev/null)"
    [ -n "${DRYRUN:-}" ] && { printf '   [dryrun] tmux kill-pane %s\n' "$name"; return 0; }
    if [ -f "$p" ]; then
        local kids; kids=$(pgrep -P "$(cat "$p")" 2>/dev/null | tr '\n' ' ')
        [ -n "$kids" ] && sudo kill $kids 2>/dev/null
    fi
    [ -n "$pane" ] && tmux kill-pane -t "$pane" 2>/dev/null
    rm -f "$p" "$(panefile "$name")"
}

src_toward() { ip -o -4 route get "$1" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'; }
core_host_ip() {
    local h; h="$(host_of core5g)"
    if [ -n "$h" ]; then ssh_split "$h"; getent ahostsv4 "${SSH_H#*@}" | awk '{print $1; exit}'
    else ip -o -4 route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p'; fi
}
core_settings() {
    local amf="" upf="" sd=""
    case "${CORE:=oai-cn5g}" in
        oai-cn5g) amf=192.168.70.132; upf=192.168.70.134 ;;
        sd-core)  amf="$(core_host_ip)"; upf=192.168.252.3; sd=010203 ;;
        external) ;;
        *) die "CORE=$CORE: use oai-cn5g, sd-core or external" ;;
    esac
    case "${CORE_CFG_MODE:=$([ "$CORE" = external ] && echo custom || echo default)}" in
        custom) CORE_CELL_SET="${CORE_PLMN:-}${CORE_TAC:-}" ;;
        default|files)
            CORE_AMF_ADDR=""; CORE_UPF_ADDR=""; CORE_PLMN=""; CORE_TAC=""; CORE_SST=""; unset CORE_SD; CORE_CELL_SET="" ;;
        *) die "CORE_CFG_MODE=$CORE_CFG_MODE: use default, custom or files" ;;
    esac
    CORE_AMF_ADDR="${CORE_AMF_ADDR:-$amf}"; CORE_UPF_ADDR="${CORE_UPF_ADDR:-${upf:-$CORE_AMF_ADDR}}"
    CORE_PLMN="${CORE_PLMN:-00101}"; CORE_TAC="${CORE_TAC:-1}"; CORE_SST="${CORE_SST:-1}"; CORE_SD="${CORE_SD-$sd}"
}
core_overlays() {
    core_settings
    if [ "$CORE_CFG_MODE" = files ]; then rm -f "$RUNDIR/core_cu.yml" "$RUNDIR/core_cell.yml"; return 0; fi
    [ -n "$CORE_AMF_ADDR" ] || die "CORE=$CORE: set CORE_AMF_ADDR (the AMF's N2 address)"
    local cu="$RUNDIR/core_cu.yml" cell="$RUNDIR/core_cell.yml" n2 n3
    n2="$(src_toward "$CORE_AMF_ADDR")"; n3="$(src_toward "$CORE_UPF_ADDR")"
    [ -n "$n2" ] || die "no route to the AMF at $CORE_AMF_ADDR"
    mkdir -p "$RUNDIR"
    { echo "# written by core_overlays for CORE=$CORE -- do not edit, set CORE_* instead"
      echo "cu_cp:"; echo "  amf:"; echo "    addrs: $CORE_AMF_ADDR"; echo "    bind_addrs: $n2"
      echo "    supported_tracking_areas:"; echo "      - tac: $CORE_TAC"; echo "        plmn_list:"
      echo "          - plmn: \"$CORE_PLMN\""; echo "            tai_slice_support_list:"
      echo "              - sst: $CORE_SST"
      [ -n "$CORE_SD" ] && echo "                sd: $((16#$CORE_SD))"
      echo "cu_up:"; echo "  ngu:"; echo "    socket:"; echo "      - bind_addr: ${n3:-$n2}"
    } > "$cu"
    if [ -n "$CORE_CELL_SET" ]; then
        printf 'cell_cfg:\n  plmn: "%s"\n  tac: %s\n' "$CORE_PLMN" "$CORE_TAC" > "$cell"
        echo "$cu $cell"
    else
        rm -f "$cell"; echo "$cu"
    fi
}

pidfile() { echo "$RUNDIR/$1.pid"; }
logfile() { echo "$RUNDIR/$1.log"; }
is_up() {
    local h; h="$(host_of "$1")"
    [ -n "$h" ] && { on_host "$h" is_up "$1" 2>/dev/null; return; }
    [ "$1" = core5g ] && { core_running; return; }
    local p pid; p="$(pidfile "$1")"
    [ -f "$p" ] || return 1
    pid="$(cat "$p")"
    case "$pid" in
        external) return 0 ;;
        k8s) sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml -n aether-5gc \
                 get pods --no-headers 2>/dev/null | grep -q " Running " ; return ;;
        *[!0-9]*) [ "$(docker inspect -f '{{.State.Running}}' "$pid" 2>/dev/null)" = true ]; return ;;
    esac
    kill -0 "$pid" 2>/dev/null || return 1
    pgrep -P "$pid" >/dev/null 2>&1
}

core_running() {
    case "${CORE:-oai-cn5g}" in
        oai-cn5g) [ "$(docker inspect -f '{{.State.Running}}' oai-amf 2>/dev/null)" = true ] ;;
        sd-core)  sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml -n aether-5gc \
                      get pods --no-headers 2>/dev/null | grep -q " Running " ;;
        *)        return 0 ;;
    esac
}

wait_for() {
    local name="$1" secs="$2" pat="$3" i=0
    [ -n "${DRYRUN:-}" ] && { echo "   [dryrun] wait_for $name '$pat'"; return 0; }
    local h; h="$(host_of "$name")"
    [ -n "$h" ] && { on_host "$h" wait_for "$@"; return; }
    while [ "$i" -lt "$secs" ]; do
        local var; var=$(echo "$name" | tr 'a-z-' 'A-Z_')
        local cmd; cmd=$(eval echo "\${${var}_HEALTH_CMD:-}")
        if [ -n "$cmd" ]; then
            bash -c "$cmd" >/dev/null 2>&1 && { ok "$name ready"; return 0; }
        else
            local extra; extra=$(eval echo "\${${var}_LOGFILE:-}")
            grep -qsE "$pat" "$(logfile "$name")" ${extra:+"$extra"} && { ok "$name ready"; return 0; }
        fi
        if ! is_up "$name"; then
            if [ -z "$cmd" ] && grep -qsE "$pat" "$(logfile "$name")" ${extra:+"$extra"}; then
                ok "$name ready"; return 0
            fi
            bad "$name died during startup; see $(logfile "$name")"; return 1
        fi
        sleep 1; i=$((i + 1))
    done
    bad "$name not ready after ${secs}s (waiting for /$pat/)"; return 1
}

RUNS="$VARDIR/runs/${STACK:-global}"
run_begin() {
    [ -n "${DRYRUN:-}" ] && return 0
    [ -f "$RUNDIR/current_run" ] && run_end superseded
    local id; id="$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$RUNS/$id"
    echo "$id" > "$RUNDIR/current_run"
    local hosts="" c
    for c in $COMPONENTS; do hosts="$hosts $c=$(host_of "$c")"; done
    python3 - "$RUNS/$id/meta.json" "$id" "$STACK" "$(id -un)" "$COMPONENTS" "$START_ORDER" "$hosts" \
        "${OCUDU_SRC_DIR:-}" "${OCUDU_BRANCH:-}" "${OAI_BRANCH:-}" "$VARDIR/overrides/$STACK.env" <<'PY'
import json, sys, time, os
p, rid, stack, user, comps, order, hosts, src, ob, ab, ovr = sys.argv[1:]
settings = {}
if os.path.isfile(ovr):
    for l in open(ovr):
        k, _, v = l.strip().partition("=")
        if k and not k.startswith("#"): settings[k] = v.strip("'\"")
json.dump({"id": rid, "stack": stack, "user": user, "started": time.time(), "ended": None, "outcome": "running",
           "components": comps.split(), "start_order": order.split(),
           "hosts": {k: v for k, _, v in (h.partition("=") for h in hosts.split()) if v},
           "ocudu_src": src, "ocudu_branch": ob, "oai_branch": ab, "settings": settings}, open(p, "w"), indent=1)
PY
    log "run $id recorded in var/runs/$STACK/$id"
}
run_up() {
    [ -n "${DRYRUN:-}" ] && return 0
    [ -f "$RUNDIR/current_run" ] || return 0
    python3 - "$RUNS/$(cat "$RUNDIR/current_run")/meta.json" <<'PY'
import json, sys, time
p = sys.argv[1]
try:
    m = json.load(open(p)); m["up_at"] = time.time(); json.dump(m, open(p, "w"), indent=1)
except (OSError, ValueError):
    pass
PY
}
run_end() {
    [ -n "${DRYRUN:-}" ] && return 0
    [ -f "$RUNDIR/current_run" ] || return 0
    local id dir l; id="$(cat "$RUNDIR/current_run")"; dir="$RUNS/$id"; rm -f "$RUNDIR/current_run"
    [ -f "$dir/meta.json" ] || return 0
    mkdir -p "$dir/logs" "$dir/data"
    for l in "$RUNDIR"/*.log; do
        [ -f "$l" ] || continue
        case "$(basename "$l")" in build-*) continue ;; esac
        tail -c 20000000 "$l" > "$dir/logs/$(basename "$l")" 2>/dev/null
    done
    if [ -n "${OCUDU_SRC_DIR:-}" ]; then
        for l in "$OCUDU_SRC_DIR"/*.log; do
            [ -f "$l" ] && [ "$l" -nt "$dir/meta.json" ] && tail -c 20000000 "$l" > "$dir/logs/ocudu-$(basename "$l")" 2>/dev/null
        done
        find "$OCUDU_SRC_DIR/ml/datasets" -name '*.csv' -newer "$dir/meta.json" -exec cp -p {} "$dir/data/" \; 2>/dev/null
    fi
    [ -d "$VARDIR/datasets/$STACK" ] && find "$VARDIR/datasets/$STACK" -type f -newer "$dir/meta.json" -exec cp -p {} "$dir/data/" \; 2>/dev/null
    python3 - "$dir/meta.json" "$1" <<'PY'
import json, sys, time
p, outcome = sys.argv[1:]
m = json.load(open(p)); m.update(ended=time.time(), outcome=outcome); json.dump(m, open(p, "w"), indent=1)
PY
    log "run $id closed ($1): $(ls "$dir/data" | wc -l) data file(s), $(ls "$dir/logs" | wc -l) log(s)"
}

mkdir -p "$RUNDIR" "$STAMPDIR" 2>/dev/null || true
for _d in "$RUNDIR" "$STAMPDIR"; do
    [ -d "$_d" ] || continue
    if [ -n "$(find "$_d" ! -user "$(id -un)" -print -quit 2>/dev/null)" ]; then
        warn "$_d has root-owned entries (left by an earlier sudo run) -- reclaiming"
        sudo chown -R "$(id -u):$(id -g)" "$_d" || die "cannot write $_d"
    fi
done
mkdir -p "$RUNDIR" "$STAMPDIR"
