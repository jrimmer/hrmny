#!/usr/bin/env bash
# ScyllaDB dev hygiene — drop accumulated keyspaces.
#
# WHY THIS EXISTS (2026-09-11 incident): the concurrent-agent convention in
# AGENTS.md namespaces test runs with `CYTALE_TEST_KEYSPACE=<unique-name>`, but
# a hard-killed run never fires its cleanup hook, so one-off keyspaces piled up:
# 76 of them, ~40 tables each (~3,000 tables total). ScyllaDB loads EVERY
# keyspace's metadata at boot, so startup stretched to 4-8 minutes and then died
# outright with `std::bad_alloc` in `tables_metadata::parallel_for_each_table` —
# the node could no longer boot at all, and no dev server could start. Boot cost
# is driven by the global table count, so keep it bounded. See the "Dev-loop
# database hygiene" section of AGENTS.md for the full story and the traps.
#
# USAGE
#   scripts/scylla-reset.sh                     dry run — lists what WOULD go
#   scripts/scylla-reset.sh --apply             drop the listed keyspaces
#   scripts/scylla-reset.sh --keep cytale,x     protect extra keyspace names
#   scripts/scylla-reset.sh --container NAME    target a differently named node
#   scripts/scylla-reset.sh --all               also drop the protected names
#   scripts/scylla-reset.sh --force             confirm a guarded action
#
# WHAT IT KEEPS
#   `system*` and `cytale` by default. `cytale` is THE DEV KEYSPACE — local
#   accounts (jordan/sam) and the Playground workspace — so nothing but an
#   explicit `--all --apply --force` can reach it.
#
# SAFETY
#   Refuses `--apply` (unless `--force`) when:
#     - the target container is not the dev default (`cytale-scylla`), which is
#       what a production or otherwise-important node would look like, or
#     - `--all` is set, since that is the only way to drop a protected keyspace.
#   Dry runs are always allowed — they change nothing and are how you inspect.
#   Also warns (non-blocking) if a `mix test` run is active, because sweeping a
#   peer agent's live keyspace breaks their suite; pass `--keep <their-name>`.
#
#   Drops are verified against system_schema and then flushed to disk — see the
#   two comments further down for why both steps are mandatory.

set -euo pipefail

DEFAULT_CONTAINER="cytale-scylla"
CONTAINER="${CYTALE_SCYLLA_CONTAINER:-$DEFAULT_CONTAINER}"
KEEP="cytale"
APPLY=0
DROP_ALL=0
FORCE=0

usage() {
  # Print the leading comment block, minus the shebang and this line's own `#`.
  awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --all) DROP_ALL=1 ;;
    --force) FORCE=1 ;;
    --keep) KEEP="${2:?--keep needs a value}"; shift ;;
    --container) CONTAINER="${2:?--container needs a value}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1  (try --help)" >&2; exit 2 ;;
  esac
  shift
done

refuse() {
  echo "REFUSING: $1" >&2
  echo >&2
  echo "Re-run with --force if you are certain — but check first that this is not a" >&2
  echo "database anyone else is using:" >&2
  echo "  pgrep -f 'mix test'        # a peer agent's suite?" >&2
  exit 1
}

if ! docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo "container '$CONTAINER' not found — set --container" >&2
  exit 1
fi

if ! docker exec "$CONTAINER" nodetool status 2>/dev/null | grep -q '^UN'; then
  echo "ScyllaDB in '$CONTAINER' is not UP/Normal — refusing to touch schema." >&2
  echo "Check: docker logs --tail 50 $CONTAINER" >&2
  exit 1
fi

IS_DEV_CONTAINER=1
if [[ "$CONTAINER" != "$DEFAULT_CONTAINER" ]]; then
  IS_DEV_CONTAINER=0
  echo "NOTE: targeting '$CONTAINER', not the dev default '$DEFAULT_CONTAINER'."
  echo "      This script DROPS KEYSPACES. If that node serves anything other"
  echo "      than a local dev database, stop here."
  echo
fi

# Guarded actions. Production never runs this intentionally, but nothing about
# the script knows where it is — a non-default container name is the cheapest
# available signal that you may be somewhere you did not mean to be, and `--all`
# is the only path to a protected keyspace.
if [[ $APPLY -eq 1 && $FORCE -eq 0 ]]; then
  # Explicit ifs, not `[[ test ]] && refuse`: that form is a && list, and its
  # set -e exemption is subtle enough that a future edit could get it wrong.
  if [[ $IS_DEV_CONTAINER -eq 0 ]]; then
    refuse "--container '$CONTAINER' is not the dev default '$DEFAULT_CONTAINER'."
  fi
  if [[ $DROP_ALL -eq 1 ]]; then
    refuse "--all drops protected keyspaces, including the dev 'cytale'."
  fi
fi

if [[ $APPLY -eq 1 ]] && pgrep -f "mix test" >/dev/null 2>&1; then
  echo "NOTE: a 'mix test' run appears active on this machine."
  echo "      If that is a peer agent's suite, add its keyspace to --keep"
  echo "      (e.g. --keep $KEEP,impl47c) and do not restart the node until it"
  echo "      finishes. Restarting ScyllaDB kills in-flight suites."
  echo
