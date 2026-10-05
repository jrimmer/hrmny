/**
 * @cytale/web — reactions message-state seam (reactions UI unit).
 *
 * Reconciles reaction gateway dispatches (`MessageReactionAdd` /
 * `MessageReactionRemove` / `MessageReactionRemoveAll`) into the SAME U17
 * store slices the shared dispatcher owns (messagesByChannel), mirroring how
 * `applyGatewayEvent` patches message rows (find slice → patch one row by
 * id → immutable copy). It lives in apps/web (not @cytale/state) because the
 * events ride runtime dispatch frames whose protocol union entries land with
 * the parallel server change; the frame check below is STRUCTURAL, so this
 * seam starts reconciling the moment the frames flow — no protocol import,
 * no drift, and unknown frames stay accepted no-ops.
 *
 * Ordering: session.ts runs this BEFORE `applyGatewayEvent` — the shared
 * dispatcher advances `lastSeq`, and this seam's replay gate (`s <= lastSeq`
 * drops, same rule as reconcile.ts) must see the pre-dispatch value.
 *
 * Own-echo dedup: optimistic toggles are applied immediately (below), and
 * the server echoes own reaction events back to the originating session
 * (Discord semantics). The pending-toggle queue marks in-flight own ops so
 * the echo is consumed WITHOUT re-applying (the optimistic apply already
 * reflected it) — without it every own add would double-count. Echoes from
 * the user's OTHER devices match no queue entry and apply normally.
 */

import type { ReactionSummary } from '@cytale/api-client';
import type { MessageSlice, StateState, StateStore } from '@cytale/state';

import type { MessageWithBots } from './types.js';

// ---------------------------------------------------------------------------
// Payload contracts (decimal-string ids; raw-Unicode emoji — no custom emoji)
// ---------------------------------------------------------------------------

/** MessageReactionAdd / MessageReactionRemove dispatch payload. */
export interface ReactionTogglePayload {
  channel_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
}

/** MessageReactionRemoveAll dispatch payload (identity fields only). */
export interface ReactionRemoveAllPayload {
  channel_id: string;
  message_id: string;
}

/** Structural guard for the toggle payloads (untrusted dispatch frames). */
function isTogglePayload(d: unknown): d is ReactionTogglePayload {
  if (typeof d !== 'object' || d === null) return false;
  const p = d as Record<string, unknown>;
  return (
    typeof p.channel_id === 'string' &&
    typeof p.message_id === 'string' &&
    typeof p.user_id === 'string' &&
    typeof p.emoji === 'string' &&
    p.emoji.length > 0
  );
}

/** Optimistic placeholder rows (pending_<nonce>) never carry reactions. */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('pending_');
}

// ---------------------------------------------------------------------------
// Row patching (same slice/row discipline as reconcile.ts patchMessage)
// ---------------------------------------------------------------------------

/**
 * Patch one message row's `reactions` array. `update` receives the current
 * summaries and returns the next ones; an empty result REMOVES the key (the
 * server contract keeps `reactions` ABSENT when a message has none, and the
 * chip row renders only when present). Placeholder rows and missing slices
 * are no-ops.
 */
function patchReactions(
  store: StateStore,
  channelId: string,
  messageId: string,
  update: (current: ReactionSummary[]) => ReactionSummary[],
): void {
  if (isPlaceholderId(messageId)) return;
  patchRow(store, channelId, messageId, (m) => {
    const next = update(((m as MessageWithBots).reactions ?? []).filter(isSummary));
    // Absent-when-empty mirrors the wire contract; the row hides.
    const row = { ...m } as MessageWithBots;
    row.reactions = next.length > 0 ? next : undefined;
    return row;
  });
}

/**
 * Patch ONE row wherever it lives: the channel's window, or — for a thread
 * reply (#15; reaction frames name the parent channel, not the thread) — the
 * thread window that holds it. A row in neither is a no-op.
 */
