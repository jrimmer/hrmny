/**
 * @cytale/mobile — the channel message window (plan 004 M6, R8).
 *
 * One hook owns everything the channel list needs from the store and the
 * REST history endpoint; `MessageList` is the thin renderer over it. Splitting
 * them keeps the three behaviours the plan singles out — open at the newest
 * message, prepend older pages without a jump, and the unread divider — in a
 * unit-testable place (no native list, no layout):
 *
 *   * the newest page loads once per channel visit (`before`-less GET) and
 *     merges through `@cytale/state`'s `mergeChannelMessages`, so the window,
 *     cursor, and `hasCompleteHistory` are the shared package's, not a
 *     mobile-only copy;
 *   * older pages load on the list's start-reached signal with
 *     `before=<oldest loaded id>`; the store merge prepends them, and
 *     FlashList's `maintainVisibleContentPosition` (v2 default, keyed by the
 *     stable message id) does the pixel anchoring — the hook keeps the ids
 *     stable and the tests assert the data-level contract;
 *   * the unread divider is captured ONCE per visit from the pre-read
 *     watermark (web's `MessageList` rule, reproduced by `window.ts`), held
 *     while newer rows land, and retired once the reader has scrolled past
 *     it — at which point the local watermark advances so re-opening the
 *     channel does not re-divide. The server-visible half of that read is a
 *     `MESSAGE_ACK` (op 21) through the live session gateway: an open window
 *     is a read view (web's `MessagePane`/`useUnread` rule), so the newest
 *     confirmed id is acked when the window becomes ready and again whenever
 *     a newer one lands — the local `markChannelRead` alone never clears the
 *     server's unread count, which is why the badge used to return on the
 *     next READY/relaunch.
 *
 * `enabled` is the session gate: with no authenticated session there is no
 * history to fetch and the window reports `ready` + empty rather than
 * spinning. That is also what keeps the M5 shell tests (which run with an
 * unauthenticated memory manager) from reaching for the network.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Message } from '@cytale/domain';
import { markChannelRead, mergeChannelMessages, type StateStore } from '@cytale/state';

import { getSessionManager } from '../navigation/session';
import { useStoreSelector } from '../navigation/store';
import { chatOrder, dividerRetired, firstUnreadMessageId, indexOfMessage } from './window';

/** Page size for history loads (the U9 REST default; web's `PAGE_SIZE`). */
export const MESSAGE_PAGE_SIZE = 50;

/** One history page: `before` = older-than cursor, absent = newest page. */
export type LoadMessagePage = (params: { before?: string; limit: number }) => Promise<Message[]>;

/** The gateway's MESSAGE_ACK body (op 21). */
export interface MessageAckPayload {
  channel_id: string;
  message_ids: string[];
}

/**
 * Read-ack seam. MUST be referentially stable (a `useCallback`/module
 * function): a new identity re-runs the ack effect. Defaults to the live
 * session gateway — null while signed out, throwing while mid-reconnect,
 * both of which are best-effort skips (web's `useUnread` contract).
 */
export type SendMessageAck = (payload: MessageAckPayload) => void;

/** True for a confirmed server id; `pending_<nonce>` placeholders are not. */
function isConfirmedId(id: string): boolean {
  return /^\d{1,19}$/.test(id);
}

/** Production ack sender: the session manager's live gateway, when there is one. */
function ackThroughSession(payload: MessageAckPayload): void {
  try {
    getSessionManager()?.getGateway()?.sendMessageAck(payload);
  } catch {
    /* offline mid-reconnect — the next ack (or the server's own read state) reconverges */
  }
}

/** Newest-page load state (the list renders loading / error / ready). */
export type MessageListLoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; error: string };

