/**
 * @cytale/tui — the key map and the shell's state machine (U6; R28).
 *
 * One job: every keystroke the client accepts is in `KEY_MAP`, and the map is
 * both the dispatcher's input and the in-client key reference's only source
 * (`keyReferenceLines`). A binding cannot exist in the help overlay without
 * working, and cannot work without being documented — the two renderings come
 * from the same array (step 5 of the unit).
 *
 * ---------------------------------------------------------------------------
 * The input-focus and selection model, stated (step 7)
 * ---------------------------------------------------------------------------
 *
 * Which surface owns keystrokes, in each state:
 *
 *   * `focus: 'navigation'` — column one. `j`/`k` (and the arrows) move the
 *     SELECTION; the selected conversation is what column two renders, so the
 *     cursor and the selection are the same thing in column one.
 *   * `focus: 'content'` — column two. `j`/`k` move the message cursor, which
 *     is where Enter opens a thread; `PageUp`/`PageDown` (and `Ctrl+U`/`Ctrl+D`)
 *     move the VIEWPORT only, leaving the cursor where it was.
 *   * `focus: 'composer'` — every printable key is text. Only Enter (send) and
 *     Escape (leave) reach the shell, so `q` and `j` type themselves instead of
 *     quitting or moving. `Ctrl+C` is the one exception: it ends the session
 *     from every surface, because a terminal that cannot be escaped is worse
 *     than one that ignores a stubborn keystroke.
 *
 * The SEARCH pane (`overlay: 'search'`, U13) has the client's two-step text
 * model, which is the composer's. `/` opens it with the QUERY LINE UNFOCUSED:
 * keystrokes are not text yet, so an accidental `/` cannot swallow the next one
 * — the map below still resolves them, which is how `r` and `u` keep their
 * meanings while the pane is open. `i` then gives the query line the keyboard,
 * and from that point the pane reads keys the way the composer does (printable
 * keys are query text, so `q` and `j` type themselves). The pane's own keys —
 * the arrows, Enter for the highlighted result, Escape to close — are read in
 * `app.tsx` before this map, and everything the map binds and the reducer gates
 * on an open overlay (movement, Tab, mode, workspace, thread, composer,
 * reactions) is inert behind the pane, exactly as it is behind the key
 * reference.
 *
 * How focus enters and leaves: `i` focuses the composer; Escape leaves it (and,
 * in order, closes a keyboard overlay, closes an open thread, then steps back
 * one column); Tab switches columns; `Enter` in column one hands the keyboard
 * to column two, which already shows the highlighted row's conversation.
 *
 * Why the state is a reducer and not React state: every rule above is a pure
 * function of (state, action, what the world currently holds), so the keyboard
 * model is testable without a terminal — and `ShellBounds` is the "what the
 * world holds" half, computed by the caller from the shared store.
 */
import {
  clampIndex,
  otherMode,
  switchColumn,
  type FocusSurface,
  type ShellMode,
} from './columns/layout.js';

// ---------------------------------------------------------------------------
// The map
// ---------------------------------------------------------------------------

export type ShellAction =
  | 'move-up'
  | 'move-down'
  | 'viewport-up'
  | 'viewport-down'
  | 'switch-column'
  | 'switch-mode'
  | 'switch-workspace'
  | 'toggle-thread'
  | 'focus-composer'
  | 'activate'
  | 'cancel'
  | 'search'
  | 'mark-read'
  | 'mark-unread'
  | 'toggle-reaction'
  | 'help'
  | 'quit';

export interface KeyBinding {
  readonly action: ShellAction;
  /** What the binding does, in the key reference's words. */
  readonly label: string;
  /** Every spelling of the key, as the reference renders it. */
  readonly keys: readonly string[];
}

/**
 * The whole key map, in the order the key reference prints it: movement first
 * (cursor then viewport), then the structural keys, then the message actions,
 * then the way out.
 */
