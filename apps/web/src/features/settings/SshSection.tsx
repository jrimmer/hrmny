/**
 * @cytale/web — SSH settings section (U3): generate a key, get a
 * certificate, re-issue, retire.
 *
 * Requirements: R1 (generate a keypair, receive the private key once in a
 * saveable form), R2 (submit a public key, receive a signed certificate as a
 * `-cert.pub` file), R5 (list certificates with expiry and the key
 * fingerprint), R5a (remove a stored public key), R6 (re-issue against a key
 * already on file, without re-pasting it).
 *
 * A ROW IS A STORED KEY, NOT A CERTIFICATE. That is the server's contract
 * (`certificates.ts`'s header carries the rationale) and it is also what the
 * member actually manages: they hold the private half of a key, they re-issue
 * against that key, and removal retires it. Certificates accumulate under a
 * key — one per issuance, newest first — so each row shows the key's
 * fingerprint (the identifier that matches the file on the member's own
 * machine), when the key was stored, and every certificate issued from it.
 * Both actions address the KEY: `reissue(key.id)` and `remove(key.id)`.
 * Nothing here can address a certificate directly, because a serial changes on
 * every re-issue and therefore cannot name the thing a member holds.
 *
 * THREE THINGS THIS SURFACE DELIBERATELY DOES DIFFERENTLY.
 *
 * 1. The private key is a DOWNLOAD, never a clipboard copy. The neighbouring
 *    show-once pattern (`integrations/TokenReveal`) copies a 15-minute bot
 *    token, which is proportionate: the blast radius is one credential that
 *    expires before it can be pasted anywhere dangerous. A long-lived private
 *    key is not. Clipboard history, a synced clipboard, and a paste into the
 *    wrong window all retain it, and the member cannot see any of that
 *    happen. So the key arrives as a file named `id_ed25519`, the object URL
 *    behind it is revoked in the same tick, and the copy states plainly that
 *    the file is unencrypted, that it — not the certificate — is the
 *    long-lived half, and that a new certificate can always be re-issued for
 *    it (R6) while a leaked key cannot be un-leaked (R5a is the only lever).
 *
 * 2. The certificate is downloaded as `id_ed25519-cert.pub`. The basename
 *    pairing is load-bearing: `ssh` looks for `<private>-cert.pub` beside the
 *    key it was given, so a certificate named anything else is presented as a
 *    bare public key and refused.
 *
 * 3. A removed key's row disappears from the list. R5a says removal stops
 *    further issuance and authentication, so the row is not a credential and
 *    not an affordance — rendering it beside live ones would offer the member
 *    a control that cannot work. The server stops returning it, and the
 *    controller drops it from state the moment the delete succeeds. Superseded
 *    CERTIFICATES stay under their key, marked, because "replaced" is a state
 *    the member can act on (re-issue again); see `certificateState`.
 *
 * KEY MATERIAL RULES honoured here: nothing loads a third-party script,
 * nothing reports anything (no analytics, no logger, no error reporter), and
 * no key text ever reaches a URL, a query string, browser history, or any
 * storage. The private key lives in this component's state and nowhere else.
 */

import { useState } from 'react';

import { ApiError } from '@cytale/api-client';

