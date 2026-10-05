/**
 * @cytale/web — a 429 on send is waited out, not shown (2026-09-28).
 *
 * The server's send budget is 10 sends / 5 s per conversation and 20 / 5 s
 * across conversations (docs/protocol/rest.md). Over a real store and the
 * real send queue, with fake timers standing in for the wait:
 *
 *  - a 429 holds the conversation's queue for Retry-After, then the SAME row
 *    goes again under the SAME nonce (header and body); the row reads
 *    "Sending…" throughout and is never marked failed; order is kept;
 *  - which queues hold comes from the limit the 429 names as data
 *    (`rateLimitScope`): `conversation` holds that conversation only; the
 *    sender's shared budget, the account or per-IP limits, an unknown scope
 *    or none hold every conversation;
 *  - a 25-message offline backlog into one conversation drains fully, in
 *    order, against a server that enforces the budget;
 *  - the retry cap: a send the server keeps refusing becomes a failed row
 *    with its manual Retry, and a hint longer than the cap fails at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import React from 'react';

import { ApiError } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

import { api, authStore } from '../../auth/session.js';
import { MessageItem } from '../MessageItem.js';
import { startSendAutoRetry } from '../sendAutoRetry.js';
import {
  SEND_RATE_LIMIT_MAX_RETRIES,
  SEND_RATE_LIMIT_MAX_WAIT_MS,
  useMessageSender,
  type UseMessages,
} from '../useMessages.js';

const CHANNEL = '9007199254740993';
const OTHER = '9007199254740995';
const ME = '7000000000000002';

function makeStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  return store;
}

function sender(store: StateStore): UseMessages['send'] {
  let send: UseMessages['send'] | null = null;
  function Probe() {
    send = useMessageSender(store).send;
    return null;
  }
  render(<Probe />);
  return send!;
}

function rows(store: StateStore, channelId = CHANNEL): Message[] {
  return [...(store.getState().messagesByChannel[channelId]?.items ?? [])].reverse();
}

/** Every send_state any row of `store` ever had — a failed flash would show here. */
function watchStates(store: StateStore): Set<string> {
  const seen = new Set<string>();
  const record = () => {
    const s = store.getState();
    for (const slice of Object.values(s.messagesByChannel)) {
      for (const m of slice?.items ?? []) if (m.send_state) seen.add(m.send_state);
    }
  };
  record();
  store.subscribe(record);
  return seen;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

/**
 * The server's native 429 on send. `scope` is the limit that tripped
 * (`ApiError.rateLimitScope`); the message is only for people, so every
 * refusal here carries the same one — the client must not read it.
 */
function rateLimited(retryAfterMs: number | null, scope: string | null = 'conversation'): ApiError {
  return new ApiError({
    key: 'rate_limited',
    code: 42901,
    message: 'Too many messages — try again in 2 seconds.',
    status: 429,
    retryAfterMs,
    rateLimitScope: scope,
  });
}

interface Posted {
  channelId: string;
  content: string;
  key: string | undefined;
  nonce: unknown;
  at: number;
}

let serial = 0;
function serverRow(channelId: string, content: string, nonce: unknown): Message {
  serial += 1;
  return {
    id: String(900_000_000_000 + serial),
    channel_id: channelId,
    thread_id: null,
    author_id: ME,
    content,
    nonce,
    created_at: new Date().toISOString(),
    edited_at: null,
  } as Message;
}

/**
 * The send endpoint, answering at once: `decide` returns an error to throw,
 * or null to accept (201 with a server row).
 */
function server(decide: (post: Posted, index: number) => ApiError | null): Posted[] {
  const posted: Posted[] = [];
  vi.spyOn(api, 'sendMessage').mockImplementation(async (channelId: string, body: unknown, key?: string) => {
    const b = body as { content: string; nonce?: unknown };
    const post: Posted = { channelId, content: b.content, key, nonce: b.nonce, at: Date.now() };
    posted.push(post);
    const refusal = decide(post, posted.length - 1);
    if (refusal) throw refusal;
    return serverRow(channelId, b.content, b.nonce);
  });
  return posted;
}

let browserOnline = true;
let stop: (() => void) | null = null;

beforeEach(() => {
  vi.useFakeTimers({ now: Date.parse('2026-09-28T12:00:00Z') });
  browserOnline = true;
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => browserOnline });
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  browserOnline = true;
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('a 429 on send is waited out', () => {
  it('pauses the conversation for Retry-After, then re-sends the SAME row under the SAME nonce; never failed; order kept', async () => {
    const store = makeStore();
    const seen = watchStates(store);
    // The second POST is refused once, with a 2 s hint.
    const posted = server((_post, i) => (i === 1 ? rateLimited(2_000) : null));
    const send = sender(store);
    const done = ['first', 'second', 'third'].map((t) => send(CHANNEL, t));
    const keys = rows(store).map((m) => m.client_key!);
    await flush();

    // first landed; second was refused and is waiting its turn — still pending.
    expect(posted.map((p) => p.content)).toEqual(['first', 'second']);
    expect(rows(store).map((m) => [m.content, m.send_state])).toEqual([
      ['first', undefined],
      ['second', 'pending'],
      ['third', 'pending'],
    ]);

    // Nothing leaves before the hint runs out — not even "third": it is behind.
    await advance(1_999);
    expect(posted).toHaveLength(2);
    await advance(1);
    await flush();

    expect(posted.map((p) => p.content)).toEqual(['first', 'second', 'second', 'third']);
    // The retry is the same send: same Idempotency-Key, same body nonce.
    expect(posted[2]!.key).toBe(keys[1]);
    expect(posted[2]!.nonce).toBe(keys[1]);
    expect(posted[2]!.at - posted[1]!.at).toBe(2_000);
    await act(async () => {
      await Promise.all(done);
    });

    expect(rows(store).map((m) => [m.content, m.client_key, m.send_state])).toEqual([
      ['first', keys[0], undefined],
      ['second', keys[1], undefined],
      ['third', keys[2], undefined],
    ]);
    expect(seen.has('failed')).toBe(false);
    expect(store.getState().failedByNonce).toEqual({});
    expect(store.getState().pendingByNonce).toEqual({});
  });

  it('the pending row reads "Sending…" while it waits — no failure line, no Retry', async () => {
    const store = makeStore();
    server((_post, i) => (i === 0 ? rateLimited(3_000) : null));
    const send = sender(store);
    void send(CHANNEL, 'patient');
    await flush();
    const row = rows(store)[0]!;
    expect(row.send_state).toBe('pending');
    render(<MessageItem message={row} currentUserId={ME} store={store} />);
    expect(screen.getByText('Sending…')).toBeTruthy();
    expect(screen.queryByTestId('message-send-failed')).toBeNull();
    expect(screen.queryByTestId('message-send-retry')).toBeNull();
    await advance(3_000);
    await flush();
    expect(rows(store)[0]!.send_state).toBeUndefined();
  });

  it('a conversation-scoped 429 holds only that conversation: another conversation sends meanwhile', async () => {
    const store = makeStore();
    let refuse: ApiError | null = rateLimited(2_000, 'conversation');
    const posted = server((post) => {
      if (post.channelId === CHANNEL && refuse) {
        const r = refuse;
        refuse = null;
        return r;
      }
      return null;
    });
    const send = sender(store);
    void send(CHANNEL, 'a1');
    await flush();
    void send(OTHER, 'b1');
    await flush();
    // OTHER went straight through while CHANNEL waits...
    expect(posted.map((p) => [p.channelId, p.content])).toEqual([
      [CHANNEL, 'a1'],
      [OTHER, 'b1'],
    ]);
    expect(rows(store, OTHER)[0]!.send_state).toBeUndefined();
    expect(rows(store)[0]!.send_state).toBe('pending');
    await advance(1_000);
    await flush();
    // ...and CHANNEL still waits out its own Retry-After...
    void send(OTHER, 'b2');
    await flush();
    expect(posted.map((p) => p.content)).toEqual(['a1', 'b1', 'b2']);
    await advance(1_000);
    await flush();
    // ...then goes again.
    expect(posted.map((p) => p.content)).toEqual(['a1', 'b1', 'b2', 'a1']);
    expect(store.getState().failedByNonce).toEqual({});
  });

  for (const scope of ['sender', 'account', 'ip', 'some-future-limit', null]) {
    it(`a ${scope === null ? 'scope-less' : `${scope}-scoped`} 429 holds every conversation`, async () => {
      const store = makeStore();
      let refuse: ApiError | null = rateLimited(2_000, scope);
      const posted = server((post) => {
        if (post.channelId === CHANNEL && refuse) {
          const r = refuse;
          refuse = null;
          return r;
        }
        return null;
      });
      const send = sender(store);
      void send(CHANNEL, 'a1');
      await flush();
      void send(OTHER, 'b1');
      await flush();
      // OTHER waits too: nothing else is posted while the hold lasts.
      expect(posted.map((p) => p.content)).toEqual(['a1']);
      expect(rows(store, OTHER)[0]!.send_state).toBe('pending');
      await advance(2_000);
      await flush();
      expect(posted.map((p) => p.content).sort()).toEqual(['a1', 'a1', 'b1']);
      expect(store.getState().failedByNonce).toEqual({});
      expect(store.getState().pendingByNonce).toEqual({});
    });
  }

  it('a 25-message offline backlog into one conversation drains fully and in order against the real budget', async () => {
    const store = makeStore();
    const seen = watchStates(store);
    stop = startSendAutoRetry(store);

    // The server's budget: 10 sends per conversation per 5 s window (the
    // window opens on the first counted send, like the server's counter).
    let windowEnd = 0;
    let count = 0;
    const accepted: string[] = [];
    let online = false;
    const posted = server((post) => {
      if (!online) return new ApiError({ key: 'network_error', code: 0, message: 'Failed to fetch', status: 0 });
      const now = Date.now();
      if (now >= windowEnd) {
        windowEnd = now + 5_000;
        count = 0;
      }
      count += 1;
      if (count > 10) {
        const retryMs = windowEnd - now;
        return rateLimited(Math.max(1, Math.ceil(retryMs / 1000)) * 1000);
      }
      accepted.push(post.content);
      return null;
    });

    browserOnline = false;
    act(() => {
      window.dispatchEvent(new Event('offline'));
    });
    const texts = Array.from({ length: 25 }, (_, i) => `backlog ${i + 1}`);
    const send = sender(store);
    const done = texts.map((t) => send(CHANNEL, t).catch(() => undefined));
    await act(async () => {
      await Promise.all(done);
    });
    expect(rows(store).every((m) => m.send_state === 'waiting')).toBe(true);
    const keys = rows(store).map((m) => m.client_key!);
    const offlinePosts = posted.length;

    online = true;
    browserOnline = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    // Let the queue work through the budget windows (three are needed).
    for (let i = 0; i < 40 && accepted.length < 25; i += 1) {
      await flush();
      await advance(500);
    }
    await flush();

    expect(accepted).toEqual(texts);
    expect(rows(store).map((m) => [m.content, m.client_key, m.send_state])).toEqual(
      texts.map((t, i) => [t, keys[i], undefined]),
    );
    // Every re-send presented its row's original key; the budget was met.
    const online429s = posted.length - offlinePosts - 25;
    expect(online429s).toBeGreaterThanOrEqual(2);
    for (const p of posted.slice(offlinePosts)) {
      expect(p.key).toBe(keys[texts.indexOf(p.content)]);
    }
    expect(seen.has('failed')).toBe(false);
    expect(store.getState().failedByNonce).toEqual({});
    expect(store.getState().pendingByNonce).toEqual({});
  });
});

describe('the retry cap', () => {
  it(`gives up after ${SEND_RATE_LIMIT_MAX_RETRIES} waited-out 429s: a failed row with Retry, same key on Retry`, async () => {
    const store = makeStore();
    let always = true;
    const posted = server(() => (always ? rateLimited(1_000) : null));
    const send = sender(store);
    const done = send(CHANNEL, 'stubborn').catch((e: unknown) => e);
    const key = rows(store)[0]!.client_key!;
    for (let i = 0; i < SEND_RATE_LIMIT_MAX_RETRIES; i += 1) {
      await flush();
      expect(rows(store)[0]!.send_state).toBe('pending');
      await advance(1_000);
    }
    await flush();
    const err = await done;
    expect((err as ApiError).status).toBe(429);
    // The first POST plus one per waited-out refusal.
    expect(posted).toHaveLength(SEND_RATE_LIMIT_MAX_RETRIES + 1);
    expect(posted.every((p) => p.key === key)).toBe(true);
    const row = rows(store)[0]!;
    expect(row.send_state).toBe('failed');
    expect(row.send_error?.key).toBe('rate_limited');

    render(<MessageItem message={row} currentUserId={ME} store={store} />);
    expect(screen.getByTestId('message-send-failed-reason').textContent).toContain(
      "You're sending messages faster than the server allows.",
    );
    expect(screen.getByTestId('message-send-retry')).toBeTruthy();

    // A manual Retry starts a fresh allowance, under the same key.
    always = false;
    screen.getByTestId('message-send-retry').click();
    await flush();
    expect(posted.at(-1)!.key).toBe(key);
    expect(rows(store)[0]!.send_state).toBeUndefined();
  });

  it(`a hint longer than the ${SEND_RATE_LIMIT_MAX_WAIT_MS / 1000}s total-wait cap fails at once, without waiting`, async () => {
    const store = makeStore();
    const posted = server(() => rateLimited(SEND_RATE_LIMIT_MAX_WAIT_MS + 1_000));
    const send = sender(store);
    const done = send(CHANNEL, 'too long a wait').catch((e: unknown) => e);
    await flush();
    expect(((await done) as ApiError).status).toBe(429);
    expect(posted).toHaveLength(1);
    expect(rows(store)[0]!.send_state).toBe('failed');
  });

  it('a 429 with no hint backs off 1 s, 2 s, 4 s', async () => {
    const store = makeStore();
    const posted = server((_p, i) => (i < 3 ? rateLimited(null) : null));
    const send = sender(store);
    const done = send(CHANNEL, 'no hint');
    await flush();
    await advance(1_000);
    await flush();
    await advance(2_000);
    await flush();
    await advance(4_000);
    await flush();
    await act(async () => {
      await done;
    });
    const gaps = posted.slice(1).map((p, i) => p.at - posted[i]!.at);
    expect(gaps).toEqual([1_000, 2_000, 4_000]);
    expect(rows(store)[0]!.send_state).toBeUndefined();
  });
});