export const KEY_MAP: readonly KeyBinding[] = [
  { action: 'move-down', label: 'Move the cursor down', keys: ['j', '↓'] },
  { action: 'move-up', label: 'Move the cursor up', keys: ['k', '↑'] },
  { action: 'viewport-down', label: 'Scroll the view down', keys: ['PageDown', 'Ctrl+D'] },
  { action: 'viewport-up', label: 'Scroll the view up', keys: ['PageUp', 'Ctrl+U'] },
  { action: 'switch-column', label: 'Switch column', keys: ['Tab', 'Shift+Tab'] },
  { action: 'switch-mode', label: 'Switch mode (Channels / DMs)', keys: ['m'] },
  { action: 'switch-workspace', label: 'Choose a workspace', keys: ['w'] },
  { action: 'activate', label: 'Open the highlighted row / send', keys: ['Enter'] },
  { action: 'toggle-thread', label: 'Open or close a thread', keys: ['t'] },
  { action: 'focus-composer', label: 'Focus the composer, or the search query', keys: ['i'] },
  { action: 'cancel', label: 'Leave the composer, thread, or overlay', keys: ['Esc'] },
  // U13: `/` opens the search pane; the query line takes the keyboard on `i`
  // (above), and the pane's own keys are printed in the pane itself.
  { action: 'search', label: 'Search messages (i writes the query)', keys: ['/'] },
  { action: 'mark-read', label: 'Mark the conversation read', keys: ['r'] },
  { action: 'mark-unread', label: 'Mark the current message unread', keys: ['u'] },
  {
    action: 'toggle-reaction',
    label: 'Toggle your 👍 reaction on the current message',
    keys: ['e'],
  },
  { action: 'help', label: 'Key reference', keys: ['?'] },
  { action: 'quit', label: 'Quit', keys: ['q', 'Ctrl+C'] },
];

/** The key reference, one line per binding, rendered from `KEY_MAP` itself. */
export function keyReferenceLines(): string[] {
  return KEY_MAP.map((binding) => `${binding.keys.join(' / ')} — ${binding.label}`);
}

// ---------------------------------------------------------------------------
// Keystrokes
// ---------------------------------------------------------------------------

/** Ink's key flags, structurally — no Ink import in a pure module. */
export interface InkKeyLike {
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
  readonly pageUp?: boolean;
  readonly pageDown?: boolean;
  readonly return?: boolean;
  readonly escape?: boolean;
  readonly tab?: boolean;
  readonly shift?: boolean;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
}

export interface Keystroke {
  readonly input: string;
  readonly up: boolean;
  readonly down: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly tab: boolean;
  readonly shift: boolean;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
}

/** Normalize Ink's `(input, key)` pair into the shape the map is written against. */
export function keystrokeOf(input: string, key: InkKeyLike = {}): Keystroke {
  return {
    input,
    up: key.upArrow === true,
    down: key.downArrow === true,
    pageUp: key.pageUp === true,
    pageDown: key.pageDown === true,
    return: key.return === true,
    escape: key.escape === true,
    tab: key.tab === true,
    shift: key.shift === true,
    ctrl: key.ctrl === true,
    meta: key.meta === true,
    backspace: key.backspace === true,
    delete: key.delete === true,
  };
}

/**
 * The action a keystroke means on a given surface, or null when the keystroke
 * is not the shell's (in the composer, that means it is text).
 */
export function resolveAction(stroke: Keystroke, focus: FocusSurface): ShellAction | null {
  // Ctrl+C ends the session from everywhere, including mid-sentence: it is
  // never text, so it is resolved before the composer hands keys to itself.
  if (stroke.ctrl && stroke.input === 'c') return 'quit';

  if (focus === 'composer') {
    if (stroke.return) return 'activate';
    if (stroke.escape) return 'cancel';
    return null;
  }

  if (stroke.escape) return 'cancel';
  if (stroke.return) return 'activate';
  if (stroke.tab) return 'switch-column';
  if (stroke.down || stroke.input === 'j') return 'move-down';
  if (stroke.up || stroke.input === 'k') return 'move-up';
  if (stroke.pageDown || (stroke.ctrl && stroke.input === 'd')) return 'viewport-down';
  if (stroke.pageUp || (stroke.ctrl && stroke.input === 'u')) return 'viewport-up';

  switch (stroke.input) {
    case 'm':
      return 'switch-mode';
    case 'w':
      return 'switch-workspace';
    case 't':
      return 'toggle-thread';
    case 'i':
      return 'focus-composer';
    case '/':
      return 'search';
    case 'r':
      return 'mark-read';
    case 'u':
      return 'mark-unread';
    case 'e':
      return 'toggle-reaction';
    case '?':
      return 'help';
    case 'q':
      return 'quit';
    default:
      return null;
  }
}

