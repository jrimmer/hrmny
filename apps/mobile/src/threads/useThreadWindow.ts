/**
 * @cytale/mobile — the thread message window (plan 004 M9, R12).
 *
 * The thread twin of `useChannelWindow`: the newest page on open, older pages
 * on the list's start-reached signal, the three load states, and the thread's
 * unread tier cleared once the replies are on screen (opening a thread reads
 * it — web's `useThreads.openThread` rule). The list renders it; the hook owns
 * the data contract so it is testable without a native list.
 *
 * Two differences from the channel window are deliberate:
 *
 *   * rows merge through `mergeThreadMessages` (the store has no thread
 *     merge), which stamps synthetic sequence numbers above the replay cursor;
 *   * there is no unread divider. Web's thread panel has none, and a thread's
 *     unread tier is a badge concern, not an in-panel line.
 *
 * The read acknowledgement is the channel twin's: `markThreadRead` alone is a
 * local patch, so the server's unread count never clears and the badge returns
 * on the next READY/relaunch. The newest confirmed reply is acked through the
 * live gateway (web's `useUnread.markThreadRead` — a thread ack rides the
 * thread id as its `channel_id`), once per newest id, placeholders excluded.
 *
 * `enabled` is the session gate, exactly as on the channel: with no
 * authenticated session there is no history to fetch, so the window reports
 * ready + whatever the store already holds instead of spinning.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Message } from '@cytale/domain';
import { markThreadRead, type StateStore } from '@cytale/state';

import {
  MESSAGE_PAGE_SIZE,
  type MessageAckPayload,
  type MessageListLoadState,
  type SendMessageAck,
} from '../messages/useChannelWindow';
import { chatOrder } from '../messages/window';
import { getSessionManager } from '../navigation/session';
import { useStoreSelector } from '../navigation/store';
import { mergeThreadMessages } from './threadWindow';

/** One thread history page: `before` = older-than cursor, absent = newest. */
export type LoadThreadPage = (params: { before?: string; limit: number }) => Promise<Message[]>;

/** Newest-page load state (the list renders loading / error / ready). */
export type ThreadListLoadState = MessageListLoadState;

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

export interface ThreadWindowOptions {
  /** Thread whose window this is (one window per mounted thread surface). */
  threadId: string;
  /** Store holding the window; `defaultStore` in production. */
  store: StateStore;
  /**
   * Page loader. MUST be referentially stable (a `useCallback` over the api
   * client + thread id): a new identity re-runs the newest-page load.
   */
  loadPage: LoadThreadPage;
  /** False while no authenticated session exists — no fetch, no spinner. */
  enabled?: boolean;
  /** Read-ack sender; defaults to the live session gateway (see `SendMessageAck`). */
  sendAck?: SendMessageAck;
}

export interface ThreadWindow {
  /** Chat order: oldest first, newest last (what the list renders). */
  ordered: Message[];
  /** Newest-page load state. */
  loadState: ThreadListLoadState;
  /** True while an older page is in flight (list footer). */
  loadingOlder: boolean;
  /** Older-page failure detail, cleared by the next attempt. */
  olderError: string | null;
  /** Re-run the newest-page load (the error state's Retry). */
  retry(): void;
  /** Load the next older page (FlashList `onStartReached`). */
  loadOlder(): Promise<void>;
}

export function useThreadWindow({
  threadId,
  store,
  loadPage,
  enabled = true,
  sendAck = ackThroughSession,
}: ThreadWindowOptions): ThreadWindow {
  const slice = useStoreSelector(store, (state) => state.messagesByThread[threadId]);
  const ordered = useMemo(() => chatOrder(slice?.items ?? []), [slice]);

  const [loadState, setLoadState] = useState<ThreadListLoadState>(() =>
    enabled ? { status: 'loading' } : { status: 'ready' },
  );
  const [reloadKey, setReloadKey] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  /** One older-page request at a time (FlashList can fire the signal twice). */
  const loadingOlderRef = useRef(false);
  /** Newest confirmed id already acked for THIS thread (dedupes re-renders). */
  const ackedRef = useRef<{ threadId: string; id: string } | null>(null);

  /**
   * Clear the local watermark AND tell the server. The store patch alone is
   * invisible to the server's unread count, so without the ack the badge
   * returns on the next READY/relaunch.
   */
  const acknowledgeRead = useCallback(
    (messageId: string) => {
      markThreadRead(store, threadId, messageId);
      sendAck({ channel_id: threadId, message_ids: [messageId] });
    },
    [sendAck, store, threadId],
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
        mergeThreadMessages(store, threadId, items, {
          isLastPage: items.length < MESSAGE_PAGE_SIZE,
        });
        setLoadState({ status: 'ready' });
      } catch {
        if (!cancelled) setLoadState({ status: 'error', error: 'Could not load replies.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled, loadPage, reloadKey, store, threadId]);

  // -- read acknowledgement (gateway) --------------------------------------
  // An open thread IS a read view (web's `useThreads.openThread` + `useUnread`
  // rule): ack the newest confirmed reply once the window is ready, and again
  // whenever a newer one lands, so the server's unread count clears and stays
  // cleared. Thread acks ride the thread id as the `channel_id` (the server's
  // MESSAGE_ACK contract for thread tiers, web's `useUnread.markThreadRead`).
  useEffect(() => {
    if (!enabled) return;
    if (loadState.status !== 'ready') return;
    const newest = ordered[ordered.length - 1];
    if (newest === undefined || !isConfirmedId(newest.id)) return;
    if (ackedRef.current?.threadId === threadId && ackedRef.current.id === newest.id) return;
    ackedRef.current = { threadId, id: newest.id };
    acknowledgeRead(newest.id);
  }, [acknowledgeRead, enabled, loadState.status, ordered, threadId]);

  // -- older pages ----------------------------------------------------------
  const loadOlder = useCallback(async (): Promise<void> => {
    if (loadingOlderRef.current) return;
    // The store slice is newest-first: its LAST item is the oldest loaded.
    const current = store.getState().messagesByThread[threadId];
    if (current === undefined || current.hasCompleteHistory) return;
    const oldest = current.items[current.items.length - 1];
    if (oldest === undefined) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const items = await loadPage({ before: oldest.id, limit: MESSAGE_PAGE_SIZE });
      mergeThreadMessages(store, threadId, items, {
        isLastPage: items.length < MESSAGE_PAGE_SIZE,
      });
    } catch {
      setOlderError('Could not load older replies. Try again.');
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [loadPage, store, threadId]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return { ordered, loadState, loadingOlder, olderError, retry, loadOlder };
}
