/**
 * @cytale/web — virtualized message list (U21 slice 2).
 *
 * react-virtuoso inverted windowed list: newest messages at the bottom,
 * scroll up to load older history via cursor pagination
 * (`before=<oldest_snowflake>`), `followOutput` stick-to-bottom so new
 * messages (from gateway MESSAGE_CREATE) append at the bottom and the view
 * follows when already at the bottom. Only the visible window mounts DOM
 * regardless of loaded history depth.
 *
 * The same list serves the thread side-panel (U22): `threadId` switches the
 * window to the thread's replies (`messagesByThread`, the thread REST read),
 * and every row is the channel's own row — avatar, @tag, grouping, date
 * dividers, the full action set and the long-press sheet (#15). The panel is
 * the same message-panel component rendered narrower (corpus §3b), not a
 * stripped transcript.
 *
 * The window is BOUNDED (`MESSAGE_SLICE_MAX` rows) and slides both ways (#9):
 * paging older past the cap sheds the newest rows and detaches the window
 * from the live edge (`hasNewer`); scrolling back down pages forward
 * (`after=`) until a short page re-attaches it. Older pages are PREFETCHED
 * from `rangeChanged` well before the first row is on screen (#11).
 *
 * Also renders the Discord-style unread divider ("NEW" rule above the first
 * message newer than the channel's read watermark, U23 unread).
 */

import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type ListRange, type VirtuosoHandle } from 'react-virtuoso';
import { ArrowDownIcon } from 'lucide-react';

import type { Message } from '@cytale/domain';
import { compareSnowflakes, isSnowflake } from '@cytale/domain';
import {
  defaultStore,
  isUnreadByReadState,
  hasLoadedHistory,
  mergeChannelMessages,
  mergeThreadMessages,
  nicknamesForChannel,
  setMessageWindowHold,
  type MergeOptions,
  type StateState,
  type StateStore,
} from '@cytale/state';

import { api } from '../auth/session.js';
import { MessageItem, type MessageItemProps } from './MessageItem.js';
import { createMentionResolver } from './mentionResolver.js';
import { formatLongDate } from '../../app/ui/time.js';
import { dmParticipants } from './dmRoster.js';
import { UnreadDivider } from './UnreadDivider.js';
import { MessageActionsSheet } from './MessageActionsSheet.js';
import { MarkPickerDialog } from './MarkPicker.js';
import { writeClipboardText, type ClipboardWriter } from './clipboard.js';
import { ListErrorBoundary } from './ListErrorBoundary.js';
import {
  mintPermalinkUrl,
  type PermalinkMessage,
  type PermalinkMinter,
} from './messagePermalink.js';
import { resolveAuthor } from './authorIdentity.js';
import type { MessageWithBots } from './types.js';
// The at-bottom rule (#128 defect 3) is shared with the thread side-panel:
// at the bottom means FOLLOW, scrolled up means never drag. The decisions
// live in scrollFollow.ts — unit-tested there, identical in every pane.
import {
  atBottomOnScroll,
  atBottomOnTouchDrag,
  atBottomOnWheel,
  distanceFromEnd,
} from './scrollFollow.js';
// #13: the reading position is a CONTENT anchor (a row + its offset), not a
// pixel offset — see readingAnchor.ts for why.
import {
  anchorDrift,
  cursorJustBefore,
  forgetReadingPositions,
  isAnchorRow,
  planRestore,
  readTopVisibleRow,
  recallReadingPosition,
  rememberReadingPosition,
  renderedRow,
  type ReadingAnchor,
} from './readingAnchor.js';

/** Page size for history loads (matches the U9 REST default of 50). */
const PAGE_SIZE = 50;

/** How long the Copy Link confirmation stays up before it clears itself. */
const COPY_NOTICE_MS = 2_000;

/**
 * Render-ahead, in pixels, on both edges of the window.
 *
 * A module CONSTANT, not a prop-site literal: Virtuoso re-processes whatever
 * object identity it is handed, so a fresh literal every render fed churn
 * into its reactive engine for no change (#137, app-level finding 2).
 *
 * The separate `overscan` prop is GONE, deliberately (#135/#137): the
 * maintainer's workaround for react-virtuoso's listStateSystem ↔
 * sizeRangeSystem recursion — the "Maximum call stack size exceeded" crash,
 * upstream react-virtuoso#946 — is to prefer `increaseViewportBy` and drop
 * `overscan`. This list was paying for BOTH (192px of overscan inside a
 * 400px increaseViewportBy), so dropping one gives up nothing the other
 * wasn't already covering.
 */
const INCREASE_VIEWPORT_BY = { top: 400, bottom: 400 } as const;

/**
 * Rows of runway that trigger the next page (#11). `startReached` fires only
 * once the FIRST row is inside the render-ahead band — a reader wheeling up
 * met the top, waited a round-trip, and watched the page land under them.
 * `rangeChanged` reports the visible window on every scroll, so the next page
 * is requested while this many rows are still above (or below) the viewport.
 */
const PREFETCH_ROWS = 30;

/**
 * Pre-measurement row height (#13): one author-row message. Without it
 * Virtuoso probe-renders a row to guess, and every channel open laid out
 * against the probe before the real sizes arrived.
 */
const DEFAULT_ITEM_HEIGHT = 48;

/** The fixed band the history header reserves while older pages remain (#11). */
const HISTORY_HEADER_PX = 32;

/** How long a page must be in flight before its indicator shows (#11). */
const LOADING_TEXT_DELAY_MS = 300;

/**
 * The reading-position restore's settle window (#13): the anchored row is
 * re-measured and put back at its saved offset on each of these beats (and on
 * every list-height change) while rows around it finish measuring. Past the
 * last one the position belongs to the ordinary rules again.
 */
const ANCHOR_SETTLE_BEATS_MS = [60, 150, 300, 600] as const;
const ANCHOR_SETTLE_MS = 1_000;

/** How often, at most, a scrolling reader's position is saved (#13). */
const POSITION_SAVE_THROTTLE_MS = 200;

/**
 * Jump to latest (owner, 2026-10-01): how far from the end, in pixels, still
 * counts as "the newest message is in view" for a reader who has stopped
 * following. A couple of pixels of sub-pixel rounding, no more — a reader
 * whose newest row is cut by the scroller's edge has not got it in view.
 */
const NEWEST_IN_VIEW_PX = 2;

/**
 * Beyond this many viewport heights a smooth scroll is a long blur of rows
 * Virtuoso has to render on the way past — the jump goes instantly instead.
 */
const JUMP_SMOOTH_MAX_VIEWPORTS = 3;

/**
 * The smooth jump's settle: a smooth scroll that has not reported `scrollend`
 * by then (WebKit has no such event) is finished by hand.
 */
const JUMP_SMOOTH_SETTLE_MS = 700;

/** After a jump to the present, how long older-page prefetch stands down. */
const JUMP_PRESENT_SETTLE_MS = 400;

/** Test seam: forget every saved reading position (#13). */
export function forgetSavedListStates(): void {
  forgetReadingPositions();
}

/** Initial newest-page load state, reported to the owning MessagePane. */
export type MessageListLoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; error: string };

export interface MessageListProps {
  /** The conversation's channel (a thread's PARENT channel in thread mode). */
  channelId: string;
  /**
   * Thread mode (#15): the window is this thread's replies. Rows, actions,
   * paging and the unread rule are the channel's own.
   */
  threadId?: string | null;
  /**
   * Thread mode: what sits above the first reply once the window reaches the
   * start of the thread — the starter line and the origin message.
   */
  historyHeader?: React.ReactNode;
  /**
   * Thread mode: the newest-page loader (the panel's `useThreads.loadReplies`,
   * injectable for its tests). Channel mode always reads the channel's REST
   * history.
   */
  loadNewestOverride?: () => Promise<unknown>;
  /**
   * Thread mode, a DRAFT thread (2026-10-01): a window the server does not
   * have yet, so its history is complete by definition (the header shows
   * from the start) and the scroller is mounted even while it is empty — the
   * first reply then lands in the SAME scroller, under the origin, instead of
   * the empty view being swapped for Virtuoso at that moment.
   */
  draft?: boolean;
  /** U17 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Current user id for author-scoped actions. */
  currentUserId: string | null;
  /** True when the current user holds MANAGE_MESSAGES in this channel. */
  canManageMessages?: boolean;
  /** Compact density (smaller type). The thread panel does NOT use it — its
   *  rows are the channel's rows (#15); kept for dense embeds of the list. */
  compact?: boolean;
  /** Called when the user clicks Reply on a message. */
  onReply?: (message: Message, opts?: { suppressPing?: boolean }) => void;
  /** Called when the user clicks Edit on a message (id + raw content — the
   *  host opens the app-styled edit dialog prefilled). */
  onEdit?: (messageId: string, content: string) => void;
  /** Called when the user clicks Delete on a message. */
  onDelete?: (messageId: string) => void;
  /** Called when the user clicks React on a message. */
  onReact?: (messageId: string) => void;
  /** Start-thread intent (id + seed content; the host derives the name). */
  onStartThread?: (messageId: string, content: string) => void;
  /** Opens the thread dock for a seed message's thread indicator. */
  onOpenThread?: (threadId: string) => void;
  /** The message currently being edited inline (one at a time). */
  editingMessageId?: string | null;
  /** Persists an inline edit (the host owns the optimistic call). */
  onSaveEdit?: (messageId: string, content: string) => Promise<void>;
  /** Cancels the inline edit. */
  onCancelEdit?: () => void;
  /** Called with (messageId, emoji) on reaction chip toggle / picker pick. */
  onToggleReaction?: (messageId: string, emoji: string) => void;
  /** Active reaction-toggle error (rendered inline on the failing row). */
  reactionError?: { messageId: string; emoji: string; message: string } | null;
  /** Retry the failed reaction toggle. */
  onRetryReaction?: (messageId: string, emoji: string) => void;
  /** Dismiss the reaction error affordance. */
  onDismissReaction?: () => void;
  /**
   * U3 touch actions (prompt-free twins of the desktop prompt flows, wired
   * by MessagePane to the SAME underlying effects):
   *   onEditSubmit       — commit an edit from the sheet's in-app input
   *                        (desktop hover Edit opens EditMessageDialog),
   *   onDeleteConfirmed  — delete after the sheet's in-sheet confirm
   *                        (desktop hover Delete opens ConfirmDialog),
   *   onStartThreadNamed — start a thread with the message-derived name
   *                        (desktop hover 🧵 names the thread from the seed
   *                        message — no prompt anywhere).
   */
  onEditSubmit?: (messageId: string, content: string) => void;
  onDeleteConfirmed?: (messageId: string) => void;
  onStartThreadNamed?: (messageId: string, name: string) => void;
  /** Reports the initial newest-page load state (loading/ready/error). */
  onInitialLoad?: (state: MessageListLoadState) => void;
  /** Read-only viewer (components plan U4): action-row controls pre-disabled. */
  viewOnly?: boolean;
  /**
   * The channel's unread slice AS IT WAS when the pane opened the channel
   * (#104) — captured by `MessagePane` before its read-ack cleared the
   * watermark, and handed down here. The list cannot capture it itself: on a
   * channel's first render the ack has already cleared the slice by the time
   * rows exist to draw the rule above, which is why every channel used to
   * land at the newest. The shape is exactly `useThreads.openThread`'s
   * held slice (capture where the ack is decided, read it where the rows
   * are) — one watermark, one capture, no second tracker.
   *
   * Absent/null is "the pane has not answered yet" (or a host that does not
   * track read state at all): no rule, and the open lands at the newest.
   */
  unreadAtOpen?: { lastReadId: string | null; unreadCount: number; unreadFloor?: string | null } | null;
  /** The channel's unread floor NOW (#54): a reminder that fires while the
   * pane is open moves the divider to the floored message (no scroll jump). */
  liveUnreadFloor?: string | null;
  /**
   * A message this list must LAND on (#114): the row is scrolled into view
   * and flashed once. When the id is not in the loaded window the list
   * resolves it through the REST permalink read and merges it (plus one page
   * of older history for context) — and when that read 404s, the message is
   * gone and the list says so instead of pretending to have landed.
   */
  focusMessageId?: string | null;
  /**
   * Fired once the focus target resolved, with the message itself — the host
   * learns its `thread_id`, which is how a link without a thread segment
   * still opens the thread the reply lives in.
   */
  onFocusMessage?: (message: Message) => void;
  /**
   * The clipboard writer (tests inject one). Defaults to the system
   * clipboard with the legacy fallback (`clipboard.ts`).
   */
  clipboardWriter?: ClipboardWriter;
  /**
   * The mint call for Copy Link (#118) — tests inject one. Defaults to the
   * session api-client's `POST /permalinks`; the returned token becomes the
   * `/m/<token>` URL the clipboard receives.
   */
  permalinkMinter?: PermalinkMinter;
}

