/**
 * @cytale/web — message state hook (U21 slice 1).
 *
 * Owns the message write path: optimistic send via the U17 store, edit/delete
 * via the api-client, and local reconcile of the store on each mutation.
 * Reads the channel's message list from the store (U17 messagesByChannel).
 *
 * The store is injectable for tests; the app uses the module default
 * (`defaultStore`). Synthetic reconcile events carry a monotonically
 * increasing seq so the store's replay gate never drops them.
 */

import { useCallback, useMemo, useState } from 'react';

import { ApiError, type ReactionSummary, type UploadedAttachment } from '@cytale/api-client';
import type { Message, ReferencedMessage, Thread } from '@cytale/domain';
import {
  defaultStore,
  beginOptimisticSend,
  confirmOptimisticSend,
  discardFailedSend,
  holdFailedSend,
  retryFailedSend,
  isConnectionFailure,
  applyGatewayEvent,
  nextSyntheticSeq,
  promoteDraftThread,
  isDraftThreadKey,
  type HeldSendState,
  type StateState,
  type StateStore,
} from '@cytale/state';

import { isOnline } from '../../app/pwa/useOnlineStatus.js';
import { useStoreSelector } from '../../app/useStoreSelector.js';
import { api } from '../auth/session.js';
import {
  applyReactionAdd,
  applyReactionRemove,
  clearPendingOwnToggle,
  markPendingOwnToggle,
} from './reactions.js';
import { ALL_SCOPES, enqueueSend, pauseSends, sendScope, waitForSendWindow } from './sendQueue.js';
import type { MessageWithBots } from './types.js';

/** Local reconcile seq — always above the store's lastSeq (replay gate). */
function nextSeq(): number {
  return nextSyntheticSeq();
}

function toErrorShape(err: unknown): { key: string; code: number; message: string } {
  if (err instanceof ApiError) {
    return { key: err.key, code: err.code, message: err.message };
  }
  if (err instanceof Error) {
    return { key: 'UNKNOWN', code: 0, message: err.message };
  }
  return { key: 'UNKNOWN', code: 0, message: String(err) };
}

/**
 * How long a send waits for the server before it is reported as timed out
 * (lane D #22). A timeout is NOT "not sent" — the POST may have landed — so
 * the failure carries the nonce (`SendFailure.sendNonce`) and a retry presents
 * it again: the server's idempotency record then answers with the stored
 * message instead of creating a second one.
 */
export const SEND_TIMEOUT_MS = 20_000;

/** Options for one send. */
export interface SendOptions {
  /**
   * Reuse this nonce / Idempotency-Key — a RETRY of a send whose outcome is
   * unknown. Omitted = a fresh send with a fresh key.
   */
  nonce?: string;
  /**
   * The endpoint the POST rides. `channel` (default) is
   * `POST /channels/{c}/messages` — carrying `thread_id` when there is one;
   * `thread` is `POST /threads/{t}/messages`, the thread composer's endpoint
   * (it also follows the thread and moves its reply count server-side).
   * `thread-create` is a DRAFT thread's first reply (`threadId` is the
   * draft's client key, `registerDraftThread`): the thread is created first,
   * the draft's window promoted to it, then the reply rides `thread`.
   */
  route?: SendRoute;
}

/** See `SendOptions.route`. */
export type SendRoute = 'channel' | 'thread' | 'thread-create';

/**
 * A draft thread a `thread-create` send creates (2026-10-01): where it hangs,
 * what it is called, and who to tell once it exists. Registered by the
 * thread composer under the draft's client key (`draftThreadKey`) and kept
 * for the session, so a failed create's Retry — the row's, or the reconnect
 * auto-retry — can run the create again after the panel has closed.
 */
export interface DraftThreadSpec {
  channelId: string;
  parentMessageId: string;
  name: string;
  /** Told with the created thread (the host promotes its open draft). */
  onCreated?: (thread: Thread) => void;
}

const draftThreads = new Map<string, DraftThreadSpec>();
/** Draft key → the thread its create made (a later queued send skips the create). */
const createdByDraft = new Map<string, string>();
/** `thread-create` sends not yet settled, per draft key. */
const draftSendsInFlight = new Map<string, number>();
/** Created thread → the draft key it was made from: its sends share the draft's queue. */
const draftByCreated = new Map<string, string>();

/** Register (or refresh) the draft thread `key` creates on its first send. */
export function registerDraftThread(key: string, spec: DraftThreadSpec): void {
  draftThreads.set(key, spec);
}

