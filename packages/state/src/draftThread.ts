/**
 * @cytale/state — DRAFT threads (2026-10-01).
 *
 * A thread does not exist on the server until its first reply is sent
 * (2026-09-12: opening "Start thread" and closing it leaves nothing behind).
 * Until then the panel's window lives in `messagesByThread` under a CLIENT
 * key — `draftThreadKey(channel, parent)` — so the first reply can be drawn at
 * once as a pending row, exactly like a reply in an existing thread, instead
 * of waiting for the create round-trip with the text held in the composer.
 *
 * When the create answers, `promoteDraftThread` moves that window (and every
 * send record that points at it) to the server's thread id in ONE store
 * write: the rows are the same objects with a new `thread_id`, their list
 * keys (`client_key`) are unchanged, so the open panel keeps its list mounted
 * and nothing on screen moves.
 */

import type { Snowflake } from '@cytale/protocol';
import type { Message, Thread } from '@cytale/domain';

import { insertNewestFirst, type MessageSlice, type StateStore } from './store.js';

const DRAFT_PREFIX = 'draft_';

/** The client key of the draft thread hanging off `parentMessageId`. */
export function draftThreadKey(channelId: Snowflake, parentMessageId: Snowflake): string {
  return `${DRAFT_PREFIX}${channelId}_${parentMessageId}`;
}

/** True for a draft thread's client key (never a server thread id). */
export function isDraftThreadKey(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.startsWith(DRAFT_PREFIX);
}

/**
 * Make sure the draft's window exists. A draft has no history by definition,
 * so its window is COMPLETE: the list shows the origin above the first row
 * and never pages older replies from a server that has none.
 */
export function seedDraftThread(store: StateStore, key: string): void {
  const slice = store.getState().messagesByThread[key];
  if (slice?.hasCompleteHistory === true) return;
  store.setState((s) => ({
    messagesByThread: {
      ...s.messagesByThread,
      [key]: {
        items: slice?.items ?? [],
        oldestId: slice?.oldestId ?? null,
        hasCompleteHistory: true,
      },
    },
  }));
}

/** Forget a draft's window once nothing is left in it (the panel closed). */
export function dropEmptyDraftThread(store: StateStore, key: string): void {
  const slice = store.getState().messagesByThread[key];
  if (!slice || slice.items.length > 0) return;
  store.setState((s) => {
    const { [key]: _gone, ...messagesByThread } = s.messagesByThread;
    return { messagesByThread };
  });
}

/**
 * The server created the draft's thread: in ONE write, the thread record
 * lands (a gateway ThreadCreate that beat the REST answer is kept — it is the
 * same thread, possibly richer), the draft's window becomes the thread's, and
 * every pending/failed send aimed at the draft is re-aimed at the thread.
 */
export function promoteDraftThread(
  store: StateStore,
  key: string,
  created: Thread | Snowflake,
): void {
  // A bare id re-aims sends only (a send queued under the draft key after an
  // earlier one already promoted it); the record is already in the store.
  const thread: Pick<Thread, 'id'> & Partial<Thread> =
    typeof created === 'string' ? { id: created } : created;
  store.setState((s) => {
    let threadsById = s.threadsById;
    let threadIdsByChannel = s.threadIdsByChannel;
    if (typeof created !== 'string') {
      if (!s.threadsById[created.id]) threadsById = { ...s.threadsById, [created.id]: created };
      const ids = s.threadIdsByChannel[created.channel_id] ?? [];
      if (!ids.includes(created.id)) {
        threadIdsByChannel = { ...s.threadIdsByChannel, [created.channel_id]: [...ids, created.id] };
      }
    }

    const draft = s.messagesByThread[key];
    let messagesByThread = s.messagesByThread;
    if (draft) {
      const retarget = (m: Message): Message =>
        m.thread_id === thread.id ? m : { ...m, thread_id: thread.id };
      const real = s.messagesByThread[thread.id];
      let slice: MessageSlice;
      if (real) {
        let items = real.items;
        for (const row of draft.items) {
          if (!items.some((m) => m.id === row.id)) items = insertNewestFirst(items, retarget(row));
        }
        slice = items === real.items ? real : { ...real, items };
      } else {
        slice = { ...draft, items: draft.items.map(retarget) };
      }
      const { [key]: _draft, ...rest } = s.messagesByThread;
      messagesByThread = { ...rest, [thread.id]: slice };
    }

    let pendingByNonce = s.pendingByNonce;
    for (const [nonce, p] of Object.entries(s.pendingByNonce)) {
      if (p.thread_id !== key) continue;
      if (pendingByNonce === s.pendingByNonce) pendingByNonce = { ...s.pendingByNonce };
      pendingByNonce[nonce] = { ...p, thread_id: thread.id };
    }
    let failedByNonce = s.failedByNonce;
    for (const [nonce, f] of Object.entries(s.failedByNonce)) {
      if (f.thread_id !== key) continue;
      if (failedByNonce === s.failedByNonce) failedByNonce = { ...s.failedByNonce };
      failedByNonce[nonce] = { ...f, thread_id: thread.id };
    }

    return { threadsById, threadIdsByChannel, messagesByThread, pendingByNonce, failedByNonce };
  });
}
