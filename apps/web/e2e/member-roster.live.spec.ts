/**
 * The member roster stays complete and correct, live (2026-10-02).
 *
 *   1. BEYOND THE FIRST PAGE. Boot reads one people page (50) per workspace.
 *      A member beyond it rendered as a raw snowflake in messages, threads and
 *      the inbox. Here the workspace holds 50 members newer than the author,
 *      so the author's row is not on the viewer's first page; their message
 *      must still show their name, on the same live page.
 *   2. A BOT RENAME. The server's UserUpdate for a bot put the new LABEL in
 *      `username`, so the bot's @tag turned into its display name on every
 *      open client. Renamed while the viewer watches: the display name
 *      changes, the @tag does not.
 *   3. A BOT DELETION. Deleting a bot announced nothing, so it stayed in every
 *      open member list until a reload. Deleted while the viewer watches: it
 *      leaves the member list.
 *
 * Each test sets a same-page marker after the page settles and asserts it at
 * the end — a reload anywhere would erase it. Screenshots: ANCHOR_SHOT_DIR +
 * ANCHOR_SHOT_PREFIX (evidence runs) or the test's own output dir.
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
const LIVE_TIMEOUT = 20_000;

function shotPath(testInfo: TestInfo, name: string): string {
  const dir = process.env.ANCHOR_SHOT_DIR ?? testInfo.outputDir;
  mkdirSync(dir, { recursive: true });
  const prefix = process.env.ANCHOR_SHOT_PREFIX ?? 'roster';
  return join(dir, `${prefix}-${name}.png`);
}

type StoreView = {
  lastSeq: number;
  marker: number;
  member: { username?: string; display_name?: string | null; nickname?: string | null } | null;
  listed: boolean;
};

/** What the viewer's store holds for `id` in `wsId`, plus the same-page marker. */
async function storeView(page: Page, wsId: string, id: string): Promise<StoreView> {
  return page.evaluate(
    ([ws, uid]) => {
      const st = (globalThis as { __cytaleStore?: { getState: () => Record<string, unknown> } }).__cytaleStore;
      const s = st?.getState() as
        | {
            lastSeq: number;
            membersById: Record<string, { username?: string; display_name?: string | null; nickname?: string | null }>;
            memberIdsByWorkspace: Record<string, string[]>;
          }
        | undefined;
      return {
        lastSeq: s ? s.lastSeq : -1,
        marker: (globalThis as { __rosterEpoch?: number }).__rosterEpoch ?? 0,
        member: s?.membersById[uid!] ?? null,
        listed: (s?.memberIdsByWorkspace[ws!] ?? []).includes(uid!),
      };
    },
    [wsId, id],
  );
}

async function markSamePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    (globalThis as { __rosterEpoch?: number }).__rosterEpoch = 1;
  });
}

/** POST with the auth surface's per-IP budget honored (30 / 10 s): a 429 waits and retries. */
async function postPatiently(
  request: APIRequestContext,
  url: string,
  data: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const res = await request.post(url, { data, headers });
    if (res.status() !== 429) {
      return { status: res.status(), body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
    }
    const after = Number(res.headers()['retry-after'] ?? '2');
    await new Promise((r) => setTimeout(r, Math.max(1, after) * 1000));
  }
  throw new Error(`still rate-limited: ${url}`);
}

