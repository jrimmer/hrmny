/**
 * Auth surface integration (plan 004 M12, R4/R6).
 *
 * `renderRouter` mounts the REAL `app/` tree — root gate, auth group, drawer
 * group — with the REAL `SessionManager` (memory storage, stubbed wire, fake
 * socket). Nothing about the session is mocked: `login`, `register`,
 * `verifyEmail`, `resendVerification`, the refresh exchange, and `logout` are
 * the shared package's own code, which is the point of the unit (R4).
 *
 * Every scenario in the plan's M12 list is here, plus the accessibility
 * contract (R18) for the auth controls.
 */
jest.mock('@cytale/session', () => require('./support').sessionModuleMock());

import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';
import { userEvent } from '@testing-library/react-native';

import { resetSurfaceStates } from '../../navigation/shellState';
import { APP_DIR, IDS, resetShellStore, seedShellStore } from '../../navigation/__tests__/support';
import { clearPendingRoute } from '../pendingRoute';
import { resetSessionNotice } from '../sessionNotice';
import { AUTH_ROUTES } from '../routes';
import { resetVerificationGate } from '../verificationGate';
import {
  authRoutes,
  TOKENS,
  installWire,
  lastBuiltSession,
  resetSessionModuleMock,
  signInRouteSession,
  UNVERIFIED_USER,
  VERIFIED_USER,
  type Wire,
  type WireRoute,
} from './support';

async function press(element: Parameters<typeof userEvent.press>[0]): Promise<void> {
  await userEvent.setup().press(element);
}

async function type(testID: string, text: string): Promise<void> {
  await fireEvent.changeText(screen.getByTestId(testID), text);
}

async function signIn(identifier = 'rowan', password = 'secret') {
  await type('sign-in-identifier', identifier);
  await type('sign-in-password', password);
  await press(screen.getByTestId('sign-in-submit'));
}

/** Render the real app tree and wait for the gate to settle on a surface. */
async function renderApp(initialUrl: string, surface: string) {
  const result = renderRouter(APP_DIR, { initialUrl });
  await result;
  await waitFor(() => expect(screen.getByTestId(surface)).toBeTruthy());
  // Wrapped: the RNTL result is thenable, so returning it from an async
  // helper would await it away.
  return { result };
}

/** The signed-out entry point: the gate always lands on sign-in. */
function renderSignedOut(initialUrl: string) {
  return renderApp(initialUrl, 'surface-sign-in');
}

