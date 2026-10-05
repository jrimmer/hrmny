/**
 * @cytale/web — SSH settings section tests (U3).
 *
 * Scenarios, per the unit: generating a keypair produces an `id_ed25519`
 * download and a valid `ssh-ed25519` public-key line; a pasted public key
 * produces an `id_ed25519-cert.pub` download; the install instructions name
 * the member's real username in the `ssh -l` form; the list shows each stored
 * key with its fingerprint and created-at plus its certificates' expiry and
 * state; re-issue and removal both address the KEY, without re-pasting
 * anything; the issue request body carries a public key and nothing else; a
 * refused key renders an actionable error; and every state in the states-first
 * set renders axe-clean.
 *
 * THE UNIT OF THE LIST IS A STORED KEY, NOT A CERTIFICATE. The server's list
 * route returns `{ keys: [{ id, fingerprint, created_at, certificates: [...] }] }`
 * and both mutations are addressed by `key_id` — `POST .../{key_id}/reissue`
 * with no body, `DELETE .../{key_id}`. The fixtures below are in that shape on
 * purpose: the assertions pin the contract the server actually serves, and
 * re-issue is asserted to send nothing at all, because the whole point of R6 is
 * that the key is read back from the member's own account.
 *
 * The requests are asserted through the REAL client (`certificates.ts`) over a
 * stubbed `fetch`, not through an injected fake: that way the wire shapes —
 * the body keys, the re-issue path and its absent payload, the delete path —
 * are pinned as the server will actually see them.
 *
 * jsdom has no SubtleCrypto, so `beforeEach` installs Node's WebCrypto (the
 * same API surface the browser exposes) and the real `keygen.ts` runs
 * unmodified. The OpenSSH-format proof lives in the sibling `keygen.test.ts`,
 * which runs in the node environment where `ssh-keygen -y` can be spawned.
 */

import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

import {
  createFetchRouter,
  goOffline,
  goOnline,
  type FetchRouter,
} from '../../settings/__tests__/helpers.js';
import { generateEd25519Keypair } from '../keygen.js';
import { SshSection } from '../../settings/SshSection.js';

const CERTIFICATES_PATH = '/api/v1/users/@me/ssh/certificates';

const NOW = Date.now();
const FUTURE = new Date(NOW + 24 * 60 * 60 * 1000).toISOString();
const PAST = new Date(NOW - 60 * 60 * 1000).toISOString();
const STORED_AT = new Date(NOW - 48 * 60 * 60 * 1000).toISOString();

/**
 * Two distinct stored keys. Ids, not serials, are what the section addresses,
 * and two of them is what proves keys are never merged into one row.
 */
const KEY_A = '910000000000000001';
const KEY_B = '910000000000000002';

const ACTIVE_SERIAL = '9001';
const SUPERSEDED_SERIAL = '9002';
const EXPIRED_SERIAL = '9003';

/** One certificate as the server renders it (`certificate_json/1`). */
function certificate(
  serial: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    serial,
    principal: 'jordan',
    issued_at: new Date(NOW - 60 * 1000).toISOString(),
    expires_at: FUTURE,
    current: true,
    ...overrides,
  };
}

/** One stored key as the server renders it (`index/2`'s `keys` entries). */
function key(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    fingerprint: `SHA256:fingerprint-of-${id}`,
    created_at: STORED_AT,
    certificates: [certificate(ACTIVE_SERIAL)],
    ...overrides,
  };
}

const ISSUED = {
  certificate: `ssh-ed25519-cert-v01@openssh.com AAAAIHNzaC1lZDI1NTE5LWNlcnQtdjAxQG9wZW5zc2guY29tAAAAIA${'x'.repeat(
    40,
  )} cytale`,
  serial: ACTIVE_SERIAL,
  key_id: KEY_A,
  principal: 'jordan',
  fingerprint: `SHA256:fingerprint-of-${KEY_A}`,
  issued_at: new Date(NOW).toISOString(),
  expires_at: FUTURE,
  current: true,
};

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

let io: FetchRouter;

interface Download {
  /** The `download` attribute's value — the filename the member gets. */
  name: string;
  /** The object URL, so the revocation can be checked against it. */
  url: string;
  /** The staged blob, read in the assertion. */
  blob: Blob | undefined;
}

