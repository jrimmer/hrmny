/**
 * People are shown by their display name, live (#168, 2026-10-04).
 *
 * A person's account display name (Settings → My Account → Profile) was
 * stored but never sent with a roster row, so every surface named people by
 * their username. Here a second account with a display name joins the
 * viewer's workspace and posts: the viewer sees the display name (with the
 * @handle kept as the handle). Then the author renames themself while the
 * viewer watches: the name changes on the same live page, no reload.
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

/** POST with the auth surface's per-IP budget honored (a 429 waits and retries). */
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
    (globalThis as { __namesEpoch?: number }).__namesEpoch = 1;
  });
}

async function samePageMarker(page: Page): Promise<number> {
  return page.evaluate(() => (globalThis as { __namesEpoch?: number }).__namesEpoch ?? 0);
}

test('a person shows by display name, and a rename lands live', async ({ page, request }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerVerifiedUser(page, 'names');
  const token = await accessToken(page);
  const wsName = `names-${Date.now().toString(36)}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);

  // The author: registered, verified, a display name set, then joins by invite.
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
  const authorToken = login.body.access_token as string;
  const auth = { authorization: `Bearer ${authorToken}` };
  const named = await request.patch(`${API}/users/@me`, { headers: auth, data: { display_name: 'E. Howard Hunt' } });
  expect(named.ok(), `display name set (${named.status()})`).toBe(true);
  const joined = await request.post(`${API}/invites/${code}`, { headers: auth, data: {} });
  expect(joined.ok(), `the author joins (${joined.status()})`).toBe(true);

  await openSeededChannel(page, wsName, chId);
  await markSamePage(page);

  const text = `the hotel room has a radio ${Date.now()}`;
  const posted = await request.post(`${API}/channels/${chId}/messages`, { headers: auth, data: { content: text } });
  expect(posted.status(), 'the author posts').toBe(201);

  const row = page.locator('[data-testid="message-item"]', { hasText: text });
  await expect(row.getByTestId('message-author'), 'shown by display name').toHaveText('E. Howard Hunt', {
    timeout: LIVE_TIMEOUT,
  });
  await expect(row.getByTestId('message-author')).not.toHaveText(user.username);

  // Renamed while the viewer watches: the same row follows, no reload.
  const renamed = await request.patch(`${API}/users/@me`, { headers: auth, data: { display_name: 'Eduardo' } });
  expect(renamed.ok(), `renamed (${renamed.status()})`).toBe(true);
  await expect(row.getByTestId('message-author'), 'the rename lands live').toHaveText('Eduardo', {
    timeout: LIVE_TIMEOUT,
  });

  // Cleared: back to the username.
  const cleared = await request.patch(`${API}/users/@me`, { headers: auth, data: { display_name: null } });
  expect(cleared.ok(), `cleared (${cleared.status()})`).toBe(true);
  await expect(row.getByTestId('message-author'), 'cleared → the username').toHaveText(user.username, {
    timeout: LIVE_TIMEOUT,
  });

  expect(await samePageMarker(page), 'observed on the same live page — no reload').toBe(1);
});
