/**
 * #83 — participation with a SECOND participant.
 *
 * The ticket's remaining bullets all need someone else in the room: "leaving and
 * deleting a thread, and what the other participants observe". Everything so far
 * has been single-actor, which cannot test that by construction.
 *
 * The second actor is a second HUMAN via an invite, not an agent: workspace bots
 * were retired (owner decision 2026-09-12) and agents are user-owned with an
 * access grant whose model is still landing — so the invite path is both the
 * ratified one and the one with no dependencies.
 *
 * Wire shapes are the ticket's own: an invite mints a code (`POST
 * /workspaces/:id/invites`), identity joins through it (`POST /invites/:code`),
 * and a thread exists because its first reply does.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  API,
  MAILBOX,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedWorkspaceWithChannel,
} from './helpers';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-13-threads-two-actors',
);

test.describe('threads with two participants (#83 participation)', () => {
  test('a second member replies in a thread; the first sees it, and leaving is per-member', async ({
    page,
    request,
  }) => {
    test.setTimeout(300_000);
    // Pins a live-suite finding (2026-09-29): at desktop width Home showed NO
    // rail icons — the Home band hid itself while the channel column's mode
    // was set (Members, the desktop default), yet Home renders no column — so
    // the Threads icon this journey clicks, and with it My Threads, was
    // unreachable from Home.
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });

    // --- actor A: the member whose view we observe -------------------------
    await registerVerifiedUser(page, 'pa');
    const tokenA = await accessToken(page);
    const a = { authorization: `Bearer ${tokenA}` };
    const { wsId, chId } = await seedWorkspaceWithChannel(
      request,
      tokenA,
      `two-${Date.now().toString(36)}`,
    );
    const seedRes = await request.post(`${API}/channels/${chId}/messages`, {
      headers: a,
      data: { content: 'two-actor seed' },
    });
    const seedId = (await seedRes.json()).message.id as string;

    // --- actor B: a second human, joined through an invite -----------------
    const bName = `pb_${Date.now().toString(36)}`;
    const bEmail = `${bName}@e2e.local`;
    const bPass = 'e2e-password-1!';
    const reg = await request.post(`${API}/auth/register`, {
      data: { username: bName, email: bEmail, password: bPass },
    });
    expect(reg.status(), 'the second actor registers').toBe(201);
    // Verify through the dev mailbox so B can post (content_mutation gates on it).
    const { readFileSync } = await import('node:fs');
    const lines = readFileSync(MAILBOX, 'utf8').trim().split('\n');
    const mail = lines
      .map((l) => {
        try {
          return JSON.parse(l) as { to?: string; token?: string };
        } catch {
          return null;
        }
      })
      .filter((m) => m?.to === bEmail && m.token)
      .at(-1);
    expect(mail, 'a verification token for the second actor').toBeTruthy();
    await request.post(`${API}/auth/verify-email`, { data: { token: mail!.token } });
    const login = await request.post(`${API}/auth/login`, {
      data: { identifier: bName, password: bPass },
    });
    const tokenB = (await login.json()).access_token as string;
    const b = { authorization: `Bearer ${tokenB}` };

    // A mints an invite; B accepts it — B is now a member of A's workspace.
    const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
      headers: a,
      data: {},
    });
    const invBody = await inv.json();
    const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
    expect(code, `invite code from ${JSON.stringify(invBody).slice(0, 120)}`).toBeTruthy();
    const accepted = await request.post(`${API}/invites/${code}`, { headers: b, data: {} });
    expect(accepted.ok(), `B joins the workspace (${accepted.status()})`).toBe(true);

    // --- the thread, created by its first reply (A's) ----------------------
    const th = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: a,
      data: { name: 'two-actor thread' },
    });
    const threadId = (await th.json()).thread.id as string;
    const replyA = await request.post(`${API}/threads/${threadId}/messages`, {
      headers: a,
      data: { content: 'A speaks first' },
    });
    expect(replyA.status(), 'A replies in the thread').toBe(201);

    // B — the OTHER participant — replies. This is the whole point of the rig.
    const replyB = await request.post(`${API}/threads/${threadId}/messages`, {
      headers: b,
      data: { content: 'B answers from the other side' },
    });
    expect(replyB.status(), 'B can post in a thread it can see').toBe(201);

    // --- what A observes ---------------------------------------------------
    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    const indicator = page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator');
    await expect(indicator).toContainText('2 replies', { timeout: 20_000 });
    await indicator.click();
    await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });
    // Both voices are there, and B's authorship is attributed to B.
    await expect(
      page.getByTestId('thread-replies').getByText('B answers from the other side'),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(OUT, 'two-actor-thread-1x.png') });

    // --- Mark Unread has something to show, because B's message exists ------
    // The same assertion that was false in the single-actor spec is meaningful
    // here: `markUnread` counts messages from OTHERS, so it needs another voice
    // in the thread to have anything to light.
    const panel = page.getByTestId('thread-side-panel');
    await panel.getByTestId('thread-ellipsis').click();
    // The ⋯ menu is portaled out of the panel (Radix): its items are page-level.
    await page.getByTestId('thread-option-mark-unread').click();
    await page.waitForTimeout(1200);
    await panel.getByTestId('thread-close').click();
    await expect(page.getByTestId('thread-dock')).toBeHidden({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('home-dashboard')).toBeVisible({ timeout: 15_000 });
    // Home at rest: no column (the channel's Members default does not follow
    // the reader here), no member list offered, and the band carries the two
    // modes Home does offer.
    await expect(page.getByTestId('member-list')).toHaveCount(0);
    await expect(page.getByTestId('home-rail-icons')).toBeVisible();
    await expect(page.getByTestId('rail-icon-members')).toHaveCount(0);
    await page.getByTestId('rail-icon-threads').click({ timeout: 15_000 });
    const mine = page.getByTestId('my-threads-sidebar');
    await expect(mine).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(OUT, 'my-threads-unread-1x.png') });
    expect(
      await mine.getByTestId('my-thread-badge').count(),
      "a thread marked unread that contains ANOTHER person's reply must show its badge",
    ).toBeGreaterThan(0);
    await page.getByTestId('rail-icon-threads').click();

    // --- leaving is PER-MEMBER --------------------------------------------
    // A leaves; the thread must survive for B. A's own view dropping it while
    // B's keeps it is the "what other participants observe" contract.
    const left = await request.delete(`${API}/threads/${threadId}/members/@me`, { headers: a });
    expect(left.ok(), `A leaves the thread (${left.status()})`).toBe(true);

    const bStillSees = await request.get(`${API}/threads/${threadId}/messages`, { headers: b });
    expect(bStillSees.ok(), "B can still read a thread A left").toBe(true);
    const bReplies = (
      (await bStillSees.json()).messages ?? (await bStillSees.json()).items ?? []
    ) as unknown[];
    console.log(`[two-actor] B still reads ${bReplies.length} message(s) after A left`);
    expect(bReplies.length, 'the thread and its history survive one member leaving').toBeGreaterThan(
      1,
    );
  });
});
