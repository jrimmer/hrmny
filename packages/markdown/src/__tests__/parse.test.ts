/**
 * Parser contract tests (plan 004 M6).
 *
 * These pin the token stream the web renderer has always produced: the
 * strongest-token-first split, the anchored classifier precedence, and the
 * "everything else is text" fallback. They are the spec the two renderers
 * (web DOM, native Text runs) must both satisfy; the cross-client assertion
 * lives in the mobile `markdown.parity` test, which runs the web renderer
 * over the same corpus.
 */
import { describe, expect, it } from 'vitest';

import {
  channelDisplayName,
  classifyInlineToken,
  mentionDisplayName,
  parseInlineMarkdown,
  parseMarkdownBlocks,
  resolveMentionTokens,
  tokenizeInline,
} from '../parse.js';

/** A leaf emphasis span (its content is one text node). */
const em = (type: 'bold' | 'italic' | 'underline' | 'strike', text: string) => ({
  type,
  text,
  children: [{ type: 'text', text }],
});

describe('tokenizeInline', () => {
  it('keeps plain text and strong tokens, preserving order and delimiters', () => {
    expect(tokenizeInline('hi `code` there')).toEqual(['hi ', '`code`', ' there']);
  });

  it('returns the whole string as one segment when no token matches', () => {
    expect(tokenizeInline('plain text')).toEqual(['plain text']);
  });

  it('returns nothing for the empty string', () => {
    expect(tokenizeInline('')).toEqual([]);
  });

  it('does not leak regex lastIndex across calls', () => {
    const text = 'a `b` c';
    expect(tokenizeInline(text)).toEqual(tokenizeInline(text));
    expect(tokenizeInline('`b`')).toEqual(['`b`']);
  });
});

describe('classifyInlineToken', () => {
  it('classifies each supported token', () => {
    expect(classifyInlineToken('<@700000000000000001>')).toEqual({
      type: 'mention',
      userId: '700000000000000001',
    });
    expect(classifyInlineToken('`code`')).toEqual({ type: 'code', text: 'code' });
    expect(classifyInlineToken('[label](https://example.com)')).toEqual({
      type: 'link',
      text: 'label',
      href: 'https://example.com',
    });
    expect(classifyInlineToken('**bold**')).toEqual(em('bold', 'bold'));
    expect(classifyInlineToken('*italic*')).toEqual(em('italic', 'italic'));
    expect(classifyInlineToken('plain')).toEqual({ type: 'text', text: 'plain' });
  });

  it('bounds mentions to 1-19 digits (snowflake convention)', () => {
    expect(classifyInlineToken('<@1>').type).toBe('mention');
    expect(classifyInlineToken(`<@${'9'.repeat(19)}>`).type).toBe('mention');
    // 20 digits is not a snowflake — the token stays literal text.
    expect(classifyInlineToken(`<@${'9'.repeat(20)}>`)).toEqual({
      type: 'text',
      text: `<@${'9'.repeat(20)}>`,
    });
  });

  it('rejects non-numeric and whitespace-padded mentions', () => {
    expect(classifyInlineToken('<@alice>').type).toBe('text');
    expect(classifyInlineToken('<@ 123 >').type).toBe('text');
  });

  it('rejects empty code spans, empty link labels, and urls with spaces', () => {
    expect(classifyInlineToken('``').type).toBe('text');
    expect(classifyInlineToken('[](https://example.com)').type).toBe('text');
    expect(classifyInlineToken('[label](https://example.com/a b)').type).toBe('text');
  });
});

