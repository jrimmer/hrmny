/**
 * @cytale/web — thread state hook (U22).
 *
 * Owns the thread side-panel UI state: which thread is open, follow/unfollow
 * (notify=true/false), unread tiers (notified orange vs unread gray), and
 * loading thread replies into the U17 store's `messagesByThread` slice.
 *
 * Thread events (THREAD_CREATE/UPDATE/DELETE/MEMBER_ADD/REMOVE/MESSAGE_CREATE)
 * are applied to the store by the auth session's gateway `onAny` hook (the
 * same path that applies channel events), so this hook just reads the store
 * through selectors — no separate dispatch wiring here.
 *
 * The open/close panel state is React-local (the store has no such field);
 * the store is injectable for tests, the app uses the module default.
 */

import { useCallback, useState } from 'react';

import type { Message, Thread } from '@cytale/domain';
import { compareSnowflakes, parsePermalinkPath } from '@cytale/domain';
import {
  channelUnreadCount,
  defaultStore,
  markThreadRead,
  mergeThreadMessages,
  type StateStore,
} from '@cytale/state';

import { shallowEqual, useStoreSelector } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';

export interface UseThreads {
  /** The currently open thread id, or null when the panel is closed. */
  openThreadId: string | null;
  /** Open the thread side-panel for a thread (and clear its unread). */
  openThread(threadId: string): void;
  /** Close the thread side-panel. */
  closeThread(): void;
  /** Follow a thread (notify=true). */
  follow(threadId: string): Promise<void>;
  /** Unfollow a thread (notify=false). */
  unfollow(threadId: string): Promise<void>;
  /** Load the thread's replies into the store (newest-first). */
  loadReplies(threadId: string): Promise<void>;
  /** Mark the thread unread (clears the read state server-side + locally). */
  markUnread(threadId: string): Promise<void>;
  /** Leave the thread: membership + local roster/read state drop. */
  leave(threadId: string): Promise<void>;
  /**
   * Archive (or unarchive) the thread (#109) — roster-hiding, not an access
   * change: the replies stay and the thread stays readable by id.
   */
  archive(threadId: string, archived: boolean): Promise<void>;
  /**
   * The first reply newer than the watermark captured when this thread was
   * OPENED, or null when there was nothing unread. See `unreadAtOpen`.
   */
  firstUnreadId(threadId: string): string | null;
  /** Newest-first replies of a thread (empty when none loaded). */
  replies(threadId: string): Message[];
  /** The thread's metadata, or null when unknown. */
  thread(threadId: string): Thread | null;
  /** True when the current user follows the thread with notify=true. */
  isNotified(threadId: string): boolean;
  /** Unread count for a thread (0 when read). */
  unreadCount(threadId: string): number;
  /**
   * Parse a nested-message deep link into {workspaceId, channelId, messageId}.
   *
   * One grammar, two readers (#114): this was a regex of its own that accepted
   * a different id charset from `tauri/deepLink.ts` and could drift from it
   * silently. It now delegates to `@cytale/domain`'s `parsePermalinkPath` —
   * the same function the OS boundary and the hash permalink route read
   * through. A DM address (no workspace segment) is still null here: this seam
   * feeds workspace-scoped jumps, and a DM has no workspace to select.
   */
  parseDeepLink(path: string): { workspaceId: string; channelId: string; messageId: string } | null;
}

/** Replies per REST page (the server's default page). */
const REPLY_PAGE_SIZE = 50;

/** Stable empty reply list: a fresh `[]` would re-identify every read. */
const NO_REPLIES: Message[] = [];

