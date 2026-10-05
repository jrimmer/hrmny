/**
 * @cytale/tui — the send path (U8; R20, R21; KTD5, KTD8).
 *
 * One job: turn "the member pressed Enter with this text, for this target"
 * into a message the server has, using the SAME machinery every other client
 * uses — `@cytale/state`'s optimistic send for the row and `@cytale/api-client`
 * for the write. There is no second reconciliation here and no local message
 * cache: the optimistic row goes into the shared store through
 * `beginOptimisticSend`, the REST 201 settles it through
 * `confirmOptimisticSend`, and a failure retires it through
 * `failOptimisticSend` (which also records the failure for the store's own
 * consumers). The gateway's echo of the same message is folded by
 * `reconcile.ts`, which is what makes "no duplicate on send" structural rather
 * than a rule this file has to remember: the placeholder is client-local, and
 * the settle pass keeps exactly one server row whether the echo or the 201
 * arrives first.
 *
 * ---------------------------------------------------------------------------
 * What the draft check refuses, and why it is local
 * ---------------------------------------------------------------------------
 *
 * The server accepts `content` between 1 and 4000 BYTES
 * (`CytaleWeb.MessageController.create/2`). A 4,001-byte message is refused
 * here, before a request is made, because the REST round trip cannot improve
 * the answer and the member would otherwise watch a rejected send for a reason
 * they could have been told immediately. The unit is BYTES, not characters:
 * a message of CJK text is three bytes per glyph.
 *
 * Empty is a refusal too, but a QUIET one (`refusal: 'empty'`): pressing Enter
 * on an empty composer is not an error, it is a keystroke that does nothing.
 * The distinction lives in the refusal, and the shell renders only the loud
 * ones — which is why "an empty composer does not send" and "a rejected send
 * keeps the text" are two different behaviors rather than one.
 *
 * ---------------------------------------------------------------------------
 * Failure is a value, never a throw
 * ---------------------------------------------------------------------------
 *
 * Every outcome comes back as a `SendResult`: a rejected send must not
 * silently drop the member's text, and a `Promise` that rejects is exactly how
 * a caller ends up with nothing to render and a cleared composer. The shell
 * keeps the text and renders `reason`, which is made INERT here
 * (`describeCause` sanitizes; a transport message can carry a server string,
 * R26a) and turned into the one line the composer shows.
 *
 * ---------------------------------------------------------------------------
 * The token the request carries (KTD8)
 * ---------------------------------------------------------------------------
 *
 * This module never touches a token. `api` is the session's own api-client,
 * whose `Http` layer asks the session's token source for the current value on
 * every request — so a renewal the host pushed down the descriptor is used by
 * the next send with nothing to invalidate and no cached credential to go
 * stale. An access-only session answers a 401 by moving to `expired` and
 * expecting the next renewal (`@cytale/session`'s header), so a rejection with
 * that cause is reported as retryable rather than as a dead end.
 */
import { ApiError, type CytaleApiClient } from '@cytale/api-client';
import type { Message } from '@cytale/domain';
import {
  beginOptimisticSend,
  confirmOptimisticSend,
  failOptimisticSend,
  type StateStore,
} from '@cytale/state';

import type { ContentTarget } from '../columns/ContentColumn.js';
import { inertText } from '../columns/layout.js';
import { describeCause } from '../format/rows.js';

/** The server's body limit, in bytes (`content must be 1-4000 bytes`). */
export const MAX_MESSAGE_BYTES = 4000;

/** Why a draft was not sent. `empty` is the quiet one. */
export type DraftRefusal = 'empty' | 'too-long' | 'no-target' | 'no-author';

export interface DraftCheck {
  readonly ok: boolean;
  /** The text to send, trimmed of surrounding whitespace when `ok`. */
  readonly text: string;
  readonly refusal: DraftRefusal | null;
  /** The member-facing reason, inert and complete on its own. Empty when `ok`. */
  readonly reason: string;
}

/** UTF-8 bytes, the unit the server's limit is stated in. */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** What the shell knows about the destination when the member presses Enter. */
export interface DraftContext {
  /** The resolved target's channel; '' when column one has nothing selected. */
  readonly channelId: string;
  /** The signed-in member's id; null when the session has no identity yet. */
  readonly authorId: string | null;
}

/**
 * Check a draft against the server's rules before a request is made. The text
 * is TRIMMED of surrounding whitespace (a trailing newline from Shift+Enter is
 * not content), so `text` is what the caller should send.
 */
