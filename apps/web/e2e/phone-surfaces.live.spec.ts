/**
 * Phone surfaces (#86) — the ticket's visual deliverable.
 *
 * The band matrix (`responsive-matrix.live.spec.ts`) asserts the shell contract and
 * the phone leg (`mobile.live.spec.ts`) asserts the behaviours; this exists purely
 * for EVIDENCE: the surfaces the 2026-09-07 audit named (B1–B4) plus the
 * composer, captured at **1x and 4x** per the house rule — 4x is a second
 * context at deviceScaleFactor 4, so hairlines, 1px borders and text rendering
 * are inspectable rather than inferred.
 *
 * Real data, real gestures: a registered account, a seeded workspace/channel,
 * an API-seeded message, and the genuine long-press (600ms > the 450ms
 * threshold) for the action sheet. A DOM rendered by hand would prove nothing
 * about the surface.
 *
 * Not covered here: the composer with a SOFTWARE keyboard (no soft keyboard in
 * a headless engine — that needs a real-device capture, which is what the
 * owner's iPhone pass is for) and the typing pill, which needs a live typist.
 */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedMessage,
  seedWorkspaceWithChannel,
} from './helpers';

/** Untracked by policy (.gitignore: /docs/research/screenshots/). */
const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-13-phone-surfaces',
);

test.describe('phone surfaces at 1x and 4x (#86)', () => {
  for (const dsf of [1, 4]) {
    test(`390x844 @ ${dsf}x — drawers, action sheet, thread sheet, settings`, async ({
      browser,
      request,
    }) => {
      test.setTimeout(300_000);
      mkdirSync(OUT, { recursive: true });

      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: dsf,
        isMobile: true,
        hasTouch: true,
      });
      const page = await context.newPage();
      const shot = (name: string) => page.screenshot({ path: join(OUT, `${name}-${dsf}x.png`) });

      const username = await registerVerifiedUser(page, `p${dsf}`);
      const token = await accessToken(page);
      const { chId } = await seedWorkspaceWithChannel(
        request,
        token,
        `phone-${dsf}-${Date.now().toString(36)}`,
      );
      await seedMessage(request, token, chId, 'phone surface capture row');

      // Boot into the seeded channel (a plain reload restores Home).
      await reloadIntoFirstWorkspace(page);
      await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 20_000 });
      await expect(page.locator('[data-testid="message-item"]').first()).toBeVisible({
        timeout: 20_000,
      });

      // 1 — the conversation and its composer (the phone shell's default).
      await shot('messages');

      // 2 — the navigation drawer; carries the workspace strip (B1/B2).
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await expect(page.getByTestId('drawer-workspace-strip')).toBeVisible();
      await shot('nav-drawer');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('drawer-workspace-strip')).toBeHidden();

      // 3 — the members drawer.
      await page.getByTestId('rail-icon-members').click();
      await shot('members-drawer');
      await page.keyboard.press('Escape');

      // 4 — the long-press action sheet (hold past the 450ms threshold).
      await page.locator('[data-testid="message-item"]').first().click({ delay: 600 });
      await expect(page.getByTestId('message-actions-sheet')).toBeVisible();
      await shot('action-sheet');

      // 5 — the thread sheet, opened from the sheet's own Thread action.
      await page.getByTestId('sheet-action-thread').click();
      await expect(page.getByTestId('thread-sheet')).toBeVisible({ timeout: 20_000 });
      await shot('thread-sheet');
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('thread-sheet')).toBeHidden({ timeout: 10_000 });

      // 6 — settings, which is only reachable through the drawer's gear (B4).
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.getByTestId('user-settings-toggle').click();
      await expect(page.getByTestId('settings-nav')).toBeVisible({ timeout: 10_000 });
      await shot('settings');

      await context.close();
    });
  }
});
