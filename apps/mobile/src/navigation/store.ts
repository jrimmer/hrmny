/**
 * @cytale/mobile — store binding for the navigation shell (plan 004 M5).
 *
 * The shell is a projection over `@cytale/state` (M2 harness proved the
 * package runs on Hermes): the drawer's workspace strip, channel list, member
 * list, and badges all read `defaultStore` here. No data is cached or copied
 * — screens render the store, the store owns the truth.
 *
 * `useStoreSelector` is the React binding. zustand v5's own `useStore` is not
 * used because `zustand` is not a direct dependency of apps/mobile (pnpm's
 * isolated linker hides it behind @cytale/state); `useSyncExternalStore` is
 * the React 19 primitive the binding is built on, so this is the same hook
 * without the extra dependency. Selectors return store SLICES (stable object
 * identities); components derive arrays/rows with `useMemo`.
 */
import './bootstrap';

import { useMemo, useRef, useSyncExternalStore } from 'react';

import { isTextChannel, type Channel, type Workspace, type WorkspaceMember, displayNameOf } from '@cytale/domain';
import type { PresenceStatus } from '@cytale/protocol';
import { defaultStore, type StateState, type StateStore } from '@cytale/state';

export { defaultStore };
export type { StateStore, StateState };

/** Structural equality for the selector cache (arrays + flat records). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  }
  const aKeys = Object.keys(a as Record<string, unknown>);
  const bKeys = Object.keys(b as Record<string, unknown>);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) =>
    Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
  );
}

/**
 * Subscribe a component to a slice of a zustand vanilla store. The selector
 * must return a stable reference for unchanged state (select slices, not
 * freshly built arrays); the ref cache absorbs the rest.
 *
 * The cache is keyed on the STATE *and* on the selector identity. Keying on
 * state alone is wrong for a selector that closes over props: a re-render with
 * new props and no store write would hand back the previous render's value
 * (`state.channels[oldChannelId]`) — the channel switch resolved permissions
 * for the workspace it just left. Selector identity changes on every render
 * for the inline closures used here, so the cache degrades to "recompute per
 * render, keep the identity when the result is shallow-equal" — the same
 * contract as zustand's own `useSyncExternalStoreWithSelector` (whose
 * memoized selector is re-created when the selector function changes). The
 * alternative — a caller-supplied dependency signature — would leave every
 * existing call site stale until it was updated by hand, including the ones
 * this worker does not own; recomputation here is a property read.
 */
