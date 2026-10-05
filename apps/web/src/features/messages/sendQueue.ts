/**
 * @cytale/web — the per-conversation send queue (optimistic send, 2026-09-28).
 *
 * Enter no longer waits for the server: the composer clears, the optimistic
 * row lands, and the member may send again at once. The POSTs themselves
 * still leave ONE AT A TIME per conversation (channel, or channel + thread),
 * in the order they were typed: the server assigns ids — and so timeline
 * order — on arrival, so two concurrent POSTs could land swapped and the
 * confirmed rows would reorder under the reader.
 *
 * A send that fails does not stall the queue: the next one goes out (Discord
 * behaves the same — a failed message stays behind, marked, while the
 * conversation carries on). A retry is simply enqueued again, behind whatever
 * is in flight at that moment.
 *
 * Keyed per store (tests run isolated stores side by side) and per scope; a
 * scope's chain is dropped once it drains, so the map holds only live queues.
 *
 * A queue can also be PAUSED (`pauseSends`): the server's send budget (10
 * sends / 5 s per conversation, 20 / 5 s across conversations — see
 * docs/protocol/rest.md) answers an over-budget POST with 429 + Retry-After,
 * and the send that met it waits that long and goes again (useMessages
 * `postQueued`). A pause on one scope holds that conversation; a pause on
 * `ALL_SCOPES` holds every conversation of the store, for the budget they
 * share. Each queued POST calls `waitForSendWindow` before it leaves.
 */

const chains = new WeakMap<object, Map<string, Promise<void>>>();

/** The queue scope of a conversation: the channel, or the channel's thread. */
export function sendScope(channelId: string, threadId: string | null | undefined): string {
  return threadId ? `${channelId}:t:${threadId}` : channelId;
}

/**
 * Run `task` after every task enqueued earlier on the same (store, scope) has
 * SETTLED — resolved or rejected — and return its own outcome.
 */
export function enqueueSend<T>(owner: object, scope: string, task: () => Promise<T>): Promise<T> {
  let byScope = chains.get(owner);
  if (byScope === undefined) {
    byScope = new Map();
    chains.set(owner, byScope);
  }
  const previous = byScope.get(scope) ?? Promise.resolve();
  const run = previous.then(task);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  byScope.set(scope, tail);
  void tail.then(() => {
    if (byScope.get(scope) === tail) byScope.delete(scope);
  });
  return run;
}

/** Test/diagnostic seam: how many scopes of `owner` have sends in flight. */
export function activeSendScopes(owner: object): number {
  return chains.get(owner)?.size ?? 0;
}

/** The pause key that holds every conversation of a store (the shared budget). */
export const ALL_SCOPES = '*';

const pauses = new WeakMap<object, Map<string, number>>();

/**
 * Hold `scope` (or `ALL_SCOPES`) of `owner` for `ms` from now. A pause never
 * shortens one already in force — the later deadline wins.
 */
export function pauseSends(owner: object, scope: string, ms: number): void {
  let byScope = pauses.get(owner);
  if (byScope === undefined) {
    byScope = new Map();
    pauses.set(owner, byScope);
  }
  const until = Date.now() + Math.max(0, ms);
  if ((byScope.get(scope) ?? 0) < until) byScope.set(scope, until);
}

/** When `scope` of `owner` may send again (epoch ms; 0 = now). */
export function sendPausedUntil(owner: object, scope: string): number {
  const byScope = pauses.get(owner);
  if (byScope === undefined) return 0;
  return Math.max(byScope.get(scope) ?? 0, byScope.get(ALL_SCOPES) ?? 0);
}

/**
 * Resolve once neither `scope` nor the store-wide pause holds `owner`'s
 * sends. Re-checks after each wait: a pause set meanwhile (another
 * conversation met the shared budget) extends it.
 */
export async function waitForSendWindow(owner: object, scope: string): Promise<void> {
  for (;;) {
    const wait = sendPausedUntil(owner, scope) - Date.now();
    if (wait <= 0) {
      const byScope = pauses.get(owner);
      byScope?.delete(scope);
      if ((byScope?.get(ALL_SCOPES) ?? 0) <= Date.now()) byScope?.delete(ALL_SCOPES);
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
}
