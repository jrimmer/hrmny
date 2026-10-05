#!/usr/bin/env bash
# Cytale local dev: server on :4000 serving the built SPA + API + gateway.
# Usage: ./scripts/dev-server.sh        (build web, then run server)
#        ./scripts/dev-server.sh --web  (web only: rebuild + copy, server keeps running)
set -euo pipefail
cd "$(dirname "$0")/../apps/server"

export MIX_ENV=dev
export PORT=4000
export SECRET_KEY_BASE=local-dev-secret-key-base-32-chars-ok!
export AUTH_JWT_SECRET=local-dev-jwt-secret-key-32-chars-ok!!
export AUTH_REFRESH_PEPPER=local-dev-refresh-pepper-32-chars-ok!
export CYTALE_SCYLLA_NODES=127.0.0.1:9042

echo "==> building web client"
(cd ../web && pnpm build)
rm -rf priv/static && cp -r ../web/dist priv/static

if [[ "${1:-}" != "--web" ]]; then
  echo "==> starting server on :4000 (Ctrl-C to stop)"
  exec mix phx.server
fi
