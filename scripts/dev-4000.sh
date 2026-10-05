#!/usr/bin/env bash
# Cytale dev server (:4000) keeper.
#
#   scripts/dev-4000.sh          one-shot: boot the server if :4000 is free
#   scripts/dev-4000.sh --watch  keep it up, with backoff while the DB is down
#
# Namespaced runs (CYTALE_TEST_PORT / PORT=4101 etc.) are untouched — only
# the default :4000 dev server is managed. Logs: /tmp/cytale-dev-4000.log.
#
# WHY THE BACKOFF (2026-09-11): this used to retry every 20s unconditionally.
# When ScyllaDB was mid-boot (4-8 min, see scripts/scylla-reset.sh for the
# cause) every retry booted a full BEAM that then raised "ScyllaDB is not
# reachable" at the boot schema step, exited, and was replaced 20s later — a
# boot storm that competed for the very RAM and CPU Scylla needed to finish
# booting, while the log grew to 17MB. Now the keeper waits for the DATABASE
# before booting anything, backs off on repeated failure, and rotates its log.
#
# -e/-o pipefail: every probe here (port_up, scylla_up, boot_and_wait,
# kill -0) is already consumed in if/while conditions or returns its verdict
# through the callers, so strict mode changes no behavior — it only turns an
# unexpected setup failure (unwritable log, missing nc) into a loud stop
# instead of a silent spin.
set -euo pipefail

LOG="${CYTALE_DEV_LOG:-/tmp/cytale-dev-4000.log}"
SCYLLA_CONTAINER="${CYTALE_SCYLLA_CONTAINER:-cytale-scylla}"
SCYLLA_PORT="${CYTALE_SCYLLA_PORT:-9042}"

POLL_UP=10          # seconds between checks while :4000 is healthy
BACKOFF_MIN=15      # first retry delay after a failure
BACKOFF_MAX=300     # ceiling — a wedged DB is not worth hammering
BOOT_WAIT_STEPS=12  # x5s = how long a boot gets to reach :4000 before we re-evaluate
MAX_LOG_BYTES=$(( 5 * 1024 * 1024 ))

cd "$(dirname "$0")/../apps/server" || exit 1

CHILD_PID=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >>"$LOG"; }

rotate_log() {
  [[ -f "$LOG" ]] || return 0
  local size
  size=$(wc -c <"$LOG" 2>/dev/null || echo 0)
  if [[ "$size" -gt "$MAX_LOG_BYTES" ]]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
    log "log rotated (previous exceeded $(( MAX_LOG_BYTES / 1048576 ))MB)"
  fi
}

port_up() { nc -z 127.0.0.1 4000 >/dev/null 2>&1; }

# A plain TCP probe is not enough for a containerised ScyllaDB: docker-proxy
# accepts the connection even while the node inside is still booting, so a
# port check would report "ready" for minutes before the first CQL statement
# can succeed. Ask the node itself when we can; fall back to TCP for a native
# (non-container) install, which is the only thing the docs allow.
scylla_up() {
  if docker inspect "$SCYLLA_CONTAINER" >/dev/null 2>&1; then
    docker exec "$SCYLLA_CONTAINER" nodetool status 2>/dev/null | grep -q '^UN'
    return
  fi
  nc -z 127.0.0.1 "$SCYLLA_PORT" >/dev/null 2>&1
}

boot() {
  rotate_log
  echo "$(date '+%Y-%m-%d %H:%M:%S') :4000 down — booting dev server" >>"$LOG"
  nohup mix phx.server >>"$LOG" 2>&1 &
  CHILD_PID=$!
}

# Give the boot a bounded window to bind :4000. Returns non-zero on timeout, so
# the caller backs off instead of immediately stacking another boot on top.
boot_and_wait() {
  boot
  local i
  for (( i = 0; i < BOOT_WAIT_STEPS; i++ )); do
    sleep 5
    if port_up; then
      log "dev server listening on :4000"
      return 0
    fi
    # The child dying (e.g. the DB went away mid-boot) is a definitive failure.
    if ! kill -0 "$CHILD_PID" 2>/dev/null; then
      log "dev server exited during boot — see tail of $LOG"
      return 1
    fi
  done
  return 1
}

if [[ "${1:-}" == "--watch" ]]; then
  delay="$BACKOFF_MIN"
  while true; do
    if port_up; then
      delay="$BACKOFF_MIN"
      CHILD_PID=""
      sleep "$POLL_UP"
      continue
    fi

    if ! scylla_up; then
      log "ScyllaDB not ready (container '$SCYLLA_CONTAINER') — holding off ${delay}s"
      sleep "$delay"
      [[ "$delay" -lt "$BACKOFF_MAX" ]] && delay=$(( delay * 2 ))
      [[ "$delay" -gt "$BACKOFF_MAX" ]] && delay="$BACKOFF_MAX"
      continue
    fi

    if boot_and_wait; then
      delay="$BACKOFF_MIN"
    else
      log "boot did not reach :4000 — next attempt in ${delay}s"
      sleep "$delay"
      [[ "$delay" -lt "$BACKOFF_MAX" ]] && delay=$(( delay * 2 ))
      [[ "$delay" -gt "$BACKOFF_MAX" ]] && delay="$BACKOFF_MAX"
    fi
  done
else
  if port_up; then
    echo ":4000 already up — log: $LOG"
  elif ! scylla_up; then
    echo "ScyllaDB is not ready — not booting (the server would fail its schema step)."
    echo "Check: docker exec $SCYLLA_CONTAINER nodetool status"
  else
    boot
    echo ":4000 booting — log: $LOG"
  fi
fi
