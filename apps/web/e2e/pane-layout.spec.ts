/**
 * Pane formatting — the timeline presents the newest message IN FULL, above
 * the composer.
 *
 * User report (2026-09-10/11, two screenshots): the newest message was sliced
 * through its last line at the message box, reading as though the box were
 * drawn over the conversation, and it survived a hard refresh. Measurement in
 * a real browser showed the composer was never over the list at all: the
 * timeline's scroll settled short of the true end (~34px on a 30-row channel),
 * leaving the newest row clipped by the scroller's own bottom edge — and that
 * edge sits directly above the composer, so the cut lands on the box's border.
 *
 * This spec renders the REAL app in real Chromium and measures the result —
 * jsdom has no layout engine, so the unit suite cannot catch this class of bug.
 *
 * No server and no database: every `/api/v1/*` call is served from the
 * fixtures below and the gateway is refused. Pane formatting is a client
 * concern and is testable without Scylla; the fixture set asserts itself
 * complete, so a new boot-time fetch surfaces here as a fixture gap rather
 * than a mystery timeout.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

// Ids stay well inside Number.MAX_SAFE_INTEGER: values near the IEEE-754
// boundary lose precision on any numeric path, which silently collapses
// consecutive rows into one and makes the fixture lie about its own length.
const WS = '91000000001';
const CH = '91000000002';
const ME = '91000000003';
const PEER = '91000000004';

/** Deterministic history — long enough to overflow the pane and scroll. */
function messages() {
  return Array.from({ length: 30 }, (_, i) => ({
    id: String(91000001000 + i),
    channel_id: CH,
    thread_id: null,
    author_id: i % 2 === 0 ? PEER : ME,
    content:
      i === 29
        ? `message ${i + 1} — a line of chat that takes real vertical space, see [details](https://example.com)`
        : `message ${i + 1} — a line of chat that takes real vertical space`,
    created_at: new Date(Date.UTC(2026, 8, 10, 20, 30 + i)).toISOString(),
    edited_at: null,
    attachments: null,
  }));
}

async function fulfill(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Serve the whole API from fixtures. Anything not listed answers `{}` and is
 * recorded in `unmocked` (asserted empty by the tests).
 */
async function mockApi(page: Page, unmocked: string[]): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const path = pathname.replace('/api/v1', '');
    const method = route.request().method();

    if (method === 'POST' && path === '/auth/login') {
      return fulfill(route, {
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
        expires_in: 3600,
      });
    }
    if (path === '/users/@me') {
      // The wire envelope is `{user: …}` — session.ts reads `.user` off it.
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
          {
            id: WS,
            name: 'Pane Layout',
            icon_url: null,
            owner_id: ME,
            role_version: 1,
            created_at: '2026-09-01T00:00:00Z',
          },
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
    // The inbox and the DM roster are boot-time reads of the Home column
    // (the other session's work); this spec's fixtures are complete by
    // contract, so they answer empty rather than tripping the gap check.
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    // The notification controls' one boot read: no overrides, no suppressions.
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === '/users/@me/channels') return fulfill(route, { channels: [] });
    // The reminder store's one boot read (#54), and the sign-in surface probe
    // (#127): both answer "nothing here" for a pane-formatting test.
    if (path === '/users/@me/marks') return fulfill(route, { marks: [] });
    if (path === '/auth/methods') return fulfill(route, { password: true, webauthn: false });
    if (path.endsWith('/threads')) return fulfill(route, { threads: [] });
    if (path === `/workspaces/${WS}/people`) {
      // Rows are `{user: {…}}`-nested (features/directory/types.ts).
      return fulfill(route, {
        people: [
          {
            user: { id: PEER, username: 'peer', avatar_url: null },
            nickname: null,
            joined_at: '2026-09-01T00:00:00Z',
            roles: [],
            kind: 'human',
          },
        ],
        next_before: null,
      });
    }
    if (path === `/channels/${CH}/messages`) {
      if (method === 'POST') {
        // Echo the send back with an id past the fixture's newest, exactly
        // like the server does (the client reconciles its optimistic row).
        const posted = messages();
        const newest = posted[posted.length - 1]!;
        return fulfill(route, {
          message: {
            ...newest,
            id: String(91000002000),
            author_id: ME,
            content: 'posted from the composer',
            created_at: new Date(Date.UTC(2026, 8, 10, 21, 30)).toISOString(),
          },
        });
      }
      return fulfill(route, { messages: messages(), oldest_id: null });
    }
    // The pane's standing call-log read (R5) — empty on a quiet channel.
    if (path === `/channels/${CH}/call`) return fulfill(route, { call: null });

    unmocked.push(`${method} ${path}`);
    return fulfill(route, {});
  });
  // No gateway: the shell must boot REST-only (hydration runs without READY).
  await page.route('**/gateway/**', (route) => route.abort());
}

