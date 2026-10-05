/**
 * @cytale/state — optimistic.ts tests (U17).
 *
 * Optimistic send: client nonce → immediate store entry → replace on REST
 * 201 with the server-assigned id → revert + surface error on failure.
 */
import { describe, expect, it } from 'vitest';

import type { Message } from '@cytale/domain';
import type { GatewayEvent } from '@cytale/protocol';

import { compareNewestFirst, createStateStore } from '../store.js';
import {
  beginOptimisticSend,
  confirmOptimisticSend,
  failOptimisticSend,
  retryFailedSend,
  getNonce,
  holdFailedSend,
  heldSendsAwaitingConnection,
  markHeldSendsWaiting,
} from '../optimistic.js';
import { applyGatewayEvent } from '../reconcile.js';

const CHANNEL = '9007199254740993';
const USER_A = '7000000000000001';

describe('optimistic message send', () => {
  it('places the message immediately under a client nonce (happy path)', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'quick draft',
    });

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(1);
    expect(getNonce(store, items[0]!.id)).toBe(nonce);
    expect(items[0]!.content).toBe('quick draft');
    expect(items[0]!.id).not.toBe(''); // placeholder id, not server-truth
  });

  it('marks the optimistic entry pending and exposes its nonce', () => {
    const store = createStateStore();
    const { messageId } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'x',
    });
    const nonce = getNonce(store, messageId)!;
    expect(nonce).toBeDefined();
    expect(store.getState().pendingByNonce[nonce]!.status).toBe('pending');
  });

  it('replaces the nonce row with the server id on REST 201 (happy path)', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'persist me',
    });

    const serverMessage: Message = {
      id: '1000000000000101',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'persist me',
      created_at: '2026-08-28T00:00:00Z',
      edited_at: null,
    };
    confirmOptimisticSend(store, nonce, serverMessage);

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('1000000000000101');
    expect(getNonce(store, '1000000000000101')).toBeUndefined();
    expect(store.getState().pendingByNonce[nonce]).toBeUndefined();
  });

  it('reverts and surfaces the error on REST failure (error path)', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'will fail',
    });

    failOptimisticSend(store, nonce, { key: 'MISSING_PERMISSIONS', code: 40303, message: 'denied' });

    // reverted: nothing left in the channel pane
    expect(store.getState().messagesByChannel[CHANNEL]).toBeUndefined();
    // error surfaced
    const failed = store.getState().failedByNonce[nonce];
    expect(failed).toBeDefined();
    expect(failed!.error.key).toBe('MISSING_PERMISSIONS');
    expect(failed!.content).toBe('will fail');
  });

  it('keeps ordering stable when the confirmed server id sorts behind a live gateway event', () => {
    const store = createStateStore();
    beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'in flight',
    });
    // A gateway MESSAGE_CREATE lands while the optimistic row is pending.
    const evt = {
      op: 0,
      t: 'MessageCreate',
      s: 1,
      d: {
        id: '1000000000000099',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'from gateway',
        created_at: '2026-08-28T00:00:01Z',
        edited_at: null,
      },
    } as GatewayEvent;
    applyGatewayEvent(store, evt);

    confirmOptimisticSend(store, getNonce(store, findPendingId(store))!, {
      id: '1000000000000090',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'in flight',
      created_at: '2026-08-28T00:00:00Z',
      edited_at: null,
    });

    const ids = store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.id);
    expect(ids).toContain('1000000000000090');
    expect(ids).toContain('1000000000000099');
    // no ghost row for the placeholder
    expect(ids.filter((id) => id.startsWith('pending_'))).toHaveLength(0);
    expect(ids).toHaveLength(2);
  });

  it('confirms a send into a deep slice without an O(n²) dedupe sweep', () => {
    const store = createStateStore();
    // Uniform-width decimal ids: snowflakes out of one generator share a width,
    // so plain string order and the isNewer length-then-lexicographic rule agree.
    const base = 9_000_000;
    const rows: Message[] = [];
    for (let i = 0; i < 250; i += 1) {
      rows.push({
        id: String(base - i),
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: `row ${i}`,
        created_at: '2026-08-28T00:00:00Z',
        edited_at: null,
      });
    }
    store.setState({
      messagesByChannel: {
        [CHANNEL]: { items: rows, oldestId: rows[rows.length - 1]!.id, hasCompleteHistory: true },
      },
    });

    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'deep send',
    });

    // Sort work over message rows + findIndex invocations over them: the old
    // confirm path did a full sort AND a `filter(findIndex)` (O(n²) — 62k row
    // comparisons at 250 rows); the Set-based dedupe does neither.
    const work = countMessageRowWork(() => {
      confirmOptimisticSend(store, nonce, {
        id: String(base + 1),
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'deep send',
        created_at: '2026-08-28T00:00:01Z',
        edited_at: null,
      });
    });

    const items = store.getState().messagesByChannel[CHANNEL]!.items;
    expect(items).toHaveLength(251);
    expect(items[0]!.id).toBe(String(base + 1));
    expect(items.map((m) => m.id)).toEqual([...items].sort(compareNewestFirst).map((m) => m.id));
    expect(work.comparisons).toBe(0);
    expect(work.findIndexCalls).toBe(0);
  });

  it('dedupes a gateway echo that already landed (single row, no ghost placeholder)', () => {
    const store = createStateStore();
    const { nonce, messageId } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'raced',
    });
    // The echo carries the server id while the placeholder is still present.
    applyGatewayEvent(store, {
      op: 0,
      t: 'MessageCreate',
      s: 1,
      d: {
        id: '1000000000000500',
        channel_id: CHANNEL,
        thread_id: null,
        author_id: USER_A,
        content: 'raced',
        created_at: '2026-08-28T00:00:00Z',
        edited_at: null,
      },
    } as GatewayEvent);
    // Re-insert the placeholder (the shadow-retire already dropped it) to
    // exercise the confirm-time dedupe on a slice holding BOTH rows.
    store.setState((s) => ({
      messagesByChannel: {
        ...s.messagesByChannel,
        [CHANNEL]: {
          ...s.messagesByChannel[CHANNEL]!,
          items: [
            {
              id: messageId,
              channel_id: CHANNEL,
              thread_id: null,
              author_id: USER_A,
              content: 'raced',
              created_at: '2026-08-28T00:00:00Z',
              edited_at: null,
            },
            ...s.messagesByChannel[CHANNEL]!.items,
          ],
        },
      },
    }));

    confirmOptimisticSend(store, nonce, {
      id: '1000000000000500',
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'raced',
      created_at: '2026-08-28T00:00:00Z',
      edited_at: null,
    });

    const ids = store.getState().messagesByChannel[CHANNEL]!.items.map((m) => m.id);
    expect(ids).toEqual(['1000000000000500']);
  });

  it('retries a failed send back into the pending state', () => {
    const store = createStateStore();
    const { nonce } = beginOptimisticSend(store, {
      channel_id: CHANNEL,
      thread_id: null,
      author_id: USER_A,
      content: 'retry me',
    });
    failOptimisticSend(store, nonce, { key: 'NETWORK', code: 0, message: 'offline' });
    const retried = retryFailedSend(store, nonce);
    // Lane D #22: the retry presents the ORIGINAL nonce (the Idempotency-Key)
    // — the failed POST may have landed, and a fresh key would duplicate it.
    expect(retried.nonce).toBe(nonce);
    expect(store.getState().failedByNonce[nonce]).toBeUndefined();
    expect(store.getState().pendingByNonce[nonce]).toBeDefined();
    expect(store.getState().messagesByChannel[CHANNEL]!.items).toHaveLength(1);
  });
});