export function useThreads(store: StateStore = defaultStore): UseThreads {
  const [openThreadId, setOpenThreadId] = useState<string | null>(null);

  // The three slices this hook reads (lane D #17, #15) — it used to take the
  // WHOLE store, so a presence tick or a channel message re-rendered every
  // thread surface (the Home rail, the side panel and its transcript).
  const snapshot = useStoreSelector(
    store,
    (s) => ({
      messagesByThread: s.messagesByThread,
      threadsById: s.threadsById,
      unreadByThread: s.unreadByThread,
    }),
    shallowEqual,
  );
  const { messagesByThread, threadsById, unreadByThread } = snapshot;

  /*
   * The unread slice AS IT WAS when the thread was opened (#104).
   *
   * A channel captures its first-unread position in the message list, because
   * the list and the pane's ack effect share a tree and the child flushes first.
   * A thread cannot: the HOST calls openThread and the panel mounts afterwards,
   * so by the time anything renders the read-mark below has already cleared the
   * anchor. The capture therefore has to happen here, in the same function that
   * invalidates it — same semantics (taken once per open, held for the visit),
   * one level up the tree.
   */
  const [unreadAtOpen, setUnreadAtOpen] = useState<
    Record<string, { lastReadId: string | null; unreadCount: number }>
  >({});

  const openThread = useCallback(
    (threadId: string) => {
      const before = store.getState().unreadByThread[threadId];
      setUnreadAtOpen((m) => ({
        ...m,
        [threadId]: {
          lastReadId: before?.last_read_id ?? null,
          unreadCount: channelUnreadCount(before),
        },
      }));
      setOpenThreadId(threadId);
      // Opening clears the thread's unread tier (badge clears on open).
      const slice = store.getState().messagesByThread[threadId];
      const last = slice?.items[0];
      if (last) markThreadRead(store, threadId, last.id);
    },
    [store],
  );

  const closeThread = useCallback(() => {
    setOpenThreadId(null);
  }, []);

  const follow = useCallback(
    async (threadId: string) => {
      await api.followThread(threadId);
      store.setState((s) => {
        const t = s.threadsById[threadId];
        if (!t) return {};
        return {
          threadsById: {
            ...s.threadsById,
            [threadId]: {
              ...t,
              member_state: { notify: true, last_read_id: t.member_state?.last_read_id ?? null },
            },
          },
        };
      });
    },
    [store],
  );

  const unfollow = useCallback(
    async (threadId: string) => {
      await api.unfollowThread(threadId);
      store.setState((s) => {
        const t = s.threadsById[threadId];
        if (!t) return {};
        return {
          threadsById: {
            ...s.threadsById,
            [threadId]: {
              ...t,
              member_state: { notify: false, last_read_id: t.member_state?.last_read_id ?? null },
            },
          },
        };
      });
    },
    [store],
  );

  const markUnread = useCallback(
    async (threadId: string) => {
      await api.markThreadUnread(threadId);
      store.setState((s) => {
        const t = s.threadsById[threadId];
        // Read state clears; the local unread rollup flips to "everything
        // new" so the roster badge lights without waiting for a refetch.
        const items = s.messagesByThread[threadId]?.items ?? [];
        const mine = s.currentUser?.id ?? null;
        const others = items.filter((m) => m.author_id !== mine);
        return {
          threadsById: t
            ? {
                ...s.threadsById,
                [threadId]: {
                  ...t,
                  member_state: { notify: t.member_state?.notify ?? false, last_read_id: null },
                },
              }
            : s.threadsById,
          unreadByThread: {
            ...s.unreadByThread,
            [threadId]: {
              last_read_id: null,
              unread_count: others.length,
              mention_count: others.filter((m) => m.content.includes(`<@${mine}>`)).length,
            },
          },
        };
      });
    },
    [store],
  );

  const leave = useCallback(
    async (threadId: string) => {
      await api.leaveThread(threadId);
      store.setState((s) => {
        const { [threadId]: _gone, ...threadsById } = s.threadsById;
        const { [threadId]: _unread, ...unreadByThread } = s.unreadByThread;
        const threadIdsByChannel = Object.fromEntries(
          Object.entries(s.threadIdsByChannel).map(([ch, ids]) => [
            ch,
            ids.filter((id) => id !== threadId),
          ]),
        );
        return { threadsById, unreadByThread, threadIdsByChannel };
      });
    },
    [store],
  );

  const archive = useCallback(
    async (threadId: string, archived: boolean) => {
      const updated = await api.updateThread(threadId, { archived });
      // Local write for the caller's own click; the server's THREAD_UPDATE
      // reaches every OTHER client (and this one) through the gateway, so the
      // two must agree — they do, because both write the same field.
      store.setState((s) => {
        const t = s.threadsById[threadId];
        if (!t) return {};
        return {
          threadsById: { ...s.threadsById, [threadId]: { ...t, archived: updated.archived ?? archived } },
        };
      });
    },
    [store],
  );

  const loadReplies = useCallback(
    async (threadId: string) => {
      const messages = await api.getThreadMessages(threadId, { limit: REPLY_PAGE_SIZE });
      // ONE batched write of WHOLE rows (#15). This used to replay the page as
      // fifty synthetic ThreadMessageCreate dispatches — fifty store writes —
      // each rebuilding a stripped row (no attachments, reactions or reply
      // reference). The merge also moves the thread's summary (#106) by
      // exactly the replies it had not counted, as the replay did.
      mergeThreadMessages(store, threadId, messages, {
        direction: 'newest',
        isLastPage: messages.length < REPLY_PAGE_SIZE,
      });
    },
    [store],
  );

  const firstUnreadId = useCallback(
    (threadId: string): string | null => {
      const held = unreadAtOpen[threadId];
      if (!held || held.unreadCount === 0) return null;
      const items = messagesByThread[threadId]?.items ?? [];
      if (items.length === 0) return null;
      // The store is newest-first; the WINDOW is chronological, and so is the
      // question. A null watermark means nothing was read, so the oldest loaded
      // reply is the first unread one.
      const chronological = [...items].reverse();
      if (held.lastReadId === null) return chronological[0]?.id ?? null;
      return (
        chronological.find((m) => compareSnowflakes(m.id, held.lastReadId as string) > 0)?.id ??
        null
      );
    },
    [unreadAtOpen, messagesByThread],
  );

  const replies = useCallback(
    (threadId: string): Message[] => messagesByThread[threadId]?.items ?? NO_REPLIES,
    [messagesByThread],
  );

  const thread = useCallback(
    (threadId: string): Thread | null => threadsById[threadId] ?? null,
    [threadsById],
  );

  const isNotified = useCallback(
    (threadId: string): boolean => threadsById[threadId]?.member_state?.notify === true,
    [threadsById],
  );

  const unreadCount = useCallback(
    // Lane D #2: the shared badge rule (server snapshot + live accrual).
    (threadId: string): number => channelUnreadCount(unreadByThread[threadId]),
    [unreadByThread],
  );

  const parseDeepLink = useCallback((path: string) => {
    const target = parsePermalinkPath(path);
    if (
      target === null ||
      target.kind !== 'message' ||
      target.workspaceId === undefined ||
      target.channelId === undefined ||
      target.messageId === undefined
    ) {
      return null;
    }
    return {
      workspaceId: target.workspaceId,
      channelId: target.channelId,
      messageId: target.messageId,
    };
  }, []);

  return {
    openThreadId,
    openThread,
    firstUnreadId,
    closeThread,
    follow,
    unfollow,
    loadReplies,
    markUnread,
    leave,
    archive,
    replies,
    thread,
    isNotified,
    unreadCount,
    parseDeepLink,
  };
}
