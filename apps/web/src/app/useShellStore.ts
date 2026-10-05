/**
 * @cytale/web — slice-scoped store subscriptions for the application shell.
 *
 * The shell used to subscribe to the WHOLE store (#137, app-level finding 1):
 *
 *     useEffect(() => defaultStore.subscribe(() => setStore(defaultStore.getState())), []);
 *
 * `getState()` returns a new object for any write, so a message in any
 * channel, a presence flip, an unread ack or a call event re-rendered the
 * 2,000-line `AuthenticatedApp` — and with it `AppShell`, `MessagePane`,
 * `MessageList`, both sidebars and the context rail.
 *
 * The two hooks here are the fix, and they are the shape the rest of the
 * codebase already uses (`MessageList`'s `useChannelSnapshot`, `useInbox`'s
 * `currentUserId`/`sessionEpoch` reads): a subscription that re-renders only
 * when the slices it reads are re-identified. Whole-store variants of it are
 * the bug, not the pattern — `ThreadSidePanel`'s `useStoreSnapshot` was
 * deleted for exactly that reason, and `useInbox`'s `watermarks` selector
 * (which IS a whole-store subscription) is why the shell no longer calls
 * `useInbox` from its own body.
 *
 * ## What this DOES and does NOT filter (measured, not assumed)
 *
 * The gate is on slice RECORDS, so it only helps for slices the storm does not
 * re-identify. As of 2026-09-20 it demonstrably filters: thread traffic,
 * edits/deletes in other channels, reconcile bookkeeping, optimistic sends and
 * `mediaEnabled`.
 *
 * It does NOT filter a live message, and the claim that it did was wrong:
 * `reconcile.ts:463-473` rewrites BOTH `lastMessageIdByChannel` and
 * `unreadByChannel` on every incoming `MessageCreate` from another author, and
 * both are gated here because the shell's JSX genuinely reads them. A presence
 * flip (`presenceByUser`) and a call event (`callByChannel`, `dmCallByChannel`,
 * `callRingByChannel`) are likewise inside the gate.
 *
 * Removing those from the gate is a real, unfinished follow-up, and it is NOT a
 * one-line change: the readers are the shell's own JSX and the four consumers
 * it hands the snapshot to (`HomeSidebar`, `HomeDashboard`, `ChannelSidebar` via
 * `sidebarStore`, `useChannelCallGate`). Each needs its own keyed subscription
 * — the `useThreadParentMessage` pattern below — before its slice can leave
 * this list. See the hardening plan's residual for batch 1 item 1.1.
 *
 * No new store, no new state library, no new global — one module-local gate
 * over slices of the store the app already has.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import type { Message } from '@cytale/domain';
import type { StateState, StateStore } from '@cytale/state';

/**
 * The store slices the SHELL's render actually depends on.
 *
 * Exhaustive by construction: every `store.<key>` `AuthenticatedApp` or its
 * store-consuming children (HomeSidebar/HomeDashboard, ChannelSidebar via
 * `sidebarStore`, `useChannelCallGate`) reads is on this list. It must grow
 * with the subtree — a slice left off is not merely quieter, it is STALE in
 * the snapshot those children receive (see `useShellStore`).
 *
 * Deliberately absent, and why:
 *
 *   * `messagesByChannel` — re-identified by every message in every channel,
 *     which IS the storm. The shell reads exactly one row out of it (the open
 *     thread's parent), and that read has its own subscription
 *     (`useThreadParentMessage`).
 *   * `messagesByThread`, `unreadByThread` — thread chatter, read through
 *     their own subscriptions (`useThreads`, `useCallLog`), never off this
 *     snapshot.
 *   * `lastSeq`, `pendingByNonce`, `failedByNonce`, `nonceByMessageId` — the
 *     reconcile/optimistic bookkeeping; nothing in this subtree reads them off
 *     the snapshot.
 *   * `mediaEnabled` — read reactively through `useMediaEnabled(store)`, which
 *     subscribes itself.
 *   * `callLogThreadIdByChannel` — identifies which channels' standing threads
 *     are call logs; read by the call-log surfaces (`useCallLog`, the timeline
 *     exclusion), never by this subtree.
 */
