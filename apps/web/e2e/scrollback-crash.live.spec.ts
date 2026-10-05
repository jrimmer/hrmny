/**
 * Scrollback crash regression (#135/#137) — REAL-browser verification.
 *
 * jsdom cannot reproduce react-virtuoso's emit graph (its own dev deps use
 * Playwright for the same reason), so the crash class this repo fixed —
 * "Maximum call stack size exceeded" while paging back through history,
 * exactly when older pages are PREPENDED and rows re-measure — is verified
 * here: an iPhone-class viewport (390×844, touch), a channel with several
 * pages of history, and 12 repeated elastic scrollbacks to the top, the
 * momentum/elastic shape that produced the recorded crashes (fractional
 * scrollTop, fast jumps, prepends mid-scroll).
 *
 * Pass criteria per run: no console/page error naming the stack overflow,
 * no app-shell fallback, the list keeps rendering through every iteration.
 * Screenshots land under docs/research/screenshots/2026-09-19-scrollback/
 * (gitignored by policy) — 1x context shots plus a 4x-DPR seam check.
 *
 * Prerequisite: dev stack up (web :5173 proxying API :4000).
 */
import { test, expect } from '@playwright/test';
import { accessToken, API, registerVerifiedUser, seedWorkspaceWithChannel } from './helpers';

const SCREENSHOTS = '../../docs/research/screenshots/2026-09-19-scrollback';

/**
 * Seed messages at the API's per-account pace (50 requests / 10s): batches
 * of 10 with a gap, and one 429-aware retry per batch.
 */
async function seedChannel(
  request: import('@playwright/test').APIRequestContext,
  token: string,
  chId: string,
  count: number,
): Promise<void> {
  for (let start = 0; start < count; start += 10) {
    const size = Math.min(10, count - start);
    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt++) {
      const batch = Array.from({ length: size }, (_, k) =>
        request.post(`${API}/channels/${chId}/messages`, {
          headers: { authorization: `Bearer ${token}` },
          data: { content: `history row ${start + k}` },
        }),
      );
      const done = await Promise.all(batch);
      const bad = done.find((r) => !r.ok());
      if (bad === undefined) {
        sent = true;
      } else if (bad.status() === 429) {
        await new Promise((r) => setTimeout(r, 8_000));
      } else {
        throw new Error(`seeding failed: ${bad.status()} ${await bad.text()}`);
      }
    }
    if (!sent) throw new Error('seeding kept hitting the rate limit');
    await new Promise((r) => setTimeout(r, 2_200));
  }
}

/** 350 messages = 7 pages of 50: prepends keep happening across iterations. */
const SEED_COUNT = 350;
const SCROLLBACK_ITERATIONS = 12;

test.use({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
  deviceScaleFactor: 1,
});

