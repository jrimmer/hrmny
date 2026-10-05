/**
 * Markdown in the composer and the message editor, typed as real keystrokes
 * (owner report 2026-09-28: "I enter `1.` and a space and the `1.` disappears.
 * But when I hit enter it's in the message posted to the channel").
 *
 * Every live shortcut must be VISIBLE the moment it fires (a painted list
 * marker, a heading's size, a quote's bar, a code panel, the emphasis itself),
 * must post exactly the Markdown the timeline then renders the same way, and
 * must be reversible by Backspace and by Ctrl+Z.
 *
 * The keyboard contract these specs pin (Enter always sends):
 *
 *   | block       | Shift+Enter                          | leaves the block        |
 *   |-------------|--------------------------------------|-------------------------|
 *   | paragraph   | a new line (which can start a list)  | —                       |
 *   | list item   | a new item                           | Shift+Enter on an empty item |
 *   | heading     | a new plain line (a heading is one line in the timeline) | at once |
 *   | quote       | a new quoted line                    | Shift+Enter on an empty last line |
 *   | code block  | a new code line (indent kept)        | Shift+Enter on two empty last lines |
 *
 * Enter on an empty trailing list item sends WITHOUT it (the timeline cannot
 * draw an empty item, so the wire never carries one).
 *
 * Fixture-backed (ux-world.ts): no server, no database; the send and the edit
 * are intercepted here and their bodies asserted.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

import { CH, ME, mockApi, openChannel, signIn } from './ux-world';

const OUT = process.env.UXSHOT_DIR;
const TAG = process.env.UXSHOT_TAG ?? 'md';

interface Wire {
  sent: string[];
  edits: string[];
}

/** Messages by the viewer, so the editor can be opened on real Markdown. */
const OWN = [
  { id: '96000000001', content: 'plain line from me' },
  { id: '96000000002', content: '1. first\n2. second\n\n> quoted <@' + ME + '>\n\n# Title\n**bold** *it* ~~gone~~ `code` __under__' },
  { id: '96000000003', content: 'Combined: ~~**struck bold**~~ ***bold italic*** __*underlined italic*__ and https://x.dev**bold after a URL**' },
];

async function setup(page: Page): Promise<Wire> {
  const wire: Wire = { sent: [], edits: [] };
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockApi(page);
  let n = 0;
  const now = Date.now();
  await page.route(`**/api/v1/channels/${CH}/messages**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.endsWith(`/channels/${CH}/messages`)) {
      const body = req.postDataJSON() as { content: string; nonce?: string };
      wire.sent.push(body.content);
      n += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: {
            id: String(97000000000 + n), channel_id: CH, thread_id: null, author_id: ME,
            content: body.content, created_at: new Date().toISOString(), edited_at: null,
            attachments: null, nonce: body.nonce ?? null,
          },
        }),
      });
    }
    if (req.method() === 'PATCH') {
      const body = req.postDataJSON() as { content: string };
      wire.edits.push(body.content);
      const id = url.pathname.split('/').pop()!;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: {
            id, channel_id: CH, thread_id: null, author_id: ME, content: body.content,
            created_at: new Date(now - 5 * 60_000).toISOString(), edited_at: new Date().toISOString(), attachments: null,
          },
        }),
      });
    }
    if (req.method() === 'GET' && url.pathname.endsWith(`/channels/${CH}/messages`)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          messages: OWN.map((m, i) => ({
            id: m.id, channel_id: CH, thread_id: null, author_id: ME, content: m.content,
            created_at: new Date(now - (10 - i) * 60_000).toISOString(), edited_at: null, attachments: null,
          })),
          oldest_id: null,
        }),
      });
    }
    return route.fallback();
  });
  await signIn(page);
  await openChannel(page);
  return wire;
}

function composer(page: Page): Locator {
  return page.getByTestId('composer-input');
}

async function shot(page: Page, target: Locator, name: string): Promise<void> {
  if (!OUT) return;
  await target.screenshot({ path: `${OUT}/${TAG}-${name}.png` });
}

/** The last rendered message body in the timeline. */
function lastBody(page: Page): Locator {
  return page.getByTestId('message-content').last();
}

/** Type a sequence where `\n` means Shift+Enter (Enter would send). */
async function type(box: Locator, text: string): Promise<void> {
  const parts = text.split('\n');
  for (let i = 0; i < parts.length; i += 1) {
    if (i > 0) await box.press('Shift+Enter');
    if (parts[i]) await box.pressSequentially(parts[i]!, { delay: 15 });
  }
}

async function sendAndWait(page: Page, wire: Wire): Promise<string> {
  const before = wire.sent.length;
  await composer(page).press('Enter');
  await expect.poll(() => wire.sent.length).toBe(before + 1);
  return wire.sent[wire.sent.length - 1]!;
}

// ---------------------------------------------------------------------------
// Visual record (before/after screenshots; only when UXSHOT_DIR is set)
// ---------------------------------------------------------------------------

const GALLERY: { name: string; keys: string }[] = [
  { name: 'ordered', keys: '1. first\nsecond' },
  { name: 'bullet', keys: '- apples\npears' },
  { name: 'quote', keys: '> quoted line\nsecond quoted line' },
  { name: 'heading', keys: '# Release notes' },
  { name: 'code', keys: '``` const x = 1;\nreturn x;' },
  { name: 'inline', keys: 'a **bold** and *italic* and `code` and ~~gone~~ word' },
  { name: 'underline', keys: 'and __underlined__ text' },
  { name: 'steps', keys: 'Steps:\n1. build\nship' },
  { name: 'task', keys: '[ ] write tests\nship it' },
  { name: 'nested', keys: 'a ***bold italic*** and **bold `code`** b' },
  { name: 'url', keys: 'see https://x.dev**bold** and https://x.dev/a_b.' },
];

test('gallery: every construct in the composer and in the timeline', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(!OUT, 'screenshot rig only (set UXSHOT_DIR)');
  const wire = await setup(page);
  const well = page.getByTestId('message-compose');
  for (const { name, keys } of GALLERY) {
    await composer(page).click();
    await type(composer(page), keys);
    await page.waitForTimeout(150);
    await shot(page, well, `composer-${name}`);
    await sendAndWait(page, wire);
    await page.waitForTimeout(300);
    await shot(page, page.getByTestId('message-item').last(), `timeline-${name}`);
  }
});