/** Drop the last code point, so a backspace never splits a surrogate pair. */
function dropLastCodePoint(text: string): string {
  return Array.from(text).slice(0, -1).join('');
}

/**
 * Apply a keystroke to the composer's buffer. Returns the new buffer, or null
 * when the keystroke is the shell's rather than the composer's — the caller
 * then routes it through `resolveAction` instead.
 *
 * A paste arrives as one call with a multi-character `input` and is appended
 * whole; arrows and modifiers carry no text and are ignored here.
 */
export function applyToComposerText(text: string, stroke: Keystroke): string | null {
  if (resolveAction(stroke, 'composer') !== null) return null;
  if (stroke.backspace || stroke.delete) return dropLastCodePoint(text);
  if (stroke.up || stroke.down || stroke.pageUp || stroke.pageDown || stroke.tab) return null;
  if (stroke.ctrl || stroke.meta || stroke.escape) return null;
  if (stroke.input === '') return null;
  return text + stroke.input;
}

// ---------------------------------------------------------------------------
// The shell's state
// ---------------------------------------------------------------------------

export type ShellOverlay = 'none' | 'help' | 'workspaces' | 'search';

export interface ShellState {
  readonly mode: ShellMode;
  readonly focus: FocusSurface;
  /**
   * The member's workspace choice. Client-local on purpose (step 2): it is a
   * view preference, the store's workspace list is a fresh Identify's to reset,
   * and a stale id is repaired by re-deriving from the loaded list rather than
   * by writing a field the other clients would have to agree on.
   */
  readonly activeWorkspaceId: string | null;
  /** Cursor inside the workspace overlay. */
  readonly workspaceCursor: number;
  /** Column one's selection, per (mode, workspace) — see `navigationKeyFor`. */
  readonly navigationIndex: Readonly<Record<string, number>>;
  /** Column two's cursor, per conversation: switching conversation is not scroll loss. */
  readonly messageCursor: Readonly<Record<string, number>>;
  /** Column two's first visible row, per conversation. */
  readonly viewport: Readonly<Record<string, number>>;
  /** The message a thread is open on; null when column two shows the channel. */
  readonly openThreadMessageId: string | null;
  readonly overlay: ShellOverlay;
  /** Set once by the quit binding; every later action is ignored. */
  readonly quit: boolean;
}

export function initialShellState(overrides: Partial<ShellState> = {}): ShellState {
  return {
    mode: 'channels',
    focus: 'navigation',
    activeWorkspaceId: null,
    workspaceCursor: 0,
    navigationIndex: {},
    messageCursor: {},
    viewport: {},
    openThreadMessageId: null,
    overlay: 'none',
    quit: false,
    ...overrides,
  };
}

/**
 * What the world currently holds — the half of the keyboard model the reducer
 * cannot see. The caller computes it from the shared store, so a movement key
 * clamps against the rows that are actually on screen.
 */
export interface ShellBounds {
  /** Every workspace id, in the order the store holds them. */
  readonly workspaceIds: readonly string[];
  /** The key column one's selection is stored under (`navigationKeyFor`). */
  readonly navigationKey: string;
  /** Selectable rows in column one. */
  readonly navigationCount: number;
  /** The selected conversation's id; '' when column one has nothing selected. */
  readonly conversationId: string;
  /** Rows in column two (the open thread's rows when a thread is open). */
  readonly messageCount: number;
  /** The message the cursor is on, null when column two has no rows. */
  readonly currentMessageId: string | null;
  /** Rows column two can draw — the viewport's page size. */
  readonly contentHeight: number;
}

/** One-shot requests the caller (which owns the session and the api) acts on. */
export interface ShellEffects {
  readonly quit: boolean;
  readonly search: boolean;
  /** Enter in the composer: the caller sends its buffer. */
  readonly send: boolean;
  /** Mark this conversation read. */
  readonly markRead: string | null;
  /** Mark this message unread. */
  readonly markUnread: string | null;
  /**
   * Toggle the member's own reaction on this message (U14). The MESSAGE id
   * only: which emoji the key toggles is the surface's own choice (the shell
   * owns the palette's first entry), so the reducer stays about the keyboard.
   * `null` when the pane has no row under the cursor.
   */
  readonly reaction: string | null;
}

export const NO_EFFECTS: ShellEffects = {
  quit: false,
  search: false,
  send: false,
  markRead: null,
  markUnread: null,
  reaction: null,
};

