/**
 * LoginPage — the #12 SSO bottom row. The oidc module and the auth session
 * are mocked at their boundaries; the page's OWN contract is:
 *  (a) the SSO button exists only when the server reports the surface enabled,
 *      labelled with the server-advertised oidc.button_label,
 *  (b) clicking hands off to the oidc module with the current signed-out
 *      route (the #114 continuation) — the browser redirect happens there,
 *  (c) a failed START is a visible alert and re-enables the password form.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

const authMethodsMock = vi.fn();
const startOidcSignInMock = vi.fn();
const currentReturnToMock = vi.fn();

vi.mock('../session.js', () => ({
    session: { setServerOrigin: vi.fn() },
    SERVER_ORIGIN_KEY: 'cytale.server_origin',
    DEFAULT_SERVER_ORIGIN: 'https://hrmny.example.com',
    ServerOriginError: class ServerOriginError extends Error {},
    validateServerOrigin: (raw: string | unknown) => {
      const url = new URL(String(raw).trim());
      if (url.protocol !== 'https:') throw new Error('Only https:// servers are accepted.');
      return url.origin;
    },
  api: {
    getAuthMethods: (...args: unknown[]) => authMethodsMock(...args),
  },
}));

vi.mock('../oidc.js', () => ({
  startOidcSignIn: (...args: unknown[]) => startOidcSignInMock(...args),
  currentReturnTo: () => currentReturnToMock(),
}));

vi.mock('../passkeys.js', () => ({
  authenticateWithPasskey: vi.fn(),
  describePasskeyError: (err: unknown) => (err instanceof Error ? err.message : 'failed'),
}));

const loginMock = vi.fn();
const loginWithTokensMock = vi.fn();

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({
    login: loginMock,
    loginWithTokens: loginWithTokensMock,
  }),
}));

import { LoginPage } from '../LoginPage.js';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('LoginPage — the SSO row (#12)', () => {
  it('renders the button only when the server reports oidc enabled, with the operator label', async () => {
    authMethodsMock.mockResolvedValue({
      password: true,
      webauthn: false,
      oidc: true,
      oidc_button_label: 'Sign in with Company SSO',
    });

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-oidc-button')).toBeTruthy());
    expect(screen.getByTestId('login-oidc-button').textContent).toBe('Sign in with Company SSO');
    // The passkey row stays honest to its own flag.
    expect(screen.queryByTestId('login-passkey-button')).toBeNull();
  });

  it('hides the row when the surface is disabled — the honest absence', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true, oidc: false });

    render(<LoginPage />);
    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('login-oidc-row')).toBeNull();
    expect(screen.queryByTestId('login-oidc-button')).toBeNull();
  });

  it('hides the row when the methods read FAILS (password path unaffected)', async () => {
    authMethodsMock.mockRejectedValue(new TypeError('Failed to fetch'));

    render(<LoginPage />);
    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('login-oidc-button')).toBeNull();
    expect(screen.getByLabelText('Username or email')).toBeTruthy();
  });

  it('clicking hands off to the oidc module with the current continuation', async () => {
    authMethodsMock.mockResolvedValue({
      password: true,
      webauthn: false,
      oidc: true,
      oidc_button_label: 'Continue with IdP',
    });
    currentReturnToMock.mockReturnValue('/workspace/9/message/3');
    startOidcSignInMock.mockResolvedValue(undefined);

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-oidc-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-oidc-button'));

    await waitFor(() =>
      expect(startOidcSignInMock).toHaveBeenCalledWith(expect.anything(), '/workspace/9/message/3'),
    );
    // Busy copy while the browser redirect is being prepared; no alert.
    expect((screen.getByTestId('login-oidc-button') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loginMock).not.toHaveBeenCalled();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  it('a failed START is visible and the button recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false, oidc: true });
    startOidcSignInMock.mockRejectedValue(
      new ApiError({ key: 'oidc_provider_unavailable', code: 50201, message: 'x', status: 502 }),
    );

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-oidc-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-oidc-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/could not start the sso sign-in/i);
    expect((screen.getByTestId('login-oidc-button') as HTMLButtonElement).disabled).toBe(false);
  });
});