describe('held sends and the connection (send reliability B2)', () => {
  function hold(store: ReturnType<typeof createStateStore>, content: string, key: string) {
    const { nonce } = beginOptimisticSend(store, { channel_id: CHANNEL, thread_id: null, author_id: USER_A, content });
    holdFailedSend(store, nonce, { key, code: 0, message: key }, key === 'timeout' ? 'unconfirmed' : 'failed');
    return nonce;
  }
  const state = (store: ReturnType<typeof createStateStore>, nonce: string) =>
    store.getState().messagesByChannel[CHANNEL]!.items.find((m) => m.id === `pending_${nonce}`)!.send_state;

  it('lists only transport failures and timeouts, oldest first', () => {
    const store = createStateStore();
    const a = hold(store, 'a', 'network_error');
    hold(store, 'refused', 'validation_failed');
    const b = hold(store, 'b', 'timeout');
    hold(store, 'server', 'internal_error');
    const c = hold(store, 'c', 'network_error');
    expect(heldSendsAwaitingConnection(store)).toEqual([a, b, c]);
  });

  it('marks exactly those rows waiting; a refusal keeps its own state', () => {
    const store = createStateStore();
    const net = hold(store, 'net', 'network_error');
    const slow = hold(store, 'slow', 'timeout');
    const refused = hold(store, 'refused', 'account_unverified');
    markHeldSendsWaiting(store);
    expect([state(store, net), state(store, slow), state(store, refused)]).toEqual(['waiting', 'waiting', 'failed']);
    // Idempotent: nothing left to re-mark writes nothing.
    const before = store.getState().messagesByChannel;
    markHeldSendsWaiting(store);
    expect(store.getState().messagesByChannel).toBe(before);
  });
});

