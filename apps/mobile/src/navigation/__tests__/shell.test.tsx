/**
 * Shell behaviour tests (plan 004 M5, R7) — component level.
 *
 * `ShellProvider` is router-agnostic by design, so these tests drive the
 * drawer/members overlays and the workspace/channel projection directly,
 * without expo-router. Router-level coverage (deep links, stack pushes) lives
 * in `router.test.tsx`.
 */
import { act, render, screen } from '@testing-library/react-native';
import { BackHandler } from 'react-native';

import { NavigationDrawer } from '../NavigationDrawer';
import { ShellProvider, useShell } from '../ShellContext';
import { SurfaceScaffold } from '../SurfaceScaffold';
import { resetSurfaceStates, setSurfaceStates, useSurfaceStates } from '../shellState';
import { defaultStore } from '../store';
import { IDS, press, resetShellStore, seedShellStore } from './support';

/** A minimal surface: the shell's frame with both overlay triggers. */
function TestSurface({ title = 'Home' }: { title?: string }) {
  const shell = useShell();
  return (
    <SurfaceScaffold
      testID="test-surface"
      title={title}
      onOpenDrawer={shell.openDrawer}
      onOpenMembers={shell.openMembers}
    />
  );
}

async function renderShell(routePath = '/') {
  const onNavigate = jest.fn();
  const onPush = jest.fn();
  // RNTL v14 renders asynchronously (React 19 concurrent); `screen` is only
  // populated once the render promise settles.
  await render(
    <ShellProvider routePath={routePath} drawer={<NavigationDrawer />} onNavigate={onNavigate} onPush={onPush}>
      <TestSurface />
    </ShellProvider>,
  );
  return { onNavigate, onPush };
}

beforeEach(() => {
  resetShellStore();
  resetSurfaceStates();
  seedShellStore();
});

afterEach(() => {
  resetShellStore();
  resetSurfaceStates();
});

