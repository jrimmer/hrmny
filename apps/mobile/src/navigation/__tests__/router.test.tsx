/**
 * Router-level tests (plan 004 M5, R7).
 *
 * `renderRouter` mounts the REAL `app/` directory (root layout, drawer group,
 * settings stack, thread push) with the real session provider — the same tree
 * the device runs. Deep links are exercised two ways: the pure
 * `redirectSystemPath` mapping expo-router calls on native, and the router
 * resolving the resulting path.
 *
 * Known testing-library limitation (reported, not worked around): passing a
 * host-ful URL such as `cytale://channel/1` as `initialUrl` makes ExpoRoot
 * parse it with `new URL()` and keep only the pathname (`/1`), dropping the
 * host segment — an artifact of the test harness, not the app, which is why
 * the host form is covered by `redirectSystemPath` and the URL form by the
 * empty-host variant below.
 */
import { act, renderRouter, screen } from 'expo-router/testing-library';
import { router } from 'expo-router';

import { redirectSystemPath } from '../../../app/+native-intent';
import { resetSessionModuleMock, signInRouteSession, signOutRouteSession } from '../../auth/__tests__/support';
import { resetSurfaceStates, setSurfaceStates } from '../shellState';
import { IDS, APP_DIR, press, resetShellStore, seedShellStore } from './support';

// M12's gate sends a signed-out tree to /sign-in; these tests exercise the
// drawer, so the session fixture (a REAL SessionManager on memory storage)
// starts signed in. Nothing about the session is mocked.
jest.mock('@cytale/session', () => require('../../auth/__tests__/support').sessionModuleMock());

beforeEach(() => {
  resetSessionModuleMock();
  signInRouteSession();
  resetShellStore();
  resetSurfaceStates();
  seedShellStore();
});

afterEach(() => {
  signOutRouteSession();
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
});

describe('deep links', () => {
  it('maps cytale://channel/<id> to the channel path', () => {
    expect(redirectSystemPath({ path: 'cytale://channel/1756920000000000001', initial: true })).toBe(
      '/channel/1756920000000000001',
    );
  });

  it('lands on the channel route from a scheme deep link', async () => {
    const path = redirectSystemPath({ path: `cytale://channel/${IDS.general}`, initial: true });
    const result = renderRouter(APP_DIR, { initialUrl: path });
    await result;

    expect(result.getPathname()).toBe(`/channel/${IDS.general}`);
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
  });

  it('lands on the channel route from a URL-form deep link', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `cytale:///channel/${IDS.random}` });
    await result;

    expect(result.getPathname()).toBe(`/channel/${IDS.random}`);
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
  });

  it('sends an unknown link to the not-found surface', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/definitely-not-a-route' });
    await result;

    expect(screen.getByTestId('surface-not-found')).toBeTruthy();
  });
});

describe('title bar', () => {
  const SURFACES = [
    { path: '/', title: 'Home' },
    { path: '/integrations', title: 'Integrations' },
    { path: `/channel/${IDS.general}`, title: '#general' },
    { path: `/thread/${IDS.thread}`, title: 'Thread' },
    { path: '/settings', title: 'Settings' },
    { path: '/settings/account', title: 'Account' },
    { path: '/diagnostics', title: 'Diagnostics' },
  ] as const;

  it.each(SURFACES)('renders exactly one title bar on $path', async ({ path, title }) => {
    const result = renderRouter(APP_DIR, { initialUrl: path });
    await result;

    expect(screen.getAllByTestId('title-bar')).toHaveLength(1);
    expect(screen.getByTestId('title-bar-title')).toHaveTextContent(title);
  });

  it('carries the channel name and the disabled voice entry point', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });
    await result;

    expect(screen.getByTestId('title-bar-title')).toHaveTextContent('#general');
    expect(screen.getByTestId('title-bar-voice')).toHaveAccessibleName('Voice — coming soon');
    expect(screen.getByTestId('title-bar-voice').props.accessibilityState).toMatchObject({
      disabled: true,
    });
  });
});

