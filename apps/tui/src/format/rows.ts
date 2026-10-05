/**
 * @cytale/tui — column two's row model and its history seam (U7; R19, R26a).
 *
 * Three things live here, and all three are pure: the row projection (oldest
 * first, grouped by author), the COLUMN BUDGET those rows are cut to, and the
 * vocabulary of the history states the pane can be in (paging, at the start,
 * failed). The Ink components (`MessageList.tsx`, `ThreadView.tsx`) only draw
 * what this module computes, which is what makes the row shape testable without
 * a terminal.
 *
 * ---------------------------------------------------------------------------
 * The column budget, stated (step 1)
 * ---------------------------------------------------------------------------
 *
 * A message row is drawn in a pane of `width` cells (`layout.contentWidth`),
 * and every cell in it is accounted for:
 *
 *     | <- gutter 2 -> | <- author cell -> | gap 1 | <- time 5 -> |
 *
 *   * `ROW_GUTTER_WIDTH` (2) — the cursor marker (or its blank) and the space
 *     after it. Every row carries this line, INCLUDING a continuation row, so
 *     the cursor always has a line of its own to sit on. The body is indented
 *     by the same two cells, so a body line never starts under the marker.
 *   * `TIME_WIDTH` (5) — `HH:MM`, the widest timestamp this client renders. A
 *     fixed column means authors of different name widths cannot shift the
 *     timestamps out of alignment, and a long display name cannot push the time
 *     off the pane: the author cell is CLIPPED to what is left (`clampToWidth`)
 *     rather than allowed to overflow.
 *   * `HEADER_GAP_WIDTH` (1) — the space between them.
 *
 * At `layout.MIN_CONTENT_WIDTH` (24) that is 16 cells of author and 22 of body,
 * which is the number this module and the pane agree on.
 *
 * A message's REACTIONS cost one more line of the budget when it has any — a
 * single chip row, however many emoji it holds — and none at all when it has
 * none, which is what keeps the pane's window arithmetic (`rowCost`,
 * `visibleWindow`) honest about what it draws.
 *
 * Grouping: consecutive messages from one author on the SAME CALENDAR DAY share
 * one author header. The rule is `apps/web`'s (`MessageList.tsx`), so the two
 * clients do not disagree about where a run begins; a continuation row carries
 * `CONTINUATION_MARKER` instead of the repeated name, plus the time when the
 * minute changed, so a long run's pace stays legible. A day boundary always
 * opens a new group — which is where the timestamp is re-stated, since this
 * pane has no date divider to draw.
 *
 * ---------------------------------------------------------------------------
 * Where the data comes from, and where it does not
 * ---------------------------------------------------------------------------
 *
 * The SHARED store only: `messagesByChannel` / `messagesByThread`, exactly the
 * slices `@cytale/state` folds gateway events and REST pages into. Nothing here
 * caches, fetches, or synthesizes a message. The store keeps each slice
 * NEWEST-FIRST for cheap inserts; this module reverses it once, at the boundary
 * where "the order on the page" is decided (R19's newest-last).
 *
 * Threads are the same story: `PaneHistory` describes what a pane still has to
 * LOAD (`before`, `needsFirstPage`, `atStart`) for the host that owns the api,
 * and the reply count a channel row shows is read from the LOADED reply set —
 * never from a server total this client has not fetched. That is the rule the
 * plan states: a zero-count thread renders nowhere.
 *
 * Authors and thread names cross `inertText` (R26a's single call-site rule for
 * server strings); bodies cross `renderMarkdownLines`, which sanitizes before it
 * parses. Every failure cause is sanitized too, because a transport message can
 * carry a server-supplied string.
 *
 * ---------------------------------------------------------------------------
 * Reactions (U14; R24) — why the chip text is projected HERE
 * ---------------------------------------------------------------------------
 *
 * A reaction chip's text is part of the row's drawn shape: it is a line of the
 * budget, and the pane cuts its window on `rowCost`. So the chip MODEL lives
 * here with the rest of the projection — the emoji vocabulary, the defensive
 * reader, and the one-line chip row — while `columns/Reactions.tsx` owns the
 * Ink surface and the two runtime seams (the optimistic toggle and the gateway
 * fold). The chip's own spelling is stated in full on {@link reactionLine}.
 *
 * The wire shape is deliberate: only the FLAT `/api/v1` form
 * (`[{emoji, count, me}]`, `CytaleApiClient`'s `ReactionSummary`, which
 * `message_controller.ex` serves) becomes a chip. The nested `{count, me,
 * emoji: {id, name}}` form is the v10-compat dialect (`message_codec.ex`'s
 * `reactions_from_native/1`), and half-reading it would draw an emoji of
 * `undefined` — so it is not read at all.
 */
