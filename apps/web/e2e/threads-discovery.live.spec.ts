/**
 * Threads discovery (#83 — the ticket's first section).
 *
 * The question the ticket asks is whether a member can FIND a thread they did
 * not start, and the owner's own evidence ("on the Hermes Discord I didn't see
 * any threads, just replies") suggests discovery is the weak half. So this leg
 * drives the four discovery paths against real, server-created data and pins
 * both halves of every contract — including the ABSENCE of the seed indicator
 * on a row with no replies, which is as load-bearing as its presence.
 *
 * The thread is seeded over REST rather than through the composer: the flow
 * under test is finding an existing thread, and a thread exists because its
 * first reply does.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  API,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedWorkspaceWithChannel,
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
  '2026-09-13-threads-discovery',
);

test.describe('threads discovery (#83)', () => {
  test('a thread is findable by a member who never opened it', async ({ page, request }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'th83');

    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `th83-${Date.now().toString(36)}`,
    );

    // One row that will seed a thread, one that must stay bare — the
    // indicator's absence is half the contract.
    const seedRes = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'discovery seed message' },
    });
    const seedId = (await seedRes.json()).message.id as string;
    await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'bare row with no replies' },
    });

    const thRes = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: auth,
      data: { name: 'discovery derived name' },
    });
    const threadId = (await thRes.json()).thread.id as string;
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content: 'first reply' },
    });

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });

    // D1 — the seed row announces the thread; the bare row does not.
    //   The indicator's contract (owner-authorized prominence pass): the COUNT
    //   leads, then the derived name, then last activity — and the accessible
    //   name spells the whole thing out, which is what a screen-reader member
    //   gets. Asserted on that rather than on inner testids so the check
    //   survives the indicator's markup.
    const seedRow = page.locator(`[data-message-id="${seedId}"]`);
    const indicator = seedRow.getByTestId('thread-indicator');
    await expect(indicator).toBeVisible({ timeout: 15_000 });
    await expect(indicator).toHaveAttribute('aria-label', /1 reply/);
    await expect(indicator).toContainText('discovery derived name');
    await expect(indicator).toContainText('last activity');
    await expect(
      page.locator('[data-testid="thread-indicator"]'),
      'exactly one row carries an indicator — the bare row must not',
    ).toHaveCount(1);

    // D2 — the rail's Threads tab lists it (owner direction 2026-09-12).
    await page.getByTestId('rail-icon-threads').click();
    const rosterRow = page.getByTestId(`threads-list-row-${threadId}`);
    await expect(rosterRow).toBeVisible({ timeout: 15_000 });
    await expect(rosterRow).toContainText('discovery derived name');
    await page.screenshot({ path: join(OUT, 'rail-threads-tab-1x.png') });

    // D3 — still findable after a fresh load: the roster is a server read, not
    // the event that created it. This is the path a member who was AWAY takes.
    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    await expect(page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('rail-icon-threads').click();
    await expect(page.getByTestId(`threads-list-row-${threadId}`)).toBeVisible({ timeout: 15_000 });

    // D4 — opening from the roster lands in the thread.
    await page.getByTestId(`threads-list-row-${threadId}`).click();
    await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(OUT, 'opened-from-roster-1x.png') });
  });

  // The roster row (owner direction 2026-10-08): a bot-made name like
  // `thread-388032` says nothing, so the row is named by the message the
  // thread started from and previews the newest reply; a chosen name stays.
  test('roster rows name a thread by its start message and preview the last reply', async ({ page, request }) => {
    test.setTimeout(240_000);
    mkdirSync(OUT, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'th83r');

    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(request, token, `th83r-${Date.now().toString(36)}`);

    const thread = async (content: string, name: string, replies: string[]) => {
      const m = await request.post(`${API}/channels/${chId}/messages`, { headers: auth, data: { content } });
      const id = (await m.json()).message.id as string;
      const t = await request.post(`${API}/channels/${chId}/messages/${id}/threads`, { headers: auth, data: { name } });
      const threadId = (await t.json()).thread.id as string;
      for (const reply of replies) {
        await request.post(`${API}/threads/${threadId}/messages`, { headers: auth, data: { content: reply } });
      }
      return threadId;
    };
    const generated = await thread('Overnight **transcript**, DNC line 2: 38 minutes', 'thread-388032', [
      'logs 1–40 are ready',
      'Shredded.',
    ]);
    const named = await thread('Taping the stairwell door latches', 'Door tape', ['he will never notice twice']);

    await reloadIntoFirstWorkspace(page);
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    await page.getByTestId('rail-icon-threads').click();

    const generatedRow = page.getByTestId(`threads-list-row-${generated}`);
    await expect(generatedRow).toBeVisible({ timeout: 15_000 });
    await expect(generatedRow).toContainText('Overnight transcript, DNC line 2: 38 minutes');
    await expect(generatedRow).not.toContainText('thread-388032');
    await expect(generatedRow).toContainText('Shredded.');
    await expect(generatedRow).toContainText('2 replies');

    const namedRow = page.getByTestId(`threads-list-row-${named}`);
    await expect(namedRow).toContainText('Door tape');
    await expect(namedRow).toContainText('he will never notice twice');
    await expect(page.getByRole('heading', { name: 'Today' })).toBeVisible();

    await page.getByTestId('threads-list').screenshot({ path: join(OUT, 'roster-rows-1x.png') });
  });
});

/**
 * Participation, bullet 1: the draft pane writes NOTHING until its first reply.
 * A thread that is opened and abandoned must leave no trace — no roster entry,
 * no empty thread for the next member to find. Driven in the touch band because
 * the action sheet is gated on a coarse pointer (the long-press is the only
 * way to reach Start thread there), while the assertions are API reads, so this
 * checks the SERVER's state rather than the client's optimism.
 */
