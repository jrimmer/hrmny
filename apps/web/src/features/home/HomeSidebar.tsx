/**
 * @cytale/web — HomeSidebar, the home surface's second column.
 *
 * The home analog of Discord's Friends/DM column, minus the Friends concept
 * (Hrmny models DM association, not friendship). Sections: Direct Messages
 * (peer-named rows from the channel's `recipients`, recency-sorted; the
 * compact ＋ opens the start-conversation member picker, #94, and the empty
 * state offers the same affordance inline, so an account nobody has DM'd is
 * never stuck); the Inbox (#117's message-level backlog); recent threads.
 * The rail owns workspace LISTING; what remains here lists ACTIVITY.
 *
 * Mentions used to have a section of their own — the per-workspace UNREAD
 * mention rollup. It is gone (owner direction 2026-09-15): the rollup only
 * ever showed counts that the read-ack zeroed, so it duplicated the Inbox's
 * job while being able to do less (the Inbox names the message, links to it
 * and dismisses one at a time). The mention COUNTS still live on the channel
 * rows and the rail badges, which is where "something wants you" belongs.
 *
 * Data is the U17 store projection only — no new server surface. Replaces
 * the workspace ChannelSidebar while Home is active; the wordmark header is
 * static (the "Hrmny" workspace-menu dropdown is gone with the workspace
 * context) and the ＋ action creates a workspace directly.
 */
import { useMemo, useState } from 'react';

import { HeaderActionsMenu } from '../../app/layout/HeaderActionsMenu.js';
import { InboxSection } from './InboxSection.js';
import type { UseInbox } from './useInbox.js';
import { Avatar, kindTitle } from '../../app/ui/UserAvatar.js';
import { channelMentionCount, channelUnreadCount, type NotificationPrefsState } from '@cytale/state';
import type { PresenceByUser } from '../presence/usePresence.js';
import { presenceOf } from '../presence/usePresence.js';
import type { Channel, PrincipalKind, Thread, Workspace } from '@cytale/domain';

import { CreateWorkspaceDialog } from '../channels/CreateWorkspaceDialog.js';
import {
  dmRowLevel,
  levelNameSuffix,
  MutedGlyph,
  rowNotificationAttrs,
  SidebarRowBadge,
} from '../channels/SidebarRowBadge.js';
import { rowLevel } from '../notifications/notificationPrefs.js';
import { StartDmPicker, type DmCandidate } from './StartDmPicker.js';
import { ThreadIcon } from '../../app/ui/icons.js';
import { displayNameOf } from '@cytale/domain';

/** The store slice the home column reads (structurally-typed for tests). */
export interface HomeStore {
  workspaces: Record<string, Workspace>;
  channels: Record<string, Channel>;
  /**
   * Per-channel recency, kept by the message hot path (U17's narrow slice).
   * Optional so structural test fixtures stay valid: a channel the gateway
   * has not touched since hydration falls back to the channel row's own
   * `last_message_id`.
   */
  lastMessageIdByChannel?: Record<string, string>;
  /** Per-channel unread state; the badge folds the server snapshot (lane D #2). */
  unreadByChannel: Record<
    string,
    {
      unread_count: number;
      mention_count: number;
      server_unread_count?: number | null;
      server_mention_count?: number | null;
      last_read_id?: string | null;
    }
  >;
  threadIdsByChannel: Record<string, string[]>;
  threadsById: Record<string, Thread>;
  /**
   * Roster names, read by the #117 inbox rows ("who addressed you") and the
   * #94 start-DM picker (display name over @handle). Optional so structural
   * test fixtures that predate those sections stay valid.
   */
  membersById?: Record<
    string,
    | {
        username: string;
        /** The account's display name (#168). */
        display_name?: string | null;
        avatar_url?: string | null;
        nickname?: string | null;
        /**
         * Principal kind and its owning human, when the roster row carries
         * them — the DM rows draw the agent seal from these, and the picker
         * refuses to message a machine (owner report 2026-09-15). Optional so
         * structural fixtures that predate the distinction stay valid; an
         * absent kind reads as a person.
         */
        kind?: PrincipalKind | null;
        parent_user_id?: string | null;
        /** Who the agent will DM with (machine principals; absent = humans). */
        dm_support?: 'humans' | 'everyone' | 'none' | null;
      }
    | undefined
  >;
  /**
   * Workspace rosters — the #94 picker's scope guard: its pool is the
   * members of workspaces YOU share with them, never an instance directory.
   */
  memberIdsByWorkspace?: Record<string, string[]>;
  currentUser: { id: string } | null;
  /**
   * The member's notification levels (notification controls): a muted DM
   * row dims and drops its unread count. Optional so structural fixtures
   * stay valid; absent reads as "nothing set".
   */
  notificationPrefs?: NotificationPrefsState;
}

