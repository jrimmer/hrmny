/**
 * @cytale/web — optimistic send (owner report 2026-09-28: "when sending a
 * message it appears in the message list and is THEN cleared from the
 * composer … I wonder if this is how Discord and Slack work?").
 *
 * The send path's contract, end to end over a real store:
 *
 *  - the placeholder is drawn SYNCHRONOUSLY, pending, before any network work;
 *  - a burst leaves one POST at a time per conversation, in typed order, and
 *    the rows keep that order whatever order the confirmations arrive in;
 *  - the placeholder is swapped BY NONCE, and is never shown twice whether the
 *    gateway echo lands before or after the HTTP ack;
 *  - a failure keeps the row (Discord), marked failed; Retry reuses the nonce
 *    (Idempotency-Key and body nonce), resends the attachments and the reply;
 *    a timeout is its own "unconfirmed" state; Delete forgets the row;
 *  - Edit moves the text back into the composer only when the composer is
 *    empty (never clobbers), and a failure never refills it on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import type { AxeMatchers } from 'vitest-axe/matchers';
import React, { useRef } from 'react';
import { $createParagraphNode, $createTextNode, $getRoot, KEY_ENTER_COMMAND, type LexicalEditor } from 'lexical';

import { ApiError, type UploadedAttachment } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import {
  applyGatewayEvent,
  beginOptimisticSend,
  confirmOptimisticSend,
  createStateStore,
  holdFailedSend,
  nextSyntheticSeq,
  type StateStore,
} from '@cytale/state';

import { api, authStore } from '../../auth/session.js';
import { MessageCompose, type ComposerHandle } from '../MessageCompose.js';
import { MessageItem } from '../MessageItem.js';
import { FailedSendBar, SendRowActionsContext, useSendRowActions } from '../SendStatus.js';
import { discardSend, retrySend, useMessageSender, type UseMessages } from '../useMessages.js';

declare module 'vitest' {
  interface Assertion<T> extends AxeMatchers {}
  interface AsymmetricMatchersContaining extends AxeMatchers {}
}

const CHANNEL = '9007199254740993';
const THREAD = '9007199254740999';
const ME = '7000000000000002';
const PEER = '7000000000000003';

/**
 * A server snowflake (+ `seq`): server ids carry the server's clock, and the
 * placeholder sorts by the time it was DRAWN, so a test id must be current
 * or it sorts years before every pending row. Minted a moment after the
 * rows are drawn — the POST reaches the server after the client drew it.
 */
const EPOCH = 1_420_070_400_000n;
// Re-minted per test (beforeEach) so every test's ids are current, and never
// below the previous test's: a confirmation re-times the still-pending rows
// just above the server id it landed with (liftPendingPlaceholders), and the
// placeholder clock never runs backwards — like a real server's ids.
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
  // The hook is a useMemo over the same factory; call the factory the way
  // the composer does, without a render.
  let send: UseMessages['send'] | null = null;
  function Probe() {
    send = useMessageSender(store).send;
    return null;
  }
  render(<Probe />);
  return send!;
}

/** The channel's rows oldest → newest (the reading order). */
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

/** api.sendMessage as a switchboard: every POST waits until the test answers. */
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

