/**
 * @cytale/web — presence state hook (U23).
 *
 * Reads per-user presence (online/idle/dnd/offline) from the U17 store's
 * `presenceByUser` slice, which reconcile.ts keeps in sync with gateway
 * PRESENCE_UPDATE dispatches (the session's `onAny` hydration path). The
 * store is injectable for tests; the app uses the module default.
 *
 * Subscription is scoped to the store slice — components read only the
 * presence of users they render (member list, DM partners), never a
 * whole-workspace push.
 */

import { useMemo } from 'react';

import type { PresenceStatus } from '@cytale/protocol';
import { defaultStore, type StateStore } from '@cytale/state';

import { useStoreSelector } from '../../app/useStoreSelector.js';

export type PresenceByUser = Record<string, PresenceStatus>;

/**
 * Reactive presence map keyed by user snowflake id. Returns a fresh object
 * only when the underlying store slice changes (zustand snapshot identity).
 */
export function usePresence(store: StateStore = defaultStore): PresenceByUser {
  // The presence slice only, through a stable subscription (lane D #17) —
  // this was a whole-store snapshot, and the map was rebuilt every render.
  const presenceByUser = useStoreSelector(store, (s) => s.presenceByUser);
  return useMemo(() => {
    const out: PresenceByUser = {};
    for (const [id, entry] of Object.entries(presenceByUser)) {
      out[id] = entry.status;
    }
    return out;
  }, [presenceByUser]);
}

/** Presence of a single user, or 'offline' when unknown. */
export function presenceOf(presence: PresenceByUser, userId: string): PresenceStatus {
  return presence[userId] ?? 'offline';
}
