# shellcheck shell=bash

_home="$HOME"
[ -n "${SUDO_USER:-}" ] && _home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
WORKSPACE="${WORKSPACE:-${_home:-$HOME}/tossi-ran}"

GH_TOSSI="https://github.com/TOSSI-Foundation"
OCUDU_URL="$GH_TOSSI/OCUDU-RAN.git";               OCUDU_BRANCH="${OCUDU_BRANCH:-dev}"
OAI_URL="$GH_TOSSI/OAI-RAN.git";                   OAI_BRANCH="${OAI_BRANCH:-develop}"
XFAPI_URL="${XFAPI_URL:-https://github.com/coranlabs/xFAPI.git}";     XFAPI_BRANCH="${XFAPI_BRANCH:-main}"
O1_URL="$GH_TOSSI/OCUDU-O1-Adaptor.git";           O1_BRANCH="${O1_BRANCH:-main}"
OAI_CN5G_URL="${OAI_CN5G_URL:-https://github.com/duranta-project/openairinterface5g.git}"
OAI_CN5G_BRANCH="${OAI_CN5G_BRANCH:-develop}"; OAI_CN5G_PATH="doc/tutorial_resources/oai-cn5g"
SDCORE_URL="${SDCORE_URL:-$GH_TOSSI/aether-onramp.git}"; SDCORE_BRANCH="${SDCORE_BRANCH:-main}"
AERIAL_URL="https://github.com/NVIDIA/aerial-cuda-accelerated-ran.git"
AERIAL_BRANCH="${AERIAL_BRANCH:-main}"

DPDK_VERSION="25.11.2";   DPDK_MIN="22.11"
UHD_VERSION="4.9.0.1";    UHD_MIN="4.9.0"
UHD_URL="https://github.com/EttusResearch/uhd.git"
UHD_COMMIT="${UHD_COMMIT:-}"
CMAKE_MIN="3.14";         GCC_MIN="11"
GPU_DRV_MIN="570.104";    CUDA_MIN="12.8"
OFED_MIN="24.04";         NV_CTK_MIN="1.17.4";   MFT_MIN="4.31.0"

case "$(cat /sys/class/dmi/id/product_name 2>/dev/null)" in
    *Spark*|*GB10*)  PLATFORM="dgx-spark"; MARCH="native" ;;
    *DGX*)           PLATFORM="dgx";       MARCH="native" ;;
    *)               PLATFORM="cots-x86";  MARCH="native" ;;
esac
