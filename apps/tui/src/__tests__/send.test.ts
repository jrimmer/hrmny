/**
 * @cytale/tui — the send path against a real server (U8; R20, R21; KTD5, KTD8).
 *
 * `composer.test.ts` drives the surface the member types into; this file is the
 * half underneath it, and it is asserted with REAL sockets and REAL package
 * code:
 *
 *   * the draft rules the server would enforce (`content must be 1-4000
 *     BYTES`) are enforced LOCALLY, before a request exists;
 *   * a send writes the optimistic row through `@cytale/state` FIRST and
 *     settles it against the server's own row, so "renders immediately" and
 *     "does not render twice" are the same machinery the web client uses;
 *   * the request is the one the server documents — the channel endpoint with
 *     `thread_id` for a reply, and the nonce as the `Idempotency-Key`, so a
 *     retry cannot double-post;
 *   * a rejection rolls the row back and comes back as a VALUE (the composer
 *     keeps the member's text);
 *   * the token the request carries is the session's CURRENT one, so a renewal
 *     the host pushed down the descriptor is used by the next send (KTD8) —
 *     asserted against the `Authorization` header the server actually saw, not
 *     against a stub.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { ApiError, CytaleApiClient, createInMemoryTokenProvider } from '@cytale/api-client';
import type { GatewayClient, GatewayClientOptions } from '@cytale/gateway-client';
import type { Message } from '@cytale/domain';
import { createSessionManager, type AccessTokenSource } from '@cytale/session';
import { createStateStore, type StateStore } from '@cytale/state';

import { createSender, checkDraft, MAX_MESSAGE_BYTES } from '../compose/send.js';
import { buildContentView } from '../columns/ContentColumn.js';
import { createWriteNullStorage } from '../session/tokenSource.js';

const WORKSPACE = '100000000000000001';
const GENERAL = '300000000000000001';
const THREAD = '700000000000000001';
const ME = '900000000000000001';
/**
 * The rows the fixture server "persists", one per accepted POST — distinct ids,
 * so two sends are two messages and a duplicate would be visible.
 */
const ROW_IDS = ['800000000000000041', '800000000000000042'] as const;

const TOKEN_A = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWE';
const TOKEN_B = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJlLWI';

const TARGET = {
  kind: 'channel' as const,
  channelId: GENERAL,
  threadId: null,
  label: '#general',
};

// ---------------------------------------------------------------------------
// A real Cytale-shaped socket
// ---------------------------------------------------------------------------

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | null;
  readonly idempotencyKey: string | null;
  readonly body: { content?: string; thread_id?: string | null };
}

/** The error envelope the server answers with (`Cytale`'s one error shape). */
const FORBIDDEN = { error: { key: 'forbidden', code: 40301, message: 'you cannot post in this channel' } };

interface Fixture {
  readonly origin: string;
  readonly sent: Sent[];
  /**
   * Withhold the next answer, and resolve once the request is actually being
   * withheld — so "in flight" is a fact the server witnessed rather than a
   * timing guess.
   */
  hold(): Promise<void>;
  release(): void;
  /** Refuse the next POST with `FORBIDDEN`. */
  forbid(): void;
  close(): Promise<void>;
}

const alive = new Set<Server>();

afterEach(async () => {
  for (const server of [...alive]) {
    alive.delete(server);
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }
});

