/**
 * @cytale/tui — the client entry point: mode/origin resolution, the session,
 * the token path, and the connection banner's view model.
 *
 * Requirements: R14 (the origin and where it comes from), R19a (a session end
 * names its cause), R27 (no Cytale token on disk in SSH mode).
 *
 * ---------------------------------------------------------------------------
 * The two modes, and why the origin is resolved first
 * ---------------------------------------------------------------------------
 *
 * `@cytale/session` builds its api client in the SessionManager CONSTRUCTOR and
 * derives the gateway URL from the same origin, so a bare `host:port` string
 * does not fail on first request — it throws while the session is being built,
 * with nothing to render. Origin resolution is therefore its own step
 * (`resolveOrigin`/`normalizeOrigin`) that runs before a session exists, and a
 * bad or missing origin is a usage/config error and never a connection attempt.
 *
 *   * **local mode** — no descriptor in the environment. The origin is the
 *     command-line argument (`cytale-tui https://chat.example.com`). The
 *     member signs in with their Cytale credentials (U9): the session is built
 *     over the credential file (`session/credentialFile.ts`), the sign-in runs
 *     BEFORE the Ink tree mounts — both write to the terminal, so they cannot
 *     draw at once — and its outcome is folded into the view: `cancelled` is a
 *     signed-out state, `failed` is a failure the member can read, and
 *     `authenticated` is the refresh-token path the other clients use. The
 *     credential file is the ONE surface allowed to hold a Cytale token
 *     (R27 is scoped to SSH mode); this module never builds it for SSH mode.
 *   * **SSH mode** — the host handed the process a token descriptor
 *     (`CYTALE_TOKEN_FD`, see `session/tokenPipe.ts`). The origin is the HOST's
 *     configuration (`CYTALE_ORIGIN`) and a command-line URL is ignored
 *     outright (R14): the member's session cannot redirect a freshly minted
 *     token at a server of their choosing, and the process has no argv channel
 *     that reaches the server choice at all.
 *
 * ---------------------------------------------------------------------------
 * The token path (KTD8) and the no-disk property (R27)
 * ---------------------------------------------------------------------------
 *
 * In SSH mode the session is access-only: it asks the token source for the
 * current token on every request, the descriptor reader pushes each renewal
 * into that source, and no token is ever persisted — the storage adapter is
 * `createWriteNullStorage()`, so the property holds by construction rather
 * than by the absence of a call (see `session/tokenSource.ts`).
 *
 * The ordering the plan fixes is enforced here: the client reads (and
 * publishes) the first token BEFORE calling `authenticateFromTokenSource()`,
 * so the very first request already carries the host's token. From then on the
 * reader is a background push. A descriptor that closes, times out, or never
 * yields a token ends the session with the `token_path_failed` cause rather
 * than stalling silently — in SSH mode there is no re-login, so a stall is
 * indistinguishable from a hang (R19a).
 *
 * A 401 during a renewal window is RECOVERABLE by contract (see
 * `@cytale/session`'s header): the session reports `expired` instead of logging
 * out, this client renders that state, and the next token from the descriptor
 * re-establishes the session. A rejected token is surfaced, never swallowed.
 */
import { pathToFileURL } from 'node:url';

import { ApiError } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import { GatewayClient, type ConnectionState, type GatewayClientOptions } from '@cytale/gateway-client';
import {
  createSessionManager,
  type AccessStatus,
  type SessionManager,
  type TokenStorage,
} from '@cytale/session';
import { applyGatewayEvent, defaultStore, mergeChannelMessages, type StateStore } from '@cytale/state';
import { render } from 'ink';
import { createElement, type ReactElement } from 'react';

import { App, type ConnectionView } from './app.js';
import { applyReactionEvent, toggleOwnReaction, type ReactionOutcome } from './columns/Reactions.js';
import type { SearchRequest } from './compose/search.js';
import { createSender } from './compose/send.js';
import type { HistoryRequest } from './format/rows.js';
import type { CredentialEnv } from './session/credentialFile.js';
import { createHydrator, type Hydrator } from './session/hydration.js';
import { createLocalLoginStorage, runLocalLogin, type LineInput, type LocalLoginOutcome, type LocalLoginStorage, type LoginPrompt, type Writer } from './session/login.js';
import { createReadState, type ReadState } from './session/readState.js';
import {
  DescriptorDecoder,
  SERVER_ORIGIN_ENV,
  TOKEN_DESCRIPTOR_ENV,
  TokenPathError,
  awaitFirstFrame,
  descriptorFromFd,
  startTokenPipe,
  type DescriptorFrame,
  type TokenDescriptor,
  type TokenPipe,
} from './session/tokenPipe.js';
import { createTokenSource, createWriteNullStorage, type ClientTokenSource, type WriteNullStorage } from './session/tokenSource.js';

/** The one-line form, printed for `--help` and on any usage error. */
export const USAGE = 'usage: cytale-tui <server-url>\n\nexample: cytale-tui https://chat.example.com';

/** How long the client waits for the host's first token before giving up. */
export const FIRST_TOKEN_TIMEOUT_MS = 30_000;

/** Where a member re-issues a certificate (the web UI's SSH settings section). */
export function reissueUrl(origin: string): string {
  return `${origin}/#/settings/ssh`;
}

// ---------------------------------------------------------------------------
// Mode and origin resolution (R14)
// ---------------------------------------------------------------------------

/**
 * A configuration the client refuses to run with. `kind` distinguishes the two
 * sources, and the distinction is load-bearing: a bad ARGUMENT is the member's
 * to fix and prints the usage line, while a bad HOST value is a broken deploy
 * (the host sets the environment; nobody in the SSH session can correct it).
 */
