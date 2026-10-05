/**
 * @cytale/web — the shell's slice gate (#137, app-level finding 1).
 *
 * The app-wide re-render storm had one root cause: the shell subscribed to the
 * WHOLE store and took `getState()` into state, so every write — a message in
 * any channel, a presence flip, an unread ack, a call event — re-rendered the
 * 2,000-line `AuthenticatedApp` and everything under it. These tests pin the
 * property that fixes it, at the seam where it lives:
 *
 *   * a write to a slice the shell does NOT read (the message hot path, the
 *     reconcile bookkeeping) must not render it at all;
 *   * a write to a slice it DOES read must, and the snapshot must carry the
 *     new value — the gate can never be "quiet but stale".
 *
 * The second half matters as much as the first: a selector that under-reports
 * is a correctness bug wearing a performance win's clothes.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { Message, Thread } from '@cytale/domain';
import { createStateStore, type StateState } from '@cytale/state';

import { SHELL_SLICE_KEYS, shellSlicesEqual, useShellStore, useThreadParentMessage } from '../useShellStore.js';

afterEach(cleanup);

const CHANNEL = '9007199254740993';
const CHANNEL_2 = '9007199254740994';
const MESSAGE = '9007199254741999';

function makeMessage(id: string, channelId: string, content = 'hello'): Message {
  return {
    id,
    channel_id: channelId,
    author_id: '9007199254741000',
    content,
    created_at: '2026-09-20T10:00:00.000Z',
    edited_at: null,
    thread_id: null,
    referenced: null,
    attachments: [],
    reactions: [],
    nonce: null,
  } as unknown as Message;
}

/** A message landing in a channel — the write that used to re-render everything. */
function writeMessageSlice(
  store: ReturnType<typeof createStateStore>,
  channelId: string,
  message: Message,
): void {
  store.setState((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [channelId]: { items: [message], oldestId: null, hasCompleteHistory: true },
    },
  }));
}

describe('shellSlicesEqual', () => {
  it('is unmoved by the slices the shell does not read', () => {
    const before = createStateStore().getState();
    const after: StateState = {
      ...before,
      lastSeq: before.lastSeq + 1,
      messagesByChannel: {
        ...before.messagesByChannel,
        [CHANNEL]: { items: [], oldestId: null, hasCompleteHistory: true },
      },
      messagesByThread: {},
      unreadByThread: {},
      mediaEnabled: false,
    };
    expect(shellSlicesEqual(before, after)).toBe(true);
  });

  it.each(SHELL_SLICE_KEYS)('is moved by a new %s record', (key) => {
    const before = createStateStore().getState();
    // A fresh record identity is exactly what a store write produces.
    // threadsById is compared by content (activity fields aside), so it needs
    // a real change: a thread that was not there.
    const value = key === 'threadsById' ? { t1: thread() } : {};
    const after = { ...before, [key]: value } as StateState;
    expect(shellSlicesEqual(before, after)).toBe(false);
  });

  const thread = (over: Partial<Thread> = {}): Thread => ({
    id: 't1',
    channel_id: CHANNEL,
    parent_message_id: null,
    name: 'plans',
    created_by: 'u1',
    archived: false,
    message_count: 1,
    latest_reply_at: '2026-09-27T00:00:00.000Z',
    created_at: '2026-09-27T00:00:00.000Z',
    ...over,
  });

  it('is unmoved when a reply only bumps a thread\'s activity fields', () => {
    const base = createStateStore().getState();
    const before = { ...base, threadsById: { t1: thread() } };
    const after = {
      ...base,
      threadsById: { t1: thread({ message_count: 2, latest_reply_at: '2026-09-27T00:01:00.000Z' }) },
    };
    expect(shellSlicesEqual(before, after)).toBe(true);
  });

  it('is moved by a rename or an archive — what the shell renders', () => {
    const base = createStateStore().getState();
    const before = { ...base, threadsById: { t1: thread() } };
    expect(shellSlicesEqual(before, { ...base, threadsById: { t1: thread({ name: 'renamed' }) } })).toBe(false);
    expect(shellSlicesEqual(before, { ...base, threadsById: { t1: thread({ archived: true }) } })).toBe(false);
    expect(shellSlicesEqual(before, { ...base, threadsById: {} })).toBe(false);
  });
});