/** Resolve a Pressable's style (function or array) into one object. */
function flattenedStyle(element: { props: { style?: unknown } }): Record<string, unknown> {
  const raw = element.props.style;
  const resolved = typeof raw === 'function' ? (raw as (s: unknown) => unknown)({ pressed: false }) : raw;
  const entries = ([] as unknown[]).concat(resolved ?? []).filter(
    (entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null,
  );
  return Object.assign({}, ...entries);
}

let wire: Wire;

function install(routes: WireRoute[] = authRoutes()): void {
  wire = installWire(routes);
}

beforeEach(() => {
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
  seedShellStore();
  resetSessionNotice();
  clearPendingRoute();
  resetVerificationGate();
  install();
});

afterEach(() => {
  wire.restore();
  resetSessionModuleMock();
  resetShellStore();
  resetSurfaceStates();
  resetSessionNotice();
  clearPendingRoute();
  resetVerificationGate();
});

describe('the gate', () => {
  it('lands a fresh install on sign-in — never the drawer, never a permanent spinner', async () => {
    await renderSignedOut('/');

    expect(screen.getByTestId('surface-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('surface-home')).toBeNull();
    expect(screen.queryByTestId('auth-splash')).toBeNull();
    expect(screen.queryByTestId('surface-loading')).toBeNull();
  });

  it('lands a channel deep link on sign-in and resumes at that channel after sign-in', async () => {
    const { result } = await renderSignedOut(`/channel/${IDS.general}`);

    expect(result.getPathname()).toBe(AUTH_ROUTES.signIn);
    expect(screen.getByTestId('surface-sign-in')).toBeTruthy();
    expect(screen.queryByTestId('surface-channel')).toBeNull();

    await signIn();

    await waitFor(() => expect(result.getPathname()).toBe(`/channel/${IDS.general}`));
    expect(screen.getByTestId('surface-channel')).toBeTruthy();
    expect(screen.queryByTestId('surface-sign-in')).toBeNull();
  });

  it('keeps the shell unreachable while signed out', async () => {
    const { result } = await renderSignedOut('/settings');

    expect(result.getPathname()).toBe(AUTH_ROUTES.signIn);
    expect(screen.queryByTestId('settings-list')).toBeNull();
  });
});

describe('sign-in', () => {
  it('surfaces a wrong password inline and stays on the form', async () => {
    install(
      authRoutes({
        login: () => ({
          status: 401,
          body: { error: { key: 'INVALID_CREDENTIALS', code: 40101, message: 'bad credentials' } },
        }),
      }),
    );
    const { result } = await renderSignedOut(AUTH_ROUTES.signIn);

    await signIn('rowan', 'wrong');

    await waitFor(() => expect(screen.getByTestId('sign-in-error')).toBeTruthy());
    expect(screen.getByTestId('sign-in-error')).toHaveTextContent(/Wrong username\/email or password\./);
    expect(result.getPathname()).toBe(AUTH_ROUTES.signIn);
    expect(screen.queryByTestId('surface-home')).toBeNull();
  });

  it('points the login at the server field, not the build-time origin', async () => {
    install(authRoutes({ login: () => ({ status: 200, body: TOKENS }) }));
    const { result } = await renderSignedOut(AUTH_ROUTES.signIn);

    await type('sign-in-server', 'https://other.example');
    await signIn('rowan', 'secret');

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    const login = wire.calls.find((call) => call.url.endsWith('/auth/login'));
    expect(login?.url.startsWith('https://other.example/api/v1/auth/login')).toBe(true);
  });

  it('renders the offline state with a retry that re-submits the last attempt', async () => {
    install(
      authRoutes({
        login: () => {
          throw new TypeError('Network request failed');
        },
      }),
    );
    const { result } = await renderSignedOut(AUTH_ROUTES.signIn);

    await signIn('rowan', 'secret');

    await waitFor(() => expect(screen.getByTestId('sign-in-offline')).toBeTruthy());
    expect(screen.getByTestId('sign-in-offline')).toHaveTextContent(/You appear to be offline/);
    expect(result.getPathname()).toBe(AUTH_ROUTES.signIn);

    // The network comes back; the retry must not need the user to retype.
    wire.restore();
    install();
    await press(screen.getByTestId('sign-in-retry'));

    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(screen.getByTestId('surface-home')).toBeTruthy();
  });

  it('explains a session that ended instead of looping on reconnect', async () => {
    let revoked = false;
    install(
      authRoutes({
        usersMe: () =>
          revoked
            ? { status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'revoked' } } }
            : { status: 200, body: { user: VERIFIED_USER } },
        refresh: () =>
          revoked
            ? { status: 401, body: { error: { key: 'unauthorized', code: 40101, message: 'revoked' } } }
            : { status: 200, body: { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 } },
      }),
    );
    const { result } = await renderSignedOut('/');
    await signIn();
    await waitFor(() => expect(result.getPathname()).toBe('/'));

    const built = lastBuiltSession();
    expect(built).not.toBeNull();

    // The server revokes the session mid-use: the next authenticated call
    // fails, the refresh fails, and the manager's onLogout hard-logs-out.
    revoked = true;
    // An async `waitFor` callback leaves act scopes open and poisons the
    // renders that follow, so the rejection is captured as a value instead.
    let revokedCall: Promise<unknown> = Promise.resolve(null);
    await act(async () => {
      revokedCall = built!.manager.api.getCurrentUser().catch((error: unknown) => error);
    });
    await waitFor(() => expect(screen.getByTestId('surface-sign-in')).toBeTruthy());
    expect(await revokedCall).toBeTruthy();
    expect(screen.getByTestId('sign-in-notice')).toHaveTextContent(
      /Your session expired\. Please sign in again\./,
    );
    expect(result.getPathname()).toBe(AUTH_ROUTES.signIn);
    // Not a reconnect loop: the gateway is gone and the token pair is cleared.
    expect(lastBuiltSession()!.manager.getGateway()).toBeNull();
    expect(lastBuiltSession()!.storage.snapshot()).toBeNull();
  });

  it('returns to sign-in and clears storage on sign-out', async () => {
    const { result } = await renderSignedOut('/');
    await signIn();
    await waitFor(() => expect(result.getPathname()).toBe('/'));

    const built = lastBuiltSession();
    expect(built!.storage.snapshot()).not.toBeNull();

    // The settings screen's Log out row calls exactly this.
    await act(async () => {
      await built!.manager.logout();
    });

    await waitFor(() => expect(screen.getByTestId('surface-sign-in')).toBeTruthy());
    expect(built!.storage.snapshot()).toBeNull();
    expect(screen.getByTestId('sign-in-notice')).toHaveTextContent(/You have been signed out\./);
  });
});

describe('sign-up and verification', () => {
  it('routes a new account to the verification-pending screen and resends', async () => {
    install(authRoutes({ user: UNVERIFIED_USER }));
    const { result } = await renderSignedOut(AUTH_ROUTES.signIn);

    await press(screen.getByTestId('sign-in-create-account'));
    expect(result.getPathname()).toBe(AUTH_ROUTES.signUp);

    await type('sign-up-username', 'rowan');
    await type('sign-up-email', 'rowan@jmc.test');
    await type('sign-up-password', 'secret');
    await press(screen.getByTestId('sign-up-submit'));

    await waitFor(() => expect(result.getPathname()).toBe(AUTH_ROUTES.verifyEmail));
    expect(screen.getByTestId('surface-verify-email')).toBeTruthy();
    expect(screen.getByTestId('verify-email-view-only')).toBeTruthy();
    expect(screen.queryByTestId('surface-home')).toBeNull();

    await press(screen.getByTestId('verify-email-resend'));
    await waitFor(() => expect(wire.seen('/auth/resend-verification')).toHaveLength(1));
    expect(screen.getByTestId('verify-email-resent')).toBeTruthy();

    // Web's read-only semantics survive the gate: the member may continue.
    await press(screen.getByTestId('verify-email-continue'));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(screen.getByTestId('surface-home')).toBeTruthy();
    // Still unverified: the shell's view-only producer (M5) enforces the rest.
    expect(lastBuiltSession()!.manager.authStore.getState().emailVerified).toBe(false);
  });

  it('shows the verification gate when an unverified account signs in', async () => {
    install(authRoutes({ user: UNVERIFIED_USER }));
    const { result } = await renderSignedOut('/');

    await signIn();

    await waitFor(() => expect(result.getPathname()).toBe(AUTH_ROUTES.verifyEmail));
    expect(screen.getByTestId('surface-verify-email')).toBeTruthy();
    expect(screen.queryByTestId('surface-home')).toBeNull();
  });

  it('consumes an emailed token from the link and reports the outcome', async () => {
    const { result } = await renderApp(`${AUTH_ROUTES.verifyEmail}?token=tok-123`, 'surface-verify-email');

    await waitFor(() => expect(wire.seen('/auth/verify-email')).toHaveLength(1));
    expect(wire.seen('/auth/verify-email')[0]?.body).toMatchObject({ token: 'tok-123' });
    expect(screen.getByTestId('verify-email-done')).toHaveTextContent(/Email verified/);
  });

  it('consumes a link opened while already signed in, then returns to the app', async () => {
    // A signed-in member taps the emailed link: the gate must not bounce the
    // token landing to Home before the token is exchanged.
    signInRouteSession();
    install(authRoutes());
    const { result } = await renderApp(`${AUTH_ROUTES.verifyEmail}?token=tok-9`, 'surface-verify-email');

    await waitFor(() => expect(wire.seen('/auth/verify-email')).toHaveLength(1));
    expect(screen.getByTestId('verify-email-done')).toBeTruthy();

    await press(screen.getByTestId('verify-email-open-app'));
    await waitFor(() => expect(result.getPathname()).toBe('/'));
    expect(screen.getByTestId('surface-home')).toBeTruthy();
  });

  it('reports a used or invalid verification link', async () => {
    wire.restore();
    install([
      {
        match: (url) => url.endsWith('/auth/verify-email'),
        respond: () => ({ status: 400, body: { error: { key: 'invalid_token', code: 40001, message: 'used' } } }),
      },
    ]);

    await renderApp(`${AUTH_ROUTES.verifyEmail}?token=stale`, 'surface-verify-email');

    await waitFor(() => expect(screen.getByTestId('verify-email-error')).toBeTruthy());
    expect(screen.getByTestId('verify-email-error')).toHaveTextContent(/invalid or was already used/);
  });

  // The server answers ONE anti-enumeration `taken` code for a taken username
  // or email (S5, a3a3fb9); this suite could not load when that landed, so it
  // still asserted the old username-only copy.
  it('surfaces a taken username or email inline on sign-up', async () => {
    install(
      authRoutes({
        register: () => ({ status: 409, body: { error: { key: 'taken', code: 40901, message: 'taken' } } }),
      }),
    );
    const { result } = await renderApp(AUTH_ROUTES.signUp, 'surface-sign-up');

    await type('sign-up-username', 'rowan');
    await type('sign-up-email', 'rowan@jmc.test');
    await type('sign-up-password', 'secret');
    await press(screen.getByTestId('sign-up-submit'));

    await waitFor(() => expect(screen.getByTestId('sign-up-error')).toBeTruthy());
    expect(screen.getByTestId('sign-up-error')).toHaveTextContent(/That username or email is already registered\./);
    expect(result.getPathname()).toBe(AUTH_ROUTES.signUp);
  });
});

describe('accessibility', () => {
  it('names every auth control and meets the 44pt touch floor', async () => {
    await renderSignedOut(AUTH_ROUTES.signIn);

    expect(screen.getByLabelText('Username or email')).toBeTruthy();
    expect(screen.getByLabelText('Password')).toBeTruthy();

    const controls = [
      screen.getByTestId('sign-in-submit'),
      screen.getByTestId('sign-in-create-account'),
      screen.getByTestId('sign-in-identifier'),
      screen.getByTestId('sign-in-password'),
    ];

    for (const control of controls) {
      expect(control).toHaveAccessibleName();
      expect(flattenedStyle(control).minHeight).toBeGreaterThanOrEqual(44);
    }
  });
});
