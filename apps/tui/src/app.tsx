/**
 * @cytale/tui — the Ink root: the connection banner and the two-column shell
 * (U5's banner, U6's shell, U7's history and pagination, U8's composer and live
 * arrival).
 *
 * Two jobs, and neither swallows the other:
 *
 *   1. **The connection surface** (R19a's visible half, U5). The member must
 *      always be able to see what the client thinks its connection is doing, so
 *      a stall prints a named phase instead of an empty screen. The phase is
 *      derived from real signals in `client.ts`; this module renders the view it
 *      is handed, and `PHASE_MARKERS` gives every phase a non-colour channel
 *      (§the banner is unchanged by U6, U7, and U8, deliberately).
 *   2. **The two-column shell** (R15, R16, R17, R18, R19, R25, R28). Column one
 *      navigates the active workspace's channels or the account's DMs; column
 *      two renders the selected conversation's messages, or an open thread's
 *      replies — and carries the composer at its bottom edge.
 *
 * ---------------------------------------------------------------------------
 * Where the data comes from
 * ---------------------------------------------------------------------------
 *
 * The SHARED store (`@cytale/state`), read through `useSyncExternalStore` — the
 * same slices `apps/web` renders and the same ones U12's hydration and the
 * gateway fill. This module owns no fetch, no cache, and no derived copy: the
 * keyboard's *bounds* (how many rows exist, which message is highlighted) are
 * computed from the store on every render, so a message the gateway folds in
 * while the member is looking at a pane is on screen without a reload.
 *
 * A boot load is wired by the host that owns the session, not here: `navigation`
 * lets that host tell column one what it knows (loading, ready, or the reason a
 * fetch failed), and without it the shell derives an honest default from the
 * connection phase and whether the store holds anything yet.
 *
 * ---------------------------------------------------------------------------
 * U7: history, pagination, and the thread pane
 * ---------------------------------------------------------------------------
 *
 * Column two's pages arrive through ONE optional seam, `onLoadHistory`. It is a
 * seam and not a fetch here because this module has no api and no token — the
 * host that owns the session does — and because the loader's contract is a
 * single sentence: fetch this page and FOLD IT INTO THE SHARED STORE. The pane
 * then grows on the store's notification, exactly like a message the gateway
 * delivered; nothing is kept here.
 *
 * What IS here is the paging model, and it is small on purpose:
 *
 *   * A page is asked for when the pane has nothing at all (`needsFirstPage`) or
 *     when the shell's cursor reaches the OLDEST loaded row and the store says
 *     the history is not complete. Asking again is free to be repeated by the
 *     member (`k` at the top) and impossible to repeat by a re-render: one
 *     request per (pane, cursor, keystroke), and at most one in flight.
 *   * When a page lands, the cursor is re-anchored on the MESSAGE it was on, and
 *     the viewport moves by the same delta — a prepended page shifts every index
 *     under the member, and their position on screen must not move with it.
 *   * A failed page renders inline (with the retry hint) and leaves the rows the
 *     member already has where they are. A failed THREAD read never clears the
 *     channel: the channel's slice is not this pane's to touch.
 *
 * ---------------------------------------------------------------------------
 * U8: the composer, and what happens when a message lands
 * ---------------------------------------------------------------------------
 *
 * The composer is MULTILINE (Enter sends, Shift+Enter inserts a newline — the
 * binding `apps/web`'s composer settled) and it owns Enter only while it is
 * focused, which is U6's reducer rule and not this module's to restate. What
 * this module adds is the seam the send rides: `onSendTo` gets the resolved
 * `ContentTarget` (U7's, never re-derived here) and the typed text, and the
 * host that wires the api-client returns a promise — so a REJECTED send keeps
 * the member's text and renders the reason (`compose/send.ts` owns the
 * wording and the optimistic write). A host that returns nothing gets the
 * synchronous behavior: the text is given up on the keystroke, because a
 * caller with nothing to await has nothing to say about the outcome.
 *
 * The ARRIVAL POLICY (step 4) lives in `compose/Composer.tsx` beside the
 * affordance it renders, and is stated there in full. The half that lives
 * here is the wiring: a `pin` decision moves the cursor and the viewport with
 * the newest row, a `hold` decision leaves both exactly where the reader put
 * them, and the composer's own line counts are refunded to column two's budget
 * so the composer cannot push the shell past the window.
 *
 * A FRESH IDENTIFY re-derives the selection rather than assuming it survived
 * (step 6): the store resets, column one's list is rebuilt from what the boot
 * load wrote, and `conversationId` is a projection of that list — not a saved
 * id. The arrival baseline is keyed on the session epoch for the same reason,
 * so a re-hydration is not mistaken for a backlog of unread arrivals.
 *
 * ---------------------------------------------------------------------------
 * Where the input goes
 * ---------------------------------------------------------------------------
 *
 * One `useInput` handler, one key map (`keys.ts`), one reducer. The reducer is
 * pure, so the keyboard model is exercised in tests without a terminal; the
 * handler only wires the reducer's one-shot effects to the host's callbacks
 * (`onQuit`, `onSearch`, `onMarkRead`, `onMarkUnread`, `onConversationOpened`,
 * `onSend`/`onSendTo`, `onToggleReaction`). Callbacks the host has not provided
 * are simply not wired — no fake behaviour stands in for a surface a later unit
 * owns (search arrives with U13). Shift+Enter is handled here, before the
 * reducer, because the reducer's contract is "Enter in the composer is SEND"
 * and a newline is not a key the map binds: it is text, and
 * `applyToComposerText` (U6's) is what inserts text. The one binding this module
 * reads more narrowly than the map states is `Ctrl+D`: while rows newer than the
 * reader's anchor are waiting, it means "all the way down" (`Composer`'s
 * affordance says so); a dedicated `jump-to-newest` binding belongs in
 * `KEY_MAP`, which this unit does not own.
 *
 * ---------------------------------------------------------------------------
 * U10 and U14: what this shell wires, and the two choices it made
 * ---------------------------------------------------------------------------
 *
 *   * **The badge** (U10, R22a) rides `buildNavigationList`'s existing
 *     `unreadCount` seam, bound to `session/readState.ts`'s `readBadge` — the
 *     SERVER's count, which is the only one that covers a channel this client
 *     has never loaded. Nothing here derives a count of its own.
 *   * **The read capture** (U10) is `onConversationOpened`, fired from the
 *     selection (one level up from the pane; see the effect's own note). The `r`
 *     binding keeps its meaning through `onMarkRead`, and `u` now carries the
 *     conversation id as well, because U10's floor is written through the
 *     channel-scoped ack route.
 *   * **The reaction key** (U14, R24) is `e`, bound in `keys.ts` to
 *     `toggle-reaction`, and it TOGGLES THE PALETTE'S FIRST EMOJI (👍) rather
 *     than opening a picker. Two reasons, both about the surface this client
 *     has: a picker needs a third `ShellOverlay` with its own cursor, its own
 *     Escape semantics and its own empty state — a modal whose only job is to
 *     pick one of eight glyphs — while the single toggle makes R24's "add one /
 *     remove their own" reachable with one keystroke and states which emoji it
 *     acted on in the chip row itself. (The exact emoji is a one-line change if
 *     the member's palette ever becomes a preference.) The failure line rides
 *     the composer's status line: the shell has no other one-line surface, and
 *     it is already inert-rendered and counted against the pane's budget.
 *
 * ---------------------------------------------------------------------------
 * U13: search — the query surface, the fetch seam, and the jump
 * ---------------------------------------------------------------------------
 *
 * `/` opens the search pane (U6's `search` binding) and this shell owns it: the
 * query is typed here, the SCOPE follows column one's mode — the active
 * workspace, or the member's own conversations (R23's two halves) — and the
 * results are drawn by `columns/SearchView.tsx` in column TWO, so the member
 * keeps their navigation while they search.
 *
 * Four things about it are worth stating rather than inferring:
 *
 *   * **The fetch is a seam, and the payload is read, not trusted.**
 *     `onSearchQuery` is asked once per query change and hands back whatever the
 *     server answered; `compose/search.ts` projects rows from it, because the
 *     api-client's declared `SearchResult` (`{items, cursor}`) is not the
 *     envelope the search controller serves (`{results, next_before}`, with no
 *     body and no author on a hit). Nothing here holds a cache: the rows live
 *     in this pane's state for as long as the pane does, and the SHARED store
 *     supplies the conversation names, authors, and bodies the wire omits.
 *   * **A superseded query is DROPPED, not overwritten.** Every issue captures
 *     a monotonic epoch and compares it at settle, so a fast typist — or a
 *     member backspacing through a query that is still in flight — cannot have
 *     an older answer render over a newer one. The empty query bumps the epoch
 *     too: it asks nothing, and it must also cancel what was already asked.
 *   * **Opening a result is a JUMP, and the cursor is the point of it.** The
 *     row's conversation is selected in column one (in the mode the hit's scope
 *     names), and the message id rides `jump` until the pane can show it: the
 *     first page loads through U7's `onLoadHistory` seam, the anchor is found
 *     with `indexOfRow`, and the cursor and viewport move together so the
 *     message is on screen. A message the pane's SETTLED history does not hold
 *     renders one line saying so — deleted, or older than what is loaded, which
 *     are two different facts — on the composer's status surface (the shell's
 *     only one-line one), and the conversation stays drawn: an empty pane over
 *     a working channel would be the lie that rule exists to prevent. A jump
 *     still pending is abandoned by the member's next keystroke, so it can
 *     never yank the cursor out from under them.
 *   * **Offline, the query is not sent at all.** The pane states the reason,
 *     which is the same rule U14's reaction binding follows: a request the
 *     transport cannot complete must not be issued as though it could.
 *
 * The pane has the client's two-step text model, which is the composer's: `/`
 * puts the pane on screen, and `i` — the key that writes anywhere else here —
 * hands the query line the keyboard, so a stray `/` cannot swallow the next
 * keystroke and the columns keep their own keys until the member asks for the
 * query. While the query line has focus it is a TEXT surface (printable keys
 * are query text, `q` included), the arrows still choose a result, Enter opens
 * the highlighted one — or re-issues the query, which is the retry the failure
 * line names — and Escape closes the pane in one press, whatever the focus. The
 * pane's presence is carried by `keys.ts`'s overlay member, which is why the
 * map's column actions stay inert behind it; the body-replacing overlays (`?`
 * for the key reference, `w` for the workspace chooser) take the column from the
 * pane as they do from any other surface, because the overlay slot holds one
 * surface at a time.
 */
