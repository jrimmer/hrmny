/**
 * The composer's `#` / `@` palettes float OVER the conversation (owner report
 * 2026-09-28: "channel and tagging search in the composer should not push the
 * message content up, instead it should be over the message content").
 *
 * The palettes used to render in the composer well's flow: opening one grew
 * the composer, shrank the message list, and the list (following its bottom)
 * scrolled. They now sit in EditorPalettes' own anchor, absolutely placed
 * above the host box. For both composers that mount the shared bundle — the
 * channel composer and the thread composer — and at desktop and phone widths,
 * with history long enough to scroll, this pins:
 *
 *  - the message list's scrollTop is unchanged while the palette is open;
 *  - the composer's bounding box is unchanged;
 *  - the palette's box overlaps the timeline region, sits above the well, and
 *    is what the pointer hits at its centre (on top, not clipped);
 *  - the palette stays inside the viewport when the phone's on-screen
 *    keyboard shrinks it (interactive-widget=resizes-content);
 *  - axe (WCAG 2.1 AA) passes with the palette open.
 *
 * Fixture-backed (ux-world.ts): no server, no database.
 */
import { expect, test, type Page } from '@playwright/test';

import { BOT, CH, ME, PARENT, PEER, THREAD, mockApi, openChannel, signIn } from './ux-world';

const now = Date.now();
const ago = (mins: number) => new Date(now - mins * 60_000).toISOString();
const AUTHORS = [PEER, BOT, ME];

/** Enough channel history to scroll, ending on the thread's origin. */
const HISTORY = [
  ...Array.from({ length: 40 }, (_, i) => ({
    id: String(94000000000 + i),
    channel_id: CH,
    thread_id: null,
    author_id: AUTHORS[i % 3],
    content: `history line ${i + 1} — earlier chat, long enough that the channel scrolls`,
    created_at: ago(900 - i * 10),
    edited_at: null,
    attachments: null,
  })),
  {
    id: PARENT,
    channel_id: CH,
    thread_id: null,
    author_id: PEER,
    content: 'Kicking off the release checklist for **v2.3**.',
    created_at: ago(300),
    edited_at: null,
    attachments: null,
  },
];

const REPLIES = Array.from({ length: 30 }, (_, i) => ({
  id: String(95000000400 + i),
  channel_id: CH,
  thread_id: THREAD,
  author_id: AUTHORS[i % 3],
  content: `thread reply ${i + 1} — enough replies that the thread scrolls too`,
  created_at: ago(280 - i * 5),
  edited_at: null,
  attachments: null,
}));

async function setup(page: Page, width: number, height: number): Promise<void> {
  await page.setViewportSize({ width, height });
  await mockApi(page);
  // Registered after mockApi, so these win for their paths.
  await page.route(`**/api/v1/channels/${CH}/messages**`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: HISTORY, oldest_id: null }) })
      : route.fallback(),
  );
  await page.route(`**/api/v1/threads/${THREAD}/messages**`, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: REPLIES, oldest_id: null }) })
      : route.fallback(),
  );
  await signIn(page);
  await openChannel(page);
}

type Scope = 'channel' | 'thread';

interface Geo {
  scrollTop: number;
  scrollable: boolean;
  well: { x: number; y: number; width: number; height: number };
  timeline: { top: number; bottom: number; left: number; right: number };
  palette: { top: number; bottom: number; left: number; right: number } | null;
  hitInPalette: boolean;
  viewportH: number;
}

/** The scope's list scroller, composer well and (if open) palette anchor. */
function geometry(page: Page, scope: Scope): Promise<Geo> {
  return page.evaluate((scope) => {
    const inThread = (el: Element) => el.closest('[data-testid="thread-side-panel"]') !== null;
    const pick = (sel: string) =>
      [...document.querySelectorAll(sel)].find((el) => (scope === 'thread') === inThread(el)) ?? null;
    const scroller = pick('[data-testid="message-list"] [data-virtuoso-scroller="true"]') as HTMLElement | null;
    const well = pick('[data-testid="composer-well"]');
    const anchor = pick('[data-testid="editor-palettes"]');
    if (!scroller || !well) throw new Error(`missing ${scope} scroller or well`);
    const s = scroller.getBoundingClientRect();
    const w = well.getBoundingClientRect();
    const p = anchor?.getBoundingClientRect() ?? null;
    let hitInPalette = false;
    if (p && anchor) {
      const hit = document.elementFromPoint((p.left + p.right) / 2, (p.top + p.bottom) / 2);
      hitInPalette = hit !== null && anchor.contains(hit);
    }
    return {
      scrollTop: Math.round(scroller.scrollTop),
      scrollable: scroller.scrollHeight > scroller.clientHeight + 20,
      well: { x: Math.round(w.x), y: Math.round(w.y), width: Math.round(w.width), height: Math.round(w.height) },
      timeline: { top: s.top, bottom: s.bottom, left: s.left, right: s.right },
      palette: p ? { top: p.top, bottom: p.bottom, left: p.left, right: p.right } : null,
      hitInPalette,
      viewportH: window.innerHeight,
    };
  }, scope);
}

