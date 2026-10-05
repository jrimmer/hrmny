/**
 * E2E — the user settings surface (real browser, real API).
 *
 * Covers what jsdom unit tests can't: the gear → #/settings route, every
 * section's live behavior against the running server (profile PATCH,
 * appearance persistence, integrations rollup, reaction-favorites editing),
 * and the logout loop. Assumes the dev stack is up (:5173 + :4000).
 */
import { expect, test } from '@playwright/test';

import {
  accessToken,
  apiRegister,
  makeE2EUser,
  openSeededChannel,
  seedWorkspaceWithChannel,
  type E2EUser,
  uiLogin,
  verifyViaMailbox,
} from './helpers';

// Real 1×1 PNG bytes (parseable IHDR — the server's dimension sniffer and
// the browser both accept it).
const PNG_1X1 = Buffer.from(
  '89504e470d0a1a0a0000000d4948445200000001000000010806000000' +
    '1f15c4890000000d49444154789c626001000000ffff03000006000557bfabd40000000049454e44ae426082',
  'hex',
);

let user: E2EUser;

test.beforeAll(async () => {
  user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user); // verified ⇒ settings writes are permitted
});

test('login lands in the shell with the user panel', async ({ page }) => {
  await uiLogin(page, user);
  await expect(page.getByTestId('user-panel')).toContainText(user.username);
});

test('the gear opens the settings surface with the section nav', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await expect(page.getByTestId('settings-nav')).toBeVisible();
  // The route is hash-addressed (#/settings/:section).
  await expect(page.getByTestId('settings-account')).toBeVisible();
});

test('My Account: identity rows + display-name save round-trips', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await expect(page.getByTestId('settings-account')).toBeVisible();

  await expect(page.getByTestId('account-username')).toHaveText(user.username);
  await expect(page.getByTestId('account-email')).toHaveText(user.email);
  await expect(page.getByTestId('account-verified')).toBeVisible();

  const input = page.getByTestId('account-display-name');
  await input.fill('E2E Renamed');
  await page.getByTestId('account-save').click();
  // The identity card echoes the saved name without a reload.
  await expect(page.getByTestId('settings-account')).toContainText('E2E Renamed');
});

test('Appearance: reduce-motion toggle persists to localStorage', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await page.getByTestId('settings-nav-appearance').click();
  await expect(page.getByTestId('settings-appearance')).toBeVisible();

  const toggle = page.getByTestId('appearance-reduce-motion');
  await toggle.click();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('cytale.reduce-motion')))
    .toBe('1');
});

test('Agents: the section renders for a fresh account (empty state)', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  // The integrations rollup split into Agents + Webhooks (user-scoped
  // integrations plan); the nav entry kept its `integrations` id.
  await page.getByTestId('settings-nav-integrations').click();
  await expect(page.getByTestId('bots-pane')).toBeVisible();
  // A fresh account owns no agents: the empty state, not an error.
  await expect(page.getByTestId('bots-empty')).toBeVisible();
});

test('Reaction emoji: removing a favorite shrinks the list and persists', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await page.getByTestId('settings-nav-emoji').click();

  const chips = page.getByTestId('reaction-favorites-chip');
  // The nav click switches the section via an async hashchange render —
  // wait for the favorites row to actually mount before counting (a bare
  // count() races the ~20ms switch and lands on the previous section's
  // zero chips; observed flaking on a slow stack).
  await expect(chips.first()).toBeVisible();
  const before = await chips.count();
  expect(before).toBeGreaterThan(1);

  // The ✕ is hover-revealed inside the chip (hover-controls doctrine):
  // hover the chip, then the remove button is clickable.
  await chips.first().hover();
  await page.getByTestId('reaction-favorites-remove').first().click();
  // Count line reads "<n> / <cap>".
  await expect(page.getByTestId('reaction-favorites-count')).toContainText(
    String(before - 1),
  );
  // Persisted per browser: reload keeps the shrunken set. The hash restores
  // the settings surface directly — no gear click needed (it would TOGGLE
  // the surface closed).
  await page.reload();
  await expect(page.getByTestId('settings-reaction-emoji')).toBeVisible();
  await expect(page.getByTestId('reaction-favorites-count')).toContainText(
    String(before - 1),
  );
});

