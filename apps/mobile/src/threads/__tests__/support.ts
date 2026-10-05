/**
 * Shared fixtures for the thread-surface tests (plan 004 M9). Not a test
 * file — jest's testMatch only picks up `*.test.ts(x)`.
 *
 * Every test builds its OWN store (`createStateStore`) so a seeded thread
 * window never leaks between suites, and ids are real 19-digit snowflakes so
 * `compareSnowflakes` ordering (the store's own rule) is the production path,
 * not a string-compare stand-in.
 */
import type { Message, Thread } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

export const IDS = {
  me: '900000000000000001',
  alice: '900000000000000002',
  bob: '900000000000000003',
  channel: '700000000000000001',
  otherChannel: '700000000000000002',
  thread: '600000000000000001',
  otherThread: '600000000000000002',
} as const;

/** A real snowflake for the `n`th reply (1-based, 19 digits, monotonic). */
export function replyId(n: number): string {
  return String(2000000000000000000n + BigInt(n));
}

export function makeReply(n: number, overrides: Partial<Message> = {}): Message {
  return {
    id: replyId(n),
    channel_id: IDS.channel,
    thread_id: IDS.thread,
    author_id: IDS.alice,
    content: `reply ${n}`,
    created_at: `2026-09-08T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
    edited_at: null,
    ...overrides,
  };
}

/** The thread record the store carries (metadata the route reads). */
export function threadRecord(overrides: Partial<Thread> = {}): Thread {
  return {
    id: IDS.thread,
    channel_id: IDS.channel,
    parent_message_id: '1000000000000000001',
    name: 'Ship it',
    created_by: IDS.me,
    archived: false,
    member_state: { notify: true, last_read_id: null },
    created_at: '2026-09-08T00:00:00.000Z',
    ...overrides,
  };
}

/** A store seeded with `currentUser`, a roster, the channel and the thread. */
export function makeStore(seed: { currentUserId?: string | null } = {}): StateStore {
  const store = createStateStore();
  const currentUser =
    seed.currentUserId === null
      ? null
      : { id: seed.currentUserId ?? IDS.me, username: 'rowan' };
  store.setState({
    currentUser,
    membersById: {
      [IDS.me]: {
        id: IDS.me,
        username: 'rowan',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [],
      },
      [IDS.alice]: {
        id: IDS.alice,
        username: 'alice',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [],
      },
      [IDS.bob]: {
        id: IDS.bob,
        username: 'bob',
        display_name: 'Bobby',
        nickname: null,
        joined_at: '2026-09-08T00:00:00.000Z',
        roles: [],
      },
    },
    channels: {
      [IDS.channel]: {
        id: IDS.channel,
        workspace_id: '800000000000000001',
        name: 'general',
        type: 'text',
        topic: 'Ship it',
        position: 0,
        last_message_id: null,
        created_at: '2026-09-08T00:00:00.000Z',
      },
    },
    threadsById: { [IDS.thread]: threadRecord() },
    threadIdsByChannel: { [IDS.channel]: [IDS.thread] },
  });
  return store;
}

/** Seed a thread window directly (newest-first, the store's own order). */
export function seedThreadWindow(
  store: StateStore,
  newestFirst: Message[],
  threadId: string = IDS.thread,
): void {
  store.setState((state) => ({
    messagesByThread: {
      ...state.messagesByThread,
      [threadId]: {
        items: newestFirst,
        oldestId: newestFirst.length > 0 ? newestFirst[newestFirst.length - 1]!.id : null,
        hasCompleteHistory: false,
      },
    },
  }));
}

/** Seed the thread's unread tier. */
export function seedThreadUnread(
  store: StateStore,
  unread: { last_read_id: string | null; unread_count: number; mention_count?: number },
  threadId: string = IDS.thread,
): void {
  store.setState((state) => ({
    unreadByThread: {
      ...state.unreadByThread,
      [threadId]: { mention_count: 0, ...unread },
    },
  }));
}

/** Chat-order ids (oldest first) of a thread window. */
export function windowIds(store: StateStore, threadId: string = IDS.thread): string[] {
  const items = store.getState().messagesByThread[threadId]?.items ?? [];
  return [...items].reverse().map((message) => message.id);
}
