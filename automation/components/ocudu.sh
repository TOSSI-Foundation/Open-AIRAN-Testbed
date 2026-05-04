#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${OCUDU_SRC_DIR:-$WORKSPACE/OCUDU-RAN}"
BUILD="$SRC/${OCUDU_BUILD_DIR:-build}"
APP="${OCUDU_APP:-gnb}"
BIN="$BUILD/apps/${OCUDU_APP_DIR:-$APP}/$APP"

case "${1:?verb}" in
deps)
    needs ml && execute pip3 install --user numpy scikit-learn pyyaml
    ;;
build)
    need_dir "$SRC" "$SRC missing -- run make fetch STACK=$STACK"
    if [ "${OCUDU_PREBUILT:-no}" = yes ]; then
        for t in ${OCUDU_PREBUILT_BINS:-$BIN}; do need_bin "$t" "OCUDU_PREBUILT=yes but $t is not built"; ok "prebuilt $t"; done
        exit 0
    fi
    if [ "${XSM_PAIR:-0}" != "0" ] && ! { [ -n "${OCUDU_TREE:-}" ] && [ -f "$SRC/include/ocudu/xsm/libxsm.so" ]; }; then
        XSM="$WORKSPACE/xFAPI/src/ipc/xsm"
        need_file "$XSM/libxsm.so" "$XSM/libxsm.so missing -- run make fetch STACK=$STACK"
        execute mkdir -p "$SRC/include/ocudu/xsm/xsm"
        execute cp "$XSM/libxsm.so" "$SRC/include/ocudu/xsm/"
        execute cp "$XSM/xsm/xsm.h" "$SRC/include/ocudu/xsm/xsm/"
    fi
    if [ -n "${OCUDU_BUILD_SCRIPT:-}" ]; then
        execute_sh "cd '$SRC' && ./$OCUDU_BUILD_SCRIPT"
    else
        execute mkdir -p "$BUILD"
        execute_sh "cd '$BUILD' && cmake $CMAKE_OPTS ${EXTRA_CMAKE_OPTS:-} ../"
        execute_sh "cd '$BUILD' && make -j\$(nproc) ${OCUDU_TARGETS:-}"
    fi
    ;;
configure)
    [ -n "${OCUDU_CFG:-}" ] || die "$STACK.conf sets no OCUDU_CFG"
    for _cfg in $OCUDU_CFG; do
        need_file "$(ocudu_cfg "$_cfg")" "config $(ocudu_cfg "$_cfg") not found"
        [ -z "${DRYRUN:-}" ] && grep -nE 'x\.x\.x\.x|xx:xx:xx' "$(ocudu_cfg "$_cfg")" \
            && die "$(ocudu_cfg "$_cfg") still has site placeholders (lines above) -- fill in this host's addresses/MACs"
        [ "$APP" = gnb ] && grep -qs '^f1ap:' "$(ocudu_cfg "$_cfg")" \
            && die "$(basename "$_cfg") is a DU config (f1ap block) -- set gNB layout to cu-du, or use a monolithic gNB config"
    done
    if [ -n "${USRP_ADDR:-}" ]; then
        args="${USRP_TYPE:+type=$USRP_TYPE,}addr=$USRP_ADDR${USRP_EXTRA_ARGS:+,$USRP_EXTRA_ARGS}"
        log "device_args -> $args"
        execute_sh "sed -i 's|^\( *device_args:\).*|\1 $args|' '$SRC/configs/$OCUDU_CFG'"
    fi
    ;;
start)
    need_bin "$BIN" "$BIN not built -- run make build STACK=$STACK"
    CFG_FLAGS=""; for _c in $OCUDU_CFG; do CFG_FLAGS="$CFG_FLAGS -c '$(ocudu_cfg "$_c")'"; done
    if [[ " $COMPONENTS " == *" core5g "* ]]; then
        _ov="$(core_overlays)" || die "cannot point the gNB at the core (see above)"
        for _c in $_ov; do
            case "$APP:$_c" in gnb:*|*:*core_cell.yml) CFG_FLAGS="$CFG_FLAGS -c '$_c'" ;; esac
        done
    fi
    tmux_start ocudu "cd '$SRC' && sudo ${OCUDU_TASKSET:+taskset -c $OCUDU_TASKSET} ${OCUDU_ENV:+env $OCUDU_ENV} '$BIN'$CFG_FLAGS"
    log "pane '$(basename "$0" .sh)' in tmux session '$(session)' -- make attach STACK=$STACK"
    ;;
stop)   tmux_stop ocudu ;;
status) is_up ocudu && echo up || echo down ;;
*) die "ocudu: unknown verb '$1'" ;;
esac