describe('parseInlineMarkdown', () => {
  it('parses the web markdown fixture into one node per token', () => {
    const nodes = parseInlineMarkdown('**bold** *italic* `code` [link](https://example.com)');
    expect(nodes).toEqual([
      em('bold', 'bold'),
      { type: 'text', text: ' ' },
      em('italic', 'italic'),
      { type: 'text', text: ' ' },
      { type: 'code', text: 'code' },
      { type: 'text', text: ' ' },
      { type: 'link', text: 'link', href: 'https://example.com' },
    ]);
  });

  it('resolves bold before italic (the `**` token wins the alternation)', () => {
    expect(parseInlineMarkdown('**both**')).toEqual([em('bold', 'both')]);
  });

  it('bold survives a single inner asterisk (reverses the old quirk)', () => {
    // The scanner's bold group was `[^*]+`, so `**a *b**` failed at index 0
    // and italics won from index 1 (stray `*` + `b**`). It now allows single
    // inner asterisks, so the span holds — the fix for Hermes' row 21. Both
    // clients share this parser, so the parity corpus moves with it.
    expect(parseInlineMarkdown('**a *b**')).toEqual([em('bold', 'a *b')]);
  });

  it('preserves newlines as text nodes', () => {
    expect(parseInlineMarkdown('one\ntwo')).toEqual([{ type: 'text', text: 'one\ntwo' }]);
  });

  it('parses a mention next to text', () => {
    expect(parseInlineMarkdown('ping <@700000000000000001>!')).toEqual([
      { type: 'text', text: 'ping ' },
      { type: 'mention', userId: '700000000000000001' },
      { type: 'text', text: '!' },
    ]);
  });

  it('parses emoji shortcodes as literal text — the web read path has no shortcode token', () => {
    // The composer converts a CLOSED :shortcode: before send (web
    // MessageCompose); a raw one in a body renders literally on both clients.
    expect(parseInlineMarkdown('hello :thumbs_up:')).toEqual([
      { type: 'text', text: 'hello :thumbs_up:' },
    ]);
  });

  it('returns the untrusted payload verbatim (escaping is the renderer’s job)', () => {
    expect(parseInlineMarkdown('<script>alert(1)</script>')).toEqual([
      { type: 'text', text: '<script>alert(1)</script>' },
    ]);
    expect(parseInlineMarkdown('a & b')).toEqual([{ type: 'text', text: 'a & b' }]);
  });

  it('handles the empty body', () => {
    expect(parseInlineMarkdown('')).toEqual([]);
  });
});

describe('mentionDisplayName', () => {
  it('uses the resolver when it knows the user and the raw id otherwise', () => {
    expect(mentionDisplayName('42', (id) => (id === '42' ? 'alice' : undefined))).toBe('@alice');
    expect(mentionDisplayName('42')).toBe('@42');
    expect(mentionDisplayName('42', () => undefined)).toBe('@42');
  });
});

// ---------------------------------------------------------------------------
// Block level — fenced code blocks
// ---------------------------------------------------------------------------

describe('parseMarkdownBlocks', () => {
  const code = (text: string, lang: string | null = null) =>
    ({ type: 'code-block', text, lang }) as const;

  it('reads a fenced run as ONE code block, with no stray backticks', () => {
    // The regression: the inline scanner saw ``` as stray backticks and boxed
    // the whole run as a single multi-line `code` span (user report
    // 2026-09-11).
    const blocks = parseMarkdownBlocks(
      'Before\n```\ncurl -s "$URL"\ndate -u\n```\nAfter',
    );
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toEqual({
      type: 'inline',
      nodes: [{ type: 'text', text: 'Before' }],
    });
    expect(blocks[1]).toEqual(code('curl -s "$URL"\ndate -u'));
    expect(blocks[2]).toEqual({
      type: 'inline',
      nodes: [{ type: 'text', text: 'After' }],
    });
  });

  it('keeps the language hint and never inline-parses the body', () => {
    const blocks = parseMarkdownBlocks('```python\n**not bold** <@42>\n```');
    expect(blocks).toEqual([code('**not bold** <@42>', 'python')]);
  });

  it('an UNCLOSED fence runs to the end of the message (it is still code)', () => {
    // Treating an unclosed fence as inline is what leaked the rest of the
    // message into the code span.
    const blocks = parseMarkdownBlocks('```\nline one\nline two');
    expect(blocks).toEqual([code('line one\nline two')]);
  });

  it('accepts tildes and longer fences', () => {
    expect(parseMarkdownBlocks('~~~\ntilde\n~~~')).toEqual([code('tilde')]);
    expect(parseMarkdownBlocks('````\ninner ```\n````')).toEqual([code('inner ```')]);
  });

  it('a shorter or different closing fence does not close the block', () => {
    expect(parseMarkdownBlocks('```\na\n``\nb\n```')).toEqual([code('a\n``\nb')]);
    expect(parseMarkdownBlocks('```\na\n~~~\nb\n```')).toEqual([code('a\n~~~\nb')]);
  });

  it('leaves inline code (single backticks) to the inline parser', () => {
    expect(parseMarkdownBlocks('use `pnpm test` here')).toEqual([
      {
        type: 'inline',
        nodes: [
          { type: 'text', text: 'use ' },
          { type: 'code', text: 'pnpm test' },
          { type: 'text', text: ' here' },
        ],
      },
    ]);
  });

  it('an inline code span opening a line is not a fence', () => {
    // A backtick fence's info string may not contain a backtick (CommonMark),
    // so `x` at the start of a line stays inline code.
    const blocks = parseMarkdownBlocks('```x```');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe('inline');
  });

  it('handles the empty body and text-only bodies', () => {
    expect(parseMarkdownBlocks('')).toEqual([]);
    expect(parseMarkdownBlocks('just words')).toEqual([
      { type: 'inline', nodes: [{ type: 'text', text: 'just words' }] },
    ]);
  });
});

