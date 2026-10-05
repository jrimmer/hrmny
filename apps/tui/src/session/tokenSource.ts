/**
 * @cytale/tui — the token source (KTD8) and the write-null storage adapter
 * (R27).
 *
 * Two halves of the same guarantee, kept in one file because they are one
 * decision: in SSH mode the token arrives over a descriptor and must never
 * reach a disk.
 *
 * **The source.** `@cytale/session`'s access-only mode asks a supplied
 * `AccessTokenSource` for the current token and its expiry on EVERY request,
 * so the answer has to be synchronous and authoritative. This object owns one
 * in-memory value; the descriptor reader (`tokenPipe.ts`) replaces it when a
 * renewal arrives. Nothing here reads a file, and — the point the plan makes —
 * nothing here is reachable from `TokenStorage.read()`, which is synchronous
 * by contract: the storage adapter holds no token at all, so there is no path
 * from a synchronous read to the renewal channel.
 *
 * **The storage.** SSH mode is given an adapter whose `write` does nothing.
 * R27 therefore holds by construction: there is no code path in which a
 * Cytale token could be written, whether or not some future refactor tried to
 * call the persisting setter. The counts below exist so a test asserts that
 * (a) the running client never even attempts a write, and (b) a write attempt
 * — the refactor case — still lands nothing.
 *
 * Local mode is deliberately NOT wired to a persistent adapter here: the
 * credential file, its permissions, and its lifecycle are the local-mode
 * login unit's deliverable (U9), and inventing a second file format ahead of
 * it would ship a token store this plan did not design.
 */
import type { AccessTokenSource } from '@cytale/session';
import type { StoredTokenPair, TokenStorage } from '@cytale/session';

/** The source's current answer (diagnostics and tests). */
export interface TokenSourceSnapshot {
  readonly accessToken: string | null;
  readonly expiresAt: number;
}

export interface ClientTokenSource extends AccessTokenSource {
  /**
   * Publish a renewed token. Called by the descriptor reader when a frame
   * arrives — never from the storage adapter, and never from a request path.
   */
  publish(accessToken: string, expiresAt: number): void;
  /** The in-memory value right now. */
  current(): TokenSourceSnapshot;
}

/**
 * The in-memory answer to "what token should the next request present?".
 * Starts empty: a session with no token yet reports `access_token_missing`
 * rather than presenting '' as a credential.
 */
export function createTokenSource(): ClientTokenSource {
  let accessToken: string | null = null;
  let expiresAt = 0;

  return {
    getAccessToken: () => accessToken,
    getAccessExpiresAt: () => expiresAt,
    publish(token: string, nextExpiresAt: number) {
      accessToken = token;
      expiresAt = nextExpiresAt;
    },
    current: () => ({ accessToken, expiresAt }),
  };
}

export interface WriteNullStorage extends TokenStorage {
  /**
   * Calls to `write`, of any kind. The client's own flow must leave this at
   * zero (R27); a teardown clearing an already-empty adapter may bump it, and
   * `tokenWrites` below is what distinguishes the two.
   */
  readonly writeCalls: number;
  /** Calls to `write` carrying a NON-NULL pair — i.e. an actual persistence. */
  readonly tokenWrites: number;
  /** Calls to `read` (always answered null: there is nothing persisted). */
  readonly readCalls: number;
}

/**
 * The SSH-mode adapter: reads nothing, writes nothing, holds nothing.
 *
 * `read()` returns null rather than a mirror of the live token on purpose — a
 * token visible through the storage contract is a token some future caller
 * could write, and the write-null property is what R27 actually rests on.
 */
export function createWriteNullStorage(): WriteNullStorage {
  let writeCalls = 0;
  let tokenWrites = 0;
  let readCalls = 0;

  const storage: WriteNullStorage = {
    get writeCalls() {
      return writeCalls;
    },
    get tokenWrites() {
      return tokenWrites;
    },
    get readCalls() {
      return readCalls;
    },
    read() {
      readCalls += 1;
      return null;
    },
    write(pair: StoredTokenPair | null) {
      writeCalls += 1;
      if (pair !== null && (pair.accessToken !== null || pair.refreshToken !== null)) {
        tokenWrites += 1;
      }
      // Deliberately empty: there is no storage to write to, so R27 cannot
      // depend on every caller behaving.
    },
    flush: async () => undefined,
  };

  return storage;
}