/**
 * The virtualized timeline.
 *
 * MEMOIZED (#137, app-level finding 3): the list owns the store subscription
 * it needs (`useChannelSnapshot`) and every prop the pane hands it is a
 * stable value — hoisted handlers, state objects, the injected store — so a
 * re-render of the pane for its OWN reasons (a reply bar opening, the delete
 * dialog, the inline-edit state, a load-state flip) no longer re-runs
 * Virtuoso and its whole window of rows. Rows still re-render when the
 * channel's slice changes, which is the only thing that should move them.
 */
export const MessageList = memo(function MessageList({
  channelId,
  threadId = null,
  historyHeader = null,
  loadNewestOverride,
  draft = false,
  store = defaultStore,
  currentUserId,
  canManageMessages = false,
  compact = false,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onStartThread,
  onOpenThread,
  editingMessageId = null,
  onSaveEdit,
  onCancelEdit,
  onToggleReaction,
  reactionError,
  onRetryReaction,
  onDismissReaction,
  onEditSubmit,
  onDeleteConfirmed,
  onStartThreadNamed,
  onInitialLoad,
  viewOnly = false,
  unreadAtOpen = null,
  liveUnreadFloor = null,
  focusMessageId = null,
  onFocusMessage,
  clipboardWriter,
  permalinkMinter,
}: MessageListProps) {
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  /** Wrapper around Virtuoso — the handle used to reach its scroller node. */
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const loadingRef = useRef(false);
  const loadingNewerRef = useRef(false);
  /** The window this list reads and pages (a channel, or a thread in it). */
  const source = useMemo<ListSource>(() => ({ channelId, threadId }), [channelId, threadId]);
  /** The per-visit identity: one landing, one saved state, per conversation. */
  const visitKey = threadId !== null ? `thread:${threadId}` : `channel:${channelId}`;

  // U3 touch actions: the long-press sheet's state lives HERE — above the
  // react-virtuoso windowing boundary. Rows only REPORT the gesture (a
  // rewindow unmounting the long-pressed row must never close an open
  // sheet), and exactly one sheet exists for the whole list.
  const [sheet, setSheet] = useState<{ messageId: string | null }>({ messageId: null });
  // #54: the reminder dialog the touch sheet opens (the desktop toolbar hosts
  // its own popover).
  const [remindFor, setRemindFor] = useState<{ channelId: string; messageId: string } | null>(null);
  const openSheet = useCallback((message: MessageWithBots) => {
    setSheet({ messageId: message.id });
  }, []);
  const handleSheetOpenChange = useCallback((next: boolean) => {
    if (next) return;
    setSheet({ messageId: null });
    // Focus restoration happens in MessageActionsSheet's unmount cleanup —
    // Radix's focus trap would otherwise pull focus back into the sheet
    // while it tears down (a synchronous focus here is undone).
  }, []);

  // Read the channel's own slices (see useChannelSnapshot — a whole-store
  // subscription re-rendered every row on unrelated writes).
  const snapshot = useChannelSnapshot(store, source);
  const messages = snapshot?.items ?? NO_ITEMS;
  // Identity for this conversation. A DM resolves from its OWN participants
  // (see dmRoster.ts): the roster is workspace-scoped, so using it here made a
  // peer outside the active workspace a raw snowflake id and one inside it a
  // workspace nickname (user report 2026-09-14). The spread is honest — the
  // participants fill the fields attribution reads (name, avatar, kind, parent)
  // and carry no roles, which this list never consults.
  const membersById = useMemo(() => {
    const base = snapshot?.membersById ?? {};
    const dm = dmParticipants(store?.getState().channels[channelId]);
    return Object.keys(dm).length === 0 ? base : ({ ...base, ...dm } as typeof base);
  }, [snapshot?.membersById, store, channelId]);
  const completeHistory = draft || snapshot?.completeHistory === true;
  /** The window is detached from the live edge (#9): newer pages remain. */
  const hasNewer = snapshot?.hasNewer === true;

  /**
   * The session's own identity + the mention resolver over the two
   * projections it reads, HOISTED out of `itemContent` (#137, app-level
   * finding 3).
   *
   * `createMentionResolver` returns a new function, and building it inside
   * `itemContent` meant every row was handed a fresh `resolveMention` on every
   * render of this list — so every row's props changed identity and no row
   * memo could ever bail out. It depends on nothing but the roster and the
   * session user, both of which are stable slices, so one memo here is enough
   * to keep the prop identical for as long as the roster is.
   *
   * The chain it implements is unchanged: roster nickname/username first,
   * session self second, raw id last — the same one the thread side-panel
   * builds over the same projection, so a mention resolves identically in
   * both panes (#128).
   */
  const selfUser = snapshot?.currentUser ?? null;
  const nicknames = snapshot?.nicknames;
  const resolveMention = useMemo(
    () => createMentionResolver(membersById, selfUser, nicknames),
    [membersById, selfUser, nicknames],
  );

  // The store slice is newest-first (oldest last — see mergeChannelMessages);
  // the virtualized list renders chat order (oldest at top, newest at bottom,
  // opening scrolled to the newest message).
  const ordered = useMemo(() => [...messages].reverse(), [messages]);

  /**
   * The active reaction error, keyed by the row it belongs to — built ONCE per
   * render, keyed on the error's PRIMITIVE fields, so its identity is stable
   * for as long as the error is.
   *
   * `itemContent` used to hand the failing row a fresh `{ emoji, message }`
   * literal on every call. `MessageItem`'s shallow `memo` compares props by
   * identity, so that one fresh object made the row bail-in impossible: any
   * render of this list that did not touch the error still re-ran the error
   * row's body (and its markdown render). The same class of leak the mention
   * resolver had (#137, app-level findings 3-5) — a memo is only as good as
   * its props' identities.
   */
  const reactionErrorByMessageId = useMemo(() => {
    const map = new Map<string, { emoji: string; message: string }>();
    if (reactionError) {
      map.set(reactionError.messageId, {
        emoji: reactionError.emoji,
        message: reactionError.message,
      });
    }
    return map;
  }, [reactionError?.messageId, reactionError?.emoji, reactionError?.message]);

  // Seed-message thread indicators: parent_message_id → summary. Keyed on
  // the thread slices themselves — a ThreadCreate landing in the store
  // re-runs the row memo so the indicator appears live.
  //
  // The summary OBJECTS are reused when their fields did not change (#14): a
  // reply landing in one thread re-identifies `threadsById`, and rebuilding
  // every summary handed EVERY seed row a fresh `thread` prop, defeating the
  // row memo for all of them. Only the thread that moved gets a new object.
  const seedCacheRef = useRef(new Map<string, SeedThread>());
  const seedThreadsByParent = useMemo(() => {
    const map = new Map<string, SeedThread>();
    const previous = seedCacheRef.current;
    const ids = snapshot?.threadIds ?? NO_THREAD_IDS;
    for (const tid of ids) {
      const t = snapshot?.threadsById[tid];
      if (!t || t.archived || t.parent_message_id == null) continue;
      // A thread is its replies: one with none is not shown at all (see the
      // deferred-create path — the panel opens a draft and only POSTs on the
      // first reply, so an empty thread means a pre-2026-09-12 artifact).
      if (t.message_count === 0) continue;
      const next: SeedThread = {
        id: t.id,
        name: t.name,
        messageCount: t.message_count ?? 0,
        latestReplyAt: t.latest_reply_at ?? null,
      };
      const prior = previous.get(t.parent_message_id);
      map.set(
        t.parent_message_id,
        prior !== undefined &&
          prior.id === next.id &&
          prior.name === next.name &&
          prior.messageCount === next.messageCount &&
          prior.latestReplyAt === next.latestReplyAt
          ? prior
          : next,
      );
    }
    seedCacheRef.current = map;
    return map;
  }, [snapshot?.threadIds, snapshot?.threadsById]);

  // Inverted-list bookkeeping: `firstItemIndex` must DECREASE by the number of
  // items prepended (each older history page) so Virtuoso can keep the scroll
  // anchored; appends (new messages) don't touch it.
  //
  // The decrement is a RENDER-PHASE adjustment (React's derived-state
  // pattern), not an effect, because Virtuoso's contract is that the new
  // `firstItemIndex` and the prepended `data` reach it in the SAME render
  // pass. An effect fires one commit late: Virtuoso first saw the longer list
  // under the OLD index space, then re-labeled every row a frame later — two
  // compensation passes in exactly the window (momentum scrolling, fast
  // scrollbar drags) where a scroll event lands between them. That split is
  // prepend-side fuel for the listStateSystem ↔ sizeRangeSystem recursion
  // that overflows the stack (#135/#137, upstream react-virtuoso#946).
  //
  // The mirror lives in state (not a ref) so the adjustment is the
  // documented "adjust state during render" pattern: React re-renders
  // immediately and commits the pair atomically. StrictMode-safe — the
  // discarded first invocation's updates are not applied, and the guard
  // (`head !== headId`) makes the second pass a no-op.
  //
  // The TOP can also LOSE rows (#9): a live message into a full window evicts
  // the oldest, and a forward page sheds the old end. Virtuoso reads a smaller
  // list under an unchanged `firstItemIndex` as "the rows after the removed
  // ones moved up", so a reader scrolled up slid one row per incoming message.
  // The index therefore INCREASES by the rows removed from the top — counted
  // against the previous committed window (`committedRef`, written after each
  // commit). A wholesale replacement (a jump, the present after a detached
  // read) shares no row with the old top; the index moves past the old window
  // so no stale measurement is reused for a different message.
  const [firstItemIndex, setFirstItemIndex] = useState(1_000_000);
  /**
   * Jump to latest's replacement (set in the same tick as its store write):
   * the present takes the window's index space AS IS rather than moving past
   * it. Measured with the move: Virtuoso drew the 50-row present in place of
   * a 500-row window, then grew a phantom band of estimated rows below it,
   * and the pin to the end landed in that band — an empty list until the next
   * write. Without it the present is in view from the first frame. Reused
   * row estimates are harmless HERE: the jump lands pinned to the end, and
   * the pin re-asserts the end as the rows measure.
   */
  const presentJumpRef = useRef(false);
  const [headId, setHeadId] = useState(() => ordered[0]?.id ?? null);
  const committedRef = useRef<readonly Message[]>(ordered);
  const head = ordered[0]?.id ?? null;
  if (head !== headId) {
    let delta = 0;
    if (head !== null && headId !== null) {
      const prepended = ordered.findIndex((m) => m.id === headId);
      if (prepended > 0) {
        delta = -prepended;
      } else if (prepended < 0) {
        const previous = committedRef.current;
        const removed = previous.findIndex((m) => m.id === head);
        delta = removed > 0 ? removed : presentJumpRef.current ? 0 : previous.length;
      }
    }
    if (delta !== 0) setFirstItemIndex((f) => f + delta);
    setHeadId(head);
  }
  useLayoutEffect(() => {
    committedRef.current = ordered;
    // Consumed by the commit that brought the present (cleared here, not in
    // render: a discarded StrictMode pass must read the same flag).
    presentJumpRef.current = false;
  }, [ordered]);

  // #13: where this visit opens — decided ONCE per mount from the reading
  // position saved when the reader last left this conversation (see
  // readingAnchor.ts). Null lands at the newest message and follows: a first
  // visit, a reader who left at the live edge, or a permalink.
  const [restore] = useState(() =>
    planRestore(recallReadingPosition(visitKey), focusMessageId, ordered),
  );
  /**
   * The anchor a restore is still settling on, or null once it has settled
   * (or the reader, a landing or a link took over). While set, the saved
   * position is not overwritten by the restore's own programmatic scrolls.
   */
  const anchorRestoreRef = useRef<ReadingAnchor | null>(restore?.anchor ?? null);
  const orderedRef = useRef(ordered);
  orderedRef.current = ordered;
  /**
   * At the bottom (following) unless this visit resumes a reader who was
   * scrolled up — the restore takes them back to their row, not the end.
   */
  const atBottomRef = useRef(restore === null);
  /**
   * Jump to latest (owner, 2026-10-01): the floating ↓ button is up while the
   * newest message of the conversation is NOT in view — the reader scrolled
   * up, landed on the unread rule or a link, was restored to a saved row, or
   * the window does not even hold the newest page (#9). Derived from the
   * at-bottom rule above (`atBottomRef`), never a second detector: see
   * `syncJump`.
   */
  const [awayFromLatest, setAwayFromLatest] = useState(restore !== null);
  /** A jump is under way: the button stays down until it has landed. */
  const jumpingRef = useRef(false);

  // -------------------------------------------------------------------------
  // #114 — landing on a linked message
  // -------------------------------------------------------------------------

  /** The focus target that has already been landed on (one flash per visit). */
  const focusedRef = useRef<string | null>(null);
  /** Set once the newest page settled, so the resolver below runs after it. */
  const [initialSettled, setInitialSettled] = useState(false);
  /** The focus target's id when the resolver answered 404 — the message is gone. */
  const [goneId, setGoneId] = useState<string | null>(null);

  // Load the newest page on mount / channel change, and report when it has
  // settled: the permalink resolver below must wait for that, or every early
  // store write would race a REST call for a row that is about to arrive
  // anyway.
  useEffect(() => {
    setInitialSettled(false);
    const report = (state: MessageListLoadState) => {
      // Settled means the newest page ANSWERED (ready or error) — the
      // pre-await 'loading' report is not it. Treating that report as
      // settled started the permalink resolver while the page was still in
      // flight, so it fetched the target over REST and raced the page.
      if (state.status !== 'loading') setInitialSettled(true);
      onInitialLoad?.(state);
    };
    const newest = () => void loadNewest(source, store, report, setLoadError, loadNewestOverride);
    // #13: a return to a reader's row reads the window AROUND that row, not
    // the newest page. A newest page replaces a detached window (#9) — the row
    // with it — and a row that left the window while the reader was away
    // (live traffic evicted it) has to be read back in before it can be shown.
    const anchor = anchorRestoreRef.current;
    if (anchor !== null && restore !== null) {
      if (restore.index === null) {
        report({ status: orderedRef.current.length > 0 ? 'ready' : 'loading' });
        void loadAround(source, store, anchor).then((found) => {
          if (found) {
            report({ status: 'ready' });
            return;
          }
          // The row is gone (deleted) or unreachable: open at the newest.
          anchorRestoreRef.current = null;
          atBottomRef.current = true;
          syncHold();
          newest();
        });
        return;
      }
      if (readSlice(store, source)?.hasNewer === true) {
        report({ status: 'ready' });
        return;
      }
    }
    newest();
    // `restore` is fixed for the mount (useState initializer).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, store, onInitialLoad, loadNewestOverride]);

  // Position of each message in render order — lets itemContent look up the
  // neighboring (visually previous, i.e. older) row regardless of Virtuoso's
  // firstItemIndex index space.
  const indexById = useMemo(
    () => new Map(ordered.map((m, i) => [m.id, i])),
    [ordered],
  );

  // Unread divider position (#104). The ROW the rule sits above — resolved
  // once per visit from the slice the pane captured before its read-ack
  // (`unreadAtOpen`) and then HELD: rows landing while the pane is open are
  // read instantly and never re-divide, and the line only retires when the
  // pane remounts on a channel switch (MessagePane keys this list by
  // channel). Discord's retention, exactly. The resolution + the landing on
  // it live further down, after the bottom-pin they have to disarm.
  const [dividerId, setDividerId] = useState<string | null>(null);
  /** The channel this visit's boundary has already been resolved for. */
  const landedForRef = useRef<string | null>(null);
  /**
   * The visit in which the READER has moved the view by hand (a wheel, a
   * drag, a key, a press on the scrollbar). From then on the view is theirs:
   * a boundary resolved later — the pane claims its unread capture on the
   * first commit that HAS a read-state entry, and for a channel with none yet
   * that commit can be a live message arriving below a scrolled-up reader —
   * still draws its rule, but never scrolls them to it. Measured in a real
   * browser: that late landing yanked a reader 700px down to the arrival.
   */
  const readerMovedRef = useRef<string | null>(null);

  const handleStartReached = useCallback(() => {
    void loadOlder(source, store, loadingRef, setLoadingOlder, setLoadError);
  }, [source, store]);

  /** Forward paging on a detached window (#9): the reader is heading back down. */
  const handleEndReached = useCallback(() => {
    void loadNewer(source, store, loadingNewerRef, setLoadingNewer, setLoadError);
  }, [source, store]);

  // The latest window facts, for the range handler below (a stable callback
  // reading refs, so Virtuoso is not handed a new function per render).
  const firstItemIndexRef = useRef(firstItemIndex);
  firstItemIndexRef.current = firstItemIndex;
  const orderedLengthRef = useRef(ordered.length);
  orderedLengthRef.current = ordered.length;
  const edgesRef = useRef({ completeHistory, hasNewer });
  edgesRef.current = { completeHistory, hasNewer };

  /**
   * Prefetch (#11): the next page is requested while PREFETCH_ROWS rows are
   * still between the reader and the edge, not once the edge row renders.
   * Virtuoso reports the range in the `firstItemIndex` space, so the distance
   * to the top is `startIndex - firstItemIndex`.
   */
  const handleRangeChanged = useCallback(
    (range: ListRange) => {
      const first = firstItemIndexRef.current;
      const edges = edgesRef.current;
      if (!edges.completeHistory && range.startIndex - first < PREFETCH_ROWS) {
        void loadOlder(source, store, loadingRef, setLoadingOlder, setLoadError);
      }
      const last = first + orderedLengthRef.current - 1;
      if (edges.hasNewer && last - range.endIndex < PREFETCH_ROWS) {
        void loadNewer(source, store, loadingNewerRef, setLoadingNewer, setLoadError);
      }
    },
    [source, store],
  );

  // The page indicators only show once a load has been in flight for a
  // moment (#11): a fast page never flashes text, and the band they sit in is
  // reserved either way, so neither appearing nor vanishing moves a row.
  const showLoadingOlder = useDelayedFlag(loadingOlder, LOADING_TEXT_DELAY_MS);
  const showLoadingNewer = useDelayedFlag(loadingNewer, LOADING_TEXT_DELAY_MS);

  // -- #114 Copy Link ---------------------------------------------------------
  // The link is MINTED, not assembled (#118): the token is keyed server-side
  // (`POST /permalinks`, one round trip on the click), so the copied URL is
  // `https://<origin>/m/<token>` — one opaque segment that publishes nothing
  // about the route grammar, the ids, or the workspace/channel/message layout.
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const copyNoticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyNoticeTimer.current !== null) clearTimeout(copyNoticeTimer.current);
    },
    [],
  );

  const announceCopy = useCallback((message: string) => {
    setCopyNotice(message);
    if (copyNoticeTimer.current !== null) clearTimeout(copyNoticeTimer.current);
    copyNoticeTimer.current = setTimeout(() => {
      copyNoticeTimer.current = null;
      setCopyNotice(null);
    }, COPY_NOTICE_MS);
  }, []);

  /**
   * Copy the message's permalink. A silent copy is a bug report, so the
   * outcome is always announced — including the failure, which is reported as
   * a failure rather than as a copy. Nothing is written to the clipboard
   * unless the mint succeeded: a link that was not minted may not resolve, and
   * a stale one is worse than the honest error.
   */
  const copyLinkFor = useCallback(
    (message: PermalinkMessage) => {
      if (!isSnowflake(message.id)) {
        // An optimistic placeholder (`pending_…`) has no address yet.
        announceCopy('This message has no link yet.');
        return;
      }
      mintPermalinkUrl(message.channel_id, message.id, permalinkMinter)
        .then((url) => writeClipboardText(url, clipboardWriter))
        .then(() => announceCopy('Link copied'))
        .catch(() => announceCopy('Could not copy the link.'));
    },
    [clipboardWriter, permalinkMinter, announceCopy],
  );

  const itemContent = useCallback(
    (_index: number, message: Message) => {
      const di = indexById.get(message.id) ?? -1;
      // The row ABOVE this one in chat order is the older message.
      const above = di > 0 ? ordered[di - 1] : undefined;

      // Date divider when the calendar day changes vs the message above.
      const showDivider =
        !above ||
        new Date(above.created_at).toDateString() !==
          new Date(message.created_at).toDateString();

      // Grouping: consecutive messages from the same author within the same
      // day render as compact continuation lines (avatar/author hidden;
      // corpus §2: 24-27px cadence, author-group gaps 14-22px). A referenced
      // message (inline reply) NEVER groups — its context line is the point.
      const grouped =
        !!above &&
        above.author_id === message.author_id &&
        !showDivider &&
        !message.referenced;
      // A row that starts a new author group gets breathing room above it
      // (owner, 2026-09-29) — unless a day or "new messages" divider already
      // separates it from the group above, which would double the gap.
      const groupGap =
        !grouped && !!above && !showDivider && message.id !== dividerId;

      // Seed-message thread indicator (2026-09-10) — see the map above.
      const seedThread = seedThreadsByParent.get(message.id) ?? null;

      // ONE resolver (authorIdentity.ts) names the author and the replied-to
      // author: roster row (people and bots alike — a bot reaches the roster
      // by MemberAdd as a person does), then the session self — your own
      // messages keep your name and avatar with no roster — then, for the
      // reply quote, the wire's `referenced.author_username`.
      const author = resolveAuthor(membersById, message.author_id, { self: selfUser, nicknames });
      const authorName = author.name;
      const authorTag = author.tag;
      const authorAvatarUrl = author.avatarUrl;
      const authorParentName = author.parentName;
      const replyAuthor = message.referenced
        ? resolveAuthor(membersById, message.referenced.author_id, {
            self: selfUser,
            nicknames,
            wireName: message.referenced.author_username,
          })
        : null;
      const replyAuthorName = replyAuthor?.known ? replyAuthor.name : undefined;
      const replyAuthorAvatarUrl = replyAuthor?.avatarUrl ?? null;

      return (
        <>
          {showDivider && <DateDivider iso={message.created_at} />}
          {message.id === dividerId && <UnreadDivider />}
          <MessageItem
            message={message}
            authorName={authorName}
            authorTag={authorTag}
            authorAvatarUrl={authorAvatarUrl}
            replyAuthorName={replyAuthorName}
            replyAuthorAvatarUrl={replyAuthorAvatarUrl}
            resolveMention={resolveMention}
            authorKind={author.kind}
            authorParentName={authorParentName}
            currentUserId={currentUserId}
            canManageMessages={canManageMessages}
            compact={compact}
            grouped={grouped}
            groupGap={groupGap}
            store={store}
            viewOnly={viewOnly}
            canRemind={!viewOnly}
            onLongPress={openSheet}
            onReply={onReply}
            onEdit={onEdit}
            onDelete={onDelete}
            onReact={onReact}
            onCopyLink={copyLinkFor}
            onStartThread={onStartThread}
            thread={seedThread}
            onOpenThread={onOpenThread}
            editing={editingMessageId === message.id}
            onSaveEdit={onSaveEdit}
            onCancelEdit={onCancelEdit}
            onToggleReaction={onToggleReaction}
            reactionError={reactionErrorByMessageId.get(message.id) ?? null}
            onRetryReaction={onRetryReaction}
            onDismissReaction={onDismissReaction}
          />
        </>
      );
    },
    [
      ordered,
      indexById,
      seedThreadsByParent,
      membersById,
      nicknames,
      resolveMention,
      selfUser,
      currentUserId,
      canManageMessages,
      compact,
      dividerId,
      onReply,
      onEdit,
      onDelete,
      onReact,
      onStartThread,
      // Every value the row mapping above closes over is listed — including
      // the ones that used to be covered by accident. They were re-created on
      // every parent render by MessagePane's inline handler props, so the
      // closure was always current; now that those handlers are stable, a
      // missing dep here would FREEZE that value in the row. `editingMessageId`
      // is the visible one: without it, starting an inline edit would stop
      // reaching the editor.
      editingMessageId,
      onSaveEdit,
      onCancelEdit,
      onOpenThread,
      onToggleReaction,
      reactionErrorByMessageId,
      onRetryReaction,
      onDismissReaction,
      openSheet,
      copyLinkFor,
      store,
      viewOnly,
    ],
  );

  // Lane D #12: keyed by the send's client key when it has one, so the row a
  // member just sent keeps its identity (and its DOM) when the placeholder
  // `pending_<nonce>` is swapped for the confirmed server row.
  const computeItemKey = useCallback(
    (_index: number, message: Message) => message.client_key ?? message.id,
    [],
  );

  /**
   * Bottom pinning — the timeline must present the newest message IN FULL.
   *
   * Virtuoso's initial position lands short of the true end (measured in a
   * real browser: 34px on a 30-row channel), and `followOutput` only reacts
   * to NEW items, so late height changes (a mention pill, a resolved author
   * name, an avatar, an attachment) leave the list settled above the bottom
   * with the newest row clipped by the scroller's own edge. That edge sits
   * directly above the composer, so the message reads as being cut by the
   * message box (user report 2026-09-11, still present after a hard refresh).
   *
   * The position is therefore re-asserted on every content-height change and
   * on every new newest-id — but only while the reader is at the bottom: a
   * deliberate scroll-up is never yanked back.
   */
  /**
   * The store's view of the reader's position (#9, `setMessageWindowHold`):
   * while scrolled up, a full window keeps its oldest rows instead of evicting
   * them for a live message. Written only when the side changes.
   */
  const holdRef = useRef(false);
  const scrollerElement = useCallback(
    () => wrapperRef.current?.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]') ?? null,
    [],
  );
  /**
   * Is the newest message out of view? The window is detached (#9: the
   * newest page is not even loaded), or the reader is not following AND the
   * end of the list is off screen. The second half reads the same scroller
   * the at-bottom rule reads; it only stops the button showing for a landing
   * whose rows all fit (the unread rule three rows from the end: not
   * following, yet nothing is hidden below).
   */
  const syncJump = useCallback(() => {
    let away: boolean;
    if (jumpingRef.current) away = false;
    else if (edgesRef.current.hasNewer) away = true;
    else if (atBottomRef.current) away = false;
    else {
      const el = scrollerElement();
      away = el === null || distanceFromEnd(el) > NEWEST_IN_VIEW_PX;
    }
    setAwayFromLatest(away);
  }, [scrollerElement]);
  const syncHold = useCallback(() => {
    syncJump();
    const hold = !atBottomRef.current;
    if (holdRef.current === hold) return;
    holdRef.current = hold;
    setMessageWindowHold(store, threadId !== null ? { threadId } : { channelId }, hold);
  }, [store, threadId, channelId, syncJump]);
  // A list that goes away (a channel switch) releases its hold: nobody is
  // reading those rows any more.
  useEffect(
    () => () => {
      if (holdRef.current) {
        holdRef.current = false;
        setMessageWindowHold(store, threadId !== null ? { threadId } : { channelId }, false);
      }
    },
    [store, threadId, channelId],
  );

  /**
   * Scroll the scroller itself rather than `scrollToIndex`.
   *
   * `scrollToIndex({ index: 'LAST', align: 'end' })` is a no-op here: with
   * `increaseViewportBy={{ bottom: 400 }}` Virtuoso already considers the last
   * row rendered and therefore "visible", so it never issues the scroll — the
   * list sits 34px above the real end and stays there. Writing `scrollTop` is
   * the only route to the actual bottom (the browser clamps it to the max).
   */
  const pinToNewest = useCallback(() => {
    if (!atBottomRef.current) return;
    const scroller = scrollerElement();
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [scrollerElement]);

  /**
   * Put the restore's anchored row back at its saved offset (#13).
   *
   * Measured on the ROW ITSELF, every time: its distance from the viewport's
   * top edge is compared with the saved one and the scroller moves by the
   * difference. Nothing above the row enters that sum, so whatever the rows
   * above measure — estimates, late images, a divider — cannot shift it. A row
   * not rendered yet (the first beat, or a window just read in around it) is
   * brought into range through Virtuoso first; the next beat measures it.
   */
  const applyAnchor = useCallback(() => {
    const anchor = anchorRestoreRef.current;
    if (anchor === null) return;
    const scroller = scrollerElement();
    if (!scroller) return;
    const index = orderedRef.current.findIndex((m) => isAnchorRow(m, anchor));
    if (index < 0) return;
    const row = renderedRow(scroller, index);
    if (row === null) {
      virtuosoRef.current?.scrollToIndex({ index, align: 'start', offset: anchor.offset });
      return;
    }
    const drift = anchorDrift(
      scroller.getBoundingClientRect().top,
      row.getBoundingClientRect().top,
      anchor.offset,
    );
    if (Math.abs(drift) >= 1) scroller.scrollTop -= drift;
  }, [scrollerElement]);

  /** Every list-height change: the end pin, or the restore's anchor. A row
   *  landing below a reader who stopped just short of the end takes the
   *  newest message out of their view, so the jump button re-reads too. */
  const onListHeightChanged = useCallback(() => {
    pinToNewest();
    applyAnchor();
    if (!atBottomRef.current) syncJump();
  }, [pinToNewest, applyAnchor, syncJump]);

  /**
   * Save where the reader is (#13): the top visible row and its offset, or
   * "at the live edge". Skipped while a restore is still settling — its own
   * programmatic scrolls are not the reader, and the saved row is still the
   * truth — and when nothing is rendered to read.
   */
  const savePosition = useCallback(() => {
    if (anchorRestoreRef.current !== null) return;
    if (atBottomRef.current) {
      rememberReadingPosition(visitKey, { atBottom: true });
      return;
    }
    const scroller = scrollerElement();
    if (!scroller) return;
    const top = readTopVisibleRow(scroller);
    const row = top === null ? undefined : orderedRef.current[top.index];
    if (top === null || row === undefined) return;
    rememberReadingPosition(visitKey, {
      atBottom: false,
      anchor: { key: rowKey(row), id: row.id, offset: top.offset },
    });
  }, [visitKey, scrollerElement]);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePositionSoon = useCallback(() => {
    if (saveTimerRef.current !== null) return;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      savePosition();
    }, POSITION_SAVE_THROTTLE_MS);
  }, [savePosition]);
  // And once more as the list goes away (a channel switch keys the list by
  // channel). A LAYOUT cleanup: it runs while the rows are still in the DOM.
  useLayoutEffect(
    () => () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      savePosition();
    },
    [savePosition],
  );

  /**
   * The unread boundary's landing, while it is still AUTHORITATIVE (#104):
   * the boundary row it has landed on, or null once the reader (or the
   * settling window) has taken over. Two jobs:
   *
   *   * it blocks the "back at the end" re-arm below — Virtuoso scrolls the
   *     list to the end ITSELF when the first page lands (the rows are
   *     measured over several frames, so that scroll can arrive AFTER the
   *     landing); without this the re-arm read it as the reader arriving at
   *     the end, the pin came back and yanked the boundary off screen;
   *   * it keeps the landing re-issued across that same settling window,
   *     exactly as `pinToNewest` re-asserts the end (measured: the first
   *     `scrollToIndex` lands before Virtuoso has measured the rows).
   */
  const landingRef = useRef<string | null>(null);
  /** The landing's re-assert timers, cleared when the visit ends. */
  const landingTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clear the timers when the reader takes over or the list goes away.
  useEffect(
    () => () => {
      for (const t of landingTimersRef.current) clearTimeout(t);
      landingTimersRef.current = [];
    },
    [visitKey],
  );

  /**
   * The reader's own input hands the list back to the normal pin rules — and
   * ends a restore's settle (#13): from here the reader owns the position.
   */
  const releaseLanding = useCallback(() => {
    landingRef.current = null;
    anchorRestoreRef.current = null;
    readerMovedRef.current = visitKey;
    jumpingRef.current = false; // a wheel or a finger mid-jump: the reader steers
  }, [visitKey]);

  /**
   * "At the bottom" is the READER's position, so it is tracked from the
   * reader's own INPUT — a wheel, a drag — plus the one offset fact that is
   * unambiguous: the end. Content that grows under a stationary reader fires
   * neither, so the flag stays true across that growth, which is exactly the
   * case that must re-pin. Virtuoso's `atBottomStateChange` flips false on the
   * same growth (the distance to the end has just increased) and disarms the
   * pin, leaving the new content behind the composer.
   */
  useEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;
    /** A touch drag in flight, so its own deltas can carry intent (below). */
    let touching = false;
    let lastTop: number | null = null;

    const onScroll = (e: Event) => {
      const el = e.target as HTMLElement | null;
      if (!el || el === root) return;
      const previous = lastTop;
      lastTop = el.scrollTop;
      const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
      // Where the reader IS: well away from the end means no following, and
      // moving back toward the end inside the band means follow again. A visit
      // that lands far outside it (a link, or the test's programmatic scroll)
      // disarms like any other leave. INSIDE the band, DIRECTION decides —
      // re-arming on distance alone yanked a reader who stopped a few px short
      // (2026-09-13), and re-arming only at the exact end left the flag dead
      // after a transient leave during the library's settle (2026-09-15). The
      // rule is shared with the thread pane (scrollFollow.ts).
      atBottomRef.current = atBottomOnScroll({
        distance,
        previousTop: previous,
        currentTop: el.scrollTop,
        landingActive: landingRef.current !== null,
        currentAtBottom: atBottomRef.current,
      });
      if (touching && previous !== null) {
        // Touch has no wheel event, so while a finger is down its deltas carry
        // the intent: dragging the content DOWN is the reader leaving the end.
        atBottomRef.current = atBottomOnTouchDrag({
          currentTop: el.scrollTop,
          previousTop: previous,
          currentAtBottom: atBottomRef.current,
        });
      }
      syncHold();
      savePositionSoon();
    };

    /**
     * WHEEL is intent; it is not the scroll offset.
     *
     * Proximity alone is not intent: a reader one wheel notch above the end is
     * still inside the band, so the old rule kept them "at the bottom" and the
     * next height change slammed them back — and scrolling fires those changes
     * itself (Virtuoso re-measures rows as they render and calls
     * `totalListHeightChanged`, which re-pins), so the first notches moved
     * nothing at all. Measured in a real browser: three 60px notches up from the
     * end moved scrollTop by 0px, and a live message then yanked the reader to
     * the end (user report 2026-09-13: "stutters for 4 or 5 mouse wheel moves
     * then finally moves ... when I return to the bottom it gets stuck again").
     *
     * It also cannot be read from scroll deltas: the LIBRARY moves the offsets
     * too (its own settle after a pin), so a decreasing scrollTop is not proof
     * of a reader — disarming on one left the timeline un-pinned while the
     * reader was still at the end. Only a wheel, or a drag, is a reader.
     */
    const onWheel = (e: WheelEvent) => {
      // The reader's own hand ends any boundary landing's authority (#104):
      // from here the usual rules apply, including "back at the end follows".
      releaseLanding();
      // WHEEL IS INTENT; it is not the scroll offset. Leaving the end needs no
      // measurement — an upward wheel IS the reader leaving, at any distance —
      // while a wheel DOWN that lands back inside the band is the reader
      // returning to the live edge and must re-arm: measured from the end is
      // not the same as landing ON it, and requiring the exact pixel left a
      // reader who stopped a few px short permanently un-followed, the newest
      // row sliced under the scroller's edge (user report 2026-09-14). The
      // rule is shared with the thread pane (scrollFollow.ts).
      const el = scrollerElement();
      atBottomRef.current = atBottomOnWheel({
        deltaY: e.deltaY,
        distance: el ? distanceFromEnd(el) : Number.POSITIVE_INFINITY,
        currentAtBottom: atBottomRef.current,
      });
      syncHold();
    };

    const onTouchStart = () => {
      touching = true;
      lastTop = null;
      releaseLanding(); // same: a finger down is the reader taking over
    };
    const onTouchEnd = () => {
      touching = false;
      lastTop = null;
    };
    // A key (PageUp, arrows, Home) or a press on the scrollbar is the reader
    // taking over too: a restore still settling must not pull them back.
    const onReaderInput = () => {
      anchorRestoreRef.current = null;
      readerMovedRef.current = visitKey;
    };

    // Scroll events do not bubble, but the capture phase reaches the inner
    // scroller's events from this stable ancestor — no re-attaching per render.
    root.addEventListener('scroll', onScroll, true);
    root.addEventListener('wheel', onWheel, { passive: true });
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('keydown', onReaderInput);
    root.addEventListener('mousedown', onReaderInput);
    return () => {
      root.removeEventListener('scroll', onScroll, true);
      root.removeEventListener('wheel', onWheel);
      root.removeEventListener('touchstart', onTouchStart);
      root.removeEventListener('touchend', onTouchEnd);
      root.removeEventListener('keydown', onReaderInput);
      root.removeEventListener('mousedown', onReaderInput);
    };
  }, [scrollerElement, releaseLanding, syncHold, savePositionSoon, visitKey]);

  const newestId = ordered.length > 0 ? ordered[ordered.length - 1]!.id : null;

  // A row can grow WITHOUT this component re-rendering — a reaction chip is
  // rendered by MessageItem from the reactions seam — so the growth signal has
  // to come from the DOM: the item container's height is the honest witness of
  // "the newest message just got taller", whatever caused it.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    // Virtuoso marks its item container `virtuoso-item-list`; an item's own
    // parent is a per-item wrapper whose height says nothing about the list.
    const content =
      wrapperRef.current?.querySelector('[data-testid="virtuoso-item-list"]') ?? null;
    if (!content) return;
    const observer = new ResizeObserver(() => pinToNewest());
    observer.observe(content);
    return () => observer.disconnect();
  }, [pinToNewest, visitKey, newestId]);

  // The scroll REGION's own box (#128 defect 3, mechanism 2): the composer
  // well steps down while a typist goes live, the reply bar opens, a banner
  // appears — this pane is a flex child, so each of those shrinks the region
  // UNDER a stationary reader. scrollTop does not move by itself, so without
  // compensation the bottom of the content slides beneath the composer
  // (measured live: a 25px typing line left the newest row 6px behind the
  // composer). The item-list observer above cannot see this — the list's own
  // height did not change; the room around it did. Watching the wrapper's box
  // catches every such shift whatever its source (composer, banner, call
  // marker, a window resize), and the pin applies the one rule: AT THE
  // BOTTOM, FOLLOW — the newest message stays fully visible. SCROLLED UP,
  // NEVER DRAG — the reader owns the view. jsdom has no ResizeObserver; the
  // unit suite stubs it, the browser proves the pixels.
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const root = wrapperRef.current;
    if (!root) return;
    /** The settle re-issue timers, so a rapid-fire resize cannot pile them up. */
    let timers: ReturnType<typeof setTimeout>[] = [];
    const pinWithSettle = () => {
      // The compensation writes NOW, in the RO callback, before the browser
      // paints the shrunken region — a one-frame slide would read as flicker.
      pinToNewest();
      for (const t of timers) clearTimeout(t);
      // Virtuoso re-measures as it re-renders into the resized viewport and
      // can move the offset again — so the pin re-issues across the same
      // settling window the newestId pin uses. Each attempt is a no-op once
      // the position is at the end, and `atBottomRef` keeps a scrolled-up
      // reader safe through all of them.
      timers = [
        setTimeout(() => requestAnimationFrame(pinToNewest), 60),
        setTimeout(pinToNewest, 250),
      ];
    };
    const observer = new ResizeObserver(() => pinWithSettle());
    observer.observe(root);
    return () => {
      observer.disconnect();
      for (const t of timers) clearTimeout(t);
    };
  }, [pinToNewest, visitKey]);

  /**
   * A jump to the present (#9 window replaced) pins in LAYOUT, before the
   * browser paints the new window: the rAF pin below runs after a paint, and
   * that one frame showed the present at the old window's offset.
   */
  const pinOnNextNewestRef = useRef(false);
  useLayoutEffect(() => {
    if (!pinOnNextNewestRef.current) return;
    pinOnNextNewestRef.current = false;
    pinToNewest();
  }, [newestId, pinToNewest]);

  useEffect(() => {
    if (newestId === null) return;
    // The rows settle over more than one pass: the first paint uses estimated
    // heights, then measurement grows the content (measured in a real browser:
    // 34px on a 30-row channel) — and Virtuoso does not re-anchor the end for
    // that growth. A single pin lands above the true end, so the pin is
    // re-issued across the settling window; every attempt is a no-op once the
    // position is already at the bottom, and `atBottomRef` keeps a deliberate
    // scroll-up safe.
    const raf = requestAnimationFrame(pinToNewest);
    const soon = setTimeout(pinToNewest, 60);
    const settled = setTimeout(pinToNewest, 250);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(soon);
      clearTimeout(settled);
    };
  }, [newestId, pinToNewest]);

  // -------------------------------------------------------------------------
  // #104 / #114 — the landing resolvers. They live HERE, after the
  // bottom-pinning block, because landing anywhere but the end has to disarm
  // that pin.
  // -------------------------------------------------------------------------

  /**
   * Land the open on the unread boundary (#104): the rule with a couple of
   * rows of context above it, rather than the newest message.
   *
   * Same stand-down as `landOnRow` below — the pin must be disarmed BEFORE
   * the scroll, or its settle (rAF/60ms/250ms) drags the view back to the
   * end. `align: 'start'` on the row two above the rule leaves that context
   * in view: the reader sees where they left off with a line of what came
   * before it, not the rule pinned to the very first pixel.
   */
  const BOUNDARY_CONTEXT_ROWS = 2;
  /** The landing's re-assert window: past Virtuoso's own settle (see the pin). */
  const LANDING_SETTLE_MS = 600;
  const landOnBoundary = useCallback(
    (boundaryIndex: number, boundaryId: string) => {
      const target = Math.max(0, boundaryIndex - BOUNDARY_CONTEXT_ROWS);
      // The pin stands down, and the landing claims authority over "where the
      // end is" for the next few frames (see `landingRef`).
      atBottomRef.current = false;
      syncHold();
      landingRef.current = boundaryId;
      anchorRestoreRef.current = null; // the unread boundary outranks a restore

      const scroll = () => {
        // A wheel or a drag released the landing: the reader owns the view.
        if (landingRef.current !== boundaryId) return;
        virtuosoRef.current?.scrollToIndex({ index: target, align: 'start', behavior: 'auto' });
      };
      scroll();
      // Re-issued like the bottom pin's settle, and for the same measured
      // reason: the first `scrollToIndex` can land before Virtuoso has measured
      // the rows, and its own scroll to the end arrives a frame or two later.
      for (const t of landingTimersRef.current) clearTimeout(t);
      landingTimersRef.current = [
        setTimeout(() => requestAnimationFrame(scroll), 60),
        setTimeout(scroll, 250),
        setTimeout(() => {
          // The settling window is over: whatever the position is now, the
          // ordinary rules (proximity re-arm, follow, the pin) own it again.
          landingRef.current = null;
        }, LANDING_SETTLE_MS),
      ];
    },
    [syncHold],
  );

  /**
   * Resolve the boundary once per visit and land on it.
   *
   * The slice is the pane's pre-ack capture (see the prop); this effect only
   * answers "where is it in the rows I have". Three outcomes:
   *
   *   * the watermark covers the window — nothing unread here, so the open
   *     lands at the newest exactly as every channel did before #104;
   *   * the first unread row is in the window — draw the rule there and land;
   *   * more unread rows than the loaded window holds — the boundary sits
   *     ABOVE it, and the oldest loaded row is not the first unread, merely
   *     the oldest one loaded. Page older history through the list's own
   *     `loadOlder` until the watermark itself is in view, then land.
   *
   * The paging cannot loop: `loadOlder` writes rows the window does not have,
   * so `ordered` changes and this effect re-runs on NEW data; a page that
   * brings nothing leaves the memoized `ordered` identical, and the store's
   * `hasCompleteHistory` bounds the walk. The `loadingRef` inside
   * `loadOlder` keeps `startReached` from doubling the same page.
   */
  useEffect(() => {
    if (landedForRef.current === visitKey) return; // one landing per visit
    if (ordered.length === 0) return; // newest page still in flight
    if (!unreadAtOpen) return; // the pane has not captured the slice yet

    const { lastReadId } = unreadAtOpen;
    const unreadFloor = unreadAtOpen.unreadFloor ?? null;
    // A floor is unread state on its own (#54): a fired reminder can make a
    // message unread while the watermark-derived count is 0.
    if (unreadAtOpen.unreadCount === 0 && unreadFloor === null) {
      landedForRef.current = visitKey; // nothing new since the last read
      setDividerId(null);
      return;
    }

    // WHERE the boundary is, positionally: the first row newer than the
    // watermark — whoever wrote it. The unread COUNT excludes your own rows
    // (they never accrue a badge), but the POSITION is the read state's own
    // predicate (`isUnreadByReadState`, packages/state): a watermark, not an
    // authors' club. `useThreads.firstUnreadId` answers the same question the
    // same way, which is why a thread and a channel cannot drift.
    const firstUnreadIndex = (): number => {
      for (let i = 0; i < ordered.length; i++) {
        const m = ordered[i]!;
        if (m.id.startsWith('pending_')) continue; // placeholders are not rows
        if (isUnreadByReadState(m.id, lastReadId, unreadFloor)) return i;
      }
      return -1;
    };

    const boundary = firstUnreadIndex();
    if (boundary < 0) {
      // The watermark covers the whole window: land at the end rather than
      // invent a rule.
      landedForRef.current = visitKey;
      setDividerId(null);
      return;
    }

    // The boundary can sit ABOVE the loaded window (more unread rows than the
    // newest page holds) — in which case the oldest loaded row is not the
    // first unread, it is merely the oldest one loaded. Page older history
    // until the watermark itself is in view, then land: bounded by the store's
    // `hasCompleteHistory`, and a page that brings nothing new leaves the
    // memoized `ordered` identical, so the effect does not re-run (no loop).
    // With a floor, the floored message ITSELF must be loaded (it is the
    // first unread); otherwise the watermark row.
    const anchorId = unreadFloor ?? lastReadId;
    const watermarkSeen = anchorId !== null && ordered.some((m) => compareSnowflakes(m.id, anchorId) <= 0);
    if (anchorId !== null && !watermarkSeen && !completeHistory) {
      void loadOlder(source, store, loadingRef, setLoadingOlder, setLoadError);
      return; // the page lands, `ordered` changes, this effect runs again
    }

    landedForRef.current = visitKey;
    const boundaryId = ordered[boundary]!.id;
    setDividerId(boundaryId);
    // A permalink (#114) names the row the member asked for: it outranks the
    // unread jump, exactly as it does in the thread panel. The rule still
    // draws; only the landing stands down. So does a reader who has already
    // moved the view themselves (`readerMovedRef`): the jump is how a visit
    // OPENS, never something done to a reader mid-read.
    if (focusMessageId === null && readerMovedRef.current !== visitKey) {
      landOnBoundary(boundary, boundaryId);
    }
  }, [
    visitKey,
    source,
    ordered,
    unreadAtOpen,
    completeHistory,
    store,
    focusMessageId,
    landOnBoundary,
  ]);

  // A reminder fired while the pane is open (#54): draw the rule on the
  // floored message without moving the member's scroll position.
  useEffect(() => {
    if (liveUnreadFloor === null) return;
    if (!ordered.some((m) => m.id === liveUnreadFloor)) return;
    setDividerId(liveUnreadFloor);
  }, [liveUnreadFloor, ordered]);

  /**
   * Land on one row: scroll the window to it and flash it once.
   *
   * The scroll goes through `scrollToIndex` (then a rAF, because the row's DOM
   * node only exists once Virtuoso has rendered the new window), and the flash
   * is the same wash the reply-context jump uses — one visual language for
   * "this is the row you asked for". Missing layout (jsdom, a virtualized row
   * not yet rendered) is harmless: the query finds nothing and the flash is
   * skipped, while the scroll itself still moved.
   */
  const landOnRow = useCallback(
    (messageId: string, index: number) => {
      // The reader is being taken somewhere they did not scroll to, so the
      // stick-to-bottom pin must stand down first: merging the target grows the
      // content, and the ResizeObserver pin would otherwise yank the view back
      // to the newest message after this scroll (it fires a frame later, before
      // the scroll event has a chance to disarm it).
      atBottomRef.current = false;
      anchorRestoreRef.current = null;
      syncHold();
      virtuosoRef.current?.scrollToIndex({ index, align: 'center', behavior: 'auto' });
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const paint = () => {
        const el = wrapper.querySelector<HTMLElement>(`[data-message-id="${messageId}"]`);
        if (!el) return;
        el.scrollIntoView?.({ block: 'center' });
        el.classList?.add('message-focus-flash');
        window.setTimeout(() => el.classList?.remove('message-focus-flash'), 1_400);
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paint);
      else paint();
    },
    [syncHold],
  );

  /**
   * The permalink landing sequence: scroll if the row is already loaded,
   * otherwise RESOLVE it through the REST read (#114) and merge it — with one
   * page of older history so the row arrives in a readable neighbourhood
   * rather than alone in an empty pane. A 404 is the honest answer that the
   * message is gone (deleted, or in a channel this account cannot read — the
   * route renders one body for both, by design).
   *
   * A transport failure is NOT terminal: it releases the caller's claim so a
   * later store write retries, because "could not reach the server" must not
   * read as "this message is gone".
   */
  const resolveFocus = useCallback(
    async (messageId: string) => {
      const local = ordered.findIndex((m) => m.id === messageId);
      if (local >= 0) {
        const found = ordered[local];
        if (found) {
          landOnRow(messageId, local);
          onFocusMessage?.(found);
        }
        return;
      }
      try {
        const message = await api.getMessage(channelId, messageId);
        let context: Message[] = [];
        try {
          context = await fetchPage(source, { before: messageId, limit: PAGE_SIZE });
        } catch {
          // Context is a courtesy; the target row is what the link promised.
        }
        // A target outside the loaded window is not ADJACENT to it: the rows
        // between are unknown, so the window is replaced by the target's
        // neighbourhood and detached from the live edge (#9) — merging it in
        // would render a gap as if the rows were consecutive. Scrolling down
        // pages forward back to the present. The window is re-read AFTER the
        // awaits: a page that landed meanwhile may hold the target, and a
        // target inside the window's span is merged in place.
        const now = readSlice(store, source)?.items ?? [];
        if (!now.some((m) => m.id === messageId)) {
          const oldest = edgeRow(now, 'oldest');
          const newest = edgeRow(now, 'newest');
          const inside =
            oldest !== undefined &&
            newest !== undefined &&
            compareSnowflakes(messageId, oldest.id) >= 0 &&
            compareSnowflakes(messageId, newest.id) <= 0;
          mergePage(store, source, [message, ...context], {
            direction: inside ? 'older' : 'jump',
            isLastPage: context.length < PAGE_SIZE,
          });
        }
        // The index is read from the store AFTER the merge landed, derived
        // exactly the way this list derives `ordered` (newest-first → chat
        // order), because the React `ordered` in this closure is stale by now.
        const fresh = [...(readSlice(store, source)?.items ?? [])].reverse();
        landOnRow(messageId, Math.max(fresh.findIndex((m) => m.id === messageId), 0));
        onFocusMessage?.(message);
      } catch (error) {
        if ((error as { status?: number } | null)?.status === 404) {
          setGoneId(messageId);
          return;
        }
        throw error;
      }
    },
    [channelId, source, ordered, store, landOnRow, onFocusMessage],
  );

  /**
   * Own send while DETACHED (#9): the reader is deep in history and just sent a
   * message, whose placeholder sorts at the window's newest end — above a gap.
   * The present is loaded (the newest page replaces the detached window, the
   * placeholder kept) and the view follows it down, as every chat client does
   * when you send while scrolled up.
   */
  const newestIsPending = ordered[ordered.length - 1]?.id.startsWith('pending_') === true;
  useEffect(() => {
    if (!hasNewer || !newestIsPending) return;
    atBottomRef.current = true;
    syncHold();
    void jumpToPresent(source, store, setLoadError);
  }, [hasNewer, newestIsPending, source, store, syncHold]);

  // The window detaching or re-attaching (#9) changes the answer on its own:
  // a detached window never holds the newest message.
  useEffect(() => {
    syncJump();
  }, [hasNewer, syncJump]);

  /** The smooth jump's finish timer (cleared by a newer jump or the unmount). */
  const jumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (jumpTimerRef.current !== null) clearTimeout(jumpTimerRef.current);
    },
    [],
  );

  /**
   * Jump to latest: take the reader to the newest message and FOLLOW again.
   *
   * Two routes, both existing ones:
   *   * the window is detached (#9) — the newest page is not loaded, so it is
   *     read in through the own-send path's `jumpToPresent`, which REPLACES
   *     the window with the present. The follow is armed in the same tick as
   *     that store write, so the commit that renders the present pins it to
   *     its end (the layout pin) — no frame at its top, none at the old
   *     window's end;
   *   * the newest page is loaded — scroll there. Smooth for a short way,
   *     instant for a long one or under reduced motion. The follow is armed
   *     when the scroll lands, not before: armed early, every row Virtuoso
   *     renders on the way down re-pins instantly and cuts the animation
   *     short — the two-movers stutter `followOutput` already learnt about.
   *
   * Read state is untouched: the pane acks the newest message on its own
   * rules (MessagePane), whatever the scroll position.
   */
  const jumpToLatest = useCallback(() => {
    // The jump is the reader's own act: it ends any landing, restore or link
    // still settling (they would otherwise pull the view back to their row).
    landingRef.current = null;
    anchorRestoreRef.current = null;
    readerMovedRef.current = visitKey;
    for (const t of landingTimersRef.current) clearTimeout(t);
    landingTimersRef.current = [];
    if (jumpTimerRef.current !== null) {
      clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = null;
    }

    const arrive = () => {
      jumpTimerRef.current = null;
      jumpingRef.current = false;
      atBottomRef.current = true;
      syncHold();
      pinToNewest();
      // The same settle the bottom pin re-issues on every new newest row:
      // rows that measure taller than their estimate grow the end after it.
      requestAnimationFrame(pinToNewest);
      setTimeout(pinToNewest, 120);
    };

    if (readSlice(store, source)?.hasNewer === true) {
      jumpingRef.current = true;
      syncJump();
      // No forward page may start meanwhile: one landing after the present
      // would splice its rows below a hole (a page already in flight is
      // let be — `loadNewer` owns its own flag). Nor an older one until the
      // landing has settled: the present is one short page, so the range
      // prefetch (#11) asks for the page above it in the very frame it
      // renders, and that prepend landing under the fresh pin painted a
      // blank frame and a few-row bounce (measured). The reader is at the
      // newest message; older history can wait for them to scroll.
      const blockedNewer = !loadingNewerRef.current;
      if (blockedNewer) loadingNewerRef.current = true;
      const blockedOlder = !loadingRef.current;
      if (blockedOlder) loadingRef.current = true;
      const unblockOlder = () => {
        if (blockedOlder) loadingRef.current = false;
      };
      // The follow arms in the same tick as the merge, so the very commit
      // that brings the present renders it pinned (see the layout pin) — the
      // old window is never pinned to its own end on the way. Unconditional:
      // the present replaces the window whatever the reader did meanwhile,
      // so the jump they asked for completes.
      const armFollow = () => {
        jumpingRef.current = true;
        atBottomRef.current = true;
        pinOnNextNewestRef.current = true;
        syncHold();
        presentJumpRef.current = true; // see the firstItemIndex block
      };
      void jumpToPresent(source, store, setLoadError, armFollow).then((landed) => {
        if (blockedNewer) loadingNewerRef.current = false;
        setTimeout(unblockOlder, JUMP_PRESENT_SETTLE_MS);
        if (landed) arrive();
        else {
          // Failed: the list's banner says so, and the button comes back.
          jumpingRef.current = false;
          syncJump();
        }
      });
      return;
    }

    const scroller = scrollerElement();
    if (!scroller) return;
    const distance = distanceFromEnd(scroller);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (
      reduced ||
      typeof scroller.scrollTo !== 'function' ||
      distance > scroller.clientHeight * JUMP_SMOOTH_MAX_VIEWPORTS
    ) {
      arrive();
      return;
    }
    jumpingRef.current = true;
    syncJump();
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'smooth' });
    const done = () => {
      scroller.removeEventListener('scrollend', done);
      // A wheel or a touch mid-flight handed the view back to the reader.
      if (jumpingRef.current) arrive();
    };
    scroller.addEventListener('scrollend', done);
    jumpTimerRef.current = setTimeout(done, JUMP_SMOOTH_SETTLE_MS);
  }, [visitKey, store, source, syncHold, syncJump, pinToNewest, scrollerElement]);

  /**
   * The button's click. A KEYBOARD activation (`detail === 0`) has nowhere to
   * leave focus — the button goes away under it — so focus moves on to the
   * conversation's composer, where a reader who jumped to the present types
   * next. A pointer click leaves focus alone: on a phone, focusing the
   * composer would raise the keyboard.
   */
  const handleJumpClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      jumpToLatest();
      if (e.detail !== 0) return;
      let sibling = wrapperRef.current?.parentElement?.nextElementSibling ?? null;
      while (sibling !== null) {
        const input = sibling.querySelector<HTMLElement>('[contenteditable="true"]');
        if (input) {
          // preventScroll: a focus scroll would cut the smooth jump short.
          input.focus({ preventScroll: true });
          return;
        }
        sibling = sibling.nextElementSibling;
      }
    },
    [jumpToLatest],
  );

  // One attempt per target id, claimed BEFORE the await so two store writes in
  // the same tick cannot both start the resolver.
  useEffect(() => {
    if (focusMessageId === null) return;
    if (focusedRef.current === focusMessageId) return;
    if (!initialSettled) return;
    focusedRef.current = focusMessageId;
    resolveFocus(focusMessageId).catch(() => {
      // Unreachable server: let the next store write try again.
      focusedRef.current = null;
    });
  }, [focusMessageId, initialSettled, resolveFocus]);

  // U14: the follow decision, STABLE and instant. A fresh inline function
  // per render re-processed through Virtuoso's reactive graph, and 'smooth'
  // animated the scroll the instant pin (`totalListHeightChanged`, the
  // ResizeObservers) was already writing — two movers fighting over one
  // offset, which read as a stutter on every incoming message.
  const followOutput = useCallback(() => (atBottomRef.current ? ('auto' as const) : false), []);

  /**
   * The restore's settle (#13). Starts once the anchored row is in the window
   * — at mount, or when the read around it lands — and re-applies the anchor
   * across the window in which rows around it finish measuring (list-height
   * changes re-apply it too, `onListHeightChanged`). The reader is scrolled
   * up, so the window holds its oldest rows (#9) instead of evicting the one
   * on screen for a live message.
   */
  const pendingAnchor = anchorRestoreRef.current;
  const anchorInWindow =
    pendingAnchor !== null && ordered.some((m) => isAnchorRow(m, pendingAnchor));
  useEffect(() => {
    if (!anchorInWindow) return;
    syncHold();
    applyAnchor();
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(applyAnchor) : null;
    const beats = ANCHOR_SETTLE_BEATS_MS.map((ms) => setTimeout(applyAnchor, ms));
    const done = setTimeout(() => {
      applyAnchor();
      anchorRestoreRef.current = null;
      savePosition();
    }, ANCHOR_SETTLE_MS);
    return () => {
      if (raf !== null) cancelAnimationFrame(raf);
      for (const t of beats) clearTimeout(t);
      clearTimeout(done);
    };
  }, [anchorInWindow, applyAnchor, syncHold, savePosition]);

  const listContext = useMemo<ListContext>(
    () => ({
      completeHistory,
      hasNewer,
      showLoadingOlder,
      showLoadingNewer,
      historyHeader,
    }),
    [completeHistory, hasNewer, showLoadingOlder, showLoadingNewer, historyHeader],
  );

  return (
    <div
      ref={wrapperRef}
      /* `relative` anchors the copy confirmation (#114) and the jump button;
         the hover toolbar positions against each row, not this wrapper, so
         nothing moves. */
      className="relative h-full"
      data-testid="message-list"
      data-channel-id={channelId}
      data-thread-id={threadId ?? undefined}
      /* #13: this visit resumed a saved reading position (e2e witness). */
      data-restored={restore !== null || undefined}
    >
      {/* Overlaid, not in flow (#11): a banner above the scroller shrank it by
          its own height and shifted every row the reader was looking at. */}
      {loadError && (
        <p
          role="alert"
          className="absolute inset-x-3 top-2 z-30 rounded-md border border-danger/40 bg-surface-strong px-3 py-1.5 text-sm text-danger shadow-[var(--shadow-popover)]"
          data-testid="list-error"
        >
          {loadError}
        </p>
      )}
      {/* #114: a link whose message the server does not have any more. It is
          reported, not hidden: the reader followed an address that promised a
          message, and landing silently on the newest page would read as "the
          link went to the wrong place". */}
      {goneId !== null && (
        <p
          role="status"
          className="px-4 py-2 text-center text-sm text-text-muted"
          data-testid="message-gone"
        >
          That message is gone — it was deleted, or it is not available to this account.
        </p>
      )}
      {/* The list's OWN crash guard (#135/#137): a render-time blow-up inside
          Virtuoso's emit graph remounts the LIST — position reset, session,
          store history and composer all survive — instead of reaching the
          app-shell boundary and taking the whole session down. See
          ListErrorBoundary for the remount cap. */}
      {/* #13: Virtuoso mounts only once there are rows to lay out. Mounted on
          an empty window it settled at index 0 and then re-landed when the
          first page arrived; the pane's skeleton covers that wait instead. A
          DRAFT thread has no page to wait for: it mounts empty, so its first
          reply appears in the scroller already on screen. */}
      {ordered.length === 0 && !draft ? (
        threadId !== null && historyHeader !== null ? (
          /* A thread reads from the top — the origin, then its replies
             (0e8a5756) — so a thread with none shows its origin there too. */
          <div className="flex h-full flex-col overflow-y-auto" data-testid="list-history-only">
            {historyHeader}
          </div>
        ) : null
      ) : (
        <ListErrorBoundary>
          <Virtuoso
            ref={virtuosoRef}
            data={ordered}
            context={listContext}
            components={LIST_COMPONENTS}
            firstItemIndex={firstItemIndex}
            /* #13: a return opens ON the reader's row, at its saved offset
               (the settle above corrects it once rows measure); every other
               open lands on the newest message. */
            initialTopMostItemIndex={
              restore !== null && restore.index !== null
                ? { index: restore.index, align: 'start', offset: restore.anchor.offset }
                : Math.max(0, ordered.length - 1)
            }
            defaultItemHeight={DEFAULT_ITEM_HEIGHT}
            /* NOT skipAnimationFrameInResizeObserver (#13 asked for it):
               measured in a real browser, synchronous size reports let
               Virtuoso re-anchor a reader scrolled to the top down to the
               newest row when they sent a message (pane-layout.spec, "a
               message arriving while scrolled up"). The rAF hop stays. */
            computeItemKey={computeItemKey}
            itemContent={itemContent}
            startReached={handleStartReached}
            endReached={hasNewer ? handleEndReached : undefined}
            rangeChanged={handleRangeChanged}
            /* A FUNCTION, not the constant: a constant string follows every
               append regardless of where the reader is, which yanks someone
               reading history down to the newest message (user report
               2026-09-13). The reader's own position decides, through the same
               ref the pin uses. */
            followOutput={followOutput}
            increaseViewportBy={INCREASE_VIEWPORT_BY}
            totalListHeightChanged={onListHeightChanged}
            className="h-full"
          />
        </ListErrorBoundary>
      )}

      {/* Jump to latest (owner, 2026-10-01): floats over the timeline at its
          bottom-right, above the composer, never in flow (the
          .editor-palettes approach) — appearing must not move a row. Always
          mounted with the scroller so it can animate in AND out; while the
          newest message is in view it is disabled and hidden from assistive
          tech, so it is neither announced nor in the tab order. */}
      {ordered.length > 0 || draft ? (
        <button
          type="button"
          className="jump-latest"
          data-testid="jump-to-latest"
          data-state={awayFromLatest ? 'visible' : 'hidden'}
          aria-label="Jump to latest messages"
          title="Jump to latest messages"
          aria-hidden={awayFromLatest ? undefined : true}
          disabled={!awayFromLatest}
          onClick={handleJumpClick}
        >
          <ArrowDownIcon aria-hidden="true" className="jump-latest-icon" strokeWidth={2.25} />
        </button>
      ) : null}

      {/* #114: the copy outcome. Hosted HERE (above the windowing boundary)
          and not inside the hover toolbar, which is `hidden` while the pointer
          is away — a confirmation that vanishes with the row it belongs to
          would be the silent copy the ticket calls a bug report. `role=status`
          is the polite live region a screen reader reads out. */}
      {copyNotice !== null && (
        <div
          role="status"
          className="pointer-events-none absolute bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-lg border border-line bg-surface-strong px-3 py-1.5 text-sm text-text-primary shadow-lg"
          data-testid="copy-link-notice"
        >
          {copyNotice}
        </div>
      )}

      {/* U3: the long-press actions sheet — hosted ABOVE the windowing
          boundary (one sheet for the whole list; rows only report the
          gesture). Portal-rendered by Radix, so its position in this tree
          is about ownership, not geometry. */}
      {(() => {
        const sheetMessage = sheet.messageId
          ? messages.find((m) => m.id === sheet.messageId) ?? null
          : null;
        if (!sheetMessage) return null;
        return (
          <MessageActionsSheet
            message={sheetMessage}
            open={sheet.messageId !== null}
            onOpenChange={handleSheetOpenChange}
            currentUserId={currentUserId}
            canManageMessages={canManageMessages}
            onToggleReaction={onToggleReaction}
            onReact={onReact}
            onReply={onReply}
            onEditSubmit={onEditSubmit}
            onDeleteConfirmed={onDeleteConfirmed}
            onStartThreadNamed={onStartThreadNamed}
            onCopyLink={copyLinkFor}
            onRemind={viewOnly ? undefined : (m) => setRemindFor({ channelId: m.channel_id, messageId: m.id })}
          />
        );
      })()}
      {remindFor ? (
        <MarkPickerDialog
          channelId={remindFor.channelId}
          messageId={remindFor.messageId}
          open
          onOpenChange={(o) => {
            if (!o) setRemindFor(null);
          }}
        />
      ) : null}
    </div>
  );
});