import { Box, Text, useApp, useInput, useWindowSize } from 'ink';
import { useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';

import { defaultStore, type StateStore, type StateState } from '@cytale/state';

import {
  ContentColumn,
  buildContentView,
  paneRows,
  type ContentTarget,
  type ContentView,
} from './columns/ContentColumn.js';
import {
  NAVIGATION_LOADING,
  NAVIGATION_READY,
  NavigationColumn,
  buildNavigationList,
  type NavigationList,
  type NavigationStatus,
} from './columns/NavigationColumn.js';
import type { ReactionOutcome } from './columns/Reactions.js';
import {
  WorkspaceSelect,
  needsWorkspaceSelection,
  resolveActiveWorkspaceId,
} from './columns/WorkspaceSelect.js';
import {
  COLUMN_SEPARATOR,
  clampIndex,
  contentHeightFor,
  layoutFor,
  navigationKeyFor,
  singleColumnScope,
  type ColumnLayout,
  type ShellMode,
} from './columns/layout.js';
import { presenceLinkForPhase } from './columns/Presence.js';
import { SearchView } from './columns/SearchView.js';
import {
  Composer,
  arrivalBaseline,
  composerHeight,
  decisionOf,
  firstBufferLine,
  newerRowCount,
  type ArrivalBaseline,
  type ComposerModel,
} from './compose/Composer.js';
import { checkDraft, describeSendFailure, refusalLine, sendFailureLine, type SendResult } from './compose/send.js';
import {
  SEARCH_OFFLINE_NOTICE,
  SEARCH_UNWIRED_NOTICE,
  buildSearchRequest,
  classifySearchFailure,
  idleSearchPane,
  jumpMissingNotice,
  jumpUnresolvedNotice,
  loadingSearchPane,
  noticeSearchPane,
  readSearchRows,
  resultsSearchPane,
  searchScopeFor,
  searchSubject,
  type SearchPane,
  type SearchRequest,
  type SearchRow,
  type SearchScope,
} from './compose/search.js';
import {
  describeCause,
  historyErrorLine,
  indexOfRow,
  REACTION_PALETTE,
  type HistoryRequest,
  type PaneRequestState,
} from './format/rows.js';
import {
  applyToComposerText,
  initialShellState,
  keystrokeOf,
  keyReferenceLines,
  maxViewportStart,
  reduceShell,
  resolveAction,
  viewportFor,
  viewportShowing,
  type Keystroke,
  type ShellBounds,
  type ShellAction,
  type ShellState,
} from './keys.js';
import { readBadge } from './session/readState.js';

/** Re-exported so a host renders column one's states from the same type. */
export type { NavigationStatus };
/** Re-exported: the host that wires `onLoadHistory` writes the store from it. */
export type { HistoryRequest };

/**
 * What the client can honestly say about itself.
 *
 *   * `connecting`  — an attempt is in flight (nothing has failed yet).
 *   * `online`      — authenticated AND the gateway is connected.
 *   * `offline`     — the gateway dropped; the shared client is reconnecting.
 *   * `expired`     — the access token is stale and a renewal is expected from
 *                     the host. RECOVERABLE, and rendered as such: in SSH mode
 *                     there is no re-login path, so this must be visible
 *                     rather than terminal.
 *   * `failed`      — this attempt ended with a cause the member can read
 *                     (unreachable, certificate refused, token rejected).
 *   * `signed_out`  — local mode with no stored credential (U9 owns the login).
 */
export type ConnectionPhase =
  | 'connecting'
  | 'online'
  | 'offline'
  | 'expired'
  | 'failed'
  | 'signed_out';

/** The view model `client.ts` produces and this module renders. */
export interface ConnectionView {
  readonly phase: ConnectionPhase;
  /** One line, always complete on its own. */
  readonly headline: string;
  /** The actionable half, when there is one. */
  readonly detail?: string;
}

/** A phase's non-colour channel (a monochrome terminal still shows the state). */
export const PHASE_MARKERS: Record<ConnectionPhase, string> = {
  connecting: '…',
  online: '●',
  offline: '○',
  expired: '◌',
  failed: '✖',
  signed_out: '·',
};

/**
 * The one-shot requests the shell hands to whoever owns the session and the api.
 * Every one of them is optional, and an unwired one is simply absent — a key
 * whose surface a later unit owns does nothing rather than pretending.
 */
export interface ShellHost {
  /** The quit binding fired: stop the session and end the process. */
  onQuit?: () => void;
  /**
   * The search binding fired (U6's seam; R28). The shell opens its OWN query
   * surface (U13), so this is the host's notification that the member asked to
   * search — a host that observes keypresses still sees it. The fetch rides
   * {@link ShellHost.onSearchQuery}.
   */
  onSearch?: () => void;
  /** Mark this conversation read (U10's `readState.markRead`). */
  onMarkRead?: (conversationId: string) => void;
  /**
   * Mark this message unread, by its id (U10's `readState.markUnread`).
   *
   * The CONVERSATION comes with it: the floor is written through the same
   * channel-scoped ack route, and this shell has no business making the host
   * look the channel up again from a message id (the pane knows it — U10's
   * report is what changed this from a one-argument callback).
   */
  onMarkUnread?: (messageId: string, conversationId: string) => void;
  /**
   * The conversation column two is showing CHANGED — including the initial
   * landing once the store has a selection. This is the read capture: the
   * boundary it acknowledges is the newest row the member could see at this
   * moment (`readState.markRead` reads the store when it is called).
   *
   * It lives here, one level up from the message pane, deliberately: the
   * pane-level shape is recorded as measured-and-blocked upstream, because the
   * ack it fires clears the session-local slice before the rows exist and the
   * landing that follows is destroyed (U10's header).
   */
  onConversationOpened?: (conversationId: string) => void;
  /** Enter in the composer: send this text to the selected conversation. */
  onSend?: (text: string) => void;
  /**
   * Toggle the member's OWN reaction on `messageId` with `emoji` (U14). The
   * host owns the api, so the request lives there (`toggleOwnReaction`); the
   * returned outcome's `error` is the line the composer shows — a reaction the
   * member cannot add must not fail silently.
   */
  onToggleReaction?: (
    target: ContentTarget,
    messageId: string,
    emoji: string,
  ) => void | Promise<ReactionOutcome>;
  /**
   * Run one search and answer with the SERVER'S PAYLOAD (U13, R23).
   *
   * Called once per query change with the scope resolved to ids — the active
   * workspace, or null for the account-wide DM segment — and never for an empty
   * query, an offline session, or a scope with nothing to search. What comes
   * back is the wire's own value, typed `unknown` on purpose:
   * `CytaleApiClient.searchWorkspace` is declared `Promise<SearchResult>`
   * (`{items, cursor}`) and the controller serves `{results, next_before}`
   * instead, so this shell projects what it is handed rather than believing a
   * declared shape (`compose/search.ts`). Reject, and the pane renders the
   * cause — with a 501 (or the `search_not_available` key) as its own
   * "unavailable" state rather than as a failure of the member's query.
   *
   * Absent, the pane states that search is not available in this session:
   * nothing stands in for a fetch nobody wired.
   */
  onSearchQuery?: (request: SearchRequest) => Promise<unknown>;
}

export interface AppProps extends ShellHost {
  readonly view: ConnectionView;
  /** How this client reached the server — shown so the mode is never a guess. */
  readonly mode: 'ssh' | 'local';
  /** Resolved server origin (the host's in SSH mode; R14). */
  readonly origin: string;
  /**
   * The shared store. Defaults to the module default so the shell renders
   * before a host has wired anything (the banner's tests do exactly that).
   */
  readonly store?: StateStore;
  /** Terminal size. Defaults to the real window; a seam for tests and resizing. */
  readonly width?: number;
  readonly height?: number;
  /** What column one's load knows. Absent = derived from the store + phase. */
  readonly navigation?: NavigationStatus;
  /**
   * Load one page of history INTO THE SHARED STORE (U8/U12 own the api and the
   * session, so the fetch lives there; this shell has neither).
   *
   * `before: null` asks for the newest page — the first load of a channel or of
   * a thread's replies. Otherwise the page is OLDER than `before`, which the
   * pane took from the store's own cursor. The returned promise is the pane's
   * pending state: resolve it once the page has landed in the store (which is
   * where the pane reads it), reject it and the pane renders the failure with a
   * retry, holding the rows it already had.
   *
   * Absent, the shell fetches nothing: a pane with no data shows its loading
   * notice, exactly as it did before this unit.
   */
  readonly onLoadHistory?: (request: HistoryRequest) => Promise<void>;
  /**
   * Send, with the destination resolved to IDS (`ContentTarget`), so a message
   * typed while a switch is in flight cannot land in the conversation the
   * member just left. Takes precedence over {@link ShellHost.onSend}; a host
   * that wires neither leaves the composer's text in place.
   *
   * The RETURN VALUE is the outcome half (U8). A host that wires the
   * api-client's send path returns `compose/send.ts`'s promise: the shell then
   * holds the text until it settles, clears it on success, and KEEPS it with
   * the reason rendered on a refusal — a rejected send must not silently drop
   * what the member wrote. A callback that returns nothing (the shape U7's
   * tests wire) keeps the synchronous behavior: the text is given up on the
   * keystroke.
   */
  readonly onSendTo?: (target: ContentTarget, text: string) => void | Promise<SendResult>;
}

/** Subscribe to the shared store without importing its state library. */
function useStoreState(store: StateStore): StateState {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState);
}

