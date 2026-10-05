/**
 * @cytale/tui — local-mode login (U9, R14).
 *
 * ---------------------------------------------------------------------------
 * The interaction, and why it is a prompt at all
 * ---------------------------------------------------------------------------
 *
 * In local mode the member starts the client themselves, so the client cannot
 * ask the host who they are: there is no certificate and no descriptor (that is
 * SSH mode, and this module is unreachable from it — see the gate below). The
 * member therefore signs in with the SAME credentials the web login accepts:
 * an identifier that is a username OR an email, and a password
 * (`LoginBody` in `@cytale/domain`; the same `SessionManager.login()` the SPA
 * calls). No new credential type, no second identity, no token pasted in by
 * hand.
 *
 *   Username or email: tester
 *   Password: ********
 *   Signing in…
 *   Signed in as @tester.
 *
 * The password is read with terminal echo OFF, and the client echoes one `*`
 * per accepted character so the member can see that their keystrokes landed.
 * Masking is done by this file rather than by a `readline` echo hook for two
 * reasons that were measured, not assumed: an echo hook also masks the PROMPT
 * unless its arming is sequenced around `question()`, and on a terminal whose
 * Delete key sends 0x7f (macOS, and anything xterm-like) a hooking prompt echoes
 * the keystroke without deleting the character — so a mistyped password must be
 * retyped in full. This reader owns its buffer, so Backspace (0x7f or 0x08)
 * erases, arrow keys are swallowed instead of being inserted as `[D`, and the
 * terminal is always handed back in the mode it was found in. Non-TTY streams
 * (a pipe, a test) are read the same way, without raw mode — there is no echo to
 * suppress there.
 *
 * The interaction's states, all of them visible rather than silent:
 *
 *   * **loading** — "Checking your saved session for <origin>…" before the
 *     stored credential is validated, and "Signing in…" before each attempt.
 *   * **empty** — no usable credential: the member is prompted.
 *   * **error** — a rejected credential renders the web login's copy
 *     ("Wrong username/email or password.") plus the machine detail
 *     (`INVALID_CREDENTIALS · 401`), and the member is asked again with the
 *     identifier retained. Attempts are bounded (`MAX_LOGIN_ATTEMPTS`), then the
 *     outcome is a failure the caller can exit on — a terminal that re-prompts
 *     forever against a wrong URL is worse than one that stops.
 *   * **offline** — a rejected `fetch` is classified as unreachable and is never
 *     reported as a credential problem: the two have different remedies.
 *
 * ---------------------------------------------------------------------------
 * Where the credential lives, and the two modes this must not cross into
 * ---------------------------------------------------------------------------
 *
 * The durable half is `./credentialFile.js`: an owner-only file (0o600 in a
 * 0o700 directory) under `$XDG_CONFIG_HOME/cytale/`, holding the refresh pair
 * scoped to the origin it was minted for. This module owns the other half — when
 * that file is read, when it is replaced, and what the member is told when it
 * cannot be used:
 *
 *   * `restore()` is what makes a second run prompt-free. It runs through
 *     `SessionManager.restore()`, which hydrates the adapter, seeds the refresh
 *     contract, and exchanges the stored refresh token.
 *   * A corrupt, unreadable, or foreign-origin file is reported in the member's
 *     words before the prompt appears, and a stale one is called out as no
 *     longer valid rather than silently re-asked.
 *   * A target the process cannot write to (an unwritable or absent home
 *     directory, a read-only mount) is reported UP FRONT with the error code,
 *     and the run continues as a session-only login: the client is live for this
 *     run, keeps the pair in memory — the storage contract's documented
 *     behaviour for a failing backend — and says so, so the member knows why
 *     they will be asked again.
 *
 * The two gates that keep R27 and KTD1 intact: `createLocalLoginStorage` and
 * `runLocalLogin` both refuse a non-local `ClientConfig` with
 * `SshModeLoginError`, before any I/O. In SSH mode the host's certificate is the
 * login and the client keeps no token on disk, so reaching this module from that
 * path is a bug that must be loud rather than a warning that gets ignored.
 *
 * Wiring note for the shell (`client.ts`, not this unit's file set): local mode
 * should build its session with `createLocalLoginStorage(config).storage`
 * instead of the memory adapter, and after the session's local branch enters
 * `start()` it should `await runLocalLogin(config, session.manager, { localStorage })`
 * and fold the outcome into its connection view. The prompt must run with the
 * Ink tree not drawing (or before it mounts), since both write to the same
 * terminal.
 */

