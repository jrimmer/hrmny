/**
 * @cytale/mobile — the mention inbox hook (#117 port).
 *
 * Mirrors apps/web/src/features/home/useInbox.ts on the mobile session: the
 * server backlog (fetched on boot and every fresh gateway session), the live
 * wire (MessageCreate / ThreadMessageCreate accrual), the one-read-state
 * prune, and done/sweep with optimistic dismiss + rollback. The web hook's
 * docs are authoritative; the semantics here are byte-equal.
 */
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { messageAddressesMe, type StateStore } from '@cytale/state';

import { defaultStore } from '../navigation/store';
import { getSessionManager, useSession } from '../navigation/session';

import {
  dismissInboxItem,
  fetchInbox,
  mentionsUser,
  mergeInbox,
  openInbox,
  sweepInbox,
  type InboxApiError,
  type InboxItem,
} from './inbox';

export type InboxStatus = 'idle' | 'loading' | 'ready' | 'error';

export const INBOX_PAGE_LIMIT = 50;
const EXCERPT_CHARS = 240;

export interface UseInbox {
  items: InboxItem[];
  status: InboxStatus;
  error: string | null;
  actionError: string | null;
  busy: boolean;
  dismiss(messageId: string): void;
  sweep(): void;
  retry(): void;
}

interface InboxState {
  server: InboxItem[];
  local: InboxItem[];
  dismissed: Set<string>;
  status: InboxStatus;
  error: string | null;
  actionError: string | null;
  busy: boolean;
}

const INITIAL: InboxState = {
  server: [],
  local: [],
  dismissed: new Set(),
  status: 'loading',
  error: null,
  actionError: null,
  busy: false,
};

export function useInbox(store: StateStore = defaultStore): UseInbox {
  const [state, setState] = useState<InboxState>(INITIAL);
  const [retryNonce, setRetryNonce] = useState(0);

  const session = useSession();
  const currentUserId = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState().currentUser?.id ?? null,
    () => null,
  );
  // A fresh gateway session (READY) re-fetches: the reload/reconnect path.
  const sessionEpoch = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState().sessionEpoch,
    () => 0,
  );

  const resolvedToken = useMemo(() => session.authStore.getState().accessToken ?? null, [session, sessionEpoch]);

  // The hydrate: boot, every fresh session, and an explicit retry.
  const refresh = useCallback(async () => {
    if (!resolvedToken) {
      setState((s) => ({ ...s, status: 'idle', error: null }));
      return;
    }
    setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading', error: null }));
    try {
      const page = await fetchInbox({ token: resolvedToken, limit: INBOX_PAGE_LIMIT });
      setState((s) => ({
        ...s,
        // MERGE — never replace (a live accrual must survive the snapshot).
        server: mergeInbox(s.local, page.items),
        local: [],
        status: 'ready',
        error: null,
      }));
    } catch (err) {
      const apiErr = err as InboxApiError;
      setState((s) => ({
        ...s,
        status: 'error',
        error: apiErr?.message ?? 'Could not load your mentions.',
      }));
    }
  }, [resolvedToken]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionEpoch, retryNonce]);

  // The live wire: a mention that lands while Home is open.
  useEffect(() => {
    const gw = getSessionManager()?.getGateway() ?? null;
    if (!gw || currentUserId === null) return;

    const accrue = (payload: unknown) => {
      const message = payload as {
        id?: string;
        channel_id?: string;
        thread_id?: string | null;
        author_id?: string;
        content?: string;
        created_at?: string | null;
      };
      if (!message.id || !message.channel_id || !message.author_id) return;
      if (message.author_id === currentUserId) return;
      // A direct mention, or (2026-09-27) an @everyone/@here the member has
      // not suppressed for the workspace — web's rule and the server's.
      const direct = mentionsUser(message.content, currentUserId);
      const addressed =
        direct ||
        messageAddressesMe(store.getState(), {
          channel_id: message.channel_id,
          author_id: message.author_id,
          content: message.content ?? '',
        });
      if (!addressed) return;

      // DMs are never inbox rows (the whole DM is addressed to you); an
      // unknown channel is skipped — the hydrate covers it.
      const channel = store.getState().channels[message.channel_id];
      if (!channel || channel.type === 'dm') return;

      const item: InboxItem = {
        message_id: message.id,
        channel_id: message.channel_id,
        thread_id: message.thread_id ?? null,
        author_id: message.author_id,
        author_username: store.getState().membersById[message.author_id]?.username ?? null,
        kind: direct ? 'mention' : 'broadcast',
        excerpt: (message.content ?? '').slice(0, EXCERPT_CHARS),
        created_at: message.created_at ?? null,
      };
      setState((s) =>
        s.dismissed.has(item.message_id) ? s : { ...s, local: mergeInbox([item], s.local) },
      );
    };

    const unsubs = [gw.on('MessageCreate', accrue), gw.on('ThreadMessageCreate', accrue)];
    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [currentUserId, store, sessionEpoch]);

  // The view: merged backlog minus everything already answered or dismissed.
  const watermarks = useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getState(),
    () => store.getState(),
  );

  const items = useMemo(
    () =>
      openInbox(
        mergeInbox(state.local, state.server),
        { channel: watermarks.unreadByChannel, thread: watermarks.unreadByThread },
        state.dismissed,
      ),
    [state.local, state.server, state.dismissed, watermarks],
  );

  const dismiss = useCallback(
    (messageId: string) => {
      setState((s) => ({
        ...s,
        dismissed: new Set(s.dismissed).add(messageId),
        busy: true,
        actionError: null,
      }));
      void (async () => {
        try {
          await dismissInboxItem(messageId, resolvedToken ?? undefined);
          setState((s) => ({ ...s, busy: false }));
        } catch {
          // Roll back so a failed done does not hide the row for good.
          setState((s) => {
            const dismissed = new Set(s.dismissed);
            dismissed.delete(messageId);
            return { ...s, dismissed, busy: false, actionError: 'Could not mark that done.' };
          });
        }
      })();
    },
    [resolvedToken],
  );

  const sweep = useCallback(() => {
    const targets = items.map((item) => item.message_id);
    if (targets.length === 0) return;
    setState((s) => ({
      ...s,
      dismissed: new Set([...s.dismissed, ...targets]),
      busy: true,
      actionError: null,
    }));
    void (async () => {
      try {
        await sweepInbox(resolvedToken ?? undefined);
        setState((s) => ({ ...s, busy: false }));
      } catch {
        setState((s) => {
          const dismissed = new Set(s.dismissed);
          for (const id of targets) dismissed.delete(id);
          return { ...s, dismissed, busy: false, actionError: 'Could not clear your mentions.' };
        });
      }
    })();
  }, [items, resolvedToken]);

  const retry = useCallback(() => {
    setState((s) => ({ ...s, status: 'loading', error: null }));
    setRetryNonce((n) => n + 1);
  }, []);

  const busy = state.busy && state.status !== 'error';

  return { items, status: state.status, error: state.error, actionError: state.actionError, busy, dismiss, sweep, retry };
}
