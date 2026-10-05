/**
 * Shell findings from the on-demand live suite (2026-09-29), pinned here too
 * so the regular fixture-backed run covers them:
 *
 *   - a `#channel` pill (and its hash route, `#/workspace/<ws>/channel/<ch>`)
 *     opens the channel, the way the sidebar does; Back returns; a channel the
 *     reader cannot see says so and leaves the pane where it was;
 *   - Home at desktop offers its rail icons, and Threads opens My Threads;
 *   - at phone width the side drawer opens only when its icon is tapped —
 *     never from the desktop Members column carried across a resize.
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page } from '@playwright/test';

import { CH, WS, mockApi, openChannel, signIn } from './ux-world';

const CH2 = '95000000020';

/** A second channel whose one message links back to #release (CH). */
async function addSecondChannel(page: Page): Promise<void> {
  const channel = (id: string, name: string, position: number, last: string | null) => ({
    id, workspace_id: WS, name, type: 0, parent_id: null, topic: null, position,
    last_message_id: last, created_at: '2026-09-01T00:00:00Z',
  });
  await page.route(`**/api/v1/workspaces/${WS}/channels`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        channels: [channel(CH, 'release', 0, '95000000104'), channel(CH2, 'general-talk', 1, '95000000021')],
      }),
    }),
  );
  await page.route(`**/api/v1/channels/${CH2}/**`, (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path.endsWith('/messages')
      ? {
          messages: [{
            id: '95000000021', channel_id: CH2, thread_id: null, author_id: '95000000004',
            content: `over in <#${CH}> please`, created_at: new Date().toISOString(), edited_at: null, attachments: null,
          }],
          oldest_id: null,
        }
      : path.endsWith('/threads')
        ? { threads: [] }
        : path.endsWith('/call')
          ? { call: null }
          : {};
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const header = (page: Page) => page.getByTestId('channel-header-name');

test.describe('the channel route', () => {
  test('a #channel pill opens the channel; Back returns; the same pill works twice', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await addSecondChannel(page);
    await signIn(page);
    await page.goto(`/#/workspace/${WS}/channel/${CH2}`);
    await expect(header(page)).toContainText('general-talk');

    const pill = page.locator(`a.channel-mention[data-channel-id="${CH}"]`).last();
    await pill.click();
    await expect(header(page)).toContainText('release');

    await page.goBack();
    await expect(header(page)).toContainText('general-talk');
    await page.goForward();
    await expect(header(page)).toContainText('release');

    // Leave through the sidebar: the address stops naming #release (it is
    // cleared in place), so the same pill still changes it — and still works.
    await page.getByTestId(`channel-${CH2}`).click();
    await expect(header(page)).toContainText('general-talk');
    await expect(page).not.toHaveURL(new RegExp(`channel/${CH}`));
    await page.locator(`a.channel-mention[data-channel-id="${CH}"]`).last().click();
    await expect(header(page)).toContainText('release');
  });

  test('a channel the reader cannot see is "not available", and the pane stays put', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await addSecondChannel(page);
    await signIn(page);
    await page.goto(`/#/workspace/${WS}/channel/${CH2}`);
    await expect(header(page)).toContainText('general-talk');

    await page.goto(`/#/workspace/${WS}/channel/95000000999`);
    await expect(page.getByTestId('permalink-notice')).toContainText("isn't available");
    await expect(header(page)).toContainText('general-talk');
    // The dead address does not linger to be reloaded.
    await expect(page).not.toHaveURL(/95000000999/);
  });
});

test.describe('Home at desktop', () => {
  test('offers Call log and Threads (no Members); Threads opens My Threads', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);
    // The channel surface opens its Members column by default at desktop…
    await expect(page.getByTestId('member-list')).toBeVisible();

    // …and that default does not follow the reader to Home, nor hide Home's band.
    await page.getByRole('button', { name: 'Home' }).click();
    await expect(page.getByTestId('home-dashboard')).toBeVisible();
    await expect(page.getByTestId('member-list')).toHaveCount(0);
    const band = page.getByTestId('home-rail-icons');
    await expect(band).toBeVisible();
    await expect(band.getByTestId('rail-icon-members')).toHaveCount(0);
    await expect(band.getByTestId('rail-icon-calls')).toBeVisible();

    await band.getByTestId('rail-icon-threads').click();
    await expect(page.getByTestId('my-threads-sidebar')).toBeVisible();
    // The icons ride the open column's header now, not a second set in the band.
    await expect(page.getByTestId('home-rail-icons')).toHaveCount(0);
    await page.getByTestId('member-list').getByTestId('rail-icon-threads').click();
    await expect(page.getByTestId('my-threads-sidebar')).toHaveCount(0);
    await expect(page.getByTestId('home-rail-icons')).toBeVisible();

    // Back in the channel, its own Members column is still there.
    await page.getByTestId(`workspace-${WS}`).click();
    await expect(page.getByTestId('member-list')).toBeVisible();
  });
});

test.describe('the phone drawer opens only on a tap', () => {
  test('a desktop Members column carried to phone width does not open the drawer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);
    await expect(page.getByTestId('member-list')).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId('mobile-topbar')).toBeVisible();
    await page.waitForTimeout(500); // the band's resize debounce, and any drawer animation
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // The topbar is live, and the first tap on Members opens the drawer.
    await page.getByTestId('mobile-topbar').getByTestId('rail-icon-members').click();
    await expect(page.getByRole('dialog', { name: 'Members' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('a phone-width load opens no drawer', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);
    await page.waitForTimeout(500);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByTestId('mobile-topbar')).toBeVisible();
  });
});
