/**
 * Optimistic send, in a real browser (owner report 2026-09-28: "When sending a
 * message it appears in the message list and is then cleared from the
 * composer. The composer should feel fast.").
 *
 * The send route is HELD by the test, so every assertion below is made while
 * the POST is still unanswered:
 *
 *  - the composer is empty within one animation frame of Enter;
 *  - the message is already in the list, muted and marked pending, then turns
 *    normal on the ack — in place, with the same box (no layout jump);
 *  - a five-message burst lands in typed order, one POST at a time;
 *  - a 500 leaves a failed row (words + Retry/Delete), and Retry — same
 *    Idempotency-Key — succeeds;
 *  - a burst the server's send budget refuses in part (429 + Retry-After)
 *    lands whole and in order: the refused rows wait, still pending, and go
 *    again under their own keys — no row is ever marked failed.
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

import { CH, ME, mockApi, openChannel, signIn } from './ux-world';

interface Post {
  content: string;
  key: string | null;
  nonce: string | null;
  route: Route;
}

/** The send endpoint as a switchboard: each POST waits for the test. */
async function holdSends(page: Page): Promise<{ posts: Post[]; answer: (i: number, status?: number) => Promise<void> }> {
  const posts: Post[] = [];
  let n = 0;
  await page.route(`**/api/v1/channels/${CH}/messages**`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = req.postDataJSON() as { content: string; nonce?: string };
    posts.push({
      content: body.content,
      key: (await req.allHeaders())['idempotency-key'] ?? null,
      nonce: body.nonce ?? null,
      route,
    });
  });
  const answer = async (i: number, status = 200): Promise<void> => {
    const post = posts[i]!;
    if (status >= 400) {
      await post.route.fulfill({
        status,
        contentType: 'application/json',
        body: JSON.stringify({ error: { key: 'internal_error', code: 50000, message: 'Database unavailable' } }),
      });
      return;
    }
    n += 1;
    await post.route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        message: {
          id: String(97000000000 + n), channel_id: CH, thread_id: null, author_id: ME,
          content: post.content, created_at: new Date().toISOString(), edited_at: null, attachments: null,
        },
      }),
    });
  };
  return { posts, answer };
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockApi(page);
  const wire = await holdSends(page);
  await signIn(page);
  await openChannel(page);
  return wire;
}

const composer = (page: Page) => page.getByTestId('composer-input');
const rowsWithState = (page: Page, state: string) => page.locator(`[data-testid="message-item"][data-send-state="${state}"]`);

/** Arm a probe that reports how many animation frames after Enter the composer was empty. */
async function armClearProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __clear?: { downAt: number; emptyAt?: number; frames?: number } };
    delete w.__clear;
    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Enter' || e.shiftKey || w.__clear) return;
        const input = document.querySelector('[data-testid="composer-input"]')!;
        const probe: { downAt: number; emptyAt?: number; frames?: number } = { downAt: performance.now() };
        w.__clear = probe;
        let frames = 0;
        const tick = () => {
          frames += 1;
          if ((input.textContent ?? '') === '') {
            probe.emptyAt = performance.now();
            probe.frames = frames;
          } else if (frames < 120) {
            requestAnimationFrame(tick);
          }
        };
        requestAnimationFrame(tick);
      },
      { capture: true, once: false },
    );
  });
}

