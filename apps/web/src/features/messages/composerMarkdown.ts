/**
 * The composer's Markdown bridge: Lexical tree ⇄ the wire text the timeline
 * renders (owner report 2026-09-28, "what you see in the composer is what
 * posts").
 *
 * ONE grammar governs both directions — the timeline's, in `@cytale/markdown`
 * (`parseMarkdownBlocks`), which the web, mobile and terminal clients all
 * render from. `@lexical/markdown`'s own import/export speak a different
 * dialect, and every difference was a way for the composer to show one thing
 * and post another:
 *
 *   - lazy continuation: its import folded "> quote\nmy reply" into ONE quote,
 *     so saving an edit re-posted the reply as quoted text (the timeline
 *     draws the reply as its own line);
 *   - no escaping: text the composer showed literally ("2 * 3 * 4", a
 *     reverted "1. ", "#1 fan" after Shift+Enter) posted as Markdown and
 *     rendered as italics, lists and headings;
 *   - `__x__` imported as BOLD and exported as `**x**`, silently turning an
 *     underline (the timeline's meaning, and Discord's) into bold on edit;
 *   - a blank line between every block, which the timeline draws as an empty
 *     line the composer never showed.
 *
 * So:
 *
 *   - IMPORT ({@link $importComposerMarkdown}) walks the timeline's own parse
 *     tree, so a draft or an edited message loads into exactly the structure
 *     the timeline draws for it.
 *   - EXPORT ({@link $exportComposerMarkdown}) writes each block in the
 *     timeline's grammar, then proves the result: it parses its own output
 *     with `parseMarkdownBlocks` and compares against the tree the editor
 *     holds ({@link $expectedBlocks}). Text the editor holds LITERALLY is
 *     backslash-escaped only where the parse says it would otherwise become
 *     structure (the escape set is minimised, so ordinary prose posts
 *     unchanged).
 *
 * The supported set is the timeline's: paragraphs (Shift+Enter line breaks),
 * `#`–`######` headings, `>` quotes, `-`/`1.` lists and `- [ ]` task lists
 * (flat — the timeline has no list nesting), fenced code blocks, and the
 * inline marks bold, italic, underline (`__`) and strikethrough — which
 * COMBINE, nesting on the wire as Discord's do (`~~**x**~~`, `***x***`;
 * {@link planMarks} decides the nesting and the few joins the grammar cannot
 * say) — plus inline code (inside any marks), links (a label marked as a
 * whole), member and channel mentions. Anything else a paste can bring in is
 * normalised onto that set by `ComposerMarkdownPlugin`.
 *
 * Images (`![alt](https://…)`) are held as their LITERAL markup, the way a
 * bare URL is held as text: the composer shows the source, posts it
 * verbatim, and the timeline draws the picture (through the server's media
 * proxy) — as it draws a bare URL as a link. The typed `[text](url)` link
 * shortcut therefore stands aside after a `!` ({@link COMPOSER_LINK}), and an
 * image in stored Markdown loads back as that same text. A timestamp tag
 * (`<t:1791328800:R>`) is held the same way: the composer shows the tag, the
 * timeline shows the time.
 */
import {
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isParagraphNode,
  $isTextNode,
  IS_BOLD,
  IS_CODE,
  IS_ITALIC,
  IS_STRIKETHROUGH,
  IS_UNDERLINE,
  type EditorConfig,
  type ElementNode,
  type LexicalNode,
} from 'lexical';
import {
  $createQuoteNode,
  $isHeadingNode,
  $isQuoteNode,
  HeadingNode,
  type HeadingTagType,
  type SerializedHeadingNode,
} from '@lexical/rich-text';
import { $createListItemNode, $createListNode, $isListItemNode, $isListNode, type ListItemNode, type ListNode } from '@lexical/list';
import { $createLinkNode, $isLinkNode } from '@lexical/link';
import { $createCodeNode, $isCodeNode } from '@lexical/code';
import {
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  CHECK_LIST,
  CODE,
  HEADING,
  INLINE_CODE,
  ITALIC_STAR,
  LINK,
  ORDERED_LIST,
  QUOTE,
  STRIKETHROUGH,
  UNORDERED_LIST,
  type ElementTransformer,
  type TextFormatTransformer,
  type TextMatchTransformer,
  type Transformer,
} from '@lexical/markdown';
import {
  isEmphasisNode,
  isOpenableLinkHref,
  parseMarkdownBlocks,
  type EmphasisType,
  type InlineNode,
  type MarkdownBlock,
} from '@cytale/markdown';

import {
  $createChannelMentionNode,
  $createMentionNode,
  $isChannelMentionNode,
  $isMentionNode,
  CHANNEL_MENTION_TRANSFORMER,
  channelToken,
  MENTION_TRANSFORMER,
  token as mentionToken,
} from './MentionNode.js';

// ---------------------------------------------------------------------------
// Headings: a styled DIV, as the timeline draws them
// ---------------------------------------------------------------------------

/**
 * The composer's heading. Lexical's HeadingNode paints a real `<h1>`…`<h6>`;
 * the timeline deliberately paints a styled `<div>` (a chat message is not a
 * document section, and real headings would fill the page's outline — and a
 * screen reader's heading list — with draft text). This node keeps every
 * HeadingNode behaviour and changes only the element, via node replacement,
 * so every `$createHeadingNode` (shortcut, paste) lands here.
 */
export class ChatHeadingNode extends HeadingNode {
  static getType(): string {
    return 'chat-heading';
  }

  static clone(node: ChatHeadingNode): ChatHeadingNode {
    return new ChatHeadingNode(node.getTag(), node.__key);
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('div');
    const className = (config.theme.heading as Record<string, string> | undefined)?.[this.getTag()];
    if (className) element.className = className;
    return element;
  }

  static importJSON(json: SerializedHeadingNode): ChatHeadingNode {
    const node = new ChatHeadingNode(json.tag);
    node.setFormat(json.format);
    node.setIndent(json.indent);
    node.setDirection(json.direction);
    return node;
  }

  exportJSON(): SerializedHeadingNode {
    return { ...super.exportJSON(), type: 'chat-heading' };
  }
}

/** The replacement entry for the editor's `nodes` config. */
export const CHAT_HEADING_REPLACEMENT = {
  replace: HeadingNode,
  with: (node: HeadingNode) => new ChatHeadingNode(node.getTag()),
  withKlass: ChatHeadingNode,
};