test('gallery: the editor seeded with an existing Markdown message', async ({ page }) => {
  test.skip(!OUT, 'screenshot rig only (set UXSHOT_DIR)');
  await setup(page);
  const own = page.getByTestId('message-item').filter({ hasText: 'Title' }).first();
  await own.hover();
  await own.getByTestId('action-edit').click();
  await expect(page.getByTestId('inline-edit-input')).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, page.getByTestId('inline-edit'), 'editor-seeded');
});

test('gallery: combined emphasis and a URL glued to bold, in the timeline and the editor', async ({ page }) => {
  test.skip(!OUT, 'screenshot rig only (set UXSHOT_DIR)');
  await setup(page);
  const own = page.getByTestId('message-item').filter({ hasText: 'Combined:' }).first();
  await shot(page, own, 'timeline-combined');
  await own.hover();
  await own.getByTestId('action-edit').click();
  await expect(page.getByTestId('inline-edit-input')).toBeVisible();
  await page.waitForTimeout(200);
  await shot(page, page.getByTestId('inline-edit'), 'editor-combined');
});

// ---------------------------------------------------------------------------
// Conformance: real keystrokes, painted styles, the wire
// ---------------------------------------------------------------------------

/** Empty the composer (select all + delete) and leave the caret in it. */
async function clear(box: Locator): Promise<void> {
  await box.click();
  await box.press('Control+a');
  await box.press('Backspace');
  await box.press('Backspace');
}

/** The composer's text as a person reads it (block breaks included). */
async function visibleText(box: Locator): Promise<string> {
  return box.evaluate((el) => (el as HTMLElement).innerText.replace(/ /g, ' ').replace(/\n+$/, ''));
}

async function style(target: Locator, prop: string, pseudo?: string): Promise<string> {
  return target.evaluate(
    (el, [p, ps]) => getComputedStyle(el, ps ?? null).getPropertyValue(p as string),
    [prop, pseudo] as const,
  );
}