import { ApiError } from '@cytale/api-client';
import type { SessionManager, TokenStorage } from '@cytale/session';

import type { ClientConfig } from '../client.js';
import {
  createCredentialFile,
  type CredentialEnv,
  type CredentialFile,
  type FileFailure,
} from './credentialFile.js';

/** The identifier prompt, in the web login's words. */
export const IDENTIFIER_LABEL = 'Username or email';
export const IDENTIFIER_PROMPT = `${IDENTIFIER_LABEL}: `;
export const PASSWORD_PROMPT = 'Password: ';

/** How many credential pairs are sent before the client gives up. */
export const MAX_LOGIN_ATTEMPTS = 3;

/**
 * Raised when the local login is reached from SSH mode. Not a recoverable
 * condition: it means a wiring bug in a path where a password prompt must not
 * exist and a token must not reach a disk (R27, KTD1).
 */
export class SshModeLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SshModeLoginError';
  }
}

/** Anything with a `write` — `process.stdout` and a test's string collector. */
export interface Writer {
  write(chunk: string): unknown;
}

/**
 * The readable stream a line is read from. Structural rather than
 * `tty.ReadStream` so the reader works against `process.stdin`, a pipe, or a
 * fake the suite drives byte by byte.
 */
export interface LineInput {
  readonly isTTY?: boolean;
  /** The terminal's echo state; the reader sets it and hands it back. */
  isRaw?: boolean;
  setEncoding(encoding: BufferEncoding): unknown;
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (error: unknown) => void): unknown;
  off(event: 'data', listener: (chunk: string) => void): unknown;
  off(event: 'end', listener: () => void): unknown;
  off(event: 'error', listener: (error: unknown) => void): unknown;
}

export interface LoginStreams {
  readonly input: LineInput;
  readonly output: Writer;
}

/** The two questions the interaction asks, as a seam a suite can script. */
export interface LoginPrompt {
  /** `null` when the member cancelled (Ctrl-C / Ctrl-D) or the stream ended. */
  askIdentifier(defaultValue?: string): Promise<string | null>;
  askPassword(): Promise<string | null>;
}

// ---------------------------------------------------------------------------
// Reading a line
// ---------------------------------------------------------------------------

const NEWLINE = new Set([0x0a, 0x0d]);
const CANCEL = new Set([0x03, 0x04]); // Ctrl-C, Ctrl-D
const ERASE = new Set([0x08, 0x7f]); // Backspace: BS on some terminals, DEL on most
const ESCAPE = 0x1b;
const CSI_INTRO = new Set([0x5b, 0x4f]); // '[' (CSI) and 'O' (SS3)
const ESCAPE_FINAL_MIN = 0x40;
const ESCAPE_FINAL_MAX = 0x7e;

export interface LineReader {
  readLine(options: { prompt: string; mask: boolean }): Promise<string | null>;
}

/**
 * Read one line, echoing `*` per character when `mask` is set.
 *
 * Raw mode is entered only for a TTY, and restored on every exit path
 * (`finish()` runs for a submitted line, a cancel, and EOF alike) — a client
 * that leaves a terminal in raw mode after a failed sign-in has taken the shell
 * hostage. Nothing is echoed in the non-TTY case beyond the prompt: a piped
 * stream has no terminal to leak to.
 */