export const SHELL_SLICE_KEYS = [
  'currentUser',
  'sessionStatus',
  'sessionEpoch',
  'rosterSource',
  'workspaces',
  'channels',
  'threadsById',
  'threadIdsByChannel',
  'membersById',
  'memberIdsByWorkspace',
  'callByChannel',
  'dmCallByChannel',
  'callRingByChannel',
] as const satisfies readonly (keyof StateState)[];
// Lane D #17 — `lastMessageIdByChannel`, `unreadByChannel` and
// `presenceByUser` LEFT this list: the surfaces that show recency, badges and
// presence (the sidebars, Home, the rail, the member directory) subscribe to
// those slices themselves (AuthenticatedApp's `Live*` leaves, and the per-key
// hooks in `useStoreSelector.ts`), so a live message or a presence tick no
// longer re-renders the shell. The follow-up the note above describes is done.

/**
 * A thread's ACTIVITY fields: what a reply bumps (#106). The shell's readers
 * (Home's recent threads) render a thread's name and archived state, never
 * these; the surfaces that do show counts and recency (`MessageList`'s seed
 * indicator, `ThreadsListPanel`) read through their own subscriptions.
 */
const THREAD_ACTIVITY_FIELDS: ReadonlySet<string> = new Set(['message_count', 'latest_reply_at']);

/**
 * `threadsById` equal for the shell: the same threads, each either the same
 * record or differing only in its activity fields. A reply in a channel the
 * shell is not showing therefore does not re-render it (plan 1.1).
 */
function threadsEqualForShell(a: StateState['threadsById'], b: StateState['threadsById']): boolean {
  if (a === b) return true;
  const ids = Object.keys(a);
  if (ids.length !== Object.keys(b).length) return false;
  for (const id of ids) {
    const x = a[id];
    const y = b[id];
    if (x === y) continue;
    if (!x || !y) return false;
    for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (THREAD_ACTIVITY_FIELDS.has(field)) continue;
      if ((x as unknown as Record<string, unknown>)[field] !== (y as unknown as Record<string, unknown>)[field]) {
        return false;
      }
    }
  }
  return true;
}

/** True when every slice the shell reads is the same record in `a` and `b`. */
export function shellSlicesEqual(a: StateState, b: StateState): boolean {
  for (const key of SHELL_SLICE_KEYS) {
    if (a[key] === b[key]) continue;
    if (key === 'threadsById' && threadsEqualForShell(a.threadsById, b.threadsById)) continue;
    return false;
  }
  return true;
}

/**
 * The shell's store snapshot, re-rendering it only for the slices it reads.
 *
 * The value handed back is a REAL `StateState` — the one the store held at the
 * last gate-tripping write — so every consumer keeps exactly the identity
 * semantics it had before: stable across unrelated writes, new when something
 * it reads changed. Nothing is copied or projected, so nothing can go stale
 * behind a memo.
 */
export function useShellStore(store: StateStore): StateState {
  const [snapshot, setSnapshot] = useState<StateState>(() => store.getState());
  const latest = useRef(snapshot);

  useEffect(() => {
    const publish = () => {
      const next = store.getState();
      if (shellSlicesEqual(latest.current, next)) return;
      latest.current = next;
      setSnapshot(next);
    };
    const unsub = store.subscribe(publish);
    // A write can land between the render above and this subscription; the
    // immediate read picks it up instead of waiting for the next event.
    publish();
    return unsub;
  }, [store]);

  return snapshot;
}

/**
 * The open thread's PARENT message, subscribed on its own.
 *
 * This is the shell's only read out of `messagesByChannel`, and the reason
 * that slice cannot gate the shell: it is re-identified by a message in ANY
 * channel. Keyed on the open thread, this subscription re-reads exactly when
 * that one channel's slice changes — and nothing else about the shell moves.
 *
 * `getSnapshot` re-reads the store on every render (React does), so switching
 * threads yields the new parent in the SAME commit rather than one effect
 * later; it returns the store's own row object (or `null`), which is a stable
 * identity between writes.
 */
export function useThreadParentMessage(
  store: StateStore,
  thread: { channelId: string; parentMessageId: string | null } | null,
): Message | null {
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
  const getSnapshot = useCallback(() => {
    if (thread === null || thread.parentMessageId === null) return null;
    return (
      store.getState().messagesByChannel[thread.channelId]?.items.find(
        (m) => m.id === thread.parentMessageId,
      ) ?? null
    );
  }, [store, thread]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
