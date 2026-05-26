#!/usr/bin/env bash
set -uo pipefail
dir=$1 glob=$2 out=$3 secs=$4 analyze=${5:-}
target=${TRAFFIC_TARGET:-10.0.0.1}
if [ -n "${UE_NETNS:-}" ]; then IN=(sudo ip netns exec "$UE_NETNS"); else IN=(sudo); fi

echo "== waiting for the UE tunnel (oaitun_ue1)"
for _ in $(seq 120); do
    "${IN[@]}" ip -4 addr show oaitun_ue1 2>/dev/null | grep -q inet && break
    sleep 1
done
"${IN[@]}" ip -4 addr show oaitun_ue1 2>/dev/null | grep -q inet || { echo "== no UE tunnel: UE never attached, nothing to collect"; exit 1; }

phase=$(( secs / 8 > 5 ? secs / 8 : 5 ))
end=$(( SECONDS + secs ))
while [ "$SECONDS" -lt "$end" ]; do
    for p in ${TRAFFIC_PHASES:-200:0.02 1000:0.1 64:0.1 600:0.05}; do
        [ "$SECONDS" -lt "$end" ] || break
        "${IN[@]}" ip link show oaitun_ue1 >/dev/null 2>&1 || { echo "== UE tunnel gone after $(( secs - end + SECONDS ))s -- collecting what was logged"; end=0; break; }
        echo "== uplink ${p%%:*} B every ${p#*:} s for ${phase}s"
        "${IN[@]}" ping -I oaitun_ue1 -q -s "${p%%:*}" -i "${p#*:}" -w "$phase" "$target" | tail -2
    done
done

f=$(ls -t "$dir"/$glob 2>/dev/null | head -1)
[ -n "$f" ] || { echo "== no $glob in $dir: is dataset_logging enabled?"; exit 1; }
mkdir -p "$out"
sudo cp "$f" "$out/" && sudo chown "$(id -u):$(id -g)" "$out/$(basename "$f")"
rows=$(( $(wc -l < "$out/$(basename "$f")") - 1 ))
[ "$rows" -gt 0 ] || { echo "== dataset EMPTY: $out/$(basename "$f")"; exit 1; }

if [ -n "$analyze" ]; then
    echo "== $(basename "$analyze")"
    python3 "$analyze" "$out/$(basename "$f")" | tee "$out/summary.txt"
fi
echo "== dataset ready: $out/$(basename "$f") ($rows rows)"