/** A row's stable key: the send's client key when it has one (lane D #12). */
function rowKey(message: Message): string {
  return message.client_key ?? message.id;
}

/** A seed row's thread summary (the indicator under the message). */
interface SeedThread {
  id: string;
  name: string;
  messageCount: number;
  latestReplyAt: string | null;
}

/** What the list's header/footer read (Virtuoso `context`). */
interface ListContext {
  completeHistory: boolean;
  hasNewer: boolean;
  showLoadingOlder: boolean;
  showLoadingNewer: boolean;
  historyHeader: React.ReactNode;
}

/**
 * The top of the list (#11). While older history remains it is a FIXED band
 * — the "Loading older messages…" line lives inside it and only its text
 * toggles, so a page starting or finishing never changes the list's height
 * (the old indicator was rendered after the full-height scroller, below the
 * viewport, and was never seen where it belonged). At the start of history it
 * is the host's header (a thread's starter line + origin), or nothing.
 */
function ListHeader({ context }: { context?: ListContext }) {
  if (!context) return null;
  if (!context.completeHistory) {
    return (
      <div
        className="flex items-center justify-center text-xs text-text-muted"
        style={{ height: HISTORY_HEADER_PX }}
        data-testid="history-header"
      >
        {context.showLoadingOlder ? (
          <span role="status" data-testid="loading-older">
            Loading older messages…
          </span>
        ) : null}
      </div>
    );
  }
  return context.historyHeader ? <>{context.historyHeader}</> : null;
}