/** The thread a draft already created, if it has (null while it is still a draft). */
export function createdThreadFor(key: string): string | null {
  return createdByDraft.get(key) ?? null;
}

/**
 * The queue a send waits in. A promoted draft's thread keeps the DRAFT's
 * queue: a reply typed while the creating send was in flight was queued
 * there, and a reply sent after the promotion must not overtake it.
 */
function queueScope(channelId: string, threadId: string | null): string {
  const draft = threadId ? draftByCreated.get(threadId) : undefined;
  return sendScope(channelId, draft ?? threadId);
}

/**
 * Turn a draft into its thread (once): POST the create, then promote the
 * draft's window and its send records to the server id in one store write
 * (`promoteDraftThread` — the open list keeps its rows and its mount), and
 * tell the host. A second send queued behind the first finds it done.
 */
async function ensureDraftCreated(store: StateStore, key: string): Promise<string> {
  const done = createdByDraft.get(key);
  if (done !== undefined) {
    // A send that was queued (or failed and retried) under the draft key
    // after the draft was promoted: re-aim its records too.
    promoteDraftThread(store, key, done);
    return done;
  }
  const spec = draftThreads.get(key);
  if (!spec) throw new Error('This thread could not be started — its message is missing.');
  const created = await api.startThread(spec.channelId, spec.parentMessageId, spec.name);
  createdByDraft.set(key, created.id);
  draftByCreated.set(created.id, key);
  // The host's switch and the store's promotion land in the same task, so
  // React renders them together: the list never sees the draft's window gone
  // before its thread id arrives.
  promoteDraftThread(store, key, created);
  spec.onCreated?.(created);
  return created.id;
}

/** The error a failed send rejects with: the transport/server error, plus the key it used. */
export type SendFailure = Error & { sendNonce?: string };

/**
 * Find a message row by id in a channel's window OR in one of its threads'
 * windows (#15 — the thread panel's rows run the same edit/delete/reaction
 * effects as the channel's). Thread slices are scanned only on a channel miss.
 */
export function findMessageRow(
  state: StateState,
  channelId: string,
  messageId: string,
): Message | undefined {
  const inChannel = state.messagesByChannel[channelId]?.items.find((m) => m.id === messageId);
  if (inChannel) return inChannel;
  for (const slice of Object.values(state.messagesByThread)) {
    const hit = slice?.items.find((m) => m.id === messageId);
    if (hit && (hit.channel_id === channelId || hit.channel_id === '')) return hit;
  }
  return undefined;
}

export interface UseMessages {
  /** Newest-first messages of a channel (empty when none loaded). */
  messages(channelId: string): Message[];
  /** Optimistic send: placeholder row → REST 201 → nonce replaced. The
   * replyToId carries the Discord-style inline-reply reference. The trailing
   * `attachments` binds previously-uploaded attachment metadata (the
   * composer's staged chips) into the create body; absent/empty = text-only. */
  send(
    channelId: string,
    content: string,
    threadId?: string | null,
    replyToId?: string | null,
    attachments?: UploadedAttachment[],
    options?: SendOptions,
  ): Promise<void>;
  /** Edit a message and reconcile the store. */
  edit(channelId: string, messageId: string, content: string): Promise<void>;
  /** Delete a message and reconcile the store. */
  remove(channelId: string, messageId: string): Promise<void>;
  /**
   * Optimistic own-reaction toggle (Discord model): chip NOT mine → add via
   * PUT @me; mine → remove via DELETE @me. The store updates immediately and
   * rolls back on failure; the error is recorded on `reactionError` for the
   * inline retry affordance (4xx — too-many-emojis 400, 403 — stays stable).
   */
  toggleReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /** Last reaction failure for the inline affordance; null when none. */
  reactionError(): ReactionError | null;
  /** Clear the recorded reaction error (dismiss affordance). */
  clearReactionError(): void;
  /** Current user's snowflake id, or null when signed out. */
  currentUserId(): string | null;
}

/** A failed reaction toggle, surfaced inline with retry/dismiss. */
export interface ReactionError {
  channelId: string;
  messageId: string;
  emoji: string;
  key: string;
  code: number;
  message: string;
}

/**
 * How a send that did not go through is held (send reliability B2).
 *
 *  - The browser is OFFLINE and the request never got an answer (a transport
 *    failure or a timeout): `waiting` — it goes out on its own, same nonce,
 *    when the connection returns (`sendAutoRetry.ts`).
 *  - A timeout while online is UNKNOWN, not failed (lane D #22): the POST may
 *    have landed. It is re-sent on the next reconnect too, and Retry is safe.
 *  - Everything else is a failure; a server refusal (4xx) is never re-sent
 *    unasked.
 */
