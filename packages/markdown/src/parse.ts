/**
 * @cytale/markdown — inline message markdown parser (plan 004 M6).
 *
 * The renderer-agnostic half of the web app's inline markdown display path,
 * extracted from `apps/web/src/features/messages/markdown.tsx` so both
 * clients share ONE parse tree (plan 004 M6: "the parse tree stays identical
 * across clients"). This module has no DOM and no React:
 *
 *   **bold**  *italic*  __underline__  ~~strike~~  `code`  [text](url)
 *   ![alt](https://image.url)  <@snowflake>  <#snowflake>  https://bare.url
 *   <https://angle.url>  <t:unix>  <t:unix:R>
 *
 * Line breaks survive as `text` nodes. BOTH levels live in this module, and
 * both are in scope: the inline parser returns {@link InlineNode} values
 * (`text`, `mention`, `channel`, `timestamp`, `code`, `link`, `image`, and the four
 * emphasis kinds `bold`, `italic`, `underline`, `strike`), and the block
 * parser below —
 * {@link parseMarkdownBlocks} — returns {@link MarkdownBlock} values and
 * recognizes fenced code blocks (`code-block`, carrying its `lang`), ATX
 * headings (`heading`, levels 1-6), blockquotes (`blockquote`, from `> ` runs
 * and from `>>>` to the end), and bullet, ordered, and task lists (`list`,
 * with `MarkdownListItem.task`). Headings, lists, and fences are NOT out of
 * scope and never fall back to plain text here.
 *
 * ## Emphasis nests, as Discord's does
 *
 * An emphasis node carries `children` — the inline parse of its content — so
 * `~~**x**~~` is bold inside strikethrough, `***x***` is bold inside italic,
 * and `__*~~**all**~~*__` is all four at once. The rules are Discord's
 * (simple-markdown's `strong`/`em`/`u`/`del`), with CommonMark's escape rule:
 *
 *   - `**x**`  bold: the FIRST `**` not followed by another `*` closes it;
 *   - `*x*`    italic: opens only before a non-blank, never closes after a
 *              blank, may hold `**…**`, and closes on a `*` not followed by
 *              another; where both could open, the LONGER match wins, and
 *              on a tie italic wins — so `***x***` is italic(bold(x));
 *   - `__x__`  underline: between non-word characters only, so
 *              `snake__case__` stays literal (our rule; Discord underlines it);
 *   - `~~x~~`  strikethrough: the first `~~` not followed by another `~`.
 *
 * A marker that never closes is literal text (`2 * 3`, `**open`). Searching
 * for a closer steps OVER opaque tokens — backslash escapes, code spans,
 * links, angle autolinks, mentions — so `**a \** b**` and ``**`**`**`` are
 * one bold span each. A bare URL is NOT opaque to that search:
 * `__https://x.dev__` underlines the link. Code spans and link labels stay opaque: their content
 * is never parsed.
 *
 * ## Images
 *
 * `![alt](https://…)` is an `image` node: CommonMark's inline image, with an
 * `http`/`https` source only (the one kind a client can load — through the
 * server's media proxy, never directly). The alt text is kept (escapes read
 * as their characters) and an optional `"title"` after ONE space is carried;
 * the node keeps its exact `source` text too, for a renderer that shows the
 * markup literally (the composer). Any other source — `![x](file.png)`,
 * `![x](javascript:…)` — is not an image: the `!` stays text and the rest
 * parses as the link it always was.
 *
 * ## Timestamps
 *
 * `<t:UNIX>` and `<t:UNIX:STYLE>` are Discord's timestamp tag: a `timestamp`
 * node carrying the instant (seconds) and the style (`t T d D f F R`, `f` when
 * none is named) — see `timestamp.ts` for the styles and their formatting.
 * An unknown style letter, or an instant a `Date` cannot hold, is not a tag:
 * it stays text. The node keeps its exact `source` for the composer, which
 * holds the tag as typed.
 *
 * Token precedence at any position: escape, mention, channel, timestamp,
 * angle autolink, code, image, link, bare URL, then emphasis. A bare URL ends at a blank, `<`, `*`,
 * `~`, a backtick (GitHub's rule) or a backslash escape, so
 * `https://x.dev**b**` is the link followed by bold `b`.
 *
 * Safety: this is a *parser*, not an HTML emitter. A node's payload is the
 * raw (untrusted) substring; each renderer escapes or escapes-by-construction
 * at its own boundary (web escapes text nodes into React; React Native's
 * <Text> has no markup to inject into). The tree can therefore never carry
 * markup semantics by accident.
 */

