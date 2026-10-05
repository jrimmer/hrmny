/**
 * @cytale/web — ChannelSidebar (U20).
 *
 * The channel list region: workspace switcher rail + category-grouped channel
 * list with unread/mention indicators. State-driven: reads workspaces,
 * channels, and unread from the U17 store seam (`useSidebarProjection`);
 * selecting a channel or workspace calls back so the app shell can set the
 * active view.
 *
 * Grouping: the domain `Channel` carries no category field, so grouping is
 * supplied as an ordered `categories` prop (label → channel ids). When absent,
 * all channels render under a single "Channels" group. This keeps the
 * component state-driven and testable without inventing a domain field.
 *
 * Server header (Discord parity): the workspace name + caret opens the
 * workspace options menu (WorkspaceMenu); the ＋ action creates a channel
 * in the active workspace (or a first workspace during a fresh install).
 * The dialogs call back via onCreateChannel / onCreateInvite /
 * onCreateWorkspace so the app shell owns the API + store seam; menu items
 * and dialogs only render for the callbacks the host actually provides.
 *
 * Responsive: the AppShell (U18) owns the mobile drawer; this component
 * renders the sidebar content that the shell places in the drawer or the
 * static rail.
 */

import { Fragment, useCallback, useState } from 'react';

import { CallSlot } from '../calls/CallSlot.js';

import type { Channel, Workspace } from '@cytale/domain';

import { ChannelListItem } from './ChannelListItem.js';
import { ChannelSettingsDialog } from './ChannelSettingsDialog.js';
import { CategoryGroup } from './CategoryGroup.js';
import { CreateChannelDialog } from './CreateChannelDialog.js';
import { CreateWorkspaceDialog } from './CreateWorkspaceDialog.js';
import { InvitePeopleDialog, type CreateInviteInput } from './InvitePeopleDialog.js';
import { MediaSettingsDialog } from './MediaSettingsDialog.js';
import { NicknameDialog } from './NicknameDialog.js';
import { WorkspaceMenu } from './WorkspaceMenu.js';
import { WorkspaceSwitcher } from './WorkspaceSwitcher.js';
import {
  useSidebarProjection,
  type SidebarStore,
} from './useSidebarProjection.js';

export interface ChannelCategorySpec {
  label: string;
  channelIds: string[];
}

export interface ChannelSidebarProps {
  /** U17 store projection; null while bootstrapping. */
  store?: SidebarStore | null;
  /** Active workspace id (rail selection). */
  activeWorkspaceId: string | null;
  /** Active channel id (list selection). */
  activeChannelId: string | null;
  /** Optional category grouping (label → channel ids). */
  categories?: ChannelCategorySpec[];
  /** Called when a channel is selected. */
  onSelectChannel?: (channelId: string) => void;
  /** Called when a workspace is selected. */
  onSelectWorkspace?: (workspaceId: string) => void;
  /** Server identity band (name above the channel list). */
  serverName?: string;
  /** Hide the embedded switcher when the shell rail owns it. */
  showWorkspaceSwitcher?: boolean;
  /** Creates a channel (or category) in the active workspace. */
  onCreateChannel?: (input: {
    name: string;
    topic?: string;
    type?: 'text' | 'category';
    parent_id?: string | null;
  }) => Promise<Channel>;
  /** Persists channel settings (name/topic/category) from the gear menu. */
  onUpdateChannel?: (
    channelId: string,
    patch: { name?: string; topic?: string | null; parent_id?: string | null },
  ) => Promise<void>;
  /** Mints an invite for the active workspace (server header menu). */
  onCreateInvite?: (input: CreateInviteInput) => Promise<{ code: string }>;
  /** Creates a workspace (fresh-install path). */
  onCreateWorkspace?: (input: { name: string }) => Promise<Workspace>;
  /** Opens the channel's thread roster (active + archived) from the gear. */
  onOpenThreads?: (channelId: string) => void;
  /** Opens the integrations surface (U13). */
  onOpenIntegrations?: () => void;
  /** Opens the workspace settings surface (⌄ menu's gear). */
  onOpenWorkspaceSettings?: () => void;
}