import type { Channel, Message, Thread, WorkspaceMember } from '@cytale/domain';

import { inertText } from '../columns/layout.js';
import { displayWidth, renderMarkdownLines, sanitizeTerminalText } from './markdown.js';
import { displayNameOf } from '@cytale/domain';

// ---------------------------------------------------------------------------
// The column budget
// ---------------------------------------------------------------------------

/** Cells the cursor gutter takes: the marker (or its blank) plus one space. */
export const ROW_GUTTER_WIDTH = 2;
/** Cells the time column takes: `HH:MM`, padded and clipped to a fixed width. */
export const TIME_WIDTH = 5;
/** One space between the author cell and the time column. */
export const HEADER_GAP_WIDTH = 1;
/**
 * A row that continues the author group above it. Never blank: the pane's
 * cursor needs a line per row, and a reader needs to see that the message
 * belongs to the name above rather than being a new one.
 */
export const CONTINUATION_MARKER = '↳';
/** The channel row's thread indicator: a reply count, from the loaded replies. */
export const REPLY_MARKER = '↩';

/** Cells a row's author cell gets in a pane of `paneWidth` cells. */
export function authorBudgetFor(paneWidth: number): number {
  const width = Number.isFinite(paneWidth) ? Math.floor(paneWidth) : 0;
  return Math.max(1, width - ROW_GUTTER_WIDTH - HEADER_GAP_WIDTH - TIME_WIDTH);
}

/** Cells a row's BODY lines get (the body is indented by the gutter). */
export function bodyBudgetFor(paneWidth: number): number {
  const width = Number.isFinite(paneWidth) ? Math.floor(paneWidth) : 0;
  return Math.max(1, width - ROW_GUTTER_WIDTH);
}

/**
 * Grapheme clusters, preferred over code points: a ZWJ emoji is one glyph and
 * two cells, and half of one is not a character. Falls back to code points when
 * the runtime has no `Intl.Segmenter` (surrogate pairs stay whole either way).
 */
const segmenter: { segment(input: string): Iterable<{ segment: string }> } | null =
  typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

function clusters(text: string): string[] {
  if (segmenter !== null) return Array.from(segmenter.segment(text), (s) => s.segment);
  return Array.from(text);
}

/**
 * `text` cut to at most `cells` terminal cells. `displayWidth` is the measure —
 * never `.length`, which counts a wide CJK glyph or an emoji as one cell and
 * would let a display name overflow its column.
 */
export function clampToWidth(text: string, cells: number): string {
  if (cells <= 0) return '';
  if (displayWidth(text) <= cells) return text;
  let out = '';
  let used = 0;
  for (const cluster of clusters(text)) {
    const width = displayWidth(cluster);
    if (used + width > cells) break;
    out += cluster;
    used += width;
  }
  return out;
}

/** `text` padded with spaces to exactly `cells` cells (never truncated). */
export function padToWidth(text: string, cells: number): string {
  const missing = cells - displayWidth(text);
  return missing > 0 ? `${text}${' '.repeat(missing)}` : text;
}

// ---------------------------------------------------------------------------
// Source and rows
// ---------------------------------------------------------------------------

/** The message slice shape the store holds (structurally — the real state fits). */
export interface MessageSliceLike {
  readonly items: readonly Message[];
  readonly oldestId: string | null;
  readonly hasCompleteHistory: boolean;
}

