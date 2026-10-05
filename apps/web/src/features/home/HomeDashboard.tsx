/**
 * @cytale/web — HomeDashboard, the home surface's main area.
 *
 * The user landing that replaces the "Active Now" column the corpus took
 * from Discord: time-bucketed greeting, a what's-new catchup per workspace
 * (top unread channels, straight into the conversation), account stats from
 * the same rollups the rail badges use, and quick actions. A fresh account
 * (zero workspaces) gets the welcome hero instead — the old zero-workspace
 * fall-through rendered a meaningless empty chat shell.
 *
 * DM conversations render the MessagePane instead of this dashboard while a
 * DM row is selected (the host decides — see AuthenticatedApp).
 */
import { useState } from 'react';

import type { Workspace } from '@cytale/domain';

import { CreateWorkspaceDialog } from '../channels/CreateWorkspaceDialog.js';
import { InboxSection } from './InboxSection.js';
import type { HomeStore } from './HomeSidebar.js';
import { channelMentionCount, channelUnreadCount } from '@cytale/state';
import type { UseInbox } from './useInbox.js';

export interface HomeDashboardProps {
  store: HomeStore;
  /** Roster hydration in flight — renders an announced loading state. */
  loading?: boolean;
  username: string | null;
  onSelectChannel: (channelId: string) => void;
  onCreateWorkspace: (input: { name: string }) => Promise<Workspace>;
  /**
   * #117's mention backlog, OWNED BY THE SHELL so the sidebar and this body
   * read one instance. Two `useInbox()` calls would be two copies of one
   * backlog, drifting on the first done or sweep.
   */
  inbox: UseInbox;
}

function greetingFor(now: Date): string {
  const hour = now.getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function HomeDashboard({
  store,
  loading = false,
  username,
  onSelectChannel,
  onCreateWorkspace,
  inbox,
}: HomeDashboardProps) {
  const [createOpen, setCreateOpen] = useState(false);
  // #117: the mention inbox lives INSIDE Home. It is OWNED by the shell rather
  // than by this component, because the sidebar renders the same backlog above
  // Mentions — two `useInbox()` instances would hold two copies of one
  // backlog and drift on the first done/sweep.

  if (loading) {
    return (
      <div className="home-dash" data-testid="home-dashboard">
        <div role="status" data-testid="home-loading">
          Loading your workspaces…
        </div>
      </div>
    );
  }

  const workspaces = Object.values(store.workspaces);
  const dmChannels = Object.values(store.channels).filter((c) => c.type === 'dm');
  // Lane D #2: the badge rule every surface shares — the server's snapshot
  // plus live accrual. The local count alone read zero after a reload.
  const unreadEntries = Object.entries(store.unreadByChannel);
  const totalUnread = unreadEntries.reduce((sum, [, u]) => sum + channelUnreadCount(u), 0);
  const totalMentions = unreadEntries.reduce((sum, [, u]) => sum + channelMentionCount(u), 0);

  // Fresh account: the welcome hero replaces the dashboard outright.
  if (workspaces.length === 0) {
    return (
      <div className="home-dash" data-testid="home-dashboard">
        <div className="home-hero" data-testid="home-hero">
          <h1 className="home-hero-title" data-testid="home-hero-title">
            Welcome to Hrmny{username ? `, ${username}` : ''}
          </h1>
          <p className="home-hero-sub">
            Create a workspace for your team, or open an invite link to join one — your
            conversations and DMs will live here.
          </p>
          <button
            type="button"
            className="home-btn home-btn--primary"
            data-testid="home-hero-create"
            onClick={() => setCreateOpen(true)}
          >
            Create a workspace
          </button>
        </div>
        <CreateWorkspaceDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreateWorkspace={onCreateWorkspace}
        />
      </div>
    );
  }

  const catchup = workspaces
    .map((workspace) => {
      const unreadChannels = Object.entries(store.unreadByChannel)
        .filter(
          ([channelId, u]) =>
            channelUnreadCount(u) > 0 &&
            store.channels[channelId]?.workspace_id === workspace.id,
        )
        .map(([channelId, u]) => ({
          channelId,
          unread: channelUnreadCount(u),
          name: store.channels[channelId]?.name ?? channelId,
        }))
        .sort((a, b) => b.unread - a.unread);
      return {
        workspace,
        total: unreadChannels.reduce((sum, c) => sum + c.unread, 0),
        mentions: unreadChannels.reduce(
          (sum, c) => sum + channelMentionCount(store.unreadByChannel[c.channelId]),
          0,
        ),
        top: unreadChannels.slice(0, 3),
      };
    })
    .filter((entry) => entry.total > 0)
    .sort((a, b) => b.total - a.total);

  return (
    <div className="home-dash" data-testid="home-dashboard">
      <div className="home-dash-inner">
        <header className="home-greeting">
          <h1 className="home-greeting-title" data-testid="home-greeting">
            {greetingFor(new Date())}
            {username ? `, ${username}` : ''}
          </h1>
          <p className="home-greeting-sub">Here's what's new across your workspaces.</p>
        </header>

        {/* #117: the message-level answer ("who needed you, and what did they
            say"), above the channel-level rollup below — the distinction the
            ticket is named for. Rows deep-link to their message through
            #114's permalinks; done/sweep touch inbox rows only. */}
        <InboxSection
          store={store}
          items={inbox.items}
          status={inbox.status}
          error={inbox.error}
          actionError={inbox.actionError}
          busy={inbox.busy}
          onDismiss={inbox.dismiss}
          onSweep={inbox.sweep}
          onRetry={inbox.retry}
        />

        <section aria-label="Catch up">
          <h2 className="home-section-label">Catch up</h2>
          {catchup.length === 0 ? (
            <div className="all-caught-up" data-testid="home-all-caught-up">
              ✓ You're all caught up.
            </div>
          ) : (
            <div className="catchup-grid" data-testid="home-catchup">
              {catchup.map(({ workspace, total, mentions, top }) => (
                <div key={workspace.id} className="catchup-card" data-testid={`catchup-${workspace.id}`}>
                  <div className="catchup-workspace">{workspace.name}</div>
                  <div className="catchup-count">
                    {total} unread{mentions > 0 ? ` · ${mentions} mention${mentions === 1 ? '' : 's'}` : ''}
                  </div>
                  {top.map(({ channelId, unread, name }) => (
                    <button
                      key={channelId}
                      type="button"
                      className="catchup-channel"
                      data-testid={`catchup-channel-${channelId}`}
                      onClick={() => onSelectChannel(channelId)}
                    >
                      <span>
                        <span aria-hidden="true"># </span>
                        {name}
                      </span>
                      <span className="channel-unread" aria-label={`${unread} unread`}>
                        {unread}
                      </span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreateWorkspace={onCreateWorkspace}
      />
    </div>
  );
}
