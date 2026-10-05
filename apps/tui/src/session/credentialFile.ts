/**
 * @cytale/tui — the local-mode credential file (U9).
 *
 * ---------------------------------------------------------------------------
 * Why this file exists at all, and why it is not the SSH path
 * ---------------------------------------------------------------------------
 *
 * R27 — "the client keeps no Cytale token on disk in SSH mode" — is scoped to
 * SSH mode, and it holds there by construction (`session/tokenSource.ts` has an
 * adapter with no sink). This is the OTHER mode: the member ran the client
 * themselves against a server they named on the command line (R14), typed their
 * own password into it, and expects to not type it again. That expectation is
 * why `createCredentialFile` takes `mode: 'local'` as a REQUIRED literal: the
 * type system refuses to build this adapter for an SSH-mode client, so no future
 * refactor can quietly hand a host-minted token a disk to live on.
 *
 * ---------------------------------------------------------------------------
 * The file: where, what shape, and what mode
 * ---------------------------------------------------------------------------
 *
 *   $XDG_CONFIG_HOME/cytale/credentials.json   (default ~/.config/cytale/)
 *
 * A relative `XDG_CONFIG_HOME` is ignored — the XDG spec requires absolute, and
 * resolving it against the process's own cwd would put a credential somewhere
 * the member did not choose. `USERPROFILE` covers shells that set no `HOME`.
 *
 * The directory is created 0o700 and the file is created 0o600 (owner-only,
 * asserted by this unit's tests and by the plan's DoD). The mode is set three
 * ways on purpose, because each covers a different hole: at creation (so the
 * file never exists with looser bits), by `fchmod` (the `open` mode is masked by
 * the process umask, so a umask of 0o077 would otherwise make the file
 * unreadable to its own owner), and by writing through a temp file in the same
 * 0o700 directory plus a rename (so a crash mid-write cannot leave a truncated
 * or half-permissioned credential behind, and no window exists where the
 * content is on a loosely-permissioned path).
 *
 * The content is the JSON of one object:
 *
 *   { "origin": "https://chat.example.com", "accessToken": "…", "refreshToken": "…" }
 *
 * The ORIGIN is stored so a saved session can only ever be replayed at the
 * server it was minted for — the reason a second run against a different URL
 * asks for a password instead of posting another server's refresh token.
 *
 * There is deliberately no format version field: this file has exactly one
 * writer (this adapter) and no migration logic exists to read an older shape, so
 * a version field would be a field nothing checks. An unknown shape is treated
 * as corrupt, which is the documented and tested behaviour below.
 *
 * ---------------------------------------------------------------------------
 * Lifecycle
 * ---------------------------------------------------------------------------
 *
 *   * **Reused** — `SessionManager.restore()` awaits `hydrate()` and then reads
 *     the pair through the storage contract, so the member's second run
 *     exchanges the stored refresh token without a prompt.
 *   * **Refreshed** — every rotation the session performs (a cold-launch
 *     exchange, a 401 rescue) is written straight back, so the file tracks the
 *     live pair rather than the pair from the first sign-in.
 *   * **Cleared** — `write(null)` removes the file. That is the path
 *     `SessionManager.logout()`/`reset()` take, so a sign-out does not leave a
 *     live credential behind.
 *   * **Discarded** — a file that cannot be read, cannot be parsed, or is not
 *     this shape is NOT adopted and is removed, with a report naming the reason
 *     (`discarded.reason`, the code and message). The alternative — refusing to
 *     start — turns one bad byte into a client that cannot be used.
 *   * **Left alone** — a file belonging to a DIFFERENT origin is neither adopted
 *     nor removed: it is not corrupt, it is someone else's. A run that is
 *     abandoned, or that fails to sign in, therefore leaves that server's saved
 *     session exactly as it was. There is one saved session per client (the
 *     plan's single-server V1 scope), so a successful sign-in for the origin
 *     this adapter was built for DOES replace it — which is why the caller is
 *     told about the mismatch before it prompts.
 *   * **Stale** — a pair the server no longer accepts: `SessionManager.restore()`
 *     tears the dead session down and resets the auth store, and that reset
 *     persists `null` — i.e. `write(null)`, which removes the file. So a dead
 *     credential is cleared rather than retried on every later run, and `found`
 *     (recorded when the file was read) is what lets the caller say "no longer
 *     valid" instead of letting the prompt look like a first run.
 *
 * A failing backend never breaks the session: `write` records the failure in
 * `diagnostics().lastWriteError` and the in-memory pair keeps working, exactly
 * as `packages/session/src/tokenStorage.ts` documents for localStorage failures.
 * An unwritable target is detected up front (`writable`) so the login surface can
 * tell the member before asking them for a password, not after.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { StoredTokenPair, TokenStorage } from '@cytale/session';

/** The directory holding the credential file is owner-only. */
export const CREDENTIAL_DIR_MODE = 0o700;
/** The credential file itself is owner-only (the plan's DoD asserts this). */
export const CREDENTIAL_FILE_MODE = 0o600;
/** The file's basename under the `cytale` config directory. */
export const CREDENTIAL_FILE_NAME = 'credentials.json';