export interface ChannelWindowOptions {
  /** Channel whose window this is (one window per mounted channel surface). */
  channelId: string;
  /** Store holding the window; `defaultStore` in production. */
  store: StateStore;
  /**
   * Page loader. MUST be referentially stable (a `useCallback` over the api
   * client + channel id): a new identity re-runs the newest-page load.
   */
  loadPage: LoadMessagePage;
  /**
   * False while no authenticated session exists — no fetch, no spinner; the
   * window reports `ready` and whatever the store already holds.
   */
  enabled?: boolean;
  /** Current user id; defaults to the store's `currentUser`. */
  currentUserId?: string | null;
  /** Read-ack sender; defaults to the live session gateway (see `SendMessageAck`). */
  sendAck?: SendMessageAck;
}

export interface ChannelWindow {
  /** Chat order: oldest first, newest last (what the list renders). */
  ordered: Message[];
  /** Newest-page load state. */
  loadState: MessageListLoadState;
  /** True while an older page is in flight (list footer). */
  loadingOlder: boolean;
  /** Older-page failure detail, cleared by the next attempt. */
  olderError: string | null;
  /** Id of the message the "NEW" divider renders above; null = none. */
  dividerId: string | null;
  /** Re-run the newest-page load (the error state's Retry). */
  retry(): void;
  /** Load the next older page (FlashList `onStartReached`). */
  loadOlder(): void;
  /** Viewability sink (FlashList `onViewableItemsChanged`). */
  handleViewableItemsChanged(info: {
    viewableItems: readonly { index: number | null }[];
  }): void;
}

