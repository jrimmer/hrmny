/**
 * Release notes — the version badge is a link that replaces the CENTER column
 * with the notes (owner request 2026-09-27), and leaving them returns the
 * member to the conversation they were reading.
 *
 * Fixture-backed like pane-layout.spec.ts: no server, no database. Every
 * `/api/v1/*` call is served below and asserted complete, so a new boot-time
 * fetch surfaces as a fixture gap. `/release-notes.json` is NOT a boot-time
 * read — it is fetched only when the pane opens — and is served here as its
 * own fixture, which the tests assert was actually requested.
 *
 * Screenshots go to RELEASE_NOTES_SHOTS when set (the lane's review evidence).
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page, type Route } from '@playwright/test';

const WS = '93000000001';
const CH = '93000000002';
const ME = '93000000003';
const PEER = '93000000004';

const SHOTS = process.env.RELEASE_NOTES_SHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

const NOTES = {
  version: 1,
  generatedAt: '2026-09-28T10:05:00Z',
  head: { sha: 'a'.repeat(40), short: 'aaaaaaa', date: '2026-09-28T10:00:00Z' },
  historyComplete: true,
  deploymentsNote: null,
  groups: [
    {
      kind: 'current',
      sha: 'a'.repeat(40),
      short: 'aaaaaaa',
      date: '2026-09-28T10:00:00Z',
      newFeatures: [
        { description: 'the version badge opens these release notes', scope: 'web', short: 'aaaaaaa', sha: 'a'.repeat(40) },
      ],
      improvements: [
        { description: 'notification menu rows keep one glyph column so labels align', scope: 'web', short: 'ea8d269', sha: 'e'.repeat(40) },
      ],
      bugFixes: [
        { description: 'a short thread reads from the top', scope: 'web', short: '0e8a575', sha: 'b'.repeat(40) },
        { description: '@me cannot 500 on a nil operator list', scope: 'server', short: 'd4671ef', sha: 'c'.repeat(40) },
      ],
      maintenance: 4,
    },
    {
      kind: 'deployment',
      sha: 'd'.repeat(40),
      short: 'd4671ef',
      date: '2026-09-27T23:36:18Z',
      current: false,
      newFeatures: [
        { description: 'notification controls in the header, menus, sidebar and thread panel', scope: 'web', short: 'a8895e7', sha: 'f'.repeat(40) },
      ],
      improvements: [],
      bugFixes: [],
      maintenance: 2,
    },
    {
      kind: 'earlier',
      day: '2026-09-26',
      date: '2026-09-26T00:00:00Z',
      newFeatures: [],
      improvements: [{ description: 'faster boot', scope: null, short: '1234567', sha: '1'.repeat(40) }],
      bugFixes: [],
      maintenance: 1,
    },
  ],
};

function messages() {
  return Array.from({ length: 12 }, (_, i) => ({
    id: String(93000001000 + i),
    channel_id: CH,
    thread_id: null,
    author_id: i % 2 === 0 ? PEER : ME,
    content: `message ${i + 1} — the conversation behind the release notes`,
    created_at: new Date(Date.UTC(2026, 8, 27, 20, 30 + i)).toISOString(),
    edited_at: null,
    attachments: null,
  }));
}

async function fulfill(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page, unmocked: string[], notesRequests: string[]): Promise<void> {
  await page.route('**/release-notes.json', async (route) => {
    notesRequests.push(route.request().url());
    await fulfill(route, NOTES);
  });
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const path = pathname.replace('/api/v1', '');
    const method = route.request().method();

    if (method === 'POST' && path === '/auth/login') {
      return fulfill(route, { access_token: 'e2e-access-token', refresh_token: 'e2e-refresh-token', expires_in: 3600 });
    }
    if (path === '/users/@me') {
      return fulfill(route, {
        user: {
          id: ME,
          username: 'e2e_viewer',
          display_name: null,
          email: 'e2e@local.test',
          email_verified: true,
          email_verified_at: '2026-09-01T00:00:00Z',
          avatar_url: null,
          created_at: '2026-09-01T00:00:00Z',
        },
      });
    }
    if (path === '/users/@me/workspaces') {
      return fulfill(route, {
        workspaces: [
          { id: WS, name: 'Release Notes', icon_url: null, owner_id: ME, role_version: 1, created_at: '2026-09-01T00:00:00Z' },
        ],
      });
    }
    if (path === `/workspaces/${WS}/channels`) {
      return fulfill(route, {
        channels: [
          {
            id: CH,
            workspace_id: WS,
            name: 'general',
            type: 0,
            parent_id: null,
            topic: null,
            position: 0,
            last_message_id: null,
            created_at: '2026-09-01T00:00:00Z',
          },
        ],
      });
    }
    // The same boot-time reads pane-layout.spec.ts answers, for the same reason.
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === '/users/@me/channels') return fulfill(route, { channels: [] });
    if (path === '/users/@me/marks') return fulfill(route, { marks: [] });
    if (path === '/auth/methods') return fulfill(route, { password: true, webauthn: false });
    if (path.endsWith('/threads')) return fulfill(route, { threads: [] });
    if (path === `/workspaces/${WS}/people`) {
      return fulfill(route, {
        people: [
          {
            user: { id: PEER, username: 'peer', avatar_url: null },
            nickname: null,
            joined_at: '2026-09-01T00:00:00Z',
            roles: [],
            kind: 'human',
          },
        ],
        next_before: null,
      });
    }
    if (path === `/channels/${CH}/messages`) return fulfill(route, { messages: messages(), oldest_id: null });
    if (path === `/channels/${CH}/call`) return fulfill(route, { call: null });

    unmocked.push(`${method} ${path}`);
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