let downloads: Download[];
let revoked: string[];

/**
 * Read a staged blob. jsdom's `Blob` has no `text()`, so this goes through
 * `FileReader` — the same route the browser-facing code would have to avoid.
 */
function readBlob(blob: Blob | undefined): Promise<string> {
  if (blob === undefined) return Promise.resolve('');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** The original `crypto` descriptor, restored after every test. */
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

beforeEach(() => {
  io = createFetchRouter();
  vi.stubGlobal('fetch', io.fetchMock);

  // jsdom implements Crypto without SubtleCrypto. Node's WebCrypto is the
  // same interface, so the production keygen path runs unchanged.
  Object.defineProperty(globalThis, 'crypto', {
    value: webcrypto,
    configurable: true,
    writable: true,
  });

  downloads = [];
  revoked = [];
  const staged = new Map<string, Blob>();
  let counter = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((source: Blob | MediaSource) => {
    const url = `blob:ssh-test-${(counter += 1)}`;
    if (source instanceof Blob) staged.set(url, source);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
    revoked.push(url);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, url: this.href, blob: staged.get(this.href) });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalCrypto) Object.defineProperty(globalThis, 'crypto', originalCrypto);
  else delete (globalThis as { crypto?: unknown }).crypto;
  goOnline();
});

/** The last download for a filename — auto-downloads fire before re-saves. */
function lastDownload(name: string): Download | undefined {
  return [...downloads].reverse().find((entry) => entry.name === name);
}

function listRoutes(keys: Record<string, unknown>[]): void {
  io.on('GET', CERTIFICATES_PATH, () => Response.json({ keys }));
}

function renderSection(props: Partial<Parameters<typeof SshSection>[0]> = {}) {
  return render(
    <SshSection username="jordan" host="ssh.cytale.test" port={2222} {...props} />,
  );
}

// ---------------------------------------------------------------------------
// states
// ---------------------------------------------------------------------------

