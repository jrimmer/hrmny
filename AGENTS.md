# AGENTS.md: working in the Hrmny repository

This file guides coding agents (and people) working in this repository. Read
it with [CONTRIBUTING.md](CONTRIBUTING.md), which has the full contributor
workflow.

Hrmny is the product name. Internal identifiers still use the former codename,
`cytale` (`@cytale/*` packages, `CYTALE_*` environment variables, the
`:cytale` Elixir app, the `cytale` keyspace, the `cytale://` scheme). Keep
using them in code until the planned rename lands.

## Repository map

| Path | What it is |
|---|---|
| `apps/server` | Phoenix backend (REST `/api/v1`, WebSocket gateway, Discord-compatible `/api/v10`, calls), ScyllaDB via Xandra, Tantivy search via the muninn NIF |
| `apps/web` | React SPA + PWA (Vite, Tailwind v4, Radix, Lexical, react-virtuoso) |
| `apps/desktop` | Tauri 2 shell hosting the built web app |
| `apps/mobile` | React Native / Expo app |
| `apps/tui` | Terminal client (Ink) |
| `apps/ssh-host` | Go SSH host that runs the terminal client per session |
| `packages/protocol` | The wire protocol: types + encode/decode. Single source of truth |
| `packages/*` | Shared client code: `api-client`, `gateway-client`, `state`, `domain`, `session`, `calls`, `markdown`, `emoji` |
| `tools/` | `protocol-check`, Discord-compat checks, smoke, soak, load harness |
| `deploy/`, `compose.yaml`, `Dockerfile*` | Self-hosting kit ([docs/self-hosting.md](docs/self-hosting.md)) |
| `docs/protocol/`, `docs/architecture/` | Wire reference and architecture notes |

## Stack pins (do not change without an agreed issue)

- Elixir ~> 1.18 / OTP 27 · Rust ~> 1.92 · Node 22 + pnpm (version in
  `package.json` `packageManager`) · Go per `apps/ssh-host/go.mod`.
- Phoenix is **backend only**: no LiveView, no HEEx.
- The web client is a React SPA in `apps/web`: Tailwind v4 with an `@theme`
  bridge over the semantic tokens in `apps/web/src/app/theme/`; Radix
  primitives skinned only by those tokens; a Lexical + `@lexical/markdown`
  composer (Enter sends, Shift+Enter inserts a newline); react-virtuoso for
  scrollback; vite-plugin-pwa with `generateSW`.
- Tauri 2 for the desktop shell.
- Every client, and the load harness, imports wire encode/decode from
  `packages/protocol`. Never hand-roll a parallel mock of the protocol.

## Running the suites

```bash
pnpm install
pnpm typecheck                              # all TypeScript
pnpm --filter @cytale/web test              # Vitest
pnpm --filter @cytale/mobile test           # Jest
pnpm --filter @cytale/tui test              # Vitest
pnpm --filter "./packages/*" test           # shared packages
pnpm protocol:check                         # protocol docs vs server vs clients

cd apps/server && mix test                  # full run, needs ScyllaDB
cd apps/server && CYTALE_TEST_NO_DB=1 mix test   # database-free PARTIAL run
cd apps/server && mix format --check-formatted
cd apps/ssh-host && go test ./...
```

Run the suite for each unit of work before committing, and the wider suites
before opening a pull request.

### Server tests without a database

When no ScyllaDB answers on the configured contact point, or with
`CYTALE_TEST_NO_DB=1`, `mix test` excludes every `:scylla`-tagged test and
prints a PARTIAL-run banner. **A green partial run is never a full run**; say
which one you ran. `ScyllaCase` and `GatewayCase` tag their modules
automatically; any other module that reaches the database must carry
`@moduletag :scylla` (or `@tag :scylla` per test).

### Parallel runs

If more than one suite may run against the same node at once (several agents,
or you and an agent), namespace every run:

```bash
CYTALE_TEST_KEYSPACE=<unique-name> CYTALE_TEST_PORT=<unique-port> mix test
```

The default `cytale_test` keyspace is reset at boot and truncated per suite,
so two runs sharing it break each other with scattered, unrelated-looking
failures. The suite refuses to run against `cytale`. Test SQL must
interpolate `Cytale.Repo.keyspace()`; never hardcode a keyspace name.
Namespaced keyspaces are dropped when the suite exits (also on Ctrl-C), but
not after a hard kill.

## A development ScyllaDB

Run it in Docker exactly like this:

```bash
docker run -d --name cytale-scylla --restart unless-stopped --memory 3g \
  -p 127.0.0.1:9042:9042 -v cytale_scylla_dev:/var/lib/scylla \
  scylladb/scylla:2026.2.6 \
  --developer-mode=1 --smp=2 --memory=1200M --overprovisioned=1 \
  --tablets-mode-for-new-keyspaces=disabled
```

`--tablets-mode-for-new-keyspaces=disabled` is required (the schema uses
SimpleStrategy, which tablet mode rejects). The container needs about 1.5 GB
of headroom above seastar's `--memory`, because page cache counts against the
container limit.

Hygiene that keeps it fast:

- **Boot cost scales with the total TABLE count across all keyspaces**, not
  with data. Leftover test keyspaces make boots slow and can eventually stop
  the node booting at all. Development boots warn when there are more than 15
  keyspaces.
- **Clean up with `scripts/scylla-reset.sh`**: with no flags it is a dry run
  that lists what would go; `--apply` drops it; `--keep a,b` protects extra
  names. It keeps `system*` and the dev keyspace `cytale`. Before applying,
  check for a live run (`pgrep -f "mix test"`) and `--keep` its keyspace.
- **Drop through CQL, never by deleting keyspace directories** on disk.
- **A `DROP KEYSPACE` is not durable until flushed.** The reset script
  flushes; if you drop by hand, run `nodetool flush` afterwards.
- **Stop the node gently**: `docker stop -t 120 cytale-scylla`, so it can
  drain. Never clear the commitlog to speed up boot; it holds recent schema
  changes.
- Restarting the node kills in-flight suites; pick a gap between runs.

## Commits

- **Conventional commits**: `type(scope): summary`, for example
  `fix(web): …`, `feat(server): …`.
- **User-visible changes carry a `Release-note:` trailer**: one paragraph for
  the people using the app. `Release-note: none` hides the commit;
  `Release-note-audience: admin` files it for admins. The notes are generated
  by `scripts/release-notes.mjs`.
- **Sign off** every commit (`git commit -s`, DCO).
- **Stage explicit file paths.** Never `git add -A` or add a whole
  directory: another session's work, editor state or agent directories may
  share the tree.
- Commit one completed, tested unit of work at a time.

## Definition of done for UI work

- WCAG 2.1 AA: axe checks pass (`vitest-axe`) and the component is fully
  keyboard-operable with visible focus.
- States first: design and test **loading, empty, error, offline, view-only
  and permission-denied** as they apply, not only the happy path.
- Style only through the design tokens.

## Things never to commit

- Screenshots or other material from third-party products, even as design
  references.
- Secrets, `.env` files, SSH CA or host keys, signing keys.
- Real hostnames, IP addresses or people's usernames in fixtures and docs:
  use `chat.example.com`, RFC 5737 addresses (`192.0.2.x`, `203.0.113.x`),
  and `alice` / `bob`.
