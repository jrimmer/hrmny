/**
 * The timeline in a real browser (#9–#15, lane U):
 *
 *   - an image row holds its height while the image loads (#10);
 *   - scrollback walks PAST the 500-row window to the first message and back
 *     down to the newest (#9), with the "Loading older" line shown at the top
 *     of the list, in its reserved band (#11);
 *   - your own message keeps its DOM row across the server confirm (#12);
 *   - leaving a channel and coming back restores where you were (#13), to
 *     the row and the pixel, across rows of very different heights;
 *   - a thread's replies are channel rows — avatar, tag, reactions,
 *     attachments, the hover toolbar (#15).
 *
 * No server and no database (the pane-layout.spec pattern): every
 * `/api/v1/*` call is served from the fixtures below — history pages honour
 * `before` / `after` / `limit` exactly as the server does (newest-first) —
 * and the gateway is refused. Screenshots land in test-results/lane-u/.
 */
import { deflateSync } from 'node:zlib';

import { expect, test, type Page, type Route } from '@playwright/test';

const OUT = 'test-results/lane-u';

// Ids stay well inside Number.MAX_SAFE_INTEGER (see pane-layout.spec).
const WS = '92000000001';
const CH = '92000000002';
const ME = '92000000003';
const PEER = '92000000004';
const CH2 = '92000000005';
const THREAD = '92000000009';
const BASE = 92000100000;

interface Row {
  id: string;
  channel_id: string;
  thread_id: string | null;
  author_id: string;
  content: string;
  created_at: string;
  edited_at: null;
  attachments?: unknown[] | null;
  reactions?: Array<{ emoji: string; count: number; me: boolean }>;
  content_proxy_urls?: Record<string, string>;
}

function row(i: number, over: Partial<Row> = {}): Row {
  return {
    id: String(BASE + i),
    channel_id: CH,
    thread_id: null,
    author_id: i % 3 === 0 ? ME : PEER,
    content: `history row ${i}`,
    created_at: new Date(Date.UTC(2026, 8, 1, 8, 0) + i * 60_000).toISOString(),
    edited_at: null,
    ...over,
  };
}

/** A solid-colour PNG of the given size. */
function png(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const line = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) line.set([88, 101, 242], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => line));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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
    // The `limit` rows CLOSEST to the anchor that are newer than it.
    slice = chrono.filter((m) => Number(m.id) > Number(after)).slice(0, limit);
  } else {
    const upto = before ? chrono.filter((m) => Number(m.id) < Number(before)) : chrono;
    slice = upto.slice(Math.max(0, upto.length - limit));
  }
  return slice.reverse();
}

interface Fixture {
  channel: Row[];
  second: Row[];
  replies: Row[];
  /** The thread hanging off a channel row, or null. */
  thread: { parent: string; count: number } | null;
  /** Held image bytes (resolved to release). */
  imageGate: Promise<void> | null;
  /** Delay for `before=` pages (so the loading line is observable). */
  olderDelayMs: number;
  /** Delay before a POST is confirmed. */
  postDelayMs: number;
  requests: string[];
}