/** Let queued promise continuations run (the send queue chains on them). */
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function echo(store: StateStore, m: Partial<Message> & { id: string; content: string }): void {
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

function serverRow(id: string, content: string): Message {
  return {
    id,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content,
    created_at: new Date().toISOString(),
    edited_at: null,
  };
}

const serverError = (message = 'Internal error') =>
  new ApiError({ key: 'internal_error', code: 50000, message, status: 500 });

beforeEach(() => {
  baseMs = Math.max(Date.now() + 2_000, baseMs + 10_000);
  base = (BigInt(baseMs) - EPOCH) << 22n;
  authStore.getState().reset();
  authStore.getState().setStatus('authenticated');
  authStore.getState().setVerified(true);
  authStore.getState().setUser({
    id: ME,
    username: 'me',
    email: 'me@example.com',
    email_verified_at: '2026-08-30T00:00:00Z',
  });
  globalThis.localStorage?.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The send path over a real store
// ---------------------------------------------------------------------------

describe('optimistic send — the pending row', () => {
  it('is drawn synchronously, marked pending, before the POST is even issued', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);

    void send(CHANNEL, 'hello there');
    // Same tick as the call: the row is already in the store…
    const [row] = rows(store);
    expect(row).toMatchObject({ content: 'hello there', send_state: 'pending', author_id: ME });
    expect(row!.id.startsWith('pending_')).toBe(true);
    // …and the network has not been touched yet (the queue hands the POST on
    // in a later microtask).
    expect(posted).toHaveLength(0);
    await flush();
    expect(posted).toHaveLength(1);
    expect(posted[0]!.key).toBe(row!.client_key);
    expect(posted[0]!.body.nonce).toBe(row!.client_key);
  });

  it('carries the reply context into the pending row — the same reply bar the confirmed row draws', async () => {
    const store = makeStore();
    store.setState({
      membersById: {
        [PEER]: { user_id: PEER, username: 'dana', nickname: 'Dana' } as never,
      },
      messagesByChannel: {
        [CHANNEL]: {
          items: [
            {
              id: '1000000000000500',
              channel_id: CHANNEL,
              thread_id: null,
              author_id: PEER,
              content: 'x'.repeat(120),
              created_at: '2026-09-28T09:00:00Z',
              edited_at: null,
            },
          ],
          oldestId: null,
          hasCompleteHistory: true,
        },
      },
    });
    holdPosts();
    const send = sender(store);
    void send(CHANNEL, `<@${PEER}> agreed`, null, '1000000000000500');
    const pending = rows(store).at(-1)!;
    expect(pending.reply_to_id).toBe('1000000000000500');
    expect(pending.referenced).toEqual({
      message_id: '1000000000000500',
      author_id: PEER,
      author_username: 'dana',
      // The server's snapshot keeps the first 80 characters; so does ours.
      content: 'x'.repeat(80),
    });
  });

  it('carries the attachments into the pending row, sized as the server row will be', () => {
    const store = makeStore();
    holdPosts();
    const send = sender(store);
    const shot: UploadedAttachment = {
      filename: 'shot.png',
      content_type: 'image/png',
      size: 2048,
      url: '/api/v1/attachments/abc',
      width: 640,
      height: 480,
    };
    void send(CHANNEL, 'look', null, null, [shot]);
    expect(rows(store)[0]!.attachments).toEqual([
      expect.objectContaining({ filename: 'shot.png', url: shot.url, width: 640, height: 480 }),
    ]);
  });
});

describe('optimistic send — a rapid burst', () => {
  it('sends five in typed order, ONE POST at a time, with the rows in order throughout', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const texts = ['one', 'two', 'three', 'four', 'five'];
    const done = texts.map((t) => send(CHANNEL, t));

    // All five drawn at once, in typed order, all pending.
    expect(rows(store).map((m) => m.content)).toEqual(texts);
    expect(rows(store).every((m) => m.send_state === 'pending')).toBe(true);

    for (let i = 0; i < texts.length; i += 1) {
      await flush();
      // Exactly one POST in flight: the next waits for this one to settle.
      expect(posted).toHaveLength(i + 1);
      expect(posted[i]!.body.content).toBe(texts[i]);
      posted[i]!.answer({ id: sf(1000 + i) });
      await flush();
      expect(rows(store).map((m) => m.content)).toEqual(texts);
    }
    await act(async () => {
      await Promise.all(done);
    });
    expect(rows(store).map((m) => m.id)).toEqual([
      sf(1000),
      sf(1001),
      sf(1002),
      sf(1003),
      sf(1004),
    ]);
    expect(rows(store).every((m) => m.send_state === undefined)).toBe(true);
  });

  it('the server confirming the FIRST send while four more are pending keeps typed order (no swap)', () => {
    // The real burst: message 2 is drawn before message 1 reaches the server,
    // so 1's server id is NEWER than 2's placeholder. Unlifted, the confirmed
    // row sorted BELOW the still-pending ones — rows swapped under the reader.
    const store = makeStore();
    const begin = (content: string) =>
      beginOptimisticSend(store, { channel_id: CHANNEL, thread_id: null, author_id: ME, content });
    const sends = ['a', 'b', 'c', 'd', 'e'].map((t) => ({ t, ...begin(t) }));
    sends.forEach((send, i) => {
      confirmOptimisticSend(store, send.nonce, serverRow(sf(2000 + i), send.t));
      expect(rows(store).map((m) => m.content)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });
  });

  it('out-of-order confirmations never duplicate or lose a row, pending rows stay BELOW confirmed ones, and the end state is typed order', () => {
    const store = makeStore();
    const begin = (content: string) =>
      beginOptimisticSend(store, { channel_id: CHANNEL, thread_id: null, author_id: ME, content });
    const a = begin('first');
    const b = begin('second');
    const c = begin('third');
    const check = () => {
      const r = rows(store);
      expect(r).toHaveLength(3);
      expect(new Set(r.map((m) => m.client_key)).size).toBe(3);
      const firstPending = r.findIndex((m) => m.send_state === 'pending');
      if (firstPending >= 0) {
        expect(r.slice(firstPending).every((m) => m.send_state === 'pending')).toBe(true);
      }
    };
    // The third is acked first, then the first, then the second.
    confirmOptimisticSend(store, c.nonce, serverRow(sf(2003), 'third'));
    check();
    confirmOptimisticSend(store, a.nonce, serverRow(sf(2001), 'first'));
    check();
    confirmOptimisticSend(store, b.nonce, serverRow(sf(2002), 'second'));
    check();
    expect(rows(store).map((m) => m.content)).toEqual(['first', 'second', 'third']);
    expect(rows(store).map((m) => m.client_key)).toEqual([a.nonce, b.nonce, c.nonce]);
  });

  it("a peer's message landing mid-send stays ABOVE the pending row (no jump when it confirms)", () => {
    const store = makeStore();
    const mine = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: ME,
      content: 'mine',
    });
    echo(store, { id: sf(2100), content: 'from dana', author_id: PEER });
    expect(rows(store).map((m) => m.content)).toEqual(['from dana', 'mine']);
    confirmOptimisticSend(store, mine.nonce, serverRow(sf(2101), 'mine'));
    expect(rows(store).map((m) => m.content)).toEqual(['from dana', 'mine']);
  });

  it('keeps sending after a failure: the next message is not stuck behind the failed one', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const first = send(CHANNEL, 'will fail');
    const second = send(CHANNEL, 'goes anyway');
    await flush();
    posted[0]!.fail(serverError());
    await act(async () => {
      await expect(first).rejects.toMatchObject({ key: 'internal_error' });
    });
    await flush();
    expect(posted).toHaveLength(2);
    posted[1]!.answer({ id: sf(3001) });
    await act(async () => {
      await second;
    });
    expect(rows(store).map((m) => [m.content, m.send_state ?? 'sent'])).toEqual([
      ['will fail', 'failed'],
      ['goes anyway', 'sent'],
    ]);
  });
});

