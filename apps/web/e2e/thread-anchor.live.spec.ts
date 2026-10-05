/**
 * Invisible threads (2026-10-02) — a thread SOMEONE ELSE starts on your
 * message shows its reply chip live, with no reload.
 *
 * The owner's bot (Hermes) answered approval and clarify prompts by starting a
 * thread on the owner's message (`POST /channels/:cid/messages/:mid/threads`)
 * and posting into it. The owner's open client never drew the chip on the seed
 * message: the live `ThreadCreate` carried no `parent_message_id`, and the
 * reducer ignored any anchor an event could carry, so the thread had nowhere to
 * hang until a reload refetched the roster. The prompts timed out unanswered.
 *
 * Two creators, because the fix is general and not a bot special case: a bot
 * through the compat API (Discord's start-from-message route, `Bot` token), and
 * a second human through the native API. Each time the viewer A sits on the
 * channel with the page open; the other principal starts the thread on A's
 * message and replies twice; A's seed row must grow the chip ("2 replies") on
 * the SAME page (a JS-context marker proves no reload happened), and clicking
 * it opens the thread with the replies.
 *
 * Screenshots: `ANCHOR_SHOT_DIR` + `ANCHOR_SHOT_PREFIX` (evidence runs) or the
 * test's own output dir. The seed-row shot is taken whether or not the chip
 * appeared, so a failing run still shows what the viewer saw.
 */
import { test, expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  accessToken,
  API,
  API_ORIGIN,
  apiRegister,
  makeE2EUser,
  openSeededChannel,
  registerVerifiedUser,
  seedWorkspaceWithChannel,
  verifyViaMailbox,
} from './helpers';

const V10 = `${API_ORIGIN}/api/v10`;
const CHIP_TIMEOUT = 20_000;

function shotPath(testInfo: TestInfo, name: string): string {
  const dir = process.env.ANCHOR_SHOT_DIR ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  const prefix = process.env.ANCHOR_SHOT_PREFIX ?? 'ta';
  return join(dir, `${prefix}-${name}.png`);
}

/** A user-owned bot with read_write everywhere its owner is (the Hermes shape). */
async function createBot(
  request: APIRequestContext,
  userToken: string,
): Promise<{ id: string; token: string; name: string }> {
  const headers = { authorization: `Bearer ${userToken}` };
  const name = `Hermes ${Date.now()}`;
  const created = await request.post(`${API}/bots`, { headers, data: { name } });
  expect(created.status(), 'bot created').toBe(201);
  const bot = { ...((await created.json()) as { id: string; token: string }), name };
  const granted = await request.patch(`${API}/bots/${bot.id}`, {
    headers,
    data: {
      access: {
        v: 1,
        dms: 'read_write',
        dm_support: 'humans',
        workspaces: { mode: 'all', level: 'read_write', grants: {} },
      },
    },
  });
  expect(granted.ok(), `bot granted (${granted.status()})`).toBe(true);
  return bot;
}