/** The environment this adapter resolves its path from. */
export type CredentialEnv = Record<string, string | undefined>;

/** A filesystem refusal, reduced to what a member can be told. */
export interface FileFailure {
  readonly code: string;
  readonly message: string;
}

/** Why a stored credential was not adopted. */
export interface DiscardReport {
  readonly reason: 'unreadable' | 'unparsable' | 'malformed';
  /** `code: message`, or the parse complaint — a detail line, not a story. */
  readonly detail: string;
  /** True when the file was removed (a read-only or permission refusal is not). */
  readonly removed: boolean;
}

/** Everything this adapter can say about the file it was pointed at. */
export interface CredentialFileDiagnostics {
  readonly path: string;
  /** The up-front probe result: a directory this adapter can create and write. */
  readonly writable: boolean;
  readonly unwritable: FileFailure | null;
  /** A credential for THIS origin was read from the file (not necessarily live). */
  readonly found: boolean;
  readonly discarded: DiscardReport | null;
  /** The origin of the file's credential, when it belongs to another server. */
  readonly otherOrigin: string | null;
  readonly lastWriteError: FileFailure | null;
}

export interface CredentialFile extends TokenStorage {
  readonly path: string;
  /** The origin this file's credential is scoped to. */
  readonly origin: string;
  /**
   * Fill the synchronous read mirror from the file. Required rather than
   * optional (the package's contract marks it optional for adapters that need
   * no loading): this adapter always reads a file, and `SessionManager.restore()`
   * awaits it before the cold-launch exchange.
   */
  hydrate(): Promise<void>;
  /** Always present: writes are synchronous, so there is never a queue. */
  flush(): Promise<void>;
  diagnostics(): CredentialFileDiagnostics;
}

export interface CredentialFileOptions {
  /**
   * The client mode that owns this file. `'local'` only, and required: R27
   * forbids a Cytale token on disk in SSH mode, so an SSH-mode caller cannot
   * even name this adapter. See the header.
   */
  readonly mode: 'local';
  /** Defaults to `process.env`; injected so a suite never touches a real HOME. */
  readonly env?: CredentialEnv;
  /** Test seam: an exact path instead of one resolved from the environment. */
  readonly path?: string;
  /** The server this credential belongs to. Stored, and enforced on adoption. */
  readonly origin: string;
}

/**
 * The credential file's path: `$XDG_CONFIG_HOME/cytale/credentials.json`,
 * defaulting to `$HOME/.config/cytale/credentials.json`.
 */
export function credentialFilePath(env: CredentialEnv = process.env): string {
  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg !== undefined && xdg.trim() !== '' && path.isAbsolute(xdg)
      ? xdg
      : path.join(homeDirectory(env), '.config');
  return path.join(base, 'cytale', CREDENTIAL_FILE_NAME);
}

function homeDirectory(env: CredentialEnv): string {
  const home = env.HOME ?? env.USERPROFILE;
  if (home !== undefined && home.trim() !== '') return home;
  return os.homedir();
}

/**
 * The credential-file storage adapter (KTD4's contract, the terminal's
 * implementation): a synchronous read from an in-memory mirror that `hydrate()`
 * fills, and a write that lands owner-only or records why it could not.
 */