describe('SshSection — states', () => {
  it('shows the loading skeleton, then the key list', async () => {
    listRoutes([key(KEY_A)]);
    const { container } = renderSection();

    expect(screen.getByTestId('ssh-loading')).toBeTruthy();
    expect(await screen.findByTestId('ssh-key-list')).toBeTruthy();
    expect(screen.queryByTestId('ssh-loading')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('empty renders the named empty state', async () => {
    listRoutes([]);
    const { container } = renderSection();

    expect(await screen.findByTestId('ssh-empty')).toBeTruthy();
    expect(screen.queryByTestId('ssh-key-list')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('error renders an alert with a working retry', async () => {
    let calls = 0;
    io.on('GET', CERTIFICATES_PATH, () => {
      calls += 1;
      return calls === 1
        ? Response.json({ error: { key: 'internal', code: 50000, message: 'boom' } }, { status: 500 })
        : Response.json({ keys: [key(KEY_A)] });
    });
    const { container } = renderSection();

    expect(await screen.findByTestId('ssh-error')).toBeTruthy();
    expect(await axe(container)).toHaveNoViolations();

    await userEvent.setup().click(screen.getByTestId('ssh-retry'));
    expect(await screen.findByTestId('ssh-key-list')).toBeTruthy();
  });

  it('offline is announced and disables the destructive surface', async () => {
    listRoutes([key(KEY_A)]);
    goOffline();
    const { container } = renderSection();
    await screen.findByTestId('ssh-key-list');

    expect(screen.getByTestId('ssh-offline')).toBeTruthy();
    expect(
      (screen.getByTestId('ssh-generate') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId('ssh-issue') as HTMLButtonElement).disabled,
    ).toBe(true);
    // Both actions address the KEY, so both test ids are key-scoped too.
    expect(
      (screen.getByTestId(`ssh-reissue-${KEY_A}`) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByTestId(`ssh-remove-${KEY_A}-trigger`) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('permission-denied renders the denial and no rows', async () => {
    io.on('GET', CERTIFICATES_PATH, () =>
      Response.json(
        {
          error: {
            key: 'ACCOUNT_UNVERIFIED',
            code: 40301,
            message: 'Verify your email address first.',
          },
        },
        { status: 403 },
      ),
    );
    const { container } = renderSection();

    const denied = await screen.findByTestId('ssh-permission-denied');
    expect(denied.textContent).toContain('ACCOUNT_UNVERIFIED');
    expect(denied.textContent).toContain('Verify your email address first.');
    expect(screen.queryByTestId('ssh-key-list')).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('marks the superseded and expired certificates of a key, and still lists both', async () => {
    listRoutes([
      key(KEY_A, {
        certificates: [
          certificate(ACTIVE_SERIAL),
          certificate(SUPERSEDED_SERIAL, { current: false }),
          certificate(EXPIRED_SERIAL, { expires_at: PAST }),
        ],
      }),
    ]);
    const { container } = renderSection();
    await screen.findByTestId('ssh-key-list');

    expect(screen.getByTestId(`ssh-certificate-badge-${SUPERSEDED_SERIAL}`).textContent).toBe(
      'Superseded',
    );
    expect(screen.getByTestId(`ssh-certificate-badge-${EXPIRED_SERIAL}`).textContent).toBe(
      'Expired',
    );
    expect(screen.getByTestId(`ssh-certificate-expiry-${EXPIRED_SERIAL}`).textContent).toMatch(
      /^Expired /,
    );
    expect(screen.getByTestId(`ssh-certificate-expiry-${ACTIVE_SERIAL}`).textContent).toMatch(
      /^Expires /,
    );
    // A live certificate carries no badge — the badge means something precisely
    // because its absence does too.
    expect(screen.queryByTestId(`ssh-certificate-badge-${ACTIVE_SERIAL}`)).toBeNull();
    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders an expired and a current certificate of one key side by side', async () => {
    // The key model makes this newly ordinary: one key, several certificates,
    // each carrying its own state — which supersedes the single-certificate
    // row shape the old flat list could express.
    listRoutes([
      key(KEY_A, {
        certificates: [
          certificate(ACTIVE_SERIAL),
          certificate(EXPIRED_SERIAL, { expires_at: PAST }),
        ],
      }),
    ]);
    const { container } = renderSection();
    await screen.findByTestId('ssh-key-list');

    const expired = screen.getByTestId(`ssh-certificate-${EXPIRED_SERIAL}`);
    const current = screen.getByTestId(`ssh-certificate-${ACTIVE_SERIAL}`);
    expect(expired.dataset.state).toBe('expired');
    expect(current.dataset.state).toBe('current');
    expect(screen.getByTestId(`ssh-certificate-badge-${EXPIRED_SERIAL}`).textContent).toBe(
      'Expired',
    );
    expect(screen.queryByTestId(`ssh-certificate-badge-${ACTIVE_SERIAL}`)).toBeNull();
    // The key still counts as live: one usable certificate is enough.
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`).dataset.state).toBe('current');
    expect(await axe(container)).toHaveNoViolations();
  });
});

// ---------------------------------------------------------------------------
// the list's content: the key's fingerprint + created-at, its certificates (R5)
// ---------------------------------------------------------------------------

describe('SshSection — the issued list', () => {
  it('shows each key with the fingerprint the server returned, and each certificate with its expiry', async () => {
    listRoutes([key(KEY_A)]);
    renderSection();
    await screen.findByTestId('ssh-key-list');

    // The fingerprint is the server's, verbatim — it is the member's only way
    // to match this row to the private key file on their own machine.
    expect(screen.getByTestId(`ssh-key-fingerprint-${KEY_A}`).textContent).toBe(
      `SHA256:fingerprint-of-${KEY_A}`,
    );

    const created = screen.getByTestId(`ssh-key-created-${KEY_A}`).textContent ?? '';
    expect(created).toMatch(/^Added /);
    expect(created).not.toMatch(/Invalid Date/);

    const expiry = screen.getByTestId(`ssh-certificate-expiry-${ACTIVE_SERIAL}`).textContent ?? '';
    expect(expiry).toMatch(/^Expires /);
    // The date, not "Invalid Date": a seconds-since-epoch window from the
    // server must still render as an instant.
    expect(expiry).not.toMatch(/Invalid Date/);
    expect(expiry).toMatch(/\d{1,4}/);
  });

  it('renders an epoch-seconds validity window as a real date, not Invalid Date', async () => {
    const seconds = Math.floor((NOW + 60 * 60 * 1000) / 1000);
    listRoutes([
      key(KEY_A, {
        certificates: [
          certificate(ACTIVE_SERIAL, { expires_at: seconds, issued_at: seconds - 86400 }),
        ],
      }),
    ]);
    renderSection();
    await screen.findByTestId('ssh-key-list');

    const expiry = screen.getByTestId(`ssh-certificate-expiry-${ACTIVE_SERIAL}`).textContent ?? '';
    expect(expiry).not.toMatch(/Invalid Date/);
    expect(expiry).toMatch(/^Expires /);
  });

  it('keeps two keys as two rows, each with its own certificates', async () => {
    listRoutes([
      key(KEY_A, { certificates: [certificate(ACTIVE_SERIAL)] }),
      key(KEY_B, {
        certificates: [
          certificate(EXPIRED_SERIAL, { expires_at: PAST }),
          certificate(SUPERSEDED_SERIAL, { current: false }),
        ],
      }),
    ]);
    const { container } = renderSection();
    await screen.findByTestId('ssh-key-list');

    // Keys are never merged: two fingerprints, two rows, two action pairs.
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`)).toBeTruthy();
    expect(screen.getByTestId(`ssh-key-row-${KEY_B}`)).toBeTruthy();
    expect(screen.getByTestId(`ssh-key-fingerprint-${KEY_A}`).textContent).toBe(
      `SHA256:fingerprint-of-${KEY_A}`,
    );
    expect(screen.getByTestId(`ssh-key-fingerprint-${KEY_B}`).textContent).toBe(
      `SHA256:fingerprint-of-${KEY_B}`,
    );

    // Each key owns its own certificate set, under its own row.
    const rowA = screen.getByTestId(`ssh-key-row-${KEY_A}`);
    const rowB = screen.getByTestId(`ssh-key-row-${KEY_B}`);
    expect(rowA.contains(screen.getByTestId(`ssh-certificate-${ACTIVE_SERIAL}`))).toBe(true);
    expect(rowA.contains(screen.getByTestId(`ssh-certificate-${EXPIRED_SERIAL}`))).toBe(false);
    expect(rowB.contains(screen.getByTestId(`ssh-certificate-${EXPIRED_SERIAL}`))).toBe(true);
    expect(rowB.contains(screen.getByTestId(`ssh-certificate-${SUPERSEDED_SERIAL}`))).toBe(true);

    // KEY_B is wholly expired (nothing current), so its row says so while
    // KEY_A stays live — the key-level state is derived, not sent.
    expect(screen.getByTestId(`ssh-key-row-${KEY_B}`).dataset.state).toBe('stale');
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`).dataset.state).toBe('current');

    expect(await axe(container)).toHaveNoViolations();
  });

  it('renders exactly the keys the server returns — a removed key is simply absent', async () => {
    // R5a: a retired key can no longer issue or authenticate, so the server
    // stops returning it and there is no row to render beside the live ones.
    listRoutes([key(KEY_A)]);
    renderSection();
    await screen.findByTestId('ssh-key-list');

    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`)).toBeTruthy();
    expect(screen.queryByTestId(`ssh-key-row-${KEY_B}`)).toBeNull();
  });

  it('says so when a stored key has no certificate yet', async () => {
    // A key is stored before it is signed for, so this is reachable: the row
    // keeps its affordances and states the gap rather than rendering blank.
    listRoutes([key(KEY_A, { certificates: [] })]);
    renderSection();
    await screen.findByTestId('ssh-key-list');

    expect(screen.getByTestId(`ssh-key-no-certificates-${KEY_A}`).textContent).toMatch(
      /No certificate on record/,
    );
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`).dataset.state).toBe('stale');
    expect(
      (screen.getByTestId(`ssh-reissue-${KEY_A}`) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// generating a keypair (R1) and the install instructions (step 3)
// ---------------------------------------------------------------------------

describe('SshSection — generating a keypair', () => {
  it('downloads `id_ed25519` and shows a valid ssh-ed25519 line', async () => {
    listRoutes([]);
    const { container } = renderSection();
    await screen.findByTestId('ssh-empty');

    await userEvent.setup().click(screen.getByTestId('ssh-generate'));
    await screen.findByTestId('ssh-key-material');

    // The private key is a DOWNLOAD, never a clipboard copy.
    const key = lastDownload('id_ed25519');
    expect(key).toBeDefined();
    const keyText = await readBlob(key?.blob);
    expect(keyText.startsWith('-----BEGIN OPENSSH PRIVATE KEY-----\n')).toBe(true);
    expect(keyText).toContain('-----END OPENSSH PRIVATE KEY-----');
    // The container's magic, base64'd — i.e. this is an openssh-key-v1 file
    // and not, say, a PKCS#8 export with a misleading header.
    expect(keyText).toContain('b3BlbnNzaC1rZXktdjE');

    // The staging URL is revoked in the same tick as the click.
    expect(revoked).toContain(key?.url);

    // The public half is rendered, is a well-formed line, and is pre-filled
    // into the submit field so the next step is not a copy-paste.
    const shown = (screen.getByTestId('ssh-generated-public-key-value') as HTMLTextAreaElement)
      .value;
    expect(shown).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]{60,}={0,2} cytale$/);
    expect((screen.getByTestId('ssh-public-key-input') as HTMLTextAreaElement).value).toBe(shown);
    expect(screen.getByTestId('ssh-generated-fingerprint').textContent).toMatch(/^Fingerprint SHA256:/);

    // The warning says what the file actually is.
    const warning = screen.getByTestId('ssh-private-key-warning').textContent ?? '';
    expect(warning).toMatch(/unencrypted private key/);
    expect(warning).toMatch(/shown once/);
    expect(warning).toMatch(/expires in 24 hours/);

    expect(await axe(container)).toHaveNoViolations();
  });

  it('can re-save the private key while the pane is open, and copies the public key', async () => {
    listRoutes([]);
    renderSection();
    await screen.findByTestId('ssh-empty');

    await userEvent.setup().click(screen.getByTestId('ssh-generate'));
    await screen.findByTestId('ssh-key-material');
    expect(downloads.filter((entry) => entry.name === 'id_ed25519')).toHaveLength(1);

    await userEvent.setup().click(screen.getByTestId('ssh-save-private-key'));
    expect(downloads.filter((entry) => entry.name === 'id_ed25519')).toHaveLength(2);

    await userEvent.setup().click(screen.getByTestId('ssh-generated-public-key-copy'));
    // eslint-disable-next-line no-console
    // Asserted through user-event's clipboard stub (installed by `setup()`),
    // which is the REAL write path: the value must land in the clipboard, not
    // merely reach a mock.
    await waitFor(() =>
      expect(screen.getByTestId('ssh-generated-public-key-copy').textContent).toBe('Copied!'),
    );
    expect(await navigator.clipboard.readText()).toMatch(/^ssh-ed25519 /);
  });

  it('names the member in the `ssh -l` form and teaches the alias', async () => {
    listRoutes([]);
    renderSection({ username: 'jordan' });
    await screen.findByTestId('ssh-empty');

    const commands = screen.getByTestId('ssh-install-install-code').textContent ?? '';
    // The certificate's principal is the USERNAME (KTD3), so this is the
    // login name — and it must be the member's own, not a placeholder.
    expect(commands).toContain('ssh -l jordan -p 2222 ssh.cytale.test');
    expect(commands).toContain('chmod 600 ~/.ssh/id_ed25519');
    expect(commands).toContain('mkdir -p ~/.ssh');
    expect(commands).toMatch(/too open/);

    const alias = screen.getByTestId('ssh-install-alias-code').textContent ?? '';
    expect(alias).toContain('User jordan');
    expect(alias).toContain('HostName ssh.cytale.test');
    expect(alias).toContain('CertificateFile ~/.ssh/id_ed25519-cert.pub');
  });

  it('renders a named failure instead of a crash when WebCrypto is missing', async () => {
    listRoutes([]);
    // Remove the shim installed in beforeEach: a browser without SubtleCrypto.
    Object.defineProperty(globalThis, 'crypto', {
      value: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) },
      configurable: true,
      writable: true,
    });
    renderSection();
    await screen.findByTestId('ssh-empty');

    await userEvent.setup().click(screen.getByTestId('ssh-generate'));
    const banner = await screen.findByTestId('ssh-keygen-error');
    expect(banner.textContent).toMatch(/WebCrypto/);
    expect(banner.textContent).toMatch(/ssh-keygen/);
  });
});

// ---------------------------------------------------------------------------
// issuing a certificate (R2)
// ---------------------------------------------------------------------------

describe('SshSection — issuing a certificate', () => {
  it('posts a public key and nothing else, and downloads the -cert.pub', async () => {
    listRoutes([]);
    io.on('POST', CERTIFICATES_PATH, () => Response.json(ISSUED, { status: 201 }));
    const { container } = renderSection();
    await screen.findByTestId('ssh-empty');

    // A real key, generated by the same code the UI uses.
    const pair = await generateEd25519Keypair();
    fireEvent.change(screen.getByTestId('ssh-public-key-input'), {
      target: { value: pair.publicKeyLine },
    });
    await userEvent.setup().click(screen.getByTestId('ssh-issue'));

    await screen.findByTestId('ssh-certificate-issued');

    const posted = io.recorded(CERTIFICATES_PATH).find((call) => call.method === 'POST');
    // Asserted directly: the body is `{ public_key }` and nothing else, so a
    // spoofed principal or account id cannot ride along (R3a's client half).
    expect(posted?.body).toEqual({ public_key: pair.publicKeyLine });
    expect(Object.keys(posted?.body as Record<string, unknown>)).toEqual(['public_key']);

    const certificate = lastDownload('id_ed25519-cert.pub');
    expect(certificate).toBeDefined();
    expect(await readBlob(certificate?.blob)).toBe(ISSUED.certificate);
    expect(revoked).toContain(certificate?.url);

    expect(screen.getByTestId('ssh-certificate-issued').textContent).toContain(ACTIVE_SERIAL);
    expect(screen.getByTestId('ssh-certificate-issued').textContent).toContain(ISSUED.fingerprint);
    expect(await axe(container)).toHaveNoViolations();
  });

  it('reports a refused public key in the server\'s own words', async () => {
    listRoutes([]);
    io.on('POST', CERTIFICATES_PATH, () =>
      Response.json(
        {
          error: {
            key: 'invalid_public_key',
            code: 42201,
            message: 'The public key could not be parsed. Paste the whole line, starting with ssh-ed25519.',
          },
        },
        { status: 422 },
      ),
    );
    renderSection();
    await screen.findByTestId('ssh-empty');

    const pair = await generateEd25519Keypair();
    fireEvent.change(screen.getByTestId('ssh-public-key-input'), {
      target: { value: pair.publicKeyLine },
    });
    await userEvent.setup().click(screen.getByTestId('ssh-issue'));

    const error = await screen.findByTestId('ssh-issue-error');
    expect(error.textContent).toContain('starting with ssh-ed25519');
    expect(error.textContent).not.toMatch(/^Request failed with status/);
    expect(downloads).toHaveLength(0);
  });

  it('catches an obviously wrong paste locally, with a next step, and sends nothing', async () => {
    listRoutes([]);
    renderSection();
    await screen.findByTestId('ssh-empty');

    fireEvent.change(screen.getByTestId('ssh-public-key-input'), { target: { value: 'hello' } });
    await userEvent.setup().click(screen.getByTestId('ssh-issue'));

    const problem = await screen.findByTestId('ssh-public-key-problem');
    expect(problem.textContent).toMatch(/ssh-ed25519/);
    expect(problem.textContent).toMatch(/id_ed25519\.pub/);
    // No round trip at all for input that cannot be a key line.
    expect(io.recorded(CERTIFICATES_PATH).filter((call) => call.method === 'POST')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// re-issue (R6) and remove (R5a)
// ---------------------------------------------------------------------------

describe('SshSection — re-issue and remove', () => {
  it('re-issues against the stored key id, sending no body at all', async () => {
    const stored = key(KEY_A);
    listRoutes([stored]);
    io.on('POST', `${CERTIFICATES_PATH}/${KEY_A}/reissue`, () =>
      Response.json({ ...ISSUED, serial: '9101' }, { status: 201 }),
    );
    renderSection();
    await screen.findByTestId('ssh-key-list');

    // Nothing is in the paste field at this point — re-issue must not need it.
    expect((screen.getByTestId('ssh-public-key-input') as HTMLTextAreaElement).value).toBe('');

    await userEvent.setup().click(screen.getByTestId(`ssh-reissue-${KEY_A}`));
    await screen.findByTestId('ssh-certificate-issued');

    // Addressed by the KEY's id — the thing the member holds — not by a
    // serial, which changes on every re-issue (R6).
    const posted = io.recorded(`${CERTIFICATES_PATH}/${KEY_A}/reissue`).find(
      (call) => call.method === 'POST',
    );
    expect(posted).toBeDefined();
    // The server reads the public key back off the caller's own account, so
    // there is no body: no public key is resent and no serial is named.
    expect(posted?.body).toBeUndefined();

    const certificate = lastDownload('id_ed25519-cert.pub');
    expect(certificate).toBeDefined();
    expect(await readBlob(certificate?.blob)).toBe(ISSUED.certificate);
  });

  it('removes a key by its id: the row and its re-issue affordance both go', async () => {
    listRoutes([key(KEY_A)]);
    io.on('DELETE', `${CERTIFICATES_PATH}/${KEY_A}`, () => new Response(null, { status: 204 }));
    renderSection();
    await screen.findByTestId('ssh-key-list');

    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-trigger`));
    // The consequence is stated before the confirm is reachable.
    expect(screen.getByTestId(`ssh-remove-${KEY_A}-consequence`).textContent).toMatch(
      /refuses logins/,
    );
    // The refetch after removal reports the key as gone.
    listRoutes([]);
    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-confirm`));

    await waitFor(() => expect(screen.queryByTestId(`ssh-key-row-${KEY_A}`)).toBeNull());
    expect(screen.queryByTestId(`ssh-reissue-${KEY_A}`)).toBeNull();
    expect(screen.getByTestId('ssh-empty')).toBeTruthy();

    // The DELETE names the key's id — a serial would not survive a re-issue
    // and so could not be the address of the thing being retired (R5a).
    const deleted = io.recorded(`${CERTIFICATES_PATH}/${KEY_A}`).find(
      (call) => call.method === 'DELETE',
    );
    expect(deleted).toBeDefined();
  });

  it('removes only the addressed key, leaving its sibling alone', async () => {
    listRoutes([key(KEY_A), key(KEY_B)]);
    io.on('DELETE', `${CERTIFICATES_PATH}/${KEY_A}`, () => new Response(null, { status: 204 }));
    renderSection();
    await screen.findByTestId('ssh-key-list');

    listRoutes([key(KEY_B)]);
    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-trigger`));
    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-confirm`));

    await waitFor(() => expect(screen.queryByTestId(`ssh-key-row-${KEY_A}`)).toBeNull());
    expect(screen.getByTestId(`ssh-key-row-${KEY_B}`)).toBeTruthy();
  });

  it('surfaces a failed removal as an actionable error and keeps the row', async () => {
    listRoutes([key(KEY_A)]);
    io.on('DELETE', `${CERTIFICATES_PATH}/${KEY_A}`, () =>
      Response.json(
        { error: { key: 'not_found', code: 40404, message: 'No such key on this account.' } },
        { status: 404 },
      ),
    );
    renderSection();
    await screen.findByTestId('ssh-key-list');

    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-trigger`));
    await userEvent.setup().click(screen.getByTestId(`ssh-remove-${KEY_A}-confirm`));

    const error = await screen.findByTestId('ssh-row-error');
    expect(error.textContent).toContain('No such key on this account.');
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`)).toBeTruthy();
  });

  it('surfaces a failed re-issue against the key as an actionable error', async () => {
    listRoutes([key(KEY_A)]);
    io.on('POST', `${CERTIFICATES_PATH}/${KEY_A}/reissue`, () =>
      Response.json(
        { error: { key: 'key_not_found', code: 40401, message: 'No stored SSH key with that id.' } },
        { status: 404 },
      ),
    );
    renderSection();
    await screen.findByTestId('ssh-key-list');

    await userEvent.setup().click(screen.getByTestId(`ssh-reissue-${KEY_A}`));

    const error = await screen.findByTestId('ssh-row-error');
    expect(error.textContent).toContain('No stored SSH key with that id.');
    expect(screen.getByTestId(`ssh-key-row-${KEY_A}`)).toBeTruthy();
    expect(downloads).toHaveLength(0);
  });
});