describe('optimistic send — reconciliation by nonce', () => {
  it('echo BEFORE the ack: one row, swapped in place, keeping the list key', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'race me');
    const nonce = rows(store)[0]!.client_key;
    await flush();

    echo(store, { id: sf(4001), content: 'race me' });
    expect(rows(store).map((m) => m.id)).toEqual([sf(4001)]);
    expect(rows(store)[0]!.client_key).toBe(nonce);

    posted[0]!.answer({ id: sf(4001) });
    await act(async () => {
      await done;
    });
    expect(rows(store).map((m) => m.id)).toEqual([sf(4001)]);
    expect(rows(store)[0]!.client_key).toBe(nonce);
    expect(store.getState().pendingByNonce).toEqual({});
  });

  it('echo AFTER the ack: still exactly one row', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'ack first');
    const nonce = rows(store)[0]!.client_key;
    await flush();
    posted[0]!.answer({ id: sf(4002) });
    await act(async () => {
      await done;
    });
    echo(store, { id: sf(4002), content: 'ack first' });
    expect(rows(store).map((m) => m.id)).toEqual([sf(4002)]);
    expect(rows(store)[0]!.client_key).toBe(nonce);
  });

  it('two identical messages in flight: each echo retires the OLDEST placeholder, so keys never swap', async () => {
    const store = makeStore();
    holdPosts();
    const send = sender(store);
    void send(CHANNEL, 'ok');
    void send(CHANNEL, 'ok');
    const [k1, k2] = rows(store).map((m) => m.client_key);
    echo(store, { id: sf(4010), content: 'ok' });
    expect(rows(store).map((m) => [m.id.startsWith('pending_') ? 'pending' : m.id, m.client_key])).toEqual([
      [sf(4010), k1],
      ['pending', k2],
    ]);
  });

  it('two identical messages in flight, echoes carrying the send key: each settles its OWN row, whatever the order', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const first = send(CHANNEL, 'ok');
    const second = send(CHANNEL, 'ok');
    const [k1, k2] = rows(store).map((m) => m.client_key!) as [string, string];
    // The SECOND send's echo lands first (another device's burst, a reordered
    // fan-out): the key names its row, so nothing swaps.
    echo(store, { id: sf(4012), content: 'ok', nonce: k2 } as Partial<Message> & { id: string; content: string });
    const byKey = () =>
      Object.fromEntries(rows(store).map((m) => [m.client_key, m.id.startsWith('pending_') ? 'pending' : m.id]));
    expect(byKey()).toEqual({ [k1]: 'pending', [k2]: sf(4012) });
    expect(rows(store)).toHaveLength(2);
    echo(store, { id: sf(4011), content: 'ok', nonce: k1 } as Partial<Message> & { id: string; content: string });
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([
      [sf(4011), k1],
      [sf(4012), k2],
    ]);
    // The acks settle nothing new: still two rows, keys intact.
    await flush();
    posted[0]!.answer({ id: sf(4011) });
    await flush();
    posted[1]!.answer({ id: sf(4012) });
    await act(async () => {
      await Promise.all([first, second]);
    });
    expect(rows(store).map((m) => [m.id, m.client_key])).toEqual([
      [sf(4011), k1],
      [sf(4012), k2],
    ]);
    expect(store.getState().pendingByNonce).toEqual({});
  });

  it('an echo with a key this client never minted settles nothing, even with the same words', () => {
    const store = makeStore();
    holdPosts();
    const send = sender(store);
    void send(CHANNEL, 'same words');
    const key = rows(store)[0]!.client_key;
    echo(store, { id: sf(4015), content: 'same words', nonce: 'from-my-other-device' } as Partial<Message> & {
      id: string;
      content: string;
    });
    const settled = rows(store).map((m) => [m.id.startsWith('pending_') ? 'pending' : m.id, m.client_key]);
    expect(settled).toHaveLength(2);
    expect(settled).toContainEqual(['pending', key]);
    expect(settled).toContainEqual([sf(4015), undefined]);
  });

  it('a late timeout AFTER the echo landed the message is not a failure', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'landed quietly');
    await flush();
    echo(store, { id: sf(4020), content: 'landed quietly' });
    posted[0]!.fail(new ApiError({ key: 'timeout', code: 0, message: 'slow', status: 0 }));
    await act(async () => {
      await expect(done).resolves.toBeUndefined();
    });
    expect(rows(store).map((m) => m.id)).toEqual([sf(4020)]);
    expect(store.getState().failedByNonce).toEqual({});
  });

  it('an echo retires a HELD failed row (it landed after all) — but a fresh identical send is matched first', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const failed = send(CHANNEL, 'same words');
    await flush();
    posted[0]!.fail(new ApiError({ key: 'timeout', code: 0, message: 'slow', status: 0 }));
    await act(async () => {
      await expect(failed).rejects.toBeTruthy();
    });
    void send(CHANNEL, 'same words'); // a NEW send of the same text
    // The first echo belongs to the in-flight send, not to the held row.
    echo(store, { id: sf(4030), content: 'same words' });
    expect(rows(store).map((m) => m.send_state ?? m.id)).toEqual(['unconfirmed', sf(4030)]);
    // A second echo of the same words: the held one did land — it is retired
    // with its failure record.
    echo(store, { id: sf(4031), content: 'same words' });
    expect(rows(store).map((m) => m.id)).toEqual([sf(4030), sf(4031)]);
    expect(store.getState().failedByNonce).toEqual({});
  });
});