describe('navigation drawer', () => {
  it('opens from the title bar and closes from its own close control', async () => {
    await renderShell();
    expect(screen.queryByTestId('drawer-panel')).toBeNull();

    await press(screen.getByLabelText('Open navigation'));
    expect(screen.getByTestId('drawer-panel')).toBeTruthy();

    await press(screen.getByTestId('drawer-scrim'));
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });

  it('closes on a scrim press', async () => {
    await renderShell();
    await press(screen.getByLabelText('Open navigation'));
    expect(screen.getByTestId('drawer-scrim')).toBeTruthy();

    await press(screen.getByTestId('drawer-scrim'));
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });

  it('carries the workspace strip and the channel list', async () => {
    await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    expect(screen.getByTestId('drawer-workspace-strip')).toBeTruthy();
    expect(screen.getByTestId('drawer-home')).toBeTruthy();
    // Integrations left the drawer with the web main menu (2026-09-19).
    expect(screen.queryByTestId('drawer-integrations')).toBeNull();
    expect(screen.getByTestId(`drawer-workspace-${IDS.ws1}`)).toBeTruthy();
    expect(screen.getByTestId(`drawer-workspace-${IDS.ws2}`)).toBeTruthy();
    expect(screen.getByTestId('drawer-channel-list')).toBeTruthy();
  });

  it('switching workspace changes the channel list', async () => {
    await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    // Home route → the first workspace's channels are listed.
    expect(screen.getByTestId(`drawer-channel-${IDS.general}`)).toBeTruthy();
    expect(screen.getByTestId(`drawer-channel-${IDS.random}`)).toBeTruthy();
    expect(screen.queryByTestId(`drawer-channel-${IDS.other}`)).toBeNull();

    await press(screen.getByTestId(`drawer-workspace-${IDS.ws2}`));

    expect(screen.getByTestId(`drawer-channel-${IDS.other}`)).toBeTruthy();
    expect(screen.queryByTestId(`drawer-channel-${IDS.general}`)).toBeNull();
  });

  it('selecting a channel navigates to it and closes the drawer', async () => {
    const { onNavigate } = await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    await press(screen.getByTestId(`drawer-channel-${IDS.general}`));

    expect(onNavigate).toHaveBeenCalledWith(`/channel/${IDS.general}`);
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });

  it('surfaces unread and mention badges', async () => {
    await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    expect(screen.getByTestId(`drawer-channel-unread-${IDS.random}`)).toBeTruthy();
    expect(screen.getByTestId(`drawer-channel-mentions-${IDS.random}`)).toBeTruthy();
    expect(screen.queryByTestId(`drawer-channel-unread-${IDS.general}`)).toBeNull();
  });

  it('renders the user panel with the signed-in identity', async () => {
    await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    expect(screen.getByTestId('user-panel')).toBeTruthy();
    expect(screen.getByText('rowan')).toBeTruthy();
  });

  it('routes the settings gear to the settings surface', async () => {
    const { onNavigate } = await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    await press(screen.getByTestId('user-panel-settings'));

    expect(onNavigate).toHaveBeenCalledWith('/settings');
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });

  it('keeps the diagnostics route reachable from the drawer in development', async () => {
    const { onNavigate } = await renderShell();
    await press(screen.getByLabelText('Open navigation'));

    expect(screen.getByTestId('drawer-dev-footer')).toBeTruthy();
    await press(screen.getByTestId('drawer-diagnostics'));

    expect(onNavigate).toHaveBeenCalledWith('/diagnostics');
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });

  it('replaces the channel list with the bootstrap failure and its retry', async () => {
    const retry = jest.fn();
    await renderShell();
    await act(async () =>
      setSurfaceStates({ hydrationError: 'Could not load your workspaces.', retryHydration: retry }),
    );

    await press(screen.getByLabelText('Open navigation'));

    // The honest state, not "No channels yet": the list never arrived.
    expect(screen.getByTestId('drawer-hydration-error')).toBeTruthy();
    expect(screen.getByText('Could not load your workspaces.')).toBeTruthy();
    expect(screen.queryByTestId('drawer-channel-list')).toBeNull();

    await press(screen.getByTestId('drawer-hydration-error-retry'));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('platform back', () => {
  it('closes an open drawer before the navigator sees the gesture', async () => {
    const spy = jest.spyOn(BackHandler, 'addEventListener');
    await renderShell();

    // Nothing open → no handler registered (the navigator keeps the gesture).
    expect(spy.mock.calls.filter(([event]) => event === 'hardwareBackPress')).toHaveLength(0);

    await press(screen.getByLabelText('Open navigation'));
    const handler = spy.mock.calls.find(([event]) => event === 'hardwareBackPress')?.[1];
    expect(handler).toBeDefined();

    let handled: boolean | null | undefined;
    await act(async () => {
      handled = handler?.({ type: 'hardwareBackPress', timeStamp: 0 });
    });

    expect(handled).toBe(true); // consumed — the surface is NOT left
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
    spy.mockRestore();
  });
});

describe('members drawer', () => {
  it('opens edge-aligned with a scrim and lists the workspace members', async () => {
    await renderShell(`/channel/${IDS.general}`);

    await press(screen.getByLabelText('Show member list'));

    expect(screen.getByTestId('members-panel')).toBeTruthy();
    expect(screen.getByTestId('members-scrim')).toBeTruthy();
    expect(screen.getByTestId(`member-row-${IDS.alice}`)).toBeTruthy();
    expect(screen.getByTestId(`member-row-${IDS.bob}`)).toBeTruthy();
    expect(screen.getByText('Bobby')).toBeTruthy();
  });

  it('closes on the scrim and on the close control', async () => {
    await renderShell(`/channel/${IDS.general}`);

    await press(screen.getByLabelText('Show member list'));
    await press(screen.getByTestId('members-scrim'));
    expect(screen.queryByTestId('members-panel')).toBeNull();

    await press(screen.getByLabelText('Show member list'));
    await press(screen.getByTestId('members-close'));
    expect(screen.queryByTestId('members-panel')).toBeNull();
  });

  it('shows the empty state when the workspace has no members', async () => {
    defaultStore.setState({ memberIdsByWorkspace: { [IDS.ws1]: [] } });
    await renderShell(`/channel/${IDS.general}`);

    await press(screen.getByLabelText('Show member list'));

    expect(screen.getByTestId('members-empty')).toBeTruthy();
    expect(screen.getByText('No members to show')).toBeTruthy();
  });

  it('subscribes the roster projection only while the layer is open', async () => {
    // The P3 proof: the always-mounted shell must not hold the members +
    // presence subscriptions. Three selectors belong to the members layer
    // (`useMemberRows`: membersById, memberIdsByWorkspace, nicknamesByWorkspace
    // (#169), presenceByUser) and
    // two to the shell itself (`useChannel`, `useWorkspaces`).
    let subscribers = 0;
    const state = defaultStore.getState();
    const store = {
      getState: () => state,
      subscribe: () => {
        subscribers += 1;
        return () => {
          subscribers -= 1;
        };
      },
    };

    await render(
      <ShellProvider
        store={store}
        routePath={`/channel/${IDS.general}`}
        drawer={null}
        onNavigate={jest.fn()}
        onPush={jest.fn()}
      >
        <TestSurface />
      </ShellProvider>,
    );

    // Closed: workspace + channel slices only — a presence event anywhere
    // does not re-sort the roster for a drawer nobody opened.
    expect(subscribers).toBe(2);

    await press(screen.getByLabelText('Show member list'));
    expect(subscribers).toBe(6);

    await press(screen.getByTestId('members-close'));
    expect(subscribers).toBe(2);
  });
});

describe('surface states', () => {
  it('renders loading, error, offline, view-only, permission-denied, and empty inside the shell', async () => {
    await renderShell();

    // loading
    await act(async () => setSurfaceStates({ loading: true }));
    expect(screen.getByTestId('surface-loading')).toBeTruthy();
    expect(screen.getByLabelText('Loading Home…')).toBeTruthy();

    // offline
    await act(async () => setSurfaceStates({ loading: false, offline: true }));
    expect(screen.getByTestId('offline-banner')).toBeTruthy();

    // view-only rides under content
    await act(async () => setSurfaceStates({ offline: false, viewOnly: true }));
    expect(screen.getByTestId('view-only-note')).toBeTruthy();

    // permission-denied replaces the body
    await act(async () =>
      setSurfaceStates({ viewOnly: false, permissionDenied: 'You cannot view this channel.' }),
    );
    expect(screen.getByTestId('permission-denied')).toBeTruthy();

    // error
    await act(async () => setSurfaceStates({ permissionDenied: null, error: 'Load failed' }));
    expect(screen.getByTestId('surface-error')).toBeTruthy();

    // empty
    await act(async () => setSurfaceStates({ error: null, empty: true }));
    expect(screen.getByTestId('surface-empty')).toBeTruthy();
  });

  it('renders the error state’s retry when the state carries one', async () => {
    await renderShell();

    const retry = jest.fn();
    await act(async () =>
      setSurfaceStates({ hydrationError: 'Could not load your workspaces.', retryHydration: retry }),
    );

    const button = screen.getByTestId('surface-error-retry');
    expect(button).toHaveAccessibleName('Retry');
    const flattened = Object.assign(
      {},
      ...([] as unknown[]).concat(button.props.style ?? []).filter(
        (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
      ),
    );
    expect(flattened.minHeight).toBeGreaterThanOrEqual(44);

    await press(button);
    expect(retry).toHaveBeenCalledTimes(1);

    // The control belongs to the error it retries: clearing one clears both.
    await act(async () => setSurfaceStates({ hydrationError: null, retryHydration: null }));
    expect(screen.queryByTestId('surface-error')).toBeNull();
    expect(screen.queryByTestId('surface-error-retry')).toBeNull();
  });

  it('leaves a surface that supplies its own states to its own truth', async () => {
    // Settings spreads the shared states but does not need the workspace
    // graph: a bootstrap failure must not blank it (residual 3's scoping).
    function SettingsLikeSurface() {
      const shared = useSurfaceStates();
      return (
        <SurfaceScaffold testID="settings-like" title="Settings" states={{ ...shared, empty: false }} />
      );
    }

    await render(<SettingsLikeSurface />);
    await act(async () => setSurfaceStates({ hydrationError: 'Could not load your workspaces.' }));

    expect(screen.getByTestId('settings-like-body')).toBeTruthy();
    expect(screen.queryByTestId('surface-error')).toBeNull();
  });
});

describe('accessibility', () => {
  it('gives every interactive control an accessible name and a 44pt target', async () => {
    await renderShell();

    // Surface controls first — opening the drawer makes them modal-hidden.
    const surfaceControls = [
      screen.getByLabelText('Open navigation'),
      screen.getByLabelText('Show member list'),
      screen.getByLabelText('Voice — coming soon'),
    ];

    await press(screen.getByLabelText('Open navigation'));

    // The scrim is a full-screen overlay: its target size is the viewport, so
    // it is checked for a name but not for a 44pt minimum.
    expect(screen.getByLabelText('Dismiss navigation')).toHaveAccessibleName();

    const drawerControls = [
      screen.getByTestId(`drawer-workspace-${IDS.ws1}`),
      screen.getByTestId(`drawer-channel-${IDS.general}`),
      screen.getByTestId('user-panel-settings'),
    ];

    for (const control of [...surfaceControls, ...drawerControls]) {
      expect(control).toHaveAccessibleName();
      const flattened = Object.assign(
        {},
        ...([] as unknown[]).concat(control.props.style ?? []).filter(
          (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
        ),
      );
      expect(flattened.minHeight).toBeGreaterThanOrEqual(44);
    }
  });

  it('announces the disabled voice entry point instead of hiding it', async () => {
    await renderShell();

    const voice = screen.getByTestId('title-bar-voice');
    expect(voice).toHaveAccessibleName('Voice — coming soon');
    expect(voice.props.accessibilityState).toMatchObject({ disabled: true });
  });
});
