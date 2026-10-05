/**
 * `![alt](url)` — the inline image node (media proxy plan). An image is a
 * node only with an http(s) source; everything else keeps the pre-image
 * parse (a literal `!` and a link), so no existing message changes meaning.
 */
import { describe, expect, it } from 'vitest';

import { imagePlainText, parseInlineMarkdown, parseMarkdownBlocks, previewText, tokenizeInline } from '../index.js';

const SRC = 'https://img.example/cat.png';

describe('image nodes', () => {
  it('parses alt, src and the exact source', () => {
    expect(parseInlineMarkdown(`a ![a cat](${SRC}) b`)).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'image', alt: 'a cat', src: SRC, title: null, source: `![a cat](${SRC})` },
      { type: 'text', text: ' b' },
    ]);
  });

  it('keeps an empty alt, and carries a CommonMark "title"', () => {
    expect(parseInlineMarkdown(`![](${SRC})`)).toEqual([
      { type: 'image', alt: '', src: SRC, title: null, source: `![](${SRC})` },
    ]);
    expect(parseInlineMarkdown(`![x](${SRC} "The cat")`)).toEqual([
      { type: 'image', alt: 'x', src: SRC, title: 'The cat', source: `![x](${SRC} "The cat")` },
    ]);
  });

  it('resolves escapes in the alt text, and an escaped `!` is no image', () => {
    expect(parseInlineMarkdown(`![a \\*star\\*](${SRC})`)[0]).toMatchObject({ type: 'image', alt: 'a *star*' });
    expect(parseInlineMarkdown(`\\![x](${SRC})`)).toEqual([
      { type: 'text', text: '!' },
      { type: 'link', text: 'x', href: SRC },
    ]);
  });

  it('is http(s) only: any other source is the old literal `!` plus a link', () => {
    for (const src of ['cat.png', 'javascript:alert(1)', 'data:image/png;base64,AA', 'ftp://x.example/a.png']) {
      const nodes = parseInlineMarkdown(`![x](${src})`);
      expect(nodes.some((n) => n.type === 'image'), src).toBe(false);
      expect(nodes[0]).toEqual({ type: 'text', text: '!' });
    }
  });

  it('is opaque: markup inside the alt is not parsed, and emphasis steps over it', () => {
    expect(parseInlineMarkdown(`![**b**](${SRC})`)[0]).toMatchObject({ type: 'image', alt: '**b**' });
    const [bold] = parseInlineMarkdown(`**see ![a*b](${SRC})**`);
    expect(bold).toMatchObject({ type: 'bold' });
    expect(bold && 'children' in bold ? bold.children[1] : null).toMatchObject({ type: 'image', alt: 'a*b' });
  });

  it('stays literal inside code, and is one token to the tokenizer', () => {
    expect(parseInlineMarkdown(`\`![x](${SRC})\``)).toEqual([{ type: 'code', text: `![x](${SRC})` }]);
    expect(tokenizeInline(`hi ![x](${SRC})!`)).toEqual(['hi ', `![x](${SRC})`, '!']);
  });

  it('does not span lines, and needs a closed target', () => {
    expect(parseInlineMarkdown(`![a\nb](${SRC})`).some((n) => n.type === 'image')).toBe(false);
    expect(parseInlineMarkdown(`![x](${SRC}`).some((n) => n.type === 'image')).toBe(false);
  });

  it('lives inside blocks like any inline node', () => {
    const [quote, list] = parseMarkdownBlocks(`> ![q](${SRC})\n- ![l](${SRC})`);
    expect(quote).toMatchObject({ type: 'blockquote', nodes: [{ type: 'image', alt: 'q' }] });
    expect(list).toMatchObject({ type: 'list', items: [{ nodes: [{ type: 'image', alt: 'l' }] }] });
  });

  it('previews as its alt text, or [image] — never the URL', () => {
    expect(previewText(`look ![a whiteboard](${SRC}) now`)).toBe('look a whiteboard now');
    expect(previewText(`![](${SRC})`)).toBe('[image]');
    expect(imagePlainText({ type: 'image', alt: '  ', src: SRC, title: null, source: '' })).toBe('[image]');
  });
});
