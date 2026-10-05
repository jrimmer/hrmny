/**
 * #104 (step 2) — opening a channel with unreads lands at the first unread.
 *
 * The owner's direction was *"Opening a thread should navigate the viewer to
 * the first message after the unread. Just like opening a channel."* The thread
 * half shipped; this is the channel half's acceptance, and it passes as of the
 * fix it was written to force.
 *
 * WHAT IT FOUND (2026-09-13, when it was written as a `fixme`): the channel's
 * unread boundary did not survive to the moment the list had rows to draw it
 * above. With a boundary injected into the store through the dev build's handle
 * and the list remounted, the list came back with every row and NO "NEW" rule
 * while the store slice read `unread_count: 0`: the pane's read-ack
 * (`MessagePane`'s ack effect: *"an open pane IS a read view"*) had cleared the
 * session-local slice first. The fix is the shape `useThreads.openThread`
 * already used for threads: the PANE captures the slice before its ack and
 * hands it to `MessageList`, which draws the rule and lands on it once rows
 * exist (see the `unreadAtOpen` prop).
 *
 * WHY THE RIG INJECTS AT ALL: the unread slice is session-local — nothing
 * re-hydrates it, and a live arrival cannot build one here because this browser
 * receives no live dispatches (its own ticket). Injection through the dev
 * handle is the only route in. The ROW COUNT is the other half of the rig: rows
 * that group under one author inside one day are 24px continuation lines, and a
 * pane 752px tall swallows more than twenty of them — so the tail below the
 * boundary has to be long enough that "landed on the boundary" cannot be
 * confused with "landed at the newest" on screen at all (measured, after the
 * original 26 rows turned out not to overflow the pane: scrollHeight ===
 * clientHeight, max scroll 0).
 */
import { test, expect } from '@playwright/test';

import {
  accessToken,
  API,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedWorkspaceWithChannel,
} from './helpers';


test.describe('#104 — the channel landing', () => {
  test(
    'a channel opened with unreads lands on the boundary, not the newest',
    async ({ page, request }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width: 1440, height: 900 });
      await registerVerifiedUser(page, 'land');
      const token = await accessToken(page);
      const auth = { authorization: `Bearer ${token}` };
      const { wsId, chId } = await seedWorkspaceWithChannel(
        request,
        token,
        `land-${Date.now().toString(36)}`,
      );

      // A second channel, so the list can be remounted by switching away and back.
      const created = await request.post(`${API}/workspaces/${wsId}/channels`, {
        headers: auth,
        data: { name: 'elsewhere' },
      });
      const otherChId = (await created.json()).channel.id as string;

      // Enough rows, and enough of them AFTER the boundary, for the two
      // measured claims to be distinguishable: rows that group under one
      // author inside a day are 24px continuation lines, so the pane (752px
      // at this viewport) swallows well over twenty of them. MEASURED, not
      // assumed: the original 26 rows did not overflow the pane at all
      // (scrollHeight === clientHeight, max scroll 0) and the spec could
      // never have passed. 50 rows with the boundary at the 10th leaves 40
      // rows below it — more than the viewport, plus slack.
      // Paced: the mutation bucket is 25/10s per client, and a 429 here
      // leaves the pane empty in a way that reads like a product bug
      // (learned the hard way).
      const ROWS = 50;
      const FIRST_UNREAD = 9; // 0-based: the 10th oldest row is the first unread
      const ids: string[] = [];
      for (let i = 0; i < ROWS; i++) {
        const res = await request.post(`${API}/channels/${chId}/messages`, {
          headers: auth,
          data: { content: `landing row ${i + 1} — a line of chat with real vertical space` },
        });
        expect(res.status(), `row ${i + 1} is seeded`).toBe(201);
        ids.push((await res.json()).message.id as string);
        if (i < ROWS - 1) await new Promise((r) => setTimeout(r, 450));
      }

      await reloadIntoFirstWorkspace(page); // a plain reload restores Home
      await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
      await page.waitForTimeout(600);

      // Sanity: with no unread anywhere, the pane lands at the NEWEST row — the
      // behaviour the boundary must replace, and the behaviour the mocked
      // pane-layout spec pins.
      const before = await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
        return s
          ? { scrollTop: Math.round(s.scrollTop), max: s.scrollHeight - s.clientHeight }
          : null;
      });
      expect(before, 'the scroller exists').not.toBeNull();
      expect(
        before!.max - before!.scrollTop,
        'opens at the bottom when nothing is unread',
      ).toBeLessThanOrEqual(2);

      // The boundary: the 10th of 50 rows is the first unread one, leaving 40
      // rows of unread traffic below it — enough that "landed on the
      // boundary" and "landed at the newest" cannot be confused on screen.
      await page.evaluate(
        ({ channelId, lastReadId, count }) => {
          const store = (
            globalThis as {
              __cytaleStore?: { setState: (fn: (s: unknown) => unknown) => void };
            }
          ).__cytaleStore;
          store!.setState((s: { unreadByChannel: Record<string, unknown> }) => ({
            unreadByChannel: {
              ...s.unreadByChannel,
              [channelId]: {
                last_read_id: lastReadId,
                unread_count: count,
                mention_count: 0,
              },
            },
          }));
        },
        { channelId: chId, lastReadId: ids[FIRST_UNREAD - 1], count: ROWS - FIRST_UNREAD },
      );

      // Remount: away and back (the boundary is captured once per channel visit).
      await page.getByTestId(`channel-${otherChId}`).click();
      await page.waitForTimeout(400);
      await page.getByTestId(`channel-${chId}`).click();
      await expect(page.getByTestId('unread-divider')).toBeVisible({ timeout: 20_000 });
      await page.waitForTimeout(800);

      const measured = await page.evaluate(() => {
        const s = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]');
        const d = document.querySelector<HTMLElement>('[data-testid="unread-divider"]');
        if (!s || !d) return null;
        const sRect = s.getBoundingClientRect();
        const dRect = d.getBoundingClientRect();
        return {
          scrollTop: Math.round(s.scrollTop),
          max: s.scrollHeight - s.clientHeight,
          dividerTopInScroller: Math.round(dRect.top - sRect.top),
          dividerVisible: dRect.top >= sRect.top - 1 && dRect.bottom <= sRect.bottom + 1,
        };
      });

      expect(measured, 'the scroller and the NEW rule are both present').not.toBeNull();

      // THE CLAIM: not at the newest any more — the boundary is what the open
      // lands on, with the unread rows below it.
      expect(measured!.max - measured!.scrollTop, 'no longer pinned to the newest').toBeGreaterThan(
        200,
      );
      expect(measured!.dividerVisible, 'the NEW rule is inside the viewport').toBe(true);
      // And near the TOP of the pane (two rows of context above it — how much is
      // Virtuoso's row measurement, not a constant to pin).
      expect(
        measured!.dividerTopInScroller,
        'the boundary is near the top of the pane',
      ).toBeLessThan(200);
      expect(measured!.dividerTopInScroller, 'and below the very first pixel').toBeGreaterThan(-1);
    },
  );
});
