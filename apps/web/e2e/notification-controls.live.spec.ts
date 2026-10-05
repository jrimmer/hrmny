/**
 * Notification controls (owner-approved design, 2026-09-27) against a real
 * server:
 *
 *   - the channel header's one button cycles All messages → Mentions only →
 *     Nothing, each click confirmed ("Notifications: …") and persisted;
 *   - right-click opens the full menu; "Use workspace default" clears the
 *     channel row and the control goes back to its inherited look;
 *   - a muted channel's sidebar row dims and drops its unread count, but a
 *     broadcast (@everyone) from another member still lands as a MENTION
 *     badge — "Mentions only" includes broadcasts, and a mute never hides a
 *     mention;
 *   - the workspace menu and the channel right-click menu carry the same
 *     Notifications group;
 *   - a reload reads the level back from the server.
 *
 * Screenshots land in test-results/notif-*.png for the visual pass.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';

import {
  accessToken,
  API,
  apiRegister,
  MAILBOX,
  makeE2EUser,
  seedWorkspaceWithChannel,
  uiLogin,
  verifyViaMailbox,
} from './helpers';


/** A second verified human, joined to `wsId` through an invite; returns its token. */
/**
 * Open a channel. The hash route is tried first (the other real-server specs'
 * idiom); a boot that restores Home instead is walked through the UI — the
 * rail's workspace button, then the channel row.
 */
async function openChannel(page: import('@playwright/test').Page, wsId: string, wsName: string, chId: string) {
  await page.goto(`/#/workspace/${wsId}/channel/${chId}`);
  await page.reload();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20_000 });
  const row = page.getByTestId(`channel-${chId}`);
  if (!(await row.isVisible().catch(() => false))) {
    // The rail button's name carries unread counts after it ("ws, 2 unread").
    await page.getByRole('button', { name: new RegExp(`^${wsName}(,|$)`) }).first().click();
  }
  await row.click({ timeout: 20_000 });
  await expect(page.getByTestId('composer-input')).toBeVisible({ timeout: 20_000 });
}

/** Cytale.Permissions.Bitfield `mention_everyone`. */
const MENTION_EVERYONE = 128;

async function secondMember(request: APIRequestContext, tokenA: string, wsId: string): Promise<string> {
  const name = `nb_${Date.now().toString(36)}`;
  const email = `${name}@e2e.local`;
  const password = 'e2e-password-1!';
  const reg = await request.post(`${API}/auth/register`, { data: { username: name, email, password } });
  expect(reg.status(), 'the second member registers').toBe(201);
  const mail = readFileSync(MAILBOX, 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l) as { to?: string; token?: string };
      } catch {
        return null;
      }
    })
    .filter((m) => m?.to === email && m.token)
    .at(-1);
  await request.post(`${API}/auth/verify-email`, { data: { token: mail!.token } });
  const login = await request.post(`${API}/auth/login`, { data: { identifier: name, password } });
  const tokenB = (await login.json()).access_token as string;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, {
    headers: { authorization: `Bearer ${tokenA}` },
    data: {},
  });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
  const accepted = await request.post(`${API}/invites/${code}`, {
    headers: { authorization: `Bearer ${tokenB}` },
    data: {},
  });
  expect(accepted.ok(), 'the second member joins').toBe(true);
  // B broadcasts `@everyone` below, and a broadcast only notifies when its
  // author holds MENTION_EVERYONE (BroadcastGate) — which the @everyone role
  // does not confer. Give B a role that does.
  const a = { authorization: `Bearer ${tokenA}` };
  const role = await request.post(`${API}/workspaces/${wsId}/roles`, {
    headers: a,
    data: { name: 'announcers', permissions: String(MENTION_EVERYONE) },
  });
  expect(role.ok(), 'the announcer role is created').toBe(true);
  const roleId = (await role.json()).role.id as string;
  const bId = (await login.json()).user.id as string;
  const granted = await request.put(`${API}/workspaces/${wsId}/roles/${roleId}/members/${bId}`, {
    headers: a,
  });
  expect(granted.ok(), 'the second member may broadcast').toBe(true);
  return tokenB;
}

