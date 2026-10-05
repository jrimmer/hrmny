/**
 * UX follow-ups (owner-approved, 2026-09-28) in a real browser.
 *
 * The consistency pass left eight judgment calls; these pin the ones jsdom
 * cannot see (keyboard order across listeners, computed colours, layout).
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test } from '@playwright/test';

import { PEER, mockApi, openChannel, signIn } from './ux-world';

test.describe('Escape steps back one surface at a time', () => {
  test('member profile: the first Escape closes the profile, the second the column', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    await page.getByTestId(`people-row-${PEER}`).click();
    await expect(page.getByTestId('member-profile-overlay')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('member-profile-overlay')).toHaveCount(0);
    await expect(page.getByTestId(`people-row-${PEER}`)).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId(`people-row-${PEER}`)).toHaveCount(0);
  });

  test('call log: Escape closes it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    await page.getByTestId('rail-icon-calls').first().click();
    await expect(page.getByTestId('rail-icon-calls').first()).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('rail-icon-calls').first()).toHaveAttribute('aria-pressed', 'false');
  });
});

test.describe('search results', () => {
  test('every hit wears its author\'s 20px avatar, and a DM is named by the person', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    await page.keyboard.press('Control+k');
    await page.getByTestId('omni-input').fill('deploy');
    await expect(page.locator('.omni-row')).toHaveCount(2);

    const boxes = await page.locator('.omni-row [data-testid="omni-avatar"]').evaluateAll((els) =>
      els.map((el) => {
        const r = el.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), radius: parseFloat(getComputedStyle(el).borderTopLeftRadius) };
      }),
    );
    expect(boxes).toHaveLength(2);
    for (const b of boxes) {
      expect(b).toMatchObject({ w: 20, h: 20 });
      expect(b.radius).toBeGreaterThanOrEqual(10);
    }
    // The DM hit is labelled by the peer's display name (Dana Scully), never "@dana".
    await expect(page.locator('[data-testid="omni-group-dm"] .omni-where')).toHaveText('Dana Scully');
  });

  test('phone: the byline keeps the full width under the place and the stamp', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    await page.keyboard.press('Control+k');
    await page.getByTestId('omni-input').fill('deploy');
    await expect(page.locator('.omni-row')).toHaveCount(2);
    const rows = await page.locator('.omni-row').evaluateAll((els) =>
      els.map((row) => {
        const r = row.getBoundingClientRect();
        const by = row.querySelector('.omni-byline')!.getBoundingClientRect();
        const time = row.querySelector('.omni-time')!.getBoundingClientRect();
        return { row: r.width, byline: by.width, bylineTop: by.top, timeBottom: time.bottom };
      }),
    );
    for (const r of rows) {
      expect(r.byline).toBeGreaterThan(r.row * 0.8);
      expect(r.bylineTop).toBeGreaterThanOrEqual(r.timeBottom - 1);
    }
  });
});

test.describe('phone channel header', () => {
  test('start call and the call-log icon wear one icon style', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    const topbar = page.getByTestId('mobile-topbar');
    const style = (testId: string) =>
      topbar.getByTestId(testId).evaluate((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          border: cs.borderTopWidth,
          background: cs.backgroundColor,
          color: cs.color,
          radius: cs.borderTopLeftRadius,
        };
      });
    const start = await style('topbar-start-call');
    expect(start).toEqual(await style('rail-icon-calls'));
    expect(start.border).toBe('0px');
  });

  test('the title names the open surface, not the channel under it', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);
    const title = page.locator('.mobile-topbar-title');
    await expect(title).toHaveText('#release');

    await page.goto('/#/settings/notifications');
    await expect(title).toHaveText('Settings');
    await expect(page.getByTestId('topbar-start-call')).toHaveCount(0);

    await page.goto('/#/release-notes');
    await expect(title).toHaveText('Release notes');
  });
});

test.describe('sheet and drawer shadows', () => {
  test('the phone drawer casts the theme\'s sheet shade, away from its edge', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    await page.getByTestId('rail-icon-members').first().click();
    const drawer = page.locator('.drawer.members');
    await expect(drawer).toBeVisible();
    const { shadow, shade } = await drawer.evaluate((el) => {
      // Resolve the token through a probe so the colour serialises the way
      // computed box-shadow does.
      const probe = document.createElement('span');
      probe.style.color = 'var(--tk-shade)';
      document.body.appendChild(probe);
      const shade = getComputedStyle(probe).color;
      probe.remove();
      return { shadow: getComputedStyle(el).boxShadow, shade };
    });
    expect(shadow).toContain(shade);
    // Cast to the left: the members drawer docks to the right edge.
    expect(shadow).toMatch(/-4px 0px 24px/);
  });
});
