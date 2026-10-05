#!/usr/bin/env bash
# Forward a remote ScyllaDB to this machine, for running the server suite
# without a local node (they are heavy — see AGENTS.md "Dev-loop database
# hygiene"). Compiling stays local; only CQL crosses the tunnel.
#
# Usage:
#   CYTALE_TUNNEL_HOST=user@db-host.example.com \
#   CYTALE_TUNNEL_TARGET=127.0.0.1:9042 \
#     scripts/scylla-tunnel.sh              # foreground; Ctrl-C closes it
#   then, in another shell:
#   CYTALE_SCYLLA_NODES=127.0.0.1:19042 CYTALE_TEST_KEYSPACE=<one_off_name> \
#     CYTALE_TEST_PORT=<port> mix test
#
# Env (defaults in brackets):
#   CYTALE_TUNNEL_HOST    ssh target                           [required]
#   CYTALE_TUNNEL_TARGET  ScyllaDB address as seen FROM that host [required]
#   CYTALE_TUNNEL_PORT    local port                           [19042]
#
# SAFETY: a node that also serves a deployment holds its `cytale` keyspace.
# ALWAYS run with a one-off CYTALE_TEST_KEYSPACE — the suite drops it on exit,
# and test_helper.exs refuses `cytale` outright (ScyllaCase truncates every
# table in its keyspace).
set -euo pipefail

# A private overlay may carry a team's usual values (not part of the public
# tree): $HRMNY_DEV_ENV, default <repo>/private/dev.env, sourced when present.
dev_env="${HRMNY_DEV_ENV:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/private/dev.env}"
if [ -f "$dev_env" ]; then
  # shellcheck disable=SC1090
  . "$dev_env"
fi

host="${CYTALE_TUNNEL_HOST:?set CYTALE_TUNNEL_HOST (the ssh target, e.g. user@db-host.example.com)}"
target="${CYTALE_TUNNEL_TARGET:?set CYTALE_TUNNEL_TARGET (ScyllaDB host:port as seen from that host)}"
port="${CYTALE_TUNNEL_PORT:-19042}"

echo "tunnel: 127.0.0.1:$port -> $target via $host (Ctrl-C to close)"
exec ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 \
  -L "127.0.0.1:$port:$target" "$host"