describe('optimistic send — failure (the Discord failed row)', () => {
  it('a 500 keeps the row, marked failed with the reason; Retry reuses the SAME nonce and confirms in place', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'try me');
    const nonce = rows(store)[0]!.client_key!;
    await flush();
    posted[0]!.fail(serverError('Database unavailable'));
    await act(async () => {
      await expect(done).rejects.toMatchObject({ sendNonce: nonce });
    });
    expect(rows(store)).toHaveLength(1);
    expect(rows(store)[0]).toMatchObject({
      content: 'try me',
      send_state: 'failed',
      send_error: { key: 'internal_error', message: 'Database unavailable' },
    });

    const retried = retrySend(store, nonce);
    expect(rows(store)[0]!.send_state).toBe('pending');
    await flush();
    expect(posted).toHaveLength(2);
    // Same key on the header AND in the body: the server's idempotency record
    // answers a POST that did land with the message it already stored.
    expect(posted[1]!.key).toBe(nonce);
    expect(posted[1]!.body.nonce).toBe(nonce);
    expect(posted[1]!.body.content).toBe('try me');
    posted[1]!.answer({ id: sf(5001) });
    await act(async () => {
      await retried;
    });
    expect(rows(store).map((m) => [m.id, m.client_key, m.send_state])).toEqual([
      [sf(5001), nonce, undefined],
    ]);
    expect(store.getState().failedByNonce).toEqual({});
  });

  it('a timeout is UNCONFIRMED, not failed — and its retry is the same nonce too', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'maybe landed');
    const nonce = rows(store)[0]!.client_key!;
    await flush();
    posted[0]!.fail(new ApiError({ key: 'timeout', code: 0, message: 'The server did not answer in time.', status: 0 }));
    await act(async () => {
      await expect(done).rejects.toMatchObject({ key: 'timeout' });
    });
    expect(rows(store)[0]!.send_state).toBe('unconfirmed');
    void retrySend(store, nonce);
    await flush();
    expect(posted[1]!.key).toBe(nonce);
  });

  it('attachments and the reply ride the retry', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const shot: UploadedAttachment = {
      filename: 'shot.png',
      content_type: 'image/png',
      size: 10,
      url: '/api/v1/attachments/xyz',
    };
    const done = send(CHANNEL, 'with pic', null, '1000000000000777', [shot]);
    const nonce = rows(store).at(-1)!.client_key!;
    await flush();
    posted[0]!.fail(serverError());
    await act(async () => {
      await expect(done).rejects.toBeTruthy();
    });
    expect(rows(store).at(-1)!.attachments?.[0]?.url).toBe(shot.url);

    void retrySend(store, nonce);
    await flush();
    expect(posted[1]!.body).toMatchObject({
      content: 'with pic',
      reply_to_id: '1000000000000777',
      attachments: [shot],
      nonce,
    });
    expect(rows(store).at(-1)).toMatchObject({
      send_state: 'pending',
      reply_to_id: '1000000000000777',
      attachments: [expect.objectContaining({ url: shot.url })],
    });
  });

  it('Delete removes the local row and forgets the send', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const send = sender(store);
    const done = send(CHANNEL, 'never mind');
    const nonce = rows(store)[0]!.client_key!;
    await flush();
    posted[0]!.fail(serverError());
    await act(async () => {
      await expect(done).rejects.toBeTruthy();
    });
    discardSend(store, nonce);
    expect(rows(store)).toEqual([]);
    expect(store.getState().failedByNonce).toEqual({});
    expect(store.getState().nonceByMessageId).toEqual({});
    // Nothing was posted on the Delete.
    expect(posted).toHaveLength(1);
  });

  it('a thread send rides the thread endpoint with its nonce, and fails into the thread slice', async () => {
    const store = makeStore();
    const threadSend = vi
      .spyOn(api, 'sendThreadMessage')
      .mockRejectedValue(serverError());
    const send = sender(store);
    const done = send(CHANNEL, 'in the thread', THREAD, null, [], { route: 'thread' });
    const row = store.getState().messagesByThread[THREAD]!.items[0]!;
    expect(row.send_state).toBe('pending');
    await act(async () => {
      await expect(done).rejects.toBeTruthy();
    });
    expect(threadSend).toHaveBeenCalledWith(
      THREAD,
      { content: 'in the thread' },
      row.client_key,
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    expect(store.getState().messagesByThread[THREAD]!.items[0]!.send_state).toBe('failed');
    // Retry goes back to the THREAD endpoint, same key.
    threadSend.mockResolvedValue({
      id: sf(6001),
      channel_id: CHANNEL,
      thread_id: THREAD,
      author_id: ME,
      content: 'in the thread',
      created_at: new Date().toISOString(),
      edited_at: null,
    } as never);
    await act(async () => {
      await retrySend(store, row.client_key!);
    });
    expect(threadSend).toHaveBeenLastCalledWith(THREAD, expect.anything(), row.client_key, expect.anything());
    expect(store.getState().messagesByThread[THREAD]!.items.map((m) => m.id)).toEqual([sf(6001)]);
  });
});