test.describe('composer: block shortcuts are painted, reversible, and post what they show', () => {
  test('`1. ` — a painted numbered list; Backspace and Ctrl+Z restore `1. `; Shift+Enter continues; Enter sends', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('1. ');
    const ol = box.locator('ol.md-list');
    await expect(ol.locator('> li')).toHaveCount(1);
    expect(await style(ol, 'list-style-type')).toBe('decimal');
    expect(parseFloat(await style(ol, 'padding-left'))).toBeGreaterThan(12);
    expect(await style(ol.locator('> li').first(), 'display')).toBe('list-item');

    // Backspace: the list goes and the text that made it comes back.
    await box.press('Backspace');
    await expect(box.locator('ol')).toHaveCount(0);
    expect(await visibleText(box)).toBe('1. ');

    // Ctrl+Z straight after the shortcut lands on the literal text too.
    await clear(box);
    await box.pressSequentially('1. ');
    await expect(box.locator('ol.md-list')).toHaveCount(1);
    await box.press('Control+z');
    await expect(box.locator('ol')).toHaveCount(0);
    expect(await visibleText(box)).toBe('1. ');

    // Shift+Enter makes the next item; on an empty item it leaves the list.
    await clear(box);
    await type(box, '1. first\nsecond\n\nafter');
    await expect(box.locator('ol.md-list > li')).toHaveCount(2);
    await shot(page, page.getByTestId('message-compose'), 'e2e-ordered');
    expect(await sendAndWait(page, wire)).toBe('1. first\n2. second\nafter');
    const body = lastBody(page);
    await expect(body.locator('ol.md-list > li')).toHaveCount(2);
    await expect(body).toContainText('after');
    await expect(box.locator('ol')).toHaveCount(0);
  });

  test('`- ` — a painted bullet list; Backspace restores `- `; an empty last item does not post', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('- ');
    const ul = box.locator('ul.md-list');
    await expect(ul).toHaveCount(1);
    expect(await style(ul, 'list-style-type')).toBe('disc');
    await box.press('Backspace');
    await expect(box.locator('ul')).toHaveCount(0);
    expect(await visibleText(box)).toBe('- ');
    await clear(box);
    await type(box, '- apples\npears\n');
    await expect(box.locator('ul.md-list > li')).toHaveCount(3);
    expect(await sendAndWait(page, wire)).toBe('- apples\n- pears');
    await expect(lastBody(page).locator('ul.md-list > li')).toHaveCount(2);
  });

  test('`> ` — a painted quote; Shift+Enter continues it, an empty last line leaves it', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('> ');
    const quote = box.locator('blockquote.md-quote');
    await expect(quote).toHaveCount(1);
    expect(parseFloat(await style(quote, 'border-left-width'))).toBeGreaterThanOrEqual(3);
    await box.press('Backspace');
    await expect(box.locator('blockquote')).toHaveCount(0);
    expect(await visibleText(box)).toBe('> ');
    await clear(box);
    await type(box, '> quoted\nstill quoted\n\nmy reply');
    await expect(box.locator('blockquote.md-quote')).toHaveCount(1);
    expect(await sendAndWait(page, wire)).toBe('> quoted\n> still quoted\nmy reply');
    const body = lastBody(page);
    await expect(body.locator('blockquote.md-quote')).toContainText('still quoted');
    await expect(body.locator('blockquote.md-quote')).not.toContainText('my reply');
  });

  test('`# ` — a painted heading; Shift+Enter starts a plain line; Backspace restores `# `', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('# Title');
    const heading = box.locator('div.md-heading.md-heading-1');
    await expect(heading).toHaveText('Title');
    const size = parseFloat(await style(heading, 'font-size'));
    expect(size).toBeGreaterThan(17);
    expect(size).toBeLessThanOrEqual(21); // modest: the composer stays compact
    expect(Number(await style(heading, 'font-weight'))).toBeGreaterThanOrEqual(600);
    // Not a real <h1>: the page outline stays free of draft text.
    await expect(box.locator('h1, h2, h3, h4, h5, h6')).toHaveCount(0);
    await box.press('Home');
    // Lexical adopts a caret move on the (async) selectionchange; a key
    // pressed in the same tick would still act at the old caret.
    await expect.poll(() => page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(0);
    await page.waitForTimeout(50);
    await box.press('Backspace');
    await expect(box.locator('.md-heading')).toHaveCount(0);
    expect(await visibleText(box)).toBe('# Title');
    await clear(box);
    await type(box, '# Title\nbody');
    await expect(box.locator('.md-heading-1')).toHaveText('Title');
    expect(await sendAndWait(page, wire)).toBe('# Title\nbody');
    await expect(lastBody(page).locator('.md-heading-1')).toHaveText('Title');
  });

  test('``` — a painted code block; Shift+Enter adds code lines; Backspace restores the fence', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('``` ');
    const code = box.locator('code.code-block');
    await expect(code).toHaveCount(1);
    expect(await style(code, 'display')).toBe('block');
    expect(await style(code, 'font-family')).toMatch(/mono/i);
    await box.press('Backspace');
    await expect(box.locator('code.code-block')).toHaveCount(0);
    expect(await visibleText(box)).toBe('``` ');
    await clear(box);
    await type(box, '``` const x = 1;\nreturn x;');
    await expect(box.locator('code.code-block')).toContainText('return x;');
    expect(await sendAndWait(page, wire)).toBe('```\nconst x = 1;\nreturn x;\n```');
    await expect(lastBody(page).locator('pre.code-block')).toContainText('return x;');
  });
});

