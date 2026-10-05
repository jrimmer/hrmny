/**
 * passkeys.ts — the CONDITIONAL mediation half (owner direction 2026-09-15,
 * "could the client check if there is a passkey and if so use it? As in be
 * automatic?"): the availability probe and the background ceremony, against
 * a MOCKED @simplewebauthn/browser boundary — with the real base64url
 * helpers kept, since the hand-rolled assertion serialization rides them —
 * and an injected fake api.
 *
 * jsdom has no WebAuthn, so the "unsupported" branch is the REAL environment
 * answer; supported-context tests stub the probe (the passkeys.test.ts
 * pattern).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@cytale/api-client';

import type { PasskeyApi } from '../passkeys.js';
import {
  PasskeyError,
  conditionalMediationAvailable,
  conditionalPasskeySignIn,
} from '../passkeys.js';

const startAuthentication = vi.fn();
/** The navigator.credentials.get stub — captured here for assertions. */
let credentialsGet: ReturnType<typeof vi.fn>;

vi.mock('@simplewebauthn/browser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/browser')>();
  return {
    ...actual,
    startAuthentication: (...args: unknown[]) => startAuthentication(...args),
  };
});

afterEach(() => {
  vi.resetAllMocks();
});

function fakeApi(overrides: Record<string, unknown> = {}) {
  return {
    getAuthMethods: vi.fn().mockResolvedValue({ password: true, webauthn: true }),
    webauthnLoginOptions: vi
      .fn()
      .mockResolvedValue({ challenge_id: 'cid-1', public_key: { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost' } }),
    webauthnLoginVerify: vi.fn().mockResolvedValue({ access_token: 'a', refresh_token: 'r', expires_in: 900 }),
    ...overrides,
  } as unknown as PasskeyApi;
}

/** Local base64url (no padding) — what bufferToBase64URLString produces. */
function b64u(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function stubSupported(): void {
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  const FakePublicKeyCredential = function Fake(): void {};
  (
    FakePublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }
  ).isConditionalMediationAvailable = vi.fn().mockResolvedValue(true);
  (window as { PublicKeyCredential?: unknown }).PublicKeyCredential = FakePublicKeyCredential;
  credentialsGet = vi.fn();
  Object.defineProperty(navigator, 'credentials', {
    value: { create: vi.fn(), get: credentialsGet },
    configurable: true,
  });
}

/** The probe member, typed loosely for stubbing (the real type is TS-lib strict). */
function probeHolder(): { isConditionalMediationAvailable?: unknown } {
  return (window as unknown as { PublicKeyCredential: { isConditionalMediationAvailable?: unknown } })
    .PublicKeyCredential;
}

function stubConditionalProbe(value: boolean | (() => Promise<boolean>)): void {
  probeHolder().isConditionalMediationAvailable =
    typeof value === 'function' ? value : vi.fn().mockResolvedValue(value);
}

/** A live-shape credential (ArrayBuffers + getClientExtensionResults). */
function fakeAssertion(): PublicKeyCredential {
  const enc = (s: string) => new TextEncoder().encode(s).buffer as ArrayBuffer;
  return {
    id: b64u('raw-id-1'),
    rawId: enc('raw-id-1'),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      authenticatorData: enc('authdata'),
      clientDataJSON: enc('clientdata'),
      signature: enc('sig'),
      userHandle: enc('user-1'),
    },
  } as unknown as PublicKeyCredential;
}

describe('conditionalMediationAvailable', () => {
  it('jsdom (no WebAuthn at all) answers NO — the honest default', async () => {
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it('a browser with PublicKeyCredential but without the probe answers NO (never throws)', async () => {
    stubSupported();
    delete probeHolder().isConditionalMediationAvailable;
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it('the probe saying yes / no is the answer', async () => {
    stubSupported();
    stubConditionalProbe(true);
    await expect(conditionalMediationAvailable()).resolves.toBe(true);
    stubConditionalProbe(false);
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });

  it('a THROWING probe answers NO (feature detection must never break the page)', async () => {
    stubSupported();
    stubConditionalProbe(() => Promise.reject(new TypeError('boom')));
    await expect(conditionalMediationAvailable()).resolves.toBe(false);
  });
});

describe('conditionalPasskeySignIn', () => {
  it('happy path: options → conditional get (mediation + caller signal + empty allow list) → verify → tokens', async () => {
    stubSupported();
    const api = fakeApi();
    const assertion = fakeAssertion();
    credentialsGet.mockResolvedValue(assertion);
    const controller = new AbortController();

    const tokens = await conditionalPasskeySignIn(api, controller.signal);

    expect(tokens).toMatchObject({ access_token: 'a' });
    expect(api.webauthnLoginOptions).toHaveBeenCalledTimes(1);

    const getArgs = credentialsGet.mock.calls[0]?.[0] as
      | {
          mediation: string;
          signal: AbortSignal;
          publicKey: { challenge: ArrayBuffer; allowCredentials: unknown[] };
        }
      | undefined;
    if (!getArgs) throw new Error('navigator.credentials.get was not called');
    expect(getArgs.mediation).toBe('conditional');
    expect(getArgs.signal).toBe(controller.signal);
    // The server's challenge arrives decoded; conditional UI forces the empty
    // allow list — what autofill offers is the browser's decision.
    expect(new TextDecoder().decode(getArgs.publicKey.challenge)).toBe('challenge');
    expect(getArgs.publicKey.allowCredentials).toEqual([]);

    expect(api.webauthnLoginVerify).toHaveBeenCalledWith({
      challenge_id: 'cid-1',
      response: expect.objectContaining({
        id: b64u('raw-id-1'),
        rawId: b64u('raw-id-1'),
        type: 'public-key',
        response: {
          authenticatorData: b64u('authdata'),
          clientDataJSON: b64u('clientdata'),
          signature: b64u('sig'),
          userHandle: b64u('user-1'),
        },
      }),
    });
  });

  it('an ALREADY-aborted signal refuses before any network call', async () => {
    stubSupported();
    const api = fakeApi();
    const controller = new AbortController();
    controller.abort();

    await expect(conditionalPasskeySignIn(api, controller.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(api.webauthnLoginOptions).not.toHaveBeenCalled();
    expect(credentialsGet).not.toHaveBeenCalled();
  });

  it('an abort that lands while options are in flight still blocks the ceremony', async () => {
    stubSupported();
    const controller = new AbortController();
    const api = fakeApi({
      webauthnLoginOptions: vi.fn().mockImplementation(async () => {
        controller.abort(); // the password submit beat the options response
        return { challenge_id: 'cid-1', public_key: { challenge: 'Y2hhbGxlbmdl' } };
      }),
    });

    await expect(conditionalPasskeySignIn(api, controller.signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    expect(credentialsGet).not.toHaveBeenCalled();
    expect(api.webauthnLoginVerify).not.toHaveBeenCalled();
  });

  it('the browser cancelling the ceremony (AbortError) classifies as cancelled', async () => {
    stubSupported();
    const api = fakeApi();
    credentialsGet.mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    await expect(conditionalPasskeySignIn(api, new AbortController().signal)).rejects.toMatchObject({
      kind: 'cancelled',
    });
    // A cancelled ceremony never reaches the verify endpoint.
    expect(api.webauthnLoginVerify).not.toHaveBeenCalled();
  });

  it('a refused options read is a server-kind error (ApiError passthrough)', async () => {
    stubSupported();
    const api = fakeApi({
      webauthnLoginOptions: vi.fn().mockRejectedValue(
        new ApiError({ key: 'passkeys_disabled', code: 40301, message: 'disabled', status: 403 }),
      ),
    });

    await expect(conditionalPasskeySignIn(api, new AbortController().signal)).rejects.toMatchObject({
      kind: 'server',
    });
  });

  it('reports the challenge lifetime once armed, so the caller can re-arm before it lapses', async () => {
    stubSupported();
    const api = fakeApi({
      webauthnLoginOptions: vi.fn().mockResolvedValue({
        challenge_id: 'cid-1',
        public_key: { challenge: 'Y2hhbGxlbmdl', rpId: 'localhost', timeout: 300_000 },
      }),
    });
    credentialsGet.mockResolvedValue(fakeAssertion());
    const onArmed = vi.fn();

    await conditionalPasskeySignIn(api, new AbortController().signal, onArmed);

    expect(onArmed).toHaveBeenCalledWith(300_000);
  });

  it('a refusal AFTER the user picked a passkey is a verify-stage error with its own kind', async () => {
    // The owner's report: the passkey was confirmed on a phone, the server
    // refused it, and nothing was said. The verify stage is what tells the
    // page it must speak.
    stubSupported();
    const api = fakeApi({
      webauthnLoginVerify: vi.fn().mockRejectedValue(
        new ApiError({ key: 'challenge_invalid', code: 40001, message: 'expired', status: 400 }),
      ),
    });
    credentialsGet.mockResolvedValue(fakeAssertion());

    await expect(conditionalPasskeySignIn(api, new AbortController().signal)).rejects.toMatchObject({
      kind: 'expired',
      stage: 'verify',
    });
  });

  it('failures before the user picked anything carry the options/prompt stage (the page stays silent)', async () => {
    stubSupported();
    credentialsGet.mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    await expect(conditionalPasskeySignIn(fakeApi(), new AbortController().signal)).rejects.toMatchObject({
      stage: 'prompt',
    });

    const refusing = fakeApi({
      webauthnLoginOptions: vi
        .fn()
        .mockRejectedValue(new ApiError({ key: 'passkeys_disabled', code: 40301, message: 'disabled', status: 403 })),
    });
    await expect(conditionalPasskeySignIn(refusing, new AbortController().signal)).rejects.toMatchObject({
      stage: 'options',
    });
  });

  it('a null credential (should not happen) is not a crash', async () => {
    stubSupported();
    const api = fakeApi();
    credentialsGet.mockResolvedValue(null);

    await expect(conditionalPasskeySignIn(api, new AbortController().signal)).rejects.toBeInstanceOf(
      PasskeyError,
    );
    expect(api.webauthnLoginVerify).not.toHaveBeenCalled();
  });
});
