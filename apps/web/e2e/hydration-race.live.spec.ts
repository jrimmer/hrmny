/**
 * The hydration race (2026-09-15): the Ready dispatch wipes the transient
 * store in the same write that bumps sessionEpoch, and the hydration effect
 * used to skip its epoch-1 re-run unconditionally — so whenever hydration's
 * REST writes landed BEFORE Ready, the wipe ate them and nothing
 * re-populated: empty workspace rail, stranded Home, until a lucky reload.
 *
 * This spec pins the user-visible contract around the repair: a fresh login
 * over a pre-seeded workspace shows the workspace in the rail, keeps it past
 * the wipe window, and can enter it. HONEST LIMIT: under the harness the
 * race's losing ordering (hydration beating Ready) did not reproduce — the
 * browser's warm connections land Ready first — so this is a contract pin,
 * not a red/green reproduction; the interactive browser hit the losing
 * ordering on nearly every fresh login while the bug was live.
 */
import { test, expect } from '@playwright/test';
import { accessToken, freshLogin, registerVerifiedUser, seedWorkspaceWithChannel } from './helpers';

test('fresh login keeps its hydrated workspace rail after the READY wipe', async ({ page, request }) => {
  const username = await registerVerifiedUser(page, 'hydration');
  const token = await accessToken(page);
  await seedWorkspaceWithChannel(request, token, 'Hydration Race');

  // The racy ordering: a FRESH login, whose REST hydration usually beats the
  // gateway's Ready on the dev box.
  await freshLogin(page, username);

  // The rail must show the workspace (hydration wrote it)…
  const rail = page.getByRole('navigation', { name: 'Workspaces' });
  await expect(rail.getByRole('button', { name: 'Hydration Race' })).toBeVisible({ timeout: 15_000 });

  // …and KEEP showing it: pre-fix, the Ready wipe landed seconds later
  // (observed 2–8s after login) and the rail went permanently empty.
  await page.waitForTimeout(9_000);
  await expect(rail.getByRole('button', { name: 'Hydration Race' })).toBeVisible();

  // The entry must be real: it opens the workspace (freshLogin's `#/` route
  // keeps Home as the landing view, so entering is the rail button's job —
  // and pre-fix the button was gone by now).
  await rail.getByRole('button', { name: 'Hydration Race' }).click();
  await expect(page.getByRole('button', { name: 'e2e', exact: true })).toBeVisible({ timeout: 15_000 });
});