export class ClientConfigError extends Error {
  readonly kind: 'usage' | 'host-config';

  constructor(kind: 'usage' | 'host-config', message: string) {
    super(message);
    this.name = 'ClientConfigError';
    this.kind = kind;
  }
}

export interface ClientConfig {
  readonly mode: 'ssh' | 'local';
  /** The resolved origin: the argument in local mode, the host's in SSH mode. */
  readonly origin: string;
  /** SSH mode: the descriptor number the host handed over. */
  readonly descriptorFd: number | null;
  /**
   * A command-line URL that was present and IGNORED because the host owns the
   * origin (R14). Kept on the config so the fact is inspectable rather than
   * only implicit in the code path.
   */
  readonly ignoredArgument: string | null;
}

export interface Invocation {
  readonly argv: readonly string[];
  readonly env: Record<string, string | undefined>;
}

/** True when the session asked for help (checked before parsing, so help is
 * reachable even when a URL is missing). */
export function wantsHelp(argv: readonly string[]): boolean {
  return argv.includes('--help') || argv.includes('-h');
}

/**
 * Normalize a server origin. A scheme is REQUIRED: the gateway protocol is
 * derived from it (`https:` → `wss:`, anything else → cleartext `ws:`) and the
 * refresh/descriptor traffic rides the same origin, so a scheme-less
 * `host:port` would silently derive a cleartext transport (the mobile client's
 * `resolveBuildTimeOrigin` refuses the same value for the same reason). A path
 * is dropped: `/api/v1` and `/gateway/websocket` are derived downstream.
 */
export function normalizeOrigin(value: string, kind: 'usage' | 'host-config' = 'usage'): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ClientConfigError(
      kind,
      `"${value}" is not a server URL. Pass an absolute URL such as https://chat.example.com — ` +
        'a bare host:port is not accepted, because the transport (ws vs wss) is derived from the scheme.',
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ClientConfigError(kind, `"${value}" could not be parsed as a server URL.`);
  }
  if (url.hostname === '') {
    throw new ClientConfigError(kind, `"${value}" has no host.`);
  }
  return url.origin;
}

/**
 * Resolve the mode, the origin, and the descriptor from the invocation.
 *
 * The order matters: the descriptor's presence decides the mode, and the mode
 * decides whether the command line is even read. In SSH mode `argv` is not
 * parsed at all — that is what "the session cannot override it" means
 * operationally, since there is no code path from an argument to the origin.
 */
export function parseInvocation(invocation: Invocation): ClientConfig {
  const { argv, env } = invocation;
  const descriptorRaw = env[TOKEN_DESCRIPTOR_ENV];

  if (descriptorRaw !== undefined && descriptorRaw.trim() !== '') {
    const descriptorFd = parseDescriptorNumber(descriptorRaw);
    const originRaw = env[SERVER_ORIGIN_ENV];
    if (originRaw === undefined || originRaw.trim() === '') {
      throw new ClientConfigError(
        'host-config',
        `${SERVER_ORIGIN_ENV} is not set. In SSH mode the host owns the server origin ` +
          'and the session cannot supply one.',
      );
    }
    return {
      mode: 'ssh',
      origin: normalizeOrigin(originRaw, 'host-config'),
      descriptorFd,
      ignoredArgument: argv[0] ?? null,
    };
  }

  const argument = argv[0];
  if (argument === undefined || argument.trim() === '') {
    throw new ClientConfigError('usage', 'a server URL is required.');
  }
  if (argv.length > 1) {
    throw new ClientConfigError('usage', `unexpected extra argument "${argv[1] ?? ''}".`);
  }
  return {
    mode: 'local',
    origin: normalizeOrigin(argument, 'usage'),
    descriptorFd: null,
    ignoredArgument: null,
  };
}

function parseDescriptorNumber(raw: string): number {
  const fd = Number(raw.trim());
  if (!Number.isInteger(fd) || fd < 0) {
    throw new ClientConfigError('host-config', `${TOKEN_DESCRIPTOR_ENV}="${raw}" is not a descriptor number.`);
  }
  return fd;
}

// ---------------------------------------------------------------------------
// Connection views (the banner's input) and the failure classifier
// ---------------------------------------------------------------------------

/**
 * Classify a failure into a view the member can act on.
 *
 * Three of these must stay DISTINCT — an unreachable server, a certificate the
 * client will not trust, and a token the server rejected are three different
 * problems with three different remedies (check the network, fix the deploy's
 * certificate, get a fresh token), and collapsing them into "could not
 * connect" is the failure mode this function exists to prevent.
 */
export function classifyFailure(error: unknown, origin: string): ConnectionView {
  // A transport failure arrives wrapped as ApiError `network_error`; the TLS or
  // socket code is on its cause chain, and it decides which message the member
  // reads (an untrusted certificate is not an unreachable server).
  const transport = transportView(error, origin);
  if (transport !== null) return transport;

  if (error instanceof ApiError) {
    if (error.key === 'access_token_missing') {
      return {
        phase: 'failed',
        headline: 'No access token was handed to this session',
        detail: "The host's descriptor carried no usable token, so there is nothing to authenticate with.",
      };
    }
    if (error.key === 'access_token_malformed') {
      return {
        phase: 'failed',
        headline: 'The token on the session descriptor is not a token',
        detail: 'The value was ignored. The descriptor reader will publish the next one it receives.',
      };
    }
    if (error.key === 'session_expired' || error.key === 'unauthorized' || error.status === 401) {
      return {
        phase: 'failed',
        headline: "The server rejected this session's access token",
        detail:
          'This session does not re-login; it retries once the host renews the token over the descriptor.',
      };
    }
    return {
      phase: 'failed',
      headline: `The server refused the request (${error.key})`,
      detail: error.message,
    };
  }

  if (error instanceof TokenPathError) {
    return {
      phase: 'failed',
      headline: 'No access token arrived from the host',
      detail: error.message,
    };
  }

  return {
    phase: 'failed',
    headline: `Could not connect to ${origin}`,
    detail: describeError(error),
  };
}

