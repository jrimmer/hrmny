/**
 * LoginPage × the REAL passkeys module — every passkey failure class ends in a
 * specific, visible, announced message (owner report 2026-10-02: "I confirm
 * on my phone and send it, then it drops me at the login… as a user I don't
 * know what's wrong").
 *
 * Unlike LoginPage.passkey/conditional tests (which mock passkeys.ts whole),
 * only the true boundaries are faked here: @simplewebauthn/browser's prompt,
 * navigator.credentials, and the api. So the server-key → message map, the
 * DOM-error → message map, the alert's live region and the focus move are
 * all exercised exactly as they ship.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { ApiError } from '@cytale/api-client';

import { PASSKEY_ERROR_COPY } from '../passkeys.js';

const startAuthentication = vi.fn();

vi.mock('@simplewebauthn/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/browser')>();
  return { ...actual, startAuthentication: (...args: unknown[]) => startAuthentication(...args) };
});

const authMethodsMock = vi.fn();
const loginOptionsMock = vi.fn();
const loginVerifyMock = vi.fn();

vi.mock('../session.js', () => ({
  session: { setServerOrigin: vi.fn() },
  SERVER_ORIGIN_KEY: 'cytale.server_origin',
  DEFAULT_SERVER_ORIGIN: 'https://hrmny.example.com',
  ServerOriginError: class ServerOriginError extends Error {},
  validateServerOrigin: (raw: string | unknown) => new URL(String(raw).trim()).origin,
  api: {
    getAuthMethods: (...args: unknown[]) => authMethodsMock(...args),
    webauthnLoginOptions: (...args: unknown[]) => loginOptionsMock(...args),
    webauthnLoginVerify: (...args: unknown[]) => loginVerifyMock(...args),
  },
}));

const loginWithTokensMock = vi.fn();

vi.mock('../useAuth.js', () => ({
  useAuth: () => ({ login: vi.fn(), loginWithTokens: loginWithTokensMock }),
}));

import { LoginPage } from '../LoginPage.js';

const tokens = { access_token: 'a', refresh_token: 'r', token_type: 'Bearer', expires_in: 900 };
let credentialsGet: ReturnType<typeof vi.fn>;

function options(timeout = 300_000) {
  return { challenge_id: 'cid', public_key: { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', timeout } };
}

/** A secure context with WebAuthn; `conditional` turns on the autofill probe. */
function stubSupported(conditional = false): void {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  const Fake = function Fake(): void {};
  (Fake as unknown as { isConditionalMediationAvailable: () => Promise<boolean> }).isConditionalMediationAvailable =
    () => Promise.resolve(conditional);
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = Fake;
  credentialsGet = vi.fn();
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get: credentialsGet },
    configurable: true,
  });
}

function fakeAssertion(): PublicKeyCredential {
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  return {
    id: 'cmF3',
    rawId: enc('raw'),
    type: 'public-key',
    authenticatorAttachment: 'cross-platform',
    getClientExtensionResults: () => ({}),
    response: {
      authenticatorData: enc('ad'),
      clientDataJSON: enc('cd'),
      signature: enc('sig'),
      userHandle: null,
    },
  } as unknown as PublicKeyCredential;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
  localStorage.clear();
  delete (window as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
});

async function clickPasskeyButton(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('login-passkey-button')).toBeTruthy());
  fireEvent.click(screen.getByTestId('login-passkey-button'));
}

/** The one visible, announced, focused message. */
async function expectAnnounced(message: string): Promise<HTMLElement> {
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(message);
  expect(alert.getAttribute('aria-live')).toBe('assertive');
  await waitFor(() => expect(document.activeElement).toBe(alert));
  return alert;
}

