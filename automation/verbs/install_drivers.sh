#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

stamped drivers && { log "drivers already done for $STACK"; exit 0; }
SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
OCUDU_SRC="${OCUDU_SRC:-$WORKSPACE/OCUDU-RAN}"

OCUDU_IN_STACK=""
case " $COMPONENTS " in *" ocudu "*|*" ocudu-low "*) OCUDU_IN_STACK=1 ;; esac

if needs dpdk || needs uhd || needs gpu || needs ofed || [ -n "$OCUDU_IN_STACK" ]; then sudo_prime; fi

did=0

{ needs dpdk || [ -n "$OCUDU_IN_STACK" ]; } && {
    have=$(pkg-config --modversion libdpdk 2>/dev/null || echo 0)
    if [ "$(printf '%s\n%s\n' "$DPDK_MIN" "$have" | sort -V | head -1)" = "$DPDK_MIN" ] \
       && [ "$have" != "0" ]; then
        log "dpdk $have >= $DPDK_MIN, keeping it"
    elif [ -x "$OCUDU_SRC/docker/scripts/build_dpdk.sh" ]; then
        log "installing dpdk build dependencies (ocudu install_dpdk_dependencies.sh)"
        execute $SUDO "$OCUDU_SRC/docker/scripts/install_dpdk_dependencies.sh" build
        log "building dpdk $DPDK_VERSION via ocudu's own script"
        execute $SUDO "$OCUDU_SRC/docker/scripts/build_dpdk.sh" "$DPDK_VERSION" "$MARCH"
    else
        die "dpdk $DPDK_MIN+ needed and $OCUDU_SRC not fetched yet -- run make install STACK=$STACK first"
    fi
    did=1
}

needs uhd && {
    have=$(pkg-config --modversion uhd 2>/dev/null || echo 0)
    if [ -n "${UHD_COMMIT:-}" ]; then
        UHD_SRC="${UHD_SRC:-$WORKSPACE/uhd}"
        if [ "$have" = "$UHD_COMMIT" ]; then
            log "uhd $have already matches UHD_COMMIT"
        else
            log "building uhd @ $UHD_COMMIT from source (device match)"
            [ -d "$UHD_SRC/.git" ] || execute git clone "$UHD_URL" "$UHD_SRC"
            execute git -C "$UHD_SRC" fetch --tags origin
            execute git -C "$UHD_SRC" checkout "$UHD_COMMIT"
            execute cmake -S "$UHD_SRC/host" -B "$UHD_SRC/host/build"
            execute cmake --build "$UHD_SRC/host/build" -j"$(nproc)"
            [ -n "${UHD_RUN_TESTS:-}" ] && execute cmake --build "$UHD_SRC/host/build" --target test
            execute $SUDO cmake --install "$UHD_SRC/host/build"
            execute $SUDO ldconfig
        fi
        execute $SUDO uhd_images_downloader
    elif [ "$(printf '%s\n%s\n' "$UHD_MIN" "$have" | sort -V | head -1)" = "$UHD_MIN" ] \
         && [ "$have" != "0" ]; then
        log "uhd $have >= $UHD_MIN, keeping it"
    else
        log "building uhd $UHD_VERSION via ocudu's own script"
        execute $SUDO "$OCUDU_SRC/docker/scripts/build_uhd.sh" "$UHD_VERSION" "$MARCH"
    fi
    did=1
}

needs gpu && {
    if nvidia-smi >/dev/null 2>&1; then
        log "gpu driver $(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1) live"
    elif modinfo nvidia >/dev/null 2>&1; then
        log "nvidia module built but not loaded, loading it"
        execute $SUDO modprobe nvidia
        execute $SUDO modprobe nvidia-uvm
    else
        die "no nvidia driver installed. Use NVIDIA's .run installer or the distro
    package matching GPU_DRV_MIN=$GPU_DRV_MIN, then rerun. This script will not
    install a kernel driver behind your back -- it needs a reboot decision."
    fi
    did=1
}

needs ofed && {
    command -v ofed_info >/dev/null \
        || die "OFED $OFED_MIN+ required. Install DOCA-Host / MLNX_OFED (reboot), then rerun."
    log "OFED $(ofed_info -s | head -1)"
    did=1
}

[ "$did" = 0 ] && log "no drivers needed for $STACK (NEEDS: ${NEEDS:-none})"
stamp drivers