export function useChannelWindow({
  channelId,
  store,
  loadPage,
  enabled = true,
  currentUserId,
  sendAck = ackThroughSession,
}: ChannelWindowOptions): ChannelWindow {
  const slice = useStoreSelector(store, (state) => state.messagesByChannel[channelId]);
  const unread = useStoreSelector(store, (state) => state.unreadByChannel[channelId]);
  const storeUserId = useStoreSelector(store, (state) => state.currentUser?.id ?? null);
  const viewerId = currentUserId === undefined ? storeUserId : currentUserId;

  const ordered = useMemo(() => chatOrder(slice?.items ?? []), [slice]);

  const [loadState, setLoadState] = useState<MessageListLoadState>(() =>
    enabled ? { status: 'loading' } : { status: 'ready' },
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [dividerId, setDividerId] = useState<string | null>(null);

  /** Channel whose divider has been captured for THIS visit. */
  const capturedForRef = useRef<string | null>(null);
  /** True once the divider row has been on screen (the retirement gate). */
  const dividerSeenRef = useRef(false);
  /** One older-page request at a time (FlashList can fire the signal twice). */
  const loadingOlderRef = useRef(false);
  /** Newest confirmed id already acked for THIS visit (dedupes re-renders). */
  const ackedRef = useRef<{ channelId: string; id: string } | null>(null);

  /**
   * Clear the local watermark AND tell the server. The store patch alone is
   * invisible to the server's unread count, so without the ack the badge
   * returns on the next READY/relaunch.
   */
  const acknowledgeRead = useCallback(
    (messageId: string) => {
      markChannelRead(store, channelId, messageId);
      sendAck({ channel_id: channelId, message_ids: [messageId] });
    },
    [channelId, sendAck, store],
  );

  // -- newest page ----------------------------------------------------------
  useEffect(() => {
    if (!enabled) {
      setLoadState({ status: 'ready' });
      return;
    }
    let cancelled = false;
    setLoadState({ status: 'loading' });
    setOlderError(null);
    void (async () => {
      try {
        const items = await loadPage({ limit: MESSAGE_PAGE_SIZE });
        if (cancelled) return;
        mergeChannelMessages(store, channelId, items, {
          isLastPage: items.length < MESSAGE_PAGE_SIZE,
        });
        setLoadState({ status: 'ready' });
      } catch {
        if (!cancelled) setLoadState({ status: 'error', error: 'Could not load messages.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, enabled, loadPage, reloadKey, store]);

  // -- unread divider capture ----------------------------------------------
  // Pinned per visit, exactly like web's `MessageList`: the read ack (and any
  // row that lands while the channel is open) must never move the line, and a
  // channel switch re-captures because the surface remounts this list.
  useEffect(() => {
    if (capturedForRef.current === channelId) return;
    if (ordered.length === 0) return; // newest page still in flight
    capturedForRef.current = channelId;
    dividerSeenRef.current = false;
    setDividerId(firstUnreadMessageId({ ordered, unread, currentUserId: viewerId }));
  }, [channelId, ordered, unread, viewerId]);

  // -- read acknowledgement (gateway) --------------------------------------
  // An open window IS a read view (web's `MessagePane` effect): ack the newest
  // confirmed message once the window is ready, and again whenever a newer one
  // lands, so the server's unread count clears and stays cleared. The divider
  // capture above runs first in the same commit and pins its position from the
  // PRE-read watermark, so acking here never moves the line.
  useEffect(() => {
    if (!enabled) return;
    if (loadState.status !== 'ready') return;
    const newest = ordered[ordered.length - 1];
    if (newest === undefined || !isConfirmedId(newest.id)) return;
    if (ackedRef.current?.channelId === channelId && ackedRef.current.id === newest.id) return;
    ackedRef.current = { channelId, id: newest.id };
    acknowledgeRead(newest.id);
  }, [acknowledgeRead, channelId, enabled, loadState.status, ordered]);

  // -- divider retirement ---------------------------------------------------
  /**
   * The divider's row index, derived once per window/divider change instead of
   * once per viewability callback: the list calls the sink on every scroll
   * frame, and a linear scan of the window per frame is work with a fixed
   * answer (performance pass, P3).
   */
  const dividerIndex = useMemo(() => indexOfMessage(ordered, dividerId), [dividerId, ordered]);

  const handleViewableItemsChanged = useCallback(
    (info: { viewableItems: readonly { index: number | null }[] }) => {
      if (dividerId === null) return;
      const indexes: number[] = [];
      for (const token of info.viewableItems) {
        if (token.index !== null) indexes.push(token.index);
      }
      if (indexes.length === 0) return;
      const first = Math.min(...indexes);
      if (dividerIndex < 0) return; // divider row not in the window (yet)
      if (first <= dividerIndex) {
        dividerSeenRef.current = true; // the reader scrolled up to the line
        return;
      }
      if (!dividerRetired(dividerIndex, first, dividerSeenRef.current)) return;

      setDividerId(null);
      // Advance the local watermark so re-opening the channel does not
      // re-divide, and ack the server. Placeholders (`pending_…`) are never
      // acked — the confirmed id arrives moments later, mirroring web's
      // MessagePane guard.
      const newest = ordered[ordered.length - 1];
      if (newest !== undefined && isConfirmedId(newest.id)) {
        acknowledgeRead(newest.id);
      }
    },
    [acknowledgeRead, dividerId, dividerIndex, ordered],
  );

  // -- older pages ----------------------------------------------------------
  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current) return;
    // The store slice is newest-first: its LAST item is the oldest loaded.
    const current = store.getState().messagesByChannel[channelId];
    if (current === undefined || current.hasCompleteHistory) return;
    const oldest = current.items[current.items.length - 1];
    if (oldest === undefined) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    void (async () => {
      try {
        const items = await loadPage({ before: oldest.id, limit: MESSAGE_PAGE_SIZE });
        mergeChannelMessages(store, channelId, items, {
          isLastPage: items.length < MESSAGE_PAGE_SIZE,
        });
      } catch {
        setOlderError('Could not load older messages. Try again.');
      } finally {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    })();
  }, [channelId, loadPage, store]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return {
    ordered,
    loadState,
    loadingOlder,
    olderError,
    dividerId,
    retry,
    loadOlder,
    handleViewableItemsChanged,
  };
}