export interface ShellReduction {
  readonly state: ShellState;
  readonly effects: ShellEffects;
}

/**
 * The message cursor's effective index: wherever the member left it in this
 * conversation, or the newest message when they have never moved it — a
 * conversation opens at its most recent line, not at its oldest.
 */
export function messageCursorFor(state: ShellState, bounds: ShellBounds): number {
  const stored = state.messageCursor[bounds.conversationId];
  return clampIndex(stored ?? bounds.messageCount - 1, bounds.messageCount);
}

/** The viewport's effective start, clamped to the rows that exist. */
export function viewportFor(state: ShellState, bounds: ShellBounds): number {
  return clampIndex(state.viewport[bounds.conversationId] ?? 0, maxViewportStart(bounds) + 1);
}

/** The largest viewport start that still fills the pane. */
export function maxViewportStart(bounds: ShellBounds): number {
  return Math.max(0, bounds.messageCount - bounds.contentHeight);
}

/** The least movement that brings `cursor` back inside the viewport. */
export function viewportShowing(start: number, cursor: number, contentHeight: number): number {
  if (cursor < start) return cursor;
  if (cursor >= start + contentHeight) return cursor - contentHeight + 1;
  return start;
}

/**
 * The shell's reducer. Pure: the same (state, action, bounds) always yields the
 * same result, which is what lets the keyboard model be tested without a
 * terminal and reasoned about without a store.
 */
