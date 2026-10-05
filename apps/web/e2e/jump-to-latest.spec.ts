/**
 * Jump to latest (owner, 2026-10-01) in a real browser:
 *
 *   "When the cursor's at a history message (in which the latest message
 *    isn't in view) ... draw a down arrow in a circle above the main compose
 *    at the right that takes the user to the new message (at the bottom)."
 *
 * Pinned here, against fixtures (jump-latest-world.ts — no server):
 *
 *   - hidden at the live edge; up once the reader scrolls away, floating over
 *     the timeline's bottom-right corner, clear of the composer;
 *   - a click lands on the newest message, the button goes, and the list
 *     FOLLOWS again (a live arrival after the jump stays in view);
 *   - a window that does not hold the newest page — a permalink outside it, or
 *     scrollback past the 500-row window — shows the button at once, and the
 *     click reads the present in before landing on the TRUE newest message;
 *   - keyboard: reachable, the house focus ring, Enter jumps, focus moves on
 *     to the composer;
 *   - the thread panel has its own, above the thread composer;
 *   - phone width: clear of the composer and of the typing line, out of
 *     the way of an open suggestion palette, on screen with the keyboard up;
 *   - Pixel style: square, the hard-offset shadow;
 *   - axe (WCAG 2.1 A/AA) on the button.
 */
import { expect, test, type Page } from '@playwright/test';

import {
  BASE,
  CH,
  ROW,
  arrive,
  expectNewestInView,
  jumpButton,
  mockApi,
  openChannel,
  openThread,
  rowInView,
  scroller,
  wheelUp,
  world,
  WS,
  type Scope,
} from './jump-latest-world';

const OUT = 'test-results/jump-latest';

interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The button, the scope's scroller and composer well, as the user sees them. */
function layout(page: Page, scope: Scope) {
  return page.evaluate((scope) => {
    const inThread = (el: Element) => el.closest('[data-testid="thread-side-panel"]') !== null;
    const pick = (sel: string) =>
      [...document.querySelectorAll(sel)].find((el) => (scope === 'thread') === inThread(el)) ?? null;
    const rect = (el: Element | null): Rect | null => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
    };
    const button = pick('[data-testid="jump-to-latest"]');
    const b = rect(button)!;
    const hit = button
      ? document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2)
      : null;
    return {
      button: b,
      scroller: rect(pick('[data-testid="message-list"] [data-virtuoso-scroller="true"]'))!,
      well: rect(pick('[data-testid="composer-well"]'))!,
      typing: rect(pick('.typing-line .typing-indicator')),
      onTop: hit !== null && button !== null && button.contains(hit),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }, scope);
}

const overlaps = (a: Rect, b: Rect) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** The button sits over the timeline's bottom-right corner and clear of the composer. */
async function expectPlaced(page: Page, scope: Scope): Promise<void> {
  const g = await layout(page, scope);
  expect(g.button.bottom, `${scope}: above the composer well`).toBeLessThanOrEqual(g.well.top);
  expect(overlaps(g.button, g.well), `${scope}: never over the composer`).toBe(false);
  expect(g.button.right, `${scope}: inside the timeline's right edge`).toBeLessThanOrEqual(g.scroller.right);
  expect(g.scroller.right - g.button.right, `${scope}: at the right`).toBeLessThanOrEqual(24);
  expect(g.scroller.bottom - g.button.bottom, `${scope}: at the bottom`).toBeLessThanOrEqual(48);
  expect(g.button.bottom, `${scope}: on screen`).toBeLessThanOrEqual(g.viewport.height);
  expect(g.onTop, `${scope}: on top of the rows, not covered`).toBe(true);
}

async function axeOnButton(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  return page.evaluate(async () => {
    const axe = (window as unknown as {
      axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> };
    }).axe;
    const result = await axe.run(
      { include: [['[data-testid="jump-to-latest"]']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
    );
    return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
  });
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
});

test('scrolled up: the button floats above the composer at the right; a click lands on the newest and follows', async ({
  page,
}) => {
  const w = world(120);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(600);
  const button = jumpButton(page);
  // At the live edge: no button (in the DOM to animate, but hidden and inert).
  await expect(button).toBeHidden();
  await expect(button).toHaveAttribute('data-state', 'hidden');
  await expect(page.getByRole('button', { name: 'Jump to latest messages' })).toHaveCount(0);

  await wheelUp(page, 'channel', 4);
  await expect(button).toBeVisible();
  await expectPlaced(page, 'channel');
  await expect(button).toHaveAccessibleName('Jump to latest messages');
  expect(await axeOnButton(page)).toEqual([]);
  await page.screenshot({ path: `${OUT}/desktop-scrolled-up.png` });

  await button.click();
  await expectNewestInView(page, 'channel', BASE + 119);
  await expect(button).toBeHidden();
  // Follow is back on: a live arrival lands in view, the button stays down.
  await arrive(page, 120);
  await expectNewestInView(page, 'channel', BASE + 120);
  await page.waitForTimeout(400);
  expect(await rowInView(page, 'channel', BASE + 120)).toBe(true);
  await expect(button).toBeHidden();
});

