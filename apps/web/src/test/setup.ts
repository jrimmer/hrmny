import '@testing-library/dom';

import { toHaveNoViolations } from 'vitest-axe/matchers';

expect.extend({ toHaveNoViolations });

// Node ≥22 exposes an experimental global `localStorage` that is inert unless
// --localstorage-file is provided, and it shadows jsdom's working copy — so
// token-persistence tests would silently read null. Detect that inert copy
// (write throws or read-back fails) and replace it with a minimal in-memory
// shim. Real browsers are unaffected.
(() => {
  // Node-environment suites (vitest `@vitest-environment node`, e.g. the
  // build-gate test that must not boot jsdom) have no window at all.
  if (typeof window === 'undefined') return;
  const probe = '__cytale_ls_probe__';
  let working = true;
  try {
    window.localStorage.setItem(probe, '1');
    working = window.localStorage.getItem(probe) === '1';
    window.localStorage.removeItem(probe);
  } catch {
    working = false;
  }
  if (working) return;

  const store = new Map<string, string>();
  const shim: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    removeItem: (k: string) => void store.delete(k),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
  };
  Object.defineProperty(window, 'localStorage', { configurable: true, writable: true, value: shim });
})();

// jsdom ships a throwing matchMedia stub; the AppShell responsive contract
// (useIsMobileWidth) needs a working one. Default: desktop (matches:false for
// max-width queries). Mobile-state tests import the helper to flip it.
const listeners = new Map<MediaQueryList, (e: MediaQueryListEvent) => void>();

/**
 * Flippable matchMedia state. `mobile` drives the max/min-width queries
 * (AppShell responsive contract); `coarse` (U3) drives `pointer: coarse` —
 * the touch-capability gate behind the long-press message actions. Default:
 * desktop + fine pointer, so every pre-U3 suite keeps its exact behavior.
 */
const mqlState = { mobile: false, coarse: false };

function evaluate(query: string): boolean {
  if (query.includes('pointer: coarse')) return mqlState.coarse;
  if (query.includes('pointer: fine')) return !mqlState.coarse;
  if (query.includes('max-width')) return mqlState.mobile;
  if (query.includes('min-width')) return !mqlState.mobile;
  return false;
}

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const mql = {
        get matches() {
          return evaluate(query);
        },
        media: query,
        onchange: null,
        addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          listeners.set(mql, cb);
        },
        removeEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => {
          if (listeners.get(mql) === cb) listeners.delete(mql);
        },
        addListener: (cb: (e: MediaQueryListEvent) => void) => {
          listeners.set(mql, cb);
        },
        removeListener: (cb: (e: MediaQueryListEvent) => void) => {
          if (listeners.get(mql) === cb) listeners.delete(mql);
        },
        dispatchEvent: () => false,
      } as unknown as MediaQueryList;
      return mql;
    },
  });
}

export const mobileWidthState = mqlState;
/** Same flippable object — `.coarse` gates the pointer: coarse queries (U3). */
export const coarsePointerState = mqlState;

// jsdom ships no object-URL implementation; anything staging a local File
// (crop dialog, attachment thumbs) needs the pair.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => `blob:mock-${Math.random().toString(36).slice(2)}`;
  URL.revokeObjectURL = () => undefined;
}

// #150: cmdk scrolls the selected item into view; jsdom omits the DOM method.
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// #150: cmdk's Command list measures with ResizeObserver, which jsdom omits.
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
