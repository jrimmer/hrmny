/**
 * Sends made offline wait, then land on reconnect (send reliability B2), in a
 * real browser.
 *
 * The offline banner says "Messages will sync when the connection returns".
 * This holds it to that: with the browser context OFFLINE, three messages are
 * sent — each row stays on screen reading "Waiting for connection…" (not
 * "Failed"). When the context comes back ONLINE they go out on their own, one
 * POST at a time, in typed order, each under the SAME Idempotency-Key / nonce
 * its first attempt carried, and every placeholder is swapped for its
 * confirmed row IN PLACE (the same DOM element — no remount, no jump).
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page } from '@playwright/test';

import { CH, ME, mockApi, openChannel, signIn } from './ux-world';

interface Attempt {
  content: string;
  key: string | null;
  nonce: string | null;
  delivered: boolean;
}

/**
 * The send endpoint: while the test says the network is down every POST is
 * aborted as a disconnect (whether or not the browser's own offline mode
 * reaches the route first); otherwise it is answered 201.
 */
async function sendEndpoint(page: Page, isDown: () => boolean): Promise<Attempt[]> {
  const attempts: Attempt[] = [];
  let n = 0;
  await page.route(`**/api/v1/channels/${CH}/messages**`, async (route) => {
    const req = route.request();
    if (req.method() !== 'POST') return route.fallback();
    const body = req.postDataJSON() as { content: string; nonce?: string };
    const attempt: Attempt = {
      content: body.content,
      key: (await req.allHeaders())['idempotency-key'] ?? null,
      nonce: body.nonce ?? null,
      delivered: !isDown(),
    };
    attempts.push(attempt);
    if (!attempt.delivered) {
      await route.abort('internetdisconnected');
      return;
    }
    n += 1;
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        message: {
          id: String(98000000000 + n),
          channel_id: CH,
          thread_id: null,
          author_id: ME,
          content: body.content,
          created_at: new Date().toISOString(),
          edited_at: null,
          attachments: null,
          nonce: body.nonce,
        },
      }),
    });
  });
  return attempts;
}

const composer = (page: Page) => page.getByTestId('composer-input');
const rowsWithState = (page: Page, state: string) =>
  page.locator(`[data-testid="message-item"][data-send-state="${state}"]`);

test.describe('offline sends', () => {
  test('three messages sent offline wait, then land in order on reconnect, same keys, swapped in place', async ({
    page,
    context,
  }) => {
    await page.setViewportSize({ width: 1280, height: 860 });
    await mockApi(page);
    let down = false;
    const attempts = await sendEndpoint(page, () => down);
    await signIn(page);
    await openChannel(page);

    down = true;
    await context.setOffline(true);
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    const texts = ['offline one', 'offline two', 'offline three'];
    await composer(page).click();
    for (const t of texts) {
      await composer(page).pressSequentially(t, { delay: 5 });
      await composer(page).press('Enter');
    }
    await expect(composer(page)).toHaveText('');

    // Every row waits, in typed order, saying why — never "Failed".
    const waiting = rowsWithState(page, 'waiting');
    await expect(waiting).toHaveCount(3);
    await expect(waiting.getByTestId('message-content')).toHaveText(texts);
    await expect(waiting.first().getByTestId('message-send-failed-reason')).toContainText('Waiting for connection');
    await expect(page.locator('[data-testid="message-item"][data-send-state="failed"]')).toHaveCount(0);
    await expect(waiting.first().getByTestId('message-send-retry')).toHaveCount(0);

    // Hold the three row elements across the reconnect.
    const handles = await Promise.all(texts.map((_, i) => waiting.nth(i).elementHandle()));
    const firstAttempts = attempts.length;
    const keyFor = new Map<string, string | null>();
    for (const a of attempts) if (!keyFor.has(a.content)) keyFor.set(a.content, a.key);

    down = false;
    await context.setOffline(false);
    await expect(page.getByTestId('offline-banner')).toHaveCount(0);

    await expect(page.locator('[data-testid="message-item"][data-send-state]')).toHaveCount(0);
    const delivered = attempts.filter((a) => a.delivered);
    expect(delivered.map((a) => a.content)).toEqual(texts);
    // Same key as the attempt it retries (when the offline attempt reached
    // the route at all) — header and body agree either way.
    for (const a of delivered) {
      expect(a.nonce).toBe(a.key);
      if (firstAttempts > 0 && keyFor.get(a.content)) expect(a.key).toBe(keyFor.get(a.content));
    }

    const bodies = await page.getByTestId('message-content').allTextContents();
    expect(bodies.slice(-3)).toEqual(texts);
    for (const [i, handle] of handles.entries()) {
      expect(await handle!.evaluate((el) => el.isConnected && el.getAttribute('data-send-state'))).toBe(null);
      await expect(handle!.evaluate((el) => el.textContent ?? '')).resolves.toContain(texts[i]!);
    }
  });
});
