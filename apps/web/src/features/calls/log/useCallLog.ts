/**
 * @cytale/web — call-log hydration hook (calls plan U9).
 *
 * On open, a log surface learns everything REST owns about the channel's
 * call surface from ONE `GET /channels/{id}/call` (the plan's approach line:
 * the panes never need a live call):
 *
 *   1. the standing call-log thread anchor — `setCallLogThread` upserts the
 *      R5 exclusion mapping (a no-op when the wire already taught it);
 *   2. the bounded `recently_ended` list — the ended boundary rows (AM11);
 *   3. thread message history — through the EXISTING thread-message loading
 *      path (useThreads.loadReplies → api.getThreadMessages → the store's
 *      messagesByThread slice), so the log pane renders exactly like a
 *      thread panel.
 *
 * Live boundary data is NOT fetched here: the store's LiveCall slice
 * (CALL_START/CALL_SYNC) owns it and the surfaces read it reactively.
 *
 * Re-hydrates when a fresh gateway session resets the store (sessionEpoch
 * advances) and on `retry()` after a REST failure. The store and hooks are
 * injectable for tests; the app uses the module defaults.
 */

import { useCallback, useState, useEffect, useMemo, useSyncExternalStore } from 'react';

import type { CallStateResponse } from '@cytale/api-client';
import { defaultStore, setCallLogThread, type StateStore } from '@cytale/state';

import { api } from '../../auth/session.js';
import { useThreads, type UseThreads } from '../../threads/useThreads.js';

/** Identity-stable default REST binding (effect-dep safety). */
const defaultGetCall = api.getCall.bind(api);

/** The hydration state machine each log surface renders against. */
export type CallLogLoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; threadId: string | null; ended: CallStateResponse['recently_ended'] }
  | { kind: 'error'; message: string };

export interface UseCallLogOptions {
  /** U6 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Threads hook override (tests); defaults to useThreads(store). */
  threads?: UseThreads;
  /** REST override (tests); defaults to the session api client. */
  getCall?: (channelId: string) => Promise<CallStateResponse>;
}

export interface UseCallLog {
  state: CallLogLoadState;
  /** Re-run hydration (the error state's Retry action). */
  retry(): void;
}

export function useCallLog(channelId: string, options: UseCallLogOptions = {}): UseCallLog {
  const store = options.store ?? defaultStore;
  // Always called (Rules of Hooks); the injection wins when present.
  const defaultThreads = useThreads(store);
  const threads = options.threads ?? defaultThreads;
  // Destructure the STABLE callback — the hook's container object is fresh
  // every render (the MessagePane markChannelRead precedent: depending on
  // the container re-runs the effect per store update).
  const { loadReplies } = threads;

  // Identity-stable (an inline `api.getCall.bind(api)` here would be a
  // fresh function per render and re-run the effect every render).
  const getCall = useMemo(
    () => options.getCall ?? defaultGetCall,
    [options.getCall],
  );

  const [state, setState] = useState<CallLogLoadState>({ kind: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);

  // A fresh gateway READY resets the transient store (the standing-thread
  // mapping included) — re-hydrate so an open log converges without a
  // reload, exactly like the shell's roster hydration.
  const sessionEpoch = useSyncExternalStore(
    store.subscribe,
    () => store.getState().sessionEpoch,
    () => store.getState().sessionEpoch,
  );

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const res = await getCall(channelId);
        if (cancelled) return;
        // The mapping upsert is durable (R4) — null (DM channels, or a
        // channel that never had a call) learns nothing and clears nothing.
        setCallLogThread(store, channelId, res.thread_id);
        const threadId =
          res.thread_id ?? store.getState().callLogThreadIdByChannel[channelId] ?? null;
        if (threadId !== null) {
          // Existing thread-history path — populates messagesByThread so
          // both log surfaces and the thread panel share one slice.
          await loadReplies(threadId);
        }
        if (cancelled) return;
        setState({ kind: 'ready', threadId, ended: res.recently_ended });
      } catch {
        if (!cancelled) setState({ kind: 'error', message: 'Could not load the call log.' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [channelId, store, getCall, loadReplies, retryNonce, sessionEpoch]);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  return { state, retry };
}
