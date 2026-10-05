/**
 * E2E helpers: fresh verified user through the REAL UI (register → dev
 * mailbox verify → login), then API-level setup for surfaces with no UI yet
 * (workspace/channel creation) before the interaction under test runs.
 */
import { readFileSync } from 'node:fs';
import type { APIRequestContext, Page } from '@playwright/test';

/**
 * Where the live stack answers. The defaults are the developer's dev stack
 * (vite :5173 proxying the server on :4000, mailbox in apps/server/tmp);
 * scripts/e2e-live.sh points all of them at its throwaway stack instead
 * (one server origin serving both the SPA and the API).
 */
export const API_ORIGIN = process.env.CYTALE_E2E_API_ORIGIN ?? 'http://localhost:4000';
export const API = `${API_ORIGIN}/api/v1`;
export const WEB_ORIGIN = process.env.CYTALE_E2E_BASE_URL ?? 'http://localhost:5173';
/** The Dev mailer's token sink (the server's own CYTALE_DEV_MAILBOX knob). */
export const MAILBOX = process.env.CYTALE_DEV_MAILBOX ?? '../../apps/server/tmp/dev_mailbox.jsonl';

/**
 * The desktop-size captures at deviceScaleFactor 4 (1440x900 → a 5760x3600
 * page) are pixel rigs for a human review; their assertions are the 1x run's.
 * On a 2-core / 4 GB runner they intermittently take the renderer down
 * ("Target crashed", "Unable to capture screenshot" — live-suite VM,
 * 2026-09-29), so the live suite runs them only when asked:
 * CYTALE_E2E_CAPTURE_4X=1 (on a bigger host).
 */
export const CAPTURE_4X = process.env.CYTALE_E2E_CAPTURE_4X === '1';
export const CAPTURE_4X_SKIPPED =
  'desktop 4x capture rig: set CYTALE_E2E_CAPTURE_4X=1 (needs more memory than a 4 GB runner)';

export async function registerVerifiedUser(page: Page, label: string): Promise<string> {
  const username = `e2e_${label}_${Date.now().toString(36)}`;

  await page.goto('/#/register');
  await page.getByRole('textbox', { name: 'Username' }).fill(username);
  await page.getByRole('textbox', { name: 'Email' }).fill(`${username}@e2e.local`);
  await page.getByRole('textbox', { name: 'Password', exact: true }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL(/#\/(verify-email|$)/, { timeout: 10_000 });

  // Complete verification via the dev mailbox (the registered user is
  // already signed in but view-only until verified).
  const mail = readFileSync(MAILBOX, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((m) => m.to === `${username}@e2e.local` && m.kind === 'verify_email')
    .at(-1);
  if (!mail) throw new Error(`no verify token for ${username}`);
  const res = await page.request.post(`${API}/auth/verify-email`, { data: { token: mail.token } });
  if (!res.ok()) throw new Error(`verify failed: ${res.status()}`);

  // Fresh verified claims via UI login (registration left a signed-in
  // view-only session — clear it so the login form renders).
  // Hash-only goto is same-document: clear storage AND hard-reload so the
  // in-memory authenticated SPA state is gone.
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto('/#/'); // reload kept #/verify-email; route to login
  await page.getByRole('textbox', { name: 'Username or email' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // Viewport-agnostic shell wait: the shell root renders in BOTH responsive
  // branches (at mobile the sidebar lives inside the drawer, so the old
  // channel-sidebar wait would hang — the audit's first mobile e2e trap).
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
  return username;
}

/** Bearer token from the signed-in page's storage (set at login). */
export async function accessToken(page: Page): Promise<string> {
  return (await page.evaluate(() => localStorage.getItem('cytale.access_token'))) as string;
}

/** API setup for surfaces without creation UI: workspace + channel. */
export async function seedWorkspaceWithChannel(
  request: APIRequestContext,
  token: string,
  name: string,
): Promise<{ wsId: string; chId: string }> {
  const ws = await request.post(`${API}/workspaces`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name },
  });
  const wsId = (await ws.json()).workspace.id;
  const ch = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'e2e' },
  });
  const chId = (await ch.json()).channel.id;
  return { wsId, chId };
}