test.describe('thread draft writes nothing (#83 participation)', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test('opening and closing a draft leaves the channel roster untouched', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await registerVerifiedUser(page, 'thd');
    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `thd-${Date.now().toString(36)}`,
    );
    const res = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'draft seed message' },
    });
    const seedId = (await res.json()).message.id as string;

    const roster = async () => {
      const r = await request.get(`${API}/channels/${chId}/threads`, { headers: auth });
      return ((await r.json()).threads ?? []) as Array<{ id: string }>;
    };

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    expect(await roster(), 'a fresh channel has no threads').toHaveLength(0);

    // Open the draft: long-press then Start thread.
    const row = page.locator(`[data-message-id="${seedId}"]`);
    await row.click({ delay: 600 });
    await expect(page.getByTestId('message-actions-sheet')).toBeVisible();
    await page.getByTestId('sheet-action-thread').click();
    await expect(page.getByTestId('thread-sheet')).toBeVisible({ timeout: 15_000 });

    // THE CONTRACT: an open draft has created nothing server-side.
    expect(await roster(), 'an open draft must not appear as a thread').toHaveLength(0);

    // Closing it must leave nothing behind either.
    await page.getByTestId('thread-close').click();
    await expect(page.getByTestId('thread-sheet')).toBeHidden();
    expect(await roster(), 'closing a draft must not leave a thread').toHaveLength(0);

    // And no indicator appeared on the seed row for a thread that never was.
    await expect(
      page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator'),
    ).toHaveCount(0);
  });
});

/**
 * The ticket names two hypotheses to test in the thread panel itself:
 *   * "the thread pane's ⋯ affordance: is it a dead end?"
 *   * "the notify bell (it once called a nonexistent endpoint — verify the
 *     surface still matches the API)"
 *
 * Both are answered here against a real thread. The bell's route is also
 * checked at the source: `PATCH /threads/:thread_id/members/@me`
 * (router.ex) is what `update_follow` serves, so the surface is not pointing
 * at a phantom.
 */
test.describe('thread panel affordances (#83 participation)', () => {
  test('the ⋯ is not a dead end, and the bell matches a real route', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'thp');
    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `thp-${Date.now().toString(36)}`,
    );
    const res = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'panel hypothesis seed' },
    });
    const seedId = (await res.json()).message.id as string;
    const thRes = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: auth,
      data: { name: 'panel hypothesis thread' },
    });
    const threadId = (await thRes.json()).thread.id as string;
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content: 'a reply so the thread is real' },
    });

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });

    // Open it from the seed indicator (the discovery path a member uses).
    await page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator').click();
    const panel = page.getByTestId('thread-side-panel');
    await expect(panel).toBeVisible({ timeout: 15_000 });

    // The level control exists and is a real control (2026-09-27: the bell is
    // the thread's notification LEVEL; Follow — PATCH /threads/:id/members/@me
    // — moved into the ⋯ menu, asserted below).
    await expect(panel.getByTestId('thread-notifications')).toBeVisible();

    // THE HYPOTHESIS: the ⋯ opens a menu with two real actions, so it is NOT
    // a dead end. Pinned by name so a third action (or a lost one) is visible.
    await panel.getByTestId('thread-ellipsis').click();
    // The menu is portaled out of the panel (Radix): it is a page-level node.
    const menu = page.getByTestId('thread-options-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId('thread-option-mark-unread')).toBeVisible();
    await expect(menu.getByTestId('thread-option-leave')).toBeVisible();
    await expect(menu.getByTestId('thread-option-follow')).toBeVisible();
    await page.screenshot({ path: join(OUT, 'thread-ellipsis-menu-1x.png') });
  });
});

