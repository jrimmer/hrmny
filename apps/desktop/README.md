# Cytale Desktop (Tauri 2.x)

The desktop shell for Cytale. It hosts the **same web build** as the PWA in
the OS webview (WebView2 on Windows, WKWebView on macOS, WebKitGTK on Linux),
so the desktop app and the phone PWA share account, gateway, unread/presence
state, and message history through the same shared TypeScript core (AE6).

The shell is deliberately thin: window management, native notifications,
`cytale://` deep links, window-state persistence, and the auto-updater. All
UI and state live in `apps/web`.

## Prerequisites

- **Rust toolchain** (stable ≥ 1.77) — `rustup` or a distro package.
- **Tauri system deps** for your OS (WebKitGTK on Linux, etc.) — see the
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).
- **pnpm** (workspace root installs `@tauri-apps/cli`).

## Run (dev)

```bash
pnpm install
pnpm --filter @cytale/desktop dev
```

`tauri dev` starts the web dev server (`pnpm --filter @cytale/web dev`,
`beforeDevCommand`) and opens a native window pointed at it
(`devUrl: http://localhost:5173`).

## Build

```bash
pnpm --filter @cytale/desktop build
```

`tauri build` runs `pnpm --filter @cytale/web build` first
(`beforeBuildCommand`), then bundles the `apps/web/dist` output
(`frontendDist`) into the platform installer.

**Server origin.** The shell serves the SPA from `tauri://localhost`, so
`location.origin` is not the server and the API/gateway/asset URLs cannot be
derived from it. A packaged build takes its server from build-time settings
(`apps/web/src/app/origin.ts`):

- `VITE_CYTALE_ORIGIN` bakes the one server the shell talks to;
- `VITE_CYTALE_HOSTED_ORIGIN` names a hosted deployment the shell falls back
  to, and the login form suggests (without either, the login form asks the
  user for a server).

`tauri dev` is excluded from the fallback — it keeps talking to the local
server through the Vite proxy. The web/PWA build is unaffected (same-origin).

**CSP and updates.** `src-tauri/tauri.conf.json` names no server and no update
feed. `pnpm --filter @cytale/desktop build` runs `scripts/release-config.mjs`
first, which turns the environment into a `tauri build --config` merge:

```bash
VITE_CYTALE_ORIGIN=https://chat.example.com pnpm --filter @cytale/desktop build
```

adds `https://chat.example.com` (and `wss://`) to the CSP's `connect-src`
and `img-src`. `DESKTOP_SERVER_ORIGINS` lists the origins explicitly;
`DESKTOP_UPDATER_ENDPOINTS` (plus `DESKTOP_UPDATER_PUBKEY` and
`TAURI_SIGNING_PRIVATE_KEY` at build time) turns on signed auto-updates from
your own feed. Without them the shell never polls for updates.

macOS/Windows artifacts need build machines on those OSes.

## Deep links

The shell registers the `cytale://` scheme and emits a `cytale-deep-link`
window event with the raw URL; the web side parses it
(`apps/web/src/tauri/deepLink.ts`) and — since #114/#50 — subscribes at boot
(`apps/web/src/main.tsx`): every message link is rewritten into the hash
route, so a link that arrives before sign-in lands on the message after it.

Both delivery paths are proven at the OS level by the harness (see below):
a cold start via `open -a <bundle> <url>` (LaunchServices launches the app
WITH the link; the shell retains it as the pending URL and the web side
takes it at boot) and a running instance via the same `open -a` against the
live process (LS hands the URL to the running app; the shell re-emits and
the listener navigates). On macOS the deep-link plugin consumes ONLY
LaunchServices openURLs events — argv-as-deep-link is a Windows/Linux
feature — so the harness proves exactly the path production uses.

The one step no harness can own: which app the OS picks for a BARE
`open cytale://…` (no `-a`). That is LaunchServices' default-handler
resolution, a property of the user's machine — the installed app and the
e2e build (different bundle ids) both claim the scheme, and macOS resolves
by its own registration heuristics.

## E2E (in-shell)