import {
  DEFAULT_TIMESTAMP_STYLE,
  isValidUnixSeconds,
  timestampPlainText,
  type TimestampNode,
  type TimestampStyle,
} from './timestamp.js';

/** Resolves a mention snowflake to a display name; undefined leaves the id. */
export type MentionResolver = (userId: string) => string | undefined;

/** Resolves a channel snowflake to its name; undefined leaves the id. */
export type ChannelResolver = (channelId: string) => string | undefined;

/** The four emphasis kinds; each nests any inline content, itself included. */
export type EmphasisType = 'bold' | 'italic' | 'underline' | 'strike';

/** An emphasis span: its parsed content, and that content as plain text. */
export interface EmphasisNode {
  readonly type: EmphasisType;
  /**
   * The span's text as a reader sees it — its children's text, markup gone
   * (mention and channel tokens stay tokens, as {@link previewText} keeps
   * them). A renderer that cannot nest can fall back to it.
   */
  readonly text: string;
  readonly children: InlineNode[];
}

/**
 * One inline token. `text` is the display text (mentions carry the bare
 * snowflake instead); `href` is the link target.
 */
export type InlineNode =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'mention'; readonly userId: string }
  | { readonly type: 'channel'; readonly channelId: string }
  | TimestampNode
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'link'; readonly text: string; readonly href: string }
  | ImageNode
  | EmphasisNode;

/**
 * `![alt](src "title")` — an inline image. `src` is always `http(s)`; `alt`
 * is the display alt text (escapes resolved; may be empty); `title` is null
 * when absent; `source` is the exact markup it was parsed from.
 */
export interface ImageNode {
  readonly type: 'image';
  readonly alt: string;
  readonly src: string;
  readonly title: string | null;
  readonly source: string;
}

/** The node kinds, in the parser's precedence order. */
export const INLINE_NODE_TYPES = [
  'mention',
  'channel',
  'timestamp',
  'code',
  'image',
  'link',
  'italic',
  'bold',
  'underline',
  'strike',
  'text',
] as const;

/** True for the four emphasis kinds (the nodes that carry `children`). */
export function isEmphasisNode(node: InlineNode): node is EmphasisNode {
  return node.type === 'bold' || node.type === 'italic' || node.type === 'underline' || node.type === 'strike';
}

// ---------------------------------------------------------------------------
// Opaque tokens: matched at a position, never parsed inside
// ---------------------------------------------------------------------------

/**
 * A backslash-escaped ASCII punctuation character renders as the character
 * itself (CommonMark's rule, and Discord's). The full punctuation set, not
 * only the inline delimiters: `1\. not a list`, `\- not a bullet` and
 * `\+ not a bullet` are how an author — and the web composer, which escapes
 * literal text it would otherwise post as structure — keeps a line-start
 * marker literal.
 */