// ---------------------------------------------------------------------------
// The composer half
// ---------------------------------------------------------------------------

function setEditorText(editor: LexicalEditor, text: string): void {
  editor.update(() => {
    const root = $getRoot();
    root.clear();
    const node = $createTextNode(text);
    root.append($createParagraphNode().append(node));
    node.select(text.length, text.length);
  });
}

function pressEnter(editor: LexicalEditor): void {
  editor.dispatchCommand(KEY_ENTER_COMMAND, {
    shiftKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent);
}

function textOf(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $getRoot().getTextContent());
}

function makeMessages(send: UseMessages['send']): UseMessages {
  return {
    messages: () => [],
    send,
    edit: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    toggleReaction: vi.fn(async () => {}),
    reactionError: () => null,
    clearReactionError: () => {},
    currentUserId: () => ME,
  };
}

async function renderComposer(props: Partial<React.ComponentProps<typeof MessageCompose>> = {}) {
  let editor: LexicalEditor | null = null;
  const handle: { current: ComposerHandle | null } = { current: null };
  render(
    <MessageCompose
      ref={handle}
      channelId={CHANNEL}
      onEditorReady={(e) => {
        editor = e;
      }}
      {...props}
    />,
  );
  await waitFor(() => expect(editor).not.toBeNull());
  return { editor: editor!, handle };
}