/** The bottom band while the window is detached from the present (#9). */
function ListFooter({ context }: { context?: ListContext }) {
  if (!context?.hasNewer) return null;
  return (
    <div
      className="flex items-center justify-center text-xs text-text-muted"
      style={{ height: HISTORY_HEADER_PX }}
      data-testid="newer-footer"
    >
      {context.showLoadingNewer ? (
        <span role="status" data-testid="loading-newer">
          Loading newer messages…
        </span>
      ) : null}
    </div>
  );
}

/** Module constant: a fresh components object per render re-mounts them. */
const LIST_COMPONENTS = { Header: ListHeader, Footer: ListFooter };

/** `value`, but only once it has held for `delayMs` (false resets at once). */
function useDelayedFlag(value: boolean, delayMs: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!value) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return value && shown;
}

/** Thin centered date divider (corpus §2: hairline rules either side). */
function DateDivider({ iso }: { iso: string }) {
  const label = formatLongDate(iso);
  return (
    <div
      className="mx-4 flex items-center gap-3 pt-4 first:pt-1"
      role="separator"
      aria-label={label}
      data-testid="date-divider"
    >
      <span className="h-px flex-1 bg-line" aria-hidden />
      <span className="text-xs font-medium text-text-muted">{label}</span>
      <span className="h-px flex-1 bg-line" aria-hidden />
    </div>
  );
}


