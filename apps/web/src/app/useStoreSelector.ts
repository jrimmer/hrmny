/**
 * @cytale/web — the ONE store-subscription primitive (lane D #17).
 *
 * The app grew half a dozen hand-rolled subscriptions to the U17 store, and
 * most of them had one of two defects:
 *
 *   * WHOLE-STORE snapshots — `useSyncExternalStore(subscribe, () =>
 *     store.getState())`: `getState()` is a new object after ANY write, so the
 *     component re-rendered for every gateway event in the app (a typing tick
 *     in another workspace re-rendered the ring toasts, the inbox, the thread
 *     rail…);
 *   * INLINE subscribe functions — `useSyncExternalStore((cb) =>
 *     store.subscribe(cb), …)`: a new function per render, which React treats
 *     as a new subscription (unsubscribe + resubscribe every render).
 *
 * `useStoreSelector` is the shape every reader should take: a stable
 * subscription, a selector, and an equality — the component re-renders only
 * when the SELECTED value changes by that equality. `useStoreSlices` is the
 * same gate for a subtree that hands a store-shaped object to children (the
 * shell's `Live*` leaves): it is why unread and presence no longer ride the
 * shell's snapshot.
 */

import { useCallback, useRef, useSyncExternalStore } from 'react';

import type { StateState, StateStore } from '@cytale/state';

export type Equality<T> = (a: T, b: T) => boolean;

/**
 * Subscribe to `selector(store.getState())`, re-rendering only when the
 * selected value changes under `equal` (default `Object.is`).
 *
 * `selector` and `equal` may be inline: the last selected value is cached
 * against the store state it came from, so an unrelated write (a new state
 * object whose selection is equal) hands back the SAME value and React bails
 * out. The subscription itself is keyed on the store only.
 */
export function useStoreSelector<T>(
  store: StateStore,
  selector: (state: StateState) => T,
  equal: Equality<T> = Object.is,
): T {
  const cache = useRef<{ state: StateState | null; value: T | undefined; has: boolean }>({
    state: null,
    value: undefined,
    has: false,
  });
  // The latest selector/equality, read at snapshot time (they may be inline).
  const selectRef = useRef(selector);
  const equalRef = useRef(equal);
  selectRef.current = selector;
  equalRef.current = equal;

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback((): T => {
    const state = store.getState();
    const c = cache.current;
    if (c.has && c.state === state) return c.value as T;
    const next = selectRef.current(state);
    if (c.has && equalRef.current(c.value as T, next)) {
      c.state = state;
      return c.value as T;
    }
    c.state = state;
    c.value = next;
    c.has = true;
    return next;
  }, [store]);

  // A selector that closes over props must re-select when the props change:
  // drop the state-identity shortcut for this render so the new selector runs.
  const lastSelector = useRef(selector);
  if (lastSelector.current !== selector) {
    lastSelector.current = selector;
    cache.current.state = null;
  }

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Shallow record equality (same keys, `Object.is` values). */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of ka) if (!Object.is(ra[k], rb[k])) return false;
  return true;
}

/**
 * A snapshot of the WHOLE state that re-renders only when one of `keys` is
 * re-identified — the `useShellStore` gate, for any subtree that hands a
 * store-shaped object to children (sidebars, Home). The returned value is a
 * real `StateState`, stable across writes to slices outside `keys`.
 */
export function useStoreSlices(store: StateStore, keys: readonly (keyof StateState)[]): StateState {
  return useStoreSelector(
    store,
    (s) => s,
    (a, b) => {
      for (const k of keys) if (!Object.is(a[k], b[k])) return false;
      return true;
    },
  );
}
