/**
 * @cytale/web — the media master switch's client read (ticket #124).
 *
 * The server declares `media_enabled` on READY (the cheapest seam every
 * authenticated client already reads at boot — zero extra round-trips; the
 * store reconciles it into `mediaEnabled`). This hook is the reactive read
 * the call affordances share: false → the surfaces hide Start-call
 * affordances behind an HONEST "calls are off on this server" state instead
 * of silently missing buttons (states-first: hidden-because-disabled must be
 * distinguishable from not-built). Cosmetic only — the authoritative gate is
 * server-side (call start/join + the ICE mint refuse regardless).
 *
 * Absence reads as enabled: a server predating the switch omits the READY
 * field, and there permissions alone govern calls — exactly as before.
 */

import { useCallback, useSyncExternalStore } from 'react';

import { defaultStore, type StateStore } from '@cytale/state';

export function useMediaEnabled(store: StateStore = defaultStore): boolean {
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => store.getState().mediaEnabled, [store]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** The user-facing copy for the disabled state (one phrasing everywhere). */
export const MEDIA_DISABLED_TITLE = 'Calls are turned off on this server';
