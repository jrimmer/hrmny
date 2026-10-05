#!/usr/bin/env bash
# call-smoke.sh — prove the LOCAL dev server's call path end to end.
#
#   scripts/call-smoke.sh
#
# Black-box: authenticates two fresh accounts over the REST API, then drives
# the voice-call control plane over the WebSocket gateway (op 22 start/join/
# leave, op 23 ICE relay) and asserts the server answers with CALL_UPDATE
# joined and pushes the sole-offerer CALL_SIGNAL sdp offer. No WebRTC
# handshake — this proves the SERVER's call control + signalling, which is
# the part that has to be right before any browser can negotiate media.
#
# Requires only: node (>= 22, for built-in fetch + WebSocket) and a dev server
# on :4000 (scripts/dev-4000.sh). Needs no TURN configuration — a no-TURN
# deployment answers GET /api/v1/calls/ice with an empty server list and the
# script asserts exactly that.
#
# Env: CYTALE_SMOKE_BASE (default http://127.0.0.1:4000)
#      CYTALE_DEV_MAILBOX (default apps/server/tmp/dev_mailbox.jsonl — the dev
#      mailer writes verification tokens there; registration alone is not
#      enough because unverified accounts are view-only)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BASE="${CYTALE_SMOKE_BASE:-http://127.0.0.1:4000}"
export CYTALE_SMOKE_BASE="$BASE"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found (needed for fetch + WebSocket); install Node >= 22" >&2
  exit 1
fi

echo "checking dev server at $BASE ..."
if ! curl -fsS -m 15 -o /dev/null "$BASE/health" 2>/dev/null; then
  echo "no healthy dev server at $BASE — start one with: scripts/dev-4000.sh" >&2
  exit 1
fi

exec node "$REPO_ROOT/scripts/call-smoke.mjs"