/**
 * Read state, hypothesis 1: where does a thread LAND when you open it?
 *
 * The ticket asks it directly — "landing position when opening a thread: newest
 * reply vs where you left off" — and this is the version of that question that
 * needs no memory of a prior visit: a thread with a long history, opened for
 * the first time. A conversation must open at its NEWEST end; landing at the
 * oldest end means a member scrolls through everything they have already read
 * to reach what happened, which is the failure mode that makes a surface feel
 * kludgy without being broken.
 *
 * Asserts the overflow first (a short thread proves nothing) and then the
 * landing, so a green result means the geometry was actually exercised.
 */
test.describe('thread landing position (#83 read state)', () => {
  /*
   * NOT a defect — this began as #104 ("threads open at their oldest reply"),
   * filed on an unverified assumption that the newest reply sits at the BOTTOM.
   * It does not: the list renders newest-first, so `scrollTop: 0` is the
   * newest end and the landing was already correct. The assertion is now
   * order-agnostic (is the newest reply IN VIEW) and carries no expect-fail.
   */
  test('a long thread opens at its newest reply, not its oldest', async ({ page, request }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'thl');
    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `thl-${Date.now().toString(36)}`,
    );
    const res = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'landing seed' },
    });
    const seedId = (await res.json()).message.id as string;
    const thRes = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: auth,
      data: { name: 'landing thread' },
    });
    const threadId = (await thRes.json()).thread.id as string;
    // Enough replies to overflow the pane with room to spare.
    for (let i = 1; i <= 30; i++) {
      await request.post(`${API}/threads/${threadId}/messages`, {
        headers: auth,
        data: { content: `reply number ${i}` },
      });
    }

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    await page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator').click();
    await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(1500); // let the list settle before measuring

    const geo = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="thread-replies"]') as HTMLElement | null;
      if (!root) return null;
      // The list is virtualised, so the scroller is usually a descendant.
      const scroller =
        (root.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null) ?? root;
      // The RENDER ORDER, because it decides which end is "newest" and my
      // original assertion assumed the bottom without checking.
      const rows = Array.from(root.querySelectorAll('[data-testid="message-item"]'));
      const text = (el: Element) => (el as HTMLElement).innerText.replace(/\s+/g, ' ').slice(0, 44);
      return {
        scrollTop: Math.round(scroller.scrollTop),
        scrollHeight: Math.round(scroller.scrollHeight),
        clientHeight: Math.round(scroller.clientHeight),
        firstRows: rows.slice(0, 2).map(text),
        lastRows: rows.slice(-2).map(text),
        // Order-agnostic: is the NEWEST reply inside the visible box? The list
        // renders newest-first, so "which end is newest" must not be assumed
        // from scroll direction.
        newestInView: (() => {
          const newest = rows.find((el) => (el as HTMLElement).innerText.includes('reply number 30'));
          if (!newest) return null;
          const box = scroller.getBoundingClientRect();
          const row = newest.getBoundingClientRect();
          return row.top >= box.top - 4 && row.bottom <= box.bottom + 4;
        })(),
      };
    });
    expect(geo, 'the thread replies region is present').not.toBeNull();
    const { scrollTop, scrollHeight, clientHeight } = geo!;
    console.log(
      `[landing] scrollTop=${scrollTop} scrollHeight=${scrollHeight} clientHeight=${clientHeight}`,
    );
    console.log(`[landing] top of list:    ${JSON.stringify(geo!.firstRows)}`);
    console.log(`[landing] bottom of list: ${JSON.stringify(geo!.lastRows)}`);

    expect(
      scrollHeight,
      'the history must overflow the pane, or the landing position is untested',
    ).toBeGreaterThan(clientHeight + 100);
    // The contract is "the newest reply is visible on open" — NOT "the scroll
    // is at the bottom". The list renders newest-first, so the bottom is the
    // OLDEST reply and a near-bottom assertion was measuring the opposite of
    // what it claimed. This is order-agnostic, which is the point.
    expect(
      geo!.newestInView,
      'the newest reply must be in view when a thread opens',
    ).toBe(true);
  });
});

