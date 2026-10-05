/**
 * @cytale/mobile — thread metadata resolution (plan 004 M9, R12).
 *
 * The store usually already holds the thread (a channel-surface push or a
 * `ThreadCreate` dispatch put it there), but a cold deep link straight to
 * `/thread/<id>` does not — and the surface needs the thread's NAME for its
 * title and its `channel_id` for the composer and the REST seams. This hook
 * is the one place that reads `threadsById`, falls back to
 * `GET /threads/{id}`, and writes the result back so every other reader (the
 * window merge's `channel_id` resolution included) sees it.
 *
 * States-first: `loading` while the fetch is in flight, `error` with the
 * server's verdict (404 is the anti-enumeration "no such thread or no
 * access" answer, so it reads as unavailable rather than forbidden), and
 * `ready` once the thread is in the store. `enabled: false` (signed out)
 * never fetches — the surface then renders whatever the store holds.
 */
import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@cytale/api-client';
import type { Thread } from '@cytale/domain';
import type { StateStore } from '@cytale/state';

import { useStoreSelector } from '../navigation/store';

/** The narrow slice of `CytaleApiClient` the metadata path needs. */
export interface ThreadMetaApi {
  getThread(threadId: string): Promise<Thread>;
}

export type ThreadMetaStatus = 'loading' | 'ready' | 'error';

export interface ThreadMeta {
  /** The thread once known (store or fetch); undefined while unresolved. */
  thread: Thread | undefined;
  status: ThreadMetaStatus;
  /** Fetch failure detail (null while loading or ready). */
  error: string | null;
  /** Re-run a failed fetch. */
  retry(): void;
}

export function useThreadMeta({
  threadId,
  store,
  api,
  enabled = true,
}: {
  threadId: string | null;
  store: StateStore;
  api: ThreadMetaApi;
  enabled?: boolean;
}): ThreadMeta {
  const thread = useStoreSelector(store, (state) =>
    threadId === null ? undefined : state.threadsById[threadId],
  );
  const [status, setStatus] = useState<ThreadMetaStatus>(() =>
    enabled && threadId !== null && thread === undefined ? 'loading' : 'ready',
  );
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (threadId === null || !enabled || store.getState().threadsById[threadId] !== undefined) {
      setStatus('ready');
      setError(null);
      return;
    }
    let cancelled = false;
    setStatus('loading');
    setError(null);
    void (async () => {
      try {
        const fetched = await api.getThread(threadId);
        if (cancelled) return;
        store.setState((state) => ({
          threadsById: { ...state.threadsById, [threadId]: fetched },
        }));
        setStatus('ready');
      } catch (err) {
        if (cancelled) return;
        setError(
          err instanceof ApiError && err.status === 404
            ? `Thread ${threadId} is unavailable.`
            : 'Could not load this thread.',
        );
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, enabled, reloadKey, store, thread, threadId]);

  const retry = useCallback(() => setReloadKey((key) => key + 1), []);

  return { thread, status, error, retry };
}