/** Sign in through the form and land on the channel with its history loaded. */
async function openChannel(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // ATTACHED, not visible: the boot cover stays over the shell until the
  // roster is known, and without a gateway that is only once the session
  // epoch below is seeded (lane D's one-pass boot).
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });

  // The send path gates on the STATE store's currentUser, which the gateway's
  // READY frame normally populates — it is refused here, so seed it through
  // the dev-only handle (session.ts). Harmless for the read-only cases.
  // sessionEpoch 1 stands in for the READY the refused gateway never
  // delivers: since lane D's one-pass boot, the shell hydrates (the REST
  // roster fallback included) only once a session has been established.
  await page.evaluate(
    (me) =>
      (window as unknown as { __cytaleStore: { setState: (s: object) => void } }).__cytaleStore.setState(
        { currentUser: { id: me, username: 'e2e_viewer' }, sessionEpoch: 1 },
      ),
    ME,
  );

  await page.getByTestId(`channel-${CH}`).click();
  await page.waitForSelector('[data-testid="message-item"]');
}

/**
 * The rects the contract is about, measured in the live document. Nothing here
 * scrolls: the spec is asserting where the APP left the timeline.
 */
async function paneGeometry(page: Page) {
  return await page.evaluate(() => {
    const list = document.querySelector('[data-testid="message-list"]');
    const well = document.querySelector('[data-testid="composer-well"]');
    const rows = Array.from(document.querySelectorAll('[data-testid="message-item"]'));
    if (!list || !well || rows.length === 0) return null;
    const scroller = list.querySelector('[data-virtuoso-scroller="true"]');
    const lb = list.getBoundingClientRect();
    const wb = well.getBoundingClientRect();
    const rb = rows[rows.length - 1]!.getBoundingClientRect();
    return {
      listBottom: Math.round(lb.bottom),
      wellTop: Math.round(wb.top),
      newestBottom: Math.round(rb.bottom),
      newestText: (rows[rows.length - 1]!.textContent ?? '').trim().slice(0, 80),
      /** The newest row runs past the scroller's edge — i.e. it is sliced. */
      clipped: rb.bottom > lb.bottom + 0.5,
      /** Daylight between the newest line and the message box. */
      gap: Math.round(wb.top - rb.bottom),
      atBottom:
        scroller !== null &&
        Math.abs(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) <= 2,
      scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
    };
  });
}

