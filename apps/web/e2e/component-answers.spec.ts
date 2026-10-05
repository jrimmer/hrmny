/**
 * A bot's answer to a button click resolves it — however the bot answers.
 *
 * Owner report (2026-10-01): after clicking "Allow Once" on Hermes's approval
 * card, the card said "Your request completed" AND "No response yet — the
 * bot may still be processing" at once. Two faults: the click tracker could
 * only see an answer that changed the message store (a deferred ack changes
 * nothing, so a bot that deferred and then took its time always tripped the
 * 10s fallback), and the fallback itself was announced as completion.
 *
 * The server now tells the clicker exactly when the bot answers
 * (`InteractionSuccess`, Discord's INTERACTION_SUCCESS, carrying the click's
 * nonce). Here, in real Chromium against fixtures (no server), the server's
 * side is played through the dev build's `__cytaleDispatch` handle — the
 * same route the live socket's frames take:
 *
 *   click → deferred update (type 6) → 12s of bot work → @original edit flips
 *   the card; across the whole 10s window and beyond, "No response yet"
 *   never appears — in a channel and in a thread.
 */
import { expect, test, type Page } from '@playwright/test';

import { BOT, CH, THREAD, mockApi, openChannel, signIn } from './ux-world';

const CARD = '95000000110';
const THREAD_CARD = '95000000310';
const NO_RESPONSE = 'No response yet';

const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();

const row = (disabled: boolean, label = 'Allow Once') => [
  {
    type: 1,
    components: [
      { type: 2, style: 3, label, custom_id: 'once', disabled },
      { type: 2, style: 4, label: 'Deny', custom_id: 'deny', disabled },
    ],
  },
];

const card = (id: string, threadId: string | null) => ({
  id,
  channel_id: CH,
  thread_id: threadId,
  author_id: BOT,
  content: '⚠️ **Hermes wants to run a command that needs your OK**',
  created_at: ago(1),
  edited_at: null,
  attachments: null,
  components: row(false),
});

let seq = 0;
async function dispatch(page: Page, t: string, d: unknown): Promise<void> {
  seq += 1;
  await page.evaluate(
    ({ t, s, d }) => (window as unknown as { __cytaleDispatch: (e: unknown) => void }).__cytaleDispatch({ op: 0, t, s, d }),
    { t, s: seq, d },
  );
}

interface Clicks {
  bodies: Array<{ nonce?: string; message_id: string; custom_id: string }>;
}

/** The fixture world plus POST /interactions answering 202 (recording the
 * body, nonce included); the card arrives live, as Hermes posts it. */
async function setup(page: Page): Promise<Clicks> {
  seq = 0;
  const clicks: Clicks = { bodies: [] };
  await page.setViewportSize({ width: 1280, height: 900 });
  await mockApi(page);

  await page.route(`**/api/v1/interactions`, async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    clicks.bodies.push(body);
    await route.fulfill({
      status: 202,
      contentType: 'application/json',
      body: JSON.stringify({ interaction_id: String(96000000000 + clicks.bodies.length) }),
    });
  });

  await signIn(page);
  await openChannel(page);
  // The card arrives live, as Hermes posts it.
  await dispatch(page, 'MessageCreate', card(CARD, null));
  await expect(cardButton(page, CARD)).toBeVisible();

  // Record any moment the fallback copy is on screen, however brief.
  await page.evaluate((text) => {
    const w = window as unknown as { __sawNoResponse: boolean };
    w.__sawNoResponse = false;
    new MutationObserver(() => {
      if (document.body.innerText.includes(text)) w.__sawNoResponse = true;
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }, NO_RESPONSE);
  return clicks;
}

function block(page: Page, messageId: string) {
  return page.locator(`[data-testid="component-block"][data-message-id="${messageId}"]`).first();
}

function cardButton(page: Page, messageId: string, customId = 'once') {
  return block(page, messageId).locator(`[data-testid="component-button"][data-custom-id="${customId}"]`);
}

async function sawNoResponse(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __sawNoResponse: boolean }).__sawNoResponse);
}

