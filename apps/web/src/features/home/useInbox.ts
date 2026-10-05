/**
 * @cytale/web — the mention inbox hook (#117).
 *
 * The glue between three sources that must not fight:
 *
 *   1. **the server** — the durable backlog, fetched on boot and on every
 *      fresh gateway session (the reload path). This is what makes the
 *      surface mean something across a reload; it is fetched through REST
 *      rather than added to READY so the hydrate can be re-run at will and
 *      needs no protocol change.
 *   2. **the live wire** — a `MessageCreate` that addresses me accrues a row
 *      immediately, so a mention that arrives while Home is open appears
 *      without waiting for a refetch.
 *   3. **the one read state** — a row disappears when my read watermark
 *      covers it, derived from the same `unreadByChannel` / `unreadByThread`
 *      slices the badges use. Reading the channel is what answers a mention;
 *      there is no second tracker to fall out of sync.
 *
 * The hydrate MERGES (`mergeInbox`) instead of replacing: a snapshot that was
 * taken before a live accrual must not erase it. That direction is the whole
 * reason this file exists rather than a `setState(serverRows)` one-liner.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';

import type { GatewayClient } from '@cytale/gateway-client';
import { defaultStore, messageAddressesMe, type StateStore } from '@cytale/state';

import { shallowEqual, useStoreSelector } from '../../app/useStoreSelector.js';
import { authStore, session } from '../auth/session.js';
import { resolveAuthor } from '../messages/authorIdentity.js';

import {
  dismissInboxItem,
  fetchInbox,
  mentionsUser,
  mergeInbox,
  openInbox,
  sweepInbox,
  type InboxItem,
} from './inbox.js';

export type InboxStatus = 'idle' | 'loading' | 'ready' | 'error';

/** How many rows one hydrate asks for (the server caps at 100). */
export const INBOX_PAGE_LIMIT = 50;

/** The excerpt cap, mirrored from the server so a live row looks like a stored one. */
const EXCERPT_CHARS = 240;

export interface UseInbox {
  items: InboxItem[];
  status: InboxStatus;
  /** The hydrate failure, when the last one failed. */
  error: string | null;
  /** A failed done/sweep, shown inline without hiding the backlog. */
  actionError: string | null;
  /** True while a done/sweep is in flight (the surface disables its controls). */
  busy: boolean;
  dismiss(messageId: string): void;
  sweep(): void;
  retry(): void;
}

