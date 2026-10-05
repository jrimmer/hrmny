/**
 * Playwright (chromium-only) — E2E for surfaces that need a REAL browser.
 *
 * Two suites share this config, split by FILE NAME:
 *
 *   * fixture-backed specs (`e2e/*.spec.ts`) mock the server per route
 *     (e2e/ux-world.ts and friends) and need only a vite dev server. They are
 *     the default: `pnpm exec playwright test` runs these and nothing else.
 *   * live-server specs (`e2e/*.live.spec.ts`) register real users against a
 *     real server, verify them through the Dev mailbox and drive the gateway.
 *     They run ONLY when CYTALE_E2E_LIVE=1, which scripts/e2e-live.sh sets
 *     after booting a throwaway stack (leased ScyllaDB + a dev server that
 *     also serves the built SPA).
 *     They are on demand by owner decision — never on push, never on a timer.
 *
 * A new spec that registers a user or calls the API for real MUST be named
 * `*.live.spec.ts`, or it will fail every fixture-backed run.
 *
 * Live projects (plan 003): `live` keeps the desktop viewport; `live-mobile`
 * runs ONLY mobile.live.spec.ts on an iPhone-class device descriptor
 * (390×844, touch, mobile UA) — per-project file gating because Playwright
 * otherwise runs every spec on every project.
 *
 * Neither suite starts servers (no webServer): baseURL defaults to the dev
 * stack's vite on :5173, and CYTALE_E2E_BASE_URL relocates it (the live
 * script points it at its server, which serves the SPA itself).
 */
import { defineConfig, type PlaywrightTestConfig } from '@playwright/test';

const LIVE = process.env.CYTALE_E2E_LIVE === '1';
const LIVE_SPEC = /\.live\.spec\.ts$/;
const MOBILE_SPEC = /mobile\.live\.spec\.ts$/;

const fixtureProjects: PlaywrightTestConfig['projects'] = [
  {
    name: 'desktop',
    testIgnore: LIVE_SPEC,
  },
];

const liveProjects: PlaywrightTestConfig['projects'] = [
  {
    name: 'live',
    testMatch: LIVE_SPEC,
    testIgnore: MOBILE_SPEC,
  },
  {
    name: 'live-mobile',
    testMatch: MOBILE_SPEC,
    // Explicit chromium context (iPhone descriptors default to webkit,
    // which this chromium-only repo doesn't install): iPhone-class
    // geometry + touch semantics on the installed engine. The fake media
    // device + granted mic let voice e2e hold a real audio leg (U2).
    use: {
      browserName: 'chromium',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
      permissions: ['microphone'],
      launchOptions: {
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
      },
    },
  },
];

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  // Live specs share one server and one client IP (the per-IP auth/API
  // buckets are production-shaped in the dev env), so the live suite runs
  // serially unless the caller asks for more workers.
  ...(LIVE ? { workers: 1 } : {}),
  use: {
    baseURL: process.env.CYTALE_E2E_BASE_URL ?? 'http://localhost:5173',
    headless: true,
    ...(LIVE ? { trace: 'retain-on-failure' as const, screenshot: 'only-on-failure' as const } : {}),
  },
  expect: { timeout: 10_000 },
  projects: LIVE ? liveProjects : fixtureProjects,
});
