/**
 * @cytale/tui — terminal markdown rendering (plan U16; requirements R26, R26a).
 *
 * The terminal is the fourth renderer over ONE parse tree. `@cytale/markdown`
 * owns the dialect — `parseMarkdownBlocks` for the block level and
 * `parseInlineMarkdown` for the inline level — and this module owns only the
 * mapping from that tree to terminal cells. There is no second parser here:
 * if a construct is not in the tree, it is not recognized on this side either,
 * which is exactly what stops the terminal's dialect from drifting away from
 * the browser's and the native client's.
 *
 *   parse half (shared)          this file (terminal)
 *   ---------------------------  ---------------------------------------
 *   block 'inline'               styled inline runs, wrapped
 *   block 'code-block' (lang)    literal, indented, one style for the body
 *   block 'heading' (1-6)        bold text (the `#` markers are the parser's)
 *   block 'blockquote'           `> ` prefixed, italic
 *   block 'list' (+ task)        `- ` / `1. ` / `[x] ` markers re-emitted as text
 *   InlineNode 'italic','bold',  SGR 3, SGR 1, SGR 36, SGR 9, SGR 4
 *     'code','strike','underline'  (see ANSI_STYLE_CODES); emphasis nests,
 *                                  so `~~**x**~~` is one run with SGR 1+9
 *   InlineNode 'link'            its text, plus the URL when it differs
 *   InlineNode 'image'           its alt text, plus the URL (the URL alone without alt)
 *   InlineNode 'mention'         `@name` through the shared resolver
 *   InlineNode 'timestamp'       the moment, in the reader's zone (`R` too:
 *                                a printed line never ticks)
 *   InlineNode 'text'            literal
 *
 * The subset R26 names — emphasis, bold, inline code, fenced code blocks, and
 * blockquotes — is what gets styling. It is BOUNDED on purpose: everything
 * else degrades to readable text rather than being dropped or printed as raw
 * markup, and the degradations are stated here rather than left to each call
 * site:
 *
 *   - **Links** render as their label with the URL in parentheses when the two
 *     differ, because a terminal cannot be relied on for a clickable
 *     hyperlink. A bare autolink whose label IS its URL prints once. The
 *     target is inert text — this client has no opener to hand it to, so the
 *     shared `isOpenableLinkHref` policy has nothing to gate (the web and
 *     native renderers do have one, and apply it there).
 *   - **Images** (`![alt](https://…)`, the parser's `image` node) degrade to
 *     their alt text with the URL after it, dimmed, like a link's — a terminal
 *     cannot display them, and the URL is how a reader gets to the picture —
 *     or to the URL alone when there is no alt. A non-http(s) source is no
 *     image to the parser (a literal `!` plus a link); it degrades to its alt
 *     the same way, by the text rule below.
 *   - **Tables** have no block construct in the shared parser, and this module
 *     does not add one: a detected table run keeps the inline nodes the shared
 *     parse produced for its cells (bold stays bold) and drops only the
 *     DECORATION — the outer pipes and the `| --- |` alignment row — so cells
 *     print as cell text and neither raw markup nor rules reach the terminal.
 *   - **Footnotes** render inline: a reference `[^1]` prints as `[1]` and a
 *     definition line `[^1]: note` as `[1] note`, in place, so the aside stays
 *     next to the sentence that cites it instead of being reflowed to a page
 *     footer a terminal message has no room for.
 *   - **Headings, lists, and mentions** are outside R26's list but outside no
 *     *dialect*: they are parsed (heading/list blocks, mention nodes) and print
 *     as readable text with their markers re-emitted, never as raw `-`, `#`,
 *     or `<@123…>` source.
 *   - A **fence's info string** is decoration, not content, and is not printed.
 *   - An **empty body** renders as no lines at all, not a blank message.
 *   - **Blocks are separated by one blank line** — the terminal's only way to
 *     show a boundary a browser shows with element margins — and blank lines
 *     at the edges of the prose run (the source's own separation, which the
 *     parser consumed) are trimmed so the message does not open or close on
 *     one. Blank lines INSIDE a run are the author's paragraph break and stay.
 *   - The two node kinds R26 does not name but the shared parser marks —
 *     `underline` and `strike` — keep their attributes (SGR 4, 9), and nested
 *     emphasis (`***x***`, `~~**x**~~`) combines them, rather than being
 *     flattened: the parser already decided they
 *     are constructs, and the web and native renderers show them, so flattening
 *     them here would be the divergence.
 *
 * Wrapping is to the CALLER's column width, not the terminal's, and never
 * splits a glyph: text is cut at grapheme-cluster boundaries (UAX #29 through
 * `Intl.Segmenter` when the runtime has it) and measured in terminal cells
 * (wide CJK/emoji count 2), so a fixed two-column layout cannot be overflowed
 * by message content. A word with no break opportunity (a long URL) wraps
 * mid-word — at a cluster boundary — rather than overflowing the column.
 *
 * ## R26a: every string this client writes to the terminal is inert
 *
 * `sanitizeTerminalText` strips control characters and escape sequences —
 * complete sequences, with their payload, so nothing is left to print but
 * text. Message bodies are sanitized once, before the parse, so the parser
 * only ever sees inert input and every SGR sequence in the output is one of
 * this module's own constants. Names, channel/thread/workspace titles,
 * presence labels, reaction short names, and search snippets have no parse
 * step of their own: those call sites pass their server-supplied strings
 * through the same function, whose rule is stated in full on
 * {@link sanitizeTerminalText} below. A member can set their own
 * display name, so without this every other member's terminal would be
 * reachable with cursor movement, a screen clear, a clipboard write (OSC 52),
 * or output shaped like the client's own chrome.
 *
 * Colour is on only when the output stream is a TTY and `NO_COLOR`/`TERM=dumb`
 * say otherwise; with colour off the same lines are produced with the style
 * atoms dropped, not with the text rearranged.
 */