describe('resolveMentionTokens', () => {
  // The reply-context snippet is plain text: it showed the raw wire token
  // because only the message BODY had a resolver (user report 2026-09-11).
  const resolve = (id: string) => (id === '42' ? 'max' : undefined);

  it('rewrites mention tokens to @name and leaves everything else verbatim', () => {
    expect(resolveMentionTokens('hi <@42> there', resolve)).toBe('hi @max there');
    // Unresolvable → the same @id shape the body's pill falls back to.
    expect(resolveMentionTokens('hi <@99> there', resolve)).toBe('hi @99 there');
    expect(resolveMentionTokens('hi <@42>', undefined)).toBe('hi @42');
  });

  it('handles several mentions and leaves inline markup alone', () => {
    expect(resolveMentionTokens('<@42> and <@42> and **bold**', resolve)).toBe(
      '@max and @max and **bold**',
    );
  });

  it('leaves text without tokens untouched, and accepts the empty body', () => {
    expect(resolveMentionTokens('no mentions here', resolve)).toBe('no mentions here');
    expect(resolveMentionTokens('', resolve)).toBe('');
    // A bare @name is not a token — nothing to rewrite.
    expect(resolveMentionTokens('@max already', resolve)).toBe('@max already');
  });
});

// ---------------------------------------------------------------------------
// Block level — ATX headings
// ---------------------------------------------------------------------------