const ESCAPE_AT = /\\([!-/:-@[-`{-~])/y;
const MENTION_AT = /<@(\d{1,19})>/y;
/** Discord's channel token: `<#id>` names a channel by id, never by name. */
const CHANNEL_AT = /<#(\d{1,19})>/y;
/** Discord's timestamp tag: `<t:1791328800>` or `<t:1791328800:R>`. */
const TIMESTAMP_AT = /<t:(-?\d{1,13})(?::([tTdDfFR]))?>/y;
/** `<https://…>` — the angle form links the URL verbatim. */
const ANGLE_AUTOLINK_AT = /<(https?:\/\/[^>\s]+)>/y;
const CODE_AT = /`([^`]+)`/y;
const LINK_AT = /\[([^\]]+)\]\(([^)\s]+)\)/y;
/**
 * `![alt](https://src)` or `![alt](https://src "title")`: the alt may be
 * empty and may hold backslash escapes (never a bare bracket or a newline);
 * the title follows exactly one space. Kept in step with the server's
 * `Cytale.MediaProxy` scan, which mints each source's proxy URL.
 */
const IMAGE_AT = /!\[((?:[^[\]\\\n]|\\[^\n])*)\]\((https?:\/\/[^)\s]+)(?: "([^"\n]*)")?\)/y;
/**
 * A bare URL runs to a blank or `<` — and, as on GitHub, stops before `*`,
 * `~` and a backtick, so markup glued to its end is markup
 * (`https://x.dev**b**`). It also stops before a backslash ESCAPE (a
 * backslash before punctuation), so `https://x.dev\*` is the link and a
 * literal star; any other backslash stays in. Its trailing sentence
 * punctuation is split off by {@link splitAutolinkTail}.
 */
const BARE_AUTOLINK_AT = /https?:\/\/(?:[^\s<*~`\\]|\\(?![!-/:-@[-`{-~]))+/y;

type Opaque = { readonly end: number; readonly nodes: InlineNode[] };

function sticky(re: RegExp, text: string, at: number): RegExpExecArray | null {
  re.lastIndex = at;
  return re.exec(text);
}

/** What a bare URL never ends on: it belongs to the sentence (or markup) around it. */
const TAIL_PUNCTUATION = '.,;:!?\'"_';

/** Split a bare URL from the sentence punctuation that follows it. */
function splitAutolinkTail(token: string): { href: string; tail: string } {
  let end = token.length;
  // "see https://x.dev." links the URL, not the full stop; a URL in quotes
  // leaves the closing quote out (Discord and GitHub both do); and trailing
  // underscores are GitHub's too, so `__https://x.dev__` underlines the link
  // instead of swallowing its own closing delimiter.
  while (end > 0 && TAIL_PUNCTUATION.includes(token[end - 1]!)) end -= 1;
  // An unbalanced closing paren belongs to the sentence too (CommonMark's
  // rule) — BALANCED parens stay in, which is why a Wikipedia link keeps its
  // `(y)`.
  const balance = (t: string) => (t.match(/\)/g)?.length ?? 0) - (t.match(/\(/g)?.length ?? 0);
  while (end > 0 && token[end - 1] === ')' && balance(token.slice(0, end)) > 0) {
    end -= 1;
    while (end > 0 && TAIL_PUNCTUATION.includes(token[end - 1]!)) end -= 1;
  }
  return { href: token.slice(0, end), tail: token.slice(end) };
}

/**
 * The opaque token at `at`, if one starts there. `urls: false` leaves bare
 * URLs out: a span's closer is found through one (`__https://x.dev__` is an
 * underlined link — GitHub and Discord both close emphasis there), while
 * code spans, links and escapes still hide their delimiters.
 */
function opaqueAt(text: string, at: number, urls = true): Opaque | null {
  const ch = text[at];
  if (ch === '\\') {
    const m = sticky(ESCAPE_AT, text, at);
    if (m) return { end: at + 2, nodes: [{ type: 'text', text: m[1]! }] };
    return null;
  }
  if (ch === '<') {
    let m = sticky(MENTION_AT, text, at);
    if (m) return { end: at + m[0].length, nodes: [{ type: 'mention', userId: m[1]! }] };
    m = sticky(CHANNEL_AT, text, at);
    if (m) return { end: at + m[0].length, nodes: [{ type: 'channel', channelId: m[1]! }] };
    m = sticky(TIMESTAMP_AT, text, at);
    if (m && isValidUnixSeconds(Number(m[1]))) {
      const style = (m[2] ?? DEFAULT_TIMESTAMP_STYLE) as TimestampStyle;
      return { end: at + m[0].length, nodes: [{ type: 'timestamp', unix: Number(m[1]), style, source: m[0] }] };
    }
    m = sticky(ANGLE_AUTOLINK_AT, text, at);
    if (m) return { end: at + m[0].length, nodes: [{ type: 'link', text: m[1]!, href: m[1]! }] };
    return null;
  }
  if (ch === '!') {
    const m = sticky(IMAGE_AT, text, at);
    if (m) {
      const alt = m[1]!.replace(/\\([!-/:-@[-`{-~])/g, '$1');
      return { end: at + m[0].length, nodes: [{ type: 'image', alt, src: m[2]!, title: m[3] ?? null, source: m[0] }] };
    }
    return null;
  }
  if (ch === '`') {
    const m = sticky(CODE_AT, text, at);
    if (m) return { end: at + m[0].length, nodes: [{ type: 'code', text: m[1]! }] };
    return null;
  }
  if (ch === '[') {
    const m = sticky(LINK_AT, text, at);
    if (m) return { end: at + m[0].length, nodes: [{ type: 'link', text: m[1]!, href: m[2]! }] };
    return null;
  }
  if (ch === 'h' && urls) {
    const m = sticky(BARE_AUTOLINK_AT, text, at);
    if (m) {
      // The tail belongs to the sentence: the gap after the link reads it.
      const { href } = splitAutolinkTail(m[0]);
      if (!/^https?:\/\/./.test(href)) return null;
      return { end: at + href.length, nodes: [{ type: 'link', text: href, href }] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Emphasis
// ---------------------------------------------------------------------------

const WORD = /[\p{L}\p{N}_]/u;
const BLANK = /\s/;

/** Advance over one unit of span content: an opaque token or a character. */
function stepOver(text: string, at: number): number {
  const opaque = opaqueAt(text, at, false);
  return opaque ? opaque.end : at + 1;
}

/**
 * `**x**`: the first `**` (after at least one unit of content) that is not
 * followed by a third `*`. Returns the index of the closer, or -1.
 */
function strongCloser(text: string, open: number): number {
  let at = stepOver(text, open + 2);
  while (at < text.length) {
    if (text.startsWith('**', at) && text[at + 2] !== '*') return at;
    at = stepOver(text, at);
  }
  return -1;
}

/**
 * `*x*` (simple-markdown's `em`, with opaque tokens as units): content opens
 * on a non-blank, and is a run of `**`, escapes/opaque tokens, blanks that
 * are followed by content, and non-star characters; it closes on a `*` not
 * followed by another.
 */
function emCloser(text: string, open: number): number {
  const first = text[open + 1];
  if (first === undefined || BLANK.test(first)) return -1;
  let at = open + 1;
  let units = 0;
  for (;;) {
    if (units > 0 && text[at] === '*' && text[at + 1] !== '*') return at;
    if (at >= text.length) return -1;
    if (text.startsWith('**', at)) {
      at += 2;
    } else if (BLANK.test(text[at]!)) {
      let end = at;
      while (end < text.length && BLANK.test(text[end]!)) end += 1;
      if (end >= text.length) return -1;
      if (text[end] === '*' && !text.startsWith('**', end)) return -1;
      at = end;
      continue; // the blank run is part of the unit that follows it
    } else if (text[at] === '*') {
      return -1;
    } else {
      at = stepOver(text, at);
    }
    units += 1;
  }
}

/** `__x__` between non-word characters; `(?!_)` on both delimiters. */
function underlineCloser(text: string, open: number): number {
  if (open > 0 && WORD.test(text[open - 1]!)) return -1;
  if (text[open + 2] === '_') return -1;
  let at = stepOver(text, open + 2);
  while (at < text.length) {
    if (text.startsWith('__', at) && text[at + 2] !== '_' && !(at + 2 < text.length && WORD.test(text[at + 2]!))) return at;
    at = stepOver(text, at);
  }
  return -1;
}

/** `~~x~~`: the first `~~` (after some content) not followed by a third `~`. */
function strikeCloser(text: string, open: number): number {
  let at = stepOver(text, open + 2);
  while (at < text.length) {
    if (text.startsWith('~~', at) && text[at + 2] !== '~') return at;
    at = stepOver(text, at);
  }
  return -1;
}

type Span = { readonly type: EmphasisType; readonly inner: [number, number]; readonly end: number };

/** The emphasis span that opens at `at`, if any (Discord's precedence). */
function emphasisAt(text: string, at: number): Span | null {
  const ch = text[at];
  if (ch === '*') {
    const em = emCloser(text, at);
    const strong = text[at + 1] === '*' ? strongCloser(text, at) : -1;
    const emLen = em < 0 ? -1 : em + 1 - at;
    const strongLen = strong < 0 ? -1 : strong + 2 - at;
    // The longer match wins; a tie goes to italic (simple-markdown's quality).
    if (emLen > 0 && emLen >= strongLen) return { type: 'italic', inner: [at + 1, em], end: em + 1 };
    if (strongLen > 0) return { type: 'bold', inner: [at + 2, strong], end: strong + 2 };
    return null;
  }
  if (ch === '_' && text[at + 1] === '_') {
    const close = underlineCloser(text, at);
    return close < 0 ? null : { type: 'underline', inner: [at + 2, close], end: close + 2 };
  }
  if (ch === '~' && text[at + 1] === '~') {
    const close = strikeCloser(text, at);
    return close < 0 ? null : { type: 'strike', inner: [at + 2, close], end: close + 2 };
  }
  return null;
}

/** The plain text an inline run reads as; mention/channel tokens stay tokens. */
function inlinePlainText(nodes: readonly InlineNode[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'mention':
          return `<@${node.userId}>`;
        case 'channel':
          return `<#${node.channelId}>`;
        case 'image':
          // A reader sees the picture; a line of text says what it is.
          return imagePlainText(node);
        case 'timestamp':
          // Nothing re-renders plain text, so a countdown reads as the
          // moment it counts to.
          return timestampPlainText(node);
        default:
          return node.text;
      }
    })
    .join('');
}

/** One top-level piece of a parse: its source slice and its node(s). */
interface Piece {
  readonly source: string;
  readonly nodes: InlineNode[];
}

function scan(text: string, depth: number): Piece[] {
  const out: Piece[] = [];
  let gap = '';
  const flush = () => {
    if (gap === '') return;
    out.push({ source: gap, nodes: [{ type: 'text', text: gap }] });
    gap = '';
  };
  let at = 0;
  while (at < text.length) {
    const opaque = opaqueAt(text, at);
    if (opaque) {
      flush();
      out.push({ source: text.slice(at, opaque.end), nodes: opaque.nodes });
      at = opaque.end;
      continue;
    }
    // Deep nesting is legitimate only a few levels down; a pathological
    // body (thousands of openers) reads as literal text past this depth.
    const span = depth < 32 ? emphasisAt(text, at) : null;
    if (span) {
      flush();
      const children = parseLevel(text.slice(span.inner[0], span.inner[1]), depth + 1);
      out.push({
        source: text.slice(at, span.end),
        nodes: [{ type: span.type, text: inlinePlainText(children), children }],
      });
      at = span.end;
      continue;
    }
    gap += text[at];
    at += 1;
  }
  flush();
  return out;
}

function parseLevel(text: string, depth: number): InlineNode[] {
  return scan(text, depth).flatMap((piece) => piece.nodes);
}

/**
 * Split `text` into alternating plain segments and top-level tokens, keeping
 * the delimiters. Exported for the parity tests so they can assert the split
 * independently of the classification.
 */
export function tokenizeInline(text: string): string[] {
  return scan(text, 0).map((piece) => piece.source);
}

/** Classify one token string into an {@link InlineNode}. */
export function classifyInlineToken(token: string): InlineNode {
  const nodes = parseInlineMarkdown(token);
  const first = nodes[0];
  if (nodes.length === 1 && first) return first;
  // A bare URL with its sentence punctuation: the link alone.
  if (nodes.length === 2 && first?.type === 'link' && nodes[1]?.type === 'text' && first.href === first.text) return first;
  return { type: 'text', text: token };
}

/**
 * Parse a message body into inline nodes. Adjacent text is NOT merged across
 * a token: the output is one node per token or gap (an escape is its own
 * `text` node), so a renderer can map nodes to elements one-for-one.
 */
export function parseInlineMarkdown(text: string): InlineNode[] {
  return parseLevel(text, 0);
}

/**
 * What an image reads as in plain text — its alt text, or `[image]` when it
 * has none. Previews (and the server's push text) never show the URL.
 */
export function imagePlainText(node: ImageNode): string {
  return node.alt.trim() !== '' ? node.alt : '[image]';
}

/** The display name a mention renders as, given an optional resolver. */
export function mentionDisplayName(userId: string, resolveMention?: MentionResolver): string {
  return `@${resolveMention?.(userId) ?? userId}`;
}

/** The display form of a channel token, given an optional resolver. */
export function channelDisplayName(channelId: string, resolveChannel?: ChannelResolver): string {
  return `#${resolveChannel?.(channelId) ?? channelId}`;
}

/** Every mention token in a body (the anchored classifier's global twin). */
const MENTION_TOKEN_GLOBAL = /<@(\d{1,19})>/g;
const CHANNEL_TOKEN_GLOBAL = /<#(\d{1,19})>/g;

/**
 * Rewrite mention tokens to their display form, leaving ALL other text
 * verbatim — no inline markup, no block handling.
 *
 * For one-line previews of a message (the reply-context snippet) that render
 * plain text: the snippet showed the raw wire token `<@snowflake>` because
 * only the body path had a resolver (user report 2026-09-11: "we render the
 * user ID when we should render the @<name>"). An id the resolver cannot name
 * falls back to `@<id>`, the same shape the body's mention pill uses.
 */
export function resolveMentionTokens(
  text: string,
  resolveMention?: MentionResolver,
  resolveChannel?: ChannelResolver,
): string {
  return text
    .replace(MENTION_TOKEN_GLOBAL, (_token, id: string) => mentionDisplayName(id, resolveMention))
    .replace(CHANNEL_TOKEN_GLOBAL, (_token, id: string) => channelDisplayName(id, resolveChannel));
}

// ---------------------------------------------------------------------------
// Block level — fenced code blocks
// ---------------------------------------------------------------------------

/**
 * A message body is a sequence of blocks: fenced code runs, and everything
 * else as inline nodes. The `inline` payload is exactly what
 * {@link parseInlineMarkdown} always produced, so a renderer that ignores
 * blocks keeps its previous behaviour.
 */
/** One list item: its inline content, plus the task marker when it has one. */
export interface MarkdownListItem {
  readonly nodes: InlineNode[];
  /** `- [ ]` / `- [x]` — null for an ordinary item. */
  readonly task: { readonly checked: boolean } | null;
}

export type MarkdownBlock =
  | { readonly type: 'code-block'; readonly text: string; readonly lang: string | null }
  | { readonly type: 'heading'; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly nodes: InlineNode[] }
  | { readonly type: 'blockquote'; readonly nodes: InlineNode[] }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      /** First number of an ordered list (1 unless the author started higher). */
      readonly start: number;
      readonly items: MarkdownListItem[];
    }
  | { readonly type: 'inline'; readonly nodes: InlineNode[] };

/**
 * Opening fence: up to three spaces, three or more backticks or tildes, then
 * an optional info string (the language). Closing fence: the same character,
 * at least as long, and nothing else on the line.
 */
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * ATX heading: 1–6 `#`, a REQUIRED space, then the text (CommonMark). Seven
 * `#` is not a heading, and neither is `#NoSpace` — Discord agrees, and a
 * message like "#1 priority" is text, not a title.
 */
const HEADING_OPEN = /^ {0,3}(#{1,6})[ \t]+(.*)$/;
/** A trailing closing sequence ("## Title ##") is decoration, not content. */
const HEADING_CLOSE = /[ \t]+#+[ \t]*$/;

/** `> quoted` lines group into one quote; `>>>` quotes the rest of the message. */
const QUOTE_LINE = /^ {0,3}> ?(.*)$/;
const QUOTE_TO_END = /^ {0,3}>>> ?(.*)$/;
/** A bullet needs the space: "-5 degrees" is text, "- item" is a list. */
const LIST_BULLET = /^ {0,3}[-*+] +(.*)$/;
const LIST_ORDERED = /^ {0,3}(\d{1,9})[.)] +(.*)$/;
/** GitHub-style task marker at the head of an item's text. */
const TASK_ITEM = /^\[([ xX])\] +(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** One list item: peel a task marker off the text, then inline-parse the rest. */
function itemFor(text: string): MarkdownListItem {
  const task = TASK_ITEM.exec(text);
  if (task) {
    return { nodes: parseInlineMarkdown(task[2] ?? ''), task: { checked: task[1] !== ' ' } };
  }
  return { nodes: parseInlineMarkdown(text), task: null };
}

/** The language token from a fence's info string; null when it carries none. */
function fenceLanguage(info: string): string | null {
  const first = info.trim().split(/\s+/)[0] ?? '';
  if (first === '') return null;
  // Rendered into an attribute, so keep it to a language-shaped token.
  const safe = first.replace(/[^A-Za-z0-9#+._-]/g, '').slice(0, 32);
  return safe === '' ? null : safe;
}

/**
 * Parse a message body into blocks.
 *
 * Fences are a BLOCK construct. Before this existed the scanner saw ` ``` ` as
 * stray inline backticks: a fenced run produced two literal backticks plus one
 * enormous multi-line "inline" span, so a transcript rendered as boxed code
 * lines with lone ` characters between them — and when the fences did not pair
 * up, the prose after them was swallowed into the code (user report
 * 2026-09-11: "code's not being rendered and coding's not being recognized as
 * closed").
 *
 * An UNCLOSED fence runs to the end of the message rather than falling back to
 * inline parsing: a fence that is never closed is still code, and treating it
 * as inline is exactly what leaked the rest of the message into it. (CommonMark
 * reads it the same way.)
 *
 * The body of a code block is never inline-parsed — mentions, links and
 * emphasis inside it stay literal, which is the point of a code block.
 */
export function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.split('\n');
  const blocks: MarkdownBlock[] = [];
  let pending: string[] = [];

  const flushInline = (): void => {
    if (pending.length === 0) return;
    const text = pending.join('\n');
    pending = [];
    // An empty body yields no blocks at all — not an empty inline run.
    if (text === '') return;
    blocks.push({ type: 'inline', nodes: parseInlineMarkdown(text) });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const heading = HEADING_OPEN.exec(line);
    if (heading) {
      flushInline();
      const level = heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6;
      const text = (heading[2] ?? '').replace(HEADING_CLOSE, '');
      blocks.push({ type: 'heading', level, nodes: parseInlineMarkdown(text) });
      continue;
    }

    const open = FENCE_OPEN.exec(line);
    // A backtick fence's info string may not contain a backtick (CommonMark) —
    // that keeps an inline `` `code` `` at the start of a line from opening one.
    const isFence = open !== null && !(open[1]![0] === '`' && (open[2] ?? '').includes('`'));

    if (isFence) {
      const marker = open![1]!;
      flushInline();

      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j += 1) {
        const candidate = FENCE_CLOSE.exec(lines[j]!);
        if (candidate && candidate[1]![0] === marker[0] && candidate[1]!.length >= marker.length) {
          closed = true;
          break;
        }
        body.push(lines[j]!);
      }

      blocks.push({ type: 'code-block', text: body.join('\n'), lang: fenceLanguage(open![2] ?? '') });
      // An unclosed fence consumed every remaining line; a closed one resumes
      // after its closing fence.
      i = closed ? j : lines.length;
      continue;
    }

    // `>>>` quotes everything after it, so it is handled before line runs.
    const toEnd = QUOTE_TO_END.exec(line);
    if (toEnd) {
      flushInline();
      const rest = [toEnd[1] ?? '', ...lines.slice(i + 1)].join('\n');
      blocks.push({ type: 'blockquote', nodes: parseInlineMarkdown(rest) });
      i = lines.length;
      continue;
    }

    // A run of `> ` lines is ONE quote (newlines survive inside it).
    if (QUOTE_LINE.test(line)) {
      flushInline();
      const quoted: string[] = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const m = QUOTE_LINE.exec(lines[j]!);
        if (!m) break;
        quoted.push(m[1] ?? '');
      }
      blocks.push({ type: 'blockquote', nodes: parseInlineMarkdown(quoted.join('\n')) });
      i = j - 1;
      continue;
    }

    // A run of bullet or ordered lines is ONE list; a marker change starts a
    // new one (CommonMark separates them too).
    const bullet = LIST_BULLET.exec(line);
    const ordered = bullet ? null : LIST_ORDERED.exec(line);
    if (bullet ?? ordered) {
      flushInline();
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered![1]) : 1;
      const items: MarkdownListItem[] = [];
      let j = i;
      for (; j < lines.length; j += 1) {
        const next = lines[j]!;
        const b = LIST_BULLET.exec(next);
        const o = b ? null : LIST_ORDERED.exec(next);
        if (b === null && o === null) break;
        if ((o !== null) !== isOrdered) break;
        items.push(itemFor((b ? b[1] : o![2]) ?? ''));
      }
      blocks.push({ type: 'list', ordered: isOrdered, start, items });
      i = j - 1;
      continue;
    }

    pending.push(line);
  }

  flushInline();
  return blocks;
}


// ---------------------------------------------------------------------------
// Previews — one line of plain text, from the SAME parse as the body
// ---------------------------------------------------------------------------

/**
 * A message body as ONE line of plain text, for every preview outside the
 * timeline (inbox rows, search hits, the reply quote, the composer's reply
 * bar, permalink chips): the markup the body renders is dropped (`**bold**`
 * reads `bold`, a code span its code, a link its text, a heading, list or
 * quote its words), whitespace collapses, and mention/channel tokens are KEPT
 * as tokens (the `<@!id>` nickname form normalized to `<@id>`) so each
 * surface resolves them its own way — pills, or `@name` text.
 *
 * It walks {@link parseMarkdownBlocks}, the parser the timeline renders with,
 * so a preview can never read markup the body would have rendered (owner
 * report 2026-09-28: the inbox excerpt showed `**Confirmed working:**` and
 * backticks where the message itself rendered them). The server's push
 * preview (`Cytale.Notifications.Preview`) strips the same way.
 */
export function previewText(content: string): string {
  const normalized = content.replace(/<@!(\d{1,19})>/g, '<@$1>');
  const parts: string[] = [];
  for (const block of parseMarkdownBlocks(normalized)) {
    switch (block.type) {
      case 'code-block':
        parts.push(block.text);
        break;
      case 'list':
        for (const item of block.items) parts.push(inlinePlainText(item.nodes));
        break;
      default:
        parts.push(inlinePlainText(block.nodes));
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}
