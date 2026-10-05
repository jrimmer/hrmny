/**
 * @cytale/tui — column two: the conversation's content (U6; U7; R16, R17, R18,
 * R19, R26a).
 *
 * Column two renders whichever conversation column one has selected, and it
 * reads the SHARED store's message slices to do it — `messagesByChannel` for a
 * channel or DM, `messagesByThread` for an open thread. There is no second
 * cache, no loader, and no optimistic copy: U12's hydration, the gateway's
 * folds, and U7's history loads all write those slices, so a message that
 * arrives while the member is looking at the pane is on screen without this
 * module knowing how it got there.
 *
 * What this module owns is the PANE MODEL: what the header says, which state
 * the pane is in, which rows it draws (via `format/rows.ts`), where the cursor
 * and the viewport sit, and the conversation a send addresses. U7's additions
 * are the last two — `sendTarget` (the ids a send needs, not the label a member
 * reads) and `history` (what the pane still has to load) — plus the thread
 * pane's seed context.
 *
 * ---------------------------------------------------------------------------
 * The states, and why each one exists
 * ---------------------------------------------------------------------------
 *
 *   * `no-selection` — column one has nothing selected. Column two says so
 *     rather than rendering an empty conversation.
 *   * `loading` — the pane's slice is NOT in the store. The header already
 *     names the target (`#general`, or `#general · thread: a thread`), which is
 *     the point of the state: a member switching channels sees where they are
 *     going while the history is fetched, and a message typed in that moment
 *     resolves to the NEW conversation (step 3), never to the previous one.
 *   * `empty` — the slice is there and holds nothing (a channel with no
 *     messages, a thread with only its seed). A state, not an error.
 *   * `ready` — rows to draw.
 *
 * A failed page is not a state of the pane: the rows the member already has stay
 * on screen and the failure renders as an inline line with a retry (U7's error
 * path), because blanking a working pane over a *refresh* failure destroys
 * state the member can see.
 *
 * Every server-supplied string is made inert at projection time (R26a). Message
 * bodies go through `renderMarkdownLines` (which sanitizes before it parses) and
 * authors through `inertText`, both inside `format/rows.ts`; the names and
 * notices this module builds — channel, DM peer, thread — cross `inertText`
 * here, where they are turned into the header and the target label.
 */
import { Box, Text } from 'ink';
import type { ReactElement } from 'react';

import type { Channel } from '@cytale/domain';

import { sanitizeTerminalText } from '../format/markdown.js';
import {
  buildMessageRows,
  messageRow,
  paneHistory,
  paneKeyFor,
  resolveThreadForMessage,
  type HistoryKind,
  type MessageRow,
  type MessageSource,
  type PaneHistory,
  type PaneRequestState,
} from '../format/rows.js';

import { MessageList } from './MessageList.js';
import { ThreadView } from './ThreadView.js';
import { FOCUS_MARKER, clampIndex, focusMarker, inertText, type FocusSurface } from './layout.js';

// ---------------------------------------------------------------------------
// Source and view model
// ---------------------------------------------------------------------------

/** The store slices column two reads (structurally — the real state satisfies it). */
export type ContentSource = MessageSource;

/** Re-exported: these were column two's public helpers before U7 split them out. */
export { displayNameFor, resolveThreadForMessage, timeLabel } from '../format/rows.js';
export type { MessageRow };

export type ContentState = 'no-selection' | 'loading' | 'empty' | 'ready';

/** Which pane column two is showing. */
export type ContentPane = HistoryKind;

/**
 * The conversation a send addresses, resolved once and in IDS.
 *
 * The composer's own line needs the label, and the send path needs the ids —
 * and they must be the same resolution, or a message typed during a switch
 * could go to the conversation the member just left. `kind: 'thread'` means
 * "into the open thread" (R20); a thread pane whose thread did not resolve
 * sends to its channel instead, because a message id is not a thread id.
 */
export interface ContentTarget {
  readonly kind: ContentPane;
  readonly channelId: string;
  readonly threadId: string | null;
  /** What the composer names; inert, for reading. */
  readonly label: string;
}

export interface ContentView {
  readonly header: string;
  readonly state: ContentState;
  /** The one-line state, when there is no body to draw. */
  readonly notice: string | null;
  /** Oldest first. */
  readonly rows: readonly MessageRow[];
  /** The highlighted row (the shell's cursor, clamped to what exists). */
  readonly cursor: number;
  /** The first row to draw. */
  readonly viewport: number;
  /** What the composer would send to, for the composer's own line. */
  readonly target: string;
  /** Which pane this is: the channel's list, or an open thread. */
  readonly pane: ContentPane;
  /** The message a thread hangs off, drawn as context (thread panes only). */
  readonly seed: MessageRow | null;
  /** The ids a send needs (R20). */
  readonly sendTarget: ContentTarget;
  /** What the pane still has to load, and what it is doing (R19's pagination). */
  readonly history: PaneHistory;
}

