/**
 * Mobile e2e — runs ONLY on the `mobile` Playwright project (iPhone-class
 * 390×844 touch context; see playwright.config.ts). One spec file per plan
 * 003 surface, added as each unit lands; the desktop project never runs
 * this file, and the desktop specs never run at mobile width.
 *
 * U1 — mobile shell chrome: the topbar contract at real-render level. The
 * jsdom suite pins structure; this spec pins GEOMETRY (the audit's B1/B2
 * findings were geometry: 390×223 invisible trigger blocks, a fixed 72px
 * rail overlay) and the drawer's workspace-switching flow end-to-end.
 *
 * U2 — header-action parity: the topbar's title slot + join-voice control,
 * the real CallPanel sheet flow through the shared engine seam, and the
 * in-pane channel header's suppression (ONE title bar at mobile).
 *
 * U3 — touch message actions: long-press opens the bottom-sheet action
 * list; Add Reaction lands an API-backed chip; Start Thread (the thread is
 * named from the seed message — no name field) opens the thread as a
 * FULL-WIDTH sheet over an uncrushed pane; back-to-channel closes it.
 *
 * U4 — mobile composer: the composer row is full-bleed (≥360 of the 390px
 * viewport) with the ＋ attach and emoji controls INSIDE its bounds (the
 * audit's occlusion/tap-interception findings, geometrically re-proven now
 * that U1 removed the rail), typing lands as draft state, and the viewport
 * meta carries interactive-widget=resizes-content for the soft keyboard.
 *
 * U5 — mobile settings: the audit's B4 two-column squeeze is replaced by a
 * list→content stack. The drawer's gear (and the workspace menu's Workspace
 * Settings item) closes the drawer; the settings LIST is the pane's
 * full-width content (sections + Log out rows, ≥44px); a section shows with
 * a ← back to the list; deep links land on the section; ✕ closes from the
 * list. Logout runs on a DISPOSABLE second account (the shared first user
 * survives the spec).
 *
 * U6 — drawer + home polish: a fresh user lands on Home with NO 👥 members
 * trigger (the all-members drawer is meaningless over the dashboard) and the
 * dashboard stacks under the topbar (screenshot + geometry); inside a
 * workspace the 👥 trigger returns; the members drawer is EDGE-ALIGNED at
 * geometry level (full viewport height, anchored at an edge — the audit's M2
 * misread regression-locked), scrimmed, Escape-closable, with the header-row
 * ✕ at its top-right corner (m1).
 */
import { test, expect } from '@playwright/test';
import {
  accessToken,
  freshLogin,
  registerVerifiedUser,
  reloadIntoFirstWorkspace,
  seedMessage,
  seedWorkspaceWithChannel,
} from './helpers';

test.describe('mobile shell chrome (U1)', () => {
  test('bounded triggers in a topbar; no fixed rail; drawer carries workspace switching', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await registerVerifiedUser(page, 'm1');
    const token = await accessToken(page);
    const wsName = `mobile-u1-${Date.now().toString(36)}`;
    await seedWorkspaceWithChannel(request, token, wsName);
    // Into the workspace: a plain reload restores Home, which has no 👥.
    await reloadIntoFirstWorkspace(page);
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 15_000 });

    // B1 regression net: the ☰/👥 triggers are 44×44 controls inside the
    // topbar — never full-width invisible blocks (audit measured 390×223).
    const nav = page.getByRole('button', { name: 'Open navigation' });
    const members = page.getByTestId('rail-icon-members');
    const navBox = (await nav.boundingBox())!;
    const membersBox = (await members.boundingBox())!;
    expect(navBox.width).toBeLessThanOrEqual(64);
    expect(navBox.height).toBeLessThanOrEqual(64);
    expect(membersBox.width).toBeLessThanOrEqual(64);
    expect(membersBox.height).toBeLessThanOrEqual(64);
    const barBox = (await page.getByTestId('mobile-topbar').boundingBox())!;
    expect(barBox.height).toBeLessThanOrEqual(56);

    // B2 regression net: the workspace rail unmounts at mobile — no fixed
    // overlay eating the left 72px of every screen.
    await expect(page.locator('nav[aria-label="Workspaces"]')).toHaveCount(0);

    // KTD2: the drawer carries workspace switching. Open, see the strip
    // (Home + the seeded workspace), select, drawer closes.
    await nav.click();
    const drawer = page.getByRole('dialog', { name: 'Channels' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Home' })).toBeVisible();
    const wsButton = drawer.getByRole('button', { name: new RegExp(`^${wsName}`) });
    await expect(wsButton).toBeVisible();
    await wsButton.click();
    await expect(drawer).toBeHidden();

    // Message pane owns the remaining height: the composer (inside the
    // pane) sits inside the viewport, not clipped below it.
    const composer = page.getByRole('combobox', { name: 'Message' });
    await expect(composer).toBeVisible();
    const composerBox = (await composer.boundingBox())!;
    expect(composerBox.y + composerBox.height).toBeLessThanOrEqual(844);
  });
});

