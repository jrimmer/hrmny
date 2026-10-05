/**
 * @cytale/web — sends wait for the connection (send reliability B2).
 *
 * The offline banner says "Messages will sync when the connection returns";
 * this is what makes it true. A send whose request never got an answer — a
 * transport failure (offline, a dropped connection) or a timeout — is held in
 * its timeline (useMessages `postQueued`), and:
 *
 *  - while the browser is offline it reads "Waiting for connection…"
 *    (`waiting`), not "Failed" — including rows that failed or timed out just
 *    BEFORE the offline event told us why (`markHeldSendsWaiting`);
 *  - when the connection returns, every such row is re-sent on its own, in the
 *    order it was typed, through the per-conversation send queue and under its
 *    ORIGINAL nonce (`retrySend`). The server dedupes by that key, so a
 *    timed-out POST that did land answers with the stored message instead of
 *    posting a second one, and the gateway echo, if it lands mid-retry, settles
 *    the same row by the same key.
 *
 * A backlog bigger than the server's send budget (10 per conversation / 5 s)
 * does not fail its tail: a 429 pauses that conversation's queue for
 * Retry-After and the refused row goes again, still "Sending…"
 * (useMessages `postQueued`), so every held row drains, in order.
 *
 * A failure the server gave (validation, permission, account_unverified, a
 * 5xx) is never re-sent unasked: those rows keep their manual Retry
 * (`isConnectionFailure`). Held rows are local only and do not survive a
 * reload — accepted.
 *
 * The connection signal is the one the banner uses (`useOnlineStatus.ts`),
 * never a second detector.
 */

import { heldSendsAwaitingConnection, markHeldSendsWaiting, type StateStore } from '@cytale/state';

import { isOnline, subscribeOnlineStatus } from '../../app/pwa/useOnlineStatus.js';
import { retrySend } from './useMessages.js';

/**
 * Re-send every held send that is waiting for the connection, oldest first.
 * Each `retrySend` turns its row pending ("Sending…") at once and enqueues
 * the POST behind whatever its conversation already has in flight, so the
 * calls' order IS the send order. Returns the nonces re-sent.
 */
export function retryWaitingSends(store: StateStore): string[] {
  if (!isOnline()) return [];
  const nonces = heldSendsAwaitingConnection(store);
  for (const nonce of nonces) {
    // A failure is the row's to show again (held once more, by its reason).
    void retrySend(store, nonce).catch(() => undefined);
  }
  return nonces;
}

/**
 * Follow the connection for `store`: offline → held connection failures say
 * they are waiting; back online → they go out. Returns the stop function.
 */
export function startSendAutoRetry(store: StateStore): () => void {
  let last = isOnline();
  return subscribeOnlineStatus((online) => {
    if (online === last) return;
    last = online;
    if (online) retryWaitingSends(store);
    else markHeldSendsWaiting(store);
  });
}
