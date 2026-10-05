/**
 * LoginPage — the AUTOMATIC passkey (conditional mediation, owner direction
 * 2026-09-15). The passkeys module and the auth session are mocked at their
 * boundaries; the page's OWN contract here is:
 *
 *   (a) when the server offers webauthn AND the browser supports conditional
 *       mediation, ONE background ceremony arms at mount — no dialog, no
 *       extra state; a resolution (the user picked from autofill) enters the
 *       SAME session machinery as the bottom button;
 *   (b) no conditional support → nothing fires at all;
 *   (c) a password submit (or the bottom button) ABORTS the pending
 *       ceremony, and a failed password login never arms the enrollment
 *       prompt flag;
 *   (d) a ceremony failure stands down SILENTLY — password form and the
 *       bottom button carry on untouched;
 *   (e) the username input carries `autocomplete="username webauthn"` —
 *       what makes the browser offer the passkey in autofill.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { PasskeyError } from '../passkeys.js';
import { consumePasswordLoginForPasskeyPrompt } from '../passkeyPrompt.js';

const authMethodsMock = vi.fn();
const conditionalAvailableMock = vi.fn();
const conditionalSignInMock = vi.fn();
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
  conditionalMediationAvailable: (...args: unknown[]) => conditionalAvailableMock(...args),
  conditionalPasskeySignIn: (...args: unknown[]) => conditionalSignInMock(...args),
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
    // #127: the password submit reads POST /auth/login through the
    // branch-aware loginRaw — a passkey flow never touches it.
    loginRaw: (...args: unknown[]) => loginRawMock(...args),
  },
}));

const loginMock = vi.fn();
const loginRawMock = vi.fn();
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
  consumePasswordLoginForPasskeyPrompt(); // drop any flag a test's login set
  // The page remembers the last /auth/methods answer (lane D #4); each case
  // states its own server.
  localStorage.clear();
});

function submitPassword(options: { password?: string } = {}): void {
  fireEvent.change(screen.getByLabelText('Username or email'), { target: { value: 'jordan' } });
  fireEvent.change(screen.getByLabelText('Password'), {
    target: { value: options.password ?? 'pw' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('LoginPage — the automatic passkey (conditional mediation)', () => {
  it('the username input carries autocomplete="username webauthn"', () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });
    render(<LoginPage />);
    expect(screen.getByLabelText('Username or email').getAttribute('autocomplete')).toBe(
      'username webauthn',
    );
  });

  it('conditional available + the user picks from autofill → signs in via loginWithTokens', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(true);
    const tokens = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };
    conditionalSignInMock.mockResolvedValue(tokens);

    render(<LoginPage />);

    await waitFor(() => expect(conditionalSignInMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(tokens));
    // The bottom button is untouched and the password path never ran; and a
    // PASSKEY login never arms the post-login enrollment ask.
    expect(screen.getByTestId('login-passkey-button')).toBeTruthy();
    expect(loginMock).not.toHaveBeenCalled();
    expect(consumePasswordLoginForPasskeyPrompt()).toBe(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('conditional unsupported → nothing fires at all', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(false);

    render(<LoginPage />);

    await waitFor(() => expect(conditionalAvailableMock).toHaveBeenCalled());
    expect(conditionalSignInMock).not.toHaveBeenCalled();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
    // The explicit fallback STAYS.
    expect(screen.getByTestId('login-passkey-button')).toBeTruthy();
  });

  it('the last /auth/methods answer shows the passkey button on the FIRST frame (lane D #4)', async () => {
    // A server answer seen on an earlier visit…
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(false);
    render(<LoginPage />);
    await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
    cleanup();

    // …seeds the next visit before its own read answers (it never does here).
    authMethodsMock.mockImplementation(() => new Promise(() => {}));
    render(<LoginPage />);
    expect(screen.getByTestId('login-passkey-button')).toBeTruthy();
  });

  it('no webauthn surface → the conditional never even probes', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: false });

    render(<LoginPage />);

    await waitFor(() => expect(authMethodsMock).toHaveBeenCalled());
    expect(conditionalAvailableMock).not.toHaveBeenCalled();
    expect(conditionalSignInMock).not.toHaveBeenCalled();
  });

  it('a password submit ABORTS the pending conditional — no late assertion can race it', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(true);
    // A holder object: the assignment happens inside a callback, and TS will
    // not narrow a `let` across it.
    const captured: { signal: AbortSignal | null } = { signal: null };
    conditionalSignInMock.mockImplementation(
      (_api: unknown, signal: AbortSignal) =>
        new Promise<never>((_resolve, _reject) => {
          captured.signal = signal; // pending forever — the user never picked
        }),
    );
    const tokens = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };
    loginRawMock.mockResolvedValue(tokens);

    render(<LoginPage />);
    await waitFor(() => expect(captured.signal).not.toBeNull());

    submitPassword();

    await waitFor(() => expect(loginRawMock).toHaveBeenCalled());
    expect(captured.signal?.aborted).toBe(true);
    // The pair the password step minted enters the SAME session machinery.
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(tokens));
    // A SUCCESSFUL password login arms the post-login passkey ask.
    expect(consumePasswordLoginForPasskeyPrompt()).toBe(true);
  });

  it('a FAILED password login neither signs in via the abort nor arms the ask', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(true);
    conditionalSignInMock.mockImplementation(
      () => new Promise<never>(() => {}), // stays pending until the abort
    );
    loginRawMock.mockRejectedValue(
      new (class extends Error {
        key = 'INVALID_CREDENTIALS';
      })('nope'),
    );

    render(<LoginPage />);
    await waitFor(() => expect(conditionalSignInMock).toHaveBeenCalled());

    submitPassword();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());

    expect(loginWithTokensMock).not.toHaveBeenCalled();
    expect(consumePasswordLoginForPasskeyPrompt()).toBe(false);
  });

  it('a ceremony failure stands down SILENTLY — once, no re-arm, no alert', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(true);
    conditionalSignInMock.mockRejectedValue(new PasskeyError('cancelled', 'cancelled.'));

    render(<LoginPage />);

    await waitFor(() => expect(conditionalSignInMock).toHaveBeenCalledTimes(1));
    // Give any (wrong) re-arm a beat, then hold the line: one arm per page life.
    await new Promise((r) => setTimeout(r, 25));
    expect(conditionalSignInMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loginWithTokensMock).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('pressing the bottom button aborts the pending automatic ceremony first', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    conditionalAvailableMock.mockResolvedValue(true);
    const signals: AbortSignal[] = [];
    conditionalSignInMock.mockImplementation((_api: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise<never>(() => {});
    });
    const tokens = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };
    authenticateWithPasskeyMock.mockResolvedValue(tokens);

    render(<LoginPage />);
    await waitFor(() => expect(signals.length).toBe(1));

    fireEvent.click(screen.getByTestId('login-passkey-button'));

    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(tokens));
    expect(signals[0]?.aborted).toBe(true);
  });
});
