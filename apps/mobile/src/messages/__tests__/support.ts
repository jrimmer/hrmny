/**
 * Shared fixtures for the message-window tests (plan 004 M6). Not a test
 * file — jest's testMatch only picks up `*.test.ts(x)`.
 *
 * Every test builds its OWN store (`createStateStore`) so a seeded window
 * never leaks between suites, and ids are real 19-digit snowflakes so
 * `compareSnowflakes` ordering (the store's and the divider's rule) is the
 * production path, not a string-compare stand-in.
 */
import type { MessageWithReactions, ReactionSummary } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import { createStateStore, type StateStore } from '@cytale/state';

export const IDS = {
  me: '900000000000000001',
  alice: '900000000000000002',
  bob: '900000000000000003',
  channel: '700000000000000001',
  otherChannel: '700000000000000002',
} as const;

/** A real snowflake for the `n`th message (1-based, 19 digits, monotonic). */
export function messageId(n: number): string {
  return String(1000000000000000000n + BigInt(n));
}

export function makeMessage(n: number, overrides: Partial<Message> = {}): Message {
  return {
    id: messageId(n),
    channel_id: IDS.channel,
    thread_id: null,
    author_id: IDS.alice,
    content: `message ${n}`,
    created_at: `2026-09-08T12:${String(n % 60).padStart(2, '0')}:00.000Z`,
    edited_at: null,
    ...overrides,
  };
}

/** A store seeded with `currentUser` and a member roster. */
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
  });
  return store;
}

/** Seed a channel window directly (newest-first, the store's own order). */
export function seedWindow(store: StateStore, channelId: string, newestFirst: Message[]): void {
  store.setState((state) => ({
    messagesByChannel: {
      ...state.messagesByChannel,
      [channelId]: {
        items: newestFirst,
        oldestId: newestFirst.length > 0 ? newestFirst[newestFirst.length - 1]!.id : null,
        hasCompleteHistory: false,
      },
    },
  }));
}

/** Seed the unread slice for a channel. */
export function seedUnread(
  store: StateStore,
  channelId: string,
  unread: { last_read_id: string | null; unread_count: number; mention_count?: number },
): void {
  store.setState((state) => ({
    unreadByChannel: {
      ...state.unreadByChannel,
      [channelId]: { mention_count: 0, ...unread },
    },
  }));
}

/** Chat-order ids (oldest first) of a channel window. */
export function windowIds(store: StateStore, channelId: string): string[] {
  const items = store.getState().messagesByChannel[channelId]?.items ?? [];
  return [...items].reverse().map((message) => message.id);
}

/**
 * Seed one row's reaction chips. `reactions` is the api-client passthrough
 * key the shared `Message` does not declare (absent-when-empty on the wire).
 */
export function seedReactions(
  store: StateStore,
  channelId: string,
  id: string,
  reactions: ReactionSummary[],
): void {
  store.setState((state) => {
    const slice = state.messagesByChannel[channelId];
    if (!slice) return {};
    return {
      messagesByChannel: {
        ...state.messagesByChannel,
        [channelId]: {
          ...slice,
          items: slice.items.map((message) =>
            message.id === id ? ({ ...message, reactions } as MessageWithReactions) : message,
          ),
        },
      },
    };
  });
}

/** One row's reaction chips (empty when the wire key is absent). */
export function reactionsOf(
  store: StateStore,
  channelId: string,
  id: string,
): ReactionSummary[] {
  const row = store.getState().messagesByChannel[channelId]?.items.find((m) => m.id === id) as
    | MessageWithReactions
    | undefined;
  return row?.reactions ?? [];
}
