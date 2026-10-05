/**
 * @cytale/web — unread state hook (U23).
 *
 * Derives per-channel/thread unread badge counts from the U17 unread store
 * (last_read_id, mention_count) and clears them on channel/thread open by
 * sending MESSAGE_ACK through the gateway client (REST fallback is the
 * server's `POST /channels/{id}/ack`; the gateway command is the realtime
 * path). The store and gateway are injectable for tests.
 */

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { GatewayClient } from '@cytale/gateway-client';
import type { Snowflake } from '@cytale/protocol';
import {
  channelMentionCount,
  channelUnreadCount,
  defaultStore,
  deriveChannelBadge,
  markChannelRead as storeMarkChannelRead,
  markThreadRead as storeMarkThreadRead,
  type StateState,
  type StateStore,
} from '@cytale/state';

import { session } from '../auth/session.js';

export interface UnreadBadge {
  /** Messages newer than last_read_id, excluding my own. */
  unread: number;
  /** Subset of unread that mention me. */
  mentions: number;
}

export interface UseUnread {
  /** Unread badge for a channel (0/0 when none). */
  channelBadge(channelId: string): UnreadBadge;
  /** Unread badge for a thread (0/0 when none). */
  threadBadge(threadId: string): UnreadBadge;
  /** Mark a channel read (MESSAGE_ACK) and clear the store badge. */
  markChannelRead(channelId: string, messageId: string): void;
  /** Mark a thread read (MESSAGE_ACK) and clear the store badge. */
  markThreadRead(threadId: string, messageId: string): void;
}

/**
 * The slice of store state a badge can possibly depend on: the two unread
 * maps, the channel message slices `deriveChannelBadge` scans, and the
 * current user (author exclusion). WEB-3: the hook used to hand
 * `useSyncExternalStore` the WHOLE store snapshot, so every gateway event —
 * presence flips, seq bumps, pending-send churn — re-rendered every badge
 * consumer. Presence, typing, session and pending events leave all four
 * references below untouched and re-render nothing; every event that CAN
 * move a badge (MESSAGE_CREATE accrual, MESSAGE_ACK, READ_STATE_SYNC, any
 * channel-slice write, sign-in) replaces at least one of them.
 *
 * `getSnapshot` must return a reference-stable value between store changes
 * or React spins, so the snapshot object itself is cached per store and
 * rebuilt only when one of the four references actually moved.
 */
interface UnreadSnapshot {
  currentUser: StateState['currentUser'];
  unreadByChannel: StateState['unreadByChannel'];
  unreadByThread: StateState['unreadByThread'];
  messagesByChannel: StateState['messagesByChannel'];
}

const snapshotCache = new WeakMap<StateStore, UnreadSnapshot>();

function unreadSnapshot(store: StateStore): UnreadSnapshot {
  const s = store.getState();
  const cached = snapshotCache.get(store);
  if (
    cached !== undefined &&
    cached.currentUser === s.currentUser &&
    cached.unreadByChannel === s.unreadByChannel &&
    cached.unreadByThread === s.unreadByThread &&
    cached.messagesByChannel === s.messagesByChannel
  ) {
    return cached;
  }
  const next: UnreadSnapshot = {
    currentUser: s.currentUser,
    unreadByChannel: s.unreadByChannel,
    unreadByThread: s.unreadByThread,
    messagesByChannel: s.messagesByChannel,
  };
  snapshotCache.set(store, next);
  return next;
}

/** Stable subscribe per store (lane D #17): an inline one resubscribed every render. */
const subscribeCache = new WeakMap<StateStore, (cb: () => void) => () => void>();

function subscribeTo(store: StateStore): (cb: () => void) => () => void {
  let sub = subscribeCache.get(store);
  if (sub === undefined) {
    sub = (cb) => store.subscribe(cb);
    subscribeCache.set(store, sub);
  }
  return sub;
}

/**
 * Reactive unread badges. `store` and `gateway` are injectable for tests;
 * the app uses the module default store and the live session gateway.
 */
export function useUnread(store: StateStore = defaultStore, gateway?: GatewayClient | null): UseUnread {
  useSyncExternalStore(
    subscribeTo(store),
    () => unreadSnapshot(store),
    () => unreadSnapshot(store),
  );

  const { markChannelRead, markThreadRead } = useUnreadActions(store, gateway);

  const channelBadge = useCallback(
    (channelId: string): UnreadBadge => {
      const state = store.getState();
      const unread = state.unreadByChannel[channelId];
      return {
        unread: deriveChannelBadge(store, channelId),
        // Lane D #2: server snapshot + live accrual — survives a reload.
        mentions: channelMentionCount(unread),
      };
    },
    [store],
  );

  const threadBadge = useCallback(
    (threadId: string): UnreadBadge => {
      const state = store.getState();
      const unread = state.unreadByThread[threadId];
      return {
        unread: channelUnreadCount(unread),
        mentions: channelMentionCount(unread),
      };
    },
    [store],
  );

  return { channelBadge, threadBadge, markChannelRead, markThreadRead };
}