import { StateBanner } from '../../app/ui/StateBanner.js';
import { PaneEmpty, PaneErrorBanner, PaneSkeleton } from '../../app/ui/PaneStates.js';
import { formatDateTime } from '../../app/ui/time.js';
import { useOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { InlineConfirm } from './InlineConfirm.js';
import { copyToClipboard } from './clipboard.js';

import {
  CERTIFICATE_FILENAME,
  PRIVATE_KEY_FILENAME,
  describePublicKeyLineProblem,
  generateEd25519Keypair,
  type GeneratedEd25519Keypair,
} from '../ssh/keygen.js';
import {
  certificateState,
  keyIsLive,
  sshCertificates,
  type SshCertificate,
  type SshCertificatesClient,
  type SshIssuedCertificate,
} from '../ssh/certificates.js';
import { KeyInstallInstructions } from '../ssh/KeyInstallInstructions.js';
import { useSshCertificates } from '../ssh/useSshCertificates.js';
import { HOSTED_ORIGIN, configuredOrigin } from '../../app/origin.js';

/** The one published SSH port (R29). The deploy notes own the value. */
const DEFAULT_SSH_PORT = 2222;

/**
 * The SSH service is deployed beside the app (one Compose stack, one edge),
 * so the host that served this page is the host to SSH to. The origin is
 * resolved the same way the API client resolves it — a packaged Tauri shell
 * has a `tauri://` location, so `configuredOrigin()` is consulted first. With
 * neither available, the documented hosted deployment is used rather than a
 * placeholder the member might copy verbatim.
 */
function defaultSshHost(): string {
  const origin =
    configuredOrigin() ?? (globalThis.location as Location | undefined)?.origin ?? '';
  try {
    const hostname = new URL(origin).hostname;
    if (hostname !== '') return hostname;
  } catch {
    // No usable origin (a bare test environment) — fall through.
  }
  if (HOSTED_ORIGIN === undefined) return '';
  try {
    return new URL(HOSTED_ORIGIN).hostname;
  } catch {
    return HOSTED_ORIGIN;
  }
}

/**
 * Hand text to the browser as a download and forget the staging URL in the
 * same tick.
 *
 * The URL is revoked immediately, not on unmount: a blob URL is readable by
 * anything that can run in this origin (an extension, a devtools session, a
 * leftover tab) for as long as it is alive, and its one job is to survive the
 * click that starts the download.
 */
function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Actionable copy for a failed mutation — the server's own words when it has them. */
function mutationMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) {
      return `Your account is not permitted to manage SSH keys (${error.key}). ${error.message}`;
    }
    return error.message;
  }
  if (error instanceof Error && error.message !== '') return error.message;
  return fallback;
}

export interface SshSectionProps {
  /**
   * The member's Cytale username. It is the certificate's sole principal
   * (R4/KTD3), so it is also the `ssh -l` login name the instructions must
   * state — not their account id.
   */
  username: string;
  /** The host the SSH service answers on; defaults to the served host. */
  host?: string;
  /** The published SSH port; defaults to the deploy default (2222). */
  port?: number;
  /** Injected in tests; defaults to the session-backed client. */
  client?: SshCertificatesClient;
  /** Injected in tests; defaults to the live navigator status. */
  online?: boolean;
}

const primaryButton =
  'min-h-10 rounded-md bg-accent px-4 py-2 text-sm font-medium text-text-onaccent transition-[filter] duration-[var(--duration-control)] hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

const subtleButton =
  'min-h-9 rounded-md border border-line bg-surface-strong px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)] disabled:cursor-not-allowed disabled:opacity-50';

/**
 * `Expires <stamp>` / `Expired <stamp>` for an expiry the server reported, and
 * an outright statement when it reported none — a blank cell would read as
 * "no expiry", which is the opposite of the truth (R5).
 */
function describeExpiry(certificate: SshCertificate): string {
  if (certificate.valid_before === null) return 'Expiry not reported by the server';
  const stamp = formatDateTime(certificate.valid_before);
  return certificateState(certificate) === 'expired'
    ? `Expired ${stamp}`
    : `Expires ${stamp}`;
}

const STATE_BADGE: Record<ReturnType<typeof certificateState>, string | null> = {
  current: null,
  expired: 'Expired',
  superseded: 'Superseded',
};

