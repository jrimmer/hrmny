/**
 * Nested emphasis (Discord parity): `~~**x**~~` is bold inside strikethrough,
 * `***x***` bold inside italic, and all four kinds combine. Unclosed markers
 * stay literal, and inline code and links stay opaque inside a span.
 */
import { describe, expect, it } from 'vitest';

import { isEmphasisNode, parseInlineMarkdown, previewText, tokenizeInline, type InlineNode } from '../parse.js';

/** A compact reading of a parse: `b(…)`, `i(…)`, `u(…)`, `s(…)`, `code(…)`, `link(…)`. */
function shape(nodes: readonly InlineNode[]): string {
  return nodes
    .map((n) => {
      if (isEmphasisNode(n)) return `${n.type[0]}(${shape(n.children)})`;
      switch (n.type) {
        case 'text':
          return JSON.stringify(n.text);
        case 'code':
          return `code(${JSON.stringify(n.text)})`;
        case 'link':
          return `link(${JSON.stringify(n.text)}→${n.href})`;
        case 'mention':
          return `@${n.userId}`;
        case 'channel':
          return `#${n.channelId}`;
      }
    })
    .join(' ');
}

const read = (md: string) => shape(parseInlineMarkdown(md));

describe('nested emphasis', () => {
  it.each([
    ['~~**x**~~', 's(b("x"))'],
    ['**~~x~~**', 'b(s("x"))'],
    ['***x***', 'i(b("x"))'],
    ['__**x**__', 'u(b("x"))'],
    ['__*~~**all**~~*__', 'u(i(s(b("all"))))'],
    ['**bold *and italic* bold**', 'b("bold " i("and italic") " bold")'],
    ['*italic **and bold** italic*', 'i("italic " b("and bold") " italic")'],
    ['***a** b*', 'i(b("a") " b")'],
    ['**a *b***', 'b("a " i("b"))'],
    ['~~a __b__ c~~', 's("a " u("b") " c")'],
    ['**x** and ~~y~~', 'b("x") " and " s("y")'],
  ])('%s → %s', (md, expected) => {
    expect(read(md)).toBe(expected);
  });

  it('the span text is its content without markup', () => {
    const [node] = parseInlineMarkdown('~~**x** y~~');
    expect(node).toMatchObject({ type: 'strike', text: 'x y' });
  });

  it('a mention, code span and link ride inside a span, and stay opaque', () => {
    expect(read('**hi <@42> `a**b` [l*](https://x.dev)**')).toBe('b("hi " @42 " " code("a**b") " " link("l*"→https://x.dev))');
  });

  it('an escaped delimiter inside a span is the character and never closes it', () => {
    expect(read('**a \\** b**')).toBe('b("a " "*" "* b")');
    expect(read('*a\\*b*')).toBe('i("a" "*" "b")');
    expect(read('~~a\\~\\~b~~')).toBe('s("a" "~" "~" "b")');
  });

  it('a strike may hold a single tilde (Discord reads `~~a~b~~` as one strike)', () => {
    expect(read('~~a~b~~')).toBe('s("a~b")');
  });
});

describe('unclosed and stray markers stay literal', () => {
  it.each([
    ['2 * 3 * 4', '"2 * 3 * 4"'],
    ['**open', '"**open"'],
    ['~~open', '"~~open"'],
    ['__open', '"__open"'],
    ['a ** b', '"a ** b"'],
    ['* a *', '"* a *"'],
    ['*a *', '"*a *"'],
    ['**a *b**', 'b("a *b")'],
    ['snake__case__word', '"snake__case__word"'],
    ['~~~x~~~', 's("~x~")'],
  ])('%s → %s', (md, expected) => {
    expect(read(md)).toBe(expected);
  });

  it('nothing is lost: the text of any parse is every character typed, minus markup', () => {
    expect(previewText('~~**a**~~ *b* c**')).toBe('a b c**');
  });

  it('a pathological run of openers parses in bounded time', () => {
    const body = '*a '.repeat(2000) + '**'.repeat(500);
    const start = Date.now();
    parseInlineMarkdown(body);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it('tokenizeInline splits at the top level only', () => {
    expect(tokenizeInline('a ~~**x**~~ b')).toEqual(['a ', '~~**x**~~', ' b']);
  });
});

describe('bare URLs end where GitHub ends them', () => {
  it.each([
    ['https://x.dev**b**', 'link("https://x.dev"→https://x.dev) b("b")'],
    ['https://x.dev~~s~~', 'link("https://x.dev"→https://x.dev) s("s")'],
    ['https://x.dev`c`', 'link("https://x.dev"→https://x.dev) code("c")'],
    ['https://x.dev*i*', 'link("https://x.dev"→https://x.dev) i("i")'],
    ['**https://x.dev**', 'b(link("https://x.dev"→https://x.dev))'],
    ['see https://x.dev/a_b_c', '"see " link("https://x.dev/a_b_c"→https://x.dev/a_b_c)'],
    ['(see https://x.dev/a)', '"(see " link("https://x.dev/a"→https://x.dev/a) ")"'],
    ['"https://x.dev"', '"\\"" link("https://x.dev"→https://x.dev) "\\""'],
    ["'https://x.dev'.", '"\'" link("https://x.dev"→https://x.dev) "\'."'],
    ['https://x.dev/a,b end', 'link("https://x.dev/a,b"→https://x.dev/a,b) " end"'],
    ['https://x.dev\\*not italic*', 'link("https://x.dev"→https://x.dev) "*" "not italic*"'],
    ['https://x.dev/a\\b', 'link("https://x.dev/a\\\\b"→https://x.dev/a\\b)'],
    ['__https://x.dev__', 'u(link("https://x.dev"→https://x.dev))'],
    ['__https://x.dev__>>> next', 'u(link("https://x.dev"→https://x.dev)) ">>> next"'],
    ['__https://x.dev/a__b__', 'u(link("https://x.dev/a__b"→https://x.dev/a__b))'],
    ['__[a](https://x.dev)__', 'u(link("a"→https://x.dev))'],
    ['__\\[a](https://x.dev)__', 'u("[" "a](" link("https://x.dev"→https://x.dev) ")")'],
    ['https://x.dev/wiki/X_(y).', 'link("https://x.dev/wiki/X_(y)"→https://x.dev/wiki/X_(y)) "."'],
  ])('%s → %s', (md, expected) => {
    expect(read(md)).toBe(expected);
  });
});