function composerIn(page: Page, scope: Scope) {
  const input = page.getByTestId('composer-input');
  return scope === 'thread'
    ? page.getByTestId('thread-side-panel').getByTestId('composer-input')
    : input.filter({ hasNot: page.locator('xpath=ancestor::*[@data-testid="thread-side-panel"]') }).first();
}

async function openThread(page: Page): Promise<void> {
  const indicator = page.getByTestId('thread-indicator').first();
  await indicator.scrollIntoViewIfNeeded();
  await indicator.click();
  await expect(page.getByTestId('thread-side-panel')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
    const result = await axe.run(
      // The avatar tiles are scanned too: the palette clears AA for white
      // initials on every hue (app/ui/avatar.ts `avatarTileColor`).
      { include: [['[data-testid="editor-palettes"]']] },
      { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
    );
    return result.violations.map((v) => `${v.id} (${v.nodes.length})` + ' ' + JSON.stringify((v.nodes as { target: unknown; failureSummary: string }[]).map((n) => [n.target, n.failureSummary])));
  });
}

/** Type the trigger, assert the overlay contract, then clear the composer. */
async function checkPalette(page: Page, scope: Scope, trigger: '#' | '@'): Promise<void> {
  const box = composerIn(page, scope);
  await box.click();
  await page.waitForTimeout(300);
  const before = await geometry(page, scope);
  expect(before.scrollable, `${scope}: the history scrolls`).toBe(true);
  expect(before.palette).toBeNull();

  await box.press(trigger);
  const testId = trigger === '#' ? 'channel-autocomplete' : 'mention-autocomplete';
  await expect(page.getByTestId(testId)).toBeVisible();
  // Let virtuoso and any resize observers settle before measuring.
  await page.waitForTimeout(400);
  const open = await geometry(page, scope);

  expect(open.scrollTop, `${scope} ${trigger}: the list did not scroll`).toBe(before.scrollTop);
  expect(open.well, `${scope} ${trigger}: the composer did not move or grow`).toEqual(before.well);
  const p = open.palette!;
  expect(p, `${scope} ${trigger}: palette anchor present`).not.toBeNull();
  expect(p.bottom, 'the palette sits above the well').toBeLessThanOrEqual(open.well.y + 1);
  expect(p.top < open.timeline.bottom && p.bottom > open.timeline.top, 'the palette overlaps the timeline').toBe(true);
  expect(p.left < open.timeline.right && p.right > open.timeline.left).toBe(true);
  expect(p.top, 'the palette is inside the viewport').toBeGreaterThanOrEqual(0);
  expect(open.hitInPalette, 'the palette is on top, not clipped or covered').toBe(true);
  // The editor still owns the listbox.
  await expect(box).toHaveAttribute('aria-expanded', 'true');
  await box.press('ArrowDown');
  await expect(box).toHaveAttribute('aria-activedescendant', /.+/);
  expect(await axeViolations(page)).toEqual([]);

  await box.press('Escape');
  await expect(page.getByTestId(testId)).toBeHidden();
  await box.press('Backspace');
}

for (const vp of [
  { label: 'desktop', width: 1280, height: 860 },
  { label: 'phone', width: 390, height: 844 },
]) {
  test.describe(`composer palettes overlay the timeline @ ${vp.label}`, () => {
    test('channel composer: # and @ leave the list and the composer where they were', async ({ page }) => {
      await setup(page, vp.width, vp.height);
      await checkPalette(page, 'channel', '#');
      await checkPalette(page, 'channel', '@');
    });

    test('thread composer: # and @ leave the thread and its composer where they were', async ({ page }) => {
      await setup(page, vp.width, vp.height);
      await openThread(page);
      await checkPalette(page, 'thread', '#');
      await checkPalette(page, 'thread', '@');
    });
  });
}

test('phone with the on-screen keyboard up: the palette stays on screen, capped, scrolling inside', async ({ page }) => {
  await setup(page, 390, 844);
  const box = composerIn(page, 'channel');
  await box.click();
  // A resizes-content keyboard shrinks the layout viewport (index.html).
  await page.setViewportSize({ width: 390, height: 420 });
  await page.waitForTimeout(400);
  await box.press('@');
  await expect(page.getByTestId('mention-autocomplete')).toBeVisible();
  await page.waitForTimeout(300);
  const g = await geometry(page, 'channel');
  expect(g.palette!.top).toBeGreaterThanOrEqual(0);
  expect(g.palette!.bottom).toBeLessThanOrEqual(g.well.y + 1);
  expect(g.hitInPalette).toBe(true);
  const cap = await page.getByTestId('mention-autocomplete').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { maxH: parseFloat(cs.maxHeight), overflowY: cs.overflowY, h: el.getBoundingClientRect().height };
  });
  expect(cap.overflowY).toBe('auto');
  expect(cap.h).toBeLessThanOrEqual(cap.maxH + 1);
  expect(cap.maxH).toBeLessThanOrEqual(420 * 0.45 + 1);
});
