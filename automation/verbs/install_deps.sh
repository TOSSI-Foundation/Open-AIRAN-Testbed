#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

if [ "${1:-}" = "--components" ]; then
    for c in $COMPONENTS; do component "$c" deps; done
    exit 0
fi

stamped deps && { log "deps already installed for $STACK (rm var/stamps/$STACK/deps to redo)"; exit 0; }

sudo_prime
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
pkgs=(build-essential cmake ninja-build pkg-config git git-lfs
      libfftw3-dev libmbedtls-dev libsctp-dev libyaml-cpp-dev libgtest-dev libcap2-bin)

needs zmq     && pkgs+=(libzmq3-dev python3-zmq)
case " $COMPONENTS " in
    *" ocudu "*|*" ocudu-low "*) pkgs+=(libdpdk-dev) ;;
esac
needs uhd     && pkgs+=(libboost-all-dev libusb-1.0-0-dev doxygen python3-docutils
                        python3-mako python3-numpy python3-requests python3-ruamel.yaml
                        python3-setuptools)
needs uhd && [ -z "${UHD_COMMIT:-}" ] && pkgs+=(libuhd-dev uhd-host)
needs dpdk    && pkgs+=(libdpdk-dev libelf-dev libdwarf-dev libdw-dev)
needs ptp     && pkgs+=(linuxptp tcpdump)
needs python3 && pkgs+=(python3 python3-pip python3-numpy)
needs ml      && pkgs+=(python3-sklearn python3-yaml)
needs oai     && pkgs+=(libconfig-dev libssl-dev libblas-dev liblapacke-dev)

missing=()
for p in "${pkgs[@]}"; do
    dpkg-query -W -f='${db:Status-Abbrev}' "$p" 2>/dev/null | grep -q '^ii' || missing+=("$p")
done
[ ${#missing[@]} -eq 0 ] && { log "apt: all ${#pkgs[@]} packages present for $STACK"; stamp deps; exit 0; }
pkgs=("${missing[@]}")
log "apt: ${#pkgs[@]} packages for $STACK"
printf '   %s\n' "${pkgs[*]}"
if [ -t 0 ] && [ -z "${ASSUME_YES:-}" ] && [ -z "${DRYRUN:-}" ]; then
    read -r -p "   install these with apt-get? [Y/n]: " a
    case "$a" in ""|y|Y|yes) ;; *) die "aborted, nothing installed" ;; esac
fi
execute $SUDO apt-get update
execute $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "${pkgs[@]}" \
    || die "apt failed -- fix the above and rerun"

stamp deps
log "deps done for $STACK"