const hasAnyNavigation = (state: StateState): boolean =>
  Object.keys(state.workspaces).length > 0 || Object.keys(state.channels).length > 0;

/**
 * True when a seam returned something to await. The seam's contract is
 * `void | Promise<...>`, and the distinction is load-bearing: a promise means
 * the outcome is still coming (so the text is held), and nothing means the host
 * has nothing to report (so the text is given up on the keystroke).
 */
function hasThen(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function isThenable(value: unknown): value is Promise<SendResult | undefined> {
  return hasThen(value);
}

/** The reaction seam's own awaitable check (U14; see {@link hasThen}). */
function isReactionOutcome(value: unknown): value is Promise<ReactionOutcome> {
  return hasThen(value);
}

/**
 * What the composer's line says when a reaction key is pressed with the link
 * down. The web client disables reactions offline; here the keystroke is
 * answered rather than swallowed (an inert line, like every other refusal).
 */
const REACTIONS_NEED_CONNECTION = '✖ Reactions need a live connection — this session is reconnecting.';

/**
 * What column one should say when the host has not told it: a store with
 * anything in it is renderable, a failed or signed-out session with an empty
 * store is an error naming the cause, and anything else is still loading.
 */
function defaultNavigationStatus(view: ConnectionView, state: StateState): NavigationStatus {
  if (hasAnyNavigation(state)) return NAVIGATION_READY;
  if (view.phase === 'failed' || view.phase === 'signed_out') {
    return { phase: 'failed', error: view.headline };
  }
  return NAVIGATION_LOADING;
}

/** The banner, unchanged: phase marker, headline, detail, and the mode footer. */
function ConnectionBanner({
  view,
  mode,
  origin,
}: {
  view: ConnectionView;
  mode: 'ssh' | 'local';
  origin: string;
}): ReactElement {
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold>{`${PHASE_MARKERS[view.phase]} ${view.headline}`}</Text>
      </Box>
      {view.detail === undefined ? null : (
        <Box>
          <Text dimColor>{view.detail}</Text>
        </Box>
      )}
      <Box>
        <Text dimColor wrap="truncate">
          {`Hrmny terminal client · ${mode} mode · ${origin}  ·  Tab column · m mode · w workspace · ? keys`}
        </Text>
      </Box>
    </Box>
  );
}