test('a small nudge up keeps the newest row in view: no button until it leaves', async ({ page }) => {
  const w = world(120);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(600);
  await wheelUp(page, 'channel', 1);
  // One notch (500px) takes the newest row off screen: the button is up.
  await expect(jumpButton(page)).toBeVisible();
  // Back down by hand: the at-bottom rule re-arms and the button goes.
  await scroller(page).hover();
  await page.mouse.wheel(0, 2000);
  await expect(jumpButton(page)).toBeHidden();
  expect(await rowInView(page, 'channel', BASE + 119)).toBe(true);
});

test('keyboard: Shift+Tab reaches it, the focus ring shows, Enter jumps and focus moves to the composer', async ({
  page,
}) => {
  const w = world(120);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(600);
  await wheelUp(page, 'channel', 4);
  const button = jumpButton(page);
  await expect(button).toBeVisible();

  const composer = page.getByTestId('message-pane').getByTestId('composer-input');
  await composer.click();
  // Paced like a person: Lexical commits the click's selection a few ms
  // later and takes focus back with it (measured: a Shift+Tab inside that
  // window was undone before the next key).
  await page.waitForTimeout(300);
  let reached = false;
  for (let i = 0; i < 12 && !reached; i++) {
    await page.keyboard.press('Shift+Tab');
    await page.waitForTimeout(80);
    reached = await button.evaluate((el) => el === document.activeElement);
  }
  expect(reached, 'the button is in the tab order').toBe(true);
  const ring = await button.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      style: cs.outlineStyle,
      width: cs.outlineWidth,
      color: cs.outlineColor,
      focused: el === document.activeElement,
      focusVisible: el.matches(':focus-visible'),
      state: el.getAttribute('data-state'),
      active: `${document.activeElement?.tagName}.${document.activeElement?.getAttribute('data-testid')}`,
    };
  });
  expect(ring.style, JSON.stringify(ring)).toBe('solid');
  expect(ring.width).toBe('2px');
  const focusToken = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--tk-focus-ring').trim(),
  );
  // The house ring: --color-focus (rgb of the --tk-focus-ring hex).
  const hex = focusToken.replace('#', '');
  const rgb = `rgb(${parseInt(hex.slice(0, 2), 16)}, ${parseInt(hex.slice(2, 4), 16)}, ${parseInt(hex.slice(4, 6), 16)})`;
  expect(ring.color).toBe(rgb);
  await page.screenshot({ path: `${OUT}/desktop-focus-ring.png` });

  await page.keyboard.press('Enter');
  await expectNewestInView(page, 'channel', BASE + 119);
  await expect(button).toBeHidden();
  await expect(composer).toBeFocused();
});

test('a permalink outside the window: the button is up, and a click loads the present first', async ({
  page,
}) => {
  const w = world(300);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(500);
  // #114: a link to a row far older than the newest page replaces the window
  // with the row's neighbourhood, detached from the live edge (#9).
  await page.evaluate(
    ({ ws, ch, id }) => {
      window.location.hash = `#/workspace/${ws}/channel/${ch}/message/${id}`;
    },
    { ws: WS, ch: CH, id: String(BASE + 40) },
  );
  await expect(page.locator(ROW(BASE + 40))).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId('newer-footer')).toHaveCount(1);
  const button = jumpButton(page);
  await expect(button).toBeVisible();
  await expectPlaced(page, 'channel');
  await page.screenshot({ path: `${OUT}/permalink-detached.png` });

  const before = w.requests.length;
  await button.click();
  await expectNewestInView(page, 'channel', BASE + 299);
  await expect(page.getByTestId('newer-footer')).toHaveCount(0);
  await expect(button).toBeHidden();
  // The present was read with a plain newest-page request (no cursor).
  const reads = w.requests.slice(before).filter((r) => r.startsWith(`GET /channels/${CH}/messages?`));
  expect(reads.some((r) => !r.includes('before=') && !r.includes('after='))).toBe(true);

  await arrive(page, 300);
  await expectNewestInView(page, 'channel', BASE + 300);
  await expect(button).toBeHidden();
});

test('deep history past the window: the newest page is reloaded and the jump lands on the true newest', async ({
  page,
}) => {
  test.setTimeout(150_000);
  const COUNT = 620;
  const w = world(COUNT);
  await mockApi(page, w);
  await openChannel(page);
  const list = scroller(page);
  const footer = page.getByTestId('newer-footer');
  // Walk up until the bounded window sheds its newest rows (#9).
  for (let i = 0; i < 60 && (await footer.count()) === 0; i++) {
    await list.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForTimeout(350);
  }
  await expect(footer, 'the window detached from the live edge').toHaveCount(1);
  const button = jumpButton(page);
  await expect(button).toBeVisible();
  await page.screenshot({ path: `${OUT}/deep-history.png` });

  await button.click();
  await expectNewestInView(page, 'channel', BASE + COUNT - 1);
  await expect(footer).toHaveCount(0);
  await expect(button).toBeHidden();
  await arrive(page, COUNT);
  await expectNewestInView(page, 'channel', BASE + COUNT);
});