test('logout from settings footer returns to the sign-in page; the session is really gone', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await page.getByTestId('settings-nav-logout').click();
  await expect(page.getByTestId('login-page')).toBeVisible();

  // The shell is not reachable without signing back in.
  await page.goto('/');
  await expect(page.getByTestId('login-page')).toBeVisible();
  // And the credentials still work (logout revokes the session, not the account).
  await uiLogin(page, user);
  await expect(page.getByTestId('user-panel')).toContainText(user.username);
});


test('My Account: avatar upload sets the image and Remove clears it', async ({ page }) => {
  await uiLogin(page, user);
  await page.getByTestId('user-settings-toggle').click();
  await expect(page.getByTestId('settings-account')).toBeVisible();

  const preview = page.getByTestId('account-avatar-preview');

  // No avatar yet: the initials tile renders (no <img> inside), no Remove.
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(page.getByTestId('account-avatar-remove')).toHaveCount(0);

  // Upload through the hidden picker input; #48 stages into the crop
  // dialog first — Confirm exports the cropped square (real browser
  // canvas; the 1x1 source exports at its own 1px side, uncapped-up).
  await page.getByTestId('account-avatar-input').setInputFiles({
    name: 'me.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await page.getByTestId('crop-confirm').click({ timeout: 10_000 });

  // The preview now carries the content-addressed image and the blob loads.
  const img = preview.locator('img');
  await expect(img).toHaveCount(1);
  await expect(img).toHaveAttribute('src', /\/api\/v1\/attachments\/[0-9a-f]{64}$/);
  await expect(img).toHaveJSProperty('naturalWidth', 1);

  // Remove clears it back to the tile.
  await page.getByTestId('account-avatar-remove').click();
  await expect(preview.locator('img')).toHaveCount(0);
  await expect(page.getByTestId('account-avatar-remove')).toHaveCount(0);
});

test('Workspace Settings: ⌄ menu opens the surface; icon + name round-trip', async ({
  page,
  request,
}) => {
  await uiLogin(page, user);

  // Seed a workspace through the API, then open it (see openSeededChannel).
  const token = await accessToken(page);
  const wsName = `wsettings-ws-${Date.now()}`;
  const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
  await openSeededChannel(page, wsName, chId);
  await page.waitForSelector('[data-testid="server-header"]', { timeout: 15_000 });

  // ⌄ menu → Workspace Settings.
  await page.getByTestId('workspace-menu-trigger').click();
  await page.getByTestId('workspace-menu-settings').click();
  await expect(page.getByTestId('wsettings-nav')).toBeVisible();
  await expect(page.getByTestId('wsettings-overview')).toBeVisible();

  // Owner (admin): icon upload sets the preview image.
  const preview = page.getByTestId('wsettings-icon-preview');
  await expect(preview.locator('img')).toHaveCount(0);
  await page.getByTestId('wsettings-icon-input').setInputFiles({
    name: 'logo.png',
    mimeType: 'image/png',
    buffer: PNG_1X1,
  });
  await page.getByTestId('crop-confirm').click({ timeout: 10_000 });
  await expect(preview.locator('img')).toHaveCount(1);
  await expect(preview.locator('img')).toHaveAttribute(
    'src',
    /\/api\/v1\/attachments\/[0-9a-f]{64}$/,
  );

  // Rename round-trips through the PATCH.
  const input = page.getByTestId('wsettings-name-input');
  await input.fill('E2E Renamed HQ');
  await page.getByTestId('wsettings-name-save').click();
  await expect(page.getByTestId('wsettings-saved')).toBeVisible();
  await expect(page.getByTestId('wsettings-name-input')).toHaveValue('E2E Renamed HQ');
});