export function createLineReader(streams: LoginStreams): LineReader {
  const { input, output } = streams;
  const interactive = input.isTTY === true && typeof input.setRawMode === 'function';

  return {
    async readLine({ prompt, mask }) {
      return await new Promise<string | null>((resolve) => {
        let line = '';
        let settled = false;
        // Escape-sequence state: 'esc' just after ESC, 'csi' inside a CSI/SS3
        // sequence (ESC [ … or ESC O …). A cursor or function key must never
        // deposit its bytes into a password.
        let escape: 'none' | 'esc' | 'csi' = 'none';
        const wasRaw = input.isRaw === true;

        const write = (chunk: string): void => {
          output.write(chunk);
        };

        const finish = (value: string | null): void => {
          if (settled) return;
          settled = true;
          input.off('data', onData);
          input.off('end', onEof);
          input.off('error', onEof);
          if (interactive) {
            try {
              input.setRawMode?.(wasRaw);
            } catch {
              // The stream stopped being a TTY under us; there is no mode to
              // restore, and the line is complete either way.
            }
          }
          input.pause?.();
          write('\n');
          resolve(value);
        };

        const onData = (chunk: string): void => {
          for (const character of chunk) {
            const code = character.codePointAt(0) ?? 0;

            if (escape === 'esc') {
              // ESC introduces either a short two-character key (ALT-x) or a
              // CSI/SS3 sequence whose final byte ends it. The '[' of a CSI is
              // an intro byte, not a final one — treating it as final is how a
              // masked prompt ends up inserting "[D".
              escape = CSI_INTRO.has(code) ? 'csi' : 'none';
              continue;
            }
            if (escape === 'csi') {
              if (code >= ESCAPE_FINAL_MIN && code <= ESCAPE_FINAL_MAX) escape = 'none';
              continue;
            }
            if (code === ESCAPE) {
              escape = 'esc';
              continue;
            }
            if (NEWLINE.has(code)) {
              finish(line);
              return;
            }
            if (CANCEL.has(code)) {
              finish(null);
              return;
            }
            if (ERASE.has(code)) {
              if (line !== '') {
                line = line.slice(0, -1);
                write('\b \b');
              }
              continue;
            }
            if (code < 0x20 || code === 0x7f) continue; // other control keys: neither value nor echo
            line += character;
            write(mask ? '*' : character);
          }
        };
        const onEof = (): void => {
          finish(null);
        };

        // Listeners first: a stream that already holds bytes (a piped stdin,
        // a host that writes early) must not have them dropped on the floor
        // between `resume()` and the first read.
        input.on('data', onData);
        input.on('end', onEof);
        input.on('error', onEof);
        input.setEncoding('utf8');
        if (interactive) {
          try {
            input.setRawMode?.(true);
          } catch {
            // Not a TTY after all: fall back to plain reading.
          }
        }
        input.resume?.();
        write(prompt);
      });
    },
  };
}

/**
 * The real prompt: two questions over a pair of streams. The identifier is
 * echoed (it is not a secret) and is trimmed; the password is masked and is
 * passed through EXACTLY as typed — a trailing space can be part of a password,
 * and trimming it would turn a correct credential into a rejected one.
 */
export function createLoginPrompt(streams: LoginStreams): LoginPrompt {
  const reader = createLineReader(streams);
  return {
    async askIdentifier(defaultValue?: string) {
      const label =
        defaultValue === undefined || defaultValue === ''
          ? IDENTIFIER_PROMPT
          : `${IDENTIFIER_LABEL} [${defaultValue}]: `;
      const answer = await reader.readLine({ prompt: label, mask: false });
      if (answer === null) return null;
      const trimmed = answer.trim();
      // An empty answer accepts the retained default, the way the web form
      // keeps the identifier field filled in after a failed attempt.
      if (trimmed === '') return defaultValue === undefined ? '' : defaultValue;
      return trimmed;
    },
    askPassword: async () => await reader.readLine({ prompt: PASSWORD_PROMPT, mask: true }),
  };
}

// ---------------------------------------------------------------------------
// The storage the session is built with
// ---------------------------------------------------------------------------

export interface LocalLoginStorage {
  /** Hand this to `createSessionManager({ storage })`. */
  readonly storage: TokenStorage;
  readonly file: CredentialFile;
  readonly path: string;
  /** False when the file cannot be written: a session-only login. */
  readonly writable: boolean;
  /** What to tell the member when persistence is unavailable; null when it is. */
  readonly note: string | null;
}

export interface LocalLoginStorageOptions {
  /** Defaults to `process.env`. */
  readonly env?: CredentialEnv;
  /** Test seam: an exact path instead of one resolved from the environment. */
  readonly path?: string;
}

/**
 * The credential-file storage for a local-mode client, with the up-front
 * writability report the interaction prints before it asks for a password.
 *
 * Throws `SshModeLoginError` for any other mode — the gate is here, at the
 * single entry that builds persistence, rather than trusting each caller.
 */