async function mockApi(page: Page, fx: Fixture): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace('/api/v1', '');
    const method = route.request().method();
    fx.requests.push(`${method} ${path}${url.search}`);

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
          { id: WS, name: 'Timeline', icon_url: null, owner_id: ME, role_version: 1, created_at: '2026-09-01T00:00:00Z' },
        ],
      });
    }
    if (path === `/workspaces/${WS}/channels`) {
      const channel = (id: string, name: string, position: number) => ({
        id,
        workspace_id: WS,
        name,
        type: 0,
        parent_id: null,
        topic: null,
        position,
        last_message_id: null,
        created_at: '2026-09-01T00:00:00Z',
      });
      return fulfill(route, { channels: [channel(CH, 'general', 0), channel(CH2, 'elsewhere', 1)] });
    }
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    // The notification controls' one boot read: no overrides, no suppressions.
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
    if (path.startsWith('/attachments/')) {
      if (fx.imageGate) await fx.imageGate;
      return route.fulfill({ status: 200, contentType: 'image/png', body: png(640, 320) });
    }
    // A Markdown image's proxy copy (content_proxy_urls), a little late so
    // it lands after the rows around it have laid out.
    if (path === '/media/proxy') {
      await new Promise((r) => setTimeout(r, 150));
      return route.fulfill({ status: 200, contentType: 'image/png', body: png(320, 160) });
    }
    const threadSummary = () =>
      fx.thread === null
        ? null
        : {
            id: THREAD,
            channel_id: CH,
            parent_message_id: fx.thread.parent,
            name: 'deploy talk',
            created_by: ME,
            archived: false,
            message_count: fx.thread.count,
            latest_reply_at: fx.replies[fx.replies.length - 1]?.created_at ?? null,
            member_state: { notify: true, last_read_id: null },
            created_at: '2026-09-01T00:00:00Z',
          };
    if (path.endsWith('/threads')) {
      const t = threadSummary();
      return fulfill(route, { threads: t && !path.includes(CH2) ? [t] : [] });
    }
    if (path === `/threads/${THREAD}`) return fulfill(route, threadSummary() ?? {});
    if (path === `/threads/${THREAD}/messages`) {
      const items = pageOf(fx.replies, url.searchParams);
      return fulfill(route, { messages: items, oldest_id: items.at(-1)?.id ?? null });
    }
    if (path.includes('/reactions/')) return route.fulfill({ status: 204, body: '' });
    for (const [id, rows] of [
      [CH, fx.channel],
      [CH2, fx.second],
    ] as const) {
      if (path === `/channels/${id}/messages`) {
        if (method === 'POST') {
          const body = route.request().postDataJSON() as { content: string };
          await new Promise((r) => setTimeout(r, fx.postDelayMs));
          const newest = rows.reduce((n, m) => Math.max(n, Number(m.id)), BASE);
          const posted = row(newest - BASE + 1, { channel_id: id, author_id: ME, content: body.content });
          rows.push(posted);
          return fulfill(route, { message: posted });
        }
        if (url.searchParams.get('before')) await new Promise((r) => setTimeout(r, fx.olderDelayMs));
        const items = pageOf(rows, url.searchParams);
        return fulfill(route, { messages: items, oldest_id: items.at(-1)?.id ?? null });
      }
      if (path === `/channels/${id}/call`) return fulfill(route, { call: null });
    }
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

function fixture(over: Partial<Fixture> = {}): Fixture {
  return {
    channel: Array.from({ length: 30 }, (_, i) => row(i)),
    second: [row(9000, { channel_id: CH2, content: 'over here' })],
    replies: [],
    thread: null,
    imageGate: null,
    olderDelayMs: 0,
    postDelayMs: 0,
    requests: [],
    ...over,
  };
}

async function openChannel(page: Page, channelId = CH): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // ATTACHED, not visible: the boot cover stays over the shell until the
  // roster is known, and without a gateway that is only once the session
  // epoch below is seeded (lane D's one-pass boot).
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });
  // sessionEpoch 1 stands in for the READY the refused gateway never
  // delivers: since lane D's one-pass boot, the shell hydrates (the REST
  // roster fallback included) only once a session has been established.
  await page.evaluate(
    (me) =>
      (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState({
        currentUser: { id: me, username: 'e2e_viewer' },
        sessionEpoch: 1,
      }),
    ME,
  );
  await page.getByTestId(`channel-${channelId}`).click();
  await page.waitForSelector('[data-testid="message-item"]');
}

/** A message ROW (the reaction row carries the same data-message-id). */
const ROW = (id: string | number) => `[data-testid="message-item"][data-message-id="${id}"]`;

const scroller = (page: Page) =>
  page.locator('[data-testid="message-pane"] [data-virtuoso-scroller="true"]').first();

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

// -- #10 ---------------------------------------------------------------------