export interface ContentInput {
  readonly source: ContentSource;
  /** The selected conversation; '' when column one has nothing selected. */
  readonly conversationId: string;
  /** The message a thread is open on, null when column two shows the channel. */
  readonly openThreadMessageId: string | null;
  /** The message body's cell budget (the pane's width). */
  readonly width: number;
  /** The shell's cursor for this conversation (absent = the newest message). */
  readonly cursor?: number | undefined;
  /** The shell's viewport start for this conversation (absent = 0). */
  readonly viewport?: number | undefined;
  /**
   * The host's history-request state (a page in flight, or why it failed).
   * Absent when the host has wired no loader: the pane then shows the loading
   * state and asks for nothing, rather than pretending a fetch is happening.
   */
  readonly request?: PaneRequestState | undefined;
}

const NO_TARGET: ContentTarget = { kind: 'channel', channelId: '', threadId: null, label: '' };

const NO_HISTORY: PaneHistory = {
  key: '',
  kind: 'channel',
  channelId: '',
  threadId: null,
  before: null,
  needsFirstPage: false,
  atStart: false,
  cursorAtOldest: false,
  loading: false,
  error: null,
};

/** The DM peer's name: the recipient that is not the viewer. */
function peerNameFor(channel: Channel, viewerId: string | null): string | null {
  const recipient = channel.recipients?.find((candidate) => candidate.id !== viewerId);
  if (recipient === undefined) return null;
  return inertText(recipient.username, 'Conversation');
}

/**
 * The destination of a send from a thread pane.
 *
 * A thread that did not RESOLVE (the seed message has none, or the member moved
 * the channel selection while one was open) is not a destination: the ids would
 * name a thread that does not exist. The send falls back to the channel, which
 * is the conversation the pane is actually showing — never a thread id invented
 * from a message id.
 */
function threadTarget(channelId: string, threadId: string | null, label: string): ContentTarget {
  if (threadId === null) return { kind: 'channel', channelId, threadId: null, label };
  return { kind: 'thread', channelId, threadId, label };
}

/**
 * The pane's rows as the view would draw them — the ONE projection the pane and
 * the shell's cursor-anchoring share, so "the message the cursor is on" cannot
 * mean two different things in two places.
 */
export function paneRows(input: ContentInput): readonly MessageRow[] {
  const { source, conversationId, openThreadMessageId, width } = input;
  if (conversationId === '') return [];
  const channel = source.channels[conversationId];

  if (openThreadMessageId !== null) {
    const thread = resolveThreadForMessage(source, conversationId, openThreadMessageId);
    if (thread === null) return [];
    return buildMessageRows({
      items: source.messagesByThread?.[thread.id]?.items ?? [],
      source,
      channel,
      width,
      threads: false,
    });
  }

  const slice = source.messagesByChannel?.[conversationId];
  if (slice === undefined) return [];
  return buildMessageRows({ items: slice.items, source, channel, width, threads: true });
}

/**
 * The whole of column two for one state: what it says at the top, what it
 * draws, where the cursor and viewport sit, which pane it is, what a send
 * addresses, and what history the pane still owes — all clamped to what exists,
 * so a shrunken slice can never leave the cursor off the end.
 */