export function createLocalLoginStorage(
  config: ClientConfig,
  options: LocalLoginStorageOptions = {},
): LocalLoginStorage {
  assertLocalMode(config);

  const file = createCredentialFile({
    mode: config.mode,
    env: options.env,
    path: options.path,
    origin: config.origin,
  });
  const diagnostics = file.diagnostics();

  return {
    storage: file,
    file,
    path: file.path,
    writable: diagnostics.writable,
    note: diagnostics.unwritable === null ? null : persistenceNote(file.path, diagnostics.unwritable),
  };
}

function persistenceNote(path: string, failure: FileFailure): string {
  return (
    `${path} cannot be saved (${failure.code}: ${failure.message}). ` +
    'This run keeps the session in memory only; you will sign in again next time.'
  );
}

/**
 * Refuse a config that is not local mode. The assertion signature narrows the
 * config for the caller, so the credential adapter's `mode: 'local'` is a value
 * the type system checked rather than one this file asserted.
 */
export function assertLocalMode(
  config: ClientConfig,
): asserts config is ClientConfig & { readonly mode: 'local' } {
  if (config.mode !== 'local') {
    throw new SshModeLoginError(
      'The local login is unreachable in SSH mode: the host’s certificate is the login there, ' +
        'and a token minted for the session must not reach a disk (R27).',
    );
  }
}

// ---------------------------------------------------------------------------
// Failure copy
// ---------------------------------------------------------------------------

export interface LoginFailureCopy {
  readonly message: string;
  readonly detail: string | null;
}

/**
 * Classify a failed sign-in into the member's words plus a machine detail line.
 *
 * The mapping is the web login's (`LoginPage` + `authErrors`) and the native
 * client's (`apps/mobile/src/auth/errors.ts`), kept to the cases a terminal
 * sign-in can actually produce: a rejected credential pair, and everything that
 * is not a server envelope at all — which is connectivity, not a credential
 * problem, and must never be shown as one.
 */
export function describeLoginFailure(error: unknown): LoginFailureCopy {
  if (error instanceof ApiError && error.key !== 'network_error' && error.status !== 0) {
    const detail = `${error.key} · ${error.status}`;
    // 6.4 rename window: the server's key moved to lower_snake and a
    // pre-rename server can still be live, so ONE case-insensitive comparison
    // covers both spellings — the same window web and mobile keep. This file
    // matched only the SHOUTY spelling, so a wrong password lost its copy.
    return error.key.toLowerCase() === 'invalid_credentials'
      ? { message: 'Wrong username/email or password.', detail }
      : { message: 'Could not sign in. Please try again.', detail };
  }

  const code = transportCode(error);
  return {
    message:
      code === null
        ? "Couldn't reach the server — check the connection and the server URL, then try again."
        : `Couldn't reach the server (${code}) — check the connection and the server URL, then try again.`,
    detail: null,
  };
}

/**
 * The `code` on an error or on its cause chain (a rejected `fetch` wraps the
 * socket error). Kept local rather than imported from `../client.js`: that is
 * the CLI entry this module is wired INTO, so importing it back would make a
 * cycle, and the value read here is the same one its classifier reads.
 */
function transportCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

export type LocalLoginOutcome =
  /** A live session: reused from the file, or freshly signed in. */
  | { readonly status: 'authenticated'; readonly username: string | null; readonly reused: boolean }
  /** The member cancelled the prompt (Ctrl-C/Ctrl-D, or the stream ended). */
  | { readonly status: 'cancelled' }
  /** No session, and no point asking again: the last reason is carried out. */
  | {
      readonly status: 'failed';
      readonly message: string;
      readonly detail: string | null;
      readonly attempts: number;
    };

export interface LocalLoginDeps {
  /** Defaults to the credential file for `config`. */
  readonly localStorage?: LocalLoginStorage;
  /** Defaults to a prompt over `input`/`output`. */
  readonly prompt?: LoginPrompt;
  readonly input?: LineInput;
  readonly output?: Writer;
  /** Defaults to `process.env` (path resolution for the default storage). */
  readonly env?: CredentialEnv;
  /** Defaults to `MAX_LOGIN_ATTEMPTS`. */
  readonly attempts?: number;
}

/**
 * Run the local-mode sign-in: reuse a stored session if there is one, else ask,
 * and report what happened.
 *
 * Returns rather than throws for every outcome the member caused or can fix —
 * a rejected password, an unreachable server, a cancelled prompt — because the
 * caller renders a connection view from the result. Throws only for a wiring
 * bug (SSH mode reaching this path) and for failures thrown by `restore()`
 * itself, which are the session package's to define.
 */