test.describe('composer: inline shortcuts', () => {
  test('**bold**, `code`, ~~strike~~ paint as they will post; Ctrl+Z undoes one', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('a **bold**');
    const bold = box.locator('.bold');
    await expect(bold).toHaveText('bold');
    expect(Number(await style(bold, 'font-weight'))).toBeGreaterThanOrEqual(600);
    await box.press('Control+z');
    await expect(box.locator('.bold')).toHaveCount(0);
    expect(await visibleText(box)).toBe('a **bold**');
    await clear(box);
    await box.pressSequentially('a **bold** and `code` and ~~gone~~ z');
    await expect(box.locator('.bold')).toHaveText('bold');
    const code = box.locator('.inline-code');
    await expect(code).toHaveText('code');
    expect(await style(code, 'font-family')).toMatch(/mono/i);
    const strike = box.locator('.md-strike');
    await expect(strike).toHaveText('gone');
    expect(await style(strike, 'text-decoration-line')).toContain('line-through');
    expect(await sendAndWait(page, wire)).toBe('a **bold** and `code` and ~~gone~~ z');
    const body = lastBody(page);
    await expect(body.locator('.bold')).toHaveText('bold');
    await expect(body.locator('.inline-code')).toHaveText('code');
    await expect(body.locator('.md-strike')).toHaveText('gone');
  });

  test('literal Markdown stays literal: a reverted `1. ` and lone stars post escaped, render as typed', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('1. ');
    await box.press('Backspace');
    await box.pressSequentially('is the answer, 2 * 3 * 4');
    expect(await sendAndWait(page, wire)).toBe('1\\. is the answer, 2 * 3 * 4');
    await expect(lastBody(page)).toHaveText('1. is the answer, 2 * 3 * 4');
    await expect(lastBody(page).locator('ol, .italic')).toHaveCount(0);
  });

  test('combined emphasis: Ctrl+B, Ctrl+I and Ctrl+U stack on one word, post nested, and paint nested', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('x word y');
    await expect(box).toHaveText('x word y');
    // Select the middle word from the keyboard, one settled step at a time.
    await box.press('Home');
    for (let i = 0; i < 2; i += 1) await box.press('ArrowRight');
    for (let i = 0; i < 4; i += 1) {
      await box.press('Shift+ArrowRight');
      await page.waitForTimeout(50);
    }
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe('word');
    await box.press('ControlOrMeta+b');
    await box.press('ControlOrMeta+i');
    await box.press('ControlOrMeta+u');
    const word = box.locator('.bold.italic.md-underline');
    await expect(word).toHaveText('word');
    expect(Number(await style(word, 'font-weight'))).toBeGreaterThanOrEqual(600);
    expect(await style(word, 'font-style')).toBe('italic');
    expect(await sendAndWait(page, wire)).toBe('x __***word***__ y');
    const body = lastBody(page);
    const painted = body.locator('.md-underline .italic .bold');
    await expect(painted).toHaveText('word');
    expect(Number(await style(painted, 'font-weight'))).toBeGreaterThanOrEqual(600);
    expect(await style(painted, 'font-style')).toBe('italic');
  });

  test('a URL ends before `**`: bold typed straight after a URL is bold, not part of the link', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.pressSequentially('see https://x.dev**b**');
    await expect(box.locator('.bold')).toHaveText('b');
    expect(await sendAndWait(page, wire)).toBe('see https://x.dev**b**');
    const body = lastBody(page);
    await expect(body.locator('a.link')).toHaveText('https://x.dev');
    await expect(body.locator('a.link')).toHaveAttribute('href', 'https://x.dev');
    await expect(body.locator('.bold')).toHaveText('b');
  });

  test('pasting Markdown text builds its structure', async ({ page }) => {
    const wire = await setup(page);
    const box = composer(page);
    await box.click();
    await box.evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', '- one\n- **two**\n> quoted');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expect(box.locator('ul.md-list > li')).toHaveCount(2);
    await expect(box.locator('blockquote.md-quote')).toHaveText('quoted');
    expect(await sendAndWait(page, wire)).toBe('- one\n- **two**\n> quoted');
  });

  test('the composer with every construct passes axe (WCAG 2.1 AA)', async ({ page }) => {
    await setup(page);
    const box = composer(page);
    await box.click();
    await type(box, '# Plan\nSteps **bold** `code`\n1. one\n\n> quoted');
    await page.addScriptTag({ path: 'node_modules/axe-core/axe.min.js' });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; nodes: unknown[] }[] }> } }).axe;
      const result = await axe.run(
        { include: [['[data-testid="message-compose"]']] },
        { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } },
      );
      return result.violations.map((v) => `${v.id} (${v.nodes.length})`);
    });
    expect(violations).toEqual([]);
    await expect(box.locator('ol.md-list > li')).toHaveCount(1);
  });
});

