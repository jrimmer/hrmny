/**
 * Cross-client markdown parity (plan 004 M6: "the parse tree stays identical
 * across clients").
 *
 * This test EXECUTES the web renderer (`apps/web/src/features/messages/
 * markdown.tsx`) and the native run mapper over the same corpus and asserts
 * they are two views of one tree: same node count, same node kinds, same
 * text, same mention/link payloads. The corpus is the one the web
 * `MessageItem` tests assert (bold/italic/code/link, mentions, literal emoji
 * shortcodes) plus the parser's edge cases, so a divergence in either
 * renderer fails here rather than in the other client's suite.
 */

import { inlineRuns, type InlineMark, type InlineRun } from '../markdown';
import { renderInlineMarkdown } from '../../../../web/src/features/messages/markdown';

/**
 * The shape the web renderer returns (plain React elements). Typed locally so
 * the assertions read `props` without depending on which `@types/react` copy
 * the web app resolves.
 */
interface WebElement {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
}

function webNodes(text: string, resolve?: (id: string) => string | undefined): WebElement[] {
  return renderInlineMarkdown(text, resolve) as unknown as WebElement[];
}

const ALICE = '700000000000000001';
const resolveMention = (id: string): string | undefined => (id === ALICE ? 'alice' : undefined);

/** The web renderer's element tag per leaf run kind (its own mapping). */
const WEB_TAG: Record<InlineRun['kind'], unknown> = {
  mention: 'span',
  // `<#id>`: web renders a span (no pill injected here), mobile a styled run.
  channel: 'span',
  code: 'code',
  link: 'a',
  text: Symbol.for('react.fragment'),
};

/**
 * The web renderer's element per emphasis kind. `Record<InlineMark, …>` is
 * what catches a new kind: the map must name every one, so a new emphasis
 * fails the mobile typecheck here rather than going silently unstyled.
 */
const WEB_MARK_TAG: Record<InlineMark, string> = {
  bold: 'strong',
  italic: 'em',
  underline: 'span',
  strike: 's',
};

/** One web leaf: the element that renders it, and the emphasis around it. */
interface WebLeaf {
  element: WebElement;
  marks: InlineMark[];
}

/**
 * Flatten the web tree the way the native mapper flattens the parse: every
 * emphasis element contributes its mark to the leaves inside it.
 */
function webLeaves(elements: readonly WebElement[], marks: InlineMark[] = []): WebLeaf[] {
  return elements.flatMap((element) => {
    const mark = (Object.keys(WEB_MARK_TAG) as InlineMark[]).find(
      (m) =>
        WEB_MARK_TAG[m] === element.type &&
        (m !== 'underline' || element.props.className === 'md-underline'),
    );
    if (mark === undefined) return [{ element, marks }];
    const children = element.props.children;
    const list = (Array.isArray(children) ? children : [children]) as WebElement[];
    return webLeaves(list, marks.includes(mark) ? marks : [...marks, mark]);
  });
}

/** Undo the web renderer's HTML escaping for the text comparison. */
function unescapeHtml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Flatten an element's children (the mention pill renders `@` + name). */
function childrenText(element: WebElement): string {
  const children = element.props.children;
  if (Array.isArray(children)) return children.map((child) => String(child)).join('');
  return String(children ?? '');
}

const CORPUS: string[] = [
  '**bold** *italic* `code` [link](https://example.com)',
  'ping <@700000000000000001>!',
  'hello :thumbs_up: :rocket:',
  'no markup at all',
  'one\ntwo',
  'a & b <script>alert(1)</script>',
  '**both**',
  '**a *b**',
  '~~**struck bold**~~ ***bold italic*** __*under italic*__',
  '**bold <@700000000000000001> `code` [link](https://example.com)**',
  'https://example.com**b**',
  // An image with no proxied copy: a link on both sides (alt, else the URL).
  'see ![a whiteboard](https://img.example/wb.png) and ![](https://img.example/x.png)',
  '',
];

describe('markdown parity: web renderer vs native runs', () => {
  it.each(CORPUS.map((text) => [JSON.stringify(text), text] as const))(
    'renders the same tree for %s',
    (_label, text) => {
      const web = webLeaves(webNodes(text, resolveMention));
      const runs = inlineRuns(text, resolveMention);

      // One web leaf per native run, with the same emphasis around it — the
      // shared parse tree, flattened the same way on both sides.
      expect(web).toHaveLength(runs.length);

      runs.forEach((run, index) => {
        const { element, marks } = web[index]!;
        expect(element.type).toBe(WEB_TAG[run.kind]);
        expect(marks).toEqual(run.marks ?? []);

        if (run.kind === 'mention') {
          expect(element.props['data-user-id']).toBe(run.userId);
          expect(childrenText(element)).toBe('@alice'); // resolved name
          expect(run).toMatchObject({ kind: 'mention', text: '@alice' });
        } else if (run.kind === 'channel') {
          expect(run.text).toBe(`#${String(element.props['data-channel-id'])}`);
        } else if (run.kind === 'link') {
          expect(element.props.href).toBe(run.href);
          expect(childrenText(element)).toBe(run.text);
        } else {
          expect(unescapeHtml(childrenText(element))).toBe(run.text);
        }
      });
    },
  );

  it('resolves mentions the same way when the resolver does not know the id', () => {
    const text = 'ping <@700000000000000001>';
    const web = webNodes(text);
    const mention = web.find((element) => element.type === 'span');
    const run = inlineRuns(text).find((candidate) => candidate.kind === 'mention');

    expect(childrenText(mention!)).toBe('@700000000000000001');
    expect(run).toMatchObject({ kind: 'mention', text: '@700000000000000001' });
  });

  it('keeps a raw emoji shortcode literal on both sides (the read path never expands it)', () => {
    const text = 'ship it :thumbs_up:';
    const web = webNodes(text);
    const runs = inlineRuns(text);

    expect(web).toHaveLength(1);
    expect(childrenText(web[0]!)).toBe(text);
    expect(runs).toEqual([{ kind: 'text', text }]);
  });
});