export function buildContentView(input: ContentInput): ContentView {
  const { source, conversationId, openThreadMessageId, width } = input;

  if (conversationId === '') {
    return {
      header: '',
      state: 'no-selection',
      notice: 'Select a channel or conversation in the column on the left.',
      rows: [],
      cursor: 0,
      viewport: 0,
      target: '',
      pane: 'channel',
      seed: null,
      sendTarget: NO_TARGET,
      history: NO_HISTORY,
    };
  }

  const channel = source.channels[conversationId];
  const viewerId = source.currentUser?.id ?? null;
  const label =
    channel === undefined
      ? 'this conversation'
      : channel.type === 'dm'
        ? (peerNameFor(channel, viewerId) ?? 'Conversation')
        : `#${inertText(channel.name, 'unnamed-channel')}`;
  const key = paneKeyFor(conversationId, openThreadMessageId);

  if (openThreadMessageId !== null) {
    const thread = resolveThreadForMessage(source, conversationId, openThreadMessageId);
    const threadId = thread?.id ?? null;
    const slice = threadId === null ? undefined : source.messagesByThread?.[threadId];
    const rows =
      thread === null ? [] : buildMessageRows({ items: slice?.items ?? [], source, channel, width, threads: false });
    const name = thread === null ? null : inertText(thread.name, 'thread');
    const replies = slice?.items.length ?? 0;
    // The header names the target even before the replies land (step 3) — the
    // thread's own record came with the message, not with the reply page. The
    // count is from the LOADED replies, and a zero count states nothing.
    const count = replies > 0 ? ` · ${replies} ${replies === 1 ? 'reply' : 'replies'}` : '';
    const seedId = thread === null ? null : (thread.parent_message_id ?? openThreadMessageId);
    const seedMessage =
      seedId === null
        ? undefined
        : source.messagesByChannel?.[conversationId]?.items.find((item) => item.id === seedId);
    const cursor = clampIndex(input.cursor ?? rows.length - 1, rows.length);
    const viewport = clampIndex(input.viewport ?? 0, Math.max(1, rows.length));
    const state: ContentState =
      thread === null ? 'empty' : slice === undefined ? 'loading' : rows.length > 0 ? 'ready' : 'empty';
    const history = paneHistory({
      key,
      kind: 'thread',
      channelId: conversationId,
      threadId,
      slice,
      cursor,
      rowCount: rows.length,
      request: input.request,
    });

    return {
      header: name === null ? label : `${label} · thread: ${name}${count}`,
      state,
      notice: noticeFor({
        kind: 'thread',
        state,
        hasRows: rows.length > 0,
        failed: history.error !== null,
        label,
        empty: thread === null ? 'This message has no thread.' : 'No replies in this thread yet.',
      }),
      rows,
      cursor,
      viewport,
      target: label,
      pane: 'thread',
      seed:
        seedMessage === undefined
          ? null
          : messageRow({ message: seedMessage, source, channel, width }),
      sendTarget: threadTarget(conversationId, threadId, label),
      history,
    };
  }

  const slice = source.messagesByChannel?.[conversationId];
  const rows =
    slice === undefined
      ? []
      : buildMessageRows({ items: slice.items, source, channel, width, threads: true });
  const cursor = clampIndex(input.cursor ?? rows.length - 1, rows.length);
  const viewport = clampIndex(input.viewport ?? 0, Math.max(1, rows.length));
  const state: ContentState =
    slice === undefined ? 'loading' : rows.length > 0 ? 'ready' : 'empty';
  const history = paneHistory({
    key,
    kind: 'channel',
    channelId: conversationId,
    threadId: null,
    slice,
    cursor,
    rowCount: rows.length,
    request: input.request,
  });

  return {
    header: label,
    state,
    notice: noticeFor({
      kind: 'channel',
      state,
      hasRows: rows.length > 0,
      failed: history.error !== null,
      label,
      empty: `No messages in ${label} yet.`,
    }),
    rows,
    cursor,
    viewport,
    target: label,
    pane: 'channel',
    seed: null,
    sendTarget: { kind: 'channel', channelId: conversationId, threadId: null, label },
    history,
  };
}

/**
 * The pane's one-line state, when there is no body to draw.
 *
 * A FAILED request is not also "loading": the error line says what happened and
 * what to press, and pairing it with "Loading #general…" would be two answers to
 * one question. So the notice steps aside for the error, and keeps the pane's
 * own words for every other case.
 */
function noticeFor(input: {
  readonly kind: ContentPane;
  readonly state: ContentState;
  readonly hasRows: boolean;
  readonly failed: boolean;
  readonly label: string;
  readonly empty: string;
}): string | null {
  if (input.state === 'ready') return null;
  if (input.failed && !input.hasRows) return null;
  if (input.state === 'loading') {
    return input.kind === 'thread' ? 'Loading replies…' : `Loading ${input.label}…`;
  }
  return input.empty;
}

// ---------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------

export interface ContentColumnProps {
  readonly view: ContentView;
  readonly focus: FocusSurface;
  /** Lines the shell budgets for column two (including its own header). */
  readonly height: number;
  readonly width: number;
  readonly composerText: string;
}

export function ContentColumn({
  view,
  focus,
  height,
  width,
  composerText,
}: ContentColumnProps): ReactElement {
  const composerFocused = focus === 'composer';
  const head = `${focusMarker('content', focus)} ${view.header === '' ? 'Nothing selected' : view.header}`;

  return (
    <Box flexDirection="column" width={width}>
      <Text bold={focus === 'content'} dimColor={focus !== 'content'} wrap="truncate">
        {head}
      </Text>
      {view.pane === 'thread' ? (
        // The thread keeps the header above it and draws the seed as context
        // above its replies (R18): the pane is the thread, in this column.
        <ThreadView view={view} width={width} height={Math.max(1, height)} />
      ) : view.state === 'ready' ? (
        <MessageList view={view} width={width} height={Math.max(1, height)} />
      ) : null}
      {view.state === 'ready' ? null : (
        <Text dimColor wrap="wrap">{`  ${inertText(view.notice, 'Nothing to show yet.')}`}</Text>
      )}
      <Text wrap="truncate" bold={composerFocused} dimColor={!composerFocused}>
        {composerFocused
          ? // Typed text is the member's own, sanitized anyway: the terminal is
            // the one surface where an echoed control sequence is a hazard even
            // to its author. Not `inertText` — a composer must keep the space
            // the member just typed.
            `${FOCUS_MARKER} > ${sanitizeTerminalText(composerText)}`
          : `  i writes${view.target === '' ? '' : ` in ${view.target}`}`}
      </Text>
    </Box>
  );
}