test.describe('message editor: the same Markdown, the same behaviour', () => {
  test('an existing message loads into its visible structure (__x__ is underline, not bold)', async ({ page }) => {
    await setup(page);
    const own = page.getByTestId('message-item').filter({ hasText: 'Title' }).first();
    await own.hover();
    await own.getByTestId('action-edit').click();
    const edit = page.getByTestId('inline-edit-input');
    await expect(edit).toBeVisible();
    await expect(edit.locator('ol.md-list > li')).toHaveCount(2);
    await expect(edit.locator('blockquote.md-quote')).toHaveCount(1);
    await expect(edit.locator('.md-heading-1')).toHaveText('Title');
    await expect(edit.locator('.md-underline')).toHaveText('under');
    await expect(edit.locator('.bold')).toHaveText('bold');
    await expect(edit.locator('.md-strike')).toHaveText('gone');
    await expect(edit.locator('.inline-code')).toHaveText('code');
    // The ordered list is not swallowed into the quote, nor the reverse.
    await expect(edit.locator('blockquote')).not.toContainText('first');
  });

  test('typed shortcuts paint, revert and save exactly as in the composer', async ({ page }) => {
    const wire = await setup(page);
    const own = page.getByTestId('message-item').filter({ hasText: 'plain line from me' }).first();
    await own.hover();
    await own.getByTestId('action-edit').click();
    const edit = page.getByTestId('inline-edit-input');
    await expect(edit).toBeVisible();
    await edit.press('Control+a');
    await edit.press('Backspace');
    await edit.pressSequentially('1. ');
    await expect(edit.locator('ol.md-list')).toHaveCount(1);
    expect(await style(edit.locator('ol.md-list'), 'list-style-type')).toBe('decimal');
    await edit.press('Backspace');
    await expect(edit.locator('ol')).toHaveCount(0);
    await edit.press('Control+a');
    await edit.press('Backspace');
    await type(edit, '1. a\nb\n\n**done** ~~x~~');
    await expect(edit.locator('ol.md-list > li')).toHaveCount(2);
    await expect(edit.locator('.bold')).toHaveText('done');
    await shot(page, page.getByTestId('inline-edit'), 'e2e-editor');
    await edit.press('Enter');
    await expect.poll(() => wire.edits.length).toBe(1);
    expect(wire.edits[0]).toBe('1. a\n2. b\n**done** ~~x~~');
  });

  test('combined emphasis loads combined, and saves back exactly as it was written', async ({ page }) => {
    const wire = await setup(page);
    const own = page.getByTestId('message-item').filter({ hasText: 'Combined:' }).first();
    // The timeline paints each combination nested.
    await expect(own.locator('.md-strike .bold')).toHaveText('struck bold');
    await expect(own.locator('.italic .bold')).toHaveText('bold italic');
    await expect(own.locator('.md-underline .italic')).toHaveText('underlined italic');
    await expect(own.locator('a.link')).toHaveText('https://x.dev');
    await own.hover();
    await own.getByTestId('action-edit').click();
    const edit = page.getByTestId('inline-edit-input');
    await expect(edit).toBeVisible();
    await expect(edit.locator('.bold.md-strike')).toHaveText('struck bold');
    await expect(edit.locator('.bold.italic')).toHaveText('bold italic');
    await expect(edit.locator('.italic.md-underline')).toHaveText('underlined italic');
    await expect(edit.locator('.bold').last()).toHaveText('bold after a URL');
    await edit.press('ControlOrMeta+End');
    await edit.pressSequentially('!');
    await edit.press('Enter');
    await expect.poll(() => wire.edits.length).toBe(1);
    expect(wire.edits[0]).toBe(
      'Combined: ~~**struck bold**~~ ***bold italic*** __*underlined italic*__ and https://x.dev**bold after a URL**!',
    );
  });
});
