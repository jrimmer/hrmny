/**
 * Thread pane (Discord reference, 2026-09-12).
 *
 * User report: "I clicked to start a thread on a long message and I can't
 * scroll to the bottom of it and the composer's missing. I also don't care
 * for the gray background."
 *
 * Measured in this spec's first run: the origin message was a PINNED block
 * with no height bound, so a 40-line origin rendered 783px tall on a 900px
 * viewport. That starved the reply list to `clientHeight: 0` — scrollHeight
 * 224, unreachable — and pushed the composer to `bottom: 929`, below the
 * fold. The pane itself was `--color-surface` (#2e2e34), a gray slab to the
 * right of a much darker message pane.
 *
 * jsdom has no layout engine, so none of this is checkable in the unit suite.
 * This spec renders the REAL app in real Chromium against fixtures — no
 * server, no database — and measures the pane the way the user sees it.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

// Ids stay well inside Number.MAX_SAFE_INTEGER (see pane-layout.spec.ts).
const WS = '95000000001';
const CH = '95000000002';
const ME = '95000000003';
const PEER = '95000000004';
const PARENT = '95000000100';
const THREAD = '95000000200';

/** A long origin — the shape of the report: 40 code lines plus prose. */
const LONG_ORIGIN = [
  'Runtime **~16 min** — exporter verified',
  '',
  '```',
  ...Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the long report body`),
  '```',
  '',
  'One note: the card is verified and ready.',
].join('\n');

const parent = {
  id: PARENT,
  channel_id: CH,
  thread_id: null,
  author_id: PEER,
  content: LONG_ORIGIN,
  created_at: new Date(Date.UTC(2026, 7, 16, 17, 0)).toISOString(),
  edited_at: null,
  attachments: null,
};

const thread = {
  id: THREAD,
  channel_id: CH,
  parent_message_id: PARENT,
  name: 'Long report thread',
  created_by: PEER,
  archived: false,
  message_count: 3,
  latest_reply_at: new Date(Date.UTC(2026, 7, 26, 18, 20)).toISOString(),
  member_state: { notify: true, last_read_id: null },
  created_at: new Date(Date.UTC(2026, 7, 26, 18, 17)).toISOString(),
  updated_at: null,
};

const replies = Array.from({ length: 3 }, (_, i) => ({
  id: String(95000000300 + i),
  channel_id: CH,
  thread_id: THREAD,
  author_id: ME,
  content: `reply ${i + 1} — a line of thread chat with some length to it`,
  created_at: new Date(Date.UTC(2026, 7, 26, 18, 18 + i)).toISOString(),
  edited_at: null,
  attachments: null,
}));

