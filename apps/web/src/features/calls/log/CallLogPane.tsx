/**
 * @cytale/web — the call-log pane (calls plan U9, R6).
 *
 * A THREAD VIEW pointed at the channel's standing call-log thread, not a
 * new message list: message rows are the ThreadSidePanel rendering (the
 * same MessageItem in compact mode with the same members attribution), the
 * composer is the thread reply composer (ThreadCompose → posts to
 * /threads/{id}/messages — the server's single-emission keeps the channel
 * clean, R5), and history loads through the existing thread-message path
 * (useCallLog → useThreads.loadReplies). Boundary rows (AM11) interpolate
 * chronologically among the messages (boundaries.tsx).
 *
 * `CallLogThreadView` is the shared body both surfaces render (R6: the log
 * is readable from inside the call panel AND from the main room without
 * joining):
 *
 *   CallLogPane        — embedded in CallPanel's reserved call-log region
 *                        (bounded-height section, "Call log" label);
 *   CallLogStandalone  — the ThreadSidePanel-dock chrome around the same
 *                        body (features/calls/log/CallLogStandalone.tsx).
 *
 * States-first DoD (UX_SPEC §9), enumerated:
 *   loading           — hydration skeleton (announced progressbar)
 *   empty             — "No call history yet" + next-step hint (no standing
 *                       thread, no live call, no ended records)
 *   error             — role=alert + Retry on REST failure
 *   offline           — persistent role=status banner (house StateBanner)
 *   view-only         — composer replaced by an explicit note when
 *                       SEND_MESSAGES is denied (canSendMessages=false —
 *                       the same host-resolved prop injection U7's
 *                       canStartCall uses)
 *   permission-denied — alert replacing content when the channel is
 *                       invisible (permissionDenied prop, MessagePane's
 *                       shape)
 */

import type { LexicalEditor } from 'lexical';

import type { CallStateResponse } from '@cytale/api-client';
import { defaultStore, nicknamesForChannel, selectLiveCall, type StateStore } from '@cytale/state';

import { StateBanner } from '../../../app/ui/StateBanner.js';
import { useStoreSlices } from '../../../app/useStoreSelector.js';

/** What the log pane reads off the store (lane D #17). */
const CALL_LOG_PANE_SLICES = [
  'callByChannel',
  'dmCallByChannel',
  'messagesByThread',
  'currentUser',
  'membersById',
  'channels',
  'nicknamesByWorkspace',
] as const;
import { useOnlineStatus } from '../../../app/pwa/useOnlineStatus.js';
import { resolveAuthor } from '../../messages/authorIdentity.js';
import { MessageItem } from '../../messages/MessageItem.js';
import { ThreadCompose } from '../../threads/ThreadCompose.js';
import type { UseThreads } from '../../threads/useThreads.js';

import {
  CallBoundaryRow,
  boundariesFromEnded,
  interleaveCallLog,
  liveStartBoundary,
  mergeBoundaries,
} from './boundaries.js';
import { useCallLog } from './useCallLog.js';
import { PaneEmpty, PaneRetryButton } from '../../../app/ui/PaneStates.js';

// ---------------------------------------------------------------------------
// The shared thread-view body
// ---------------------------------------------------------------------------

export interface CallLogThreadViewProps {
  /** The channel whose standing call-log thread this view renders. */
  channelId: string;
  /** U6 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** Threads hook override (tests); defaults to useThreads(store). */
  threads?: UseThreads;
  /** REST override (tests); defaults to the session api client. */
  getCall?: (channelId: string) => Promise<CallStateResponse>;
  /**
   * True when the viewer's resolved channel permissions include
   * SEND_MESSAGES (host-resolved like U7's canStartCall). Default true;
   * false renders the view-only note instead of the composer.
   */
  canSendMessages?: boolean;
  /** When set, the surface is replaced by a permission-denied alert. */
  permissionDenied?: string;
  /** Test seam passthrough (MessageCompose's onEditorReady). */
  onComposerReady?: (editor: LexicalEditor) => void;
  /** Rail-header search text — client-side filter on message content. */
  query?: string;
}

