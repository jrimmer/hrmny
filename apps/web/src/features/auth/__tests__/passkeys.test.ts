/**
 * passkeys.ts — the browser ceremony glue, against a MOCKED
 * @simplewebauthn/browser boundary (the ticket's web-unit posture) and an
 * injected fake api. jsdom has no WebAuthn, so the "unsupported" branch is
 * the REAL environment answer; supported-context tests stub the probe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';

import type { PasskeyApi } from '../passkeys.js';
import { PasskeyError, authenticateWithPasskey, enrollPasskey, passkeySupport } from '../passkeys.js';

const startAuthentication = vi.fn();
const startRegistration = vi.fn();

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: (...args: unknown[]) => startAuthentication(...args),
  startRegistration: (...args: unknown[]) => startRegistration(...args),
}));

afterEach(() => {
  vi.resetAllMocks();
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    getAuthMethods: vi.fn().mockResolvedValue({ password: true, webauthn: true }),
    webauthnLoginOptions: vi
      .fn()
      .mockResolvedValue({ challenge_id: 'cid-1', public_key: { challenge: 'c2VydmVy', rpId: 'localhost' } }),
    webauthnLoginVerify: vi.fn().mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 900 }),
    webauthnRegisterOptions: vi.fn().mockResolvedValue({ challenge_id: 'cid-2', public_key: { challenge: 'cw' } }),
    webauthnRegisterVerify: vi
      .fn()
      .mockResolvedValue({ credential: { id: 'cred-1', name: 'Test', created_at: 'x', last_used_at: null } }),
    listWebauthnCredentials: vi.fn().mockResolvedValue({ credentials: [] }),
    deleteWebauthnCredential: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PasskeyApi;
}

function stubSupported(): void {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = function Fake(): void {};
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get: vi.fn() },
    configurable: true,
  });
}

describe('passkeySupport', () => {
  it('jsdom (no WebAuthn, insecure context) is unsupported — the honest default', () => {
    expect(passkeySupport()).toBe(false);
  });
});

describe('authenticateWithPasskey', () => {
  it('unsupported context refuses before any network call', async () => {
    const api = fakeApi();
    await expect(authenticateWithPasskey(api)).rejects.toMatchObject({ kind: 'unsupported' });
    expect(api.webauthnLoginOptions).not.toHaveBeenCalled();
  });

  it('happy path: options → browser get → verify, and the SAME tokens return', async () => {
    stubSupported();
    const api = fakeApi();
    const assertion = { id: 'abc', response: { authenticatorData: 'ad', signature: 'sg', clientDataJSON: 'cd' } };
    startAuthentication.mockResolvedValue(assertion);

    const tokens = await authenticateWithPasskey(api);

    expect(api.webauthnLoginOptions).toHaveBeenCalledTimes(1);
    expect(startAuthentication).toHaveBeenCalledWith({
      optionsJSON: { challenge: 'c2VydmVy', rpId: 'localhost' },
    });
    expect(api.webauthnLoginVerify).toHaveBeenCalledWith({
      challenge_id: 'cid-1',
      response: assertion,
    });
    expect((tokens as { access_token: string }).access_token).toBe('a');
  });

  it('a cancelled prompt (NotAllowedError) is a visible cancelled PasskeyError', async () => {
    stubSupported();
    const api = fakeApi();
    startAuthentication.mockRejectedValue(new DOMException('user cancelled', 'NotAllowedError'));

    await expect(authenticateWithPasskey(api)).rejects.toMatchObject({ kind: 'cancelled' });
    expect(api.webauthnLoginVerify).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid_credentials', 401, 'not-recognized', /may not be registered on this server.*Settings → My Account → Passkeys/],
    ['INVALID_CREDENTIALS', 401, 'not-recognized', /Sign in with your password/],
    ['challenge_invalid', 400, 'expired', /expired.*Try again/],
    ['ceremony_failed', 400, 'wrong-address', /address/],
    ['network_error', 0, 'network', /Couldn't reach the server/],
  ])('a verify refusal keyed %s (%i) is a %s PasskeyError with actionable copy', async (key, status, kind, copy) => {
    stubSupported();
    const api = fakeApi({
      webauthnLoginVerify: vi
        .fn()
        .mockRejectedValue(new ApiError({ key, code: status * 100 + 1, message: 'server copy', status })),
    });
    startAuthentication.mockResolvedValue({ id: 'abc', response: {} });

    const err = await authenticateWithPasskey(api).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PasskeyError);
    expect(err).toMatchObject({ kind, stage: 'verify' });
    expect((err as PasskeyError).message).toMatch(copy);
  });

  it('any other server refusal keeps the server copy (kind server)', async () => {
    stubSupported();
    const api = fakeApi({
      webauthnLoginVerify: vi
        .fn()
        .mockRejectedValue(new ApiError({ key: 'rate_limited', code: 42901, message: 'Slow down.', status: 429 })),
    });
    startAuthentication.mockResolvedValue({ id: 'abc', response: {} });

    await expect(authenticateWithPasskey(api)).rejects.toMatchObject({ kind: 'server', message: 'Slow down.' });
  });

  it('the browser refusing the RP ID (SecurityError in a secure context) is wrong-address, not "unsupported"', async () => {
    stubSupported();
    const api = fakeApi();
    startAuthentication.mockRejectedValue(new DOMException('rp id mismatch', 'SecurityError'));

    await expect(authenticateWithPasskey(api)).rejects.toMatchObject({ kind: 'wrong-address', stage: 'prompt' });
    expect(api.webauthnLoginVerify).not.toHaveBeenCalled();
  });

  it('a cancel carries the prompt stage — distinct from every server refusal', async () => {
    stubSupported();
    const api = fakeApi();
    startAuthentication.mockRejectedValue(new DOMException('user cancelled', 'NotAllowedError'));

    const err = (await authenticateWithPasskey(api).catch((e: unknown) => e)) as PasskeyError;
    expect(err.kind).toBe('cancelled');
    expect(err.stage).toBe('prompt');
    expect(err.message).toMatch(/cancelled/);
  });

  it('options endpoint refusing a DISABLED surface is a server PasskeyError', async () => {
    stubSupported();
    const api = fakeApi({
      webauthnLoginOptions: vi
        .fn()
        .mockRejectedValue(new ApiError({ key: 'passkeys_disabled', code: 40301, message: 'disabled', status: 403 })),
    });

    await expect(authenticateWithPasskey(api)).rejects.toMatchObject({ kind: 'server', stage: 'options' });
    expect(startAuthentication).not.toHaveBeenCalled();
  });
});

describe('enrollPasskey', () => {
  it('happy path: register options → browser create → verify with name', async () => {
    stubSupported();
    const api = fakeApi();
    const attestation = { id: 'xyz', response: { attestationObject: 'ao', clientDataJSON: 'cd' } };
    startRegistration.mockResolvedValue(attestation);

    const credential = await enrollPasskey(api, 'MacBook Touch ID');

    expect(api.webauthnRegisterVerify).toHaveBeenCalledWith({
      challenge_id: 'cid-2',
      name: 'MacBook Touch ID',
      response: attestation,
    });
    expect((credential as { id: string }).id).toBe('cred-1');
  });

  it('an already-registered authenticator (InvalidStateError) is invalid-state, visible', async () => {
    stubSupported();
    const api = fakeApi();
    startRegistration.mockRejectedValue(new DOMException('excluded', 'InvalidStateError'));

    await expect(enrollPasskey(api, 'dupe')).rejects.toMatchObject({ kind: 'invalid-state' });
  });
});

describe('PasskeyError copy', () => {
  it('kinds carry their user-visible copy', () => {
    expect(new PasskeyError('unsupported').message).toBe(
      "This device or browser doesn't support passkeys. Sign in with your password instead.",
    );
    expect(new PasskeyError('cancelled').message).toMatch(/cancelled/i);
    expect(new PasskeyError('invalid-state').message).toMatch(/already/);
    expect(new PasskeyError('expired').message).toMatch(/expired/);
    expect(new PasskeyError('wrong-address').message).toMatch(/address/);
    expect(new PasskeyError('not-recognized').message).toMatch(/Settings → My Account → Passkeys/);
    expect(new PasskeyError('unknown').message).toBe("The passkey couldn't be verified. Try again.");
  });
});
