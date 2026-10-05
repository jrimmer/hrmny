/**
 * UX consistency (owner report 2026-09-28) in a real browser.
 *
 * "Please unify the avatar render — you'll see it's a square here": Home's
 * inbox drew its author avatar as a square tile with body-sized initials,
 * beside round avatars everywhere else. jsdom computes no layout, so the shape
 * is measured here: every avatar on Home and in the channel is a circle whose
 * initials scale with it, and the inbox avatar matches its peers (the people
 * list's two-line-row size, the agent seal for a machine author).
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page } from '@playwright/test';

import { WS, mockApi, openChannel, signIn } from './ux-world';

interface AvatarBox {
  cls: string;
  w: number;
  h: number;
  radius: number;
  fontSize: number;
  color: string;
}

async function avatars(page: Page, scope = 'body'): Promise<AvatarBox[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll(`${sel} .avatar`))
      .filter((el) => (el as HTMLElement).offsetParent !== null)
      .map((el) => {
        const cs = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return {
          cls: (el as HTMLElement).className,
          w: Math.round(r.width),
          h: Math.round(r.height),
          radius: parseFloat(cs.borderTopLeftRadius),
          fontSize: parseFloat(cs.fontSize),
          color: cs.color,
        };
      });
  }, scope);
}

function expectRound(list: AvatarBox[]): void {
  expect(list.length).toBeGreaterThan(0);
  for (const a of list) {
    expect(a.w, `${a.cls} is square-boxed`).toBe(a.h);
    expect(a.radius, `${a.cls} is a circle`).toBeGreaterThanOrEqual(a.w / 2);
    // Initials scale with the circle (never the body's 14-16px on a 16px dot).
    expect(a.fontSize, `${a.cls} initials fit`).toBeLessThanOrEqual(a.w * 0.6);
  }
}

test.describe('one avatar, one shape', () => {
  test('Home: the inbox avatar is a circle like its peers, and a machine author wears the seal', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await page.getByTestId('rail-home').click();

    const inbox = page.getByTestId('home-inbox').first();
    await expect(inbox.getByTestId('inbox-list')).toBeVisible();

    const all = await avatars(page);
    expectRound(all);

    const row = inbox.locator('li', { has: page.locator(`[data-testid="kind-badge"]`) }).first();
    await expect(row).toBeVisible();
    const box = (await avatars(page, '[data-testid="home-inbox"] li'))[0]!;
    // The people list's two-line-row step, white initials on the hue tile.
    expect(box.w).toBe(36);
    expect(box.color).toBe('rgb(255, 255, 255)');
    await expect(row.locator('.inbox-row-author')).toHaveText('mia');
    await expect(row.getByTestId('kind-badge')).toHaveAttribute('title', /^Agent account/);
  });

  test('channel: message, reply-context, member-list and user-panel avatars share the shape', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);

    const list = await avatars(page);
    expectRound(list);
    const sizes = new Set(list.map((a) => a.w));
    // The one scale: reply context 16, user panel 32, members 36, messages 40.
    for (const w of sizes) expect([16, 20, 28, 32, 36, 40, 48, 64, 72]).toContain(w);
  });
});

test.describe('one chrome', () => {
  for (const vp of [
    { label: 'desktop', width: 1440, height: 900 },
    { label: 'phone', width: 390, height: 844 },
  ]) {
    test(`search (${vp.label}): the palette is centred, holds still, and wears the house ✕`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await mockApi(page);
      await signIn(page);
      await openChannel(page);
      await page.keyboard.press('Control+k');
      const input = page.getByTestId('omni-input');
      await expect(input).toBeVisible();
      const panel = page.locator('.omni-panel');
      const before = await panel.boundingBox();
      await input.fill('deploy');
      await expect(page.getByTestId('omnisearch').getByText('Direct Messages')).toBeVisible();
      await page.waitForTimeout(250); // let the open animation settle
      const after = await panel.boundingBox();
      // Centred (the wrapper's translate compounded with ours: it sat a
      // quarter-width left, off-screen on a phone).
      expect(Math.abs(after!.x + after!.width / 2 - vp.width / 2)).toBeLessThanOrEqual(2);
      expect(after!.x).toBeGreaterThanOrEqual(0);
      // Top-anchored: results arriving grow it downward, never move its top.
      expect(Math.abs(after!.y - before!.y)).toBeLessThanOrEqual(2);
      // The house ✕ (.modal-close), not the wrapper's lucide X.
      await expect(page.getByTestId('omni-close')).toHaveClass(/modal-close/);
      await expect(page.locator('[data-slot="dialog-content"] > button > svg.lucide-x')).toHaveCount(0);
      await page.getByTestId('omni-close').click();
      await expect(input).toBeHidden();
    });
  }

  test('release notes: Escape closes it, like the settings panes beside it', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await openChannel(page);
    await page.goto('/#/release-notes');
    await expect(page.getByTestId('release-notes-pane')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('release-notes-pane')).toBeHidden();
  });

  test('workspace settings: the image preview draws the rail tile (one initial, same shape)', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await page.goto('/#/wsettings/overview');
    const preview = page.getByTestId('wsettings-icon-preview');
    await expect(preview).toBeVisible();
    const railText = (await page.getByTestId(`workspace-${WS}`).locator('.workspace-initial').textContent())?.trim();
    expect(railText).toBe('P');
    await expect(preview).toHaveText(railText!);
  });

  test('inbox: "Mark all done" and each row\'s "Done" are one size', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockApi(page);
    await signIn(page);
    await page.getByTestId('rail-home').click();
    await expect(page.locator('.inbox-row-done').first()).toBeVisible();
    // Both inbox variants (the Home column and the dashboard): every sweep
    // and every row's Done — they were 24/30px in one and 36/30px in the other.
    const boxes = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.inbox-sweep, .inbox-row-done'))
        .filter((el) => (el as HTMLElement).offsetParent !== null)
        .map((el) => ({ h: Math.round(el.getBoundingClientRect().height), fs: getComputedStyle(el).fontSize })),
    );
    expect(boxes.length).toBeGreaterThanOrEqual(4);
    expect(new Set(boxes.map((b) => b.h)).size).toBe(1);
    expect(new Set(boxes.map((b) => b.fs)).size).toBe(1);
  });
});
