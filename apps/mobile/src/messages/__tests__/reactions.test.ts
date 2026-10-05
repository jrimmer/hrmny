/**
 * Reactions seam tests (plan 004 M8, R11).
 *
 * The seam mirrors the shipped web one (`apps/web/.../reactions.ts`) case for
 * case: gateway-shaped frames patch the SAME `messagesByChannel` slices the
 * shared dispatcher owns, own echoes of optimistic toggles are deduped,
 * replays drop, placeholders and malformed frames are accepted no-ops.
 * `beginOptimisticReaction` is the chips'/sheet's apply path — the optimistic
 * half of "react applies instantly, then reconciles on the dispatch".
 */
import type { MessageWithReactions } from '@cytale/api-client';
import { createStateStore, type StateStore } from '@cytale/state';

import {
  applyReactionAdd,
  applyReactionEvent,
  applyReactionRemove,
  applyReactionRemoveAll,
  beginOptimisticReaction,
  markPendingOwnToggle,
  resetReactionSeam,
} from '../reactions';
import { IDS, makeMessage, makeStore, messageId, reactionsOf, seedReactions, seedWindow } from './support';

const CHANNEL = IDS.channel;
const MESSAGE = messageId(1);
const ME = IDS.me;
const OTHER = IDS.alice;

let seq = 0;
function frame(t: string, d: unknown, s?: number): unknown {
  return { op: 0, t, s: s ?? ++seq, d };
}

function togglePayload(
  overrides: Partial<{
    channel_id: string;
    message_id: string;
    user_id: string;
    emoji: string;
  }> = {},
) {
  return {
    channel_id: CHANNEL,
    message_id: MESSAGE,
    user_id: OTHER,
    emoji: '👍',
    ...overrides,
  };
}

/** A store holding one confirmed message by `author_id`. */
function seedStore(authorId = OTHER): StateStore {
  const store = makeStore();
  seedWindow(store, CHANNEL, [makeMessage(1, { author_id: authorId })]);
  return store;
}

beforeEach(() => {
  seq = 0;
  resetReactionSeam();
});

describe('dispatch reconcile', () => {
  it('creates a chip for an unreacted emoji (foreign reactor)', () => {
    const store = seedStore();
    expect(applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()))).toBe(true);
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });

  it('marks own adds and increments foreign chips', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    applyReactionEvent(
      store,
      frame('MessageReactionAdd', togglePayload({ user_id: `${OTHER}9` })),
    );
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 2, me: true }]);
  });

  it('is idempotent for a duplicate own add (echo/retry)', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('decrements on remove and drops the chip at zero', () => {
    const store = seedStore();
    seedReactions(store, CHANNEL, MESSAGE, [{ emoji: '👍', count: 2, me: true }]);

    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ user_id: OTHER })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
    // Absent-when-empty: the wire key is REMOVED, not left as an empty array.
    const row = store.getState().messagesByChannel[CHANNEL]!.items[0] as MessageWithReactions;
    expect(row.reactions).toBeUndefined();
  });

  it('clears the whole chip row on RemoveAll', () => {
    const store = seedStore();
    seedReactions(store, CHANNEL, MESSAGE, [
      { emoji: '👍', count: 1, me: false },
      { emoji: '🎉', count: 2, me: true },
    ]);
    expect(
      applyReactionEvent(store, frame('MessageReactionRemoveAll', { channel_id: CHANNEL, message_id: MESSAGE })),
    ).toBe(true);
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
  });

  it('drops replayed frames (s <= lastSeq)', () => {
    const store = seedStore();
    store.setState({ lastSeq: 5 });
    expect(applyReactionEvent(store, frame('MessageReactionAdd', togglePayload(), 5))).toBe(false);
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
  });

  it('accepts malformed and non-reaction frames as no-ops', () => {
    const store = seedStore();
    expect(applyReactionEvent(store, frame('MessageReactionAdd', { emoji: '' }))).toBe(false);
    expect(applyReactionEvent(store, frame('MessageCreate', togglePayload()))).toBe(false);
    expect(applyReactionEvent(store, 'not a frame')).toBe(false);
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
  });

  it('never patches optimistic placeholder rows', () => {
    const store = seedStore();
    const pending = 'pending_abc';
    seedWindow(store, CHANNEL, [makeMessage(1), { ...makeMessage(2), id: pending }]);
    applyReactionAdd(store, { ...togglePayload(), message_id: pending });
    applyReactionRemoveAll(store, { channel_id: CHANNEL, message_id: pending });
    expect(reactionsOf(store, CHANNEL, pending)).toEqual([]);
  });

  it('ignores slices that do not hold the message', () => {
    const store = seedStore();
    applyReactionAdd(store, { ...togglePayload(), message_id: messageId(9) });
    applyReactionRemove(store, { ...togglePayload(), emoji: '🎉' });
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
  });
});