test.describe('mobile header actions (U2)', () => {
  test('topbar carries the channel title + join-voice; activating it opens the call sheet; the in-pane header is suppressed', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    const username = await registerVerifiedUser(page, 'm2');
    const token = await accessToken(page);
    const wsName = `mobile-u2-${Date.now().toString(36)}`;
    await seedWorkspaceWithChannel(request, token, wsName);
    // Pick the seeded workspace up with a FRESH LOGIN, not a post-login
    // reload: the reload-restore path currently leaves the gateway session
    // churning (a pre-existing session-domain condition this spec
    // deliberately avoids — the login-boot path is the stable one the
    // desktop specs ride), and the call leg needs a live gateway session.
    // freshLogin boots UNAUTHENTICATED (storage wiped), so no session
    // exists to churn; the login that follows hydrates the store with the
    // seeded workspace already in place.
    await freshLogin(page, username);
    const topbar = page.getByTestId('mobile-topbar');
    await expect(topbar).toBeVisible({ timeout: 15_000 });

    // Title slot (U2): the active channel's name — the same derivation the
    // desktop pane header uses. Settles once roster hydration names the
    // default-selected channel (before that the slot degrades to Home).
    await expect(topbar.locator('.mobile-topbar-title')).toHaveText('#e2e', {
      timeout: 15_000,
    });

    // Audit B3: voice is reachable at mobile — a join-voice control with
    // the desktop header button's exact accessible name, and it is the ONLY
    // one in the accessibility tree (the in-pane header's twin is
    // display:none at mobile, so no stacked band, no double control).
    // Wait for it to be STABLY visible: the current dev stack's gateway
    // intermittently churns sessions (a pre-existing server-side condition
    // around op bursts — presence/call ops — that resets the store in
    // bursts; canStartCall flickers with the membership wipe until the
    // session settles).
    const joinVoice = topbar.getByRole('button', { name: 'Start call', exact: true });
    await expect(joinVoice).toBeVisible({ timeout: 15_000 });
    // Stability: visible on 8 consecutive 250ms samples (a flickering
    // control resets the run — clicking mid-flicker is the dropped tap).
    let stableSamples = 0;
    for (let i = 0; i < 40 && stableSamples < 8; i++) {
      stableSamples = (await joinVoice.isVisible().catch(() => false))
        ? stableSamples + 1
        : 0;
      await page.waitForTimeout(250);
    }
    expect(stableSamples).toBe(8);
    await expect(
      page.getByRole('button', { name: 'Start call', exact: true }),
    ).toHaveCount(1);
    await expect(page.getByTestId('channel-header')).toBeHidden();

    // Activating join-voice routes through the same engine seam the desktop
    // header uses, which opens the EXISTING CallPanel mobile sheet. When the
    // stack is healthy the leg connects for real (mic granted over the fake
    // media device — mute/deafen/leave render); the current dev stack's
    // gateway can intermittently churn (a pre-existing condition: sessions
    // drop after op bursts, and the per-IP admission limiter then livelocks
    // reconnects — localhost e2e traffic all shares one IP), which can park
    // the leg in the announced connecting state instead. Drive retries for
    // the connected controls; accept the held states-first surface on
    // exhaustion — the control-to-surface routing is this unit's contract,
    // the leg's server confirmation is not.
    const sheet = page.getByTestId('call-sheet');
    const controls = sheet.getByTestId('call-controls');
    // By TESTID, not by a loose /call/i name: the rail icons added a "Show Call
    // log" control to this same topbar, so the name regex matched two buttons,
    // every click threw a strict-mode violation, and the `.catch()` below
    // swallowed it — the loop exhausted without ever starting a call, which read
    // as "the sheet never mounts". Matches either state of the one control.
    const callButton = topbar
      .locator('[data-testid="topbar-start-call"], [data-testid="topbar-join-call"]')
      .first();
    let connected = false;
    for (let attempt = 0; attempt < 5 && !connected; attempt++) {
      connected = await controls
        .waitFor({ state: 'visible', timeout: attempt === 0 ? 5_000 : 2_500 })
        .then(
          () => true,
          () => false,
        );
      if (!connected) {
        await callButton.click({ timeout: 2_000 }).catch(() => undefined);
      }
    }
    await expect(sheet).toBeVisible();
    await expect(sheet.getByTestId('call-panel')).toBeVisible();
    await expect(sheet.getByTestId('call-header')).toBeVisible();
    if (connected) {
      // Scoped to the PANEL's copies by testid, not by accessible name: the
      // roster's self row deliberately carries the same three controls (it
      // doubles as the control surface), so "Mute microphone" resolves to two
      // buttons and a name query is a strict-mode violation. CallPanel.test.tsx
      // pins the roster copy; this leg is about the sheet's own controls.
      await expect(sheet.getByTestId('call-mute-panel')).toBeVisible();
      await expect(sheet.getByTestId('call-deafen-panel')).toBeVisible();
      await expect(sheet.getByTestId('call-leave-panel')).toBeVisible();
      // Leave closes the sheet — the escape hatch stays reachable at mobile.
      await sheet.getByTestId('call-leave-panel').click();
    } else {
      // The held connecting surface is still the real sheet: an announced
      // status plus the dismiss affordance. Review #4: strict mode —
      // CYTALE_REQUIRE_CONNECTED=1 (healthy stack / CI) refuses the
      // fallback so a dead voice leg cannot pass green.
      if (process.env.CYTALE_REQUIRE_CONNECTED === '1') {
        throw new Error(
          'call never connected (CYTALE_REQUIRE_CONNECTED=1): the voice leg is dead or the dev gateway is churning',
        );
      }
      await expect(sheet.getByRole('status').first()).toBeVisible();
      await sheet.getByRole('button', { name: 'Close call panel' }).click();
    }
    await expect(sheet).toBeHidden({ timeout: 20_000 });
  });
});