/**
 * Reload, then make sure the shell shows the member's FIRST workspace and
 * its default channel — the landing a spec that just seeded a workspace over
 * the API wants. Since lane D #3 a reload restores the member's LAST location
 * (Home, for an account that has only ever been on Home), so when the reload
 * lands anywhere without a composer, walk in: the rail's first workspace on
 * desktop, the drawer's on the phone branch. Selecting a workspace opens its
 * first channel.
 */
export async function reloadIntoFirstWorkspace(page: Page): Promise<void> {
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
  const composer = page.getByTestId('composer-input');
  if (await composer.isVisible().catch(() => false)) return;
  const openNav = page.getByRole('button', { name: 'Open navigation' });
  const scope = (await openNav.isVisible().catch(() => false))
    ? (await openNav.click(), page.getByRole('dialog', { name: 'Channels' }))
    : page;
  await scope
    .getByRole('list', { name: 'Workspaces' })
    .getByRole('button')
    .first()
    .click({ timeout: 20_000 });
  await composer.waitFor({ state: 'visible', timeout: 20_000 });
}

/**
 * Open a channel that was seeded through the API AFTER this page's session
 * booted. Two things make a bare `page.goto('#/workspace/…/channel/…')` a
 * no-op: that address is not a route (only message permalinks are acted on),
 * and the shell boots to the member's LAST location (lane D #3) — Home, for
 * an account that has only ever been on Home. So: reload to re-run the boot
 * hydrate (the new workspace joins the rail), then walk the UI — the rail's
 * workspace button, then the channel row.
 */
export async function openSeededChannel(page: Page, wsName: string, chId: string): Promise<void> {
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
  const row = page.getByTestId(`channel-${chId}`);
  if (!(await row.isVisible().catch(() => false))) {
    // The rail button's name carries unread/mention counts after the name
    // ("ws, 2 unread"), so match the prefix.
    const escaped = wsName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    await page
      .getByRole('button', { name: new RegExp(`^${escaped}(,|$)`) })
      .first()
      .click({ timeout: 20_000 });
  }
  await row.click({ timeout: 20_000 });
  await page.getByTestId('composer-input').waitFor({ state: 'visible', timeout: 20_000 });
}

/** Seed one message in a channel (rows are asserted against the API/DOM). */
export async function seedMessage(
  request: APIRequestContext,
  token: string,
  chId: string,
  content: string,
): Promise<void> {
  const res = await request.post(`${API}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
    data: { content },
  });
  if (!res.ok()) throw new Error(`seedMessage failed: ${res.status()}`);
}

/**
 * Re-login as an existing username (the fresh-login pickup used by mobile
 * specs after a reload wipes the SPA's in-memory session state).
 */
export async function freshLogin(page: Page, username: string): Promise<void> {
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
}

// ---------------------------------------------------------------------------
// Settings-surface e2e (second consumer): API base rides the page's origin
// (WEB_ORIGIN: the vite proxy, or the server serving the SPA) so requests
// share the browser's origin cookies, plus UI login.
// ---------------------------------------------------------------------------

export interface E2EUser {
  username: string;
  email: string;
  password: string;
}

export function makeE2EUser(): E2EUser {
  const n = Math.floor(Math.random() * 1e9);
  return {
    username: `e2e_${n}`,
    email: `e2e_${n}@e2e.local`,
    password: 'e2e-password-1',
  };
}

const PROXY_API = `${WEB_ORIGIN}/api/v1`;

export async function apiRegister(user: E2EUser): Promise<void> {
  const res = await fetch(`${PROXY_API}/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(user),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${await res.text()}`);
}

/** Verify a fresh registration via the Dev-mailer mailbox file. */
export async function verifyViaMailbox(user: E2EUser): Promise<void> {
  const lines = readFileSync(MAILBOX, 'utf8').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as { to?: string; token?: string };
      if (entry.to === user.email && entry.token) {
        const res = await fetch(`${PROXY_API}/auth/verify-email`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: entry.token }),
        });
        if (res.status !== 200) throw new Error(`verify failed: ${res.status}`);
        return;
      }
    } catch {
      // malformed tail line — keep scanning
    }
  }
  throw new Error(`no verification token found for ${user.email}`);
}

/** Real login through the UI form (identifier + password). */
export async function uiLogin(page: Page, user: E2EUser): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(user.username);
  await page.getByRole('textbox', { name: 'Password' }).fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  // Same viewport-agnostic wait as registerVerifiedUser (see note there).
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
}
