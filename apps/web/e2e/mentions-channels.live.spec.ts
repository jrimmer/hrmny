/**
 * `@` and `#` completion in a real browser (owner, 2026-09-27):
 *
 *   - `#gen` opens the channel palette; Tab inserts a `#name` pill;
 *   - `@` + Tab inserts the member's TAG (`@username`) as a pill;
 *   - the sent message renders the channel as an in-app link and the mention
 *     as a pill, and the channel link navigates.
 *
 * Screenshots land in test-results/ for the visual pass (palette, composer
 * pills, rendered message).
 */
import { test, expect } from '@playwright/test';

import {
  accessToken,
  API,
  apiRegister,
  makeE2EUser,
  openSeededChannel,
  seedMessage,
  seedWorkspaceWithChannel,
  uiLogin,
  verifyViaMailbox,
} from './helpers';



test('# completes a channel, @ completes a tag, and both render in the sent message', async ({
  page,
  request,
}) => {
  // API register + mailbox verify + UI login: the page never holds a
  // pre-verification session to get stuck behind.
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const username = user.username;
  const token = await accessToken(page);
  const wsName = `mentions-ws-${Date.now()}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);
  const other = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'general-talk' },
  });
  const otherId = (await other.json()).channel.id as string;

  await openSeededChannel(page, wsName, chId);
  // The field is a combobox (it owns the @ / # / : palettes), not a textbox.
  const composer = page.getByTestId('composer-input');
  await expect(composer).toBeVisible({ timeout: 20_000 });

  // `#gen` → the channel palette, listing the matching channel.
  await composer.click();
  await composer.pressSequentially('see #gen');
  const palette = page.getByTestId('channel-autocomplete');
  await expect(palette).toBeVisible();
  await expect(page.getByTestId('channel-option')).toHaveCount(1);
  await expect(page.getByTestId('channel-option').first()).toContainText('general-talk');
  await page.screenshot({ path: 'test-results/mentions-01-channel-palette.png' });

  // Tab completes it into a pill.
  await composer.press('Tab');
  await expect(palette).toBeHidden();
  await expect(page.getByTestId('composer-channel-mention')).toHaveText('#general-talk');

  // `@` + the first letters of our own username → Tab → the TAG pill.
  await composer.pressSequentially(`and @${username.slice(0, 4)}`);
  await expect(page.getByTestId('mention-autocomplete')).toBeVisible();
  await page.screenshot({ path: 'test-results/mentions-02-member-palette.png' });
  await composer.press('Tab');
  await expect(page.getByTestId('composer-mention')).toHaveText(`@${username}`);
  await page.getByTestId('composer-input').screenshot({ path: 'test-results/mentions-03-composer-pills.png' });

  // Send: the body renders the channel as a link and the mention as a pill.
  await composer.press('Enter');
  const body = page.getByTestId('message-content').filter({ hasText: 'see' }).last();
  const link = body.locator(`a.channel-mention[data-channel-id="${otherId}"]`);
  await expect(link).toHaveText('#general-talk');
  await expect(link).toHaveAttribute('href', `#/workspace/${wsId}/channel/${otherId}`);
  await expect(body.locator('.mention').filter({ hasText: `@${username}` })).toBeVisible();
  // Whole page: the virtualized row can re-mount under an element screenshot.
  await page.screenshot({ path: 'test-results/mentions-04-rendered-message.png' });

  // The channel link navigates in-app.
  await link.click();
  await expect(page).toHaveURL(new RegExp(`#/workspace/${wsId}/channel/${otherId}`));
});

/*
 * Pins a live-suite finding (2026-09-29): the `#channel` pill's link changed
 * the address to `#/workspace/<ws>/channel/<ch>`, but nothing routed that
 * address — the shell acted on MESSAGE permalinks only — so the pane stayed
 * where it was. The test above only ever asserted the URL, which is why it
 * stayed green. This one asserts the pane, the way back, the same pill twice,
 * and a channel address the reader cannot open.
 */
test('clicking a #channel pill opens that channel', async ({ page, request }) => {
  const user = makeE2EUser();
  await apiRegister(user);
  await verifyViaMailbox(user);
  await uiLogin(page, user);
  const token = await accessToken(page);
  const wsName = `pill-ws-${Date.now()}`;
  const { wsId, chId } = await seedWorkspaceWithChannel(request, token, wsName);
  const other = await request.post(`${API}/workspaces/${wsId}/channels`, {
    headers: { authorization: `Bearer ${token}` },
    data: { name: 'general-talk' },
  });
  const otherId = (await other.json()).channel.id as string;
  await seedMessage(request, token, chId, `over in <#${otherId}> please`);

  await openSeededChannel(page, wsName, chId);
  const pill = page.locator(`a.channel-mention[data-channel-id="${otherId}"]`).last();
  await expect(pill).toHaveText('#general-talk');
  await pill.click();
  await expect(page.getByTestId('channel-header-name')).toContainText('general-talk', {
    timeout: 5_000,
  });

  // Back: the address before the click is where Back goes, and the pane goes
  // with it once it names a channel.
  await page.goto(`/#/workspace/${wsId}/channel/${chId}`);
  await expect(page.getByTestId('channel-header-name')).not.toContainText('general-talk');
  await page.goBack();
  await expect(page.getByTestId('channel-header-name')).toContainText('general-talk');
  await page.goForward();
  await expect(page.getByTestId('channel-header-name')).not.toContainText('general-talk');

  // The same pill twice: leave through the sidebar (which clears the address
  // back to the bare route), then click the pill again — it must still work.
  const pillAgain = page.locator(`a.channel-mention[data-channel-id="${otherId}"]`).last();
  await pillAgain.click();
  await expect(page.getByTestId('channel-header-name')).toContainText('general-talk');
  await page.getByTestId(`channel-${chId}`).click();
  await expect(page.getByTestId('channel-header-name')).not.toContainText('general-talk');
  await expect(page).not.toHaveURL(new RegExp(`channel/${otherId}`));
  await page.locator(`a.channel-mention[data-channel-id="${otherId}"]`).last().click();
  await expect(page.getByTestId('channel-header-name')).toContainText('general-talk');

  // A channel this reader cannot see (another member's workspace): the pane
  // stays put and says so.
  const stranger = makeE2EUser();
  await apiRegister(stranger);
  await verifyViaMailbox(stranger);
  const sLogin = await request.post(`${API}/auth/login`, {
    data: { identifier: stranger.username, password: stranger.password },
  });
  const sToken = (await sLogin.json()).access_token as string;
  const hidden = await seedWorkspaceWithChannel(request, sToken, `hidden-${Date.now()}`);
  await page.goto(`/#/workspace/${hidden.wsId}/channel/${hidden.chId}`);
  await expect(page.getByTestId('permalink-notice')).toContainText("isn't available");
  await expect(page.getByTestId('channel-header-name')).toContainText('general-talk');
});