describe('LoginPage — the passkey button says what went wrong, every time', () => {
  const verifyRefusals: Array<[string, number, keyof typeof PASSKEY_ERROR_COPY]> = [
    ['invalid_credentials', 401, 'not-recognized'],
    ['challenge_invalid', 400, 'expired'],
    ['ceremony_failed', 400, 'wrong-address'],
    ['network_error', 0, 'network'],
  ];

  it.each(verifyRefusals)('a %s (%i) refusal after the prompt shows the %s message', async (key, status, kind) => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported();
    loginOptionsMock.mockResolvedValue(options());
    startAuthentication.mockResolvedValue({ id: 'abc', rawId: 'abc', response: {} });
    loginVerifyMock.mockRejectedValue(new ApiError({ key, code: status * 100 + 1, message: 'server copy', status }));

    render(<LoginPage />);
    await clickPasskeyButton();

    await expectAnnounced(PASSKEY_ERROR_COPY[kind]);
    expect(loginWithTokensMock).not.toHaveBeenCalled();
    // The form is still there to fall back on.
    expect(screen.getByLabelText('Password')).toBeTruthy();
  });

  it('the not-registered message keeps the anti-enumeration line but still says what to do', async () => {
    expect(PASSKEY_ERROR_COPY['not-recognized']).toBe(
      "That passkey couldn't sign you in. It may not be registered on this server. Sign in with your password, then add the passkey again in Settings → My Account → Passkeys.",
    );
  });

  it('cancelling the browser prompt (NotAllowedError) shows the cancel message — not a server refusal', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported();
    loginOptionsMock.mockResolvedValue(options());
    startAuthentication.mockRejectedValue(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));

    render(<LoginPage />);
    await clickPasskeyButton();

    await expectAnnounced(PASSKEY_ERROR_COPY.cancelled);
    expect(loginVerifyMock).not.toHaveBeenCalled();
  });

  it('the browser refusing the server RP ID (SecurityError) names the address, not the browser', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported();
    loginOptionsMock.mockResolvedValue(options());
    startAuthentication.mockRejectedValue(new DOMException('The RP ID is invalid for this domain', 'SecurityError'));

    render(<LoginPage />);
    await clickPasskeyButton();

    await expectAnnounced(PASSKEY_ERROR_COPY['wrong-address']);
  });

  it('a browser without passkeys says so', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });

    render(<LoginPage />);
    await clickPasskeyButton();

    await expectAnnounced(PASSKEY_ERROR_COPY.unsupported);
    expect(loginOptionsMock).not.toHaveBeenCalled();
  });

  it('a retry clears the old message and a success shows none', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported();
    loginOptionsMock.mockResolvedValue(options());
    startAuthentication.mockResolvedValue({ id: 'abc', rawId: 'abc', response: {} });
    loginVerifyMock
      .mockRejectedValueOnce(new ApiError({ key: 'challenge_invalid', code: 40001, message: 'x', status: 400 }))
      .mockResolvedValueOnce(tokens);

    render(<LoginPage />);
    await clickPasskeyButton();
    await expectAnnounced(PASSKEY_ERROR_COPY.expired);

    fireEvent.click(screen.getByTestId('login-passkey-button'));
    await waitFor(() => expect(loginWithTokensMock).toHaveBeenCalledWith(tokens));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('LoginPage — the automatic (autofill) passkey never fails silently', () => {
  it('a refusal after the user picked and confirmed a passkey is shown, and the offer re-arms', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported(true);
    loginOptionsMock.mockResolvedValue(options());
    credentialsGet.mockResolvedValueOnce(fakeAssertion()).mockImplementation(() => new Promise(() => {}));
    loginVerifyMock.mockRejectedValue(new ApiError({ key: 'invalid_credentials', code: 40101, message: 'x', status: 401 }));

    render(<LoginPage />);

    await expectAnnounced(PASSKEY_ERROR_COPY['not-recognized']);
    // Re-armed with a fresh challenge so the user can pick again.
    await waitFor(() => expect(loginOptionsMock).toHaveBeenCalledTimes(2));
    expect(loginWithTokensMock).not.toHaveBeenCalled();
  });

  it('re-arms with a FRESH challenge before the old one expires — silently', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported(true);
    // A 2-minute challenge re-arms one margin (60 s) early.
    loginOptionsMock.mockResolvedValue(options(120_000));
    const signals: AbortSignal[] = [];
    credentialsGet.mockImplementation(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signals.push(signal);
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );

    render(<LoginPage />);
    await waitFor(() => expect(signals.length).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_000);
    });
    expect(loginOptionsMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(signals.length).toBe(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(loginOptionsMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('nothing is said before the user picks a passkey (no support, a dismissed autofill)', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported(true);
    loginOptionsMock.mockResolvedValue(options());
    credentialsGet.mockRejectedValue(new DOMException('dismissed', 'NotAllowedError'));

    render(<LoginPage />);

    await waitFor(() => expect(credentialsGet).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(loginVerifyMock).not.toHaveBeenCalled();
  });

  it('a session failure after the passkey was accepted is shown too', async () => {
    authMethodsMock.mockResolvedValue({ password: true, webauthn: true });
    stubSupported(true);
    loginOptionsMock.mockResolvedValue(options());
    credentialsGet.mockResolvedValueOnce(fakeAssertion());
    loginVerifyMock.mockResolvedValue(tokens);
    loginWithTokensMock.mockRejectedValue(
      new ApiError({ key: 'network_error', code: 0, message: 'Could not reach the server.', status: 0 }),
    );

    render(<LoginPage />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Could not reach the server.');
  });
});
