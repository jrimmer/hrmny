import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, loadEnv } from 'vite';
import type { ViteUserConfig as VitestUserConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Short commit hash of the build running in this browser — rendered by the
 * rail's version badge (src/app/version.ts).
 *
 * Resolution order, and the reason for each step:
 *   1. an explicit CYTALE_VERSION (a container build passes it: .git is out of
 *      the Docker context and the node image ships no git, which is how a
 *      deploy ends up reading "vdev");
 *   2. the CI job env (release.yml exports the commit as SHA);
 *   3. `git rev-parse` for a normal checkout;
 *   4. `.git` read directly — a checkout that has the repo but no git binary;
 *   5. 'dev', the honest "this build cannot name itself".
 */
function buildVersion(): string {
  const fromEnv = process.env.CYTALE_VERSION ?? process.env.SHA ?? process.env.GITHUB_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return versionFromGitDir() ?? 'dev';
  }
}

/**
 * Resolve HEAD by reading `.git` directly (no git binary). Handles both a
 * loose ref (`.git/refs/heads/<branch>`) and the packed form
 * (`.git/packed-refs`), plus a detached HEAD holding the hash on the first
 * line. Returns null when nothing usable is found.
 */
function versionFromGitDir(): string | null {
  try {
    const repoRoot = dirname(fileURLToPath(import.meta.url)); // apps/web
    const gitDir = join(repoRoot, '..', '..', '.git');
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();

    const short = (hash: string) => hash.slice(0, 7);
    if (!head.startsWith('ref:')) return short(head); // detached HEAD

    const ref = head.slice(4).trim();
    try {
      return short(readFileSync(join(gitDir, ref), 'utf8').trim());
    } catch {
      // Packed refs: "<hash> refs/heads/<branch>" — the ref file is absent
      // once git has packed the ref.
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8');
      for (const line of packed.split('\n')) {
        const [hash, name] = line.trim().split(' ');
        if (name === ref && hash) return short(hash);
      }
      return null;
    }
  } catch {
    return null;
  }
}