/** The slices this list actually renders, selected out of the store. */
interface ChannelSnapshot {
  items: readonly Message[];
  membersById: StateState['membersById'];
  /** This channel's workspace nicknames (#169); undefined in a DM. */
  nicknames: Readonly<Record<string, string>> | undefined;
  threadIds: readonly string[];
  threadsById: StateState['threadsById'];
  /** True when the store has seen the window's oldest page (#104 paging). */
  completeHistory: boolean;
  /** The window is detached from the live edge (#9). */
  hasNewer: boolean;
  currentUser: StateState['currentUser'];
}

/** The window a list reads: a channel, or a thread inside it. */
interface ListSource {
  channelId: string;
  threadId: string | null;
}

// Stable identities for absent values: a fresh `[]` per read would defeat the
// field-by-field comparison below (and every memo keyed on `items`).
const NO_ITEMS: readonly Message[] = [];
const NO_THREAD_IDS: readonly string[] = [];
const EMPTY_THREADS: StateState['threadsById'] = {};

function readChannelSnapshot(
  store: StateStore | undefined,
  source: ListSource,
): ChannelSnapshot | null {
  const s = store?.getState();
  if (!s) return null;
  if (source.threadId !== null) {
    const slice = s.messagesByThread[source.threadId];
    const items = slice?.items ?? NO_ITEMS;
    // A thread's summary counts its replies (#106), so a window holding that
    // many has reached the start even before a short page proved it.
    const count = s.threadsById[source.threadId]?.message_count;
    const loaded = items.reduce((n, m) => (m.id.startsWith('pending_') ? n : n + 1), 0);
    return {
      items,
      membersById: s.membersById,
      nicknames: nicknamesForChannel(s, source.channelId),
      // Replies do not seed threads: no indicator map in thread mode.
      threadIds: NO_THREAD_IDS,
      threadsById: EMPTY_THREADS,
      completeHistory:
        slice?.hasCompleteHistory === true || (typeof count === 'number' && loaded >= count),
      hasNewer: slice?.hasNewer === true,
      currentUser: s.currentUser,
    };
  }
  const slice = s.messagesByChannel[source.channelId];
  return {
    items: slice?.items ?? NO_ITEMS,
    membersById: s.membersById,
    nicknames: nicknamesForChannel(s, source.channelId),
    threadIds: s.threadIdsByChannel[source.channelId] ?? NO_THREAD_IDS,
    threadsById: s.threadsById,
    completeHistory: slice?.hasCompleteHistory === true,
    hasNewer: slice?.hasNewer === true,
    currentUser: s.currentUser,
  };
}

