#!/usr/bin/env bash
set -uo pipefail

USRP_IP="${1:?usage: probe_usrp.sh <usrp_ip> [host_cidr]}"
if [ -n "${2:-}" ]; then
    HOST_CIDR="$2"
else
    base="${USRP_IP%.*}"; last="${USRP_IP##*.}"
    [ "$last" = "1" ] && HOST_CIDR="$base.2/24" || HOST_CIDR="$base.1/24"
fi
MTU="${USRP_MTU:-9000}"

if ping -c1 -W1 "$USRP_IP" >/dev/null 2>&1; then
    dev=$(ip -o route get "$USRP_IP" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p')
    echo "USRP $USRP_IP already reachable via ${dev:-?}"
    exit 0
fi

for iface in $(ls /sys/class/net); do
    [ "$iface" = "lo" ] && continue
    [ -e "/sys/class/net/$iface/device" ] || continue
    [ "$(cat "/sys/class/net/$iface/operstate")" = "up" ] && continue

    echo "-- trying $iface"
    ip link set "$iface" up
    ip addr add "$HOST_CIDR" dev "$iface" 2>/dev/null
    ip link set "$iface" mtu "$MTU"
    sleep 1

    if ping -c3 -W1 "$USRP_IP" >/dev/null 2>&1; then
        echo "SUCCESS: $iface reaches $USRP_IP (host $HOST_CIDR, mtu $MTU)"
        exit 0
    fi

    echo "   no answer, resetting $iface"
    ip addr del "$HOST_CIDR" dev "$iface" 2>/dev/null
    ip link set "$iface" mtu 1500
    ip link set "$iface" down
done

echo "no interface could reach $USRP_IP" >&2
exit 1