describe('useShellStore', () => {
  it('does NOT re-render on a message in another channel', () => {
    const store = createStateStore();
    const { result } = renderHook(() => useShellStore(store));
    const first = result.current;

    act(() => writeMessageSlice(store, CHANNEL, makeMessage(MESSAGE, CHANNEL)));

    // Same object: the shell never rendered, so nothing downstream did either.
    expect(result.current).toBe(first);
  });

  it('does NOT re-render on reconcile bookkeeping', () => {
    const store = createStateStore();
    const { result } = renderHook(() => useShellStore(store));
    const first = result.current;

    act(() => store.setState((s) => ({ lastSeq: s.lastSeq + 1 })));

    expect(result.current).toBe(first);
  });

  it('does re-render for a slice it reads, and hands back the fresh state', () => {
    const store = createStateStore();
    const { result } = renderHook(() => useShellStore(store));
    const first = result.current;

    act(() => store.setState({ rosterSource: 'server' }));

    expect(result.current).not.toBe(first);
    expect(result.current.rosterSource).toBe('server');
  });

  it('does NOT re-render for unread, presence or recency ticks (lane D #17)', () => {
    const store = createStateStore();
    const { result } = renderHook(() => useShellStore(store));
    const first = result.current;

    act(() =>
      store.setState((s) => ({
        unreadByChannel: {
          ...s.unreadByChannel,
          [CHANNEL]: { last_read_id: null, unread_count: 3, mention_count: 1 },
        },
        presenceByUser: { '42': { status: 'online', last_seen_at: 'x' } },
        lastMessageIdByChannel: { [CHANNEL]: '5' },
      })),
    );

    // The surfaces that show those subscribe to them themselves.
    expect(result.current).toBe(first);
  });

  it('the snapshot is a real store state — unread slices are current, not stale', () => {
    const store = createStateStore();
    const { result } = renderHook(() => useShellStore(store));

    // A message writes a slice the gate ignores...
    act(() => writeMessageSlice(store, CHANNEL, makeMessage(MESSAGE, CHANNEL)));
    // ...and a roster write it honours. The snapshot must be the state object
    // captured THEN, so it carries the message too (no half-stale view).
    act(() => store.setState((s) => ({ membersById: { ...s.membersById } })));

    expect(result.current.messagesByChannel[CHANNEL]?.items[0]?.id).toBe(MESSAGE);
  });
});

describe('useThreadParentMessage', () => {
  it('resolves the open thread parent in the SAME commit, and follows its channel', () => {
    const store = createStateStore();
    act(() => writeMessageSlice(store, CHANNEL, makeMessage(MESSAGE, CHANNEL)));
    const { result, rerender } = renderHook(
      ({ thread }) =>
        useThreadParentMessage(
          store,
          thread as { channelId: string; parentMessageId: string | null } | null,
        ),
      { initialProps: { thread: null as { channelId: string; parentMessageId: string } | null } },
    );
    expect(result.current).toBeNull();

    rerender({ thread: { channelId: CHANNEL, parentMessageId: MESSAGE } });

    // Resolved during THIS render — not one effect (and one wrong frame) later.
    expect(result.current?.id).toBe(MESSAGE);
  });

  it('ignores a message in a different channel', () => {
    const store = createStateStore();
    act(() => writeMessageSlice(store, CHANNEL, makeMessage(MESSAGE, CHANNEL)));
    const { result } = renderHook(() =>
      useThreadParentMessage(store, { channelId: CHANNEL, parentMessageId: MESSAGE }),
    );
    const first = result.current;
    expect(first?.id).toBe(MESSAGE);

    act(() => writeMessageSlice(store, CHANNEL_2, makeMessage('9007199254742000', CHANNEL_2)));

    // The row object is re-read, but it is the SAME store row — no churn.
    expect(result.current).toBe(first);
  });

  it('resolves in the same commit when the thread switches', () => {
    const store = createStateStore();
    act(() => {
      writeMessageSlice(store, CHANNEL, makeMessage(MESSAGE, CHANNEL));
      writeMessageSlice(store, CHANNEL_2, makeMessage('9007199254742000', CHANNEL_2, 'other'));
    });
    const { result, rerender } = renderHook(
      ({ thread }: { thread: { channelId: string; parentMessageId: string } }) =>
        useThreadParentMessage(store, thread),
      { initialProps: { thread: { channelId: CHANNEL, parentMessageId: MESSAGE } } },
    );
    expect(result.current?.content).toBe('hello');

    rerender({ thread: { channelId: CHANNEL_2, parentMessageId: '9007199254742000' } });

    expect(result.current?.content).toBe('other');
  });
});
