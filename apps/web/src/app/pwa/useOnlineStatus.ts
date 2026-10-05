/**
 * @cytale/web — online/offline reactivity (U25 offline surface).
 *
 * The offline indicator contract (resolved 2026-08-27): offline shows a
 * persistent banner, and attachments/commands disable with an explanatory
 * affordance. Text sends are NOT refused offline: they wait, marked "Waiting
 * for connection…", and go out on their own when the connection returns
 * (send reliability B2, `features/messages/sendAutoRetry.ts`) — which is what
 * the banner's "Messages will sync when the connection returns" promises.
 * This module is the ONE connectivity signal all of that consumes; it tracks
 * `navigator.onLine` via the browser's online/offline events.
 *
 * The state and the listeners are MODULE-level, not per-hook: the message
 * list mounts one of these per visible row, and every row used to attach its
 * own online/offline pair — dozens of listeners flipping the same boolean.
 * One subscription serves every consumer; the last unmount detaches, and the
 * next attach re-reads `navigator.onLine` so a change that happened while
 * nothing was mounted is not stale.
 */

import { useSyncExternalStore } from 'react';

function readNavigator(): boolean {
  return typeof navigator === 'undefined' ? true : navigator.onLine !== false;
}

let online = readNavigator();
const listeners = new Set<() => void>();
let attached = false;

function publish(next: boolean): void {
  if (online === next) return;
  online = next;
  for (const listener of listeners) listener();
}

function handleOnline(): void {
  publish(true);
}

function handleOffline(): void {
  publish(false);
}

function getSnapshot(): boolean {
  return online;
}

function subscribe(listener: () => void): () => void {
  if (typeof window !== 'undefined' && !attached) {
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    attached = true;
    // Re-read on attach: the browser may have gone offline while nothing was
    // subscribed. No notify needed — useSyncExternalStore reads the snapshot
    // immediately after subscribing.
    online = readNavigator();
  }
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && attached && typeof window !== 'undefined') {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      attached = false;
    }
  };
}

/**
 * The same signal outside React (the send auto-retry): `listener` hears every
 * change with the new value. Returns the unsubscribe.
 */
export function subscribeOnlineStatus(listener: (online: boolean) => void): () => void {
  return subscribe(() => listener(online));
}

/** The current value — the subscribed snapshot while anything listens, else the browser's. */
export function isOnline(): boolean {
  return attached ? online : readNavigator();
}

export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