import {
  channelDisplayName,
  isEmphasisNode,
  mentionDisplayName,
  parseMarkdownBlocks,
  timestampPlainText,
  type InlineNode,
  type MarkdownBlock,
  type MentionResolver,
} from '@cytale/markdown';

// ---------------------------------------------------------------------------
// R26a — inert terminal text
// ---------------------------------------------------------------------------

/**
 * Complete escape sequences, removed together with their payload: leaving the
 * parameters behind would print `[2J` as literal noise, and a lone `ESC` is
 * already stripped as a control character. Three passes, in order:
 *
 *   1. CSI — `ESC [ params intermediates final` (cursor movement, erase,
 *      SGR, and the modes that reshape the screen).
 *   2. String introducers — OSC (`ESC ]`), DCS, SOS, PM, APC — whose payload
 *      runs to BEL, ST (`ESC \`), C1 ST, or the end of the string. OSC 52
 *      (clipboard) and OSC 8 (link) live here.
 *   3. Any remaining escape — intermediates plus an optional final byte, or a
 *      bare `ESC`.
 */
const ESCAPE_SEQUENCES: readonly RegExp[] = [
  /\u001b\[[0-?]*[ -/]*[@-~]/g,
  /\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g,
  /\u001b[ -/]*[0-~]?/g,
];

/**
 * Every C0 control except TAB, LF, and CR (those three are handled below),
 * plus DEL and the C1 block. C1 counts because a terminal reads U+0080-U+009F
 * as control codes too — `NEL`, `IND`, and a second CSI introducer among them.
 */
const C0_C1_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/**
 * Bidirectional controls: they cannot move the cursor, but they reorder what
 * the cursor already wrote, which is enough to render a name or a snippet as
 * something it is not (the "Trojan Source" shape). Zero-width joiners and
 * variation selectors are deliberately NOT here — emoji sequences are
 * server-supplied text too, and stripping those would break them.
 */
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export interface SanitizeOptions {
  /**
   * Keep LF (and TAB) as content: the message-body path, where line structure
   * and code indentation belong to the author. Off for single-line values —
   * a display name carrying a newline could forge a second line of client
   * chrome, so LF, TAB, and CR collapse to one space instead.
   */
  readonly allowNewlines?: boolean;
}

/**
 * Strip everything from `value` that a terminal would act on rather than
 * print, leaving the text.
 *
 * The rule, exactly:
 *
 *   1. Remove each complete escape sequence (CSI, OSC/DCS/SOS/PM/APC, and any
 *      other `ESC`-introduced sequence) with its payload, including an
 *      unterminated one that runs to the end of the string.
 *   2. Remove the remaining C0 controls (NUL through US, minus TAB/LF/CR) and
 *      DEL, and the whole C1 block U+0080-U+009F.
 *   3. Remove bidirectional controls (U+061C, U+200E/U+200F, U+202A-U+202E,
 *      U+2066-U+2069): they reorder rendered text and so can imitate chrome
 *      even though they move nothing.
 *   4. Normalize CR and CRLF to LF — a lone CR returns the cursor to column
 *      zero and would let a value overwrite the client's own line.
 *   5. Without `allowNewlines`, collapse LF and TAB runs into a single space,
 *      so the value stays one line.
 *
 * Everything else is preserved verbatim, including the text around a removed
 * sequence: the goal is inertness, not censorship. Callers that render a name
 * whose sanitized form is empty own that fallback; this function never invents
 * text.
 */
export function sanitizeTerminalText(value: string, options: SanitizeOptions = {}): string {
  let out = value;
  for (const pattern of ESCAPE_SEQUENCES) out = out.replace(pattern, '');
  out = out.replace(C0_C1_CONTROLS, '');
  out = out.replace(BIDI_CONTROLS, '');
  out = out.replace(/\r\n?/g, '\n');
  if (options.allowNewlines !== true) out = out.replace(/[\n\t]+/g, ' ');
  return out;
}

// ---------------------------------------------------------------------------
// The style map
// ---------------------------------------------------------------------------

/**
 * The whole style map: one SGR attribute code per atom, and nothing derived
 * from message content. `code` is a foreground colour (cyan) rather than
 * bold/reverse so a code span inside a bold heading still reads as code.
 */
export const ANSI_STYLE_CODES = {
  bold: 1,
  dim: 2,
  italic: 3,
  underline: 4,
  strike: 9,
  code: 36,
} as const;

export type TerminalStyleAtom = keyof typeof ANSI_STYLE_CODES;

/** Fixed paint order, so one attribute set always serializes the same way. */
export const STYLE_ORDER: readonly TerminalStyleAtom[] = [
  'bold',
  'dim',
  'italic',
  'underline',
  'strike',
  'code',
];

/** SGR 0 — emitted before each run instead of per-attribute undo, because
 * `Bold off` (22) also cancels `dim` and would silently drop it. */
const SGR_RESET = '\u001b[0m';

/** Inline node kind to style atoms. Every kind is named, so a node the shared
 * parser grows fails the typecheck here rather than rendering unstyled. */
const NODE_STYLES: Record<InlineNode['type'], readonly TerminalStyleAtom[]> = {
  text: [],
  mention: [],
  channel: [],
  timestamp: [],
  link: [],
  image: [],
  code: ['code'],
  bold: ['bold'],
  italic: ['italic'],
  underline: ['underline'],
  strike: ['strike'],
};

/** Colour is on only for a TTY that has not opted out. */
export function detectColorSupport(
  stream: { isTTY?: boolean } | undefined = typeof process === 'undefined' ? undefined : process.stdout,
  env: Record<string, string | undefined> = typeof process === 'undefined' ? {} : process.env,
): boolean {
  // The NO_COLOR convention: present and non-empty, whatever its value.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  if (env.TERM === 'dumb') return false;
  return stream?.isTTY === true;
}

// ---------------------------------------------------------------------------
// Cell measurement (UAX #11 approximation) and grapheme segmentation
// ---------------------------------------------------------------------------

/** East Asian Wide / Fullwidth / emoji blocks: two cells. */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
];

