#!/usr/bin/env bash
# Run the LIVE-SERVER Playwright suite (apps/web/e2e/*.live.spec.ts) against a
# throwaway stack: a leased ScyllaDB, a real dev server on its own keyspace and
# port that also serves the built SPA. ON DEMAND ONLY (owner
# decision 2026-09-29): nothing runs this on push or on a timer; the
# e2e-live.yml workflow is workflow_dispatch-only and gates nothing.
#
#   scripts/e2e-live.sh                                  # the whole live suite
#   scripts/e2e-live.sh e2e/settings.live.spec.ts        # any playwright args
#   scripts/e2e-live.sh --grep 'reply' --retries 1
#
# The stack, and why each piece is what it is:
#
#   * DATABASE — the node CYTALE_SCYLLA_NODES names (a local Docker ScyllaDB
#     is fine; the run uses its own keyspace and drops it at exit). Where a
#     lease helper exists (scripts/ci-scylla-lease.sh — CI-infrastructure
#     specific, not part of every checkout), an unset CYTALE_SCYLLA_NODES
#     leases a throwaway node through it instead; the lease is released by an
#     EXIT trap, so a red run, a Ctrl-C or a failed boot all give it back.
#   * SERVER — `MIX_ENV=dev mix phx.server`, not the test env and not the
#     release image. The test env is hermetic by design (no Scylla pool at
#     boot, a logging publisher instead of the fan-out, a stub gateway
#     authenticator), so real clients cannot drive it. The release image is
#     the most production-like, but it needs a docker build per run and a
#     prod env with the dev mailer opted in, for no gain the specs can see.
#     The dev server runs the same application code as a release with the
#     production-shaped auth/gateway/publish wiring, applies the schema to its
#     keyspace at boot, and uses the Dev mailer — the token sink
#     `registerVerifiedUser` reads to verify email. Nothing in production
#     code is relaxed for it: its keyspace (CYTALE_DEV_KEYSPACE), port, mailbox
#     file, search index and server-config paths are all per-run, and the one
#     limit it lifts is the SEND budget (CYTALE_DEV_LIFT_SEND_BUDGET, dev-only,
#     as config/test.exs does) — specs seed dozens of rows in a burst to set a
#     scene. Every request-rate bucket stays production-shaped.
#   * WEB — the SPA BUILT and served by that same server from priv/static,
#     the production topology: one origin, the real CSP and static plug, a
#     bundled module graph. Built in vite's `development` mode, because the
#     live specs read the dev-gated automation handles (__cytaleStore). Not
#     the vite dev server: its unbundled graph (hundreds of modules per page
#     load) exhausted Chromium's request pool on a 2-core runner
#     (net::ERR_INSUFFICIENT_RESOURCES → blank page after every reload), and
#     its file watcher full-reloaded pages whenever the run wrote a trace.
#     NOTE: the build replaces apps/server/priv/static (gitignored), exactly
#     as scripts/dev-server.sh does.
#
# Output (E2E_OUT_DIR, default apps/web/e2e-live-results): report/ (Playwright
# HTML report, traces inside), results.json, test-results/ (traces and
# failure screenshots), server.log, build.log, summary.txt.
#
# Env:
#   CYTALE_SCYLLA_NODES  use this node (host:port) instead of leasing one; the
#                        run's keyspace is dropped from it at exit (required
#                        when no lease helper is present)
#   E2E_SERVER_PORT      dev server port (API + SPA)            [4180]
#                        (must not be a fetch "bad port", e.g. 4190)
#   E2E_KEYSPACE         keyspace                   [e2e_live_<epoch>_<pid>]
#   E2E_OUT_DIR          artifacts directory  [apps/web/e2e-live-results]
#   E2E_SKIP_SETUP=1     skip `pnpm install` / `mix deps.get` / browser install
#   E2E_RETRIES          Playwright retries (a later --retries wins)  [0]
#   E2E_BOOT_TIMEOUT     seconds to wait for the server's /health   [300]
#   E2E_PASSKEYS=1       boot the server the way a deployment runs it —
#                        CYTALE_EXTERNAL_BASE_URL set to its own origin
#                        (http://localhost:<port>) — so the WebAuthn RP ID and
#                        expected origin derive exactly as in production and
#                        passkeys are advertised. Needed by
#                        passkey-login.live.spec.ts (which skips without it).
#                        Opt-in because an advertised passkey surface asks
#                        every password login to set one up — an overlay the
#                        other specs were not written around.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LEASE_SCRIPT="$ROOT/scripts/ci-scylla-lease.sh"
SERVER_PORT="${E2E_SERVER_PORT:-4180}"
KEYSPACE="${E2E_KEYSPACE:-e2e_live_$(date +%s)_$$}"
OUT="${E2E_OUT_DIR:-$ROOT/apps/web/e2e-live-results}"
BOOT_TIMEOUT="${E2E_BOOT_TIMEOUT:-300}"
RUN="$OUT/run" # server-side state: mailbox, search index, server config

