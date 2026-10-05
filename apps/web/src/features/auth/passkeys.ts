/**
 * #36 — the WEB half of the WebAuthn ceremonies (the browser owns
 * `navigator.credentials`; the server owns verification; this module is the
 * glue). The crypto never passes through here: @simplewebauthn/browser
 * serializes the browser's credential objects into the JSON shapes the
 * server's wax_ library verifies.
 *
 * Every failure surfaces as a `PasskeyError` carrying a UI-actionable
 * `kind` — never a silent no-op — and a message that says what to DO:
 *
 *   unsupported      — no WebAuthn API or an insecure context (the deploy is
 *                      HTTPS, so this means non-localhost http, a WebView
 *                      without WebAuthn, or an aged browser)
 *   cancelled        — the user dismissed the prompt, or it timed out, or no
 *                      authenticator answered (NotAllowedError / AbortError —
 *                      the browser deliberately does not say which)
 *   invalid-state    — a credential for this account is already on this
 *                      authenticator (registration only)
 *   wrong-address    — the ceremony does not belong to the address the page
 *                      is open at: the browser refused the server's RP ID
 *                      (SecurityError in a secure context), or the server
 *                      refused the response's origin/RP ID (`ceremony_failed`)
 *   expired          — the server's challenge expired or was already spent
 *                      (`challenge_invalid`) — try again
 *   not-recognized   — the server's uniform credential refusal
 *                      (`invalid_credentials`): unknown credential, bad
 *                      signature, removed passkey… indistinguishable by design
 *                      (no account oracle), so the copy covers them all and
 *                      points at re-enrolment
 *   network          — the server could not be reached
 *   server           — any other server refusal (ApiError passthrough:
 *                      disabled surface, rate limit…), with the server's copy
 *   unknown          — anything else
 */

import {
  base64URLStringToBuffer,
  bufferToBase64URLString,
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';

import type { AuthTokens, WebauthnCredential, WebauthnOptions } from '@cytale/api-client';
import { ApiError } from '@cytale/api-client';

/** The narrow server-facing surface this module needs (injection keeps the DOM and the api client out of the unit tests). */
export interface PasskeyApi {
  getAuthMethods(): Promise<{ password: boolean; webauthn: boolean }>;
  webauthnLoginOptions(): Promise<WebauthnOptions>;
  webauthnLoginVerify(body: { challenge_id: string; response: Record<string, unknown> }): Promise<AuthTokens>;
  webauthnRegisterOptions(): Promise<WebauthnOptions>;
  webauthnRegisterVerify(body: {
    challenge_id: string;
    name?: string;
    response: Record<string, unknown>;
  }): Promise<{ credential: WebauthnCredential }>;
  listWebauthnCredentials(): Promise<{ credentials: WebauthnCredential[] }>;
  deleteWebauthnCredential(credentialId: string): Promise<void>;
}

export type PasskeyErrorKind =
  | 'unsupported'
  | 'cancelled'
  | 'invalid-state'
  | 'wrong-address'
  | 'expired'
  | 'not-recognized'
  | 'network'
  | 'server'
  | 'unknown';

/** The user-visible copy per kind (login and settings share it). `server` carries the server's own message. */
export const PASSKEY_ERROR_COPY: Record<Exclude<PasskeyErrorKind, 'server'>, string> = {
  unsupported: "This device or browser doesn't support passkeys. Sign in with your password instead.",
  cancelled: 'Passkey sign-in was cancelled or timed out. Try again, or sign in with your password.',
  'invalid-state': 'A passkey for this account is already on this device.',
  'wrong-address':
    "The passkey couldn't be verified for this address. Open Hrmny at its usual address and try again.",
  expired: 'The passkey request expired before it finished. Try again.',
  'not-recognized':
    "That passkey couldn't sign you in. It may not be registered on this server. Sign in with your password, then add the passkey again in Settings → My Account → Passkeys.",
  network: "Couldn't reach the server to finish the passkey sign-in. Check your connection and try again.",
  unknown: "The passkey couldn't be verified. Try again.",
};

/**
 * Where in the sign-in a failure happened: fetching the server's options, the
 * browser prompt, or the server verifying a response the user already
 * produced. The automatic (conditional) path stays silent before `verify`
 * — nobody asked it for anything yet — and must speak from `verify` on.
 */
export type PasskeyErrorStage = 'options' | 'prompt' | 'verify';

export class PasskeyError extends Error {
  readonly kind: PasskeyErrorKind;
  /** The underlying error when one exists (ApiError detail, DOM error). */
  readonly underlying?: unknown;
  /** Set where the ceremony knows it (see `PasskeyErrorStage`). */
  stage?: PasskeyErrorStage;

  constructor(kind: PasskeyErrorKind, message?: string, underlying?: unknown) {
    super(message ?? (kind === 'server' ? 'Passkey operation failed.' : PASSKEY_ERROR_COPY[kind]));
    this.name = 'PasskeyError';
    this.kind = kind;
    this.underlying = underlying;
  }
}

/** The user-visible copy for ANY passkey-path failure (login + settings share it). */
export function describePasskeyError(err: unknown): string {
  if (err instanceof PasskeyError) return err.message;
  if (err instanceof ApiError) return err.message;
  return err instanceof Error && err.message ? err.message : 'Passkey operation failed.';
}

/** Whether this context can run a WebAuthn ceremony AT ALL (cheap sync probe). */
export function passkeySupport(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext === true &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials?.create === 'function' &&
    typeof navigator.credentials?.get === 'function' &&
    typeof window.PublicKeyCredential === 'function'
  );
}