async function fulfill(route: Route, body: unknown): Promise<void> {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function mockApi(
  page: Page,
  unmocked: string[],
  /** Every request the app made, as `METHOD /path` — the write recorder. */
  requests: string[] = [],
  /** Fixture knobs: the channel's existing thread roster (default: one). */
  opts: {
    existingThread?: boolean;
    /** Hold the thread create's answer this long (a slow server). */
    createDelayMs?: number;
    /** The origin's text (default: the long report). */
    originContent?: string;
  } = {},
): Promise<void> {
  /** Replies posted into the thread this run created (its GET serves them). */
  const posted: unknown[] = [];
  await page.route('**/api/v1/**', async (route) => {
    const { pathname } = new URL(route.request().url());
    const path = pathname.replace('/api/v1', '');
    const method = route.request().method();
    requests.push(`${method} ${path}`);

    if (method === 'POST' && path === '/auth/login') {
      return fulfill(route, {
        access_token: 'e2e-access-token',
        refresh_token: 'e2e-refresh-token',
        expires_in: 3600,
      });
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
          {
            id: WS,
            name: 'Threads',
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
            name: 'mia',
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
    // Boot-time reads of the Home column (the other session's inbox work);
    // this spec answers every request by contract, so they answer empty.
    if (path === '/users/@me/inbox') return fulfill(route, { items: [], oldest_id: null });
    // The notification controls' one boot read: no overrides, no suppressions.
    if (path === '/users/@me/notification-preferences') return fulfill(route, { preferences: [], suppress_broadcasts: [] });
    if (path === '/users/@me/channels') return fulfill(route, { channels: [] });
    // The reminder store's boot read (#54) and the sign-in surface probe
    // (#127), as pane-layout serves them — both answer "nothing here".
    if (path === '/users/@me/marks') return fulfill(route, { marks: [] });
    if (path === '/auth/methods') return fulfill(route, { password: true, webauthn: false });
    if (path === `/workspaces/${WS}/people`) {
      return fulfill(route, {
        people: [
          {
            user: { id: PEER, username: 'peer', avatar_url: null },
            nickname: null,
            joined_at: '2026-09-01T00:00:00Z',
            roles: [],
            kind: 'human',
          },
          {
            user: { id: ME, username: 'e2e_viewer', avatar_url: null },
            nickname: null,
            joined_at: '2026-09-01T00:00:00Z',
            roles: [],
            kind: 'human',
          },
        ],
        next_before: null,
      });
    }
    if (path === `/channels/${CH}/threads`)
      return fulfill(route, { threads: opts.existingThread === false ? [] : [thread] });
    // A thread created by its first reply: the server returns it with NO
    // replies yet (they arrive as the next request).
    if (method === 'POST' && path === `/channels/${CH}/messages/${PARENT}/threads`) {
      const body = route.request().postDataJSON() as { name?: string } | null;
      if (opts.createDelayMs) await new Promise((r) => setTimeout(r, opts.createDelayMs));
      return fulfill(route, {
        thread: {
          ...thread,
          name: body?.name ?? thread.name,
          message_count: 0,
          latest_reply_at: null,
        },
      });
    }
    if (method === 'POST' && path === `/threads/${THREAD}/messages`) {
      const body = route.request().postDataJSON() as { content?: string } | null;
      const message = {
        id: '95000000400',
        channel_id: CH,
        thread_id: THREAD,
        author_id: ME,
        content: body?.content ?? '',
        created_at: new Date().toISOString(),
        edited_at: null,
      };
      posted.unshift(message);
      return fulfill(route, { message });
    }
    if (method === 'GET' && path === `/threads/${THREAD}/messages`) {
      // A thread this run created holds only what this run posted into it.
      return fulfill(route, { messages: opts.existingThread === false ? posted : replies });
    }
    if (path === `/channels/${CH}/messages`) {
      return fulfill(route, {
        messages: [opts.originContent ? { ...parent, content: opts.originContent } : parent],
        oldest_id: null,
      });
    }
    if (path === `/channels/${CH}/call`) return fulfill(route, { call: null });

    unmocked.push(`${method} ${path}`);
    return fulfill(route, {});
  });
  await page.route('**/gateway/**', (route) => route.abort());
}

/** Sign in and land on the channel with its history loaded. */
async function openChannel(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill('e2e_viewer');
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  // ATTACHED, not visible: the boot cover stays over the shell until the
  // roster is known, and without a gateway that is only once the session
  // epoch below is seeded (lane D's one-pass boot).
  await page.waitForSelector('[data-testid="app-shell"]', { state: 'attached', timeout: 15_000 });

  // The send gate reads the STATE store's currentUser, which the gateway's
  // READY frame normally supplies (refused here) — seed it via the dev handle.
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

/** Open the channel, then the thread hanging off the origin message. */
async function openThread(page: Page): Promise<void> {
  await openChannel(page);
  await page.waitForSelector('[data-testid="thread-indicator"]');
  await page.getByTestId('thread-indicator').click();
  await page.waitForSelector('[data-testid="thread-side-panel"]');
  await page.waitForTimeout(500);
}

/** Open the channel and start a thread from the origin's hover toolbar. */
async function startThreadFromMessage(page: Page): Promise<void> {
  await openChannel(page);
  await page.locator('[data-testid="message-item"]').first().hover();
  await page.getByTestId('action-start-thread').click();
  await page.waitForSelector('[data-testid="thread-side-panel"]');
}

test.describe('thread pane — the origin scrolls, the composer stays', () => {
  test('a long origin cannot starve the reply list or push the composer off screen', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, unmocked);
    await openThread(page);

    const geo = await page.evaluate(() => {
      const q = (s: string) => document.querySelector(s) as HTMLElement | null;
      // The replies are the virtualized list in thread mode (#15): its own
      // scroller is the thread body.
      const region = q('[data-testid="thread-replies"]');
      const body =
        (region?.querySelector('[data-virtuoso-scroller="true"]') as HTMLElement | null) ?? region;
      const well = q('[data-testid="thread-side-panel"] [data-testid="composer-well"]');
      const dock = q('[data-testid="thread-dock"]');
      const origin = q('[data-testid="thread-parent-pin"]');
      const started = q('[data-testid="thread-started-line"]');
      // Scroll the thread body as far as it goes (the user's complaint was
      // that the bottom was unreachable, so reach for it).
      if (body) body.scrollTop = body.scrollHeight;
      const wellRect = well?.getBoundingClientRect() ?? null;
      return {
        viewportH: window.innerHeight,
        wellBottom: wellRect ? Math.round(wellRect.bottom) : null,
        bodyClientH: body ? body.clientHeight : 0,
        bodyScrollH: body ? body.scrollHeight : 0,
        atBottomReachable:
          body !== null && body.scrollTop + body.clientHeight >= body.scrollHeight - 2,
        originInsideBody: body !== null && origin !== null && body.contains(origin),
        membersPresent: q('[data-testid="member-list"]') !== null,
        dockBackground: dock ? getComputedStyle(dock).backgroundColor : null,
        paneBackground: getComputedStyle(q('[data-testid="message-pane"]')!).backgroundColor,
        startedText: started?.textContent ?? null,
        starterAboveOrigin:
          started !== null &&
          origin !== null &&
          started.compareDocumentPosition(origin) === Node.DOCUMENT_POSITION_FOLLOWING,
      };
    });

    // The composer is on screen, below the thread it belongs to.
    expect(geo.wellBottom, 'composer well is inside the viewport').not.toBeNull();
    expect(geo.wellBottom!).toBeLessThanOrEqual(geo.viewportH);

    // The reply list has real height and its end is reachable.
    expect(geo.bodyClientH, 'the thread body has height').toBeGreaterThan(200);
    expect(geo.bodyScrollH, 'the thread body overflows its box').toBeGreaterThan(geo.bodyClientH);
    expect(geo.atBottomReachable, 'the bottom of the thread is reachable').toBe(true);

    // The origin scrolls with the thread (not a pinned, unbounded block).
    expect(geo.originInsideBody, 'the origin lives in the scrolling body').toBe(true);

    // The members rail stands down while the pane is open.
    expect(geo.membersPresent, 'the members rail is unmounted').toBe(false);

    // The pane sits on the message pane's own surface — no gray slab.
    expect(geo.dockBackground, 'the dock uses the message pane surface').toBe(geo.paneBackground);

    // Who started it, and when — above the origin, so a long origin cannot
    // bury it.
    expect(geo.startedText, 'the start line names the starter').toContain('peer');
    expect(geo.startedText, 'the start line carries the start date').toContain('2026');
    expect(geo.starterAboveOrigin, 'the start line sits above the origin').toBe(true);

    expect(unmocked, 'every boot-time request is covered by a fixture').toEqual([]);
  });

  test('thread messages use the channel column’s type scale (owner, 2026-09-27)', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, unmocked);
    await openThread(page);

    const sizes = await page.evaluate(() => {
      const style = (el: Element | null | undefined) =>
        el ? { font: getComputedStyle(el).fontSize, line: getComputedStyle(el).lineHeight } : null;
      const pane = document.querySelector('[data-testid="message-pane"]');
      const replies = document.querySelector('[data-testid="thread-replies"]');
      const pin = document.querySelector('[data-testid="thread-parent-pin"]');
      const pick = (root: Element | null, id: string) => root?.querySelector(`[data-testid="${id}"]`);
      return Object.fromEntries(
        ['message-content', 'message-author', 'message-time'].map((id) => [
          id,
          { pane: style(pick(pane, id)), reply: style(pick(replies, id)), pin: style(pick(pin, id)) },
        ]),
      );
    });

    for (const [part, s] of Object.entries(sizes)) {
      expect(s.pane, `${part} renders in the channel pane`).not.toBeNull();
      expect(s.reply, `${part} renders in the thread replies`).not.toBeNull();
      expect(s.reply, `${part}: a thread reply matches the channel`).toEqual(s.pane);
      if (s.pin) expect(s.pin, `${part}: the thread origin matches the channel`).toEqual(s.pane);
    }
    expect(unmocked, 'every boot-time request is covered by a fixture').toEqual([]);
  });

  test('the thread composer keeps the channel composer’s look, titled for the thread', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await mockApi(page, unmocked);
    await openThread(page);

    const composer = page.locator(
      '[data-testid="thread-side-panel"] [data-testid="message-compose"] [contenteditable="true"]',
    );
    await expect(composer).toBeVisible();
    // The thread placeholder is neutral: our thread names are the seed
    // message's own words, so a quoted name reads as content in the box.
    await expect(
      page.locator('[data-testid="thread-side-panel"] [data-testid="composer-placeholder"]'),
    ).toHaveText('Reply in thread');

    // The reply lands in the thread's own list.
    await composer.click();
    await composer.type('a reply from the thread pane');
    await page.waitForTimeout(300);
    expect(unmocked, 'no unmocked request during compose').toEqual([]);
  });
});