export function createCredentialFile(options: CredentialFileOptions): CredentialFile {
  const target = options.path ?? credentialFilePath(options.env ?? process.env);
  const origin = options.origin;

  let mirror: StoredTokenPair | null = null;
  let found = false;
  let discarded: DiscardReport | null = null;
  let otherOrigin: string | null = null;
  let lastWriteError: FileFailure | null = null;

  const unwritable = probeTarget(target);

  const remove = (): boolean => {
    try {
      fs.unlinkSync(target);
      return true;
    } catch {
      // Already gone, or a directory/attribute refuses the unlink: either way
      // the file was not adopted, which is what the report has to convey.
      return false;
    }
  };

  return {
    path: target,
    origin,

    read() {
      return mirror === null ? null : { ...mirror };
    },

    async hydrate() {
      found = false;
      discarded = null;
      otherOrigin = null;
      mirror = null;

      let raw: string;
      try {
        raw = fs.readFileSync(target, 'utf8');
      } catch (err) {
        // No file yet is the empty state, and the overwhelmingly common one.
        // ENOTDIR is the same fact for an unwritable target whose directory
        // could never be created: there is no credential here, which the
        // `writable` probe reports as the actionable problem — not this read.
        const code = failureOf(err).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return;
        discarded = { reason: 'unreadable', detail: describeFailure(err), removed: remove() };
        return;
      }

      const parsed = parseCredentialFile(raw, origin);
      switch (parsed.kind) {
        case 'empty':
          return;
        case 'unparsable':
          discarded = { reason: 'unparsable', detail: parsed.detail, removed: remove() };
          return;
        case 'malformed':
          discarded = { reason: 'malformed', detail: parsed.detail, removed: remove() };
          return;
        case 'other-origin':
          otherOrigin = parsed.origin;
          return;
        case 'pair':
          mirror = parsed.pair;
          found = true;
          return;
      }
    },

    write(pair: StoredTokenPair | null) {
      // Empty means absent (the contract's normalization), so a restore()'s
      // seed of `accessToken: ''` never writes an empty string as a token.
      const normalized = normalize(pair);
      mirror = normalized;

      if (normalized === null) {
        remove();
        return;
      }

      const body = `${JSON.stringify({ origin, ...normalized }, null, 2)}\n`;
      try {
        writeAtomically(target, body);
        lastWriteError = null;
      } catch (err) {
        lastWriteError = failureOf(err);
      }
    },

    flush() {
      // Writes are synchronous: by the time write() returns, the pair is on
      // disk or the failure is recorded. There is nothing queued to settle.
      return Promise.resolve();
    },

    diagnostics() {
      return {
        path: target,
        writable: unwritable === null,
        unwritable,
        found,
        discarded,
        otherOrigin,
        lastWriteError,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------

type Parsed =
  | { readonly kind: 'empty' }
  | { readonly kind: 'unparsable'; readonly detail: string }
  | { readonly kind: 'malformed'; readonly detail: string }
  | { readonly kind: 'other-origin'; readonly origin: string }
  | { readonly kind: 'pair'; readonly pair: StoredTokenPair };

/**
 * Read one file's worth of credential, without ever throwing: this runs on the
 * launch path, and a garbage byte must not become a crash.
 */
function parseCredentialFile(raw: string, origin: string): Parsed {
  if (raw.trim() === '') return { kind: 'empty' };

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { kind: 'unparsable', detail: describeFailure(err) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'malformed', detail: 'the file does not hold a credential object' };
  }

  const record = value as Record<string, unknown>;
  const fileOrigin = record.origin;
  if (typeof fileOrigin !== 'string' || fileOrigin === '') {
    return { kind: 'malformed', detail: 'the credential names no server' };
  }
  for (const key of ['accessToken', 'refreshToken']) {
    const token = record[key];
    if (token !== undefined && token !== null && typeof token !== 'string') {
      return { kind: 'malformed', detail: `${key} is not a token string` };
    }
  }

  const pair = normalize({
    accessToken: (record.accessToken as string | null | undefined) ?? null,
    refreshToken: (record.refreshToken as string | null | undefined) ?? null,
  });
  if (pair === null) return { kind: 'empty' };
  if (fileOrigin !== origin) return { kind: 'other-origin', origin: fileOrigin };
  return { kind: 'pair', pair };
}

/** An empty-string token is absent, as `packages/session`'s contract states. */
function normalize(pair: StoredTokenPair | null): StoredTokenPair | null {
  if (pair === null) return null;
  const accessToken = nonEmpty(pair.accessToken);
  const refreshToken = nonEmpty(pair.refreshToken);
  if (accessToken === null && refreshToken === null) return null;
  return { accessToken, refreshToken };
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Create the directory and prove it can take a file, without leaving anything
 * behind. `mkdir` alone is not enough — a directory can exist and still refuse
 * a write (a read-only mount, a full filesystem, an ACL) — so the probe opens
 * the target itself, which is also the operation the first real write performs.
 */
function probeTarget(target: string): FileFailure | null {
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: CREDENTIAL_DIR_MODE });
  } catch (err) {
    return failureOf(err);
  }

  const existed = fs.existsSync(target);
  try {
    fs.closeSync(fs.openSync(target, 'a', CREDENTIAL_FILE_MODE));
  } catch (err) {
    return failureOf(err);
  }
  if (!existed) {
    try {
      fs.unlinkSync(target);
    } catch {
      /* an empty file is an empty credential, not a failure */
    }
  }
  return null;
}

/**
 * Write the credential through a temp file in the same owner-only directory,
 * then rename it into place: the file the member is told about is always whole,
 * and it is never briefly world-readable.
 */
function writeAtomically(target: string, body: string): void {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: CREDENTIAL_DIR_MODE });

  const temp = path.join(dir, `.${CREDENTIAL_FILE_NAME}.${process.pid}.tmp`);
  const fd = fs.openSync(temp, 'w', CREDENTIAL_FILE_MODE);
  try {
    // The `open` mode is masked by the process umask; the mode is part of this
    // adapter's contract, so it is set rather than inherited.
    fs.fchmodSync(fd, CREDENTIAL_FILE_MODE);
    fs.writeSync(fd, body);
    // A credential the member was told was saved must survive a crash: settle
    // the bytes before the rename that publishes them.
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    quietlyRemove(temp);
    throw err;
  }
  fs.closeSync(fd);

  try {
    fs.renameSync(temp, target);
  } catch (err) {
    quietlyRemove(temp);
    throw err;
  }
}

function quietlyRemove(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch {
    /* best effort */
  }
}

function failureOf(err: unknown): FileFailure {
  const code = (err as { code?: unknown }).code;
  return {
    code: typeof code === 'string' ? code : 'unknown',
    message: err instanceof Error ? err.message : String(err),
  };
}

function describeFailure(err: unknown): string {
  const failure = failureOf(err);
  return `${failure.code}: ${failure.message}`;
}
