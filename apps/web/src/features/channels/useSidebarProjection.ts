/**
 * @cytale/web — Channel Sidebar store seam (U20).
 *
 * The plan reads workspaces/channels/unread from the U17 state store. This
 * module defines a MINIMAL local projection over a store-like shape so the
 * sidebar is testable without wiring the full gateway hydration. It is a
 * seam, not a reimplementation: when the real U17 `StateState` slices are
 * wired (workspaces, channels, unreadByChannel, memberIdsByWorkspace), this
 * hook's input type is satisfied without changing the surface.
 *
 * NOTE (evidence): no `packages/**` edits per task rules — the local hook is
 * the documented seam until the store is wired at the app shell.
 */

import { useMemo } from 'react';

import type { Channel, Workspace } from '@cytale/domain';
import {
  channelMentionCount,
  channelUnreadCount,
  selectCallRoster,
  selectIsInCall,
  selectLiveCall,
  selectParticipantCount,
  type CallParticipantState,
  type CallRingEntry,
  type LiveCall,
  type StateState,
} from '@cytale/state';

/** Minimal store projection the sidebar reads (U17-compatible shape). */
export interface SidebarStore {
  workspaces: Record<string, Workspace>;
  channels: Record<string, Channel>;
  /**
   * Per-channel unread state (U17 unreadByChannel). The badge reads the
   * server snapshot plus live accrual (lane D #2); the server fields are
   * optional so structural test fixtures stay valid.
   */
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
  /** Workspace → channel ids (U17 channel list per workspace). */
  channelIdsByWorkspace: Record<string, string[]>;
  /** Workspace → member ids (for the rail's per-workspace unread badge). */
  memberIdsByWorkspace: Record<string, string[]>;
  /**
   * Roster rows by user id — the call slot's avatars name and draw their
   * participants from it. Optional so bare-bones test stores keep compiling.
   */
  membersById?: Record<
    string,
    | { username: string; nickname?: string | null; display_name?: string | null; avatar_url?: string | null }
    | undefined
  >;
  /** Per-workspace nicknames (#169) — the call slot names participants by them. */
  nicknamesByWorkspace?: Record<string, Record<string, string>>;
  /**
   * Live room calls by channel (calls plan U6 slice). Optional so bare-bones
   * test stores keep compiling; the real U17 store satisfies it structurally
   * (AuthenticatedApp spreads the full StateState in). Absence = no calls.
   */
  callByChannel?: Record<string, LiveCall | undefined>;
  /** Live DM calls by channel (R11 — separate slice; sidebar slot fallback). */
  dmCallByChannel?: Record<string, LiveCall | undefined>;
  /**
   * Ephemeral ring notifications by channel (calls plan U6/U11): presence of
   * an entry = the channel row's transient ringing emphasis (the ring's
   * visual equivalent while the ring toast is live).
   */
  callRingByChannel?: Record<string, CallRingEntry | undefined>;
  /** The signed-in viewer (drives the slot's joined read; null = anonymous). */
  currentUser?: StateState['currentUser'];
}

/** The call-facing projection of one channel's sidebar row (calls plan U7). */
export interface SidebarLiveCall {
  /** The live call record (call_id, boundary metadata). */
  call: LiveCall;
  /** Roster sorted by user id (stable rendering; U6 selectCallRoster). */
  roster: CallParticipantState[];
  /** Voice-leg count for the avatar stack / count pill. */
  participantCount: number;
  /** True when the VIEWER holds a leg (slot click = return, AM18). */
  joined: boolean;
}