test('an image row reserves its box before the image loads (#10)', async ({ page }) => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const fx = fixture({
    imageGate: gate,
    channel: [
      ...Array.from({ length: 10 }, (_, i) => row(i)),
      row(10, {
        content: 'a picture',
        attachments: [
          { id: '92000900001', message_id: String(BASE + 10), filename: 'wide.png', content_type: 'image/png', size: 2048, url: '/api/v1/attachments/wide', width: 640, height: 320 },
        ],
      }),
      row(11, { content: 'below the picture' }),
    ],
  });
  await mockApi(page, fx);
  await openChannel(page);
  const box = page.getByTestId('attachment-image').first();
  await expect(box).toBeVisible();
  const rowEl = page.locator(ROW(BASE + 10));
  const before = (await box.boundingBox())!;
  const rowBefore = (await rowEl.boundingBox())!;
  // 640×320 clamped to 320 wide → 160 tall, before a single byte arrived.
  expect(Math.round(before.width)).toBe(320);
  expect(Math.round(before.height)).toBeGreaterThanOrEqual(159);
  await page.screenshot({ path: `${OUT}/image-row-before-load.png` });
  release();
  await expect
    .poll(() =>
      box.locator('img').evaluate((img) => (img as HTMLImageElement).complete && (img as HTMLImageElement).naturalWidth > 0),
    )
    .toBe(true);
  const after = (await box.boundingBox())!;
  const rowAfter = (await rowEl.boundingBox())!;
  expect(Math.round(after.height)).toBe(Math.round(before.height));
  expect(Math.round(rowAfter.height)).toBe(Math.round(rowBefore.height));
  await page.screenshot({ path: `${OUT}/image-row-after-load.png` });
});

// -- #12 ---------------------------------------------------------------------

test('your own message keeps its row across the server confirm (#12)', async ({ page }) => {
  const fx = fixture({ postDelayMs: 900 });
  await mockApi(page, fx);
  await openChannel(page);
  await page.evaluate(() => {
    const w = window as unknown as { __tagged?: boolean };
    new MutationObserver(() => {
      if (w.__tagged) return;
      const el = document.querySelector('[data-message-id^="pending_"]') as HTMLElement | null;
      if (el) {
        el.dataset.laneUTag = 'optimistic';
        w.__tagged = true;
      }
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  const composer = page.getByTestId('composer-input');
  await composer.click();
  await composer.pressSequentially('keyed by the placeholder');
  await composer.press('Enter');
  await expect(page.locator('[data-lane-u-tag="optimistic"]')).toHaveCount(1, { timeout: 5_000 });
  const confirmed = page.locator('[data-message-id]').filter({ hasText: 'keyed by the placeholder' }).first();
  await expect(confirmed).toHaveAttribute('data-message-id', /^\d+$/, { timeout: 10_000 });
  // The SAME node now carries the server id: the row was not remounted.
  await expect(confirmed).toHaveAttribute('data-lane-u-tag', 'optimistic');
});

// -- #13 ---------------------------------------------------------------------

test('leaving a channel and coming back restores the reading position (#13)', async ({ page }) => {
  const fx = fixture({ channel: Array.from({ length: 120 }, (_, i) => row(i)) });
  await mockApi(page, fx);
  await openChannel(page);
  const list = scroller(page);
  await list.hover();
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -500);
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(700);
  const firstVisible = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="message-item"]'));
      return rows.find((r) => r.getBoundingClientRect().bottom > top + 4)?.dataset.messageId ?? null;
    });
  const before = await firstVisible();
  expect(before).not.toBeNull();
  await page.getByTestId(`channel-${CH2}`).click();
  await expect(page.getByText('over here')).toBeVisible();
  await page.getByTestId(`channel-${CH}`).click();
  await page.waitForSelector('[data-testid="message-item"]');
  await page.waitForTimeout(700);
  console.log(
    `[restore] list restored attr=${await page.getByTestId('message-list').getAttribute('data-restored')}`,
  );
  const after = await firstVisible();
  console.log(`[restore] before=${before} after=${after}`);
  expect(after, 'the same row is at the top of the view').toBe(before);
  await page.screenshot({ path: `${OUT}/channel-restored.png` });
});

// -- #13, mixed row heights --------------------------------------------------

