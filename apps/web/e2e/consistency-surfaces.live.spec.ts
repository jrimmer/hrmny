/**
 * The UI consistency pass (2026-09-27) in a real browser:
 *
 *   - menus are Radix DropdownMenus: focus ENTERS the menu, Escape hands it
 *     back to the trigger (the Home gear menu, the composer's ＋ menu);
 *   - the composer's emoji picker is a Radix popover: a second click on the
 *     trigger CLOSES it (the hand-rolled one closed on mousedown and the
 *     click re-opened it);
 *   - the hover toolbar wears the popover recipe and its Delete is tinted;
 *   - an EDIT gets the composer's `@` palette.
 *
 * Screenshots land in test-results/consistency-*.png for the visual pass.
 */
import { test, expect } from '@playwright/test';

import {
  accessToken,
  apiRegister,
  makeE2EUser,
  openSeededChannel,
  seedMessage,
  seedWorkspaceWithChannel,
  uiLogin,
  verifyViaMailbox,
} from './helpers';

test('menus, pickers, toolbar and the edit palettes share one language', async ({ page, request }) => {
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const token = await accessToken(page);
  const wsName = `consistency-${Date.now()}`;
  const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
  await seedMessage(request, token, chId, `release notes for <#${chId}> are in`);

  await openSeededChannel(page, wsName, chId);
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // ＋ menu: a real menu — focus enters it, Escape returns to ＋.
  const plus = page.getByTestId('composer-plus');
  await plus.focus();
  await page.keyboard.press('Enter');
  const plusMenu = page.getByTestId('composer-plus-menu');
  await expect(plusMenu).toBeVisible();
  await expect(plusMenu).toHaveAttribute('role', 'menu');
  await expect(page.getByTestId('composer-plus-upload')).toBeFocused();
  await page.screenshot({ path: 'test-results/consistency-01-plus-menu.png' });
  await page.keyboard.press('Escape');
  await expect(plusMenu).toBeHidden();
  await expect(plus).toBeFocused();

  // Emoji picker: the trigger toggles it closed (no mousedown/click reopen).
  const emoji = page.getByTestId('composer-emoji');
  await emoji.click();
  const panel = page.getByTestId('emoji-picker-panel');
  await expect(panel).toBeVisible();
  await page.screenshot({ path: 'test-results/consistency-02-emoji-popover.png' });
  await emoji.click();
  await expect(panel).toBeHidden();
  await expect(composer).toBeFocused();

  // Hover toolbar: popover recipe + tinted Delete.
  const row = page.getByTestId('message-item').filter({ hasText: 'release notes' }).last();
  await row.hover();
  const toolbar = row.getByTestId('message-actions');
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveClass(/popover/);
  const del = row.getByTestId('action-delete');
  const delColor = await del.evaluate((el) => getComputedStyle(el).color);
  const editColor = await row.getByTestId('action-edit').evaluate((el) => getComputedStyle(el).color);
  expect(delColor).not.toBe(editColor);
  await row.screenshot({ path: 'test-results/consistency-03-hover-toolbar.png' });

  // Inline edit: the channel token is a pill, and `@` opens the member palette.
  await row.getByTestId('action-edit').click();
  const edit = page.getByTestId('inline-edit-input');
  await expect(edit).toBeVisible();
  await expect(edit).not.toContainText('<#');
  await edit.press('End');
  await edit.pressSequentially(` @${user.username.slice(0, 5)}`);
  await expect(page.getByTestId('mention-autocomplete')).toBeVisible();
  await page.screenshot({ path: 'test-results/consistency-04-edit-mention-palette.png' });
  await edit.press('Tab');
  await expect(page.getByTestId('mention-autocomplete')).toBeHidden();
  await edit.press('Escape');

  // Home gear menu (HeaderActionsMenu): focus enters; Escape returns.
  await page.getByRole('button', { name: 'Home' }).click();
  const gear = page.getByTestId('home-actions');
  await expect(gear).toBeVisible({ timeout: 15_000 });
  await gear.focus();
  await page.keyboard.press('Enter');
  const homeMenu = page.getByTestId('home-actions-menu');
  await expect(homeMenu).toBeVisible();
  await expect(homeMenu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.screenshot({ path: 'test-results/consistency-05-home-menu.png' });
  await page.keyboard.press('Escape');
  await expect(homeMenu).toBeHidden();
  await expect(gear).toBeFocused();
});
