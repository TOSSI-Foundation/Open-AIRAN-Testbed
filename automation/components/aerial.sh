#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

SRC="${AERIAL_SDK:-$WORKSPACE/aerial-cuda-accelerated-ran}"
YAML="${AERIAL_CFG:-cuphycontroller_P5G_FXN.yaml}"

case "${1:?verb}" in
deps)
    need_dir "$SRC" "$SRC missing -- run make install STACK=$STACK"
    execute_sh "cd '$SRC' && git lfs pull"
    ;;
build)
    execute_sh "cd '$SRC' && ./cubb_scripts/run.sh build"
    ;;
configure)
    [ -f "$SRC/cuPHY-CP/cuphycontroller/config/$YAML" ] \
        || die "aerial config $YAML not found under cuPHY-CP/cuphycontroller/config/"
    ;;
start)
    execute_sh "cd '$SRC' && nohup ./cuPHY-CP/cuphycontroller/examples/cuphycontroller_scf '$YAML' \
        >'$(logfile aerial)' 2>&1 & echo \$! > '$(pidfile aerial)'"
    ;;
stop)
    execute_sh "sudo kill \$(cat '$(pidfile aerial)' 2>/dev/null) 2>/dev/null; rm -f '$(pidfile aerial)'"
    ;;
status) is_up aerial && echo up || echo down ;;
*) die "aerial: unknown verb '$1'" ;;
esac