export interface HomeSidebarProps {
  store: HomeStore;
  /**
   * Presence by user id — the DM rows' avatar dots. Passed in rather than read
   * from a hook because this component's store is a structural slice (tests),
   * and because the shell already derives the live map once for the whole
   * surface. Absent reads as "nothing known", which renders as offline.
   */
  presence?: PresenceByUser;
  /** Active conversation (a DM while home is active) — highlights its row. */
  activeChannelId: string | null;
  onSelectDm: (channelId: string) => void;
  onSelectWorkspace: (workspaceId: string) => void;
  /** Mention-nav jump into a workspace channel (leaves Home). */
  onSelectChannel: (channelId: string) => void;
  onSelectThread: (threadId: string, channelId: string) => void;
  /**
   * Opens (or returns the existing) DM with a member and navigates into it
   * (#94) — the picker's selection path. Optional: the affordance renders
   * only when wired (structural fixtures without it keep working).
   */
  onStartDm?: (memberId: string) => Promise<Channel>;
  onCreateWorkspace: (input: { name: string }) => Promise<Workspace>;
  /**
   * #121 — the Server Settings entry, rendered ONLY for operators (the
   * `is_operator` flag from `/users/@me`; the routes stay gated
   * server-side — this decides the affordance, not the authority).
   */
  isOperator?: boolean;
  /**
   * #117's mention inbox, always present. It was in the message-column body,
   * where a member scrolling to it had no reason to expect it and its
   * disappearing act read as "there is no inbox".
   */
  inbox: UseInbox;
  onOpenServerSettings?: () => void;
}

/** Decimal-string snowflake compare, newest first (nulls sink). */
function snowflakeDesc(a: string | null, b: string | null): number {
  const av = a ? BigInt(a) : -1n;
  const bv = b ? BigInt(b) : -1n;
  if (av > bv) return -1;
  if (av < bv) return 1;
  return 0;
}

/** The DM row's display peer: the recipient that isn't the viewer. */
function dmPeer(
  channel: Channel,
  selfId: string | null,
): { id: string; name: string; avatarUrl?: string | null } {
  const recipient = channel.recipients?.find((r) => r.id !== selfId);
  return {
    id: recipient?.id ?? channel.id,
    // `||`, not `??`: the server's DM payload carries NO name field at all and
    // resolves `recipients` from the peer users, so a DM whose peer no longer
    // resolves arrives with an empty recipients list and `channel.name` filled
    // in as ''. The nullish chain accepted that empty string as a name, and the
    // row rendered as a bare avatar tile with no initials — a "huge green dot"
    // under the heading (user report 2026-09-14). Never let the initials helper
    // see undefined either.
    name: (recipient && displayNameOf(recipient)) || channel.name || 'Unknown',
    avatarUrl: recipient?.avatar_url ?? null,
  };
}

/** The roster entry for a DM's peer, when the peer shares a workspace. */
function peerMember(store: HomeSidebarProps['store'], peerId: string) {
  return store.membersById?.[peerId] ?? null;
}