/** Combining marks and zero-width formatting: no cells of their own. */
const ZERO_WIDTH_RANGES: readonly (readonly [number, number])[] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05c7],
  [0x0610, 0x061a],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2060, 0x2064],
  [0x20d0, 0x20f0],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

const inRanges = (cp: number, ranges: readonly (readonly [number, number])[]): boolean =>
  ranges.some(([lo, hi]) => cp >= lo && cp <= hi);

/** Cells one code point occupies. */
function pointCells(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (inRanges(cp, ZERO_WIDTH_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

/**
 * Grapheme clusters. `Intl.Segmenter` is the real UAX #29 implementation;
 * the code-point fallback keeps surrogate pairs (and therefore every astral
 * character) whole when a runtime ships without it.
 */
const segmenter: { segment(input: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function graphemes(text: string): string[] {
  if (segmenter !== null) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

/**
 * Cells one cluster occupies. Compound emoji (ZWJ sequences, `FE0F`-presented
 * pictographs) are one glyph two cells wide whatever their code point count;
 * a regional-indicator flag pair is NOT special-cased, because it is two
 * clusters that happen to sum to the two cells a flag needs.
 */
function clusterCells(cluster: string): number {
  const points = Array.from(cluster);
  if (points.includes('\u200d') || points.includes('\ufe0f')) return 2;
  let cells = 0;
  for (const point of points) cells += pointCells(point.codePointAt(0) ?? 0);
  return cells;
}

/** Display width of a plain string, in terminal cells. */
export function displayWidth(text: string): number {
  let cells = 0;
  for (const cluster of graphemes(text)) cells += clusterCells(cluster);
  return cells;
}

// ---------------------------------------------------------------------------
// Pieces, lines, and units
// ---------------------------------------------------------------------------

/** A styled run of text, before wrapping. */
interface Piece {
  readonly text: string;
  readonly styles: readonly TerminalStyleAtom[];
}

/** One source line of a paragraph, plus what the callers prefix it with. */
interface Paragraph {
  readonly pieces: readonly Piece[];
  /** Text in front of every wrapped line (a quote marker, a list bullet). */
  readonly prefix: string;
  /** Indent for wrapped continuation lines; spaces the width of `prefix`. */
  readonly continuation?: string;
}

/** One unbreakable-ish atom for the wrapper: a grapheme with its styles. */
interface Unit {
  readonly text: string;
  readonly cells: number;
  readonly styles: readonly TerminalStyleAtom[];
  readonly space: boolean;
}

const orderedStyles = (styles: readonly TerminalStyleAtom[]): readonly TerminalStyleAtom[] =>
  STYLE_ORDER.filter((atom) => styles.includes(atom));

/**
 * Footnotes degrade INLINE: a definition line `[^1]: note` becomes `[1] note`
 * where the author wrote it, and a reference `[^1]` becomes `[1]`. An image
 * with no alt text (`![](src)`) has no label, so the shared parser does not
 * see a link at all and the marker lands in a text node — where this rewrites
 * it to the URL, the only readable content an alt-less image has. (When the
 * source IS a URL the parser lifts it out as an autolink, splitting the
 * marker; that shape is handled in `piecesForNodes`.) These are text
 * rewrites, not construct handlers: no other markdown is touched.
 */
function degradeText(text: string): string {
  return text
    .replace(/!\[\]\(([^)\s]+)\)/g, '$1')
    .replace(
      /(^|\n)([ \t]*)\[\^([^\]\s]+)\]:?[ \t]*/g,
      (_match, lead: string, indent: string, label: string) => `${lead}${indent}[${label}] `,
    )
    .replace(/\[\^([^\]\s]+)\]/g, '[$1]');
}

/**
 * Map the shared parser's inline nodes to pieces. This is where the
 * degradation rules above (images, links, mentions, footnotes) live, and the
 * only place inline styling is chosen.
 */
function piecesForNodes(
  nodes: readonly InlineNode[],
  extra: readonly TerminalStyleAtom[],
  resolveMention?: MentionResolver,
): Piece[] {
  const out: Piece[] = [];
  const push = (text: string, styles: readonly TerminalStyleAtom[] = []): void => {
    if (text === '') return;
    out.push({ text, styles: orderedStyles([...extra, ...styles]) });
  };

  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i];
    if (node === undefined) continue;

    if (node.type === 'text') {
      const next = nodes[i + 1];
      if (node.text.endsWith('!') && next !== undefined && next.type === 'link') {
        // `![alt](src)` with a non-http(s) source: the shared parser splits
        // the marker from the link target, so this "image" IS an exclamation
        // mark plus a link node. Print it as an image node prints — the alt
        // plus the dimmed URL, or the URL when the alt is empty.
        push(degradeText(node.text.slice(0, -1)));
        push(next.text !== '' ? next.text : next.href);
        if (next.text !== '' && next.text !== next.href) push(` (${next.href})`, ['dim']);
        i += 1;
        continue;
      }
      const afterLink = nodes[i + 2];
      if (
        node.text.endsWith('![](') &&
        next !== undefined &&
        next.type === 'link' &&
        afterLink !== undefined &&
        afterLink.type === 'text' &&
        afterLink.text.startsWith(')')
      ) {
        // `![](https://…)`: the parser lifts the source out as a bare
        // autolink, so the marker arrives as `![](` and the closing paren
        // follows the link. Same rule — an alt-less image prints its URL.
        push(degradeText(node.text.slice(0, -4)));
        push(next.text !== '' ? next.text : next.href);
        push(afterLink.text.slice(1));
        i += 2;
        continue;
      }
      push(degradeText(node.text));
      continue;
    }

    if (node.type === 'image') {
      // R26a: alt text is author-controlled like the body (already sanitized
      // with it). The URL follows dimmed, exactly as a link's does.
      if (node.alt !== '') {
        push(node.alt);
        push(` (${node.src})`, ['dim']);
      } else {
        push(node.src);
      }
      continue;
    }

    if (node.type === 'link') {
      push(node.text);
      // The URL is shown only when it adds information, and always as inert
      // text: nothing here can be clicked, so this mirrors the requirement's
      // "text, with the URL visible when it differs".
      if (node.href !== node.text) push(` (${node.href})`, ['dim']);
      continue;
    }

    if (node.type === 'mention') {
      // R26a: the name comes from the member table, so it is a server-supplied
      // string a member controls — the shared display form is sanitized here,
      // at the one place it reaches the terminal.
      push(sanitizeTerminalText(mentionDisplayName(node.userId, resolveMention)));
      continue;
    }

    if (node.type === 'channel') {
      // `<#id>` — no channel resolver reaches this printer yet, so it shows
      // the id, as an unresolved mention does.
      push(sanitizeTerminalText(channelDisplayName(node.channelId)));
      continue;
    }

    if (node.type === 'timestamp') {
      // `<t:…>` in the reader's zone. A printed line is never redrawn, so a
      // countdown (`R`) prints the moment it counts to, not "in 5 minutes".
      push(timestampPlainText(node));
      continue;
    }

    if (isEmphasisNode(node)) {
      // Emphasis nests (`~~**x**~~`): the span's children render with its
      // attribute added to everything already in force, so a combination is
      // one run with every SGR code it needs (bold + strike here).
      out.push(...piecesForNodes(node.children, [...extra, ...NODE_STYLES[node.type]], resolveMention));
      continue;
    }

    push(node.text, NODE_STYLES[node.type]);
  }

  return out;
}

/** Split pieces on newlines: one array per source line, in order. */
function piecesToLines(pieces: readonly Piece[]): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const piece of pieces) {
    const parts = piece.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      const current = lines[lines.length - 1];
      if (part !== '' && current !== undefined) current.push({ text: part, styles: piece.styles });
    });
  }
  return lines;
}

