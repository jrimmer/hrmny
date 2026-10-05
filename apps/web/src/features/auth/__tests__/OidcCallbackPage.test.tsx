/**
 * OidcCallbackPage — the provider-redirect landing (#12). The api session and
 * the auth session are mocked; the page's OWN contract is:
 *  (a) it forwards the provider's code+state verbatim to POST /auth/oidc/callback,
 *  (b) success enters the SAME session machinery (loginWithTokens) and
 *      continues to the server-echoed return_to ("/" when none),
 *  (c) every failure is a visible alert with a way back to sign-in, and a
 *      landing without the provider's query says so instead of guessing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

const oidcCallbackMock = vi.fn();
const twoFactorVerifyMock = vi.fn();
const loginWithTokensMock = vi.fn();

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
    oidcCallback: (...args: unknown[]) => oidcCallbackMock(...args),
    twoFactorVerify: (...args: unknown[]) => twoFactorVerifyMock(...args),
  },
}));

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({
    loginWithTokens: loginWithTokensMock,
  }),
}));

import { OidcCallbackPage } from '../OidcCallbackPage.js';
import { OIDC_STATE_KEY } from '../oidc.js';

/** Land as the provider redirect would; by default THIS tab started the
    ceremony whose state is `xyz` (what startOidcSignIn remembers). */
function landWithQuery(query: string, rememberedState: string | null = 'xyz'): void {
  if (rememberedState !== null) sessionStorage.setItem(OIDC_STATE_KEY, rememberedState);
  window.location.hash = '/auth/oidc/callback' + query;
}

function renderPage(onNavigate?: (to: string) => void): void {
  render(<OidcCallbackPage onNavigate={onNavigate} />);
}

const TOKENS = {
  access_token: 'a',
  refresh_token: 'r',
  expires_in: 900,
  return_to: '/workspace/42',
};

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.location.hash = '';
  sessionStorage.clear();
});

describe('OidcCallbackPage — finishing the ceremony (#12)', () => {
  it('forwards code+state verbatim, signs in via loginWithTokens, continues to return_to', async () => {
    oidcCallbackMock.mockResolvedValue(TOKENS);
    const navigate = vi.fn();
    landWithQuery('?code=abc&state=xyz');

    renderPage(navigate);

    await waitFor(() =>
      expect(oidcCallbackMock).toHaveBeenCalledWith({ code: 'abc', state: 'xyz' }),
    );
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(TOKENS));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/workspace/42'));
  });

  it('a null return_to lands at "/"', async () => {
    oidcCallbackMock.mockResolvedValue({ ...TOKENS, return_to: null });
    const navigate = vi.fn();
    landWithQuery('?code=abc&state=xyz');

    renderPage(navigate);

    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalled());
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/'));
  });

  it('a landing without the provider query says so and never calls the server', async () => {
    landWithQuery('');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/did not return a completion code/i);
    expect(oidcCallbackMock).not.toHaveBeenCalled();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  it('a uniform server refusal is a visible alert with a way back', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    oidcCallbackMock.mockRejectedValue(
      new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'SSO sign-in failed.', status: 401 }),
    );
    landWithQuery('?code=abc&state=xyz');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('SSO sign-in failed.');
    expect(loginWithTokensMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to sign in' }));
  });

  it('an unreachable server is an actionable message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    oidcCallbackMock.mockRejectedValue(new TypeError('Failed to fetch'));
    landWithQuery('?code=abc&state=xyz');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i);
  });

  it('runs the exchange once even if the effect is re-invoked (single-use transaction)', async () => {
    oidcCallbackMock.mockResolvedValue(TOKENS);
    landWithQuery('?code=abc&state=xyz');

    renderPage();
    await waitFor(() => expect(oidcCallbackMock).toHaveBeenCalledTimes(1));
  });
});

describe('OidcCallbackPage — login-CSRF state binding (Tier 3 #1c)', () => {
  it('refuses a callback whose state this tab never started, without calling the server', async () => {
    landWithQuery('?code=abc&state=attacker', 'mine');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/not started from this browser tab/i);
    expect(oidcCallbackMock).not.toHaveBeenCalled();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
    // Single-use: the remembered state is gone either way.
    expect(sessionStorage.getItem(OIDC_STATE_KEY)).toBeNull();
  });

  it('refuses when no ceremony was started in this tab at all', async () => {
    landWithQuery('?code=abc&state=xyz', null);

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(oidcCallbackMock).not.toHaveBeenCalled();
  });

  it('consumes the remembered state on a match (a replay cannot reuse it)', async () => {
    oidcCallbackMock.mockResolvedValue(TOKENS);
    landWithQuery('?code=abc&state=xyz');

    renderPage();

    await waitFor(() => expect(oidcCallbackMock).toHaveBeenCalledTimes(1));
    expect(sessionStorage.getItem(OIDC_STATE_KEY)).toBeNull();
  });
});

describe('OidcCallbackPage — enrolled accounts owe the TOTP step (Tier 3 #1b)', () => {
  const STEP = {
    status: 'totp_pending',
    grant: 'g-1',
    user: { id: '7', username: 'alice' },
    return_to: '/workspace/42',
  };

  it('shows the code step (no session yet); a valid code signs in and continues to return_to', async () => {
    oidcCallbackMock.mockResolvedValue(STEP);
    twoFactorVerifyMock.mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 900 });
    const navigate = vi.fn();
    landWithQuery('?code=abc&state=xyz');

    renderPage(navigate);

    await waitFor(() => expect(screen.getByTestId('oidc-totp-step')).toBeTruthy());
    expect(screen.getByTestId('oidc-totp-user').textContent).toContain('@alice');
    expect(loginWithTokensMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId('oidc-totp-input'), { target: { value: '123 456' } });
    fireEvent.submit(screen.getByTestId('oidc-totp-step'));

    await waitFor(() =>
      expect(twoFactorVerifyMock).toHaveBeenCalledWith({ grant: 'g-1', code: '123456' }),
    );
    await waitFor(() =>
      expect(loginWithTokensMock).toHaveBeenCalledWith({ access_token: 'a', refresh_token: 'r', expires_in: 900 }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/workspace/42'));
  });

  it('a refused code spends the step: the server copy shows with the way back to sign in', async () => {
    oidcCallbackMock.mockResolvedValue(STEP);
    twoFactorVerifyMock.mockRejectedValue(
      new ApiError({
        key: 'invalid_credentials',
        code: 40101,
        message: "That code didn't match, or this sign-in step expired. Sign in again.",
        status: 401,
      }),
    );
    landWithQuery('?code=abc&state=xyz');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-totp-step')).toBeTruthy());
    fireEvent.change(screen.getByTestId('oidc-totp-input'), { target: { value: '000000' } });
    fireEvent.submit(screen.getByTestId('oidc-totp-step'));

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/didn't match/);
    expect(screen.queryByTestId('oidc-totp-step')).toBeNull();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });
});

describe('OidcCallbackPage — unverified local account (Tier 3 #1a)', () => {
  it('shows the server\'s link-required guidance verbatim', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    oidcCallbackMock.mockRejectedValue(
      new ApiError({
        key: 'oidc_link_required',
        code: 40901,
        message: 'Sign in with your password and verify your email address.',
        status: 409,
      }),
    );
    landWithQuery('?code=abc&state=xyz');

    renderPage();

    await waitFor(() => expect(screen.getByTestId('oidc-callback-error')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain('Sign in with your password');
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });
});
