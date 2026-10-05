/**
 * @cytale/web — SSH key + certificate install instructions (U3 step 3).
 *
 * The failure this component exists to prevent is the quiet one: a key that
 * was downloaded correctly, moved into place with the wrong permissions, and
 * then refused by OpenSSH with `Permissions 0644 for '~/.ssh/id_ed25519' are
 * too open`. The member has no way to tell that apart from a broken
 * certificate, so every rule that makes the pair work is stated here rather
 * than assumed:
 *
 *   - the target directory (`~/.ssh`) and the required `chmod 600`;
 *   - that OpenSSH refuses a group- or world-readable key (so "it works after
 *     chmod" is explained, not cargo-culted);
 *   - the login name, filled in with the member's ACTUAL username — the
 *     certificate's principal is the username (KTD3), so `ssh host` presents
 *     the local username, fails the principal check, and reads as "my
 *     certificate is broken" to anyone who does not know that;
 *   - a `~/.ssh/config` alias, so the login name is not something the member
 *     has to remember at all.
 *
 * Both blocks are copyable, because the alternative is transcription errors in
 * a `chmod` mode. Nothing here is secret: the private key itself is delivered
 * as a download and is deliberately NOT copyable (see SshSection).
 *
 * `ssh -l <username>` is used rather than the `user@host` form: the local
 * username on macOS is very often the same string as the member's Cytale
 * username, which makes `user@host` look like it should work while actually
 * working by accident, and look like the *server* is broken when it does not.
 */

import { useState } from 'react';

import { copyToClipboard } from '../settings/clipboard.js';

export interface KeyInstallInstructionsProps {
  /**
   * The member's Cytale username. It is the certificate's sole principal
   * (R4/`KTD3`), so it is also the SSH login name — not their account id.
   */
  username: string;
  /** The host the SSH service answers on (the deploy notes own the value). */
  host: string;
  /** The one published SSH port (R29). */
  port: number;
  testId?: string;
}

interface CopyableBlockProps {
  title: string;
  /** Announced on the scrollable region, which is keyboard-reachable. */
  label: string;
  text: string;
  testId: string;
}

/** A `<pre>` the member copies verbatim: keyboard-scrollable and announced. */
function CopyableBlock({ title, label, text, testId }: CopyableBlockProps) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex flex-col gap-1.5" data-testid={`${testId}-block`}>
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium text-text-primary">{title}</h3>
        <button
          type="button"
          aria-live="polite"
          data-testid={`${testId}-copy`}
          onClick={() => {
            void copyToClipboard(text).then((ok) => {
              if (ok) setCopied(true);
            });
          }}
          className="min-h-9 shrink-0 rounded-md border border-line px-3 py-1.5 text-sm font-medium text-text transition-colors duration-[var(--duration-control)] hover:bg-surface-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre
        role="region"
        aria-label={label}
        tabIndex={0}
        data-testid={`${testId}-code`}
        className="overflow-x-auto rounded-md border border-line bg-surface-strong px-3 py-2.5 font-mono text-xs leading-relaxed text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]"
      >
        {text}
      </pre>
    </div>
  );
}

export function KeyInstallInstructions({
  username,
  host,
  port,
  testId = 'ssh-install',
}: KeyInstallInstructionsProps) {
  const install = [
    '# Put both files in ~/.ssh, keeping the shared basename:',
    '#   id_ed25519          the private key',
    '#   id_ed25519-cert.pub the certificate',
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    'mv ~/Downloads/id_ed25519 ~/Downloads/id_ed25519-cert.pub ~/.ssh/',
    '',
    '# OpenSSH refuses a group- or world-readable key ("are too open"),',
    '# and it will not present the certificate if the key is rejected first.',
    'chmod 600 ~/.ssh/id_ed25519',
    'chmod 644 ~/.ssh/id_ed25519-cert.pub',
    '',
    `# -l is the login name: it must be your Hrmny username, ${username}.`,
    `ssh -l ${username} -p ${port} ${host}`,
  ].join('\n');

  const alias = [
    `Host cytale`,
    `  HostName ${host}`,
    `  Port ${port}`,
    `  User ${username}`,
    `  IdentityFile ~/.ssh/id_ed25519`,
    `  CertificateFile ~/.ssh/id_ed25519-cert.pub`,
  ].join('\n');

  return (
    <div className="flex flex-col gap-4" data-testid={testId}>
      <p className="text-sm text-text-muted">
        Your certificate names you as <span className="font-mono text-text">{username}</span>, so
        that is the login name to use — not your account id, and not whatever your laptop calls you.
        The certificate lives for 24 hours; the key does not, so keep it and re-issue when it lapses.
      </p>

      <CopyableBlock
        title="Install the key and certificate"
        label="Install commands"
        text={install}
        testId={`${testId}-install`}
      />

      <CopyableBlock
        title="Give the host a name (optional)"
        label="SSH config alias"
        text={alias}
        testId={`${testId}-alias`}
      />

      <p className="text-xs text-text-muted">
        Add that alias to <span className="font-mono">~/.ssh/config</span> and plain{' '}
        <span className="font-mono">ssh cytale</span> works — the login name, the port and the
        certificate are all handled for you. The certificate is found automatically because it sits
        beside the key with that exact name; renaming either file breaks the pairing.
      </p>
    </div>
  );
}
