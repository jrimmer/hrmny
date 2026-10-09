/**
 * Markdown conformance: composer ⇄ wire ⇄ timeline (owner report 2026-09-28,
 * "we need relatively aggressive conformance testing").
 *
 * Every case runs the REAL editor configuration (editorConfig.ts nodes and
 * theme, ComposerMarkdownPlugin's shortcuts, transforms and keys) on a
 * Lexical editor mounted in jsdom, and checks five things:
 *
 *   1. TREE — typed keystrokes (or an imported message) build the expected
 *      node tree;
 *   2. WIRE — the export is the expected Markdown;
 *   3. WYSIWYG — the timeline's own parse of that Markdown is exactly the
 *      structure the editor holds (`$expectedBlocks`), i.e. what you see is
 *      what posts;
 *   4. IDEMPOTENCE — importing the wire rebuilds the same tree, and
 *      serialise(import(serialise(x))) === serialise(x);
 *   5. PAINT — the element each construct needs is present BOTH in the
 *      composer's DOM (with the timeline's classes) and in the timeline's
 *      rendering of the wire.
 *
 * Keystroke notation in `typed`: `\n` is Shift+Enter (Enter sends), `\b` is
 * Backspace. The Shift+Enter contract (ComposerMarkdownPlugin):
 *   paragraph → new line; list item → new item, and an empty item leaves the
 *   list; heading → a new plain line; quote → new quoted line, an empty last
 *   line leaves it; code block → new code line, two empty last lines leave it.
 *
 * A seeded generator then fuzzes trees and Markdown over the supported
 * grammar (no new dependency).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isLineBreakNode,
  $isParagraphNode,
  $isRangeSelection,
  $isTextNode,
  createEditor,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { $isHeadingNode, $isQuoteNode, $createQuoteNode } from '@lexical/rich-text';
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode } from '@lexical/list';
import { $createLinkNode, $isLinkNode } from '@lexical/link';
import { $createCodeNode, $isCodeNode } from '@lexical/code';

import { COMPOSER_NODES, COMPOSER_THEME } from '../editorConfig.js';
import {
  $expectedBlocks,
  $exportComposerMarkdown,
  $importComposerMarkdown,
  ChatHeadingNode,
  timelineBlocks,
} from '../composerMarkdown.js';
import { $handleBackspace, $handleShiftEnter, $pasteMarkdown, registerComposerMarkdown } from '../ComposerMarkdownPlugin.js';
import { $createMentionNode, $isChannelMentionNode, $isMentionNode } from '../MentionNode.js';
import { renderMarkdown } from '../markdown.js';
import { parseMarkdownBlocks } from '@cytale/markdown';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const mounted: HTMLElement[] = [];

afterEach(() => {
  for (const el of mounted.splice(0)) el.remove();
});

/**
 * A headless editor with the composer's configuration. Typing runs without a
 * DOM (jsdom's selectionchange would re-derive the caret's format from the
 * node and blur the shortcut semantics under test); `paint` attaches one.
 */
function mount(): LexicalEditor {
  const editor = createEditor({
    namespace: 'conformance',
    nodes: [...COMPOSER_NODES],
    theme: COMPOSER_THEME,
    onError: (err) => {
      throw err;
    },
  });
  // Lexical's own headless mode (what @lexical/headless sets): the caret
  // carries from update to update instead of being re-read from a DOM.
  (editor as unknown as { _headless: boolean })._headless = true;
  registerComposerMarkdown(editor);
  editor.update(
    () => {
      const p = $createParagraphNode();
      $getRoot().clear().append(p);
      p.select();
    },
    { discrete: true },
  );
  return editor;
}

/** Attach a DOM root so the theme's elements and classes can be inspected. */
function paint(editor: LexicalEditor): HTMLElement {
  const root = document.createElement('div');
  root.contentEditable = 'true';
  document.body.append(root);
  mounted.push(root);
  (editor as unknown as { _headless: boolean })._headless = false;
  editor.setRootElement(root);
  return root;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 0));

/** Type keystrokes: `\n` = Shift+Enter, `\b` = Backspace, anything else inserts. */
async function type(editor: LexicalEditor, keys: string): Promise<void> {
  for (const ch of keys) {
    editor.update(
      () => {
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error('no selection');
        if (ch === '\n') {
          if (!$handleShiftEnter()) sel.insertLineBreak();
        } else if (ch === '\b') {
          if ($handleBackspace()) return;
          // jsdom has no Selection.modify (Lexical's character delete uses
          // it); delete the character before the caret by hand.
          const node = sel.anchor.getNode();
          if ($isTextNode(node) && sel.anchor.offset > 0) node.spliceText(sel.anchor.offset - 1, 1, '', true);
          else sel.deleteCharacter(true);
        } else sel.insertText(ch);
      },
      { discrete: true },
    );
    // The shortcut listener runs its transform as a follow-up update.
    await settle();
  }
}

function load(editor: LexicalEditor, markdown: string): void {
  editor.update(() => $importComposerMarkdown(markdown), { discrete: true });
}

function wire(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $exportComposerMarkdown());
}

const FORMAT_TAGS: [number, string][] = [
  [IS_CODE, 'c'],
  [IS_BOLD, 'b'],
  [IS_ITALIC, 'i'],
  [IS_STRIKETHROUGH, 's'],
  [IS_UNDERLINE, 'u'],
];

function inlineTree(el: ElementNode): string {
  return el
    .getChildren()
    .map((c: LexicalNode) => {
      if ($isLineBreakNode(c)) return 'br';
      if ($isMentionNode(c)) return `@${c.getId()}`;
      if ($isChannelMentionNode(c)) return `#${c.getId()}`;
      if ($isLinkNode(c)) return `a(${c.getURL()})[${inlineTree(c)}]`;
      if ($isTextNode(c)) {
        const tags = FORMAT_TAGS.filter(([bit]) => c.getFormat() & bit).map(([, t]) => t).join('');
        return `${tags ? `${tags}:` : ''}${JSON.stringify(c.getTextContent())}`;
      }
      return `?${c.getType()}`;
    })
    .join(' ');
}