/** Discoverable sign-in: empty allowCredentials — the browser's picker chooses the identity. */
export async function authenticateWithPasskey(api: PasskeyApi): Promise<AuthTokens> {
  if (!passkeySupport()) throw new PasskeyError('unsupported');

  let options: WebauthnOptions;
  try {
    options = await api.webauthnLoginOptions();
  } catch (err) {
    throw staged(toServerPasskeyError(err), 'options');
  }

  let assertion: Awaited<ReturnType<typeof startAuthentication>>;
  try {
    assertion = await startAuthentication({
      optionsJSON: options.public_key as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
    });
  } catch (err) {
    throw staged(classifyCeremonyError(err), 'prompt');
  }

  try {
    return await api.webauthnLoginVerify({
      challenge_id: options.challenge_id,
      response: assertion as unknown as Record<string, unknown>,
    });
  } catch (err) {
    throw staged(toServerPasskeyError(err), 'verify');
  }
}

/**
 * Whether this browser can run a CONDITIONAL mediation ceremony — the
 * automatic sign-in where the passkey rides the username field's autofill
 * dropdown instead of a button-prompted dialog. Feature-detected per the
 * spec (`PublicKeyCredential.isConditionalMediationAvailable`), which some
 * engines lack outright; every absence answers "no", never throws.
 */
export async function conditionalMediationAvailable(): Promise<boolean> {
  if (!passkeySupport()) return false;
  try {
    // The static exists only on newer engines; `passkeySupport` proved the
    // constructor but not this member, so the guard is runtime-real.
    const probe = window.PublicKeyCredential.isConditionalMediationAvailable;
    if (typeof probe !== 'function') return false;
    return (await probe.call(window.PublicKeyCredential)) === true;
  } catch {
    return false;
  }
}

/**
 * The AUTOMATIC sign-in half of conditional mediation (owner direction
 * 2026-09-15: "Is a passkey button always necessary? Could the client check
 * if there is one and if so, use it? As in be automatic?").
 *
 * Runs `navigator.credentials.get({ mediation: 'conditional' })` in the
 * background: the browser offers the passkey inside the username field's
 * autofill dropdown, and the promise RESOLVES only when the user picks one
 * there. It never shows a dialog of its own, and the caller owns the
 * AbortController — a password submit aborts the signal, which rejects the
 * pending ceremony before it could race the password login.
 *
 * Serialization is hand-rolled (the @simplewebauthn/browser helpers do the
 * base64url) because startAuthentication's own conditional support brings an
 * abort service we cannot wire to the caller's controller.
 */
export async function conditionalPasskeySignIn(
  api: PasskeyApi,
  signal: AbortSignal,
  /** Called once the server's challenge is in hand, with its lifetime in ms — the caller re-arms before it lapses. */
  onArmed?: (challengeTimeoutMs: number) => void,
): Promise<AuthTokens> {
  if (!passkeySupport()) throw new PasskeyError('unsupported');
  throwIfAborted(signal);

  let options: WebauthnOptions;
  try {
    options = await api.webauthnLoginOptions();
  } catch (err) {
    throw staged(toServerPasskeyError(err), 'options');
  }
  throwIfAborted(signal);
  const timeout = (options.public_key as { timeout?: unknown }).timeout;
  onArmed?.(typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_CHALLENGE_TIMEOUT_MS);

  // Conditional UI requires an empty allow list — which credential (if any)
  // to offer is the browser's autofill decision, not the server's.
  const pk = options.public_key;
  const publicKey: PublicKeyCredentialRequestOptions = {
    ...pk,
    challenge: base64URLStringToBuffer(typeof pk.challenge === 'string' ? pk.challenge : ''),
    allowCredentials: [],
  } as PublicKeyCredentialRequestOptions;

  let credential: PublicKeyCredential | null;
  try {
    // A publicKey request resolves to a PublicKeyCredential — the DOM type
    // only narrows to the base Credential.
    credential = (await navigator.credentials.get({
      mediation: 'conditional',
      publicKey,
      signal,
    })) as PublicKeyCredential | null;
  } catch (err) {
    // An aborted signal (the user submitted the password instead) lands here
    // as AbortError and classifies as 'cancelled' — the caller stands down.
    throw staged(classifyCeremonyError(err), 'prompt');
  }
  if (!credential) throw staged(new PasskeyError('cancelled'), 'prompt');

  try {
    return await api.webauthnLoginVerify({
      challenge_id: options.challenge_id,
      response: assertionToJson(credential),
    });
  } catch (err) {
    // From here the user HAS picked and confirmed a passkey: the caller must
    // say why it did not sign them in.
    throw staged(toServerPasskeyError(err), 'verify');
  }
}

