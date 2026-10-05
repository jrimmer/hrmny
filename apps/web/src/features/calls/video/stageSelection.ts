/**
 * @cytale/web — the stage-selection state machine (calls V2 plan U5, VM22).
 *
 * RATIFIED VM22: {follow-recent, viewer-selected, pinned} with transitions
 *   switcher select → viewer-selected
 *   pin toggle      → pinned
 *   pinned ends     → follow-recent
 *   last share ends → collapse (no staged share — the grid owns the panel)
 * plus the two continuations the ratification implies: `share-started` while
 * follow-recent re-stages the newcomer (VM4 "stage follows most-recent
 * sharer") while viewer-selected/pinned HOLD; `unpin` returns to
 * follow-recent staging the most recent live share (the same resumption a
 * ended pin takes — recorded here as the machine's definition, not a new
 * decision).
 *
 * This module is the machine only — pure, engine-free, fixture-testable.
 * The composition unit (U5b) owns the state and feeds events; Stage renders
 * `activeShareId`, ShareSwitcher reports `select`, Stage's pin button
 * reports `pin`/`unpin`, roster share lifetimes report `share-started`/
 * `share-ended`.
 */

/** VM22's three modes. */
export type StageSelectionMode = 'follow-recent' | 'viewer-selected' | 'pinned';

export interface StageSelectionState {
  mode: StageSelectionMode;
  /** The share the stage renders; null = collapsed to grid (VM22's last-ends). */
  activeShareId: string | null;
  /** The pinned share (meaningful only while mode = 'pinned'). */
  pinnedShareId: string | null;
}

/**
 * Events. `remaining`/`live` lists are ordered OLDEST → NEWEST share (the
 * roster's arrival order); "most recent" is the last element.
 */
export type StageSelectionEvent =
  | { type: 'share-started'; shareId: string }
  | { type: 'share-ended'; shareId: string; remaining: readonly string[] }
  | { type: 'select'; shareId: string }
  | { type: 'pin'; shareId: string }
  | { type: 'unpin'; live: readonly string[] };

/** The initial machine state: no shares, following. */
export const initialStageSelection: StageSelectionState = {
  mode: 'follow-recent',
  activeShareId: null,
  pinnedShareId: null,
};

/** The newest entry of an oldest→newest share list, or null when empty. */
export function mostRecentShareId(shares: readonly string[]): string | null {
  return shares.length > 0 ? (shares[shares.length - 1] as string) : null;
}

/** One transition of the VM22 machine (pure; unknown events are no-ops). */
export function stageSelectionReducer(
  state: StageSelectionState,
  event: StageSelectionEvent,
): StageSelectionState {
  switch (event.type) {
    case 'share-started': {
      // VM4: the stage follows the most-recent sharer — unless the viewer
      // has taken control (selected or pinned holds its ground).
      if (state.mode !== 'follow-recent') return state;
      return { ...state, activeShareId: event.shareId };
    }

    case 'share-ended': {
      if (event.shareId === state.pinnedShareId) {
        // VM22: pinned source ends → follow-recent (collapse if it was last).
        return {
          mode: 'follow-recent',
          activeShareId: mostRecentShareId(event.remaining),
          pinnedShareId: null,
        };
      }
      if (event.shareId === state.activeShareId) {
        // The staged share ended while unpinned: follow-recent resumes on
        // the most recent survivor; viewer-selection does not survive its
        // own share ending (the ratification's follow-recent default).
        return {
          mode: 'follow-recent',
          activeShareId: mostRecentShareId(event.remaining),
          pinnedShareId: null,
        };
      }
      // A background share ended — the stage is untouched.
      return state;
    }

    case 'select': {
      // VM22: switcher select → viewer-selected (from ANY mode — a switcher
      // pick while pinned hands control back to the viewer's choice).
      return { mode: 'viewer-selected', activeShareId: event.shareId, pinnedShareId: null };
    }

    case 'pin': {
      // VM4: manual pin overrides everything.
      return { mode: 'pinned', activeShareId: event.shareId, pinnedShareId: event.shareId };
    }

    case 'unpin': {
      // Unpin resumes following the most recent live share.
      return {
        mode: 'follow-recent',
        activeShareId: mostRecentShareId(event.live),
        pinnedShareId: null,
      };
    }

    default:
      return state;
  }
}
