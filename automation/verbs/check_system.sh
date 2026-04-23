#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

FIX=""; STRICT=""
for a in "$@"; do
    case "$a" in --fix) FIX=1 ;; --strict) STRICT=1 ;; esac
done

fails=0
fixable=0
need_fail() { bad "$1"; printf '        fix: %s\n' "$2"; fails=$((fails + 1)); }
need_fix()  { bad "$1"; printf '        installed by: %s\n' "$2"; fixable=$((fixable + 1)); }

_comps="$COMPONENTS"; [ "$COMPONENTS" = core5g ] || _comps="$(echo " $COMPONENTS " | sed 's/ core5g / /')"

_hs=""; for c in $_comps; do _hs="$_hs $(host_of "$c")"; done
_one=$(echo $_hs | tr ' ' '\n' | sort -u)
if [ -n "$_one" ] && [ "$(echo "$_one" | wc -l)" = 1 ] && [ "$(echo $_hs | wc -w)" = "$(echo $_comps | wc -w)" ]; then
    log "check_system: $STACK runs on $_one -- checking there"
    remote_sync "$_one" || die "cannot reach $_one"
    on_host "$_one" automation/verbs/check_system.sh "$@"
    exit $?
fi

log "check_system: $STACK  (needs: ${NEEDS:-none})"

for c in $_comps; do
    h="$(host_of "$c")"; [ -n "$h" ] || continue
    if ! rssh "$h" true 2>/dev/null; then
        need_fail "$c: cannot ssh to $h" "ssh-copy-id ${h%:*} (key-based ssh from this server)"
    elif ! rssh "$h" sudo -n true 2>/dev/null; then
        need_fail "$c: no passwordless sudo on $h" "on $h: echo \"\$USER ALL=(ALL) NOPASSWD:ALL\" | sudo tee /etc/sudoers.d/tossi"
    else
        ok "$c runs on $h (ssh + sudo ok)"
    fi
done

CORES=$(nproc)
RAM_GB=$(($(awk '/MemTotal/{print $2}' /proc/meminfo) / 1024 / 1024))
DISK_GB=$(df -BG --output=avail "$WORKSPACE" 2>/dev/null | tail -1 | tr -dc 0-9)
DISK_GB=${DISK_GB:-$(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9)}
[ "$CORES"   -ge 8  ] && ok "cores $CORES"        || need_fail "cores $CORES < 8" "use a bigger host"
[ "$RAM_GB"  -ge 16 ] && ok "RAM ${RAM_GB}G"      || need_fail "RAM ${RAM_GB}G < 16G" "use a bigger host"
[ "${DISK_GB:-0}" -ge 30 ] && ok "disk ${DISK_GB}G free" \
    || need_fail "disk ${DISK_GB}G < 30G at $WORKSPACE" "free space or set WORKSPACE="
grep -q avx2 /proc/cpuinfo && ok "AVX2" || need_fail "no AVX2" "PHY needs AVX2; different CPU"

HAVE_PKGCONFIG=1
command -v pkg-config >/dev/null || {
    HAVE_PKGCONFIG=""
    need_fix "pkg-config not installed -- library checks below are unreliable" \
             "make prepare STACK=$STACK (install_deps)"
}
have_pkg() { [ -n "$HAVE_PKGCONFIG" ] && pkg-config --exists "$1"; }
pkg_ver()  { [ -n "$HAVE_PKGCONFIG" ] && pkg-config --modversion "$1" 2>/dev/null; }
absent()   { [ -n "$HAVE_PKGCONFIG" ] && echo "missing" || echo "unknown (no pkg-config)"; }

case "$(uname -r) $(uname -v)" in
    *lowlatency*|*-rt*|*realtime*|*PREEMPT_RT*) ok "kernel $(uname -r)" ;;
    *) warn "kernel $(uname -r) is not lowlatency/RT -- expect late slots under load" ;;
esac
grep -q isolcpus= /proc/cmdline && ok "isolcpus set" || warn "no isolcpus= on cmdline"