/** The server's side of a deferred update then an @original edit. */
async function answerDeferredThenEdit(
  page: Page,
  clicks: Clicks,
  messageId: string,
  threadId: string | null,
): Promise<void> {
  const sent = clicks.bodies[clicks.bodies.length - 1]!;
  expect(sent.nonce, 'the click carries a nonce').toMatch(/^.{1,64}$/);
  // Type 6: the ack. Nothing in the message store changes.
  await dispatch(page, 'InteractionSuccess', {
    interaction_id: String(96000000000 + clicks.bodies.length),
    nonce: sent.nonce,
    application_id: BOT,
    channel_id: CH,
    thread_id: threadId,
    message_id: messageId,
    custom_id: 'once',
    response_type: 6,
  });
  await expect(cardButton(page, messageId)).not.toHaveAttribute('data-pending', 'true');
  // The bot works PAST the client's 10s fallback window (Hermes runs the
  // command), then edits @original: the card flips. Before the exact
  // signal, nothing changed in the store until this edit, so the fallback
  // fired in between.
  await page.waitForTimeout(12_000);
  await dispatch(page, 'MessageUpdate', {
    ...card(messageId, threadId),
    content: '✅ Approved once by Jordan R',
    edited_at: new Date().toISOString(),
    components: row(true, 'Allowed once'),
    embeds: [],
  });
}

test.describe('a bot card click resolves on the bot’s answer', () => {
  test('channel: click → deferred update → @original edit; "No response yet" never shows', async ({ page }) => {
    test.setTimeout(60_000);
    const clicks = await setup(page);

    await cardButton(page, CARD).click();
    await expect(cardButton(page, CARD)).toHaveAttribute('data-pending', 'true');
    expect(clicks.bodies).toHaveLength(1);
    expect(clicks.bodies[0]).toMatchObject({ message_id: CARD, custom_id: 'once' });

    await answerDeferredThenEdit(page, clicks, CARD, null);
    await expect(cardButton(page, CARD)).toHaveText('Allowed once');
    await expect(cardButton(page, CARD)).toBeDisabled();

    await page.waitForTimeout(1_000);
    await expect(page.getByText(NO_RESPONSE)).toHaveCount(0);
    expect(await sawNoResponse(page)).toBe(false);
    await expect(block(page, CARD).getByTestId('component-live-region')).toHaveText(/Your request completed|Card updated/);
  });

  test('thread: the same flow on a card inside a thread', async ({ page }) => {
    test.setTimeout(60_000);
    const clicks = await setup(page);

    await page.getByTestId('thread-indicator').first().click();
    await page.waitForSelector('[data-testid="thread-side-panel"]');
    await dispatch(page, 'ThreadMessageCreate', card(THREAD_CARD, THREAD));
    const panel = page.getByTestId('thread-side-panel');
    const button = panel.locator(
      `[data-testid="component-block"][data-message-id="${THREAD_CARD}"] [data-testid="component-button"][data-custom-id="once"]`,
    );
    await expect(button).toBeVisible();

    await button.click();
    await expect(button).toHaveAttribute('data-pending', 'true');
    expect(clicks.bodies.at(-1)).toMatchObject({ message_id: THREAD_CARD, custom_id: 'once' });

    await answerDeferredThenEdit(page, clicks, THREAD_CARD, THREAD);
    await expect(button).toHaveText('Allowed once');

    await page.waitForTimeout(1_000);
    await expect(page.getByText(NO_RESPONSE)).toHaveCount(0);
    expect(await sawNoResponse(page)).toBe(false);
  });

  test('no answer: the fallback shows without claiming completion; a late answer clears it', async ({ page }) => {
    test.setTimeout(60_000);
    const clicks = await setup(page);

    await cardButton(page, CARD).click();
    await expect(page.getByText(NO_RESPONSE)).toBeVisible({ timeout: 15_000 });
    await expect(block(page, CARD).getByTestId('component-live-region')).not.toHaveText('Your request completed');

    const sent = clicks.bodies[0]!;
    await dispatch(page, 'InteractionSuccess', {
      interaction_id: '96000000001',
      nonce: sent.nonce,
      application_id: BOT,
      channel_id: CH,
      thread_id: null,
      message_id: CARD,
      custom_id: 'once',
      response_type: 5,
    });
    await expect(page.getByText(NO_RESPONSE)).toHaveCount(0);
    await expect(block(page, CARD).getByTestId('component-live-region')).toHaveText('Your request completed');
  });
});
