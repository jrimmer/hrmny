/**
 * A bot card click against the real server: the bot answers with a deferred
 * update and edits the card after the client's 10s fallback window, and
 * "No response yet" never appears — in a channel and in a thread.
 *
 * Owner report (2026-10-01, Hermes's "Allow Once" card in a thread): the
 * card showed "No response yet" beside "Your request completed". The server
 * now tells the clicker exactly when the bot answers (InteractionSuccess,
 * Discord's INTERACTION_SUCCESS), so a deferred ack resolves the click even
 * though it changes nothing on screen.
 *
 * The bot is real: a user-owned bot with a Discord-dialect gateway session
 * (Node's WebSocket) that reads its INTERACTION_CREATE, answers over the
 * compat callback, and edits @original — the discord.py/discord.js
 * `defer()` → `edit_original_response()` flow.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import {
  API,
  API_ORIGIN,
  accessToken,
  openSeededChannel,
  registerVerifiedUser,
  seedWorkspaceWithChannel,
} from './helpers';

const V10 = `${API_ORIGIN}/api/v10`;
const NO_RESPONSE = 'No response yet';

const row = (disabled: boolean, label = 'Allow Once') => [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label, custom_id: 'once', disabled },
      { type: 2, style: 4, label: 'Deny', custom_id: 'deny', disabled },
    ],
  },
];

interface BotGateway {
  /** The next dispatch named `t` (waits up to 20s). */
  next(t: string): Promise<Record<string, unknown>>;
  close(): void;
}

/** A Discord-dialect gateway session for the bot: Hello → Identify → READY,
 * heartbeats, and a dispatch queue. */
