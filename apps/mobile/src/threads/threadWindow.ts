/**
 * @cytale/mobile — thread-window primitives (plan 004 M9, R12).
 *
 * `@cytale/state` exports `mergeChannelMessages` for the channel timeline but
 * no thread equivalent, so the mobile thread surface owns the thread merge.
 * It goes through the SAME dispatcher the gateway feeds —
 * `applyGatewayEvent`'s `ThreadMessageCreate` branch — which is what web's
 * `useThreads.loadReplies` does and what keeps one upsert/dedupe rule (and
 * the optimistic-placeholder shadowing) across both clients.
 *
 * The synthetic sequence stamp is the load-bearing detail: `applyGatewayEvent`
 * drops any dispatch with `s <= lastSeq` (the RESUMED-replay gate). A page
 * load is a local reconcile, not a gateway frame, so it must be stamped
 * ABOVE the live session's cursor. The counter therefore seeds itself from
 * the store's `lastSeq` on every stamp instead of starting at a fixed
 * constant a long session can outrun — a constant silently drops history.
 */
import type { Message } from '@cytale/domain';
import { applyGatewayEvent, SYNTHETIC_SEQ_FLOOR, type StateStore } from '@cytale/state';

/**
 * Synthetic sequence floor — the SAME binding web's allocator starts at. It used
 * to be a mirrored `1_000_000` here, which is the drift 6.8's "one owner" claim
 * is about: mobile's allocator keeps its own (deliberately different) reseeding
 * behaviour, but the NUMBER has one home in `@cytale/state`.
 */
let localSeq = SYNTHETIC_SEQ_FLOOR;

/**
 * Next synthetic sequence number — always above the store's replay cursor,
 * and always increasing. One counter per module (per-module counters collide:
 * a second module's first stamp lands below the first module's last).
 */
export function nextSyntheticSeq(store: StateStore): number {
  localSeq = Math.max(localSeq, store.getState().lastSeq) + 1;
  return localSeq;
}

/** Test hygiene: restore the counter to its floor. */
export function resetSyntheticSeq(): void {
  localSeq = SYNTHETIC_SEQ_FLOOR;
}

export interface MergeThreadOptions {
  /**
   * True when the page was short — there is no older history behind it, so
   * the window stops asking (`loadOlder`'s completion gate).
   */
  isLastPage?: boolean;
}

/**
 * Merge one REST page into `messagesByThread[threadId]`. Rows upsert by id
 * (a replayed page is a no-op), sort newest-first like the store's slice, and
 * the slice's `oldestId` tracks the oldest loaded reply.
 */
export function mergeThreadMessages(
  store: StateStore,
  threadId: string,
  messages: readonly Message[],
  options: MergeThreadOptions = {},
): void {
  // Oldest-first: the reducer counts a reply toward the thread summary only
  // when it is newer than the summary's latest (#106), so time order is what
  // lets a replayed page never inflate it.
  for (const message of [...messages].reverse()) {
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: nextSyntheticSeq(store),
      d: {
        id: message.id,
        channel_id: message.channel_id,
        thread_id: threadId,
        author_id: message.author_id,
        content: message.content,
        created_at: message.created_at,
        edited_at: message.edited_at,
      },
    });
  }

  store.setState((state) => {
    const slice = state.messagesByThread[threadId];
    if (slice === undefined) return {};
    const oldest = slice.items.length > 0 ? slice.items[slice.items.length - 1]!.id : null;
    const hasCompleteHistory = options.isLastPage === true || slice.hasCompleteHistory;
    if (slice.oldestId === oldest && slice.hasCompleteHistory === hasCompleteHistory) return {};
    return {
      messagesByThread: {
        ...state.messagesByThread,
        [threadId]: { ...slice, oldestId: oldest, hasCompleteHistory },
      },
    };
  });
}
