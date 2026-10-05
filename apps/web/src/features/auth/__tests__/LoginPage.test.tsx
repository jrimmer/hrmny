/**
 * LoginPage error rendering (diagnosability hardening, 2026-09-10).
 *
 * Pins the user-visible half of the fix: a failed sign-in now distinguishes
 * an unreachable server from a generic failure, and a generic failure shows
 * the machine detail (key · code · status) instead of hiding it.
 *
 * #127: the password submit reads POST /auth/login through `loginRaw` (the
 * branch-aware typing — the page may take a totp/enrollment step next), so
 * these tests mock the api at that seam; the error-classification contract
 * below is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

const authMethodsMock = vi.fn();
const loginRawMock = vi.fn();

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
    loginRaw: (...args: unknown[]) => loginRawMock(...args),
  },
}));

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({
    loginWithTokens: vi.fn(),
  }),
}));

import { LoginPage } from '../LoginPage.js';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function submit(): void {
  fireEvent.change(screen.getByLabelText('Username or email'), {
    target: { value: 'jordan' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage — error rendering', () => {
  it('bad credentials: specific copy, no detail line', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(
      new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'x', status: 401 }),
    );
    render(<LoginPage />);
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Wrong username/email or password.');
    expect(screen.queryByTestId('login-error-detail')).toBeNull();
  });

  it('unreachable server: actionable message instead of the generic one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<LoginPage />);
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i);
  });

  it('other API failure: generic copy PLUS the machine detail, and the cause is logged', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(
      new ApiError({ key: 'INTERNAL_ERROR', code: 50001, message: 'boom', status: 500 }),
    );
    render(<LoginPage />);
    submit();
    await waitFor(() => expect(screen.getByTestId('login-error-detail')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Could not sign in. Please try again.');
    expect(screen.getByTestId('login-error-detail').textContent).toBe(
      'INTERNAL_ERROR · 50001 · HTTP 500',
    );
    expect(spy).toHaveBeenCalled();
  });

  // #90: behind a NAT the whole team shares one per-IP budget, and a 429 used
  // to render as "your credentials are wrong" — the visible half of the bug.
  it('a 429 says to slow down with the server retry hint, never a credential failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(
      new ApiError({
        key: 'rate_limited',
        code: 42901,
        message:
          'Too many requests from this network — the per-IP limit is 30 per 10s and is shared by everyone behind this IP. Try again in 12 seconds.',
        status: 429,
      }),
    );
    render(<LoginPage />);
    submit();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/try again in 12 seconds/i);
    expect(screen.getByRole('alert').textContent).not.toContain('Could not sign in');
    expect(screen.getByTestId('login-error-detail').textContent).toBe(
      'rate_limited · 42901 · HTTP 429',
    );
  });
});