describe('optimistic send — the composer clears FIRST', () => {
  it('the text, the tray and the reply bar are gone while the send is still unresolved', async () => {
    // A send that never answers: anything the composer does must not wait on it.
    const send = vi.fn(() => new Promise<void>(() => {}));
    const onCancelReply = vi.fn();
    const { editor } = await renderComposer({
      messages: makeMessages(send as unknown as UseMessages['send']),
      replyTo: { messageId: '1000000000000001', authorId: PEER, authorName: 'dana', snippet: 'hi', ping: false },
      onCancelReply,
    });
    setEditorText(editor, 'instant');
    pressEnter(editor);
    // The send was handed the message, and the reply bar was released, in the
    // same tick as the Enter.
    expect(send).toHaveBeenCalledWith(CHANNEL, 'instant', null, '1000000000000001');
    expect(onCancelReply).toHaveBeenCalledTimes(1);
    // The editor commits its update on the next microtask — no network in it.
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(editor)).toBe('');
    expect(screen.getByTestId('composer-send-status').textContent).toBe('Sending…');
  });

  it('the member can send again at once: a second message while the first is in flight is NOT dropped', async () => {
    const send = vi.fn(() => new Promise<void>(() => {}));
    const { editor } = await renderComposer({ messages: makeMessages(send as unknown as UseMessages['send']) });
    setEditorText(editor, 'first');
    pressEnter(editor);
    await act(async () => {
      await Promise.resolve();
    });
    setEditorText(editor, 'second');
    pressEnter(editor);
    expect(send.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['first', 'second']);
  });

  it('the SAME Enter twice (key repeat) sends once — the second lands on an empty box', async () => {
    const send = vi.fn(() => new Promise<void>(() => {}));
    const { editor } = await renderComposer({ messages: makeMessages(send as unknown as UseMessages['send']) });
    setEditorText(editor, 'once');
    pressEnter(editor);
    await act(async () => {
      await Promise.resolve();
    });
    pressEnter(editor);
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  // DECISION (owner's idea, 2026-09-28): a failure NEVER auto-refills the
  // composer — not even an empty one. The member may be mid-way through the
  // next message, or about to start it; text jumping back into the box is the
  // jarring case. The failed row keeps the message and offers Edit instead.
  it('a failure never refills the composer, even when it is empty', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('boom'), { key: 'internal_error' });
    });
    const { editor } = await renderComposer({ messages: makeMessages(send as unknown as UseMessages['send']) });
    setEditorText(editor, 'lost?');
    pressEnter(editor);
    await waitFor(() => expect(send).toHaveBeenCalled());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(textOf(editor)).toBe('');
    expect(screen.queryByTestId('composer-error')).toBeNull();
  });

  it('account_unverified still flips the verify banner', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('verify'), { key: 'account_unverified' });
    });
    const { editor } = await renderComposer({ messages: makeMessages(send as unknown as UseMessages['send']) });
    setEditorText(editor, 'nope');
    pressEnter(editor);
    await waitFor(() => expect(screen.getByTestId('composer-banner')).toBeTruthy());
  });

  it('restoreDraft fills an EMPTY composer and refuses (changing nothing) when it holds text', async () => {
    const { editor, handle } = await renderComposer({
      messages: makeMessages(vi.fn(async () => {}) as unknown as UseMessages['send']),
    });
    const draft = {
      content: 'bring me back',
      attachments: [{ filename: 'a.txt', content_type: 'text/plain', size: 3, url: '/api/v1/attachments/a' }],
    };
    let took = false;
    act(() => {
      took = handle.current!.restoreDraft(draft);
    });
    expect(took).toBe(true);
    await waitFor(() => expect(textOf(editor)).toBe('bring me back'));
    expect(screen.getByTestId('attachment-chip').getAttribute('data-status')).toBe('done');

    // Now the box is occupied: a second restore must not touch it.
    act(() => setEditorText(editor, 'my next message'));
    await waitFor(() => expect(textOf(editor)).toBe('my next message'));
    act(() => {
      took = handle.current!.restoreDraft({ content: 'other', attachments: [] });
    });
    expect(took).toBe(false);
    await act(async () => {
      await Promise.resolve();
    });
    expect(textOf(editor)).toBe('my next message');
  });
});

