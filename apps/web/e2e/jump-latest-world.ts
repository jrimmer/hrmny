/**
 * The fixture world for jump-to-latest.spec.ts (no server, no database — the
 * timeline-window.spec pattern): every `/api/v1/*` call is served from the
 * rows below, history pages honour `before` / `after` / `limit` exactly as
 * the server cuts them (newest-first, exclusive cursors), and the gateway is
 * refused. Live traffic is injected through the dev store's dispatch handle.
 */
import { expect, type Page, type Route } from '@playwright/test';

// Ids stay well inside Number.MAX_SAFE_INTEGER (see pane-layout.spec).
export const WS = '93000000001';
export const CH = '93000000002';
export const ME = '93000000003';
export const PEER = '93000000004';
export const THREAD = '93000000009';
export const BASE = 93000100000;
/** The thread's seed: a channel row near the newest end. */
export const PARENT_INDEX = 110;

export interface Row {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: null;
  attachments: null;
}

export function row(i: number, over: Partial<Row> = {}): Row {
  return {
    id: String(BASE + i),
    channel_id: CH,
    thread_id: null,
    author_id: i % 3 === 0 ? ME : PEER,
    content: `history row ${i}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 8, 0) + i * 60_000).toISOString(),
    edited_at: null,
    attachments: null,
    ...over,
  };
}

export function reply(i: number): Row {
  return row(5000 + i, {
    thread_id: THREAD,
    author_id: i % 2 === 0 ? PEER : ME,
    content: `thread reply ${i} — enough replies that the thread scrolls`,
  });
}

async function fulfill(route: Route, body: unknown, status = 200): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** A history page exactly as the server cuts it: newest-first, exclusive cursors. */
function pageOf(all: readonly Row[], params: URLSearchParams): Row[] {
  const limit = Number(params.get('limit') ?? 50);
  const before = params.get('before');
  const after = params.get('after');
  const chrono = [...all].sort((a, b) => Number(a.id) - Number(b.id));
  let slice: Row[];
  if (after) {
    slice = chrono.filter((m) => Number(m.id) > Number(after)).slice(0, limit);
  } else {
    const upto = before ? chrono.filter((m) => Number(m.id) < Number(before)) : chrono;
    slice = upto.slice(Math.max(0, upto.length - limit));
  }
  return slice.reverse();
}

export interface World {
  channel: Row[];
  replies: Row[];
  requests: string[];
}

export function world(count: number, replies = 0): World {
  return {
    channel: Array.from({ length: count }, (_, i) =>
      row(i, i === PARENT_INDEX ? { content: 'let us discuss the deploy' } : {}),
    ),
    replies: Array.from({ length: replies }, (_, i) => reply(i)),
    requests: [],
  };
}

export async function mockApi(page: Page, w: World): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const method = route.request().method();
    w.requests.push(`${method} ${path}${url.search}`);

    if (method === 'POST' && path === '/auth/login') {
      return fulfill(route, { access_token: 't', refresh_token: 'r', expires_in: 3600 });
    }
    if (path === '/users/@me') {
      return fulfill(route, {
        user: {
          id: ME,
          username: 'e2e_viewer',
          display_name: null,
          email: 'e2e@local.test',
          email_verified: true,
          email_verified_at: '2026-09-01T00:00:00Z',
          avatar_url: null,
          created_at: '2026-09-01T00:00:00Z',
        },
      });
    }
    if (path === '/users/@me/workspaces') {
      return fulfill(route, {
        workspaces: [
          { id: WS, name: 'Jump', icon_url: null, owner_id: ME, role_version: 1, created_at: '2026-09-01T00:00:00Z' },
        ],
      });
    }
    if (path === `/workspaces/${WS}/channels`) {
      return fulfill(route, {
        channels: [
          {
            id: CH,
            workspace_id: WS,
            name: 'general',
            type: 0,
            parent_id: null,
            topic: null,
            position: 0,
            last_message_id: null,
            created_at: '2026-09-01T00:00:00Z',
          },
        ],
      });
    }
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === '/users/@me/channels') return fulfill(route, { channels: [] });
    if (path === '/users/@me/marks') return fulfill(route, { marks: [] });
    if (path === '/auth/methods') return fulfill(route, { password: true, webauthn: false });
    if (path === `/workspaces/${WS}/people`) {
      return fulfill(route, {
        people: [
          { user: { id: PEER, username: 'peer', avatar_url: null }, nickname: 'Pat Peer', joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'human' },
          { user: { id: ME, username: 'e2e_viewer', avatar_url: null }, nickname: null, joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'human' },
        ],
        next_before: null,
      });
    }
    const thread = () =>
      w.replies.length === 0
        ? null
        : {
            id: THREAD,
            channel_id: CH,
            parent_message_id: String(BASE + PARENT_INDEX),
            name: 'deploy talk',
            created_by: ME,
            archived: false,
            message_count: w.replies.length,
            latest_reply_at: w.replies[w.replies.length - 1]!.created_at,
            member_state: { notify: true, last_read_id: null },
            created_at: '2026-09-01T00:00:00Z',
          };
    if (path.endsWith('/threads')) {
      const t = thread();
      return fulfill(route, { threads: t ? [t] : [] });
    }
    if (path === `/threads/${THREAD}`) return fulfill(route, thread() ?? {});
    if (path === `/threads/${THREAD}/messages`) {
      const items = pageOf(w.replies, url.searchParams);
      return fulfill(route, { messages: items, oldest_id: items.at(-1)?.id ?? null });
    }
    // The permalink resolver's single-message read (#114).
    const one = path.match(new RegExp(`^/channels/${CH}/messages/(\\d+)$`));
    if (one && method === 'GET') {
      const found = w.channel.find((m) => m.id === one[1]);
      return found ? fulfill(route, { message: found }) : fulfill(route, { error: 'not_found' }, 404);
    }
    if (path === `/channels/${CH}/messages` && method === 'GET') {
      const items = pageOf(w.channel, url.searchParams);
      return fulfill(route, { messages: items, oldest_id: items.at(-1)?.id ?? null });
    }
    if (path === `/channels/${CH}/call`) return fulfill(route, { call: null });
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

/** Sign in, stand in for the READY the refused gateway never sends, open #general. */
export async function openChannel(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });
  await page.evaluate(
    (me) =>
      (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState({
        currentUser: { id: me, username: 'e2e_viewer' },
        sessionEpoch: 1,
      }),
    ME,
  );
  // By route, not by the sidebar row: at phone width the sidebar is a drawer.
  await page.evaluate(
    ({ ws, ch }) => {
      window.location.hash = `#/workspace/${ws}/channel/${ch}`;
    },
    { ws: WS, ch: CH },
  );
  await page.waitForSelector('[data-testid="message-pane"] [data-testid="message-item"]', { timeout: 15_000 });
}

