#!/usr/bin/env bash
# Cytale dev loop — the fastest possible iteration path.
#
# Terminal 1:  ./scripts/dev.sh            # vite dev server on :5173 + api proxy to :4000
# Terminal 2:  ./scripts/dev.sh --server   # Elixir server on :4000 (run once)
# Terminal 3:  ./scripts/dev.sh --test     # vitest + mix test watchers
#
# The vite dev server gives INSTANT hot-module-reload on every web edit.
# No build step, no deploy step, no service-worker, no localStorage staleness.
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  --server)
    cd apps/server
    export MIX_ENV=dev PORT=4000
    export SECRET_KEY_BASE=dev-secret-key-base-32-chars-minimum!
    export AUTH_JWT_SECRET=dev-jwt-secret-key-base-32-chars-minim!
    export AUTH_REFRESH_PEPPER=dev-refresh-pepper-32-chars-minimum!!
    export CYTALE_SCYLLA_NODES=127.0.0.1:9042
    echo "==> Elixir server on :4000 (Ctrl+C to stop)"
    exec mix phx.server
    ;;
  --test)
    # Watch both suites: TS in one process, Elixir in another.
    echo "==> vitest watch (web)"
    (cd apps/web && pnpm vitest --watch) &
    VITEST_PID=$!
    echo "==> mix test --stale watch (server)"
    (cd apps/server && mix test.watch --stale) &
    MIX_PID=$!
    trap "kill $VITEST_PID $MIX_PID 2>/dev/null" EXIT
    wait
    ;;
  *)
    # Default: vite dev server with proxy to the Elixir backend.
    cd apps/web
    echo "==> vite dev server on http://localhost:5173 (proxies /api + /gateway to :4000)"
    echo "==> start the backend first: $0 --server"
    exec pnpm vite --host
    ;;
esac