function heldStateFor(key: string): HeldSendState {
  if (isConnectionFailure(key) && !isOnline()) return 'waiting';
  return key === 'timeout' ? 'unconfirmed' : 'failed';
}

/** The reply-context snapshot the server will attach (`reference_snapshot`). */
function referencedSnapshot(
  state: StateState,
  channelId: string,
  replyToId: string,
): ReferencedMessage | null {
  const original = findMessageRow(state, channelId, replyToId);
  if (!original) return null;
  const member = state.membersById[original.author_id];
  const self = state.currentUser?.id === original.author_id ? state.currentUser.username : undefined;
  return {
    message_id: original.id,
    author_id: original.author_id,
    author_username: member?.username ?? self ?? null,
    // The server keeps the first 80 characters (graphemes; code points here).
    content: Array.from(original.content ?? '').slice(0, 80).join(''),
  };
}

/** Where each in-flight or failed send's POST goes, for its retry. */
const routeByNonce = new Map<string, SendRoute>();

/**
 * Post an optimistic row that is ALREADY in the store (`nonce`), in queue
 * order, and settle it: confirmed → the server row replaces it in place;
 * over the send budget (429) → the queue waits out Retry-After and posts the
 * SAME nonce again, the row pending throughout (up to the cap below);
 * failed → the row is HELD, marked, with Retry/Delete (`holdFailedSend`).
 * Rejects with the transport/server error (plus `sendNonce`) on failure.
 */
function postQueued(
  store: StateStore,
  nonce: string,
  input: {
    channelId: string;
    threadId: string | null;
    content: string;
    replyToId: string | null;
    attachments: UploadedAttachment[];
    route: SendRoute;
  },
): Promise<void> {
  routeByNonce.set(nonce, input.route);
  const scope = queueScope(input.channelId, input.threadId);
  // Mutable: a `thread-create` send becomes a `thread` send once it created
  // its thread, and a 429 retry of it must not create a second one.
  input = { ...input };
  const draftKey =
    input.route === 'thread-create' && isDraftThreadKey(input.threadId) ? input.threadId : null;
  if (draftKey !== null) {
    draftSendsInFlight.set(draftKey, (draftSendsInFlight.get(draftKey) ?? 0) + 1);
  }
  const sent = enqueueSend(store, scope, async () => {
    let rateLimited = 0;
    let waitedMs = 0;
    for (;;) {
      await waitForSendWindow(store, scope);
      if (rateLimited > 0 && !store.getState().pendingByNonce[nonce]) {
        // The row went away while it waited out a 429 (signed out, store
        // reset): there is nothing left to send it for.
        routeByNonce.delete(nonce);
        return;
      }
      try {
        await postOnce(store, nonce, input);
        return;
      } catch (err) {
        const pause = rateLimitPause(err, rateLimited, waitedMs);
        if (pause === null) {
          const shape = toErrorShape(err);
          if (!holdFailedSend(store, nonce, shape, heldStateFor(shape.key))) {
            // The echo already landed this send: the late error is moot.
            routeByNonce.delete(nonce);
            return;
          }
          // The key rides the failure so the caller's retry can present it again.
          if (err instanceof Error) (err as SendFailure).sendNonce = nonce;
          throw err;
        }
        // Over the send budget: the row stays pending ("Sending…"), this
        // conversation's queue — or every conversation's, for the shared
        // budget — holds for the server's Retry-After, and the SAME nonce
        // goes again. Nothing behind it overtakes it: it still holds its
        // queue's turn.
        rateLimited += 1;
        waitedMs += pause.ms;
        pauseSends(store, pause.everyConversation ? ALL_SCOPES : scope, pause.ms);
      }
    }
  });
  if (draftKey === null) return sent;
  return sent.finally(() => {
    // The last send aimed at the draft has settled: forget which thread it
    // made, so a draft opened on the same message later (that thread deleted)
    // creates a new one instead of posting into a thread that is gone.
    const left = (draftSendsInFlight.get(draftKey) ?? 1) - 1;
    if (left > 0) {
      draftSendsInFlight.set(draftKey, left);
      return;
    }
    draftSendsInFlight.delete(draftKey);
    createdByDraft.delete(draftKey);
  });
}

