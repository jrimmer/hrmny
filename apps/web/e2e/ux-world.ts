/**
 * A small fixture world for the UX consistency specs: one workspace with a
 * #release channel, a human peer (Dana Scully, @dana), a machine peer (@mia,
 * an agent owned by the viewer), a thread, two DMs and an inbox holding a
 * markdown-bearing mention from the agent. No server, no database: every
 * `/api/v1/*` read is served here and the gateway is refused.
 */
import type { Page, Route } from '@playwright/test';

export const WS = '95000000001';
export const CH = '95000000002';
export const ME = '95000000003';
export const PEER = '95000000004';
export const BOT = '95000000005';
export const DM = '95000000006';
export const PARENT = '95000000100';
export const THREAD = '95000000200';

const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

const people = [
  { user: { id: PEER, username: 'dana', avatar_url: null }, nickname: 'Dana Scully', joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'human' },
  { user: { id: BOT, username: 'mia', avatar_url: null }, nickname: null, joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'bot', parent_user_id: ME },
  { user: { id: ME, username: 'e2e_viewer', avatar_url: null }, nickname: 'Jordan R', joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'human' },
];

export const MD = '**Confirmed working:** the `deploy` step on <#' + CH + '> — ping <@' + ME + '> if it _regresses_.';

const messages = [
  { id: PARENT, channel_id: CH, thread_id: null, author_id: PEER, content: 'Kicking off the release checklist for **v2.3**. Notes in `docs/release.md`.', created_at: ago(300), edited_at: null, attachments: null },
  { id: '95000000101', channel_id: CH, thread_id: null, author_id: BOT, content: MD, created_at: ago(200), edited_at: null, attachments: null },
  { id: '95000000102', channel_id: CH, thread_id: null, author_id: BOT, content: 'Second line from the bot, grouped.', created_at: ago(199), edited_at: null, attachments: null },
  { id: '95000000103', channel_id: CH, thread_id: null, author_id: ME, content: 'Thanks <@' + BOT + '>, looks good.', created_at: ago(60), edited_at: null, attachments: null,
    referenced_message_id: '95000000101',
    referenced: { message_id: '95000000101', author_id: BOT, author_username: 'mia', content: MD } },
  { id: '95000000104', channel_id: CH, thread_id: null, author_id: BOT, content: MD, created_at: ago(10), edited_at: null, attachments: null },
];

const thread = {
  id: THREAD, channel_id: CH, parent_message_id: PARENT, name: 'Release checklist', created_by: PEER, archived: false,
  message_count: 2, latest_reply_at: ago(90), member_state: { notify: true, last_read_id: null }, created_at: ago(280), updated_at: null,
};
const replies = [
  { id: '95000000300', channel_id: CH, thread_id: THREAD, author_id: PEER, content: 'Step 1 **done**.', created_at: ago(120), edited_at: null, attachments: null },
  { id: '95000000301', channel_id: CH, thread_id: THREAD, author_id: BOT, content: 'Step 2 `green`.', created_at: ago(90), edited_at: null, attachments: null },
  { id: '95000000302', channel_id: CH, thread_id: THREAD, author_id: BOT, content: MD, created_at: ago(10), edited_at: null, attachments: null },
];
const dmMessages = [
  { id: '95000000500', channel_id: DM, thread_id: null, author_id: PEER, content: 'Hey — got a sec for the **retro**?', created_at: ago(30), edited_at: null, attachments: null },
];

