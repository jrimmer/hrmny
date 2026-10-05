/**
 * @cytale/web — the ring toast lifecycle (calls plan U11, R7/AM6/AM19).
 *
 * The store's `callRingByChannel` slice (U6) is the single source of truth:
 * CALL_RING writes one entry per call (call_id dedupe, rang_at preserved),
 * and THIS module owns the consumer side — mounting a toast per entry,
 * expiring it 30 s after `rang_at` (the wire carries no clock; the slice
 * stamped arrival), clearing the slice via `clearCallRing` on expiry/
 * dismiss/join, and gating side effects:
 *
 *   DM rings        — the reducer stays SILENT: U10's DmCallIndicator owns
 *                     the DM ring surface (no double-toast). Discriminated
 *                     from the channel record (`type: 'dm'`) or the DM call
 *                     slice (a live DM call on the channel).
 *   in-call rings   — subtle toast only, no sound (the plan's in-call
 *                     courtesy; `subtle: true` on the mounted toast).
 *   muted channels  — suppressed entirely + the slice cleared (defensive
 *                     belt: the SERVER already excludes muted members from
 *                     CALL_RING delivery, U4 — this covers the toggle race).
 *   backgrounded    — AM19: see notifyBackgroundRing below.
 *
 * Pure reducer + driver hook split mirrors the TypingIndicator expiry
 * pattern (U23): `ringReducer` is testable without React; `useRingToasts`
 * owns timers, store sync, and side effects.
 */

import { useEffect, useRef, useState } from 'react';

import {
  clearCallRing,
  defaultStore,
  type StateState,
  type StateStore,
} from '@cytale/state';

import { useStoreSlices } from '../../../app/useStoreSelector.js';
import { getCallEngine } from '../useCallMedia.js';
import { createRingSound, type RingSoundController } from './RingSound.js';
import { isCallMuted } from './notificationMute.js';

/** Ring lifetime — the plan's ~30 s window, measured from `rang_at`. */
export const RING_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Toast model + pure reducer
// ---------------------------------------------------------------------------

/** One mounted ring toast (1:1 with a store CallRingEntry while alive). */
export interface RingToastState {
  channelId: string;
  callId: string;
  fromUser: string;
  /** Unix epoch ms the ring arrived (the slice's `rang_at`). */
  rangAt: number;
  /** True when mounted while the viewer was in another call (no sound). */
  subtle: boolean;
}

export type RingAction =
  /** Mount (or replace, on a same-channel new call) a toast. */
  | { type: 'ring'; toast: RingToastState }
  /** 30 s expiry / dismissal of one call's toast. */
  | { type: 'expire'; channelId: string; callId: string }
  /** The slice vanished or moved on (cleared elsewhere) — drop the toast. */
  | { type: 'remove'; channelId: string };

export function ringReducer(state: RingToastState[], action: RingAction): RingToastState[] {
  switch (action.type) {
    case 'ring': {
      // One toast per channel (a newer call replaces an older one's toast);
      // one toast per call_id (a re-delivery never remounts — the store's
      // dedupe already preserves the original rang_at, and mounting is
      // keyed on the slice entry, so this arm only runs for NEW entries).
      const withoutChannel = state.filter((t) => t.channelId !== action.toast.channelId);
      return [...withoutChannel, action.toast];
    }
    case 'expire':
      return state.filter(
        (t) => !(t.channelId === action.channelId && t.callId === action.callId),
      );
    case 'remove':
      return state.filter((t) => t.channelId !== action.channelId);
  }
}

/** Milliseconds until a ring stamped `rangAt` expires, clamped to ≥ 0. */
export function ringExpiryDelayMs(rangAt: number, now: number): number {
  return Math.max(rangAt + RING_TIMEOUT_MS - now, 0);
}

// ---------------------------------------------------------------------------
// Discriminators
// ---------------------------------------------------------------------------

/**
 * True when the ring's channel is a DM conversation (U10's DmCallIndicator
 * owns the surface): the hydrated channel record says `dm`, or a live call
 * rides the DM slice (covers un-hydrated channels).
 */
export function isDmRing(state: StateState, channelId: string): boolean {
  if (state.channels[channelId]?.type === 'dm') return true;
  return state.dmCallByChannel[channelId] !== undefined;
}

/**
 * True while the viewer holds (or is establishing/tearing down) a voice leg
 * on ANY channel — the in-call courtesy gate. Mirrors the shell's
 * call-surface derivation over the engine snapshot.
 */
export function viewerInCall(): boolean {
  const snapshot = getCallEngine().getSnapshot();
  return (
    snapshot.channelId !== null &&
    (snapshot.voice.status !== 'idle' || snapshot.voice.notice !== null)
  );
}

// ---------------------------------------------------------------------------
// AM19 — backgrounded PWA ring
// ---------------------------------------------------------------------------

/**
 * Surface a ring that arrived while the PWA was backgrounded (AM19).
 *
 * DISPOSITION (recorded per the unit brief): the client ships NO wired
 * web-push/Notification surface today — searched apps/web/src/features for
 * Notification usage: zero hits; only the REST push-subscription endpoints
 * (@cytale/api-client createPushSubscription/deletePushSubscription) and the
 * capability helpers (isWebPushSupported) exist, with no subscribe UI, so
 * Notification permission can never have been granted and a guarded
 * `new Notification(...)` would be unreachable dead code. A backgrounded
 * ring is therefore VISIBLE ON RETURN (the toast mounts from the store
 * slice; the sidebar/header emphasis rides it) — the documented V1
 * limitation, not a silent failure. Wire the real badge here when the
 * push-subscription surface lands.
 */