// -- helpers ----------------------------------------------------------------

/**
 * Sort/findIndex work over MESSAGE ROWS (arrays whose first element carries a
 * string `id`) performed while `run` executes. Both prototypes are restored in
 * a finally block; unrelated calls are not counted. `findIndexCalls` is the
 * O(n²) tell — the old `filter((m, i, arr) => arr.findIndex(...))` dedupe
 * invoked `findIndex` once per row.
 */
function countMessageRowWork(run: () => void): {
  sorts: number;
  comparisons: number;
  findIndexCalls: number;
} {
  const originalSort = Array.prototype.sort;
  const originalFindIndex = Array.prototype.findIndex;
  let sorts = 0;
  let comparisons = 0;
  let findIndexCalls = 0;
  const isRowArray = (value: unknown[]): boolean =>
    typeof (value[0] as { id?: unknown } | undefined)?.id === 'string';

  Array.prototype.sort = function (
    this: unknown[],
    compareFn?: (a: unknown, b: unknown) => number,
  ) {
    if (isRowArray(this)) {
      sorts += 1;
      if (typeof compareFn === 'function') {
        const counted = (a: unknown, b: unknown): number => {
          comparisons += 1;
          return compareFn(a, b);
        };
        return originalSort.call(this, counted as never);
      }
    }
    return originalSort.call(this, compareFn as never);
  } as unknown as typeof Array.prototype.sort;

  Array.prototype.findIndex = function (this: unknown[], predicate: unknown, thisArg?: unknown) {
    if (isRowArray(this)) findIndexCalls += 1;
    return (
      originalFindIndex as unknown as (
        this: unknown[],
        p: unknown,
        t?: unknown,
      ) => number
    ).call(this, predicate, thisArg);
  } as unknown as typeof Array.prototype.findIndex;

  try {
    run();
  } finally {
    Array.prototype.sort = originalSort;
    Array.prototype.findIndex = originalFindIndex;
  }
  return { sorts, comparisons, findIndexCalls };
}

function findPendingId(store: ReturnType<typeof createStateStore>): string {
  const [nonce, pending] = Object.entries(store.getState().pendingByNonce)[0]!;
  void nonce;
  return pending.messageId;
}