describe('optimistic toggle', () => {
  it('applies an add instantly and swallows the own echo that follows', () => {
    const store = seedStore();
    const toggle = beginOptimisticReaction(store, {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      user_id: ME,
      emoji: '👍',
    });
    expect(toggle?.op).toBe('add');
    // Optimistic: the chip is on the row before any server round-trip.
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    // The gateway echoes the own add back: consumed, not re-applied.
    expect(applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })))).toBe(
      true,
    );
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    // A foreign add still reconciles normally.
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: `${OTHER}9` })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 2, me: true }]);
  });

  it('applies a remove instantly and swallows the own remove echo', () => {
    const store = seedStore();
    seedReactions(store, CHANNEL, MESSAGE, [{ emoji: '👍', count: 1, me: true }]);

    const toggle = beginOptimisticReaction(store, {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      user_id: ME,
      emoji: '👍',
    });
    expect(toggle?.op).toBe('remove');
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);

    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);
  });

  it('rolls back a failed add and forgets the pending echo', () => {
    const store = seedStore();
    const toggle = beginOptimisticReaction(store, {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      user_id: ME,
      emoji: '👍',
    })!;
    toggle.rollback();
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([]);

    // The queue is empty: a later own echo (another device) applies.
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('rolls back a failed remove to the previous chip', () => {
    const store = seedStore();
    seedReactions(store, CHANNEL, MESSAGE, [{ emoji: '👍', count: 3, me: true }]);
    const toggle = beginOptimisticReaction(store, {
      channel_id: CHANNEL,
      message_id: MESSAGE,
      user_id: ME,
      emoji: '👍',
    })!;
    // Our own reaction is gone: the remaining reactors are other people.
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 2, me: false }]);
    toggle.rollback();
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 3, me: true }]);
  });

  it('is a no-op for placeholder rows (never reactable)', () => {
    const store = seedStore();
    seedWindow(store, CHANNEL, [{ ...makeMessage(1), id: 'pending_abc' }]);
    const toggle = beginOptimisticReaction(store, {
      channel_id: CHANNEL,
      message_id: 'pending_abc',
      user_id: ME,
      emoji: '👍',
    });
    expect(toggle).toBeNull();
    expect(reactionsOf(store, CHANNEL, 'pending_abc')).toEqual([]);
  });
});

describe('pending queue hygiene', () => {
  it('does not dedupe a foreign reactor even while an own toggle is queued', () => {
    const store = seedStore();
    markPendingOwnToggle(MESSAGE, '👍', 'add');
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: OTHER })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });

  it('resets cleanly between sessions', () => {
    const store = seedStore();
    markPendingOwnToggle(MESSAGE, '👍', 'add');
    resetReactionSeam();
    // Queue gone → the own echo applies like any other add.
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('reads the viewer from the store (no signed-in user → never "mine")', () => {
    const store = createStateStore();
    seedWindow(store, CHANNEL, [makeMessage(1)]);
    applyReactionAdd(store, { ...togglePayload(), user_id: ME });
    expect(reactionsOf(store, CHANNEL, MESSAGE)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });
});
