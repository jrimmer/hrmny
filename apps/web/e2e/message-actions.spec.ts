/**
 * Message hover toolbar — where it sits, and its hover-only contract.
 *
 * The placement is config-driven (features/messages/messageActionsPlacement.ts):
 * 'top-right' is the resting default — the horizontal pill at the message's
 * own top-right, lifted to straddle the row's top edge so it never covers the
 * text it acts on (owner report 2026-09-28) — and
 * 'left-rail' is the vertical stack in the gutter left of the message, kept
 * selectable for comparison. `localStorage` flips them per browser, so this
 * spec pins BOTH from the same markup.
 *
 * jsdom has no layout engine, so none of the geometry below is checkable in
 * the unit suite. Real Chromium, fixtures only — no server, no database.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const WS = '97000000001';
const CH = '97000000002';
const ME = '97000000003';
const PEER = '97000000004';
const SHORT = '97000000100';
const TALL = '97000000101';
const OTHER = '97000000102';

/** The row's own geometry constants (MessageItem): 16px padding + 40px avatar. */
const ROW_PADDING = 16;
const AVATAR = 40;
const GAP = 12;
/** The gutter the left rail centres in: padding + avatar + the content gap. */
const GUTTER = ROW_PADDING + AVATAR + GAP;

const msg = (id: string, author_id: string, content: string, minutes: number) => ({
  id,
  channel_id: CH,
  thread_id: null,
  author_id,
  content,
  created_at: new Date(Date.UTC(2026, 8, 12, 9, minutes)).toISOString(),
  edited_at: null,
  attachments: null,
});

const other = msg(OTHER, PEER, 'A neighbour above and below, to show what the toolbar overlaps.', 10);
const tall = msg(
  TALL,
  PEER,
  'A taller message so the rail has room to sit beside it.\n\nSecond paragraph with enough words to wrap onto another line and give the row real height to centre against.',
  5,
);
const short = msg(SHORT, ME, 'One line, mine (edit + delete present).', 0);

/**
 * Enough messages to push the timeline past the pane, so the NEWEST row lands
 * against the composer. That adjacency is the whole point: the pill is taller
 * than a one-line row, so its natural hang is *past* its own row's bottom, and
 * on the last row that hang met the pane's edge and got clipped (user report
 * 2026-09-15).
 */
const FILLED = Array.from({ length: 30 }, (_, i) =>
  msg(`9700000${2000 + i}`, i === 29 ? ME : PEER, `filler line ${i + 1} so the timeline fills the pane`, i),
);

async function fulfill(route: Route, body: unknown) {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockApi(page: Page, messages: unknown[] = [other, tall, short]): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    const method = route.request().method();
    if (method === 'POST' && path === '/auth/login') {
      return fulfill(route, { access_token: 'a', refresh_token: 'r', expires_in: 3600 });
    }
    if (path === '/users/@me') {
      return fulfill(route, {
        user: {
          id: ME,
          username: 'jordan',
          display_name: null,
          email: 'e@local.test',
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
          { id: WS, name: 'Playground', icon_url: null, owner_id: ME, role_version: 1, created_at: '2026-09-01T00:00:00Z' },
        ],
      });
    }
    if (path === `/workspaces/${WS}/channels`) {
      return fulfill(route, {
        channels: [
          { id: CH, workspace_id: WS, name: 'mia', type: 0, parent_id: null, topic: null, position: 0, last_message_id: null, created_at: '2026-09-01T00:00:00Z' },
        ],
      });
    }
    if (path === `/workspaces/${WS}/people`) {
      return fulfill(route, {
        people: [
          { user: { id: PEER, username: 'hermes', avatar_url: null }, nickname: null, joined_at: '2026-09-01T00:00:00Z', roles: [], kind: 'human' },
        ],
        next_before: null,
      });
    }
    if (path.endsWith('/threads')) return fulfill(route, { threads: [] });
    // The mention inbox is fetched at shell BOOT on every surface, not only on
    // Home — so a spec that leaves it to the `{}` fallback below crashes the
    // app before it renders (see `fetchInbox`). Stub it explicitly.
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    // The notification controls' one boot read: no overrides, no suppressions.
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === `/channels/${CH}/messages`) {
      return fulfill(route, { messages, oldest_id: null });
    }
    if (path === `/channels/${CH}/call`) return fulfill(route, { call: null });
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

/** Sign in and open the channel, with the current user seeded for own-message actions. */
async function openChannel(
  page: Page,
  placement?: 'top-right' | 'left-rail',
  messages?: unknown[],
): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.addInitScript((p) => {
    if (p) localStorage.setItem('cytale.message-actions-placement', p);
  }, placement ?? '');
  await mockApi(page, messages);
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
      (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState(
        { currentUser: { id: me, username: 'jordan' }, sessionEpoch: 1 },
      ),
    ME,
  );
  await page.getByTestId(`channel-${CH}`).click();
  await page.waitForSelector('[data-testid="message-item"]');
  await page.waitForTimeout(300);
}

