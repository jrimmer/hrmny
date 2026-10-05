/**
 * @cytale/web — the at-bottom follow RULE (#128 defect 3).
 *
 * The doctrine under test: AT THE BOTTOM MEANS FOLLOW; SCROLLED UP MEANS
 * NEVER DRAG. jsdom has no layout engine, so the components wire DOM events
 * to these pure functions — the rule is tested here, the wiring in the
 * browser (e2e/defect3-repro.spec.ts is the visual proof).
 */
import { describe, expect, it } from 'vitest';

import {
  AT_BOTTOM_THRESHOLD,
  atBottomOnScroll,
  atBottomOnTouchDrag,
  atBottomOnWheel,
  distanceFromEnd,
} from '../scrollFollow.js';

describe('distanceFromEnd', () => {
  it('is zero when pinned to the last row', () => {
    expect(distanceFromEnd({ scrollTop: 700, scrollHeight: 1000, clientHeight: 300 })).toBe(0);
  });

  it('grows as the reader climbs', () => {
    expect(distanceFromEnd({ scrollTop: 400, scrollHeight: 1000, clientHeight: 300 })).toBe(300);
  });
});

describe('atBottomOnScroll — where the reader is, then which way they moved', () => {
  it('disarms well away from the end, whoever moved', () => {
    expect(
      atBottomOnScroll({
        distance: AT_BOTTOM_THRESHOLD + 1,
        previousTop: 500,
        currentTop: 500,
        landingActive: false,
        currentAtBottom: true,
      }),
    ).toBe(false);
  });

  it('re-arms moving toward the end inside the band', () => {
    expect(
      atBottomOnScroll({
        distance: AT_BOTTOM_THRESHOLD - 1,
        previousTop: 200,
        currentTop: 230,
        landingActive: false,
        currentAtBottom: false,
      }),
    ).toBe(true);
  });

  it('does not re-arm moving away inside the band — a wheeled-away reader who stopped short stays un-followed (2026-09-13)', () => {
    expect(
      atBottomOnScroll({
        distance: AT_BOTTOM_THRESHOLD - 1,
        previousTop: 230,
        currentTop: 200,
        landingActive: false,
        currentAtBottom: false,
      }),
    ).toBe(false);
  });

  it('a stationary event inside the band counts as at the bottom — content growing under a stationary reader must keep following (2026-09-15 restore)', () => {
    const params = {
      distance: 0,
      previousTop: 700,
      currentTop: 700,
      landingActive: false,
    };
    expect(atBottomOnScroll({ ...params, currentAtBottom: true })).toBe(true);
    // Even a transient disarm is restored: a stationary position inside the
    // band is the reader AT the live edge, and the pin must come back.
    expect(atBottomOnScroll({ ...params, currentAtBottom: false })).toBe(true);
  });

  it('a landing in flight blocks the re-arm — its settle is not the reader (2026-09-13 yank)', () => {
    expect(
      atBottomOnScroll({
        distance: 0,
        previousTop: 100,
        currentTop: 400,
        landingActive: true,
        currentAtBottom: false,
      }),
    ).toBe(false);
  });

  it('the first event (no previous top) counts as toward-the-end', () => {
    expect(
      atBottomOnScroll({
        distance: 0,
        previousTop: null,
        currentTop: 700,
        landingActive: false,
        currentAtBottom: false,
      }),
    ).toBe(true);
  });

  it('tolerates a sub-pixel upward jitter while settling', () => {
    expect(
      atBottomOnScroll({
        distance: 0,
        previousTop: 700,
        currentTop: 699.5,
        landingActive: false,
        currentAtBottom: false,
      }),
    ).toBe(true);
  });
});

describe('atBottomOnWheel — wheel is intent', () => {
  it('an upward wheel disarms at ANY distance', () => {
    expect(
      atBottomOnWheel({ deltaY: -60, distance: 0, currentAtBottom: true }),
    ).toBe(false);
    expect(
      atBottomOnWheel({ deltaY: -60, distance: 5_000, currentAtBottom: true }),
    ).toBe(false);
  });

  it('a downward wheel landing inside the band re-arms (2026-09-14 dead edge)', () => {
    expect(
      atBottomOnWheel({ deltaY: 60, distance: AT_BOTTOM_THRESHOLD, currentAtBottom: false }),
    ).toBe(true);
    expect(
      atBottomOnWheel({ deltaY: 60, distance: 0, currentAtBottom: false }),
    ).toBe(true);
  });

  it('a downward wheel still outside the band changes nothing', () => {
    expect(
      atBottomOnWheel({
        deltaY: 60,
        distance: AT_BOTTOM_THRESHOLD + 1,
        currentAtBottom: false,
      }),
    ).toBe(false);
    expect(
      atBottomOnWheel({
        deltaY: 60,
        distance: AT_BOTTOM_THRESHOLD + 1,
        currentAtBottom: true,
      }),
    ).toBe(true);
  });
});

describe('atBottomOnTouchDrag — the drag deltas carry the intent', () => {
  it('dragging the content down (scrollTop decreasing) disarms at the first pixel', () => {
    expect(
      atBottomOnTouchDrag({ currentTop: 695, previousTop: 700, currentAtBottom: true }),
    ).toBe(false);
  });

  it('dragging up toward the end leaves the flag alone', () => {
    expect(
      atBottomOnTouchDrag({ currentTop: 705, previousTop: 700, currentAtBottom: true }),
    ).toBe(true);
  });

  it('the drag start (no previous top) changes nothing', () => {
    expect(
      atBottomOnTouchDrag({ currentTop: 700, previousTop: null, currentAtBottom: true }),
    ).toBe(true);
  });
});
