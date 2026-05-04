#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

CORE="${CORE:-oai-cn5g}"
COMPOSE="${CORE_COMPOSE:-$WORKSPACE/oai-cn5g/docker-compose.yaml}"
SDCORE_DIR="$WORKSPACE/aether-onramp"
KUBECTL="sudo -n /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml"
HELM="sudo -n /usr/local/bin/helm --kubeconfig /etc/rancher/rke2/rke2.yaml"
ONRAMP="cd '$SDCORE_DIR' && PATH=\$HOME/.local/bin:\$PATH make"

sdcore_deployed() { [ "$($HELM -n aether-5gc status sd-core -o json 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["info"]["status"])' 2>/dev/null)" = deployed ]; }
sdcore_ready() {
    local pods; pods="$($KUBECTL -n aether-5gc get pods --no-headers 2>/dev/null)" || return 1
    [ -n "$pods" ] && ! echo "$pods" | awk '{split($2,r,"/"); if ($3!="Running" && $3!="Completed" || ($3=="Running" && r[1]!=r[2])) bad=1} END{exit !bad}'
}

case "$CORE:${1:?verb}" in
oai-cn5g:deps)      docker version >/dev/null 2>&1 || die "docker daemon not reachable (install docker, add $USER to the docker group)" ;;
oai-cn5g:build)
    need_file "$COMPOSE" "$COMPOSE missing -- run make fetch STACK=$STACK"
    execute docker compose -f "$COMPOSE" pull --ignore-pull-failures ;;
oai-cn5g:configure) need_file "$COMPOSE" "$COMPOSE missing -- run make fetch STACK=$STACK" ;;
oai-cn5g:start)
    execute docker compose -f "$COMPOSE" up -d --wait
    execute_sh "docker compose -f '$COMPOSE' ps > '$(logfile core5g)' 2>&1"
    execute_sh "docker compose -f '$COMPOSE' ps -q | head -1 > '$(pidfile core5g)'" ;;
oai-cn5g:stop)
    [ -f "$COMPOSE" ] && execute docker compose -f "$COMPOSE" down
    execute rm -f "$(pidfile core5g)" ;;
oai-cn5g:status)    docker compose -f "$COMPOSE" ps ;;

sd-core:deps)
    sudo -n true 2>/dev/null || die "sd-core needs passwordless sudo (RKE2, helm, ansible)"
    . /etc/os-release; case "$VERSION_ID" in 22.04|24.04) ;; *) warn "aether-onramp supports Ubuntu 22.04/24.04, this is $VERSION_ID" ;; esac ;;
sd-core:build)
    need_file "$SDCORE_DIR/oneclick.sh" "$SDCORE_DIR missing -- run make fetch STACK=$STACK"
    if sdcore_deployed; then ok "SD-Core already deployed (helm release sd-core in aether-5gc)"; exit 0; fi
    if sudo -n test -e /etc/cni/net.d/00-multus.conf && ! sudo -n test -x /opt/cni/bin/multus; then
        bk="$VARDIR/backup/cni-$(date +%Y%m%d-%H%M%S)"
        warn "stale /etc/cni/net.d/00-multus.conf without /opt/cni/bin/multus -- moving it (and multus.d) to $bk"
        execute mkdir -p "$bk"
        execute_sh "sudo -n mv /etc/cni/net.d/00-multus.conf $(sudo -n test -d /etc/cni/net.d/multus.d && echo /etc/cni/net.d/multus.d) '$bk/' && sudo -n chown -R $USER '$bk'"
        sudo -n systemctl is-active -q rke2-server 2>/dev/null && execute sudo -n systemctl restart rke2-server
    fi
    [ -n "${DRYRUN:-}" ] && { printf '   [dryrun] cd %s && ./oneclick.sh\n' "$SDCORE_DIR"; exit 0; }
    if ! (cd "$SDCORE_DIR" && ${CORE_AMF_ADDR:+NODE_IP="$CORE_AMF_ADDR"} ./oneclick.sh); then
        sdcore_deployed && sdcore_ready || die "SD-Core install failed (see above); the build can be re-run"
        warn "oneclick.sh reported a failure, but the sd-core release is deployed and every aether-5gc pod is Ready -- continuing"
    fi
    ok "SD-Core deployed" ;;
sd-core:configure)
    sudo -n test -x /var/lib/rancher/rke2/bin/kubectl || die "RKE2 is not installed -- run make build STACK=$STACK (installs RKE2 + SD-Core)" ;;
sd-core:start)
    if ! sdcore_deployed; then
        log "SD-Core is not deployed -- installing it (images are cached, a few minutes)"
        execute_sh "$ONRAMP 5gc-install"
    fi
    for _ in $(seq 240); do sdcore_ready && break; sleep 5; done
    sdcore_ready || { $KUBECTL -n aether-5gc get pods >&2; die "SD-Core pods are not all Ready (make -C $SDCORE_DIR aether-sdcore-verify)"; }
    $KUBECTL -n aether-5gc get pods > "$(logfile core5g)" 2>&1
    echo k8s > "$(pidfile core5g)"
    ok "SD-Core ready, AMF N2 at $(core_host_ip):38412" ;;
sd-core:stop)
    if sdcore_deployed || $HELM -n aether-5gc status sd-core >/dev/null 2>&1; then
        execute_sh "$ONRAMP 5gc-uninstall"
        ok "SD-Core undeployed (RKE2 left installed)"
    else
        ok "SD-Core is not deployed"
    fi
    execute rm -f "$(pidfile core5g)" ;;
sd-core:status)     $KUBECTL -n aether-5gc get pods ;;

external:deps|external:build) : ;;
external:configure)
    core_settings
    [ "$CORE_CFG_MODE" = files ] || [ -n "$CORE_AMF_ADDR" ] || die "CORE=external: set CORE_AMF_ADDR (the AMF's N2 address), or take the core from your config files" ;;
external:start)
    core_settings
    if [ -n "$CORE_AMF_ADDR" ]; then
        ping -c 2 -W 1 "$CORE_AMF_ADDR" >/dev/null 2>&1 || warn "AMF $CORE_AMF_ADDR does not answer ping (it may filter ICMP)"
        ok "external core, AMF at $CORE_AMF_ADDR"
    else
        ok "external core, AMF/PLMN/TAC/slice from your gNB/CU config files"
    fi
    echo external > "$(pidfile core5g)" ;;
external:stop)      rm -f "$(pidfile core5g)" ;;
external:status)    echo "external core, AMF at ${CORE_AMF_ADDR:-unset}" ;;

*:*) die "core5g: unknown CORE '$CORE' or verb '$1'" ;;
esac