function patchRow(
  store: StateStore,
  channelId: string,
  messageId: string,
  patch: (row: MessageSlice['items'][number]) => MessageSlice['items'][number],
): void {
  store.setState((s) => {
    const slice = s.messagesByChannel[channelId];
    if (slice && slice.items.some((m) => m.id === messageId)) {
      return {
        messagesByChannel: {
          ...s.messagesByChannel,
          [channelId]: { ...slice, items: slice.items.map((m) => (m.id === messageId ? patch(m) : m)) },
        },
      };
    }
    const threadId = threadHolding(s, channelId, messageId);
    if (threadId === null) return {};
    const thread = s.messagesByThread[threadId]!;
    return {
      messagesByThread: {
        ...s.messagesByThread,
        [threadId]: { ...thread, items: thread.items.map((m) => (m.id === messageId ? patch(m) : m)) },
      },
    };
  });
}

/** The thread window holding a parent channel's reply, or null. */
function threadHolding(s: StateState, channelId: string, messageId: string): string | null {
  for (const [threadId, slice] of Object.entries(s.messagesByThread)) {
    if (!slice) continue;
    const hit = slice.items.find((m) => m.id === messageId);
    if (hit && (hit.channel_id === channelId || hit.channel_id === '')) return threadId;
  }
  return null;
}