test.describe('optimistic send', () => {
  test('Enter clears the composer within one frame while the POST is still pending; the row is pending, then normal in place', async ({ page }) => {
    const wire = await setup(page);
    await armClearProbe(page);
    await composer(page).click();
    await composer(page).pressSequentially('fast as thought', { delay: 10 });
    await composer(page).press('Enter');

    const probe = await page.waitForFunction(() => (window as unknown as { __clear?: { emptyAt?: number } }).__clear?.emptyAt !== undefined).then(() =>
      page.evaluate(() => (window as unknown as { __clear: { downAt: number; emptyAt: number; frames: number } }).__clear),
    );
    console.log(`[optimistic-send] composer empty ${Math.round((probe.emptyAt - probe.downAt) * 10) / 10}ms / ${probe.frames} frame(s) after Enter`);
    expect(probe.frames).toBeLessThanOrEqual(1);

    // The POST has been made — and is still unanswered.
    await expect.poll(() => wire.posts.length).toBe(1);
    const pending = rowsWithState(page, 'pending');
    await expect(pending).toHaveCount(1);
    await expect(pending.getByTestId('message-content')).toHaveText('fast as thought');
    await expect(pending).toHaveAttribute('aria-busy', 'true');
    // Muted, not hidden: the pending text is drawn in the muted token.
    const pendingColor = await pending.getByTestId('message-content').evaluate((el) => getComputedStyle(el).color);
    const before = await pending.boundingBox();

    // Hold a handle on the SAME element across the ack.
    const handle = await pending.elementHandle();
    await wire.answer(0);
    await expect(rowsWithState(page, 'pending')).toHaveCount(0);
    const confirmed = page.getByTestId('message-item').filter({ hasText: 'fast as thought' });
    await expect(confirmed).toHaveCount(1);
    expect(await handle!.evaluate((el) => el.isConnected && el.getAttribute('data-send-state'))).toBe(null);
    const confirmedColor = await confirmed.getByTestId('message-content').evaluate((el) => getComputedStyle(el).color);
    expect(confirmedColor).not.toBe(pendingColor);
    const after = await confirmed.boundingBox();
    console.log(`[optimistic-send] row box pending ${JSON.stringify(before)} → confirmed ${JSON.stringify(after)}`);
    expect(after).toEqual(before);
  });

  test('a five-message burst goes out one POST at a time and lands in typed order', async ({ page }) => {
    const wire = await setup(page);
    const texts = ['burst one', 'burst two', 'burst three', 'burst four', 'burst five'];
    await composer(page).click();
    for (const t of texts) {
      await composer(page).pressSequentially(t, { delay: 5 });
      await composer(page).press('Enter');
    }
    // All five drawn, pending, in order — while only the FIRST POST is out.
    await expect(rowsWithState(page, 'pending')).toHaveCount(5);
    await expect(rowsWithState(page, 'pending').getByTestId('message-content')).toHaveText(texts);
    await expect.poll(() => wire.posts.length).toBe(1);
    await expect(composer(page)).toHaveText('');

    for (let i = 0; i < texts.length; i += 1) {
      await expect.poll(() => wire.posts.length).toBe(i + 1);
      expect(wire.posts[i]!.content).toBe(texts[i]);
      await wire.answer(i);
    }
    await expect(rowsWithState(page, 'pending')).toHaveCount(0);
    const bodies = await page.getByTestId('message-content').allTextContents();
    expect(bodies.slice(-5)).toEqual(texts);
  });

  test('a 500 leaves a failed row with Retry; Retry reuses the key and succeeds', async ({ page }) => {
    const wire = await setup(page);
    await composer(page).click();
    await composer(page).pressSequentially('please arrive', { delay: 5 });
    await composer(page).press('Enter');
    await expect.poll(() => wire.posts.length).toBe(1);
    await wire.answer(0, 500);

    const failed = rowsWithState(page, 'failed');
    await expect(failed).toHaveCount(1);
    await expect(failed.getByTestId('message-send-failed-reason')).toContainText('Failed to send');
    await expect(failed.getByTestId('message-send-failed-reason')).toHaveAttribute('role', 'alert');
    // The composer was never refilled.
    await expect(composer(page)).toHaveText('');

    // Keyboard: Retry is a real button in the tab order.
    await failed.getByTestId('message-send-retry').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => wire.posts.length).toBe(2);
    expect(wire.posts[1]!.key).toBe(wire.posts[0]!.key);
    expect(wire.posts[1]!.nonce).toBe(wire.posts[0]!.nonce);
    await expect(rowsWithState(page, 'pending')).toHaveCount(1);
    await wire.answer(1);
    await expect(page.locator('[data-testid="message-item"][data-send-state]')).toHaveCount(0);
    await expect(page.getByTestId('message-item').filter({ hasText: 'please arrive' })).toHaveCount(1);
  });

  test('Delete removes a failed row; Edit puts it back in an empty composer', async ({ page }) => {
    const wire = await setup(page);
    await composer(page).click();
    await composer(page).pressSequentially('first draft', { delay: 5 });
    await composer(page).press('Enter');
    await composer(page).pressSequentially('second draft', { delay: 5 });
    await composer(page).press('Enter');
    await expect.poll(() => wire.posts.length).toBe(1);
    await wire.answer(0, 500);
    await expect.poll(() => wire.posts.length).toBe(2);
    await wire.answer(1, 500);
    await expect(rowsWithState(page, 'failed')).toHaveCount(2);

    await rowsWithState(page, 'failed').first().getByTestId('message-send-delete').click();
    await expect(rowsWithState(page, 'failed')).toHaveCount(1);
    await expect(page.getByTestId('message-item').filter({ hasText: 'first draft' })).toHaveCount(0);

    await rowsWithState(page, 'failed').getByTestId('message-send-edit').click();
    await expect(composer(page)).toHaveText('second draft');
    await expect(rowsWithState(page, 'failed')).toHaveCount(0);
  });
});

