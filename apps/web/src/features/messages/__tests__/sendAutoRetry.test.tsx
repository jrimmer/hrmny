/**
 * @cytale/web — sends wait for the connection (send reliability B2).
 *
 * The offline banner promises "Messages will sync when the connection
 * returns". Over a real store and the real send queue:
 *
 *  - a send made offline is held as WAITING ("Waiting for connection…", no
 *    Retry), not "Failed";
 *  - when the connection returns, every waiting send goes out on its own, one
 *    POST at a time per conversation, in typed order, under its ORIGINAL
 *    nonce (header and body), and confirms in place;
 *  - a timed-out send is re-sent on reconnect too (same nonce — the server
 *    dedupes it);
 *  - a refusal from the server (4xx: validation, account_unverified) is never
 *    re-sent unasked;
 *  - an echo landing during the retry (or before it) never draws the message
 *    twice.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React from 'react';

import { ApiError } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import { applyGatewayEvent, createStateStore, nextSyntheticSeq, type StateStore } from '@cytale/state';

import { api, authStore } from '../../auth/session.js';
import { MessageItem } from '../MessageItem.js';
import { retryWaitingSends, startSendAutoRetry } from '../sendAutoRetry.js';
import { useMessageSender, type UseMessages } from '../useMessages.js';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const CHANNEL = '9007199254740993';
const OTHER = '9007199254740995';
const ME = '7000000000000002';

const EPOCH = 1_420_070_400_000n;
let baseMs = 0;
let base = 0n;
function sf(seq: number): string {
  return (base + BigInt(seq)).toString();
}

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

interface Posted {
  channelId: string;
  body: Record<string, unknown>;
  key: string | undefined;
  answer: (m: Partial<Message>) => void;
  fail: (e: unknown) => void;
}

function holdPosts(): Posted[] {
  const posted: Posted[] = [];
  vi.spyOn(api, 'sendMessage').mockImplementation(
    (channelId: string, body: unknown, key?: string) =>
      new Promise<Message>((resolve, reject) => {
        const b = body as Record<string, unknown>;
        posted.push({
          channelId,
          body: b,
          key,
          answer: (m) =>
            resolve({
              channel_id: channelId,
              thread_id: null,
              author_id: ME,
              content: String(b.content),
              created_at: new Date().toISOString(),
              edited_at: null,
              ...m,
            } as Message),
          fail: reject,
        });
      }),
  );
  return posted;
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  });
}

const networkError = () =>
  new ApiError({ key: 'network_error', code: 0, message: 'Failed to fetch', status: 0 });
const timeoutError = () =>
  new ApiError({ key: 'timeout', code: 0, message: 'The server did not answer in time.', status: 0 });

// -- the connection (the banner's signal: navigator.onLine + its events) -------

let browserOnline = true;
let stop: (() => void) | null = null;

function goOffline(): void {
  browserOnline = false;
  act(() => {
    window.dispatchEvent(new Event('offline'));
  });
}

function goOnline(): void {
  browserOnline = true;
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
}

function follow(store: StateStore): void {
  stop = startSendAutoRetry(store);
}

function echo(store: StateStore, m: { id: string; content: string; nonce?: string }): void {
  applyGatewayEvent(store, {
    op: 0,
    t: 'MessageCreate',
    s: nextSyntheticSeq(),
    d: {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      created_at: new Date().toISOString(),
      edited_at: null,
      ...m,
    } as never,
  });
}

beforeEach(() => {
  baseMs = Math.max(Date.now() + 2_000, baseMs + 10_000);
  base = (BigInt(baseMs) - EPOCH) << 22n;
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
});

/** Send `texts` while offline: each POST fails with a transport error, one at a time. */
async function sendOffline(store: StateStore, posted: Posted[], texts: string[], channelId = CHANNEL) {
  const send = sender(store);
  const done = texts.map((t) => send(channelId, t).catch(() => undefined));
  for (let i = 0; i < texts.length; i += 1) {
    await flush();
    posted[posted.length - 1]!.fail(networkError());
  }
  await act(async () => {
    await Promise.all(done);
  });
}

describe('offline sends wait, then go out on reconnect', () => {
  it('three offline sends read "waiting", then all go out in typed order, one at a time, under their ORIGINAL nonces', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    goOffline();

    await sendOffline(store, posted, ['one', 'two', 'three']);
    const keys = rows(store).map((m) => m.client_key!);
    expect(rows(store).map((m) => [m.content, m.send_state])).toEqual([
      ['one', 'waiting'],
      ['two', 'waiting'],
      ['three', 'waiting'],
    ]);
    expect(posted).toHaveLength(3);

    goOnline();
    // Every row is "Sending…" at once; only the FIRST POST is out.
    expect(rows(store).map((m) => m.send_state)).toEqual(['pending', 'pending', 'pending']);
    await flush();
    expect(posted).toHaveLength(4);

    for (let i = 0; i < 3; i += 1) {
      await flush();
      const post = posted[3 + i]!;
      expect(post.body.content).toBe(['one', 'two', 'three'][i]);
      expect(post.key).toBe(keys[i]);
      expect(post.body.nonce).toBe(keys[i]);
      // One at a time: the next POST waits for this answer.
      expect(posted).toHaveLength(4 + i);
      post.answer({ id: sf(100 + i), nonce: keys[i] } as Partial<Message>);
    }
    await flush();

    expect(rows(store).map((m) => [m.id, m.content, m.client_key, m.send_state])).toEqual([
      [sf(100), 'one', keys[0], undefined],
      [sf(101), 'two', keys[1], undefined],
      [sf(102), 'three', keys[2], undefined],
    ]);
    expect(store.getState().failedByNonce).toEqual({});
    expect(store.getState().pendingByNonce).toEqual({});
  });

  it('each conversation keeps its own order', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    goOffline();
    await sendOffline(store, posted, ['a1', 'a2']);
    await sendOffline(store, posted, ['b1'], OTHER);

    goOnline();
    await flush();
    // Two queues: the first of each conversation is out.
    expect(posted.slice(3).map((p) => [p.channelId, p.body.content])).toEqual([
      [CHANNEL, 'a1'],
      [OTHER, 'b1'],
    ]);
    posted[3]!.answer({ id: sf(200) });
    await flush();
    expect(posted.slice(3).map((p) => p.body.content)).toEqual(['a1', 'b1', 'a2']);
  });

  it('a retry that fails offline again waits again, and goes on the NEXT reconnect', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    goOffline();
    await sendOffline(store, posted, ['stubborn']);
    const key = rows(store)[0]!.client_key!;

    goOnline();
    await flush();
    goOffline();
    posted[1]!.fail(networkError());
    await flush();
    expect(rows(store)[0]!.send_state).toBe('waiting');

    goOnline();
    await flush();
    expect(posted).toHaveLength(3);
    expect(posted[2]!.key).toBe(key);
  });
});

