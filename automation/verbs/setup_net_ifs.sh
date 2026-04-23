#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

if needs hugepages || needs nic || needs dpdk || needs ptp || needs usrp; then sudo_prime; fi
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
did=0

needs hugepages && {
    want="${HUGEPAGES_2M:-1024}"
    have=$(awk '/HugePages_Total/{print $2}' /proc/meminfo)
    if [ "${have:-0}" -ge "$want" ]; then log "hugepages: $have already allocated"
    else log "allocating $want hugepages"; execute_sh "echo $want | $SUDO tee /proc/sys/vm/nr_hugepages >/dev/null"; fi
    mountpoint -q /dev/hugepages || execute $SUDO mount -t hugetlbfs nodev /dev/hugepages
    did=1
}

needs nic && [ -n "${FH_IF:-}" ] && {
    log "fronthaul iface $FH_IF: ${FH_VFS:-0} VFs, VLAN ${FH_VLAN:-none}"
    [ -n "${FH_VFS:-}" ] && execute_sh "echo $FH_VFS | $SUDO tee /sys/class/net/$FH_IF/device/sriov_numvfs >/dev/null"
    [ -n "${FH_VLAN:-}" ] && execute $SUDO ip link set "$FH_IF" vf 0 vlan "$FH_VLAN"
    [ -n "${RU_MAC:-}" ] && log "RU peer MAC $RU_MAC (referenced by the ocudu ru_ofh config)"
    execute $SUDO ip link set "$FH_IF" up
    did=1
}

needs dpdk && [ -n "${DPDK_BIND_PCI:-}" ] && {
    log "binding $DPDK_BIND_PCI to vfio-pci"
    execute $SUDO modprobe vfio-pci
    execute $SUDO dpdk-devbind.py --bind=vfio-pci "$DPDK_BIND_PCI"
    did=1
}

needs usrp && {
    [ -n "${USRP_ADDR:-}" ] || die "NEEDS usrp but USRP_ADDR is unset -- pass USRP_ADDR=<ip>"
    log "probing for the NIC that reaches $USRP_ADDR"
    execute $SUDO "$ROOT/scripts/probe_usrp.sh" "$USRP_ADDR" "${USRP_HOST_CIDR:-}"
    did=1
}

needs ptp && {
    if systemctl is-active --quiet ptp4l; then log "ptp4l already running"
    else
        [ -n "${PTP_IF:-}" ] || die "NEEDS ptp but the stack sets no PTP_IF="
        log "starting ptp4l/phc2sys on $PTP_IF"
        execute $SUDO systemctl start ptp4l phc2sys
    fi
    did=1
}

[ "$did" = 0 ] && log "no host networking needed for $STACK"
exit 0
