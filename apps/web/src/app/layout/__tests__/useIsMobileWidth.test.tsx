/**
 * useIsMobileWidth — the breakpoint contract's defensive re-evaluation
 * (plan 003 U7 / R10). The audit observed a stranded mobile branch after a
 * resize whose `change` event was missed; these tests simulate exactly that
 * through the shared mock (mobileWidthState) by flipping the underlying
 * state WITHOUT dispatching a change event, then firing the defensive
 * triggers (resize/focus/visibilitychange) and expecting the hook to
 * converge on the new reality.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { mobileWidthState } from '../../../test/setup.js';
import { useIsMobileWidth } from '../useIsMobileWidth.js';

describe('useIsMobileWidth — defensive re-evaluation (U7/R10)', () => {
  afterEach(() => {
    mobileWidthState.mobile = false;
  });

  function flipWithoutChangeEvent(mobile: boolean) {
    // The missed-event simulation: the query's reality changes but no
    // MediaQueryListEvent fires (the audit's stranded-branch precondition).
    mobileWidthState.mobile = mobile;
  }

  it('recovers via a debounced resize after a missed change event (the audit repro)', async () => {
    mobileWidthState.mobile = true;
    const { result } = renderHook(() => useIsMobileWidth());
    expect(result.current).toBe(true);

    flipWithoutChangeEvent(false);
    act(() => {
      window.dispatchEvent(new window.Event('resize'));
    });
    // Debounced — not yet converged.
    expect(result.current).toBe(true);
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('recovers via focus after a missed change event', async () => {
    mobileWidthState.mobile = true;
    const { result } = renderHook(() => useIsMobileWidth());
    expect(result.current).toBe(true);

    flipWithoutChangeEvent(false);
    act(() => {
      window.dispatchEvent(new window.Event('focus'));
    });
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('recovers via visibilitychange after a missed change event', async () => {
    mobileWidthState.mobile = false;
    const { result } = renderHook(() => useIsMobileWidth());
    expect(result.current).toBe(false);

    flipWithoutChangeEvent(true);
    act(() => {
      document.dispatchEvent(new window.Event('visibilitychange'));
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('still follows a real change event immediately', async () => {
    const { result } = renderHook(() => useIsMobileWidth());
    expect(result.current).toBe(false);
    act(() => {
      mobileWidthState.mobile = true;
      // The shared mock's listeners fire change on setMobile — drive one directly.
      window.dispatchEvent(new window.Event('resize'));
    });
    await waitFor(() => expect(result.current).toBe(true));
  });

});