/** The certificate / unreachable views, from a code anywhere on the cause chain. */
function transportView(error: unknown, origin: string): ConnectionView | null {
  const code = transportCode(error);
  if (code !== null && CERTIFICATE_CODES.has(code)) {
    return {
      phase: 'failed',
      headline: "The server's TLS certificate could not be verified",
      detail: `The handshake failed with ${code}. The certificate is not trusted by this client.`,
    };
  }
  if (code !== null && UNREACHABLE_CODES.has(code)) {
    return {
      phase: 'failed',
      headline: `Cannot reach the Hrmny server at ${origin}`,
      detail: `The connection failed (${code}). Check the server and your network.`,
    };
  }
  return null;
}

/** TLS verification failures Node reports on `error.cause.code`. */
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);

/** Connection-level failures: the server was never reached (or went away). */
const UNREACHABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/** The `code` on an error or on its cause chain (fetch wraps in a TypeError). */
export function transportCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The session-end message (R19a). The host owns the vocabulary — these are its
 * codes, spelled as `SESSION_END_REASONS` lists them — and the host writes its
 * own wording to the SSH channel after this process exits. What this function
 * guarantees is that a member who is told through the client is told WHICH cause
 * it was, and, where re-issuing is the remedy, where to re-issue.
 *
 * The two host codes that are re-issue-remedied beyond an expiry —
 * `credential_epoch_moved` (a password reset or a revoke-all-sessions) and
 * `bridge_refused` — carry the URL here for the same reason the host's own block
 * does: the remedy is a new certificate, and a member told only "refused" has
 * nowhere to go.
 */
export function sessionEndMessage(reason: string, options: { reissueUrl?: string } = {}): string {
  const reissue =
    options.reissueUrl === undefined
      ? ''
      : ` Issue a new certificate at ${options.reissueUrl} and connect again.`;

  switch (reason) {
    case 'certificate_expired':
      return `Your SSH certificate expired, so this session ended.${reissue}`;
    case 'credential_epoch_moved':
      return `Your account's credentials were reset, so this session ended. Sign in again.${reissue}`;
    case 'bridge_refused':
      return `The server refused this session.${reissue}`;
    case 'max_session_duration':
      return 'This session reached its maximum duration and the host ended it. Connect again to continue.';
    case 'idle_timeout':
      return 'This session was idle for too long and the host ended it. Connect again to continue.';
    case 'token_path_failed':
      return "The host could not renew this session's access token, so the session ended. Connect again to continue.";
    default:
      return `This session ended: ${reason}. Connect again to continue.`;
  }
}

// ---------------------------------------------------------------------------
// The wired session
// ---------------------------------------------------------------------------

/** Test seam for the renderer; `ink`'s own `render` is the default. */
export type RenderFn = (node: ReactElement) => {
  rerender(node: ReactElement): void;
  unmount(): void;
};

export interface ClientSessionDeps {
  /** Test seam: the descriptor to read instead of the numbered one. */
  readonly descriptor?: TokenDescriptor;
  /** Gateway seam: the real client dials the server, which tests do not have. */
  readonly createGatewayClient?: (options: GatewayClientOptions) => GatewayClient;
  readonly now?: () => number;
  readonly firstTokenTimeoutMs?: number;
  /**
   * The shared store (`@cytale/state`). Defaults to the module's `defaultStore`
   * — the instance the shell renders from — and the session hands the SAME
   * instance back through `ClientSession.store` so the hydrator U12 built is
   * given it too. One instance, or column one reads a store nothing writes.
   */
  readonly store?: StateStore;
  /**
   * Local mode (U9): the credential-file storage. Built from the environment
   * (or `credentialPath`) when omitted; never built in SSH mode, where the
   * host's certificate is the login and R27 forbids a token on disk.
   */
  readonly localStorage?: LocalLoginStorage;
  /** Local mode (U9): where the credential file resolves from. Defaults to `process.env`. */
  readonly credentialEnv?: CredentialEnv;
  /** Local mode (U9): an exact credential-file path (a test seam). */
  readonly credentialPath?: string;
  /** Local mode (U9): the prompt itself. Defaults to a prompt over the streams. */
  readonly loginPrompt?: LoginPrompt;
  /** Local mode (U9): the terminal the prompt reads. Defaults to `process.stdin`. */
  readonly loginInput?: LineInput;
  /** Local mode (U9): the stream the prompt writes. Defaults to `process.stdout`. */
  readonly loginOutput?: Writer;
  /** Local mode (U9): credential attempts before giving up (`MAX_LOGIN_ATTEMPTS`). */
  readonly loginAttempts?: number;
}

