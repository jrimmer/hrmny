/**
 * @cytale/web — integrations pane list hook (U13).
 *
 * Owns the load scaffolding every integrations pane shares: the reload
 * nonce, the cancelled-flag fetch effect, the `LoadState` transitions, and
 * the 403 `ApiError` → permission-denied mapping (the pane renders its own
 * deny copy from the carried error, e.g. BotsPane's ACCOUNT_UNVERIFIED
 * case). Panes supply a memoized fetcher (`useCallback`) whose identity —
 * and therefore its captured inputs (workspaceId, channels, …) — drives
 * refetches; returning null means "nothing to load right now" (BotsPane
 * before a workspace is picked). Fan-out fetchers (WebhooksPane aggregates
 * across channels) signal total denial by letting the 403 escape.
 */

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@cytale/api-client';

import type { LoadState } from '../../app/ui/PaneStates.js';

/** Reads the pane's rows; a null return skips the fetch entirely. */
export type PaneListFetcher<T> = () => Promise<T[]> | null;

export interface UsePaneListOptions {
  /** Error copy when the failure is not an `Error` instance. */
  errorFallback: string;
}

export interface PaneList<T> {
  items: T[];
  loadState: LoadState;
  /** The 403 `ApiError` when the read was denied; null otherwise. */
  permissionDenied: ApiError | null;
  /** Bump to refetch (the Retry button, post-mutation refreshes). */
  reload: () => void;
  /** Surface a mutation failure as the pane's error state (with Retry). */
  setError: (message: string) => void;
}

export function usePaneList<T>(
  fetcher: PaneListFetcher<T>,
  { errorFallback }: UsePaneListOptions,
): PaneList<T> {
  const [items, setItems] = useState<T[]>([]);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'loading' });
  const [permissionDenied, setPermissionDenied] = useState<ApiError | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);
  const setError = useCallback((message: string) => setLoadState({ kind: 'error', message }), []);

  useEffect(() => {
    const pending = fetcher();
    if (pending == null) return;
    let cancelled = false;
    setLoadState({ kind: 'loading' });
    setPermissionDenied(null);

    pending
      .then((rows) => {
        if (cancelled) return;
        setItems(rows);
        setLoadState({ kind: 'ready' });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setPermissionDenied(err);
          setLoadState({ kind: 'ready' });
        } else {
          setLoadState({
            kind: 'error',
            message: err instanceof Error ? err.message : errorFallback,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [fetcher, errorFallback, reloadNonce]);

  return { items, loadState, permissionDenied, reload, setError };
}
