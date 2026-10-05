/**
 * @cytale/tui — the token descriptor (KTD8), the client's half.
 *
 * The SSH host mints a fresh access token for the member's certificate, hands
 * the client a descriptor number at spawn, and writes each token down that
 * descriptor. The client never handles a refresh token and never persists a
 * token (R27): this file is the whole of the renewal path's input side, and it
 * only ever produces VALUES — nothing here touches the filesystem for writing.
 *
 * ---------------------------------------------------------------------------
 * The contract with the host (U4 owns the other half of it)
 * ---------------------------------------------------------------------------
 *
 * Environment (the host constructs the child's environment; R14):
 *
 *   CYTALE_ORIGIN    the Cytale server origin the host is configured with.
 *                    The ONLY origin source in SSH mode — a session-supplied
 *                    command-line URL is ignored, so a member cannot redirect
 *                    a freshly minted token at a server of their choosing.
 *   CYTALE_TOKEN_FD  the inherited descriptor number. Its PRESENCE is what
 *                    selects SSH mode: a client handed a descriptor is a
 *                    client whose identity was already verified by the host.
 *
 * Framing: newline-delimited JSON, UTF-8, one frame per line. Two frame kinds,
 * and nothing else is a frame:
 *
 *   {"access_token":"<jwt>","expires_in":900}
 *       a live token. `expires_in` is seconds from the host's write; the
 *       absolute form `{"access_token":…,"expires_at":<ms since epoch>}` is
 *       also accepted, and neither means "expiry unknown" (usable, not
 *       expired — see `AccessTokenSource`).
 *   {"end":"<reason>"}
 *       the host is ending the session and names why. The host writes this
 *       BEFORE it closes the write end, so the reason arrives as a frame and
 *       not as a bare end-of-stream: an unknown code still ends the session and
 *       is named verbatim rather than swallowed.
 *
 * The reason vocabulary is the host's, and both sides spell it identically
 * (see `endFrameCode` in `apps/ssh-host/internal/session/handoff.go`).
 * `SESSION_END_REASONS` below is exactly that list — the six codes the host
 * pushes down this descriptor, because those are the endings it decides while
 * this client is still running:
 *
 *   max_session_duration, idle_timeout, certificate_expired,
 *   credential_epoch_moved, bridge_refused, token_path_failed
 *
 * The host's remaining codes — a clean or failed client exit, a client that
 * never started, a session refused before a client existed (`no_pty`,
 * `command_not_supported`, `identity_missing`, `session_limit`,
 * `bridge_unreachable`, a startup `bridge_refused`), and `connection_lost` —
 * never travel on this descriptor: there is no live reader, or no descriptor at
 * all, when they happen. They reach the member on the SSH channel after this
 * process exits, not here.
 *
 * The ORDERING the plan fixes: the host writes the first token before the
 * child can issue its first request, and this client does not authenticate
 * until it has read one (`awaitFirstToken`). Renewals are then a background
 * push — the pipe reader publishes each later token into the session's token
 * source, which is the live request path's answer for every subsequent call.
 * The reader is deliberately NOT hooked to the storage adapter: `TokenStorage`
 * is synchronous by contract and is consulted for a refresh token this session
 * does not have.
 *
 * Malformed input is DROPPED, never fatal: a garbled line (not JSON, no token
 * field, an empty token) is ignored and the reader keeps waiting, because the
 * alternative is a client that dies at startup on one bad write. A descriptor
 * that closes, or one that never yields a token, is a token-path failure —
 * the one condition this file reports rather than ignores.
 */
import net from 'node:net';

/** The inherited descriptor number the host hands the client (SSH mode). */
export const TOKEN_DESCRIPTOR_ENV = 'CYTALE_TOKEN_FD';

/** The host-configured server origin (R14; the only origin source in SSH mode). */
export const SERVER_ORIGIN_ENV = 'CYTALE_ORIGIN';

/**
 * R19a's session-end vocabulary, as the host names it on the wire.
 *
 * These are the codes the host can send on an `end` frame — the endings it
 * decides while this client is still running — spelled exactly as
 * `apps/ssh-host/internal/session/handoff.go` spells them. It is the whole
 * vocabulary: a code the host never sends is not listed, and a listed code is
 * one the host really sends.
 */
export const SESSION_END_REASONS = [
  'max_session_duration',
  'idle_timeout',
  'certificate_expired',
  'credential_epoch_moved',
  'bridge_refused',
  'token_path_failed',
] as const;