/** `| --- | :---: |` — an alignment row, which carries no content. */
const TABLE_DELIMITER_ROW = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/**
 * A table is a row, an alignment row, then rows (CommonMark's shape). The
 * shared block parser has no table construct and this module does not add one
 * — it strips the run's DECORATION (outer pipes, the alignment row) from the
 * pieces the shared parse already produced, so the cells keep their inline
 * nodes and nothing but cell text prints. A fence is its own block, so a table
 * inside a code sample never reaches this pass.
 */
function degradeTableLines(lines: readonly (readonly Piece[])[]): Piece[][] {
  const text = lines.map((line) => line.map((piece) => piece.text).join(''));
  const isRow = (line: string | undefined): boolean =>
    line !== undefined && line.includes('|');
  const isAlignmentRow = (line: string | undefined): boolean =>
    isRow(line) && TABLE_DELIMITER_ROW.test(line ?? '');

  const drop = new Set<number>();
  const strip = new Set<number>();

  for (let i = 0; i < text.length; i += 1) {
    if (!isRow(text[i]) || !isAlignmentRow(text[i + 1])) continue;
    strip.add(i);
    drop.add(i + 1);
    let j = i + 2;
    while (j < text.length && isRow(text[j]) && !isAlignmentRow(text[j])) {
      strip.add(j);
      j += 1;
    }
    i = j - 1;
  }
  if (strip.size === 0) return lines.map((line) => [...line]);

  const trimmed = (pieces: readonly Piece[]): Piece[] => {
    const out = pieces.map((piece) => ({ ...piece }));
    const first = out[0];
    if (first !== undefined) {
      out[0] = { ...first, text: first.text.replace(/^[ \t]*\|/, '').replace(/^[ \t]+/, '') };
    }
    const last = out[out.length - 1];
    if (last !== undefined) {
      out[out.length - 1] = {
        ...last,
        text: last.text.replace(/\|[ \t]*$/, '').replace(/[ \t]+$/, ''),
      };
    }
    return out.filter((piece) => piece.text !== '');
  };

  const kept: Piece[][] = [];
  lines.forEach((line, index) => {
    if (drop.has(index)) return;
    kept.push(strip.has(index) ? trimmed(line) : [...line]);
  });
  return kept;
}