function $createChatHeadingNode(tag: HeadingTagType): ChatHeadingNode {
  return new ChatHeadingNode(tag);
}

// ---------------------------------------------------------------------------
// Live shortcuts: the timeline's set, nothing more
// ---------------------------------------------------------------------------

/** `__x__` is UNDERLINE in the timeline (Discord's meaning), never bold. */
export const UNDERLINE: TextFormatTransformer = {
  format: ['underline'],
  intraword: false,
  tag: '__',
  type: 'text-format',
};

/**
 * Lists are FLAT (the timeline has no nesting), so the shortcuts only fire
 * on a marker at the very start of a line: Lexical's stock patterns read
 * leading spaces as an indent level and would build a nested list the
 * timeline cannot draw.
 */
const FLAT_CHECK_LIST: ElementTransformer = { ...CHECK_LIST, regExp: /^()(\[(\s|x)?\])\s/i };
const FLAT_BULLET_LIST: ElementTransformer = { ...UNORDERED_LIST, regExp: /^()[-*+]\s/ };
const FLAT_ORDERED_LIST: ElementTransformer = { ...ORDERED_LIST, regExp: /^()(\d{1,9})\.\s/ };

/**
 * Lexical's `[text](url)` shortcut, except after a `!`: `![alt](https://…)`
 * is an IMAGE in the timeline's grammar, which the composer holds as text —
 * turning its `[alt](url)` half into a link node would post `!` + a link.
 */
