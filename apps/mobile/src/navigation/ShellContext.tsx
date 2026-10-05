/**
 * @cytale/mobile — shell context (plan 004 M5, R7).
 *
 * Owns the two overlays the shell has (navigation drawer, members drawer),
 * the selected workspace (which drives the drawer's channel list), and the
 * platform-back ordering: an open overlay closes before a surface is left.
 *
 * `ShellProvider` is router-agnostic on purpose — it takes the current route
 * path as a prop so component tests can drive it directly, while
 * `DrawerShell` (the layout the `(drawer)` group renders) supplies the real
 * pathname from expo-router.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { BackHandler, Keyboard, StyleSheet, View } from 'react-native';

import { parseRoute } from './routes';
import { defaultStore, useChannel, useMemberRows, useWorkspaces, type StoreLike } from './store';
import { DrawerLayer } from './DrawerLayer';
import { MembersDrawer } from './MembersDrawer';

export interface ShellContextValue {
  store: StoreLike;
  /** The route the shell is on (`/`, `/channel/<id>`, …). */
  routePath: string;
  /** Channel the route addresses, or null on non-channel surfaces. */
  activeChannelId: string | null;
  /** Workspace whose channels the drawer lists (route-derived until changed). */
  activeWorkspaceId: string | null;
  /**
   * The nav-trigger face's source (TitleBar): the ACTIVE workspace's name and
   * icon, derived INSIDE the shell from the workspaces slice it already
   * subscribes — the trigger must not add a second set of store
   * subscriptions to every surface (the P3 contract the shell tests count).
   * Null when no workspace is active (the ☰ fallback).
   */
  navTriggerWorkspace: { id: string; name: string; iconUrl: string | null } | null;
  /** User-chosen workspace from the drawer strip. */
  selectWorkspace(workspaceId: string): void;

  /** Switch surfaces without stacking (drawer destinations). */
  navigate(path: string): void;
  /** Push a stacked surface (thread, settings). */
  push(path: string): void;

  drawerOpen: boolean;
  openDrawer(): void;
  closeDrawer(): void;
  toggleDrawer(): void;

  membersOpen: boolean;
  openMembers(): void;
  closeMembers(): void;
}

const ShellContext = createContext<ShellContextValue | null>(null);

/** The shell context. Throws outside the provider (a wiring bug). */
export function useShell(): ShellContextValue {
  const value = useContext(ShellContext);
  if (value === null) {
    throw new Error('useShell() used outside <ShellProvider> — the (drawer) layout owns the shell.');
  }
  return value;
}

/**
 * The shell when one is mounted, null otherwise. For the one consumer that
 * must render BOTH inside and outside a provider — TitleBar's nav-trigger
 * face (the active workspace's icon) reads the shell's active workspace, and
 * standalone mounts (component tests) take the ☰ fallback instead of
 * crashing.
 */
export function useShellOptional(): ShellContextValue | null {
  return useContext(ShellContext);
}

export interface ShellProviderProps {
  children: ReactNode;
  /** Drawer content, rendered in the navigation layer when open. */
  drawer: ReactNode;
  /** Current pathname (DrawerShell supplies expo-router's; tests pass it). */
  routePath?: string;
  /** Store projection; `defaultStore` in production. */
  store?: StoreLike;
  /** Test seam: start with a workspace selected. */
  initialWorkspaceId?: string | null;
  /** Router seams — the shell never imports expo-router itself. */
  onNavigate: (path: string) => void;
  onPush: (path: string) => void;
}