export function reduceShell(
  state: ShellState,
  action: ShellAction,
  bounds: ShellBounds,
): ShellReduction {
  // A session that has ended handles nothing: one quit, and no action escapes
  // it (nothing else can fire after the member has left).
  if (state.quit) return { state, effects: NO_EFFECTS };

  const none: ShellReduction = { state, effects: NO_EFFECTS };
  const withOverlay = (overlay: ShellOverlay): ShellReduction => ({
    state: { ...state, overlay },
    effects: NO_EFFECTS,
  });

  switch (action) {
    case 'move-down':
    case 'move-up': {
      const step = action === 'move-down' ? 1 : -1;
      // The composer swallows movement keys as text; the reducer says so too,
      // so a caller that dispatched one directly still cannot move a column.
      if (state.focus === 'composer') return none;
      if (state.overlay === 'workspaces') {
        return {
          state: {
            ...state,
            workspaceCursor: clampIndex(state.workspaceCursor + step, bounds.workspaceIds.length),
          },
          effects: NO_EFFECTS,
        };
      }
      // The key reference is a modal: it answers `?` and Escape only.
      if (state.overlay === 'help') return none;
      // The search pane owns every keystroke it can read as text or as one of
      // its own (the handler in `app.tsx`), so a movement action that reached
      // the reducer behind it moves NOTHING: the columns under an open pane
      // must not drift while the member is searching.
      if (state.overlay === 'search') return none;

      if (state.focus === 'content') {
        const cursor = clampIndex(messageCursorFor(state, bounds) + step, bounds.messageCount);
        return {
          state: {
            ...state,
            messageCursor: { ...state.messageCursor, [bounds.conversationId]: cursor },
            viewport: {
              ...state.viewport,
              [bounds.conversationId]: viewportShowing(
                viewportFor(state, bounds),
                cursor,
                bounds.contentHeight,
              ),
            },
          },
          effects: NO_EFFECTS,
        };
      }

      const index = clampIndex(
        (state.navigationIndex[bounds.navigationKey] ?? 0) + step,
        bounds.navigationCount,
      );
      return {
        state: { ...state, navigationIndex: { ...state.navigationIndex, [bounds.navigationKey]: index } },
        effects: NO_EFFECTS,
      };
    }

    case 'viewport-down':
    case 'viewport-up': {
      if (state.overlay !== 'none' || state.focus === 'composer') return none;
      const half = Math.max(1, Math.floor(bounds.contentHeight / 2));
      const step = action === 'viewport-down' ? half : -half;
      const start = clampIndex(viewportFor(state, bounds) + step, maxViewportStart(bounds) + 1);
      return {
        state: { ...state, viewport: { ...state.viewport, [bounds.conversationId]: start } },
        effects: NO_EFFECTS,
      };
    }

    case 'switch-column':
      if (state.overlay !== 'none') return none;
      return { state: { ...state, focus: switchColumn(state.focus) }, effects: NO_EFFECTS };

    case 'switch-mode':
      if (state.overlay !== 'none') return none;
      // Column one's list is replaced, so the keyboard returns to it; each mode
      // keeps its own selection and column two keeps its per-conversation
      // cursor, because both are keyed rather than shared.
      return {
        state: { ...state, mode: otherMode(state.mode), focus: 'navigation' },
        effects: NO_EFFECTS,
      };

    case 'switch-workspace': {
      // One workspace is not a choice: a member with one proceeds without a
      // selection step.
      if (bounds.workspaceIds.length < 2) return none;
      return {
        state: {
          ...state,
          overlay: 'workspaces',
          workspaceCursor: Math.max(0, bounds.workspaceIds.indexOf(state.activeWorkspaceId ?? '')),
        },
        effects: NO_EFFECTS,
      };
    }

    case 'focus-composer':
      if (state.overlay !== 'none') return none;
      return { state: { ...state, focus: 'composer' }, effects: NO_EFFECTS };

    case 'toggle-thread':
      return toggleThread(state, bounds);

    case 'activate': {
      if (state.overlay === 'help') return withOverlay('none');
      // The search pane's Enter opens the highlighted result; it is handled
      // where the pane's own keys are (`app.tsx`), so nothing here acts.
      if (state.overlay === 'search') return none;
      if (state.overlay === 'workspaces') {
        const chosen = bounds.workspaceIds[clampIndex(state.workspaceCursor, bounds.workspaceIds.length)];
        return {
          state: {
            ...state,
            overlay: 'none',
            activeWorkspaceId: chosen ?? state.activeWorkspaceId,
          },
          effects: NO_EFFECTS,
        };
      }
      if (state.focus === 'composer') {
        return { state, effects: { ...NO_EFFECTS, send: true } };
      }
      // In column two, Enter opens the thread on the highlighted message; in
      // column one it hands the keyboard to column two, which is already
      // showing that row's conversation.
      if (state.focus === 'content') return toggleThread(state, bounds);
      return { state: { ...state, focus: 'content' }, effects: NO_EFFECTS };
    }

    case 'cancel': {
      if (state.overlay !== 'none') return withOverlay('none');
      // One binding closes a thread (R18's way back), then focus steps back.
      if (state.openThreadMessageId !== null) {
        return { state: { ...state, openThreadMessageId: null, focus: 'content' }, effects: NO_EFFECTS };
      }
      if (state.focus === 'composer') return { state: { ...state, focus: 'content' }, effects: NO_EFFECTS };
      if (state.focus === 'content') return { state: { ...state, focus: 'navigation' }, effects: NO_EFFECTS };
      return none;
    }

    case 'search':
      return { state, effects: { ...NO_EFFECTS, search: true } };

    case 'mark-read':
      return {
        state,
        effects: {
          ...NO_EFFECTS,
          markRead: bounds.conversationId === '' ? null : bounds.conversationId,
        },
      };

    case 'mark-unread':
      return { state, effects: { ...NO_EFFECTS, markUnread: bounds.currentMessageId } };

    // A message action like `u`: it addresses the row column two is showing
    // (the cursor's message), and it is unavailable behind an overlay — the key
    // reference and the workspace chooser are modal.
    case 'toggle-reaction':
      if (state.overlay !== 'none') return none;
      return { state, effects: { ...NO_EFFECTS, reaction: bounds.currentMessageId } };

    case 'help':
      return withOverlay(state.overlay === 'help' ? 'none' : 'help');

    case 'quit':
      return { state: { ...state, quit: true }, effects: { ...NO_EFFECTS, quit: true } };

    default:
      return none;
  }
}

function toggleThread(state: ShellState, bounds: ShellBounds): ShellReduction {
  if (state.overlay !== 'none') return { state, effects: NO_EFFECTS };
  // `t` closes an open thread whatever the cursor is on, so the way back never
  // depends on where the cursor happens to sit.
  if (state.openThreadMessageId !== null) {
    return { state: { ...state, openThreadMessageId: null, focus: 'content' }, effects: NO_EFFECTS };
  }
  if (bounds.currentMessageId === null) return { state, effects: NO_EFFECTS };
  return {
    state: { ...state, openThreadMessageId: bounds.currentMessageId, focus: 'content' },
    effects: NO_EFFECTS,
  };
}