/** The store slices column two reads (structurally — the real state satisfies it). */
export interface MessageSource {
  readonly channels: Record<string, Channel>;
  readonly membersById: Record<string, WorkspaceMember>;
  /** Per-workspace nicknames (#169); absent in fixtures that predate them. */
  readonly nicknamesByWorkspace?: Record<string, Record<string, string>> | undefined;
  readonly currentUser: { readonly id: string; readonly username: string } | null;
  readonly messagesByChannel?: Record<string, MessageSliceLike | undefined> | undefined;
  readonly messagesByThread?: Record<string, MessageSliceLike | undefined> | undefined;
  readonly threadsById?: Record<string, Thread | undefined> | undefined;
  readonly threadIdsByChannel?: Record<string, readonly string[] | undefined> | undefined;
}

/** One message as the pane draws it: a gutter line, then the body's lines. */
export interface MessageRow {
  readonly id: string;
  readonly authorId: string;
  /** The inert display name — the fallback chain, never a raw id. */
  readonly author: string;
  /** `HH:MM` in the member's own timezone; '' when the timestamp is unusable. */
  readonly time: string;
  readonly lines: readonly string[];
  /** True when this row opens an author group (it carries author and time). */
  readonly groupStart: boolean;
  /** Replies in this row's thread, from the LOADED reply set; 0 = no indicator. */
  readonly replies: number;
  /**
   * The message's reactions, in the order the server stated them. Empty and
   * absent mean the same thing — no chip line — so a row that was not projected
   * from a stored message (a hand-built literal) states no reactions rather than
   * an empty set it cannot vouch for.
   */
  readonly reactions?: readonly ReactionChip[] | undefined;
}