export function CallLogThreadView({
  channelId,
  store: storeProp,
  threads,
  getCall,
  canSendMessages = true,
  permissionDenied,
  onComposerReady,
  query = '',
}: CallLogThreadViewProps) {
  const store = storeProp ?? defaultStore;
  const online = useOnlineStatus();
  const { state: log, retry } = useCallLog(channelId, { store, threads, getCall });

  // One subscription serves the live call (boundary + liveness), the
  // thread's message slice, and the members attribution projection.
  // The slices the log reads (lane D #17; was whole-store).
  const snapshot = useStoreSlices(store, CALL_LOG_PANE_SLICES);
  const live = selectLiveCall(snapshot, channelId);
  const replies =
    log.kind === 'ready' && log.threadId !== null
      ? (snapshot.messagesByThread[log.threadId]?.items ?? [])
      : [];
  // Rail-header search: case-insensitive content filter over the log rows.
  const needle = query.trim().toLowerCase();
  const visibleReplies = needle
    ? replies.filter((r) => r.content.toLowerCase().includes(needle))
    : replies;
  const currentUserId = snapshot.currentUser?.id ?? null;
  const membersById = snapshot.membersById;

  // The shared author resolver (authorIdentity.ts), as the timeline uses it.
  const attributionFor = (authorId: string) => {
    const who = resolveAuthor(membersById, authorId, {
      self: snapshot.currentUser,
      nicknames: nicknamesForChannel(snapshot, channelId),
    });
    return {
      authorName: who.name,
      authorTag: who.tag,
      authorAvatarUrl: who.avatarUrl,
      authorKind: who.kind,
      authorParentName: who.parentName,
    };
  };

  // Permission-denied replaces the whole surface (MessagePane's shape).
  if (permissionDenied) {
    return (
      <div
        role="alert"
        data-testid="call-log-permission-denied"
        className="flex flex-1 items-center justify-center px-4 text-center text-sm text-danger"
      >
        {permissionDenied}
      </div>
    );
  }

  // Offline rides ABOVE the content (house pattern: persistent status
  // banner; the composer disables itself separately via the same hook).
  const offlineBanner = !online ? (
    <div className="px-1 pb-2">
      <StateBanner tone="warning" testId="call-log-offline">
        You are offline — the call log will refresh when the connection returns.
      </StateBanner>
    </div>
  ) : null;

  if (log.kind === 'loading') {
    return (
      <div
        role="progressbar"
        aria-busy="true"
        aria-label="Loading call log"
        data-testid="call-log-loading"
        className="flex flex-col gap-2 py-2"
      >
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            aria-hidden="true"
            className="flex items-center gap-3 rounded-md border border-line bg-surface px-3 py-3"
          >
            <div className="h-8 w-8 animate-pulse motion-reduce:animate-none rounded-full bg-surface-hover" />
            <div className="flex-1">
              <div className="h-3 w-32 animate-pulse motion-reduce:animate-none rounded bg-surface-hover" />
              <div className="mt-1.5 h-2.5 w-20 animate-pulse motion-reduce:animate-none rounded bg-surface-hover" />
            </div>
          </div>
        ))}
        <span className="sr-only">Loading…</span>
      </div>
    );
  }

  if (log.kind === 'error') {
    return (
      <div className="px-1 py-2" data-testid="call-log-error-wrap">
        <StateBanner
          tone="danger"
          testId="call-log-error"
          action={
            <PaneRetryButton testId="call-log-retry" onRetry={retry} />
          }
        >
          {log.message}
        </StateBanner>
      </div>
    );
  }

  // Ready. The named empty state: no standing thread, nothing live, no
  // ended records — the channel has never had a call.
  if (log.threadId === null && live === undefined && log.ended.length === 0) {
    return (
      <>
        {offlineBanner}
        <PaneEmpty
          testId="call-log-empty"
          title="No call history yet"
          hint="Start a call from the channel header — messages sent during calls live here."
        />
      </>
    );
  }

  // Boundaries: ended records from REST + the live call's start from the
  // store (AM11 virtual rows; a live call has no end row yet).
  const boundaries = mergeBoundaries(
    boundariesFromEnded(log.ended),
    live === undefined ? null : liveStartBoundary(live),
  );
  const rows = interleaveCallLog(visibleReplies, boundaries);

  return (
    <>
      {offlineBanner}
      <div
        className="min-h-0 flex-1 overflow-y-auto scrollbar-thin"
        data-testid="call-log-rows"
      >
        {rows.map((row) =>
          row.kind === 'boundary' ? (
            <CallBoundaryRow
              key={`boundary-${row.boundary.callId}-${row.boundary.kind}`}
              boundary={row.boundary}
            />
          ) : (
            (() => {
              const a = attributionFor(row.message.author_id);
              return (
                <MessageItem
                  key={row.message.id}
                  message={row.message}
                  authorName={a.authorName}
                  authorTag={a.authorTag}
                  authorAvatarUrl={a.authorAvatarUrl}
                  authorKind={a.authorKind}
                  authorParentName={a.authorParentName}
                  currentUserId={currentUserId}
                  store={store}
                  compact
                />
              );
            })()
          ),
        )}
      </div>

      {/* Composer — the thread reply composer (posts via the thread reply
          route; U4's server-side single-emission keeps the channel clean).
          No thread yet (never had a call) → nothing to post into. */}
      {log.threadId !== null ? (
        canSendMessages ? (
          <ThreadCompose
            threadId={log.threadId}
            channelId={channelId}
            store={store}
            channelName="Call log"
            onEditorReady={onComposerReady}
          />
        ) : (
          <div className="px-1 pt-2">
            <StateBanner tone="info" testId="call-log-view-only">
              View-only — you don&apos;t have permission to send messages in this call log.
            </StateBanner>
          </div>
        )
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// The panel-embedded pane (fills CallPanel's reserved call-log region)
// ---------------------------------------------------------------------------

export interface CallLogPaneProps extends CallLogThreadViewProps {}

/**
 * The call log embedded in the call panel: a bounded-height section inside
 * the panel's scrollable body, labeled "Call log" (the reserved region U8
 * shipped — this replaces its placeholder content).
 */
export function CallLogPane(props: CallLogPaneProps) {
  return (
    <section
      className="flex max-h-[340px] min-h-[160px] shrink-0 flex-col rounded-md border border-line bg-surface-hover"
      data-testid="call-log-slot"
      aria-label="Call log"
    >
      <p
        className="shrink-0 px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-text-muted"
        data-testid="call-log-label"
      >
        Call log
      </p>
      <div className="flex min-h-0 flex-1 flex-col px-1 pb-1">
        <CallLogThreadView {...props} />
      </div>
    </section>
  );
}
