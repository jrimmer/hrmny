/**
 * LoginPage — the #36 bottom-button passkey path. The passkeys module and the
 * auth session are mocked at their boundaries: the page's OWN contract is
 * (a) the button exists only when the server reports the surface enabled,
 * (b) success hands the token pair to the SAME session machinery password
 * login uses (so continuation resumes identically), and (c) every failure is
 * a visible alert.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PasskeyError } from '../passkeys.js';

const authMethodsMock = vi.fn();
const authenticateWithPasskeyMock = vi.fn();

vi.mock('../passkeys.js', () => ({
  // Stand-in error class: the page only reads `.message` for the alert copy.
  PasskeyError: class PasskeyError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
  authenticateWithPasskey: (...args: unknown[]) => authenticateWithPasskeyMock(...args),
  describePasskeyError: (err: unknown) =>
    err instanceof Error ? err.message : 'Passkey operation failed.',
}));

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

describe('LoginPage — passkey bottom button', () => {
  it('renders the button only when the server reports webauthn enabled', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
  });

  it('hides the button when the surface is disabled — and never calls the api beyond methods', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    render(<LoginPage />);
    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('login-passkey-button')).toBeNull();
    expect(authenticateWithPasskeyMock).not.toHaveBeenCalled();
  });

  it('hides the button when the methods read FAILS (password path unaffected)', async () => {
    authMethodsMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginPage />);
    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(screen.queryByTestId('login-passkey-button')).toBeNull();
    // Password form still present and functional.
    expect(screen.getByLabelText('Username or email')).toBeTruthy();
  });

  it('success hands the SAME token pair to the session (loginWithTokens), like password login', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    const tokens = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };
    authenticateWithPasskeyMock.mockResolvedValue(tokens);

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-passkey-button'));

    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(tokens));
    expect(loginMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a cancelled prompt shows the visible message', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    authenticateWithPasskeyMock.mockRejectedValue(
      new PasskeyError('cancelled', 'Passkey prompt was cancelled or no authenticator was available.'),
    );

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-passkey-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/cancelled/i);
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  it('a server refusal (e.g. 401 INVALID_CREDENTIALS) is visible, never a silent no-op', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    authenticateWithPasskeyMock.mockRejectedValue(new PasskeyError('server', 'Passkey sign-in failed.'));

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-passkey-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toBe('Passkey sign-in failed.');
  });

  it('an unsupported browser/context is a visible message', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    authenticateWithPasskeyMock.mockRejectedValue(
      new PasskeyError('unsupported', 'This browser or context does not support passkeys (an HTTPS connection is required).'),
    );

    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
    fireEvent.click(screen.getByTestId('login-passkey-button'));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/HTTPS/);
  });
});
