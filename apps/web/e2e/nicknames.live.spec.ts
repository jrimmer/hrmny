/**
 * Per-workspace nicknames, live (#169, 2026-10-04).
 *
 *   1. YOURS, FROM THE MENU. The workspace menu's "Change Nickname" sets your
 *      nickname in this workspace; your messages show it at once.
 *   2. SOMEONE ELSE'S, LIVE. A member sets their nickname (the API, as any
 *      client or bot would) while the viewer watches: the viewer's row for
 *      them changes on the same page, no reload, and clearing it brings the
 *      display name back.
 */
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';

import {
  accessToken,
  API,
  apiRegister,
  makeE2EUser,
  openSeededChannel,
  registerVerifiedUser,
  seedWorkspaceWithChannel,
  verifyViaMailbox,
} from './helpers';

const LIVE_TIMEOUT = 20_000;

async function postPatiently(
  request: APIRequestContext,
  url: string,
  data: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await request.post(url, { data });
    if (res.status() !== 429) {
      return { status: res.status(), body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const after = Number(res.headers()['retry-after'] ?? '2');
    await new Promise((r) => setTimeout(r, Math.max(1, after) * 1000));
  }
  throw new Error(`still rate-limited: ${url}`);
}

async function markSamePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as { __nickEpoch?: number }).__nickEpoch = 1;
  });
}

const samePage = (page: Page) =>
  page.evaluate(() => (globalThis as { __nickEpoch?: number }).__nickEpoch ?? 0);

test('nicknames: yours from the menu, and another member’s live', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const viewerName = await registerVerifiedUser(page, 'nick');
  const token = await accessToken(page);
  const wsName = `nicks-${Date.now().toString(36)}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);

  // A second member, with a display name, joins by invite.
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code) as string;
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  const login = await postPatiently(request, `${API}/auth/login`, {
    identifier: user.username,
    password: user.password,
  });
  const auth = { authorization: `Bearer ${login.body.access_token as string}` };
  await request.patch(`${API}/users/@me`, { headers: auth, data: { display_name: 'E. Howard Hunt' } });
  const joined = await request.post(`${API}/invites/${code}`, { headers: auth, data: {} });
  expect(joined.ok(), `the member joins (${joined.status()})`).toBe(true);

  await openSeededChannel(page, wsName, chId);
  await markSamePage(page);

  // 1. Yours, from the workspace menu.
  const mine = `my own words ${Date.now()}`;
  const posted = await request.post(`${API}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${token}` },
    data: { content: mine },
  });
  expect(posted.status()).toBe(201);
  const myRow = page.locator('[data-testid="message-item"]', { hasText: mine });
  await expect(myRow.getByTestId('message-author')).toHaveText(viewerName, { timeout: LIVE_TIMEOUT });

  await page.getByTestId('workspace-menu-trigger').click();
  await page.getByTestId('workspace-menu-change-nickname').click();
  await page.getByTestId('nickname-input').fill('Gemstone');
  await page.getByTestId('nickname-save').click();
  await expect(page.getByTestId('nickname-dialog')).toBeHidden({ timeout: LIVE_TIMEOUT });
  await expect(myRow.getByTestId('message-author'), 'your nickname shows').toHaveText('Gemstone', {
    timeout: LIVE_TIMEOUT,
  });

  // 2. Someone else's, live.
  const theirs = `the hotel room ${Date.now()}`;
  await request.post(`${API}/channels/${chId}/messages`, { headers: auth, data: { content: theirs } });
  const theirRow = page.locator('[data-testid="message-item"]', { hasText: theirs });
  await expect(theirRow.getByTestId('message-author')).toHaveText('E. Howard Hunt', { timeout: LIVE_TIMEOUT });

  const set = await request.patch(`${API}/workspaces/${wsId}/members/@me`, {
    headers: auth,
    data: { nickname: 'Eduardo' },
  });
  expect(set.ok(), `nickname set (${set.status()})`).toBe(true);
  await expect(theirRow.getByTestId('message-author'), 'the nickname lands live').toHaveText('Eduardo', {
    timeout: LIVE_TIMEOUT,
  });

  const cleared = await request.patch(`${API}/workspaces/${wsId}/members/@me`, {
    headers: auth,
    data: { nickname: null },
  });
  expect(cleared.ok()).toBe(true);
  await expect(theirRow.getByTestId('message-author'), 'cleared → the display name').toHaveText('E. Howard Hunt', {
    timeout: LIVE_TIMEOUT,
  });

  expect(await samePage(page), 'observed on the same live page — no reload').toBe(1);
});