async function fulfill(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

export async function mockApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const method = route.request().method();
    if (method === 'POST' && path === '/auth/login')
      return fulfill(route, { access_token: 'e2e', refresh_token: 'e2e-r', expires_in: 3600 });
    if (path === '/users/@me')
      return fulfill(route, { user: { id: ME, username: 'e2e_viewer', display_name: null, email: 'e2e@local.test', email_verified: true, email_verified_at: '2026-09-01T00:00:00Z', avatar_url: null, created_at: '2026-09-01T00:00:00Z' } });
    if (path === '/users/@me/workspaces')
      return fulfill(route, { workspaces: [{ id: WS, name: 'Playground', icon_url: null, owner_id: ME, role_version: 1, created_at: '2026-09-01T00:00:00Z' }] });
    if (path === `/workspaces/${WS}/channels`)
      return fulfill(route, { channels: [{ id: CH, workspace_id: WS, name: 'release', type: 0, parent_id: null, topic: 'Ship it', position: 0, last_message_id: '95000000104', created_at: '2026-09-01T00:00:00Z' }] });
    if (path === '/users/@me/inbox')
      return fulfill(route, { items: [
        { message_id: '95000000302', channel_id: CH, thread_id: THREAD, author_id: BOT, author_username: 'mia', kind: 'mention', excerpt: MD, created_at: ago(10) },
        { message_id: '95000000300', channel_id: CH, thread_id: THREAD, author_id: PEER, author_username: 'dana', kind: 'mention', excerpt: 'can you check <@' + ME + '>? **urgent**', created_at: ago(120) },
      ], oldest_id: null });
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === '/users/@me/channels')
      return fulfill(route, { channels: [{ id: DM, type: 'dm', name: '', recipients: [{ id: PEER, username: 'dana', avatar_url: null }, { id: ME, username: 'e2e_viewer', avatar_url: null }], last_message_id: '95000000500' },
        { id: '95000000007', type: 'dm', name: '', recipients: [{ id: BOT, username: 'mia', avatar_url: null }], last_message_id: '95000000501' }] });
    if (path === '/users/@me/marks') return fulfill(route, { marks: [] });
    if (path === '/auth/methods') return fulfill(route, { password: true, webauthn: false });
    if (path === `/workspaces/${WS}/people` || path === `/workspaces/${WS}/members`) return fulfill(route, { people, members: people, next_before: null });
    if (path === `/channels/${CH}/threads`) return fulfill(route, { threads: [thread] });
    if (path === `/threads/${THREAD}/messages`) return fulfill(route, { messages: replies });
    if (path === `/channels/${CH}/messages`) return fulfill(route, { messages, oldest_id: null });
    if (path === `/channels/${DM}/messages`) return fulfill(route, { messages: dmMessages, oldest_id: null });
    if (path.endsWith('/call')) return fulfill(route, { call: null });
    if (path === `/workspaces/${WS}/search`)
      return fulfill(route, { results: [{ message_id: '95000000101', channel_id: CH, thread_id: null, score: 1 }, { message_id: PARENT, channel_id: CH, thread_id: null, score: 0.5 }], next_before: null });
    if (path === '/users/@me/omnisearch')
      return fulfill(route, { results: [
        { kind: 'workspace', message_id: '95000000101', channel_id: CH, thread_id: null, workspace_id: WS, author_id: BOT, content: MD, created_at: ago(200), score: 1 },
        { kind: 'dm', message_id: '95000000500', channel_id: DM, thread_id: null, workspace_id: null, author_id: PEER, content: 'Hey — got a sec for the **retro** after the deploy?', created_at: ago(30), score: 0.5 },
      ] });
    if (path === '/users/@me/two-factor') return fulfill(route, { mode_enabled: false, enrolled: false });
    if (path === '/users/@me/webauthn/credentials') return fulfill(route, { credentials: [] });
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });
  await page.evaluate(
    (me) => (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState({
      currentUser: { id: me, username: 'e2e_viewer' }, sessionEpoch: 1,
      presence: {},
    }),
    ME,
  );
  await page.waitForTimeout(800);
}

export async function openChannel(page: Page): Promise<void> {
  await page.goto(`/#/workspace/${WS}/channel/${CH}`);
  if (await page.locator('[data-testid="message-item"]').first().isVisible().catch(() => false)) return;
  await page.getByTestId(`workspace-${WS}`).click({ timeout: 4000 }).catch(() => {});
  await page.waitForTimeout(500);
  await page.getByTestId(`channel-${CH}`).click({ timeout: 4000 }).catch(() => {});
  await page.waitForSelector('[data-testid="message-item"]', { timeout: 10_000 });
}