/**
 * The send budget's retry cap (2026-09-28). A 429 is waited out, not shown:
 * the server's budget is 10 sends / 5 s per conversation and 20 / 5 s
 * overall, so a send that meets it normally goes on its next try, at most a
 * few seconds later — a 25-message offline backlog into one conversation
 * meets the limit twice and each of its sends at most once. A send gives up
 * (and becomes a failed row with its manual Retry) only when the server keeps
 * refusing it: after `SEND_RATE_LIMIT_MAX_RETRIES` 429s in a row, or when
 * waiting any longer would put its total wait past
 * `SEND_RATE_LIMIT_MAX_WAIT_MS` — one minute of "Sending…" is the longest a
 * message may look like it is on its way before the member is told and
 * handed the decision. Six refusals is several full budget windows of
 * contention, far past a burst or a backlog; only a stuck or much stricter
 * limit (a per-IP ceiling shared with others) reaches it.
 */
export const SEND_RATE_LIMIT_MAX_RETRIES = 6;
export const SEND_RATE_LIMIT_MAX_WAIT_MS = 60_000;
/** A 429 with no usable hint waits 1 s, 2 s, 4 s, then 5 s per try. */
const RATE_LIMIT_FALLBACK_MS = [1_000, 2_000, 4_000, 5_000];
/** Never re-send sooner than this, whatever the hint says. */
const RATE_LIMIT_MIN_WAIT_MS = 250;

/**
 * How long to hold before re-sending after `err`, and which queue(s) to
 * hold — or null when `err` is not a 429 or the send has used its budget of
 * retries. The server names the limit that tripped as data
 * (`ApiError.rateLimitScope`, docs/protocol/rest.md): `conversation` is the
 * per-conversation send limit, so only this conversation holds; anything else
 * — the sender's budget across conversations, the account or per-IP limits,
 * a scope this client does not know, or none at all — may cover every send,
 * so every conversation of the store holds.
 */
function rateLimitPause(
  err: unknown,
  retriesSoFar: number,
  waitedMs: number,
): { ms: number; everyConversation: boolean } | null {
  if (!(err instanceof ApiError) || err.status !== 429) return null;
  if (retriesSoFar >= SEND_RATE_LIMIT_MAX_RETRIES) return null;
  const fallback = RATE_LIMIT_FALLBACK_MS[Math.min(retriesSoFar, RATE_LIMIT_FALLBACK_MS.length - 1)]!;
  const ms = Math.max(RATE_LIMIT_MIN_WAIT_MS, err.retryAfterMs ?? fallback);
  if (waitedMs + ms > SEND_RATE_LIMIT_MAX_WAIT_MS) return null;
  return { ms, everyConversation: err.rateLimitScope !== 'conversation' };
}

/**
 * One POST of a queued send; on success the server row replaces the
 * placeholder. A failure is thrown as-is — `postQueued` decides whether it is
 * waited out (a 429) or held on the row.
 */