/**
 * A timeline whose rows differ wildly in height: author runs of varying
 * length (so group gaps come and go), a new day every 45 rows, image
 * attachments with reserved boxes, Markdown images through the media proxy,
 * and long messages that wrap over several lines.
 */
function mixedRow(i: number): Row {
  const over: Partial<Row> = {
    // Runs of 1, 2, 3 and 4 rows per author.
    author_id: [ME, PEER][Math.floor(i / ((i % 4) + 1)) % 2]!,
    created_at: new Date(Date.UTC(2026, 7, 1, 8, 0) + Math.floor(i / 45) * 86_400_000 + i * 60_000).toISOString(),
  };
  if (i % 7 === 3) {
    over.content = `picture ${i}`;
    over.attachments = [
      {
        id: String(92000800000 + i),
        message_id: String(BASE + i),
        filename: `p${i}.png`,
        content_type: 'image/png',
        size: 2048,
        url: `/api/v1/attachments/p${i}`,
        width: 640,
        height: 320,
      },
    ];
  } else if (i % 11 === 5) {
    const src = `https://images.example.test/w${i}.png`;
    over.content = `markdown image ${i}\n\n![whiteboard ${i}](${src})`;
    over.content_proxy_urls = { [src]: `/api/v1/media/proxy?u=w${i}&e=1900000000&s=sig${i}` };
  } else if (i % 5 === 1) {
    over.content = `long row ${i}: ` + 'the quick brown fox jumps over the lazy dog, '.repeat(14);
  }
  return row(i, over);
}