say() { echo "e2e-live: $*" >&2; }
started_at=$(date +%s)

case "$KEYSPACE" in
  cytale | cytale_test | system*) say "refusing keyspace '$KEYSPACE' (shared/system)"; exit 2 ;;
esac

case "$OUT" in
  / | "$ROOT" | "$HOME") say "refusing E2E_OUT_DIR '$OUT' (it is emptied first)"; exit 2 ;;
esac
rm -rf "$OUT"
mkdir -p "$OUT" "$RUN"

server_pid=""
suite_pid=""
leased_id=""
external_nodes=""

# Stop a process group we started (setsid made each child its own group
# leader, so the group id is the pid we recorded) — never by name.
stop_group() {
  local pid="$1" name="$2"
  [ -n "$pid" ] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || { say "$name stopped"; return 0; }; sleep 0.5; done
  kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
  say "$name killed"
}

drop_keyspace() {
  # Only for a caller-supplied node: a leased fork disappears with its lease.
  [ -n "$external_nodes" ] || return 0
  say "dropping keyspace $KEYSPACE from $external_nodes"
  (cd "$ROOT/apps/server" && MIX_ENV=dev CYTALE_SCYLLA_NODES="$external_nodes" \
    mix run --no-start --no-compile -e '
      [ks, nodes] = System.argv()
      {:ok, _} = Application.ensure_all_started(:xandra)
      {:ok, conn} = Xandra.start_link(nodes: String.split(nodes, ","))
      Xandra.execute!(conn, "DROP KEYSPACE IF EXISTS #{ks}", [], timeout: 60_000)
    ' "$KEYSPACE" "$external_nodes" >/dev/null 2>&1) || say "could not drop $KEYSPACE (scripts/scylla-reset.sh sweeps leftovers)"
}

cleanup() {
  local rc=$?
  trap - EXIT INT TERM
  stop_group "$suite_pid" playwright
  stop_group "$server_pid" server
  drop_keyspace
  if [ -n "$leased_id" ]; then "$LEASE_SCRIPT" release "$leased_id" || true; fi
  say "done in $(($(date +%s) - started_at))s (exit $rc)"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# The Fetch standard's "bad ports" (Node's fetch and browsers refuse them with
# "bad port"). 4190 (ManageSieve) was this script's first default and failed
# every API call in CI run 2990.
case " 1 7 9 11 13 15 17 19 20 21 22 23 25 37 42 43 53 69 77 79 87 95 101 102 103 104 109 110 111 113 115 117 119 123 135 137 139 143 161 179 389 427 465 512 513 514 515 526 530 531 532 540 548 554 556 563 587 601 636 989 990 993 995 1719 1720 1723 2049 3659 4045 4190 5060 5061 6000 6566 6665 6666 6667 6668 6669 6679 6697 10080 " in
  *" $SERVER_PORT "*) echo "[e2e-live] port $SERVER_PORT is a fetch 'bad port' (browsers and Node refuse it) — choose another E2E_SERVER_PORT" >&2; exit 2 ;;
esac
port_free() { ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
port_free "$SERVER_PORT" || { say "port $SERVER_PORT is already in use — set E2E_SERVER_PORT"; exit 2; }

# ----- setup ------------------------------------------------------------------
if [ "${E2E_SKIP_SETUP:-0}" != "1" ]; then
  say "installing workspace deps"
  (cd "$ROOT" && pnpm install --frozen-lockfile --reporter=append-only >/dev/null)
  say "installing the Playwright browser"
  if [ "$(id -u)" = 0 ]; then
    (cd "$ROOT/apps/web" && pnpm exec playwright install --with-deps chromium >/dev/null)
  else
    (cd "$ROOT/apps/web" && pnpm exec playwright install chromium >/dev/null)
  fi
  say "fetching + compiling the server (MIX_ENV=dev)"
  (cd "$ROOT/apps/server" && export MIX_ENV=dev &&
    mix local.hex --if-missing --force >/dev/null && mix local.rebar --if-missing --force >/dev/null &&
    mix deps.get >/dev/null && mix compile >"$OUT/compile.log" 2>&1) || {
    tail -40 "$OUT/compile.log" >&2; exit 1; }
fi

# ----- web build ----------------------------------------------------------------
say "building the SPA (vite, development mode) into apps/server/priv/static"
(cd "$ROOT/apps/web" && pnpm exec vite build --mode development --outDir "$RUN/spa" --emptyOutDir \
  >"$OUT/build.log" 2>&1) || { tail -40 "$OUT/build.log" >&2; exit 1; }
rm -rf "$ROOT/apps/server/priv/static"
cp -r "$RUN/spa" "$ROOT/apps/server/priv/static"

# ----- database -----------------------------------------------------------------
if [ -n "${CYTALE_SCYLLA_NODES:-}" ]; then
  external_nodes="$CYTALE_SCYLLA_NODES"
  say "using ScyllaDB at $external_nodes (keyspace $KEYSPACE)"
else
  [ -x "$LEASE_SCRIPT" ] || { echo "e2e-live: set CYTALE_SCYLLA_NODES=host:port (no lease helper at $LEASE_SCRIPT)" >&2; exit 2; }
  eval "$("$LEASE_SCRIPT" acquire)"
  leased_id="$SCYLLA_LEASE_ID"
  say "leased ScyllaDB $leased_id at $CYTALE_SCYLLA_NODES"
fi

# ----- server -------------------------------------------------------------------
say "booting the dev server on :$SERVER_PORT (keyspace $KEYSPACE)"
(
  cd "$ROOT/apps/server"
  export MIX_ENV=dev PORT="$SERVER_PORT" CYTALE_DEV_KEYSPACE="$KEYSPACE" \
    CYTALE_SCYLLA_NODES CYTALE_DEV_MAILBOX="$RUN/dev_mailbox.jsonl" \
    SEARCH_INDEX_ROOT="$RUN/search" CYTALE_SERVER_CONFIG_PATH="$RUN/server-config.json" \
    CYTALE_APPLY_SCHEMA_ON_BOOT=1 CYTALE_DEV_LIFT_SEND_BUDGET=1
  if [ "${E2E_PASSKEYS:-0}" = "1" ]; then export CYTALE_EXTERNAL_BASE_URL="http://localhost:$SERVER_PORT"; fi
  exec setsid mix phx.server </dev/null >"$OUT/server.log" 2>&1
) &
server_pid=$!

deadline=$(($(date +%s) + BOOT_TIMEOUT))
until curl -fsS -o /dev/null "http://127.0.0.1:$SERVER_PORT/health" 2>/dev/null; do
  if ! kill -0 "$server_pid" 2>/dev/null; then
    say "the server exited during boot — last 60 lines of server.log:"; tail -60 "$OUT/server.log" >&2; exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    say "the server did not answer /health within ${BOOT_TIMEOUT}s — last 60 lines:"; tail -60 "$OUT/server.log" >&2; exit 1
  fi
  sleep 1
done
say "server up after $(($(date +%s) - started_at))s"

# ----- suite --------------------------------------------------------------------
say "running the live suite: ${*:-(all *.live.spec.ts)}"
# Its own process group, in the background: bash runs a trap only between
# commands, so a TERM/INT (a cancelled job, a Ctrl-C) must not wait for a
# foreground Playwright to finish first — `wait` returns at once, and the
# cleanup stops the whole group.
: >"$OUT/playwright.log"
(
  cd "$ROOT/apps/web"
  export CYTALE_E2E_LIVE=1 \
    CYTALE_E2E_BASE_URL="http://localhost:$SERVER_PORT" \
    CYTALE_E2E_API_ORIGIN="http://localhost:$SERVER_PORT" \
    CYTALE_DEV_MAILBOX="$RUN/dev_mailbox.jsonl" \
    PLAYWRIGHT_HTML_OUTPUT_DIR="$OUT/report" PLAYWRIGHT_HTML_REPORT="$OUT/report" PLAYWRIGHT_HTML_OPEN=never \
    PLAYWRIGHT_JSON_OUTPUT_FILE="$OUT/results.json" PLAYWRIGHT_JSON_OUTPUT_NAME="$OUT/results.json"
  exec setsid pnpm exec playwright test --reporter=list,html,json --output "$OUT/test-results" \
    --retries="${E2E_RETRIES:-0}" "$@" </dev/null >"$OUT/playwright.log" 2>&1
) &
suite_pid=$!
tail -n +1 -f "$OUT/playwright.log" --pid="$suite_pid" 2>/dev/null &
set +e
wait "$suite_pid"
suite_rc=$?
set -e
suite_pid=""
sleep 1 # let tail drain the last lines

# ----- summary ------------------------------------------------------------------
node - "$OUT/results.json" <<'NODE' | tee "$OUT/summary.txt"
const fs = require('fs');
const file = process.argv[2];
if (!fs.existsSync(file)) { console.log('no results.json — the suite did not run'); process.exit(0); }
const r = JSON.parse(fs.readFileSync(file, 'utf8'));
const per = new Map();
const walk = (s) => {
  for (const spec of s.specs ?? []) {
    for (const t of spec.tests ?? []) {
      const key = spec.file + (t.projectName ? ` [${t.projectName}]` : '');
      const row = per.get(key) ?? { passed: 0, failed: 0, flaky: 0, skipped: 0 };
      const st = t.status; // expected | unexpected | flaky | skipped
      if (st === 'expected') row.passed++;
      else if (st === 'unexpected') row.failed++;
      else if (st === 'flaky') row.flaky++;
      else row.skipped++;
      per.set(key, row);
    }
  }
  for (const c of s.suites ?? []) walk(c);
};
for (const s of r.suites ?? []) walk(s);
const tot = { passed: 0, failed: 0, flaky: 0, skipped: 0 };
console.log('\n=== live e2e summary ===');
for (const [k, v] of [...per].sort()) {
  for (const f of Object.keys(tot)) tot[f] += v[f];
  const mark = v.failed ? 'FAIL' : v.flaky ? 'FLAKY' : 'ok';
  console.log(`${mark.padEnd(5)} ${k.padEnd(58)} passed ${v.passed}  failed ${v.failed}  flaky ${v.flaky}  skipped ${v.skipped}`);
}
const secs = Math.round((r.stats?.duration ?? 0) / 1000);
console.log(`TOTAL passed ${tot.passed}  failed ${tot.failed}  flaky ${tot.flaky}  skipped ${tot.skipped}  (suite ${secs}s)`);
NODE
say "artifacts: $OUT (report/index.html, test-results/, server.log)"
exit "$suite_rc"