test('the thread panel has its own button above the thread composer', async ({ page }) => {
  const w = world(120, 40);
  await mockApi(page, w);
  await openChannel(page);
  await openThread(page);
  const threadButton = jumpButton(page, 'thread');
  const newestReply = BASE + 5000 + 39;
  // Get the thread's newest reply in view first (a thread may open reading
  // from its origin), then leave it.
  if (await threadButton.isVisible()) await threadButton.click();
  await expectNewestInView(page, 'thread', newestReply);
  await expect(threadButton).toBeHidden();

  await wheelUp(page, 'thread', 3);
  await expect(threadButton).toBeVisible();
  await expectPlaced(page, 'thread');
  // The channel's own button is a different control and stays down.
  await expect(jumpButton(page, 'channel')).toBeHidden();
  expect(await axeOnButton(page)).toEqual([]);
  await page.screenshot({ path: `${OUT}/thread-scrolled-up.png` });

  await threadButton.click();
  await expectNewestInView(page, 'thread', newestReply);
  await expect(threadButton).toBeHidden();
});

test('phone width: clear of the composer and the typing line, away from an open palette, on screen with the keyboard up', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const w = world(120);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(600);
  await wheelUp(page, 'channel', 4);
  const button = jumpButton(page);
  await expect(button).toBeVisible();
  await expectPlaced(page, 'channel');
  const size = await button.boundingBox();
  expect(Math.round(size!.width)).toBe(44);
  await page.screenshot({ path: `${OUT}/phone-scrolled-up.png` });

  // A typist goes live: the floating typing line takes the strip above the
  // well and keeps out of the button's column — even a label long enough to
  // wrap. (Injected as the composer renders it: the refused gateway sends no
  // TypingStart.)
  await page.evaluate(() => {
    const compose = [...document.querySelectorAll('[data-testid="message-compose"]')].find(
      (el) => el.closest('[data-testid="thread-side-panel"]') === null,
    )!;
    const line = document.createElement('div');
    line.className = 'typing-line';
    line.dataset.testid = 'injected-typing-line';
    line.innerHTML =
      '<div class="typing-indicator" role="status"><span class="typing-dots" aria-hidden="true"></span>' +
      '<span class="typing-label"><span class="typing-names">Patricia Peerington-Smythe, Samuel Someone-Else, and +3 others</span>' +
      '<span class="typing-remainder"> are typing...</span></span></div>';
    compose.prepend(line);
  });
  await page.waitForTimeout(300);
  const typed = await layout(page, 'channel');
  expect(typed.typing).not.toBeNull();
  expect(overlaps(typed.button, typed.typing!), 'the button clears the typing line').toBe(false);
  expect(typed.typing!.right).toBeLessThanOrEqual(typed.button.left);
  await page.screenshot({ path: `${OUT}/phone-typing.png` });
  await page.evaluate(() => document.querySelector('[data-testid="injected-typing-line"]')?.remove());

  // An open suggestion palette owns that corner: the button steps aside.
  const composer = page.getByTestId('message-pane').getByTestId('composer-input');
  await composer.click();
  await composer.press('#');
  await expect(page.getByTestId('channel-autocomplete')).toBeVisible();
  await expect(button).toBeHidden();
  await composer.press('Escape');
  await composer.press('Backspace');
  await expect(page.getByTestId('channel-autocomplete')).toBeHidden();
  await expect(button).toBeVisible();

  // The on-screen keyboard (interactive-widget=resizes-content shrinks the
  // viewport): the button rides up with the composer and stays on screen.
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(400);
  await expect(button).toBeVisible();
  await expectPlaced(page, 'channel');
  await page.screenshot({ path: `${OUT}/phone-keyboard.png` });

  await button.click();
  await expectNewestInView(page, 'channel', BASE + 119);
  await expect(button).toBeHidden();
});

test('Pixel style: square corners and the hard-offset shadow, from the style tokens', async ({ page }) => {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('cytale.style', 'pixel');
    } catch {
      /* storage unavailable */
    }
  });
  const w = world(120);
  await mockApi(page, w);
  await openChannel(page);
  await page.waitForTimeout(600);
  await expect(page.locator('html')).toHaveAttribute('data-style', 'pixel');
  await wheelUp(page, 'channel', 4);
  const button = jumpButton(page);
  await expect(button).toBeVisible();
  const look = await button.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { radius: cs.borderTopLeftRadius, shadow: cs.boxShadow };
  });
  expect(look.radius).toBe('0px');
  // The pixel popover shadow: a 1px text ring and an unblurred 4px offset.
  expect(look.shadow).toContain('4px 4px 0px');
  expect(await axeOnButton(page)).toEqual([]);
  await page.screenshot({ path: `${OUT}/pixel-scrolled-up.png` });
});
