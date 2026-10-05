/**
 * @cytale/state — optimistic message send (U17 optimistic).
 *
 * Flow (plan contract): on send, add the message to the store immediately
 * under a client nonce + placeholder id; on REST 201, replace the nonce row
 * with the server-assigned id; on REST failure, revert and surface the error.
 *
 * Placeholder ids are `pending_<nonce>` — reconcile.ts ignores gateway
 * MESSAGE_CREATE frames carrying that shape, and confirmation swaps the row
 * in place so ordering stays stable.
 */

import type { Snowflake } from '@cytale/protocol';
import type { Attachment, Message, ReferencedMessage, UploadedAttachment } from '@cytale/domain';

import {
  insertIntoWindow,
  insertNewestFirst,
  liftPendingPlaceholders,
  nextPlaceholderTimestamp,
  type FailedSend,
  type MessageSlice,
  type PendingSend,
  type StateState,
  type StateStore,
} from './store.js';

/** Length of the random nonce suffix. */
const NONCE_BYTES = 9; // 12 base64url chars

/**
 * Mint a send nonce — the optimistic row's key AND the POST's
 * Idempotency-Key. Exported so a caller that may RETRY a send (the composer
 * after a failure or a timeout, lane D #22) can hold the nonce and present the
 * same one again: a retry with a fresh key is a second message whenever the
 * first POST actually landed.
 */
export function newSendNonce(): string {
  return makeNonce();
}

function makeNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function makePlaceholderId(nonce: string): Snowflake {
  return `pending_${nonce}`;
}

function emptySlice(): MessageSlice {
  return { items: [], oldestId: null, hasCompleteHistory: false };
}

/**
 * Retire a placeholder row and install the server row in ONE pass.
 *
 * - the placeholder disappears (its id was client-local);
 * - duplicate ids keep their FIRST occurrence (`seen` replaces the old
 *   `filter((m, i, arr) => arr.findIndex(...))` — an O(n²) scan that cost
 *   62k row comparisons at 250 rows, 500k at 1,000);
 * - when the server row is not already present it is placed by the shared
 *   ordered insert (no full-slice sort).
 */
function settleOptimisticRow(
  slice: MessageSlice,
  placeholderId: Snowflake,
  serverMessage: Message,
): MessageSlice {
  const seen = new Set<Snowflake>();
  const items: Message[] = [];
  let replaces = false;
  for (const row of slice.items) {
    if (row.id === placeholderId) continue;
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    items.push(row);
    if (row.id === serverMessage.id) replaces = true;
  }
  // The gateway echo may have beaten the REST 201: its row already carries
  // the server id, and the mapped placeholder must not double it (nor
  // overwrite the row's richer state with the REST echo of it).
  // Lane D #12: the confirmed row keeps the placeholder's client key, so a
  // list keyed by `client_key ?? id` does not remount it at the swap. An echo
  // that already landed (and was matched to this placeholder) carries it too;
  // one that was not gets it here.
  const clientKey = placeholderId.slice('pending_'.length);
  let next: Message[];
  if (replaces) {
    const at = items.findIndex((row) => row.id === serverMessage.id);
    const row = items[at]!;
    if (row.client_key === undefined) {
      next = items.slice();
      next[at] = { ...row, client_key: clientKey };
    } else {
      next = items;
    }
  } else {
    next = insertNewestFirst(items, { ...serverMessage, client_key: clientKey });
  }
  // The sends still pending after this one stay below it (see there).
  next = liftPendingPlaceholders(next, serverMessage);
  if (next === slice.items) return slice;
  return { ...slice, items: next };
}

export interface BeginSendInput {
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  author_id: Snowflake;
  content: string;
  /**
   * The inline-reply reference, and the receiver-side snapshot the reply
   * context line renders. The placeholder carries both so it draws the SAME
   * row the server's will — a reply bar that only appeared at the ack moved
   * the row (and everything under it) by a line.
   */
  reply_to_id?: Snowflake | null;
  referenced?: ReferencedMessage | null;
  /** Already-uploaded attachment descriptors (the composer's finished chips). */
  attachments?: UploadedAttachment[];
}

export interface BeginSendResult {
  /** Client nonce — also the Idempotency-Key for the REST POST (U9). */
  nonce: string;
  /** Placeholder id the row carries until confirmation. */
  messageId: Snowflake;
}

export interface BeginSendOptions {
  /**
   * Reuse this nonce instead of minting one (lane D #22): a RETRY of a send
   * whose outcome is unknown (a failure, a timeout) must present the same
   * Idempotency-Key, or a POST that did land becomes a second message.
   */
  nonce?: string;
}

