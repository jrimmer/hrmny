/**
 * @cytale/web — AllCallsList, the Home context's Call log rail content.
 *
 * The cross-channel aggregate of the per-channel call surface: every
 * workspace channel's standing call state (live roster + the bounded
 * recently-ended list) from ONE `GET /channels/{id}/call` each — a bounded
 * client-side fan-out, honest loading/error/empty states. DIVERGENCE LEDGER:
 * a server-side workspace-level call index is the scale answer; until one
 * exists the fan-out is capped (MAX_FANOUT channels, dev-scale) rather than
 * unbounded. Rows jump into the owning channel, where the rail's contextual
 * tab opens the full log.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import type { CallStateResponse } from '@cytale/api-client';
import type { Channel } from '@cytale/domain';

import { api } from '../../auth/session.js';
import { formatRelative } from '../../../app/ui/time.js';
import { PaneRetryButton } from '../../../app/ui/PaneStates.js';

/** Identity-stable default REST binding (matches useCallLog's pattern). */
const defaultGetCall = api.getCall.bind(api);

export interface AllCallsListProps {
  /** Workspace channels to survey (DM channels carry no call surface). */
  channels: Channel[];
  getCall?: (channelId: string) => Promise<CallStateResponse>;
  /** Rail-header search text — client-side filter on channel name. */
  query?: string;
  onSelectChannel: (channelId: string) => void;
}

/** Fan-out cap — the divergence note above owns the reasoning. */
const MAX_FANOUT = 60;

type ChannelCallState =
  | { kind: 'loading' }
  | { kind: 'ready'; states: Array<{ channel: Channel; state: CallStateResponse }> }
  | { kind: 'error'; message: string };

export function AllCallsList({ channels, getCall, query = '', onSelectChannel }: AllCallsListProps) {
  const [state, setState] = useState<ChannelCallState>({ kind: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);
  const getCallRef = useRef(getCall);
  getCallRef.current = getCall;

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    const targets = channels.slice(0, MAX_FANOUT);
    void (async () => {
      try {
        const settled = await Promise.allSettled(
          targets.map((c) => {
            const fetcher = getCallRef.current ?? defaultGetCall;
            return fetcher(c.id);
          }),
        );
        if (cancelled) return;
        const states: Array<{ channel: Channel; state: CallStateResponse }> = [];
        settled.forEach((r, i) => {
          if (r.status === 'fulfilled') states.push({ channel: targets[i]!, state: r.value });
        });
        const failures = settled.filter((r) => r.status === 'rejected').length;
        if (states.length === 0 && failures > 0) {
          setState({ kind: 'error', message: 'Could not load call logs.' });
          return;
        }
        setState({ kind: 'ready', states });
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'Could not load call logs.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channels, retryNonce]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  if (state.kind === 'loading') {
    return (
      <div className="people-directory" data-testid="all-calls-loading">
        <p className="home-empty" role="status">
          Loading call logs…
        </p>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="people-directory" data-testid="all-calls-error">
        <p className="home-empty" role="alert">
          {state.message}
        </p>
        <PaneRetryButton testId="all-calls-retry" onRetry={retry} />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const sections = state.states.filter(
    ({ channel, state: s }) =>
      // Search filters by channel name; empty search shows everything.
      (!needle || channel.name.toLowerCase().includes(needle)) &&
      (s.live !== null || s.recently_ended.length > 0),
  );

  if (sections.length === 0) {
    return (
      <div className="people-directory" data-testid="all-calls-empty">
        <p className="home-empty">
          {needle
            ? `No calls in channels matching “${query.trim()}”.`
            : 'No calls yet — start one from any channel\'s header.'}
        </p>
      </div>
    );
  }

  return (
    <div className="people-directory" data-testid="all-calls-list">
      <ul className="people-list" role="list" aria-label="All calls">
        {sections.map(({ channel, state: s }) => (
          <li key={channel.id} className="px-1 py-1">
            <div
              className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-muted"
              data-testid={`all-calls-channel-${channel.id}`}
            >
              # {channel.name}
            </div>
            {s.live !== null ? (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                data-testid={`all-calls-live-${channel.id}`}
                onClick={() => onSelectChannel(channel.id)}
              >
                <span className="call-slot-icon" aria-hidden="true" />
                <span className="flex-1">
                  Live now — {s.live.participants?.length ?? 0} in call
                </span>
              </button>
            ) : null}
            {s.recently_ended.map((call) => (
              <button
                key={call.call_id}
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-text-muted transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
                data-testid={`all-calls-ended-${call.call_id}`}
                onClick={() => onSelectChannel(channel.id)}
              >
                <span aria-hidden="true">📞</span>
                <span className="flex-1">Ended call</span>
                <span className="text-xs">{formatRelative(call.ended_at) || call.ended_at}</span>
              </button>
            ))}
          </li>
        ))}
      </ul>
    </div>
  );
}