// PWA layer (U25) — pinned stack decision (2026-08-27): vite-plugin-pwa in
// generateSW mode — registerType 'prompt' since lane D #6 (an update waits
// for consent; no hand-written sw.js anywhere). Cache strategies (resolved
// before implementation):
//   * /api/v1/* and the gateway URL — NETWORK-FIRST. Live data is never
//     served stale from cache; the offline shell shows cached STATE, not
//     stale fetches.
//   * hashed static assets — cache-first via generateSW precache (default).
//   * navigations/app shell — stale-while-revalidate so repeat loads are
//     instant while still refreshing the shell in the background.
// The directory holding this config (Vite emits its bundled copy beside it),
// used as `envDir` so the define below and Vite's own import.meta.env
// replacement read the SAME .env files no matter where the build is invoked.
const configDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig(({ mode }) => {
  // Same lookup Vite performs for import.meta.env (prefix '' = every key).
  const env = loadEnv(mode, configDir, '');

  // #137, version-reporting acceptance: a client-error report carries this
  // version, and a report reading 'dev' cannot be resolved to the build that
  // produced it (the incident: reports at 5304c1f while the deployed image
  // was b53ba3f left the crashing build unidentifiable). A PRODUCTION build
  // must therefore name its commit — refuse to emit one that cannot. Dev
  // servers, tests, and deliberate local experiments keep the honest 'dev'
  // fallback (opt back in with CYTALE_ALLOW_UNVERSIONED=1).
  const version = buildVersion();
  if (
    mode === 'production' &&
    version === 'dev' &&
    process.env.CYTALE_ALLOW_UNVERSIONED !== '1'
  ) {
    throw new Error(
      '[cytale] this production build cannot name its commit ' +
        '(no CYTALE_VERSION/SHA env, no git, no readable .git), so every ' +
        'client-error report from it would be unattributable. ' +
        'Pass the commit as CYTALE_VERSION or SHA (see buildVersion above; ' +
        'the release workflow exports SHA) — or set CYTALE_ALLOW_UNVERSIONED=1 ' +
        'to ship an unversioned build deliberately.',
    );
  }

  return {
  envDir: configDir,
  define: {
    // Build identity (see buildVersion above); src/app/version.ts reads it and
    // degrades to 'dev' if a tool runs the module without this define applied.
    __CYTALE_VERSION__: JSON.stringify(version),
    // Dev-build gate for debug handles (session.ts's console/automation
    // store surface). `typeof` at the use site keeps non-Vite tools (the
    // mobile parity suite) calm with the gate off.
    // A literal boolean per mode — NEVER the text 'import.meta.env.DEV':
    // define's output is spliced in AFTER esbuild's env replacement, so that
    // text shipped verbatim in production bundles where import.meta.env is
    // undefined, throwing at module init and killing the whole app at boot
    // (live incident 2026-09-19). True for dev AND e2e builds — the e2e
    // driver and the composer bridge read the store handle it gates.
    __CYTALE_DEV__: mode === 'production' ? 'false' : 'true',
    /**
     * Single source of truth for the e2e-only surfaces — the in-shell driver
     * (src/e2e/driver.ts) and the composer bridge (MessageCompose's
     * E2EBridgePlugin). Read the value, never re-export it: a `define` lands
     * as a literal at every use site, so Rollup folds the guard and drops the
     * driver's dynamic import (a re-exported const does NOT fold — verified
     * against a production build, which kept the chunk).
     *
     * BOTH conditions are required. `mode === 'e2e'` comes only from
     * `vite build --mode e2e` (apps/desktop/e2e/tauri.e2e.conf.json) and
     * .env.e2e supplies VITE_CYTALE_E2E; without the mode check an ordinary
     * build that merely inherited the env var would ship a control channel.
     * CI (.github/workflows/ci.yml) asserts the release bundle is clean.
     */
    __CYTALE_E2E__: JSON.stringify(
      mode === 'e2e' && env.VITE_CYTALE_E2E === '1',
    ),
  },
  // Dev proxy: the vite dev server on :5173 forwards API + gateway to the
  // Elixir server on :4000 — no CORS, no build, no SW, hot reload on save.
  server: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/gateway': { target: 'http://127.0.0.1:4000', ws: true },
      '/health': { target: 'http://127.0.0.1:4000' },
      '/manifest.json': { target: 'http://127.0.0.1:4000' },
      '/icons': { target: 'http://127.0.0.1:4000' },
    },
  },
  // #21 bundle split: vendor groups keep the long-lived libs in their own
  // cacheable chunks; the authenticated shell loads behind the entry's lazy
  // boundary (src/AuthenticatedApp.tsx).
  build: {
    rollupOptions: {
      output: {
        manualChunks(id: string) {
          if (id.includes('node_modules')) {
            if (id.includes('@lexical') || id.includes('/lexical/')) return 'lexical';
            if (id.includes('@radix-ui')) return 'radix';
            if (id.includes('react-virtuoso')) return 'virtuoso';
            if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('scheduler')) {
              return 'react';
            }
          }
          return undefined;
        },
      },
    },
  },
  // Prod-parity preview (`vite preview`): same proxy as dev so the built
  // bundle can be exercised against the real API (#21 verification).
  preview: {
    proxy: {
      '/api': { target: 'http://127.0.0.1:4000', changeOrigin: true },
      '/gateway': { target: 'http://127.0.0.1:4000', ws: true },
      '/health': { target: 'http://127.0.0.1:4000' },
    },
  },
  plugins: [
    tailwindcss(),
    VitePWA({
      strategies: 'generateSW',
      // Lane D #6: 'prompt' — a new worker WAITS for the member's consent
      // (the UpdateAvailable affordance) instead of reloading open tabs.
      registerType: 'prompt',
      injectRegister: false,
      manifest: false, // manifest.json lives in public/ (hand-maintained)
      workbox: {
        // Hashed assets up to 5MB precache (the JS bundle is ~600KB).
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: undefined,
        // The push display + click handlers. A generateSW worker carries no
        // build-time code, so the push half lives in public/push-handler.js
        // and is pulled in here — the supported way to extend a generated
        // worker. It must NOT be precached separately: importScripts fetches
        // it, and precaching it would put a second copy in the cache.
        importScripts: ['push-handler.js'],
        runtimeCaching: [
          // No /api/v1 entry on purpose (audit WEB-8): a NetworkFirst cache
          // here stored message/channel bodies in Cache Storage — readable by
          // any script that ever runs in the origin and by whoever opens the
          // machine. Offline rendering comes from the store's hydrated state,
          // not from cached responses, so there is nothing to buy back.
          {
            // Gateway endpoint: live-first (WebSocket upgrades bypass the
            // service worker entirely; any HTTP probes must not be cached).
            urlPattern: ({ url }) => url.pathname.includes('gateway/websocket'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'cytale-gateway',
              networkTimeoutSeconds: 5,
            },
          },
          {
            // App shell navigations: stale-while-revalidate.
            urlPattern: ({ request }) => request.mode === 'navigate',
            handler: 'StaleWhileRevalidate',
            options: {
              cacheName: 'cytale-app-shell',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    // axe scans are CPU-heavy; 5s flakes under parallel load (observed
    // pass/fail/pass on identical trees).
    testTimeout: 15_000,
    // e2e/ holds Playwright specs (their own runner); vitest's default
    // *.spec.ts include must not sweep them into JS collection.
    exclude: ['**/e2e/**', '**/node_modules/**'],
  },
};
});