export interface ClientSession {
  readonly config: ClientConfig;
  readonly manager: SessionManager;
  readonly storage: TokenStorage;
  /**
   * The SSH-mode adapter, or null in local mode. Its counters are how the
   * no-disk property is ASSERTED rather than read off the code (R27).
   */
  readonly writeNullStorage: WriteNullStorage | null;
  /** Non-null in SSH mode (the access-only renewal seam). */
  readonly tokenSource: ClientTokenSource | null;
  /**
   * The shared store this session writes and the shell renders — the same
   * instance the hydrator must be given (U12, `@cytale/state`).
   */
  readonly store: StateStore;
  /** Local mode: the credential file the sign-in reads and writes; null in SSH mode. */
  readonly localStorage: LocalLoginStorage | null;
  view(): ConnectionView;
  onViewChange(listener: (view: ConnectionView) => void): () => void;
  /** A session end, in the host's vocabulary (R19a). */
  onEnd(listener: (reason: string) => void): () => void;
  /**
   * Local mode (U9): run the sign-in and record its outcome.
   *
   * MUST be awaited BEFORE the Ink tree mounts: the prompt and Ink both write
   * to the terminal, and interleaving them corrupts both. Idempotent — the
   * outcome is recorded once, `start()` folds it — and a no-op in SSH mode,
   * where the host's certificate is the login.
   */
  signIn(): Promise<void>;
  /** Await the first token, authenticate, then follow renewals. */
  start(): Promise<void>;
  stop(): void;
}

/** connected/ready → online; the drop and terminal states → offline. */
function connectivityOf(state: ConnectionState): 'unknown' | 'online' | 'offline' {
  if (state === 'connected' || state === 'ready') return 'online';
  if (state === 'disconnected' || state === 'reconnecting' || state === 'dead') return 'offline';
  return 'unknown';
}

