/**
 * The phantom unread badge (owner report 2026-09-29: "#logs shows 3 unread
 * messages but when I click in there are no messages").
 *
 * Production: three messages landed in #logs while the owner was elsewhere,
 * then all were deleted. The client counted them on MessageCreate and never
 * took them back on MessageDelete. The device snapshot then carried the "3"
 * across reloads, and the session sync that reported 0 at the same watermark
 * was skipped. Opening the empty channel had no message to ack, so the badge
 * stayed.
 *
 * Fixture-backed (ux-world.ts): no server, no database. Dispatches go through
 * the dev build's `__cytaleDispatch` handle, which is the same reconcile the
 * live socket feeds.
 */
import { expect, test, type Page } from '@playwright/test';

import { WS, mockApi, openChannel, signIn } from './ux-world';

const LOGS = '95000000900';
const MAX = '95000000005';

/** A second channel, #logs, holding nothing: every message in it was deleted. */
async function addLogsChannel(page: Page): Promise<void> {
  const channel = (id: string, name: string, position: number, last: string | null) => ({
    id, workspace_id: WS, name, type: 0, parent_id: null, topic: null, position, last_message_id: last,
    created_at: '2026-09-01T00:00:00Z',
  });
  // Registered after mockApi, so these take precedence for their paths.
  await page.route(`**/api/v1/workspaces/${WS}/channels`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ channels: [channel('95000000002', 'release', 0, '95000000104'), channel(LOGS, 'logs', 1, null)] }),
    }),
  );
  await page.route(`**/api/v1/channels/${LOGS}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/messages') ? { messages: [], oldest_id: null } : path.endsWith('/threads') ? { threads: [] } : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

let seq = 0;
async function dispatch(page: Page, t: string, d: unknown): Promise<void> {
  seq += 1;
  await page.evaluate(
    ({ t, s, d }) => (window as unknown as { __cytaleDispatch: (e: unknown) => void }).__cytaleDispatch({ op: 0, t, s, d }),
    { t, s: seq, d },
  );
}

const IDS = ['95000000901', '95000000902', '95000000903'];
const badge = (page: Page) => page.getByTestId(`unread-${LOGS}`);

async function setup(page: Page): Promise<void> {
  seq = 0;
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockApi(page);
  await addLogsChannel(page);
  await signIn(page);
  await openChannel(page); // viewing #release, not #logs
  await expect(page.getByTestId(`channel-${LOGS}`)).toBeVisible();
}

test.describe('phantom unread', () => {
  test('three messages arrive in another channel and are deleted: the badge shows 3, then disappears', async ({ page }) => {
    await setup(page);
    await expect(badge(page)).toHaveCount(0);

    for (const id of IDS) {
      await dispatch(page, 'MessageCreate', {
        id, channel_id: LOGS, thread_id: null, author_id: MAX, content: `log line ${id}`,
        created_at: new Date().toISOString(), edited_at: null, attachments: null,
      });
    }
    await expect(badge(page)).toHaveText('3');

    await dispatch(page, 'MessageDelete', { id: IDS[0], channel_id: LOGS, thread_id: null });
    await expect(badge(page)).toHaveText('2');
    await dispatch(page, 'MessageDelete', { id: IDS[1], channel_id: LOGS, thread_id: null });
    await dispatch(page, 'MessageDelete', { id: IDS[2], channel_id: LOGS, thread_id: null });
    await expect(badge(page)).toHaveCount(0);

    // Opening #logs: empty, and still no badge.
    await page.getByTestId(`channel-${LOGS}`).click();
    await expect(page.getByTestId('message-item')).toHaveCount(0);
    await expect(badge(page)).toHaveCount(0);
  });

  test('a stale count (as a restored device snapshot carries it) clears when the empty channel is opened', async ({ page }) => {
    await setup(page);
    // The owner's state after the reload: the acked watermark, and a count of
    // 3 for messages that no longer exist.
    await page.evaluate((logs) => {
      const store = (window as unknown as {
        __cytaleStore: { setState: (fn: (s: { unreadByChannel: Record<string, unknown> }) => unknown) => void };
      }).__cytaleStore;
      store.setState((s) => ({
        unreadByChannel: { ...s.unreadByChannel, [logs]: { last_read_id: '95000000800', unread_count: 3, mention_count: 0 } },
      }));
    }, LOGS);
    await expect(badge(page)).toHaveText('3');

    await page.getByTestId(`channel-${LOGS}`).click();
    await expect(badge(page)).toHaveCount(0);
    await expect(page.getByTestId('message-item')).toHaveCount(0);

    // And it stays gone after leaving again.
    await page.getByTestId('channel-95000000002').click();
    await page.waitForSelector('[data-testid="message-item"]');
    await expect(badge(page)).toHaveCount(0);
  });
});