/** `HH:MM` local time, or nothing when the timestamp does not parse. */
export function timeLabel(createdAt: string): string {
  const at = new Date(createdAt);
  if (Number.isNaN(at.getTime())) return '';
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** True when two timestamps fall on the same calendar day (web's grouping rule). */
function sameDay(a: string, b: string): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * The display name for an author: the member row's nickname, then its username,
 * then the DM peer's username from the channel itself, then the member's own
 * name for their messages — and `unknown` if none of those exists. Never a raw
 * id, and never a server string that has not been made inert.
 */
export function displayNameFor(
  source: MessageSource,
  authorId: string,
  channel: Channel | undefined,
): string {
  const member = source.membersById[authorId];
  if (member !== undefined) {
    // This channel's workspace nickname first (#169); none in a DM.
    const ws = channel?.workspace_id;
    const nickname = ws ? (source.nicknamesByWorkspace?.[ws]?.[authorId] ?? null) : null;
    return inertText(displayNameOf({ ...member, nickname }), 'unknown');
  }
  const recipient = channel?.recipients?.find((candidate) => candidate.id === authorId);
  if (recipient !== undefined) return inertText(displayNameOf(recipient), 'unknown');
  if (source.currentUser?.id === authorId) return inertText(source.currentUser.username, 'you');
  return 'unknown';
}

/**
 * The thread anchored on a message, if one exists. Thread ids are looked up
 * through the channel's own list first (the store's index) and then by scanning
 * the thread table, because a thread created from a composer rather than from a
 * seed message may not be indexed under the channel at all.
 */
export function resolveThreadForMessage(
  source: MessageSource,
  channelId: string,
  messageId: string,
): Thread | null {
  for (const id of source.threadIdsByChannel?.[channelId] ?? []) {
    const thread = source.threadsById?.[id];
    if (thread !== undefined && thread.parent_message_id === messageId) return thread;
  }
  for (const thread of Object.values(source.threadsById ?? {})) {
    if (
      thread !== undefined &&
      thread.channel_id === channelId &&
      thread.parent_message_id === messageId
    ) {
      return thread;
    }
  }
  return null;
}

/**
 * Replies in the thread on `messageId`, counted from the LOADED reply set.
 *
 * 0 means one of two things — the message has no thread, or nothing has loaded
 * its replies — and both render NOTHING: this client never states a count it
 * has not fetched, which is the "a zero-count thread renders nowhere" rule.
 */
export function replyCountFor(source: MessageSource, channelId: string, messageId: string): number {
  const thread = resolveThreadForMessage(source, channelId, messageId);
  if (thread === null) return 0;
  return source.messagesByThread?.[thread.id]?.items.length ?? 0;
}

/**
 * The thread indicator line under a message with replies, or null when it has
 * none. Zero renders NOTHING — the count is what this client has LOADED, and a
 * thread with no loaded replies has no count to state (the plan's rule).
 */
export function replyIndicatorLine(row: { readonly replies: number }): string | null {
  if (row.replies <= 0) return null;
  const indent = ' '.repeat(ROW_GUTTER_WIDTH);
  return `${indent}${REPLY_MARKER} ${row.replies} ${row.replies === 1 ? 'reply' : 'replies'}`;
}

/** Cells a row costs the pane: its gutter line, body, thread indicator, chips. */
export function rowCost(row: {
  readonly lines: readonly string[];
  readonly replies: number;
  readonly reactions?: readonly ReactionChip[] | undefined;
}): number {
  return (
    1 +
    row.lines.length +
    (row.replies > 0 ? 1 : 0) +
    // One chip row, however many chips it holds — or nothing to draw at all.
    ((row.reactions?.length ?? 0) > 0 ? 1 : 0)
  );
}

// ---------------------------------------------------------------------------
// Reactions (U14; R24, R26a)
// ---------------------------------------------------------------------------

/**
 * One emoji of the reaction palette, with the short name the shared
 * `@cytale/emoji` catalog gives it (`canonicalShortcode`, no colons).
 *
 * The names are kept in step with that catalog by hand for now, because
 * `apps/tui` does not depend on `@cytale/emoji` yet: the terminal's chip needs
 * a name for the emoji it draws, and one emoji with two names in one repo is
 * exactly the drift this table is written down to avoid.
 */
export interface ReactionGlyph {
  readonly emoji: string;
  /** The catalog's shortcode, without colons: `thumbs_up`. */
  readonly shortName: string;
}

/**
 * The palette: the eight emoji the browser's reaction picker offers, in that
 * order (`apps/web`'s `REACTION_PALETTE`, the fixed reactions contract).
 * Terminal-first, but not terminal-only: it is the set a member can ADD from
 * this client, and any emoji the web client applied renders here too.
 */
export const REACTION_VOCABULARY: readonly ReactionGlyph[] = [
  { emoji: '👍', shortName: 'thumbs_up' },
  { emoji: '👎', shortName: 'thumbs_down' },
  { emoji: '❤️', shortName: 'heart' },
  { emoji: '😂', shortName: 'joy' },
  { emoji: '😮', shortName: 'open_mouth' },
  { emoji: '😢', shortName: 'crying_face' },
  { emoji: '🎉', shortName: 'tada' },
  { emoji: '👀', shortName: 'eyes' },
];

/** The palette's emoji, in display order, as the web picker spells it. */
export const REACTION_PALETTE: readonly string[] = REACTION_VOCABULARY.map((glyph) => glyph.emoji);

/** Glyph → short name. The map is the "known emoji" test as well as a lookup. */
const SHORT_NAME_BY_EMOJI: ReadonlyMap<string, string> = new Map(
  REACTION_VOCABULARY.map((glyph) => [glyph.emoji, glyph.shortName]),
);

/**
 * The stable short name for an emoji: this client's own name for one it knows,
 * else the code points it is made of (`u1fae0`, `u1f9d1-200d-1f4bb`).
 *
 * The fallback is STABLE and ASCII by construction — the same emoji always
 * yields the same name, whatever the terminal's font can draw — which is what
 * makes a chip legible on a terminal with no emoji glyph at all. It is derived
 * from the emoji's code points, never from the server's string, so a hostile
 * value cannot reach the terminal through this door either (R26a).
 */
export function reactionShortName(emoji: string): string {
  const known = SHORT_NAME_BY_EMOJI.get(emoji);
  if (known !== undefined) return known;
  return Array.from(emoji, (point) => `u${(point.codePointAt(0) ?? 0).toString(16)}`).join('-');
}

/** One reaction as the pane draws it. */
export interface ReactionChip {
  /** The emoji as the server sent it, sanitized — what a toggle round-trips. */
  readonly emoji: string;
  /**
   * What the chip draws: the glyph when this client knows the emoji, else
   * `:short_name:` — the legibility fallback the unit asks for.
   */
  readonly label: string;
  /** The stable short name, with no colons (`thumbs_up`). */
  readonly shortName: string;
  readonly count: number;
  /** The member reacted (the wire's `me` flag). */
  readonly me: boolean;
}

/** An own chip's brackets: the NON-COLOUR channel that marks it as the member's. */
export const OWN_CHIP_OPEN = '[';
export const OWN_CHIP_CLOSE = ']';

/** Between two chips: two cells, so a chip's count never touches the next glyph. */
export const CHIP_GAP = '  ';

/** One chip's text: `👍 3`, or `[👍 3]` when it is the member's own. */
export function reactionChipText(chip: ReactionChip): string {
  const body = `${chip.label} ${chip.count}`;
  return chip.me ? `${OWN_CHIP_OPEN}${body}${OWN_CHIP_CLOSE}` : body;
}

/**
 * One reaction from the values a wire frame or a store patch supplies, or null
 * when they are not a reaction this client can draw.
 *
 * The ONE place a chip is built, so the projection and the fold cannot disagree
 * about what a chip is. Every argument is `unknown` on purpose: these values
 * come off a wire, and the validation IS this function. An emoji value that
 * sanitizes to nothing (R26a) is not an emoji, a count that is not a positive
 * integer is not a count, and `me` is true only for a literal `true` — anything
 * else would be this client inventing a fact about who reacted.
 */
export function reactionChipOf(
  emoji: unknown,
  count: unknown,
  me: unknown,
): ReactionChip | null {
  if (typeof emoji !== 'string') return null;
  const clean = sanitizeTerminalText(emoji);
  if (clean === '') return null;
  const size = typeof count === 'number' && Number.isFinite(count) ? Math.floor(count) : 0;
  if (size <= 0) return null;
  const shortName = reactionShortName(clean);
  return {
    emoji: clean,
    // A known emoji draws ITS OWN glyph, from this module's table — the
    // server's string is never the thing that reaches the cell.
    label: SHORT_NAME_BY_EMOJI.has(clean) ? clean : `:${shortName}:`,
    shortName,
    count: size,
    me: me === true,
  };
}

/**
 * A message's reactions as chips — DEFENSIVELY, because the value crosses a
 * wire this client does not control.
 *
 * Read from the message's own `reactions` key (the native `/api/v1` array; see
 * the module header for the dialect this deliberately does not read). The
 * argument is `unknown` because that is what it is. An entry that is not
 * `{emoji: string, count: > 0, me: boolean}` is DROPPED rather than drawn: a
 * chip with an `undefined` glyph or a count nothing supports would state
 * something this client cannot know. Duplicates collapse to the first — a
 * message's reactions are a set.
 */
export function readReactions(message: unknown): ReactionChip[] {
  if (typeof message !== 'object' || message === null) return [];
  const raw = (message as { reactions?: unknown }).reactions;
  if (!Array.isArray(raw)) return [];
  const chips: ReactionChip[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as { emoji?: unknown; count?: unknown; me?: unknown };
    const chip = reactionChipOf(candidate.emoji, candidate.count, candidate.me);
    if (chip === null || seen.has(chip.emoji)) continue;
    seen.add(chip.emoji);
    chips.push(chip);
  }
  return chips;
}

/**
 * The chip row under a message, or null when it has none. It carries the same
 * gutter indent the body does, so the chips sit under the message's text
 * rather than under the author's name.
 *
 * Nothing renders at zero reactions — not an empty line, and not a count this
 * client has not been told — which is the same rule the thread indicator
 * follows, and the reason a message with no reactions costs the pane nothing.
 */
export function reactionLine(row: {
  readonly reactions?: readonly ReactionChip[] | undefined;
}): string | null {
  const chips = row.reactions ?? [];
  if (chips.length === 0) return null;
  return `${' '.repeat(ROW_GUTTER_WIDTH)}${chips.map(reactionChipText).join(CHIP_GAP)}`;
}

/** The index of a row by id, or null when it is not in the projection. */
export function indexOfRow(rows: readonly MessageRow[], id: string): number | null {
  const at = rows.findIndex((row) => row.id === id);
  return at === -1 ? null : at;
}

/**
 * One message as a row. `previous` is the message ABOVE it in oldest-first
 * order — its author and day decide whether this row opens a group.
 */
function projectRow(
  item: Message,
  previous: Message | undefined,
  source: MessageSource,
  channel: Channel | undefined,
  bodyWidth: number,
  threads: boolean,
): MessageRow {
  return {
    id: item.id,
    authorId: item.author_id,
    author: displayNameFor(source, item.author_id, channel),
    time: timeLabel(item.created_at),
    // Sanitized before the parse inside renderMarkdownLines (U16, R26a).
    lines: renderMarkdownLines(item.content ?? '', { width: bodyWidth }),
    groupStart:
      previous === undefined ||
      previous.author_id !== item.author_id ||
      !sameDay(previous.created_at, item.created_at),
    replies: threads ? replyCountFor(source, item.channel_id, item.id) : 0,
    // Read from the message row the store holds: the REST leg's page and the
    // gateway's projection both write it there (U14).
    reactions: readReactions(item),
  };
}

/**
 * One message drawn on its own — the thread pane's seed, which belongs to the
 * channel's slice but is context rather than a reply. It opens a group (there is
 * nothing above it inside the thread) and carries no thread indicator: the
 * pane's header already states the reply count.
 */
export function messageRow(input: {
  readonly message: Message;
  readonly source: MessageSource;
  readonly channel: Channel | undefined;
  readonly width: number;
}): MessageRow {
  return projectRow(
    input.message,
    undefined,
    input.source,
    input.channel,
    bodyBudgetFor(input.width),
    false,
  );
}

export interface RowBuildInput {
  /** The slice's items, NEWEST-FIRST — the order the store keeps them in. */
  readonly items: readonly Message[];
  readonly source: MessageSource;
  /** The conversation the rows belong to, for the author fallback chain. */
  readonly channel: Channel | undefined;
  /** The pane's width in cells (the whole budget, not the body's). */
  readonly width: number;
  /** Look up the thread indicator (channel panes; a thread's replies have none). */
  readonly threads?: boolean | undefined;
}

/**
 * The rows of one pane, OLDEST FIRST (R19's newest-last: the newest message is
 * the last row, at the bottom of the list).
 *
 * The slice is reversed rather than re-sorted: newest-first is the store's own
 * invariant (every writer keeps it), and a second ordering rule here would be a
 * second thing to keep in step.
 */
export function buildMessageRows(input: RowBuildInput): MessageRow[] {
  const { items, source, channel, width, threads = false } = input;
  const ordered = [...items].reverse();
  const bodyWidth = bodyBudgetFor(width);
  return ordered.map((item, index) =>
    projectRow(item, ordered[index - 1], source, channel, bodyWidth, threads),
  );
}

// ---------------------------------------------------------------------------
// The history seam: what a pane still has to load
// ---------------------------------------------------------------------------

export type HistoryKind = 'channel' | 'thread';

/**
 * The pane a request state belongs to. A thread is keyed by its SEED message,
 * because that is the pane's identity before the thread record is resolved.
 */
export function paneKeyFor(conversationId: string, openThreadMessageId: string | null): string {
  return openThreadMessageId === null ? `channel:${conversationId}` : `thread:${openThreadMessageId}`;
}

/** The host's request state for one pane (a page in flight, or why it failed). */
export interface PaneRequestState {
  readonly key: string;
  readonly loading: boolean;
  /** The line to render, already sanitized. */
  readonly error: string | null;
}

/** One page of history as the host's loader is asked for it. */
export interface HistoryRequest {
  /** The pane this page belongs to (`paneKeyFor`). */
  readonly key: string;
  readonly kind: HistoryKind;
  readonly channelId: string;
  /** The thread to page, when the pane is a thread and its record is known. */
  readonly threadId: string | null;
  /** Page before this id; `null` asks for the newest page (a first load). */
  readonly before: string | null;
}

/** What the pane knows about its own history, all of it derived from the store. */
export interface PaneHistory {
  readonly key: string;
  readonly kind: HistoryKind;
  readonly channelId: string;
  readonly threadId: string | null;
  /** The `before=` cursor for the next older page; null when there is none. */
  readonly before: string | null;
  /**
   * True when this pane has to be fetched before it can show anything: no slice
   * in the store, and something to fetch one FROM (a channel, or a thread whose
   * record is known). A message with no thread has no first page.
   */
  readonly needsFirstPage: boolean;
  /** True when the loaded page reached the start of the conversation. */
  readonly atStart: boolean;
  /** True when the shell's cursor is on the pane's oldest loaded row. */
  readonly cursorAtOldest: boolean;
  /** A page is in flight (the host's request state, matched to this pane). */
  readonly loading: boolean;
  /** The last load failed; the line to render. */
  readonly error: string | null;
}

export interface PaneHistoryInput {
  readonly key: string;
  readonly kind: HistoryKind;
  readonly channelId: string;
  readonly threadId: string | null;
  readonly slice: MessageSliceLike | undefined;
  /** The pane's current cursor (already clamped to the rows that exist). */
  readonly cursor: number;
  readonly rowCount: number;
  readonly request?: PaneRequestState | undefined;
}

/**
 * The pane's history state. A request belongs to ONE pane, so a state left over
 * from a pane the member has switched away from is ignored rather than rendered
 * into the new one (step 3: a switch cannot inherit the last pane's error).
 */
export function paneHistory(input: PaneHistoryInput): PaneHistory {
  const { slice, request } = input;
  const matched = request !== undefined && request.key === input.key ? request : null;
  const oldest = slice?.items[slice.items.length - 1];
  return {
    key: input.key,
    kind: input.kind,
    channelId: input.channelId,
    threadId: input.threadId,
    before: slice === undefined ? null : (slice.oldestId ?? oldest?.id ?? null),
    needsFirstPage: slice === undefined && (input.kind === 'channel' || input.threadId !== null),
    atStart: slice?.hasCompleteHistory === true,
    cursorAtOldest: input.rowCount > 0 && input.cursor === 0,
    loading: matched?.loading === true,
    error: matched?.error ?? null,
  };
}

/** The pending marker: the same `…` the connection banner uses for "in flight". */
export const HISTORY_PENDING: Record<HistoryKind, string> = {
  channel: '… loading earlier messages',
  thread: '… loading earlier replies',
};

/** The start-of-history marker, so a finished history is not read as a stall. */
export const HISTORY_START: Record<HistoryKind, string> = {
  channel: '· beginning of history',
  thread: '· beginning of the thread',
};

/**
 * The one status line the pane's top edge shows, or null when it has none.
 *
 * The error wins over everything (it is actionable), then a page in flight, then
 * the start of history. A pane with no rows shows nothing here: its notice
 * ("Loading #general…") already says what it is doing, and two lines saying the
 * same thing is how a state starts to look like a different state.
 */
export function historyStatusLine(history: PaneHistory, hasRows: boolean): string | null {
  if (history.error !== null) return history.error;
  if (!hasRows) return null;
  if (history.loading) return HISTORY_PENDING[history.kind];
  if (history.atStart) return HISTORY_START[history.kind];
  return null;
}

/** The transport cause of a failure, as one INERT line (R26a). */
export function describeCause(cause: unknown): string {
  const raw = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
  return inertText(raw, '');
}

/**
 * The inline error for a failed page, with its retry affordance spelled out.
 * The marker matches the connection banner's `failed` phase (a non-colour
 * channel), and `k` is the movement key the member is already using at the top
 * — pressing it again is what asks for the page once more.
 */
export function historyErrorLine(kind: HistoryKind, cause: unknown): string {
  const subject = kind === 'thread' ? "this thread's replies" : 'earlier messages';
  const cause_ = describeCause(cause);
  return `✖ Could not load ${subject}.${cause_ === '' ? '' : ` (${cause_})`} Press k to try again.`;
}