test.describe('pane formatting — timeline above the composer', () => {
  test('opening a channel shows the newest message in full, above the composer', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openChannel(page);
    // The rows settle after the first paint; this is the state the report
    // describes, with no scrolling and nothing posted.
    await page.waitForTimeout(700);

    const geo = await paneGeometry(page);
    expect(geo, 'pane geometry readable').not.toBeNull();
    expect(geo!.newestText, 'the last row is the newest message').toContain('message 30');
    expect(geo!.clipped, 'the newest row is not sliced by the scroller edge').toBe(false);
    expect(geo!.gap, 'the newest message clears the composer').toBeGreaterThanOrEqual(12);
    // The composer never rides over the timeline.
    expect(geo!.listBottom).toBeLessThanOrEqual(geo!.wellTop + 1);

    expect(unmocked, 'every boot-time request is covered by a fixture').toEqual([]);
  });

  test('posting a message brings it fully into view above the composer', async ({ page }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openChannel(page);

    // A person posting never scrolls by hand: they type and hit Enter.
    const composer = page.locator('[data-testid="message-compose"] [contenteditable="true"]');
    await composer.click();
    await composer.type('posted from the composer');
    await composer.press('Enter');
    await page.waitForTimeout(700);

    const geo = await paneGeometry(page);
    expect(geo, 'pane geometry readable after posting').not.toBeNull();
    expect(geo!.newestText, 'the posted message is the newest row').toContain(
      'posted from the composer',
    );
    expect(geo!.clipped, 'the posted row is not sliced by the scroller edge').toBe(false);
    expect(geo!.gap, 'the posted message clears the composer').toBeGreaterThanOrEqual(12);
    expect(geo!.atBottom, 'the timeline followed the new message to the end').toBe(true);
  });

  // The report that came back after the pin landed: "it works until a user
  // adds a reaction which is then now hiding behind the compose". A reaction
  // chip GROWS the newest row, and that growth flips Virtuoso's own "at the
  // bottom" reading false — so a pin that trusts it disarms itself exactly
  // when it is needed.
  test('a reaction on the newest message does not push it behind the composer', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openChannel(page);

    // React the way the UI does: the chip lands in the store slice the
    // reactions seam writes (features/messages/reactions.ts, patchReactions).
    // The slice holds raw server order (newest FIRST), so the target is the
    // highest id — not the last array element.
    const reacted = await page.evaluate(
      ({ ch }) => {
        const store = (
          window as unknown as {
            __cytaleStore: {
              getState: () => { messagesByChannel: Record<string, { items: unknown[] }> };
              setState: (s: object) => void;
            };
          }
        ).__cytaleStore;
        const state = store.getState();
        const slice = state.messagesByChannel[ch];
        if (!slice) return null;
        const newest = (slice.items as { id: string }[]).reduce((a, b) =>
          BigInt(a.id) >= BigInt(b.id) ? a : b,
        );
        const items = slice.items.map((m) =>
          (m as { id: string }).id === newest.id
            ? { ...(m as object), reactions: [{ emoji: '👍', count: 1, me: true }] }
            : m,
        );
        store.setState({
          messagesByChannel: { ...state.messagesByChannel, [ch]: { ...slice, items } },
        });
        return newest.id;
      },
      { ch: CH },
    );
    expect(reacted, 'the newest message was found in the store').not.toBeNull();
    await page.waitForTimeout(700);

    const geo = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="message-list"]');
      const well = document.querySelector('[data-testid="composer-well"]');
      const chips = Array.from(document.querySelectorAll('[data-testid="reaction-chip"]'));
      if (!list || !well || chips.length === 0) return null;
      const lb = list.getBoundingClientRect();
      const wb = well.getBoundingClientRect();
      // The lowest thing the row now renders: the reaction chip row.
      const lowest = Math.max(
        ...chips.map((c) => c.getBoundingClientRect().bottom),
        ...Array.from(document.querySelectorAll('[data-testid="message-item"]')).map(
          (r) => r.getBoundingClientRect().bottom,
        ),
      );
      return {
        listBottom: Math.round(lb.bottom),
        wellTop: Math.round(wb.top),
        lowest: Math.round(lowest),
        clipped: lowest > lb.bottom + 0.5,
        gap: Math.round(wb.top - lowest),
      };
    });

    expect(geo, 'the reacted row rendered a chip').not.toBeNull();
    expect(geo!.clipped, 'the reaction is not sliced by the scroller edge').toBe(false);
    expect(geo!.gap, 'the reacted row still clears the composer').toBeGreaterThanOrEqual(12);
  });

  // The pinning that fixes the above must never fight the reader: scrolling up
  // to read history and then receiving a message must not yank the view back to
  // the bottom.
  test('a message arriving while scrolled up does not yank the reader down', async ({ page }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openChannel(page);

    const before = await page.evaluate(() => {
      const s = document.querySelector(
        '[data-testid="message-list"] [data-virtuoso-scroller="true"]',
      );
      if (!s) return null;
      s.scrollTop = 0; // deliberate scroll-up to the oldest loaded message
      return Math.round(s.scrollTop);
    });
    expect(before, 'scrolled to the top').toBe(0);

    const composer = page.locator('[data-testid="message-compose"] [contenteditable="true"]');
    await composer.click();
    await composer.type('a message while reading history');
    await composer.press('Enter');
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => {
      const s = document.querySelector(
        '[data-testid="message-list"] [data-virtuoso-scroller="true"]',
      );
      return s ? Math.round(s.scrollTop) : null;
    });
    console.log('[pane-layout] scrollTop after posting while scrolled up:', after);
    expect(after, 'the reader stays where they were').toBeLessThanOrEqual(64);
  });
});

test.describe('message row affordances — the hover toolbar', () => {
  // The toolbar used to reveal on `group-focus-within:`, which a plain CLICK
  // satisfies (the row is tabIndex={-1}, so clicking focuses it). It stayed
  // pinned open over the message above, making that row's hover unreachable
  // (user report 2026-09-11). Reveal is now hover + `:focus-visible`.
  test('click does not latch it; hover and keyboard focus still reveal it', async ({ page }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openChannel(page);

    // The newest row: the fixture opens scrolled to the bottom, so rows
    // outside the virtualized window are not in the DOM at all.
    const row = page.getByTestId('message-item').last();
    const toolbar = row.getByTestId('message-actions').first();

    // Click, then take the POINTER AWAY — a click that keeps hovering the row
    // would reveal the toolbar via `group-hover:` and prove nothing.
    await row.click();
    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    expect(await toolbar.isVisible(), 'a click must not latch the toolbar').toBe(false);

    await row.hover();
    await page.waitForTimeout(300);
    expect(await toolbar.isVisible(), 'hover reveals it').toBe(true);

    await page.mouse.move(2, 2);
    await page.waitForTimeout(300);
    expect(await toolbar.isVisible(), 'leaving the row hides it').toBe(false);

    // Keyboard: Tab until focus lands inside a row (a markdown link in the
    // fixture is the in-row target). No pointer is over the row here.
    let insideRow = false;
    for (let i = 0; i < 60 && !insideRow; i += 1) {
      await page.keyboard.press('Tab');
      insideRow = await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[data-testid="message-item"]')),
      );
    }
    expect(insideRow, 'the fixture exposes a focusable element inside a row').toBe(true);
    await page.waitForTimeout(300);
    expect(
      await page.evaluate(() => {
        const host = document.activeElement?.closest('.message-actions-host');
        const bar = host?.querySelector('[data-testid="message-actions"]');
        return bar ? getComputedStyle(bar).display !== 'none' : null;
      }),
      'keyboard focus still reveals it',
    ).toBe(true);
  });
});
