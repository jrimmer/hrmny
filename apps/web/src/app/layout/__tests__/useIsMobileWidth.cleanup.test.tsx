/**
 * useIsMobileWidth cleanup — review #13: the R10 defensive listeners must
 * all be removed at unmount. Runs in its own file because the strengthened
 * add/remove pair-matching is order-sensitive to foreign window listeners
 * registered by earlier tests in the main hook suite.
 */
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useIsMobileWidth } from '../useIsMobileWidth.js';

describe('useIsMobileWidth — cleanup removes every registered listener (review #13)', () => {
  it('removes each (type, handler) pair the effect registered', () => {
    const addWindow = vi.spyOn(window, 'addEventListener');
    const addDoc = vi.spyOn(document, 'addEventListener');
    const removeWindow = vi.spyOn(window, 'removeEventListener');
    const removeDoc = vi.spyOn(document, 'removeEventListener');

    const windowBefore = addWindow.mock.calls.length;
    const docBefore = addDoc.mock.calls.length;
    const { unmount } = renderHook(() => useIsMobileWidth());
    const addedWindow = addWindow.mock.calls
      .slice(windowBefore)
      .filter(([, h]) => typeof h === 'function')
      .map(([t, h]) => [t, h as EventListener] as const);
    const addedDoc = addDoc.mock.calls
      .slice(docBefore)
      .filter(([, h]) => typeof h === 'function')
      .map(([t, h]) => [t, h as EventListener] as const);
    expect(addedWindow.length).toBeGreaterThan(0);

    unmount();

    for (const [type, handler] of addedWindow) {
      const ok = removeWindow.mock.calls.some(([n, h]) => n === type && h === handler);
      console.log('PAIR', type, String(handler).slice(0, 25), 'removed:', ok);
      expect(ok).toBe(true);
    }
    // React registers its own document selectionchange listener during
    // mount — only OUR contract (visibilitychange) must be removed by the
    // hook's cleanup.
    const visibility = addedDoc.find(([t]) => t === 'visibilitychange');
    expect(visibility).toBeTruthy();
    expect(removeDoc.mock.calls.some(([n, h]) => n === 'visibilitychange' && h === visibility![1])).toBe(true);
    addWindow.mockRestore();
    addDoc.mockRestore();
    removeWindow.mockRestore();
    removeDoc.mockRestore();
  });
});