export function notifyBackgroundRing(channelId: string, callId: string): void {
  void channelId;
  void callId;
}

// ---------------------------------------------------------------------------
// Driver hook — store sync, timers, side effects
// ---------------------------------------------------------------------------

/** Injectable environment (tests override; defaults wire the real seams). */
export interface RingDriverDeps {
  /** Ring sound controller; default = a fresh WebAudio-synthesized one. */
  sound?: RingSoundController;
  /** In-call gate; default = the module call engine's snapshot. */
  isViewerInCall?: () => boolean;
  /** Per-channel mute gate; default = the notificationMute store. */
  isChannelMuted?: (channelId: string) => boolean;
  /** Hidden-document gate (AM19); default = document.hidden. */
  isDocumentHidden?: () => boolean;
  /** Clock; default = Date.now. */
  now?: () => number;
}

/** What the ring sweep reads (see `useRingToasts`). */
const RING_SLICES = ['callRingByChannel', 'channels', 'dmCallByChannel'] as const;

export function useRingToasts(
  store: StateStore = defaultStore,
  deps: RingDriverDeps = {},
): RingToastState[] {
  const sound = deps.sound;
  const isViewerInCall = deps.isViewerInCall ?? viewerInCall;
  const isChannelMuted = deps.isChannelMuted ?? isCallMuted;
  const isDocumentHidden = deps.isDocumentHidden ?? (() => document.hidden);
  const now = deps.now ?? Date.now;

  // Gated on the ring slice (plus the two slices `isDmRing` reads) — lane D
  // #17. The sweep used to re-run on EVERY store write in the app; a ring can
  // only mount or retire when one of these moves.
  const state = useStoreSlices(store, RING_SLICES);
  const [toasts, setToasts] = useState<RingToastState[]>([]);
  const toastsRef = useRef<RingToastState[]>([]);
  toastsRef.current = toasts;
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const soundingRef = useRef(false);
  const soundDepsRef = useRef<RingDriverDeps>({});
  soundDepsRef.current = { sound };

  // Mount/expiry sweep: runs on every store change; diffs the ring slice
  // against the mounted toasts (the TypingIndicator expiry pattern).
  useEffect(() => {
    const rings = state.callRingByChannel;
    const dispatch = (action: RingAction) =>
      setToasts((prev) => {
        const next = ringReducer(prev, action);
        toastsRef.current = next;
        return next;
      });

    // 1) drop toasts whose slice entry vanished or moved to a new call
    //    (cleared by dismissal elsewhere, replaced, or session reset).
    for (const t of [...toastsRef.current]) {
      const entry = rings[t.channelId];
      if (entry === undefined || entry.call_id !== t.callId) {
        const timer = timersRef.current.get(t.channelId);
        if (timer) {
          clearTimeout(timer);
          timersRef.current.delete(t.channelId);
        }
        dispatch({ type: 'remove', channelId: t.channelId });
      }
    }

    // 2) mount toasts for new slice entries.
    for (const [channelId, entry] of Object.entries(rings)) {
      if (entry === undefined) continue;
      const mounted = toastsRef.current.find((t) => t.channelId === channelId);
      if (mounted !== undefined && mounted.callId === entry.call_id) continue; // seen

      // DM rings route to DmCallIndicator (U10) — no toast, no side effects,
      // and the slice is left readable for the missed-call derivation.
      if (isDmRing(state, channelId)) continue;

      // Muted rooms are never rung by the server (U4); if a ring raced the
      // toggle, suppress every surface and clear the slice (belt + braces —
      // the sidebar emphasis reads the slice too).
      if (isChannelMuted(channelId)) {
        clearCallRing(store, channelId);
        continue;
      }

      const subtle = isViewerInCall();
      const toast: RingToastState = {
        channelId,
        callId: entry.call_id,
        fromUser: entry.from_user,
        rangAt: entry.rang_at,
        subtle,
      };
      dispatch({ type: 'ring', toast });

      // 30 s from the slice's rang_at — a ring re-delivered mid-window never
      // extends it (the store dedupe preserved the original stamp).
      const timer = setTimeout(
        () => {
          timersRef.current.delete(channelId);
          clearCallRing(store, channelId); // the sweep below drops the toast
        },
        ringExpiryDelayMs(entry.rang_at, now()),
      );
      const existing = timersRef.current.get(channelId);
      if (existing) clearTimeout(existing);
      timersRef.current.set(channelId, timer);

      if (isDocumentHidden()) notifyBackgroundRing(channelId, entry.call_id);
    }
    // The sweep reads `state` wholesale; gates are stable deps by contract.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, store]);

  // Sound lifecycle: start when the first non-subtle toast mounts; stop when
  // no audible toast remains. A blocked start resolves inaudible — the
  // visual surfaces keep carrying the ring (autoplay fallback).
  const audibleCount = toasts.filter((t) => !t.subtle).length;
  useEffect(() => {
    const controller = soundDepsRef.current.sound;
    if (controller === undefined) return;
    if (audibleCount > 0 && !soundingRef.current) {
      soundingRef.current = true;
      void controller
        .start()
        .then((result) => {
          if (!result.audible) soundingRef.current = false; // visual-only ring
        })
        .catch(() => {
          soundingRef.current = false;
        });
    } else if (audibleCount === 0 && soundingRef.current) {
      soundingRef.current = false;
      controller.stop();
    }
  }, [audibleCount]);

  // Unmount: timers + sound teardown.
  useEffect(
    () => () => {
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
      if (soundingRef.current) {
        soundingRef.current = false;
        soundDepsRef.current.sound?.stop();
      }
    },
    [],
  );

  return toasts;
}