/**
 * The read ACTIONS alone, with no store subscription (lane D #17): a caller
 * that only acks (the open message pane) must not re-render for every badge
 * change in the app, which is what calling `useUnread` for its
 * `markChannelRead` did.
 */
export function useUnreadActions(
  store: StateStore = defaultStore,
  gateway?: GatewayClient | null,
): Pick<UseUnread, 'markChannelRead' | 'markThreadRead'> {
  const gw = gateway === undefined ? session.getGateway() : gateway;

  const markChannelRead = useCallback(
    (channelId: string, messageId: string) => {
      storeMarkChannelRead(store, channelId as Snowflake, messageId as Snowflake);
      // Best-effort while disconnected (mid-reconnect the command throws;
      // the REST fallback and the next ack reconverge read state).
      try {
        gw?.sendMessageAck({ channel_id: channelId, message_ids: [messageId] });
      } catch {
        /* offline — converge on reconnect */
      }
    },
    [store, gw],
  );

  const markThreadRead = useCallback(
    (threadId: string, messageId: string) => {
      storeMarkThreadRead(store, threadId as Snowflake, messageId as Snowflake);
      // Thread ACK rides the parent channel's MESSAGE_ACK (server contract);
      // the store clears the thread tier directly. Best-effort (offline mid-
      // reconnect throws; next ack reconverges).
      try {
        gw?.sendMessageAck({ channel_id: threadId, message_ids: [messageId] });
      } catch {
        /* offline — converge on reconnect */
      }
    },
    [store, gw],
  );

  return useMemo(() => ({ markChannelRead, markThreadRead }), [markChannelRead, markThreadRead]);
}

// ---------------------------------------------------------------------------
// The open pane's ack cadence (lane D #20)
// ---------------------------------------------------------------------------

/**
 * Trailing debounce for acks of messages that land while a channel is open.
 * The pane used to ack EVERY new message — a busy channel sent a MESSAGE_ACK
 * (and the server persisted and fanned one back) per message per open client.
 * Within this window only the newest id is acked.
 */
export const ACK_DEBOUNCE_MS = 750;

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/** Snowflakes only: an optimistic placeholder (`pending_<nonce>`) is never acked. */
function ackable(id: string | null | undefined): id is string {
  return typeof id === 'string' && /^\d{1,19}$/.test(id);
}

/**
 * Ack an open channel as its newest message moves (lane D #20):
 *
 *   * opening a channel (a new `channelId`) acks at once when the tab is
 *     visible — the badge the member just clicked clears immediately;
 *   * newer messages while it stays open are acked on a TRAILING debounce of
 *     `ACK_DEBOUNCE_MS` (the newest id wins);
 *   * nothing is acked while the tab is hidden — a channel left open in a
 *     background tab is not being read. The pending ack is flushed the moment
 *     the tab becomes visible again;
 *   * leaving the channel (switch or unmount) flushes a pending ack if the tab
 *     is visible (the member saw those rows before leaving).
 */
export function useDebouncedChannelAck(
  channelId: string | null,
  newestId: string | null | undefined,
  markChannelRead: (channelId: string, messageId: string) => void,
): void {
  const pending = useRef<{ channelId: string; messageId: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visitRef = useRef<string | null>(null);
  const markRef = useRef(markChannelRead);
  markRef.current = markChannelRead;

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const p = pending.current;
    if (p === null || !tabVisible()) return;
    pending.current = null;
    markRef.current(p.channelId, p.messageId);
  }, []);

  useEffect(() => {
    if (channelId === null || !ackable(newestId)) return;
    const openingVisit = visitRef.current !== channelId;
    visitRef.current = channelId;
    pending.current = { channelId, messageId: newestId };
    if (openingVisit) {
      flush();
      return;
    }
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(flush, ACK_DEBOUNCE_MS);
  }, [channelId, newestId, flush]);

  // A channel switch: the previous channel's pending ack goes out now (the
  // member read it), before the new visit starts.
  useEffect(() => {
    return () => {
      if (pending.current !== null && pending.current.channelId === channelId) flush();
    };
  }, [channelId, flush]);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = () => {
      if (tabVisible()) flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [flush]);
}