macOS has no WebDriver for WKWebView (tauri-driver is Windows/Linux only), so
the shell drives itself: an **e2e build** bundles a driver
(`apps/web/src/e2e/driver.ts`) that logs in, opens a channel, sends a message, asserts the
row, and opens the Members directory. `tools/desktop-e2e.mts` seeds a verified
account + workspace + channel through the API, serves the driver its inputs
over a loopback control channel, and asserts the report.

```bash
# 1. a server from current main, with the CORS allowlist (default) — a
#    dedicated instance keeps dev servers untouched:
cd apps/server
PORT=4102 SEARCH_INDEX_ROOT=/tmp/cytale-e2e-search \
  SECRET_KEY_BASE=… AUTH_JWT_SECRET=… AUTH_REFRESH_PEPPER=… \
  CYTALE_SCYLLA_NODES=127.0.0.1:9042 mix phx.server

# 2. an e2e build pointed at it, using the committed e2e override
#    (apps/desktop/e2e/tauri.e2e.conf.json). That override is REQUIRED for two
#    reasons: the driver clears localStorage at startup (so every run starts
#    from a clean session) and must not share the real app's webview data
#    store, and its control channel on 127.0.0.1:4199 needs a CSP the shipped
#    build deliberately does not allow.
cd apps/desktop
VITE_CYTALE_ORIGIN=http://127.0.0.1:4102 pnpm exec tauri build --debug --bundles app \
  -c e2e/tauri.e2e.conf.json

# 3. run it (from the repo root):
pnpm e2e:desktop
```

The run has two phases. Phase 1 drives login → send → transcript. Phase 2
proves the deep links (#50): the runner seeds two messages, launches the
bundle WITH `cytale://…/message/{id}` (cold start), asserts the hash names
the message BEFORE login and the row is on screen after, then delivers a
second link to the RUNNING instance and asserts the live handoff lands.
`E2E_SKIP_DEEPLINK=1` skips phase 2; on non-macOS it is skipped
automatically (the delivery is LaunchServices). The keychain is namespaced
per bundle identifier, so the e2e build's session reset can never touch the
installed app's stored session.

Two honest limits. Synthetic `Enter` does not reach Lexical's send command in
WKWebView, so the driver falls back to the composer's own send path
(`E2EBridgePlugin`, same `onSend`) — the report tags that step
`send-via-bridge`. And the driver covers the shell-specific path (custom
scheme, CORS, gateway, asset/API origins); the interaction mechanics stay
covered by the Playwright suite in `apps/web/e2e/`.

## State parity (AE6)

Because the desktop app hosts the identical web bundle, there is no separate
desktop state model — the same gateway client, API client, and state store
run in both. Native notifications and window-state are the only desktop-only
surfaces, and both are thin plugin wrappers.

## Known gaps (packaged builds)

- **Deep links**: wired and proven — the harness's phase 2 asserts both
  delivery paths (cold start, running instance) at the OS level on macOS.
  Remaining OS-dependency: a bare `open cytale://…` resolves through
  LaunchServices' default-handler choice, which belongs to the user's
  machine, not the app (see "Deep links" above).
- **Auto-update**: infrastructure shipped and PROVEN locally — the updater
  selftest run (0.0.1-test detects → downloads → signature-verifies →
  installs → relaunch reports 0.0.2-test) is documented in
  `docs/desktop-updates.md` with the transcript. What remains is product
  work, not proof: the web-side check/download/install UX (no caller of the
  updater API yet; `dialog: false`, so nothing prompts on its own).
- **Icons**: only `icons/icon.png` (512px) ships. This does NOT block a macOS
  bundle — the bundler synthesizes `Cytale.icns` from the PNGs listed in
  `bundle.icon` (verified: the generated `.icns` carries a single 512px
  layer, `ic09`). The cost is fidelity: Retina macOS upscales that layer, and
  Windows needs an `.ico` for the exe/installer icon. Once the brand mark is
  settled, `pnpm exec tauri icon <1024px source>` emits the full set in one
  command. Today's PNG is a flat indigo tile, not a mark.
- **Signing/notarization**: not configured (needs an Apple Developer account
  for macOS distribution).