const COMPOSER_LINK: TextMatchTransformer = {
  ...LINK,
  regExp: /(?<!!)(?:\[([^[]+)\])(?:\((?:([^()\s]+)(?:\s"((?:[^"]*\\")*[^"]*)"\s*)?)\))$/,
};

/**
 * The live shortcuts both editors run. Deliberately NOT Lexical's
 * `TRANSFORMERS`: that list also builds `==highlight==`, `_italic_`,
 * `___bold italic___` and `__bold__`, none of which the timeline draws (and
 * `__` means underline there).
 */
export const COMPOSER_TRANSFORMERS: Transformer[] = [
  HEADING,
  QUOTE,
  FLAT_CHECK_LIST,
  FLAT_BULLET_LIST,
  FLAT_ORDERED_LIST,
  CODE,
  INLINE_CODE,
  BOLD_ITALIC_STAR,
  BOLD_STAR,
  UNDERLINE,
  ITALIC_STAR,
  STRIKETHROUGH,
  COMPOSER_LINK,
  MENTION_TRANSFORMER,
  CHANNEL_MENTION_TRANSFORMER,
];

// ---------------------------------------------------------------------------
// The comparable shape: what the timeline will draw
// ---------------------------------------------------------------------------

/**
 * The emphasis marks the timeline draws, as Lexical format bits. They
 * COMBINE (owner decision 2026-09-28, Discord parity): `~~**x**~~` is bold
 * and struck, `***x***` bold and italic, and all four can sit on one run.
 */
export const MARK_BITS = IS_BOLD | IS_ITALIC | IS_UNDERLINE | IS_STRIKETHROUGH;
/** The two marks whose delimiters are made of `*`. */
const STAR_MARKS = IS_BOLD | IS_ITALIC;

const EMPHASIS_BIT: Record<EmphasisType, number> = {
  bold: IS_BOLD,
  italic: IS_ITALIC,
  underline: IS_UNDERLINE,
  strike: IS_STRIKETHROUGH,
};

const MARK_DELIMITER: Record<number, string> = {
  [IS_BOLD]: '**',
  [IS_ITALIC]: '*',
  [IS_UNDERLINE]: '__',
  [IS_STRIKETHROUGH]: '~~',
};

/** The mark bits in a fixed order (outermost first when nothing else decides). */
const MARK_ORDER = [IS_STRIKETHROUGH, IS_UNDERLINE, IS_BOLD, IS_ITALIC];

/**
 * One inline piece, normalised so the editor and the parse compare equal.
 * `f` is the set of emphasis marks (Lexical bits, {@link MARK_BITS}) the
 * piece carries — nesting is flattened, since `***x***` and `*` around `**x**`
 * draw the same.
 */
export type NInline =
  | { readonly k: 'text'; s: string; readonly f: number }
  | { readonly k: 'code'; readonly s: string; readonly f: number }
  | { readonly k: 'link'; readonly s: string; readonly href: string; readonly f: number }
  | { readonly k: 'mention' | 'channel'; readonly id: string };

export interface NItem {
  readonly task: boolean | null;
  readonly n: NInline[];
}

/** One block, normalised. */
export type NBlock =
  | { readonly k: 'inline'; readonly n: NInline[] }
  | { readonly k: 'heading'; readonly level: number; readonly n: NInline[] }
  | { readonly k: 'quote'; readonly n: NInline[] }
  | { readonly k: 'list'; readonly ordered: boolean; readonly start: number; readonly items: NItem[] }
  | { readonly k: 'code'; readonly text: string; readonly lang: string | null };

class InlineBuilder {
  readonly out: NInline[] = [];

  text(s: string, f = 0): void {
    if (s === '') return;
    const last = this.out[this.out.length - 1];
    if (last && last.k === 'text' && last.f === f) last.s += s;
    else this.out.push({ k: 'text', s, f });
  }

  push(node: NInline): void {
    if (node.k === 'text') this.text(node.s, node.f);
    else this.out.push(node);
  }
}

/**
 * The timeline's parse, normalised: emphasis flattens onto the pieces inside
 * it, bare and angle-bracket autolinks (text === href) read as the text they
 * are — the composer holds a URL as plain text, and both draw it as a link —
 * a link the renderer refuses reads as its label, an image reads as its own
 * markup (the composer holds it as text), and adjacent text merges.
 */
export function normalizeInline(nodes: readonly InlineNode[], f = 0, b = new InlineBuilder()): NInline[] {
  for (const node of nodes) {
    if (isEmphasisNode(node)) {
      normalizeInline(node.children, f | EMPHASIS_BIT[node.type], b);
      continue;
    }
    switch (node.type) {
      case 'text':
        b.text(node.text, f);
        break;
      case 'link':
        if (node.text === node.href || !isOpenableLinkHref(node.href)) b.text(node.text, f);
        else b.push({ k: 'link', s: node.text, href: node.href, f });
        break;
      case 'mention':
        b.push({ k: 'mention', id: node.userId });
        break;
      case 'channel':
        b.push({ k: 'channel', id: node.channelId });
        break;
      case 'code':
        b.push({ k: 'code', s: node.text, f });
        break;
      case 'image':
      case 'timestamp':
        b.text(node.source, f);
        break;
    }
  }
  return b.out;
}

export function normalizeBlocks(blocks: readonly MarkdownBlock[]): NBlock[] {
  return blocks.map((block): NBlock => {
    switch (block.type) {
      case 'inline':
        return { k: 'inline', n: normalizeInline(block.nodes) };
      case 'heading':
        return { k: 'heading', level: block.level, n: normalizeInline(block.nodes) };
      case 'blockquote':
        return { k: 'quote', n: normalizeInline(block.nodes) };
      case 'list':
        return {
          k: 'list',
          ordered: block.ordered,
          start: block.start,
          items: block.items.map((item) => ({
            task: item.task ? item.task.checked : null,
            n: normalizeInline(item.nodes),
          })),
        };
      case 'code-block':
        return { k: 'code', text: block.text, lang: block.lang };
    }
  });
}

/** What the timeline draws for `markdown`, in the comparable shape. */
export function timelineBlocks(markdown: string): NBlock[] {
  return normalizeBlocks(parseMarkdownBlocks(markdown));
}

// ---------------------------------------------------------------------------
// Walking the editor: runs
// ---------------------------------------------------------------------------

type Run =
  | { readonly t: 'text'; readonly f: number; readonly code: boolean; readonly s: string }
  | { readonly t: 'br' }
  | { readonly t: 'link'; readonly s: string; readonly href: string; readonly f: number }
  | { readonly t: 'mention' | 'channel'; readonly id: string };

/**
 * The marks a link's label carries: the ones EVERY piece of it has (a label
 * is one `[text](url)`, so it is marked as a whole or not at all — the
 * plugin keeps a link's pieces uniform, and this is the reading of any tree
 * it has not reached yet).
 */
export function $linkMarks(link: ElementNode): number {
  let f = MARK_BITS;
  let any = false;
  for (const child of link.getChildren()) {
    if (!$isTextNode(child)) continue;
    any = true;
    f &= child.getFormat();
  }
  return any ? f & MARK_BITS : 0;
}

/** An element's inline content as runs, adjacent same-format text merged. */
function $runsOf(element: ElementNode): Run[] {
  const runs: Run[] = [];
  const pushText = (f: number, code: boolean, s: string) => {
    if (s === '') return;
    const last = runs[runs.length - 1];
    if (last && last.t === 'text' && last.f === f && last.code === code) {
      runs[runs.length - 1] = { t: 'text', f, code, s: last.s + s };
    } else runs.push({ t: 'text', f, code, s });
  };
  const walk = (el: ElementNode) => {
    for (const child of el.getChildren()) {
      if ($isLineBreakNode(child)) runs.push({ t: 'br' });
      else if ($isMentionNode(child)) runs.push({ t: 'mention', id: child.getId() });
      else if ($isChannelMentionNode(child)) runs.push({ t: 'channel', id: child.getId() });
      else if ($isLinkNode(child)) {
        const s = child.getTextContent();
        if (s !== '') runs.push({ t: 'link', s, href: child.getURL(), f: $linkMarks(child) });
      } else if ($isTextNode(child)) {
        const format = child.getFormat();
        pushText(format & MARK_BITS, (format & IS_CODE) !== 0, child.getTextContent());
      } else if ($isElementNode(child)) walk(child);
      else if ($isDecoratorNode(child)) pushText(0, false, child.getTextContent());
    }
  };
  walk(element);
  return runs;
}

// ---------------------------------------------------------------------------
// Cells: the runs, one character (or atom) at a time, with their marks
// ---------------------------------------------------------------------------

/**
 * The unit the mark plan works on: one literal character, or an atom the
 * wire writes whole (a code span, a link, a mention, a line break).
 */
export type Cell =
  | { readonly c: 'ch'; readonly ch: string; f: number; readonly keep?: boolean }
  | { readonly c: 'code'; readonly s: string; f: number }
  | { readonly c: 'link'; readonly s: string; readonly href: string; f: number }
  | { readonly c: 'mention' | 'channel'; readonly id: string; f: number }
  | { readonly c: 'br'; f: number };

/** A link the timeline's `[text](url)` pattern can carry. */
function linkRepresentable(text: string, href: string): boolean {
  return !text.includes(']') && !/[)\s]/.test(href) && !text.includes('\n');
}

function pushChars(out: Cell[], s: string, f: number, brText: string | null, keep = 0): void {
  let i = 0;
  for (const ch of s) {
    if (ch === '\n') {
      if (brText === null) out.push({ c: 'br', f: 0 });
      else for (const b of brText) out.push({ c: 'ch', ch: b, f: 0 });
    } else out.push(i < keep ? { c: 'ch', ch, f, keep: true } : { c: 'ch', ch, f });
    i += 1;
  }
}

/**
 * Runs → cells. `brText` is what a line break reads as where the timeline
 * has no line break (a heading or list item: a blank); null keeps it a break.
 * `keep` protects the first characters from escaping (a typed task marker).
 */
function cellsOf(runs: readonly Run[], brText: string | null, keep = 0): Cell[] {
  const out: Cell[] = [];
  for (const run of runs) {
    switch (run.t) {
      case 'br':
        if (brText === null) out.push({ c: 'br', f: 0 });
        else pushChars(out, brText, 0, brText);
        break;
      case 'mention':
      case 'channel':
        out.push({ c: run.t, id: run.id, f: 0 });
        break;
      case 'link':
        if (run.s === run.href || !isOpenableLinkHref(run.href) || !linkRepresentable(run.s, run.href))
          pushChars(out, run.s, run.f, brText);
        else out.push({ c: 'link', s: run.s, href: run.href, f: run.f });
        break;
      case 'text':
        if (!run.code) {
          pushChars(out, run.s, run.f, brText, keep);
          keep = 0;
          break;
        }
        // A code span cannot hold a backtick or cross a line: those
        // characters post beside it, carrying its marks.
        run.s.split(/(`|\n)/).forEach((part) => {
          if (part === '') return;
          if (part === '`' || part === '\n') pushChars(out, part, run.f, brText);
          else out.push({ c: 'code', s: part, f: run.f });
        });
        break;
    }
    if (run.t !== 'text') keep = 0;
  }
  // A link written straight after a typed URL would be swallowed by it (a
  // bare URL runs on through `[label](…)`): it posts as its label, which the
  // URL then takes in — the one place a composer link cannot be a link.
  for (let i = 0; i < out.length; i += 1) {
    const cell = out[i]!;
    if (cell.c !== 'link') continue;
    let j = i;
    let before = '';
    while (j > 0) {
      const prev = out[j - 1]!;
      if (prev.c !== 'ch' || ((prev.f ^ cell.f) & ~IS_UNDERLINE) !== 0) break;
      before = prev.ch + before;
      j -= 1;
    }
    if (!URL_AT_END.test(before)) continue;
    const label: Cell[] = [];
    pushChars(label, cell.s, cell.f, brText);
    out.splice(i, 1, ...label);
  }
  return out;
}

/** Text that ends inside a bare URL (the parser's `BARE_AUTOLINK_AT`). */
const URL_AT_END = /https?:\/\/(?:[^\s<*~`\\]|\\(?![!-/:-@[-`{-~]))+$/;

const BLANK = /\s/;
/** A word character, as the timeline's underline rule reads one. */
const WORD = /[\p{L}\p{N}_]/u;

const isBlankCell = (cell: Cell | undefined): boolean => cell !== undefined && cell.c === 'ch' && BLANK.test(cell.ch);
const isWordCell = (cell: Cell | undefined): boolean => cell !== undefined && cell.c === 'ch' && WORD.test(cell.ch);

/** The run of cells from `from` (inclusive) that carry `bit`, walking by `step`. */
function regionOf(cells: readonly Cell[], from: number, bit: number, step: 1 | -1): number[] {
  const out: number[] = [];
  for (let i = from; i >= 0 && i < cells.length && (cells[i]!.f & bit) !== 0; i += step) out.push(i);
  return out;
}

/** One delimiter the writer emits between two cells. */
interface MarkEvent {
  readonly open: boolean;
  readonly bit: number;
}

/**
 * The writer's delimiters, as a plan: `events[i]` is what is written before
 * cell `i` (and `events[cells.length]` closes what is still open). A stack of
 * open marks; a mark that ends closes every mark opened inside it, and the
 * ones still wanted reopen. New marks open longest-lasting first, so a mark
 * that ends sooner sits inside and closes alone.
 */
function planEvents(cells: readonly Cell[]): MarkEvent[][] {
  const events: MarkEvent[][] = [];
  const stack: number[] = [];
  const lasting = (i: number, bit: number) => regionOf(cells, i, bit, 1).length;
  for (let i = 0; i <= cells.length; i += 1) {
    const want = i < cells.length ? cells[i]!.f : 0;
    const here: MarkEvent[] = [];
    const k = stack.findIndex((bit) => (want & bit) === 0);
    if (k >= 0) {
      for (let j = stack.length - 1; j >= k; j -= 1) here.push({ open: false, bit: stack[j]! });
      stack.length = k;
    }
    const opens = MARK_ORDER.filter((bit) => (want & bit) !== 0 && !stack.includes(bit));
    opens.sort((a, b) => lasting(i, b) - lasting(i, a));
    const lastClose = here.length > 0 ? here[here.length - 1]! : null;
    // `**` closing straight into `*` opening (or the reverse) reads as one
    // run of stars: open a non-star mark first when there is one.
    if (lastClose && (lastClose.bit & STAR_MARKS) && opens.length > 1 && (opens[0]! & STAR_MARKS)) {
      const other = opens.findIndex((bit) => (bit & STAR_MARKS) === 0);
      if (other > 0) opens.unshift(...opens.splice(other, 1));
    }
    // `__` needs a non-word character before it: straight after a word
    // character, open it inside the other new marks.
    if (!lastClose && isWordCell(cells[i - 1]) && opens.length > 1 && opens[0] === IS_UNDERLINE) {
      opens.push(opens.shift()!);
    }
    for (const bit of opens) {
      here.push({ open: true, bit });
      stack.push(bit);
    }
    events.push(here);
  }
  return events;
}

/**
 * Fit the cells' marks to what the timeline's grammar can say, in place, and
 * return the delimiter plan. What cannot post as it stands loses the mark,
 * here — so the composer's oracle, its writer and (through the plugin) the
 * editor's display all agree on it:
 *
 *   - blanks at the edge of a mark's run go outside it (`** a **` is not
 *     emphasis, and `* a*` not italic) — and an italic the writer has to
 *     close and reopen around another mark's end never reopens or closes
 *     on a blank either;
 *   - an underline glued to a word character (`a__b__`, `__a__b`) is not
 *     one (`__` needs a non-word neighbour), nor is one opening straight
 *     after typed URL text (the URL would run on through the `__`);
 *   - a `*` mark ending exactly where another `*` mark starts, with no other
 *     delimiter between (`**a***b*`), reads as one run of stars — the mark
 *     that would open there is dropped (Discord's grammar cannot say it
 *     either).
 */
export function planMarks(cells: Cell[]): MarkEvent[][] {
  // 1. Blanks at a mark's edges go outside it.
  for (const bit of MARK_ORDER) {
    for (let i = 0; i < cells.length; ) {
      if ((cells[i]!.f & bit) === 0) {
        i += 1;
        continue;
      }
      const region = regionOf(cells, i, bit, 1);
      let a = 0;
      let z = region.length - 1;
      while (a <= z && isBlankCell(cells[region[a]!])) cells[region[a++]!]!.f &= ~bit;
      while (z >= a && isBlankCell(cells[region[z]!])) cells[region[z--]!]!.f &= ~bit;
      i = region[region.length - 1]! + 1;
    }
  }
  // 2–3. Drop what the plan cannot write, until it can write everything.
  for (let guard = 0; guard < 512; guard += 1) {
    const events = planEvents(cells);
    let fixed = false;
    for (let i = 0; i <= cells.length && !fixed; i += 1) {
      const here = events[i]!;
      if (here.length === 0) continue;
      const first = here[0]!;
      const last = here[here.length - 1]!;
      if (here.every((e) => e.bit === IS_UNDERLINE) && here.some((e) => e.open) && endsInUrl(cells, i)) {
        // A bare URL runs on through `__` (underscores are URL characters):
        // an underline opening straight after typed URL text cannot post.
        for (const j of regionOf(cells, i, IS_UNDERLINE, 1)) cells[j]!.f &= ~IS_UNDERLINE;
        fixed = true;
      } else if (first.open && first.bit === IS_UNDERLINE && isWordCell(cells[i - 1])) {
        for (const j of regionOf(cells, i, IS_UNDERLINE, 1)) cells[j]!.f &= ~IS_UNDERLINE;
        fixed = true;
      } else if (!last.open && last.bit === IS_UNDERLINE && isWordCell(cells[i])) {
        for (const j of regionOf(cells, i - 1, IS_UNDERLINE, -1)) cells[j]!.f &= ~IS_UNDERLINE;
        fixed = true;
      } else if (here.some((e) => e.open && e.bit === IS_ITALIC) && isBlankCell(cells[i])) {
        // `*` never opens before a blank — a reopened italic can meet one.
        for (let j = i; isBlankCell(cells[j]) && (cells[j]!.f & IS_ITALIC) !== 0; j += 1) cells[j]!.f &= ~IS_ITALIC;
        fixed = true;
      } else if (here.some((e) => !e.open && e.bit === IS_ITALIC) && isBlankCell(cells[i - 1])) {
        // …nor closes after one.
        for (let j = i - 1; isBlankCell(cells[j]) && (cells[j]!.f & IS_ITALIC) !== 0; j -= 1) cells[j]!.f &= ~IS_ITALIC;
        fixed = true;
      } else {
        for (let e = 1; e < here.length; e += 1) {
          const a = here[e - 1]!;
          const b = here[e]!;
          if (!a.open && b.open && a.bit & STAR_MARKS && b.bit & STAR_MARKS) {
            for (const j of regionOf(cells, i, b.bit, 1)) cells[j]!.f &= ~b.bit;
            fixed = true;
            break;
          }
        }
      }
    }
    if (!fixed) return events;
  }
  return planEvents(cells);
}

/**
 * Fit an element's text nodes to {@link planMarks}, so the editor never
 * shows a mark the message will not have (an underline glued to a word, a
 * `*` mark that would run into another, emphasis on nothing but blanks).
 * Only marks a node loses on EVERY non-blank character come off it: blanks
 * at the edge of a marked word are the writer's business (it puts them
 * outside the delimiters) and stay as they are shown.
 */
export function $fitMarks(element: ElementNode): void {
  const cells: Cell[] = [];
  const owners: { node: LexicalNode; from: number; to: number }[] = [];
  for (const child of element.getChildren()) {
    const from = cells.length;
    if ($isLineBreakNode(child)) cells.push({ c: 'br', f: 0 });
    else if ($isMentionNode(child) || $isChannelMentionNode(child)) cells.push({ c: 'mention', id: '', f: 0 });
    else if ($isLinkNode(child)) cells.push({ c: 'link', s: child.getTextContent(), href: child.getURL(), f: $linkMarks(child) });
    else if ($isTextNode(child)) {
      const format = child.getFormat();
      const f = format & MARK_BITS;
      if (format & IS_CODE) cells.push({ c: 'code', s: child.getTextContent(), f });
      else for (const ch of child.getTextContent()) cells.push(ch === '\n' ? { c: 'br', f: 0 } : { c: 'ch', ch, f });
    } else cells.push({ c: 'ch', ch: ' ', f: 0 });
    owners.push({ node: child, from, to: cells.length });
  }
  planMarks(cells);
  for (const { node, from, to } of owners) {
    if (!$isTextNode(node) && !$isLinkNode(node)) continue;
    const had = $isLinkNode(node) ? $linkMarks(node) : node.getFormat() & MARK_BITS;
    if (had === 0) continue;
    // A node of blanks keeps what its blanks keep (`** **` is not bold
    // anywhere, but the blank between two bold words is bold).
    let kept = 0;
    let blanks = MARK_BITS;
    let any = false;
    for (let i = from; i < to; i += 1) {
      const cell = cells[i]!;
      if (cell.c === 'br' || (cell.c === 'ch' && BLANK.test(cell.ch))) {
        blanks &= cell.f;
        continue;
      }
      kept |= cell.f;
      any = true;
    }
    const lost = had & ~(any ? kept : blanks);
    if (lost === 0) continue;
    if ($isLinkNode(node)) {
      for (const t of node.getChildren()) if ($isTextNode(t)) t.setFormat(t.getFormat() & ~lost);
    } else node.setFormat(node.getFormat() & ~lost);
  }
}

/** True when the literal text just before cell `i` ends inside a bare URL. */
function endsInUrl(cells: readonly Cell[], i: number): boolean {
  let before = '';
  for (let j = i - 1; j >= 0; j -= 1) {
    const cell = cells[j]!;
    if (cell.c !== 'ch') break;
    before = cell.ch + before;
  }
  return URL_AT_END.test(before);
}

/** Cells → the comparable shape. */
function inlineOfCells(cells: readonly Cell[]): NInline[] {
  const b = new InlineBuilder();
  for (const cell of cells) {
    switch (cell.c) {
      case 'ch':
        b.text(cell.ch, cell.f);
        break;
      case 'br':
        b.text('\n', 0);
        break;
      case 'code':
        b.push({ k: 'code', s: cell.s, f: cell.f });
        break;
      case 'link':
        b.push({ k: 'link', s: cell.s, href: cell.href, f: cell.f });
        break;
      case 'mention':
      case 'channel':
        b.push({ k: cell.c, id: cell.id });
        break;
    }
  }
  return b.out;
}

// ---------------------------------------------------------------------------
// The expected render of the editor's tree
// ---------------------------------------------------------------------------

/** The timeline's task marker at the head of an item (`- [ ] `, `- [x] `). */
const TASK_MARKER = /^\[([ xX])\] +/;

/** The top-level blocks that will be exported (trailing empties dropped). */
function $exportableBlocks(root: ElementNode): LexicalNode[] {
  const blocks = root.getChildren();
  let end = blocks.length;
  while (end > 0 && $isBlankBlock(blocks[end - 1]!)) end -= 1;
  return blocks.slice(0, end);
}

function $isBlankBlock(node: LexicalNode): boolean {
  if ($isCodeNode(node)) return false;
  if ($isListNode(node)) return $listItemsOf(node).every((item) => item.getTextContent().trim() === '' && !$hasAtom(item));
  if ($isElementNode(node)) return node.getTextContent().trim() === '' && !$hasAtom(node);
  return false;
}

/** Mentions are content even though their text is not typed. */
function $hasAtom(element: ElementNode): boolean {
  return element.getChildren().some(
    (c) => $isMentionNode(c) || $isChannelMentionNode(c) || ($isElementNode(c) && $hasAtom(c)),
  );
}

/** A list's items, flattened (a nested list's items follow their parent's). */
function $listItemsOf(list: ListNode): ListItemNode[] {
  const out: ListItemNode[] = [];
  for (const child of list.getChildren()) {
    if (!$isListItemNode(child)) continue;
    const nested = child.getChildren().filter($isListNode);
    if (!(nested.length > 0 && nested.length === child.getChildrenSize())) out.push(child);
    for (const n of nested) out.push(...$listItemsOf(n));
  }
  return out;
}

/** List items to export: a trailing blank item in the LAST block is dropped. */
function $exportItems(list: ListNode, isLast: boolean): ListItemNode[] {
  const items = $listItemsOf(list);
  if (!isLast) return items;
  let end = items.length;
  while (end > 0 && items[end - 1]!.getTextContent().trim() === '' && !$hasAtom(items[end - 1]!)) end -= 1;
  return items.slice(0, end);
}

/** An element's runs as the timeline will draw them (marks fitted). */
function inlineOf(runs: readonly Run[], brText: string | null): NInline[] {
  const cells = cellsOf(runs, brText);
  planMarks(cells);
  return inlineOfCells(cells);
}

/**
 * What the timeline will draw for the editor's current tree — the oracle the
 * exporter checks itself against, and the conformance suite's expectation.
 */
export function $expectedBlocks(root: ElementNode = $getRoot()): NBlock[] {
  const out: NBlock[] = [];
  let para: InlineBuilder | null = null;
  let paraLines = 0;
  let prev: LexicalNode | null = null;
  const flushPara = () => {
    if (para === null) return;
    // One empty line is no block at all; anything more is text.
    if (!(paraLines === 1 && para.out.length === 0)) out.push({ k: 'inline', n: para.out });
    para = null;
    paraLines = 0;
  };
  const addParagraphText = (n: readonly NInline[]) => {
    if (para === null) para = new InlineBuilder();
    else para.text('\n');
    for (const node of n) para.push(node);
    paraLines += 1;
  };
  const blocks = $exportableBlocks(root);
  blocks.forEach((block, index) => {
    const isLast = index === blocks.length - 1;
    const before = prev;
    prev = block;
    if ($isParagraphNode(block)) {
      addParagraphText(inlineOf($runsOf(block), null));
      return;
    }
    if (!$isHeadingNode(block) && !$isQuoteNode(block) && !$isListNode(block) && !$isCodeNode(block)) {
      // Anything else a paste slipped in reads as its text.
      const text = block.getTextContent();
      addParagraphText(text === '' ? [] : [{ k: 'text', s: text, f: 0 }]);
      return;
    }
    flushPara();
    const last = out[out.length - 1];
    if ($isHeadingNode(block)) {
      const level = Number(block.getTag().slice(1));
      out.push({ k: 'heading', level, n: inlineOf(trimLeadingBlanks($runsOf(block)), ' ') });
    } else if ($isQuoteNode(block)) {
      const n = inlineOf($runsOf(block), null);
      // Directly adjacent quotes are one quote (the timeline groups `>` lines).
      if ($isQuoteNode(before) && last && last.k === 'quote') {
        const b = new InlineBuilder();
        for (const node of last.n) b.push(node);
        b.text('\n');
        for (const node of n) b.push(node);
        out[out.length - 1] = { k: 'quote', n: b.out };
      } else out.push({ k: 'quote', n });
    } else if ($isListNode(block)) {
      const items = $exportItems(block, isLast);
      if (items.length === 0) return;
      const type = block.getListType();
      const nItems = items.map((item): NItem => {
        const n = inlineOf(trimLeadingBlanks($runsOf(item)), ' ');
        if (type === 'check') return { task: item.getChecked() === true, n };
        const first = n[0];
        const task = first && first.k === 'text' && first.f === 0 ? TASK_MARKER.exec(first.s) : null;
        if (task && first && first.k === 'text') {
          first.s = first.s.slice(task[0].length);
          if (first.s === '') n.shift();
          return { task: task[1] !== ' ', n };
        }
        return { task: null, n };
      });
      // Directly adjacent runs of the same kind (bullet/task vs numbered)
      // are ONE list in the timeline.
      if ($isListNode(before) && before.getListType() === type && last && last.k === 'list') {
        last.items.push(...nItems);
        return;
      }
      out.push({ k: 'list', ordered: type === 'number', start: type === 'number' ? block.getStart() : 1, items: nItems });
    } else if ($isCodeNode(block)) {
      out.push({ k: 'code', text: block.getTextContent(), lang: fenceLanguage(block.getLanguage() ?? '') });
    }
  });
  flushPara();
  return out;
}

/** The fence info the timeline keeps (its `fenceLanguage`). */
function fenceLanguage(info: string): string | null {
  const first = info.trim().split(/\s+/)[0] ?? '';
  if (first === '') return null;
  const safe = first.replace(/[^A-Za-z0-9#+._-]/g, '').slice(0, 32);
  return safe === '' ? null : safe;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** Characters that can open or close an inline span, a link or a token —
 * `!` included: a literal `!` right before a link would otherwise post as an
 * IMAGE (`![label](https://…)`). */
const INLINE_CANDIDATES = '\\`*_~[<#!';
/** Characters that open a block at the start of a paragraph line. */
const LINE_START_CANDIDATES = '>-+';

class Writer {
  s = '';
  /** Offsets of characters the author typed literally (escape candidates). */
  readonly literal: number[] = [];
  /** Offsets inside a top-level paragraph (block markers matter there). */
  readonly paragraph = new Set<number>();
  /** Literal offsets that must NOT be escaped (a task marker the author typed). */
  readonly keep = new Set<number>();

  raw(text: string): void {
    this.s += text;
  }

  /** Literal text; a raw newline in it (a paste can hold one) is a line break. */
  lit(text: string, inParagraph: boolean, br = '\n'): void {
    const lines = text.split('\n');
    if (lines.length > 1) {
      lines.forEach((line, i) => {
        if (i > 0) this.raw(br);
        this.lit(line, inParagraph, br);
      });
      return;
    }
    for (const ch of text) {
      const at = this.s.length;
      this.literal.push(at);
      if (inParagraph) this.paragraph.add(at);
      this.s += ch;
    }
  }
}

/**
 * A list item's or heading's leading blanks belong to its marker in the
 * timeline's grammar (`- +`, `# +`) — they never post, so they never write.
 */
function trimLeadingBlanks(runs: readonly Run[]): Run[] {
  const out = [...runs];
  while (out.length > 0) {
    const first = out[0]!;
    if (first.t !== 'text' || first.code) break;
    const s = first.s.replace(/^[ \t]+/, '');
    if (s === '') {
      out.shift();
      continue;
    }
    out[0] = { ...first, s };
    break;
  }
  return out;
}

/** A task marker typed into an ordinary item posts in its one spelling. */
function canonicalTask(runs: readonly Run[]): Run[] {
  const first = runs[0];
  if (!first || first.t !== 'text' || first.f !== 0 || first.code) return [...runs];
  const m = TASK_MARKER.exec(first.s);
  if (!m) return [...runs];
  const rest = first.s.slice(m[0].length);
  // The marker's blanks run on into the next span's (`[ ]   **x**`).
  const tail = rest === '' ? trimLeadingBlanks(runs.slice(1)) : runs.slice(1);
  return [{ ...first, s: `[${m[1]}] ${rest}` }, ...tail];
}

/**
 * Write an element's runs: the SAME cells and mark plan the oracle reads
 * ({@link planMarks}), so what posts is what `$expectedBlocks` says it is.
 * Literal characters go through `lit` (escape candidates); delimiters, code
 * spans, links and mentions are written raw.
 */
function writeRuns(w: Writer, runs: readonly Run[], opts: { paragraph: boolean; br: string; brText: string | null; keepTask?: boolean }): void {
  let keep = 0;
  const first = runs[0];
  if (opts.keepTask && first && first.t === 'text' && first.f === 0 && !first.code) {
    keep = TASK_MARKER.exec(first.s)?.[0].length ?? 0;
  }
  const cells = cellsOf(runs, opts.brText, keep);
  const events = planMarks(cells);
  cells.forEach((cell, i) => {
    for (const e of events[i]!) w.raw(MARK_DELIMITER[e.bit]!);
    switch (cell.c) {
      case 'ch': {
        const at = w.s.length;
        w.lit(cell.ch, opts.paragraph, opts.br);
        if (cell.keep) w.keep.add(at);
        break;
      }
      case 'br':
        w.raw(opts.br);
        break;
      case 'code':
        w.raw('`' + cell.s + '`');
        break;
      case 'link':
        w.raw(`[${cell.s}](${cell.href})`);
        break;
      case 'mention':
        w.raw(mentionToken(cell.id));
        break;
      case 'channel':
        w.raw(channelToken(cell.id));
        break;
    }
  });
  for (const e of events[cells.length]!) w.raw(MARK_DELIMITER[e.bit]!);
}

/** The longest backtick fence line inside a code body, plus one (min 3). */
function fenceFor(body: string): string {
  let longest = 2;
  for (const line of body.split('\n')) {
    const m = /^ {0,3}(`{3,})[ \t]*$/.exec(line);
    if (m) longest = Math.max(longest, m[1]!.length);
  }
  return '`'.repeat(longest + 1);
}

/** The unescaped wire text, with its escape candidates. */
function $write(root: ElementNode): Writer {
  const w = new Writer();
  const blocks = $exportableBlocks(root);
  let first = true;
  const line = () => {
    if (!first) w.raw('\n');
    first = false;
  };
  blocks.forEach((block, index) => {
    const isLast = index === blocks.length - 1;
    if ($isParagraphNode(block)) {
      line();
      writeRuns(w, $runsOf(block), { paragraph: true, br: '\n', brText: null });
    } else if ($isHeadingNode(block)) {
      line();
      w.raw('#'.repeat(Number(block.getTag().slice(1))) + ' ');
      writeRuns(w, trimLeadingBlanks($runsOf(block)), { paragraph: false, br: ' ', brText: ' ' });
    } else if ($isQuoteNode(block)) {
      line();
      w.raw('> ');
      writeRuns(w, $runsOf(block), { paragraph: false, br: '\n> ', brText: null });
    } else if ($isListNode(block)) {
      const items = $exportItems(block, isLast);
      const type = block.getListType();
      // A task list and a bullet list side by side would read as ONE list in
      // the timeline; a blank line (which it does not draw) keeps them two.
      const before = index > 0 ? blocks[index - 1] : null;
      if (items.length > 0 && $isListNode(before) && before.getListType() !== type && type !== 'number' && before.getListType() !== 'number') w.raw('\n');
      items.forEach((item, i) => {
        line();
        if (type === 'number') w.raw(`${block.getStart() + i}. `);
        else if (type === 'check') w.raw(`- [${item.getChecked() ? 'x' : ' '}] `);
        else w.raw('- ');
        const runs = trimLeadingBlanks($runsOf(item));
        writeRuns(w, type === 'check' ? runs : canonicalTask(runs), { paragraph: false, br: ' ', brText: ' ', keepTask: type !== 'check' });
      });
    } else if ($isCodeNode(block)) {
      line();
      const body = block.getTextContent();
      const fence = fenceFor(body);
      w.raw(`${fence}${fenceLanguage(block.getLanguage() ?? '') ?? ''}\n${body === '' ? '' : `${body}\n`}${fence}`);
    } else if ($isElementNode(block) || $isDecoratorNode(block)) {
      line();
      w.lit(block.getTextContent(), true);
    }
  });
  return w;
}

/** A bare URL is a link in the timeline: never escape inside one. */
const BARE_URL = /https?:\/\/(?:[^\s<*~`\\]|\\(?![!-/:-@[-`{-~]))+/g;

function candidatesOf(w: Writer, sparingUrls: boolean): number[] {
  const literal = new Set(w.literal);
  const inUrl = new Set<number>();
  if (sparingUrls) {
    // A URL the author typed as text is linked by the timeline as it stands:
    // an escape inside it would become part of the link. Only a run that
    // starts in literal text, and only as far as the literal text goes.
    const offsets = [...literal].sort((a, b) => a - b);
    for (let i = 0; i < offsets.length; ) {
      let j = i;
      while (j + 1 < offsets.length && offsets[j + 1] === offsets[j]! + 1) j += 1;
      const start = offsets[i]!;
      for (const m of w.s.slice(start, offsets[j]! + 1).matchAll(BARE_URL)) {
        // (The character that ends it can be escaped: a backslash escape
        // ends a bare URL, so it cannot extend the link.)
        for (let k = 0; k < m[0].length; k += 1) inUrl.add(start + m.index! + k);
      }
      i = j + 1;
    }
  }
  const out: number[] = [];
  for (const at of w.literal) {
    if (inUrl.has(at) || w.keep.has(at)) continue;
    const ch = w.s[at]!;
    if (INLINE_CANDIDATES.includes(ch)) {
      out.push(at);
      continue;
    }
    if (!w.paragraph.has(at)) continue;
    const lineStart = w.s.lastIndexOf('\n', at - 1) + 1;
    const prefix = w.s.slice(lineStart, at);
    if (LINE_START_CANDIDATES.includes(ch) && /^ {0,3}$/.test(prefix)) out.push(at);
    else if ('.)'.includes(ch) && /^ {0,3}\d{1,9}$/.test(prefix)) out.push(at);
  }
  return out;
}

function withEscapes(s: string, escaped: ReadonlySet<number>): string {
  if (escaped.size === 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    if (escaped.has(i)) out += '\\';
    out += s[i];
  }
  return out;
}

export function sameBlocks(a: readonly NBlock[], b: readonly NBlock[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The editor's content as the Markdown the timeline will draw identically.
 * Must run inside a read or update.
 */
export function $exportComposerMarkdown(root: ElementNode = $getRoot()): string {
  const w = $write(root);
  const plain = w.s;
  const sparing = candidatesOf(w, true);
  if (sparing.length === 0 && candidatesOf(w, false).length === 0) return plain;
  const expected = $expectedBlocks(root);
  if (sameBlocks(timelineBlocks(plain), expected)) return plain;
  for (const candidates of [sparing, candidatesOf(w, false)]) {
    const escaped = new Set(candidates);
    if (!sameBlocks(timelineBlocks(withEscapes(plain, escaped)), expected)) continue;
    // Minimise: an escape stays only if the parse needs it.
    for (const at of candidates) {
      escaped.delete(at);
      if (!sameBlocks(timelineBlocks(withEscapes(plain, escaped)), expected)) escaped.add(at);
    }
    return withEscapes(plain, escaped);
  }
  // Unreachable for a tree the plugin has normalised (the fuzz suite pins
  // it); the fully escaped text is the closest the grammar allows.
  return withEscapes(plain, new Set(candidatesOf(w, false)));
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

function appendText(parent: ElementNode, text: string, format: number): void {
  const lines = text.split('\n');
  lines.forEach((part, i) => {
    if (i > 0) parent.append($createLineBreakNode());
    if (part === '') return;
    const node = $createTextNode(part);
    if (format) node.setFormat(format);
    parent.append(node);
  });
}

function appendInline(parent: ElementNode, nodes: readonly InlineNode[], f = 0): void {
  for (const node of nodes) {
    if (isEmphasisNode(node)) {
      // Nested emphasis loads as combined marks: `~~**x**~~` is one text
      // node, bold and struck.
      appendInline(parent, node.children, f | EMPHASIS_BIT[node.type]);
      continue;
    }
    switch (node.type) {
      case 'text':
        appendText(parent, node.text, f);
        break;
      case 'mention':
        parent.append($createMentionNode(node.userId));
        break;
      case 'channel':
        parent.append($createChannelMentionNode(node.channelId));
        break;
      case 'code':
        appendText(parent, node.text, IS_CODE | f);
        break;
      case 'image':
      case 'timestamp':
        // Held as its markup, exactly as typed (see the module comment).
        appendText(parent, node.source, f);
        break;
      case 'link': {
        // An autolink is text the timeline links on its own; a refused
        // target is only its label there — hold exactly that.
        // A label that runs across lines cannot be a composer link either.
        if (node.text === node.href || !isOpenableLinkHref(node.href) || node.text.includes('\n')) {
          appendText(parent, node.text, f);
          break;
        }
        const link = $createLinkNode(node.href);
        const label = $createTextNode(node.text);
        if (f) label.setFormat(f);
        link.append(label);
        parent.append(link);
        break;
      }
    }
  }
}

/** The Lexical blocks for `markdown`, read with the timeline's grammar. */
export function $markdownToNodes(markdown: string): ElementNode[] {
  const out: ElementNode[] = [];
  for (const block of parseMarkdownBlocks(markdown.replace(/\r\n?/g, '\n'))) {
    switch (block.type) {
      case 'inline': {
        // One paragraph per line, as Shift+Enter makes them.
        const p = $createParagraphNode();
        appendInline(p, block.nodes);
        let line = $createParagraphNode();
        out.push(line);
        for (const child of p.getChildren()) {
          if ($isLineBreakNode(child)) {
            child.remove();
            line = $createParagraphNode();
            out.push(line);
          } else line.append(child);
        }
        break;
      }
      case 'heading': {
        const h = $createChatHeadingNode(`h${block.level}` as HeadingTagType);
        appendInline(h, block.nodes);
        out.push(h);
        break;
      }
      case 'blockquote': {
        const q = $createQuoteNode();
        appendInline(q, block.nodes);
        out.push(q);
        break;
      }
      case 'list': {
        const check = !block.ordered && block.items.length > 0 && block.items.every((i) => i.task !== null);
        const list = $createListNode(check ? 'check' : block.ordered ? 'number' : 'bullet', block.ordered ? block.start : 1);
        for (const item of block.items) {
          const li = $createListItemNode(check ? item.task?.checked === true : undefined);
          // A task in a mixed list keeps its marker as text (it re-posts as
          // the same task); only an all-task list is a check list.
          if (!check && item.task) li.append($createTextNode(item.task.checked ? '[x] ' : '[ ] '));
          appendInline(li, item.nodes);
          list.append(li);
        }
        out.push(list);
        break;
      }
      case 'code-block': {
        const code = $createCodeNode(block.lang ?? undefined);
        appendText(code, block.text, 0);
        out.push(code);
        break;
      }
    }
  }
  return out;
}

/** Replace the editor's content with `markdown`. Inside an update. */
export function $importComposerMarkdown(markdown: string, root: ElementNode = $getRoot()): void {
  root.clear();
  const nodes = $markdownToNodes(markdown);
  if (nodes.length === 0) root.append($createParagraphNode());
  else root.append(...nodes);
}

