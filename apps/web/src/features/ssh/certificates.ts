/**
 * @cytale/web — SSH certificate REST seam (U3).
 *
 * The member routes this surface calls, as U2 implements them:
 *
 *   POST   /api/v1/users/@me/ssh/certificates                     { public_key } → issued cert
 *   GET    /api/v1/users/@me/ssh/certificates                     → stored keys + their certs
 *   POST   /api/v1/users/@me/ssh/certificates/{key_id}/reissue    (no body)      → issued cert
 *   DELETE /api/v1/users/@me/ssh/certificates/{key_id}                           → 204
 *
 * THE ADDRESSING IS BY `key_id`, NOT BY SERIAL. A stored key is the thing a
 * member manages (R5a retires a key; R6 re-issues against one), and a serial
 * names one certificate issued from it. Re-issue therefore addresses the key
 * and reads the public key back from the caller's own account, so a key id
 * belonging to another member is simply not found. That is also why re-issue
 * carries no body — the member never pastes the key again, which is R6's whole
 * point.
 *
 * WHY THIS IS A DIRECT FETCH AND NOT AN `api` METHOD. `@cytale/api-client` has
 * no SSH surface, and U1-U3 deliberately keep this off the shared package so
 * the three existing clients' bundles do not grow for a surface none of them
 * renders. The client also exposes no generic request escape hatch — `buildUrl`
 * is the only public plumbing — so there is nothing to call through. This
 * module therefore follows the repo's documented pattern for the few modules
 * that fetch directly (`features/directory/api.ts`, and `apiUrl`'s own header in
 * `app/origin.ts`): resolve the URL with `apiUrl` so a packaged Tauri shell
 * reaches the server rather than the webview scheme, send the Bearer from the
 * live auth store, and keep every api-client convention that can be kept by
 * hand —
 *
 *   - the `{ error: { key, code, message } }` envelope is normalized into a
 *     real `ApiError`, so callers narrow on `.status` (403 → permission denied)
 *     exactly as they do for `api.*`;
 *   - POSTs carry an `Idempotency-Key`, so a retry cannot issue two
 *     certificates or burn two serials;
 *   - the 401 → refresh → one-retry exchange is NOT reimplemented here. A 401
 *     is surfaced as an `ApiError`; the surface renders it as an error state
 *     with Retry rather than pretending to own the session.
 *
 * NO KEY MATERIAL LEAVES THIS FILE except where the UI branches require it:
 * the public key travels in a POST body (never a URL, a query string, or
 * history), the returned certificate is returned to the caller and not cached,
 * and nothing here logs or reports anything.
 */

import { ApiError } from '@cytale/api-client';

import { apiUrl, configuredOrigin } from '../../app/origin.js';
import { authStore } from '../auth/session.js';

/** The member path prefix every route below hangs off. */
const CERTIFICATES_PATH = '/api/v1/users/@me/ssh/certificates';

/**
 * Absolute URL for a request path. The origin resolution mirrors the session
 * manager's own (`configuredOrigin() ?? location.origin`), so the SSH surface
 * reaches the same server the rest of the app does — including from the
 * packaged Tauri shell, where `location.origin` is the webview.
 */
function resolveUrl(path: string): string {
  const origin =
    configuredOrigin() ?? (globalThis.location as Location | undefined)?.origin ?? '';
  return apiUrl(path, origin);
}

/** One certificate issued from a stored key (R5). */
export interface SshCertificate {
  serial: string;
  /** The certificate's principal — the member's username. */
  principal: string | null;
  /** ISO-8601 instant the certificate becomes valid. */
  valid_after: string | null;
  /** ISO-8601 instant the certificate expires. */
  valid_before: string | null;
  /**
   * A newer certificate exists for the same stored key. The server marks this
   * rather than removing the row, so superseded certificates are history the
   * member can still read.
   */
  superseded: boolean;
}

/**
 * One stored public key and the certificates issued from it (R5, R5a).
 *
 * The fingerprint lives on the KEY, not on a certificate, and that is the
 * point: it is how a member tells which row corresponds to the private key
 * file on their own machine. A certificate's serial cannot do that, because
 * the same key accumulates a new serial every time it is re-issued.
 */
export interface SshKey {
  /** The stored key's id — the address for re-issue and removal. */
  id: string;
  /** `SHA256:…` of the stored public key. Identifies a local private key. */
  fingerprint: string;
  /** ISO-8601 instant the key was first stored. */
  created_at: string | null;
  /** Certificates issued from this key, newest first. */
  certificates: SshCertificate[];
}

/** The body of a successful issue/re-issue — the certificate itself. */
export interface SshIssuedCertificate {
  /** The `id_ed25519-cert.pub` file text. */
  certificate: string;
  serial: string;
  key_id: string;
  fingerprint: string;
  valid_after: string | null;
  valid_before: string | null;
}

/** The operations the section needs, injectable for tests. */
export interface SshCertificatesClient {
  issue(publicKey: string): Promise<SshIssuedCertificate>;
  list(): Promise<SshKey[]>;
  reissue(keyId: string): Promise<SshIssuedCertificate>;
  remove(keyId: string): Promise<void>;
}

export interface SshCertificatesClientOptions {
  /** Bearer token for the request, read per call (never captured once). */
  getToken?: () => string | null;
  /** Escape hatch for tests; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

function idempotencyKey(): string {
  const crypto = globalThis.crypto as Crypto | undefined;
  return crypto !== undefined && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Rebuild the api-client's error envelope into a real `ApiError`. */
async function apiErrorFrom(response: Response): Promise<ApiError> {
  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON failure body (proxy HTML, empty 500, …) — status-only.
  }
  const envelope =
    payload !== null && typeof payload === 'object' && 'error' in payload
      ? ((payload as { error?: Partial<Record<'key' | 'code' | 'message', unknown>> }).error ?? {})
      : {};
  return new ApiError({
    key: typeof envelope.key === 'string' ? envelope.key : 'unknown_error',
    code: typeof envelope.code === 'number' ? envelope.code : response.status * 100,
    message:
      typeof envelope.message === 'string'
        ? envelope.message
        : `Request failed with status ${response.status}`,
    status: response.status,
  });
}