export function useStoreSelector<T>(store: StoreLike, selector: (state: StateState) => T): T {
  const cache = useRef<{
    state: StateState;
    selector: (state: StateState) => T;
    value: T;
  } | null>(null);

  const getSnapshot = (): T => {
    const state = store.getState();
    const cached = cache.current;
    if (cached !== null && cached.state === state && cached.selector === selector) {
      return cached.value;
    }
    const value = selector(state);
    if (cached !== null && shallowEqual(cached.value, value)) {
      cache.current = { state, selector, value: cached.value };
      return cached.value;
    }
    cache.current = { state, selector, value };
    return value;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Derived rows
// ---------------------------------------------------------------------------

export interface WorkspaceRow {
  id: string;
  name: string;
  /** First letter, uppercased — the tile glyph when no icon is set. */
  initial: string;
  /** Server path of the workspace icon (`/icons/…`), null when unset. */
  iconUrl: string | null;
  /** Total unread across the workspace's channels (rail badge). */
  unread: number;
}

export interface ChannelRow {
  id: string;
  name: string;
  topic: string | null;
  unread: number;
  mentions: number;
}

export interface MemberRow {
  id: string;
  name: string;
  status: PresenceStatus;
  avatarUrl: string | null;
}

/** Workspaces, name-ordered (the domain carries no position field). */
export function useWorkspaces(store: StoreLike): Workspace[] {
  const workspaces = useStoreSelector(store, (s) => s.workspaces);
  return useMemo(
    () =>
      Object.values(workspaces).sort(
        (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
      ),
    [workspaces],
  );
}

/**
 * Text channels of one workspace, position-ordered. `isTextChannel` comes
 * from `@cytale/domain`: it owns the wire → domain channel-type mapping
 * (numeric 0/1 on the wire, string union at the boundary) so the drawer does
 * not re-derive it.
 */
export function useWorkspaceChannels(store: StoreLike, workspaceId: string | null): Channel[] {
  const channels = useStoreSelector(store, (s) => s.channels);
  return useMemo(() => {
    if (workspaceId === null) return [];
    return Object.values(channels)
      .filter((channel) => isTextChannel(channel) && channel.workspace_id === workspaceId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [channels, workspaceId]);
}

/** Channel rows with unread/mention badges from the store's unread slice. */
export function useChannelRows(store: StoreLike, workspaceId: string | null): ChannelRow[] {
  const channels = useWorkspaceChannels(store, workspaceId);
  const unread = useStoreSelector(store, (s) => s.unreadByChannel);
  return useMemo(
    () =>
      channels.map((channel) => ({
        id: channel.id,
        name: channel.name,
        topic: channel.topic,
        unread: unread[channel.id]?.unread_count ?? 0,
        mentions: unread[channel.id]?.mention_count ?? 0,
      })),
    [channels, unread],
  );
}

/** Workspace strip rows with per-workspace unread totals. */
export function useWorkspaceRows(store: StoreLike): WorkspaceRow[] {
  const workspaces = useWorkspaces(store);
  const channels = useStoreSelector(store, (s) => s.channels);
  const unread = useStoreSelector(store, (s) => s.unreadByChannel);
  return useMemo(
    () =>
      workspaces.map((workspace) => {
        let total = 0;
        for (const channel of Object.values(channels)) {
          if (channel.workspace_id !== workspace.id) continue;
          total += unread[channel.id]?.unread_count ?? 0;
        }
        return {
          id: workspace.id,
          name: workspace.name,
          initial: workspace.name.charAt(0).toUpperCase(),
          iconUrl: workspace.icon_url ?? null,
          unread: total,
        };
      }),
    [workspaces, channels, unread],
  );
}

/** Members of a workspace with presence, sorted by display name. */
export function useMemberRows(store: StoreLike, workspaceId: string | null): MemberRow[] {
  const membersById = useStoreSelector(store, (s) => s.membersById);
  const memberIds = useStoreSelector(store, (s) => s.memberIdsByWorkspace);
  const nicknamesByWorkspace = useStoreSelector(store, (s) => s.nicknamesByWorkspace);
  const presence = useStoreSelector(store, (s) => s.presenceByUser);

  return useMemo(() => {
    if (workspaceId === null) return [];
    const ids = memberIds[workspaceId] ?? [];
    const rows: MemberRow[] = [];
    for (const id of ids) {
      const member: WorkspaceMember | undefined = membersById[id];
      if (!member) continue;
      rows.push({
        id,
        // This workspace's nickname first (#169).
        name: displayNameOf({ ...member, nickname: nicknamesByWorkspace[workspaceId]?.[id] ?? null }),
        status: presence[id]?.status ?? 'offline',
        avatarUrl: member.avatar_url ?? null,
      });
    }
    return rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }, [membersById, memberIds, presence, workspaceId, nicknamesByWorkspace]);
}

/** One channel by id (the channel surface's title/state source). */
export function useChannel(store: StoreLike, channelId: string | null): Channel | undefined {
  const channels = useStoreSelector(store, (s) => s.channels);
  return channelId === null ? undefined : channels[channelId];
}

/** True once the store holds any workspace — the shell's hydration signal. */
export function useHasWorkspaces(store: StoreLike): boolean {
  const workspaces = useStoreSelector(store, (s) => s.workspaces);
  return Object.keys(workspaces).length > 0;
}

/**
 * Structural store shape the shell needs. `StateStore` satisfies it; tests
 * pass `defaultStore` seeded via `setState`.
 */
export type StoreLike = Pick<StateStore, 'getState' | 'subscribe'>;