/** A user-owned bot granted read_write everywhere its owner is; its @tag read back. */
async function createBot(
  request: APIRequestContext,
  userToken: string,
): Promise<{ id: string; token: string; name: string; handle: string }> {
  const headers = { authorization: `Bearer ${userToken}` };
  const name = `Hermes ${Date.now()}`;
  const created = await request.post(`${API}/bots`, { headers, data: { name } });
  expect(created.status(), 'bot created').toBe(201);
  const { id, token } = (await created.json()) as { id: string; token: string };
  const granted = await request.patch(`${API}/bots/${id}`, {
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
  const handle = ((await granted.json()) as { username: string }).username;
  expect(handle, 'the bot has a handle').toBeTruthy();
  return { id, token, name, handle };
}

/** Viewer: registered, a workspace + channel, the page open on the channel with READY landed. */
async function viewerOnChannel(
  page: Page,
  request: APIRequestContext,
  label: string,
  beforeOpen?: (ctx: { token: string; wsId: string; chId: string }) => Promise<void>,
): Promise<{ token: string; wsId: string; chId: string; wsName: string }> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await registerVerifiedUser(page, `ros${label}`);
  const token = await accessToken(page);
  const wsName = `roster-${label}-${Date.now().toString(36)}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);
  if (beforeOpen) await beforeOpen({ token, wsId, chId });
  await openSeededChannel(page, wsName, chId);
  await expect.poll(async () => (await storeView(page, wsId, '0')).lastSeq, { timeout: 15_000 }).toBeGreaterThan(0);
  return { token, wsId, chId, wsName };
}

test.describe('the member roster stays complete and correct, live', () => {
  test('a member beyond the first people page shows by name, not digits, with no reload', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(300_000);
    let author: { id: string; username: string; token: string } | null = null;
    const FILLERS = 52;

    const { wsId, chId } = await viewerOnChannel(page, request, 'page', async ({ token, wsId }) => {
      // Off the app while the workspace fills: a live page would hear every
      // join (MemberAdd) and its device snapshot would carry the author's
      // row into the reload — the boot under test must come from the page.
      await page.goto('about:blank');
      const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
        headers: { authorization: `Bearer ${token}` },
        data: {},
      });
      const invBody = await inv.json();
      const code = (invBody.invite?.code ?? invBody.code) as string;

      // The AUTHOR joins first, so every later member has a higher id and the
      // first page (the 50 highest) leaves the author out.
      const user = makeE2EUser();
      await apiRegister(user);
      await verifyViaMailbox(user);
      const login = await postPatiently(request, `${API}/auth/login`, {
        identifier: user.username,
        password: user.password,
      });
      const authorToken = login.body.access_token as string;
      const joined = await request.post(`${API}/invites/${code}`, {
        headers: { authorization: `Bearer ${authorToken}` },
        data: {},
      });
      expect(joined.ok(), `the author joins (${joined.status()})`).toBe(true);
      const me = await request.get(`${API}/users/@me`, { headers: { authorization: `Bearer ${authorToken}` } });
      const meBody = (await me.json()) as { id?: string; user?: { id: string } };
      const authorId = meBody.id ?? meBody.user?.id;
      expect(authorId, 'the author’s id').toBeTruthy();
      author = { id: authorId!, username: user.username, token: authorToken };

      // 52 newer members (register-with-invite: one auth request each).
      for (let i = 0; i < FILLERS; i++) {
        const filler = makeE2EUser();
        const reg = await postPatiently(request, `${API}/auth/register`, { ...filler, invite_code: code });
        expect(reg.status, `filler ${i} registers into the workspace`).toBe(201);
      }

      // The fillers spent this IP's auth budget (30 / 10 s); let it refill
      // so the next test's registration is not throttled.
      await new Promise((r) => setTimeout(r, 11_000));
      await page.goto('/');

      const first = await request.get(`${API}/workspaces/${wsId}/people`, {
        headers: { authorization: `Bearer ${token}` },
      });
      const firstPage = (await first.json()) as { people: { user: { id: string } }[]; next_before: string | null };
      expect(firstPage.next_before, 'the roster is longer than one page').not.toBeNull();
      expect(
        firstPage.people.some((p) => p.user.id === author!.id),
        'the author is NOT on the first people page',
      ).toBe(false);
    });
    const who = author!;

    // Booted with the first page only: the store cannot name the author yet.
    expect((await storeView(page, wsId, who.id)).member, 'the author is not in the booted roster').toBeNull();
    await markSamePage(page);

    const text = `hello from beyond the first page ${Date.now()}`;
    const posted = await request.post(`${API}/channels/${chId}/messages`, {
      headers: { authorization: `Bearer ${who.token}` },
      data: { content: text },
    });
    expect(posted.status(), 'the author posts').toBe(201);

    const row = page.locator('[data-testid="message-item"]', { hasText: text });
    try {
      await expect(row.getByTestId('message-author'), 'the row names its author').toHaveText(who.username, {
        timeout: LIVE_TIMEOUT,
      });
      await expect(row.getByTestId('message-author')).not.toContainText(who.id);
    } finally {
      await page.screenshot({ path: shotPath(testInfo, 'beyond-page') });
    }

    const after = await storeView(page, wsId, who.id);
    expect(after.member?.username, 'the store holds the author’s row').toBe(who.username);
    expect(after.listed, 'and lists them in the workspace').toBe(true);
    expect(after.marker, 'observed on the same live page — no reload').toBe(1);
  });

  test('a bot renamed while the viewer watches: display name updated, @tag unchanged', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    let bot: Awaited<ReturnType<typeof createBot>> | null = null;
    const text = `deploy finished ${Date.now()}`;
    const { wsId } = await viewerOnChannel(page, request, 'rename', async ({ token, chId }) => {
      bot = await createBot(request, token);
      const posted = await request.post(`${V10}/channels/${chId}/messages`, {
        headers: { authorization: `Bot ${bot.token}` },
        data: { content: text },
      });
      expect(posted.ok(), `the bot posts (${posted.status()})`).toBe(true);
    });
    const b = bot!;
    const row = page.locator('[data-testid="message-item"]', { hasText: text });
    await expect(row.getByTestId('message-author')).toHaveText(b.name, { timeout: LIVE_TIMEOUT });
    await expect(row.getByTestId('message-author-tag')).toHaveText(`@${b.handle}`);
    await markSamePage(page);

    const renamed = `Hermes Prime ${Date.now()}`;
    const res = await request.patch(`${API}/bots/${b.id}`, {
      headers: { authorization: `Bearer ${await accessToken(page)}` },
      data: { name: renamed },
    });
    expect(res.status(), 'the owner renames the bot').toBe(200);

    try {
      await expect(row.getByTestId('message-author'), 'the display name updates live').toHaveText(renamed, {
        timeout: LIVE_TIMEOUT,
      });
      await expect(row.getByTestId('message-author-tag'), 'the @tag is still the handle').toHaveText(`@${b.handle}`);
      const directoryRow = page.getByTestId(`people-row-${b.id}`);
      await expect(directoryRow, 'the member list shows the new name').toContainText(renamed, {
        timeout: LIVE_TIMEOUT,
      });
      await expect(directoryRow).toContainText(`@${b.handle}`);
    } finally {
      await page.screenshot({ path: shotPath(testInfo, 'bot-rename') });
    }

    const view = await storeView(page, wsId, b.id);
    // The label is the display name (#168); the nickname is per-workspace
    // and unset (#169).
    expect(view.member, 'the roster row keeps the handle as username').toMatchObject({
      username: b.handle,
      display_name: renamed,
      nickname: null,
    });
    expect(view.marker, 'observed on the same live page — no reload').toBe(1);
  });

  test('a bot deleted while the viewer watches leaves the member list with no reload', async ({
    page,
    request,
  }, testInfo) => {
    test.setTimeout(180_000);
    let bot: Awaited<ReturnType<typeof createBot>> | null = null;
    const { wsId } = await viewerOnChannel(page, request, 'delete', async ({ token }) => {
      bot = await createBot(request, token);
    });
    const b = bot!;
    const directoryRow = page.getByTestId(`people-row-${b.id}`);
    await expect(directoryRow, 'the bot is in the member list').toBeVisible({ timeout: LIVE_TIMEOUT });
    await markSamePage(page);

    const res = await request.delete(`${API}/bots/${b.id}`, {
      headers: { authorization: `Bearer ${await accessToken(page)}` },
    });
    expect(res.status(), 'the owner deletes the bot').toBe(204);

    try {
      await expect(directoryRow, 'the bot leaves the member list live').toHaveCount(0, { timeout: LIVE_TIMEOUT });
    } finally {
      await page.screenshot({ path: shotPath(testInfo, 'bot-delete') });
    }
    const view = await storeView(page, wsId, b.id);
    expect(view.listed, 'and the workspace roster').toBe(false);
    expect(view.marker, 'observed on the same live page — no reload').toBe(1);
  });
});