/** Reveal the toolbar on a row and report its geometry against that row. */
async function revealedGeometry(page: Page, messageId: string) {
  const row = page.locator(`[data-message-id="${messageId}"]`);
  await row.hover();
  // The reveal is a CSS transition; let it finish before measuring.
  await page.waitForTimeout(300);
  return await page.evaluate((mid) => {
    const rowEl = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null;
    const bar = rowEl?.querySelector('[data-testid="message-actions"]') as HTMLElement | null;
    const scroller = rowEl?.closest('[data-virtuoso-scroller="true"]') as HTMLElement | null;
    if (!rowEl || !bar || !scroller) return null;
    const rb = rowEl.getBoundingClientRect();
    const bb = bar.getBoundingClientRect();
    const sb = scroller.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    return {
      placement: bar.dataset.placement ?? null,
      direction: cs.flexDirection,
      opacity: Number(cs.opacity),
      pointerEvents: cs.pointerEvents,
      row: { x: Math.round(rb.x), y: Math.round(rb.y), h: Math.round(rb.height), right: Math.round(rb.right) },
      bar: { x: Math.round(bb.x), y: Math.round(bb.y), w: Math.round(bb.width), h: Math.round(bb.height), right: Math.round(bb.right), bottom: Math.round(bb.bottom) },
      centreOffset: Math.round(bb.top + bb.height / 2 - (rb.top + rb.height / 2)),
      /** The bar floats over the row it acts on, not outside it. */
      overlapsRow: bb.top >= rb.top - 0.5 && bb.bottom <= rb.bottom + 0.5 && bb.right <= rb.right + 0.5,
      insideScroller: bb.top >= sb.top - 0.5 && bb.bottom <= sb.bottom + 0.5,
      /** Top-right: how far the pill's bottom reaches into its own row. */
      rowOverlap: Math.round(bb.bottom - rb.top),
      /** The pill's bottom against the top of the message text. */
      clearOfText: (() => {
        const body = rowEl.querySelector('[data-testid="message-content"]');
        return body === null ? null : bb.bottom <= body.getBoundingClientRect().top + 0.5;
      })(),
      /** Left-rail only: the bar's centre within the row's gutter. */
      gutterCentreDelta: Math.round(
        bb.x + bb.width / 2 - (rb.x + (16 + 40 + 12) / 2),
      ),
      children: Array.from(bar.children).map((c) => {
        const el = c as HTMLElement;
        return {
          // The rule is the only control without a testid of its own.
          key: el.dataset.testid ?? 'divider',
          order: getComputedStyle(el).order,
        };
      }),
    };
  }, messageId);
}

