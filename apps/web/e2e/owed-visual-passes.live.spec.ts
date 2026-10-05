/**
 * Visual passes owed by invariant #1: nobody has LOOKED at the surfaces #114,
 * #117 and #118 added. Tests assert their layout; this captures the pixels, at
 * 1x and 4x, so a human can accept or reject them.
 *
 * What it captures per scale:
 *   1. Home's "where you were needed" list, with a real mention in it (#117).
 *   2. A message whose body contains a LEGACY permalink — the in-app chip (#118).
 *      (The `/m/<token>` chip form is captured by the same spec once the token
 *      form is recognized; until then this is the form that renders a chip.)
 *   3. The Copy Link action's confirmation (#114).
 *
 * The mention has to be authored by ANOTHER member — mentions of yourself are
 * not a backlog — so the rig runs two humans via an invite, the same shape
 * `threads-two-actors.live.spec.ts` uses.
 */
import { test, expect, type Browser, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  accessToken,
  API,
  apiRegister,
  CAPTURE_4X,
  CAPTURE_4X_SKIPPED,
  makeE2EUser,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedMessage,
  seedWorkspaceWithChannel,
  uiLogin,
  verifyViaMailbox,
} from './helpers';

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'docs',
  'research',
  'screenshots',
  '2026-09-14-owed-visual-passes',
);

async function capture(browser: Browser, request: APIRequestContext, scale: number) {
  const label = `${scale}x`;
  const ctxA = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: scale,
    // Copy Link writes the clipboard; headless contexts deny it without this.
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  const pageA = await ctxA.newPage();

  await registerVerifiedUser(pageA, `cap${scale}`);
  const tokenA = await accessToken(pageA);
  const a = { authorization: `Bearer ${tokenA}` };
  const { wsId, chId } = await seedWorkspaceWithChannel(
    request,
    tokenA,
    `cap-${label}-${Date.now().toString(36)}`,
  );

  const me = await request.get(`${API}/users/@me`, { headers: a });
  const myId = ((await me.json()).user ?? (await me.json())).id as string;

  // A second human, joined BEFORE its browser session boots (READY hydrates the
  // workspaces a member is already in).
  const userB = makeE2EUser();
  await apiRegister(userB);
  await verifyViaMailbox(userB);
  const loginB = await request.post(`${API}/auth/login`, {
    data: { identifier: userB.username, password: userB.password },
  });
  const tokenB0 = (await loginB.json()).access_token as string;
  const inv = await request.post(`${API}/workspaces/${wsId}/invites`, { headers: a, data: {} });
  const invBody = await inv.json();
  const code = (invBody.invite?.code ?? invBody.code ?? invBody.invite?.id) as string;
  expect(
    (await request.post(`${API}/invites/${code}`, {
      headers: { authorization: `Bearer ${tokenB0}` },
      data: {},
    })).ok(),
  ).toBe(true);
  const b = { authorization: `Bearer ${tokenB0}` };

  // 1. The mention that puts a row in A's inbox.
  const mention = await request.post(`${API}/channels/${chId}/messages`, {
    headers: b,
    data: { content: `hey <@${myId}> — the deploy is green, can you sanity-check?` },
  });
  expect(mention.status(), 'B can mention A').toBe(201);

  // 2. A message whose body carries a legacy permalink (the chip).
  const seedRes = await request.post(`${API}/channels/${chId}/messages`, {
    headers: a,
    data: { content: 'message to link to' },
  });
  expect(seedRes.status()).toBe(201);
  const seedId = (await seedRes.json()).message.id as string;
  // The chip only recognizes SAME-INSTANCE permalinks — build it from the
  // page's own origin, not the production domain.
  const pageOrigin = new URL(pageA.url()).origin;
  const linkUrl = `${pageOrigin}/#/workspace/${wsId}/channel/${chId}/message/${seedId}`;
  const withLink = await request.post(`${API}/channels/${chId}/messages`, {
    headers: a,
    data: { content: `see ${linkUrl} for the details` },
  });
  expect(withLink.status()).toBe(201);

  // Boot into the seeded channel (a plain reload restores Home).
  await reloadIntoFirstWorkspace(pageA);
  await pageA.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 }).catch(async () => {
    // The browser session predates the workspace's creation and live
    // dispatches don't reach this rig (#111), so the reload boots to HOME with
    // an empty workspace rail. Navigate in through the switcher + sidebar.
      const diag = await pageA.evaluate(() => {
      const st = (globalThis as { __cytaleStore?: { getState: () => Record<string, unknown> } })
        .__cytaleStore!.getState();
      return {
        workspaceKeys: Object.keys((st.workspaces ?? {}) as Record<string, unknown>),
        workspaceDetail: st.workspaces,
        railHtml: document.querySelector('nav[aria-label="Workspaces"]')?.innerHTML?.slice(0, 300) ?? null,
        url: location.href,
      };
    });
    console.log(`[${label}] DIAG:`, JSON.stringify(diag).slice(0, 600));
    // A second fresh boot re-runs the workspace hydrate — the first boot raced
  // it (full-gate/#111 class), and one retry has made the race vanish in
  // practice.
  await pageA.reload();
  await pageA.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
  await pageA.getByTestId(`workspace-${wsId}`).click();
    await pageA.waitForSelector('[data-testid="message-item"]', { timeout: 20_000 });
  });

  // (2) the chip, in the channel
  const chip = pageA.getByTestId('permalink-chip').first();
  await chip.waitFor({ state: 'visible', timeout: 20_000 });
  await pageA.waitForTimeout(1500); // the chip resolves lazily
  await pageA.screenshot({ path: join(OUT, `channel-permalink-chip-${label}.png`) });

  // (3) Copy Link's confirmation, from the message hover toolbar
  const linkedRow = pageA.locator(`[data-message-id="${(await withLink.json()).message.id}"]`).first();
  await linkedRow.hover();
  // Force: the toolbar is hover-revealed via CSS, and Playwright's visibility
  // check runs BEFORE the pointer move that would reveal it — chicken-and-egg
  // under any scroll. The handler is what the capture needs, so fire it via a
  // DOM click on the revealed toolbar's copy control.
  await pageA.evaluate(() => {
    (document.querySelector('[data-testid="action-copy-link"]') as HTMLElement | null)?.click();
  });
  await pageA.waitForTimeout(800); // the confirmation pill beat
  await pageA.screenshot({ path: join(OUT, `copy-link-confirmation-${label}.png`) });

  // (1) Home's inbox
  await pageA.getByRole('button', { name: 'Home' }).click();
  await expect(pageA.getByTestId('home-dashboard')).toBeVisible({ timeout: 20_000 });
  await pageA.waitForTimeout(1500); // the boot hydrate
  await pageA.screenshot({ path: join(OUT, `home-inbox-${label}.png`) });

  await ctxA.close();
}

test.describe('owed visual passes (#114 / #117 / #118)', () => {
  test('1x captures', async ({ browser, request }) => {
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    await capture(browser, request, 1);
  });

  test('4x captures', async ({ browser, request }) => {
    test.skip(!CAPTURE_4X, CAPTURE_4X_SKIPPED);
    test.setTimeout(300_000);
    mkdirSync(OUT, { recursive: true });
    await capture(browser, request, 4);
  });
});
