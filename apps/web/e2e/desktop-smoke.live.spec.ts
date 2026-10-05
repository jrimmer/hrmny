/**
 * Desktop-viewport smoke (plan 003 U7) — the parity gate for the responsive
 * work: home, channel, and settings still render at the desktop viewport
 * after the ≤767px shell rework. Deep coverage lives in settings.live.spec.ts
 * and reply.live.spec.ts; this file only catches structural regressions fast.
 */
import { test, expect } from '@playwright/test';
import {
  accessToken,
  openSeededChannel,
  registerVerifiedUser,
  seedMessage,
  seedWorkspaceWithChannel,
} from './helpers';

test.describe('desktop smoke (U7 parity)', () => {
  test('home, channel, and settings render at desktop width', async ({ page, request }) => {
    test.setTimeout(90_000);
    await registerVerifiedUser(page, 'smoke');

    // Home: the dashboard hero (fresh account).
    await expect(page.getByTestId('home-hero-title')).toBeVisible();
    // Desktop shell invariants: left cluster + members rail, no topbar.
    await expect(page.getByTestId('left-cluster')).toBeVisible();
    await expect(page.getByTestId('mobile-topbar')).toHaveCount(0);

    // Channel: seed a workspace + one message, land in it, pane + row present.
    const token = await accessToken(page);
    const wsName = `smoke-${Date.now().toString(36)}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    await seedMessage(request, token, chId, 'smoke message');
    await openSeededChannel(page, wsName, chId);
    await page.waitForSelector('[data-testid="server-header"]', { timeout: 15_000 });
    await expect(page.getByRole('combobox', { name: 'Message' })).toBeVisible();
    await expect(page.getByTestId('message-item').first()).toBeVisible();
    // #6 ratification pin: the pane header's Start-call control is live for
    // workspace members at desktop (dormant before plan 003's U2 lift).
    await expect(page.getByTestId('header-start-call')).toBeVisible();

    // Settings: gear opens the col-2 nav (the desktop doctrine untouched).
    await page.getByTestId('user-settings-toggle').click();
    await expect(page.getByTestId('settings-nav')).toBeVisible();
  });
});