async function startServer(): Promise<Fixture> {
  const sent: Sent[] = [];
  /** Set while an answer should be withheld; called when the request arrives. */
  let armed: (() => void) | null = null;
  let forbidden = false;
  let created = 0;
  const held: Array<() => void> = [];

  const server = createServer((req, res) => {
    const url = req.url ?? '';
    let raw = '';
    req.on('data', (chunk: Buffer) => {
      raw += chunk.toString('utf8');
    });
    req.on('end', () => {
      const json = (status: number, payload: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (req.method === 'GET' && url.startsWith('/api/v1/users/@me')) {
        json(200, { user: { id: ME, username: 'tester', email: null, email_verified_at: null } });
        return;
      }

      const body = raw === '' ? {} : (JSON.parse(raw) as Sent['body']);
      sent.push({
        method: req.method ?? '',
        url,
        authorization: req.headers.authorization ?? null,
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
        body,
      });

      const answer = (): void => {
        if (forbidden) {
          forbidden = false;
          json(403, FORBIDDEN);
          return;
        }
        // The server's own row: same ids the request addressed, a real id of
        // its own (one per accepted POST).
        const id = ROW_IDS[created] ?? ROW_IDS[ROW_IDS.length - 1];
        created += 1;
        json(201, {
          message: {
            id,
            channel_id: GENERAL,
            thread_id: body.thread_id ?? null,
            author_id: ME,
            content: body.content ?? '',
            created_at: '2026-09-13T12:30:00.000Z',
            edited_at: null,
          },
        });
      };

      if (armed !== null) {
        const notify = armed;
        armed = null;
        held.push(answer);
        notify();
        return;
      }
      answer();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  alive.add(server);
  const address = server.address() as AddressInfo | null;
  if (address === null) throw new Error('the fixture server did not bind');

  return {
    origin: `http://127.0.0.1:${address.port}`,
    sent,
    hold: async () =>
      await new Promise<void>((resolve) => {
        armed = resolve;
      }),
    release: () => {
      for (const answer of held.splice(0)) answer();
    },
    forbid: () => {
      forbidden = true;
    },
    close: async () => {
      alive.delete(server);
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function makeApi(origin: string): CytaleApiClient {
  return new CytaleApiClient({
    baseUrl: `${origin}/api/v1`,
    tokens: createInMemoryTokenProvider({
      access_token: TOKEN_A,
      refresh_token: '',
      expires_in: 900,
    }),
  });
}

/** The store a session would hydrate, with just the member on it. */
function storeWithViewer(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'tester' } });
  return store;
}

/** The pane the member is looking at: the rows column two would draw. */
function renderedRows(store: StateStore): string[] {
  return buildContentView({
    source: store.getState(),
    conversationId: GENERAL,
    openThreadMessageId: null,
    width: 66,
  }).rows.map((row) => row.id);
}

/** The gateway seam: a session manager needs one, and nothing here dials out. */
function stubGateway(): (options: GatewayClientOptions) => GatewayClient {
  return () =>
    ({
      connect: async () => undefined,
      disconnect: () => undefined,
      destroy: () => undefined,
      onAny: () => () => undefined,
    }) as unknown as GatewayClient;
}

// ---------------------------------------------------------------------------
// The draft rules (checked before any request exists)
// ---------------------------------------------------------------------------

describe('checking a draft locally', () => {
  const me = { channelId: GENERAL, authorId: ME };

  it('refuses an empty draft, quietly', () => {
    for (const text of ['', '   ', '\n \n']) {
      const check = checkDraft(text, me);
      expect(check.ok).toBe(false);
      expect(check.refusal).toBe('empty');
      // No request, and nothing for the member to read either.
      expect(check.reason).toContain('Nothing to send');
    }
  });

  it('accepts exactly the limit and refuses a byte over it', () => {
    expect(checkDraft('x'.repeat(MAX_MESSAGE_BYTES), me).ok).toBe(true);
    const over = checkDraft('x'.repeat(MAX_MESSAGE_BYTES + 1), me);
    expect(over.ok).toBe(false);
    expect(over.refusal).toBe('too-long');
    // The reason names the limit AND the size of the draft, so the member can
    // act on it rather than guess what "too long" means (R28's standard).
    expect(over.reason).toContain(String(MAX_MESSAGE_BYTES));
    expect(over.reason).toContain(String(MAX_MESSAGE_BYTES + 1));
  });

  it('counts BYTES, so a CJK message is refused at the right length', () => {
    // Three bytes per glyph: 1,333 glyphs is 3,999 bytes, 1,334 is 4,002.
    expect(checkDraft('漢'.repeat(1333), me).ok).toBe(true);
    expect(checkDraft('漢'.repeat(1334), me).refusal).toBe('too-long');
  });

  it('refuses a draft with nowhere to go, and one with nobody to send as', () => {
    expect(checkDraft('hi', { channelId: '', authorId: ME }).refusal).toBe('no-target');
    expect(checkDraft('hi', { channelId: GENERAL, authorId: null }).refusal).toBe('no-author');
  });

  it('makes no request at all for a refused draft', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(fixture.origin) });

    const result = await send(TARGET, 'x'.repeat(MAX_MESSAGE_BYTES + 1));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('4000') });
    expect(fixture.sent).toHaveLength(0);
    // Nothing was written optimistically either: a refusal never touched the
    // store, so there is no rolled-back row to explain.
    expect(renderedRows(store)).toEqual([]);
    expect(store.getState().pendingByNonce).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// R20 — the send itself
// ---------------------------------------------------------------------------

describe('sending to the server', () => {
  it('writes the optimistic row first and settles it on the server row', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(fixture.origin) });

    const holding = fixture.hold();
    const pending = send(TARGET, 'hello world');
    // The member sees their message before the server has answered: the row is
    // in the store, under a client-local id, while the POST is still out.
    await holding;
    expect(renderedRows(store)).toHaveLength(1);
    expect(renderedRows(store)[0]?.startsWith('pending_')).toBe(true);
    expect(Object.keys(store.getState().pendingByNonce)).toHaveLength(1);

    fixture.release();
    const result = await pending;
    expect(result.ok).toBe(true);
    // Settled IN PLACE: one row, the server's id, no placeholder left.
    expect(renderedRows(store)).toEqual([ROW_IDS[0]]);
    expect(store.getState().pendingByNonce).toEqual({});
    expect(store.getState().messagesByChannel[GENERAL]?.items[0]?.content).toBe('hello world');
  });

  it('posts the channel message with the nonce as its Idempotency-Key', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(fixture.origin) });

    await send(TARGET, '  trimmed  ');

    expect(fixture.sent).toHaveLength(1);
    const request = fixture.sent[0];
    expect(request?.method).toBe('POST');
    expect(request?.url).toBe(`/api/v1/channels/${GENERAL}/messages`);
    // Surrounding whitespace is not content.
    expect(request?.body).toMatchObject({ content: 'trimmed' });
    expect(request?.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,}$/);
    // The placeholder the store held while the request was out is gone, and the
    // nonce it was keyed by is no longer a way to find a row.
    expect(store.getState().nonceByMessageId).toEqual({});
  });

  it('sends a thread reply on the channel endpoint with thread_id, into the thread pane', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(fixture.origin) });

    const result = await send({ ...TARGET, kind: 'thread', threadId: THREAD }, 'a reply');

    expect(result.ok).toBe(true);
    expect(fixture.sent[0]?.url).toBe(`/api/v1/channels/${GENERAL}/messages`);
    expect(fixture.sent[0]?.body).toMatchObject({ content: 'a reply', thread_id: THREAD });
    // The pane identity: the reply is in the thread's slice, not the channel's.
    expect(store.getState().messagesByThread[THREAD]?.items).toHaveLength(1);
    expect(store.getState().messagesByChannel[GENERAL]).toBeUndefined();
  });

  it('rolls the row back and reports the reason when the server refuses', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(fixture.origin) });

    fixture.forbid();
    const result = await send(TARGET, 'refused');

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ reason: expect.stringContaining('you cannot post in this channel') });
    // Nothing is left pretending the message went, and the shared store keeps
    // the record the other clients' retry surfaces read.
    expect(renderedRows(store)).toEqual([]);
    expect(store.getState().pendingByNonce).toEqual({});
    expect(Object.values(store.getState().failedByNonce)).toHaveLength(1);
    expect(Object.values(store.getState().failedByNonce)[0]).toMatchObject({
      channel_id: GENERAL,
      content: 'refused',
      error: { key: 'forbidden', code: 40301 },
    });
  });

  it('reports an unreachable server as a failure rather than hanging or throwing', async () => {
    const fixture = await startServer();
    const origin = fixture.origin;
    await fixture.close(); // nothing is listening on that port any more
    const store = storeWithViewer();
    const send = createSender({ store, api: makeApi(origin) });

    const result = await send(TARGET, 'into the void');

    expect(result.ok).toBe(false);
    expect(renderedRows(store)).toEqual([]);
    expect(Object.keys(store.getState().failedByNonce)).toHaveLength(1);
  });

  it('keeps a recoverable 401 retryable rather than treating it as a sign-out', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();
    const api = {
      sendMessage: async (): Promise<Message> => {
        throw new ApiError({
          key: 'session_expired',
          code: 40101,
          message: 'the access token is stale',
          status: 401,
        });
      },
    };
    const send = createSender({ store, api });

    const result = await send(TARGET, 'after a renewal');

    expect(result.ok).toBe(false);
    // The session renews its token from the host over the descriptor; the
    // member is told to try again rather than that they are signed out (KTD8).
    expect(result).toMatchObject({
      reason: expect.stringMatching(/renew|try|again/i),
    });
    expect(fixture.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// KTD8 — the token the request carries
// ---------------------------------------------------------------------------

describe('a token renewed mid-session', () => {
  it('is used by the next send rather than the expired one', async () => {
    const fixture = await startServer();
    const store = storeWithViewer();

    // The descriptor reader's half: one mutable value the session's api-client
    // asks for on every request (this is the seam KTD8 names).
    let token: string = TOKEN_A;
    let expiresAt = Date.now() + 15 * 60 * 1000;
    const source: AccessTokenSource = {
      getAccessToken: () => token,
      getAccessExpiresAt: () => expiresAt,
    };

    const session = createSessionManager({
      storage: createWriteNullStorage(),
      store,
      tokenSource: source,
      createGatewayClient: stubGateway(),
      resolveOrigin: () => fixture.origin,
    });
    await session.authenticateFromTokenSource();

    const send = createSender({ store, api: session.api });
    await send(TARGET, 'before the renewal');

    // The host mints a fresh token and writes it down the pipe; the reader
    // publishes it into the source the live request path reads.
    token = TOKEN_B;
    expiresAt = Date.now() + 15 * 60 * 1000;

    const second = await send(TARGET, 'after the renewal');

    expect(second.ok).toBe(true);
    const posts = fixture.sent.filter((request) => request.method === 'POST');
    expect(posts.map((request) => request.authorization)).toEqual([
      `Bearer ${TOKEN_A}`,
      `Bearer ${TOKEN_B}`,
    ]);
    // Both sends are messages the pane can show — the pane draws OLDEST FIRST
    // (R19's newest-last): the renewal lost nothing and duplicated nothing.
    expect(renderedRows(store)).toEqual([ROW_IDS[0], ROW_IDS[1]]);
  });
});
