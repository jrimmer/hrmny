/**
 * @cytale/web — the channel call-header derivation (calls plan U7, U2 lift).
 *
 * The ONE implementation of the header phone affordance's reactive state:
 * live-ness (the U6 call slice), ring emphasis (U11, non-DM), and the
 * start/join intents (the useCall engine seam). It lived inside MessagePane
 * until U2; the mobile topbar's join-voice control needs the exact same
 * derivation, so it was lifted here — the topbar is chrome, never a second
 * header implementation. Both hosts consume this hook against the same
 * store + engine, so their affordances can never drift apart.
 *
 * Host override seams keep their U7 contracts: `onStartCall`/`onJoinCall`
 * (tests and pre-nav surfaces) replace the engine intents when present.
 */

import { useCallback } from 'react';

import { defaultStore, selectCallRing, selectLiveCall, type StateStore } from '@cytale/state';

import { useStoreSlices } from '../../app/useStoreSelector.js';
import { useCall } from './useCall.js';

/** What the header derivation reads off the store (lane D #17). */
const CALL_HEADER_SLICES = ['channels', 'callByChannel', 'dmCallByChannel', 'callRingByChannel'] as const;

export interface UseChannelCallHeaderOptions {
  /**
   * DM-ness override for the ring-emphasis derivation (DM conversations are
   * excluded — the DmCallIndicator owns the incoming state there). Defaults
   * to the store's channel record.
   */
  isDm?: boolean;
  /** Start-call intent override; defaults to the useCall seam. */
  onStartCall?: (opts: { ring: boolean }) => void;
  /** Join-call intent override; defaults to the useCall seam. */
  onJoinCall?: () => void;
}

export interface UseChannelCallHeader {
  /** True while a call is live in the channel (CALL_SYNC/START/UPDATE). */
  live: boolean;
  /** True while the channel's call is ringing this client (non-DM only). */
  ringing: boolean;
  /** Start-call intent (honors the override seam). */
  start(opts: { ring: boolean }): void;
  /** Join-call intent (honors the override seam). */
  join(): void;
}

/**
 * Derive the channel header's call affordance state. `store` is injectable
 * for tests; the app uses the module-default store (the same one the
 * session's gateway events hydrate).
 */
export function useChannelCallHeader(
  store: StateStore = defaultStore,
  channelId: string | null,
  { isDm, onStartCall, onJoinCall }: UseChannelCallHeaderOptions = {},
): UseChannelCallHeader {
  // Destructure once: useCall returns a fresh object per render, so holding
  // the whole api in the callbacks' deps would undercut the identity
  // stability below — the engine's start/join are useCallback-stable.
  const { startCall: engineStart, joinCall: engineJoin } = useCall(store);
  // The subscription keeps the Start→Join flip reactive standalone (hosts
  // that already subscribe to the store re-render anyway; this makes the
  // hook self-sufficient wherever it mounts — including the topbar).
  // Identity-stable subscribe/getSnapshot: inline closures would change
  // every render, and AuthenticatedApp re-renders on every gateway store
  // write (boot storm) — resubscribing per render is churn the shell
  // doesn't need.
  //
  // Lane D #17: gated on the four slices the derivation reads — the whole-
  // store snapshot re-rendered the header (and the topbar control) for every
  // gateway event in the app.
  const state = useStoreSlices(store, CALL_HEADER_SLICES);

  const live = channelId !== null && selectLiveCall(state, channelId) !== undefined;
  const dm = isDm ?? (channelId !== null && state.channels[channelId]?.type === 'dm');
  const ringing =
    channelId !== null && !dm && selectCallRing(state, channelId) !== undefined;

  const start = useCallback(
    (opts: { ring: boolean }) => {
      if (channelId === null) return;
      if (onStartCall) onStartCall(opts);
      else engineStart(channelId, opts);
    },
    [channelId, onStartCall, engineStart],
  );
  const join = useCallback(() => {
    if (channelId === null) return;
    if (onJoinCall) onJoinCall();
    else engineJoin(channelId);
  }, [channelId, onJoinCall, engineJoin]);

  return { live, ringing, start, join };
}