async function openChannel(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });
  // No gateway: stand in for READY (see pane-layout.spec.ts).
  await page.evaluate(
    (me) =>
      (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState({
        currentUser: { id: me, username: 'e2e_viewer' },
        sessionEpoch: 1,
      }),
    ME,
  );
}

test.describe('release notes — the version badge replaces the center column', () => {
  test('desktop: badge → notes in the center column → back to the channel', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    const unmocked: string[] = [];
    const notesRequests: string[] = [];
    await mockApi(page, unmocked, notesRequests);
    await openChannel(page);
    await page.getByTestId(`channel-${CH}`).click();
    await page.waitForSelector('[data-testid="message-item"]');
    await shot(page, 'desktop-1-channel');

    // Nothing fetched the notes at boot — they are read when opened.
    expect(notesRequests).toEqual([]);

    const badge = page.getByTestId('rail-footer').getByTestId('rail-version');
    await expect(badge).toHaveAttribute('href', '#/release-notes');
    await badge.click();

    const pane = page.getByTestId('release-notes-pane');
    await expect(pane).toBeVisible();
    await expect(page).toHaveURL(/#\/release-notes$/);
    expect(notesRequests.length).toBeGreaterThan(0);
    // It REPLACES the conversation: no timeline, no composer.
    await expect(page.locator('[data-testid="message-item"]')).toHaveCount(0);
    await expect(page.getByTestId('composer-well')).toHaveCount(0);
    // …in the center column: the left cluster (rail + channel list) stays.
    await expect(page.getByTestId(`channel-${CH}`)).toBeVisible();
    const cluster = await page.getByTestId('left-cluster').boundingBox();
    const box = await pane.boundingBox();
    expect(cluster && box && box.x >= cluster.x + cluster.width - 1).toBe(true);

    const groups = pane.getByTestId('release-notes-group');
    await expect(groups).toHaveCount(3);
    await expect(groups.nth(0).getByRole('heading', { level: 2 })).toHaveText('This version');
    await expect(groups.nth(0).getByRole('heading', { name: 'New features' })).toBeVisible();
    await expect(groups.nth(0).getByRole('heading', { name: 'Improvements' })).toBeVisible();
    await expect(groups.nth(0).getByRole('heading', { name: 'Bug fixes' })).toBeVisible();
    await expect(groups.nth(0).getByTestId('release-notes-maintenance')).toHaveText('+4 maintenance changes');
    await expect(groups.nth(1).getByRole('heading', { level: 2 })).toHaveText('vd4671ef');
    await expect(groups.nth(2).getByRole('heading', { level: 2 })).toHaveText(/^Earlier — /);
    await shot(page, 'desktop-2-release-notes');

    // Browser Back returns to the conversation.
    await page.goBack();
    await expect(pane).toHaveCount(0);
    await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible();

    // …and so does the pane's own close.
    await badge.click();
    await expect(pane).toBeVisible();
    await page.getByRole('button', { name: 'Close release notes' }).click();
    await expect(pane).toHaveCount(0);
    await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible();

    // A channel click from beside the notes leaves them too.
    await badge.click();
    await expect(pane).toBeVisible();
    await page.getByTestId(`channel-${CH}`).click();
    await expect(pane).toHaveCount(0);
    await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible();

    expect(unmocked, 'every boot-time request is covered by a fixture').toEqual([]);
  });

  test('phone: the drawer carries the badge; the notes take the full screen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const unmocked: string[] = [];
    const notesRequests: string[] = [];
    await mockApi(page, unmocked, notesRequests);
    await openChannel(page);
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 20_000 });

    await page.getByRole('button', { name: 'Open navigation' }).click();
    const badge = page.getByTestId('drawer-footer').getByTestId('rail-version');
    await expect(badge).toBeVisible();
    // Let the drawer's slide-in settle so the capture shows the footer row.
    if (SHOTS) await page.waitForTimeout(600);
    await shot(page, 'phone-1-drawer');
    await badge.click();

    const pane = page.getByTestId('release-notes-pane');
    await expect(pane).toBeVisible();
    await expect(page.getByTestId('drawer-workspace-strip')).toBeHidden();
    const box = await pane.boundingBox();
    expect(box && box.width >= 389).toBe(true);
    await expect(pane.getByTestId('release-notes-group')).toHaveCount(3);
    await shot(page, 'phone-2-release-notes');

    await page.getByRole('button', { name: 'Close release notes' }).click();
    await expect(pane).toHaveCount(0);

    expect(unmocked, 'every boot-time request is covered by a fixture').toEqual([]);
  });
});