async function connectBot(token: string): Promise<BotGateway> {
  const url = `${API_ORIGIN.replace(/^http/, 'ws')}/gateway/websocket?v=10&encoding=json`;
  const ws = new WebSocket(url);
  const queue: Array<{ t: string; d: Record<string, unknown> }> = [];
  const waiters: Array<{ t: string; resolve: (d: Record<string, unknown>) => void }> = [];
  let seq: number | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;

  const ready = new Promise<void>((resolve, reject) => {
    ws.addEventListener('error', () => reject(new Error('bot gateway error')));
    ws.addEventListener('message', (ev) => {
      const frame = JSON.parse(String(ev.data)) as { op: number; t?: string; s?: number; d: unknown };
      if (frame.op === 10) {
        const interval = (frame.d as { heartbeat_interval: number }).heartbeat_interval;
        beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: seq })), interval);
        ws.send(
          JSON.stringify({
            op: 2,
            d: { token, intents: 0, properties: { os: 'linux', browser: 'e2e', device: 'e2e' } },
          }),
        );
        return;
      }
      if (frame.op !== 0 || !frame.t) return;
      if (typeof frame.s === 'number') seq = frame.s;
      if (frame.t === 'READY') resolve();
      const d = frame.d as Record<string, unknown>;
      const i = waiters.findIndex((w) => w.t === frame.t);
      if (i >= 0) waiters.splice(i, 1)[0]!.resolve(d);
      else queue.push({ t: frame.t, d });
    });
  });
  await ready;

  return {
    next(t: string) {
      const i = queue.findIndex((q) => q.t === t);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]!.d);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ${t} within 20s`)), 20_000);
        waiters.push({
          t,
          resolve: (d) => {
            clearTimeout(timer);
            resolve(d);
          },
        });
      });
    },
    close() {
      if (beat) clearInterval(beat);
      ws.close();
    },
  };
}

/** A user-owned bot with read_write everywhere its owner is. */
async function createBot(request: APIRequestContext, userToken: string): Promise<{ id: string; token: string }> {
  const headers = { authorization: `Bearer ${userToken}` };
  const created = await request.post(`${API}/bots`, { headers, data: { name: `Hermes ${Date.now()}` } });
  expect(created.status(), 'bot created').toBe(201);
  const bot = (await created.json()) as { id: string; token: string };
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

async function watchForNoResponse(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const w = window as unknown as { __sawNoResponse: boolean };
    w.__sawNoResponse = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes(text)) w.__sawNoResponse = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, NO_RESPONSE);
}

async function sawNoResponse(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawNoResponse: boolean }).__sawNoResponse);
}

/** The bot's side: defer (type 6), work past the 10s window, edit @original. */
async function deferThenEdit(
  request: APIRequestContext,
  gw: BotGateway,
  page: Page,
  button: ReturnType<Page['locator']>,
): Promise<void> {
  const interaction = await gw.next('INTERACTION_CREATE');
  const id = interaction.id as string;
  const token = interaction.token as string;
  const appId = interaction.application_id as string;

  const ack = await request.post(`${V10}/interactions/${id}/${token}/callback`, { data: { type: 6 } });
  expect(ack.ok(), `deferred update accepted (${ack.status()})`).toBe(true);
  // The ack alone resolves the click (nothing on screen changed).
  await expect(button).not.toHaveAttribute('data-pending', 'true', { timeout: 5_000 });

  await page.waitForTimeout(12_000);
  const edit = await request.patch(`${V10}/webhooks/${appId}/${token}/messages/@original`, {
    data: { content: '✅ Approved once', components: row(true, 'Allowed once') },
  });
  expect(edit.ok(), `@original edited (${edit.status()})`).toBe(true);
  await expect(button).toHaveText('Allowed once', { timeout: 10_000 });
  await expect(button).toBeDisabled();
}

test.describe('bot card clicks resolve on the bot’s answer (live)', () => {
  test('channel: defer, then an @original edit after 12s — "No response yet" never shows', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await registerVerifiedUser(page, 'cardresp');
    const token = await accessToken(page);
    const wsName = `cardresp-${Date.now()}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    const bot = await createBot(request, token);
    const gw = await connectBot(bot.token);
    try {
      await openSeededChannel(page, wsName, chId);
      await watchForNoResponse(page);

      const posted = await request.post(`${V10}/channels/${chId}/messages`, {
        headers: { authorization: `Bot ${bot.token}` },
        data: { content: '⚠️ **Hermes wants to run a command that needs your OK**', components: row(false) },
      });
      expect(posted.status()).toBe(201);
      const cardId = (await posted.json()).id as string;

      const button = page.locator(
        `[data-testid="component-block"][data-message-id="${cardId}"] [data-testid="component-button"][data-custom-id="once"]`,
      );
      await expect(button).toBeVisible({ timeout: 20_000 });
      await button.click();

      await deferThenEdit(request, gw, page, button);
      await page.waitForTimeout(1_000);
      await expect(page.getByText(NO_RESPONSE)).toHaveCount(0);
      expect(await sawNoResponse(page)).toBe(false);
    } finally {
      gw.close();
    }
  });

  test('thread: the same flow on a card the bot posted into a thread', async ({ page, request }) => {
    test.setTimeout(150_000);
    await registerVerifiedUser(page, 'cardresp');
    const token = await accessToken(page);
    const headers = { authorization: `Bearer ${token}` };
    const wsName = `cardresp-${Date.now()}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    const bot = await createBot(request, token);

    const seed = await request.post(`${API}/channels/${chId}/messages`, {
      headers,
      data: { content: 'run the deploy' },
    });
    const seedId = (await seed.json()).message.id as string;
    const th = await request.post(`${API}/channels/${chId}/messages/${seedId}/threads`, {
      headers,
      data: { name: 'deploy' },
    });
    const threadId = (await th.json()).thread.id as string;

    const gw = await connectBot(bot.token);
    try {
      // The card goes into the thread BEFORE the page loads (the thread
      // panel reads it on open), exactly as Hermes posts it: to the thread id.
      const posted = await request.post(`${V10}/channels/${threadId}/messages`, {
        headers: { authorization: `Bot ${bot.token}` },
        data: { content: '⚠️ **Hermes wants to run a command that needs your OK**', components: row(false) },
      });
      expect(posted.status()).toBe(201);
      const cardId = (await posted.json()).id as string;

      await openSeededChannel(page, wsName, chId);
      const indicator = page.locator(`[data-message-id="${seedId}"]`).getByTestId('thread-indicator');
      await expect(indicator).toBeVisible({ timeout: 20_000 });
      await indicator.click();
      const panel = page.getByTestId('thread-side-panel');
      await expect(panel).toBeVisible({ timeout: 15_000 });
      await watchForNoResponse(page);

      const button = panel.locator(
        `[data-testid="component-block"][data-message-id="${cardId}"] [data-testid="component-button"][data-custom-id="once"]`,
      );
      await expect(button).toBeVisible({ timeout: 20_000 });
      await button.click();

      await deferThenEdit(request, gw, page, button);
      await page.waitForTimeout(1_000);
      await expect(page.getByText(NO_RESPONSE)).toHaveCount(0);
      expect(await sawNoResponse(page)).toBe(false);
    } finally {
      gw.close();
    }
  });
});