export type SessionEndReason = (typeof SESSION_END_REASONS)[number];

/** A live token: the value the session presents on its next request. */
export interface TokenFrame {
  readonly type: 'token';
  readonly accessToken: string;
  /** Expiry in ms since epoch, or 0 when the host did not say (usable). */
  readonly expiresAt: number;
}

/** The host is ending the session. `reason` is a vocabulary code, or raw text. */
export interface SessionEndFrame {
  readonly type: 'end';
  readonly reason: string;
}

export type DescriptorFrame = TokenFrame | SessionEndFrame;

/**
 * Parse one line into a frame, or null when it is not a frame.
 *
 * `now` is injected so the relative/absolute expiry forms are testable without
 * touching the clock. Anything that is not an object carrying a non-empty
 * `access_token` string or an `end` string is not a frame — the JWT *shape*
 * check stays in `@cytale/session` (`#usableSourceToken`), which owns the
 * rule that a malformed token is never adopted and never tears a live session
 * down. This function's job is narrower: it must not throw on garbage.
 */
export function parseDescriptorFrame(line: string, now: number): DescriptorFrame | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;

  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (typeof record.end === 'string' && record.end !== '') {
    return { type: 'end', reason: record.end };
  }

  const token = record.access_token;
  if (typeof token !== 'string' || token === '') return null;

  const expiresIn = record.expires_in;
  const expiresAt = record.expires_at;
  if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0) {
    return { type: 'token', accessToken: token, expiresAt };
  }
  if (typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0) {
    return { type: 'token', accessToken: token, expiresAt: now + expiresIn * 1000 };
  }
  return { type: 'token', accessToken: token, expiresAt: 0 };
}

/**
 * Bytes in, frames out. Line-oriented, so a frame split across two reads is
 * reassembled and two frames in one read are both emitted; a malformed line is
 * dropped whole (never merged into the next line, never thrown).
 */
export class DescriptorDecoder {
  #buffer = '';

  /** Bytes held back from the last push (an incomplete line). */
  get pending(): string {
    return this.#buffer;
  }

  push(chunk: string): DescriptorFrame[] {
    this.#buffer += chunk;
    const frames: DescriptorFrame[] = [];
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      const frame = parseDescriptorFrame(line, Date.now());
      if (frame !== null) frames.push(frame);
      newline = this.#buffer.indexOf('\n');
    }
    return frames;
  }
}

/**
 * A readable descriptor. `read()` resolves with whatever bytes arrived, or
 * null at end-of-stream (the host closed the pipe, or died).
 *
 * Deliberately minimal — one outstanding read at a time, no polling — because
 * the descriptor is a pipe: a read on one does not return 0 bytes, it waits,
 * which is exactly the semantics a renewal channel needs.
 */
export interface TokenDescriptor {
  read(): Promise<string | null>;
  close(): void;
}

/**
 * The stream surface a descriptor needs. Deliberately structural rather than
 * `net.Socket`, so the pipe can be handed in as whatever the runtime already
 * has — the socket wrapping an inherited number, or an existing stdio pipe on
 * it — and so the reader is testable against a real pipe without reaching for
 * a numeric file descriptor.
 */
export interface DescriptorStream {
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string) => void): unknown;
  on(event: 'end', listener: () => void): unknown;
  on(event: 'error', listener: (err: unknown) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  destroy(error?: Error): unknown;
}

/**
 * The real thing: a byte stream that can be read WITHOUT blocking the event
 * loop and closed mid-read.
 *
 * Why a socket and not `fs.read(2)`: a blocked `fs.read` on a pipe cannot be
 * cancelled — closing the number underneath it leaves the threadpool read
 * pending, and the client could not exit after a token-path failure (the
 * abandoned read keeps the loop alive). Destroying the socket stops the read.
 * UTF-8 decoding is the stream's, so a multi-byte character split across two
 * pipe writes cannot become mojibake.
 *
 * One shell's worth of buffering: chunks are queued so a `read()` issued later
 * still sees bytes that arrived earlier — a renewal that lands while the first
 * token is still being authenticated must not be dropped.
 */