export function ShellProvider({
  children,
  drawer,
  routePath = '/',
  store = defaultStore,
  initialWorkspaceId = null,
  onNavigate,
  onPush,
}: ShellProviderProps) {
  const route = useMemo(() => parseRoute(routePath), [routePath]);
  const activeChannelId = route.surface === 'channel' ? route.channelId : null;

  const channel = useChannel(store, activeChannelId);
  const workspaces = useWorkspaces(store);
  const routeWorkspaceId = channel?.workspace_id ?? null;
  const fallbackWorkspaceId = workspaces[0]?.id ?? null;

  // Route-derived selection that the user can override from the strip. The
  // override resets when the route lands in a different workspace (render-
  // phase derivation — no effect, so there is never a frame showing the
  // previous workspace's channels).
  const [selection, setSelection] = useState<{ routeWorkspaceId: string | null; workspaceId: string | null }>(
    () => ({ routeWorkspaceId, workspaceId: initialWorkspaceId }),
  );
  if (selection.routeWorkspaceId !== routeWorkspaceId) {
    setSelection({ routeWorkspaceId, workspaceId: null });
  }
  const activeWorkspaceId = selection.workspaceId ?? routeWorkspaceId ?? fallbackWorkspaceId;

  // The TitleBar nav-trigger face (device feedback 2442: the active
  // workspace's icon replaces the hamburger, web mobileNavIcon parity).
  // Derived here so the icon rides the subscription the shell already holds.
  const navTriggerWorkspace = useMemo(() => {
    // Home is workspace-less: the trigger takes the plain menu glyph there
    // (web's rule — the workspace icon belongs to workspace surfaces), or
    // the fallback workspace would leak its icon onto Home's title bar.
    if (route.surface === 'home') return null;
    const workspace = workspaces.find((candidate) => candidate.id === activeWorkspaceId);
    return workspace === undefined
      ? null
      : { id: workspace.id, name: workspace.name, iconUrl: workspace.icon_url ?? null };
  }, [workspaces, activeWorkspaceId, route]);

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);

  // Opening the drawer dismisses the keyboard: the composer underneath lost
  // focus, and a keyboard left standing behind the drawer reads as a second
  // input on screen (device feedback 2441, round 3).
  const openDrawer = useCallback(() => {
    Keyboard.dismiss();
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => setDrawerOpen(false), []);
  const toggleDrawer = useCallback(() => setDrawerOpen((open) => !open), []);
  const openMembers = useCallback(() => setMembersOpen(true), []);
  const closeMembers = useCallback(() => setMembersOpen(false), []);

  // Platform back closes an open overlay before the navigator sees the
  // gesture (R7). Members sit above the drawer, so they close first.
  useEffect(() => {
    if (!drawerOpen && !membersOpen) return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (membersOpen) {
        setMembersOpen(false);
        return true;
      }
      setDrawerOpen(false);
      return true;
    });
    return () => subscription.remove();
  }, [drawerOpen, membersOpen]);

  const value = useMemo<ShellContextValue>(
    () => ({
      store,
      routePath,
      activeChannelId,
      activeWorkspaceId,
      navTriggerWorkspace,
      selectWorkspace: (workspaceId: string) => setSelection({ routeWorkspaceId, workspaceId }),
      navigate: onNavigate,
      push: onPush,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      membersOpen,
      openMembers,
      closeMembers,
    }),
    [
      store,
      routePath,
      activeChannelId,
      activeWorkspaceId,
      navTriggerWorkspace,
      routeWorkspaceId,
      onNavigate,
      onPush,
      drawerOpen,
      openDrawer,
      closeDrawer,
      toggleDrawer,
      membersOpen,
      openMembers,
      closeMembers,
    ],
  );

  return (
    <ShellContext.Provider value={value}>
      <View style={styles.root}>
        {children}
        {drawerOpen ? <DrawerLayer onClose={closeDrawer}>{drawer}</DrawerLayer> : null}
        {membersOpen ? (
          <MembersLayer store={store} workspaceId={activeWorkspaceId} onClose={closeMembers} />
        ) : null}
      </View>
    </ShellContext.Provider>
  );
}

/**
 * The members overlay, and the ONLY place the roster projection runs.
 *
 * `useMemberRows` selects `presenceByUser` and sorts the roster
 * (`store.ts` member rows) — a projection whose result only the members
 * drawer renders. It used to live in `ShellProvider`, which is mounted for
 * every shell surface, so each presence event anywhere re-sorted the whole
 * roster for a drawer nobody had opened. Mounting this layer only while the
 * drawer is open moves the subscription to its consumer: closed, a presence
 * event costs the shell nothing; open, a presence event re-sorts (correctly —
 * the rows show presence).
 *
 * Tradeoff: the first open pays the projection at mount (a sort of the
 * roster, during the panel's 180ms entrance animation) instead of having it
 * precomputed. That is strictly less work than doing it on every presence
 * event while closed.
 */
function MembersLayer({
  store,
  workspaceId,
  onClose,
}: {
  store: StoreLike;
  workspaceId: string | null;
  onClose: () => void;
}) {
  const members = useMemberRows(store, workspaceId);
  return <MembersDrawer members={members} onClose={onClose} />;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