test.describe('the send budget (429 + Retry-After)', () => {
  interface Attempt {
    content: string;
    key: string | null;
    nonce: string | null;
    status: number;
    at: number;
  }

  /**
   * The send endpoint, answering on its own: the 3rd and 6th messages of the
   * burst are refused ONCE each with the server's native 429 (Retry-After: 1,
   * the rate_limited envelope naming its `conversation` scope, the
   * X-RateLimit-* set); everything else is 201.
   */
  async function budgetedSends(page: Page): Promise<Attempt[]> {
    const attempts: Attempt[] = [];
    const refuseOnce = new Set(['budget 3', 'budget 6']);
    let n = 0;
    await page.route(`**/api/v1/channels/${CH}/messages**`, async (route) => {
      const req = route.request();
      if (req.method() !== 'POST') return route.fallback();
      const body = req.postDataJSON() as { content: string; nonce?: string };
      const key = (await req.allHeaders())['idempotency-key'] ?? null;
      const refuse = refuseOnce.delete(body.content);
      attempts.push({ content: body.content, key, nonce: body.nonce ?? null, status: refuse ? 429 : 201, at: Date.now() });
      if (refuse) {
        await route.fulfill({
          status: 429,
          contentType: 'application/json',
          headers: {
            'retry-after': '1',
            'x-ratelimit-limit': '10',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset-after': '1',
            'x-ratelimit-scope': 'conversation',
          },
          body: JSON.stringify({
            error: {
              key: 'rate_limited',
              code: 42901,
              message:
                'Too many messages in this conversation — the send limit is 10 per 5s per sender in one channel or thread. Try again in 1 second.',
              scope: 'conversation',
              retry_after_ms: 1000,
            },
          }),
        });
        return;
      }
      n += 1;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({
          message: {
            id: String(96000000000 + n), channel_id: CH, thread_id: null, author_id: ME,
            content: body.content, nonce: body.nonce, created_at: new Date().toISOString(), edited_at: null, attachments: null,
          },
        }),
      });
    });
    return attempts;
  }

  test('a burst the server partly refuses with 429 lands whole, in typed order, same keys, never a failed row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await mockApi(page);
    const attempts = await budgetedSends(page);
    await signIn(page);
    await openChannel(page);

    // Record every send state any row ever shows — a failed flash would land here.
    await page.evaluate(() => {
      const w = window as unknown as { __states: string[] };
      w.__states = [];
      const note = () => {
        for (const el of document.querySelectorAll('[data-testid="message-item"][data-send-state]')) {
          w.__states.push(el.getAttribute('data-send-state') ?? '');
        }
        if (document.querySelector('[data-testid="message-send-failed"]')) w.__states.push('failed-bar');
      };
      new MutationObserver(note).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-send-state'] });
    });

    const texts = Array.from({ length: 8 }, (_, i) => `budget ${i + 1}`);
    await composer(page).click();
    for (const t of texts) {
      await composer(page).pressSequentially(t, { delay: 5 });
      await composer(page).press('Enter');
    }

    // The refused row waits out Retry-After still pending: muted, "Sending…".
    await expect.poll(() => attempts.filter((a) => a.status === 429).length).toBeGreaterThanOrEqual(1);
    const waiting = page.getByTestId('message-item').filter({ hasText: 'budget 3' });
    await expect(waiting).toHaveAttribute('data-send-state', 'pending');
    await expect(waiting.getByText('Sending…')).toBeAttached();
    await expect(waiting.getByTestId('message-send-failed')).toHaveCount(0);

    await expect(rowsWithState(page, 'pending')).toHaveCount(0, { timeout: 15_000 });
    const bodies = await page.getByTestId('message-content').allTextContents();
    expect(bodies.slice(-8)).toEqual(texts);

    // Delivered in typed order; each refused send went again under its own key, after the hint.
    const delivered = attempts.filter((a) => a.status === 201);
    expect(delivered.map((a) => a.content)).toEqual(texts);
    for (const refused of attempts.filter((a) => a.status === 429)) {
      const again = delivered.find((a) => a.content === refused.content)!;
      expect(again.key).toBe(refused.key);
      expect(again.nonce).toBe(refused.nonce);
      expect(again.at - refused.at).toBeGreaterThanOrEqual(900);
    }
    expect(attempts.filter((a) => a.status === 429).map((a) => a.content)).toEqual(['budget 3', 'budget 6']);

    const states = await page.evaluate(() => (window as unknown as { __states: string[] }).__states);
    expect(states).not.toContain('failed');
    expect(states).not.toContain('failed-bar');
    expect(states).toContain('pending');
    await expect(page.locator('[data-testid="message-item"][data-send-state]')).toHaveCount(0);
  });
});
