/**
 * Terminal markdown renderer tests (plan U16; R26, R26a).
 *
 * The contract these pin: the terminal prints the SHARED parse tree
 * (`@cytale/markdown`) with terminal styling, degrades everything R26 does not
 * name to readable text, wraps to the caller's width without cutting a glyph,
 * and prints nothing a server-supplied string can steer. The parity block at
 * the end asserts the terminal against the shared parser directly — the
 * browser and the native client render the same tree, so a divergence shows up
 * here before it shows up between clients.
 */
import {
  isEmphasisNode,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  timestampPlainText,
  type InlineNode,
  type MentionResolver,
} from '@cytale/markdown';
import { describe, expect, it, vi } from 'vitest';

import {
  ANSI_STYLE_CODES,
  DEFAULT_WIDTH,
  detectColorSupport,
  displayWidth,
  renderMarkdown,
  renderMarkdownLines,
  sanitizeTerminalText,
  type TerminalStyleAtom,
} from '../format/markdown.js';

const ESC = '\u001b';
const SGR = /\u001b\[[0-9;]*m/g;
const stripAnsi = (value: string): string => value.replace(SGR, '');
/** Wide enough that nothing in a corpus entry wraps. */
const WIDE = 200;

/** Render with colour off unless a test asks for it (most assertions are
 * about text; the styling tests opt in). */
function render(body: string, options: { width?: number; color?: boolean } = {}): string {
  return renderMarkdown(body, { width: WIDE, color: false, ...options });
}

/** Every SGR code the renderer emitted, resets excluded. */
function emittedCodes(value: string): Set<number> {
  const codes = new Set<number>();
  for (const match of value.matchAll(/\u001b\[(\d+)m/g)) {
    const code = Number(match[1]);
    if (code !== 0) codes.add(code);
  }
  return codes;
}

/** The spec's node kind to attribute map — written out here, not imported, so
 * this test fails if the renderer's mapping drifts. */
const EXPECTED_ATOMS: Record<InlineNode['type'], readonly TerminalStyleAtom[]> = {
  text: [],
  mention: [],
  channel: [],
  timestamp: [],
  code: ['code'],
  link: [],
  image: [],
  bold: ['bold'],
  italic: ['italic'],
  underline: ['underline'],
  strike: ['strike'],
};

const ALICE = '700000000000000001';
const resolveAlice: MentionResolver = (id) => (id === ALICE ? 'alice' : undefined);

// ---------------------------------------------------------------------------
// R26a — the sanitizer
// ---------------------------------------------------------------------------

describe('sanitizeTerminalText', () => {
  it('removes an escape sequence with its payload, keeping the text around it', () => {
    expect(sanitizeTerminalText('eve\u001b[2Jpwn')).toBe('evepwn');
    expect(sanitizeTerminalText('a\u001b[31mred\u001b[0mz')).toBe('aredz');
    // A lone ESC and an unmapped escape go too, never leaving parameters behind.
    expect(sanitizeTerminalText('a\u001bb')).toBe('a');
    expect(sanitizeTerminalText('a\u001b')).toBe('a');
  });

  it('removes OSC 52 clipboard writes whichever terminator they use', () => {
    expect(sanitizeTerminalText('a\u001b]52;c;cHduZWQ=\u0007b')).toBe('ab');
    expect(sanitizeTerminalText('a\u001b]52;c;cHduZWQ=\u001b\\b')).toBe('ab');
    // An unterminated one runs to the end of the value rather than surviving.
    expect(sanitizeTerminalText('a\u001b]52;c;cHduZWQ=')).toBe('a');
  });

  it('removes C0, DEL, and C1 controls, and normalizes CR', () => {
    expect(sanitizeTerminalText('a\u0000\u0007b\u007f\u009bc')).toBe('abc');
    expect(sanitizeTerminalText('one\r\ntwo')).toBe('one two');
    expect(sanitizeTerminalText('over\rwrite')).toBe('over write');
  });

  it('collapses newlines and tabs in a single-line value', () => {
    expect(sanitizeTerminalText('eve\n2J')).toBe('eve 2J');
    expect(sanitizeTerminalText('eve\t2J')).toBe('eve 2J');
  });

  it('keeps newlines and tabs when the caller says they are content', () => {
    expect(sanitizeTerminalText('one\n\ttwo', { allowNewlines: true })).toBe('one\n\ttwo');
    // CR still cannot survive: it returns the cursor to column zero.
    expect(sanitizeTerminalText('one\r\ntwo', { allowNewlines: true })).toBe('one\ntwo');
  });

  it('removes bidirectional controls but leaves emoji sequences intact', () => {
    // Trojan-source shape: the text reads right-to-left and reorders chrome.
    expect(sanitizeTerminalText('eve\u202ehtab')).toBe('evehtab');
    expect(sanitizeTerminalText('a\u200eb')).toBe('ab');
    const family = '\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
    expect(sanitizeTerminalText(family)).toBe(family);
    expect(sanitizeTerminalText('\u2764\ufe0f')).toBe('\u2764\ufe0f');
  });

  it('is idempotent', () => {
    const hostile = 'a\u001b[2Jb\u001b]52;c;x\u0007c\u0000d';
    const once = sanitizeTerminalText(hostile);
    expect(sanitizeTerminalText(once)).toBe(once);
  });
});

describe('detectColorSupport', () => {
  it('is off without a TTY and on with one', () => {
    expect(detectColorSupport({ isTTY: false }, {})).toBe(false);
    expect(detectColorSupport(undefined, {})).toBe(false);
    expect(detectColorSupport({ isTTY: true }, { TERM: 'xterm-256color' })).toBe(true);
  });

  it('honours NO_COLOR and TERM=dumb', () => {
    expect(detectColorSupport({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(detectColorSupport({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(detectColorSupport({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R26 — the subset renders with styling
// ---------------------------------------------------------------------------

describe('the markdown subset', () => {
  it('renders emphasis as italic', () => {
    expect(render('*hi*', { color: true })).toBe(`${ESC}[0m${ESC}[3mhi${ESC}[0m`);
  });

  it('renders bold as bold', () => {
    expect(render('**hi**', { color: true })).toBe(`${ESC}[0m${ESC}[1mhi${ESC}[0m`);
  });

  it('renders inline code in the code style', () => {
    expect(render('`hi`', { color: true })).toBe(`${ESC}[0m${ESC}[36mhi${ESC}[0m`);
  });

  it('renders a fenced code block as literal indented text', () => {
    const out = render('```js\nconst x = 1;\n```', { color: true });
    expect(stripAnsi(out)).toBe('  const x = 1;');
    expect(out).toContain(`${ESC}[36mconst x = 1;`);
    // The fence markers are the parser's; they never print.
    expect(out).not.toContain('```');
    expect(out).not.toContain('js');
  });

  it('does not inline-parse a code block body', () => {
    const out = render('```\n**not bold** <@700000000000000001>\n```');
    expect(stripAnsi(out)).toBe('  **not bold** <@700000000000000001>');
  });

  it('renders a blockquote with a marker on every line and italic text', () => {
    const out = render('> one\n> two', { color: true });
    expect(stripAnsi(out)).toBe('> one\n> two');
    expect(emittedCodes(out)).toEqual(new Set([ANSI_STYLE_CODES.italic]));
  });

  it('marks every wrapped quote line so the quote survives the wrap', () => {
    const out = render('> a fairly long quoted sentence that will wrap', { width: 12 });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.startsWith('> ')).toBe(true);
  });

  it('renders a heading as bold text without its markers', () => {
    expect(render('## Title')).toBe('Title');
    expect(render('## Title', { color: true })).toBe(`${ESC}[0m${ESC}[1mTitle${ESC}[0m`);
  });

  it('renders lists with their markers re-emitted as text', () => {
    expect(render('- one\n- two')).toBe('- one\n- two');
    expect(render('1. one\n2. two')).toBe('1. one\n2. two');
    expect(render('3. three')).toBe('3. three');
    expect(render('- [x] done\n- [ ] todo')).toBe('- [x] done\n- [ ] todo');
  });

  it('styles the other node kinds the shared parser produces', () => {
    // Outside R26's list, but inside no dialect: the parser already marks
    // them, so the terminal does not print the source back at the member.
    expect(render('~~gone~~')).toBe('gone');
    expect(emittedCodes(render('~~gone~~', { color: true }))).toEqual(
      new Set([ANSI_STYLE_CODES.strike]),
    );
    expect(emittedCodes(render('__under__', { color: true }))).toEqual(
      new Set([ANSI_STYLE_CODES.underline]),
    );
    expect(emittedCodes(render('***both***', { color: true }))).toEqual(
      new Set([ANSI_STYLE_CODES.bold, ANSI_STYLE_CODES.italic]),
    );
    expect(render('\\*escaped\\*')).toBe('*escaped*');
  });

  it('renders a mention as the shared display form', () => {
    expect(
      renderMarkdown(`hi <@${ALICE}>`, { width: WIDE, color: false, resolveMention: resolveAlice }),
    ).toBe('hi @alice');
    // No resolver: the shared fallback shape, not the raw wire token.
    expect(render(`hi <@${ALICE}>`)).toBe(`hi @${ALICE}`);
  });

  it('renders an empty body as nothing at all', () => {
    expect(render('')).toBe('');
    expect(renderMarkdownLines('', { width: 40, color: false })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R26 — wrapping
// ---------------------------------------------------------------------------

describe('wrapping to the caller\'s width', () => {
  it('wraps prose to the width and loses nothing but the break spaces', () => {
    const body = 'the quick brown fox jumps over the lazy dog';
    const lines = renderMarkdownLines(body, { width: 10, color: false });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(displayWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join(' ')).toBe(body);
  });

  it('wraps a word wider than the column instead of overflowing it', () => {
    const lines = renderMarkdownLines('x'.repeat(25), { width: 10, color: false });
    expect(lines).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
  });

  it('never splits a surrogate pair', () => {
    const lines = renderMarkdownLines('\u{1F642}'.repeat(5), { width: 3, color: false });
    for (const line of lines) {
      expect(line).not.toMatch(/[\uD800-\uDBFF]$/);
      expect(line).not.toMatch(/^[\uDC00-\uDFFF]/);
    }
    expect(lines.join('')).toBe('\u{1F642}'.repeat(5));
  });

  it('never splits a combining sequence', () => {
    const lines = renderMarkdownLines('e\u0301'.repeat(6), { width: 3, color: false });
    for (const line of lines) {
      expect(line.startsWith('\u0301')).toBe(false);
      expect(line.match(/e/g)?.length).toBe(3);
    }
  });

  it('never splits a ZWJ emoji cluster', () => {
    const family = '\u{1F469}\u200d\u{1F469}\u200d\u{1F467}\u200d\u{1F466}';
    const lines = renderMarkdownLines(family.repeat(4), { width: 4, color: false });
    for (const line of lines) {
      expect(displayWidth(line)).toBe(4); // two two-cell clusters per line
      // Whole families only: a split would leave a partial sequence behind.
      expect(line.length % family.length).toBe(0);
    }
    expect(lines.join('')).toBe(family.repeat(4));
  });

  it('counts a wide glyph as two cells', () => {
    expect(displayWidth('\u4f60\u597d')).toBe(4);
    expect(renderMarkdownLines('\u4f60\u597d\u4e16\u754c', { width: 6, color: false })).toEqual([
      '\u4f60\u597d\u4e16',
      '\u754c',
    ]);
  });

  it('keeps a code block inside the column and preserves its indentation', () => {
    const out = render('```\n    indented and quite long indeed\n```', { width: 14 });
    for (const line of out.split('\n')) expect(displayWidth(line)).toBeLessThanOrEqual(14);
    expect(out.startsWith('      indented')).toBe(true);
  });

  it('defaults to a stated width when the caller gives none', () => {
    const lines = renderMarkdownLines('x'.repeat(DEFAULT_WIDTH + 5), { color: false });
    expect(lines).toEqual(['x'.repeat(DEFAULT_WIDTH), 'xxxxx']);
  });

  it('treats a non-finite or absurd width as usable rather than crashing', () => {
    expect(renderMarkdownLines('ab', { width: 0, color: false })).toEqual(['a', 'b']);
    expect(renderMarkdownLines('ab', { width: Number.NaN, color: false })).toEqual(['ab']);
  });
});

// ---------------------------------------------------------------------------
// R26 — degradation of everything outside the subset
// ---------------------------------------------------------------------------

describe('degradation', () => {
  it('shows a link\'s URL only when it differs from its text', () => {
    expect(render('[docs](https://example.dev/guide)')).toBe('docs (https://example.dev/guide)');
    expect(render('<https://example.dev/guide>')).toBe('https://example.dev/guide');
    expect(render('see https://example.dev/guide.')).toBe('see https://example.dev/guide.');
  });

  it('degrades an image to its alt text plus its URL, or the URL alone when it has no alt', () => {
    const withAlt = render('![a diagram](https://example.dev/d.png)');
    expect(withAlt).toBe('a diagram (https://example.dev/d.png)');
    expect(withAlt).not.toContain('![');
    expect(render('![](https://example.dev/d.png)')).toBe('https://example.dev/d.png');
    expect(render('see ![chart](https://example.dev/c.png "Q3") now')).toBe('see chart (https://example.dev/c.png) now');
    // A non-http source is no image to the shared parser: its alt, as before.
    expect(render('![local](d.png)')).toBe('local (d.png)');
  });

  it('prints a timestamp tag as its moment — a countdown too, since a printed line never ticks', () => {
    const out = render('answer <t:1791328800:R> or it will NOT run');
    expect(out).not.toContain('<t:');
    expect(out).not.toMatch(/\bin \d+ minutes?\b/);
    expect(out).toContain('2026');
  });

  it('degrades a table to its cell text, without the alignment row', () => {
    const out = render('| name | value |\n| --- | --- |\n| one | two |');
    expect(out).toBe('name | value\none | two');
    expect(out).not.toContain('---');
    expect(out.startsWith('|')).toBe(false);
  });

  it('degrades a table whose cells carry markup through the shared parse', () => {
    const out = render('| name | value |\n| --- | --- |\n| **one** | `two` |', { color: true });
    expect(stripAnsi(out)).toBe('name | value\none | two');
    expect(emittedCodes(out)).toEqual(new Set([ANSI_STYLE_CODES.bold, ANSI_STYLE_CODES.code]));
  });

  it('leaves prose that merely contains a pipe alone', () => {
    expect(render('either | or')).toBe('either | or');
  });

  it('renders a footnote inline rather than dropping it', () => {
    const out = render('See the note[^1].\n\n[^1]: the note text');
    expect(out).toContain('the note text');
    expect(out).toContain('See the note[1].');
    expect(out).toContain('[1] the note text');
    expect(out).not.toContain('[^');
  });

  it('renders unterminated emphasis as plain text', () => {
    const out = render('*unclosed', { color: true });
    expect(stripAnsi(out)).toBe('*unclosed');
    expect(out).not.toContain(`${ESC}[3m`);
  });

  it('renders an unclosed fence as plain literal text', () => {
    const out = render('```\n**still literal** and <@700000000000000001>');
    expect(stripAnsi(out)).toBe('  **still literal** and <@700000000000000001>');
    expect(out).not.toContain('```');
  });
});

// ---------------------------------------------------------------------------
// R26a — inertness through the renderer
// ---------------------------------------------------------------------------

describe('inert terminal output (R26a)', () => {
  /** The only sequences this renderer may ever emit. */
  const allowed = new Set([
    `${ESC}[0m`,
    ...Object.values(ANSI_STYLE_CODES).map((code) => `${ESC}[${code}m`),
  ]);

  const sequencesIn = (value: string): string[] =>
    value.match(/\u001b(\[[0-9;]*[A-Za-z]|\][^\u0007]*\u0007|.)/g) ?? [];

  it('renders a body containing escape sequences inertly', () => {
    const body = 'eve\u001b[2J\u001b]52;c;cHduZWQ=\u0007 sent\u0007 a message\u0000';
    const plain = render(body, { color: true });
    expect(stripAnsi(plain)).toBe('eve sent a message');
    for (const sequence of sequencesIn(plain)) expect(allowed.has(sequence)).toBe(true);
    expect(plain).not.toContain(`${ESC}[2J`);
    expect(plain).not.toContain(']52');
    // Nothing that moves the cursor, clears the screen, or sets a mode.
    expect(plain).not.toMatch(/\u001b\[[0-9;]*[JHKABCDSTfhlm]/);
    // Colour off: not one escape reaches the terminal, whatever the body held.
    expect(render(body)).not.toContain(ESC);
  });

  it('renders a hostile display name inertly in the author path', () => {
    const name = 'eve\u001b[2J\u001b]52;c;cHduZWQ=\u0007\t\u202ebad';
    const out = renderMarkdown(`hi <@${ALICE}>`, {
      width: WIDE,
      color: true,
      resolveMention: () => name,
    });
    expect(out).toContain('@eve');
    expect(out).toContain('bad');
    expect(sequencesIn(out).every((sequence) => allowed.has(sequence))).toBe(true);
    expect(out).not.toContain(`${ESC}[2J`);
    expect(out).not.toContain(']52');
    // A name carrying a newline cannot forge a second line of client chrome.
    const multiline = renderMarkdown(`hi <@${ALICE}>`, {
      width: WIDE,
      color: false,
      resolveMention: () => 'eve\n  cytale $ ',
    });
    expect(multiline.split('\n')).toHaveLength(1);
    expect(multiline).toContain('@eve');
    expect(multiline).toContain('cytale $');
  });

  it('renders unadorned text when colour is off', () => {
    const body = '**bold** *italic* `code`\n\n> quote\n\n- item\n\n| a | b |\n| --- | --- |\n| c | d |';
    const out = render(body);
    expect(out).not.toContain(ESC);
    expect(out).toBe('bold italic code\n\n> quote\n\n- item\n\na | b\nc | d');
  });

  it('turns colour off by itself when the stream is not a TTY or NO_COLOR is set', () => {
    const stdout = process.stdout as { isTTY?: boolean };
    const descriptor = Object.getOwnPropertyDescriptor(stdout, 'isTTY');
    const noColor = process.env.NO_COLOR;
    const term = process.env.TERM;
    try {
      delete process.env.NO_COLOR;
      process.env.TERM = 'xterm-256color';
      Object.defineProperty(stdout, 'isTTY', { value: true, configurable: true });
      expect(renderMarkdown('**hi**', { width: WIDE })).toContain(`${ESC}[1m`);

      process.env.NO_COLOR = '1';
      expect(renderMarkdown('**hi**', { width: WIDE })).toBe('hi');

      delete process.env.NO_COLOR;
      Object.defineProperty(stdout, 'isTTY', { value: false, configurable: true });
      expect(renderMarkdown('**hi**', { width: WIDE })).toBe('hi');
    } finally {
      if (descriptor === undefined) delete stdout.isTTY;
      else Object.defineProperty(stdout, 'isTTY', descriptor);
      if (noColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = noColor;
      if (term === undefined) delete process.env.TERM;
      else process.env.TERM = term;
    }
  });
});

// ---------------------------------------------------------------------------
// Integration — one dialect, one tree
// ---------------------------------------------------------------------------

describe('the terminal renders the shared parse tree', () => {
  const CORPUS = [
    'plain text',
    '*emphasis* and **strong**',
    '***both*** with `code` and __under__ and ~~struck~~',
    'a [label](https://example.dev/path) here',
    'an auto link https://example.dev/path and a sentence end.',
    'a bare mention <@700000000000000001>',
    'escaped \\*stars\\* and a literal *unclosed',
    'mixed **bold `code` bold** tail',
    '~~**struck bold**~~ and __*underlined italic*__',
    'https://example.dev**bold after a URL**',
  ];

  it('combines nested emphasis into one run carrying every attribute', () => {
    const out = render('~~**x**~~ ***y*** __*~~**z**~~*__', { color: true });
    expect(out).toContain('\u001b[1m\u001b[9mx');
    expect(out).toContain('\u001b[1m\u001b[3my');
    expect(out).toContain('\u001b[1m\u001b[3m\u001b[4m\u001b[9mz');
    expect(stripAnsi(out)).toBe('x y z');
  });

  /** The parse tree's text, as the shared nodes define it. */
  function parseText(body: string): string {
    const textOf = (nodes: readonly InlineNode[]): string =>
      nodes
        .map((node) => {
          if (isEmphasisNode(node)) return textOf(node.children);
          if (node.type === 'link') {
            return node.href === node.text ? node.text : `${node.text} (${node.href})`;
          }
          if (node.type === 'mention') return `@${node.userId}`;
          if (node.type === 'channel') return `#${node.channelId}`;
          if (node.type === 'image') return node.alt !== '' ? `${node.alt} (${node.src})` : node.src;
          if (node.type === 'timestamp') return timestampPlainText(node);
          return node.text;
        })
        .join('');
    return textOf(parseInlineMarkdown(body));
  }

  /** The attributes each node kind requires, straight from the spec map. */
  function parseCodes(body: string): Set<number> {
    const codes = new Set<number>();
    const walk = (nodes: readonly InlineNode[]): void => {
      for (const node of nodes) {
        if (node.type === 'link') {
          if (node.href !== node.text) codes.add(ANSI_STYLE_CODES.dim);
          continue;
        }
        for (const atom of EXPECTED_ATOMS[node.type]) codes.add(ANSI_STYLE_CODES[atom]);
        if (isEmphasisNode(node)) walk(node.children);
      }
    };
    walk(parseInlineMarkdown(body));
    return codes;
  }

  it('prints exactly the text the shared parser produced', () => {
    for (const body of CORPUS) {
      expect(stripAnsi(render(body, { color: true })), body).toBe(parseText(body));
    }
  });

  it('styles exactly the node kinds the shared parser marked', () => {
    for (const body of CORPUS) {
      expect(emittedCodes(render(body, { color: true })), body).toEqual(parseCodes(body));
    }
  });

  it('covers every block the shared parser produced, one by one', () => {
    const body = [
      '# Title',
      '',
      '> quoted **text**',
      '',
      '```js',
      'const x = 1;',
      '```',
      '',
      '- one',
      '- [x] two',
      '',
      'plain **body**',
    ].join('\n');
    const blocks = parseMarkdownBlocks(body);
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'blockquote',
      'code-block',
      'list',
      'inline',
    ]);

    const out = render(body);
    expect(out).toBe(
      [
        'Title',
        '',
        '> quoted text',
        '',
        '  const x = 1;',
        '',
        '- one',
        '- [x] two',
        '',
        'plain body',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Error path
// ---------------------------------------------------------------------------

describe('a parse failure', () => {
  it('falls back to the raw body rather than rendering nothing', async () => {
    vi.resetModules();
    vi.doMock('@cytale/markdown', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@cytale/markdown')>();
      return {
        ...actual,
        parseMarkdownBlocks: (): never => {
          throw new Error('parser unavailable');
        },
      };
    });
    try {
      const mod = await import('../format/markdown.js');
      expect(mod.renderMarkdown('hello **world**', { width: 40, color: false })).toBe(
        'hello **world**',
      );
      // Still wrapped, still inert, and still not nothing.
      expect(mod.renderMarkdown('eve\u001b[2Jhere', { width: 40, color: true })).toBe('evehere');
    } finally {
      vi.doUnmock('@cytale/markdown');
      vi.resetModules();
    }
  });
});