export function HomeSidebar({
  store,
  presence = {},
  activeChannelId,
  onSelectDm,
  onSelectWorkspace,
  onSelectChannel,
  onSelectThread,
  onStartDm,
  onCreateWorkspace,
  isOperator,
  onOpenServerSettings,
  inbox,
}: HomeSidebarProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [dmPickerOpen, setDmPickerOpen] = useState(false);
  const selfId = store.currentUser?.id ?? null;

  // Newest known message id: the narrow recency slice the message hot path
  // keeps (it no longer rewrites the channel record per message), falling back
  // to the id REST hydration stored on the channel row.
  const lastMessageId = (channel: Channel): string | null =>
    store.lastMessageIdByChannel?.[channel.id] ?? channel.last_message_id;

  const dmChannels = Object.values(store.channels)
    .filter((c) => c.type === 'dm')
    .sort((a, b) => snowflakeDesc(lastMessageId(a), lastMessageId(b)) || snowflakeDesc(a.id, b.id));

  const recentThreads = Array.from(
    new Set(Object.values(store.threadIdsByChannel).flat()),
  )
    .map((id) => store.threadsById[id])
    .filter((t): t is Thread => t !== undefined && !t.archived)
    .sort((a, b) => snowflakeDesc(a.id, b.id))
    .slice(0, 5);

  const unreadFor = (channelId: string): number =>
    channelUnreadCount(store.unreadByChannel[channelId]);


  // The start-DM picker's pool: the rosters of the workspaces YOU belong to,
  // deduped by user — never an instance directory (#94 scope guard), and never
  // one row per shared workspace either. A person is ONE DM target whatever you
  // share with them, and listing them once per workspace showed the same human
  // twice under two workspace labels (user report 2026-09-14: "@mia under
  // EXAMPLE.COM and again under PLAYGROUND"). A DM is instance-wide — the roster
  // endpoint carries no workspace at all.
  const dmCandidates = useMemo<DmCandidate[]>(() => {
    const rowsById = store.membersById ?? {};
    const seen = new Map<string, DmCandidate>();
    for (const ids of Object.values(store.memberIdsByWorkspace ?? {})) {
      for (const id of ids) {
        if (id === selfId || seen.has(id)) continue;
        const row = rowsById[id];
        if (!row) continue;
        const parent = row.parent_user_id ? rowsById[row.parent_user_id] : null;
        seen.set(id, {
          id,
          username: row.username,
          avatar_url: row.avatar_url ?? null,
          nickname: row.nickname ?? null,
          display_name: row.display_name ?? null,
          // A machine credential is a principal like any other, and the picker
          // has to be able to SAY so: without the kind it listed agents as
          // ordinary people and let a DM be opened to one (owner report
          // 2026-09-15).
          kind: row.kind ?? null,
          parentName: parent ? displayNameOf(parent) : null,
          dmSupport: row.dm_support ?? null,
        });
      }
    }
    return [...seen.values()].sort((a, b) =>
      displayNameOf(a).localeCompare(displayNameOf(b)),
    );
  }, [store.memberIdsByWorkspace, store.membersById, selfId]);

  return (
    <div className="channel-sidebar" data-testid="home-sidebar">
      <div className="home-header" data-testid="home-header">
        <span className="home-wordmark">Hrmny</span>
        <HeaderActionsMenu
          triggerLabel="Hrmny actions"
          triggerTestId="home-actions"
          menuTestId="home-actions-menu"
          items={[
            {
              label: 'Create workspace',
              testId: 'home-actions-create-workspace',
              onSelect: () => setCreateOpen(true),
            },
            // #121: operator-only — hidden for everyone else (an operator is
            // the `is_operator` flag on /users/@me; the route it opens is
            // ALSO gated server-side, so a hidden link loses nothing).
            ...(isOperator && onOpenServerSettings
              ? [
                  {
                    label: 'Server settings',
                    testId: 'home-actions-server-settings',
                    onSelect: onOpenServerSettings,
                  },
                ]
              : []),
          ]}
        />
      </div>
      <CreateWorkspaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreateWorkspace={onCreateWorkspace}
      />
      {onStartDm ? (
        <StartDmPicker
          open={dmPickerOpen}
          onOpenChange={setDmPickerOpen}
          candidates={dmCandidates}
          onStartDm={onStartDm}
        />
      ) : null}

      <div className="channel-list" aria-label="Home navigation">
        <section aria-label="Direct Messages">
          {/* The section's own affordance, in its heading — a lone ＋ at the
              heading's right edge, where the rows' trailing controls sit. It
              replaces the full-width "Start conversation" row, which cost a
              line of the column and read as a conversation of its own (user
              direction 2026-09-14), and it is present in the empty state too,
              so a new member still finds it without the inline duplicate. */}
          <h3 className="category-label">
            Direct Messages
            {onStartDm ? (
              <button
                type="button"
                className="dm-add"
                data-testid="dm-start"
                aria-label="Start a conversation"
                title="Start a conversation"
                onClick={() => setDmPickerOpen(true)}
              >
                ＋
              </button>
            ) : null}
          </h3>
          {dmChannels.length === 0 ? (
            <p className="home-empty" data-testid="home-dms-empty">
              No conversations yet — DMs you open appear here.
            </p>
          ) : (
            <>
              <ul className="category-channels">
              {dmChannels.map((channel) => {
                const peer = dmPeer(channel, selfId);
                const member = peerMember(store, peer.id);
                const kind = member?.kind ?? null;
                const parent = member?.parent_user_id
                  ? peerMember(store, member.parent_user_id)
                  : null;
                const parentName = parent ? displayNameOf(parent) : undefined;
                const unread = unreadFor(channel.id);
                const mentions = channelMentionCount(store.unreadByChannel[channel.id]);
                // A DM has no workspace: its chain is the DM row, then the
                // account. Only a mute changes how a conversation row reads.
                const level = dmRowLevel(rowLevel(store.notificationPrefs, { channelId: channel.id }));
                return (
                  <li key={channel.id} className="channel-list-item">
                    <button
                      type="button"
                      className="channel-row home-row"
                      data-active={channel.id === activeChannelId || undefined}
                      {...rowNotificationAttrs(level, unread)}
                      aria-current={channel.id === activeChannelId ? 'page' : undefined}
                      data-testid={`home-dm-${channel.id}`}
                      onClick={() => onSelectDm(channel.id)}
                    >
                      {/* Presence for EVERY peer, people and agents alike: an
                          agent goes offline when its connection drops, which is
                          exactly what a reader wants to see on its DM row
                          (owner direction 2026-09-15). The seal sits opposite
                          the dot, so a machine carries both. */}
                      <Avatar
                        id={peer.id}
                        name={peer.name}
                        src={peer.avatarUrl}
                        className="home-avatar"
                        data-presence={presenceOf(presence, peer.id)}
                        kind={kind}
                        parentName={parentName}
                      />
                      <span className="channel-name">{peer.name}</span>
                      {kindTitle(kind, parentName) ? (
                        <span className="sr-only">{kindTitle(kind, parentName)}</span>
                      ) : null}
                      {/* The row's name is its content, so "muted" joins it as
                          words (the glyph is decorative). */}
                      {level === 'mute' ? <span className="sr-only">{levelNameSuffix(level)}</span> : null}
                      {level === 'mute' ? <MutedGlyph testId={`home-dm-muted-${channel.id}`} /> : null}
                      {/* The channel row's badge rule: mention wins, one badge. */}
                      <SidebarRowBadge
                        unread={unread}
                        mentions={mentions}
                        level={level}
                        mentionsTestId={`home-dm-mentions-${channel.id}`}
                        unreadTestId={`home-dm-unread-${channel.id}`}
                      />
                    </button>
                  </li>
                );
              })}
              </ul>
            </>
          )}
        </section>

        {/* ALWAYS present: this surface used to vanish until it had something
            to say, which is how the owner concluded there was no inbox at all.
            A steady heading with an honest empty line beats saving the
            vertical space. */}
        <InboxSection
          store={store}
          variant="column"
          items={inbox.items}
          status={inbox.status}
          error={inbox.error}
          actionError={inbox.actionError}
          busy={inbox.busy}
          onDismiss={inbox.dismiss}
          onSweep={inbox.sweep}
          onRetry={inbox.retry}
        />

        {recentThreads.length > 0 ? (
          <section aria-label="Recent threads">
            <h3 className="category-label">Threads</h3>
            <ul className="category-channels">
              {recentThreads.map((thread) => (
                <li key={thread.id} className="channel-list-item">
                  <button
                    type="button"
                    className="channel-row home-row"
                    data-testid={`home-thread-${thread.id}`}
                    onClick={() => onSelectThread(thread.id, thread.channel_id)}
                  >
                    <span className="channel-prefix" aria-hidden="true">
                      <ThreadIcon size={16} />
                    </span>
                    <span className="channel-name">{thread.name}</span>
                    <span className="home-row-sub">
                      #{store.channels[thread.channel_id]?.name ?? 'channel'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

      </div>
    </div>
  );
}