test('returning restores the exact reading line across mixed row heights (#13)', async ({ page }) => {
  test.setTimeout(90_000);
  const fx = fixture({ channel: Array.from({ length: 180 }, (_, i) => mixedRow(i)) });
  await mockApi(page, fx);
  await openChannel(page);
  const list = scroller(page);
  /** The top visible message and how far its top sits from the viewport's. */
  const readingLine = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const rows = Array.from(el.querySelectorAll<HTMLElement>('[data-testid="message-item"]'));
      const first = rows.find((r) => r.getBoundingClientRect().bottom > top + 4);
      return first
        ? { id: first.dataset.messageId ?? null, offset: Math.round(first.getBoundingClientRect().top - top) }
        : null;
    });
  const away = async () => {
    await page.getByTestId(`channel-${CH2}`).click();
    await expect(page.getByText('over here')).toBeVisible();
  };
  const back = async () => {
    await page.getByTestId(`channel-${CH}`).click();
    await page.waitForSelector('[data-testid="message-item"]');
    await expect(page.getByTestId('message-list')).toHaveAttribute('data-restored', 'true');
    // Past the restore's settle window and the late proxy images.
    await page.waitForTimeout(1_300);
  };

  // Two readings: one a few screens up, one deep enough to page older history.
  for (const [notches, label] of [
    [5, 'near'],
    [16, 'deep'],
  ] as const) {
    await list.hover();
    for (let i = 0; i < notches; i++) {
      await page.mouse.wheel(0, -430);
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(900);
    const before = await readingLine();
    expect(before?.id).toBeTruthy();
    // The offset is checked as well as the row: the top row is usually partly
    // scrolled out, and landing on it at a different offset is still a jump.
    await away();
    await back();
    const after = await readingLine();
    console.log(`[restore:${label}] before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    expect(after?.id, `${label}: the same row is at the top of the view`).toBe(before!.id);
    expect(Math.abs(after!.offset - before!.offset), `${label}: at the same offset`).toBeLessThanOrEqual(1);

    // And again, with nothing moved in between: a restore saves exactly what
    // it restored, so repeated visits do not creep.
    await away();
    await back();
    const again = await readingLine();
    expect(again?.id, `${label}: stable across a second return`).toBe(before!.id);
    expect(Math.abs(again!.offset - before!.offset)).toBeLessThanOrEqual(1);
  }
  await page.screenshot({ path: `${OUT}/channel-restored-mixed.png` });

  // Back at the live edge: the return lands on the newest message again.
  await list.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  for (let i = 0; i < 3; i++) {
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(150);
  }
  await expect(page.locator(ROW(BASE + 179))).toBeVisible();
  await page.waitForTimeout(500);
  await away();
  await page.getByTestId(`channel-${CH}`).click();
  await page.waitForSelector('[data-testid="message-item"]');
  await page.waitForTimeout(800);
  await expect(page.getByTestId('message-list')).not.toHaveAttribute('data-restored', 'true');
  const newest = (await page.locator(ROW(BASE + 179)).boundingBox())!;
  const view = (await list.boundingBox())!;
  expect(newest.y + newest.height).toBeLessThanOrEqual(view.y + view.height + 1);
  expect(newest.y + newest.height).toBeGreaterThan(view.y + view.height - 80);
});

// -- #9 / #11 ----------------------------------------------------------------

test('scrollback walks past the 500-row window to the first message and back (#9/#11)', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const COUNT = 620;
  // The first older page is held long enough to look at its indicator; the
  // walk after it pages at a normal pace.
  const fx = fixture({ channel: Array.from({ length: COUNT }, (_, i) => row(i)), olderDelayMs: 3000 });
  await mockApi(page, fx);
  await openChannel(page);
  const list = scroller(page);

  // #11: the indicator lives INSIDE the list's top band, where the reader is
  // looking — not below the full-height scroller.
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  const loading = page.getByTestId('loading-older');
  await expect(loading).toBeVisible({ timeout: 5_000 });
  const band = (await page.getByTestId('history-header').boundingBox())!;
  const view = (await list.boundingBox())!;
  expect(band.height).toBe(32);
  expect(band.y).toBeGreaterThanOrEqual(view.y - 1);
  expect(band.y + band.height).toBeLessThanOrEqual(view.y + view.height);
  await page.screenshot({ path: `${OUT}/scrollback-loading-older.png` });
  fx.olderDelayMs = 250;

  const oldest = page.locator(ROW(BASE));
  for (let i = 0; i < 60 && (await oldest.count()) === 0; i++) {
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(450);
  }
  await expect(oldest, 'the very first message is reachable past the window').toBeVisible();
  await expect(page.getByTestId('history-header')).toHaveCount(0);
  // The window slid: the newest rows are no longer held, and the list knows.
  await expect(page.getByTestId('newer-footer')).toHaveCount(1);
  expect(await page.getByTestId('message-item').count()).toBeGreaterThan(0);
  await page.screenshot({ path: `${OUT}/scrollback-first-message.png` });

  const newest = page.locator(ROW(BASE + COUNT - 1));
  for (let i = 0; i < 60 && (await newest.count()) === 0; i++) {
    await list.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(350);
  }
  await expect(newest, 'paging forward reaches the newest message').toBeVisible();
  await expect(page.getByTestId('newer-footer')).toHaveCount(0);
  expect(fx.requests.some((r) => r.includes('after='))).toBe(true);
  await page.screenshot({ path: `${OUT}/scrollback-back-to-newest.png` });
});

// -- author-group spacing (owner, 2026-09-29) --------------------------------

test('a new author gets breathing room; a same-author run stays tight; no row jumps', async ({
  page,
}) => {
  // Default authors: i % 3 === 0 → ME, else PEER — so 4→5 is a same-author
  // continuation and 5→6 an author change.
  const fx = fixture({ channel: Array.from({ length: 120 }, (_, i) => row(i)), olderDelayMs: 600 });
  await mockApi(page, fx);
  await openChannel(page);
  const list = scroller(page);
  const box = async (sel: string) => (await page.locator(sel).boundingBox())!;
  const newestBase = 120 - 50; // the first page holds the newest 50 rows
  const cont = 116; // PEER after PEER (grouped), near the newest end
  const start = 117; // ME after PEER (a new group)
  await page.locator(ROW(BASE + start)).scrollIntoViewIfNeeded();
  const prev = await box(ROW(BASE + cont - 1));
  const contBox = await box(ROW(BASE + cont));
  const startBox = await box(ROW(BASE + start));

  // Same author: the continuation row butts against the row above, as before.
  expect(Math.abs(contBox.y - (prev.y + prev.height))).toBeLessThanOrEqual(1);
  await expect(page.locator(ROW(BASE + cont))).toHaveAttribute('data-grouped', 'true');
  // New author: a clear gap between the two message boxes.
  const gap = startBox.y - (contBox.y + contBox.height);
  expect(gap).toBeGreaterThanOrEqual(12);
  expect(gap).toBeLessThanOrEqual(20);

  // The hover tint covers the message, not the gap above it: the tinted box
  // IS the row, and the gap belongs to its untinted wrapper.
  await page.locator(ROW(BASE + start)).hover();
  const tint = await page.locator(ROW(BASE + start)).evaluate((el) => {
    const wrap = el.closest('[data-testid="message-row"]') as HTMLElement;
    return {
      row: getComputedStyle(el).backgroundColor,
      wrap: getComputedStyle(wrap).backgroundColor,
      wrapTop: wrap.getBoundingClientRect().top,
      rowTop: el.getBoundingClientRect().top,
    };
  });
  expect(tint.row).not.toBe('rgba(0, 0, 0, 0)');
  expect(tint.wrap).toBe('rgba(0, 0, 0, 0)');
  expect(Math.round(tint.rowTop - tint.wrapTop)).toBe(Math.round(gap));
  // The toolbar rides the message, not the gap: its bottom edge overlaps
  // the row's top, as it did before the gap existed.
  const bar = await box(`${ROW(BASE + start)} [data-testid="message-actions"]`);
  expect(bar.y + bar.height).toBeGreaterThan(startBox.y);

  // Virtuoso measures each item's box: no margin may escape it. Consecutive
  // items abut exactly, so the measured sizes sum to the laid-out list.
  const drift = await list.evaluate((el) => {
    const items = [...el.querySelectorAll<HTMLElement>('[data-item-index]')];
    let worst = 0;
    for (let k = 1; k < items.length; k++) {
      const a = items[k - 1]!.getBoundingClientRect();
      const b = items[k]!.getBoundingClientRect();
      worst = Math.max(worst, Math.abs(b.top - a.bottom));
    }
    return worst;
  });
  expect(drift).toBeLessThanOrEqual(0.5);

  // Loading history keeps the reader's row where it was.
  await page.mouse.move(5, 5);
  await list.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  const anchorId = await page
    .locator('[data-testid="message-item"]')
    .first()
    .getAttribute('data-message-id');
  const before = await box(ROW(anchorId!));
  await expect(page.getByTestId('loading-older')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('loading-older')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(ROW(BASE + newestBase - 1))).toHaveCount(1);
  await page.waitForTimeout(300);
  const after = await box(ROW(anchorId!));
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(2);
});

// -- #15 ---------------------------------------------------------------------

test('a thread reply is a channel row: avatar, tag, reactions, attachment, toolbar (#15)', async ({
  page,
}) => {
  const parent = BASE + 20;
  const reply = (i: number, over: Partial<Row> = {}) =>
    row(1000 + i, { thread_id: THREAD, author_id: PEER, content: `reply ${i}`, ...over });
  const replies = [
    reply(0),
    reply(1, { content: 'with a thumbs up', reactions: [{ emoji: '👍', count: 2, me: true }] }),
    reply(2, {
      author_id: ME,
      content: 'and a picture',
      attachments: [
        { id: '92000900002', message_id: String(BASE + 1002), filename: 'shot.png', content_type: 'image/png', size: 2048, url: '/api/v1/attachments/shot', width: 640, height: 320 },
      ],
    }),
  ];
  const fx = fixture({
    channel: Array.from({ length: 30 }, (_, i) => row(i, i === 20 ? { content: 'let us discuss the deploy' } : {})),
    replies,
    thread: { parent: String(parent), count: replies.length },
  });
  await mockApi(page, fx);
  await openChannel(page);
  await page.locator(ROW(parent)).getByTestId('thread-indicator').click();
  const panel = page.getByTestId('thread-side-panel');
  await expect(panel).toBeVisible();
  const first = panel.locator(ROW(BASE + 1000));
  await expect(first).toBeVisible();
  await expect(first.getByTestId('message-author')).toHaveText('Pat Peer');
  await expect(first.getByTestId('message-author-tag')).toHaveText('@peer');
  await expect(first.getByTestId('message-avatar')).toBeVisible();
  const thumbs = panel.locator(ROW(BASE + 1001));
  await expect(thumbs.getByTestId('reaction-chip')).toContainText('2');
  await expect(panel.locator(ROW(BASE + 1002)).getByTestId('attachment-image')).toBeVisible();
  // The origin and the starter line sit above the first reply.
  await expect(panel.getByTestId('thread-started-line')).toBeVisible();
  await expect(panel.getByTestId('thread-parent-pin')).toBeVisible();
  // Hover builds the channel's own toolbar.
  await thumbs.hover();
  const toolbar = thumbs.getByTestId('message-actions');
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByTestId('action-copy-link')).toBeVisible();
  await page.screenshot({ path: `${OUT}/thread-panel-rows.png` });
  // A reaction from the thread lands on the THREAD row (own chip → removed).
  await thumbs.getByTestId('reaction-chip').click();
  await expect(thumbs.getByTestId('reaction-chip')).toContainText('1');
  expect(fx.requests.some((r) => r.startsWith('DELETE') && r.includes(`/messages/${BASE + 1001}/reactions/`))).toBe(true);
});

// -- live edge: a scrolled-up reader is never moved (live suite 2026-09-29) --

test('a message arriving below a scrolled-up reader does not move them', async ({ page }) => {
  // No read-state entry for the channel (no gateway READY here): the pane
  // claims its unread capture on the first commit that has one — and the
  // arrival below is that commit. It used to resolve the boundary THEN and
  // land on it, dragging the reader ~700px down to the new message.
  const fx = fixture({ channel: Array.from({ length: 60 }, (_, i) => row(i)) });
  await mockApi(page, fx);
  await openChannel(page);
  const list = scroller(page);
  await page.waitForTimeout(800);
  await list.hover();
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(600);
  const view = () =>
    list.evaluate((el) => {
      const top = el.getBoundingClientRect().top;
      const rows = [...el.querySelectorAll<HTMLElement>('[data-testid="message-item"]')];
      const first = rows.find((r) => r.getBoundingClientRect().bottom > top + 1)!;
      return {
        scrollTop: el.scrollTop,
        distanceToEnd: el.scrollHeight - el.clientHeight - el.scrollTop,
        firstId: first.getAttribute('data-message-id'),
        firstTop: Math.round(first.getBoundingClientRect().top - top),
      };
    });
  const before = await view();
  expect(before.distanceToEnd, 'the reader really left the live edge').toBeGreaterThan(100);

  await page.evaluate(
    ({ id, ch, peer }) =>
      (window as unknown as { __cytaleDispatch: (e: unknown) => void }).__cytaleDispatch({
        op: 0,
        t: 'MessageCreate',
        s: 1,
        d: {
          id, channel_id: ch, thread_id: null, author_id: peer, content: 'a live arrival below the reader',
          created_at: new Date().toISOString(), edited_at: null, attachments: null,
        },
      }),
    { id: String(BASE + 60), ch: CH, peer: PEER },
  );
  // The arrival is in the window (below the fold — virtualized, so asked of
  // the store), and the view has not moved: the same row at the same pixel.
  await page.waitForFunction(
    ({ ch, id }) => {
      const store = (window as unknown as {
        __cytaleStore: { getState: () => { messagesByChannel: Record<string, { items: Array<{ id: string }> }> } };
      }).__cytaleStore;
      return (store.getState().messagesByChannel[ch]?.items ?? []).some((m) => m.id === id);
    },
    { ch: CH, id: String(BASE + 60) },
  );
  await page.waitForTimeout(800);
  const after = await view();
  expect(after.firstId).toBe(before.firstId);
  expect(after.firstTop).toBe(before.firstTop);
  expect(after.scrollTop).toBe(before.scrollTop);
});