/**
 * Desktop, thread open (2026-09-30): the channel header showed NO side-panel
 * icons — the column mode (Members by default) hid them, while the dock held
 * the column's slot — so Members and My Threads were unreachable until the
 * thread was closed. The icons now stay up and choosing one REPLACES the
 * thread with that pane (the dock and the column share one slot).
 */
test.describe('thread pane — the side-panel icons stay reachable at desktop', () => {
  test('Members from the channel header closes the thread and shows the member list', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page, unmocked);
    await openThread(page);

    const header = page.getByTestId('channel-header');
    for (const mode of ['members', 'calls', 'threads']) {
      await expect(header.getByTestId(`rail-icon-${mode}`)).toBeVisible();
      await expect(header.getByTestId(`rail-icon-${mode}`)).toHaveAttribute('aria-pressed', 'false');
    }
    await expect(page.getByTestId('member-list')).toHaveCount(0);

    await header.getByTestId('rail-icon-members').click();

    await expect(page.getByTestId('thread-dock')).toHaveCount(0);
    const pane = page.getByTestId('rail-pane');
    await expect(pane).toHaveAttribute('data-mode', 'members');
    await expect(page.getByTestId('member-list')).toBeVisible();
    await expect(pane.getByTestId(`people-row-${PEER}`)).toBeVisible();
    // The icons moved into the column's header, Members pressed.
    await expect(pane.getByTestId('rail-icon-members')).toHaveAttribute('aria-pressed', 'true');
    await expect(header.getByTestId('rail-icons')).toHaveCount(0);

    // The thread reopens from its indicator exactly as before, and the
    // header icons come back with it.
    await page.getByTestId('thread-indicator').click();
    await expect(page.getByTestId('thread-dock')).toBeVisible();
    await expect(header.getByTestId('rail-icon-threads')).toBeVisible();
    await header.getByTestId('rail-icon-threads').click();
    await expect(page.getByTestId('thread-dock')).toHaveCount(0);
    await expect(page.getByTestId('rail-pane')).toHaveAttribute('data-mode', 'threads');

    expect(unmocked, 'every request is covered by a fixture').toEqual([]);
  });
});