test('elastic scrollback through a multi-page channel does not blow the stack', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  const consoleErrors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e)));

  // Self-contained history: fresh verified user + own workspace + channel.
  const username = await registerVerifiedUser(page, 'scrollback');
  const token = await accessToken(page);
  const { wsId, chId } = await seedWorkspaceWithChannel(
    request,
    token,
    `scrollback-${Date.now().toString(36)}`,
  );
  // Self-contained long history; snowflakes order by creation, content order
  // does not matter — the list sorts by id.
  await seedChannel(request, token, chId, SEED_COUNT);

  // Pick the workspace up on the stable login-boot path (see mobile.live.spec's
  // note: the reload-restore path can churn the gateway session).
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });

  // Open the workspace, then the channel.
  const nav = page.getByRole('button', { name: 'Open navigation' });
  await nav.click();
  const drawer = page.getByRole('dialog', { name: 'Channels' });
  await drawer.getByRole('button', { name: /scrollback-/ }).click();
  // Selecting the workspace auto-opens its first channel at mobile (the
  // drawer closes and the pane mounts) — the same default-selection the
  // other mobile specs ride. Clicking the row here races the drawer's
  // re-render (the row detaches mid-click).
  await expect(page.locator('.mobile-topbar-title')).toHaveText('#e2e', { timeout: 15_000 });

  // The newest page rendered; the list is the virtualized scroller.
  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  await expect(scroller).toBeVisible();
  await expect(page.getByTestId('message-item').first()).toBeVisible({ timeout: 15_000 });

  await page.screenshot({ path: `${SCREENSHOTS}/after-open-1x.png`, fullPage: false });

  // Passive prepend counter: every REST history page the list pulls while
  // the walk runs (the list may also auto-chain pages while the open
  // settles — startReached at the top — so blocking on any ONE request is
  // the wrong signal; what matters is that prepends HAPPEN and that the
  // scroll interaction never blows the stack).
  let prependRequests = 0;
  page.on('response', (r) => {
    if (r.url().includes(`/channels/${chId}/messages`) && r.url().includes('before=')) {
      prependRequests += 1;
    }
  });

  /** The elastic/momentum shape: fractional scrollTops jittered around a
   *  position while prepends and their compensation settle — the recorded
   *  crash carried fractional scrollTop from iOS momentum scrolling. */
  const elasticJitter = async (steps: number) => {
    for (let f = 0; f < steps; f++) {
      await scroller.evaluate((el, frac) => {
        const range = el.scrollHeight - el.clientHeight;
        el.scrollTop = Math.max(0, Math.min(range, range * frac + 13.37));
      }, (f % 7) / 7);
      await page.waitForTimeout(35);
    }
  };

  let firstWalk = true;
  for (let i = 0; i < SCROLLBACK_ITERATIONS; i++) {
    // A crash at any earlier iteration must not silently end the walk: the
    // app-shell fallback would replace the pane.
    expect(page.getByTestId('app-error-fallback')).toHaveCount(0);

    // 1. The fast-scrollbar-drag shape: an instant jump to the very top —
    //    into the prepend window (startReached chains older pages while
    //    the reader sits here, exactly the recorded trigger).
    await scroller.evaluate((el) => {
      el.scrollTop = 0;
    });

    // 2. Jitter DURING the prepend chain, then give the compensation time
    //    to settle under the fractional offsets.
    await elasticJitter(14);
    await page.waitForTimeout(450);

    if (firstWalk) {
      firstWalk = false;
      await page.screenshot({
        path: `${SCREENSHOTS}/after-first-scrollback-1x.png`,
        fullPage: false,
      });
    }

    // 3. Back to the live edge for the next iteration (the reader
    //    returning to the bottom).
    await scroller.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(250);
  }

  // The walk must have exercised the prepend path, not just the top edge.
  console.log(`prepend history requests observed: ${prependRequests}`);
  expect(prependRequests, 'the walk never paged older history').toBeGreaterThan(0);

  // The stack never blew up.
  const stackOverflows = consoleErrors.filter((t) => /Maximum call stack/i.test(t));
  expect(stackOverflows, `stack overflow errors: ${stackOverflows.join(' | ')}`).toEqual([]);
  expect(consoleErrors.filter((t) => /Maximum call stack/i.test(t))).toEqual([]);
  expect(page.getByTestId('app-error-fallback')).toHaveCount(0);
  expect(page.getByTestId('list-crash-fallback')).toHaveCount(0);
  // The list is alive after the whole walk.
  await expect(page.getByTestId('message-item').first()).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOTS}/after-final-scrollback-1x.png`, fullPage: false });
});

test.describe('4x-DPR seam check', () => {
  test.use({ deviceScaleFactor: 4 });

  test('the prepended window edge renders cleanly', async ({ page, request }) => {
    // The visual-seam leg at 4x device scale (doctrine: 4x for any visual
    // seam) — a fresh context, same flow, one still at the prepended edge.
    test.setTimeout(180_000);

  const username = await registerVerifiedUser(page, 'scrollback4x');
  const token = await accessToken(page);
  const { chId } = await seedWorkspaceWithChannel(
    request,
    token,
    `scrollback4x-${Date.now().toString(36)}`,
  );
  await seedChannel(request, token, chId, 120);

  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Username or email' }).fill(username);
  await page.getByRole('textbox', { name: 'Password' }).fill('e2e-password-1!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 15_000 });
  const nav = page.getByRole('button', { name: 'Open navigation' });
  await nav.click();
  const drawer = page.getByRole('dialog', { name: 'Channels' });
  await drawer.getByRole('button', { name: /scrollback4x-/ }).click();
  await expect(page.locator('.mobile-topbar-title')).toHaveText('#e2e', { timeout: 15_000 });

  const scroller = page.locator('[data-virtuoso-scroller="true"]');
  await expect(page.getByTestId('message-item').first()).toBeVisible({ timeout: 15_000 });
  const resp = page.waitForResponse(
    (r) => r.url().includes(`/channels/${chId}/messages`) && r.url().includes('before='),
    { timeout: 20_000 },
  );
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await (await resp).finished();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${SCREENSHOTS}/prepended-edge-4x.png`, fullPage: false });
  expect(page.getByTestId('app-error-fallback')).toHaveCount(0);
});
});