export function ChannelSidebar({
  store = null,
  activeWorkspaceId,
  activeChannelId,
  categories: categoriesProp,
  onSelectChannel,
  onSelectWorkspace,
  serverName,
  showWorkspaceSwitcher = true,
  onCreateChannel,
  onUpdateChannel,
  onOpenThreads,
  onCreateInvite,
  onCreateWorkspace,
  onOpenIntegrations,
  onOpenWorkspaceSettings,
}: ChannelSidebarProps) {
  // Stable (lane D #17): the rows are memoized, and an inline arrow here
  // re-rendered every row on every sidebar render.
  const openChannelSettings = useCallback((id: string) => setSettingsChannelId(id), []);
  const { workspaces, channels, categories, unreadFor, mentionsFor, workspaceUnread, workspaceMentions, liveCallFor, ringingFor } =
    useSidebarProjection(store, activeWorkspaceId);

  // The channel whose settings dialog is open (gear menu entry).
  const [settingsChannelId, setSettingsChannelId] = useState<string | null>(null);

  // Which server-header dialog is open (menu items + the ＋ action target it).
  const [headerDialog, setHeaderDialog] = useState<
    'invite' | 'create-channel' | 'create-workspace' | 'media-settings' | 'nickname' | null
  >(null);
  const hasActiveWorkspace = activeWorkspaceId != null;

  const byId = new Map<string, Channel>(channels.map((c) => [c.id, c]));

  // Resolve the ordered groups: an explicit host grouping wins; otherwise
  // the workspace's own category rows (server order) group their children,
  // with parentless channels first under the standing "Channels" header —
  // the section exists whether or not categories do (owner report
  // 2026-09-15: it used to lose its header once any category existed).
  const groups: ChannelCategorySpec[] =
    categoriesProp && categoriesProp.length > 0
      ? categoriesProp
      : categories.length === 0
        ? // No categories anywhere: the original single group (unchanged UX).
          [{ label: 'Channels', channelIds: channels.map((c) => c.id) }]
        : (() => {
            const grouped: ChannelCategorySpec[] = [];
            const ungrouped = channels.filter(
              (c) => !c.parent_id || !categories.some((cat) => cat.id === c.parent_id),
            );
            if (ungrouped.length > 0) {
              // Owner report 2026-09-15: the ungrouped section's header used to
              // VANISH the moment the first category existed, stranding its
              // channels under nothing while an empty category rendered as a
              // bare header. The header stays — it is the same "Channels"
              // section the zero-categories case shows, not an error state.
              grouped.push({ label: 'Channels', channelIds: ungrouped.map((c) => c.id) });
            }
            for (const cat of categories) {
              const ids = channels.filter((c) => c.parent_id === cat.id).map((c) => c.id);
              grouped.push({ label: cat.name, channelIds: ids });
            }
            return grouped;
          })();

  return (
    <div className="channel-sidebar" data-testid="channel-sidebar">
      {serverName !== undefined ? (
        <div className="server-header" data-testid="server-header">
          <WorkspaceMenu
            workspaceName={serverName}
            hasActiveWorkspace={hasActiveWorkspace}
            workspaceId={activeWorkspaceId}
            onInvitePeople={onCreateInvite ? () => setHeaderDialog('invite') : undefined}
            onCreateChannel={
              onCreateChannel ? () => setHeaderDialog('create-channel') : undefined
            }
            onCreateWorkspace={
              onCreateWorkspace ? () => setHeaderDialog('create-workspace') : undefined
            }
            onOpenIntegrations={onOpenIntegrations}
            onOpenWorkspaceSettings={onOpenWorkspaceSettings}
            onOpenMediaSettings={hasActiveWorkspace ? () => setHeaderDialog('media-settings') : undefined}
            onChangeNickname={hasActiveWorkspace ? () => setHeaderDialog('nickname') : undefined}
          />
          {/* Owner direction 2026-09-12: the ⋯ Actions button is gone. Its only
              item ("Create channel", or "Create workspace" with nothing
              active) is already carried by the workspace menu, which the same
              header's gear now opens — see WorkspaceMenu. One trigger, one
              menu: the name is a label, the gear carries the actions. */}
        </div>
      ) : null}

      {onCreateChannel ? (
        <CreateChannelDialog
          open={headerDialog === 'create-channel'}
          onOpenChange={(open) => {
            if (!open) setHeaderDialog(null);
          }}
          categories={categories.map((c) => ({ id: c.id, name: c.name }))}
          onCreateChannel={onCreateChannel}
        />
      ) : null}

      {onCreateInvite ? (
        <InvitePeopleDialog
          open={headerDialog === 'invite'}
          onOpenChange={(open) => {
            if (!open) setHeaderDialog(null);
          }}
          onCreateInvite={onCreateInvite}
        />
      ) : null}

      {onCreateWorkspace ? (
        <CreateWorkspaceDialog
          open={headerDialog === 'create-workspace'}
          onOpenChange={(open) => {
            if (!open) setHeaderDialog(null);
          }}
          onCreateWorkspace={onCreateWorkspace}
        />
      ) : null}

      {/* Workspace media settings (calls V2 plan U8): self-contained api
          seam — the dialog renders its own permission-denied state, so the
          menu entry shows for every member (server-side honesty). */}
      <MediaSettingsDialog
        open={headerDialog === 'media-settings'}
        onOpenChange={(open) => {
          if (!open) setHeaderDialog(null);
        }}
        workspaceId={activeWorkspaceId}
      />

      {/* Your nickname in this workspace (#169): every member may set their
          own (CHANGE_NICKNAME is in the @everyone base). */}
      <NicknameDialog
        open={headerDialog === 'nickname'}
        onOpenChange={(open) => {
          if (!open) setHeaderDialog(null);
        }}
        workspaceId={activeWorkspaceId ?? null}
        userId="@me"
      />

      {showWorkspaceSwitcher ? (
        <WorkspaceSwitcher
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspaceId}
          unreadFor={workspaceUnread}
          mentionsFor={workspaceMentions}
          onSelect={onSelectWorkspace}
        />
      ) : null}

      <div className="channel-list" aria-label="Channels">
        {groups.map((group) => {
          const groupChannels = group.channelIds
            .map((id) => byId.get(id))
            .filter((c): c is Channel => Boolean(c));
          if (groupChannels.length === 0) return null;
          return (
            <CategoryGroup key={group.label} label={group.label}>
              {groupChannels.map((channel) => {
                // Live call projection (R3): the slot renders ONLY while a
                // call is live in that channel — an idle channel leaves no
                // dead row behind, and CALL_END simply unmounts the slot.
                const liveCall = liveCallFor(channel.id);
                const ringing = ringingFor(channel.id);
                return (
                  <Fragment key={channel.id}>
                    <ChannelListItem
                      channel={channel}
                      active={channel.id === activeChannelId}
                      onOpenSettings={onUpdateChannel ? openChannelSettings : undefined}
                      onOpenThreads={onOpenThreads}
                      unread={unreadFor(channel.id)}
                      mentions={mentionsFor(channel.id)}
                      live={liveCall !== null}
                      ringing={ringing}
                      onSelect={onSelectChannel}
                    />
                    {liveCall ? (
                      <CallSlot
                        channelId={channel.id}
                        roster={liveCall.roster}
                        members={store?.membersById}
                        nicknames={store?.nicknamesByWorkspace?.[channel.workspace_id ?? '']}
                        joined={liveCall.joined}
                        ringing={ringing}
                      />
                    ) : null}
                  </Fragment>
                );
              })}
            </CategoryGroup>
          );
        })}
      </div>

      <ChannelSettingsDialog
        open={settingsChannelId !== null}
        onOpenChange={(o) => {
          if (!o) setSettingsChannelId(null);
        }}
        channel={settingsChannelId !== null ? (byId.get(settingsChannelId) ?? null) : null}
        categories={categories.map((c) => ({ id: c.id, name: c.name }))}
        onSave={async (patch) => {
          if (settingsChannelId !== null && onUpdateChannel) {
            await onUpdateChannel(settingsChannelId, patch);
          }
        }}
      />
    </div>
  );
}