/** Defensive row filter — malformed summary entries drop out, never crash. */
function isSummary(r: unknown): r is ReactionSummary {
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof (r as ReactionSummary).emoji === 'string' &&
    typeof (r as ReactionSummary).count === 'number' &&
    typeof (r as ReactionSummary).me === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// Reconcile primitives (also the optimistic path of useMessages.toggleReaction)
// ---------------------------------------------------------------------------

/** Apply one MessageReactionAdd to the store (idempotent for own adds). */
export function applyReactionAdd(store: StateStore, payload: ReactionTogglePayload): void {
  const me = store.getState().currentUser?.id ?? null;
  const mine = me !== null && payload.user_id === me;
  patchReactions(store, payload.channel_id, payload.message_id, (rs) => {
    const existing = rs.find((r) => r.emoji === payload.emoji);
    if (!existing) return [...rs, { emoji: payload.emoji, count: 1, me: mine }];
    // Own add over an already-me chip is a duplicate (echo/retry) — no-op.
    if (mine && existing.me) return rs;
    return rs.map((r) =>
      r.emoji === payload.emoji ? { ...r, count: r.count + 1, me: r.me || mine } : r,
    );
  });
}

/** Apply one MessageReactionRemove (own removes flip `me` off; 0 drops the chip). */
export function applyReactionRemove(store: StateStore, payload: ReactionTogglePayload): void {
  const me = store.getState().currentUser?.id ?? null;
  const mine = me !== null && payload.user_id === me;
  patchReactions(store, payload.channel_id, payload.message_id, (rs) => {
    const existing = rs.find((r) => r.emoji === payload.emoji);
    if (!existing) return rs;
    if (mine && !existing.me) return rs; // wasn't ours — duplicate remove, no-op
    const count = Math.max(existing.count - 1, 0);
    if (count <= 0) return rs.filter((r) => r.emoji !== payload.emoji);
    return rs.map((r) =>
      r.emoji === payload.emoji ? { ...r, count, me: mine ? false : r.me } : r,
    );
  });
}

/** Apply MessageReactionRemoveAll — clears the whole chip row. */
export function applyReactionRemoveAll(store: StateStore, payload: ReactionRemoveAllPayload): void {
  if (isPlaceholderId(payload.message_id)) return;
  patchRow(store, payload.channel_id, payload.message_id, (m) => {
    const row = { ...m } as MessageWithBots;
    row.reactions = undefined;
    return row;
  });
}

// ---------------------------------------------------------------------------
// Own-echo dedup queue
// ---------------------------------------------------------------------------

interface PendingToggle {
  op: 'add' | 'remove';
}

const pendingOwnToggles = new Map<string, PendingToggle[]>();

function ownKey(messageId: string, emoji: string): string {
  return `${messageId}\u0000${emoji}`;
}

/**
 * Register an in-flight own toggle (called just before the optimistic apply).
 * The returned entry is the rollback handle — pass it to
 * `clearPendingOwnToggle` if the REST call fails.
 */
export function markPendingOwnToggle(
  messageId: string,
  emoji: string,
  op: 'add' | 'remove',
): PendingToggle {
  const entry: PendingToggle = { op };
  const key = ownKey(messageId, emoji);
  const queue = pendingOwnToggles.get(key) ?? [];
  queue.push(entry);
  pendingOwnToggles.set(key, queue);
  return entry;
}

/** Drop a pending own toggle (REST failure rollback — no echo will come). */
export function clearPendingOwnToggle(
  messageId: string,
  emoji: string,
  entry: PendingToggle,
): void {
  const key = ownKey(messageId, emoji);
  const queue = pendingOwnToggles.get(key);
  if (!queue) return;
  const i = queue.indexOf(entry);
  if (i >= 0) queue.splice(i, 1);
  if (queue.length === 0) pendingOwnToggles.delete(key);
}

/**
 * True when an own-user echo matches a queued optimistic toggle — the echo
 * must be swallowed (the optimistic apply already reflected it). Own echoes
 * with no queue entry (another device reacted) return false and apply.
 */
function consumeOwnEcho(
  store: StateStore,
  payload: ReactionTogglePayload,
  op: 'add' | 'remove',
): boolean {
  const me = store.getState().currentUser?.id;
  if (!me || payload.user_id !== me) return false;
  const queue = pendingOwnToggles.get(ownKey(payload.message_id, payload.emoji));
  if (!queue || queue.length === 0) return false;
  const i = queue.findIndex((e) => e.op === op);
  if (i === -1) return false;
  queue.splice(i, 1);
  if (queue.length === 0) pendingOwnToggles.delete(ownKey(payload.message_id, payload.emoji));
  return true;
}

// ---------------------------------------------------------------------------
// Dispatch seam (structural — works regardless of the protocol union)
// ---------------------------------------------------------------------------

/** A gateway dispatch frame, viewed structurally (untrusted). */
export interface DispatchFrame {
  op: number;
  t: string;
  s: number;
  d: unknown;
}

function isDispatchFrame(value: unknown): value is DispatchFrame {
  if (typeof value !== 'object' || value === null) return false;
  const f = value as Record<string, unknown>;
  return f.op === 0 && typeof f.t === 'string' && typeof f.s === 'number' && typeof f.d !== 'undefined';
}

/**
 * Apply one gateway dispatch frame's reaction effects to the store. Returns
 * true when the frame was a reaction dispatch (applied or deduped); every
 * other frame is an accepted no-op (false), so the caller can pipe the full
 * dispatch stream through unfiltered — the same contract as
 * `applyGatewayEvent`. Replay gate mirrors reconcile.ts: `s <= lastSeq`
 * drops; the caller must invoke this BEFORE `applyGatewayEvent` so lastSeq
 * still holds the previous dispatch's sequence.
 */
export function applyReactionEvent(store: StateStore, frame: unknown): boolean {
  if (!isDispatchFrame(frame)) return false;
  // Ready/Resumed exceptions never apply here (not reaction events).
  if (frame.s <= store.getState().lastSeq) return false;

  switch (frame.t) {
    case 'MessageReactionAdd': {
      if (!isTogglePayload(frame.d)) return false;
      if (!consumeOwnEcho(store, frame.d, 'add')) applyReactionAdd(store, frame.d);
      return true;
    }
    case 'MessageReactionRemove': {
      if (!isTogglePayload(frame.d)) return false;
      if (!consumeOwnEcho(store, frame.d, 'remove')) applyReactionRemove(store, frame.d);
      return true;
    }
    case 'MessageReactionRemoveAll': {
      const d = frame.d;
      if (
        typeof d !== 'object' ||
        d === null ||
        typeof (d as Record<string, unknown>).channel_id !== 'string' ||
        typeof (d as Record<string, unknown>).message_id !== 'string'
      ) {
        return false;
      }
      applyReactionRemoveAll(store, d as unknown as ReactionRemoveAllPayload);
      return true;
    }
    default:
      return false;
  }
}