function sameChannelSnapshot(a: ChannelSnapshot | null, b: ChannelSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  // Field identities are slices of an immutable store, so a write to any
  // OTHER channel (or a presence/typing/session write) leaves them all equal.
  return (
    a.items === b.items &&
    a.membersById === b.membersById &&
    a.nicknames === b.nicknames &&
    a.threadIds === b.threadIds &&
    a.threadsById === b.threadsById &&
    a.completeHistory === b.completeHistory &&
    a.hasNewer === b.hasNewer &&
    a.currentUser === b.currentUser
  );
}

/**
 * Subscribe to the channel's own slice of the store.
 *
 * A whole-store snapshot was re-rendering the entire list on ANY write — a
 * typing indicator, a presence flip, a message in another channel — and every
 * re-render re-derives each visible row's names, avatars and mention
 * resolver. Selecting the six fields the list reads keeps the identity stable
 * across every unrelated write, so only this channel's traffic (and roster /
 * thread / session changes) reaches the rows.
 */
function useChannelSnapshot(store: StateStore | undefined, source: ListSource) {
  const [snapshot, setSnapshot] = useState(() => readChannelSnapshot(store, source));
  const latest = useRef(snapshot);
  /** The source the subscription below currently serves. */
  const subscribed = useRef({ store, source });

  useEffect(() => {
    subscribed.current = { store, source };
    if (!store) return;
    const publish = () => {
      const next = readChannelSnapshot(store, source);
      if (sameChannelSnapshot(latest.current, next)) return;
      latest.current = next;
      setSnapshot(next);
    };
    const unsub = store.subscribe(publish);
    publish(); // channel change: re-read before the next store write
    return unsub;
  }, [store, source]);

  /*
   * A NEW source is read in the render that brings it (2026-10-01), not one
   * commit later when the effect above re-subscribes. A draft thread promoted
   * to its created thread changes the source while the list stays mounted,
   * and the draft's window has just moved: for that one commit the held
   * snapshot was the draft key's — now empty — so the list dropped its rows,
   * swapped Virtuoso for the empty view and remounted the origin (a flash).
   * The fields read are store slices, so a fresh read is identity-stable.
   */
  if (subscribed.current.source !== source || subscribed.current.store !== store) {
    return readChannelSnapshot(store, source);
  }
  return snapshot;
}