needs zmq && { have_pkg libzmq && ok "libzmq $(pkg_ver libzmq)" \
    || need_fix "libzmq $(absent)" "make prepare STACK=$STACK (install_deps)"; }

needs uhd && { have_pkg uhd && ok "uhd $(pkg_ver uhd)" \
    || need_fix "uhd $(absent)" "make prepare STACK=$STACK (install_drivers)"; }

needs python3 && { command -v python3 >/dev/null && ok "python3 $(python3 -V | cut -d' ' -f2)" \
    || need_fix "python3 missing" "make prepare STACK=$STACK (install_deps)"; }

needs usrp && {
    if [ -z "${USRP_ADDR:-}" ]; then
        need_fail "USRP_ADDR is not set" "make check STACK=$STACK USRP_ADDR=<your USRP ip>"
    elif ping -c1 -W1 "$USRP_ADDR" >/dev/null 2>&1; then
        ok "USRP $USRP_ADDR reachable"
        if command -v uhd_usrp_probe >/dev/null; then
            if probe=$(timeout "${UHD_PROBE_TIMEOUT:-30}" uhd_usrp_probe --args "addr=$USRP_ADDR" 2>&1); then
                prod=$(printf '%s' "$probe" | sed -n 's/.*product=\([A-Za-z0-9_]*\).*/\1/p' | head -1)
                fpga=$(printf '%s' "$probe" | sed -n 's/^[| ]*FPGA Version: *//p' | head -1)
                ok "uhd_usrp_probe: ${prod:-device}${fpga:+, FPGA $fpga}, host $(pkg-config --modversion uhd 2>/dev/null)"
                case "$prod" in
                    x4*|X4*) [ "${USRP_TYPE:-}" = "x4xx" ] || warn "device is $prod but USRP_TYPE=${USRP_TYPE:-unset}; set USRP_TYPE=x4xx" ;;
                    n3*|N3*) [ "${USRP_TYPE:-}" = "n3xx" ] || warn "device is $prod but USRP_TYPE=${USRP_TYPE:-unset}; set USRP_TYPE=n3xx" ;;
                esac
            elif printf '%s' "$probe" | grep -qiE "incompatible|mismatch|please update|version"; then
                need_fail "host UHD is incompatible with the device image" \
                          "read the version it names, then UHD_COMMIT=<that> make prepare"
            else
                need_fail "uhd_usrp_probe could not enumerate $USRP_ADDR" \
                          "check the cable/MTU: sudo ./scripts/probe_usrp.sh $USRP_ADDR"
            fi
        else
            need_fix "uhd_usrp_probe not installed" "make prepare STACK=$STACK (install_drivers)"
        fi
    else
        need_fail "USRP $USRP_ADDR unreachable" "sudo ./scripts/probe_usrp.sh $USRP_ADDR"
    fi
}

needs dpdk && {
    have_pkg libdpdk && ok "dpdk $(pkg_ver libdpdk)" \
        || need_fix "dpdk $(absent)" "make prepare STACK=$STACK (install_drivers)"
    [ -d /sys/bus/pci/drivers/vfio-pci ] && ok "vfio-pci bound" \
        || need_fix "vfio-pci not available" "make prepare STACK=$STACK (setup_net_ifs) (modprobe vfio-pci)"
    grep -qE "intel_iommu=on|amd_iommu=on" /proc/cmdline && ok "IOMMU on" \
        || need_fail "IOMMU off" "add intel_iommu=on iommu=pt to the kernel cmdline, reboot"
}

needs hugepages && {
    HP=$(awk '/HugePages_Total/{print $2}' /proc/meminfo)
    if [ "${HP:-0}" -gt 0 ]; then ok "hugepages $HP x $(awk '/Hugepagesize/{print $2$3}' /proc/meminfo)"
    elif [ -n "$FIX" ]; then log "allocating 1024 x 2M hugepages"; execute_sh "echo 1024 | sudo tee /proc/sys/vm/nr_hugepages >/dev/null"
    else need_fix "no hugepages" "make prepare STACK=$STACK (setup_net_ifs), or make cmdline APPLY=1 for boot-time pools"; fi
}