export function SshSection({
  username,
  host = defaultSshHost(),
  port = DEFAULT_SSH_PORT,
  client = sshCertificates,
  online,
}: SshSectionProps) {
  const liveOnline = useOnlineStatus();
  const isOnline = online ?? liveOnline;

  const { keys, loadState, permissionDenied, reload, issue, reissue, remove } =
    useSshCertificates(client);

  const [generated, setGenerated] = useState<GeneratedEd25519Keypair | null>(null);
  const [generating, setGenerating] = useState(false);
  const [keygenError, setKeygenError] = useState<string | null>(null);
  const [publicKeyInput, setPublicKeyInput] = useState('');
  const [pasteProblem, setPasteProblem] = useState<string | null>(null);
  const [issuing, setIssuing] = useState(false);
  const [issueError, setIssueError] = useState<string | null>(null);
  const [issued, setIssued] = useState<SshIssuedCertificate | null>(null);
  const [pendingKeyId, setPendingKeyId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const [publicKeyCopied, setPublicKeyCopied] = useState(false);

  async function handleGenerate(): Promise<void> {
    setGenerating(true);
    setKeygenError(null);
    setPublicKeyCopied(false);
    try {
      const pair = await generateEd25519Keypair();
      setGenerated(pair);
      // The private key is delivered here and nowhere else: R1's "exactly
      // once" is this download, and the button that can repeat it lives only
      // while this pane is mounted (below).
      downloadText(PRIVATE_KEY_FILENAME, pair.privateKey);
      // Pre-fill the submit field with the matching public half, so the
      // member's next action is Get a certificate rather than a copy-paste.
      setPublicKeyInput(pair.publicKeyLine);
      setPasteProblem(null);
      setIssued(null);
      setIssueError(null);
    } catch (error) {
      setKeygenError(
        error instanceof Error && error.message !== ''
          ? error.message
          : 'Could not generate a keypair in this browser.',
      );
    } finally {
      setGenerating(false);
    }
  }

  async function handleIssue(): Promise<void> {
    const problem = describePublicKeyLineProblem(publicKeyInput);
    if (problem !== null) {
      // Caught locally: an actionable sentence beats a round trip that comes
      // back as an opaque refusal.
      setPasteProblem(problem);
      return;
    }
    setPasteProblem(null);
    setIssuing(true);
    setIssueError(null);
    try {
      const result = await issue(publicKeyInput.trim());
      setIssued(result);
      downloadText(CERTIFICATE_FILENAME, result.certificate);
    } catch (error) {
      setIssueError(
        mutationMessage(error, 'Could not reach the server to issue a certificate.'),
      );
    } finally {
      setIssuing(false);
    }
  }

  async function handleReissue(keyId: string): Promise<void> {
    setPendingKeyId(keyId);
    setRowError(null);
    try {
      // No public key is sent: R6 is exactly this — the stored key is named by
      // its own id, and the server reads the public half back off the caller's
      // account, so nothing has to be pasted again and a key id belonging to
      // somebody else cannot be named at all.
      const result = await reissue(keyId);
      setIssued(result);
      downloadText(CERTIFICATE_FILENAME, result.certificate);
    } catch (error) {
      setRowError(mutationMessage(error, 'Could not re-issue a certificate for that key.'));
    } finally {
      setPendingKeyId(null);
    }
  }

  async function handleRemove(keyId: string): Promise<void> {
    setPendingKeyId(keyId);
    setRowError(null);
    try {
      await remove(keyId);
      // A certificate belonging to the retired key is no longer something the
      // member can act on, so retire the panel with the row.
      setIssued(null);
    } catch (error) {
      setRowError(mutationMessage(error, 'Could not remove that key.'));
    } finally {
      setPendingKeyId(null);
    }
  }

  return (
    <div className="flex flex-col gap-8" data-testid="ssh-section">
      <p className="text-sm text-text-muted">
        Reach your workspaces from a terminal. A Hrmny host authenticates an SSH certificate
        instead of a password, and the certificate is issued here, in your browser — your private
        key never leaves your machine.
      </p>

      {!isOnline ? (
        <StateBanner tone="warning" testId="ssh-offline">
          You are offline — generating keys and issuing certificates are disabled until the
          connection returns. Your existing key and certificate keep working.
        </StateBanner>
      ) : null}

      {/* -- 1. the keypair (R1) -------------------------------------------- */}
      <section aria-labelledby="ssh-keypair-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="ssh-keypair-heading" className="text-sm font-bold uppercase tracking-wide text-text-muted">
            Your key
          </h2>
          <p className="text-sm text-text-muted">
            Generate a keypair here, or use one you already have — either way the public half is
            what you paste below, and the private half never leaves this machine.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={primaryButton}
            data-testid="ssh-generate"
            disabled={!isOnline || generating}
            aria-busy={generating || undefined}
            onClick={() => void handleGenerate()}
          >
            {generating ? 'Generating…' : generated === null ? 'Generate a keypair' : 'Generate another keypair'}
          </button>
          {generated !== null ? (
            <button
              type="button"
              className={subtleButton}
              data-testid="ssh-save-private-key"
              onClick={() => downloadText(PRIVATE_KEY_FILENAME, generated.privateKey)}
            >
              Save {PRIVATE_KEY_FILENAME} again
            </button>
          ) : null}
        </div>

        {keygenError !== null ? (
          <StateBanner tone="danger" testId="ssh-keygen-error">
            {keygenError}
          </StateBanner>
        ) : null}

        {generated !== null ? (
          <div className="flex flex-col gap-3" data-testid="ssh-key-material">
            <StateBanner tone="danger" testId="ssh-private-key-warning">
              <strong className="font-semibold">
                {PRIVATE_KEY_FILENAME} is now in your downloads, and it is shown once.
              </strong>{' '}
              It is an <strong className="font-semibold">unencrypted private key</strong>: anyone
              who reads that file can use it. It is the long-lived half of the pair — the
              certificate expires in 24 hours and is the disposable half, which is why re-issuing
              one is always available below. Do not copy it into a chat, a paste site, a password
              manager note, or any other place a file was not asked for. Removing the stored public
              key below is the only way to stop it working.
            </StateBanner>

            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="ssh-generated-public-key"
                className="text-sm font-medium text-text-primary"
              >
                Your public key — paste this below
              </label>
              <textarea
                id="ssh-generated-public-key"
                readOnly
                rows={2}
                value={generated.publicKeyLine}
                data-testid="ssh-generated-public-key-value"
                onFocus={(event) => event.currentTarget.select()}
                className="w-full resize-none rounded-md border border-line bg-surface-strong px-3 py-2 font-mono text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
              />
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className={subtleButton}
                  aria-live="polite"
                  data-testid="ssh-generated-public-key-copy"
                  onClick={() => {
                    void copyToClipboard(generated.publicKeyLine).then((ok) => {
                      if (ok) setPublicKeyCopied(true);
                    });
                  }}
                >
                  {publicKeyCopied ? 'Copied!' : 'Copy public key'}
                </button>
                <span className="text-xs text-text-muted" data-testid="ssh-generated-fingerprint">
                  Fingerprint {generated.fingerprint}
                </span>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      {/* -- 2. issue a certificate (R2) ------------------------------------ */}
      <section aria-labelledby="ssh-issue-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="ssh-issue-heading" className="text-sm font-bold uppercase tracking-wide text-text-muted">
            Get a certificate
          </h2>
          <p className="text-sm text-text-muted">
            The certificate is signed for your username and lasts 24 hours. It arrives as{' '}
            <span className="font-mono">{CERTIFICATE_FILENAME}</span> — that name matters, because
            it is how <span className="font-mono">ssh</span> finds the certificate that belongs to
            your key. If your key is named something else, rename the certificate the same way
            (<span className="font-mono">&lt;keyname&gt;-cert.pub</span>).
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="ssh-public-key-input" className="text-sm font-medium text-text-primary">
            Public key
          </label>
          <textarea
            id="ssh-public-key-input"
            rows={3}
            value={publicKeyInput}
            spellCheck={false}
            placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA… you@laptop"
            data-testid="ssh-public-key-input"
            onChange={(event) => {
              setPublicKeyInput(event.target.value);
              if (pasteProblem !== null) setPasteProblem(null);
            }}
            aria-invalid={pasteProblem !== null || undefined}
            aria-describedby={pasteProblem === null ? undefined : 'ssh-public-key-problem'}
            className="w-full resize-none rounded-md border border-line bg-surface px-3 py-2 font-mono text-xs text-text-primary placeholder:text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={primaryButton}
            data-testid="ssh-issue"
            disabled={!isOnline || issuing}
            aria-busy={issuing || undefined}
            onClick={() => void handleIssue()}
          >
            {issuing ? 'Issuing…' : 'Get a certificate'}
          </button>
        </div>

        {pasteProblem !== null ? (
          <StateBanner tone="danger" testId="ssh-public-key-problem">
            {pasteProblem}
          </StateBanner>
        ) : null}

        {issueError !== null ? (
          <StateBanner tone="danger" testId="ssh-issue-error">
            {issueError}
          </StateBanner>
        ) : null}

        {issued !== null ? (
          <div
            className="flex flex-col gap-2 rounded-md border border-line bg-surface px-4 py-3"
            data-testid="ssh-certificate-issued"
          >
            <p className="text-sm text-text-primary">
              Certificate <span className="font-mono">{issued.serial}</span> issued — it expires{' '}
              {issued.valid_before === null
                ? 'in 24 hours'
                : formatDateTime(issued.valid_before)}
              .
            </p>
            {issued.fingerprint !== '' ? (
              <p className="text-xs text-text-muted" data-testid="ssh-certificate-issued-fingerprint">
                Key fingerprint {issued.fingerprint}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={subtleButton}
                data-testid="ssh-save-certificate"
                onClick={() => downloadText(CERTIFICATE_FILENAME, issued.certificate)}
              >
                Save {CERTIFICATE_FILENAME} again
              </button>
              <span className="text-xs text-text-muted">
                Shown once — this button lives only while this page is open.
              </span>
            </div>
          </div>
        ) : null}
      </section>

      {/* -- 3. install instructions (step 3) ------------------------------- */}
      <section aria-labelledby="ssh-install-heading" className="flex flex-col gap-3">
        <h2 id="ssh-install-heading" className="text-sm font-bold uppercase tracking-wide text-text-muted">
          Install it
        </h2>
        <KeyInstallInstructions username={username} host={host} port={port} />
      </section>

      {/* -- 4. the member's keys and their certificates (R5, R5a, R6) ------ */}
      <section aria-labelledby="ssh-keys-heading" className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          <h2 id="ssh-keys-heading" className="text-sm font-bold uppercase tracking-wide text-text-muted">
            Your keys
          </h2>
          <p className="text-sm text-text-muted">
            Each row is a public key the server holds for you — identified by the fingerprint of
            its public half, which is how you match it to the private key file on your own machine.
            Under each key are the certificates issued from it. Re-issue gives the key a fresh 24
            hours without pasting anything; removing the key stops further certificates and further
            logins with it.
          </p>
        </div>

        {rowError !== null ? (
          <StateBanner tone="danger" testId="ssh-row-error">
            {rowError}
          </StateBanner>
        ) : null}

        {loadState.kind === 'loading' ? (
          <PaneSkeleton label="Loading your SSH keys" testId="ssh-loading" />
        ) : null}

        {loadState.kind === 'error' ? (
          <PaneErrorBanner
            testId="ssh-error"
            retryTestId="ssh-retry"
            message={loadState.message}
            onRetry={reload}
          />
        ) : null}

        {loadState.kind === 'ready' && permissionDenied !== null ? (
          <StateBanner tone="danger" testId="ssh-permission-denied">
            Your account is not permitted to manage SSH keys here ({permissionDenied.key}).{' '}
            {permissionDenied.message}
          </StateBanner>
        ) : null}

        {loadState.kind === 'ready' && permissionDenied === null && keys.length === 0 ? (
          <PaneEmpty
            title="No stored keys"
            hint="Paste a public key above and issue a certificate — the key is stored on your account, so you can re-issue against it for as long as you keep it."
            testId="ssh-empty"
          />
        ) : null}

        {loadState.kind === 'ready' && permissionDenied === null && keys.length > 0 ? (
          <ul className="flex flex-col gap-2" data-testid="ssh-key-list">
            {keys.map((key) => {
              const busy = pendingKeyId === key.id;
              const live = keyIsLive(key);
              return (
                <li
                  key={key.id}
                  data-testid={`ssh-key-row-${key.id}`}
                  data-state={live ? 'current' : 'stale'}
                  className="flex flex-col gap-3 rounded-md border border-line bg-surface px-4 py-3"
                >
                  {/* The fingerprint leads: it is the only thing on this row a
                      member can compare against the key file they hold. */}
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="text-sm font-medium text-text-primary">
                        Key fingerprint
                      </span>
                      <span
                        className="break-all font-mono text-sm text-text-primary"
                        data-testid={`ssh-key-fingerprint-${key.id}`}
                      >
                        {key.fingerprint === ''
                          ? 'Fingerprint not reported by the server'
                          : key.fingerprint}
                      </span>
                    </div>
                    <p className="text-xs text-text-muted" data-testid={`ssh-key-created-${key.id}`}>
                      {key.created_at === null
                        ? 'Added at a time the server did not report'
                        : `Added ${formatDateTime(key.created_at)}`}
                    </p>
                  </div>

                  {key.certificates.length === 0 ? (
                    <p
                      className="text-sm text-text-muted"
                      data-testid={`ssh-key-no-certificates-${key.id}`}
                    >
                      No certificate on record for this key — re-issue one below.
                    </p>
                  ) : (
                    <ul
                      className="flex flex-col gap-1.5"
                      data-testid={`ssh-key-certificates-${key.id}`}
                    >
                      {key.certificates.map((certificate) => {
                        const state = certificateState(certificate);
                        const badge = STATE_BADGE[state];
                        return (
                          <li
                            key={certificate.serial}
                            data-testid={`ssh-certificate-${certificate.serial}`}
                            data-state={state}
                            className="flex flex-wrap items-center gap-2"
                          >
                            <span className="font-mono text-xs text-text-muted">
                              {certificate.serial}
                            </span>
                            {badge !== null ? (
                              <span
                                data-testid={`ssh-certificate-badge-${certificate.serial}`}
                                className={
                                  state === 'expired'
                                    ? 'rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning'
                                    : 'rounded-full border border-line bg-surface-strong px-2 py-0.5 text-xs text-text-muted'
                                }
                              >
                                {badge}
                              </span>
                            ) : null}
                            <span
                              className="text-sm text-text-primary"
                              data-testid={`ssh-certificate-expiry-${certificate.serial}`}
                            >
                              {describeExpiry(certificate)}
                            </span>
                          </li>
                        );
                      })}
                    </ul>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      className={subtleButton}
                      data-testid={`ssh-reissue-${key.id}`}
                      disabled={!isOnline || busy}
                      onClick={() => void handleReissue(key.id)}
                    >
                      {busy ? 'Working…' : 'Re-issue'}
                    </button>
                    <InlineConfirm
                      label="Remove key"
                      confirmLabel="Remove key"
                      tone="danger"
                      disabled={!isOnline || busy}
                      disabledReason="Unavailable while offline."
                      consequence="Stops further certificates for this key and refuses logins that use it. The private key file on your machine keeps existing."
                      testId={`ssh-remove-${key.id}`}
                      onConfirm={() => void handleRemove(key.id)}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </section>
    </div>
  );
}