export function descriptorFromStream(stream: DescriptorStream): TokenDescriptor {
  stream.setEncoding('utf8');

  const queued: string[] = [];
  let pending: ((value: string | null) => void) | null = null;
  let ended = false;
  let failure: Error | null = null;

  const settle = (value: string | null): void => {
    const resolve = pending;
    pending = null;
    resolve?.(value);
  };

  // The listeners exist from construction: the host may write before the first
  // read is issued, and a stream with no 'data' listener would buffer that
  // write where nothing could see it.
  stream.on('data', (chunk: string) => {
    if (pending !== null) settle(chunk);
    else queued.push(chunk);
  });
  stream.on('end', () => {
    ended = true;
    settle(null);
  });
  stream.on('error', (err: unknown) => {
    failure = err instanceof Error ? err : new Error(String(err));
    settle(null);
  });
  stream.on('close', () => {
    ended = true;
    settle(null);
  });

  return {
    read() {
      const buffered = queued.shift();
      if (buffered !== undefined) return Promise.resolve(buffered);
      if (failure !== null) return Promise.reject(failure);
      if (ended) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        pending = resolve;
      });
    },
    close() {
      ended = true;
      queued.length = 0;
      settle(null);
      // Takes the descriptor with it: the stream owns the number from here.
      stream.destroy();
    },
  };
}

/** The descriptor number the host handed over, as a stream. */
export function descriptorFromFd(fd: number): TokenDescriptor {
  return descriptorFromStream(new net.Socket({ fd, readable: true, writable: false }));
}

/** Why a session's token path failed (R19a renders these). */
export type TokenPathFailure = 'closed' | 'timeout' | 'unreadable';

/** The token path could not supply a token — a session-ending condition. */
export class TokenPathError extends Error {
  readonly failure: TokenPathFailure;

  constructor(failure: TokenPathFailure, message: string) {
    super(message);
    this.name = 'TokenPathError';
    this.failure = failure;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read until one frame arrives, or the wait is over. Resolves a token frame,
 * an end frame, or nothing but a `TokenPathError` — the caller must not issue
 * a request before this resolves, which is the plan's fixed ordering (the host
 * writes the first token before the child can ask for anything).
 */
export async function awaitFirstFrame(
  descriptor: TokenDescriptor,
  decoder: DescriptorDecoder,
  options: { timeoutMs: number; now?: () => number } = { timeoutMs: 30_000 },
): Promise<DescriptorFrame> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;

  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) {
      throw new TokenPathError(
        'timeout',
        `No token arrived on the session descriptor within ${Math.round(options.timeoutMs / 1000)}s.`,
      );
    }

    const read = descriptor.read();
    // The race below may abandon this read; a later rejection must not surface
    // as an unhandled rejection. The descriptor is closed by the caller on the
    // timeout path, which is what unblocks it.
    read.catch(() => undefined);
    let chunk: string | null;
    try {
      chunk = await Promise.race([
        read,
        sleep(remaining).then((): string | null => {
          throw new TokenPathError('timeout', 'The session descriptor never produced a token.');
        }),
      ]);
    } catch (err) {
      if (err instanceof TokenPathError) throw err;
      throw new TokenPathError('unreadable', describe(err));
    }

    if (chunk === null) {
      throw new TokenPathError('closed', 'The host closed the session descriptor before sending a token.');
    }

    const frames = decoder.push(chunk);
    const frame = frames[0];
    if (frame !== undefined) return frame;
    // Only malformed lines so far: keep waiting rather than failing at startup.
  }
}

export interface TokenPipeCallbacks {
  onFrame(frame: DescriptorFrame): void;
  /** The descriptor reached end-of-stream: no further renewals will arrive. */
  onClose(): void;
}

export interface TokenPipe {
  stop(): void;
}

/**
 * The background reader: every later frame is pushed to `onFrame` as it
 * arrives, and a closed descriptor is reported once. Used only AFTER the first
 * frame has been read, so it inherits the decoder's leftover bytes and the
 * first token cannot be delivered twice.
 */
export function startTokenPipe(
  descriptor: TokenDescriptor,
  decoder: DescriptorDecoder,
  callbacks: TokenPipeCallbacks,
): TokenPipe {
  let stopped = false;

  void (async () => {
    while (!stopped) {
      let chunk: string | null;
      try {
        chunk = await descriptor.read();
      } catch {
        // A read that fails after the first frame is a closed pipe from this
        // side's point of view: the next token is not coming.
        break;
      }
      if (chunk === null) break;
      for (const frame of decoder.push(chunk)) {
        if (stopped) return;
        callbacks.onFrame(frame);
      }
    }
    if (!stopped) callbacks.onClose();
  })();

  return {
    stop() {
      stopped = true;
    },
  };
}

function describe(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}