/** A compact, readable rendering of the editor's tree. */
function tree(editor: LexicalEditor): string {
  return editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((b) => {
        if ($isParagraphNode(b)) return `p[${inlineTree(b)}]`;
        if ($isHeadingNode(b)) return `${b.getTag()}[${inlineTree(b)}]`;
        if ($isQuoteNode(b)) return `q[${inlineTree(b)}]`;
        if ($isCodeNode(b)) return `code${b.getLanguage() ? `(${b.getLanguage()})` : ''}[${JSON.stringify(b.getTextContent())}]`;
        if ($isListNode(b)) {
          const type = b.getListType();
          const head = type === 'number' ? `ol${b.getStart() === 1 ? '' : `(${b.getStart()})`}` : type === 'check' ? 'tasks' : 'ul';
          const items = b
            .getChildren()
            .map((li) =>
              $isListItemNode(li)
                ? `${type === 'check' ? (li.getChecked() ? 'x' : 'o') : 'li'}[${inlineTree(li)}]`
                : '?',
            );
          return `${head}{${items.join(' ')}}`;
        }
        return `?${b.getType()}`;
      })
      .join(' '),
  );
}

/** Constructs whose element must paint in BOTH the composer and the timeline. */
type Paint =
  | 'ol'
  | 'ul'
  | 'task'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h6'
  | 'quote'
  | 'code-block'
  | 'bold'
  | 'italic'
  | 'strike'
  | 'underline'
  | 'inline-code'
  | 'link'
  | 'mention';

const COMPOSER_SELECTOR: Record<Paint, string> = {
  ol: 'ol.md-list > li.md-list-item',
  ul: 'ul.md-list > li.md-list-item',
  task: 'ul.md-list > li.md-check-item',
  h1: 'div.md-heading.md-heading-1',
  h2: 'div.md-heading.md-heading-2',
  h3: 'div.md-heading.md-heading-3',
  h6: 'div.md-heading.md-heading-6',
  quote: 'blockquote.md-quote',
  'code-block': 'code.code-block',
  bold: '.bold',
  italic: '.italic',
  strike: '.md-strike',
  underline: '.md-underline',
  'inline-code': '.inline-code',
  link: 'a.link',
  mention: '.composer-mention-host',
};

const TIMELINE_SELECTOR: Record<Paint, string> = {
  ol: 'ol.md-list > li.md-list-item',
  ul: 'ul.md-list > li.md-list-item',
  task: 'ul.md-list .md-task',
  h1: 'div.md-heading.md-heading-1',
  h2: 'div.md-heading.md-heading-2',
  h3: 'div.md-heading.md-heading-3',
  h6: 'div.md-heading.md-heading-6',
  quote: 'blockquote.md-quote',
  'code-block': 'pre.code-block',
  bold: '.bold',
  italic: '.italic',
  strike: '.md-strike',
  underline: '.md-underline',
  'inline-code': '.inline-code',
  link: 'a.link',
  mention: '.mention',
};

function timelineDom(markdown: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = renderToStaticMarkup(<>{renderMarkdown(markdown)}</>);
  return div;
}

interface Case {
  name: string;
  /** Keystrokes typed into an empty composer. */
  typed?: string;
  /** Or a stored message / draft loaded into the editor. */
  md?: string;
  tree: string;
  /** The exact wire text (omit to check only the WYSIWYG oracle). */
  wire?: string;
  paint?: Paint[];
  /** The tree after re-importing the wire, when normalisation changes it. */
  reimported?: string;
}

