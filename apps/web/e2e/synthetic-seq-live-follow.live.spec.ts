/**
 * #143 — the synthetic seq space must never poison the replay gate.
 *
 * Mechanism (pre-fix): apps/web stamps local REST reconciles — the thread
 * backfill (`useThreads.loadReplies`), optimistic sends/edits, avatar
 * convergence — at s >= 1,000,001 through `applyGatewayEvent`, whose
 * advance guard folded every applied event's `s` into the store's
 * `lastSeq`. Real gateway seqs are per-session integers counting from 1
 * (server: `Cytale.Gateway.Session.buffer_event`; READY/RESUMED are
 * sequence-less control frames, s: 0), so one backfill raised the
 * watermark into the synthetic range and the replay gate then dropped
 * EVERY real dispatch until the next Ready/Resumed — a healthy socket
 * whose page stopped applying live events.
 *
 * The fix (packages/state reconcile.ts): seqs above SYNTHETIC_SEQ_FLOOR
 * are a separate synthetic space — they always apply and never advance
 * `lastSeq`. This spec drives the real page: open a thread (running the
 * real loadReplies backfill), then assert a live channel dispatch still
 * renders on the same page, no reload, with the watermark pinned to the
 * real range throughout.
 */
import { test, expect, type Page } from '@playwright/test';

import {
  accessToken,
  API,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedWorkspaceWithChannel,
} from './helpers';

/** Mirror of packages/state `SYNTHETIC_SEQ_FLOOR` (e2e runs outside the workspace graph). */
const SYNTHETIC_SEQ_FLOOR = 1_000_000;

interface StoreProbe {
  lastSeq: number;
  threadReplyCount: number;
}

/** The `__cytaleStore` dev probe: watermark + first thread slice's row count. */
async function probe(page: Page): Promise<StoreProbe> {
  return page.evaluate(() => {
    const store = (
      globalThis as {
        __cytaleStore?: {
          getState: () => {
            lastSeq: number;
            messagesByThread: Record<string, { items: unknown[] }>;
          };
        };
      }
    ).__cytaleStore;
    if (!store) throw new Error('__cytaleStore probe missing');
    const s = store.getState();
    const threadReplyCount =
      Object.values(s.messagesByThread)[0]?.items.length ?? 0;
    return { lastSeq: s.lastSeq, threadReplyCount };
  });
}

test('#143 — a thread backfill never advances lastSeq; a live dispatch still applies', async ({
  page,
  request,
}) => {
  test.setTimeout(90_000); // boot + hydrate races get real headroom
  await registerVerifiedUser(page, 'ss143');
  const token = await accessToken(page);
  const auth = { authorization: `Bearer ${token}` };
  const { chId } = await seedWorkspaceWithChannel(
    request,
    token,
    `ss143-${Date.now().toString(36)}`,
  );

  // Seed over REST before the page boots: an origin row, a thread on it,
  // two replies — the backfill's payload.
  const seedRes = await request.post(`${API}/channels/${chId}/messages`, {
    headers: auth,
    data: { content: 'ss143 origin' },
  });
  const seedId = (await seedRes.json()).message.id as string;
  const thRes = await request.post(
    `${API}/channels/${chId}/messages/${seedId}/threads`,
    { headers: auth, data: { name: 'ss143 thread' } },
  );
  expect(thRes.ok()).toBeTruthy();
  const threadId = (await thRes.json()).thread.id as string;
  for (const content of ['ss143 reply one', 'ss143 reply two']) {
    await request.post(`${API}/threads/${threadId}/messages`, {
      headers: auth,
      data: { content },
    });
  }

  // Open the channel by its hash route (same shape openBOnChannel rides in
  // live-dispatch.live.spec) — the known workspace-hydrate race gets the same
  // reload-retry shape — and wait for the boot stream to settle: READY
  // hydration advances lastSeq with REAL seqs. Then plant the marker.
  // (A plain reload restores the member's last location — Home — so the
  // boot is pointed at the first workspace instead.)
  await reloadIntoFirstWorkspace(page);
  await page
    .waitForSelector('[data-testid="message-item"]', { timeout: 20_000 })
    .catch(async () => {
      // The hydrate race: a reload re-runs the boot hydrate so the rail and
      // channel appear; a second reload covers the observed double-miss.
      await reloadIntoFirstWorkspace(page);
      await page
        .waitForSelector('[data-testid="message-item"]', { timeout: 20_000 })
        .catch(async () => {
          await reloadIntoFirstWorkspace(page);
          await page.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
        });
    });
  await expect
    .poll(async () => (await probe(page)).lastSeq, { timeout: 10_000 })
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    (globalThis as { __pageEpoch?: number }).__pageEpoch = 1;
  });
  const before = await probe(page);
  expect(before.lastSeq, 'boot watermark sits in the REAL seq range').toBeLessThan(
    SYNTHETIC_SEQ_FLOOR,
  );

  // The REAL backfill: opening the panel runs useThreads.loadReplies,
  // which feeds ThreadMessageCreate events with SYNTHETIC seqs through
  // applyGatewayEvent.
  await page.getByTestId('thread-indicator').click();
  await page.waitForSelector('[data-testid="thread-side-panel"]', { timeout: 10_000 });
  await expect
    .poll(async () => (await probe(page)).threadReplyCount, { timeout: 10_000 })
    .toBe(2); // the backfill APPLIED

  // THE INVARIANT: the synthetic reconcile never touched the watermark —
  // it still reads the real stream's range. (Pre-fix this read at
  // >= SYNTHETIC_SEQ_FLOOR + 1 and every live dispatch then dropped.)
  const afterBackfill = await probe(page);
  expect(afterBackfill.lastSeq, 'the watermark never entered the synthetic range').toBeLessThan(
    SYNTHETIC_SEQ_FLOOR,
  );

  // A real gateway dispatch on the healthy socket still applies: a REST
  // post fans out to this page's own session too (fan_out includes the
  // sender). It must render with NO reload, and the watermark must advance
  // — within the REAL range.
  const marker = `SS143-LIVE-${Date.now().toString(36)}`;
  const liveRes = await request.post(`${API}/channels/${chId}/messages`, {
    headers: auth,
    data: { content: marker },
  });
  expect(liveRes.ok()).toBeTruthy();
  await expect(
    page.locator('[data-testid="message-item"]', { hasText: marker }),
  ).toBeVisible({ timeout: 10_000 });
  const final = await probe(page);
  expect(final.lastSeq, 'the live dispatch advanced the watermark').toBeGreaterThan(
    afterBackfill.lastSeq,
  );
  expect(final.lastSeq).toBeLessThan(SYNTHETIC_SEQ_FLOOR);
  expect(
    await page.evaluate(() => (globalThis as { __pageEpoch?: number }).__pageEpoch),
    'the observation happened on the same live page',
  ).toBe(1);
});