async function postOnce(
  store: StateStore,
  nonce: string,
  input: {
    channelId: string;
    threadId: string | null;
    content: string;
    replyToId: string | null;
    attachments: UploadedAttachment[];
    route: SendRoute;
  },
): Promise<void> {
  if (input.route === 'thread-create') {
    // The create is the first half of this send; on success the rest of it
    // (and any 429 retry of it) is an ordinary thread reply. A send whose
    // draft another send already promoted (its failed row moved with the
    // window, then was retried) is aimed at the thread already.
    const created = isDraftThreadKey(input.threadId)
      ? await ensureDraftCreated(store, input.threadId!)
      : input.threadId;
    input.threadId = created;
    input.route = 'thread';
    routeByNonce.set(nonce, 'thread');
  }
  const { channelId, threadId, content, replyToId, attachments, route } = input;
  const body = {
    content,
    ...(replyToId ? { reply_to_id: replyToId } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  let serverMessage: Message;
  if (route === 'thread' && threadId) {
    serverMessage = {
      ...(await api.sendThreadMessage(threadId, body, nonce, { timeoutMs: SEND_TIMEOUT_MS })),
      thread_id: threadId,
    };
  } else {
    serverMessage = await api.sendMessage(
      channelId,
      {
        ...body,
        nonce,
        // A thread send must say so on the wire: the optimistic row went
        // into the thread slice, so the POST has to land there too.
        ...(threadId ? { thread_id: threadId } : {}),
      },
      nonce,
      { timeoutMs: SEND_TIMEOUT_MS },
    );
  }
  confirmOptimisticSend(store, nonce, serverMessage);
  if (route === 'thread' && threadId) {
    // The thread's summary (reply count, latest reply) moves on the
    // ThreadMessageCreate reducer (#106); the row is already settled, so
    // the upsert is a no-op and the gateway's own echo stays one too.
    applyGatewayEvent(store, {
      op: 0,
      t: 'ThreadMessageCreate',
      s: nextSyntheticSeq(),
      d: serverMessage as never,
    });
  }
  routeByNonce.delete(nonce);
}

/**
 * The optimistic send path, as a plain factory (no hooks).
 *
 * Split out of `useMessages` so a consumer that needs ONLY `send` can hold
 * one stable function without subscribing to the store — see
 * `useMessageSender`. It reads the store through `getState()` at CALL time.
 *
 * The placeholder row is inserted SYNCHRONOUSLY, before this function's first
 * await — the caller has already cleared its composer, and the row is on
 * screen by the next frame. The POST then waits its turn in the
 * conversation's send queue (`sendQueue.ts`), so a burst goes out in order.
 */
function makeSend(store: StateStore): UseMessages['send'] {
  return async (
    channelId: string,
    content: string,
    threadId: string | null = null,
    replyToId: string | null = null,
    attachments: UploadedAttachment[] = [],
    options: SendOptions = {},
  ) => {
    const state = store.getState();
    const me = state.currentUser;
    if (!me) {
      throw new ApiError({ key: 'UNAUTHENTICATED', code: 40101, message: 'Not signed in' });
    }
    const { nonce } = beginOptimisticSend(
      store,
      {
        channel_id: channelId,
        thread_id: threadId,
        author_id: me.id,
        content,
        ...(replyToId
          ? { reply_to_id: replyToId, referenced: referencedSnapshot(state, channelId, replyToId) }
          : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      },
      options.nonce !== undefined ? { nonce: options.nonce } : {},
    );
    await postQueued(store, nonce, {
      channelId,
      threadId,
      content,
      replyToId,
      attachments,
      route: options.route ?? 'channel',
    });
  };
}

/**
 * The failed row's Retry: the SAME nonce (the Idempotency-Key — a send whose
 * outcome was unknown must never land twice), the same content, reply
 * reference and attachments, through the same endpoint, behind whatever the
 * conversation already has in flight. The row turns pending again at the
 * bottom (where the confirmed message will sit).
 */
export function retrySend(store: StateStore, nonce: string): Promise<void> {
  const failed = store.getState().failedByNonce[nonce];
  if (!failed) return Promise.resolve();
  retryFailedSend(store, nonce);
  return postQueued(store, nonce, {
    channelId: failed.channel_id,
    threadId: failed.thread_id,
    content: failed.content,
    replyToId: failed.reply_to_id ?? null,
    attachments: failed.attachments ?? [],
    route: routeByNonce.get(nonce) ?? 'channel',
  });
}

/** The failed row's Delete: the row and its record go; nothing was sent. */
export function discardSend(store: StateStore, nonce: string): void {
  discardFailedSend(store, nonce);
  routeByNonce.delete(nonce);
}

/**
 * `send` alone, with NO store subscription.
 *
 * MessageCompose's fallback used to be `useMessages()`, whose whole-store
 * `useSyncExternalStore` re-rendered the always-mounted Lexical composer on
 * every gateway event — while the only thing the composer ever reads is
 * `send` (the pane and the thread panel always pass their own `messages`
 * hook). This is the honest shape of that dependency: one stable function,
 * which reads the store when it is called.
 */
export function useMessageSender(store: StateStore = defaultStore): { send: UseMessages['send'] } {
  return useMemo(() => ({ send: makeSend(store) }), [store]);
}

export function useMessages(store: StateStore = defaultStore): UseMessages {
  /**
   * The ONE reactive read in this hook (#137, app-level finding 6).
   *
   * `messages(channelId)` is the only member that reads a snapshot; every
   * other member (`send`/`edit`/`remove`/`toggleReaction`/`currentUserId`)
   * resolves the store with `getState()` when it is CALLED. The subscription
   * used to take the whole `getState()` object anyway, so `MessagePane` — its
   * only in-app caller — re-rendered on every store write in the app:
   * presence, typing, unread acks, call events, reconcile bookkeeping.
   * Selecting the one slice this hook reads keeps message reactivity exactly
   * as it was (a new message still re-identifies this record, so the pane
   * still re-renders and its read-ack still fires) and drops the rest.
   */
  const messagesByChannel = useStoreSelector(store, (s) => s.messagesByChannel);
  /** Last reaction-toggle failure (inline retry affordance; one at a time). */
  const [reactionError, setReactionError] = useState<ReactionError | null>(null);

  const messages = useCallback(
    (channelId: string): Message[] => messagesByChannel[channelId]?.items ?? [],
    [messagesByChannel],
  );

  // Shares `useMessageSender` rather than re-deriving the same factory call
  // declared ~30 lines above it: both build `makeSend(store)` and nothing else.
  const { send } = useMessageSender(store);

  /**
   * Optimistic edit (2026-09-10 decision): apply the new content to the row
   * immediately, converge on the server echo, and ROLL BACK to the prior
   * content when the write fails — the editor stays open and surfaces the
   * error with Retry (InlineMessageEditor owns that surface).
   */
  const edit = useCallback(
    async (channelId: string, messageId: string, content: string) => {
      // A thread reply lives in its thread's slice, not the channel's (#15):
      // the lookup covers both, and `thread_id` routes the update.
      const before = findMessageRow(store.getState(), channelId, messageId);

      const apply = (next: string, editedAt: string | null): void => {
        applyGatewayEvent(store, {
          op: 0,
          t: 'MessageUpdate',
          s: nextSeq(),
          d: {
            id: messageId,
            channel_id: channelId,
            thread_id: before?.thread_id ?? null,
            content: next,
            edited_at: editedAt,
          },
        });
      };

      apply(content, new Date().toISOString());
      try {
        const updated = await api.editMessage(channelId, messageId, { content });
        apply(updated.content, updated.edited_at);
      } catch (err) {
        // Roll back to the exact prior state (including its edited_at).
        if (before) apply(before.content, before.edited_at ?? null);
        throw err;
      }
    },
    [store],
  );

  const remove = useCallback(
    async (channelId: string, messageId: string) => {
      await api.deleteMessage(channelId, messageId);
      const msg = findMessageRow(store.getState(), channelId, messageId);
      applyGatewayEvent(store, {
        op: 0,
        t: 'MessageDelete',
        s: nextSeq(),
        d: { id: messageId, channel_id: channelId, thread_id: msg?.thread_id ?? null },
      });
    },
    [store],
  );

  const currentUserId = useCallback(() => store.getState().currentUser?.id ?? null, [store]);

  const toggleReaction = useCallback(
    async (channelId: string, messageId: string, emoji: string) => {
      const me = store.getState().currentUser;
      if (!me) {
        const err = new ApiError({ key: 'UNAUTHENTICATED', code: 40101, message: 'Not signed in' });
        setReactionError({ channelId, messageId, emoji, ...toErrorShape(err) });
        throw err;
      }
      // Placeholder rows never carry reactions (the confirmed server row is
      // what becomes reactable).
      if (messageId.startsWith('pending_')) return;

      const row = findMessageRow(store.getState(), channelId, messageId) as
        | MessageWithBots
        | undefined;
      const mine =
        row?.reactions?.some((r: ReactionSummary) => r.emoji === emoji && r.me) === true;

      const payload = { channel_id: channelId, message_id: messageId, user_id: me.id, emoji };
      // Register before the optimistic apply so a racing own echo is deduped.
      const pending = markPendingOwnToggle(messageId, emoji, mine ? 'remove' : 'add');
      const rollback = (): void => {
        clearPendingOwnToggle(messageId, emoji, pending);
        if (mine) applyReactionAdd(store, payload);
        else applyReactionRemove(store, payload);
      };

      try {
        if (mine) {
          applyReactionRemove(store, payload);
          await api.removeReaction(channelId, messageId, emoji);
        } else {
          applyReactionAdd(store, payload);
          await api.addReaction(channelId, messageId, emoji);
        }
        setReactionError(null);
      } catch (err) {
        rollback();
        setReactionError({ channelId, messageId, emoji, ...toErrorShape(err) });
        throw err;
      }
    },
    [store],
  );

  const readReactionError = useCallback(() => reactionError, [reactionError]);
  const clearReactionError = useCallback(() => setReactionError(null), []);

  // Referentially stable (lane D #17): the object is a prop of the memoized
  // composer, so a fresh literal per render defeated the memo.
  return useMemo(
    () => ({
      messages,
      send,
      edit,
      remove,
      toggleReaction,
      reactionError: readReactionError,
      clearReactionError,
      currentUserId,
    }),
    [messages, send, edit, remove, toggleReaction, readReactionError, clearReactionError, currentUserId],
  );
}