/**
 * Read state, hypothesis 2 — MOVED to `threads-two-actors.live.spec.ts`.
 *
 * This asked whether Mark Unread has a visible consequence, and asserted a badge
 * on a thread whose only reply was the reader's OWN. It failed, I filed it as
 * #108, and then found the mechanism: the badge derives from `unread_count`,
 * which `markUnread` sets to the number of messages from OTHER people. A
 * self-only thread therefore has nothing to be unread about, and showing no
 * badge is CORRECT — the test's premise was wrong, not the product.
 *
 * The check moved to the two-actor rig, which is the only place it means
 * anything: B replies, A marks unread, A's badge lights.
 */
test.describe('where a thread reply lands (#83 participation)', () => {
  /**
   * The data-model half: a reply is readable IN the thread and does NOT also
   * appear as a channel message. Unmarked, because these are enforced by the
   * model and a failure here would be a genuine regression.
   */
  test('a reply is readable in the thread and never leaks into the channel', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'thr');
    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `thr-${Date.now().toString(36)}`,
    );
    const res = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'reply-routing seed' },
    });
    const seedId = (await res.json()).message.id as string;
    const thRes = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: auth,
      data: { name: 'reply routing thread' },
    });
    const threadId = (await thRes.json()).thread.id as string;
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content: 'thread-only reply' },
    });

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });

    // NOT in the channel timeline — measured BEFORE the thread is opened, since
    // the thread dock renders its replies with the same `message-item` testid,
    // so an open panel would match its own copy and read as a leak that is not
    // one. Order is the check here.
    const inChannel = await page
      .locator('[data-testid="message-item"]')
      .getByText('thread-only reply')
      .count();
    console.log(`[reply-routing] copies in the channel timeline: ${inChannel}`);
    expect(inChannel, 'a thread reply must not also appear as a channel message').toBe(0);

    // IN the thread…
    await page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator').click();
    await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId('thread-replies').getByText('thread-only reply'),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: join(OUT, 'thread-reply-lands-1x.png') });
  });

  /**
   * The live half — #106. The count once only moved on a refetch, which read as
   * intermittency; the cause was that a live ThreadMessageCreate never touched
   * the thread summary. The reducer now counts a reply strictly newer than the
   * summary's latest_reply_at, which is what keeps loadReplies()' replay of
   * history and the sender's own echo (same event type) from double-counting.
   *
   * The discriminator (a plain channel message arriving live on the same
   * socket) stays asserted FIRST, so a failure says which half moved.
   */
  test('the seed indicator reflects a reply that arrives while the client is open (#106)', async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await registerVerifiedUser(page, 'thl2');
    const token = await accessToken(page);
    const auth = { authorization: `Bearer ${token}` };
    const { chId } = await seedWorkspaceWithChannel(
      request,
      token,
      `thl2-${Date.now().toString(36)}`,
    );
    const res = await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'live count seed' },
    });
    const seedId = (await res.json()).message.id as string;
    const thRes = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: auth,
      data: { name: 'live count thread' },
    });
    const threadId = (await thRes.json()).thread.id as string;
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content: 'first reply' },
    });

    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
    const indicator = page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator');
    await expect(indicator).toContainText('1 reply', { timeout: 15_000 });

    // A second reply arrives while the client is OPEN — no reload after this.
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content: 'second reply' },
    });

    // Discriminator: live delivery itself works on this client.
    await request.post(`${API}/channels/${chId}/messages`, {
      headers: auth,
      data: { content: 'live channel probe' },
    });
    await expect(
      page.getByTestId('message-item').getByText('live channel probe'),
      'live delivery works at all on this client',
    ).toBeVisible({ timeout: 20_000 });
    console.log('[reply-routing] a channel message DID arrive live');

    await expect(
      indicator,
      'the seed indicator must reflect a reply that arrived while the client was open',
    ).toContainText('2 replies', { timeout: 20_000 });
  });
});