// ---------------------------------------------------------------------------
// The row
// ---------------------------------------------------------------------------

function localRow(overrides: Partial<Message> = {}): Message {
  return {
    id: 'pending_abc',
    client_key: 'abc',
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content: 'hello',
    created_at: '2026-09-28T10:00:00Z',
    edited_at: null,
    send_state: 'pending',
    ...overrides,
  };
}

describe('optimistic send — the row', () => {
  it('a pending row is muted, busy, spoken as "Sending", and offers no server actions', () => {
    render(
      <MessageItem
        message={localRow()}
        currentUserId={ME}
        onReply={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
        onToggleReaction={() => {}}
      />,
    );
    const item = screen.getByTestId('message-item');
    expect(item.getAttribute('data-send-state')).toBe('pending');
    expect(item.getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText('Sending…').className).toContain('sr-only');
    expect(screen.getByTestId('message-content').className).toContain('text-text-muted');
    fireEvent.mouseEnter(item);
    expect(screen.queryByTestId('message-actions')).toBeNull();
    expect(screen.queryByTestId('message-send-failed')).toBeNull();
  });

  it('the confirmed row keeps the pending row’s box: no status line, same content node', () => {
    const { rerender } = render(<MessageItem message={localRow()} currentUserId={ME} />);
    const content = screen.getByTestId('message-content');
    rerender(
      <MessageItem
        message={localRow({ id: sf(7001), send_state: undefined })}
        currentUserId={ME}
      />,
    );
    // Same DOM node (no remount), no longer muted, nothing spoken as sending.
    expect(screen.getByTestId('message-content')).toBe(content);
    expect(content.className).not.toContain('text-text-muted');
    expect(screen.queryByText('Sending…')).toBeNull();
  });

  it.each([
    ['ungrouped', false],
    ['grouped', true],
  ])('a pending %s row draws no clock or icon — the dim is the only visual cue', (_label, grouped) => {
    const { container, rerender } = render(
      <MessageItem message={localRow()} currentUserId={ME} grouped={grouped} />,
    );
    const item = screen.getByTestId('message-item');
    expect(item.getAttribute('data-send-state')).toBe('pending');
    expect(item.getAttribute('aria-busy')).toBe('true');
    expect(screen.queryByTestId('message-send-pending')).toBeNull();
    expect(screen.queryByTitle('Sending…')).toBeNull();
    // The only thing a pending row adds over its confirmed form is the
    // sr-only status: no svg, no aria-hidden glyph, no extra element.
    const pendingShape = [...item.querySelectorAll('*')]
      .filter((el) => !el.classList.contains('sr-only') || el.textContent !== 'Sending…')
      .map((el) => el.tagName)
      .join(',');
    expect(item.querySelectorAll('svg').length).toBe(0);
    rerender(
      <MessageItem
        message={localRow({ id: sf(7002), send_state: undefined })}
        currentUserId={ME}
        grouped={grouped}
      />,
    );
    const confirmed = screen.getByTestId('message-item');
    expect(confirmed.getAttribute('aria-busy')).toBeNull();
    const confirmedShape = [...confirmed.querySelectorAll('*')].map((el) => el.tagName).join(',');
    expect(pendingShape).toBe(confirmedShape);
    expect(container.querySelectorAll('svg').length).toBe(0);
  });

  it('a failed row says so in words (an alert), with keyboard-reachable Retry and Delete', async () => {
    const { container } = render(
      <MessageItem
        message={localRow({ send_state: 'failed', send_error: { key: 'internal_error', message: 'Database unavailable' } })}
        currentUserId={ME}
      />,
    );
    const reason = screen.getByTestId('message-send-failed-reason');
    expect(reason.getAttribute('role')).toBe('alert');
    expect(reason.textContent).toContain('Failed to send');
    expect(reason.textContent).toContain('Database unavailable');
    const user = userEvent.setup();
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('message-send-retry'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByTestId('message-send-delete'));
    expect(await axe(container)).toHaveNoViolations();
  });

  it('an unconfirmed row reads "Not confirmed yet" and says the retry is safe', () => {
    render(
      <MessageItem
        message={localRow({ send_state: 'unconfirmed', send_error: { key: 'timeout', message: 'slow' } })}
        currentUserId={ME}
      />,
    );
    const reason = screen.getByTestId('message-send-failed-reason').textContent ?? '';
    expect(reason).toContain('Not confirmed yet');
    expect(reason).toContain("won't send twice");
    expect(reason).not.toContain('Failed');
  });

  it('an account_unverified failure explains itself on the row', () => {
    render(
      <MessageItem
        message={localRow({ send_state: 'failed', send_error: { key: 'account_unverified', message: 'x' } })}
        currentUserId={ME}
      />,
    );
    expect(screen.getByTestId('message-send-failed-reason').textContent).toContain('Verify your email');
  });
});

/** A composer beside a failed row, wired the way the panes wire them. */
function EditHarness({ store, nonce }: { store: StateStore; nonce: string }) {
  const composeRef = useRef<ComposerHandle | null>(null);
  const actions = useSendRowActions(store, CHANNEL, composeRef);
  const row = store.getState().messagesByChannel[CHANNEL]?.items.find((m) => m.client_key === nonce);
  return (
    <SendRowActionsContext.Provider value={actions}>
      {row ? <FailedSendBar message={row} store={store} /> : <p data-testid="row-gone" />}
      <MessageCompose
        ref={composeRef}
        channelId={CHANNEL}
        store={store}
        messages={makeMessages(vi.fn(async () => {}) as unknown as UseMessages['send'])}
        onEditorReady={(e) => {
          (window as unknown as { __ed?: LexicalEditor }).__ed = e;
        }}
      />
    </SendRowActionsContext.Provider>
  );
}

function heldFailure(store: StateStore, content: string): string {
  const { nonce } = beginOptimisticSend(store, {
    channel_id: CHANNEL,
    thread_id: null,
    author_id: ME,
    content,
  });
  holdFailedSend(store, nonce, { key: 'internal_error', code: 50000, message: 'boom' });
  return nonce;
}

describe('optimistic send — Edit on a failed row', () => {
  it('moves the text back into an EMPTY composer and removes the failed row', async () => {
    const store = makeStore();
    const nonce = heldFailure(store, 'fix my typo');
    const { rerender } = render(<EditHarness store={store} nonce={nonce} />);
    await waitFor(() => expect((window as unknown as { __ed?: LexicalEditor }).__ed).toBeTruthy());
    const editor = (window as unknown as { __ed: LexicalEditor }).__ed;
    await userEvent.setup().click(screen.getByTestId('message-send-edit'));
    await waitFor(() => expect(textOf(editor)).toBe('fix my typo'));
    expect(store.getState().failedByNonce).toEqual({});
    rerender(<EditHarness store={store} nonce={nonce} />);
    expect(screen.getByTestId('row-gone')).toBeTruthy();
  });

  it('never clobbers text already in the composer: it refuses, says why, and keeps the row', async () => {
    const store = makeStore();
    const nonce = heldFailure(store, 'the failed one');
    render(<EditHarness store={store} nonce={nonce} />);
    await waitFor(() => expect((window as unknown as { __ed?: LexicalEditor }).__ed).toBeTruthy());
    const editor = (window as unknown as { __ed: LexicalEditor }).__ed;
    act(() => setEditorText(editor, 'what I am typing now'));
    await waitFor(() => expect(textOf(editor)).toBe('what I am typing now'));
    await userEvent.setup().click(screen.getByTestId('message-send-edit'));
    expect(screen.getByTestId('message-send-edit-note').textContent).toContain('already has text');
    expect(textOf(editor)).toBe('what I am typing now');
    expect(store.getState().failedByNonce[nonce]).toBeTruthy();
  });

  it('Retry and Delete on the row drive the store (same nonce; row gone)', async () => {
    const store = makeStore();
    const posted = holdPosts();
    const nonce = heldFailure(store, 'again');
    render(<EditHarness store={store} nonce={nonce} />);
    await userEvent.setup().click(screen.getByTestId('message-send-retry'));
    await flush();
    expect(posted.map((p) => p.key)).toEqual([nonce]);
    expect(rows(store)[0]!.send_state).toBe('pending');

    const nonce2 = heldFailure(store, 'bin me');
    cleanup();
    render(<EditHarness store={store} nonce={nonce2} />);
    await userEvent.setup().click(screen.getByTestId('message-send-delete'));
    expect(rows(store).some((m) => m.client_key === nonce2)).toBe(false);
  });
});
