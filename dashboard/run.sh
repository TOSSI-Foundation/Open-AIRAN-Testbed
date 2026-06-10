#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FE="$HERE/frontend"
BE="$HERE/backend"
HOST="${HOST:-0.0.0.0}"

network_password() {
  case "$HOST" in 127.*|localhost|::1) return ;; esac
  if [[ -z "${TOSSI_PASSWORD:-}" || "$TOSSI_PASSWORD" == tossi ]]; then
    local f="$HERE/../var/dashboard/password"
    if [[ ! -s "$f" ]]; then
      mkdir -p "$(dirname "$f")"
      (umask 077 && python3 -c 'import secrets; print(secrets.token_urlsafe(12))' > "$f")
    fi
    TOSSI_PASSWORD="$(cat "$f")"
  fi
  export TOSSI_PASSWORD
  echo "[tossi] listening on $HOST -- reachable from other machines"
  echo "[tossi] password: $TOSSI_PASSWORD   (set TOSSI_PASSWORD to choose your own)"
}
PORT="${PORT:-8000}"

ensure_backend() {
  if [[ ! -d "$BE/.venv" ]]; then
    echo "[tossi] creating backend venv…"
    python3 -m venv "$BE/.venv"
    "$BE/.venv/bin/pip" install -q --upgrade pip
    "$BE/.venv/bin/pip" install -q -r "$BE/requirements.txt"
  fi
}

ensure_frontend() {
  if [[ ! -d "$FE/node_modules" ]]; then
    echo "[tossi] installing frontend deps…"
    (cd "$FE" && npm install --no-audit --no-fund)
  fi
}

case "${1:-serve}" in
  build)
    ensure_frontend
    (cd "$FE" && npm run build)
    ;;

  audit)
    ensure_backend
    exec "$BE/.venv/bin/python" "$HERE/audit_live.py"
    ;;
  test)
    ensure_backend
    shift || true
    (cd "$BE" && "$BE/.venv/bin/python" -m unittest discover -s tests -t . "$@") || exit 1
    if [ -x "$HERE/.node/bin/node" ]; then
      echo "[tossi] map module"
      (cd "$HERE/sionna-map/test" && "$HERE/.node/bin/node" test_rays.mjs) || exit 1
      for t in "$HERE"/sionna-map/src/*.test.mjs; do
        [ -e "$t" ] || continue
        (cd "$HERE/sionna-map" && "$HERE/.node/bin/node" "$t") || exit 1
      done
    else
      echo "[tossi] map module tests skipped (no ./.node/bin/node)"
    fi
    ;;

  dev)
    ensure_backend
    ensure_frontend
    network_password
    echo "[tossi] backend  → http://$HOST:8000"
    echo "[tossi] frontend → http://$HOST:5173  (open this one in dev)"
    "$BE/.venv/bin/python" -m uvicorn app.main:app --app-dir "$BE" \
        --host "$HOST" --port 8000 --reload &
    BE_PID=$!
    trap 'kill $BE_PID 2>/dev/null || true' EXIT
    (cd "$FE" && npm run dev)
    ;;

  serve)
    ensure_backend
    ensure_frontend
    network_password
    echo "[tossi] building frontend…"
    (cd "$FE" && npm run build)
    echo "[tossi] serving the whole app at http://$(hostname -I 2>/dev/null | awk '{print $1}'):$PORT  (bound to $HOST)"
    exec "$BE/.venv/bin/python" -m uvicorn app.main:app --app-dir "$BE" \
        --host "$HOST" --port "$PORT"
    ;;

  *)
    echo "usage: $0 {dev|serve|build|test}" >&2
    exit 1
    ;;
esac