/** A second, verified human joined to the workspace through an invite. */
async function secondMember(
  request: APIRequestContext,
  ownerToken: string,
  wsId: string,
): Promise<{ token: string; username: string }> {
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  const login = await request.post(`${API}/auth/login`, {
    data: { identifier: user.username, password: user.password },
  });
  const token = (await login.json()).access_token as string;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${ownerToken}` },
    data: {},
  });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
  const joined = await request.post(`${API}/invites/${code}`, {
    headers: { authorization: `Bearer ${token}` },
    data: {},
  });
  expect(joined.ok(), `the second member joins (${joined.status()})`).toBe(true);
  return { token, username: user.username };
}

/** The viewer's store watermark + the same-page marker. */
async function viewerState(page: Page): Promise<{ lastSeq: number; epoch: number }> {
  return page.evaluate(() => {
    const st = (globalThis as { __cytaleStore?: { getState: () => { lastSeq: number } } }).__cytaleStore;
    return {
      lastSeq: st ? st.getState().lastSeq : -1,
      epoch: (globalThis as { __anchorEpoch?: number }).__anchorEpoch ?? 0,
    };
  });
}

/**
 * Viewer A: a workspace + channel, A's own seed message, and A's page open on
 * the channel with the gateway READY. Everything after this is live.
 */
async function viewerOnChannel(
  page: Page,
  request: APIRequestContext,
  label: string,
): Promise<{ tokenA: string; viewerName: string; wsId: string; chId: string; seedId: string; seedText: string }> {
  await page.setViewportSize({ width: 1440, height: 900 });
  const viewerName = await registerVerifiedUser(page, `anc${label}`);
  const tokenA = await accessToken(page);
  const wsName = `anchor-${label}-${Date.now().toString(36)}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, tokenA, wsName);
  const seedText = `please approve the ${label} deploy`;
  const seed = await request.post(`${API}/channels/${chId}/messages`, {
    headers: { authorization: `Bearer ${tokenA}` },
    data: { content: seedText },
  });
  expect(seed.status(), 'A posts the seed message').toBe(201);
  const seedId = (await seed.json()).message.id as string;

  await openSeededChannel(page, wsName, chId);
  await expect(page.locator(`[data-testid="message-item"][data-message-id="${seedId}"]`)).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () => (await viewerState(page)).lastSeq, { timeout: 15_000 })
    .toBeGreaterThan(0);
  // Same-page marker: a reload anywhere below would erase it.
  await page.evaluate(() => {
    (globalThis as { __anchorEpoch?: number }).__anchorEpoch = 1;
  });
  // No chip yet — the seed has no thread.
  await expect(page.locator(`[data-testid="message-item"][data-message-id="${seedId}"]`).getByTestId('thread-indicator')).toHaveCount(0);
  return { tokenA, viewerName, wsId, chId, seedId, seedText };
}

/**
 * The assertion both creators share: the chip appears LIVE on A's seed row with
 * the reply count, on the same page; then it opens the thread with the replies.
 */
async function expectLiveChip(
  page: Page,
  testInfo: TestInfo,
  name: string,
  seedId: string,
  replies: string[],
): Promise<void> {
  const seedRow = page.locator(`[data-testid="message-item"][data-message-id="${seedId}"]`);
  const chip = seedRow.getByTestId('thread-indicator');
  try {
    await expect(chip, 'the seed row grows the reply chip with no reload').toContainText(
      `${replies.length} replies`,
      { timeout: CHIP_TIMEOUT },
    );
  } finally {
    await seedRow.scrollIntoViewIfNeeded().catch(() => {});
    await page.screenshot({ path: shotPath(testInfo, `${name}-seed`) });
  }
  expect((await viewerState(page)).epoch, 'observed on the same live page — no reload').toBe(1);

  await chip.click();
  await expect(page.getByTestId('thread-dock')).toBeVisible({ timeout: 15_000 });
  const pane = page.getByTestId('thread-replies');
  for (const text of replies) {
    await expect(pane.getByText(text), `the thread shows "${text}"`).toBeVisible({ timeout: 15_000 });
  }
  await page.screenshot({ path: shotPath(testInfo, `${name}-thread`) });
  expect((await viewerState(page)).epoch, 'still the same live page').toBe(1);
}

/**
 * Bot attribution (2026-10-02): with the thread open, the creator's replies
 * carry the creator's NAME (never the raw snowflake) and, for a machine, the
 * kind badge; the header names the creator as the one who started the thread —
 * never the viewer, whose message the thread hangs off. The ids the store
 * holds are logged so a failure shows which lookup missed.
 */
