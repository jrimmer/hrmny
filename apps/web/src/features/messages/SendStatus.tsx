/**
 * @cytale/web — the optimistic send's row states (2026-09-28).
 *
 * Enter clears the composer at once and the message is drawn locally
 * (useMessages `send`); this file is what that local row shows while it is
 * not a confirmed server message yet:
 *
 *  - PENDING — the text is muted (never a layout change: the confirmed row
 *    replaces it in place, same height) and assistive tech reads "Sending".
 *    No icon, grouped or not. Nothing to click. A send the server's budget
 *    turned away (429) STAYS pending while its queue waits out Retry-After
 *    and re-sends it under the same nonce (useMessages `postQueued`).
 *  - FAILED — Discord's failed message: the row STAYS, with "Failed to send"
 *    and why, plus Retry (same nonce — the server's idempotency record means
 *    it can never land twice), Delete (forget it locally) and Edit (move it
 *    back into the composer).
 *  - UNCONFIRMED — a timeout: the POST may have landed. Its own words ("Not
 *    confirmed yet"), because telling someone a message failed when it might
 *    be in the channel invites the duplicate we are guarding against.
 *  - WAITING — the connection is down (send reliability B2): "Waiting for
 *    connection…", muted, no Retry — it goes out on its own, same nonce, when
 *    the connection returns (sendAutoRetry.ts), and turns pending
 *    ("Sending…") then. Delete and Edit still work.
 *
 * The failure line is `role="alert"`: it is inserted into a row that is
 * already on screen, so it is announced when the send fails — the state is
 * never carried by colour alone. A waiting row is not a failure: its line is
 * a polite `role="status"`.
 *
 * Edit never overwrites text: when the composer already holds something (the
 * member has moved on to the next message) it refuses and says so. The
 * composer is also never refilled automatically on a failure — see
 * `restoreDraft` in MessageCompose.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';

import type { Message, UploadedAttachment } from '@cytale/domain';
import { defaultStore, type StateStore } from '@cytale/state';

import { discardSend, findMessageRow, retrySend } from './useMessages.js';

/** What a pane that owns a composer offers the failed rows it renders. */
export interface SendRowActions {
  /**
   * Move a failed send back into the composer (text, attachments, reply).
   * Returns false — and changes nothing — when the composer is not empty.
   */
  editInComposer?: (nonce: string) => boolean;
  /** Where focus goes when a failed row's buttons disappear (Retry/Delete). */
  focusComposer?: () => void;
}

export const SendRowActionsContext = createContext<SendRowActions>({});

/** The composer seam `editInComposer` fills (see ComposerHandle.restoreDraft). */
export interface RestorableDraft {
  content: string;
  attachments: UploadedAttachment[];
}

/**
 * The pane half of Edit: pull the failed record, strip the reply ping the
 * composer will add back, hand the rest to the composer, and — only if it took
 * it — forget the failed row and re-arm the reply bar.
 */
export function useSendRowActions(
  store: StateStore,
  channelId: string | null,
  composer: {
    current: {
      restoreDraft?: (draft: RestorableDraft) => boolean;
      focus?: () => void;
    } | null;
  },
  startReply?: (message: Message, opts?: { suppressPing?: boolean }) => void,
): SendRowActions {
  const editInComposer = useCallback(
    (nonce: string): boolean => {
      const state = store.getState();
      const failed = state.failedByNonce[nonce];
      const restore = composer.current?.restoreDraft;
      if (!failed || !restore) return false;
      const original = failed.reply_to_id
        ? findMessageRow(state, channelId ?? failed.channel_id, failed.reply_to_id)
        : undefined;
      let content = failed.content;
      let ping = false;
      if (original) {
        // The composer prefixes the ping when the reply bar's @ is on; the
        // wire content already carries it, so take it back off.
        const prefix = `<@${original.author_id}> `;
        if (content.startsWith(prefix)) {
          content = content.slice(prefix.length);
          ping = true;
        }
      }
      if (!restore({ content, attachments: failed.attachments ?? [] })) return false;
      discardSend(store, nonce);
      if (original && startReply) startReply(original, { suppressPing: !ping });
      return true;
    },
    [store, channelId, composer, startReply],
  );
  const focusComposer = useCallback(() => composer.current?.focus?.(), [composer]);
  return useMemo(() => ({ editInComposer, focusComposer }), [editInComposer, focusComposer]);
}

/** The nonce behind a local row (`pending_<nonce>`). */
function nonceOf(message: Message): string {
  return message.client_key ?? message.id.slice('pending_'.length);
}

/** True for a row that is still the local optimistic placeholder. */
export function isLocalSendRow(message: Message): boolean {
  return message.send_state !== undefined && message.id.startsWith('pending_');
}