export function createClientSession(config: ClientConfig, deps: ClientSessionDeps = {}): ClientSession {
  const now = deps.now ?? Date.now;
  const ssh = config.mode === 'ssh';

  // R27 is scoped to SSH mode: that path gets an adapter with nothing to write
  // to. Local mode gets the credential file (U9) — the one surface allowed to
  // persist a Cytale token, built only here and only for a local config.
  const localLogin = ssh
    ? null
    : (deps.localStorage ??
      createLocalLoginStorage(config, { env: deps.credentialEnv, path: deps.credentialPath }));
  const storage: TokenStorage = localLogin === null ? createWriteNullStorage() : localLogin.storage;
  const tokenSource = ssh ? createTokenSource() : null;

  // One store for the session, the hydrator (U12) and the shell (U6).
  const store = deps.store ?? defaultStore;

  const viewListeners = new Set<(view: ConnectionView) => void>();
  const endListeners = new Set<(reason: string) => void>();

  let managerRef: SessionManager | null = null;
  let accessStatus: AccessStatus = 'idle';
  let gateway: 'unknown' | 'online' | 'offline' = 'unknown';
  let failure: ConnectionView | null = null;
  let current: ConnectionView | null = null;
  let endSettled = false;
  /** Local mode: the sign-in's outcome, once it has run (U9). */
  let loginOutcome: LocalLoginOutcome | null = null;
  let loginInFlight: Promise<void> | null = null;

  const connectingView = (): ConnectionView => ({
    phase: 'connecting',
    headline: `Connecting to ${config.origin}…`,
  });

  const offlineView = (): ConnectionView => ({
    phase: 'offline',
    headline: 'Connection lost — reconnecting',
    detail: `The gateway link to ${config.origin} dropped; the client is retrying.`,
  });

  const onlineView = (): ConnectionView => {
    const username = managerRef?.authStore.getState().currentUser?.username ?? null;
    return {
      phase: 'online',
      headline: `Connected to ${config.origin}`,
      detail: username === null ? 'Authenticated.' : `Signed in as @${username}.`,
    };
  };

  /**
   * Local mode's signed-out state. Two spellings, because they are two facts:
   * a member who cancelled the prompt (or piped stdin closed, so the prompt
   * ended) needs to be told the client must be run again, while a session that
   * simply has no credential must not claim a sign-in was interrupted.
   */
  const localSignedOutView = (): ConnectionView =>
    loginOutcome?.status === 'cancelled'
      ? {
          phase: 'signed_out',
          headline: 'Not signed in',
          detail: `The sign-in was cancelled; run the client again to sign in to ${config.origin}.`,
        }
      : {
          phase: 'signed_out',
          headline: 'Not signed in',
          detail: `No stored credential for ${config.origin}.`,
        };

  const computeView = (): ConnectionView => {
    if (failure !== null) return failure;

    // Local mode is the refresh-token shape, where `accessStatus` — the
    // ACCESS-ONLY status — is never anything but 'idle'. The auth store is
    // what says whether a session exists there, and only U9's sign-in can
    // create one.
    if (localLogin !== null) {
      if (managerRef?.authStore.getState().status !== 'authenticated') return localSignedOutView();
      if (gateway === 'offline') return offlineView();
      if (gateway === 'online') return onlineView();
      return connectingView();
    }

    if (accessStatus === 'expired') {
      return {
        phase: 'expired',
        headline: 'Access token expired — waiting for a renewed token',
        detail: 'The host renews it over this session’s descriptor; this state is recoverable and not a sign-out.',
      };
    }
    if (accessStatus === 'connecting') return connectingView();
    if (accessStatus === 'authenticated') {
      if (gateway === 'offline') return offlineView();
      if (gateway === 'online') return onlineView();
      return connectingView();
    }

    // 'idle': in SSH mode an attempt has not run yet (it is about to).
    return connectingView();
  };

  const publish = (): void => {
    const next = computeView();
    if (
      current !== null &&
      current.phase === next.phase &&
      current.headline === next.headline &&
      current.detail === next.detail
    ) {
      return;
    }
    current = next;
    for (const listener of [...viewListeners]) listener(next);
  };

  const createGatewayClient = (options: GatewayClientOptions): GatewayClient => {
    const factory =
      deps.createGatewayClient ?? ((gatewayOptions: GatewayClientOptions) => new GatewayClient(gatewayOptions));
    return factory({
      ...options,
      onStateChange: (change) => {
        gateway = connectivityOf(change.to);
        publish();
        options.onStateChange?.(change);
      },
    });
  };

  const manager = createSessionManager({
    storage,
    // The shared store: the same instance the shell renders and the hydrator
    // fills. Passing it explicitly (rather than relying on the package's
    // default) is what makes "one instance" a property of this module.
    store,
    // The origin is resolved before this constructor runs (see the header):
    // the api client and the gateway URL are both derived from it here.
    resolveOrigin: () => config.origin,
    createGatewayClient,
    // U14's reactions fold, in the seat the session gives it. `@cytale/state`
    // accepts the three reaction dispatches as pass-through no-ops, so without
    // this registration a live session's reaction frames change nothing; the
    // seam has to run BEFORE `applyGatewayEvent` advances `lastSeq`, which is
    // exactly what this list is (packages/session, `onAny`). One preprocessor
    // today — a later seam appends to this array rather than replacing it.
    gatewayPreprocessors: [
      (frame, seamStore) => {
        applyReactionEvent(seamStore, frame);
      },
    ],
    ...(tokenSource === null ? {} : { tokenSource }),
  });
  managerRef = manager;
  accessStatus = manager.accessStatus;
  manager.onAccessStatusChange((status) => {
    accessStatus = status;
    publish();
  });

  if (localLogin !== null) {
    // The refresh-token path moves the auth store, not `accessStatus`, and a
    // 401 it cannot rescue signs the session out (`onLogout` → `logout()`).
    // Following the store keeps the banner honest through both.
    manager.authStore.subscribe(() => {
      publish();
    });
  }

  const descriptor = ssh ? (deps.descriptor ?? descriptorFromFd(config.descriptorFd ?? 0)) : null;
  const decoder = new DescriptorDecoder();
  let pipe: TokenPipe | null = null;
  let retrying = false;

  const emitEnd = (reason: string): void => {
    if (endSettled) return;
    endSettled = true;
    pipe?.stop();
    // Release the descriptor with the session: a read left blocked on a pipe
    // nobody is writing to is a process that cannot exit.
    descriptor?.close();
    for (const listener of [...endListeners]) listener(reason);
  };

  const authenticate = async (): Promise<void> => {
    try {
      await manager.authenticateFromTokenSource();
      failure = null;
    } catch (err) {
      failure = classifyFailure(err, config.origin);
    }
    publish();
  };

  /**
   * A renewal arrived. If the session is in `expired` (a 401 raced the renewal)
   * or the last attempt failed, establish again — in SSH mode there is no
   * re-login path, so the renewal IS the recovery.
   */
  const retryIfNeeded = (): void => {
    if (retrying) return;
    if (failure === null && manager.accessStatus === 'authenticated') return;
    retrying = true;
    void authenticate().finally(() => {
      retrying = false;
    });
  };

  /**
   * U9's sign-in, run once. The outcome is recorded so `start()` can fold it
   * (and so a second call is free), and the failure it can carry is published
   * as this session's view. It runs BEFORE the Ink tree mounts — the entry
   * point is what guarantees that ordering — because the prompt and Ink write
   * to the same terminal.
   */
  const signIn = async (): Promise<void> => {
    if (localLogin === null) return; // SSH mode: the certificate is the login
    loginInFlight ??= (async () => {
      loginOutcome = await runLocalLogin(config, manager, {
        localStorage: localLogin,
        ...(deps.loginPrompt === undefined ? {} : { prompt: deps.loginPrompt }),
        ...(deps.loginInput === undefined ? {} : { input: deps.loginInput }),
        ...(deps.loginOutput === undefined ? {} : { output: deps.loginOutput }),
        ...(deps.loginAttempts === undefined ? {} : { attempts: deps.loginAttempts }),
      });
      failure =
        loginOutcome.status === 'failed'
          ? {
              phase: 'failed',
              headline: loginOutcome.message,
              ...(loginOutcome.detail === null ? {} : { detail: loginOutcome.detail }),
            }
          : null;
      publish();
    })();
    await loginInFlight;
  };

  return {
    config,
    manager,
    storage,
    writeNullStorage: localLogin === null ? (storage as WriteNullStorage) : null,
    tokenSource,
    store,
    localStorage: localLogin,

    view() {
      current ??= computeView();
      return current;
    },

    onViewChange(listener) {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },

    onEnd(listener) {
      endListeners.add(listener);
      return () => {
        endListeners.delete(listener);
      };
    },

    signIn,

    async start() {
      if (descriptor === null || tokenSource === null) {
        // Local mode: the sign-in IS the start (U9). `runLocalLogin` runs
        // `manager.restore()` itself, so a stored credential is exchanged
        // before the prompt is ever reached, and the recorded outcome decides
        // the view: `cancelled` stays signed out, `failed` is a failure the
        // member can read, `authenticated` is the online path below.
        await signIn();
        // The gateway may already have reported a transition; either way the
        // view is refreshed from the state the sign-in landed.
        publish();
        return;
      }

      let first: DescriptorFrame;
      try {
        first = await awaitFirstFrame(descriptor, decoder, {
          timeoutMs: deps.firstTokenTimeoutMs ?? FIRST_TOKEN_TIMEOUT_MS,
          now,
        });
      } catch (err) {
        failure = classifyFailure(err, config.origin);
        publish();
        emitEnd('token_path_failed');
        return;
      }

      if (first.type === 'end') {
        emitEnd(first.reason);
        return;
      }

      // ORDERING (KTD8): the first token is published before the session makes
      // its first request, so no request is ever issued without a credential.
      tokenSource.publish(first.accessToken, first.expiresAt);
      await authenticate();

      pipe = startTokenPipe(descriptor, decoder, {
        onFrame: (frame) => {
          if (frame.type === 'end') {
            emitEnd(frame.reason);
            return;
          }
          tokenSource.publish(frame.accessToken, frame.expiresAt);
          retryIfNeeded();
        },
        onClose: () => {
          // The host closed the renewal channel: no further token can arrive,
          // so the session's remaining life is the current token's. Say so
          // rather than letting it expire into a silent stall (R19a).
          emitEnd('token_path_failed');
        },
      });
    },

    stop() {
      pipe?.stop();
      descriptor?.close();
      // The teardown clears local state and disconnects the gateway. In
      // access-only mode there is no refresh token, so no revocation call is
      // made, and the clear writes null — never a token (R27).
      //
      // In local mode this IS a sign-out: `logout()` revokes the refresh token
      // server-side and the credential-file adapter's `write(null)` removes the
      // file. That is the intended meaning of ending a locally run session, and
      // it is also the only reachable teardown: the manager arms a refresh
      // timer at login and clears it only in its own teardown, so a quit that
      // skipped `logout()` would leave the process alive until that timer
      // fired. Preserving the saved credential across a clean quit needs a
      // public non-logout teardown on `SessionManager` (reported, not invented
      // here).
      void manager.logout().catch(() => undefined);
    },
  };
}

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

