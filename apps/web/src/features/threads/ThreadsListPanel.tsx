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
 *
 * Rows (owner direction 2026-10-08, mockup "D3"): grouped Today / This week /
 * Older by last activity; the starter's avatar; the subject (threadRows.ts:
 * the start message when the name is a generated one) beside "started →
 * last reply"; under it the newest reply with its author, and the reply
 * count. No box per row at rest — the hover highlight only.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react';

import type { Thread } from '@cytale/domain';
import { defaultStore, nicknamesForChannel, type StateStore } from '@cytale/state';

import { api } from '../auth/session.js';
import { PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { Avatar } from '../../app/ui/UserAvatar.js';
import { formatDateTime, formatMonthDay, formatRelative } from '../../app/ui/time.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import { channelNameOf } from '../messages/ChannelMentionPill.js';
import { resolveAuthor, type AuthorRoster } from '../messages/authorIdentity.js';
import { dmParticipants } from '../messages/dmRoster.js';
import { createMentionResolver } from '../messages/mentionResolver.js';
import { ACTIVITY_GROUP_LABEL, groupByActivity, previewLine, threadSubject } from './threadRows.js';

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
  /** Names, avatars and unread state; the app store unless a test hands one in. */
  store?: StateStore;
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
  store = defaultStore,
}: ThreadsListPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [retryNonce, setRetryNonce] = useState(0);

  // Names resolve through the chain every message row uses: DM participants,
  // the roster with this workspace's nicknames, the session self.
  const membersById = useStoreSelector(store, (s) => s.membersById);
  const currentUser = useStoreSelector(store, (s) => s.currentUser);
  const channel = useStoreSelector(store, (s) => (channelId ? s.channels[channelId] : undefined));
  const nicknames = useStoreSelector(store, (s) => (channelId ? nicknamesForChannel(s, channelId) : undefined));
  const unreadByThread = useStoreSelector(store, (s) => s.unreadByThread);
  const roster = useMemo(() => {
    const dmRows = dmParticipants(channel);
    return Object.keys(dmRows).length === 0
      ? membersById
      : ({ ...membersById, ...dmRows } as typeof membersById);
  }, [channel, membersById]);
  const resolveMention = useMemo(
    () => createMentionResolver(roster, currentUser, nicknames),
    [roster, currentUser, nicknames],
  );
  const resolveChannel = useCallback((id: string) => channelNameOf(store, id), [store]);
  const authorOf = useCallback<AuthorOf>(
    (id, webhookName) =>
      resolveAuthor(roster as AuthorRoster, id, {
        self: currentUser,
        nicknames,
        override: webhookName ? { username: webhookName } : null,
      }),
    [roster, currentUser, nicknames],
  );
  const groupIdPrefix = useId();

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

  const subjectOf = (t: Thread) => threadSubject(t, resolveMention, resolveChannel);
  const needle = query.trim().toLowerCase();
  const visible =
    state.kind === 'ready' && needle !== ''
      ? state.threads.filter(
          (t) => t.name.toLowerCase().includes(needle) || subjectOf(t).toLowerCase().includes(needle),
        )
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
        <div className="threads-list" data-testid="threads-list">
          {groupByActivity(visible).map(({ group, threads }) => (
            <section key={group} className="threads-list-group" aria-labelledby={`${groupIdPrefix}-${group}`}>
              <h3 id={`${groupIdPrefix}-${group}`} className="threads-list-group-label">
                {ACTIVITY_GROUP_LABEL[group]}
              </h3>
              <ul className="threads-list-rows">
                {threads.map((t) => (
                  <li key={t.id}>
                    <ThreadRow
                      thread={t}
                      subject={subjectOf(t)}
                      unread={(unreadByThread[t.id]?.unread_count ?? 0) > 0}
                      authorOf={authorOf}
                      lastText={previewLine(t.latest_reply, resolveMention, resolveChannel)}
                      onOpen={onOpenThread}
                    />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

type AuthorOf = (id: string, webhookName?: string | null) => ReturnType<typeof resolveAuthor>;

function ThreadRow({
  thread: t,
  subject,
  unread,
  authorOf,
  lastText,
  onOpen,
}: {
  thread: Thread;
  subject: string;
  unread: boolean;
  authorOf: AuthorOf;
  lastText: string;
  onOpen: (threadId: string) => void;
}) {
  // The starter message names who started it; a thread whose start message is
  // gone falls back to its creator.
  const starterId = t.starter?.author_id ?? t.created_by;
  const starter = authorOf(starterId, t.starter?.author_name);
  const last = t.latest_reply ? authorOf(t.latest_reply.author_id, t.latest_reply.author_name) : null;
  const replies = t.message_count ?? 0;
  const lastAt = t.latest_reply_at ?? null;
  const stamp = `Started ${formatDateTime(t.created_at)}${lastAt ? ` · last reply ${formatDateTime(lastAt)}` : ''}`;

  return (
    <button
      type="button"
      className="threads-list-row"
      data-testid={`threads-list-row-${t.id}`}
      data-unread={unread ? 'true' : undefined}
      onClick={() => onOpen(t.id)}
    >
      <Avatar
        id={starterId}
        name={starter.name}
        src={starter.avatarUrl}
        kind={starter.kind}
        parentName={starter.parentName}
        size={32}
      />
      <span className="threads-list-row-body">
        <span className="threads-list-row-line">
          {unread ? (
            <span className="threads-list-unread">
              <span className="sr-only">Unread: </span>
            </span>
          ) : null}
          <span className="threads-list-subject">{subject}</span>
          {t.archived ? <span className="threads-list-archived">archived</span> : null}
          <span className="threads-list-dates" title={stamp}>
            {formatMonthDay(t.created_at)}
            {lastAt ? (
              <>
                <span aria-hidden> → </span>
                <span className="sr-only">, last reply </span>
                <span className="threads-list-last-at">{formatRelative(lastAt)}</span>
              </>
            ) : null}
          </span>
        </span>
        <span className="threads-list-row-line">
          {last && t.latest_reply ? (
            <>
              <Avatar
                id={t.latest_reply.author_id}
                name={last.name}
                src={last.avatarUrl}
                kind={last.kind}
                parentName={last.parentName}
                size={16}
              />
              <span className="threads-list-preview">
                <span className="threads-list-preview-author">{last.name}</span> {lastText}
              </span>
            </>
          ) : (
            <span className="threads-list-preview">{starter.name}</span>
          )}
          <span className="threads-list-count" title={replies === 1 ? '1 reply' : `${replies} replies`}>
            {replies}
            <span className="sr-only">{replies === 1 ? ' reply' : ' replies'}</span>
          </span>
        </span>
      </span>
    </button>
  );
}
