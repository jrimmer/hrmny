/**
 * Channel route wiring (plan 004 M6).
 *
 * The M5 route shipped a placeholder body; M6 renders `MessageList` inside
 * the shell's frame. This mounts the REAL `app/` directory (root layout →
 * drawer group → channel route) so the wiring is asserted where the device
 * runs it: one title bar, the list inside `channel-body`, and the surface's
 * states still owned by the scaffold around it.
 *
 * The session is unauthenticated in this harness (the same memory-free
 * manager the M5 router tests use), which is also the signed-out contract:
 * no history request is attempted, so the list renders its empty state
 * inside the shell rather than a spinner that can never resolve.
 */
import { renderRouter, screen, within } from 'expo-router/testing-library';

import { resetSessionModuleMock, signInRouteSession, signOutRouteSession } from '../../auth/__tests__/support';
import {
  APP_DIR,
  resetShellStore,
  seedShellStore,
  IDS,
} from '../../navigation/__tests__/support';
import { resetSurfaceStates } from '../../navigation/shellState';

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

describe('channel route', () => {
  it('renders the message list inside the shell body', async () => {
    await renderRouter(APP_DIR, { initialUrl: `/channel/${IDS.general}` });

    expect(screen.getByTestId('surface-channel')).toBeTruthy();
    expect(screen.getAllByTestId('title-bar')).toHaveLength(1);

    const body = screen.getByTestId('channel-body');
    // The list owns the body: its root is mounted inside it, and the empty
    // state comes from the list (not the scaffold) because the window is
    // empty and the session is not authenticated.
    expect(within(body).getByTestId('message-list-root')).toBeTruthy();
    expect(within(body).getByTestId('surface-empty')).toBeTruthy();
    expect(within(body).queryByTestId('message-list')).toBeNull();
  });

  it('keeps the unknown-channel failure a surface state, not a list state', async () => {
    await renderRouter(APP_DIR, { initialUrl: '/channel/999999999999999999' });

    expect(screen.getByTestId('surface-error')).toBeTruthy();
    expect(screen.getByText('#999999999999999999 is unavailable.')).toBeTruthy();
    expect(screen.queryByTestId('message-list-root')).toBeNull();
  });
});