test.describe('message hover toolbar — top-right (default)', () => {
  test('hover-only, floating over the row’s own top-right', async ({ page }) => {
    await openChannel(page);

    // At rest the toolbar takes no space at all: a laid-out bar would add its
    // overflow to the scroller and move the timeline's settle point. It is
    // built on a row's first hover (#14), so at rest it is either absent or
    // `hidden`.
    const restClasses = await page.evaluate(
      () => document.querySelector('[data-testid="message-actions"]')?.className ?? null,
    );
    expect(restClasses === null || restClasses.includes('hidden'), 'hidden (or unbuilt) at rest').toBe(
      true,
    );

    const hovered = await revealedGeometry(page, TALL);
    expect(hovered, 'toolbar geometry readable on hover').not.toBeNull();
    expect(hovered!.placement, 'the default placement is the pill').toBe('top-right');
    expect(hovered!.direction, 'a horizontal bar').toBe('row');
    expect(hovered!.opacity, 'revealed on hover').toBe(1);
    expect(hovered!.pointerEvents, 'interactive once shown').toBe('auto');
    // At the message's own top-right, whole inside the pane (a row at the
    // pane's top is pushed down just enough; the straddle itself is pinned on
    // a mid-pane row in the FILLED test below).
    expect(hovered!.insideScroller, 'never clipped by the pane').toBe(true);
    expect(hovered!.row.right - hovered!.bar.right, 'inset from the row’s right edge').toBeLessThan(20);

    // The pill keeps DOM order, no CSS reordering — asserted on my own message,
    // which carries all six controls (edit + delete exist only for the author).
    const own = await revealedGeometry(page, SHORT);
    expect(
      own!.children.every((c) => c.order === '0'),
      'the pill does not reorder its controls',
    ).toBe(true);
    expect(own!.children[0]?.key, 'the react control leads').toBe('reaction-picker-root');
    // Copy Link (#114) sits beside Reply — the two share actions stay
    // adjacent, which is also the order shell.css gives the rail. This list
    // predated #114 and had gone stale; the spec is the only thing that
    // notices a reordered toolbar, so it has to name every control.
    expect(own!.children.map((c) => c.key), 'composer order, left to right').toEqual([
      'reaction-picker-root',
      'divider',
      'action-reply',
      'action-copy-link',
      // #54 "Remind me…" — a personal action beside the share action.
      'mark-picker-root',
      'action-start-thread',
      'action-edit',
      'action-delete',
    ]);
  });

  test('a one-line NEWEST row beside the composer keeps its whole pill on screen', async ({
    page,
  }) => {
    await openChannel(page, 'top-right', FILLED);

    // The premise: the timeline fills the pane, so the newest row sits against
    // its bottom edge with the composer directly beneath it. Without that
    // adjacency this test would pass for the wrong reason.
    const newest = FILLED[FILLED.length - 1]!.id;
    const gap = await page.evaluate(
      ([mid]) => {
        const rowEl = document.querySelector(`[data-message-id="${mid}"]`) as HTMLElement | null;
        const scroller = rowEl?.closest('[data-virtuoso-scroller="true"]') as HTMLElement | null;
        if (!rowEl || !scroller) return null;
        return {
          below: Math.round(scroller.getBoundingClientRect().bottom - rowEl.getBoundingClientRect().bottom),
          rows: document.querySelectorAll('[data-testid="message-item"]').length,
        };
      },
      [newest],
    );
    expect(gap, 'the newest row is the fixture’s last one').not.toBeNull();
    expect(gap!.below, 'the newest row hugs the pane’s bottom edge').toBeLessThanOrEqual(8);

    // The pill is 46px on a 24px row, so its resting hang runs past the pane
    // and was clipped — it read as having flipped the wrong way (user report
    // 2026-09-15, with a screenshot of exactly that).
    const geo = await revealedGeometry(page, newest);
    expect(geo, 'toolbar geometry readable on hover').not.toBeNull();
    expect(geo!.bar.h, 'the pill is taller than a one-line row').toBeGreaterThan(24);
    expect(geo!.insideScroller, 'every action stays reachable, not clipped by the pane').toBe(
      true,
    );
    await expect(
      page.locator(`[data-message-id="${newest}"] [data-testid="action-reply"]`),
    ).toBeVisible();

    // …and an ordinary mid-pane row gets the resting geometry: the pill rides
    // above its message, touching its own row by a few px, never over its text
    // (owner report 2026-09-28: at `top: 4px` it hid the first line).
    const resting = await revealedGeometry(page, FILLED[10]!.id);
    expect(resting!.rowOverlap, 'touches its own row').toBeGreaterThanOrEqual(0);
    expect(resting!.rowOverlap, 'only its bottom edge rests on the row').toBeLessThanOrEqual(8);
    expect(resting!.clearOfText, 'never covers the message text').toBe(true);
    expect(resting!.insideScroller).toBe(true);
  });
});

test.describe('message hover toolbar — left rail (config override)', () => {
  test('centred in the gutter and on the row, controls in the asked-for order', async ({ page }) => {
    await openChannel(page, 'left-rail');
    const hovered = await revealedGeometry(page, TALL);
    expect(hovered, 'toolbar geometry readable on hover').not.toBeNull();
    expect(hovered!.placement, 'the override wins').toBe('left-rail');
    expect(hovered!.direction, 'stacked vertically').toBe('column');
    expect(hovered!.opacity, 'revealed on hover').toBe(1);
    // Vertically centred on the message it acts on…
    expect(Math.abs(hovered!.centreOffset), 'centred on the row').toBeLessThanOrEqual(1);
    // …and horizontally centred in the gutter: the row's 16px padding + 40px
    // avatar + 12px gap = 68px, so the bar's centre lands at 34px.
    expect(Math.abs(hovered!.gutterCentreDelta), 'centred in the gutter').toBeLessThanOrEqual(1);

    // Reading order top→bottom: the rule, reply, thread, edit, delete, and the
    // react emoji LAST (user direction 2026-09-12).
    const own = await revealedGeometry(page, SHORT);
    const orderOf = (key: string) =>
      Number(own!.children.find((c) => c.key === key)?.order ?? NaN);
    expect(orderOf('divider'), 'the rule leads the stack').toBeLessThan(orderOf('action-reply'));
    expect(orderOf('action-reply')).toBeLessThan(orderOf('action-start-thread'));
    expect(orderOf('action-start-thread')).toBeLessThan(orderOf('action-edit'));
    expect(orderOf('action-edit')).toBeLessThan(orderOf('action-delete'));
    expect(orderOf('action-delete'), 'the react emoji is last (bottom)').toBeLessThan(
      orderOf('reaction-picker-root'),
    );
  });

  test('a one-line row near the top of the pane keeps its whole rail on screen', async ({ page }) => {
    await openChannel(page, 'left-rail');
    // SHORT is my own message (react, rule, reply, thread, edit, delete — the
    // tallest rail) and sits first in the visible list, where a centred 225px
    // rail ran off the top of the scroller and hid its own reply action.
    const geo = await revealedGeometry(page, SHORT);
    expect(geo!.bar.h, 'the tallest rail is the own-message set').toBeGreaterThan(200);
    expect(geo!.insideScroller, 'every action stays reachable').toBe(true);
    await expect(
      page.locator(`[data-message-id="${SHORT}"] [data-testid="action-reply"]`),
    ).toBeVisible();
  });
});