export async function runLocalLogin(
  config: ClientConfig,
  manager: SessionManager,
  deps: LocalLoginDeps = {},
): Promise<LocalLoginOutcome> {
  assertLocalMode(config);

  const output = deps.output ?? process.stdout;
  const say = (line: string): void => {
    output.write(`${line}\n`);
  };
  const localStorage = deps.localStorage ?? createLocalLoginStorage(config, { env: deps.env });
  const attempts = deps.attempts ?? MAX_LOGIN_ATTEMPTS;

  // The persistence failure is reported BEFORE the password prompt: a member
  // who is about to type a password deserves to know it cannot be saved.
  if (localStorage.note !== null) say(localStorage.note);

  // A stored session is the fast path and the whole point of the file. Its
  // validation is a network round trip, so it is stated rather than silent.
  say(`Checking your saved session for ${config.origin}…`);
  await manager.restore();
  reportFileTrouble(localStorage, config.origin, say);

  const restored = manager.authStore.getState();
  if (restored.status === 'authenticated') {
    const username = restored.currentUser?.username ?? null;
    say(
      username === null
        ? 'Signed in from your saved session.'
        : `Signed in as @${username} from your saved session.`,
    );
    return { status: 'authenticated', username, reused: true };
  }
  if (localStorage.file.diagnostics().found) {
    // A credential was there and the server would not take it: say so, instead
    // of letting the prompt look like a first run.
    say('Your saved session is no longer valid. Sign in again.');
  }

  const prompt = deps.prompt ?? createLoginPrompt({ input: deps.input ?? process.stdin, output });
  let retained: string | undefined;
  let failure: LoginFailureCopy | null = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const identifier = await askNonEmpty(
      () => prompt.askIdentifier(retained),
      'A username or email is required.',
      say,
    );
    if (identifier === null) return { status: 'cancelled' };
    const password = await askNonEmpty(() => prompt.askPassword(), 'A password is required.', say);
    if (password === null) return { status: 'cancelled' };
    retained = identifier;

    say('Signing in…');
    try {
      await manager.login(identifier, password);
    } catch (err) {
      failure = describeLoginFailure(err);
      say(failure.detail === null ? failure.message : `${failure.message} [${failure.detail}]`);
      continue;
    }

    // The session is live either way; only its persistence can have failed,
    // and it is only news when the up-front probe said the file was writable.
    const writeError = localStorage.file.diagnostics().lastWriteError;
    if (writeError !== null && localStorage.writable) {
      say(
        `Your session could not be saved (${writeError.code}: ${writeError.message}). ` +
          'It is live for this run only.',
      );
    }

    const signedIn = manager.authStore.getState().currentUser?.username ?? null;
    say(signedIn === null ? 'Signed in.' : `Signed in as @${signedIn}.`);
    return { status: 'authenticated', username: signedIn, reused: false };
  }

  return {
    status: 'failed',
    message: failure?.message ?? 'Sign-in failed.',
    detail: failure?.detail ?? null,
    attempts,
  };
}

/**
 * What happened to the credential file, in the member's words. Every report
 * here is one the member can act on: sign in again, or know that a session for
 * a different server was left untouched.
 */
function reportFileTrouble(
  localStorage: LocalLoginStorage,
  origin: string,
  say: (line: string) => void,
): void {
  const { discarded, otherOrigin, path } = localStorage.file.diagnostics();
  if (discarded !== null) {
    const fate = discarded.removed ? 'removed' : 'ignored';
    say(`Your saved session at ${path} could not be read (${discarded.detail}) and was ${fate}. Sign in again.`);
  }
  if (otherOrigin !== null) {
    say(
      `The saved session at ${path} belongs to ${otherOrigin}, so it cannot be reused for ${origin}. ` +
        'It is left untouched unless you sign in here.',
    );
  }
}

/**
 * Ask until there is an answer to send. An empty identifier or an empty
 * password is not a credential attempt — the server would reject it and count
 * it against the member's rate limit — so it is re-asked without consuming one.
 */
async function askNonEmpty(
  ask: () => Promise<string | null>,
  complaint: string,
  say: (line: string) => void,
): Promise<string | null> {
  for (;;) {
    const value = await ask();
    if (value === null) return null;
    if (value.trim() !== '') return value;
    say(complaint);
  }
}