/** The placeholder's attachments: the uploaded descriptors, as rows render them. */
function placeholderAttachments(
  messageId: Snowflake,
  attachments: readonly UploadedAttachment[] | undefined,
): Attachment[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((a, i) => ({
    id: `${messageId}:${i}`,
    message_id: null,
    filename: a.filename,
    content_type: a.content_type,
    size: a.size,
    url: a.url,
    ...(typeof a.width === 'number' ? { width: a.width } : {}),
    ...(typeof a.height === 'number' ? { height: a.height } : {}),
  }));
}

/** Drop a row by id from a slice (the retry path re-inserts its placeholder). */
function withoutRow(slice: MessageSlice, id: Snowflake): MessageSlice {
  if (!slice.items.some((m) => m.id === id)) return slice;
  return { ...slice, items: slice.items.filter((m) => m.id !== id) };
}

/** Insert the optimistic row (channel pane or thread pane) and mark pending. */
export function beginOptimisticSend(
  store: StateStore,
  input: BeginSendInput,
  options: BeginSendOptions = {},
): BeginSendResult {
  const nonce = options.nonce ?? makeNonce();
  const messageId = makePlaceholderId(nonce);
  const attachments = placeholderAttachments(messageId, input.attachments);

  const message: Message = {
    id: messageId,
    channel_id: input.channel_id,
    thread_id: input.thread_id,
    author_id: input.author_id,
    content: input.content,
    created_at: nextPlaceholderTimestamp(),
    edited_at: null,
    ...(input.reply_to_id ? { reply_to_id: input.reply_to_id } : {}),
    ...(input.reply_to_id && input.referenced ? { referenced: input.referenced } : {}),
    ...(attachments ? { attachments } : {}),
    // Lane D #12: the stable list key the confirmed row inherits.
    client_key: nonce,
    send_state: 'pending',
  };

  store.setState((s) => {
    // A retry under the same nonce clears the failure it answers.
    const { [nonce]: _retried, ...failedByNonce } = s.failedByNonce;
    const pendingByNonce = {
      ...s.pendingByNonce,
      [nonce]: {
        messageId,
        channel_id: input.channel_id,
        thread_id: input.thread_id,
        content: input.content,
        status: 'pending' as const,
        ...(input.reply_to_id ? { reply_to_id: input.reply_to_id } : {}),
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      },
    };
    const nonceByMessageId = { ...s.nonceByMessageId, [messageId]: nonce };

    // A retry of a HELD failed row: the old row leaves in the same write the
    // pending one lands (at "now" — where the server row will sit), so the
    // send is never drawn twice nor missing for a frame.
    if (input.thread_id !== null) {
      const slice = withoutRow(s.messagesByThread[input.thread_id] ?? emptySlice(), messageId);
      return {
        pendingByNonce,
        nonceByMessageId,
        failedByNonce,
        messagesByThread: {
          ...s.messagesByThread,
          [input.thread_id]: insertIntoWindow(slice, message),
        },
      };
    }

    const slice = withoutRow(s.messagesByChannel[input.channel_id] ?? emptySlice(), messageId);
    return {
      pendingByNonce,
      nonceByMessageId,
      failedByNonce,
      messagesByChannel: {
        ...s.messagesByChannel,
        // The shared ordered insert places the placeholder by its
        // `created_at` (`messageSortKey`, lane D #12) — where the confirmed
        // row will sit — rather than pinning it to the head; the window's
        // ends are respected (`insertIntoWindow`, #9).
        [input.channel_id]: insertIntoWindow(slice, message),
      },
    };
  });

  return { nonce, messageId };
}

/**
 * REST 201 arrived: swap the placeholder row for the server record and drop
 * the pending marker. Unknown nonces are ignored (idempotent retries).
 */
