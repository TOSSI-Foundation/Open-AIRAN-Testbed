#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

MODE="${1:-show}"
PROFILE="${KERNEL_PROFILE:-}"
[ -n "$PROFILE" ] || { log "$STACK declares no KERNEL_PROFILE -- nothing to tune"; exit 0; }

NCPU=$(nproc)
HK_COUNT="${HK_COUNT:-4}"
if [ -z "${ISOL_CPUS:-}" ]; then
    [ "$NCPU" -gt "$((HK_COUNT + 3))" ] || die "only $NCPU CPUs: too few to isolate $HK_COUNT for housekeeping"
    ISOL_CPUS="0-$((NCPU - HK_COUNT - 1))"
fi
HK_CPUS="${HK_CPUS:-$((NCPU - HK_COUNT))-$((NCPU - 1))}"

RAM_GB=$(( $(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024 ))
_hp_auto=$(( RAM_GB / 4 ))
[ "$(( RAM_GB - _hp_auto ))" -lt 16 ] && _hp_auto=$(( RAM_GB - 16 ))
[ "$_hp_auto" -lt 4 ] && _hp_auto=4
HP_1G="${HUGEPAGES_1G:-$_hp_auto}"
HP_2M="${HUGEPAGES_2M:-1024}"
HP_512M="${HUGEPAGES_512M:-$(( _hp_auto * 2 ))}"
export ISOL_CPUS HK_CPUS HP_1G HP_2M HP_512M

PARAMS_FILE="$ROOT/configs/cmdline/$PROFILE.params"
[ -f "$PARAMS_FILE" ] || die "no cmdline profile '$PROFILE' ($PARAMS_FILE)"

render() {
    local body; body=$(grep -vE '^\s*(#|$)' "$PARAMS_FILE")
    eval "cat <<EOF
$body
EOF"
}

BOOTED=$(cat /proc/cmdline)

_booted_hp() {
    local sz="" t
    for t in $BOOTED; do
        case "$t" in
            hugepagesz=*) sz="${t#*=}" ;;
            hugepages=*)  [ "$sz" = "$1" ] && { echo "${t#*=}"; return; } ;;
        esac
    done
}
for _s in 1G:HP_1G 2M:HP_2M 512M:HP_512M; do
    _have=$(_booted_hp "${_s%%:*}")
    _var="${_s#*:}"
    [ -n "$_have" ] && [ "$_have" -gt "${!_var}" ] && printf -v "$_var" '%s' "$_have"
done

WANT=$(render | tr '\n' ' ' | tr -s ' ')

hp_map() {
    local sz="" t
    for t in $1; do
        case "$t" in
            hugepagesz=*) sz="${t#*=}" ;;
            hugepages=*)  [ -n "$sz" ] && printf '%s:%s\n' "$sz" "${t#*=}" ;;
        esac
    done
}
hp_bytes() {
    case "$1" in *G) echo $(( ${1%G} * 1024 )) ;; *M) echo "${1%M}" ;; *) echo 0 ;; esac
}

missing=0
for p in $WANT; do
    case "$p" in hugepages=*|hugepagesz=*) continue ;; esac
    key="${p%%=*}"
    if printf '%s' "$BOOTED" | grep -qwF -- "$p"; then
        [ "$MODE" = "--check" ] || ok "$p"
    elif printf '%s' "$BOOTED" | grep -qE "(^| )$key="; then
        cur=$(printf '%s' "$BOOTED" | grep -oE "(^| )$key=[^ ]*" | tr -d ' ' | head -1)
        bad "$p   (booted: $cur)"; missing=$((missing + 1))
    else
        bad "$p   (absent)"; missing=$((missing + 1))
    fi
done

booted_hp=$(hp_map "$BOOTED")
while IFS=: read -r sz want_n; do
    [ -n "$sz" ] || continue
    have_n=$(printf '%s\n' "$booted_hp" | awk -F: -v s="$sz" '$1==s{print $2; exit}')
    if [ -z "$have_n" ]; then
        bad "hugepagesz=$sz hugepages=$want_n   (no $sz pool booted)"; missing=$((missing + 1))
    elif [ "$have_n" -ge "$want_n" ]; then
        [ "$MODE" = "--check" ] || ok "hugepagesz=$sz hugepages=$have_n (>= $want_n)"
    else
        bad "hugepagesz=$sz hugepages=$want_n   (booted only $have_n)"; missing=$((missing + 1))
    fi
done <<< "$(hp_map "$WANT")"

echo
log "profile=$PROFILE  isolcpus=$ISOL_CPUS  housekeeping=$HK_CPUS  ($NCPU CPUs)"

if [ "$missing" -eq 0 ]; then
    log "kernel cmdline already satisfies $STACK"
    exit 0
fi

case "$MODE" in
--check) exit 1 ;;
--apply)
    DROPIN=/etc/default/grub.d/cmdline.cfg
    echo "=============================================================="
    echo "ABOUT TO CHANGE THE KERNEL COMMAND LINE"
    echo "=============================================================="
    echo
    echo "Machine:  $NCPU CPUs, ${RAM_GB}G RAM"
    echo "Derived:  isolcpus=$ISOL_CPUS  housekeeping=$HK_CPUS  1G-hugepages=$HP_1G"
    echo
    echo "Parameters that will be added or changed:"
    for p in $WANT; do
        key="${p%%=*}"
        printf '%s' "$BOOTED" | grep -qwF -- "$p" && continue
        if cur=$(printf '%s' "$BOOTED" | grep -oE "(^| )$key=[^ ]*" | tr -d ' ' | head -1) && [ -n "$cur" ]; then
            printf '    CHANGE  %-40s (now: %s)\n' "$p" "$cur"
        else
            printf '    ADD     %s\n' "$p"
        fi
    done
    echo
    echo "File to be written -- $DROPIN:"
    echo "    GRUB_CMDLINE_LINUX=\"\$GRUB_CMDLINE_LINUX $WANT\""
    echo
    echo "Then: sudo update-grub.  This does NOT reboot, and does NOT edit"
    echo "GRUB_CMDLINE_LINUX_DEFAULT -- your distro's own cmdline is untouched."
    echo "To undo: sudo rm $DROPIN && sudo update-grub && reboot."
    echo "Parameters repeated from the existing cmdline are harmless: the kernel"
    echo "takes the last occurrence, which is the one written here."
    echo
    if [ -t 0 ] && [ -z "${ASSUME_YES:-}" ] && [ -z "${DRYRUN:-}" ]; then
        read -r -p "Proceed? [y/N]: " a
        case "$a" in y|Y|yes) ;; *) die "aborted, nothing written" ;; esac
    fi
    execute sudo mkdir -p /etc/default/grub.d
    execute_sh "printf 'GRUB_CMDLINE_LINUX=\"\$GRUB_CMDLINE_LINUX %s\"\n' '$WANT' | sudo tee $DROPIN >/dev/null"
    execute sudo update-grub
    echo
    log "written. REBOOT for it to take effect, then: make check STACK=$STACK"
    ;;
*)
    echo "$missing parameter(s) missing. To apply:"
    echo "    make cmdline STACK=$STACK APPLY=1     # writes a grub drop-in, then reboot"
    exit 1
    ;;
esac