/**
 * The page size this client asks for. 50 is the number the other two clients
 * use (`apps/web`'s `PAGE_SIZE`, `apps/mobile`'s `MESSAGE_PAGE_SIZE`), and the
 * server's own default: a page that comes back SHORTER than this is a page the
 * history ran out on (a thread page is the exception — see
 * {@link mergeThreadPage}).
 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * A synthetic sequence stamp for a LOCAL REST reconcile (a fetched thread
 * page). `applyGatewayEvent` drops any dispatch whose `s` is not above
 * `lastSeq` — the replay gate RESUMED traffic depends on — and a page load is
 * not a gateway frame, so its rows have to be stamped above the live session's
 * cursor or they are silently dropped. The counter seeds itself from the store
 * on every stamp rather than from a constant a long session can outrun; one
 * counter for the whole client, because two counters' ranges collide. The rule
 * is `apps/web/src/features/syntheticSeq.ts`'s and the mobile client's
 * `threads/threadWindow.ts`'s, stated there for the same reason.
 */
let localSeq = 1_000_000;

function nextLocalSeq(store: StateStore): number {
  localSeq = Math.max(localSeq, store.getState().lastSeq) + 1;
  return localSeq;
}

/**
 * Fold one REST page of THREAD replies into the shared store (U7).
 *
 * `@cytale/state` exports `mergeChannelMessages` for a channel's timeline and
 * no thread equivalent, so this takes the shape both other clients settled on
 * (web's `useThreads.loadReplies`, mobile's `mergeThreadMessages`): the rows
 * re-enter the store through the SHARED dispatcher — `applyGatewayEvent`'s
 * `ThreadMessageCreate` branch — which is what keeps ONE upsert/dedupe rule
 * (and the optimistic-placeholder shadowing) between a fetched page and a
 * gateway delivery. A `mergeThreadMessages` in `@cytale/state` would remove
 * this duplication; it is reported rather than invented here (this file may
 * not write that package).
 *
 * WHAT THE THREAD ROUTE GUARANTEES (#152). `GET /threads/:id/messages` reads
 * the thread's own locator, not a filtered walk of the parent channel, so:
 *
 *   * **A short page is the end.** A page with fewer rows than were asked for
 *     proves nothing older exists — the caller passes that as `complete`.
 *     (Before #152 the server applied `limit` BEFORE filtering by thread, and
 *     only an empty page could prove it.)
 *   * **The slice's `oldestId` stays derived** from the oldest row held, which
 *     equals the route's `oldest_id` now that pages are dense — so no second
 *     source of truth is recorded here.
 *
 * `complete` stays the caller's verdict rather than a length check in here.
 * The completeness write also CREATES the slice when the page was empty and no
 * slice existed, because otherwise a thread with no replies would look like a
 * thread that has not been fetched yet — and the pane would ask again on every
 * keystroke, forever.
 */
export function mergeThreadPage(
  store: StateStore,
  threadId: string,
  messages: readonly Message[],
  options: { readonly complete: boolean },
): void {
  // Oldest-first: the reducer counts a reply toward the thread summary only
  // when it is newer than the summary's latest (#106), so time order is what
  // lets a replayed page never inflate it.
  for (const message of [...messages].reverse()) {
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: nextLocalSeq(store),
      d: {
        id: message.id,
        channel_id: message.channel_id,
        thread_id: threadId,
        author_id: message.author_id,
        content: message.content,
        created_at: message.created_at,
        edited_at: message.edited_at,
      },
    });
  }
  if (!options.complete) return;
  store.setState((state) => {
    const slice = state.messagesByThread[threadId] ?? {
      items: [],
      oldestId: null,
      hasCompleteHistory: false,
    };
    if (slice.hasCompleteHistory) return {};
    return {
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: { ...slice, hasCompleteHistory: true },
      },
    };
  });
}

export interface RunClientOptions {
  readonly argv?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly deps?: ClientSessionDeps & { render?: RenderFn };
  /** Streams are injectable so the suite can read the client's own output. */
  readonly stdout?: { write(chunk: string): unknown };
  readonly stderr?: { write(chunk: string): unknown };
}