if [ "$COMPONENTS" = core5g ] && [ -z "$(host_of core5g)" ]; then
    core_settings
    case "$CORE" in
    oai-cn5g)
        docker version >/dev/null 2>&1 && ok "core: OAI CN5G (docker $(docker version -f '{{.Server.Version}}' 2>/dev/null))" \
            || need_fail "core: docker daemon not reachable" "install docker (OAI CN5G tutorial 2.1) and add $USER to the docker group" ;;
    sd-core)
        c=$(nproc); m=$(awk '/MemTotal/{print int($2/1048576)}' /proc/meminfo); dsk=$(df -BG --output=avail "$WORKSPACE" 2>/dev/null | tail -1 | tr -dc 0-9)
        [ "$c" -ge 8 ] && [ "$m" -ge 15 ] && ok "core: SD-Core host $c cores, ${m}G RAM" || need_fail "core: SD-Core needs 8+ cores, 16+ GiB RAM (have $c, ${m}G)" "a bigger host, or HOST_CORE5G=user@host"
        [ "${dsk:-0}" -ge 40 ] && ok "core: ${dsk}G free for RKE2 + images" || need_fail "core: SD-Core needs ~40 GB free (have ${dsk}G)" "free disk"
        sudo -n true 2>/dev/null && ok "core: passwordless sudo" || need_fail "core: SD-Core needs passwordless sudo" "echo \"\$USER ALL=(ALL) NOPASSWD:ALL\" | sudo tee /etc/sudoers.d/tossi"
        . /etc/os-release; case "$VERSION_ID" in 22.04|24.04) ok "core: Ubuntu $VERSION_ID" ;; *) warn "core: aether-onramp supports Ubuntu 22.04/24.04, this is $VERSION_ID" ;; esac ;;
    external)
        if [ "$CORE_CFG_MODE" = files ]; then ok "core: external, AMF/PLMN/TAC/slice from your gNB/CU config files"
        elif [ -z "$CORE_AMF_ADDR" ]; then need_fail "core: CORE=external but CORE_AMF_ADDR is not set" "set CORE_AMF_ADDR (the AMF's N2 address) in Deployments > Configs"
        elif [ -z "$(src_toward "$CORE_AMF_ADDR")" ]; then need_fail "core: no route to the AMF at $CORE_AMF_ADDR" "fix routing to the core"
        else ok "core: external AMF $CORE_AMF_ADDR (PLMN $CORE_PLMN, TAC $CORE_TAC, SST $CORE_SST${CORE_SD:+, SD $CORE_SD})"; fi ;;
    esac
fi

needs bbdev && { lspci -nn 2>/dev/null | grep -qE "8086:(0d5c|57c0)" \
    && ok "Intel ACC100/ACC200 present" \
    || need_fail "no FEC accelerator on the PCI bus" "this stack needs an ACC100/ACC200 card"; }