/**
 * Coerce a validity instant to ISO-8601.
 *
 * The certificate's window is seconds since the epoch in the OpenSSH format, so
 * the server may reasonably hand back either an ISO string or a number. Both
 * are accepted (and a millisecond-looking number is read as millis), so the
 * surface renders a real date instead of "Invalid Date" whichever the server
 * settles on.
 */
export function normalizeInstant(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const millis = value > 1e12 ? value : value * 1000;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
  }
  return null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function normalizeCertificate(raw: Record<string, unknown>): SshCertificate {
  return {
    serial: String(raw.serial ?? ''),
    principal: asString(raw.principal),
    // The server's field names are `issued_at` / `expires_at`; the certificate's
    // own vocabulary is valid-after / valid-before. Both are read so a naming
    // drift on either side still renders a date.
    valid_after: normalizeInstant(raw.issued_at ?? raw.valid_after),
    valid_before: normalizeInstant(raw.expires_at ?? raw.valid_before),
    // The server marks the current row `current: true`; anything else in the
    // list is history for the same key.
    superseded: raw.current === false,
  };
}

function normalizeKey(raw: Record<string, unknown>): SshKey {
  const certificates = Array.isArray(raw.certificates) ? raw.certificates : [];
  return {
    // The server names the id `id` on the list route and `key_id` on an
    // issuance response; both are read so the shape cannot silently empty.
    id: String(raw.id ?? raw.key_id ?? ''),
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    created_at: normalizeInstant(raw.created_at),
    certificates: certificates
      .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
      .map(normalizeCertificate),
  };
}

function normalizeIssued(raw: Record<string, unknown>): SshIssuedCertificate {
  return {
    certificate: typeof raw.certificate === 'string' ? raw.certificate : '',
    serial: String(raw.serial ?? ''),
    key_id: String(raw.key_id ?? ''),
    fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    valid_after: normalizeInstant(raw.issued_at ?? raw.valid_after),
    valid_before: normalizeInstant(raw.expires_at ?? raw.valid_before),
  };
}

/**
 * Build the client. The token is read through `getToken` on every call so a
 * refreshed access token is picked up without re-constructing anything.
 */
export function createSshCertificatesClient(
  options: SshCertificatesClientOptions = {},
): SshCertificatesClient {
  const getToken = options.getToken ?? (() => null);
  const fetchImpl: typeof fetch =
    options.fetchImpl ?? ((...args) => (globalThis.fetch as typeof fetch)(...args));

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const token = getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['Idempotency-Key'] = idempotencyKey();
    }

    const response = await fetchImpl(resolveUrl(path), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (!response.ok) throw await apiErrorFrom(response);
    if (response.status === 204) return undefined;
    return await response.json();
  }

  return {
    /** R2: submit a public key, receive a signed certificate. */
    async issue(publicKey: string): Promise<SshIssuedCertificate> {
      const raw = await request('POST', CERTIFICATES_PATH, { public_key: publicKey });
      return normalizeIssued(asRecord(raw));
    },

    /** R5: the member's stored keys, each with its certificates and expiry. */
    async list(): Promise<SshKey[]> {
      const raw = asRecord(await request('GET', CERTIFICATES_PATH));
      const keys = Array.isArray(raw.keys) ? raw.keys : [];
      return keys
        .filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object')
        .map(normalizeKey);
    },

    /**
     * R6: a fresh certificate for a public key already on file. The key is
     * addressed by its own id and read back from the caller's account, so the
     * member never pastes it again — which is why there is no body.
     */
    async reissue(keyId: string): Promise<SshIssuedCertificate> {
      const raw = await request('POST', `${CERTIFICATES_PATH}/${encodeURIComponent(keyId)}/reissue`);
      return normalizeIssued(asRecord(raw));
    },

    /** R5a: retire the stored public key. Further issuance stops here. */
    async remove(keyId: string): Promise<void> {
      await request('DELETE', `${CERTIFICATES_PATH}/${encodeURIComponent(keyId)}`);
    },
  };
}

/**
 * The app's client: the live in-memory access token (authStore) over the
 * resolved server origin. Sections take this as their default and accept an
 * injected client in tests.
 */
export const sshCertificates: SshCertificatesClient = createSshCertificatesClient({
  getToken: () => authStore.getState().getAccessToken(),
});

/** Row states the list distinguishes. */
export type CertificateState = 'current' | 'expired' | 'superseded';

/**
 * Classify a certificate. Superseded wins over expired: a replaced certificate
 * is history either way, and "replaced" is the reason the member can act on.
 */
export function certificateState(
  certificate: Pick<SshCertificate, 'superseded' | 'valid_before'>,
  now: number = Date.now(),
): CertificateState {
  if (certificate.superseded) return 'superseded';
  if (certificate.valid_before !== null) {
    const expiry = Date.parse(certificate.valid_before);
    if (!Number.isNaN(expiry) && expiry <= now) return 'expired';
  }
  return 'current';
}

/** The newest certificate on a key — the one a badge describes. */
export function latestCertificate(key: SshKey): SshCertificate | null {
  return key.certificates[0] ?? null;
}

/** True when a key currently has a usable (non-expired, non-superseded) certificate. */
export function keyIsLive(key: SshKey, now: number = Date.now()): boolean {
  return key.certificates.some((c) => certificateState(c, now) === 'current');
}
