/**
 * Narrow desktop window (plan 003 U7) — the ratified Tauri overlap: desktop
 * windows resize below 768px, so the MOBILE branch renders under a FINE
 * pointer with `hover: hover` media. This context deliberately lives on the
 * DESKTOP project (mouse-only; the mobile project emulates a phone where
 * `hover: none` legitimately disables hover affordances). The hover toolbar
 * — the mouse user's message actions — must keep working inside the mobile
 * branch; the long-press sheet stays the touch path.
 */
import { test, expect } from '@playwright/test';
import {
  accessToken,
  freshLogin,
  registerVerifiedUser,
  seedMessage,
  seedWorkspaceWithChannel,
} from './helpers';

test.use({ viewport: { width: 390, height: 844 } });

test.describe('narrow desktop window (U7)', () => {
  test('hover toolbar still works inside the mobile branch under a mouse', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    const username = await registerVerifiedUser(page, 'nw');
    const token = await accessToken(page);
    const wsName = `narrow-${Date.now().toString(36)}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    await seedMessage(request, token, chId, 'narrow-window hover target');
    // A fresh login (storage wiped) boots into the seeded workspace: a plain
    // reload would restore the member's last location, Home (lane D #3).
    await freshLogin(page, username);
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 15_000 });
    const row = page.getByTestId('message-item').first();
    await expect(row).toBeVisible();

    // Mouse hover (fine pointer) reveals the desktop affordance inside the
    // mobile branch.
    const toolbar = page.getByTestId('message-actions');
    await expect(toolbar).toBeHidden();
    await row.hover();
    await expect(toolbar).toBeVisible();
  });
});