/** Base cells a line's prefix costs (prefixes are ASCII by construction). */
function prefixCells(text: string): number {
  return text.length;
}

/** Turn a source line into wrapper units. */
function unitsForPieces(pieces: readonly Piece[]): Unit[] {
  const units: Unit[] = [];
  for (const piece of pieces) {
    const styles = orderedStyles(piece.styles);
    for (const cluster of graphemes(piece.text)) {
      units.push({
        text: cluster,
        cells: clusterCells(cluster),
        styles,
        // TAB is a break opportunity with a nominal width of one cell: it is
        // content in a code block, and a hard stop cannot be measured without
        // knowing the column we are wrapping into.
        space: cluster === ' ' || cluster === '\t',
      });
    }
  }
  return units;
}

/**
 * Greedy wrap: fill a line, prefer the last space as the break, and fall back
 * to a cluster boundary when a single word is wider than the column. A
 * cluster wider than the whole column is emitted alone — never split, never
 * dropped.
 *
 * A space that does not fit IS the break (the word after it could not have
 * fit either), and neither a break space nor a wrap may start a line with one,
 * so a wrapped line never begins with stray indentation it did not have.
 */
function wrapUnits(units: readonly Unit[], width: number): Unit[][] {
  const limit = Math.max(1, width);
  const lines: Unit[][] = [];
  let line: Unit[] = [];
  let used = 0;
  /** Index in `line` of the last space that has content in front of it. */
  let breakAt = -1;
  let hasContent = false;

  const startLine = (carry: readonly Unit[]): void => {
    while (line.length > 0 && line[line.length - 1]?.space === true) line.pop();
    if (line.length > 0) lines.push(line);
    line = [...carry];
    used = 0;
    hasContent = false;
    for (const unit of line) {
      used += unit.cells;
      if (!unit.space) hasContent = true;
    }
    breakAt = -1;
  };

  for (const unit of units) {
    if (used + unit.cells > limit) {
      if (unit.space) {
        startLine([]);
        continue;
      }
      if (breakAt >= 0) {
        const carry = line.slice(breakAt + 1);
        line = line.slice(0, breakAt);
        startLine(carry);
      } else {
        startLine([]);
      }
    }
    line.push(unit);
    used += unit.cells;
    if (unit.space) {
      if (hasContent) breakAt = line.length - 1;
    } else {
      hasContent = true;
    }
  }

  while (line.length > 0 && line[line.length - 1]?.space === true) line.pop();
  if (line.length > 0) lines.push(line);
  return lines;
}