/**
 * User report (2026-09-12): "I started a thread but then closed it without
 * posting so the thread shouldn't have been created." A thread is its replies
 * — the panel opens a DRAFT and the first reply is what creates it.
 */
test.describe('thread creation is deferred to the first reply', () => {
  test('starting a thread and closing it without posting creates nothing', async ({ page }) => {
    const unmocked: string[] = [];
    const requests: string[] = [];
    await mockApi(page, unmocked, requests, { existingThread: false });
    await startThreadFromMessage(page);

    // The pane is open, offering the origin and a composer — titled for the
    // thread its reply would create.
    await expect(page.getByTestId('thread-title')).not.toHaveText('');
    // No empty-state copy and no content box on the origin (user direction
    // 2026-09-13) — the transcript stays bare and the composer is the cue.
    await expect(page.getByTestId('thread-empty')).toHaveCount(0);
    await expect(page.locator('.thread-origin')).toHaveCount(0);
    // Nothing to follow or leave yet.
    await expect(page.getByTestId('thread-notifications')).toHaveCount(0);
    await expect(page.getByTestId('thread-ellipsis')).toHaveCount(0);

    await page.getByTestId('thread-close').click();
    await expect(page.getByTestId('thread-dock')).toHaveCount(0);

    // The whole point: not one write reached the API.
    expect(
      requests.filter(
        (r) =>
          // Sign-in is the harness's own write; the app's writes are the point.
          !r.includes('/auth/') &&
          (r.startsWith('POST ') || r.startsWith('PATCH ') || r.startsWith('DELETE ')),
      ),
      'closing a draft writes nothing',
    ).toEqual([]);
    // ...and the seed message carries no thread mark.
    await expect(page.getByTestId('thread-indicator')).toHaveCount(0);
  });

  /*
   * Owner report (2026-10-01): "When I start a thread the original message is
   * at the bottom. Then when I send, the thread panel goes black with some
   * gray skeletons, the thread panel flashes, then the messages render at
   * top." The panel is sampled EVERY animation frame from the Enter to the
   * settle, with the create held for 800ms (a slow server): the origin stays
   * put at the top, the reply is under it on the next frame, and no frame is
   * blank or shows a skeleton.
   */
  test('starting a thread: origin at the top, the reply under it at once, no blank, skeleton or jump', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    const requests: string[] = [];
    await mockApi(page, unmocked, requests, {
      existingThread: false,
      createDelayMs: 800,
      originContent: 'Deploy is green — anyone see the latency bump on the 14:00 run?',
    });
    await startThreadFromMessage(page);

    const panel = page.getByTestId('thread-side-panel');
    const origin = panel.getByTestId('thread-parent-pin');
    await expect(origin).toBeVisible();
    // The draft is laid out like the thread it becomes: the origin at the TOP
    // of the body (directly under the header), the composer at the bottom.
    const layout = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="thread-side-panel"] [data-testid="thread-replies"]')!;
      const pin = document.querySelector('[data-testid="thread-side-panel"] [data-testid="thread-parent-pin"]')!;
      return {
        bodyTop: body.getBoundingClientRect().top,
        bodyBottom: body.getBoundingClientRect().bottom,
        pinTop: pin.getBoundingClientRect().top,
        pinBottom: pin.getBoundingClientRect().bottom,
      };
    });
    expect(layout.pinTop - layout.bodyTop, 'the origin sits at the top of the draft').toBeLessThan(80);
    expect(layout.bodyBottom - layout.pinBottom, 'with the empty space below it').toBeGreaterThan(100);

    const composer = panel.locator('[contenteditable="true"]');
    await composer.click();
    await composer.type('the reply that starts it');

    // Arm the sampler, then press Enter in the same task as its first frame.
    await page.evaluate(() => {
      type Sample = {
        t: number;
        skeleton: boolean;
        list: boolean;
        text: string;
        originTop: number | null;
        replyTop: number | null;
        replyText: string | null;
      };
      const w = window as unknown as { __tcSamples: Sample[]; __tcStop: boolean; __tcEnterAt: number };
      w.__tcSamples = [];
      w.__tcStop = false;
      w.__tcEnterAt = 0;
      document.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter' && w.__tcEnterAt === 0) w.__tcEnterAt = performance.now();
        },
        true,
      );
      const sample = () => {
        const panel = document.querySelector('[data-testid="thread-side-panel"]');
        const pin = panel?.querySelector('[data-testid="thread-parent-pin"]');
        const rows = panel?.querySelectorAll('[data-testid="thread-replies"] [data-testid="message-item"]');
        const reply = rows && rows.length > 0 ? rows[rows.length - 1]! : null;
        w.__tcSamples.push({
          t: performance.now(),
          skeleton: panel?.querySelector('[data-testid="thread-loading"]') != null,
          list: panel?.querySelector('[data-testid="message-list"]') != null,
          text: (panel?.querySelector('[data-testid="thread-replies"]') as HTMLElement | null)?.innerText ?? '',
          originTop: pin ? pin.getBoundingClientRect().top : null,
          replyTop: reply ? reply.getBoundingClientRect().top : null,
          replyText: reply ? (reply.textContent ?? '') : null,
        });
        if (!w.__tcStop) requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await composer.press('Enter');

    // Settled: the thread exists, the reply is confirmed, the indicator shows.
    await expect(panel).toHaveAttribute('data-thread-id', THREAD);
    await expect(page.getByTestId('thread-indicator')).toContainText('1 reply');
    await expect
      .poll(() => requests.filter((r) => r.startsWith('GET ') && r.includes(`/threads/${THREAD}/messages`)).length)
      .toBeGreaterThan(0);
    await page.waitForTimeout(400);
    const samples = await page.evaluate(() => {
      const w = window as unknown as {
        __tcSamples: {
          t: number;
          skeleton: boolean;
          list: boolean;
          text: string;
          originTop: number | null;
          replyTop: number | null;
          replyText: string | null;
        }[];
        __tcStop: boolean;
        __tcEnterAt: number;
      };
      w.__tcStop = true;
      return { samples: w.__tcSamples, enterAt: w.__tcEnterAt };
    });

    const frames = samples.samples;
    expect(frames.length, 'the panel was sampled through the create').toBeGreaterThan(40);
    const firstOrigin = frames[0]!.originTop;
    expect(firstOrigin).not.toBeNull();
    for (const [i, f] of frames.entries()) {
      expect(f.skeleton, `frame ${i}: no skeleton`).toBe(false);
      expect(f.list, `frame ${i}: the list is there`).toBe(true);
      expect(f.text.trim().length, `frame ${i}: the panel is never blank`).toBeGreaterThan(0);
      expect(f.originTop, `frame ${i}: the origin never moves`).toBe(firstOrigin);
    }
    // The reply is under the origin within a frame of the Enter — long before
    // the 800ms create answers — and it stays there.
    const firstWithReply = frames.findIndex((f) => f.replyText?.includes('the reply that starts it'));
    expect(firstWithReply).toBeGreaterThanOrEqual(0);
    expect(samples.enterAt).toBeGreaterThan(0);
    expect(
      frames[firstWithReply]!.t - samples.enterAt,
      'the reply is drawn within one frame of Enter',
    ).toBeLessThan(50);
    const replyTop = frames[firstWithReply]!.replyTop!;
    expect(replyTop).toBeGreaterThan(firstOrigin!);
    for (const f of frames.slice(firstWithReply)) {
      expect(f.replyText).toContain('the reply that starts it');
      expect(f.replyTop, 'the reply never moves').toBe(replyTop);
    }
    expect(unmocked).toEqual([]);
  });

  test('the first reply creates the thread, and the seed message then announces it', async ({
    page,
  }) => {
    const unmocked: string[] = [];
    const requests: string[] = [];
    await mockApi(page, unmocked, requests, { existingThread: false });
    await startThreadFromMessage(page);

    const composer = page.locator(
      '[data-testid="thread-side-panel"] [contenteditable="true"]',
    );
    await composer.click();
    await composer.type('the reply that starts it');
    await composer.press('Enter');

    // Create, then reply — in that order, exactly once each.
    await expect
      .poll(() => requests.filter((r) => r.startsWith('POST ') && !r.includes('/auth/')))
      .toEqual([
        `POST /channels/${CH}/messages/${PARENT}/threads`,
        `POST /threads/${THREAD}/messages`,
      ]);

    // The seed message now announces the thread — with the count leading in
    // the accent color and Discord's chevron (the prominence fix).
    const indicator = page.getByTestId('thread-indicator');
    await expect(indicator).toBeVisible();
    await expect(indicator).toContainText('1 reply');
    await expect(indicator).toContainText('›');
    // Away from the pointer: hovering the indicator shifts it to the hover
    // shade, which is not what this asserts.
    await page.mouse.move(2, 2);
    const colors = await page.evaluate(() => {
      const count = document.querySelector('.thread-indicator-count');
      const chevron = document.querySelector('.thread-indicator-chevron');
      // The ACCENT token as the active theme resolves it (the light theme
      // steps the blurple down a shade for contrast — a literal would pin one
      // theme).
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-accent)';
      document.body.appendChild(probe);
      const accent = getComputedStyle(probe).color;
      probe.remove();
      return {
        accent,
        count: count ? getComputedStyle(count).color : null,
        chevron: chevron ? getComputedStyle(chevron).color : null,
      };
    });
    expect(colors.count, 'the count is the accent color').toBe(colors.accent);
    expect(colors.chevron, 'the chevron is the accent color').toBe(colors.accent);
  });
});