/**
 * Run the client and resolve with its exit code.
 *
 *   0 — the client ran and the session ended (the host owns the message that
 *       follows, and its own exit accounting).
 *   1 — the session ended through a token-path failure.
 *   2 — the client never connected: a usage error or a host misconfiguration.
 *
 * Nothing is drawn before the origin resolves, and a usage error never reaches
 * a session at all — "a missing URL produces a usage error rather than a
 * connection attempt" is a property of this function's shape, not a rule the
 * caller has to remember.
 *
 * ---------------------------------------------------------------------------
 * What the host wires here (U6 + U9 + U12)
 * ---------------------------------------------------------------------------
 *
 * This is the one place the three seams meet, so each is stated rather than
 * implied by the order of the statements below:
 *
 *   * **Before anything is drawn, local mode signs in** (U9). The prompt and
 *     the Ink tree both write to the terminal, so the sign-in runs to
 *     completion while the tree does not exist yet. It is why the sign-in is
 *     awaited before `renderApp` and not inside `start()`.
 *   * **The hydrator is constructed over the session's OWN store** (U12).
 *     `session.store` is the instance the session writes and the shell
 *     renders, so column one cannot end up reading a store nothing fills.
 *   * **The shell gets its store, the load's snapshot, and its host callbacks**
 *     (U6, and then U8, U10 and U14). `onQuit` is the load-bearing one: the
 *     shell's `q` tears down the Ink tree itself, and without this callback
 *     `runClient` would keep awaiting a session whose screen is gone — a blank
 *     terminal over a live SSH session. The rest are the units' own seams,
 *     wired here because this is the only place that holds BOTH the session
 *     (the api and the store) and the shell:
 *
 *       - `onSendTo` — U8's `createSender`, which writes the optimistic row
 *         through `@cytale/state` and settles it against the server's own
 *         message. The shell passes the RESOLVED target, so a message typed
 *         during a conversation switch cannot land in the wrong channel.
 *       - `onConversationOpened` / `onMarkRead` / `onMarkUnread` — U10's
 *         `createReadState`, over the ordinary `POST /channels/{id}/ack` route
 *         (the floor rides the same route through the api-client's
 *         `unreadFloor` option). These three are hoisted into stable consts
 *         because the shell's read capture is an EFFECT with the callback in
 *         its dependency list: a fresh closure per render would re-acknowledge
 *         on every render.
 *       - `onToggleReaction` — U14's `toggleOwnReaction`, addressing only the
 *         member's own `@me` reaction. The shell renders the outcome's error
 *         line, so a refusal is visible rather than silent.
 *       - `onLoadHistory` — U7's loader: one page of history, folded into the
 *         session's own store (see {@link mergeThreadPage} for the thread leg
 *         and its two route-imposed limits). The shell asks for it when a pane
 *         has nothing to draw or when its cursor reaches the oldest row it
 *         holds, and the returned promise IS the pane's pending state — so a
 *         rejection here renders inline, holding the rows the member has.
 *       - `onSearchQuery` — U13's fetch, in the scope the query names
 *         (`searchScopeFor` follows column one's mode): the active workspace's
 *         segment, or the account-wide DM one. The DM segment answers the
 *         server's own 501 `search_not_available` today, which is the pane's
 *         `unavailable` state — an honest error, not a hang.
 */