describe('parseMarkdownBlocks — headings', () => {
  const heading = (level: number, text: string) =>
    ({ type: 'heading', level, nodes: [{ type: 'text', text }] }) as const;

  it('parses # through ###### as headings with their level', () => {
    // Reported as "headers #, ##, ### etc. aren't being rendered" — they used
    // to fall through as plain text.
    expect(parseMarkdownBlocks('# One')).toEqual([heading(1, 'One')]);
    expect(parseMarkdownBlocks('## Two')).toEqual([heading(2, 'Two')]);
    expect(parseMarkdownBlocks('### Three')).toEqual([heading(3, 'Three')]);
    expect(parseMarkdownBlocks('###### Six')).toEqual([heading(6, 'Six')]);
  });

  it('keeps inline markdown inside a heading', () => {
    const [block] = parseMarkdownBlocks('## Hello **world** <@42>');
    expect(block).toEqual({
      type: 'heading',
      level: 2,
      nodes: [
        { type: 'text', text: 'Hello ' },
        em('bold', 'world'),
        { type: 'text', text: ' ' },
        { type: 'mention', userId: '42' },
      ],
    });
  });

  it('requires a space, and at most six hashes — #1 and ####### are text', () => {
    expect(parseMarkdownBlocks('#1 priority')).toEqual([
      { type: 'inline', nodes: [{ type: 'text', text: '#1 priority' }] },
    ]);
    expect(parseMarkdownBlocks('####### seven')).toEqual([
      { type: 'inline', nodes: [{ type: 'text', text: '####### seven' }] },
    ]);
  });

  it('strips a closing sequence of hashes and allows up to three leading spaces', () => {
    expect(parseMarkdownBlocks('## Title ##')).toEqual([heading(2, 'Title')]);
    expect(parseMarkdownBlocks('   # Indented')).toEqual([heading(1, 'Indented')]);
    // Four spaces is not a heading (CommonMark), and stays literal text.
    expect(parseMarkdownBlocks('    # Nope')[0]!.type).toBe('inline');
  });

  it('separates headings from the prose around them', () => {
    const blocks = parseMarkdownBlocks('intro\n# Title\nbody');
    expect(blocks.map((b) => b.type)).toEqual(['inline', 'heading', 'inline']);
    expect(blocks[0]).toEqual({ type: 'inline', nodes: [{ type: 'text', text: 'intro' }] });
    expect(blocks[1]).toEqual(heading(1, 'Title'));
    expect(blocks[2]).toEqual({ type: 'inline', nodes: [{ type: 'text', text: 'body' }] });
  });

  it('a hash inside a fenced block is code, not a heading', () => {
    expect(parseMarkdownBlocks('```\n# not a heading\n```')).toEqual([
      { type: 'code-block', text: '# not a heading', lang: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Inline: the Discord-parity family (bold italic, underline, strike, escapes)
// ---------------------------------------------------------------------------

describe('parseInlineMarkdown — decorations and escapes', () => {
  it('parses ***bold italic***, __underline__ and ~~strike~~', () => {
    expect(parseInlineMarkdown('***both***')).toEqual([{ type: 'italic', text: 'both', children: [em('bold', 'both')] }]);
    expect(parseInlineMarkdown('__under__')).toEqual([em('underline', 'under')]);
    expect(parseInlineMarkdown('~~gone~~')).toEqual([em('strike', 'gone')]);
  });

  it('*** is bold inside italic (the longer match wins, a tie goes to italic — Discord\'s rule)', () => {
    expect(parseInlineMarkdown('***x***')).toEqual([{ type: 'italic', text: 'x', children: [em('bold', 'x')] }]);
    // …and __ is underline, never two italics.
    expect(parseInlineMarkdown('__x__')).toEqual([em('underline', 'x')]);
  });

  it('keeps a single inner asterisk inside bold (the old breakage)', () => {
    // Hermes' row 21: `**bold with inner *star**` used to lose the bold and
    // come out as a literal `*` + italics + `star**`.
    expect(parseInlineMarkdown('**bold with inner *star**')).toEqual([
      em('bold', 'bold with inner *star'),
    ]);
  });

  it('an escaped delimiter is the character, never the start of a span', () => {
    expect(parseInlineMarkdown('\\*\\*not bold\\*\\*')).toEqual([
      { type: 'text', text: '*' },
      { type: 'text', text: '*' },
      { type: 'text', text: 'not bold' },
      { type: 'text', text: '*' },
      { type: 'text', text: '*' },
    ]);
    expect(parseInlineMarkdown('a \\* literal')).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'text', text: '*' },
      { type: 'text', text: ' literal' },
    ]);
    // Which means the rendered text is exactly what was typed.
    expect(parseInlineMarkdown('\\*\\*not bold\\*\\*').map((n) => ('text' in n ? n.text : '')).join('')).toBe(
      '**not bold**',
    );
  });

  it('any escaped ASCII punctuation is the character (CommonMark), so a line-start marker can stay literal', () => {
    const text = (s: string) =>
      parseMarkdownBlocks(s)
        .map((b) => ('nodes' in b ? b.nodes.map((n) => ('text' in n ? n.text : '')).join('') : b.type))
        .join('|');
    expect(parseMarkdownBlocks('1\\. is the answer')).toEqual([
      { type: 'inline', nodes: [{ type: 'text', text: '1' }, { type: 'text', text: '.' }, { type: 'text', text: ' is the answer' }] },
    ]);
    expect(text('1\\) not a list')).toBe('1) not a list');
    expect(text('\\- not a bullet')).toBe('- not a bullet');
    expect(text('\\+ not a bullet')).toBe('+ not a bullet');
    expect(text('\\# not a heading')).toBe('# not a heading');
    expect(text('\\> not a quote')).toBe('> not a quote');
    // A backslash before anything else is itself.
    expect(text('C:\\Users\\me')).toBe('C:\\Users\\me');
    expect(text('a\\nb')).toBe('a\\nb');
  });

  it('does not underline inside snake_case words', () => {
    // A word-boundary guard on the underscore family (CommonMark's rule).
    expect(parseInlineMarkdown('foo_bar_baz')).toEqual([{ type: 'text', text: 'foo_bar_baz' }]);
    expect(parseInlineMarkdown('a __b__ c')).toEqual([
      { type: 'text', text: 'a ' },
      em('underline', 'b'),
      { type: 'text', text: ' c' },
    ]);
  });

  it('the new kinds ride inside a heading, a fence body stays literal', () => {
    expect(parseMarkdownBlocks('## ~~old~~ **new**')[0]).toEqual({
      type: 'heading',
      level: 2,
      nodes: [
        em('strike', 'old'),
        { type: 'text', text: ' ' },
        em('bold', 'new'),
      ],
    });
    expect(parseMarkdownBlocks('```\n~~not strike~~\n```')).toEqual([
      { type: 'code-block', text: '~~not strike~~', lang: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Block level — blockquotes and lists
// ---------------------------------------------------------------------------

describe('parseMarkdownBlocks — quotes and lists', () => {
  const item = (text: string, task: null | { checked: boolean } = null) => ({
    nodes: [{ type: 'text', text }],
    task,
  });

  it('groups > lines into ONE quote, and >>> quotes to the end', () => {
    // "15: > quote → RAW (Discord renders)" — the ledger's row.
    expect(parseMarkdownBlocks('> one\n> two')).toEqual([
      { type: 'blockquote', nodes: [{ type: 'text', text: 'one\ntwo' }] },
    ]);
    expect(parseMarkdownBlocks('>>> everything\nand this')).toEqual([
      { type: 'blockquote', nodes: [{ type: 'text', text: 'everything\nand this' }] },
    ]);
  });

  it('groups bullet and ordered runs, keeping the start number', () => {
    expect(parseMarkdownBlocks('- a\n- b')).toEqual([
      { type: 'list', ordered: false, start: 1, items: [item('a'), item('b')] },
    ]);
    expect(parseMarkdownBlocks('1. a\n2. b')).toEqual([
      { type: 'list', ordered: true, start: 1, items: [item('a'), item('b')] },
    ]);
    expect(parseMarkdownBlocks('3. third')).toEqual([
      { type: 'list', ordered: true, start: 3, items: [item('third')] },
    ]);
  });

  it('reads task markers, and starts a NEW list when the marker kind changes', () => {
    expect(parseMarkdownBlocks('- [ ] todo\n- [x] done')).toEqual([
      {
        type: 'list',
        ordered: false,
        start: 1,
        items: [item('todo', { checked: false }), item('done', { checked: true })],
      },
    ]);
    expect(parseMarkdownBlocks('- a\n1. b')).toHaveLength(2);
  });

  it('needs the space, and a fence body stays literal', () => {
    expect(parseMarkdownBlocks('-5 degrees')).toEqual([
      { type: 'inline', nodes: [{ type: 'text', text: '-5 degrees' }] },
    ]);
    expect(parseMarkdownBlocks('```\n- not a list\n> not a quote\n```')).toEqual([
      { type: 'code-block', text: '- not a list\n> not a quote', lang: null },
    ]);
  });

  it('keeps inline markdown inside items and quotes', () => {
    expect(parseMarkdownBlocks('- **bold** item')[0]).toEqual({
      type: 'list',
      ordered: false,
      start: 1,
      items: [{ nodes: [em('bold', 'bold'), { type: 'text', text: ' item' }], task: null }],
    });
  });
});

describe('parseInlineMarkdown — autolinks', () => {
  const link = (href: string) => ({ type: 'link', text: href, href });

  it('links the angle form and bare URLs', () => {
    expect(parseInlineMarkdown('<https://example.com>')).toEqual([link('https://example.com')]);
    expect(parseInlineMarkdown('go http://example.com/a?b=1 now')).toEqual([
      { type: 'text', text: 'go ' },
      link('http://example.com/a?b=1'),
      { type: 'text', text: ' now' },
    ]);
  });

  it('leaves sentence punctuation out of the link, and keeps balanced parens in', () => {
    expect(parseInlineMarkdown('go https://example.com.')).toEqual([
      { type: 'text', text: 'go ' },
      link('https://example.com'),
      { type: 'text', text: '.' },
    ]);
    expect(parseInlineMarkdown('(https://en.wikipedia.org/wiki/X_(y))')).toEqual([
      { type: 'text', text: '(' },
      link('https://en.wikipedia.org/wiki/X_(y)'),
      { type: 'text', text: ')' },
    ]);
  });

  it('ends before `*`, `~`, a backtick and a backslash escape (GitHub), so glued markup is markup', () => {
    expect(parseInlineMarkdown('https://x.dev**b**')).toEqual([link('https://x.dev'), em('bold', 'b')]);
    expect(parseInlineMarkdown('https://x.dev~~s~~')).toEqual([link('https://x.dev'), em('strike', 's')]);
    expect(parseInlineMarkdown('https://x.dev`c`')).toEqual([link('https://x.dev'), { type: 'code', text: 'c' }]);
    expect(parseInlineMarkdown('https://x.dev\\*')).toEqual([link('https://x.dev'), { type: 'text', text: '*' }]);
    // A backslash before anything else stays in the URL.
    expect(parseInlineMarkdown('https://x.dev/a\\b')).toEqual([link('https://x.dev/a\\b')]);
    // Underscores inside a URL stay in it.
    expect(parseInlineMarkdown('https://x.dev/a_b_c')).toEqual([link('https://x.dev/a_b_c')]);
  });

  it('leaves closing quotes and trailing underscores out, and keeps commas inside', () => {
    expect(parseInlineMarkdown('"https://x.dev"')).toEqual([
      { type: 'text', text: '"' },
      link('https://x.dev'),
      { type: 'text', text: '"' },
    ]);
    expect(parseInlineMarkdown("'https://x.dev'.")).toEqual([
      { type: 'text', text: "'" },
      link('https://x.dev'),
      { type: 'text', text: "'." },
    ]);
    expect(parseInlineMarkdown('https://x.dev/a_')).toEqual([link('https://x.dev/a'), { type: 'text', text: '_' }]);
    expect(parseInlineMarkdown('https://x.dev/a,b end')).toEqual([link('https://x.dev/a,b'), { type: 'text', text: ' end' }]);
    expect(parseInlineMarkdown('https://x.dev/wiki/X_(y).')).toEqual([
      link('https://x.dev/wiki/X_(y)'),
      { type: 'text', text: '.' },
    ]);
  });

  it('does not linkify inside code, and a markdown link still wins', () => {
    expect(parseInlineMarkdown('`https://example.com`')).toEqual([
      { type: 'code', text: 'https://example.com' },
    ]);
    expect(parseInlineMarkdown('[x](https://example.com)')).toEqual([
      { type: 'link', text: 'x', href: 'https://example.com' },
    ]);
  });
});

describe('channel tokens (<#id>)', () => {
  it('classifies <#id> as a channel node, bounded like mentions', () => {
    expect(classifyInlineToken('<#42>')).toEqual({ type: 'channel', channelId: '42' });
    expect(classifyInlineToken(`<#${'9'.repeat(20)}>`).type).toBe('text');
    expect(classifyInlineToken('<#general>').type).toBe('text');
  });

  it('parses a channel token inside prose', () => {
    expect(parseInlineMarkdown('see <#42> now')).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'channel', channelId: '42' },
      { type: 'text', text: ' now' },
    ]);
  });

  it('display form and plain-text rewriting', () => {
    expect(channelDisplayName('42')).toBe('#42');
    expect(channelDisplayName('42', () => 'general')).toBe('#general');
    expect(resolveMentionTokens('<@1> in <#42>', () => 'max', () => 'general')).toBe('@max in #general');
    expect(resolveMentionTokens('<#42>')).toBe('#42');
  });
});