/** A live MessageCreate, as the gateway would deliver it. */
export async function arrive(page: Page, i: number, over: Partial<Row> = {}): Promise<void> {
  await page.evaluate(
    (d) =>
      (window as unknown as { __cytaleDispatch: (e: unknown) => void }).__cytaleDispatch({
        op: 0,
        t: 'MessageCreate',
        s: 1,
        d,
      }),
    row(i, { created_at: new Date().toISOString(), content: `a live arrival ${i}`, ...over }),
  );
}

/** A message ROW (the reaction row carries the same data-message-id). */
export const ROW = (id: string | number) => `[data-testid="message-item"][data-message-id="${id}"]`;

export type Scope = 'channel' | 'thread';

/** The scope's pane: the channel pane outside the thread panel, or the panel. */
export function pane(page: Page, scope: Scope) {
  return scope === 'thread'
    ? page.getByTestId('thread-side-panel')
    : page.getByTestId('message-pane');
}

export function scroller(page: Page, scope: Scope = 'channel') {
  return pane(page, scope).locator('[data-testid="message-list"] [data-virtuoso-scroller="true"]').first();
}

export function jumpButton(page: Page, scope: Scope = 'channel') {
  return pane(page, scope).locator('[data-testid="message-list"] [data-testid="jump-to-latest"]').first();
}

/** Wheel the scope's list up by `notches` × 500px, as a reader does. */
export async function wheelUp(page: Page, scope: Scope, notches: number): Promise<void> {
  await scroller(page, scope).hover();
  for (let i = 0; i < notches; i++) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(400);
}

/** The bottom of a row against the bottom of the scope's scroller. */
export async function rowInView(page: Page, scope: Scope, id: string | number): Promise<boolean> {
  const el = pane(page, scope).locator(ROW(id));
  if ((await el.count()) === 0) return false;
  const r = await el.boundingBox();
  const v = await scroller(page, scope).boundingBox();
  if (!r || !v) return false;
  return r.y + r.height <= v.y + v.height + 1 && r.y >= v.y - 1;
}

export async function expectNewestInView(page: Page, scope: Scope, id: string | number): Promise<void> {
  await expect.poll(() => rowInView(page, scope, id), { timeout: 10_000 }).toBe(true);
}

export async function openThread(page: Page): Promise<void> {
  const indicator = page.locator(ROW(BASE + PARENT_INDEX)).getByTestId('thread-indicator');
  await indicator.scrollIntoViewIfNeeded();
  await indicator.click();
  await expect(page.getByTestId('thread-side-panel')).toBeVisible({ timeout: 10_000 });
  await page.waitForSelector('[data-testid="thread-side-panel"] [data-testid="message-item"]');
  await page.waitForTimeout(500);
}