/** Serialize one physical line: style runs in, SGR sequences out. */
function serializeUnits(units: readonly Unit[], color: boolean): string {
  if (!color) return units.map((unit) => unit.text).join('');
  let out = '';
  let active = '';
  for (const unit of units) {
    const key = unit.styles.join(',');
    if (key !== active) {
      out += SGR_RESET;
      for (const atom of unit.styles) out += `\u001b[${ANSI_STYLE_CODES[atom]}m`;
      active = key;
    }
    out += unit.text;
  }
  return active === '' ? out : `${out}${SGR_RESET}`;
}

/** Wrap one paragraph and prefix every physical line it produces. */
function wrapParagraph(paragraph: Paragraph, width: number, color: boolean): string[] {
  const continuation = paragraph.continuation ?? ' '.repeat(prefixCells(paragraph.prefix));
  const limit = Math.max(1, width - prefixCells(paragraph.prefix));
  const out: string[] = [];

  for (const source of piecesToLines(paragraph.pieces)) {
    const wrapped = wrapUnits(unitsForPieces(source), limit);
    if (wrapped.length === 0) {
      // An empty source line is a blank line, not a dropped one: inside a
      // quote or a code block it keeps the block's own shape.
      out.push(paragraph.prefix);
      continue;
    }
    wrapped.forEach((physical, index) => {
      out.push((index === 0 ? paragraph.prefix : continuation) + serializeUnits(physical, color));
    });
  }
  return out;
}

