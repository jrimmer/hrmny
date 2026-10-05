/**
 * @cytale/web — stageSelection tests (calls V2 plan U5a, RATIFIED VM22).
 *
 * The stage-selection state machine {follow-recent, viewer-selected,
 * pinned} and its defined transitions:
 *   switcher select → viewer-selected (from ANY mode)
 *   pin toggle      → pinned
 *   pinned ends     → follow-recent
 *   last share ends → collapse (activeShareId null — the grid owns the panel)
 * plus the ratified continuations: share-started re-stages ONLY while
 * follow-recent (VM4 most-recent follows; viewer-selected/pinned hold), and
 * unpin resumes follow-recent.
 */
import { describe, expect, it } from 'vitest';

import {
  initialStageSelection,
  mostRecentShareId,
  stageSelectionReducer,
  type StageSelectionState,
} from '../stageSelection.js';

function walking(
  ...steps: Array<StageSelectionState | Parameters<typeof stageSelectionReducer>[1]>
): StageSelectionState {
  // A bare STATE object (no `type`) resets the walk to it — tests compose
  // continuations from earlier results; events step the machine.
  return steps.reduce<StageSelectionState>(
    (state, step) => ('type' in step ? stageSelectionReducer(state, step) : step),
    initialStageSelection,
  );
}

describe('stageSelection — VM22 transitions', () => {
  it('initial state: follow-recent, nothing staged (collapsed grid)', () => {
    expect(initialStageSelection).toEqual({
      mode: 'follow-recent',
      activeShareId: null,
      pinnedShareId: null,
    });
    expect(mostRecentShareId([])).toBeNull();
  });

  it('VM4: share-started stages the newcomer while follow-recent', () => {
    const s = walking({ type: 'share-started', shareId: 'a' });
    expect(s).toEqual({ mode: 'follow-recent', activeShareId: 'a', pinnedShareId: null });
    const s2 = walking(s, { type: 'share-started', shareId: 'b' });
    expect(s2.activeShareId).toBe('b'); // follows the MOST RECENT sharer
  });

  it('switcher select → viewer-selected; a later share-started holds the choice', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'select', shareId: 'a' },
    );
    expect(s).toEqual({ mode: 'viewer-selected', activeShareId: 'a', pinnedShareId: null });

    const s2 = walking(s, { type: 'share-started', shareId: 'c' });
    expect(s2.mode).toBe('viewer-selected');
    expect(s2.activeShareId).toBe('a'); // does NOT follow the newcomer
  });

  it('pin → pinned: holds across new shares AND across other shares ending', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'pin', shareId: 'a' },
    );
    expect(s).toEqual({ mode: 'pinned', activeShareId: 'a', pinnedShareId: 'a' });

    const held = walking(
      s,
      { type: 'share-started', shareId: 'c' },
      { type: 'share-ended', shareId: 'b', remaining: ['a', 'c'] },
    );
    expect(held).toEqual(s); // untouched — pin overrides everything
  });

  it('pinned ends → follow-recent (on the most recent survivor)', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'pin', shareId: 'a' },
      { type: 'share-ended', shareId: 'a', remaining: ['b'] },
    );
    expect(s).toEqual({ mode: 'follow-recent', activeShareId: 'b', pinnedShareId: null });
  });

  it('viewer-selected share ends → follow-recent on the most recent survivor', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'select', shareId: 'a' },
      { type: 'share-ended', shareId: 'a', remaining: ['b'] },
    );
    expect(s.mode).toBe('follow-recent');
    expect(s.activeShareId).toBe('b');
  });

  it('a background share ending never moves the stage', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'share-ended', shareId: 'a', remaining: ['b'] },
    );
    expect(s.activeShareId).toBe('b');
    expect(s.mode).toBe('follow-recent');
  });

  it('last share ends → collapse (null stage; the grid owns the panel)', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-ended', shareId: 'a', remaining: [] },
    );
    expect(s).toEqual({ mode: 'follow-recent', activeShareId: null, pinnedShareId: null });

    // Collapsed from pinned, too.
    const p = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'pin', shareId: 'a' },
      { type: 'share-ended', shareId: 'a', remaining: [] },
    );
    expect(p.activeShareId).toBeNull();
    expect(p.mode).toBe('follow-recent');
  });

  it('unpin → follow-recent on the most recent live share', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'pin', shareId: 'a' },
      { type: 'unpin', live: ['a', 'b'] },
    );
    expect(s).toEqual({ mode: 'follow-recent', activeShareId: 'b', pinnedShareId: null });
  });

  it('switcher select while PINNED hands control to the viewer (mode exits pinned)', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-started', shareId: 'b' },
      { type: 'pin', shareId: 'a' },
      { type: 'select', shareId: 'b' },
    );
    expect(s).toEqual({ mode: 'viewer-selected', activeShareId: 'b', pinnedShareId: null });
  });

  it('follow-recent survives a non-active share ending (stage unchanged)', () => {
    const s = walking(
      { type: 'share-started', shareId: 'a' },
      { type: 'share-ended', shareId: 'zz', remaining: ['a'] },
    );
    expect(s.activeShareId).toBe('a');
  });
});