fi

# cqlsh prints a boxed table: header, dashes, row lines, then an `(N rows)`
# trailer. Keep only the row lines — the trailer parses as a bogus keyspace.
all_keyspaces() {
  docker exec "$CONTAINER" cqlsh -e \
    "SELECT keyspace_name FROM system_schema.keyspaces;" 2>/dev/null |
    grep -vE '^\s*$|^-+$|keyspace_name|^\([0-9]+ rows?\)$' |
    awk '{print $1}' | sort
}

# system* is Cassandra/Scylla internals — never a caller's business to drop.
is_system() { [[ "$1" == system* ]]; }

wanted_keep() {
  local ks="$1" k
  [[ $DROP_ALL -eq 1 ]] && return 1
  IFS=',' read -ra parts <<<"$KEEP"
  for k in "${parts[@]}"; do
    [[ "$ks" == "$k" ]] && return 0
  done
  return 1
}

drop_list=()
keep_list=()
while read -r ks; do
  if is_system "$ks" || wanted_keep "$ks"; then
    keep_list+=("$ks")
  else
    drop_list+=("$ks")
  fi
done < <(all_keyspaces)

total=$(( ${#drop_list[@]} + ${#keep_list[@]} ))

echo "container:  $CONTAINER"
echo "keyspaces:  $total total — ${#keep_list[@]} kept, ${#drop_list[@]} to drop"
echo
echo "keeping:    ${keep_list[*]:-<none>}"
echo

if [[ ${#drop_list[@]} -eq 0 ]]; then
  echo "nothing to drop — the database is already clean."
  exit 0
fi

echo "dropping:"
printf '  %s\n' "${drop_list[@]}"
echo

if [[ $APPLY -eq 0 ]]; then
  echo "DRY RUN — re-run with --apply to drop the ${#drop_list[@]} keyspace(s) above."
  echo "Each DROP is a schema change; expect roughly one raft round-trip apiece."
  exit 0
fi

# cqlsh default --request-timeout is 10s, and a DROP KEYSPACE has to wait for
# schema agreement across the raft group — on a busy node that regularly
# outlives the client timeout. Raise it; the verification pass below catches
# whatever still slips through.
CQLSH="cqlsh --request-timeout=60"

# Drop, then verify against the schema instead of trusting cqlsh's exit code.
# Measured 2026-09-11: of 80 drops, cqlsh reported 48 as failures
# (`OperationTimedOut`) while only 13 keyspaces actually survived — the DROP
# had landed server-side and the client had merely given up waiting. So each
# pass re-reads system_schema and retries only the keyspaces still present.
worklist=("${drop_list[@]}")
pass=1
max_passes=4

while [[ ${#worklist[@]} -gt 0 && $pass -le $max_passes ]]; do
  echo "pass $pass: ${#worklist[@]} keyspace(s)"
  for ks in "${worklist[@]}"; do
    docker exec "$CONTAINER" $CQLSH -e "DROP KEYSPACE IF EXISTS $ks;" >/dev/null 2>&1 || true
  done

  live=$(all_keyspaces)
  survivors=()
  for ks in "${worklist[@]}"; do
    if grep -qx "$ks" <<<"$live"; then survivors+=("$ks"); fi
  done

  printf '  dropped %d, %d still present\n' \
    "$(( ${#worklist[@]} - ${#survivors[@]} ))" "${#survivors[@]}"

  if [[ ${#survivors[@]} -eq 0 ]]; then
    worklist=()
  else
    worklist=("${survivors[@]}")
  fi
  (( pass++ )) || true
done

echo
if [[ ${#worklist[@]} -gt 0 ]]; then
  echo "${#worklist[@]} keyspace(s) still present after $max_passes passes:" >&2
  printf '  %s\n' "${worklist[@]}" >&2
  echo "The node may be overloaded or the raft group wedged. Check:" >&2
  echo "  docker exec $CONTAINER nodetool status" >&2
  exit 1
fi

# Persist the drops. ScyllaDB holds recent schema mutations in its commitlog
# until they are flushed, so a container that is SIGKILLed before that replays
# the OLD schema and silently resurrects every keyspace you just dropped.
# Observed 2026-09-11: 80 drops read back as gone, the container was stopped
# (SIGKILL after docker's 10s default), the commitlog was cleared, and all 80
# came back on the next boot. Flush, and prefer `docker stop -t 120` over a
# SIGKILL, so a drain has time to finish.
echo "flushing schema to disk..."
if ! docker exec "$CONTAINER" nodetool flush >/dev/null 2>&1; then
  echo "WARNING: flush failed — give the node a graceful stop (docker stop -t 120)" >&2
  echo "         before killing it, or these drops will be replayed away." >&2
fi

echo "done — ${#drop_list[@]} keyspace(s) dropped (was $total, now $(( total - ${#drop_list[@]} )))."
echo "Boot time is driven by table count across all keyspaces; a restart should now be quick:"
echo "  docker restart $CONTAINER"