/**
 * The pending mark: only the spoken state. There is no visible icon — the
 * muted text (MessageItem) is the whole visual cue, as in Discord. An earlier
 * clock was absolutely placed at the avatar gutter's bottom edge, which a
 * grouped continuation row (no avatar, ~22px tall) does not have, so it hung
 * below the row on its own; the owner asked for it to go (2026-09-28). The
 * sr-only span is out of flow, so confirming removes it without a shift.
 */
export function PendingSendMark() {
  return <span className="sr-only">Sending…</span>;
}

/** Why a failed row failed, in the member's words. */
export function failedSendReason(message: Message): { title: string; detail: string | null } {
  const key = message.send_error?.key ?? '';
  if (message.send_state === 'waiting') {
    return {
      title: 'Waiting for connection…',
      detail: "It'll send when you're back online.",
    };
  }
  if (message.send_state === 'unconfirmed') {
    return {
      title: 'Not confirmed yet',
      detail: "The server didn't answer in time. Retry is safe — it won't send twice.",
    };
  }
  if (key === 'account_unverified' || key === 'ACCOUNT_UNVERIFIED') {
    return { title: 'Failed to send', detail: 'Verify your email to post messages.' };
  }
  if (key === 'rate_limited') {
    // Only after the queue waited out the send budget several times over
    // (useMessages SEND_RATE_LIMIT_MAX_RETRIES) — a single 429 never shows.
    return {
      title: 'Failed to send',
      detail: "You're sending messages faster than the server allows. Retry in a moment.",
    };
  }
  if (key === 'network_error') {
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return {
      title: 'Failed to send',
      detail: offline ? "You're offline." : "Couldn't reach the server.",
    };
  }
  const detail = message.send_error?.message?.trim();
  return { title: 'Failed to send', detail: detail ? detail : null };
}

const ACTION_BTN =
  'rounded px-1.5 py-0.5 font-medium transition-colors duration-[var(--duration-control)] ' +
  'hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-focus)]';

/**
 * The failed/unconfirmed row's status line and its actions. Keyboard: three
 * plain buttons in the tab order, in the order a member reaches for them.
 */
export function FailedSendBar({ message, store }: { message: Message; store?: StateStore }) {
  const actions = useContext(SendRowActionsContext);
  const effective = store ?? defaultStore;
  const nonce = nonceOf(message);
  const [note, setNote] = useState<string | null>(null);
  const { title, detail } = failedSendReason(message);
  const waiting = message.send_state === 'waiting';
  // Neither is a failure: muted words, no danger colour.
  const unconfirmed = message.send_state === 'unconfirmed' || waiting;

  const onRetry = useCallback(() => {
    actions.focusComposer?.();
    // The failure is the row's to show again if the retry fails too.
    void retrySend(effective, nonce).catch(() => undefined);
  }, [actions, effective, nonce]);
  const onDelete = useCallback(() => {
    actions.focusComposer?.();
    discardSend(effective, nonce);
  }, [actions, effective, nonce]);
  const onEdit = useCallback(() => {
    if (!actions.editInComposer) return;
    if (!actions.editInComposer(nonce)) {
      setNote('Your message box already has text — send or clear it first, then Edit.');
    }
  }, [actions, nonce]);

  return (
    <div
      className={`mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs ${
        unconfirmed ? 'text-text-muted' : 'text-danger'
      }`}
      data-testid="message-send-failed"
      data-send-state={message.send_state}
    >
      <span
        role={waiting ? 'status' : 'alert'}
        className="inline-flex items-center gap-1"
        data-testid="message-send-failed-reason"
      >
        <span aria-hidden>{unconfirmed ? '⏳' : '⚠'}</span>
        <span className="font-semibold">{title}</span>
        {detail ? <span>— {detail}</span> : null}
      </span>
      {waiting ? null : (
        <button
          type="button"
          className={`${ACTION_BTN} text-accent`}
          data-testid="message-send-retry"
          onClick={onRetry}
          aria-label={`Retry sending this message`}
        >
          Retry
        </button>
      )}
      {actions.editInComposer ? (
        <button
          type="button"
          className={`${ACTION_BTN} text-text-muted hover:text-text`}
          data-testid="message-send-edit"
          onClick={onEdit}
          aria-label="Edit this message in the message box"
        >
          Edit
        </button>
      ) : null}
      <button
        type="button"
        className={`${ACTION_BTN} text-text-muted hover:text-text`}
        data-testid="message-send-delete"
        onClick={onDelete}
        aria-label="Delete this unsent message"
      >
        Delete
      </button>
      {note ? (
        <span role="status" className="basis-full text-text-muted" data-testid="message-send-edit-note">
          {note}
        </span>
      ) : null}
    </div>
  );
}
