# Contributing to Hrmny

Thanks for helping. This guide covers setting up, running the suites, and what
a change needs before it can be merged. For a tour of the repository, start
with the [README](README.md). If you work with a coding agent, point it at
[AGENTS.md](AGENTS.md).

Internal identifiers still use the project's former codename, `cytale`
(`@cytale/*` packages, `CYTALE_*` environment variables, the `:cytale` Elixir
app, the `cytale` keyspace). Keep using them in code until the planned rename
lands.

## Before you start

- **Bugs and feature requests** go to the
  [issue tracker](https://github.com/jrimmer/hrmny/issues). For anything larger
  than a small fix, open an issue first so the approach can be agreed before
  you write it.
- **Security issues** must not be filed publicly. Follow
  [SECURITY.md](SECURITY.md).
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Setting up

You need:

- Elixir ~> 1.18 on Erlang/OTP 27;
- Rust ~> 1.92 (the search NIF and the desktop shell);
- Node.js 22+ and pnpm 11 (the exact version is `packageManager` in
  `package.json`; `corepack enable` provides it);
- Go at the version in `apps/ssh-host/go.mod`, if you touch the SSH host;
- Docker, for a development ScyllaDB.

Start ScyllaDB exactly like this (the flags matter: the schema uses
SimpleStrategy, which tablet mode rejects):

```bash
docker run -d --name cytale-scylla --restart unless-stopped --memory 3g \
  -p 127.0.0.1:9042:9042 -v cytale_scylla_dev:/var/lib/scylla \
  scylladb/scylla:2026.2.6 \
  --developer-mode=1 --smp=2 --memory=1200M --overprovisioned=1 \
  --tablets-mode-for-new-keyspaces=disabled
```

Then:

```bash
pnpm install
./scripts/dev.sh --server    # terminal 1: the server on :4000
./scripts/dev.sh             # terminal 2: the web app on :5173 with hot reload
```

The server applies and verifies the schema at boot, and in development it
writes verification and reset emails to a local mailbox file instead of
sending them.

You do not need a database for most server work: see
[the database-free run](#the-database-free-server-run) below.

## Running the suites

Run the suites that cover what you changed before you push. CI runs the same
checks on every pull request.

| What changed | Run |
|---|---|
| Any TypeScript | `pnpm typecheck` |
| `apps/web` | `pnpm --filter @cytale/web test` |
| `apps/mobile` | `pnpm --filter @cytale/mobile test` |
| `apps/tui` | `pnpm --filter @cytale/tui test` |
| `packages/*` | `pnpm --filter "./packages/*" test` |
| The wire protocol (`packages/protocol`, gateway or REST shapes, `docs/protocol`) | `pnpm protocol:check` |
| `apps/server` | `cd apps/server && mix test` and `mix format --check-formatted` |
| `apps/ssh-host` | `cd apps/ssh-host && go test ./...` |
| The Discord-compatible surface | `pnpm compat:check` (starts its own server; needs ScyllaDB) |

The web app's fixture-backed end-to-end specs need only a Vite dev server:
run `pnpm exec vite --port 5173` in `apps/web`, then
`pnpm exec playwright test` there.

### The database-free server run

When no ScyllaDB answers on the configured contact point, or when you set
`CYTALE_TEST_NO_DB=1`, `mix test` excludes every test tagged `:scylla` and
prints a **PARTIAL-run** banner:

```bash
cd apps/server && CYTALE_TEST_NO_DB=1 mix test
```

A green partial run is never a full run. CI runs this half on every pull
request; the database half needs a ScyllaDB node. `ScyllaCase` and
`GatewayCase` tag their modules automatically. A test module that reaches the
database without them must carry `@moduletag :scylla` (or `@tag :scylla` per
test), or it will fail the partial run.

### Running suites in parallel

Two server suites running at once against the same node must each use their
own keyspace and port, or they destroy each other's data mid-run:

```bash
CYTALE_TEST_KEYSPACE=mytest_1 CYTALE_TEST_PORT=4101 mix test
```

A namespaced keyspace is dropped when the suite exits, but a hard-killed run
cannot clean up. `scripts/scylla-reset.sh` lists leftover keyspaces (dry run
by default) and `--apply` drops them. Test SQL must interpolate
`Cytale.Repo.keyspace()`; never hardcode a keyspace name in a fixture.

## Accessibility is part of done

The UI targets **WCAG 2.1 AA**. A change to a user-facing component is not
done until:

- it passes **axe** checks (the web suite uses `vitest-axe`);
- it is fully usable from the **keyboard**: reachable, operable, visible
  focus, no traps;
- its **states** are designed and tested first, not only the happy path:
  **loading, empty, error, offline, view-only and permission-denied**,
  whichever apply.

Style components only through the design tokens (the semantic layer in
`apps/web/src/app/theme/`, exposed to Tailwind v4 by the `@theme` bridge in
`tokens.css`); Radix primitives are skinned by those tokens, never by
Tailwind's stock palette or one-off values.

Never commit screenshots or other material from third-party products.

## Commits

### Conventional commits

Every commit subject follows [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, for example `fix(web): a #channel pill opens the
channel it names`. Common types are `feat`, `fix`, `perf`, `refactor`,
`test`, `docs`, `ci`, `build` and `chore`; the scope is usually the app or
package (`server`, `web`, `mobile`, `tui`, `desktop`, `ssh-host`,
`protocol`, …). Write the summary as what is now true, in the present tense.

### Release notes: the `Release-note:` trailer

The in-app release notes (the version badge in the web app) are generated
from commit history by `scripts/release-notes.mjs`. `feat` commits are listed
as new features, `fix` as bug fixes, and `perf`/`style` as improvements;
other types only add to a maintenance count.

A commit that changes **user-visible behaviour** carries a `Release-note:`
trailer: one paragraph, written for the people using Hrmny, not for
developers. Wrap a long note onto indented continuation lines like any git
trailer.

```
fix(web): Home at desktop offers Call log and Threads again

<body explaining the change for reviewers>

Release-note: Home shows the Call log and Threads buttons again on wide
  screens, so your followed threads are reachable from Home.
Signed-off-by: Alice Example <alice@example.com>
```

- `Release-note: none` hides a user-facing-typed commit from the notes (it
  counts as maintenance).
- `Release-note-audience: admin` files the note under the collapsed
  "For admins" section.
- Without a trailer the whole commit message is shown, so write one.

`pnpm release-notes:missing` lists displayed commits that have no note.

### Sign-off (Developer Certificate of Origin)

Contributions are accepted under the project's
[BSD-3-Clause license](LICENSE) and the
[Developer Certificate of Origin 1.1](https://developercertificate.org/).
Certify it by signing off every commit:

```bash
git commit -s
```

which adds `Signed-off-by: Your Name <you@example.com>`, using your real name
or the name you are publicly known by. Pull requests with unsigned commits
cannot be merged; `git rebase --signoff main` fixes a branch after the fact.

### Staging

Stage explicit file paths (`git add path/to/file`), not whole directories or
`git add -A`, so stray local files (editor state, agent directories, build
output, screenshots) never land in a commit.

## Pull requests

1. Fork the repository and branch from `main`.
2. Keep each pull request to one logical change. Several small commits are
   fine when each builds and passes on its own.
3. Run the suites for what you touched, and say in the description which ones
   you ran (and whether the server run was full or partial).
4. For UI changes, include before/after screenshots **of Hrmny** and note how
   you covered accessibility (axe, keyboard, the states above).
5. For protocol changes, update `docs/protocol/` in the same pull request and
   run `pnpm protocol:check`; for self-hosting changes, update
   `docs/self-hosting.md` and `.env.example`.
6. CI must be green. A maintainer reviews, may ask for changes, and merges
   (usually a rebase or squash onto `main`, keeping the conventional subject
   and trailers).

## License

By contributing you agree that your contributions are licensed under the
[BSD-3-Clause license](LICENSE).