/** The window's slice (a channel's, or a thread's). */
function readSlice(store: StateStore, source: ListSource) {
  const s = store.getState();
  return source.threadId !== null
    ? s.messagesByThread[source.threadId]
    : s.messagesByChannel[source.channelId];
}

/** One REST page of the window's history (newest-first, like every read). */
async function fetchPage(
  source: ListSource,
  params: { before?: string; after?: string; limit: number },
): Promise<Message[]> {
  if (source.threadId !== null) {
    return (await api.getThreadMessagePage(source.threadId, params)).items;
  }
  return (await api.getMessagePage(source.channelId, params)).items;
}

/** Merge a page into the window's slice — ONE store write either way. */
function mergePage(
  store: StateStore,
  source: ListSource,
  items: Message[],
  options: MergeOptions,
): void {
  if (source.threadId !== null) mergeThreadMessages(store, source.threadId, items, options);
  else mergeChannelMessages(store, source.channelId, items, options);
}

/** The newest / oldest SERVER row of a window (placeholders are not cursors). */
function edgeRow(items: readonly Message[], end: 'newest' | 'oldest'): Message | undefined {
  if (end === 'newest') return items.find((m) => !m.id.startsWith('pending_'));
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i]!;
    if (!m.id.startsWith('pending_')) return m;
  }
  return undefined;
}

