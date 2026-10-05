/**
 * @cytale/web — per-room call-ring mute state (calls plan U11, AM6).
 *
 * The client half of the durable per-user-per-channel setting: the channel
 * context menu toggles through `toggleCallMute`, which PATCHes
 * `/channels/{id}/call-notification-mute` (@cytale/api-client) and tracks
 * the state in this small vanilla-zustand store so every surface reading the
 * label ("Mute call rings" / "Unmute call rings") stays in sync.
 *
 * Optimistic with rollback: the label flips immediately, `status` marks the
 * PATCH in flight, and a failure reverts + exposes `status: 'error'` for the
 * menu's inline alert (states-first DoD).
 *
 * KNOWN V1 SEAM (recorded): the REST surface ships no read for the mute
 * (only the PATCH — the server consults the table when dispatching
 * CALL_RING, U4), so the map starts empty each session and learns state as
 * the user toggles. The server-side default is unmuted, which matches the
 * fresh-session label. Durable across RESTARTS means the server never
 * re-rings muted members — not that this client map survives reloads.
 */

import { useSyncExternalStore } from 'react';
import { createStore } from 'zustand/vanilla';

import { api } from '../../auth/session.js';

export type CallMuteStatus = 'idle' | 'pending' | 'error';

export interface CallMuteEntry {
  muted: boolean;
  status: CallMuteStatus;
}

interface CallMuteState {
  byChannel: Record<string, CallMuteEntry>;
}

const DEFAULT_ENTRY: CallMuteEntry = { muted: false, status: 'idle' };

/** Module-default store (the SPA has exactly one mute map). */
export const callMuteStore = createStore<CallMuteState>()((_) => ({
  byChannel: {},
}));

/** Synchronous read (driver gates + non-React consumers). */
export function getCallMute(channelId: string): CallMuteEntry {
  return callMuteStore.getState().byChannel[channelId] ?? DEFAULT_ENTRY;
}

/** Synchronous muted read for the ring driver's suppression gate. */
export function isCallMuted(channelId: string): boolean {
  return getCallMute(channelId).muted;
}

/** Reactive read for surfaces (the context menu's label). */
export function useCallMute(channelId: string): CallMuteEntry {
  return useSyncExternalStore(
    callMuteStore.subscribe,
    () => callMuteStore.getState().byChannel[channelId] ?? DEFAULT_ENTRY,
    () => DEFAULT_ENTRY,
  );
}

/**
 * Toggle the channel's ring mute: optimistic flip → PATCH → keep or revert.
 * Never throws to the caller (the entry's `status` carries the outcome) so
 * menu handlers can fire-and-forget.
 */
export async function toggleCallMute(channelId: string): Promise<void> {
  const current = getCallMute(channelId);
  const next = !current.muted;

  callMuteStore.setState((s) => ({
    byChannel: {
      ...s.byChannel,
      [channelId]: { muted: next, status: 'pending' },
    },
  }));

  try {
    const res = await api.setCallNotificationMute(channelId, next);
    // Server echo is authoritative (a successful unmute reports false).
    callMuteStore.setState((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: { muted: res.muted, status: 'idle' },
      },
    }));
  } catch {
    callMuteStore.setState((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: { muted: current.muted, status: 'error' },
      },
    }));
  }
}

/** Test seam: reset the map between cases. */
export function resetCallMuteStoreForTests(): void {
  callMuteStore.setState({ byChannel: {} });
}
