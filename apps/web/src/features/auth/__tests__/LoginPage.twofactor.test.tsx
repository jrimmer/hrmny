/**
 * LoginPage — the #127 branches. When the server's 2FA switch is on, a
 * verified password is not always enough: the page's OWN contract here is
 *
 *   (a) `totp_pending` → the 6-digit code step; a valid code swaps the grant
 *       for the token pair, which enters the SAME session machinery
 *       (loginWithTokens) as every other login — the signed-out continuation
 *       resumes identically, and the post-password passkey ask is armed
 *       (a 2FA login is still a password login);
 *   (b) `enrollment_required` → the QR/secret walk; confirm's success mints
 *       the pair — skipping is impossible;
 *   (c) a wrong code shows the SERVER's copy and stays on the step;
 *   (d) the mode flipping off mid-flow (`two_factor_disabled`) returns the
 *       user to the password form with the server's message;
 *   (e) the classic token-pair response keeps today's path (loginWithTokens,
 *       passkey ask armed) — the branch adds, it never replaces.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@cytale/api-client';

const authMethodsMock = vi.fn();
const loginRawMock = vi.fn();
const twoFactorVerifyMock = vi.fn();
const twoFactorEnrollStartMock = vi.fn();
const twoFactorEnrollConfirmMock = vi.fn();

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
    twoFactorVerify: (...args: unknown[]) => twoFactorVerifyMock(...args),
    twoFactorEnrollStart: (...args: unknown[]) => twoFactorEnrollStartMock(...args),
    twoFactorEnrollConfirm: (...args: unknown[]) => twoFactorEnrollConfirmMock(...args),
  },
}));

const loginWithTokensMock = vi.fn();

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({
    loginWithTokens: loginWithTokensMock,
  }),
}));

import { LoginPage } from '../LoginPage.js';

const TOKENS = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function submitPassword(): void {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'jordan' } });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'pw' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

async function enterTotpStep(): Promise<void> {
  authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
  loginRawMock.mockResolvedValue({ status: 'totp_pending', grant: 'g-1', user: { id: '9', username: 'jordan' } });
  render(<LoginPage />);
  submitPassword();
  await waitFor(() => expect(screen.getByTestId('login-totp-step')).toBeTruthy());
}

async function enterEnrollStep(): Promise<void> {
  authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
  loginRawMock.mockResolvedValue({
    status: 'enrollment_required',
    grant: 'g-2',
    user: { id: '9', username: 'jordan' },
  });
  twoFactorEnrollStartMock.mockResolvedValue({
    secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
    otpauth_uri: 'otpauth://totp/Hrmny:jordan?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Hrmny',
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
  });
  render(<LoginPage />);
  submitPassword();
  await waitFor(() => expect(screen.getByTestId('login-enroll-step')).toBeTruthy());
}

describe("LoginPage — totp_pending (the enrolled account's second factor)", () => {
  it('branches to the code step, carrying the grant and the step identity', async () => {
    await enterTotpStep();
    expect(loginRawMock).toHaveBeenCalledWith({ identifier: 'jordan', password: 'pw' });
    expect(screen.getByTestId('login-step-user').textContent).toBe('Signing in as @jordan');
    // The password form is gone; the code input is focused for typing.
    const input = screen.getByTestId('login-totp-input') as HTMLInputElement;
    expect(document.activeElement).toBe(input);
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  it('a valid code swaps the grant for the pair via loginWithTokens', async () => {
    await enterTotpStep();
    twoFactorVerifyMock.mockResolvedValue(TOKENS);

    await userEvent.setup().type(screen.getByTestId('login-totp-input'), '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(twoFactorVerifyMock).toHaveBeenCalledWith({ grant: 'g-1', code: '123456' }));
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(TOKENS));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("a wrong code shows the SERVER's message and stays on the step", async () => {
    await enterTotpStep();
    twoFactorVerifyMock.mockRejectedValue(
      new ApiError({
        key: 'INVALID_CREDENTIALS',
        code: 40101,
        message: "That code didn't match, or this sign-in step expired. Sign in again.",
        status: 401,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-totp-input'), '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByTestId('login-totp-error').textContent).toBe(
      "That code didn't match, or this sign-in step expired. Sign in again.",
    ));
    expect(screen.getByTestId('login-totp-step')).toBeTruthy();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  // 6.4 rename window: the post-rename lower_snake spellings must behave
  // exactly like the upper-case ones (both spellings are live during rollout).
  it('the post-6.4 lower_snake key (invalid_credentials) is handled identically', async () => {
    await enterTotpStep();
    twoFactorVerifyMock.mockRejectedValue(
      new ApiError({
        key: 'invalid_credentials',
        code: 40101,
        message: "That code didn't match, or this sign-in step expired. Sign in again.",
        status: 401,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-totp-input'), '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() =>
      expect(screen.getByTestId('login-totp-error').textContent).toBe(
        "That code didn't match, or this sign-in step expired. Sign in again.",
      ),
    );
    expect(screen.getByTestId('login-totp-step')).toBeTruthy();
  });

  it('the post-6.4 lower_snake key (already_enrolled) also returns to the password form', async () => {
    await enterTotpStep();
    twoFactorVerifyMock.mockRejectedValue(
      new ApiError({
        key: 'already_enrolled',
        code: 40901,
        message: 'This account already has two-factor authentication.',
        status: 409,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-totp-input'), '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/already has two-factor/));
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByTestId('login-totp-step')).toBeNull();
  });

  it('the mode flipping off mid-flow (two_factor_disabled) returns to the password form', async () => {
    await enterTotpStep();
    twoFactorVerifyMock.mockRejectedValue(
      new ApiError({
        key: 'two_factor_disabled',
        code: 40301,
        message: 'Two-factor authentication is disabled on this server',
        status: 403,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-totp-input'), '123456');
    fireEvent.click(screen.getByRole('button', { name: 'Verify' }));

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/disabled on this server/));
    // The password form is back (re-start the login), with a fresh password.
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(screen.queryByTestId('login-totp-step')).toBeNull();
  });

  it('Back to sign in leaves the step without any call', async () => {
    await enterTotpStep();
    await userEvent.setup().click(screen.getByTestId('login-step-back'));

    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(twoFactorVerifyMock).not.toHaveBeenCalled();
  });
});

describe('LoginPage — enrollment_required (the forced walk)', () => {
  it('walks to the QR step: secret + client-rendered QR, then confirm mints the pair', async () => {
    await enterEnrollStep();
    expect(twoFactorEnrollStartMock).toHaveBeenCalledWith('g-2');
    expect(screen.getByTestId('login-step-user').textContent).toBe('Signing in as @jordan');
    // The QR renders client-side from the otpauth URI, and the base32 secret
    // is shown for manual entry.
    expect(screen.getByTestId('qr-svg')).toBeTruthy();
    expect(screen.getByTestId('qr-svg').querySelectorAll('path').length).toBeGreaterThan(0);
    expect(screen.getByTestId('login-enroll-secret').textContent).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');

    twoFactorEnrollConfirmMock.mockResolvedValue(TOKENS);
    await userEvent.setup().type(screen.getByTestId('login-enroll-input'), '654321');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(twoFactorEnrollConfirmMock).toHaveBeenCalledWith({ grant: 'g-2', code: '654321' }),
    );
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(TOKENS));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it("a wrong confirmation code shows the server's copy and keeps the walk on screen", async () => {
    await enterEnrollStep();
    twoFactorEnrollConfirmMock.mockRejectedValue(
      new ApiError({
        key: 'INVALID_CODE',
        code: 40001,
        message: "That code didn't match. Check your authenticator app and try again.",
        status: 400,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-enroll-input'), '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(screen.getByTestId('login-enroll-error').textContent).toMatch(
      /didn't match/,
    ));
    // The walk (QR + secret) stays — a typo must not lose the setup.
    expect(screen.getByTestId('login-enroll-step')).toBeTruthy();
    expect(screen.getByTestId('qr-svg')).toBeTruthy();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  // 6.4 rename window: the lower_snake `invalid_code` spelling keeps the walk.
  it('the post-6.4 lower_snake key (invalid_code) keeps the walk on screen', async () => {
    await enterEnrollStep();
    twoFactorEnrollConfirmMock.mockRejectedValue(
      new ApiError({
        key: 'invalid_code',
        code: 40001,
        message: "That code didn't match. Check your authenticator app and try again.",
        status: 400,
      }),
    );

    await userEvent.setup().type(screen.getByTestId('login-enroll-input'), '000000');
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));

    await waitFor(() =>
      expect(screen.getByTestId('login-enroll-error').textContent).toMatch(/didn't match/),
    );
    expect(screen.getByTestId('login-enroll-step')).toBeTruthy();
  });

  it('a dead grant at enroll-start (expired between steps) sends the user back to sign in', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockResolvedValue({
      status: 'enrollment_required',
      grant: 'g-dead',
      user: { id: '9', username: 'jordan' },
    });
    twoFactorEnrollStartMock.mockRejectedValue(
      new ApiError({
        key: 'INVALID_CREDENTIALS',
        code: 40101,
        message: 'This enrollment session is not valid. Sign in again.',
        status: 401,
      }),
    );

    render(<LoginPage />);
    submitPassword();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/not valid/));
    expect(screen.getByLabelText('Password')).toBeTruthy();
    expect(screen.queryByTestId('login-enroll-step')).toBeNull();
  });
});

describe('LoginPage — the classic response under 2FA-aware typing', () => {
  it("a token-pair response takes today's path: loginWithTokens, no steps", async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockResolvedValue(TOKENS);

    render(<LoginPage />);
    submitPassword();

    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(TOKENS));
    expect(twoFactorVerifyMock).not.toHaveBeenCalled();
    expect(twoFactorEnrollStartMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId('login-totp-step')).toBeNull();
    expect(screen.queryByTestId('login-enroll-step')).toBeNull();
  });

  it('bad credentials keep their specific copy (the branch never masks a wrong password)', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(
      new ApiError({ key: 'INVALID_CREDENTIALS', code: 40101, message: 'x', status: 401 }),
    );

    render(<LoginPage />);
    submitPassword();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Wrong username/email or password.'));
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  // 6.4 rename window: the lower_snake credential rejection keeps its copy.
  it('the post-6.4 lower_snake key keeps the wrong-password copy', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    loginRawMock.mockRejectedValue(
      new ApiError({ key: 'invalid_credentials', code: 40101, message: 'x', status: 401 }),
    );

    render(<LoginPage />);
    submitPassword();

    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Wrong username/email or password.'));
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });
});
