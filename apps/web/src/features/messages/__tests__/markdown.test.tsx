/**
 * @cytale/web — message-body markdown rendering (jsdom).
 *
 * Covers the half of the contract the parser tests cannot: what the message
 * viewer actually draws. The regression that prompted this file (user report
 * 2026-09-11, "code's not being rendered and coding's not being recognized as
 * closed") came from fenced runs going through the INLINE renderer — the fence
 * backticks leaked as literal text and the whole run was boxed as one
 * multi-line `code` span, with the prose after it swallowed whenever the
 * fences did not pair up.
 *
 * `renderInlineMarkdown` stays inline-only on purpose: the mobile parity suite
 * executes it over a shared corpus.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';

import { renderInlineMarkdown, renderMarkdown } from '../markdown.js';

afterEach(cleanup);

const inBody = (text: string) => <div className="whitespace-pre-wrap">{renderMarkdown(text)}</div>;

describe('renderMarkdown — fenced code blocks', () => {
  it('renders a fence as one <pre><code>, with the surrounding prose outside it', () => {
    const { container } = render(
      inBody('Before\n```\ncurl -s "$URL"\ndate -u\n```\nAfter'),
    );

    const blocks = container.querySelectorAll('[data-testid="code-block"]');
    expect(blocks).toHaveLength(1);
    const pre = blocks[0]!;
    expect(pre.tagName).toBe('PRE');
    expect(pre.querySelector('code')!.textContent).toBe('curl -s "$URL"\ndate -u');
    // No stray backticks anywhere in the rendered body.
    expect(container.textContent).not.toContain('`');
    // The prose stayed prose: "Before" and "After" are outside the code block.
    const text = container.textContent ?? '';
    expect(text.indexOf('Before')).toBeLessThan(text.indexOf('curl'));
    expect(text.indexOf('After')).toBeGreaterThan(text.indexOf('date'));
  });

  it('carries the language hint as data-lang (and only when given)', () => {
    const { container } = render(inBody('```python\nx = 1\n```\n\n```\nplain\n```'));
    const blocks = container.querySelectorAll('[data-testid="code-block"]');
    expect(blocks[0]!.getAttribute('data-lang')).toBe('python');
    expect(blocks[1]!.getAttribute('data-lang')).toBeNull();
  });

  it('an UNCLOSED fence still renders as a code block to the end of the message', () => {
    const { container } = render(inBody('```\nline one\nline two'));
    const pre = container.querySelector('[data-testid="code-block"]');
    expect(pre).not.toBeNull();
    expect(pre!.textContent).toBe('line one\nline two');
  });

  it('keeps inline syntax inside a code block LITERAL', () => {
    const { container } = render(inBody('```\n**bold** <@42> [x](https://y.z)\n```'));
    const pre = container.querySelector('[data-testid="code-block"]')!;
    // No strong/mention/anchor inside the block — it is code, not markup.
    expect(pre.querySelector('strong')).toBeNull();
    expect(pre.querySelector('.mention')).toBeNull();
    expect(pre.querySelector('a')).toBeNull();
    expect(pre.textContent).toBe('**bold** <@42> [x](https://y.z)');
  });

  it('still renders inline markdown outside fences', () => {
    const { container } = render(inBody('**bold** and `code` and <@42>'));
    expect(container.querySelector('strong')!.textContent).toBe('bold');
    expect(container.querySelector('.inline-code')!.textContent).toBe('code');
    expect(container.querySelector('.mention')!.textContent).toBe('@42');
  });

  it('resolves mentions through the resolver as before', () => {
    render(<div>{renderMarkdown('hi <@42>', (id) => (id === '42' ? 'alice' : undefined))}</div>);
    expect(screen.getByText('@alice')).toBeTruthy();
  });

  it('an empty body renders nothing', () => {
    const { container } = render(inBody(''));
    expect(container.textContent).toBe('');
  });
});

describe('renderInlineMarkdown — inline-only (mobile parity contract)', () => {
  it('does NOT treat a fence as a block: the inline mapping is unchanged', () => {
    // This is deliberate: apps/mobile's parity suite runs this function over a
    // shared corpus. Block handling lives in renderMarkdown.
    const { container } = render(<div>{renderInlineMarkdown('```\ncode\n```')}</div>);
    expect(container.querySelector('[data-testid="code-block"]')).toBeNull();
  });
});

describe('renderMarkdown — headings', () => {
  it('renders # .. ###### with a level class, without document semantics', () => {
    // Reported as "headers #, ##, ### etc. aren't being rendered". Styled DIVs,
    // not <h1>: a message is not a section, and per-message headings would
    // pollute the accessibility outline (and axe's heading-order rule).
    const { container } = render(inBody('# One\n\n### Three\n\n###### Six'));
    const levels = Array.from(container.querySelectorAll('.md-heading')).map(
      (el) => el.className,
    );
    expect(levels).toEqual(['md-heading md-heading-1', 'md-heading md-heading-3', 'md-heading md-heading-6']);
    expect(container.querySelector('h1, h2, h3, h4, h5, h6')).toBeNull();
    expect(container.textContent).toContain('One');
    expect(container.textContent).toContain('Six');
  });

  it('keeps inline markdown inside a heading, and prose outside it', () => {
    const { container } = render(inBody('intro\n## Hello **world** <@42>\nbody'));
    const heading = container.querySelector('.md-heading-2')!;
    expect(heading.querySelector('strong')!.textContent).toBe('world');
    expect(heading.querySelector('.mention')!.textContent).toBe('@42');
    const text = container.textContent ?? '';
    expect(text.indexOf('intro')).toBeLessThan(text.indexOf('Hello'));
    expect(text.indexOf('body')).toBeGreaterThan(text.indexOf('Hello'));
  });

  it('a hash inside a fence stays code', () => {
    const { container } = render(inBody('```\n# not a heading\n```'));
    expect(container.querySelector('.md-heading')).toBeNull();
    expect(container.querySelector('[data-testid="code-block"]')!.textContent).toContain('# not a heading');
  });
});

describe('renderMarkdown — decorations and escapes', () => {
  it('renders bold italic, underline and strike', () => {
    const { container } = render(inBody('***both*** __under__ ~~gone~~'));
    // `***x***` is bold inside italic (Discord's reading).
    const em = container.querySelector('em')!;
    expect(em.querySelector('strong')!.textContent).toBe('both');
    expect(container.querySelector('.md-underline')!.textContent).toBe('under');
    const strike = container.querySelector('.md-strike')!;
    expect(strike.tagName).toBe('S');
    expect(strike.textContent).toBe('gone');
  });

  it('escaped delimiters render as the characters, never as spans', () => {
    const { container } = render(inBody('\\*\\*not bold\\*\\*'));
    expect(container.textContent).toBe('**not bold**');
    expect(container.querySelector('strong')).toBeNull();
    expect(container.querySelector('em')).toBeNull();
  });

  it('a single inner asterisk no longer breaks the bold span', () => {
    const { container } = render(inBody('**bold with inner *star**'));
    expect(container.querySelector('strong')!.textContent).toBe('bold with inner *star');
  });

  it('keeps decorations inside a heading', () => {
    const { container } = render(inBody('## ~~old~~ **new**'));
    const heading = container.querySelector('.md-heading-2')!;
    expect(heading.querySelector('.md-strike')!.textContent).toBe('old');
    expect(heading.querySelector('strong')!.textContent).toBe('new');
  });
});

describe('renderMarkdown — quotes and lists', () => {
  it('renders a quote run as one <blockquote>', () => {
    const { container } = render(inBody('> one\n> two'));
    const quote = container.querySelectorAll('blockquote.md-quote');
    expect(quote).toHaveLength(1);
    expect(quote[0]!.textContent).toContain('one');
    expect(quote[0]!.textContent).toContain('two');
  });

  it('renders bullets and ordered items as real lists, with the start number', () => {
    const { container } = render(inBody('- a\n- b\n\n3. c'));
    expect(container.querySelectorAll('ul.md-list li.md-list-item')).toHaveLength(2);
    const ol = container.querySelector('ol.md-list')!;
    expect(ol.getAttribute('start')).toBe('3');
    expect(ol.querySelectorAll('li')).toHaveLength(1);
  });

  it('shows a task glyph and announces its state', () => {
    const { container } = render(inBody('- [ ] todo\n- [x] done'));
    const glyphs = Array.from(container.querySelectorAll('.md-task')).map((el) => el.textContent);
    expect(glyphs).toEqual(['☐', '☑']);
    expect(container.textContent).toContain('unchecked');
    expect(container.textContent).toContain('checked');
  });

  it('keeps inline markdown inside an item', () => {
    const { container } = render(inBody('- **bold** item'));
    expect(container.querySelector('li strong')!.textContent).toBe('bold');
  });
});

// ---------------------------------------------------------------------------
// Parity ledger — Hermes' markdown rendering test v1, adopted as a fixture
// ---------------------------------------------------------------------------
//
// One row per line of that test, asserted against the RENDERED output, where
// it is executable. Rows marked `gap` are the constructs Discord renders and
// we deliberately do not: they assert TODAY'S behaviour, so implementing one
// fails the row loudly and the fix flips it to `patch` in the same commit —
// the point is that the gap cannot close or widen silently.
//
// Statuses: `parity` = matches Discord, `gap` = Discord renders, we do not.

describe('markdown parity ledger (Hermes v1)', () => {
  const render1 = (text: string, resolve?: (id: string) => string) =>
    render(<div>{renderMarkdown(text, resolve)}</div>).container;

  it('1-4: bold, italic, inline code, link', () => {
    const c = render1('**BOLD** *ITALIC* `CODE` [label](https://example.com)');
    expect(c.querySelector('strong')!.textContent).toBe('BOLD');
    expect(c.querySelector('em')!.textContent).toBe('ITALIC');
    expect(c.querySelector('.inline-code')!.textContent).toBe('CODE');
    expect(c.textContent).not.toContain('`');
    expect(c.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    expect(c.querySelector('a')!.textContent).toBe('label');
  });

  it('5-6: mentions render as pills with their resolved name', () => {
    const c = render1('<@9000000000000002> and <@9000000000000003>', (id) =>
      id === '9000000000000002' ? 'Max' : 'jason',
    );
    const pills = Array.from(c.querySelectorAll('.mention')).map((el) => el.textContent);
    expect(pills).toEqual(['@Max', '@jason']);
  });

  it('7-8: nesting (was a gap) — a link and code inside bold stay live', () => {
    const c = render1('**[label](https://example.com)** and **`code`**');
    const strongs = c.querySelectorAll('strong');
    expect(strongs[0]!.querySelector('a')!.textContent).toBe('label');
    expect(strongs[0]!.querySelector('a')!.getAttribute('href')).toBe('https://example.com');
    expect(strongs[1]!.querySelector('code')!.textContent).toBe('code');
    expect(c.textContent).not.toContain('`'); // no stray backticks
  });

  it('7-8b: emphasis nests — every combination paints every element', () => {
    const c = render1('~~**sb**~~ ***bi*** __*ui*__ __*~~**all**~~*__');
    expect(c.querySelector('s.md-strike > strong.bold')!.textContent).toBe('sb');
    expect(c.querySelector('em.italic > strong.bold')!.textContent).toBe('bi');
    expect(c.querySelector('.md-underline > em.italic')!.textContent).toBe('ui');
    expect(c.querySelector('.md-underline > em > s > strong')!.textContent).toBe('all');
  });

  it('9: escaped delimiters render as the characters', () => {
    const c = render1('\\*\\*not bold\\*\\*');
    expect(c.textContent).toBe('**not bold**');
    expect(c.querySelector('strong')).toBeNull();
  });

  it('10-11: underline and strikethrough', () => {
    const c = render1('__under__ ~~gone~~');
    expect(c.querySelector('.md-underline')!.textContent).toBe('under');
    expect(c.querySelector('.md-strike')!.textContent).toBe('gone');
  });

  it('12: spoiler is a known gap — still literal', () => {
    const c = render1('||hidden||');
    expect(c.textContent).toBe('||hidden||');
    expect(c.querySelector('[data-testid="spoiler"]')).toBeNull();
  });

  it('13-14: headings', () => {
    const c = render1('# H1\n\n## H2');
    expect(c.querySelector('.md-heading-1')!.textContent).toBe('H1');
    expect(c.querySelector('.md-heading-2')!.textContent).toBe('H2');
  });

  it('15-16: quote, bullet, ordered and task lists', () => {
    const c = render1('> quoted\n\n- bullet\n\n1. ordered\n\n- [ ] task');
    expect(c.querySelector('blockquote.md-quote')!.textContent).toContain('quoted');
    expect(c.querySelector('ul.md-list li')!.textContent).toContain('bullet');
    expect(c.querySelector('ol.md-list li')!.textContent).toContain('ordered');
    expect(c.querySelector('.md-task')!.textContent).toBe('☐');
  });

  it('17: horizontal rule is a known gap — still literal', () => {
    expect(render1('---').textContent).toBe('---');
  });

  it('18: tables stay literal (Discord too)', () => {
    const c = render1('| a | b |');
    expect(c.textContent).toBe('| a | b |');
    expect(c.querySelector('table')).toBeNull();
  });

  it('19-20: autolinks, angle and bare', () => {
    const c = render1('<https://example.com> and https://example.com/x.');
    const hrefs = Array.from(c.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['https://example.com', 'https://example.com/x']);
  });

  it('21: a bold span survives a single inner asterisk', () => {
    const c = render1('**bold with inner *star**');
    expect(c.querySelector('strong')!.textContent).toBe('bold with inner *star');
  });

  it('22: two italic runs are two italics', () => {
    const c = render1('*one* and *two*');
    expect(Array.from(c.querySelectorAll('em')).map((e) => e.textContent)).toEqual([
      'one',
      'two',
    ]);
  });

  it('23-24: the link scheme policy drops the target, keeps the label', () => {
    const c = render1('[bare](//example.com) and [inert](javascript:alert(1))');
    expect(c.querySelectorAll('a')).toHaveLength(0);
    expect(c.textContent).toContain('bare');
    expect(c.textContent).toContain('inert');
  });

  it('25: channel refs parse as channel nodes (#id without an injected pill)', () => {
    const c = render1('<#91267352024317952>');
    expect(c.textContent).toBe('#91267352024317952');
    expect(c.querySelector('[data-channel-id="91267352024317952"]')).not.toBeNull();
  });

  it('26-27: raw HTML is literal, and the symbols render', () => {
    const c = render1('<b>raw html</b> and 5 > 3 & 2 < 4');
    expect(c.querySelector('b')).toBeNull();
    expect(c.textContent).toContain('<b>raw html</b>');
    expect(c.textContent).toContain('5 > 3 & 2 < 4');
  });

  it('29-30: a fenced body stays literal, and an unclosed fence runs to the end', () => {
    const c = render1('```js\nconst notBold = "**literal**";\n<@9000000000000002> stays literal\n```');
    const pre = c.querySelector('[data-testid="code-block"]')!;
    expect(pre.querySelector('strong')).toBeNull();
    expect(pre.querySelector('.mention')).toBeNull();
    expect(pre.textContent).toContain('<@9000000000000002> stays literal');
    expect(pre.getAttribute('data-lang')).toBe('js');

    const open = render1('```\nlast line\n**and this is not bold**');
    expect(open.querySelector('[data-testid="code-block"]')!.textContent).toContain(
      '**and this is not bold**',
    );
  });
});

// ---------------------------------------------------------------------------
// #118 — the permalink chip hook
// ---------------------------------------------------------------------------
//
// `renderMarkdown` owns the "is this one of OUR permalinks" rule and offers
// those links to the injected renderer. What the renderer returns is the
// caller's business (MessageItem returns a `PermalinkChip`); what this suite
// pins is the DISPATCH: only a same-instance MESSAGE address is offered,
// returning null keeps the anchor exactly as it was, and with no renderer
// injected at all (the mobile parity path) nothing changes.

describe('renderMarkdown — #118 permalink chip hook', () => {
  const ORIGIN = globalThis.location.origin;
  const PERMALINK = `${ORIGIN}/#/workspace/1001/channel/2002/message/3003`;

  /** Render `text` with a chip renderer that records what it was offered. */
  const declining = (text: string) => {
    const offered: string[] = [];
    const container = render(
      <div>
        {renderMarkdown(text, undefined, (href) => {
          offered.push(href);
          return null;
        })}
      </div>,
    ).container;
    return { offered, container };
  };

  it('offers only a same-instance message link, and keeps the anchor when the chip declines', () => {
    const text = `see ${PERMALINK} and https://example.com/x and ${ORIGIN}/#/workspace/1001/channel/2002`;
    const { offered, container } = declining(text);

    // The channel address is one of OURS but not a message: no author or
    // snippet to show, so it is never offered; the foreign host never is.
    expect(offered).toEqual([PERMALINK]);
    // Declined → the plain anchor, unchanged (same hrefs, same order).
    expect(Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'))).toEqual([
      PERMALINK,
      'https://example.com/x',
      `${ORIGIN}/#/workspace/1001/channel/2002`,
    ]);
  });

  it('renders what the renderer returns in the anchor\u2019s place', () => {
    const container = render(
      <div>
        {renderMarkdown(PERMALINK, undefined, (_href, _text, target, key) => (
          <em key={key} data-testid="stub-chip">
            {target.messageId}
          </em>
        ))}
      </div>,
    ).container;

    expect(container.querySelector('[data-testid="stub-chip"]')!.textContent).toBe('3003');
    expect(container.querySelector('a')).toBeNull();
    expect(container.textContent).toBe('3003');
  });

  it('does not offer anything when no renderer was injected (the parity path)', () => {
    const container = render(<div>{renderInlineMarkdown(PERMALINK)}</div>).container;
    expect(container.querySelector('a')!.getAttribute('href')).toBe(PERMALINK);
  });
});