export interface SidebarProjection {
  workspaces: Workspace[];
  /** Text channels of the active workspace, sorted by position. */
  channels: Channel[];
  /** Category rows of the active workspace (type 'category'), by position. */
  categories: Channel[];
  /** Unread count for a channel (0 when none). */
  unreadFor(channelId: string): number;
  /** Mention count for a channel (0 when none). */
  mentionsFor(channelId: string): number;
  /** Total unread across a workspace's channels (rail badge). */
  workspaceUnread(workspaceId: string): number;
  /** Total mentions across a workspace's channels (the rail badge's red half). */
  workspaceMentions(workspaceId: string): number;
  /**
   * The live call on a channel (null when idle — R3: no call, no slot row).
   * An empty roster (SYNC in flight) still returns a summary so the slot
   * renders placeholders rather than nothing.
   */
  liveCallFor(channelId: string): SidebarLiveCall | null;
  /**
   * True while a call in the channel is ringing this client (U11): the
   * row/slot emphasis riding the ring slice's lifetime.
   */
  ringingFor(channelId: string): boolean;
}

/**
 * Derive the sidebar projection from the store. Falls back to empty lists
 * when the store has no data (loading/empty states are the surface's
 * concern).
 */
export function useSidebarProjection(
  store: SidebarStore | null,
  activeWorkspaceId: string | null,
): SidebarProjection {
  return useMemo(() => {
    if (!store) {
      return {
        workspaces: [],
        channels: [],
        categories: [],
        unreadFor: () => 0,
        mentionsFor: () => 0,
        workspaceUnread: () => 0,
        workspaceMentions: () => 0,
        liveCallFor: () => null,
        ringingFor: () => false,
      };
    }

    const workspaces = Object.values(store.workspaces);
    const channelIds = activeWorkspaceId
      ? (store.channelIdsByWorkspace[activeWorkspaceId] ?? [])
      : [];
    const allChannels = channelIds
      .map((id) => store.channels[id])
      .filter((c): c is Channel => Boolean(c))
      .sort((a, b) => a.position - b.position);

    // Categories are channel rows of type 'category'; text channels file
    // under them via parent_id. The sidebar renders: parentless channels
    // first (no header), then each category with its children (server order:
    // category-first, then position).
    const categories = allChannels.filter((c) => c.type === 'category');
    const channels = allChannels.filter((c) => c.type !== 'category');

    // Lane D #2: the ONE badge rule (server snapshot + live accrual). The
    // local count alone read zero after every reload.
    const unreadFor = (channelId: string): number =>
      channelUnreadCount(store.unreadByChannel[channelId]);
    const mentionsFor = (channelId: string): number =>
      channelMentionCount(store.unreadByChannel[channelId]);

    const workspaceUnread = (workspaceId: string): number => {
      const ids = store.channelIdsByWorkspace[workspaceId] ?? [];
      return ids.reduce((sum, id) => sum + unreadFor(id), 0);
    };
    const workspaceMentions = (workspaceId: string): number => {
      const ids = store.channelIdsByWorkspace[workspaceId] ?? [];
      return ids.reduce((sum, id) => sum + mentionsFor(id), 0);
    };

    // Call projection (calls plan U7): the U6 selectors read exactly the two
    // call slices off a StateState, so the (optional) SidebarStore fields are
    // adapted into that shape here — absent slices behave as empty ones.
    const callState = {
      callByChannel: store.callByChannel ?? {},
      dmCallByChannel: store.dmCallByChannel ?? {},
    } as StateState;
    const viewerId = store.currentUser?.id ?? null;
    const liveCallFor = (channelId: string): SidebarLiveCall | null => {
      const call = selectLiveCall(callState, channelId);
      if (call === undefined) return null;
      return {
        call,
        roster: selectCallRoster(callState, channelId),
        participantCount: selectParticipantCount(callState, channelId),
        joined: viewerId !== null && selectIsInCall(callState, channelId, viewerId),
      };
    };
    // Ringing emphasis (U11): an entry in the ring slice = ring live on the
    // channel (its lifetime IS the toast's — mount → expiry/dismiss/join).
    const ringingFor = (channelId: string): boolean =>
      store.callRingByChannel?.[channelId] !== undefined;

    return {
      workspaces,
      channels,
      categories,
      unreadFor,
      mentionsFor,
      workspaceUnread,
      workspaceMentions,
      liveCallFor,
      ringingFor,
    };
  }, [store, activeWorkspaceId]);
}
