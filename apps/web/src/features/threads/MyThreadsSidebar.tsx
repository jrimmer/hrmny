/**
 * @cytale/web — My Threads sidebar (U22).
 *
 * Lists the current user's followed threads. Clicking a thread opens it in
 * the side-panel; the unread badge clears on open. Reads followed threads
 * from the U17 store (`threadsById` with `member_state`), counts from
 * `unreadByThread`.
 *
 * The rows ARE sidebar rows (UI consistency, 2026-09-27): `.channel-row`
 * with the same hover, the same neutral active pill + `aria-current`, the
 * same bold-when-unread weight and the same trailing badge rule as channels
 * and DMs (`SidebarRowBadge` — mention count wins, else unread count). They
 * used to be one-off rows with their own hover and colored dots, and the open
 * thread had no active state at all.
 *
 * WCAG 2.1 AA: each row is a real button with an accessible label naming the
 * thread and its unread state; badges are announced via aria-label.
 */

import { useCallback, useSyncExternalStore } from 'react';

import type { Thread } from '@cytale/domain';
import { channelMentionCount, defaultStore, type StateStore } from '@cytale/state';

import { ThreadIcon } from '../../app/ui/icons.js';
import { levelNameSuffix, MutedGlyph, showsUnread, SidebarRowBadge } from '../channels/SidebarRowBadge.js';
import { rowLevel } from '../notifications/notificationPrefs.js';
import type { UseThreads } from './useThreads.js';

export interface MyThreadsSidebarProps {
  /** U17 store (injectable for tests; app uses the module default). */
  store?: StateStore;
  /** The threads hook (injectable for tests). */
  threads?: UseThreads;
  /** Called when a thread is clicked (opens the side-panel). */
  onOpenThread?: (threadId: string) => void;
  /** The thread open in the dock right now (the active pill). */
  activeThreadId?: string | null;
}

export function MyThreadsSidebar({
  store,
  threads,
  onOpenThread,
  activeThreadId = null,
}: MyThreadsSidebarProps) {
  const s = store ?? defaultStore;
  // The two slices the rows read — not the whole store (a typing or presence
  // write must not re-render the list). Slice identities are stable across
  // unrelated writes (immutable store).
  const threadsById = useSyncExternalStore(
    (cb) => s.subscribe(cb),
    () => s.getState().threadsById,
    () => s.getState().threadsById,
  );
  const unreadByThread = useSyncExternalStore(
    (cb) => s.subscribe(cb),
    () => s.getState().unreadByThread,
    () => s.getState().unreadByThread,
  );
  // The member's notification levels (notification controls): a muted thread
  // row dims and keeps only its mention badge, like a channel row.
  const notificationPrefs = useSyncExternalStore(
    (cb) => s.subscribe(cb),
    () => s.getState().notificationPrefs,
    () => s.getState().notificationPrefs,
  );
  const t = threads!;

  const followed: Thread[] = Object.values(threadsById).filter(
    (th) => th.member_state != null,
  );

  const handleOpen = useCallback(
    (threadId: string) => {
      t.openThread(threadId);
      onOpenThread?.(threadId);
    },
    [t, onOpenThread],
  );

  return (
    <nav aria-label="My Threads" className="flex h-full flex-col" data-testid="my-threads-sidebar">
      {/* The column heading idiom (.category-label, as Direct Messages,
          Inbox and Threads use) and the column's empty line (.home-empty) —
          this column hand-rolled a semibold, wider-tracked heading of its own. */}
      <h2 className="category-label mx-2 mt-2">My Threads</h2>
      {followed.length === 0 ? (
        <p className="home-empty mx-2" data-testid="my-threads-empty">
          No followed threads yet.
        </p>
      ) : (
        <ul className="category-channels min-h-0 flex-1 overflow-y-auto px-2">
          {followed.map((th) => {
            // The thread's chain: thread → its channel → that channel's
            // workspace. The channel record is read (not subscribed): a
            // thread never moves workspaces, so there is nothing to follow.
            const level = rowLevel(notificationPrefs, {
              threadId: th.id,
              channelId: th.channel_id,
              workspaceId: s.getState().channels[th.channel_id]?.workspace_id ?? null,
            });
            const rawUnread = t.unreadCount(th.id);
            const unread = showsUnread(level) ? rawUnread : 0;
            // Lane D #2: the one badge rule (server snapshot + live accrual).
            const mentions = channelMentionCount(unreadByThread[th.id]);
            const active = th.id === activeThreadId;
            const state =
              (mentions > 0 ? `${mentions} mentions` : unread > 0 ? `${unread} unread` : 'read') +
              levelNameSuffix(level);
            return (
              <li key={th.id} className="channel-list-item">
                <button
                  type="button"
                  onClick={() => handleOpen(th.id)}
                  className="channel-row"
                  aria-label={`${th.name} — ${state}`}
                  aria-current={active ? 'page' : undefined}
                  data-active={active || undefined}
                  data-muted={level === 'mute' || undefined}
                  data-level={level}
                  data-unread={(level !== 'mute' && rawUnread > 0) || mentions > 0 || undefined}
                  data-testid="my-thread-row"
                  data-thread-id={th.id}
                  data-badge={mentions > 0 ? 'mentions' : unread > 0 ? 'unread' : 'read'}
                >
                  <span className="channel-prefix" aria-hidden="true">
                    <ThreadIcon size={16} />
                  </span>
                  <span className="channel-name" data-testid="my-thread-name">
                    {th.name}
                  </span>
                  {level === 'mute' ? <MutedGlyph testId="my-thread-muted" /> : null}
                  <SidebarRowBadge
                    unread={unread}
                    mentions={mentions}
                    level={level}
                    mentionsTestId="my-thread-badge"
                    unreadTestId="my-thread-badge"
                  />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </nav>
  );
}