export async function runClient(options: RunClientOptions = {}): Promise<number> {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const renderApp: RenderFn = options.deps?.render ?? ((node: ReactElement) => render(node));

  if (wantsHelp(argv)) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }

  let config: ClientConfig;
  try {
    config = parseInvocation({ argv, env });
  } catch (err) {
    if (err instanceof ClientConfigError) {
      const where = err.kind === 'host-config' ? 'host configuration error' : 'usage error';
      stderr.write(`cytale-tui: ${where}: ${err.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw err;
  }

  const session = createClientSession(config, {
    ...(options.deps ?? {}),
    // The prompt writes to the stream this run was handed, so one injection
    // covers the client's own output and the sign-in's.
    loginOutput: options.deps?.loginOutput ?? stdout,
  });

  // U12's boot load: one owner for the workspace/channel/member/DM graph, over
  // the session's own store (see the header).
  const hydrator: Hydrator = createHydrator({
    api: session.manager.api,
    store: session.store,
    origin: config.origin,
  });

  // U8's send path: the draft check, the optimistic row, and the settle pass,
  // over the session's own store and api. The shell passes the resolved target.
  const sender = createSender({ store: session.store, api: session.manager.api });

  // U10's read state: the badge (a projection) and the two writes, both on the
  // ack route. `setUnreadFloor` is the api-client's `unread_floor` on the same
  // call, which is what makes "mark unread" persist server-side.
  const readState: ReadState = createReadState({
    store: session.store,
    transport: {
      ack: (channelId, messageId) => session.manager.api.ackChannel(channelId, messageId),
      setUnreadFloor: (channelId, body) =>
        session.manager.api.ackChannel(channelId, body.message_ids[0]!, {
          unreadFloor: body.unread_floor,
        }),
    },
  });

  // The read callbacks are EFFECT DEPENDENCIES in the shell (its capture fires
  // when the selection changes, with the callback in the dependency list), so
  // they are hoisted rather than built per render: a fresh closure every render
  // would acknowledge again every render.
  const onConversationOpened = (channelId: string): void => {
    void readState.markRead(channelId);
  };
  const onMarkRead = (channelId: string): void => {
    void readState.markRead(channelId);
  };
  const onMarkUnread = (messageId: string, channelId: string): void => {
    void readState.markUnread(channelId, messageId);
  };

  // -------------------------------------------------------------------------
  // U7's loader and U13's search fetch — the shell's two remaining seams
  // -------------------------------------------------------------------------
  //
  // Both are the same shape as the seams above: they own the api and the
  // store, and the shell owns the pane that reads the result. Neither catches
  // anything — a rejected promise IS the shell's error state, and it renders
  // the cause inline (`historyErrorLine`, `classifySearchFailure`), so wrapping
  // a failure in a resolved value here would hide it from the member.

  const loadHistory = async (request: HistoryRequest): Promise<void> => {
    if (request.kind === 'thread') {
      // A seed message with no thread record has no reply route to read. The
      // shell does not ask for one (`needsFirstPage` is false without a thread
      // id); this is the belt to that brace, so no request is aimed at a
      // thread id that does not exist.
      if (request.threadId === null) return;
      const page = await session.manager.api.getThreadMessages(request.threadId, {
        ...(request.before === null ? {} : { before: request.before }),
        limit: HISTORY_PAGE_SIZE,
      });
      // The thread route is thread-scoped (#152), so — as for a channel — a
      // page shorter than the one asked for is the last one.
      mergeThreadPage(session.store, request.threadId, page, {
        complete: page.length < HISTORY_PAGE_SIZE,
      });
      return;
    }

    const page = await session.manager.api.getMessagePage(request.channelId, {
      ...(request.before === null ? {} : { before: request.before }),
      limit: HISTORY_PAGE_SIZE,
    });
    // The channel route is authoritative about the end of its history, so a
    // page shorter than the one that was asked for is the last one — the rule
    // `@cytale/state`'s other two callers (web, mobile) apply.
    mergeChannelMessages(session.store, request.channelId, page.items, {
      isLastPage: page.items.length < HISTORY_PAGE_SIZE,
    });
  };

  const onSearchQuery = (request: SearchRequest): Promise<unknown> => {
    if (request.scope === 'dms') return session.manager.api.searchDMs(request.query);
    // The shell never issues a workspace-scoped query without a workspace
    // (`buildSearchRequest` answers null for one, and the pane renders that as
    // its idle state), so this is a guard rather than a fallback: a query aimed
    // at nothing is not aimed at `/workspaces//search` either, and the pane
    // shows the reason.
    if (request.workspaceId === null) {
      return Promise.reject(new Error('no workspace to search'));
    }
    return session.manager.api.searchWorkspace(request.workspaceId, request.query);
  };

  if (config.mode === 'local') {
    // U9's ordering: the sign-in owns the terminal until it is done, so it runs
    // BEFORE the tree mounts. A cancelled prompt leaves the view signed out, a
    // failed one a failure the member can read; either way the tree below is
    // what renders it.
    await session.signIn();
  }

  let settled = false;
  let endReason: string | null = null;
  let resolveEnded: (() => void) | null = null;
  const ended = new Promise<void>((resolve) => {
    resolveEnded = resolve;
  });

  let instance: ReturnType<RenderFn> | null = null;
  let unsubscribeView: () => void = () => undefined;
  let unsubscribeHydration: () => void = () => undefined;

  const finish = (reason: string | null): void => {
    if (settled) return;
    settled = true;
    endReason = reason;
    unsubscribeView();
    unsubscribeHydration();
    hydrator.stop();
    // Leave the terminal readable BEFORE the host's message prints: unmounting
    // the Ink tree releases the cursor and restores the screen it drew on, so
    // the host's reason lands on a clean slate instead of over live chrome.
    instance?.unmount();
    if (reason !== null) {
      stdout.write(`\n${sessionEndMessage(reason, { reissueUrl: reissueUrl(config.origin) })}\n`);
    }
    resolveEnded?.();
  };

  // `createElement`, not JSX: this file is the CLI entry and stays a `.ts`
  // module (`app.tsx` owns the JSX). The element is identical.
  const banner = (view: ConnectionView): ReactElement =>
    createElement(App, {
      mode: config.mode,
      origin: config.origin,
      view,
      // U6's host surface: the store the columns project from, the boot load's
      // snapshot for column one's states, and the quit binding.
      store: session.store,
      navigation: hydrator.snapshot(),
      onQuit: () => finish(null),
      // U8's send, U10's read state (the capture at the SELECTION, the `r`
      // binding, and the floor), and U14's own-reaction toggle. The read three
      // are the hoisted consts above, for the reason stated there.
      onSendTo: sender,
      onConversationOpened,
      onMarkRead,
      onMarkUnread,
      onToggleReaction: (target, messageId, emoji): Promise<ReactionOutcome> =>
        toggleOwnReaction({
          store: session.store,
          api: session.manager.api,
          channelId: target.channelId,
          messageId,
          emoji,
        }),
      // U7's pagination and U13's search: the two seams above, over the same
      // session and the same store as every other callback here.
      onLoadHistory: loadHistory,
      onSearchQuery,
    });

  const draw = (view: ConnectionView): void => {
    instance?.rerender(banner(view));
  };
  instance = renderApp(banner(session.view()));
  unsubscribeView = session.onViewChange(draw);
  // The shell renders the load's phases, so every hydration publish redraws.
  unsubscribeHydration = hydrator.subscribe(() => {
    draw(session.view());
  });

  session.onEnd((reason) => {
    finish(reason);
  });
  const onSigint = (): void => {
    finish(null);
  };
  process.once('SIGINT', onSigint);

  try {
    await session.start();
    // Started AFTER the session, and NOT awaited: the fan-out is the shell's
    // data, not a gate on the process's exit — a member who quits during a slow
    // load must not be held by it. The store keeps whatever has landed.
    void hydrator.start().catch(() => undefined);
    await ended;
  } finally {
    process.off('SIGINT', onSigint);
    hydrator.stop();
    session.stop();
  }

  return endReason === 'token_path_failed' ? 1 : 0;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  void runClient()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`cytale-tui: ${describeError(err)}\n`);
      process.exitCode = 1;
    });
}