test('header cycle, menu reset, muted sidebar row, broadcast mention through a mute', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });

  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const token = await accessToken(page);
  const wsName = `notif-ws-${Date.now()}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);
  const other = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'lounge' },
  });
  const loungeId = (await other.json()).channel.id as string;
  const tokenB = await secondMember(request, token, wsId);

  await openChannel(page, wsId, wsName, chId);

  // --- the header control: inherited, then cycled ---------------------------
  const control = page.getByTestId('header-notifications');
  await expect(control).toBeVisible();
  await expect(control).toHaveAttribute('data-inherited', 'true');
  await expect(control).toHaveAttribute(
    'aria-label',
    'Notifications: Mentions only (account default) — click for Nothing',
  );
  await page.getByTestId('channel-header').screenshot({ path: 'test-results/notif-01-header-inherited.png' });

  const confirm = page.getByTestId('header-notifications-confirm');
  const seen: string[] = [];
  for (const [level, words] of [
    ['mute', 'Nothing'],
    ['all', 'All messages'],
    ['mentions', 'Mentions only'],
  ] as const) {
    await control.click();
    await expect(control).toHaveAttribute('data-level', level);
    await expect(confirm).toHaveText(`Notifications: ${words}`);
    await expect(control).not.toHaveAttribute('data-inherited', 'true');
    await page
      .getByTestId('channel-header')
      .screenshot({ path: `test-results/notif-02-header-${level}.png` });
    seen.push(level);
  }
  expect(seen).toEqual(['mute', 'all', 'mentions']);

  // The server holds the last write.
  const prefs = await request.get(`${API}/users/@me/notification-preferences`, {
    headers: { authorization: `Bearer ${token}` },
  });
  expect((await prefs.json()).preferences).toContainEqual({
    scope: 'channel',
    entity_id: chId,
    level: 'mentions',
  });

  // --- right-click: the full menu, then "Use workspace default" --------------
  await control.click({ button: 'right' });
  const menu = page.getByTestId('header-notifications-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('header-notifications-menu-level-mentions')).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.waitForTimeout(400); // let the menu's fade-in settle for the shot
  await page.screenshot({ path: 'test-results/notif-03-header-menu.png' });
  await page.getByTestId('header-notifications-menu-level-inherit').click();
  await expect(menu).toBeHidden();
  await expect(control).toHaveAttribute('data-inherited', 'true');

  // --- mute from the header, then watch the sidebar row ---------------------
  await control.click(); // inherited mentions → Nothing
  await expect(control).toHaveAttribute('data-level', 'mute');
  // Leave the channel so new traffic accrues as unread.
  await page.getByTestId(`channel-${loungeId}`).click();
  await expect(page.getByTestId('channel-header-name')).toContainText('lounge');

  const row = page.getByTestId(`channel-${chId}`);
  await expect(row).toHaveAttribute('data-muted', 'true');

  const b = { authorization: `Bearer ${tokenB}` };
  const plain = await request.post(`${API}/channels/${chId}/messages`, { headers: b, data: { content: 'plain chatter' } });
  expect(plain.ok()).toBe(true);
  // Muted: no unread badge, no unread weight — the row stays quiet.
  await page.waitForTimeout(1500);
  await expect(page.getByTestId(`unread-${chId}`)).toHaveCount(0);
  await expect(page.getByTestId(`muted-${chId}`)).toBeVisible();
  await page.getByTestId('channel-sidebar').screenshot({ path: 'test-results/notif-04-sidebar-muted.png' }).catch(async () => {
    await page.screenshot({ path: 'test-results/notif-04-sidebar-muted.png' });
  });

  // A broadcast addresses the member: it lands as a mention even through the mute.
  const everyone = await request.post(`${API}/channels/${chId}/messages`, {
    headers: b,
    data: { content: '@everyone standup in five' },
  });
  expect(everyone.ok()).toBe(true);
  await expect(page.getByTestId(`mentions-${chId}`)).toHaveText('1', { timeout: 15_000 });
  await expect(page.getByTestId(`unread-${chId}`)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/notif-05-sidebar-muted-with-mention.png' });

  // --- the channel right-click menu carries the same group -------------------
  await row.click({ button: 'right' });
  const channelMenu = page.getByTestId('channel-context-menu');
  await expect(channelMenu).toBeVisible();
  await expect(page.getByTestId('channel-context-level-mute')).toHaveAttribute('aria-checked', 'true');
  await expect(channelMenu.getByTestId('channel-context-mute-rings')).toBeVisible();
  await page.waitForTimeout(400); // let the menu's fade-in settle for the shot
  await page.screenshot({ path: 'test-results/notif-06-channel-context-menu.png' });
  await page.keyboard.press('Escape');

  // --- the workspace menu's group ---------------------------------------------
  await page.getByTestId('workspace-menu-trigger').click();
  await expect(page.getByTestId('workspace-menu-notifications')).toBeVisible();
  await expect(page.getByTestId('workspace-menu-suppress-broadcasts')).toHaveAttribute('aria-checked', 'false');
  await page.waitForTimeout(400); // let the menu's fade-in settle for the shot
  await page.screenshot({ path: 'test-results/notif-07-workspace-menu.png' });
  await page.keyboard.press('Escape');

  // --- a reload reads the level back from the server --------------------------
  await openChannel(page, wsId, wsName, loungeId);
  await expect(page.getByTestId(`channel-${chId}`)).toHaveAttribute('data-muted', 'true', { timeout: 20_000 });
  // The durable broadcast row survives the reload as the mention badge.
  await expect(page.getByTestId(`mentions-${chId}`)).toHaveText('1', { timeout: 15_000 });
});

test('the phone topbar cycles on tap and opens the sheet on long-press', async ({ page, request }) => {
  test.setTimeout(120_000);

  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const token = await accessToken(page);
  const wsName = `notif-phone-${Date.now()}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);

  // Open the channel at desktop width (the sidebar is on screen), then drop
  // to phone width: the topbar takes over and carries the control.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChannel(page, wsId, wsName, chId);
  await page.setViewportSize({ width: 390, height: 844 });
  // The desktop Members column must NOT come up as the phone's modal drawer
  // on the resize (live suite, CI run 2995: a "Members" dialog opened by
  // itself over the topbar and intercepted every tap here). At phone width a
  // drawer opens only when its icon is tapped.
  const control = page.getByTestId('topbar-notifications');
  await expect(control).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500); // past the band's resize debounce and any drawer animation
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await control.click();
  await expect(control).toHaveAttribute('data-level', 'mute');
  await page.getByTestId('mobile-topbar').screenshot({ path: 'test-results/notif-08-phone-topbar-mute.png' });

  // Long-press = the context menu gesture here (Chromium without touch
  // emulation fires contextmenu); the sheet variant opens the sheet.
  await control.click({ button: 'right' });
  const sheet = page.getByTestId('topbar-notifications-sheet');
  await expect(sheet).toBeVisible();
  await expect(page.getByTestId('topbar-notifications-sheet-mute')).toHaveAttribute('aria-checked', 'true');
  await page.waitForTimeout(400); // let the menu's fade-in settle for the shot
  await page.screenshot({ path: 'test-results/notif-09-phone-sheet.png' });
  await page.getByTestId('topbar-notifications-sheet-inherit').click();
  await expect(sheet).toBeHidden();
  await expect(control).toHaveAttribute('data-inherited', 'true');

  // …and the drawer is still one tap away: the first tap on Members opens it.
  await page.getByTestId('mobile-topbar').getByTestId('rail-icon-members').click();
  await expect(page.getByRole('dialog', { name: 'Members' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Members' })).toHaveCount(0);
});

test('a phone-width load opens no drawer until one is tapped', async ({ page, request }) => {
  test.setTimeout(120_000);
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const token = await accessToken(page);
  const wsName = `phone-load-${Date.now()}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);
  // Visit the channel at desktop first, so a Members column is what this
  // browser last had open, then load the app afresh at phone width.
  await page.setViewportSize({ width: 1440, height: 900 });
  await openChannel(page, wsId, wsName, chId);
  await expect(page.getByTestId('member-list')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId('mobile-topbar')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(1_000);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The topbar is live, not behind an inert modal.
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog', { name: 'Channels' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
