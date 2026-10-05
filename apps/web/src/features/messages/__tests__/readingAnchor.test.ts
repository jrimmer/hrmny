/**
 * @cytale/web — the reading-position anchor (#13).
 *
 * The rule under test: a position is WHAT the reader was looking at (a row
 * and its offset from the viewport's top edge), and a restore is corrected by
 * measuring that row alone, so the heights of the rows above it never enter
 * the sum. jsdom has no layout engine, so the DOM read is exercised with
 * stubbed boxes. The pixels are proven in the browser
 * (e2e/timeline-window.spec.ts, #13 and its mixed-height variant).
 */
import { afterEach, describe, expect, it } from 'vitest';

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
  topVisibleRow,
  type ReadingAnchor,
} from '../readingAnchor.js';

afterEach(() => forgetReadingPositions());

const anchor = (over: Partial<ReadingAnchor> = {}): ReadingAnchor => ({
  key: '1000000000000042',
  id: '1000000000000042',
  offset: 12,
  ...over,
});

describe('topVisibleRow — the row being read', () => {
  it('is the first row whose bottom is below the edge, with how far it hides above it', () => {
    const rows = [
      { index: 3, top: 40, bottom: 88 },
      { index: 4, top: 88, bottom: 150 },
      { index: 5, top: 150, bottom: 190 },
    ];
    expect(topVisibleRow(100, rows)).toEqual({ index: 4, offset: 12 });
  });

  it('ignores a sub-pixel sliver left above the edge', () => {
    const rows = [
      { index: 0, top: 0, bottom: 100.5 },
      { index: 1, top: 100.5, bottom: 160 },
    ];
    expect(topVisibleRow(100, rows)).toEqual({ index: 1, offset: -0.5 });
  });

  it('reads a row that starts BELOW the edge as a negative offset (the history band above it)', () => {
    expect(topVisibleRow(100, [{ index: 0, top: 132, bottom: 180 }])).toEqual({
      index: 0,
      offset: -32,
    });
  });

  it('does not depend on the order the rows were rendered in', () => {
    const rows = [
      { index: 9, top: 300, bottom: 360 },
      { index: 7, top: 90, bottom: 200 },
      { index: 8, top: 200, bottom: 300 },
    ];
    expect(topVisibleRow(100, rows)?.index).toBe(7);
  });

  it('is null with nothing rendered', () => {
    expect(topVisibleRow(100, [])).toBeNull();
  });
});

describe('anchorDrift — the correction, measured on the row alone', () => {
  it('is zero when the row sits exactly where it was saved', () => {
    expect(anchorDrift(100, 88, 12)).toBe(0);
  });

  it('is positive when the row sits too high (scroll up by it)', () => {
    // Rows above measured 248px taller than their estimate pushed nothing:
    // only the row's own top counts.
    expect(anchorDrift(100, 88 - 248, 12)).toBe(248);
  });

  it('is negative when the row sits too low (scroll down by it)', () => {
    expect(anchorDrift(100, 130, 12)).toBe(-42);
  });

  it('round-trips: the offset a row was saved at is the one a restore corrects to', () => {
    const saved = topVisibleRow(64, [{ index: 2, top: 20, bottom: 140 }])!;
    // After a return the same row renders 300px lower; the drift undoes it.
    const drift = anchorDrift(64, 20 + 300, saved.offset);
    expect(drift).toBe(-300);
  });
});

describe('planRestore — how a visit opens', () => {
  const rows = [
    { id: '1000000000000040' },
    { id: '1000000000000041' },
    { id: 'pending_abc', client_key: 'abc' },
    { id: '1000000000000042' },
  ];

  it('opens at the newest with no saved position', () => {
    expect(planRestore(undefined, null, rows)).toBeNull();
  });

  it('opens at the newest when the reader left at the live edge', () => {
    expect(planRestore({ atBottom: true }, null, rows)).toBeNull();
  });

  it('lets a permalink outrank the saved position', () => {
    expect(planRestore({ atBottom: false, anchor: anchor() }, '1000000000000040', rows)).toBeNull();
  });

  it('finds the saved row in the window', () => {
    expect(planRestore({ atBottom: false, anchor: anchor() }, null, rows)).toEqual({
      anchor: anchor(),
      index: 3,
    });
  });

  it('finds a row by its client key after the placeholder confirmed (and vice versa)', () => {
    const confirmed = [{ id: '1000000000000050', client_key: 'abc' }];
    const saved = anchor({ key: 'abc', id: 'pending_abc' });
    expect(planRestore({ atBottom: false, anchor: saved }, null, confirmed)?.index).toBe(0);
    expect(isAnchorRow({ id: 'pending_abc', client_key: 'abc' }, saved)).toBe(true);
  });

  it('marks a row that left the window for a read around it', () => {
    const gone = anchor({ key: '1000000000000001', id: '1000000000000001' });
    expect(planRestore({ atBottom: false, anchor: gone }, null, rows)).toEqual({
      anchor: gone,
      index: null,
    });
  });
});

describe('the saved positions', () => {
  it('are kept per conversation and forgotten together', () => {
    rememberReadingPosition('channel:1', { atBottom: false, anchor: anchor() });
    rememberReadingPosition('thread:2', { atBottom: true });
    expect(recallReadingPosition('channel:1')).toEqual({ atBottom: false, anchor: anchor() });
    expect(recallReadingPosition('thread:2')).toEqual({ atBottom: true });
    rememberReadingPosition('channel:1', { atBottom: true });
    expect(recallReadingPosition('channel:1')).toEqual({ atBottom: true });
    forgetReadingPositions();
    expect(recallReadingPosition('channel:1')).toBeUndefined();
  });
});

describe('cursorJustBefore — the after= cursor whose page starts at the row', () => {
  it('is the snowflake one below, exact past 2^53', () => {
    expect(cursorJustBefore('9007199254740993')).toBe('9007199254740992');
  });

  it('is null for a placeholder id', () => {
    expect(cursorJustBefore('pending_abc')).toBeNull();
    expect(cursorJustBefore('0')).toBeNull();
  });
});

describe('the DOM read (Virtuoso item wrappers)', () => {
  function box(el: Element, top: number, bottom: number): void {
    (el as HTMLElement).getBoundingClientRect = () =>
      ({ top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top }) as DOMRect;
  }

  function scrollerWith(rows: Array<[index: number, top: number, bottom: number]>): HTMLElement {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-virtuoso-scroller', 'true');
    const list = document.createElement('div');
    list.setAttribute('data-testid', 'virtuoso-item-list');
    scroller.appendChild(list);
    for (const [index, top, bottom] of rows) {
      const item = document.createElement('div');
      item.dataset.index = String(index);
      // A row's own content can carry data attributes too; only the wrapper counts.
      const inner = document.createElement('div');
      inner.dataset.index = '999';
      item.appendChild(inner);
      box(item, top, bottom);
      box(inner, -1000, 1000);
      list.appendChild(item);
    }
    box(scroller, 100, 700);
    return scroller;
  }

  it('reads the top visible wrapper and its offset', () => {
    const scroller = scrollerWith([
      [10, 20, 90],
      [11, 90, 160],
      [12, 160, 220],
    ]);
    expect(readTopVisibleRow(scroller)).toEqual({ index: 11, offset: 10 });
  });

  it('finds a rendered wrapper by data index, and nothing for one not rendered', () => {
    const scroller = scrollerWith([[10, 20, 90]]);
    expect(renderedRow(scroller, 10)?.dataset.index).toBe('10');
    expect(renderedRow(scroller, 11)).toBeNull();
  });
});