/** A line with nothing left in it (a source blank line). */
const isBlankLine = (line: readonly Piece[]): boolean =>
  line.every((piece) => piece.text === '');

/** Drop blank lines at the head and tail of a block's line list. */
function trimBlankEdges(lines: Piece[][]): Piece[][] {
  let start = 0;
  let end = lines.length;
  while (start < end && isBlankLine(lines[start] ?? [])) start += 1;
  while (end > start && isBlankLine(lines[end - 1] ?? [])) end -= 1;
  return lines.slice(start, end);
}

/** One source line as a paragraph. */
const lineParagraph = (
  line: readonly Piece[],
  prefix = '',
  continuation?: string,
): Paragraph => ({
  pieces: line,
  prefix,
  ...(continuation === undefined ? {} : { continuation }),
});

/** A block's paragraphs, in order, before wrapping. */
function paragraphsForBlock(block: MarkdownBlock, resolveMention?: MentionResolver): Paragraph[] {
  switch (block.type) {
    case 'code-block': {
      // Literal: the body is not inline-parsed, so its text is printed as-is
      // (indented, in the code style). An unclosed fence reaches here as a
      // code block running to the end of the message — the shared parser's
      // rule — and prints as literal text with no fence markers.
      const pieces: Piece[] = [{ text: block.text, styles: ['code'] }];
      return piecesToLines(pieces).map((line) => lineParagraph(line, '  '));
    }
    case 'heading': {
      // The `#` markers are the parser's; the terminal's heading is bold text.
      const pieces = piecesForNodes(block.nodes, ['bold'], resolveMention);
      return piecesToLines(pieces).map((line) => lineParagraph(line));
    }
    case 'blockquote': {
      const pieces = piecesForNodes(block.nodes, ['italic'], resolveMention);
      // Every source line of the quote carries the marker, and so does every
      // line it wraps onto, so the quote's extent survives the wrap.
      return piecesToLines(pieces).map((line) => lineParagraph(line, '> ', '> '));
    }
    case 'list': {
      return block.items.flatMap((item, index) => {
        const marker = block.ordered ? `${block.start + index}. ` : '- ';
        const task = item.task === null ? '' : item.task.checked ? '[x] ' : '[ ] ';
        const prefix = `${marker}${task}`;
        const pieces = piecesForNodes(item.nodes, [], resolveMention);
        return piecesToLines(pieces).map((line) => lineParagraph(line, prefix));
      });
    }
    case 'inline':
    default: {
      const pieces = piecesForNodes(block.nodes, [], resolveMention);
      // Blank lines the parser left at the edges of the prose run are the
      // source's block separation, not content: they are what the between-block
      // separator below reproduces, and keeping both would double them. Blank
      // lines INSIDE the run are the author's paragraph break and stay.
      const lines = trimBlankEdges(degradeTableLines(piecesToLines(pieces)));
      return lines.map((line) => lineParagraph(line));
    }
  }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** Wrapping width when the caller does not know its column budget yet. */
export const DEFAULT_WIDTH = 80;

export interface MarkdownRenderOptions {
  /** The column's width in terminal cells (R26: the available width, not the
   * terminal's default). */
  readonly width?: number;
  /** Explicit colour control; default is `detectColorSupport()`. */
  readonly color?: boolean;
  readonly resolveMention?: MentionResolver;
}

function clampWidth(width: number | undefined): number {
  if (width === undefined || !Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.max(1, Math.floor(width));
}

/**
 * Render a message body to terminal lines, wrapped to `width`.
 *
 * The body is sanitized ONCE, before the parse (R26a): the shared parser sees
 * inert input, so every escape sequence in the output is one of this module's
 * own constants. A parser failure falls back to the raw body as plain text —
 * `packages/markdown` is shared with three shipping clients and must not be
 * able to blank a member's message here.
 */
export function renderMarkdownLines(raw: string, options: MarkdownRenderOptions = {}): string[] {
  const width = clampWidth(options.width);
  const color = options.color ?? detectColorSupport();
  const body = sanitizeTerminalText(typeof raw === 'string' ? raw : '', { allowNewlines: true });

  let blocks: MarkdownBlock[];
  try {
    blocks = parseMarkdownBlocks(body);
  } catch {
    return wrapParagraph(lineParagraph([{ text: body, styles: [] }]), width, color);
  }

  const lines: string[] = [];
  for (const block of blocks) {
    const rendered: string[] = [];
    for (const paragraph of paragraphsForBlock(block, options.resolveMention)) {
      rendered.push(...wrapParagraph(paragraph, width, color));
    }
    if (rendered.length === 0) continue;
    // One blank line between blocks: the terminal's only way to show the block
    // boundary a browser shows with element margins. The parser consumed the
    // blank lines the author typed between blocks, so this restores the shape
    // without inventing content.
    if (lines.length > 0) lines.push('');
    lines.push(...rendered);
  }
  return lines;
}

/** {@link renderMarkdownLines}, joined — what a message row writes. */
export function renderMarkdown(raw: string, options: MarkdownRenderOptions = {}): string {
  return renderMarkdownLines(raw, options).join('\n');
}