/** Enrollment: registers the authenticator against the SIGNED-IN account, under a display name. */
export async function enrollPasskey(api: PasskeyApi, name: string): Promise<WebauthnCredential> {
  if (!passkeySupport()) throw new PasskeyError('unsupported');

  let options: WebauthnOptions;
  try {
    options = await api.webauthnRegisterOptions();
  } catch (err) {
    throw toServerPasskeyError(err);
  }

  try {
    const attestation = await startRegistration({
      optionsJSON: options.public_key as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
    });
    const { credential } = await api.webauthnRegisterVerify({
      challenge_id: options.challenge_id,
      name,
      response: attestation as unknown as Record<string, unknown>,
    });
    return credential;
  } catch (err) {
    throw classifyCeremonyError(err);
  }
}

// -- internals ------------------------------------------------------------------

/** The challenge lifetime assumed when the server's options name none (the server default). */
const DEFAULT_CHALLENGE_TIMEOUT_MS = 300_000;

function staged(err: PasskeyError, stage: PasskeyErrorStage): PasskeyError {
  err.stage ??= stage;
  return err;
}

// The browser refuses the ceremony for a family of reasons the DOM names
// precisely; everything else is the server's answer (or the unknown bin).
// @simplewebauthn/browser rethrows as WebAuthnError but keeps the DOM name.
function classifyCeremonyError(err: unknown): PasskeyError {
  const name =
    typeof err === 'object' && err !== null && 'name' in err ? String((err as { name: unknown }).name) : '';

  switch (name) {
    case 'NotAllowedError':
    case 'AbortError':
      return new PasskeyError('cancelled', undefined, err);
    case 'InvalidStateError':
      return new PasskeyError('invalid-state', undefined, err);
    case 'SecurityError':
      // `passkeySupport()` already proved a secure context, so a SecurityError
      // here is the browser refusing the server's RP ID for this page's
      // address — a deployment mismatch, not an unsupported browser.
      return new PasskeyError(
        typeof window !== 'undefined' && window.isSecureContext === true ? 'wrong-address' : 'unsupported',
        undefined,
        err,
      );
    case 'NotSupportedError':
      return new PasskeyError('unsupported', undefined, err);
    default:
      break;
  }

  if (err instanceof ApiError) return toServerPasskeyError(err);
  if (err instanceof PasskeyError) return err;
  return new PasskeyError('unknown', undefined, err);
}

/** A server refusal → the kind the member can act on (the keys are the server's WebAuthnController contract). */
function toServerPasskeyError(err: unknown): PasskeyError {
  if (err instanceof PasskeyError) return err;
  if (err instanceof ApiError) {
    switch (err.key.toLowerCase()) {
      case 'invalid_credentials':
        return new PasskeyError('not-recognized', undefined, err);
      case 'challenge_invalid':
        return new PasskeyError('expired', undefined, err);
      case 'ceremony_failed':
        return new PasskeyError('wrong-address', undefined, err);
      case 'network_error':
      case 'timeout':
        return new PasskeyError('network', undefined, err);
      default:
        return new PasskeyError('server', err.message || undefined, err);
    }
  }
  return new PasskeyError('unknown', undefined, err);
}

/** The caller's abort between awaits: a password submit must leave no window for a late ceremony. */
function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new PasskeyError('cancelled', 'Passkey sign-in was aborted.');
}

/**
 * The live PublicKeyCredential → the AuthenticationResponseJSON shape the
 * server verifies (the same shape startAuthentication returns: base64url
 * binaries, spec camelCase; the controller also tolerates snake_case).
 */
function assertionToJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse;
  const userHandle = response.userHandle;
  return {
    id: credential.id,
    rawId: bufferToBase64URLString(credential.rawId),
    type: credential.type,
    clientExtensionResults: credential.getClientExtensionResults(),
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    response: {
      authenticatorData: bufferToBase64URLString(response.authenticatorData),
      clientDataJSON: bufferToBase64URLString(response.clientDataJSON),
      signature: bufferToBase64URLString(response.signature),
      userHandle: userHandle ? bufferToBase64URLString(userHandle) : null,
    },
  };
}
