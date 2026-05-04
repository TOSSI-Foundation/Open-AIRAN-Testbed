# OCUDU-RAN: xSM FAPI-split transport is built unconditionally, breaking monolithic builds

**Repo:** `TOSSI-Foundation/OCUDU-RAN`
**Branch/commit:** `dev` @ `a91a0f8e5a`
**Also affects:** `fapi_split` (same code in `apps/du/CMakeLists.txt`)
**Applies to:** any build that is *not* a FAPI split — monolithic `gnb`, split-8 ZMQ,
split-8 USRP, AI-RAN, split-7.2 without xFAPI.

## Summary

`ENABLE_XSM_FAPI_SPLIT` is documented as an option, but neither value produces a
working build on a host without DPDK development headers:

- **ON (the default)** → compiles `lib/ipc/xsm/xsm_context.cpp`, which does
  `#include <rte_eal.h>`, so every build needs DPDK headers *on the compiler's
  default include path* even when the stack has nothing to do with DPDK.
- **OFF** → fails at link with `cannot find -locudu_xsm_context`.

So a split-8 ZMQ gNB — no fronthaul, no DPDK datapath — cannot be built without
DPDK, and the option that should exclude it doesn't work.

## Why OFF fails

Root `CMakeLists.txt` only *defines* the target when the option is ON:

```cmake
if (ENABLE_XSM_FAPI_SPLIT)
    add_subdirectory(include/ocudu/xsm)     # line ~647
endif (ENABLE_XSM_FAPI_SPLIT)
```
`lib/ipc/CMakeLists.txt` likewise: `if (ENABLE_XSM_FAPI_SPLIT) add_subdirectory(xsm)`.

But `apps/du/CMakeLists.txt` builds and links it **unconditionally** — the option
only guards a compile *definition*:

```cmake
add_library(fapi_xsm_transport STATIC
        fapi_xsm_transport.cpp
        fapi_stats.cpp
        fapi_stats_serializers.cpp)
target_link_libraries(fapi_xsm_transport PUBLIC
        ocudu_xsm_context                    # <-- unconditional
        ocudu_fapi_serialization)
if(ENABLE_XSM_FAPI_SPLIT)
    target_compile_definitions(fapi_xsm_transport PRIVATE ENABLE_XSM_FAPI_SPLIT)
endif()
```

`fapi_xsm_transport` is linked by `odu`, `odu_high`, `odu_low_fapi`, the split_6
plugins, `split_helpers`, and transitively by `gnb`.

## Why ON needs DPDK even with ENABLE_DPDK=OFF

`${DPDK_INCLUDE_DIRS}` is only added inside the DPDK branch:

```cmake
if (ENABLE_DPDK)
    find_package(DPDK ${DPDK_MIN_VERSION})
    if (DPDK_FOUND)
        include_directories(SYSTEM ${DPDK_INCLUDE_DIRS})   # only here
```

With `ENABLE_DPDK=OFF` (the default) nothing tells the compiler where DPDK headers
are, yet `xsm_context.cpp` still includes `<rte_eal.h>`. The build therefore only
succeeds by accident — when DPDK happens to be **source-built into
`/usr/local/include`** (a default search path). With Ubuntu's `libdpdk-dev` the
headers land in `/usr/include/dpdk`, which is *not* searched, and the build fails:

```
lib/ipc/xsm/xsm_context.cpp:5:10: fatal error: rte_eal.h: No such file or directory
```

Note `-DENABLE_DPDK=ON` does **not** rescue this on Ubuntu 22.04: its DPDK is
21.11, below `DPDK_MIN_VERSION` 22.11, so `find_package` rejects it, `DPDK_FOUND`
stays unset, and no include dirs are added.

## Reproduction

Ubuntu 22.04, `apt install libdpdk-dev` (21.11), no source-built DPDK:

```bash
git clone -b dev https://github.com/TOSSI-Foundation/OCUDU-RAN
cd OCUDU-RAN && mkdir build && cd build

cmake ..                                   # ENABLE_XSM_FAPI_SPLIT=ON (default)
make -j$(nproc) gnb
# -> xsm_context.cpp:5:10: fatal error: rte_eal.h: No such file or directory

cmake .. -DENABLE_XSM_FAPI_SPLIT=OFF
make -j$(nproc) gnb
# -> /usr/bin/ld: cannot find -locudu_xsm_context
```

## Fix

Only `fapi_xsm_transport.cpp` needs xSM. `fapi_stats.cpp` and
`fapi_stats_serializers.cpp` reference neither xsm nor rte — they are the reason
`gnb` links this library at all (see the existing comment "fapi_xsm_transport for
the same fapi_stats-symbol reason"). Splitting the source list by the option
fixes both failure modes. See `ocudu-xsm-split-only.patch`.

Verified on `dev` @ `a91a0f8e5a`: with the patch, `cmake -DENABLE_XSM_FAPI_SPLIT=OFF`
configures and the `gnb` target builds past the xSM stage with no DPDK headers
present.

## Secondary issues found while diagnosing

1. **`DU_SPLIT_TYPE` is not defined anywhere** in `dev` or `fapi_split` (not in the
   root `CMakeLists.txt`, `lib/`, `apps/`, or `cmake/modules/`). cmake reports
   `Manually-specified variables were not used by the project: DU_SPLIT_TYPE`.
   Several tossi.org tutorials pass `-DDU_SPLIT_TYPE=SPLIT_7_2` / `SPLIT_8`, so
   either the variable should be honoured or the docs should drop it.
2. **tossi.org inline-GPU page typo**: it prints `-CMAKE_CUDA_ARCHITECTURES=86`
   with a single dash, which cmake silently ignores, so copy-pasting builds for
   the default arch instead of 86.
