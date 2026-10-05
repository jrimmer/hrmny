/**
 * #109 — archiving a thread, in a real browser.
 *
 * What this leg claims, and what it deliberately does not:
 *
 *   * CLAIMED: the creator is OFFERED the control (the thread's `created_by`
 *     rides the roster read), archiving hides the thread from the roster and
 *     from the seed indicator while leaving it directly readable, the open pane
 *     says it is archived instead of vanishing, and unarchiving restores both.
 *     Both scales (1x and 4x) are captured.
 *
 *   * NOT CLAIMED HERE: that a SECOND client's open pane flips live off the
 *     fan-out. That half is asserted where it can be asserted honestly — the
 *     server suite (`gateway_fanout_test.exs`: a publish reaches the channel's
 *     sockets) plus `Threads.Events` carrying the `channel_id` the fan-out
 *     routes by. In THIS rig the browser never receives live dispatches at all
 *     (a plain channel message posted over REST does not appear either: the
 *     payload codec negotiates `zlib_stream` because Playwright's Chromium has
 *     no native zstd, and the decoded stream never reaches the store). That is
 *     a pre-existing client-side issue on a surface #109 does not touch, and it
 *     is reported separately rather than papered over with a reload.
 *
 * The thread is seeded over REST (a thread exists because its first reply does),
 * and the flow is run twice — once per scale — because a context's
 * `deviceScaleFactor` is fixed for its lifetime AND an archived thread is
 * deliberately unreachable from the UI afterwards (that is the feature), so a
 * fresh 4x context could never navigate back to the state under test.
 */
import { test, expect, type Browser, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  API,
  apiRegister,
  CAPTURE_4X,
  CAPTURE_4X_SKIPPED,
  makeE2EUser,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedWorkspaceWithChannel,
  verifyViaMailbox,
} from './helpers';

/** Untracked by policy (.gitignore: /docs/research/screenshots/). */
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-13-threads-archive',
);

/** The creator's whole flow at one device scale, including both captures. */
async function creatorFlow(
  browser: Browser,
  request: APIRequestContext,
  scale: number,
  label: string,
) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: scale,
  });
  const page = await context.newPage();

  await registerVerifiedUser(page, `arch${label}`);
  const token = await accessToken(page);
  const a = { authorization: `Bearer ${token}` };
  const { wsId, chId } = await seedWorkspaceWithChannel(
    request,
    token,
    `arch-${label}-${Date.now().toString(36)}`,
  );

  // A second member — the "every participant" half of the acceptance, checked
  // where it is checkable: the roster read and the direct read.
  const userB = makeE2EUser();
  await apiRegister(userB);
  await verifyViaMailbox(userB);
  const loginB = await request.post(`${API}/auth/login`, {
    data: { identifier: userB.username, password: userB.password },
  });
  const tokenB = (await loginB.json()).access_token as string;
  const b = { authorization: `Bearer ${tokenB}` };
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, { headers: a, data: {} });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
  const accepted = await request.post(`${API}/invites/${code}`, { headers: b, data: {} });
  expect(accepted.ok(), `the second member joins (${accepted.status()})`).toBe(true);

  const seedRes = await request.post(`${API}/channels/${chId}/messages`, {
    headers: a,
    data: { content: 'archive seed message' },
  });
  const seedId = (await seedRes.json()).message.id as string;
  const th = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
    headers: a,
    data: { name: 'archive leg' },
  });
  const threadId = (await th.json()).thread.id as string;
  await request.post(`${API}/threads/${threadId}/messages`, {
    headers: a,
    data: { content: 'A speaks first' },
  });
  await request.post(`${API}/threads/${threadId}/messages`, {
    headers: b,
    data: { content: 'B answers' },
  });

  await reloadIntoFirstWorkspace(page); // a plain reload restores Home
  await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });

  const indicator = page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator');
  await expect(indicator).toBeVisible({ timeout: 20_000 });
  await indicator.click();
  await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });

  const panel = page.getByTestId('thread-side-panel');
  await expect(panel.getByTestId('thread-replies').getByText('B answers')).toBeVisible({
    timeout: 15_000,
  });
  // Before: no archived state anywhere.
  await expect(panel.getByTestId('thread-archived-notice')).toHaveCount(0);

  // Archive — the control is OFFERED because this account created the thread.
  await panel.getByTestId('thread-ellipsis').click();
  // The ⋯ menu is portaled out of the panel (Radix): its items are page-level.
  await page.getByTestId('thread-option-archive').click();

  await expect(panel.getByTestId('thread-archived-notice')).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByTestId('thread-archived-notice')).toContainText('no longer appears');
  // The pane stays open (it did not vanish under the cursor) and the seed
  // indicator stops advertising the thread.
  await expect(page.getByTestId('thread-side-panel')).toBeVisible();
  await expect(indicator).toHaveCount(0, { timeout: 15_000 });

  await page.screenshot({ path: join(OUT, `archive-${label}.png`) });

  // The roster read and the direct read agree, for BOTH members: archiving
  // hides the thread from the listings without changing who may read it.
  for (const headers of [a, b]) {
    const roster = await request.get(`${API}/channels/${chId}/threads`, { headers });
    const listed = (await roster.json()).threads as Array<{ id: string }>;
    expect(listed.map((t) => t.id)).not.toContain(threadId);

    const archived = await request.get(`${API}/channels/${chId}/threads?include_archived=true`, {
      headers,
    });
    expect(
      ((await archived.json()).threads as Array<{ id: string }>).map((t) => t.id),
    ).toContain(threadId);

    const direct = await request.get(`${API}/threads/${threadId}/messages`, { headers });
    expect(direct.status(), 'an archived thread stays directly readable').toBe(200);
  }

  // Unarchive — the same control, other direction.
  await panel.getByTestId('thread-ellipsis').click();
  // The ⋯ menu is portaled out of the panel (Radix): its items are page-level.
  await page.getByTestId('thread-option-archive').click();
  await expect(panel.getByTestId('thread-archived-notice')).toHaveCount(0, { timeout: 15_000 });
  await expect(indicator).toBeVisible({ timeout: 15_000 });

  await context.close();
}

test.describe('#109 — archiving a thread', () => {
  test('the creator archives and unarchives: roster, indicator, pane state (1x)', async ({
    browser,
    request,
  }) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    await creatorFlow(browser, request, 1, '1x');
  });

  test('the same flow at 4x, for the pixel copy', async ({ browser, request }) => {
    test.skip(!CAPTURE_4X, CAPTURE_4X_SKIPPED);
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    await creatorFlow(browser, request, 4, '4x');
  });
});