describe('what is and is not re-sent', () => {
  it('a 4xx refusal is never re-sent on reconnect: it keeps "Failed" and its manual Retry', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    const send = sender(store);
    const done = send(CHANNEL, 'too spicy').catch(() => undefined);
    const unverified = send(CHANNEL, 'not yet verified').catch(() => undefined);
    await flush();
    posted[0]!.fail(
      new ApiError({ key: 'validation_failed', code: 40001, message: 'content must be 1-4000 bytes', status: 400 }),
    );
    await flush();
    posted[1]!.fail(
      new ApiError({ key: 'account_unverified', code: 40301, message: 'Verify your email', status: 403 }),
    );
    await act(async () => {
      await Promise.allSettled([done, unverified]);
    });
    expect(rows(store).map((m) => m.send_state)).toEqual(['failed', 'failed']);

    goOffline();
    // Not re-marked: the server's refusal keeps its own words.
    expect(rows(store).map((m) => m.send_state)).toEqual(['failed', 'failed']);
    goOnline();
    await flush();
    expect(posted).toHaveLength(2);
    expect(retryWaitingSends(store)).toEqual([]);
    expect(rows(store).map((m) => m.send_state)).toEqual(['failed', 'failed']);
  });

  it('a timed-out (unconfirmed) send is re-sent on reconnect with the same nonce', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    const send = sender(store);
    const done = send(CHANNEL, 'slow lane').catch(() => undefined);
    const key = rows(store)[0]!.client_key!;
    await flush();
    posted[0]!.fail(timeoutError());
    await act(async () => {
      await done;
    });
    expect(rows(store)[0]!.send_state).toBe('unconfirmed');

    goOffline();
    expect(rows(store)[0]!.send_state).toBe('waiting');
    goOnline();
    await flush();
    expect(posted).toHaveLength(2);
    expect(posted[1]!.key).toBe(key);
    expect(posted[1]!.body.nonce).toBe(key);
    // The server dedupes: it answers with the message the first POST stored.
    posted[1]!.answer({ id: sf(300) });
    await flush();
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([[sf(300), key]]);
  });
});

describe('no duplicates when the echo lands', () => {
  it('during the retry: the echo settles the row by its nonce, the ack changes nothing', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    goOffline();
    await sendOffline(store, posted, ['echoed']);
    const key = rows(store)[0]!.client_key!;

    goOnline();
    await flush();
    echo(store, { id: sf(400), content: 'echoed', nonce: key });
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([[sf(400), key]]);
    posted[1]!.answer({ id: sf(400), nonce: key } as Partial<Message>);
    await flush();
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([[sf(400), key]]);
    expect(store.getState().pendingByNonce).toEqual({});
    expect(store.getState().failedByNonce).toEqual({});
  });

  it('before the reconnect (the timed-out POST did land): the held row settles and nothing is re-sent', async () => {
    const store = makeStore();
    const posted = holdPosts();
    follow(store);
    const send = sender(store);
    const done = send(CHANNEL, 'landed after all').catch(() => undefined);
    const key = rows(store)[0]!.client_key!;
    await flush();
    posted[0]!.fail(timeoutError());
    await act(async () => {
      await done;
    });
    goOffline();
    echo(store, { id: sf(410), content: 'landed after all', nonce: key });
    goOnline();
    await flush();
    expect(posted).toHaveLength(1);
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([[sf(410), key]]);
  });
});

describe('the waiting row', () => {
  function waitingRow(): Message {
    return {
      id: 'pending_abc',
      client_key: 'abc',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'hello',
      created_at: '2026-09-28T10:00:00Z',
      edited_at: null,
      send_state: 'waiting',
      send_error: { key: 'network_error', message: 'Failed to fetch' },
    };
  }

  it('reads "Waiting for connection…" as a polite status — not a failure, no Retry — and keeps Delete', async () => {
    const { container } = render(<MessageItem message={waitingRow()} currentUserId={ME} />);
    const reason = screen.getByTestId('message-send-failed-reason');
    expect(reason.textContent).toContain('Waiting for connection…');
    expect(reason.textContent).not.toContain('Failed');
    expect(reason.getAttribute('role')).toBe('status');
    expect(screen.queryByTestId('message-send-retry')).toBeNull();
    expect(screen.getByTestId('message-send-delete')).toBeTruthy();
    expect(screen.getByTestId('message-item').getAttribute('data-send-state')).toBe('waiting');
    expect(await axe(container)).toHaveNoViolations();
  });
});