describe('stack pushes', () => {
  it('back from a pushed thread returns to the channel', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });
    await result;

    await act(async () => {
      router.push(`/thread/${IDS.thread}`);
    });
    expect(result.getPathname()).toBe(`/thread/${IDS.thread}`);
    expect(screen.getByTestId('surface-thread')).toBeTruthy();

    await act(async () => {
      router.back();
    });
    expect(result.getPathname()).toBe(`/channel/${IDS.general}`);
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
  });

  it('settings is a list → section push with a back path', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/settings' });
    await result;

    expect(screen.getByTestId('settings-row-account')).toBeTruthy();
    expect(screen.getByTestId('settings-row-appearance')).toBeTruthy();
    expect(screen.getByTestId('settings-row-integrations')).toBeTruthy();
    expect(screen.getByTestId('settings-row-logout')).toBeTruthy();

    await press(screen.getByTestId('settings-row-account'));

    expect(result.getPathname()).toBe('/settings/account');
    expect(screen.getByTestId('surface-settings-section')).toBeTruthy();
    expect(screen.getByTestId('title-bar-title')).toHaveTextContent('Account');

    await press(screen.getByLabelText('Back'));
    expect(result.getPathname()).toBe('/settings');
  });
});

describe('drawer in the real app', () => {
  it('opens from the channel title bar and switches the channel list', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });
    await result;

    await press(screen.getByLabelText('Open navigation'));
    expect(screen.getByTestId('drawer-panel')).toBeTruthy();
    expect(screen.getByTestId(`drawer-channel-${IDS.random}`)).toBeTruthy();

    await press(screen.getByTestId(`drawer-workspace-${IDS.ws2}`));
    expect(screen.getByTestId(`drawer-channel-${IDS.other}`)).toBeTruthy();
    expect(screen.queryByTestId(`drawer-channel-${IDS.random}`)).toBeNull();

    // Selecting a channel routes to it and closes the drawer.
    await press(screen.getByTestId(`drawer-channel-${IDS.other}`));
    expect(result.getPathname()).toBe(`/channel/${IDS.other}`);
    expect(screen.queryByTestId('drawer-panel')).toBeNull();
  });
});

describe('release hardening', () => {
  it('does not mount the diagnostics surface outside development', async () => {
    // The drawer LINK is __DEV__-gated, but the route file is not: a deep link
    // (`cytale://diagnostics`) reaches it in any build, and the screen owns a
    // control that opens a cleartext socket to localhost:4000.
    const globalWithDev = globalThis as unknown as { __DEV__: boolean };
    const dev = globalWithDev.__DEV__;
    globalWithDev.__DEV__ = false;
    try {
      const result = renderRouter(APP_DIR, { initialUrl: '/diagnostics' });
      await result;

      expect(screen.queryByTestId('surface-diagnostics')).toBeNull();
      expect(result.getPathname()).toBe('/');
    } finally {
      globalWithDev.__DEV__ = dev;
    }
  });
});

describe('states inside the shell', () => {
  it('renders the offline banner over the channel surface', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });
    await result;

    await act(async () => setSurfaceStates({ offline: true }));
    expect(screen.getByTestId('offline-banner')).toBeTruthy();
  });

  it('renders the empty state for a channel with no messages', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });
    await result;

    expect(screen.getByTestId('surface-empty')).toBeTruthy();
    expect(screen.getByText('No messages yet')).toBeTruthy();
  });

  it('renders the error state for an unknown channel once the store is hydrated', async () => {
    const result = renderRouter(APP_DIR, { initialUrl: '/channel/999999999999999999' });
    await result;

    expect(screen.getByTestId('surface-error')).toBeTruthy();
    expect(screen.getByText('#999999999999999999 is unavailable.')).toBeTruthy();
  });
});