test.describe('touch message actions (U3)', () => {
  test('long-press opens the action sheet; react lands; thread opens full-width; back closes', async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const username = await registerVerifiedUser(page, 'm3');
    const token = await accessToken(page);
    const wsName = `mobile-u3-${Date.now().toString(36)}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);

    // Seed the message under test via REST (repo convention: API-seeded rows).
    await seedMessage(request, token, chId, 'long press me');


    // Fresh-login boot (the stable path — reload-restore churns).
    await freshLogin(page, username);
    await expect(page.getByTestId('mobile-topbar')).toBeVisible({ timeout: 15_000 });

    // The seeded channel is the default selection; wait for the row.
    const row = page.locator('[data-testid="message-item"]', { hasText: 'long press me' });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // LONG-PRESS: hold the pointer down 600ms (> the 450ms threshold).
    await row.click({ delay: 600 });
    const sheet = page.getByTestId('message-actions-sheet');
    await expect(sheet).toBeVisible();
    // The full action list for an OWN message (react/reply/edit/thread/copy/delete).
    for (const id of [
      'sheet-action-react',
      'sheet-action-reply',
      'sheet-action-edit',
      'sheet-action-thread',
      'sheet-action-copy',
      'sheet-action-delete',
    ]) {
      await expect(sheet.getByTestId(id), id).toBeVisible();
    }

    // Add Reaction from the sheet (embedded favorites grid) — the chip is
    // the API-backed assertion (REST add → gateway echo → store → render).
    await sheet.getByTestId('sheet-action-react').click();
    const picker = sheet.getByTestId('sheet-reaction-picker');
    await expect(picker).toBeVisible();
    await picker.locator('[data-testid="reaction-favorite"][data-emoji="👍"]').click();
    await expect(sheet).toBeHidden();
    await expect(
      row.locator('[data-testid="reaction-chip"][data-emoji="👍"]'),
    ).toBeVisible({ timeout: 15_000 });

    // Start Thread from the sheet. There is no name field to fill: the thread
    // is named from the seed message (no prompt anywhere — iOS suppresses
    // window.prompt in standalone mode), and the panel opens as a DRAFT whose
    // first reply creates the thread.
    await row.click({ delay: 600 });
    await expect(sheet).toBeVisible();
    await sheet.getByTestId('sheet-action-thread').click();

    // The thread surface opens as the FULL-WIDTH mobile sheet OVER the
    // conversation — and the message pane is NOT crushed by a dock.
    const threadSheet = page.getByTestId('thread-sheet');
    await expect(threadSheet).toBeVisible({ timeout: 15_000 });
    // The sheet slides in: read its box once the entrance has settled.
    await expect
      .poll(async () => (await threadSheet.boundingBox())?.x, { timeout: 5_000 })
      .toBe(0);
    const tsBox = (await threadSheet.boundingBox())!;
    expect(tsBox.x).toBe(0);
    expect(tsBox.width).toBe(390);
    const paneBox = (
      await page.locator('.pane-split > [data-testid="message-pane"]').boundingBox()
    )!;
    expect(paneBox.width).toBeGreaterThan(380);

    // Back to channel: the ✕ header closes the sheet.
    await threadSheet.getByTestId('thread-close').click();
    await expect(threadSheet).toBeHidden();
    await expect(row).toBeVisible();
  });
});

test.describe('mobile composer (U4)', () => {
  test('full-bleed composer row with tappable ＋/emoji inside it; typing lands as draft state', async ({
    page,
    request,
  }) => {
    test.setTimeout(90_000);
    await registerVerifiedUser(page, 'm4');
    const token = await accessToken(page);
    const wsName = `mobile-u4-${Date.now().toString(36)}`;
    const { chId } = await seedWorkspaceWithChannel(request, token, wsName);
    await reloadIntoFirstWorkspace(page); // a plain reload restores Home
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 15_000 });

    // U4 viewport contract: the soft keyboard resizes the layout viewport
    // (the meta rides every page; asserted on the live DOM).
    const viewportMeta = await page.evaluate(() =>
      document.querySelector('meta[name="viewport"]')?.getAttribute('content'),
    );
    expect(viewportMeta).toContain('interactive-widget=resizes-content');

    // Audit geometry re-proven post-U1: the composer row spans the viewport
    // (≥360 of 390 — full-bleed within the safe-area gutter tolerance) and
    // the ＋ attach / emoji controls render INSIDE the row's box — nothing
    // (rail remnant, desktop gutter) occludes or squeezes them.
    const row = page.getByTestId('composer-row');
    await expect(row).toBeVisible({ timeout: 15_000 });
    const rowBox = (await row.boundingBox())!;
    expect(rowBox.width).toBeGreaterThanOrEqual(360);
    expect(rowBox.x).toBeGreaterThanOrEqual(0);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(390);
    // Bottom-anchored above the viewport edge (100dvh column intact).
    expect(rowBox.y + rowBox.height).toBeLessThanOrEqual(844);

    const inside = (
      inner: { x: number; y: number; width: number; height: number },
      outer: { x: number; y: number; width: number; height: number },
    ) =>
      inner.x >= outer.x &&
      inner.y >= outer.y &&
      inner.x + inner.width <= outer.x + outer.width + 1 &&
      inner.y + inner.height <= outer.y + outer.height + 1;
    const plusBox = (await page.getByTestId('composer-plus').boundingBox())!;
    const emojiBox = (await page.getByTestId('composer-emoji').boundingBox())!;
    expect(inside(plusBox, rowBox), '＋ inside composer row').toBe(true);
    expect(inside(emojiBox, rowBox), 'emoji inside composer row').toBe(true);

    // The composer accepts input and the text lands as draft state (the
    // localStorage draft the composer persists on every edit, keyed per
    // member and channel: `cytale.draft.<userId>.<channelId>`).
    const composer = page.getByRole('combobox', { name: 'Message' });
    await composer.click();
    await page.keyboard.type('mobile draft hello');
    await expect(composer).toContainText('mobile draft hello');
    await expect
      .poll(() =>
        page.evaluate((id) => {
          const key = Object.keys(localStorage).find(
            (k) => k.startsWith('cytale.draft.') && k.endsWith(`.${id}`),
          );
          return key === undefined ? null : localStorage.getItem(key);
        }, chId),
      )
      .toBe('mobile draft hello');
  });
});

test.describe('mobile settings (U5)', () => {
  test('list→content stack from the drawer gear; deep link lands on the section; wsettings mirrors it', async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    await registerVerifiedUser(page, 'm5');
    const token = await accessToken(page);
    await seedWorkspaceWithChannel(request, token, `mobile-u5-${Date.now().toString(36)}`);
    // Into the workspace (its menu is exercised below): a plain reload
    // restores Home.
    await reloadIntoFirstWorkspace(page);
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 15_000 });

    // The gear rides the drawer's user panel (U1/U2); activating it opens
    // user settings AND closes the drawer — the list lives full-width in
    // the pane, which the open drawer would cover.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Channels' });
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('user-settings-toggle').click();
    await expect(drawer).toBeHidden();

    // The LIST is the pane: full-width, all sections + Log out rows.
    const list = page.getByTestId('settings-nav');
    await expect(list).toBeVisible();
    const listBox = (await list.boundingBox())!;
    expect(listBox.x).toBe(0);
    expect(listBox.width).toBeGreaterThan(370); // of the 390px viewport
    for (const row of [
      'settings-nav-account',
      'settings-nav-appearance',
      'settings-nav-emoji',
      'settings-nav-integrations',
      'settings-nav-logout',
    ]) {
      await expect(list.getByTestId(row), row).toBeVisible();
    }
    // ≥44px rows, geometrically this time.
    const rowBox = (await list.getByTestId('settings-nav-appearance').boundingBox())!;
    expect(rowBox.height).toBeGreaterThanOrEqual(44);

    // Tap a section → its content with a ← back control; hash reflects it.
    await list.getByTestId('settings-nav-appearance').click();
    await expect(page.getByTestId('settings-pane')).toBeVisible();
    await expect(page.getByTestId('settings-pane-title')).toHaveText('Appearance');
    await expect(page.getByTestId('settings-appearance')).toBeVisible();
    await expect(page).toHaveURL(/#\/settings\/appearance/);
    const back = page.getByTestId('settings-back');
    await expect(back).toBeVisible();
    await back.click();
    await expect(page.getByTestId('settings-nav')).toBeVisible();
    await expect(page.getByTestId('settings-pane')).toHaveCount(0);

    // Deep link: #/settings/account reload lands on Account WITH a back
    // target (the hash is the source of truth; the list is a UI layer).
    await page.goto('/#/settings/account');
    await page.reload();
    await expect(page.getByTestId('settings-pane')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('settings-pane-title')).toHaveText('My Account');
    await expect(page.getByTestId('settings-account')).toBeVisible();
    await expect(page.getByTestId('settings-back')).toBeVisible();
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('settings-nav')).toBeVisible();

    // The list header's ✕ closes settings entirely.
    await page.getByTestId('settings-nav-close').click();
    await expect(page.getByTestId('settings-nav')).toHaveCount(0);
    await expect(page.getByTestId('mobile-topbar')).toBeVisible();

    // Workspace settings mirrors the stack: the drawer server-header's
    // ⌄ menu → Workspace Settings (also closes the drawer), Overview row
    // → content + ← → back to the list → ✕ closes.
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer2 = page.getByRole('dialog', { name: 'Channels' });
    await expect(drawer2).toBeVisible();
    await drawer2.getByTestId('workspace-menu-trigger').click();
    // The ⌄ menu is portaled out of the drawer (Radix): its items are page-level.
    await page.getByTestId('workspace-menu-settings').click();
    await expect(drawer2).toBeHidden();
    const wlist = page.getByTestId('wsettings-nav');
    await expect(wlist).toBeVisible();
    await wlist.getByTestId('wsettings-nav-overview').click();
    await expect(page.getByTestId('settings-pane')).toBeVisible();
    await expect(page.getByTestId('settings-pane-title')).toHaveText('Workspace settings');
    await expect(page.getByTestId('wsettings-overview')).toBeVisible();
    await expect(page).toHaveURL(/#\/wsettings\/overview/);
    await page.getByTestId('settings-back').click();
    await expect(page.getByTestId('wsettings-nav')).toBeVisible();
    await page.getByTestId('wsettings-nav-close').click();
    await expect(page.getByTestId('wsettings-nav')).toHaveCount(0);
  });

  test('logout from the mobile list ends the session (disposable account)', async ({ page }) => {
    test.setTimeout(90_000);
    // Disposable second account: logout revokes THIS session; the shared
    // first user of the describe above is untouched.
    await registerVerifiedUser(page, 'm5logout');
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const drawer = page.getByRole('dialog', { name: 'Channels' });
    await expect(drawer).toBeVisible();
    await drawer.getByTestId('user-settings-toggle').click();
    await expect(drawer).toBeHidden();
    const list = page.getByTestId('settings-nav');
    await expect(list).toBeVisible();
    await expect(list.getByTestId('settings-nav-logout')).toBeVisible();
    await list.getByTestId('settings-nav-logout').click();
    await expect(page.getByTestId('login-page')).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('mobile drawer + home (U6)', () => {
  test('Home has no 👥 trigger and stacks under the topbar; the workspace members drawer is edge-aligned, scrimmed, Escape-closable', async ({
    page,
    request,
  }) => {
    test.setTimeout(120_000);
    // Fresh user, zero workspaces → Home hero.
    const username = await registerVerifiedUser(page, 'm6');

    // Home carries NO fourth column at all (owner direction 2026-09-14:
    // "In home, col 4 doesn't make sense as I'm not in a room … the entire
    // column shouldn't be there"). This SUPERSEDES the #105 compromise the
    // previous comment described ("the icons ARE present on Home at mobile —
    // Home is an ordinary case"): the icons are how the column is opened, so
    // removing the column removes them, and `railHidden` covers every band.
    // That the 👥 trigger RETURNS in a workspace is asserted below — it is
    // what keeps this a Home rule rather than a global suppression.
    await expect(page.getByTestId('rail-icon-members')).toHaveCount(0);
    await expect(page.locator('[data-testid^="context-rail-body-"]')).toHaveCount(0);

    // The dashboard stacks UNDER the topbar (the mobile column order —
    // geometry, not just presence).
    const topbar = page.getByTestId('mobile-topbar');
    await expect(topbar).toBeVisible();
    const hero = page.getByTestId('home-hero-title');
    await expect(hero).toBeVisible({ timeout: 15_000 });
    // The product is Hrmny (renamed from Cytale); this assertion predated the
    // rename and had been reading the OLD name — stale, not a regression.
    await expect(hero).toHaveText(new RegExp(`Welcome to Hrmny, ${username}`));
    const topbarBox = (await topbar.boundingBox())!;
    const heroBox = (await hero.boundingBox())!;
    expect(topbarBox.height).toBeLessThanOrEqual(56);
    expect(heroBox.y).toBeGreaterThanOrEqual(topbarBox.y + topbarBox.height);
    // Visual record for the audit trail (test-results/ is untracked).
    await page.screenshot({ path: 'test-results/u6-home-mobile.png' });

    // Seed the workspace, then ride the drawer's workspace strip into it
    // (U1's select-closes idiom): the 👥 trigger must RETURN off Home —
    // the suppression is Home-scoped, not global.
    const token = await accessToken(page);
    const wsName = `mobile-u6-${Date.now().toString(36)}`;
    await seedWorkspaceWithChannel(request, token, wsName);
    await page.reload();
    await page.waitForSelector('[data-testid="mobile-topbar"]', { timeout: 15_000 });
    await page.getByRole('button', { name: 'Open navigation' }).click();
    const navDrawer = page.getByRole('dialog', { name: 'Channels' });
    await expect(navDrawer).toBeVisible();
    // m1: the drawer header row — ✕ at the TOP-RIGHT (title left). Geometry
    // (measured after the slide-in settles so the boxes are final).
    await page.waitForTimeout(300);
    const navClose = navDrawer.getByRole('button', { name: 'Close navigation' });
    const navDrawerBox = (await navDrawer.boundingBox())!;
    const navCloseBox = (await navClose.boundingBox())!;
    expect(navCloseBox.y).toBeLessThanOrEqual(12);
    expect(navCloseBox.x + navCloseBox.width).toBeGreaterThanOrEqual(
      navDrawerBox.x + navDrawerBox.width - 12,
    );
    await page.screenshot({ path: 'test-results/u6-nav-drawer-mobile.png' });
    await navDrawer.getByRole('button', { name: new RegExp(`^${wsName}`) }).click();
    await expect(navDrawer).toBeHidden();
    const members = page.getByTestId('rail-icon-members');
    await expect(members).toBeVisible({ timeout: 15_000 });

    // M2 regression lock at GEOMETRY: the members drawer is the edge-aligned
    // surface — full viewport height (0 → 844), anchored AT an edge (right),
    // never a floating centered card — with the scrim behind it.
    await members.click();
    const drawer = page.locator('.drawer.members');
    await expect(drawer).toBeVisible();
    await expect(page.locator('.drawer-overlay')).toBeVisible();
    // Let the slide-in animation settle before measuring.
    await page.waitForTimeout(350);
    const box = (await drawer.boundingBox())!;
    expect(box.y, 'drawer top flush with the viewport top').toBeLessThanOrEqual(1);
    expect(box.height, 'drawer spans the full 844px viewport height').toBeGreaterThanOrEqual(
      840,
    );
    expect(box.x + box.width, 'drawer anchored at the right edge').toBeGreaterThanOrEqual(389);
    expect(box.x, 'drawer NOT left-anchored/centered (width ≈ min(85vw, 320))').toBeGreaterThan(
      40,
    );
    const scrimBox = (await page.locator('.drawer-overlay').boundingBox())!;
    expect(scrimBox.width).toBe(390);
    expect(scrimBox.height).toBe(844);
    // Header-row ✕ at the drawer's top-right (m1).
    const close = drawer.getByRole('button', { name: 'Close side panel' });
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.y).toBeLessThanOrEqual(12);
    expect(closeBox.x + closeBox.width).toBeGreaterThanOrEqual(box.x + box.width - 12);
    await page.screenshot({ path: 'test-results/u6-members-drawer-mobile.png' });

    // Escape closes the drawer (Radix dialog semantics intact).
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
  });
});


/**
 * Home carries NO member list — owner direction 2026-09-12, RESTATED and
 * widened 2026-09-14 ("the entire column shouldn't be there"). The 09-12 note
 * superseded the U6 note that deliberately kept Home's desktop rail and the U7
 * review fix that bounded the mobile inline band; the 09-14 direction then
 * superseded #105's compromise, which had removed the member LIST from Home
 * but kept the mode icons so the Call log and Threads tabs stayed reachable.
 * `railHidden` includes `homeActive`, so on Home there is no aside in any band
 * AND no trigger to open one.
 *
 * This replaces the old "the all-members aside is height-bounded" test, which
 * asserted a surface that no longer exists: the bound it pinned (max-height
 * 40dvh) is now unreachable, and a passing test for a dead branch is worse
 * than none. The behaviour worth pinning is the ABSENCE.
 */
test.describe('home carries no member list (owner direction 2026-09-12)', () => {
  test('mobile Home renders no members aside and the dashboard keeps the width', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await registerVerifiedUser(page, 'mf1');
    await page.waitForSelector('[data-testid="home-hero-title"]', { timeout: 15_000 });

    await expect(page.locator('.shell > .members-rail')).toHaveCount(0);
    // The trigger is gone too, not just the column: `railHidden` covers every
    // band, so Home has no 👥 and no inline band (owner direction 2026-09-14 —
    // this is the assertion that changed from #105's count 1).
    await expect(page.getByTestId('rail-icon-members')).toHaveCount(0);
    await expect(page.locator('[data-testid^="context-rail-body-"]')).toHaveCount(0);

    // The dashboard owns the full pane below the topbar (no band stealing
    // height from it).
    const hero = (await page.getByTestId('home-hero-title').boundingBox())!;
    expect(hero.height).toBeGreaterThan(0);
    const main = (await page.getByTestId('message-pane').boundingBox())!;
    expect(main.width).toBe(390);
  });
});