export function confirmOptimisticSend(
  store: StateStore,
  nonce: string,
  serverMessage: Message,
): void {
  const state = store.getState();
  const pending = state.pendingByNonce[nonce];
  if (!pending) return;

  const placeholderId = pending.messageId;

  store.setState((s) => {
    const { [nonce]: _done, ...pendingByNonce } = s.pendingByNonce;
    const { [placeholderId]: _gone, ...nonceByMessageId } = s.nonceByMessageId;

    if (pending.thread_id !== null) {
      const slice = s.messagesByThread[pending.thread_id];
      if (!slice) return { pendingByNonce, nonceByMessageId };
      return {
        pendingByNonce,
        nonceByMessageId,
        messagesByThread: {
          ...s.messagesByThread,
          [pending.thread_id]: settleOptimisticRow(slice, placeholderId, serverMessage),
        },
      };
    }

    const slice = s.messagesByChannel[pending.channel_id];
    if (!slice) return { pendingByNonce, nonceByMessageId };

    // The gateway MessageCreate may land BEFORE this REST confirm — the real
    // id is then already in the slice, so the settle pass above removes the
    // placeholder and leaves exactly one server row (`settleOptimisticRow`).
    return {
      pendingByNonce,
      nonceByMessageId,
      messagesByChannel: {
        ...s.messagesByChannel,
        [pending.channel_id]: settleOptimisticRow(slice, placeholderId, serverMessage),
      },
    };
  });
}

/** REST failure: remove the optimistic row and surface the error. */
export function failOptimisticSend(
  store: StateStore,
  nonce: string,
  error: { key: string; code: number; message: string },
): void {
  const state = store.getState();
  const pending = state.pendingByNonce[nonce];
  if (!pending) return;

  store.setState((s) => {
    const { [nonce]: _failed, ...pendingByNonce } = s.pendingByNonce;
    const { [pending.messageId]: _gone, ...nonceByMessageId } = s.nonceByMessageId;
    const failedByNonce = {
      ...s.failedByNonce,
      [nonce]: failedRecord(pending, error),
    };

    if (pending.thread_id !== null) {
      const slice = s.messagesByThread[pending.thread_id];
      if (!slice) return { pendingByNonce, nonceByMessageId, failedByNonce };
      const items = slice.items.filter((m) => m.id !== pending.messageId);
      if (items.length > 0) {
        return {
          pendingByNonce,
          nonceByMessageId,
          failedByNonce,
          messagesByThread: {
            ...s.messagesByThread,
            [pending.thread_id]: { ...slice, items },
          },
        };
      }
      const { [pending.thread_id]: _removed, ...messagesByThread } = s.messagesByThread;
      return { pendingByNonce, nonceByMessageId, failedByNonce, messagesByThread };
    }

    const slice = s.messagesByChannel[pending.channel_id];
    if (!slice) return { pendingByNonce, nonceByMessageId, failedByNonce };
    const items = slice.items.filter((m) => m.id !== pending.messageId);
    if (items.length > 0) {
      return {
        pendingByNonce,
        nonceByMessageId,
        failedByNonce,
        messagesByChannel: {
          ...s.messagesByChannel,
          [pending.channel_id]: { ...slice, items },
        },
      };
    }
    const { [pending.channel_id]: _removed, ...messagesByChannel } = s.messagesByChannel;
    return { pendingByNonce, nonceByMessageId, failedByNonce, messagesByChannel };
  });
}

function failedRecord(
  pending: PendingSend,
  error: { key: string; code: number; message: string },
  held?: boolean,
): FailedSend {
  return {
    channel_id: pending.channel_id,
    thread_id: pending.thread_id,
    content: pending.content,
    error,
    failedAt: Date.now(),
    ...(pending.reply_to_id ? { reply_to_id: pending.reply_to_id } : {}),
    ...(pending.attachments && pending.attachments.length > 0
      ? { attachments: pending.attachments }
      : {}),
    ...(held ? { held: true } : {}),
  };
}

/** Where a held (not in flight) send's row stands — see `Message.send_state`. */
export type HeldSendState = 'failed' | 'unconfirmed' | 'waiting';

/**
 * True for a failure that says nothing about the MESSAGE — the request never
 * got an answer: a transport failure (offline, DNS, a dropped connection) or
 * a timeout. Such a send is re-sent on its own when the connection returns,
 * under its original nonce, which the server dedupes (a timed-out POST that
 * did land answers with the stored message instead of a second one).
 *
 * Everything else is the server's answer about this message — validation,
 * permission, an unverified account, a 5xx — and waits for the member's own
 * Retry: sending it again unasked would only repeat the refusal, or repeat a
 * request the server just failed on.
 */
export function isConnectionFailure(key: string): boolean {
  return key === 'network_error' || key === 'timeout';
}

/** The held rows of every conversation, with their failure records. */
function heldConnectionFailures(
  s: StateState,
): { nonce: string; failed: FailedSend; row: Message | undefined }[] {
  const out: { nonce: string; failed: FailedSend; row: Message | undefined }[] = [];
  for (const [nonce, failed] of Object.entries(s.failedByNonce)) {
    if (!failed.held || !isConnectionFailure(failed.error.key)) continue;
    const slice =
      failed.thread_id !== null ? s.messagesByThread[failed.thread_id] : s.messagesByChannel[failed.channel_id];
    const id = makePlaceholderId(nonce);
    out.push({ nonce, failed, row: slice?.items.find((m) => m.id === id) });
  }
  return out;
}

