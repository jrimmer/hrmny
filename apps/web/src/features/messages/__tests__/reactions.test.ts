/**
 * @cytale/web — reactions seam tests (reactions UI unit).
 *
 * Dispatch reconcile mirroring the U17 dispatch-test style: gateway-shaped
 * MessageReactionAdd/Remove/RemoveAll frames patch the SAME store slices
 * (messagesByChannel) the shared dispatcher owns; own echoes of optimistic
 * toggles are deduped; replays drop; placeholders and malformed frames are
 * accepted no-ops. Store-level row clearing is the render contract's "row
 * clears" half (MessageItem hides the row when the key is absent).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { createStateStore, type StateStore } from '@cytale/state';
import type { Message } from '@cytale/domain';

import {
  applyReactionAdd,
  applyReactionEvent,
  applyReactionRemove,
  applyReactionRemoveAll,
  markPendingOwnToggle,
} from '../reactions.js';

const CHANNEL = '9007199254740993';
const MESSAGE = '1000000000000001';
const ME = '7000000000000002';
const OTHER = '7000000000000001';

let seq = 0;
function frame(t: string, d: unknown, s?: number): unknown {
  return { op: 0, t, s: s ?? ++seq, d };
}

function togglePayload(overrides: Partial<{ channel_id: string; message_id: string; user_id: string; emoji: string }> = {}) {
  return {
    channel_id: CHANNEL,
    message_id: MESSAGE,
    user_id: OTHER,
    emoji: '👍',
    ...overrides,
  };
}

function seedStore(): StateStore {
  const store = createStateStore();
  store.setState({ currentUser: { id: ME, username: 'me' } });
  const seed: Message = {
    id: MESSAGE,
    channel_id: CHANNEL,
    thread_id: null,
    author_id: OTHER,
    content: 'react to me',
    created_at: '2026-09-04T00:00:00Z',
    edited_at: null,
  };
  store.setState((s) => ({
    messagesByChannel: {
      ...s.messagesByChannel,
      [CHANNEL]: { items: [seed], oldestId: null, hasCompleteHistory: true },
    },
  }));
  return store;
}

function reactionsOf(store: StateStore): { emoji: string; count: number; me: boolean }[] {
  const row = store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === MESSAGE);
  return ((row as { reactions?: { emoji: string; count: number; me: boolean }[] }).reactions ??
    []) as { emoji: string; count: number; me: boolean }[];
}

beforeEach(() => {
  seq = 1; // store's lastSeq starts at 0; dispatch seqs must exceed it
});

describe('reactions seam — MESSAGE_REACTION_ADD', () => {
  it('creates a new chip for an unreacted emoji (foreign reactor)', () => {
    const store = seedStore();
    expect(applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()))).toBe(true);
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });

  it('increments the count on an existing chip and flags me for own adds', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: OTHER + '9' })));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 3, me: true }]);
  });

  it('keeps chips per-emoji (second emoji appends, first untouched)', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ emoji: '🎉' })));
    expect(reactionsOf(store)).toEqual([
      { emoji: '👍', count: 1, me: false },
      { emoji: '🎉', count: 1, me: false },
    ]);
  });
});

describe('reactions seam — MESSAGE_REACTION_REMOVE', () => {
  it('decrements and drops the chip at zero', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload()));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ user_id: ME })));
    expect(reactionsOf(store)).toEqual([]); // key removed — the chip row clears
  });

  it('own remove flips me off but keeps the chip while others remain', () => {
    const store = seedStore();
    for (let i = 0; i < 3; i++) {
      applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: `${OTHER}${i}` })));
    }
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ user_id: ME })));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 3, me: false }]);
  });

  it('removing an emoji nobody reacted with is a no-op', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    applyReactionEvent(store, frame('MessageReactionRemove', togglePayload({ emoji: '👀' })));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });
});

describe('reactions seam — MESSAGE_REACTION_REMOVE_ALL', () => {
  it('clears the whole reactions row (key absent)', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ emoji: '🎉', user_id: ME })));
    expect(reactionsOf(store)).toHaveLength(2);

    expect(
      applyReactionEvent(store, frame('MessageReactionRemoveAll', { channel_id: CHANNEL, message_id: MESSAGE })),
    ).toBe(true);
    const row = store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === MESSAGE);
    expect((row as { reactions?: unknown }).reactions).toBeUndefined();
  });
});

describe('reactions seam — dedup, gating, and no-ops', () => {
  it('an own echo of a pending optimistic toggle is consumed without double-counting', () => {
    const store = seedStore();
    // The hook's optimistic path: mark pending, apply add immediately.
    markPendingOwnToggle(MESSAGE, '👍', 'add');
    applyReactionAdd(store, togglePayload({ user_id: ME }));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);

    // The server echo arrives — it must NOT increment again.
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it("own echoes from the user's OTHER devices apply (no pending entry)", () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ user_id: ME })));
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: true }]);
  });

  it('drops replayed frames (s <= lastSeq)', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload()));
    // Mirror the wired pipeline: the shared dispatcher (which runs AFTER the
    // reactions seam in session.ts) advances lastSeq for the applied frame.
    store.setState({ lastSeq: seq });
    // Same seq replayed — dropped by the seam's replay gate.
    expect(applyReactionEvent(store, frame('MessageReactionAdd', togglePayload(), seq))).toBe(false);
    expect(reactionsOf(store)).toEqual([{ emoji: '👍', count: 1, me: false }]);
  });

  it('never patches optimistic placeholder rows (pending_<nonce>)', () => {
    const store = seedStore();
    applyReactionAdd(store, togglePayload({ message_id: `pending_${'abc'}` }));
    applyReactionRemove(store, togglePayload({ message_id: `pending_${'abc'}` }));
    applyReactionRemoveAll(store, { channel_id: CHANNEL, message_id: `pending_${'abc'}` });
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });

  it('unknown event names and malformed frames are accepted no-ops', () => {
    const store = seedStore();
    expect(applyReactionEvent(store, frame('MessageCreate', { id: '1' }))).toBe(false);
    expect(applyReactionEvent(store, frame('MessageReactionAdd', { channel_id: CHANNEL }))).toBe(false);
    expect(applyReactionEvent(store, { op: 1, t: 'MessageReactionAdd', s: 99, d: togglePayload() })).toBe(false);
    expect(applyReactionEvent(store, null)).toBe(false);
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });

  it('no-ops when the channel slice or message is unknown (never crashes)', () => {
    const store = seedStore();
    applyReactionEvent(store, frame('MessageReactionAdd', togglePayload({ message_id: '4242424242424242' })));
    applyReactionRemoveAll(store, { channel_id: '9999999999999999', message_id: MESSAGE });
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });
});