async function expectAttribution(
  page: Page,
  testInfo: TestInfo,
  name: string,
  creator: { name: string; id: string | null; kind: 'bot' | null },
  viewerName: string,
  replyText: string,
): Promise<void> {
  const pane = page.getByTestId('thread-replies');
  const ids = await page.evaluate(() => {
    const st = (globalThis as { __cytaleStore?: { getState: () => Record<string, unknown> } }).__cytaleStore;
    if (!st) return null;
    const s = st.getState() as {
      membersById: Record<string, { username?: string; nickname?: string | null; kind?: string }>;
      threadsById: Record<string, { created_by?: string; name?: string }>;
      messagesByThread: Record<string, { items: { author_id: string }[] }>;
    };
    return {
      members: Object.entries(s.membersById).map(([id, m]) => `${id}:${m.nickname ?? m.username}:${m.kind ?? '-'}`),
      threads: Object.entries(s.threadsById).map(([id, t]) => `${id}:created_by=${t.created_by}`),
      replyAuthors: Object.entries(s.messagesByThread).map(
        ([id, sl]) => `${id}:${[...new Set(sl.items.map((m) => m.author_id))].join(',')}`,
      ),
    };
  });
  console.log(`[attribution ${name}] store ids`, JSON.stringify(ids));
  try {
    // The creator's first reply row (the pinned seed above it is the viewer's).
    const reply = pane.locator('[data-testid="message-item"]', { hasText: replyText });
    await expect(reply.getByTestId('message-author'), 'the reply row names its author').toHaveText(creator.name, {
      timeout: 15_000,
    });
    if (creator.id !== null) {
      await expect(pane.getByTestId('message-author').filter({ hasText: creator.id })).toHaveCount(0);
    }
    if (creator.kind !== null) {
      await expect(
        reply.locator(`[data-testid="message-avatar"] [data-testid="kind-badge"][data-kind="${creator.kind}"]`),
        'the reply avatar carries the kind badge',
      ).toBeAttached();
    }
    const started = page.getByTestId('thread-started-line');
    await expect(started, 'the header names who started the thread').toContainText(
      `${creator.name} started this thread`,
    );
    await expect(started).not.toContainText(viewerName);
  } finally {
    await page.screenshot({ path: shotPath(testInfo, `${name}-attribution`) });
  }
}

test.describe('a thread someone else starts on your message shows live (invisible threads)', () => {
  test('a BOT starts it through the compat API; the viewer sees the chip and the replies', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { tokenA, viewerName, chId, seedId } = await viewerOnChannel(page, request, 'bot');
    const bot = await createBot(request, tokenA);
    const botHeaders = { authorization: `Bot ${bot.token}` };

    const started = await request.post(`${V10}/channels/${chId}/messages/${seedId}/threads`, {
      headers: botHeaders,
      data: { name: 'Approval: deploy', auto_archive_duration: 1440 },
    });
    expect(started.status(), 'the bot starts a thread on the viewer’s message').toBe(200);
    const threadId = (await started.json()).id as string;

    const replies = ['Hermes needs your OK to run the deploy', 'Reply here to approve or deny'];
    for (const content of replies) {
      const posted = await request.post(`${V10}/channels/${threadId}/messages`, {
        headers: botHeaders,
        data: { content },
      });
      expect(posted.ok(), `the bot replies in its thread (${posted.status()})`).toBe(true);
    }

    await expectLiveChip(page, testInfo, 'bot', seedId, replies);
    await expectAttribution(page, testInfo, 'bot', { name: bot.name, id: bot.id, kind: 'bot' }, viewerName, replies[0]!);
  });

  test('a second HUMAN starts it through the native API; the viewer sees the chip and the replies', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    const { tokenA, viewerName, wsId, chId, seedId } = await viewerOnChannel(page, request, 'human');
    const { token: tokenB, username: nameB } = await secondMember(request, tokenA, wsId);
    const b = { authorization: `Bearer ${tokenB}` };

    const started = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers: b,
      data: { name: 'second opinion' },
    });
    expect(started.status(), 'B starts a thread on A’s message').toBe(201);
    const threadId = (await started.json()).thread.id as string;

    const replies = ['B looked at it', 'Ship it once CI is green'];
    for (const content of replies) {
      const posted = await request.post(`${API}/threads/${threadId}/messages`, { headers: b, data: { content } });
      expect(posted.status(), 'B replies in the thread').toBe(201);
    }

    await expectLiveChip(page, testInfo, 'human', seedId, replies);
    await expectAttribution(page, testInfo, 'human', { name: nameB, id: null, kind: null }, viewerName, replies[0]!);
  });
});
