#!/usr/bin/env bash
# probe-sink.sh — run the JSON probe sink in the FOREGROUND on 127.0.0.1:41999.
#
#   scripts/probe-sink.sh
#
# Accepts POST / (any JSON body) and appends one line per request to
# /tmp/cytale-probe.jsonl, printing each line to stdout prefixed `SINK `.
# GET / answers 204 as a device reachability check. Zero dependencies — plain
# node built-ins (node:http + node:fs), no npm install.
#
# Android device reachability (run once per device connection, in another shell):
#
#     adb reverse tcp:41999 tcp:41999
#
# then POST from the device to http://127.0.0.1:41999/ and watch the lines
# appear here. Ctrl-C stops the listener.
#
# The app side is apps/mobile/src/calls/devSink.ts, which POSTs to
# EXPO_PUBLIC_CYTALE_PROBE_SINK — point that at this listener for a device run:
#
#     EXPO_PUBLIC_CYTALE_PROBE_SINK=http://127.0.0.1:41999/ npx expo start
#
# Env: CYTALE_PROBE_PORT (41999) · CYTALE_PROBE_HOST (127.0.0.1)
#      CYTALE_PROBE_OUT  (/tmp/cytale-probe.jsonl)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "probe-sink: node not found (needs Node >= 22 for a bare built-in server)" >&2
  exit 1
fi

exec node "$REPO_ROOT/scripts/probe-sink.mjs"
