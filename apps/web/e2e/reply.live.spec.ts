/**
 * The inline-reply journey (Discord semantics) end-to-end in a real browser:
 * login → post → hover-reply (bar, ping toggle, Escape cancel, Shift+click)
 * → send → context line + spine → jump-to-original flash.
 */
import { test, expect } from '@playwright/test';

const RUN = Date.now().toString(36);
import {
  accessToken,
  openSeededChannel,
  registerVerifiedUser,
  seedWorkspaceWithChannel,
} from './helpers';

test.describe('inline replies', () => {
  // test.fixme'd 2026-09-07 for a fresh-session boot race (the composer
  // mounted late). The boot has been rebuilt since (READY in one frame,
  // 45faed97); re-enabled for the live suite, it walks into the seeded channel
  // because a reload now restores the member's last location (Home).
  test('full reply journey: bar → send → context line → jump', async ({ page, request }) => {
    const username = await registerVerifiedUser(page, 'reply');
    const token = await accessToken(page);
    const wsName = `reply-ws-${Date.now()}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    await openSeededChannel(page, wsName, chId);

    // Post the original through the composer.
    const composer = page.getByTestId('composer-input');
    await composer.click();
    await composer.pressSequentially(`original ${RUN}`);
    await composer.press('Enter');
    await expect(page.getByTestId('message-content').filter({ hasText: `original ${RUN}` })).toBeVisible();

    // Hover → reply arrow → the bar appears with author + snippet + ping on.
    const original = page.locator('[data-testid="message-item"]', {
      hasText: `original ${RUN}`,
    }).first();
    await original.hover();
    await original.getByRole('button', { name: 'Reply to message' }).click();
    const bar = page.getByTestId('reply-bar');
    await expect(bar).toBeVisible();
    await expect(bar).toContainText(`Replying to ${username}`);
    await expect(page.getByTestId('reply-bar-ping')).toHaveAttribute('aria-pressed', 'true');

    // Escape cancels the reply.
    await page.keyboard.press('Escape');
    await expect(bar).toBeHidden({ timeout: 5_000 });

    // Shift+click reply starts with the ping suppressed.
    await original.hover();
    await original.getByRole('button', { name: 'Reply to message' }).click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('reply-bar-ping')).toHaveAttribute('aria-pressed', 'false');

    // Send the reply; the bar clears and the reply renders with the context
    // line (author + snippet) joined by the spine.
    await composer.click();
    await composer.pressSequentially(`reply ${RUN}`);
    await composer.press('Enter');
    await expect(bar).toBeHidden({ timeout: 10_000 });
    const composeErr = await page.getByTestId('composer-error').count();
    if (composeErr) console.log('COMPOSE-ERR', await page.getByTestId('composer-error').textContent());
    await expect(page.getByTestId('message-content').filter({ hasText: `reply ${RUN}` })).toBeVisible();

    const replyItem = page.locator('[data-testid="message-item"]', {
      has: page.getByText(`reply ${RUN}`),
    }).first();
    const context = replyItem.getByTestId('reply-context');
    await expect(context).toBeVisible();
    await expect(context).toContainText(username);
    await expect(context).toContainText(`original ${RUN}`);

    // Jump: clicking the context line scrolls to + flashes the original.
    await context.click();
    await expect(original).toBeInViewport();
    await expect(original).toHaveClass(/reply-flash/);
  });
});