needs nic && {
    fh=$(for d in /sys/bus/pci/devices/*; do
            [ "$(cat "$d/class" 2>/dev/null)" = 0x020000 ] || continue
            drv=$(basename "$(readlink "$d/driver" 2>/dev/null)")
            case "$drv" in mlx5_core|ice|iavf|vfio-pci) echo "$(basename "$d") $drv" ;; esac
         done)
    if [ -n "$fh" ]; then
        ok "fronthaul NIC: $(echo "$fh" | awk '{print $2}' | sort | uniq -c | awk '{printf "%s%s x%s", sep, $2, $1; sep=", "}')"
    else
        need_fail "no fronthaul NIC" "7.2 fronthaul needs a ConnectX, an E810 or a vfio-bound VF"
    fi
}

needs ptp && {
    if [ -n "${PTP_IF:-}" ] && pgrep -af '[p]tp4l' | grep -qw -- "$PTP_IF"; then
        ok "ptp4l already running on $PTP_IF (pid $(pgrep -af '[p]tp4l' | grep -w -- "$PTP_IF" | awk '{print $1}' | head -1)) -- will be reused"
    elif command -v ptp4l >/dev/null && command -v phc2sys >/dev/null; then
        ok "linuxptp $(ptp4l -v 2>&1 | head -1)"
    else
        need_fix "linuxptp missing" "make prepare STACK=$STACK (install_deps)"
    fi
    if [ -z "${PTP_IF:-}" ]; then
        need_fail "PTP_IF is not set" "make check STACK=$STACK IF=<fronthaul iface>"
    elif [ ! -e "/sys/class/net/$PTP_IF" ]; then
        need_fail "ptp interface $PTP_IF is not on this server" "set PTP_IF to its fronthaul port (Configs -> Other settings)"
    else
        ok "ptp interface $PTP_IF"
    fi
    if [ -n "${PTP_IF:-}" ] && command -v tcpdump >/dev/null; then
        if sudo -n timeout 3 tcpdump -q -i "$PTP_IF" -c 1 'ether proto 0x88f7' >/dev/null 2>&1; then
            ok "PTP traffic seen on $PTP_IF (grandmaster is live)"
        else
            warn "no PTP frames on $PTP_IF in 3s -- check the GM before expecting lock"
        fi
    fi
}

needs gpu && {
    if lspci -nn 2>/dev/null | grep -qi nvidia; then ok "NVIDIA device on the bus"
    else need_fail "no NVIDIA GPU on the PCI bus" "this stack cannot run on this host"; fi
    if nvidia-smi >/dev/null 2>&1; then ok "driver $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1)"
    else need_fix "nvidia driver not responding" "make prepare STACK=$STACK (install_drivers) (modprobe nvidia)"; fi
}

needs cuda && { command -v nvcc >/dev/null && ok "cuda $(nvcc --version | sed -n 's/.*release \([0-9.]*\).*/\1/p')" \
    || need_fix "no CUDA toolkit" "make prepare STACK=$STACK (install_drivers)"; }

needs ofed && { command -v ofed_info >/dev/null && ok "OFED $(ofed_info -s | head -1)" \
    || need_fail "OFED missing" "DOCA/MLNX_OFED host installer"; }

needs docker && { docker version 2>/dev/null | grep -q Server: && ok "docker daemon up" \
    || need_fix "docker not reachable" "sudo systemctl start docker"; }

needs aerial && {
    CHK="$(ls -t "$HOME"/*/cuPHY/util/cuBB_system_checks/cuBB_system_checks.py \
              "$HOME"/*/*/cuPHY/util/cuBB_system_checks/cuBB_system_checks.py 2>/dev/null | head -1)"
    if [ -z "$CHK" ]; then need_fail "cuBB_system_checks.py not found" "set AERIAL_SDK=<sdk root>"
    else
        log "delegating to $(basename "$CHK")"
        STUB=$(mktemp -d); printf 'AutoAddPolicy=object\nclass SSHClient:\n def set_missing_host_key_policy(self,*a): pass\n' > "$STUB/paramiko.py"
        out=$(PYTHONPATH="$STUB:${PYTHONPATH:-}" python3 "$CHK" -c -g -m -b -n -k -l -s -p --sys 2>&1 | sed 's/\x1b\[[0-9;]*m//g')
        rm -rf "$STUB"
        while IFS= read -r l; do need_fail "${l#"${l%%[![:space:]]*}"}" "see the Aerial install guide"; done \
            < <(printf '%s\n' "$out" | grep "is required")
        printf '%s\n' "$out" | grep -q "is required" || ok "all NVIDIA cuBB checks pass"
    fi
}

echo
if [ "$fails" -gt 0 ]; then
    die "$fails hardware/boot requirement(s) not met -- $STACK cannot run on this host"
fi
if [ "$fixable" -gt 0 ]; then
    if [ -n "$STRICT" ]; then
        die "$fixable dependency(ies) still missing -- run: make prepare STACK=$STACK"
    fi
    warn "$fixable dependency(ies) missing; 'make prepare STACK=$STACK' installs them"
    log "$STACK: hardware is capable (software gaps listed above)"
    exit 0
fi
log "$STACK: system requirements met"
