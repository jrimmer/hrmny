/**
 * The desktop shell's server-address field (owner direction 2026-09-19).
 *
 * The Tauri shell connects to a USER-CHOSEN server: the login carries a
 * server field (default: the build's hosted origin, here https://hosted.example.com) that is validated, persisted to
 * localStorage for the next launch, and applied to the live session BEFORE
 * the credential walk dials it. Browsers never see the field — they are
 * same-origin by construction — so this suite mocks the shell detection on.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const setServerOriginMock = vi.fn();
const loginRawMock = vi.fn();

/** Enter the desktop shell: Tauri 2 injects this global; isTauri() reads it. */
function enterDesktopShell(): void {
  (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
}

function leaveDesktopShell(): void {
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
}

vi.mock('../session.js', async () => {
  const actualSession = await vi.importActual<typeof import('@cytale/session')>('@cytale/session');
  return {
    // The real validator — the login form's rule (https / dev loopback) is
    // the session package's contract, so the suite exercises the actual one.
    validateServerOrigin: actualSession.validateServerOrigin,
    ServerOriginError: actualSession.ServerOriginError,
    // What a deployment's build suggests (VITE_CYTALE_HOSTED_ORIGIN).
    DEFAULT_SERVER_ORIGIN: 'https://hosted.example.com',
    api: {
      getAuthMethods: vi.fn().mockResolvedValue({ webauthn: false, oidc: false }),
      loginRaw: (...args: unknown[]) => loginRawMock(...args),
    },
    session: {
      setServerOrigin: (...args: unknown[]) => setServerOriginMock(...args),
    },
    SERVER_ORIGIN_KEY: 'cytale.server_origin',
  };
});

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({
    loginWithTokens: vi.fn(),
  }),
}));

import { LoginPage } from '../LoginPage.js';

const TOKENS = { access_token: 'a', refresh_token: 'r', expires_in: 900 };

beforeEach(() => {
  localStorage.clear();
  setServerOriginMock.mockClear();
  loginRawMock.mockClear();
  leaveDesktopShell();
  enterDesktopShell();
  loginRawMock.mockResolvedValue(TOKENS);
});

afterEach(() => {
  cleanup();
});

describe('LoginPage — the desktop server-address field', () => {
  it('renders only in the desktop shell, defaulting to the product home', () => {
    render(<LoginPage />);
    expect(screen.getByTestId('login-server')).toBeTruthy();
    expect((screen.getByTestId('login-server') as HTMLInputElement).value).toBe('https://hosted.example.com');
  });

  it('never renders in a browser (same-origin by construction)', () => {
    leaveDesktopShell();
    render(<LoginPage />);
    expect(screen.queryByTestId('login-server')).toBeNull();
  });

  it('validates, persists, and applies the server before the credential walk', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.clear(screen.getByTestId('login-server'));
    await user.type(screen.getByTestId('login-server'), 'https://chat.example');
    await user.type(screen.getByLabelText('Username or email'), 'rowan');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(setServerOriginMock).toHaveBeenCalledWith('https://chat.example');
    expect(localStorage.getItem('cytale.server_origin')).toBe('https://chat.example');
    expect(loginRawMock).toHaveBeenCalledWith({ identifier: 'rowan', password: 'secret' });
  });

  it('refuses a non-https server with the form\u2019s own error slot', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.clear(screen.getByTestId('login-server'));
    await user.type(screen.getByTestId('login-server'), 'http://insecure.example');
    await user.type(screen.getByLabelText('Username or email'), 'rowan');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByTestId('login-server-error').textContent).toContain('Only https://');
    expect(setServerOriginMock).not.toHaveBeenCalled();
    expect(loginRawMock).not.toHaveBeenCalled();
  });

  it('a rejected address never persists, and the next submit re-validates', async () => {
    const user = userEvent.setup();
    render(<LoginPage />);
    await user.clear(screen.getByTestId('login-server'));
    await user.type(screen.getByTestId('login-server'), '   ');
    await user.type(screen.getByLabelText('Username or email'), 'rowan');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByTestId('login-server-error')).toBeTruthy();
    expect(localStorage.getItem('cytale.server_origin')).toBeNull();
  });
});
