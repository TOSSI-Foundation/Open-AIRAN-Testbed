#!/usr/bin/env bash
. "$(dirname "$0")/../lib/includes.sh"
load_stack

OFFLINE=""; ONLY=""
for a in "$@"; do case "$a" in --offline) OFFLINE=1 ;; --only=*) ONLY="${a#--only=}" ;; esac; done

ff_latest() {
    git -C "$1" fetch -q origin "$2" || { warn "$(basename "$1"): fetch failed, building what is there"; return; }
    git -C "$1" merge -q --ff-only "origin/$2" 2>/dev/null \
        || warn "$(basename "$1"): has local changes/commits, not moved to origin/$2"
    ok "$(basename "$1") @ $(git -C "$1" log -1 --format='%h %s' HEAD)"
}

git_at() {
    local url="$1" branch="$2" dir="$3" main; main="$WORKSPACE/$(basename "${dir%%-worktree*}")"
    case "$dir" in "$WORKSPACE/worktrees/"*) ;; *) main="$dir" ;; esac

    if [ -d "$dir/.git" ] || [ -f "$dir/.git" ]; then
        local have; have="$(git -C "$dir" remote get-url origin 2>/dev/null)"
        [ "${have%.git}" = "${url%.git}" ] \
            || die "$dir is a clone of $have, this stack wants $url -- move it aside and rerun"
        [ -z "$OFFLINE" ] && ff_latest "$dir" "$branch"
        return
    fi
    [ -n "$OFFLINE" ] && die "--offline but $dir is not a checkout"

    case "$dir" in
    "$WORKSPACE/worktrees/"*)
        main="$WORKSPACE/$(basename "$dir" | sed "s/-${branch}\$//")"
        [ -d "$main/.git" ] || { log "clone $(basename "$main")"; execute git clone "$url" "$main"; }
        log "worktree $(basename "$dir") @ $branch (main clone stays on $(git -C "$main" rev-parse --abbrev-ref HEAD))"
        execute mkdir -p "$WORKSPACE/worktrees"
        execute git -C "$main" fetch origin "$branch"
        execute git -C "$main" worktree prune
        if git -C "$main" show-ref --verify --quiet "refs/heads/$branch"; then
            execute git -C "$main" worktree add "$dir" "$branch"
        else
            execute git -C "$main" worktree add "$dir" -b "$branch" "origin/$branch"
        fi
        ff_latest "$dir" "$branch"
        ;;
    *)
        log "clone $(basename "$dir") @ $branch"
        execute git clone -b "$branch" "$url" "$dir"
        ;;
    esac
}

execute mkdir -p "$WORKSPACE"

for c in $COMPONENTS; do
    [ -n "$ONLY" ] && [ "$ONLY" != "$c" ] && continue
    h="$(host_of "$c")"
    if [ -n "$h" ]; then
        log "fetch $c on $h"
        remote_sync "$h" && on_host "$h" automation/verbs/fetch.sh --only="$c" ${OFFLINE:+--offline} || die "fetch $c on $h failed"
        continue
    fi
    case "$c" in
        ocudu|ocudu-cu|ocudu-low)
            if [ -n "${OCUDU_TREE:-}" ]; then
                need_dir "$OCUDU_TREE/apps" "OCUDU_TREE=$OCUDU_TREE is not an OCUDU checkout"
                ok "$c: using your OCUDU tree $OCUDU_TREE (not fetched)"
            else
                git_at "$OCUDU_URL"  "${OCUDU_BRANCH}" "$OCUDU_SRC_DIR"
            fi ;;
        oai-gnb|oai-nrue)
                   git_at "$OAI_URL"    "${OAI_BRANCH}"   "$OAI_SRC_DIR" ;;
        xfapi)     git_at "$XFAPI_URL"  "${XFAPI_BRANCH}" "$WORKSPACE/xFAPI"
                   git_at "$OAI_URL"    "${OAI_BRANCH}"   "$OAI_SRC_DIR" ;;
        o1)        git_at "$O1_URL"     "${O1_BRANCH}"    "$WORKSPACE/OCUDU-O1-Adaptor" ;;
        aerial)    git_at "$AERIAL_URL" "${AERIAL_BRANCH}" "$WORKSPACE/aerial-cuda-accelerated-ran"
                   execute git -C "$WORKSPACE/aerial-cuda-accelerated-ran" lfs pull ;;
        core5g)
            [ "$COMPONENTS" != core5g ] && { ok "core5g: the operator's, nothing to fetch"; continue; }
            case "${CORE:-oai-cn5g}" in
            oai-cn5g)
                d="$WORKSPACE/oai-cn5g"
                if [ -f "$d/docker-compose.yaml" ]; then ok "oai-cn5g already in $d"
                elif [ -n "$OFFLINE" ]; then die "--offline but $d is missing"
                else
                    log "oai-cn5g from $OAI_CN5G_URL ($OAI_CN5G_BRANCH:$OAI_CN5G_PATH)"
                    t="$(mktemp -d)"
                    execute git clone -q --depth 1 --filter=blob:none --sparse -b "$OAI_CN5G_BRANCH" "$OAI_CN5G_URL" "$t/oai"
                    execute git -C "$t/oai" sparse-checkout set "$OAI_CN5G_PATH"
                    execute mv "$t/oai/$OAI_CN5G_PATH" "$d"; rm -rf "$t"
                fi ;;
            sd-core)  git_at "$SDCORE_URL" "$SDCORE_BRANCH" "$WORKSPACE/aether-onramp" ;;
            external) ok "external core: nothing to fetch" ;;
            esac ;;
        *)         : ;;
    esac
done

log "workspace: $WORKSPACE"