/**
 * Load the newest page of a channel into the store.
 *
 * STALE-WHILE-REVALIDATE: a channel whose messages are already in the store
 * renders them at once and refreshes underneath, instead of blanking the pane
 * for a round-trip it does not need. The pane used to report `loading` on
 * every open — including switching BACK to a channel it had just loaded — and
 * the pane answers `loading` with a full-area placeholder, so every switch
 * flashed an empty conversation (user report 2026-09-11: "switching between
 * channels the entire screen's gray with a fetching messages message...
 * jarring"). Only a channel with nothing cached shows the placeholder.
 *
 * A refresh that fails on a cached channel keeps the content and says so
 * through the list's own non-blocking banner (the same one older pages use) —
 * replacing the conversation with an error screen would be worse than showing
 * slightly stale messages.
 */
async function loadNewest(
  source: ListSource,
  store: StateStore | undefined,
  onInitialLoad?: (state: MessageListLoadState) => void,
  setLoadError?: (e: string | null) => void,
  override?: () => Promise<unknown>,
): Promise<void> {
  if (!store) return;
  // Lane D #24: "cached" means a REST window was merged (`oldestId` set) —
  // not merely that live traffic created a slice. A channel never opened
  // that received one message used to count as cached: it painted that ONE
  // row, then jumped to fifty when the page landed. (A thread's window is
  // only ever created by its own reads and sends.)
  const cached =
    source.threadId === null
      ? hasLoadedHistory(store.getState(), source.channelId)
      : (readSlice(store, source)?.items.length ?? 0) > 0;
  // Report BEFORE the await: with content cached the pane must render it in
  // this tick, not after a round-trip it does not need.
  onInitialLoad?.(cached ? { status: 'ready' } : { status: 'loading' });
  setLoadError?.(null);
  try {
    if (override) {
      await override();
    } else {
      const items = await fetchPage(source, { limit: PAGE_SIZE });
      mergePage(store, source, items, {
        direction: 'newest',
        isLastPage: items.length < PAGE_SIZE,
      });
    }
    onInitialLoad?.({ status: 'ready' });
  } catch {
    if (cached) {
      setLoadError?.('Could not refresh messages. Showing what is already loaded.');
      onInitialLoad?.({ status: 'ready' });
    } else {
      onInitialLoad?.({ status: 'error', error: 'Could not load messages.' });
    }
  }
}

/** Load the next older page (before the oldest loaded message). */
async function loadOlder(
  source: ListSource,
  store: StateStore | undefined,
  loadingRef: React.MutableRefObject<boolean>,
  setLoadingOlder: (v: boolean) => void,
  setLoadError: (e: string | null) => void,
): Promise<void> {
  if (!store || loadingRef.current) return;
  const slice = readSlice(store, source);
  if (!slice || slice.hasCompleteHistory) return;
  const oldest = edgeRow(slice.items, 'oldest');
  if (!oldest) return;

  loadingRef.current = true;
  setLoadingOlder(true);
  setLoadError(null);
  try {
    const items = await fetchPage(source, { before: oldest.id, limit: PAGE_SIZE });
    mergePage(store, source, items, {
      direction: 'older',
      isLastPage: items.length < PAGE_SIZE,
    });
  } catch {
    setLoadError('Could not load older messages. Try again.');
  } finally {
    loadingRef.current = false;
    setLoadingOlder(false);
  }
}

/**
 * Page FORWARD on a detached window (#9, the `after=` cursor from #152). A
 * short page re-attaches the window to the live edge; a live message that
 * arrived while it was detached was not slid in (it would have sat above a
 * gap), so if the recency fact says the channel has moved past the page, the
 * newest page is merged too.
 */
async function loadNewer(
  source: ListSource,
  store: StateStore | undefined,
  loadingRef: React.MutableRefObject<boolean>,
  setLoadingNewer: (v: boolean) => void,
  setLoadError: (e: string | null) => void,
): Promise<void> {
  if (!store || loadingRef.current) return;
  const slice = readSlice(store, source);
  if (!slice || slice.hasNewer !== true) return;
  const newest = edgeRow(slice.items, 'newest');
  if (!newest) return;

  loadingRef.current = true;
  setLoadingNewer(true);
  setLoadError(null);
  try {
    const items = await fetchPage(source, { after: newest.id, limit: PAGE_SIZE });
    const isLastPage = items.length < PAGE_SIZE;
    mergePage(store, source, items, { direction: 'newer', isLastPage });
    if (isLastPage && source.threadId === null) {
      const recency = store.getState().lastMessageIdByChannel[source.channelId];
      const head = edgeRow(readSlice(store, source)?.items ?? [], 'newest');
      if (recency !== undefined && head !== undefined && compareSnowflakes(recency, head.id) > 0) {
        const latest = await fetchPage(source, { limit: PAGE_SIZE });
        mergePage(store, source, latest, { direction: 'newest' });
      }
    }
  } catch {
    setLoadError('Could not load newer messages. Try again.');
  } finally {
    loadingRef.current = false;
    setLoadingNewer(false);
  }
}

/**
 * Replace a detached window with the present (the own-send effect, and the
 * jump-to-latest button). `beforeMerge` runs in the same tick as the store
 * write, so a caller can arm what the new window's first render must see.
 * Resolves true once the present is in the window.
 */
async function jumpToPresent(
  source: ListSource,
  store: StateStore | undefined,
  setLoadError: (e: string | null) => void,
  beforeMerge?: () => void,
): Promise<boolean> {
  if (!store) return false;
  try {
    const items = await fetchPage(source, { limit: PAGE_SIZE });
    beforeMerge?.();
    mergePage(store, source, items, {
      direction: 'newest',
      isLastPage: items.length < PAGE_SIZE,
    });
    return true;
  } catch {
    setLoadError('Could not load the latest messages. Try again.');
    return false;
  }
}

/**
 * Read the window back in AROUND a reader's saved row (#13): the page that
 * starts at the row (`after=` the id just below it, so the row itself is
 * included) and the page before it, merged as a jump — the window is replaced
 * by the row's neighbourhood and detached from the live edge (#9); scrolling
 * down pages forward to the present. False when the row is not there any more
 * (deleted) or the read failed: the caller opens at the newest instead.
 */
async function loadAround(
  source: ListSource,
  store: StateStore | undefined,
  anchor: ReadingAnchor,
): Promise<boolean> {
  const after = cursorJustBefore(anchor.id);
  if (!store || after === null) return false;
  try {
    const [from, before] = await Promise.all([
      fetchPage(source, { after, limit: PAGE_SIZE }),
      fetchPage(source, { before: anchor.id, limit: PAGE_SIZE }),
    ]);
    if (!from.some((m) => m.id === anchor.id)) return false;
    mergePage(store, source, [...from, ...before], {
      direction: 'jump',
      isLastPage: before.length < PAGE_SIZE,
    });
    return true;
  } catch {
    return false;
  }
}
