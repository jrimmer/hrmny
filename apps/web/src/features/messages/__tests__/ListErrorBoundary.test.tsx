/**
 * @cytale/web — ListErrorBoundary tests (#135/#137).
 *
 * The boundary's contract, at unit level:
 *   * a crash INSIDE the list subtree is contained: the crashing children
 *     leave the tree in the crash commit (render null), every crash is
 *     reported through the shared reporter (the wire's `error-boundary`
 *     source; the component stack attributes it to the list subtree), and
 *     the response is a REMOUNT — a fresh subtree epoch via the attempt key;
 *   * remounts are capped: a fault that survives its own remounts hits the
 *     cap after a BOUNDED number of catches and an inline fallback renders,
 *     with a Try again that resets the cap and remounts;
 *   * a healthy list is rendered untouched, and nothing is reported.
 *
 * Mount counts: React 19's concurrent renderer makes TWO render attempts per
 * committed crash (the abandoned concurrent attempt + the synchronous
 * recovery), so one logical crash logs two child invocations — the assertions
 * count REPORTS (one per committed crash) and bound the mounts, rather than
 * pinning React's internal attempt count.
 *
 * What this does NOT prove: the upstream emit-graph oscillation itself.
 * jsdom cannot reproduce it (react-virtuoso's own dev deps use Playwright
 * for exactly this reason — see the e2e scrollback spec). Here we prove the
 * CONTAINMENT semantics that hold regardless of what throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, act } from '@testing-library/react';
import React from 'react';

import { ListErrorBoundary } from '../ListErrorBoundary.js';

/** Reporter seam double: captures captureThrown calls. */
function reporterDouble() {
  return { captureThrown: vi.fn() };
}

/** A list child that throws the crash under investigation on every render. */
function alwaysThrowsChild(mounts: number[] = []) {
  return function AlwaysThrows() {
    mounts.push(mounts.length + 1);
    throw new RangeError('Maximum call stack size exceeded');
  };
}

beforeEach(() => {
  // React logs caught errors even when a boundary handles them, and its
  // concurrent-render recovery reports the abandoned attempt through
  // window.reportError — quiet both: the boundary's handling is the
  // behavior under test, not React's own notices.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('reportError', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ListErrorBoundary', () => {
  it('a healthy list renders untouched and reports nothing', () => {
    const reporter = reporterDouble();
    render(
      <ListErrorBoundary reporter={reporter}>
        <div data-testid="list-ok">fine</div>
      </ListErrorBoundary>,
    );
    expect(screen.getByTestId('list-ok')).toBeTruthy();
    expect(reporter.captureThrown).not.toHaveBeenCalled();
  });

  it('a fault that survives its remounts is contained: reported per catch, capped, fallback', () => {
    const reporter = reporterDouble();
    const mounts: number[] = [];
    const Broken = alwaysThrowsChild(mounts);
    render(
      <ListErrorBoundary reporter={reporter} maxRemounts={2}>
        <Broken />
      </ListErrorBoundary>,
    );

    // The cap stopped the loop: an inline fallback replaces the list —
    // bounded work, not a per-frame remount-crash cycle.
    expect(screen.getByTestId('list-crash-fallback')).toBeTruthy();
    expect(screen.queryByTestId('list-ok')).toBeNull();

    // One report per committed crash (initial + the two capped remounts)…
    expect(reporter.captureThrown.mock.calls.length).toBe(3);
    for (const call of reporter.captureThrown.mock.calls) {
      expect(call[1]).toMatchObject({ source: 'error-boundary' });
      expect((call[0] as Error).message).toBe('Maximum call stack size exceeded');
    }
    // …each response mounted a FRESH subtree (two render attempts per crash
    // under React 19's recovery — the exact count is React's business; what
    // is ours is that the loop stayed BOUNDED and never resumed the crashed
    // subtree in place).
    expect(mounts.length).toBeGreaterThan(0);
    expect(mounts.length).toBeLessThan(12);
  });

  it('Try again clears the cap and remounts the list once the fault is gone', () => {
    const reporter = reporterDouble();
    const Broken = alwaysThrowsChild();
    const { rerender } = render(
      <ListErrorBoundary reporter={reporter} maxRemounts={2}>
        <Broken />
      </ListErrorBoundary>,
    );
    expect(screen.getByTestId('list-crash-fallback')).toBeTruthy();

    // The fault clears (as if the oscillation lost its trigger), the reader
    // presses Try again, and the list comes back — remounted, at the newest
    // position the host's initialTopMostItemIndex chooses.
    const reportsBeforeRetry = reporter.captureThrown.mock.calls.length;
    rerender(
      <ListErrorBoundary reporter={reporter} maxRemounts={2}>
        <div data-testid="list-ok">list ok</div>
      </ListErrorBoundary>,
    );
    act(() => {
      screen.getByTestId('list-crash-retry').click();
    });
    expect(screen.queryByTestId('list-crash-fallback')).toBeNull();
    expect(screen.getByTestId('list-ok')).toBeTruthy();
    // The retry itself reported nothing new — the crash count is untouched.
    expect(reporter.captureThrown.mock.calls.length).toBe(reportsBeforeRetry);
  });
});
