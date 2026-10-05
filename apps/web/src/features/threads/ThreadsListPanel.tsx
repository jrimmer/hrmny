/**
 * @cytale/web — a channel's thread roster, shared by its two hosts.
 *
 * Extracted from ThreadsListDialog so the dialog and the context rail's
 * **Threads** tab cannot drift (owner direction 2026-09-12: the 4th column
 * carries "members, calls, and now Threads"). The rail is the
 * always-available listing; the dialog stays the focused view with the
 * archived toggle and the title. Both render the same states — loading /
 * error+retry / empty / list — because they are the same component.
 *
 * A thread IS its replies: the roster never lists an empty one (the
 * deferred-create path leaves none behind, and this hides any that predate
 * it — user direction 2026-09-12).
 */
import { useCallback, useEffect, useState } from 'react';

import type { Thread } from '@cytale/domain';

import { api } from '../auth/session.js';
import { ThreadIcon } from '../../app/ui/icons.js';
import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { formatRelative } from '../../app/ui/time.js';

export interface ThreadsListPanelProps {
  /** The channel whose threads are listed; null renders the empty hint. */
  channelId: string | null;
  /** Rail search text — filtered on thread name by the caller's contract. */
  query?: string;
  /** Opens the thread (the rail swaps the pane; the dialog also closes). */
  onOpenThread: (threadId: string) => void;
  /** When supplied (the dialog), renders the archived toggle. */
  includeArchived?: boolean;
  onIncludeArchivedChange?: (value: boolean) => void;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; threads: Thread[] }
  | { kind: 'error'; message: string };

export function ThreadsListPanel({
  channelId,
  query = '',
  onOpenThread,
  includeArchived = false,
  onIncludeArchivedChange,
}: ThreadsListPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);

  useEffect(() => {
    if (channelId === null) return;
    let cancelled = false;
    setState({ kind: 'loading' });
    void api
      .listThreads(channelId, { includeArchived })
      .then((threads) => {
        if (!cancelled)
          setState({ kind: 'ready', threads: threads.filter((t) => t.message_count !== 0) });
      })
      .catch(() => {
        if (!cancelled) setState({ kind: 'error', message: 'Could not load threads.' });
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, includeArchived, retryNonce]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  if (channelId === null) {
    return (
      <div className="threads-list-panel">
        <p className="py-4 text-sm text-text-muted">Select a channel to see its threads.</p>
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const visible =
    state.kind === 'ready' && needle !== ''
      ? state.threads.filter((t) => t.name.toLowerCase().includes(needle))
      : state.kind === 'ready'
        ? state.threads
        : [];

  return (
    <div className="threads-list-panel">
      {onIncludeArchivedChange ? (
        <label className="flex items-center gap-2 pb-2 text-sm text-text">
          <input
            type="checkbox"
            data-testid="threads-list-archived"
            checked={includeArchived}
            onChange={(e) => onIncludeArchivedChange(e.target.checked)}
          />
          Include archived
        </label>
      ) : null}

      {/* The shared pane states (app/ui/PaneStates): the same skeleton and
          the same banner + Retry every list pane uses. */}
      {state.kind === 'loading' ? (
        <PaneSkeleton label="Loading threads" testId="threads-list-loading" variant="message" />
      ) : state.kind === 'error' ? (
        <PaneErrorBanner
          testId="threads-list-error"
          retryTestId="threads-list-retry"
          message={state.message}
          onRetry={retry}
        />
      ) : visible.length === 0 ? (
        <p className="py-4 text-sm text-text-muted" data-testid="threads-list-empty">
          {needle !== ''
            ? 'No threads match that search.'
            : 'No threads in this channel yet — start one from a message.'}
        </p>
      ) : (
        <ul className="threads-list" data-testid="threads-list">
          {visible.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className="settings-list-row w-full text-left"
                data-testid={`threads-list-row-${t.id}`}
                onClick={() => onOpenThread(t.id)}
              >
                <span className="min-w-0 flex-1 truncate">
                  <span aria-hidden className="mr-1 inline-flex align-[-2px]">
                    <ThreadIcon size={14} />
                  </span>
                  {t.name}
                  {t.archived ? (
                    <span className="ml-2 text-xs text-text-muted">archived</span>
                  ) : null}
                </span>
                <span className="shrink-0 text-xs text-text-muted">
                  {t.message_count === 1 ? '1 reply' : `${t.message_count ?? 0} replies`}
                  {t.latest_reply_at ? ` · ${formatRelative(t.latest_reply_at)}` : ''}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