/**
 * The held sends a returning connection re-sends (`isConnectionFailure`), in
 * the order they were first drawn — oldest first, which is the order the
 * member typed them in every conversation. The caller re-sends them in this
 * order through the per-conversation send queue, so each conversation's
 * messages land in typed order. A held row whose row is gone (its
 * conversation was evicted) is skipped: there is nothing on screen to settle.
 */
export function heldSendsAwaitingConnection(store: StateStore): string[] {
  return heldConnectionFailures(store.getState())
    .filter((h) => h.row !== undefined)
    .sort((a, b) => {
      const at = a.row!.created_at;
      const bt = b.row!.created_at;
      if (at !== bt) return at < bt ? -1 : 1;
      return a.failed.failedAt - b.failed.failedAt;
    })
    .map((h) => h.nonce);
}

/**
 * The connection just went away: every held send that will go out on its
 * own when it returns (`isConnectionFailure`) says so — `waiting` instead of
 * "Failed" or "Not confirmed yet". A refusal from the server keeps its own
 * words. Writes nothing when there is nothing to re-mark.
 */
export function markHeldSendsWaiting(store: StateStore): void {
  const targets = heldConnectionFailures(store.getState()).filter(
    (h) => h.row !== undefined && h.row.send_state !== 'waiting',
  );
  if (targets.length === 0) return;
  store.setState((s) => {
    let messagesByChannel = s.messagesByChannel;
    let messagesByThread = s.messagesByThread;
    const wait = (m: Message): Message => ({ ...m, send_state: 'waiting' });
    for (const { nonce, failed } of targets) {
      const id = makePlaceholderId(nonce);
      if (failed.thread_id !== null) {
        const slice = mapRow(messagesByThread[failed.thread_id], id, wait);
        if (slice) messagesByThread = { ...messagesByThread, [failed.thread_id]: slice };
      } else {
        const slice = mapRow(messagesByChannel[failed.channel_id], id, wait);
        if (slice) messagesByChannel = { ...messagesByChannel, [failed.channel_id]: slice };
      }
    }
    return { messagesByChannel, messagesByThread };
  });
}

/** Map one row of a slice (by id); the slice is returned as-is on a miss. */
function mapRow(
  slice: MessageSlice | undefined,
  id: Snowflake,
  fn: (m: Message) => Message,
): MessageSlice | undefined {
  if (!slice) return slice;
  const at = slice.items.findIndex((m) => m.id === id);
  if (at < 0) return slice;
  const items = slice.items.slice();
  items[at] = fn(items[at]!);
  return { ...slice, items };
}

/**
 * A send that did not go through, KEPT in its timeline (the Discord model).
 *
 * `failOptimisticSend` removes the placeholder — the row vanishes and the
 * text has to live somewhere else (the composer, which then cannot be cleared
 * until the ack). Here the row stays exactly where it was drawn, marked
 * `failed` (the server refused it, or it never left) or `unconfirmed` (no
 * answer in time — a timeout may have landed), with the reason on the row.
 * The failure record keeps everything a retry needs — content, reply
 * reference, attachments — under the ORIGINAL nonce (`retryFailedSend`), and
 * `discardFailedSend` is the row's Delete.
 *
 * Returns false (and records nothing) when there is no row to hold: the
 * send's own gateway echo already replaced it, i.e. it landed.
 */