export function checkDraft(text: string, context: DraftContext): DraftCheck {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, text: '', refusal: 'empty', reason: 'Nothing to send yet.' };
  }
  if (context.channelId === '') {
    return {
      ok: false,
      text: trimmed,
      refusal: 'no-target',
      reason: 'No conversation is selected, so there is nowhere to send this.',
    };
  }
  if (context.authorId === null) {
    return {
      ok: false,
      text: trimmed,
      refusal: 'no-author',
      reason: 'This session has no signed-in member to send as.',
    };
  }
  const bytes = utf8Bytes(trimmed);
  if (bytes > MAX_MESSAGE_BYTES) {
    return {
      ok: false,
      text: trimmed,
      refusal: 'too-long',
      reason:
        `That message is ${bytes} bytes, over Hrmny's ${MAX_MESSAGE_BYTES}-byte limit. ` +
        'Shorten it and press Enter again.',
    };
  }
  return { ok: true, text: trimmed, refusal: null, reason: '' };
}

/** The line the composer shows for a draft refused before any request. */
export function refusalLine(reason: string): string {
  return `✖ ${inertText(reason, 'That message was not sent.')}`;
}

/**
 * The line the composer shows for a send the server (or the transport)
 * refused. The text is still in the composer, so the way out is Enter.
 */
export function sendFailureLine(reason: string): string {
  const cause = inertText(reason, 'the send did not complete');
  return `✖ Could not send: ${cause} — the message is still here; Enter tries again.`;
}

/**
 * The outcome of a send. A rejected send is a VALUE: the caller renders
 * `reason` and keeps the text, which is what makes "a rejected send must not
 * silently drop the text" a property of the shape rather than of a caller's
 * discipline.
 */
export type SendResult =
  | { readonly ok: true; readonly message?: Message }
  | { readonly ok: false; readonly reason: string };

/** The host's send seam: the resolved target, the text, and what happened. */
export type Sender = (target: ContentTarget, text: string) => Promise<SendResult>;

/** What every writer of the optimistic slices needs to describe a failure. */
export interface SendFailure {
  readonly key: string;
  readonly code: number;
  readonly message: string;
}

/**
 * A failed send, in the shape `failOptimisticSend` records and the shape the
 * composer renders. An `ApiError` carries the server's key and message; a
 * transport failure is one inert line (R26a).
 */
export function describeSendFailure(error: unknown): SendFailure {
  if (error instanceof ApiError) {
    return { key: error.key, code: error.code, message: error.message };
  }
  return { key: 'transport_error', code: 0, message: describeCause(error) };
}

/**
 * A cause an access-only session recovers from on its own: the token was
 * stale, the host renews it over the descriptor, and the SAME text can be sent
 * again (KTD8 — a 401 in this mode is recoverable, never a sign-out).
 */
const RECOVERABLE_KEYS = new Set(['session_expired', 'token_expired', 'unauthorized', 'access_token_expired']);

/** The member-facing reason for a failed send. */
export function sendFailureReason(failure: SendFailure): string {
  const cause = failure.message === '' ? failure.key : failure.message;
  if (RECOVERABLE_KEYS.has(failure.key)) {
    return `${cause} (this session renews its token from the host; press Enter again)`;
  }
  return cause;
}

export interface SenderOptions {
  /** The shared store the optimistic row is written into. */
  readonly store: StateStore;
  /**
   * The session's own api-client. Only `sendMessage` is used: it addresses a
   * channel or a thread's replies with one body (`thread_id`), which is the
   * write path the other clients take.
   */
  readonly api: Pick<CytaleApiClient, 'sendMessage'>;
}

/**
 * The sender the shell hands to `App`'s send seam: check the draft, write the
 * optimistic row, POST it, settle it — and report, never throw.
 */
export function createSender(options: SenderOptions): Sender {
  const { store, api } = options;

  return async (target: ContentTarget, text: string): Promise<SendResult> => {
    const check = checkDraft(text, {
      channelId: target.channelId,
      authorId: store.getState().currentUser?.id ?? null,
    });
    if (!check.ok) {
      // `empty` is not an error the member needs to read.
      return { ok: false, reason: check.refusal === 'empty' ? '' : check.reason };
    }

    const { nonce } = beginOptimisticSend(store, {
      channel_id: target.channelId,
      thread_id: target.threadId,
      author_id: store.getState().currentUser?.id ?? '',
      content: check.text,
    });

    try {
      // The nonce IS the Idempotency-Key (optimistic.ts): a retry of the same
      // send cannot double-post it server-side.
      const message = await api.sendMessage(
        target.channelId,
        { content: check.text, thread_id: target.threadId },
        nonce,
      );
      confirmOptimisticSend(store, nonce, message);
      return { ok: true, message };
    } catch (error) {
      const failure = describeSendFailure(error);
      failOptimisticSend(store, nonce, failure);
      return { ok: false, reason: sendFailureReason(failure) };
    }
  };
}