/** The in-client key reference: `KEY_MAP` itself, not a second copy of it. */
function KeyReference(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text bold>Key reference</Text>
      {keyReferenceLines().map((line) => (
        <Text key={line} wrap="truncate">{`  ${line}`}</Text>
      ))}
      <Text dimColor>{'? or Esc closes'}</Text>
    </Box>
  );
}

/**
 * The Ink root. U5's banner on top, the two-column shell below it, and the
 * key map's own reference as an overlay — nothing else, because everything else
 * belongs to a unit with a stated owner.
 */
export function App(props: AppProps): ReactElement {
  const {
    view,
    mode,
    origin,
    store = defaultStore,
    width,
    height,
    navigation,
    onQuit,
    onSearch,
    onMarkRead,
    onMarkUnread,
    onConversationOpened,
    onSend,
    onLoadHistory,
    onSendTo,
    onToggleReaction,
    onSearchQuery,
  } = props;

  const { exit } = useApp();
  const window = useWindowSize();
  const state = useStoreState(store);

  const [shell, setShell] = useState<ShellState>(() => initialShellState());
  const shellRef = useRef(shell);
  const [composerText, setComposerText] = useState('');
  const composerRef = useRef('');
  /**
   * A send is IN FLIGHT. The text is not given up until the host's promise
   * settles, and the guard is a ref as well as state because Enter can arrive
   * twice before a re-render — a double-send is not something the server should
   * have to deduplicate (its Idempotency-Key would, but the member would still
   * watch two sends).
   */
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  /** Why the last send did not go: the composer's own line. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Where the reader was in the pane, so an arrival is not a redraw. */
  const arrivalRef = useRef<ArrivalBaseline | null>(null);
  /**
   * The history request the host's loader is working on. One at a time, and one
   * pane's at a time: a state left over from a pane the member has switched
   * away from is ignored by the view (`paneHistory` matches on the pane key), so
   * a slow page cannot render its outcome into the conversation they moved to.
   */
  const [request, setRequest] = useState<PaneRequestState>({
    key: '',
    loading: false,
    error: null,
  });
  /**
   * Bumped by every action. It is what makes a repeated move key at the top of
   * the pane a NEW attempt (U7's retry) while a re-render is not: a page is
   * asked for at most once per (pane, cursor, keystroke), so the paging rule
   * cannot spin (step 2's "leaves the view unchanged rather than looping").
   */
  const [pokes, setPokes] = useState(0);
  /** The pane a loader is currently working on; null when none is in flight. */
  const pendingKey = useRef<string | null>(null);
  /** The last request attempt: the pane + cursor, and the keystroke it served. */
  const blockedRef = useRef<{ stamp: string; pokes: number } | null>(null);
  /** The pane column two is showing, for a page that lands after a switch. */
  const paneKeyRef = useRef('');

  // -------------------------------------------------------------------------
  // U13: the search pane's own state
  // -------------------------------------------------------------------------
  /** What the member has typed. The ref is what the keystroke handler reads. */
  const [searchQuery, setSearchQuery] = useState('');
  const searchQueryRef = useRef('');
  /** The projected pane: results, or the one line a state shows. */
  const [searchPane, setSearchPane] = useState<SearchPane>(() => idleSearchPane('workspace'));
  /** The handler needs the pane it is moving through, without a re-render. */
  const searchPaneRef = useRef(searchPane);
  searchPaneRef.current = searchPane;
  /**
   * Whether the query line holds the keyboard. It does not on open: `/` puts
   * the pane on screen and the member presses `i` — the key that writes
   * anywhere in this client — to type in it, so an accidental `/` cannot
   * swallow the keystroke that follows (and so the columns' own keys keep
   * working until the query is asked for).
   */
  const [searchFocused, setSearchFocused] = useState(false);
  const searchFocusedRef = useRef(false);
  /**
   * The request the pane is answering. Monotonic, captured when a query is
   * ISSUED and compared when it SETTLES, which is what makes a slow earlier
   * query unable to render over a faster later one (and what makes a query
   * abandoned by Escape settle into nothing).
   */
  const searchEpoch = useRef(0);
  /**
   * The message a result asked to land on, until the pane can show it. Cleared
   * when it resolves, when the pane's settled history proves it is not there,
   * and by the member's next keystroke — a jump that outlived their input would
   * move the cursor out from under them.
   */
  const [jump, setJump] = useState<{ readonly channelId: string; readonly messageId: string } | null>(
    null,
  );

  // Geometry and the store projections, derived per render: the layout follows
  // the window (resize included), and column one / column two follow whatever
  // the shared store currently holds.
  const layout: ColumnLayout = layoutFor({
    width: width ?? window.columns,
    height: height ?? window.rows,
  });
  const bodyWidth = layout.kind === 'two-column' ? layout.contentWidth : layout.width;
  const contentRows = contentHeightFor(layout);

  const workspaces = Object.values(state.workspaces);
  const activeWorkspaceId = resolveActiveWorkspaceId(shell.activeWorkspaceId, workspaces);
  const activeWorkspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
  const viewerId = state.currentUser?.id ?? null;

  const list: NavigationList = buildNavigationList({
    mode: shell.mode,
    source: state,
    activeWorkspaceId,
    viewerId,
    origin,
    // U10's badge, through the seam the column already has: the count is the
    // SERVER's (`readBadge` → `deriveChannelBadge`), so a channel this client
    // has never loaded a message for still carries the number a badge exists
    // for. Nothing else in this file derives a count.
    unreadCount: (channelId: string) => readBadge(store, channelId),
  });
  const navigationKey = navigationKeyFor(shell.mode, activeWorkspaceId);
  const navigationIndex = clampIndex(
    shell.navigationIndex[navigationKey] ?? 0,
    list.selectableIds.length,
  );
  const conversationId = list.selectableIds[navigationIndex] ?? '';

  const content: ContentView = buildContentView({
    source: state,
    conversationId,
    openThreadMessageId: shell.openThreadMessageId,
    width: bodyWidth,
    cursor: shell.messageCursor[conversationId],
    viewport: shell.viewport[conversationId],
    request,
  });

  // The composer's own model, and the lines it costs (U8). Its FIRST line is
  // column two's composer line (that is where the focus marker lives), so only
  // the continuation and status lines are counted here — and they are refunded
  // to column two's budget, so a multiline draft or a failure line cannot push
  // the shell past the window it was measured against.
  const composerModel: ComposerModel = {
    buffer: composerText,
    pending: sending,
    problem,
    newerCount: newerRowCount(content.rows, content.cursor),
    target: content.target,
  };
  const paneHeight = Math.max(1, contentRows - composerHeight(composerModel, bodyWidth));
  /**
   * What the affordance is currently offering. The input handler needs it
   * synchronously (a keystroke is not a render), so it rides a ref beside the
   * model it is derived from.
   */
  const newerCountRef = useRef(composerModel.newerCount);
  newerCountRef.current = composerModel.newerCount;

  // The world the reducer clamps against, read from the store rather than kept
  // in a second place. `contentHeight` is the pane's REAL budget: the viewport
  // keys must move by what is drawn, not by what the terminal is tall.
  const bounds: ShellBounds = {
    workspaceIds: workspaces.map((workspace) => workspace.id),
    navigationKey,
    navigationCount: list.selectableIds.length,
    conversationId,
    messageCount: content.rows.length,
    currentMessageId: content.rows[content.cursor]?.id ?? null,
    contentHeight: paneHeight,
  };

  const status = navigation ?? defaultNavigationStatus(view, state);

  /** Move one conversation's cursor and viewport (the paging anchor's write). */
  const moveCursor = (conversation: string, cursor: number, viewport: number): void => {
    const current = shellRef.current;
    if (current.quit) return;
    const next: ShellState = {
      ...current,
      messageCursor: { ...current.messageCursor, [conversation]: cursor },
      viewport: { ...current.viewport, [conversation]: viewport },
    };
    shellRef.current = next;
    setShell(next);
  };

  /**
   * The affordance's key: go to the newest row and put the viewport under it.
   * The same write the pin makes, so "jump" and "follow" cannot disagree about
   * where the bottom is.
   */
  const jumpToNewest = (): void => {
    const rows = content.rows.length;
    if (rows === 0) return;
    moveCursor(conversationId, rows - 1, maxViewportStart({ ...bounds, messageCount: rows }));
  };

  /** Give the composer's text up, in both the ref and the state. */
  const clearComposer = (): void => {
    composerRef.current = '';
    setComposerText('');
  };

  // -------------------------------------------------------------------------
  // U13: the search pane — the query, the request, and the jump
  // -------------------------------------------------------------------------

  /** The segment a query runs against: column one's mode IS the scope (R23). */
  const searchScope: SearchScope = searchScopeFor(shell.mode);

  /**
   * Close the pane and forget the query. Bumping the epoch is the load-bearing
   * half: a request still in flight then settles into nothing rather than into
   * a pane the member has left.
   */
  const resetSearch = (): void => {
    searchEpoch.current += 1;
    searchQueryRef.current = '';
    searchFocusedRef.current = false;
    setSearchQuery('');
    setSearchFocused(false);
    setSearchPane(idleSearchPane(searchScopeFor(shellRef.current.mode)));
  };

  /** The `search` binding: a fresh pane, idle, with its query line unfocused. */
  const openSearch = (): void => {
    resetSearch();
    const current = shellRef.current;
    const next: ShellState = { ...current, overlay: 'search' };
    shellRef.current = next;
    setShell(next);
  };

  /** `i` in the pane: the query line takes the keyboard. */
  const focusSearch = (): void => {
    searchFocusedRef.current = true;
    setSearchFocused(true);
  };

  /**
   * Ask for one query and render whatever it answers — unless a NEWER query has
   * been issued in the meantime, in which case the answer is dropped (the epoch
   * comparison is the whole of the out-of-order rule; a `loading` boolean could
   * not express it).
   *
   * Three things never reach the seam at all, and each one is a state instead:
   * an empty query (`idle`), a session that is not online (`offline`), and a
   * host that wired no search (`unavailable`).
   */
  const runSearch = (query: string): void => {
    const scope = searchScopeFor(shellRef.current.mode);
    const epoch = searchEpoch.current + 1;
    searchEpoch.current = epoch;

    const request = buildSearchRequest({ scope, workspaceId: activeWorkspaceId, query });
    if (request === null) {
      setSearchPane(idleSearchPane(scope));
      return;
    }
    if (view.phase !== 'online') {
      setSearchPane(noticeSearchPane('offline', request.query, SEARCH_OFFLINE_NOTICE));
      return;
    }
    if (onSearchQuery === undefined) {
      setSearchPane(noticeSearchPane('unavailable', request.query, SEARCH_UNWIRED_NOTICE));
      return;
    }

    setSearchPane(loadingSearchPane(request.query));
    void (async () => {
      try {
        const payload = await onSearchQuery(request);
        if (searchEpoch.current !== epoch) return;
        // Projected from the store AS IT IS NOW, not as it was when the query
        // was issued: the conversation names, authors, and bodies the wire does
        // not carry are looked up when the rows are built.
        setSearchPane(
          resultsSearchPane(
            request.query,
            readSearchRows(payload, { source: store.getState(), scope: request.scope }),
          ),
        );
      } catch (error) {
        if (searchEpoch.current !== epoch) return;
        const failure = classifySearchFailure(error);
        setSearchPane(noticeSearchPane(failure.status, request.query, failure.notice));
      }
    })();
  };

  /** A keystroke that is query text: keep it, and ask again for it. */
  const setSearchText = (next: string): void => {
    searchQueryRef.current = next;
    setSearchQuery(next);
    runSearch(next);
  };

  /** The arrows move the result cursor, leaving the query text alone. */
  const moveSearchCursor = (step: number): void => {
    const pane = searchPaneRef.current;
    if (pane.rows.length === 0) return;
    setSearchPane({ ...pane, cursor: clampIndex(pane.cursor + step, pane.rows.length) });
  };

  /**
   * Open the result under the search cursor: select its conversation in column
   * one — in the mode its SCOPE names, so a DM hit does not look for the
   * conversation among the workspace's channels — and hand the message id to the
   * jump effect below.
   *
   * A result whose conversation is NOT in that list (a stale channel list, or a
   * DM list whose own read failed) is stated rather than opened: selecting the
   * wrong conversation would be worse than saying nothing can be selected.
   */
  const openSearchRow = (row: SearchRow): void => {
    const current = shellRef.current;
    const targetMode: ShellMode = row.scope === 'dms' ? 'dms' : 'channels';
    const targetKey = navigationKeyFor(targetMode, activeWorkspaceId);
    const targetList = buildNavigationList({
      mode: targetMode,
      source: store.getState(),
      activeWorkspaceId,
      viewerId,
      origin,
      unreadCount: (channelId: string) => readBadge(store, channelId),
    });
    const at = targetList.selectableIds.indexOf(row.channelId);
    resetSearch();
    // Either way the pane closes: the member is back at the columns with the
    // reason on the composer's line, which is the shell's one-line surface.
    const closed: ShellState = { ...current, overlay: 'none' };
    if (at < 0) {
      shellRef.current = closed;
      setShell(closed);
      setProblem(jumpMissingNotice(row.where));
      return;
    }
    const next: ShellState = {
      ...closed,
      mode: targetMode,
      focus: 'content',
      openThreadMessageId: null,
      navigationIndex: { ...current.navigationIndex, [targetKey]: at },
    };
    shellRef.current = next;
    setShell(next);
    setJump({ channelId: row.channelId, messageId: row.messageId });
  };

  /**
   * The search pane's keystrokes, and whether the pane consumed one.
   *
   * The pane has TWO states, and the difference is who holds the keyboard:
   *
   *   * **the query line focused** (`i`) — a TEXT surface, so it reads keys the
   *     way the composer does: every printable key is query text (a `q` in a
   *     query is a letter, not a quit), backspace edits, and only Escape, Enter,
   *     the arrows and `Ctrl+C` mean anything else. Tab and the Ctrl chords are
   *     swallowed rather than handed to the columns behind the pane.
   *   * **the query line not focused** (the state `/` opens in) — the pane's own
   *     keys are live (the arrows choose a result, Enter opens it, Escape closes
   *     the pane) and `i` focuses the query, exactly as it focuses the composer
   *     anywhere else. Everything else falls THROUGH to the shell's map, so the
   *     columns keep their keys until the member asks for the query line: an
   *     accidental `/` must not swallow the next keystroke.
   */
  const handleSearchKey = (stroke: Keystroke, focused: boolean): boolean => {
    if (stroke.ctrl && stroke.input === 'c') {
      dispatch('quit');
      return true;
    }
    if (stroke.escape) {
      // One press, whatever the focus: leaving the pane is leaving the query.
      resetSearch();
      dispatch('cancel');
      return true;
    }
    if (stroke.down) {
      moveSearchCursor(1);
      return true;
    }
    if (stroke.up) {
      moveSearchCursor(-1);
      return true;
    }
    if (stroke.return) {
      const pane = searchPaneRef.current;
      const row = pane.rows[pane.cursor];
      // Enter opens the highlighted result — and with no rows it re-issues the
      // query, which is the retry the failure line names.
      if (row === undefined) runSearch(searchQueryRef.current);
      else openSearchRow(row);
      return true;
    }
    if (!focused) {
      if (stroke.input === 'i' && !stroke.ctrl && !stroke.meta) {
        focusSearch();
        return true;
      }
      return false; // the shell's own keys keep their meanings
    }
    const typed = applyToComposerText(searchQueryRef.current, stroke);
    if (typed !== null) setSearchText(typed);
    return true;
  };

  /**
   * Enter in the composer (U8, R20).
   *
   * Three things, in this order: the draft is checked LOCALLY (empty, over the
   * server's 4000-byte limit, no destination — `compose/send.ts` owns the rules
   * and the wording), the send goes to the destination this render resolved —
   * the IDS the pane is showing, so a message typed during a switch cannot be
   * misattributed — and the outcome decides what happens to the member's text:
   * cleared on success, KEPT with the reason rendered on anything else. A host
   * with no promise to await (U7's synchronous seam) keeps the old behavior.
   */
  const submitComposer = (): void => {
    if (sendingRef.current) return;
    const target = content.sendTarget;
    const draft = checkDraft(composerRef.current, {
      channelId: target.channelId,
      authorId: store.getState().currentUser?.id ?? null,
    });
    if (!draft.ok) {
      // An empty composer is not an error: it is Enter on nothing.
      if (draft.refusal !== 'empty') setProblem(refusalLine(draft.reason));
      return;
    }

    if (onSendTo !== undefined && target.channelId !== '') {
      const outcome = onSendTo(target, draft.text);
      if (!isThenable(outcome)) {
        // Nothing to await: the text is given up on the keystroke, which is all
        // this host's callback can say.
        clearComposer();
        setProblem(null);
        return;
      }
      sendingRef.current = true;
      setSending(true);
      setProblem(null);
      void outcome.then(
        (result) => {
          sendingRef.current = false;
          setSending(false);
          if (result === undefined || result.ok) {
            clearComposer();
            return;
          }
          // The text STAYS: a rejected send that dropped it would be the one
          // failure the member cannot recover from by pressing Enter again.
          setProblem(sendFailureLine(result.reason));
        },
        (error: unknown) => {
          // A host that returned a promise and then threw still owes the member
          // their text, and the cause is made inert before it is drawn (R26a).
          sendingRef.current = false;
          setSending(false);
          setProblem(sendFailureLine(describeSendFailure(error).message));
        },
      );
      return;
    }

    if (onSend !== undefined) {
      onSend(draft.text);
      clearComposer();
      setProblem(null);
    }
    // Neither seam wired: the text stays put — an Enter that silently discarded
    // the message would be a lie about what just happened (U7's rule).
  };

  /**
   * The reaction key (U14, R24).
   *
   * The chip moves optimistically inside the host's `toggleOwnReaction`, so
   * there is nothing to hold here: the message id comes from the pane's own
   * cursor (the row the member is on), the emoji is the palette's first entry —
   * the key is a single toggle, not a picker (see the module header) — and the
   * only thing this shell owes the member is the outcome's failure line, which
   * rides the composer's own status line (the one surface that exists for a
   * one-line problem, already sanitized and counted against the pane's budget).
   *
   * Offline the browser disables reactions; here the keystroke is answered with
   * the reason instead of being swallowed, and nothing is sent.
   */
  const toggleReaction = (messageId: string | null): void => {
    if (messageId === null) return; // nothing under the cursor
    const target = content.sendTarget;
    if (target.channelId === '') return; // nothing selected
    if (view.phase !== 'online') {
      setProblem(REACTIONS_NEED_CONNECTION);
      return;
    }
    if (onToggleReaction === undefined) return;

    const outcome = onToggleReaction(target, messageId, REACTION_PALETTE[0] ?? '👍');
    if (!isReactionOutcome(outcome)) return;
    void outcome.then(
      (result) => {
        if (result.error !== null) setProblem(result.error);
      },
      (error: unknown) => {
        // A host that threw instead of returning an outcome still owes the
        // member a reason; the cause is made inert before it is drawn (R26a).
        const cause = describeCause(error);
        setProblem(`✖ Could not toggle your reaction.${cause === '' ? '' : ` (${cause})`}`);
      },
    );
  };

  const dispatch = (action: ShellAction): void => {
    const reduction = reduceShell(shellRef.current, action, bounds);
    shellRef.current = reduction.state;
    setShell(reduction.state);
    // A keystroke that is not part of the jump IS the member taking control of
    // the pane: a pending anchor would otherwise move the cursor after they had
    // already put it somewhere themselves.
    setJump(null);
    // Every action is also a chance to ask again: a page that failed is retried
    // by the member pressing a key on the pane, never by a re-render alone.
    setPokes((current) => current + 1);
    const effects = reduction.effects;
    if (effects.send) submitComposer();
    // U6's `search` binding: the host's notification first, then this shell's
    // own query surface (U13 — the pane is where the member types).
    if (effects.search) {
      onSearch?.();
      openSearch();
    }
    if (effects.markRead !== null) onMarkRead?.(effects.markRead);
    // The floor is channel-scoped, so the conversation travels with the
    // message id (U10's `markUnread(channelId, messageId)`).
    if (effects.markUnread !== null) onMarkUnread?.(effects.markUnread, conversationId);
    if (effects.reaction !== null) toggleReaction(effects.reaction);
    if (effects.quit) {
      // The host owns the session; the shell owns the screen. Both come down,
      // so the quit binding leaves a readable terminal and nothing running.
      onQuit?.();
      exit();
    }
  };

  useInput((input, key) => {
    const current = shellRef.current;
    // A session that has ended handles nothing, including a keystroke that
    // arrives after the Ink tree came down.
    if (current.quit) return;
    const stroke = keystrokeOf(input, key);
    // The search pane reads its own keys first (U13). A keystroke it does not
    // consume — anything but the query line's own while it is unfocused — keeps
    // its meaning in the map below.
    if (current.overlay === 'search' && handleSearchKey(stroke, searchFocusedRef.current)) {
      return;
    }
    if (current.focus === 'composer') {
      // Shift+Enter is a NEWLINE, not a send: the binding the web composer
      // settled. It is handled before the reducer because the reducer's rule is
      // "Enter in the composer sends" and a newline is text, not a key the map
      // binds (`keys.ts` owns the map, and this keystroke is not a binding).
      if (stroke.return && stroke.shift) {
        const typed = `${composerRef.current}\n`;
        composerRef.current = typed;
        setComposerText(typed);
        return;
      }
      const typed = applyToComposerText(composerRef.current, stroke);
      if (typed !== null) {
        composerRef.current = typed;
        setComposerText(typed);
        return;
      }
    }
    const action = resolveAction(stroke, current.focus);
    if (action === null) return;
    // The affordance's key (see `compose/Composer.tsx`): while rows newer than
    // the reader's anchor are waiting, `Ctrl+D` — already bound to "scroll the
    // view down" — goes all the way down. `PageDown` keeps its exact meaning,
    // so a reader walking down the pane a page at a time still can.
    if (action === 'viewport-down' && stroke.ctrl && stroke.input === 'd' && newerCountRef.current > 0) {
      jumpToNewest();
      return;
    }
    dispatch(action);
  });

  // -------------------------------------------------------------------------
  // U8: the arrival policy (step 4)
  // -------------------------------------------------------------------------
  //
  // The rule lives in `compose/Composer.tsx` beside the affordance it renders;
  // this is the wiring. It runs after every render because the trigger is the
  // reader's position and the pane's newest row TOGETHER, and it acts only on a
  // `pin` — a `hold` decision is the absence of an action, which is exactly what
  // "the reader's position does not move" means. A baseline is adopted (never
  // acted on) for a new pane and for a new session epoch, so a channel switch
  // and a fresh Identify's re-hydration are not mistaken for arrivals.
  useEffect(() => {
    const baseline = arrivalBaseline(
      content.history.key,
      state.sessionEpoch,
      content.rows,
      content.cursor,
    );
    const decision = decisionOf(arrivalRef.current, baseline);
    arrivalRef.current = baseline;
    if (decision !== 'pin') return;
    // The reader was at the newest and the newest moved: follow it down, with
    // the viewport landing where the reducer itself would put it for the pane's
    // real budget, so the next movement key starts from the right place.
    const rows = content.rows.length;
    moveCursor(
      conversationId,
      rows - 1,
      maxViewportStart({ ...bounds, messageCount: rows }),
    );
  });

  // A problem line belongs to the conversation it happened in: switching panes
  // (or opening a thread) clears it rather than rendering one pane's failure
  // over another's composer.
  useEffect(() => {
    setProblem(null);
  }, [content.history.key]);

  // -------------------------------------------------------------------------
  // U10: the read boundary is captured at the SELECTION, not in the pane
  // -------------------------------------------------------------------------
  //
  // The host's `markRead` reads the store when it is CALLED, so this effect
  // fires it when the selected conversation changes — including the initial
  // landing, once the store has a selection — and the boundary is then the
  // newest row the member could actually see. The pane-level shape is recorded
  // as measured-and-blocked upstream: the ack it fires clears the session-local
  // slice before the rows exist, destroying the landing that follows.
  //
  // The callback is a dependency because it is a prop, so a host must hand a
  // STABLE function (the entry point hoists its three) or every re-render would
  // re-acknowledge; the guard below is what makes the effect's meaning "the
  // selection changed", not "something rendered".
  useEffect(() => {
    if (conversationId === '') return;
    onConversationOpened?.(conversationId);
  }, [conversationId, onConversationOpened]);

  // -------------------------------------------------------------------------
  // U7: paging column two's history
  // -------------------------------------------------------------------------
  //
  // This effect runs after EVERY render, deliberately: the trigger is a fact
  // about the pane, the store, and the cursor together (a channel switch, a
  // thread opening, a cursor reaching the oldest loaded row, a page landing),
  // and a dependency list is exactly what makes that kind of rule go stale. It
  // is loop-free by construction instead: at most one request is in flight, and
  // a request is made at most once per (pane, cursor) per keystroke — so a
  // re-render cannot spin, while the member pressing `k` at the top can ask
  // again after a failure.
  useEffect(() => {
    paneKeyRef.current = content.history.key;
    if (onLoadHistory === undefined) return;
    const pane = content.history;
    if (pane.channelId === '' || pane.key === '') return; // nothing selected
    if (pendingKey.current !== null) return; // one page at a time

    // The pane has nothing, or the cursor has reached the oldest row it holds
    // and the store has not proved that row is the beginning of the history.
    const paging = pane.cursorAtOldest && pane.before !== null && !pane.atStart;
    if (!pane.needsFirstPage && !paging) return;

    const before = pane.needsFirstPage ? null : pane.before;
    const stamp = `${pane.key}:${before ?? '^'}`;
    const blocked = blockedRef.current;
    if (blocked !== null && blocked.stamp === stamp && blocked.pokes === pokes) return;
    blockedRef.current = { stamp, pokes };

    const asked: HistoryRequest = {
      key: pane.key,
      kind: pane.kind,
      channelId: pane.channelId,
      threadId: pane.threadId,
      before,
    };
    // Where the member is now: the message the cursor is on is what must stay
    // put when the page lands under it.
    const anchorId = content.rows[content.cursor]?.id ?? null;
    const wasCursor = content.cursor;
    const wasViewport = content.viewport;
    const paneConversation = conversationId;
    const paneThread = shell.openThreadMessageId;

    pendingKey.current = pane.key;
    setRequest({ key: pane.key, loading: true, error: null });

    void (async () => {
      try {
        await onLoadHistory(asked);
      } catch (err) {
        if (pendingKey.current === pane.key) pendingKey.current = null;
        // The block STAYS: a failure must not be re-attempted by the re-render
        // its own error state causes. The member's next keystroke releases it.
        blockedRef.current = { stamp, pokes };
        setRequest({ key: pane.key, loading: false, error: historyErrorLine(pane.kind, err) });
        return;
      }

      if (pendingKey.current === pane.key) pendingKey.current = null;
      setRequest({ key: pane.key, loading: false, error: null });
      // A page that landed after the member moved on belongs to nobody: the pane
      // showing now has its own cursor and its own rows.
      if (paneKeyRef.current !== pane.key || anchorId === null) return;

      const next = paneRows({
        source: store.getState(),
        conversationId: paneConversation,
        openThreadMessageId: paneThread,
        width: bodyWidth,
      });
      const found = indexOfRow(next, anchorId);
      if (found === null || found === wasCursor) return;
      // The page was PREPENDED, so every index below it moved by the same
      // delta. The cursor follows its message and the viewport follows the
      // cursor: the member's position on screen does not move (step 2).
      const delta = found - wasCursor;
      const current = shellRef.current;
      // The viewport moves with the cursor, then lands inside the range the
      // reducer itself would allow for the new row count (`maxViewportStart`),
      // so the two never disagree about where the pane is scrolled to.
      const scrolled = (current.viewport[paneConversation] ?? wasViewport) + delta;
      const allowed = maxViewportStart({ ...bounds, messageCount: next.length }) + 1;
      moveCursor(
        paneConversation,
        clampIndex((current.messageCursor[paneConversation] ?? wasCursor) + delta, next.length),
        clampIndex(scrolled, allowed),
      );
    })();
  });

  // -------------------------------------------------------------------------
  // U13: landing on the message a search result named
  // -------------------------------------------------------------------------
  //
  // A jump is a message ID, and the pane's cursor is an INDEX into a window it
  // may not hold yet: the conversation switches, its first page loads through
  // U7's seam above, and the anchor resolves when the row appears. This effect
  // runs after every render for the same reason the paging effect does — the
  // trigger is a fact about the store, the pane, and the pending jump TOGETHER —
  // and it is loop-free because it clears the jump the moment it acts: once
  // resolved, once reported, or (in `dispatch`) once the member takes over.
  //
  // It also reuses U7's seam rather than inventing a second one: `indexOfRow`
  // finds the message, and the cursor and viewport move together through the
  // same `moveCursor` the page-anchoring write uses, so "where the cursor is"
  // cannot mean two things in two places.
  useEffect(() => {
    if (jump === null) return;
    // The pane has not switched yet (a render behind the selection write).
    if (content.sendTarget.channelId !== jump.channelId) return;
    const at = indexOfRow(content.rows, jump.messageId);

    if (at === null) {
      // Still coming: the pane has to fetch before it can be absent.
      if (content.history.needsFirstPage || content.history.loading) return;
      // Settled, and the message is not there. The conversation stays drawn —
      // an empty pane over a working channel would say the channel is empty.
      setProblem(
        jumpUnresolvedNotice({ where: content.header, atStart: content.history.atStart }),
      );
      setJump(null);
      return;
    }

    setJump(null);
    const start = viewportFor(shellRef.current, bounds);
    moveCursor(jump.channelId, at, viewportShowing(start, at, paneHeight));
  });

  const columnProps = {
    navigation: {
      mode: shell.mode,
      workspaceName: shell.mode === 'channels' ? (activeWorkspace?.name ?? null) : null,
      focused: shell.focus === 'navigation',
      list,
      selectedIndex: navigationIndex,
      status,
      height: contentRows + 1,
      presenceLink: presenceLinkForPhase(view.phase),
    },
    content: {
      view: content,
      focus: shell.focus,
      height: paneHeight,
      // Only the FIRST buffer line: column two's composer line is one line, and
      // its own sanitizing pass flattens newlines — handing it the whole
      // multiline buffer would print every continuation twice.
      composerText: firstBufferLine(composerModel.buffer),
    },
  };

  // The composer's own lines (U8): drawn directly under column two, inside the
  // column's width, so a continuation line of a multiline draft and a failure
  // reason read as parts of the composer rather than as pane content.
  const composer = <Composer {...composerModel} width={bodyWidth} />;

  // U13: the search pane takes column two (results are column two's — R23),
  // with its own query line in place of the composer, and the navigation column
  // stays exactly where it was: a search is something the member does TO the
  // workspace they are looking at. It gets the shell's whole content budget
  // because nothing else is drawn in the column while it is open.
  const searching = shell.overlay === 'search';
  const search = (
    <SearchView
      pane={searchPane}
      query={searchQuery}
      focused={searchFocused}
      subject={searchSubject(searchScope, activeWorkspace?.name ?? null)}
      width={bodyWidth}
      height={contentRows}
    />
  );

  return (
    <Box flexDirection="column">
      <ConnectionBanner view={view} mode={mode} origin={origin} />
      {shell.overlay === 'help' ? (
        <KeyReference />
      ) : shell.overlay === 'workspaces' && needsWorkspaceSelection(workspaces) ? (
        // The overlay is guarded as well as opened by the reducer: the list can
        // shrink under a live session (a workspace removed, then re-hydrated),
        // and a chooser with one entry is not a choice.
        <WorkspaceSelect
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          cursor={shell.workspaceCursor}
          width={layout.kind === 'two-column' ? layout.totalWidth : layout.width}
        />
      ) : layout.kind === 'two-column' ? (
        <Box>
          <NavigationColumn {...columnProps.navigation} width={layout.navigationWidth} />
          <Text>{COLUMN_SEPARATOR}</Text>
          <Box flexDirection="column" width={layout.contentWidth}>
            {searching ? (
              search
            ) : (
              <>
                <ContentColumn {...columnProps.content} width={layout.contentWidth} />
                {composer}
              </>
            )}
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column">
          {/* The sub-minimum policy: one column at full width, and the reason
              plus the way to see the other one. */}
          <Text dimColor wrap="truncate">{layout.notice}</Text>
          {singleColumnScope(shell.focus) === 'navigation' && !searching ? (
            <NavigationColumn {...columnProps.navigation} width={layout.width} />
          ) : (
            <Box flexDirection="column" width={layout.width}>
              {searching ? (
                search
              ) : (
                <>
                  <ContentColumn {...columnProps.content} width={layout.width} />
                  {composer}
                </>
              )}
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}