export function holdFailedSend(
  store: StateStore,
  nonce: string,
  error: { key: string; code: number; message: string },
  state: HeldSendState = 'failed',
): boolean {
  const current = store.getState();
  const pending = current.pendingByNonce[nonce];
  if (!pending) return false;
  const home =
    pending.thread_id !== null
      ? current.messagesByThread[pending.thread_id]
      : current.messagesByChannel[pending.channel_id];
  if (!home?.items.some((m) => m.id === pending.messageId)) {
    // The placeholder is already gone: the gateway echo of this very send
    // retired it (reconcile's shadowing), so the message DID land and a late
    // transport error (a timeout on a slow ack) is not a failure at all.
    store.setState((s) => {
      const { [nonce]: _landed, ...pendingByNonce } = s.pendingByNonce;
      const { [pending.messageId]: _id, ...nonceByMessageId } = s.nonceByMessageId;
      return { pendingByNonce, nonceByMessageId };
    });
    return false;
  }
  const mark = (m: Message): Message => ({
    ...m,
    send_state: state,
    send_error: { key: error.key, message: error.message },
  });
  store.setState((s) => {
    const { [nonce]: _failed, ...pendingByNonce } = s.pendingByNonce;
    const failedByNonce = { ...s.failedByNonce, [nonce]: failedRecord(pending, error, true) };
    if (pending.thread_id !== null) {
      const slice = mapRow(s.messagesByThread[pending.thread_id], pending.messageId, mark);
      if (!slice) return { pendingByNonce, failedByNonce };
      return {
        pendingByNonce,
        failedByNonce,
        messagesByThread: { ...s.messagesByThread, [pending.thread_id]: slice },
      };
    }
    const slice = mapRow(s.messagesByChannel[pending.channel_id], pending.messageId, mark);
    if (!slice) return { pendingByNonce, failedByNonce };
    return {
      pendingByNonce,
      failedByNonce,
      messagesByChannel: { ...s.messagesByChannel, [pending.channel_id]: slice },
    };
  });
  return true;
}

/**
 * The failed row's Delete: forget the send — its failure record, its nonce
 * mapping and its row. Nothing was confirmed, so nothing server-side is
 * touched. Unknown nonces are ignored.
 */
export function discardFailedSend(store: StateStore, nonce: string): void {
  const failed = store.getState().failedByNonce[nonce];
  if (!failed) return;
  const messageId = makePlaceholderId(nonce);
  store.setState((s) => {
    const { [nonce]: _gone, ...failedByNonce } = s.failedByNonce;
    const { [messageId]: _id, ...nonceByMessageId } = s.nonceByMessageId;
    if (failed.thread_id !== null) {
      const slice = s.messagesByThread[failed.thread_id];
      if (!slice) return { failedByNonce, nonceByMessageId };
      return {
        failedByNonce,
        nonceByMessageId,
        messagesByThread: { ...s.messagesByThread, [failed.thread_id]: withoutRow(slice, messageId) },
      };
    }
    const slice = s.messagesByChannel[failed.channel_id];
    if (!slice) return { failedByNonce, nonceByMessageId };
    return {
      failedByNonce,
      nonceByMessageId,
      messagesByChannel: {
        ...s.messagesByChannel,
        [failed.channel_id]: withoutRow(slice, messageId),
      },
    };
  });
}

/**
 * Re-queue a failed send as an optimistic row under its ORIGINAL nonce
 * (lane D #22). A failure is not proof the POST never landed — a timeout, a
 * dropped response, a 5xx after the write — so the retry must present the same
 * Idempotency-Key; the server then answers with the message it already stored
 * instead of creating a second one. (It used to mint a fresh nonce.)
 */
export function retryFailedSend(store: StateStore, nonce: string): BeginSendResult {
  const failed = store.getState().failedByNonce[nonce];
  if (!failed) {
    throw new Error(`retryFailedSend: unknown failed nonce ${nonce}`);
  }
  // beginOptimisticSend clears the failure in the same write it re-inserts
  // the row, so a subscriber never sees the send in neither state.
  return beginOptimisticSend(
    store,
    {
      channel_id: failed.channel_id,
      thread_id: failed.thread_id,
      author_id: failedAuthorId(store, failed.channel_id, failed.thread_id),
      content: failed.content,
      ...(failed.reply_to_id ? { reply_to_id: failed.reply_to_id } : {}),
      // The held row's reply snapshot rides into the retried one.
      ...(failed.reply_to_id ? { referenced: heldReferenced(store, failed, nonce) } : {}),
      ...(failed.attachments ? { attachments: failed.attachments } : {}),
    },
    { nonce },
  );
}

function heldReferenced(
  store: StateStore,
  failed: FailedSend,
  nonce: string,
): ReferencedMessage | null {
  const id = makePlaceholderId(nonce);
  const s = store.getState();
  const slice =
    failed.thread_id !== null ? s.messagesByThread[failed.thread_id] : s.messagesByChannel[failed.channel_id];
  return slice?.items.find((m) => m.id === id)?.referenced ?? null;
}

function failedAuthorId(store: StateStore, _channelId: string, _threadId: string | null): Snowflake {
  const me = store.getState().currentUser;
  return me?.id ?? '0';
}

/** Look up the nonce behind a message row (undefined for non-optimistic rows). */
export function getNonce(store: StateStore, messageId: Snowflake): string | undefined {
  return store.getState().nonceByMessageId[messageId];
}
