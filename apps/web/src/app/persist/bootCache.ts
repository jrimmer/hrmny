/**
 * @cytale/web — the device snapshot's place in the boot (lane D #8).
 *
 * `deviceCache.ts` owns reading, writing and clearing the snapshot; this
 * module decides WHEN, against the session:
 *
 *   * the snapshot for the last member who signed in on this device starts
 *     loading at entry, in parallel with the session restore — never blocking
 *     it (the load is time-capped);
 *   * it is applied only once the session says who is signed in, and only
 *     when that is the same member (a different member's snapshot is
 *     discarded and deleted — a shared browser must never paint one member's
 *     channels for another);
 *   * it is applied before the shell's first frame whenever it is ready by
 *     then (the auth store notifies synchronously, ahead of React), so a
 *     reload paints the member's real sidebar and last messages instead of
 *     an empty shell, and READY then replaces it whole;
 *   * while signed in, the snapshot is kept fresh (debounced, on idle); on
 *     sign-out every stored snapshot is deleted, and so is every composer
 *     draft;
 *   * a boot that settles SIGNED OUT while a snapshot is stored (the session
 *     died while no tab was open) purges the same way — the in-page sign-out
 *     never saw it happen.
 */

import type { StateStore } from '@cytale/state';
import type { AuthStore } from '../../features/auth/authStore.js';

import {
  applyDeviceSnapshot,
  clearDeviceSnapshots,
  isDeviceCacheEnabled,
  loadDeviceSnapshot,
  startDeviceSnapshotWriter,
  type DeviceSnapshot,
} from './deviceCache.js';
import { readLastUserId, writeLastUserId } from '../lastLocation.js';
import { clearAllDrafts } from '../../features/messages/draftStorage.js';

/** How long the entry waits for the snapshot read before giving up on it. */
export const BOOT_SNAPSHOT_TIMEOUT_MS = 300;

export function initDeviceCache(options: {
  authStore: AuthStore;
  store: StateStore;
  origin: string;
}): () => void {
  const { authStore, store, origin } = options;
  const snapshotUser = readLastUserId();
  // undefined = still loading; null = none (or consumed).
  let snapshot: DeviceSnapshot | null | undefined =
    snapshotUser === null ? null : undefined;
  let signedInAs: string | null = null;
  let stopWriter: (() => void) | null = null;
  // Set once a signed-out purge ran; a later sign-in re-arms it.
  let purged = false;
  // The boot snapshot was purged: a read still in flight must never apply it
  // (not even to a later sign-in — it no longer exists on the device).
  let bootSnapshotDropped = false;

  // Sign-out's device purge: the snapshot records, the last-member marker,
  // and every composer draft (drafts are per member, but none survive a
  // sign-out on a shared device).
  const purgeSignedOut = (): void => {
    bootSnapshotDropped = true;
    snapshot = null;
    writeLastUserId(null);
    void clearDeviceSnapshots();
    clearAllDrafts();
  };

  const settle = (): void => {
    const state = authStore.getState();
    const uid = state.status === 'authenticated' ? (state.currentUser?.id || null) : null;

    if (uid === null) {
      if (state.status !== 'unauthenticated') return; // still restoring

      if (signedInAs !== null) {
        // Signed out after having been signed in: nothing of theirs stays.
        stopWriter?.();
        stopWriter = null;
        signedInAs = null;
        purged = true;
        purgeSignedOut();
      } else if (!purged && snapshotUser !== null) {
        // The boot settled SIGNED OUT while a member's snapshot is on the
        // device: their session died while no tab was open (expired or
        // revoked refresh token, a server-side sign-out elsewhere), so the
        // in-page sign-out path above never ran. Their sidebar and last
        // messages must not wait on this device for whoever signs in next —
        // purge now, exactly as a sign-out would.
        purged = true;
        purgeSignedOut();
      }
      return;
    }

    if (signedInAs !== uid) {
      stopWriter?.();
      signedInAs = uid;
      purged = false;
      writeLastUserId(uid);
      stopWriter = startDeviceSnapshotWriter(store, { userId: uid, origin, enabled: isDeviceCacheEnabled });
    }

    if (snapshot === undefined) return; // still loading — applied when it lands
    if (snapshot !== null) {
      if (snapshotUser === uid) applyDeviceSnapshot(store, snapshot);
      else void clearDeviceSnapshots(); // another member's: never shown, not kept
      snapshot = null;
    }
  };

  if (snapshotUser !== null) {
    void loadDeviceSnapshot({ userId: snapshotUser, origin, timeoutMs: BOOT_SNAPSHOT_TIMEOUT_MS })
      .catch(() => null)
      .then((loaded) => {
        // Landed after a signed-out purge: it is already deleted, keep it gone.
        snapshot = bootSnapshotDropped ? null : loaded;
        settle();
      });
  }

  const unsubscribe = authStore.subscribe(settle);
  settle();
  return () => {
    unsubscribe();
    stopWriter?.();
  };
}
