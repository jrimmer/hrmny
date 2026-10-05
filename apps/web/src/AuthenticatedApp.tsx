/**
 * Cytale web — the authenticated application shell.
 *
 * Split from the entry on purpose (#21): everything heavy (Lexical composer,
 * virtuoso list, Radix overlays, the full feature surfaces) lives behind
 * this module's dynamic import, so the unauthenticated boot path (login)
 * ships a tiny entry chunk. The entry lazy-loads this module at the auth
 * gate.
 */
import {
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { ReactNode } from 'react';

import {
  applyGatewayEvent,
  channelMentionCount,
  channelUnreadCount,
  defaultStore,
  nextSyntheticSeq,
  replaceMembers,
  replaceRoster,
  replaceThreads,
  startMemberResolver,
  touchChannel,
  type MemberResolver,
  type StateState,
  type StateStore,
} from '@cytale/state';
import type { Channel, Message, Thread, Workspace, WorkspaceMember } from '@cytale/domain';
import { parsePermalinkPath } from '@cytale/domain';
import type { CurrentUser } from '@cytale/api-client';

import { useShellStore, useThreadParentMessage } from './app/useShellStore.js';
import { useStoreSelector, useStoreSlices } from './app/useStoreSelector.js';
import { mapWithConcurrency } from './lib/concurrency.js';
import { dismissBootCover } from './app/boot/splash.js';
import { readLastLocation, writeLastLocation } from './app/lastLocation.js';
import { startGapRepair } from './app/gapRepair.js';
import {
  AccountSection,
  AgentsSection,
  AllCallsList,
  AppearanceSection,
  CallLogStandalone,
  CallPanelSurface,
  NotificationsSection,
  OmnisearchDialog,
  PeopleDirectory,
  prefetchSecondarySurfaces,
  ProfileCard,
  ReactionEmojiSection,
  ReleaseNotesPane,
  ServerSettingsPage,
  SshSection,
  ThreadsListDialog,
  ThreadsListPanel,
  WebhooksSection,
  WorkspaceOverview,
} from './app/lazySurfaces.js';

import { headerIconButtonClass } from './app/ui/button.js';
import { AppShell } from './app/layout/AppShell.js';
import { ContextRail } from './app/layout/ContextRail.js';
import { WorkspaceRail } from './app/layout/WorkspaceRail.js';
import { UserPanel } from './app/layout/UserPanel.js';
import { VersionBadge } from './app/layout/VersionBadge.js';
import { TopbarCallAction } from './app/layout/MobileTopbar.js';
import { NotificationLevelControl } from './features/notifications/NotificationLevelControl.js';
import {
  channelTarget,
  hydrateNotificationPrefs,
  setTargetLevel,
  setWorkspaceBroadcastSuppressed,
  workspaceTarget,
  accountTarget,
} from './features/notifications/notificationPrefs.js';
import { useShellBand } from './app/layout/useShellBand.js';
import { RailIcons, type RailMode } from './app/layout/RailIcons.js';
import { useAuth } from './features/auth/index.js';
import { session, api, authStore } from './features/auth/session.js';
import { useHashRoute } from './features/auth/router.js';
import { useOnlineStatus } from './app/pwa/useOnlineStatus.js';
import { startSendAutoRetry } from './features/messages/sendAutoRetry.js';
import { notificationClickPath, type NotificationTarget } from './app/pwa/notificationClick.js';
import { RingToasts, useCallEngineState } from './features/calls/index.js';
import { useChannelCallHeader } from './features/calls/useChannelCallHeader.js';
import { useChannelCallGate } from './features/channels/useChannelCallGate.js';
import { useCanCreateInvites, useWorkspaceCan } from './features/channels/useCanCreateInvites.js';
import { NicknameDialog } from './features/channels/NicknameDialog.js';
import { WorkspaceSwitcher, RailIcon } from './features/channels/WorkspaceSwitcher.js';
import { ChannelSidebar, type ChannelSidebarProps } from './features/channels/ChannelSidebar.js';
import { acceptInvite, InviteLandingPage } from './features/channels/index.js';
import { useInbox, type UseInbox } from './features/home/useInbox.js';
import { HomeDashboard, HomeSidebar } from './features/home/index.js';
import type { HomeDashboardProps } from './features/home/HomeDashboard.js';
import type { HomeSidebarProps } from './features/home/HomeSidebar.js';
import { makeStartDm } from './features/home/startDm.js';
import { MyThreadsSidebar } from './features/threads/MyThreadsSidebar.js';
import { useThreads } from './features/threads/useThreads.js';
import { MessagePane } from './features/messages/MessagePane.js';
import { shouldDefaultChannel } from './features/messages/channelSelection.js';
import { PathPermalinkNotice, usePathPermalink } from './features/messages/index.js';
import { ThreadSurface } from './features/threads/ThreadSidePanel.js';
import { fetchPeoplePage, memberFromPeopleRow } from './features/directory/api.js';
import { enrollPasskey } from './features/auth/passkeys.js';
import { PasskeyEnrollmentPrompt } from './features/auth/PasskeyEnrollmentPrompt.js';
import type { PeopleMember } from './features/directory/types.js';
import type { SelfStatus } from './features/presence/PresenceMenu.js';
import {
  disablePushSubscription,
  enablePushSubscription,
  hasPushSubscription,
} from './app/pwa/pushSubscription.js';
import {
  NotificationPrompt,
  clearPromptDismissal,
} from './app/pwa/NotificationPrompt.js';
// Route hooks and constants come from their OWN modules, never the feature
// barrels: a barrel re-exports the (lazy, lane D #7) surfaces too, and one
// static import of it would pull them all back into this chunk.
import {
  aliasLegacyIntegrationsPath,
  SETTINGS_ROUTE_PREFIX,
  useSettingsRoute,
} from './features/settings/router.js';
import { SettingsNav, sectionTitle } from './features/settings/SettingsNav.js';
import { SettingsPane } from './features/settings/SettingsPane.js';
import type { ChannelOption, TreeWorkspace } from './features/settings/types.js';
import {
  resolveFromOverrides,
  type NotificationRow,
} from './features/settings/notificationLevels.js';
import { readNotificationPermission } from './features/settings/notificationPermission.js';
import { WSETTINGS_ROUTE_PREFIX, useWSettingsRoute } from './features/wsettings/router.js';
import { WorkspaceSettingsNav } from './features/wsettings/WorkspaceSettingsNav.js';
import { useServerSettingsRoute } from './features/serversettings/router.js';
import { useReleaseNotesRoute } from './features/releasenotes/router.js';
import { displayNameOf } from '@cytale/domain';

/**
 * Invite code parked across the login/register hop (flow F1): the landing
 * page stashes it before navigating to auth; the first authenticated render
 * with no other route resumes it so the join intent survives the hop.
 */
const PENDING_INVITE_KEY = 'cytale.pending-invite';

function readPendingInvite(): string | null {
  try {
    return sessionStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

/**
 * Boot hydration's per-channel fan-out width (hardening plan 7.2). The
 * thread-roster leg used to run one `listThreads` per channel SERIALLY, so a
 * workspace with many channels stretched boot by one round-trip each before
 * the shell was usable. Four in flight is the small fixed pool: enough to
 * overlap latency without piling every channel onto the socket that is also
 * carrying the gateway's identify/resume (see `mapWithConcurrency`).
 */
const HYDRATION_FANOUT_LIMIT = 4;

/**
 * How long the boot cover may wait for the member's roster before the shell
 * shows itself anyway (lane D #3). The cover is the honest "loading" state:
 * the shell used to paint Home (and an empty sidebar) on its first frame for
 * every member, because nothing was known yet. It comes down the moment the
 * roster lands — READY carries it, or the device snapshot restored it — and
 * this bound only covers a server that is slow to answer.
 */
const ROSTER_COVER_MAX_WAIT_MS = 4_000;

/** workspace → channel ids (U17 has no prebuilt index). */
/**
 * The rail modes Home offers: the cross-workspace Call log and the Threads
 * you follow. No Members — a member list outside a room is what the owner
 * took off Home (2026-09-14), and the column itself only opens on request.
 */
const HOME_RAIL_MODES: readonly RailMode[] = ['calls', 'threads'];

/** What a channel address that names nothing this reader can open says (#channel pills). */
const CHANNEL_ROUTE_UNAVAILABLE =
  "That channel isn't available — it may have been deleted, or you may not have access to it.";
/** How long that notice stays up when nothing else clears it first. */
const CHANNEL_ROUTE_NOTICE_MS = 6_000;

/**
 * Put the address back to the bare route IN PLACE — no new history entry, so
 * Back still goes where it went — when it names a channel route (`path`) the
 * shell has finished with. `replaceState` fires no `hashchange`, so one is
 * dispatched: the hash router (`useHashRoute`) re-reads the address on it, and
 * the same address arriving again later (the same pill clicked twice) is then
 * a change it sees.
 */
function clearHashRoute(path: string): void {
  if (typeof window === 'undefined') return;
  if (window.location.hash !== `#${path}`) return;
  try {
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#/`);
  } catch {
    return;
  }
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

function channelIndex(channels: StateState['channels']): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  for (const ch of Object.values(channels)) {
    const ws = ch.workspace_id;
    if (ws == null) continue;
    (index[ws] ??= []).push(ch.id);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Live-data leaves (lane D #17)
//
// Unread counts, presence and recency change with nearly every gateway event.
// They used to ride the SHELL's snapshot (`useShellStore`), so a message in
// any channel re-rendered the 2,000-line shell to update one badge. Each
// surface that shows them now subscribes to exactly the slices it reads, and
// the shell's gate no longer includes them.
// ---------------------------------------------------------------------------

const SIDEBAR_SLICES = [
  'workspaces',
  'channels',
  'unreadByChannel',
  'memberIdsByWorkspace',
  'callByChannel',
  'dmCallByChannel',
  'callRingByChannel',
  'currentUser',
] as const satisfies readonly (keyof StateState)[];

/** The workspace sidebar, fed by its own slice subscription. */
function LiveChannelSidebar(props: Omit<ChannelSidebarProps, 'store'>) {
  const snap = useStoreSlices(defaultStore, SIDEBAR_SLICES);
  const channelIdsByWorkspace = useMemo(() => channelIndex(snap.channels), [snap.channels]);
  const store = useMemo(() => ({ ...snap, channelIdsByWorkspace }), [snap, channelIdsByWorkspace]);
  return <ChannelSidebar {...props} store={store} />;
}

const HOME_SLICES = [
  'workspaces',
  'channels',
  // The DM rows read at the member's notification level (a muted DM dims).
  'notificationPrefs',
  'lastMessageIdByChannel',
  'unreadByChannel',
  'threadIdsByChannel',
  'threadsById',
  'membersById',
  'memberIdsByWorkspace',
  'currentUser',
] as const satisfies readonly (keyof StateState)[];

type Presence = 'online' | 'idle' | 'dnd' | 'offline';

/**
 * The directory's presence map: gateway-reported statuses, plus self as
 * `selfDisplay` while the session is live (the server does not echo our own
 * presence back). Subscribed on its own, so a presence tick re-renders the
 * surfaces that show presence — not the shell.
 */
function useLivePresence(self: { id: string | null; display: Presence; online: boolean }): Record<string, Presence> {
  const presenceByUser = useStoreSelector(defaultStore, (st) => st.presenceByUser);
  return useMemo(() => {
    const out: Record<string, Presence> = {};
    for (const [id, p] of Object.entries(presenceByUser)) out[id] = p.status;
    if (self.online && self.id !== null) out[self.id] = self.display;
    return out;
  }, [presenceByUser, self.id, self.display, self.online]);
}

type SelfPresence = { id: string | null; display: Presence; online: boolean };

/** The Home column, fed by its own slice + presence subscriptions. */
function LiveHomeSidebar(props: Omit<HomeSidebarProps, 'store' | 'presence'> & { self: SelfPresence }) {
  const { self, ...rest } = props;
  const snap = useStoreSlices(defaultStore, HOME_SLICES);
  const presence = useLivePresence(self);
  return <HomeSidebar {...rest} store={snap} presence={presence} />;
}

/** The Home body, fed by its own slice subscription. */
function LiveHomeDashboard(props: Omit<HomeDashboardProps, 'store'>) {
  const snap = useStoreSlices(defaultStore, HOME_SLICES);
  return <HomeDashboard {...props} store={snap} />;
}

/** The rail's workspace icons with their unread + mention totals (one subscription). */
function LiveWorkspaceSwitcher(
  props: Omit<Parameters<typeof WorkspaceSwitcher>[0], 'unreadFor' | 'mentionsFor'>,
) {
  const channels = useStoreSelector(defaultStore, (st) => st.channels);
  const index = useMemo(() => channelIndex(channels), [channels]);
  // Per-workspace totals as ONE record, compared by value, so an unread tick
  // that does not change any total re-renders nothing. `u:`/`m:` keys hold
  // the unread and mention halves (the badge is red only for mentions).
  const totals = useStoreSelector(
    defaultStore,
    (st) => {
      const out: Record<string, number> = {};
      for (const [ws, ids] of Object.entries(index)) {
        let unread = 0;
        let mentions = 0;
        for (const id of ids) {
          unread += channelUnreadCount(st.unreadByChannel[id]);
          mentions += channelMentionCount(st.unreadByChannel[id]);
        }
        out[`u:${ws}`] = unread;
        out[`m:${ws}`] = mentions;
      }
      return out;
    },
    (a, b) => {
      const ka = Object.keys(a);
      if (ka.length !== Object.keys(b).length) return false;
      for (const k of ka) if (a[k] !== b[k]) return false;
      return true;
    },
  );
  const unreadFor = useCallback((workspaceId: string) => totals[`u:${workspaceId}`] ?? 0, [totals]);
  const mentionsFor = useCallback((workspaceId: string) => totals[`m:${workspaceId}`] ?? 0, [totals]);
  return <WorkspaceSwitcher {...props} unreadFor={unreadFor} mentionsFor={mentionsFor} />;
}

/** The member rail: directory + profile overlay, with live presence. */
function LiveMemberRail({
  workspaceId,
  query,
  self,
  profileMember,
  onSelectMember,
  onCloseProfile,
  canManageNicknames = null,
}: {
  workspaceId: string | null;
  query: string;
  self: SelfPresence;
  profileMember: PeopleMember | null;
  /** MANAGE_NICKNAMES here (#169): offers "Change nickname" on others' profiles. */
  canManageNicknames?: boolean | null;
  onSelectMember: (m: PeopleMember | null) => void;
  onCloseProfile: () => void;
}) {
  const presence = useLivePresence(self);
  const membersById = useStoreSelector(defaultStore, (st) => st.membersById);
  const memberIdsByWorkspace = useStoreSelector(defaultStore, (st) => st.memberIdsByWorkspace);
  const nicknamesByWorkspace = useStoreSelector(defaultStore, (st) => st.nicknamesByWorkspace);
  // The directory follows the store's live roster (MemberAdd / MemberRemove /
  // MemberUpdate / UserUpdate) over its REST page; presence rides its own override.
  const directoryStore = useMemo(
    () => ({ membersById, memberIdsByWorkspace, nicknamesByWorkspace, presenceByUser: {} }),
    [membersById, memberIdsByWorkspace, nicknamesByWorkspace],
  );
  // Escape closes the profile — back to the list — like the settings panes
  // and release notes. A layer above that already handled the key (a dialog,
  // a menu, the phone drawer the overlay sits in) wins; the column's own
  // Escape (RailIcons) steps aside once this one claims it.
  const profileOpen = profileMember !== null;
  // The profile's "Change nickname" (#169): yours always (CHANGE_NICKNAME is
  // everyone's), someone else's with MANAGE_NICKNAMES — the server still
  // applies the role hierarchy, and the dialog shows its refusal.
  const [nicknameFor, setNicknameFor] = useState<PeopleMember | null>(null);
  const selfId = useStoreSelector(defaultStore, (st) => st.currentUser?.id ?? null);
  const mayRename = (m: PeopleMember) => m.user.id === selfId || canManageNicknames === true;
  useEffect(() => {
    if (!profileOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      onCloseProfile();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [profileOpen, onCloseProfile]);
  return (
    <div className="member-rail-wrap">
      {/* The directory is a lazy chunk (lane D #7): its fallback is the same
          empty rail the no-workspace case renders, so nothing flashes. */}
      <Suspense fallback={<div className="members-inner" />}>
        {workspaceId ? (
          <PeopleDirectory
            workspaceId={workspaceId}
            store={directoryStore}
            token={authStore.getState().getAccessToken() ?? undefined}
            presence={presence}
            query={query}
            onSelectMember={onSelectMember}
          />
        ) : (
          <div className="members-inner" />
        )}
        {profileMember ? (
          <div className="member-profile-overlay" data-testid="member-profile-overlay">
            <button
              type="button"
              className="member-profile-close"
              aria-label="Close profile"
              data-testid="member-profile-close"
              onClick={onCloseProfile}
            >
              ✕
            </button>
            <ProfileCard
              member={profileMember}
              presence={presence[profileMember.user.id] ?? 'offline'}
              parentName={
                profileMember.parent_user_id
                  ? (() => {
                      const parent = membersById[profileMember.parent_user_id];
                      const nick = workspaceId
                        ? nicknamesByWorkspace[workspaceId]?.[profileMember.parent_user_id]
                        : undefined;
                      return parent ? displayNameOf({ ...parent, nickname: nick ?? null }) : undefined;
                    })()
                  : undefined
              }
              onChangeNickname={workspaceId && mayRename(profileMember) ? setNicknameFor : undefined}
            />
          </div>
        ) : null}
      </Suspense>
      <NicknameDialog
        open={nicknameFor !== null}
        onOpenChange={(open) => {
          if (!open) setNicknameFor(null);
        }}
        workspaceId={workspaceId}
        userId={nicknameFor?.user.id ?? '@me'}
        baseName={nicknameFor ? displayNameOf({ ...nicknameFor.user, nickname: null }) : undefined}
      />
    </div>
  );
}

/**
 * The Home mention backlog belongs to a PROVIDER, not to the shell (plan 1.1).
 *
 * `useInbox` subscribes to the WHOLE store: its `watermarks` read is a
 * `useSyncExternalStore` over `store.getState()` (useInbox.ts), so calling it
 * in `AuthenticatedApp`'s body re-rendered the shell on every gateway event —
 * the storm `useShellStore` exists to stop, still fully in force through this
 * one hook. It is read by TWO surfaces (the sidebar's Mentions row and Home's
 * body) and must stay ONE instance, because done/sweep mutate its local state
 * and two instances drift (see the hook's own note) — so it cannot simply move
 * into either consumer.
 *
 * The provider owns the single instance; the shell hands it the element tree
 * as `children`, which React keeps by reference across the provider's own
 * re-renders. An inbox write therefore re-renders the provider and the two
 * `InboxSurface` consumers, never the shell.
 */
const InboxContext = createContext<UseInbox | null>(null);

function InboxProvider({ children }: { children: ReactNode }) {
  const inbox = useInbox();
  return <InboxContext.Provider value={inbox}>{children}</InboxContext.Provider>;
}

/** The consumer half: hands the provider's single inbox to one surface. */
function InboxSurface({ children }: { children: (inbox: UseInbox) => ReactNode }) {
  const inbox = useContext(InboxContext);
  return inbox === null ? null : <>{children(inbox)}</>;
}

/**
 * The Home rail's Threads tab — the ONLY consumer of `useThreads` in the shell
 * (plan 1.1).
 *
 * `useThreads` subscribes to the whole store too (`useSyncExternalStore` over
 * `getState()`), so the shell must not call it. Isolating it in the subtree
 * that reads its value keeps that subscription off the 2,000-line shell; the
 * hook's own state is consumed only by `MyThreadsSidebar`, which mounts in
 * this branch and nowhere else, so nothing observable moves.
 */
function HomeThreadsRail({
  onOpenThread,
  activeThreadId,
}: {
  onOpenThread: (threadId: string) => void;
  activeThreadId: string | null;
}) {
  const threads = useThreads();
  return (
    <MyThreadsSidebar threads={threads} onOpenThread={onOpenThread} activeThreadId={activeThreadId} />
  );
}

/**
 * The mobile topbar's join-voice control (plan 1.1).
 *
 * `useChannelCallHeader` is a THIRD whole-store subscriber: its
 * `useSyncExternalStore(subscribe, () => store.getState())` re-renders its
 * caller on every gateway event (useChannelCallHeader.ts). Called from
 * `AuthenticatedApp`'s body it re-rendered the shell; the only value read off
 * it is this button's four props, so it lives here — an unrelated write now
 * re-renders at most this control, and only while a workspace channel is the
 * active surface (the shell keeps the show/hide decision, which it makes from
 * its own gated snapshot).
 */
function TopbarCallSurface({
  channelId,
  canStartCall,
}: {
  channelId: string | null;
  canStartCall: boolean;
}) {
  const header = useChannelCallHeader(defaultStore, channelId);
  return (
    <TopbarCallAction
      live={header.live}
      ringing={header.ringing}
      canStartCall={canStartCall}
      onStart={header.start}
      onJoin={header.join}
    />
  );
}

/**
 * A store-derived list whose IDENTITY is stable while its elements are equal
 * (plan 7.3).
 *
 * The shell's two channel lists used to be memoized on a `JSON.stringify`
 * serialization key of the roster, which re-serialized the whole roster on
 * EVERY render. This keeps the same guarantee without a key: the selector
 * runs on store writes, and the previous array is returned whenever the new
 * elements compare equal — so a downstream `useMemo` (or a child) depends on
 * a reference that moves only when the list itself changes.
 *
 * The `equal` comparison is the caller's because the two callers need
 * different notions: the channel records are immutable store rows (`===`),
 * while the integrations pane derives fresh `{id, name}` options (field
 * equality).
 */
/**
 * Identity-stable selector parts for the `useStableChannelList` call sites
 * (plan 7.3). The hook caches on the SOURCE slice, so a fresh closure per
 * render would defeat the cache entirely — these read nothing but the store,
 * so they live at module scope.
 */
const channelSource = (state: StateState) => state.channels;

const workspaceChannelOptions = (state: StateState): Channel[] =>
  Object.values(state.channels).filter((c) => c.workspace_id !== null);

const sameChannelRow = (a: Channel, b: Channel) => a === b;

const sameChannelOption = (a: ChannelOption, b: ChannelOption) => a.id === b.id && a.name === b.name;

export function useStableChannelList<T, S>(
  store: StateStore,
  source: (state: StateState) => S,
  select: (state: StateState) => T[],
  equal: (a: T, b: T) => boolean,
): T[] {
  // `source` must name EVERY slice and closure input `select` reads, and the
  // three functions must be identity-stable (module scope, or `useCallback`):
  // a new closure means a new selection, and this object is the marker for it.
  const deps = useMemo(() => ({ source, select, equal }), [source, select, equal]);
  const cache = useRef<{ deps: typeof deps | null; source: unknown; value: T[] | null }>({
    deps: null,
    source: undefined,
    value: null,
  });

  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);

  const getSnapshot = useCallback(() => {
    const state = store.getState();
    const src = source(state);
    const prev = cache.current;

    // The list is a function of `source` alone, so an unchanged source means
    // an unchanged list: a `lastSeq` write, a thread reply, a presence tick or
    // any other slice the selector does not read returns the cached array
    // WITHOUT running the selector. Before this gate the hook subscribed to
    // the raw store, so both call sites rebuilt an array over the whole roster
    // on every gateway dispatch — exactly the work `useShellStore`'s slice
    // gate exists to avoid.
    if (prev.deps === deps && prev.value !== null && Object.is(prev.source, src)) {
      return prev.value;
    }

    const next = select(state);

    if (
      prev.value !== null &&
      prev.value.length === next.length &&
      prev.value.every((element, i) => equal(element, next[i]!))
    ) {
      // Same elements, same reference: a downstream `useMemo` or child prop
      // keyed on this array does not move. Deliberately NOT gated on the
      // closure marker — identity stability is the hook's original contract
      // and holds even for a caller that passes fresh closures every render
      // (which then simply loses the skip above, not the stability).
      prev.deps = deps;
      prev.source = src;
      return prev.value;
    }

    prev.deps = deps;
    prev.source = src;
    prev.value = next;
    return next;
  }, [store, source, select, equal, deps]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function AuthenticatedApp() {
  const online = useOnlineStatus();
  // Sends that could not go out wait for the connection and go out on their
  // own when it returns — the offline banner's promise (sendAutoRetry.ts).
  useEffect(() => startSendAutoRetry(defaultStore), []);
  const { state: authState } = useAuth();
  // U5: the shell's mobile breakpoint — below 768px the settings surfaces
  // swap their desktop col-2 menu for a pane-owned full-width list.
  const band = useShellBand();
  const isMobile = band === 'phone';
  const isTablet = band === 'tablet';
  // User settings (the gear): hash-routed #/settings/:section — the surface
  // takes columns 2 (menu) + 3 (section), hides the fourth column, and the
  // left cluster (rail + sidebar + user panel) always stays.
  //
  // Integrations live HERE now (owner direction 2026-09-14, plan
  // 2026-09-15-1200): the rail button, its `#/integrations/:pane` overlay and
  // the read-only rollup that duplicated it are all gone, and the two panes
  // are sections — `integrations` (agents) and `webhooks`. A stale link is
  // aliased at the surface-resolution point, below.
  const {
    open: settingsOpen,
    section: settingsSection,
    openSection: openSettingsSection,
    close: closeSettings,
  } = useSettingsRoute();
  const {
    open: wsettingsOpen,
    section: wsettingsSection,
    openSection: openWSettingsSection,
    close: closeWSettings,
  } = useWSettingsRoute();
  // #121: the operator-only Server Settings surface (#/serversettings) — the
  // Home gear's menu item opens it; the ROUTES are gated server-side, so a
  // hand-typed hash meets the 403 the page renders as its error state.
  const serverSettings = useServerSettingsRoute();
  // Release notes (#/release-notes, the version badge's link): a CENTER-column
  // takeover like server settings — the left cluster stays navigable, and any
  // navigation from it leaves the notes (`leave`, via leaveSettings and
  // selectChannel below).
  const releaseNotes = useReleaseNotesRoute();
  const { leave: leaveReleaseNotes } = releaseNotes;
  const { path: rawPath, navigate } = useHashRoute();
  /**
   * The removed integrations surface is ALIASED, not deleted (KD7): a stale
   * `#/integrations/agents` bookmark, or a link someone copied before the
   * relocation, must still land somewhere real. Normalizing here — the single
   * point where a surface is resolved — is what lets every downstream read
   * (`settingsOpen`, the section bodies, the nav) see ONE address for one
   * surface instead of each learning about a prefix that no longer exists.
   */
  const legacyAlias = aliasLegacyIntegrationsPath(rawPath);
  useEffect(() => {
    if (legacyAlias !== null) navigate(legacyAlias);
  }, [legacyAlias, navigate]);
  const path = legacyAlias ?? rawPath;

  /*
   * #118 — the `/m/<token>` page path. A copied permalink is an opaque path
   * now; the token is resolved over the API here (the key is the server's) and
   * turned into the ordinary `#/…channel/…message/…` route, at which point
   * everything below is #114 unchanged: the same parse, the same navigation
   * effects, the same landing. One decode at the edge. A failure is a real
   * state and is shown, never swallowed (the reader is not left wondering why
   * the link did nothing).
   */
  const pathPermalink = usePathPermalink({ navigate });

  // U5 — the mobile list↔content split rides the HASH, which stays the
  // single source of truth: the BARE prefix (#/settings — what the gear
  // writes at mobile) is the full-width LIST; #/settings/:section is the
  // section view with a ← back target (deep links land there; selecting a
  // section updates the hash as today; ← returns to the bare prefix).
  // Desktop keeps the col-2/col-3 doctrine at both shapes.
  const settingsMobileList = settingsOpen && isMobile && path === SETTINGS_ROUTE_PREFIX;
  const wsettingsMobileList = wsettingsOpen && isMobile && path === WSETTINGS_ROUTE_PREFIX;

  // Flow F1, authenticated leg: `#/invite/{code}` renders the join landing;
  // a code parked across the login/register hop resumes on the bare route.
  const invitePathMatch = /^\/invite\/([^/?#]+)/.exec(path);
  const inviteCode = invitePathMatch
    ? decodeURIComponent(invitePathMatch[1]!)
    : path === '/'
      ? readPendingInvite()
      : null;
  /** Bumped after an invite accept so the roster hydration re-runs. */
  const [inviteJoinNonce, setInviteJoinNonce] = useState(0);

  /*
   * #114 — the message permalink route. `#/workspace/{ws}/channel/{ch}[/thread/{t}]/message/{mid}`
   * (and its workspace-less DM form) is parsed by the SAME grammar the
   * Tauri/Expo deep link and the OS scheme go through (`@cytale/domain`), so
   * an address has one definition no matter which door it arrives by.
   *
   * Only the CHANNEL and the MESSAGE are acted on here; a thread SEGMENT is a
   * promise the resolver confirms — the resolved message carries `thread_id`,
   * so a link written without the segment still opens the thread it lives in
   * (see `handlePermalinkMessage`).
   */
  const permalink = useMemo(() => {
    const target = parsePermalinkPath(path);
    // Only a message address is actionable here: the shorter forms (a
    // workspace, a channel, a thread) carry no message to land on, and this
    // route's contract is "open the message".
    if (target === null || target.kind !== 'message') return null;
    if (target.channelId === undefined || target.messageId === undefined) return null;
    return {
      workspaceId: target.workspaceId ?? null,
      channelId: target.channelId,
      threadId: target.threadId ?? null,
      messageId: target.messageId,
    };
  }, [path]);

  // U17 store projection: workspaces/channels/unread as the gateway hydrates —
  // gated on the slices this subtree reads (see `useShellStore`), so a message
  // in another channel no longer re-renders the whole application.
  const store = useShellStore(defaultStore);
  // Settings back semantics (review #9): remember the hash trail so a
  // section's ← can use history.back() when the previous entry IS the list
  // (the normal gear -> section flow) — the system Back button then exits
  // settings instead of re-entering the section just left. Deep links and
  // foreign previous entries fall back to a plain push.
  const hashTrailRef = useRef<string[]>(
    typeof location !== 'undefined' ? [location.hash] : [''],
  );
  useEffect(() => {
    const onHashChange = () => {
      hashTrailRef.current.push(location.hash);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  const settingsBackTo = (prefix: string) => {
    const trail = hashTrailRef.current;
    const previous = trail.length >= 2 ? trail[trail.length - 2] : null;
    if (previous === prefix) {
      trail.pop();
      history.back();
    } else {
      navigate(prefix);
    }
  };

  const workspaces = Object.values(store.workspaces);
  /**
   * Lane D #3: the shell starts where this member left off on this device —
   * read once at mount (per user; see `lastLocation.ts`). The roster may not
   * be known yet; the defaulting effects below validate the restored ids once
   * it is, and never "correct" them before.
   */
  const selfIdAtMount = authState.currentUser?.id ?? null;
  const [lastLocation] = useState(() => readLastLocation(selfIdAtMount));
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    () => lastLocation?.workspaceId ?? null,
  );
  const [activeChannelId, setActiveChannelId] = useState<string | null>(
    () => lastLocation?.channelId ?? null,
  );
  /**
   * True once ANY roster is known — the server's (READY / REST), the device
   * snapshot's, or rows some other writer already put in the store (a
   * workspace in the store IS a known roster, whatever wrote it).
   */
  const rosterKnown = store.rosterSource !== 'none' || workspaces.length > 0;
  /**
   * The open thread. `threadId === null` is a DRAFT: "Start thread" opens the
   * panel without creating anything, and the first reply creates the thread
   * (ThreadCompose). `parentMessageId` is what both modes hang the pane off,
   * `draftName` names the thread the reply will create.
   */
  const [activeThread, setActiveThread] = useState<{
    threadId: string | null;
    channelId: string;
    parentMessageId: string | null;
    draftName?: string;
  } | null>(null);
  // The open thread's parent row — the ONE thing the shell reads out of the
  // message hot path. Its own subscription (see `useThreadParentMessage`), so
  // the shell can stay off `messagesByChannel` entirely.
  const threadParentMessage = useThreadParentMessage(defaultStore, activeThread);
  // The right rail's tab (Members | Call log) — content stays contextual:
  // a workspace shows its directory / the active channel's log; Home shows
  // the cross-workspace aggregate. The header search (⌕) routes to the
  // active tab's list and resets on close/tab switch.
  const [railTab, setRailTab] = useState<'members' | 'calls' | 'threads'>('members');
  /**
   * The 4th column: which mode it shows, or null when hidden. One value,
   * because visibility and mode used to share a flag and that is what let Home
   * lose the whole column (#105).
   *
   * The starting state is the BAND's, amended 2026-09-13 (owner: *"On desktop
   * or viewports similarly wide, show the member list by default"*):
   *
   *   * desktop (≥1280px) — OPEN on Members. The fourth track is there, the
   *     width is there, and members are what Discord shows beside a channel;
   *   * tablet / phone — HIDDEN as before. The owner's 2026-09-12 direction
   *     ("always start hidden") still holds where opening the column costs the
   *     conversation: at tablet it REPLACES the pane, at phone it is a modal
   *     drawer. It also keeps the phone default safe for the shell's own
   *     `aria-hidden` contract, which a drawer at rest would break.
   *
   * Deliberately read ONCE, at mount (`useState`'s lazy initializer): resizing
   * across the 1280px line must not open or close the column under the user's
   * hands — a resize is not a mode decision.
   *
   * The same mode survives a band change and a channel switch by decision, so
   * there is no reset effect: at desktop it opens the fourth track, at tablet
   * it replaces the pane, and after a channel switch it shows that channel's
   * content.
   */
  const [railMode, setRailMode] = useState<RailMode | null>(() =>
    band === 'desktop' ? 'members' : null,
  );
  /** The toggle rule lives here, once: the same icon closes, a different one
      replaces. Every control (pane header, Home band, phone topbar) routes
      through it. */
  const selectRailMode = useCallback((mode: RailMode) => {
    setRailSearchOpen(false);
    setRailSearchQuery('');
    setRailTab(mode);
    setRailMode((current) => (current === mode ? null : mode));
  }, []);
  /**
   * The pane header's rail icons as ONE element per (mode) — MessagePane is
   * memoized (lane D #17), and a fresh element per shell render would defeat
   * the memo on every render.
   */
  /**
   * Home's OWN column mode — separate from `railMode`, and always starting
   * closed. Home carries no fourth column by default (owner direction
   * 2026-09-14: "In home, col 4 doesn't make sense as I'm not in a room"), and
   * it offers no member list at all (`HOME_RAIL_MODES`); but the
   * cross-workspace Call log and the Threads you follow (My Threads) are Home's
   * to show, on request. So the channel surface's mode — Members by default at
   * desktop — never leaks onto Home as a column, and a mode chosen on Home
   * never follows the reader into a channel.
   */
  const [homeRailMode, setHomeRailMode] = useState<RailMode | null>(null);
  const selectHomeRailMode = useCallback((mode: RailMode) => {
    setRailSearchOpen(false);
    setRailSearchQuery('');
    setRailTab(mode);
    setHomeRailMode((current) => (current === mode ? null : mode));
  }, []);
  /**
   * A thread docked at desktop holds the side column: the dock takes the
   * member-list slot (`railHidden` covers `activeThread`), so no rail mode is
   * showing even when `railMode` is set. The channel header's icons stay up
   * throughout (see `headerActions`), none of them pressed, and choosing one
   * REPLACES the thread with that pane — Discord's behaviour when the member
   * list is opened over a thread, and the only one this layout allows, since
   * the dock and the column share one slot. It closes the thread exactly as
   * its ✕ does, and it OPENS the chosen mode rather than toggling it: the
   * pane was not showing, so "same icon closes" does not apply.
   */
  const threadHoldsColumn = band === 'desktop' && activeThread !== null;
  const replaceThreadWithRailMode = useCallback((mode: RailMode) => {
    setActiveThread(null);
    setRailSearchOpen(false);
    setRailSearchQuery('');
    setRailTab(mode);
    setRailMode(mode);
  }, []);
  const railIconsElement = useMemo(
    () =>
      threadHoldsColumn ? (
        <RailIcons mode={null} onSelect={replaceThreadWithRailMode} />
      ) : (
        <RailIcons mode={railMode} onSelect={selectRailMode} />
      ),
    [threadHoldsColumn, railMode, selectRailMode, replaceThreadWithRailMode],
  );
  const [railSearchOpen, setRailSearchOpen] = useState(false);
  const [railSearchQuery, setRailSearchQuery] = useState('');
  const changeRailTab = useCallback((id: string) => {
    setRailSearchOpen(false);
    setRailSearchQuery('');
    setRailTab(id === 'calls' ? 'calls' : id === 'threads' ? 'threads' : 'members');
  }, []);
  const toggleRailSearch = useCallback(() => {
    setRailSearchOpen((open) => !open);
    setRailSearchQuery('');
  }, []);

  // Channel thread roster (the ⋯ menu's Threads entry) — a dialog hosted by
  // the shell; selecting a row opens the dock.
  const [threadsListChannelId, setThreadsListChannelId] = useState<string | null>(null);

  /** A sidebar channel click (stable — the rows are memoized, lane D #17). */
  const selectChannel = useCallback(
    (id: string) => {
      // The channel list stays visible beside the release notes (they take
      // only the center column), so a channel click must close them.
      leaveReleaseNotes();
      setActiveChannelId(id);
      setActiveThread(null);
    },
    [leaveReleaseNotes],
  );

  // Start thread (hover 🧵 → name prompt in the pane): the shell owns the
  // REST call, the store upsert (the gateway ThreadCreate may also land;
  // both converge), and opening the thread dock on the parent channel.
  /**
   * Write a thread the user just created (its first reply did it) into the
   * store and promote the open draft to it. The store write is the same one
   * the old eager-create path did — only its trigger moved from "clicked
   * Start thread" to "sent the first reply".
   */
  const handleThreadCreated = useCallback((thread: Thread) => {
    defaultStore.setState((s) => {
      const existing = s.threadIdsByChannel[thread.channel_id] ?? [];
      return {
        threadsById: { ...s.threadsById, [thread.id]: thread },
        threadIdsByChannel: {
          ...s.threadIdsByChannel,
          [thread.channel_id]: existing.includes(thread.id)
            ? existing
            : [...existing, thread.id],
        },
      };
    });
    // Only the draft that made it is promoted: a create that answers after
    // the reader moved on (another thread, another draft, a closed pane —
    // or a failed create retried from its row later) must not hijack the
    // pane. The thread is in the store either way.
    setActiveThread((cur) =>
      cur === null ||
      cur.threadId !== null ||
      cur.channelId !== thread.channel_id ||
      (thread.parent_message_id != null && cur.parentMessageId !== thread.parent_message_id)
        ? cur
        : {
            ...cur,
            threadId: thread.id,
            parentMessageId: thread.parent_message_id ?? cur.parentMessageId,
          },
    );
  }, []);

  const handleStartThread = useCallback(
    (chId: string, messageId: string, name: string) => {
      // A thread is only real once it has a reply: this opens a DRAFT pane —
      // no REST call, no ThreadCreate fan-out, nothing to clean up if the
      // user closes it (user direction 2026-09-12).
      setActiveThread({
        threadId: null,
        channelId: chId,
        parentMessageId: messageId,
        draftName: name,
      });
    },
    [],
  );

  /**
   * Open the thread dock for a row's thread indicator (#137, app-level finding
   * 2). Hoisted out of the JSX: as an inline arrow it was a new function on
   * every render, which made `MessagePane`'s `MessageList` props — and so its
   * `itemContent`, and so every virtualized row — new on every gateway event.
   * The body is the one it had inline, unchanged; `activeChannelId` is its
   * only dependency.
   */
  const handleOpenThreadFromRow = useCallback(
    (threadId: string) => {
      const t = defaultStore.getState().threadsById[threadId];
      setActiveThread({
        threadId,
        channelId: t?.channel_id ?? activeChannelId ?? '',
        parentMessageId: t?.parent_message_id ?? null,
      });
    },
    [activeChannelId],
  );

  // Home surface state: null defers to the derived default — zero-workspace
  // accounts land on Home (the old fall-through rendered a meaningless empty
  // chat shell); anyone with workspaces lands in their first workspace. The
  // rail Home button / a workspace or DM selection flip the override.
  const [homeOverride, setHomeOverride] = useState<boolean | null>(() =>
    lastLocation?.home === true ? true : null,
  );
  // Lane D #3: "no workspaces → Home" is a statement about the ROSTER, so it
  // is only made once a roster is known. Before that the shell shows the
  // workspace frame (the restored location), never Home — an empty store at
  // mount used to put Home on every member's first frame.
  const homeActive = homeOverride ?? (rosterKnown ? workspaces.length === 0 : false);
  /** The column mode the CURRENT surface shows (see `homeRailMode`). */
  const shownRailMode = homeActive ? homeRailMode : railMode;
  // Calls plan U9: the call log lives in the right rail's "Call log" tab —
  // contextual per channel in a workspace, the cross-channel aggregate on
  // Home. (The old pane-dock + header button are gone with it.)
  const [profileMember, setProfileMember] = useState<PeopleMember | null>(null);
  const closeProfile = useCallback(() => setProfileMember(null), []);
  const [hydrationDone, setHydrationDone] = useState(false);
  const [hydrationError, setHydrationError] = useState<string | null>(null);
  /** Coalesces overlapping hydration triggers (the effect has two deps). */
  // Names the authors the first people page did not (memberResolver): every
  // message window and thread roster is watched, unknown ids are looked up
  // in batches. Lives as long as the shell.
  const memberResolver = useRef<MemberResolver | null>(null);
  useEffect(() => {
    const resolver = startMemberResolver({
      store: defaultStore,
      lookup: async (workspaceId, ids) => {
        const token = authStore.getState().getAccessToken() ?? undefined;
        const page = await fetchPeoplePage({ workspaceId, ids, token });
        return page.people.map(memberFromPeopleRow);
      },
    });
    memberResolver.current = resolver;
    return () => {
      resolver.stop();
      memberResolver.current = null;
    };
  }, []);
  const hydrationInFlight = useRef(false);
  /** Hydration runs within this mount (diagnostics). */
  const hydrationRuns = useRef(0);
  /** The invite-join nonce the last hydration saw (a new one re-reads the roster). */
  const lastInviteNonce = useRef(0);

  // Calls plan U8: the call surface. The engine holds ONE voice leg; the
  // panel docks (or sheets, on mobile) while a leg is being held or a
  // terminal notice is showing, on the call's own channel (the slot row is
  // the return-to-call entry — AM18).
  // Calls plan U10 (R11/AM18): DM calls NEVER dock the full panel — the DM
  // header indicator expands into the compact controls instead. A channel is
  // DM-flavored when its record says `dm` OR the live call rides the DM
  // slice (covers channels the store has not hydrated yet).
  const callEngine = useCallEngineState();
  const callSurfaceChannel =
    callEngine.channelId !== null &&
    (callEngine.voice.status !== 'idle' || callEngine.voice.notice !== null)
      ? callEngine.channelId
      : null;
  const callSurfaceIsDm =
    callSurfaceChannel !== null &&
    (store.channels[callSurfaceChannel]?.type === 'dm' ||
      store.dmCallByChannel[callSurfaceChannel] !== undefined);
  const [callSurfaceHidden, setCallSurfaceHidden] = useState(false);
  useEffect(() => {
    setCallSurfaceHidden(false); // a new leg reopens the surface
  }, [callSurfaceChannel]);

  // Self presence preference: persisted, re-asserted on every fresh gateway
  // session (the server forgets preferences when the last socket closes).
  const [selfStatus, setSelfStatus] = useState<SelfStatus>(() => {
    const stored = localStorage.getItem('cytale.self-presence');
    return stored === 'idle' || stored === 'dnd' || stored === 'invisible' ? stored : 'online';
  });
  const handleSelfStatus = useCallback((status: SelfStatus) => {
    setSelfStatus(status);
    localStorage.setItem('cytale.self-presence', status);
    session.getGateway()?.updatePresence(status);
  }, []);

  // -- user settings (the gear surface) --------------------------------------
  // API + session wiring for the sections; the components stay presentational.

  // PATCH /users/@me returns the {user} envelope raw (the client types it as
  // CurrentUser — same drift session.ts unwraps); reflect the saved profile
  // into the auth store, and converge the roster row so the user's own
  // display name updates in member lists immediately (refetch converges).
  const handleSaveProfile = useCallback(
    async (patch: { display_name?: string; avatar_url?: string | null }) => {
      const res = (await api.updateCurrentUser(
        patch as Parameters<typeof api.updateCurrentUser>[0],
      )) as unknown as { user: CurrentUser };
      authStore.getState().setUser(res.user);
      const selfId = res.user?.id;
      const displayName = patch.display_name;
      if (selfId && typeof displayName === 'string') {
        defaultStore.setState((s) => {
          const row = s.membersById[selfId];
          if (!row) return s;
          // The display name, never the nickname: a nickname is
          // per-workspace and the row is shared (#169).
          return {
            membersById: { ...s.membersById, [selfId]: { ...row, display_name: displayName || null } },
          };
        });
      }
    },
    [],
  );
  // Avatar upload (POST /users/@me/avatar): the endpoint sets avatar_url
  // atomically with the upload and dispatches UserUpdate to every workspace
  // + DM — here we only converge self (auth store + roster row); other
  // clients see the event.
  const handleUploadAvatar = useCallback(async (file: File) => {
    const res = await api.uploadAvatar(file);
    authStore.getState().setUser(res.user);
    // Local convergence rides the gateway reconcile (the repo's synthetic-
    // event pattern); the server's real UserUpdate re-applies idempotently.
    if (res.user) {
      const u = res.user;
      applyGatewayEvent(defaultStore, {
        op: 0,
        t: 'UserUpdate',
        s: nextSyntheticSeq(),
        d: {
          id: u.id,
          username: u.username,
          display_name: u.display_name ?? null,
          avatar_url: u.avatar_url ?? null,
        },
      });
    }
  }, []);
  // Workspace settings (the ⌄ menu's gear): icon upload/rename ride the
  // admin endpoints; the store's workspace row converges from the response
  // so the switcher + home rollups update immediately.
  const convergeWorkspace = useCallback((ws: Workspace) => {
    defaultStore.setState((s) => ({ workspaces: { ...s.workspaces, [ws.id]: ws } }));
  }, []);

  const handleUploadWorkspaceIcon = useCallback(
    async (workspaceId: string, file: File) => {
      convergeWorkspace((await api.uploadWorkspaceIcon(workspaceId, file)).workspace);
    },
    [convergeWorkspace],
  );

  const handleRenameWorkspace = useCallback(
    async (workspaceId: string, name: string) => {
      convergeWorkspace((await api.updateWorkspace(workspaceId, { name })).workspace);
    },
    [convergeWorkspace],
  );

  const handleRemoveWorkspaceIcon = useCallback(
    async (workspaceId: string) => {
      convergeWorkspace((await api.updateWorkspace(workspaceId, { icon_url: '' })).workspace);
    },
    [convergeWorkspace],
  );

  const handleResendVerification = useCallback(async () => {
    await session.resendVerification();
  }, []);
  const handleSendPasswordReset = useCallback(async (email: string) => {
    await session.requestPasswordReset(email);
  }, []);
  const handleSignOutEverywhere = useCallback(async () => {
    try {
      await api.revokeAllSessions();
    } finally {
      await session.logout('You were signed out on all devices.');
    }
  }, []);
  const handleDeleteAccount = useCallback(async () => {
    try {
      await api.deleteAccount();
    } finally {
      await session.logout('Your account has been deleted.');
    }
  }, []);

  // #36 passkeys block (Account section): enroll runs the full browser
  // ceremony, the list/remove ride the plain account-scoped routes.
  const passkeysApi = useMemo(
    () => ({
      onEnroll: (name: string) => enrollPasskey(api, name),
      onRemove: (id: string) => api.deleteWebauthnCredential(id),
      onList: async () => (await api.listWebauthnCredentials()).credentials,
    }),
    [],
  );
  // #127 two-factor block (Account section): the settings half of the TOTP
  // surface — the status read (which also carries the mode the section's
  // visibility keys on), the Bearer-path enroll start/confirm, and removal.
  const twoFactorApi = useMemo(
    () => ({
      onStatus: () => api.twoFactorStatus(),
      onEnrollStart: () => api.twoFactorEnrollStart(),
      onEnrollConfirm: (code: string) => api.twoFactorEnrollConfirm({ code }),
      onRemove: () => api.twoFactorDelete(),
    }),
    [],
  );
  // Stable identity — the Integrations section's fetch effect keys on it.
  const loadMyIntegrations = useCallback(() => api.listMyIntegrations(), []);

  // Browser permission is read at mount and after every toggle: the member can
  // change it in the browser's own UI at any time, and the surface must not
  // keep claiming a state the browser has since revoked.
  const [notificationPermission, setNotificationPermission] = useState(readNotificationPermission);
  /**
   * Whether THIS browser holds a live push subscription. Permission alone is
   * not enough to say "notifications are on": a member can grant permission
   * and never turn them on, or turn them off on this device, and the settings
   * box then reads "on" for a browser that can receive nothing. Probed rather
   * than remembered, because the browser rotates and drops subscriptions
   * silently — the stored fact is the one most likely to be stale.
   */
  const [pushSubscribed, setPushSubscribed] = useState<boolean | undefined>(undefined);
  // Bumped when a member asks to see the invitation again, so the prompt
  // remounts and re-reads its dismissal flag.
  const [promptEpoch, setPromptEpoch] = useState(0);

  // Cmd-K omnisearch (owner direction 2026-09-15). The listener lives HERE —
  // the shell is the one surface that always exists once signed in, and the
  // palette works from any route. Meta on macOS, Ctrl elsewhere: the same
  // physical key position, so no platform detection is needed — just accept
  // both. An icon-based entry point is deliberately deferred (owner: "I need
  // to figure out where to add icon-based access").
  const [omniOpen, setOmniOpen] = useState(false);
  const [omniEverOpened, setOmniEverOpened] = useState(false);
  useEffect(() => {
    if (omniOpen) setOmniEverOpened(true);
  }, [omniOpen]);

  // The notification-click listener (the SW's belt-and-braces channel): the
  // worker focuses + navigates this tab itself when it can, and a client
  // whose navigate() was unavailable still routes through here. The target's
  // ids build the same permalink the router already understands.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; target?: NotificationTarget } | null;
      if (data?.type !== 'cytale:notification-click' || !data.target) return;
      const href = notificationClickPath(data.target);
      if (href) window.location.hash = href;
    };
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, []);
  useEffect(() => {
    function onOmniKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOmniOpen((o) => !o);
      }
    }
    window.addEventListener('keydown', onOmniKey);
    return () => window.removeEventListener('keydown', onOmniKey);
  }, []);

  // #117's mention backlog is owned by `InboxProvider` (module scope, plan
  // 1.1): two surfaces read it — the sidebar (above Mentions) and Home's body
  // — and they must share ONE instance, one truth, because done/sweep drift
  // apart with two. It is NOT called here: `useInbox` whole-store-subscribes,
  // so the shell calling it re-rendered on every gateway event.

  useEffect(() => {
    const onFocus = () => setNotificationPermission(readNotificationPermission());
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // Probe the subscription whenever the notifications surface is addressed,
  // and re-probe on focus alongside the permission read — the two can change
  // independently while the member is in the browser's own settings.
  useEffect(() => {
    let live = true;
    const probe = () => {
      void hasPushSubscription().then((yes) => {
        if (live) setPushSubscribed(yes);
      });
    };
    if (settingsOpen) probe();
    window.addEventListener('focus', probe);
    return () => {
      live = false;
      window.removeEventListener('focus', probe);
    };
  }, [settingsOpen]);

  /**
   * The notifications section's rows: every workspace and every channel the
   * member can see, each resolved through the same walk the server runs.
   *
   * Rows are built from what the member can ACT on rather than only from what
   * they have overridden: a row they never touched still has a resolved level,
   * and showing it (with its provenance) is the whole point of the surface.
   */
  const loadNotificationRows = useCallback(async (): Promise<NotificationRow[]> => {
    // The rows derive from the ONE shared preference slice (notification
    // controls, 2026-09-27) — the same copy the header control, the menus and
    // the sidebar read, so this overview can never disagree with them. The
    // slice hydrates at session start; a load before that lands (or after it
    // failed) reads it now, and a failed read is this surface's error state.
    if (defaultStore.getState().notificationPrefs.status !== 'ready') {
      await hydrateNotificationPrefs();
      if (defaultStore.getState().notificationPrefs.status !== 'ready') {
        throw new Error('notification preferences unavailable');
      }
    }
    const { overrides, suppressBroadcasts } = defaultStore.getState().notificationPrefs;

    const rows: NotificationRow[] = [];
    const workspaces = Object.values(store.workspaces);
    const channels = Object.values(store.channels);

    const account = resolveFromOverrides({ overrides });
    rows.push({
      id: 'account',
      label: 'Default for everything',
      level: account.level,
      decidedBy: account.decidedBy,
      overridden: account.overridden,
      scope: 'account',
    });

    for (const workspace of workspaces) {
      const resolved = resolveFromOverrides({ overrides, workspaceId: workspace.id });
      rows.push({
        id: `ws-${workspace.id}`,
        label: workspace.name,
        level: resolved.level,
        decidedBy: resolved.decidedBy,
        overridden: resolved.overridden,
        scope: 'workspace',
        suppressBroadcasts: suppressBroadcasts[workspace.id] === true,
      });

      for (const channel of channels) {
        if (channel.workspace_id !== workspace.id) continue;
        const chResolved = resolveFromOverrides({
          overrides,
          workspaceId: workspace.id,
          channelId: channel.id,
        });
        rows.push({
          id: `ch-${channel.id}`,
          label: `#${channel.name}`,
          level: chResolved.level,
          decidedBy: chResolved.decidedBy,
          overridden: chResolved.overridden,
          // The channel's own scope plus the workspace it hangs under: the
          // surface builds its tree from these two fields alone.
          scope: 'channel',
          parentId: `ws-${workspace.id}`,
        });
      }
    }

    return rows;
  }, [store.workspaces, store.channels]);

  /**
   * Turn web push on for this browser.
   *
   * Three things have to line up and each can fail independently: the instance
   * must have VAPID keys, the member must grant permission, and the server must
   * accept the registration. Each failure throws, and the surface renders it —
   * a toggle that appears to succeed and delivers nothing is the worst outcome
   * of all.
   */
  const enableNotifications = useCallback(async () => {
    const vapidPublicKey = await api.getVapidPublicKey();

    if (!vapidPublicKey) {
      throw new Error('this instance has no web push configured');
    }

    const result = await enablePushSubscription({
      vapidPublicKey,
      register: (body) => api.createPushSubscription(body),
    });

    if (!result.ok) throw new Error(result.reason);
    setNotificationPermission(readNotificationPermission());
    // Re-probe rather than assume: `enablePushSubscription` reports success for
    // re-registering an EXISTING subscription too, so "ok" is not by itself
    // proof that this browser now holds one.
    setPushSubscribed(await hasPushSubscription());
  }, []);

  const disableNotifications = useCallback(async () => {
    const result = await disablePushSubscription({
      unregister: (endpoint) => api.deletePushSubscription(endpoint),
    });

    if (!result.ok) throw new Error(result.reason);
    setNotificationPermission(readNotificationPermission());
    setPushSubscribed(await hasPushSubscription());
  }, []);

  // Settings writes go through the shared preference module like every other
  // surface: optimistic in the one store (the header and sidebar move with
  // the radio), rolled back and rejected on refusal (the row shows its error).
  const saveNotificationLevel = useCallback(
    async (rowId: string, level: 'all' | 'mentions' | 'mute') => {
      if (rowId === 'account') {
        await setTargetLevel(accountTarget(), level);
        return;
      }
      if (rowId.startsWith('ws-')) {
        await setTargetLevel(workspaceTarget(rowId.slice(3)), level);
        return;
      }
      if (rowId.startsWith('ch-')) {
        const channelId = rowId.slice(3);
        await setTargetLevel(
          channelTarget(channelId, defaultStore.getState().channels[channelId]?.workspace_id ?? null),
          level,
        );
      }
    },
    [],
  );

  const saveBroadcastSuppression = useCallback(async (rowId: string, suppress: boolean) => {
    if (rowId.startsWith('ws-')) await setWorkspaceBroadcastSuppressed(rowId.slice(3), suppress);
  }, []);

  // The overview follows the slice: any surface's write re-derives its rows.
  const subscribeNotificationPrefs = useCallback((onChange: () => void) => {
    let last = defaultStore.getState().notificationPrefs;
    return defaultStore.subscribe((state) => {
      if (state.notificationPrefs === last) return;
      last = state.notificationPrefs;
      onChange();
    });
  }, []);

  // Session start: hydrate the shared preference slice once per signed-in
  // member, so the header control, the sidebar dimming and the ding know the
  // member's levels without the settings surface ever opening.
  const prefsUserId = store.currentUser?.id ?? null;
  useEffect(() => {
    if (prefsUserId !== null) void hydrateNotificationPrefs();
  }, [prefsUserId]);

  // Focus contract: leaving settings returns focus to the gear that opened
  // them (keyboard users don't land in the middle of the chat pane).
  const settingsWasOpenRef = useRef(false);
  useEffect(() => {
    if (settingsWasOpenRef.current && !settingsOpen) {
      document.querySelector<HTMLButtonElement>('[data-testid="user-settings-toggle"]')?.focus();
    }
    settingsWasOpenRef.current = settingsOpen;
  }, [settingsOpen]);

  // Home surface navigation. DMs open IN home (the home column stays put,
  // Discord-style); workspace channels and threads leave Home for the
  // workspace context; mention rows route by channel flavor (a DM mention
  // stays in home, a workspace channel lands in its workspace). Every
  // React-state navigation also leaves the settings surface — its hash
  // doesn't move on its own, and a silent swap underneath would strand the
  // settings menu over a different context.
  const leaveSettings = useCallback(() => {
    // BOTH settings surfaces. User settings is account-scoped and workspace
    // settings is workspace-scoped, but from NAVIGATION's point of view they
    // are one thing: a leaving click must not strand either menu over a
    // different context (owner report 2026-09-15: workspace settings stayed
    // open, silently re-scoped, over the workspace just clicked into).
    if (settingsOpen) closeSettings();
    if (wsettingsOpen) closeWSettings();
    leaveReleaseNotes();
  }, [settingsOpen, closeSettings, wsettingsOpen, closeWSettings, leaveReleaseNotes]);
  const openDmFromHome = useCallback(
    (channelId: string) => {
      leaveSettings();
      setActiveChannelId(channelId);
      setActiveThread(null);
    },
    [leaveSettings],
  );
  /**
   * The #94 picker's selection path: open (or return the existing) DM with
   * a member, store the channel row (a fresh DM is unknown to the store —
   * nothing else writes DM rows), and navigate EXACTLY as an existing DM
   * row does (openDmFromHome). Dedup reads the store fresh per call, so
   * selecting the same member twice hits the network once.
   */
  const startDmWith = useMemo(
    () =>
      makeStartDm({
        channelsSnapshot: () => defaultStore.getState().channels,
        openDm: (memberId) => api.createDM(memberId),
        onDmReady: (channel) => {
          defaultStore.setState((s) => ({
            channels: { ...s.channels, [channel.id]: channel },
          }));
          openDmFromHome(channel.id);
        },
      }),
    [openDmFromHome],
  );
  const openChannelFromHome = useCallback(
    (channelId: string) => {
      leaveSettings();
      setHomeOverride(store.channels[channelId]?.type === 'dm');
      setActiveChannelId(channelId);
      setActiveThread(null);
    },
    [store.channels, leaveSettings],
  );
  const openThreadFromHome = useCallback(
    (threadId: string, channelId: string) => {
      leaveSettings();
      setHomeOverride(false);
      setActiveChannelId(channelId);
      setActiveThread({
        threadId,
        channelId,
        parentMessageId:
          defaultStore.getState().threadsById[threadId]?.parent_message_id ?? null,
      });
    },
    [leaveSettings],
  );
  /**
   * The rail's Threads rows carry only a thread id, so resolve the channel
   * from the store and reuse the same navigation as Home's own thread rows
   * (leave settings, drop the Home override, select the channel, open the
   * panel).
   */
  const openThreadById = useCallback(
    (threadId: string) => {
      const channelId =
        defaultStore.getState().threadsById[threadId]?.channel_id ?? activeChannelId;
      if (channelId == null) return;
      openThreadFromHome(threadId, channelId);
    },
    [activeChannelId, openThreadFromHome],
  );
  const selectWorkspace = useCallback(
    (workspaceId: string) => {
      leaveSettings();
      setHomeOverride(false);
      // A workspace switch is a clean navigation: a docked thread belongs to
      // the PREVIOUS workspace's channel and must not persist into the new
      // one (the channel itself re-defaults to the top-most channel via the
      // shouldDefaultChannel effect, because the old channel is not a member
      // of the new workspace's list).
      setActiveThread(null);
      setActiveWorkspaceId(workspaceId);
    },
    [leaveSettings],
  );

  // Server-header flows (Discord parity): create workspace / channel, mint
  // invites, accept invites. Each writes straight into the U17 store so the
  // sidebar + rail react like any gateway-driven change would.
  const handleCreateWorkspace = useCallback(async (input: { name: string }) => {
    const created = await api.createWorkspace({ name: input.name });
    // api-client unwraps the create envelope; normalize to the read model
    // the store carries (icon/role fields may be absent on create).
    const workspace: Workspace = {
      id: created.id,
      name: created.name,
      icon_url: created.icon_url ?? null,
      description: created.description ?? null,
      owner_id: created.owner_id,
      role_version: created.role_version ?? 0,
      created_at: created.created_at,
    };
    defaultStore.setState((s) => ({
      workspaces: { ...s.workspaces, [workspace.id]: workspace },
    }));
    setActiveWorkspaceId(workspace.id);
    setActiveChannelId(null);
    return workspace;
  }, []);

  const handleCreateChannel = useCallback(
    async (input: {
      name: string;
      topic?: string;
      type?: 'text' | 'category';
      parent_id?: string | null;
    }) => {
      if (!activeWorkspaceId) throw new Error('No active workspace.');
      const channel = await api.createChannel(activeWorkspaceId, {
        name: input.name,
        type: input.type ?? 'text',
        topic: input.topic,
        parent_id: input.parent_id ?? null,
      });
      // Optimistic-ish write: the workspace-scoped ChannelCreate fan-out may
      // also land; overwriting the same id converges either way.
      defaultStore.setState((s) => ({
        channels: { ...s.channels, [channel.id]: channel },
      }));
      setActiveChannelId(channel.id);
      setActiveThread(null);
      return channel;
    },
    [activeWorkspaceId],
  );

  // Channel settings (gear menu): rename / topic / move between categories.
  // The api-client normalizes the wire type, so the store row stays a valid
  // domain Channel (category rows included).
  const handleUpdateChannel = useCallback(
    async (
      channelId: string,
      patch: { name?: string; topic?: string | null; parent_id?: string | null },
    ) => {
      const channel = await api.updateChannel(channelId, patch);
      defaultStore.setState((s) => ({
        channels: { ...s.channels, [channel.id]: channel },
      }));
    },
    [],
  );

  const handleCreateInvite = useCallback(
    async (input: { maxAgeSeconds: number; maxUses: number }) => {
      if (!activeWorkspaceId) throw new Error('No active workspace.');
      const invite = await api.createInvite(activeWorkspaceId, {
        max_age_s: input.maxAgeSeconds,
        max_uses: input.maxUses,
      });
      return { code: invite.code };
    },
    [activeWorkspaceId],
  );

  // Invite People is offered only to a viewer holding CREATE_INVITES (the
  // server's gate); unknown keeps the entry and the dialog's 403 copy.
  const fetchWorkspacePermissions = useCallback((id: string) => api.getWorkspacePermissions(id), []);
  const canCreateInvites = useCanCreateInvites(
    activeWorkspaceId,
    authState.currentUser?.id ?? null,
    activeWorkspaceId ? store.workspaces[activeWorkspaceId]?.owner_id : null,
    fetchWorkspacePermissions,
  );
  // Renaming other members (#169): MANAGE_NICKNAMES, read the same way.
  const canManageNicknames = useWorkspaceCan(
    'MANAGE_NICKNAMES',
    activeWorkspaceId,
    authState.currentUser?.id ?? null,
    activeWorkspaceId ? store.workspaces[activeWorkspaceId]?.owner_id : null,
    fetchWorkspacePermissions,
  );

  const handleAcceptInvite = useCallback(
    async (code: string) => {
      const token = authStore.getState().getAccessToken();
      if (!token) throw new Error('Sign in to accept this invite.');
      const workspaceId = await acceptInvite(code, token);
      try {
        sessionStorage.removeItem(PENDING_INVITE_KEY);
      } catch {
        // storage unavailable — resume simply re-prompts
      }
      setActiveWorkspaceId(workspaceId);
      setActiveChannelId(null);
      setInviteJoinNonce((n) => n + 1);
      navigate('/');
    },
    [navigate],
  );

  // Hydration (lane D #1 / #5). READY now carries the entity roster
  // (workspaces, channels, DMs) and applies it in the same commit that marks
  // the session — no REST waterfall, and nothing is wiped first: a READY
  // keeps the member's data as stale content until its replacement lands
  // whole. What READY does not carry — thread rosters per channel, member
  // rosters per workspace — is read here, IN PARALLEL, into local maps and
  // swapped in with ONE store write per slice (replace, not merge, so a
  // deleted thread or a departed member actually goes).
  //
  // The REST roster read survives as the fallback for a server whose READY
  // carries no roster (`rosterSource` still not 'server' after READY), and
  // after an invite accept (the new workspace is not in the session's READY).
  //
  // Calls plan U6 — call state has NO leg here by design: CALL_SYNC over the
  // gateway covers every live call on Identify/Resume, and idle channels learn
  // their standing call-log thread on demand (U9's getCall).
  const sessionEpoch = store.sessionEpoch;
  const rosterSource = store.rosterSource;
  // Re-assert the presence preference on every fresh gateway session — the
  // server forgets preferences when the last socket closes.
  useEffect(() => {
    if (sessionEpoch === 0) return;
    // The socket can already be gone again by the time this runs (a flapping
    // connection; a test harness that refuses the gateway). The send throws
    // GatewayOfflineError then, and a throw inside a commit's effects aborts
    // the ones after it — the roster hydration below among them. The next
    // session re-asserts the preference, so an offline send is simply skipped.
    try {
      session.getGateway()?.updatePresence(selfStatus);
    } catch {
      // offline — the next READY re-asserts it
    }
  }, [sessionEpoch]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Nothing to hydrate against until the session's READY has landed (the
    // device snapshot, if any, is already on screen meanwhile).
    if (sessionEpoch === 0) return;
    if (hydrationInFlight.current) return;
    hydrationInFlight.current = true;
    hydrationRuns.current += 1;
    const needsRestRoster =
      defaultStore.getState().rosterSource !== 'server' || inviteJoinNonce !== lastInviteNonce.current;
    lastInviteNonce.current = inviteJoinNonce;
    void (async () => {
      try {
        setHydrationError(null);
        if (needsRestRoster) {
          // All three reads in flight at once; the roster REPLACES the store's
          // only when every read succeeded — a partial roster would delete
          // the workspaces whose read failed.
          const [{ items: wsList }, dms] = await Promise.all([
            api.listWorkspaces(),
            api.listDMChannels().then(
              (r) => r.items,
              () => null, // the DM column keeps what it has; the picker still works
            ),
          ]);
          const channelLists = await Promise.all(wsList.map((w) => api.listChannels(w.id)));
          replaceRoster(defaultStore, {
            workspaces: wsList,
            channels: channelLists.flatMap((r) => r.items),
            dmChannels: dms,
          });
        }

        const state = defaultStore.getState();
        const workspaceIds = Object.keys(state.workspaces);
        const channelsToRead = Object.values(state.channels).filter(
          (c) => c.workspace_id !== null && c.type !== 'category',
        );
        const token = authStore.getState().getAccessToken() ?? undefined;

        // Threads and members in parallel (they used to run serially per
        // workspace, after the channel list, before the DM list).
        const threadsByChannel: Record<string, Thread[]> = {};
        const membersByWorkspace: Record<string, WorkspaceMember[]> = {};
        // Workspaces whose first people page is not the whole roster: the
        // rest is named on demand (memberResolver), never paged in here.
        const partialRosters = new Set<string>();
        await Promise.all([
          mapWithConcurrency(channelsToRead, HYDRATION_FANOUT_LIMIT, async (c) => {
            try {
              threadsByChannel[c.id] = await api.listThreads(c.id);
            } catch {
              // Thread nav is additive; a failed read keeps what is there.
            }
          }),
          Promise.all(
            workspaceIds.map(async (workspaceId) => {
              try {
                const page = await fetchPeoplePage({ workspaceId, token });
                // The roster row's principal kind rides through: Home draws
                // the agent seal from it (DM rows, the picker's unmessagable
                // state). Dropping it here left every DM surface unable to
                // tell an agent from a person (owner report 2026-09-15).
                membersByWorkspace[workspaceId] = page.people.map(memberFromPeopleRow);
                if (page.next_before) partialRosters.add(workspaceId);
              } catch {
                // Directory surface owns its member-fetch error states.
              }
            }),
          ),
        ]);
        replaceThreads(defaultStore, threadsByChannel);
        replaceMembers(defaultStore, membersByWorkspace, partialRosters);
        // In a workspace larger than a page the viewer's own row may sit
        // beyond it; membership checks (the call gate) read the list.
        const selfId = defaultStore.getState().currentUser?.id;
        if (selfId) {
          for (const workspaceId of partialRosters) {
            memberResolver.current?.request(workspaceId, [selfId], { membership: true });
          }
        }
      } catch (err) {
        // The shell surfaces the banner; individual surfaces own retry UX.
        setHydrationError(err instanceof Error ? err.message : 'Could not load your workspaces.');
      } finally {
        hydrationInFlight.current = false;
        setHydrationDone(true);
      }
    })();
  }, [sessionEpoch, inviteJoinNonce]);

  // A roster from READY that lands while a REST fallback is not needed still
  // ends the "loading" state for surfaces that announce it.
  useEffect(() => {
    if (rosterSource === 'server') setHydrationDone(true);
  }, [rosterSource]);

  /*
   * Lane D #3: the boot cover (index.html) stays up until the shell has the
   * member's roster to paint — never Home-then-jump. READY carries it (or the
   * device snapshot restored it); a slow server gets the shell after a bound,
   * and a hydration failure shows its banner instead of a cover.
   */
  useEffect(() => {
    if (rosterKnown || hydrationError !== null) {
      dismissBootCover();
      return;
    }
    const t = setTimeout(dismissBootCover, ROSTER_COVER_MAX_WAIT_MS);
    return () => clearTimeout(t);
  }, [rosterKnown, hydrationError]);

  // Lane D #23: fetch into the cached windows whatever a disconnect skipped
  // (a fresh READY, a RESUMED, `online`, window focus).
  const activeChannelRef = useRef<string | null>(activeChannelId);
  activeChannelRef.current = activeChannelId;
  useEffect(
    () =>
      startGapRepair({
        store: defaultStore,
        api,
        activeChannelId: () => activeChannelRef.current,
      }),
    [],
  );

  // Lane D #7: warm the secondary surfaces' chunks once the shell is idle;
  // the desktop member rail opens on the directory, so that one goes first.
  useEffect(() => {
    prefetchSecondarySurfaces(band === 'desktop' ? ['people'] : []);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Lane D #16: the recency bound — the open channel joins the recent set,
  // and whatever falls out of it is trimmed back to one page.
  useEffect(() => {
    if (activeChannelId !== null) touchChannel(defaultStore, activeChannelId);
  }, [activeChannelId]);

  // Lane D #3: remember where the member is, for the next boot.
  useEffect(() => {
    if (!rosterKnown) return; // never overwrite the restored location with a pre-roster guess
    writeLastLocation(selfIdAtMount, {
      home: homeActive,
      workspaceId: activeWorkspaceId,
      channelId: activeChannelId,
    });
  }, [rosterKnown, selfIdAtMount, homeActive, activeWorkspaceId, activeChannelId]);

  // Pick the first workspace until the user chooses one — and replace a
  // restored one (lane D #3) the member no longer belongs to. Only against a
  // KNOWN roster: before it lands, the restored id stands.
  useEffect(() => {
    if (!rosterKnown || workspaces.length === 0) return;
    if (activeWorkspaceId == null || store.workspaces[activeWorkspaceId] === undefined) {
      setActiveWorkspaceId(workspaces[0]!.id);
    }
  }, [workspaces, activeWorkspaceId, rosterKnown, store.workspaces]);

  // Derive workspace → channel ids (U17 has no prebuilt index). Memoized on
  // the channel slice alone.
  const channelIdsByWorkspace = useMemo(() => channelIndex(store.channels), [store.channels]);

  // Self presence, for the surfaces that render it (each subscribes to the
  // presence slice itself — see `useLivePresence`).
  const selfOnline = store.sessionStatus === 'ready' || store.sessionStatus === 'resumed';
  const selfDisplay: Presence = selfStatus === 'invisible' ? 'offline' : selfStatus;
  const selfPresenceId = store.currentUser?.id ?? null;
  const selfPresence = useMemo<SelfPresence>(
    () => ({ id: selfPresenceId, display: selfDisplay, online: selfOnline }),
    [selfPresenceId, selfDisplay, selfOnline],
  );


  // Home's Call log tab surveys every workspace channel's call surface.
  // Identity-stable on purpose: AllCallsList fans out up to 60
  // `GET /channels/:id/call` requests keyed on this array, so a fresh array per
  // store write (every gateway event) restarted the whole fan-out. Stability
  // comes from the selector (`useStableChannelList`, plan 7.3): the array keeps
  // its identity while the channel records do, which a DM's recipient update —
  // the one write that re-identifies `channels` without touching this roster —
  // no longer disturbs. (This was a `JSON.stringify` roster key, re-serialized
  // on every render.)
  const workspaceChannels = useStableChannelList<Channel, StateState['channels']>(
    defaultStore,
    channelSource,
    workspaceChannelOptions,
    sameChannelRow,
  );

  // Default the channel to the workspace's first TEXT channel — categories
  // are channel rows too, and selecting one opens a header with no messages
  // (the list order puts a category first when it sorts above its children).
  //
  // The decision is a table-tested predicate (`shouldDefaultChannel`), because
  // BOTH halves of it were learned from bugs: a hash-pinned channel (#114) and
  // a DM selected on Home must both survive it. A DM belongs to no workspace,
  // so it can never appear in `ids` — and this effect used to "correct" a
  // selected DM away to the workspace's first channel one render after the
  // click, which is why selecting a DM on Home showed the DASHBOARD instead of
  // the conversation (owner report 2026-09-14: "click on an existing one col 3
  // should change to the usual message interface … no new concepts here").
  // `activeWorkspaceId` is still whatever workspace was last open, so the
  // correction ran even though Home was the active surface.
  useEffect(() => {
    if (activeWorkspaceId == null) return;
    // Lane D #3: a restored channel is only "stale" against a KNOWN roster.
    if (!rosterKnown) return;
    const ids = (channelIdsByWorkspace[activeWorkspaceId] ?? []).filter(
      (id) => store.channels[id]?.type !== 'category',
    );
    const defaulting = shouldDefaultChannel({
      activeChannelId,
      workspaceChannelIds: ids,
      hashPinned: permalink?.channelId ?? null,
      homeActive,
      selectedType: activeChannelId == null ? undefined : store.channels[activeChannelId]?.type,
    });
    if (defaulting) setActiveChannelId(ids[0] ?? null);
  }, [
    channelIdsByWorkspace,
    activeWorkspaceId,
    activeChannelId,
    store.channels,
    permalink,
    homeActive,
    rosterKnown,
  ]);

  /*
   * The permalink's own navigation (#114): open the workspace and channel the
   * address names, show the channel pane (a DM lives on Home), and hand the
   * message id down so the list can land on it. A thread SEGMENT opens the
   * dock immediately; without one the dock still opens a beat later, when the
   * resolved message reports its `thread_id` (`handlePermalinkMessage`).
   *
   * Runs on every hash change to a new permalink — and is idempotent, so the
   * roster arriving later simply re-asserts the same state.
   */
  useEffect(() => {
    if (permalink === null) return;
    const channel = defaultStore.getState().channels[permalink.channelId];
    leaveSettings();
    setHomeOverride(channel?.type === 'dm');
    const workspaceId = permalink.workspaceId ?? channel?.workspace_id ?? null;
    if (workspaceId !== null) setActiveWorkspaceId(workspaceId);
    setActiveChannelId(permalink.channelId);
    if (permalink.threadId !== null) {
      setActiveThread({
        threadId: permalink.threadId,
        channelId: permalink.channelId,
        parentMessageId:
          defaultStore.getState().threadsById[permalink.threadId]?.parent_message_id ?? null,
      });
    } else {
      setActiveThread(null);
    }
  }, [permalink, leaveSettings]);

  /*
   * The CHANNEL route: `#/workspace/{ws}/channel/{ch}` (and the DM form,
   * `#/channel/{ch}`) — what a `#channel` pill links to, and what a pasted or
   * back/forward address can carry. Before this effect nothing acted on it:
   * the pill changed the address and the pane stayed put (live suite,
   * 2026-09-29).
   *
   * It opens the channel EXACTLY as the sidebar does — leave any settings
   * surface, put the right surface up (Home for a DM, the channel's workspace
   * otherwise), then `selectChannel`, the sidebar row's own handler — so there
   * is one navigation, not a pill-flavoured copy of it.
   *
   * Permissions come from the store, which only ever holds channels the reader
   * can see (the same rule that renders an unseeable channel's pill as
   * `#unknown-channel`, never as a link). So an address for a channel that is
   * not there once the SERVER's roster is known is "not available": the pane
   * stays where it was and a notice says so. Before that roster (a cached
   * snapshot, or none yet) the route simply waits — a channel created since
   * the snapshot is not a missing one.
   *
   * Applied ONCE per address (`appliedChannelRouteRef`): the effect re-runs
   * on every roster change, and re-asserting the route then would drag a
   * reader who has since clicked elsewhere back to the linked channel.
   */
  const channelRoute = useMemo(() => {
    const target = parsePermalinkPath(path);
    if (target === null || target.kind !== 'channel' || target.channelId === undefined) {
      return null;
    }
    return { path, channelId: target.channelId };
  }, [path]);
  const routedChannel = channelRoute ? store.channels[channelRoute.channelId] : undefined;
  const routedChannelOpenable =
    routedChannel !== undefined &&
    (routedChannel.type === 'dm' ||
      (routedChannel.type === 'text' && routedChannel.workspace_id != null));
  const [channelRouteNotice, setChannelRouteNotice] = useState<string | null>(null);
  const appliedChannelRouteRef = useRef<string | null>(null);
  const channelRouteLandedRef = useRef(false);
  useEffect(() => {
    if (channelRoute === null) {
      appliedChannelRouteRef.current = null;
      return;
    }
    if (appliedChannelRouteRef.current === channelRoute.path) return;
    const channel = defaultStore.getState().channels[channelRoute.channelId];
    if (routedChannelOpenable && channel !== undefined) {
      appliedChannelRouteRef.current = channelRoute.path;
      channelRouteLandedRef.current = false;
      setChannelRouteNotice(null);
      leaveSettings();
      const isDm = channel.type === 'dm';
      setHomeOverride(isDm);
      if (!isDm && channel.workspace_id != null) setActiveWorkspaceId(channel.workspace_id);
      selectChannel(channelRoute.channelId);
      return;
    }
    if (store.rosterSource !== 'server') return;
    appliedChannelRouteRef.current = channelRoute.path;
    setChannelRouteNotice(CHANNEL_ROUTE_UNAVAILABLE);
    clearHashRoute(channelRoute.path);
  }, [channelRoute, routedChannelOpenable, store.rosterSource, leaveSettings, selectChannel]);

  /*
   * Once the reader moves on from a routed channel (a sidebar click, a DM, a
   * workspace switch), the address stops naming what is on screen — so it is
   * cleared back to the bare route, in place (no new history entry). Without
   * this a reload would reopen the LINKED channel instead of where the reader
   * is, and clicking the same pill again would not change the address, so
   * nothing would fire.
   */
  useEffect(() => {
    if (channelRoute === null || appliedChannelRouteRef.current !== channelRoute.path) {
      channelRouteLandedRef.current = false;
      return;
    }
    // The route's own selection lands a render AFTER it is applied; only a
    // move away from it once it has landed is the reader leaving.
    if (activeChannelId === channelRoute.channelId) {
      channelRouteLandedRef.current = true;
      return;
    }
    if (channelRouteLandedRef.current) clearHashRoute(channelRoute.path);
  }, [channelRoute, activeChannelId]);

  // The "not available" notice clears on the next routed channel, or on its own.
  useEffect(() => {
    if (channelRouteNotice === null) return;
    const timer = setTimeout(() => setChannelRouteNotice(null), CHANNEL_ROUTE_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [channelRouteNotice]);

  /**
   * The permalink target, once the pane's list has it (#114): open the thread
   * when the message turns out to be a reply. The address may carry no thread
   * segment at all — the resolved `thread_id` is the truth, and a link written
   * by hand (or by an older client) still lands inside the thread.
   */
  const handlePermalinkMessage = useCallback((message: Message) => {
    const threadId = message.thread_id ?? null;
    if (threadId === null) return;
    setActiveThread((current) => {
      if (current?.threadId === threadId) return current;
      return {
        threadId,
        channelId: message.channel_id,
        parentMessageId:
          defaultStore.getState().threadsById[threadId]?.parent_message_id ?? null,
      };
    });
  }, []);

  /**
   * The message the ACTIVE pane must land on (#114). Scoped to the channel the
   * address names, so navigating elsewhere does not re-fire a landing in
   * whichever channel happens to be open.
   */
  const focusMessageId =
    permalink !== null && permalink.channelId === activeChannelId ? permalink.messageId : null;

  // The active home conversation: a DM selected in the home column renders
  // the MessagePane (which owns the DM header + call indicator); anything
  // else on home shows the dashboard. Peer name resolves from the channel's
  // recipients (the DmCallIndicator seam).
  const activeDm =
    homeActive && activeChannelId && store.channels[activeChannelId]?.type === 'dm'
      ? store.channels[activeChannelId]!
      : null;
  // `||`, not `??`: an unresolvable peer arrives as an empty recipients list
  // with `name: ''`, and the nullish chain would hand the pane header an empty
  // string (the same defect as the DM row's — user report 2026-09-14).
  const dmPeerName = activeDm
    ? (activeDm.recipients?.find((r) => r.id !== store.currentUser?.id)?.username ||
      activeDm.name ||
      'Unknown')
    : undefined;

  // U2: the channel call-header derivation, lifted out of MessagePane into
  // the shared useChannelCallHeader hook — ONE derivation feeds both the
  // pane header and the mobile topbar's join-voice control, so the affordance
  // states can never drift between chrome and content. The intents route
  // through the same engine the pane header uses; at mobile the resulting
  // leg opens the existing CallPanel bottom sheet (CallPanelSurface).
  //
  // The hook whole-store-subscribes, so its call site moved into
  // `TopbarCallSurface` below (plan 1.1): the shell only decides WHETHER the
  // control shows, and does that from its gated snapshot.
  // canStartCall (AM17 gate): the server's @everyone base grants every
  // workspace member VIEW + SEND + START_CALL (voice plan U3 KTD7) and stays
  // channel-overridable; the client store carries no role bitfields or
  // channel overwrites yet, so the honest client-side resolution is
  // membership/ownership of the channel's workspace (the server re-evaluates
  // every op-22 and remains authoritative). DMs never gate through here —
  // participation IS the authorization on the DmCallIndicator path.
  const activeChannel = activeChannelId ? store.channels[activeChannelId] : undefined;
  const activeIsDm = activeChannel?.type === 'dm';
  const selfId = authState.currentUser?.id ?? null;
  // Extracted (review #7): the topbar's call/title model lives beside its
  // data; the pure gate is table-tested in useChannelCallGate.test.
  // A takeover surface (settings, workspace or server settings, release notes)
  // covers the pane on a phone, so the topbar names IT — the way Home and a
  // DM title themselves — not the channel underneath, and drops that
  // channel's controls. Same precedence as the pane column below.
  const takeoverTitle = releaseNotes.open
    ? 'Release notes'
    : serverSettings.open
      ? 'Server settings'
      : wsettingsOpen
        ? 'Workspace settings'
        : settingsOpen
          ? 'Settings'
          : null;
  const { canStartCall, mobileTitle, mobileTitleSigil } = useChannelCallGate(store, {
    takeoverTitle,
    homeActive,
    activeChannelId,
    activeWorkspaceId,
    activeChannel,
    activeDm,
    dmPeerName,
    selfId,
  });
  // The nav trigger's face (2026-09-18): the active workspace's rail icon —
  // the same renderer the desktop rail uses — replaces the ☰ glyph.
  const activeWorkspace = activeWorkspaceId ? store.workspaces[activeWorkspaceId] : undefined;
  // The topbar's join-voice control renders for the active WORKSPACE
  // channel (Home and DM conversations keep their own call surfaces).
  // Notification controls (2026-09-27): the phone band folds the pane header
  // away for workspace channels, so the header's level control rides the
  // topbar beside join-voice — tap cycles, long-press opens the bottom sheet.
  // (A DM keeps its pane header at phone width, control included.)
  const topbarCallAction =
    !homeActive && takeoverTitle === null && activeChannel && !activeIsDm ? (
      <>
        <NotificationLevelControl
          target={channelTarget(activeChannel.id, activeChannel.workspace_id)}
          variant="sheet"
          className={headerIconButtonClass}
          iconSize={18}
          targetName={`#${activeChannel.name}`}
          testIdPrefix="topbar-notifications"
        />
        <TopbarCallSurface channelId={activeChannelId} canStartCall={canStartCall} />
      </>
    ) : null;

  // Bottom-left identity panel — column 2's footer (the shell owns placement;
  // the rail column ends in the build badge instead).
  const currentUser = authStore.getState().currentUser;
  const userPanel = currentUser ? (
    <UserPanel
      user={{
        id: currentUser.id,
        name: currentUser.username,
        handle: `@${currentUser.username}`,
        avatarUrl: currentUser.avatar_url ?? null,
        status: selfOnline ? selfDisplay : 'offline',
      }}
      selfStatus={selfStatus}
      onSelfStatus={handleSelfStatus}
      settingsOpen={settingsOpen}
      onToggleSettings={() => {
        if (settingsOpen) {
          closeSettings();
        } else if (isMobile) {
          // U5: the gear lands on the mobile LIST (the bare prefix — the
          // full-width pane stack); desktop opens the account section.
          navigate(SETTINGS_ROUTE_PREFIX);
        } else {
          openSettingsSection('account');
        }
      }}
    />
  ) : null;

  // Integrations channel options, identity-stable across store updates.
  // This array used to be rebuilt inline in the panel's props, so EVERY
  // store update (each gateway event) handed WebhooksPane a fresh identity
  // and its fetch effect cancelled + refetched every channel's webhooks
  // per event. Identity now comes from the selector (`useStableChannelList`,
  // plan 7.3): unrelated store writes leave the array's reference untouched,
  // and only roster/name changes for the active workspace re-derive it. (This
  // was a `JSON.stringify` id+name key, re-serialized on every render.)
  // The integrations selector is the one that also reads a COMPONENT input
  // (the active workspace), so its identity is keyed on it — a change is a new
  // selection and the hook recomputes — while every other store write leaves
  // it untouched.
  const integrationChannelOptions = useCallback(
    (s: StateState): ChannelOption[] =>
      (activeWorkspaceId ? (channelIdsByWorkspace[activeWorkspaceId] ?? []) : []).map((id) => ({
        id,
        name: s.channels[id]?.name ?? id,
      })),
    [activeWorkspaceId, channelIdsByWorkspace],
  );

  const integrationChannels = useStableChannelList<ChannelOption, StateState['channels']>(
    defaultStore,
    channelSource,
    integrationChannelOptions,
    sameChannelOption,
  );

  // The agent access tree spans EVERY workspace the caller is in (R5: an
  // agent's credential is user-scoped; workspaces appear only as grants), so
  // it takes the list rather than the active workspace.
  const integrationWorkspaces = useMemo<TreeWorkspace[]>(
    () => workspaces.map((w) => ({ id: w.id, name: w.name })),
    [workspaces],
  );

  /**
   * The tree's per-channel levels need the channels of a workspace the client
   * may never have opened, so they are fetched on expand. The store may
   * already hold them (a hydrated workspace) — prefer that, and fall back to
   * the API for workspaces that were never opened this session.
   */
  const integrationLoadChannels = useCallback(
    async (workspaceId: string): Promise<ChannelOption[]> => {
      const known = (channelIdsByWorkspace[workspaceId] ?? [])
        .map((id) => store.channels[id])
        .filter((c): c is NonNullable<typeof c> => c != null)
        .map((c) => ({ id: c.id, name: c.name }));

      if (known.length > 0) return known;

      const { items } = await api.listChannels(workspaceId);

      // Categories are sidebar structure, not grantable channels (the picker
      // in the tree offers the same set the composer can post into). The
      // api-client boundary has already normalized the wire type.
      return items
        .filter((c) => c.type !== 'category')
        .map((c) => ({ id: c.id, name: c.name }));
    },
    [channelIdsByWorkspace, store.channels],
  );

  // U5: the section bodies are identical across the desktop pane and the
  // mobile section view — hoisted so both branches reuse the same wiring.
  const settingsSectionBody =
    settingsSection === 'account' ? (
      <AccountSection
        user={authState.currentUser}
        onSaveProfile={handleSaveProfile}
        onUploadAvatar={handleUploadAvatar}
        onResendVerification={handleResendVerification}
        onSendPasswordReset={handleSendPasswordReset}
        onSignOutEverywhere={handleSignOutEverywhere}
        onDeleteAccount={handleDeleteAccount}
        passkeys={passkeysApi}
        twoFactor={twoFactorApi}
      />
    ) : settingsSection === 'appearance' ? (
      <AppearanceSection />
    ) : settingsSection === 'emoji' ? (
      <ReactionEmojiSection />
    ) : settingsSection === 'notifications' ? (
      <NotificationsSection
        load={loadNotificationRows}
        setLevel={saveNotificationLevel}
        subscribe={subscribeNotificationPrefs}
        setSuppressBroadcasts={saveBroadcastSuppression}
        permission={notificationPermission}
        onEnable={enableNotifications}
        onDisable={disableNotifications}
        onRestorePrompt={() => {
          clearPromptDismissal();
          setPromptEpoch((n) => n + 1);
        }}
        // The self-test fires at the CALLER's own devices — no target
        // parameter exists server-side, so this cannot reach anyone else.
        onSendTest={() => api.sendTestNotification()}
        subscribed={pushSubscribed}
      />
    ) : settingsSection === 'ssh' ? (
      // U3 (tui plan): keys + certificates. The username is the certificate's
      // sole principal (KTD3), so it is what the install instructions must
      // print as the `ssh -l` login name.
      <SshSection username={authState.currentUser?.username ?? ''} />
    ) : settingsSection === 'webhooks' ? (
      <WebhooksSection
        workspaces={integrationWorkspaces}
        activeWorkspaceId={activeWorkspaceId}
        channels={integrationChannels}
        loadChannels={integrationLoadChannels}
        online={online}
      />
    ) : (
      // The ONE management surface for an agent (KD1): the rail overlay's pane,
      // moved here. Replaces the read-only rollup that used to sit beside it.
      <AgentsSection
        workspaces={integrationWorkspaces}
        loadChannels={integrationLoadChannels}
        online={online}
      />
    );
  const wsettingsBody = (
    <WorkspaceOverview
      workspace={activeWorkspaceId ? (store.workspaces[activeWorkspaceId] ?? null) : null}
      isAdmin={
        !!activeWorkspaceId &&
        !!authState.currentUser &&
        store.workspaces[activeWorkspaceId]?.owner_id === authState.currentUser.id
      }
      onUploadIcon={(file) => handleUploadWorkspaceIcon(activeWorkspaceId!, file)}
      onRename={(name) => handleRenameWorkspace(activeWorkspaceId!, name)}
      onRemoveIcon={() => handleRemoveWorkspaceIcon(activeWorkspaceId!)}
    />
  );

  // Flow F1 (authenticated leg): the invite landing owns the screen until
  // the join completes — accept → store re-hydration → land in the joined
  // workspace's default channel.
  if (inviteCode) {
    return <InviteLandingPage code={inviteCode} authenticated onAccept={handleAcceptInvite} />;
  }

  return (
    <InboxProvider>
      {/* The in-app invitation to enable notifications. Browsers forbid a
          page opening the permission dialog on load, so this is the honest
          shape of "prompt on first visit": an affordance whose click supplies
          the gesture the browser requires. It asks once and respects both
          answers (see NotificationPrompt). */}
      {/* The `key` remounts the prompt after a "show it again" from settings:
          the dismissal is read once at mount, so clearing storage alone would
          not bring it back until a reload. */}
      <NotificationPrompt
        key={promptEpoch}
        permission={notificationPermission}
        onEnable={enableNotifications}
      />

      {/* The Cmd-K palette: one query over the caller's reachable messages
          (workspaces + DMs, permission-honoring server-side). */}
      {/* Lazy (lane D #7): mounted on first open, kept mounted after so a
          close/reopen does not refetch the chunk or lose its state. */}
      {omniEverOpened ? (
        <Suspense fallback={null}>
          <OmnisearchDialog
            open={omniOpen}
            onOpenChange={setOmniOpen}
            token={authStore.getState().getAccessToken()}
          />
        </Suspense>
      ) : null}

      {/* The post-PASSWORD-login passkey ask (owner direction 2026-09-15):
          the owner was never asked to set one, which they consider part of
          passkeys being on. It self-gates — armed only by a password login
          (passkey/SSO logins never set the flag), skipped when the account
          already holds a passkey, silent once "Not now" is recorded — and it
          reuses the Account section's enroll ceremony below. */}
      <PasskeyEnrollmentPrompt
        onListCredentials={passkeysApi.onList}
        onEnroll={passkeysApi.onEnroll}
      />

      <AppShell
        workspaceRail={
          <WorkspaceRail>
            <button
              type="button"
              className="rail-home"
              aria-label="Home"
              aria-current={homeActive ? 'page' : undefined}
              data-active={homeActive || undefined}
              data-testid="rail-home"
              onClick={() => {
                leaveSettings();
                setHomeOverride(true);
              }}
            >
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
                <path
                  d="M12 3 3 10h2v9h5v-6h4v6h5v-9h2z"
                  fill="currentColor"
                />
              </svg>
            </button>
            {/* The integrations rail entry is GONE (owner direction
                2026-09-14: management is user-scoped, so it belongs in user
                settings and nowhere else). Its two panes are settings sections
                now — see `#/settings/integrations` and `#/settings/webhooks` —
                and a stale `#/integrations/...` link still lands on them. */}
            <LiveWorkspaceSwitcher
              workspaces={workspaces}
              activeWorkspaceId={homeActive ? null : activeWorkspaceId}
              onSelect={selectWorkspace}
            />
          </WorkspaceRail>
        }
      channelSidebar={
        settingsOpen ? (
          // U5: at mobile the nav renders as the pane's full-width LIST, so
          // the drawer copy is dropped (the gear closes the drawer; the list
          // is the pane). The desktop col-2 menu is untouched.
          isMobile ? null : (
            <SettingsNav
              active={settingsSection}
              onSelect={openSettingsSection}
              onLogout={() => void session.logout()}
            />
          )
        ) : wsettingsOpen ? (
          isMobile ? null : (
            <WorkspaceSettingsNav
              workspaceName={
                (activeWorkspaceId && store.workspaces[activeWorkspaceId]?.name) || 'Workspace'
              }
              active={wsettingsSection}
              onSelect={openWSettingsSection}
            />
          )
        ) : homeActive ? (
          <InboxSurface>
            {(inbox) => (
              <LiveHomeSidebar
                self={selfPresence}
                activeChannelId={activeChannelId}
                onSelectDm={openDmFromHome}
                onSelectWorkspace={selectWorkspace}
                onSelectChannel={openChannelFromHome}
                onSelectThread={openThreadFromHome}
                onStartDm={startDmWith}
                onCreateWorkspace={handleCreateWorkspace}
                isOperator={!!authState.currentUser?.is_operator}
                onOpenServerSettings={serverSettings.openSurface}
                inbox={inbox}
              />
            )}
          </InboxSurface>
        ) : (
          <LiveChannelSidebar
            activeWorkspaceId={activeWorkspaceId}
            activeChannelId={activeChannelId}
            onSelectChannel={selectChannel}
            showWorkspaceSwitcher={false}
            serverName={
              (activeWorkspaceId && store.workspaces[activeWorkspaceId]?.name) || ''
            }
            onCreateChannel={handleCreateChannel}
            onUpdateChannel={handleUpdateChannel}
            onOpenThreads={setThreadsListChannelId}
            onCreateInvite={canCreateInvites === false ? undefined : handleCreateInvite}
            onCreateWorkspace={handleCreateWorkspace}
            onOpenWorkspaceSettings={() => {
              // U5: at mobile the entry lands on the wsettings LIST (the
              // bare prefix); desktop opens Overview directly.
              if (isMobile) navigate(WSETTINGS_ROUTE_PREFIX);
              else openWSettingsSection('overview');
            }}
          />
        )
      }
      messagePane={
        // The settings surfaces own the pane column while addressed (the
        // in-shell column swap the owner ratified — col2 menu, col3 content,
        // col4 hidden). #121's Server Settings takes the same takeover: the
        // operator's JSON editor renders where conversations do, its ✕
        // returns to the app root. U5: below 768px the user-settings stack
        // is list→content — at the bare prefix the nav IS the pane's
        // full-width list; a sectioned hash renders the content with a ←
        // back to the list, so deep links land on the section.
        releaseNotes.open ? (
          // First: the badge is reachable from every surface (settings
          // included), and the notes are what it just asked for.
          <Suspense fallback={null}>
            <ReleaseNotesPane onClose={releaseNotes.close} />
          </Suspense>
        ) : serverSettings.open ? (
          <Suspense fallback={null}>
            <ServerSettingsPage
              load={() => api.getServerConfig()}
              save={(config) => api.putServerConfig(config)}
              restart={() => api.restartServer()}
              onClose={serverSettings.close}
            />
          </Suspense>
        ) : wsettingsOpen ? (
          wsettingsMobileList ? (
            <WorkspaceSettingsNav
              workspaceName={
                (activeWorkspaceId && store.workspaces[activeWorkspaceId]?.name) || 'Workspace'
              }
              active={wsettingsSection}
              onSelect={openWSettingsSection}
              mobile
              onClose={closeWSettings}
            />
          ) : (
            <SettingsPane
              title="Workspace settings"
              onClose={closeWSettings}
              onBack={isMobile ? () => settingsBackTo(WSETTINGS_ROUTE_PREFIX) : undefined}
            >
              <Suspense fallback={null}>{wsettingsBody}</Suspense>
            </SettingsPane>
          )
        ) : settingsOpen ? (
          settingsMobileList ? (
            <SettingsNav
              active={settingsSection}
              onSelect={openSettingsSection}
              onLogout={() => void session.logout()}
              mobile
              onClose={closeSettings}
            />
          ) : (
            <SettingsPane
              title={sectionTitle(settingsSection)}
              onClose={closeSettings}
              onBack={isMobile ? () => settingsBackTo(SETTINGS_ROUTE_PREFIX) : undefined}
            >
              <Suspense fallback={null}>{settingsSectionBody}</Suspense>
            </SettingsPane>
          )
        ) : homeActive ? (
          activeDm ? (
            // A DM selected in the home column: the conversation pane (the
            // pane owns the DM header + call indicator). No workspace docks
            // here — thread/call-log docks are workspace-bound surfaces.
            // No epoch key (lane D #1): a fresh session no longer remounts the
            // pane — the gap repair refreshes the window underneath it.
            <div className="pane-split">
              <MessagePane
                channelId={activeChannelId}
                channelName={dmPeerName}
                viewOnly={!authState.emailVerified}
                focusMessageId={focusMessageId}
                onFocusMessage={handlePermalinkMessage}
              />
            </div>
          ) : (
            <>
              {/* The same rule the channel pane's header actions apply: at
                  desktop these icons are the CLOSED state's entry point only.
                  Once the column is open they render in ITS header (AppShell's
                  aside renders RailPane), and keeping this band as well put two
                  identical control sets on screen either side of the border,
                  with the pressed state ambiguous (user report 2026-09-13).
                  Below the desktop band the pane IS the rail, so the band
                  would double RailPane's own header.
                  "Open" means HOME's column (`homeRailMode`), not the channel
                  surface's mode: gating on `railMode` — Members by default at
                  desktop, yet never a column on Home — hid the band on every
                  desktop Home, which left My Threads unreachable there (live
                  suite, 2026-09-29). */}
              {isMobile || (band === 'desktop' && homeRailMode !== null) ? null : (
                <div className="rail-icons-band" data-testid="home-rail-icons">
                  <RailIcons
                    mode={homeRailMode}
                    onSelect={selectHomeRailMode}
                    modes={HOME_RAIL_MODES}
                  />
                </div>
              )}
            <InboxSurface>
              {(inbox) => (
                <LiveHomeDashboard
                  inbox={inbox}
                  loading={!rosterKnown && !hydrationDone}
                  username={currentUser?.username ?? null}
                  onSelectChannel={openChannelFromHome}
                  onCreateWorkspace={handleCreateWorkspace}
                />
              )}
            </InboxSurface>
            </>
          )
        ) : (
          // Not keyed by the session epoch any more (lane D #1): a remount
          // flashed the whole conversation on every reconnect. The gap
          // repair (app/gapRepair.ts) fetches what the disconnect skipped
          // into the SAME window, and the thread pane reloads its replies on
          // a fresh session itself.
          <div className="pane-split">
          {/* Tablet: an open thread REPLACES the conversation (ThreadSurface
              renders `.thread-pane`), so the message pane stands down — there
              is no room to hold both, which is exactly why the fixed dock was
              crushing the parent to 36px at 768px. */}
          {isTablet && activeThread ? null : (
          <MessagePane
            channelId={activeChannelId}
            canStartCall={canStartCall}
            channelName={
              activeChannelId ? store.channels[activeChannelId]?.name : undefined
            }
            channelTopic={
              activeChannelId ? (store.channels[activeChannelId]?.topic ?? undefined) : undefined
            }
            viewOnly={!authState.emailVerified}
            focusMessageId={focusMessageId}
            onFocusMessage={handlePermalinkMessage}
            onStartThread={handleStartThread}
            onOpenThread={handleOpenThreadFromRow}
            /* Tablet: the members entry point. Below 1280px the shell has no
               fourth grid track, so the member rail cannot exist — the list
               takes the pane instead and this toggle (which renders in the
               same corner in both states) flips it. Phone uses the topbar's
               👥.
               Desktop: these icons are the CLOSED state's entry point only.
               Once the column is open they render in ITS header (AppShell's
               aside renders RailPane), which is what the owner asked for on
               2026-09-13 — *"when opening do so in a way that slides over the
               three associated icons… when col4 is open the associated icons
               are in the header within it"*. Rendering them here as well would
               put two identical control sets on screen and leave the pressed
               state ambiguous.
               An open thread counts as the column being CLOSED here: the dock
               holds that slot and the column is not rendered, so gating on
               `railMode` alone (Members by default at desktop) left no icons
               anywhere while a thread was open — Members and My Threads were
               unreachable until the thread was closed. The icons then replace
               the thread (`threadHoldsColumn`). */
            headerActions={
              isMobile || (band === 'desktop' && railMode !== null && !threadHoldsColumn)
                ? undefined
                : railIconsElement
            }
          />
          )}
          {activeThread ? (
            // U3: responsive thread surface — the dock beside the pane on
            // desktop, a full-width sheet over the pane below 768px (the dock
            // crushed a 390px screen). The switch lives in ThreadSurface.
            // `parentMessageId` drives the origin lookup in BOTH modes: a
            // draft has no thread record to read it back from.
            (() => {
              // The parent row comes from its own subscription (see
              // `useThreadParentMessage`) — NOT off `store`, which no longer
              // tracks `messagesByChannel`.
              // The pinned origin's author is named inside the panel, by the
              // shared resolver every other author surface uses.
              const parentMessage = threadParentMessage;
              return (
                <ThreadSurface
                  threadId={activeThread.threadId}
                  channelId={activeThread.channelId}
                  parentMessageId={activeThread.parentMessageId}
                  draftName={activeThread.draftName}
                  parentMessage={parentMessage}
                  /* #114: a permalink to a reply opens the thread AT the reply. */
                  focusMessageId={focusMessageId}
                  onThreadCreated={handleThreadCreated}
                  onClose={() => setActiveThread(null)}
                />
              );
            })()
          ) : null}
          {callSurfaceChannel !== null &&
          !callSurfaceIsDm &&
          callSurfaceChannel === activeChannelId &&
          !callSurfaceHidden ? (
            <Suspense fallback={null}>
              <CallPanelSurface
                channelId={callSurfaceChannel}
                onClose={() => setCallSurfaceHidden(true)}
              />
            </Suspense>
          ) : null}
        </div>
        )
      }
      railContent={
        <ContextRail
          tabs={[
            {
              id: 'members',
              label: 'Members',
              testId: 'rail-tab-members',
              icon: (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h7v-2.5c0-.86.35-1.66.94-2.29C7.44 14.08 6.76 14 6 14zm10 0c-.29 0-.62.02-.97.05.69.63 1.12 1.47 1.12 2.45V19h6v-1.5c0-2.33-4.67-3.5-7-3.5zm-5 0c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"
                    fill="currentColor"
                  />
                </svg>
              ),
              content: (
                <LiveMemberRail
                  workspaceId={activeWorkspaceId}
                  query={railSearchOpen ? railSearchQuery : ''}
                  self={selfPresence}
                  profileMember={profileMember}
                  onSelectMember={setProfileMember}
                  onCloseProfile={closeProfile}
                  canManageNicknames={canManageNicknames}
                />
              ),
            },
            {
              id: 'calls',
              label: 'Call log',
              testId: 'rail-tab-calls',
              icon: (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M6.6 10.8a15.6 15.6 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z"
                    fill="currentColor"
                  />
                </svg>
              ),
              content: homeActive ? (
                <Suspense fallback={null}>
                  <AllCallsList
                    channels={workspaceChannels}
                    query={railSearchQuery}
                    onSelectChannel={openChannelFromHome}
                  />
                </Suspense>
              ) : activeChannelId ? (
                <Suspense fallback={null}>
                  <CallLogStandalone
                    key={activeChannelId}
                    channelId={activeChannelId}
                    query={railSearchQuery}
                  />
                </Suspense>
              ) : (
                <div className="people-directory">
                  <p className="home-empty">Select a channel to see its call log.</p>
                </div>
              ),
            },
            {
              /* Owner direction 2026-09-12: the 4th column carries members,
                 calls, and now Threads. Contextual like its siblings — a
                 workspace shows the ACTIVE CHANNEL's roster (the exhaustive
                 REST read the ⋯ Threads dialog uses, so the two agree), Home
                 shows the cross-workspace set of threads you follow. */
              id: 'threads',
              label: 'Threads',
              testId: 'rail-tab-threads',
              icon: (
                <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
                  <path
                    d="M20 2H4a2 2 0 0 0-2 2v18l4-4h14a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-3 10H7v-2h10v2zm0-4H7V6h10v2z"
                    fill="currentColor"
                  />
                </svg>
              ),
              content: homeActive ? (
                <HomeThreadsRail
                  onOpenThread={openThreadById}
                  activeThreadId={activeThread?.threadId ?? null}
                />
              ) : (
                <Suspense fallback={null}>
                  <ThreadsListPanel
                    channelId={activeChannelId}
                    query={railSearchQuery}
                    onOpenThread={openThreadById}
                  />
                </Suspense>
              ),
            },
          ]}
          active={shownRailMode ?? 'members'}
          search={{
            open: railSearchOpen,
            onToggle: toggleRailSearch,
            query: railSearchQuery,
            onQueryChange: setRailSearchQuery,
            placeholder: homeActive
              ? railTab === 'members'
                ? 'Search all members'
                : railTab === 'threads'
                  ? 'Search all threads'
                  : 'Search calls'
              : railTab === 'members'
                ? 'Search members'
                : railTab === 'threads'
                  ? 'Search threads'
                  : 'Filter this log',
          }}
        />
      }

      loading={false}
      offline={!online}
      viewOnly={!authState.emailVerified}
      userPanel={userPanel}
      railFooter={<VersionBadge />}
      /* Phones have no rail footer; the drawer's footer carries the same
         badge so the release notes are reachable there too (the drawer
         closes on the click — the footer's own idiom). */
      drawerFooter={<VersionBadge />}
      mobileTitle={mobileTitle}
      mobileTitleSigil={mobileTitleSigil}
      mobileNavIcon={activeWorkspace ? <RailIcon workspace={activeWorkspace} /> : undefined}
      mobileCallAction={topbarCallAction}
      /* The fourth column stands down for every surface that owns the right
         side of the window: both settings takeovers, the operator server
         settings, Home, and an open thread — the thread pane docks where the
         rail was (Discord's layout), which is what gives the thread pane its
         width. */
      /* Home has NO fourth column at all (owner direction 2026-09-14: "In
         home, col 4 doesn't make sense as I'm not in a room … the entire
         column shouldn't be there"). `railHidden` is what removes it — the
         desktop rail, the tablet pane swap, the mobile drawer AND the inline
         mobile aside all gate on it, so one flag covers every band. This
         supersedes both the U6 note that deliberately kept Home's desktop rail
         (`memberListCollapsible` alone left the aside rendering inline on
         narrow Home — the strip that showed up under the identity panel) and
         the cross-workspace Members/Threads rail Home briefly carried: a column
         built for a room has nothing to say outside one.
         Amended 2026-09-29 the way the 2026-09-14 note itself prescribed ("a
         Home rule that drops the MEMBERS tab rather than `railHidden`"): Home
         still has no column BY DEFAULT and never a member list, but its band
         offers Call log and Threads, and choosing one opens the column for
         that mode (`homeRailMode`) — which is how My Threads is reached from
         Home again. */
      railHidden={
        settingsOpen || wsettingsOpen || serverSettings.open || (homeActive && homeRailMode === null) ||
        releaseNotes.open || activeThread !== null
      }
      railModes={homeActive ? HOME_RAIL_MODES : undefined}
      /* Tablet: the members list holds the pane (see the header toggle above).
         The shell owns the swap so the members node is never duplicated — it
         renders the same node the desktop rail hosts. */
      railMode={shownRailMode}
      onRailSelect={homeActive ? selectHomeRailMode : selectRailMode}
      channelSidebarError={hydrationError ?? undefined}
      channelSidebarEmpty={
        (rosterKnown || hydrationDone) &&
        activeWorkspaceId != null &&
        (channelIdsByWorkspace[activeWorkspaceId] ?? []).length === 0
      }
      />

      {/* Calls plan U11: the global ring toast region — mounts exactly one
          per authenticated shell. Join routes to the ringing channel (the
          same navigation contract as a sidebar channel select) and fires
          the join intent through the useCall seam. */}
      <RingToasts
        onJoinChannel={(id) => {
          leaveSettings();
          setActiveChannelId(id);
          setActiveThread(null);
        }}
      />

      {/* #118: a `/m/<token>` that did not resolve says so. Rendered beside the
          shell (like the ring region above) rather than inside the pane: the
          token names no channel we could open, so there is no pane state that
          could carry the failure. */}
      <PathPermalinkNotice state={pathPermalink} />
      {/* A channel address this reader cannot open (see the channel route). */}
      <PathPermalinkNotice state={{ pending: false, error: channelRouteNotice }} />

      {threadsListChannelId !== null ? (
      <Suspense fallback={null}>
      <ThreadsListDialog
        open={threadsListChannelId !== null}
        onOpenChange={(o) => {
          if (!o) setThreadsListChannelId(null);
        }}
        channelId={threadsListChannelId}
        channelName={
          threadsListChannelId ? store.channels[threadsListChannelId]?.name : undefined
        }
        onOpenThread={(threadId) => {
          const t = defaultStore.getState().threadsById[threadId];
          setThreadsListChannelId(null);
          setActiveThread({
            threadId,
            channelId: t?.channel_id ?? threadsListChannelId ?? activeChannelId ?? '',
            parentMessageId: t?.parent_message_id ?? null,
          });
        }}
      />
      </Suspense>
      ) : null}

    </InboxProvider>
  );
}

export default AuthenticatedApp;
