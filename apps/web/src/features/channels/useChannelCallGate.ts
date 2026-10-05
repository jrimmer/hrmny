/**
 * @cytale/web — the mobile topbar's call/title model (plan 003 U2, extracted
 * at code-review finding #7): one derivation feeds both the desktop pane
 * header and the MobileTopbar. `resolveTopbarCallAccess` is the pure gate
 * (table-tested); the hook reads the store snapshot.
 */
import { defaultStore } from '@cytale/state';

/** A state snapshot (AuthenticatedApp's `store` state), not the vanilla store. */
type StoreSnapshot = ReturnType<typeof defaultStore.getState>;

export interface TopbarCallAccessInput {
  homeActive: boolean;
  selfId: string | null;
  activeChannel:
    | { workspace_id: string | null; type?: string | null }
    | undefined;
  workspaces: Record<string, { owner_id: string } | undefined>;
  memberIdsByWorkspace: Record<string, string[] | undefined>;
}

/**
 * Start-call permission for the active surface: a real WORKSPACE channel
 * (never Home, never a DM) whose workspace the user owns or belongs to.
 * Mirrors the server's KTD7 model — @everyone grants members START_CALL.
 */
export function resolveTopbarCallAccess(input: TopbarCallAccessInput): boolean {
  const { homeActive, selfId, activeChannel, workspaces, memberIdsByWorkspace } = input;
  if (homeActive) return false;
  if (activeChannel === undefined) return false;
  if (activeChannel.workspace_id === null) return false;
  if (activeChannel.type === 'dm') return false;
  const wsId = activeChannel.workspace_id;
  return (
    workspaces[wsId]?.owner_id === selfId ||
    (memberIdsByWorkspace[wsId] ?? []).includes(selfId ?? '')
  );
}

export interface MobileTitleInput {
  /**
   * The surface covering the pane (settings, release notes…), when one is:
   * it wins, so the topbar names what is open rather than the channel under it.
   */
  takeoverTitle?: string | null;
  activeDm: { id: string } | null | undefined;
  dmPeerName: string | null | undefined;
  homeActive: boolean;
  activeChannelId: string | null | undefined;
  channels: Record<string, { name: string } | undefined>;
  activeWorkspaceId: string | null | undefined;
  workspaces: Record<string, { name: string } | undefined>;
}

/** The topbar title — the pane header's derivation, degrading to Home. */
export function resolveMobileTitle(input: MobileTitleInput): string {
  const { takeoverTitle, activeDm, dmPeerName, homeActive, activeChannelId, channels, activeWorkspaceId, workspaces } =
    input;
  if (takeoverTitle) return takeoverTitle;
  if (activeDm) return dmPeerName ?? 'Home';
  if (homeActive) return 'Home';
  return (
    (activeChannelId ? channels[activeChannelId]?.name : undefined) ??
    (activeWorkspaceId ? workspaces[activeWorkspaceId]?.name : undefined) ??
    'Home'
  );
}

/**
 * The title's sigil — the desktop pane header's convention (`#` channel,
 * `@` DM, none on Home). Kept OUT of resolveMobileTitle so the title string
 * stays a bare name (its tests and any future plain-text consumer rely on
 * that); the sigil is presentation, and aria-hidden at the render site.
 */
export function resolveMobileTitleSigil(input: MobileTitleInput): string | null {
  const { takeoverTitle, activeDm, dmPeerName, homeActive, activeChannelId, channels } = input;
  if (takeoverTitle) return null;
  if (activeDm) return dmPeerName ? '@' : null;
  if (homeActive) return null;
  return activeChannelId && channels[activeChannelId] ? '#' : null;
}

export interface ChannelCallGateDeps {
  /** The takeover surface's title (see MobileTitleInput); null/omitted when none. */
  takeoverTitle?: string | null;
  homeActive: boolean;
  activeChannelId: string | null;
  activeWorkspaceId: string | null;
  activeChannel: StoreSnapshot['channels'][string] | undefined;
  activeDm: { id: string } | null | undefined;
  dmPeerName: string | null | undefined;
  selfId: string | null;
}

export function useChannelCallGate(
  store: StoreSnapshot,
  deps: ChannelCallGateDeps,
): { canStartCall: boolean; mobileTitle: string; mobileTitleSigil: string | null } {
  const { takeoverTitle, homeActive, activeChannelId, activeWorkspaceId, activeChannel, activeDm, dmPeerName, selfId } =
    deps;
  const titleInput = {
    takeoverTitle,
    activeDm,
    dmPeerName,
    homeActive,
    activeChannelId,
    channels: store.channels,
    activeWorkspaceId,
    workspaces: store.workspaces,
  };
  return {
    canStartCall: resolveTopbarCallAccess({
      homeActive,
      selfId,
      activeChannel,
      workspaces: store.workspaces,
      memberIdsByWorkspace: store.memberIdsByWorkspace,
    }),
    mobileTitle: resolveMobileTitle(titleInput),
    mobileTitleSigil: resolveMobileTitleSigil(titleInput),
  };
}