async function check(c: Case): Promise<void> {
  const editor = mount();
  if (c.typed !== undefined) await type(editor, c.typed);
  else load(editor, c.md ?? '');
  await settle();

  // 1. tree
  expect(tree(editor)).toBe(c.tree);

  // 2. wire
  const out = wire(editor);
  if (c.wire !== undefined) expect(out).toBe(c.wire);

  // 3. what you see is what posts: the timeline's parse == the editor's tree
  const expected = editor.getEditorState().read(() => $expectedBlocks());
  expect(timelineBlocks(out)).toEqual(expected);

  // 4. idempotence
  const again = mount();
  load(again, out);
  await settle();
  expect(tree(again)).toBe(c.reimported ?? c.tree);
  expect(wire(again)).toBe(out);

  // 5. paint, in the composer and in the timeline
  const composerDom = paint(editor);
  const timeline = timelineDom(out);
  for (const p of c.paint ?? []) {
    expect(composerDom.querySelector(COMPOSER_SELECTOR[p]), `composer paints ${p}`).not.toBeNull();
    expect(timeline.querySelector(TIMELINE_SELECTOR[p]), `timeline paints ${p}`).not.toBeNull();
  }
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

const ID = '123456789012345678';
const CHAN = '223456789012345678';

const TYPED: Case[] = [
  // Ordered lists (the owner's report)
  { name: '`1. ` makes a numbered list', typed: '1. first', tree: 'ol{li["first"]}', wire: '1. first', paint: ['ol'] },
  { name: '`3. ` keeps its start number', typed: '3. third', tree: 'ol(3){li["third"]}', wire: '3. third', paint: ['ol'] },
  { name: 'Shift+Enter in a list makes the next item', typed: '1. a\nb\nc', tree: 'ol{li["a"] li["b"] li["c"]}', wire: '1. a\n2. b\n3. c', paint: ['ol'] },
  { name: 'Shift+Enter on an empty item leaves the list', typed: '1. a\n\nafter', tree: 'ol{li["a"]} p["after"]', wire: '1. a\nafter' },
  { name: 'an empty trailing item never posts (Enter sends without it)', typed: '1. a\n', tree: 'ol{li["a"] li[]}', wire: '1. a', reimported: 'ol{li["a"]}' },
  { name: 'digits without a dot stay text', typed: '2024 was a year', tree: 'p["2024 was a year"]', wire: '2024 was a year' },
  // Bullets
  { name: '`- ` makes a bullet list', typed: '- apples\npears', tree: 'ul{li["apples"] li["pears"]}', wire: '- apples\n- pears', paint: ['ul'] },
  { name: '`* ` makes a bullet list (posts as `- `)', typed: '* x', tree: 'ul{li["x"]}', wire: '- x', paint: ['ul'] },
  { name: '`+ ` makes a bullet list', typed: '+ y', tree: 'ul{li["y"]}', wire: '- y', paint: ['ul'] },
  { name: 'a leading space never nests (the timeline has no nesting)', typed: ' - x', tree: 'p[" - x"]', wire: ' \\- x' },
  // Task lists
  { name: '`[ ] ` makes a task list', typed: '[ ] todo', tree: 'tasks{o["todo"]}', wire: '- [ ] todo', paint: ['task'] },
  { name: '`[x] ` makes a checked task', typed: '[x] done', tree: 'tasks{x["done"]}', wire: '- [x] done', paint: ['task'] },
  { name: '`- [ ] ` becomes a task list too', typed: '- [ ] task', tree: 'tasks{o["task"]}', wire: '- [ ] task', paint: ['task'] },
  // Headings
  { name: '`# ` makes a heading', typed: '# Release notes', tree: 'h1["Release notes"]', wire: '# Release notes', paint: ['h1'] },
  { name: '`## ` makes a level-2 heading', typed: '## Sub', tree: 'h2["Sub"]', wire: '## Sub', paint: ['h2'] },
  { name: '`###### ` makes a level-6 heading', typed: '###### six', tree: 'h6["six"]', wire: '###### six', paint: ['h6'] },
  { name: '`#tag` (no space) stays text', typed: '#1 fan', tree: 'p["#1 fan"]', wire: '#1 fan' },
  { name: 'Shift+Enter after a heading starts a plain line', typed: '# Title\nbody', tree: 'h1["Title"] p["body"]', wire: '# Title\nbody', paint: ['h1'] },
  // Quotes
  { name: '`> ` makes a quote; Shift+Enter continues it', typed: '> a\nb', tree: 'q["a" br "b"]', wire: '> a\n> b', paint: ['quote'] },
  { name: 'Shift+Enter on an empty last quote line leaves the quote', typed: '> a\n\nreply', tree: 'q["a"] p["reply"]', wire: '> a\nreply', paint: ['quote'] },
  // Code blocks
  { name: '``` makes a code block', typed: '``` const x = 1;\nreturn x;', tree: 'code["const x = 1;\\nreturn x;"]', wire: '```\nconst x = 1;\nreturn x;\n```', paint: ['code-block'] },
  { name: '```js keeps the language', typed: '```js let a', tree: 'code(js)["let a"]', wire: '```js\nlet a\n```', paint: ['code-block'] },
  { name: 'two empty last code lines leave the block', typed: '``` a\n\n\nafter', tree: 'code["a"] p["after"]', wire: '```\na\n```\nafter' },
  { name: 'Markdown inside a code block stays literal', typed: '``` **not** `bold`', tree: 'code["**not** `bold`"]', wire: '```\n**not** `bold`\n```' },
  // Inline
  { name: '**bold**', typed: 'a **bold** b', tree: 'p["a " b:"bold" " b"]', wire: 'a **bold** b', paint: ['bold'] },
  { name: '*italic*', typed: 'an *italic* word', tree: 'p["an " i:"italic" " word"]', wire: 'an *italic* word', paint: ['italic'] },
  { name: '***bold italic***', typed: '***both***', tree: 'p[bi:"both"]', wire: '***both***', paint: ['bold', 'italic'] },
  { name: '~~strikethrough~~', typed: 'was ~~gone~~', tree: 'p["was " s:"gone"]', wire: 'was ~~gone~~', paint: ['strike'] },
  { name: '__underline__ (never bold)', typed: 'and __under__ it', tree: 'p["and " u:"under" " it"]', wire: 'and __under__ it', paint: ['underline'] },
  { name: '`inline code`', typed: 'run `make`', tree: 'p["run " c:"make"]', wire: 'run `make`', paint: ['inline-code'] },
  { name: '[text](url) makes a link', typed: 'see [docs](https://x.dev/a_b)', tree: 'p["see " a(https://x.dev/a_b)["docs"]]', wire: 'see [docs](https://x.dev/a_b)', paint: ['link'] },
  // Images: held as their markup (like a bare URL), posted verbatim, drawn by the timeline
  { name: '![alt](url) stays text in the composer and posts verbatim', typed: 'see ![a cat](https://x.dev/c.png)', tree: 'p["see ![a cat](https://x.dev/c.png)"]', wire: 'see ![a cat](https://x.dev/c.png)' },
  { name: 'the link shortcut stands aside after `!`', typed: 'a ![](https://x.dev/e.png) b', tree: 'p["a ![](https://x.dev/e.png) b"]', wire: 'a ![](https://x.dev/e.png) b' },
  { name: 'every inline span in one line', typed: 'a **b** *i* ~~s~~ `c` __u__ z', tree: 'p["a " b:"b" " " i:"i" " " s:"s" " " c:"c" " " u:"u" " z"]', wire: 'a **b** *i* ~~s~~ `c` __u__ z', paint: ['bold', 'italic', 'strike', 'inline-code', 'underline'] },
  { name: 'bold inside a list item', typed: '- **x** y', tree: 'ul{li[b:"x" " y"]}', wire: '- **x** y', paint: ['ul', 'bold'] },
  { name: 'code inside a quote', typed: '> run `x`', tree: 'q["run " c:"x"]', wire: '> run `x`', paint: ['quote', 'inline-code'] },
  { name: 'strike inside a heading', typed: '## ~~old~~ new', tree: 'h2[s:"old" " new"]', wire: '## ~~old~~ new', paint: ['h2', 'strike'] },
  { name: '***x*** typed is bold italic', typed: 'a ***x*** b', tree: 'p["a " bi:"x" " b"]', wire: 'a ***x*** b', paint: ['bold', 'italic'] },
  { name: 'typed ~~**x**~~ is bold and struck', typed: '~~**x**~~', tree: 'p[bs:"x"]', wire: '~~**x**~~', paint: ['bold', 'strike'] },
  { name: 'typed **~~x~~** is the same, posted in one canonical nesting', typed: '**~~x~~**', tree: 'p[bs:"x"]', wire: '~~**x**~~', paint: ['bold', 'strike'] },
  { name: 'typed __**x**__ is bold and underlined', typed: '__**x**__', tree: 'p[bu:"x"]', wire: '__**x**__', paint: ['bold', 'underline'] },
  { name: 'typed italic inside bold', typed: '**a *b* c**', tree: 'p[b:"a " bi:"b" b:" c"]', wire: '**a *b* c**', paint: ['bold', 'italic'] },
  { name: 'typed bold inside strike', typed: '~~a **b** c~~', tree: 'p[s:"a " bs:"b" s:" c"]', wire: '~~a **b** c~~', paint: ['bold', 'strike'] },
  { name: 'typed bold straight after a URL is bold (the URL ends before `**`)', typed: 'see https://x.dev**b**', tree: 'p["see https://x.dev" b:"b"]', wire: 'see https://x.dev**b**', paint: ['bold'] },
  { name: 'underline glued to a word cannot post, so it does not show', typed: '__ab__c', tree: 'p["abc"]', wire: 'abc' },
  // Literal text that must NOT become structure in the timeline
  { name: 'lone stars stay literal (a star before a blank opens nothing)', typed: '2 * 3 * 4', tree: 'p["2 * 3 * 4"]', wire: '2 * 3 * 4' },
  { name: 'a star before a word opens nothing without a closer', typed: 'a *b', tree: 'p["a *b"]', wire: 'a *b' },
  { name: 'snake_case stays as typed', typed: 'my_var_name', tree: 'p["my_var_name"]', wire: 'my_var_name' },
  { name: 'a Windows path keeps its backslashes', typed: 'C:\\Users\\me', tree: 'p["C:\\\\Users\\\\me"]', wire: 'C:\\Users\\me' },
  { name: 'a typed backslash-star is literal', typed: 'a \\* b', tree: 'p["a \\\\* b"]', wire: 'a \\\\* b' },
  { name: 'Shift+Enter starts a new line that can itself start a list', typed: 'Steps:\n1. one\ntwo', tree: 'p["Steps:"] ol{li["one"] li["two"]}', wire: 'Steps:\n1. one\n2. two', paint: ['ol'] },
  { name: 'Shift+Enter in a paragraph is a new line of the same message', typed: 'one\ntwo\n\nfour', tree: 'p["one"] p["two"] p[] p["four"]', wire: 'one\ntwo\n\nfour' },
  { name: 'a trailing space survives the export (Enter trims the message)', typed: 'hi  ', tree: 'p["hi  "]', wire: 'hi  ' },
  { name: 'emoji and shortcodes pass through', typed: '🎉 done :tada:', tree: 'p["🎉 done :tada:"]', wire: '🎉 done :tada:' },
  // Backspace reverts a shortcut to the text that made it
  { name: 'Backspace after `1. ` brings back the literal `1. `', typed: '1. \bis the answer', tree: 'p["1. is the answer"]', wire: '1\\. is the answer' },
  { name: 'Backspace after `- ` brings back `- `', typed: '- \bdash', tree: 'p["- dash"]', wire: '\\- dash' },
  { name: 'Backspace after `# ` brings back `# `', typed: '# \bhash', tree: 'p["# hash"]', wire: '\\# hash' },
  { name: 'Backspace after `> ` brings back `> `', typed: '> \bangle', tree: 'p["> angle"]', wire: '\\> angle' },
  { name: 'Backspace after ``` brings back the fence', typed: '``` \bfence', tree: 'p["``` fence"]' },
  { name: 'Backspace after `[ ] ` brings back the box', typed: '[ ] \bbox', tree: 'p["[ ] box"]', wire: '[ ] box' },
  { name: 'Backspace on an empty new item returns to the item above', typed: '- a\n\b', tree: 'ul{li["a"]}', wire: '- a' },
  { name: 'Backspace twice after `1. ` edits the literal', typed: '1. \b\b\bx', tree: 'p["1x"]', wire: '1x' },
];

const IMPORTED: Case[] = [
  // What the timeline draws is what the editor shows (edit / draft restore)
  { name: 'a quote then a reply stays two blocks (no lazy continuation)', md: '> quoted\nmy reply', tree: 'q["quoted"] p["my reply"]', wire: '> quoted\nmy reply', paint: ['quote'] },
  { name: 'a list then a line stays two blocks', md: '- a\nb', tree: 'ul{li["a"]} p["b"]', wire: '- a\nb', paint: ['ul'] },
  { name: '__x__ loads as underline, not bold', md: 'an __under__ line', tree: 'p["an " u:"under" " line"]', wire: 'an __under__ line', paint: ['underline'] },
  { name: '_x_ is literal (the timeline draws it literally)', md: 'an _em_ line', tree: 'p["an _em_ line"]', wire: 'an _em_ line' },
  { name: '==x== is literal', md: 'a ==mark== b', tree: 'p["a ==mark== b"]', wire: 'a ==mark== b' },
  { name: '`1)` lists load as numbered lists', md: '1) one\n2) two', tree: 'ol{li["one"] li["two"]}', wire: '1. one\n2. two', paint: ['ol'] },
  { name: '`*`/`+` bullets load as one list', md: '* a\n+ b', tree: 'ul{li["a"] li["b"]}', wire: '- a\n- b', paint: ['ul'] },
  { name: 'an indented marker is flattened', md: '- a\n  - b', tree: 'ul{li["a"] li["b"]}', wire: '- a\n- b', paint: ['ul'] },
  { name: 'four-space indent is text, not a list', md: '    - not nested', tree: 'p["    - not nested"]', wire: '    - not nested' },
  { name: 'a task list loads as tasks', md: '- [ ] a\n- [x] b', tree: 'tasks{o["a"] x["b"]}', wire: '- [ ] a\n- [x] b', paint: ['task'] },
  { name: 'a mixed list keeps its task marker as text', md: '- [ ] a\n- b', tree: 'ul{li["[ ] a"] li["b"]}', wire: '- [ ] a\n- b', paint: ['ul'] },
  { name: 'a numbered list keeps its start', md: '7. seven\n8. eight', tree: 'ol(7){li["seven"] li["eight"]}', wire: '7. seven\n8. eight', paint: ['ol'] },
  { name: 'heading closing hashes are decoration', md: '## Title ##', tree: 'h2["Title"]', wire: '## Title', paint: ['h2'] },
  { name: 'a heading ending in # keeps it', md: '## C\\#', tree: 'h2["C#"]', wire: '## C#' },
  { name: 'a quote keeps its lines', md: '> one\n> two', tree: 'q["one" br "two"]', wire: '> one\n> two', paint: ['quote'] },
  { name: '>>> quotes to the end', md: '>>> all\nof this', tree: 'q["all" br "of this"]', wire: '> all\n> of this', paint: ['quote'] },
  { name: 'fenced code keeps its body and language', md: '```ts\nlet a = 1;\n  indented\n```', tree: 'code(ts)["let a = 1;\\n  indented"]', wire: '```ts\nlet a = 1;\n  indented\n```', paint: ['code-block'] },
  { name: 'an unclosed fence is code to the end', md: '```\nunclosed', tree: 'code["unclosed"]', wire: '```\nunclosed\n```', paint: ['code-block'] },
  { name: 'a fence inside code gets a longer fence', md: '````\n```\ninner\n```\n````', tree: 'code["```\\ninner\\n```"]', wire: '````\n```\ninner\n```\n````', paint: ['code-block'] },
  { name: 'a blank line between paragraphs survives', md: 'a\n\nb', tree: 'p["a"] p[] p["b"]', wire: 'a\n\nb' },
  { name: 'escaped line-start markers stay literal lines', md: 'intro\n\\# not a heading\n\\- not a bullet\n1\\. not a list\n\\> not a quote', tree: 'p["intro"] p["# not a heading"] p["- not a bullet"] p["1. not a list"] p["> not a quote"]', wire: 'intro\n\\# not a heading\n\\- not a bullet\n1\\. not a list\n\\> not a quote' },
  { name: 'emphasis across a line break stays emphasis on both lines', md: '*a\nb*', tree: 'p[i:"a"] p[i:"b"]', wire: '*a*\n*b*' },
  { name: 'a mention inside a list', md: `- ping <@${ID}>`, tree: `ul{li["ping " @${ID}]}`, wire: `- ping <@${ID}>`, paint: ['ul', 'mention'] },
  { name: 'a mention inside a quote', md: `> <@${ID}> said`, tree: `q[@${ID} " said"]`, wire: `> <@${ID}> said`, paint: ['quote', 'mention'] },
  { name: 'a channel inside a heading', md: `# in <#${CHAN}>`, tree: `h1["in " #${CHAN}]`, wire: `# in <#${CHAN}>`, paint: ['h1'] },
  { name: 'a bare URL keeps its underscores and ends before a star (GitHub)', md: 'see https://x.dev/a_b_c*d*', tree: 'p["see https://x.dev/a_b_c" i:"d"]', wire: 'see https://x.dev/a_b_c*d*', paint: ['italic'] },
  { name: 'bold glued to a URL is bold, not part of the link', md: 'https://x.dev**b**', tree: 'p["https://x.dev" b:"b"]', wire: 'https://x.dev**b**', paint: ['bold'] },
  { name: 'strike and code glued to a URL end it too', md: 'https://x.dev~~s~~ https://y.dev`c`', tree: 'p["https://x.dev" s:"s" " https://y.dev" c:"c"]', wire: 'https://x.dev~~s~~ https://y.dev`c`', paint: ['strike', 'inline-code'] },
  { name: 'a URL in quotes leaves the quotes out', md: 'see "https://x.dev".', tree: 'p["see \\"https://x.dev\\"."]', wire: 'see "https://x.dev".' },
  // Nested emphasis (Discord parity): combinations load, show and post
  { name: 'bold inside strike', md: '~~**x**~~', tree: 'p[bs:"x"]', wire: '~~**x**~~', paint: ['bold', 'strike'] },
  { name: 'strike inside bold posts in one canonical nesting', md: '**~~x~~**', tree: 'p[bs:"x"]', wire: '~~**x**~~', paint: ['bold', 'strike'] },
  { name: 'all four marks at once', md: '__*~~**all**~~*__', tree: 'p[bisu:"all"]', wire: '~~__***all***__~~', paint: ['bold', 'italic', 'strike', 'underline'] },
  { name: 'italic inside bold', md: '**bold *and italic* bold**', tree: 'p[b:"bold " bi:"and italic" b:" bold"]', wire: '**bold *and italic* bold**', paint: ['bold', 'italic'] },
  { name: 'bold inside italic', md: '*a **b** c*', tree: 'p[i:"a " bi:"b" i:" c"]', wire: '*a **b** c*', paint: ['bold', 'italic'] },
  { name: 'underline inside strike inside a heading', md: '## ~~a __b__ c~~', tree: 'h2[s:"a " su:"b" s:" c"]', wire: '## ~~a __b__ c~~', paint: ['h2', 'strike', 'underline'] },
  { name: 'code and a link inside bold', md: `**\`code\`** and **[l](https://x.dev)**`, tree: 'p[cb:"code" " and " a(https://x.dev)[b:"l"]]', wire: '**`code`** and **[l](https://x.dev)**', paint: ['bold', 'inline-code', 'link'] },
  { name: 'a literal star inside bold stays literal', md: '**2 * 3**', tree: 'p[b:"2 * 3"]', wire: '**2 * 3**', paint: ['bold'] },
  { name: 'an escaped star inside italic', md: '*a\\*b*', tree: 'p[i:"a*b"]', wire: '*a\\*b*', paint: ['italic'] },
  { name: 'an angle autolink loads as its URL', md: '<https://x.dev/q?a=1>', tree: 'p["https://x.dev/q?a=1"]', wire: 'https://x.dev/q?a=1' },
  { name: 'a link whose text is its URL is the URL', md: '[https://x.dev](https://x.dev)', tree: 'p["https://x.dev"]', wire: 'https://x.dev' },
  { name: 'a refused link target is its label (as in the timeline)', md: '[x](javascript:alert(1))', tree: 'p["x)"]', wire: 'x)' },
  { name: 'bold may hold a single star', md: '**a *b**', tree: 'p[b:"a *b"]', wire: '**a *b**', paint: ['bold'] },
  { name: 'bold italic', md: '***x***', tree: 'p[bi:"x"]', wire: '***x***', paint: ['bold', 'italic'] },
  { name: 'literal stars around a word post with the fewest escapes', md: 'x \\*y\\* z', tree: 'p["x *y* z"]', wire: 'x *y\\* z' },
  { name: 'escapes load as their characters', md: '\\*not\\* \\_x\\_ 1\\. \\# \\\\', tree: 'p["*not* _x_ 1. # \\\\"]' },
  { name: 'a strike may hold one tilde (Discord)', md: '~~a~b~~', tree: 'p[s:"a~b"]', wire: '~~a~b~~' },
  { name: 'an unclosed strike stays literal', md: '~~open', tree: 'p["~~open"]', wire: '~~open' },
  { name: 'unclosed bold stays literal', md: '**open and *half', tree: 'p["**open and *half"]' },
  { name: 'a lone backtick stays literal', md: 'it`s', tree: 'p["it`s"]', wire: 'it`s' },
  { name: 'square brackets without a target stay literal', md: '[WIP] fix', tree: 'p["[WIP] fix"]', wire: '[WIP] fix' },
  { name: 'emoji are text', md: '🚀 ship :rocket:', tree: 'p["🚀 ship :rocket:"]', wire: '🚀 ship :rocket:' },
  // Images load back as the markup the author typed, and post unchanged
  { name: 'an image (with a title) loads as its markup', md: 'plan ![wb](https://x.dev/wb.png "Q3") **now**', tree: 'p["plan ![wb](https://x.dev/wb.png \\"Q3\\") " b:"now"]', wire: 'plan ![wb](https://x.dev/wb.png "Q3") **now**', paint: ['bold'] },
  { name: 'an image inside bold keeps the mark', md: '**![x](https://x.dev/i.png)**', tree: 'p[b:"![x](https://x.dev/i.png)"]', wire: '**![x](https://x.dev/i.png)**', paint: ['bold'] },
  { name: 'an image in a list item and a quote', md: '- ![a](https://x.dev/a.png)\n> ![b](https://x.dev/b.png)', tree: 'ul{li["![a](https://x.dev/a.png)"]} q["![b](https://x.dev/b.png)"]', wire: '- ![a](https://x.dev/a.png)\n> ![b](https://x.dev/b.png)', paint: ['ul', 'quote'] },
  // A timestamp tag loads as the tag the author typed, and posts unchanged
  { name: 'a timestamp tag loads as its markup', md: 'answer <t:1791328800:R> **now**', tree: 'p["answer <t:1791328800:R> " b:"now"]', wire: 'answer <t:1791328800:R> **now**', paint: ['bold'] },
  { name: 'an escaped `!` before a link stays a `!` and a link', md: '\\![x](https://x.dev/i.png)', tree: 'p["!" a(https://x.dev/i.png)["x"]]', wire: '\\![x](https://x.dev/i.png)', paint: ['link'] },
  {
    name: 'a whole message of every block',
    md: '# Plan\nIntro **now**.\n1. first\n2. second\n> quoted\n```sh\nmake\n```\n- [ ] todo\ndone ~~x~~',
    tree: 'h1["Plan"] p["Intro " b:"now" "."] ol{li["first"] li["second"]} q["quoted"] code(sh)["make"] tasks{o["todo"]} p["done " s:"x"]',
    wire: '# Plan\nIntro **now**.\n1. first\n2. second\n> quoted\n```sh\nmake\n```\n- [ ] todo\ndone ~~x~~',
    paint: ['h1', 'bold', 'ol', 'quote', 'code-block', 'task', 'strike'],
  },
];

describe('composer Markdown conformance — typed shortcuts', () => {
  for (const c of TYPED) it(c.name, () => check(c));
});

describe('composer Markdown conformance — stored Markdown (edit, draft restore)', () => {
  for (const c of IMPORTED) it(c.name, () => check(c));
});

// ---------------------------------------------------------------------------
// Behaviour the table cannot express
// ---------------------------------------------------------------------------

describe('composer Markdown behaviour', () => {
  it('a typed image posts as markup the timeline parses as an IMAGE node (drawn through the proxy)', async () => {
    const editor = mount();
    await type(editor, 'look ![a cat](https://x.dev/c.png)');
    const out = wire(editor);
    const [block] = parseMarkdownBlocks(out);
    expect(block).toMatchObject({
      type: 'inline',
      nodes: [
        { type: 'text', text: 'look ' },
        { type: 'image', alt: 'a cat', src: 'https://x.dev/c.png' },
      ],
    });
    // Without a proxied copy (no renderer here) the timeline shows a link to it.
    const link = timelineDom(out).querySelector('a[data-link="image"]');
    expect(link?.getAttribute('href')).toBe('https://x.dev/c.png');
    expect(link?.textContent).toBe('a cat');
  });

  it('a typed timestamp tag posts as typed and the timeline parses it as a TIMESTAMP node', async () => {
    const editor = mount();
    await type(editor, 'answer <t:1791328800:R> or not');
    const out = wire(editor);
    expect(out).toBe('answer <t:1791328800:R> or not');
    const [block] = parseMarkdownBlocks(out);
    expect(block).toMatchObject({
      type: 'inline',
      nodes: [
        { type: 'text', text: 'answer ' },
        { type: 'timestamp', unix: 1791328800, style: 'R' },
        { type: 'text', text: ' or not' },
      ],
    });
    expect(timelineDom(out).querySelector('time.md-timestamp')).not.toBeNull();
  });

  it('Backspace at the start of a later list item joins it to the item above', async () => {
    const editor = mount();
    await type(editor, '1. a\nb');
    editor.update(
      () => {
        const list = $getRoot().getFirstChild() as ElementNode;
        (list.getLastChild() as ElementNode).selectStart();
        expect($handleBackspace()).toBe(true);
      },
      { discrete: true },
    );
    expect(tree(editor)).toBe('ol{li["ab"]}');
  });

  it('Backspace at the start of the FIRST item of a longer list keeps the rest a list', async () => {
    const editor = mount();
    await type(editor, '1. a\nb\nc');
    editor.update(
      () => {
        const list = $getRoot().getFirstChild() as ElementNode;
        (list.getFirstChild() as ElementNode).selectStart();
        expect($handleBackspace()).toBe(true);
      },
      { discrete: true },
    );
    expect(tree(editor)).toBe('p["1. a"] ol(2){li["b"] li["c"]}');
    expect(wire(editor)).toBe('1\\. a\n2. b\n3. c');
  });

  it('pasting Markdown text builds the structure it describes', async () => {
    const editor = mount();
    editor.update(() => void $pasteMarkdown('# T\n- a\n- b\n> q'), { discrete: true });
    await settle();
    expect(tree(editor)).toBe('h1["T"] ul{li["a"] li["b"]} q["q"]');
  });

  it('pasting inline Markdown lands at the caret', async () => {
    const editor = mount();
    await type(editor, 'x ');
    editor.update(() => void $pasteMarkdown('**b** and `c`'), { discrete: true });
    await settle();
    expect(tree(editor)).toBe('p["x " b:"b" " and " c:"c"]');
    expect(wire(editor)).toBe('x **b** and `c`');
  });

  it('a pasted nested list flattens, and adjacent lists and quotes merge', async () => {
    const editor = mount();
    editor.update(
      () => {
        const outer = $createListNode('bullet');
        const a = $createListItemNode();
        a.append($createTextNode('a'));
        const holder = $createListItemNode();
        const inner = $createListNode('bullet');
        const b = $createListItemNode();
        b.append($createTextNode('b'));
        inner.append(b);
        holder.append(inner);
        outer.append(a, holder);
        const second = $createListNode('bullet');
        const c = $createListItemNode();
        c.append($createTextNode('c'));
        second.append(c);
        const q1 = $createQuoteNode();
        q1.append($createTextNode('q1'));
        const q2 = $createQuoteNode();
        q2.append($createTextNode('q2'));
        $getRoot().clear().append(outer, second, q1, q2);
      },
      { discrete: true },
    );
    expect(tree(editor)).toBe('ul{li["a"] li["b"] li["c"]} q["q1" br "q2"]');
    expect(wire(editor)).toBe('- a\n- b\n- c\n> q1\n> q2');
  });

  it('a line break inside a list item or heading splits it', async () => {
    const editor = mount();
    editor.update(
      () => {
        const list = $createListNode('number');
        const li = $createListItemNode();
        li.append($createTextNode('a'), $createLineBreakNode(), $createTextNode('b'));
        list.append(li);
        const h = new ChatHeadingNode('h2');
        h.append($createTextNode('T'), $createLineBreakNode(), $createTextNode('body'));
        $getRoot().clear().append(list, h);
      },
      { discrete: true },
    );
    expect(tree(editor)).toBe('ol{li["a"] li["b"]} h2["T"] p["body"]');
  });

  it('formats the timeline cannot draw are dropped; link text is marked as a whole', async () => {
    const editor = mount();
    editor.update(
      () => {
        const p = $createParagraphNode();
        const hl = $createTextNode('mark');
        hl.toggleFormat('highlight');
        const sub = $createTextNode('sub');
        sub.toggleFormat('subscript');
        const styled = $createTextNode(' red');
        styled.setStyle('color: red');
        const link = $createLinkNode('https://x.dev');
        const lt = $createTextNode('L');
        lt.toggleFormat('bold');
        link.append(lt);
        p.append(hl, sub, styled, $createTextNode(' '), link);
        $getRoot().clear().append(p);
      },
      { discrete: true },
    );
    expect(tree(editor)).toBe('p["marksub red " a(https://x.dev)[b:"L"]]');
  });

  it('keyboard formatting combines marks, and the combination posts', async () => {
    const editor = mount();
    await type(editor, 'a word b');
    editor.update(
      () => {
        const text = $getRoot().getFirstDescendant();
        if (!$isTextNode(text)) throw new Error('no text');
        text.select(2, 6);
        const sel = $getSelection();
        if (!$isRangeSelection(sel)) throw new Error('no selection');
        sel.formatText('bold');
        sel.formatText('italic');
        sel.formatText('strikethrough');
        sel.formatText('underline');
      },
      { discrete: true },
    );
    await settle();
    expect(tree(editor)).toBe('p["a " bisu:"word" " b"]');
    expect(wire(editor)).toBe('a ~~__***word***__~~ b');
    const dom = timelineDom(wire(editor));
    expect(dom.querySelector('s.md-strike .md-underline .bold .italic, s.md-strike .md-underline .italic .bold')).not.toBeNull();
  });

  it('a mark that cannot post is taken off in the editor too', async () => {
    const editor = mount();
    editor.update(
      () => {
        const p = $createParagraphNode();
        const a = $createTextNode('ab');
        const u = $createTextNode('cd');
        u.setFormat(IS_UNDERLINE);
        const bold = $createTextNode('x');
        bold.setFormat(IS_BOLD);
        const it = $createTextNode('y');
        it.setFormat(IS_ITALIC);
        p.append(a, u, $createTextNode(' '), bold, it);
        $getRoot().clear().append(p);
      },
      { discrete: true },
    );
    await settle();
    // `ab__cd__` would not underline (glued to a word), and `**x***y*`
    // would not read as bold-then-italic: both marks come off, as shown.
    expect(tree(editor)).toBe('p["abcd " b:"x" "y"]');
    expect(wire(editor)).toBe('abcd **x**y');
  });

  it('a draft round-trips through storage unchanged', async () => {
    const draft = `# Notes\n1. one\n2. **two**\n> <@${ID}> said\n\`\`\`\ncode\n\`\`\`\ntail \\* star`;
    const editor = mount();
    load(editor, draft);
    const first = wire(editor);
    const again = mount();
    load(again, first);
    expect(wire(again)).toBe(first);
    expect(timelineBlocks(first)).toEqual(timelineBlocks(draft));
  });

  it('the theme gives every construct the timeline\'s classes', () => {
    expect(COMPOSER_THEME.list).toMatchObject({ ol: 'md-list', ul: 'md-list', listitem: 'md-list-item' });
    expect(COMPOSER_THEME.heading?.h1).toBe('md-heading md-heading-1');
    expect(COMPOSER_THEME.quote).toBe('md-quote');
    expect(COMPOSER_THEME.code).toBe('code-block');
    expect(COMPOSER_THEME.text).toMatchObject({ bold: 'bold', italic: 'italic', strikethrough: 'md-strike', underline: 'md-underline', code: 'inline-code' });
    expect(COMPOSER_THEME.link).toBe('link');
  });
});

// ---------------------------------------------------------------------------
// Fuzz: seeded trees and seeded Markdown over the supported grammar
// ---------------------------------------------------------------------------

/** Rounds per fuzz (MD_FUZZ raises it for a deeper local sweep). */
const ROUNDS = Number(process.env.MD_FUZZ ?? 500);
const SEED = Number(process.env.MD_FUZZ_SEED ?? 0);

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A bare URL ends at a blank, `<`, `*`, `~` or a backtick (GitHub's rule),
// so emphasis and code glued to one are markup, not part of the link.
const ATOMS = ['![i](https://x.dev/i.png) ', '![](https://x.dev/e.png "t")', 'https://x.dev', '***', '\\*', 'é', 'a', 'bc', 'word', ' ', '  ', '*', '**', '_', '__', '~', '~~', '`', '[', ']', '(', ')', '#', '>', '-', '+', '1.', '2)', '\\', '<', ':tada:', '🎉', 'x_y', 'https://x.dev/a_b*c ', '.', '!', '[ ] ', '[x] ', '>>>', '```', '~~~', '#### ', '<https://x.dev> ', '[a](https://x.dev) '];

describe('composer Markdown fuzz', () => {
  it(`${ROUNDS} random editor trees: the timeline parses exactly what the editor holds, and the wire is a fixed point`, async () => {
    const rand = mulberry32(20260928 + SEED);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    // Every combination of the four marks, alone and around inline code.
    const marks = [IS_BOLD, IS_ITALIC, IS_STRIKETHROUGH, IS_UNDERLINE];
    const combos = Array.from({ length: 16 }, (_, m) => marks.reduce((f, bit, i) => (m & (1 << i) ? f | bit : f), 0));
    const formats = [0, 0, 0, 0, ...combos, IS_CODE, IS_CODE | IS_BOLD, IS_CODE | IS_ITALIC | IS_STRIKETHROUGH];
    const text = () => {
      let s = '';
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i += 1) s += pick(ATOMS);
      return s;
    };
    const fillInline = (el: ElementNode, allowBreak: boolean) => {
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i += 1) {
        const r = rand();
        if (r < 0.08) el.append($createMentionNode(ID));
        else if (r < 0.14 && allowBreak) el.append($createLineBreakNode());
        else if (r < 0.2) {
          const link = $createLinkNode('https://x.dev/p');
          const label = $createTextNode(pick(['docs', 'a b', 'x_y']));
          label.setFormat(pick([0, 0, IS_BOLD, IS_ITALIC | IS_STRIKETHROUGH]));
          link.append(label);
          el.append(link);
        } else {
          const t = $createTextNode(text());
          t.setFormat(pick(formats));
          el.append(t);
        }
      }
    };
    let checked = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const editor = mount();
      editor.update(
        () => {
          const root = $getRoot().clear();
          const blocks = 1 + Math.floor(rand() * 4);
          for (let b = 0; b < blocks; b += 1) {
            const kind = pick(['p', 'p', 'p', 'h', 'q', 'ul', 'ol', 'task', 'code']);
            if (kind === 'p') {
              const p = $createParagraphNode();
              fillInline(p, true);
              root.append(p);
            } else if (kind === 'h') {
              const h = new ChatHeadingNode(pick(['h1', 'h2', 'h3'] as const));
              fillInline(h, false);
              root.append(h);
            } else if (kind === 'q') {
              const q = $createQuoteNode();
              fillInline(q, true);
              root.append(q);
            } else if (kind === 'code') {
              const code = $createCodeNode(pick([undefined, 'js']));
              code.append($createTextNode(text()), $createLineBreakNode(), $createTextNode(text()));
              root.append(code);
            } else {
              const list = $createListNode(kind === 'ol' ? 'number' : kind === 'task' ? 'check' : 'bullet');
              const items = 1 + Math.floor(rand() * 3);
              for (let i = 0; i < items; i += 1) {
                const li = $createListItemNode(kind === 'task' ? rand() < 0.5 : undefined);
                fillInline(li, false);
                list.append(li);
              }
              root.append(list);
            }
          }
        },
        { discrete: true },
      );
      const out = wire(editor);
      const expected = editor.getEditorState().read(() => $expectedBlocks());
      expect(timelineBlocks(out), JSON.stringify({ round, out, expected, parsed: timelineBlocks(out) })).toEqual(expected);
      const again = mount();
      load(again, out);
      expect(wire(again), JSON.stringify({ round, out, tree: tree(editor), again: tree(again) })).toBe(out);
      checked += 1;
    }
    expect(checked).toBe(ROUNDS);
  }, 600_000);

  it(`${ROUNDS} random Markdown strings: import → export is stable and draws what it holds`, () => {
    const rand = mulberry32(8675309 + SEED);
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const LINES = ['see ![i](https://x.dev/i.png)', '- ![](https://x.dev/e.png)', '# h', '## **b** h', '> q', '> ', '- a', '* b', '1. one', '3) three', '- [ ] t', '- [x] d', '```', '```js', '~~~', 'plain', '', '  - x', '    - y', `<@${ID}> hi`, '**b** *i* ~~s~~ `c` __u__', '~~**bs**~~ ***bi*** __*ui*__', '**b *bi* b** *i **ib** i*', '**`bc`** ~~[l](https://x.dev)~~', 'https://x.dev**b**', '**open ~~half', '_e_', '[l](https://x.dev)', 'https://x.dev/a_b', '\\# esc', '2 * 3', 'a\\', '>>> rest'];
    for (let round = 0; round < ROUNDS; round += 1) {
      const n = 1 + Math.floor(rand() * 6);
      const lines: string[] = [];
      for (let i = 0; i < n; i += 1) lines.push(pick(LINES) + (rand() < 0.3 ? pick(ATOMS) : ''));
      const md = lines.join('\n');
      const editor = mount();
      load(editor, md);
      const out = wire(editor);
      const expected = editor.getEditorState().read(() => $expectedBlocks());
      expect(timelineBlocks(out), JSON.stringify({ md, out })).toEqual(expected);
      const again = mount();
      load(again, out);
      expect(wire(again), JSON.stringify({ md, out })).toBe(out);
    }
  }, 600_000);
});