export interface InboxState {
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

/**
 * `store` and `gateway` are injectable for tests (the `useUnread`
 * convention); `token` overrides the auth store's access token, which is what
 * a test uses to drive the REST calls. `token === undefined` means "read the
 * live credential".
 */
export function useInbox(
  store: StateStore = defaultStore,
  gateway?: GatewayClient | null,
  token?: string | null,
): UseInbox {
  const [state, setState] = useState<InboxState>(INITIAL);
  const [retryNonce, setRetryNonce] = useState(0);

  const gw = gateway === undefined ? session.getGateway() : gateway;
  // Stable, selector-scoped subscriptions (lane D #17): the inline
  // `(cb) => store.subscribe(cb)` resubscribed on every render.
  const currentUserId = useStoreSelector(store, (s) => s.currentUser?.id ?? null);
  // A fresh gateway session (READY) invalidates nothing and re-fetches
  // everything: this is the value that changes on a reload/reconnect.
  const sessionEpoch = useStoreSelector(store, (s) => s.sessionEpoch);

  const resolvedToken = useMemo(
    () => (token === undefined ? (authStore.getState().getAccessToken() ?? null) : (token ?? null)),
    [token, sessionEpoch],
  );

  // ---------------------------------------------------------------------
  // The hydrate: boot, every fresh session, and an explicit retry.
  // ---------------------------------------------------------------------
  const refresh = useCallback(async () => {
    if (!resolvedToken) {
      // No credential: there is nothing to hydrate and no surface to show.
      // (A logged-in Home always has one; this is the shell's teardown edge.)
      setState((s) => ({ ...s, status: 'idle', error: null }));
      return;
    }

    setState((s) => ({ ...s, status: s.status === 'ready' ? 'ready' : 'loading', error: null }));

    try {
      const page = await fetchInbox({ token: resolvedToken, limit: INBOX_PAGE_LIMIT });
      setState((s) => ({
        ...s,
        // MERGE — never replace. `s.local` holds mentions that arrived while
        // this request was in flight; the snapshot cannot know about them.
        server: mergeInbox(s.local, page.items),
        local: [],
        status: 'ready',
        error: null,
      }));
    } catch (err) {
      setState((s) => ({
        ...s,
        status: 'error',
        error: err instanceof Error ? err.message : 'Could not load your mentions.',
      }));
    }
  }, [resolvedToken]);

  useEffect(() => {
    void refresh();
  }, [refresh, sessionEpoch, retryNonce]);

  // ---------------------------------------------------------------------
  // The live wire: a mention that lands while Home is open.
  // ---------------------------------------------------------------------
  useEffect(() => {
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
      // not suppressed for the workspace — the server's recorder writes a
      // "broadcast" row for exactly those, so the live row matches the one a
      // reload hydrates.
      const direct = mentionsUser(message.content, currentUserId);
      const addressed =
        direct ||
        messageAddressesMe(store.getState(), {
          channel_id: message.channel_id,
          author_id: message.author_id,
          content: message.content ?? '',
        });
      if (!addressed) return;

      // A DM is never an inbox row, on either side of the wire: the whole DM
      // is addressed to its participants, so a row would restate its unread.
      // An UNKNOWN channel is skipped too — the hydrate covers it, and a row
      // the server would not have recorded must not appear for one session.
      const channel = store.getState().channels[message.channel_id];
      if (!channel || channel.type === 'dm') return;

      const item: InboxItem = {
        message_id: message.id,
        channel_id: message.channel_id,
        thread_id: message.thread_id ?? null,
        author_id: message.author_id,
        author_username: resolveAuthor(store.getState().membersById, message.author_id).tag ?? null,
        kind: direct ? 'mention' : 'broadcast',
        excerpt: (message.content ?? '').slice(0, EXCERPT_CHARS),
        created_at: message.created_at ?? null,
      };

      setState((s) =>
        s.dismissed.has(item.message_id) ? s : { ...s, local: mergeInbox([item], s.local) },
      );
    };

    // A thread reply rides its OWN dispatch name (the server keeps the thread
    // off the channel timeline), and its payload still carries the parent
    // channel and the thread — so a mention inside a thread must be listened
    // for here too, or the one place a mention is easiest to miss goes missing.
    const unsubs = [gw.on('MessageCreate', accrue), gw.on('ThreadMessageCreate', accrue)];

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [gw, currentUserId, store]);

  // ---------------------------------------------------------------------
  // The view: merged backlog minus everything already answered or dismissed.
  // ---------------------------------------------------------------------
  // Only the two read-state slices the view filters by (lane D #17). This
  // was a WHOLE-STORE snapshot — every gateway event re-rendered the inbox
  // provider and both of its surfaces.
  const watermarks = useStoreSelector(
    store,
    (s) => ({ unreadByChannel: s.unreadByChannel, unreadByThread: s.unreadByThread }),
    shallowEqual,
  );

  const items = useMemo(
    () =>
      openInbox(
        mergeInbox(state.local, state.server),
        {
          channel: watermarks.unreadByChannel,
          thread: watermarks.unreadByThread,
        },
        state.dismissed,
      ),
    [state.local, state.server, state.dismissed, watermarks],
  );

  // ---------------------------------------------------------------------
  // Done: per item, and the sweep.
  // ---------------------------------------------------------------------
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

  // `busy` must not stick if a request never resolves (a hung fetch): the
  // next hydrate clears it.
  const busy = state.busy && state.status !== 'error';

  // Referentially stable (lane D #17): this object is the InboxProvider's
  // context value, so a fresh literal per render re-rendered every consumer
  // whenever the provider rendered at all.
  return useMemo(
    () => ({
      items,
      status: state.status,
      error: state.error,
      actionError: state.actionError,
      busy,
      dismiss,
      sweep,
      retry,
    }),
    [items, state.status, state.error, state.actionError, busy, dismiss, sweep, retry],
  );
}
