/**
 * @cytale/mobile — reactions message-state seam (plan 004 M8, R11).
 *
 * The native twin of `apps/web/src/features/messages/reactions.ts`: reaction
 * dispatches (`MessageReactionAdd` / `MessageReactionRemove` /
 * `MessageReactionRemoveAll`) patch the SAME `messagesByChannel` slices the
 * shared dispatcher owns, and an optimistic toggle applies the same patch
 * before the REST call so a chip flips the instant a finger lands on it.
 *
 * Why this file exists rather than an import: the shipped seam is DOM-free
 * but it lives in `apps/web` (M4's plan text expected it to move into a
 * shared package; the extraction that shipped only took the session
 * orchestration). `@cytale/state` deliberately does not model reactions —
 * `applyGatewayEvent` accepts the three dispatch types as pass-through no-ops
 * and documents that a client seam reconciles them. Mobile cannot import web
 * source (apps/mobile is file-disjoint from apps/web), so this module mirrors
 * the shipped semantics case for case; when the extraction lands, both
 * clients swap to the shared module and this file is deleted.
 *
 * Ordering: feed frames through `applyReactionEvent` BEFORE
 * `applyGatewayEvent` (the session package's `gatewayPreprocessors` seam is
 * exactly this) — the shared dispatcher advances `lastSeq`, and this module's
 * replay gate must see the pre-dispatch value.
 *
 * Own-echo dedup: the server fans an own reaction back to the originating
 * session. `beginOptimisticReaction` queues the in-flight toggle, so the echo
 * is consumed without re-applying (the optimistic patch already reflected it)
 * while echoes from the user's other devices still apply normally.
 */
import type { MessageWithReactions, ReactionSummary } from '@cytale/api-client';
import type { StateStore } from '@cytale/state';

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

/** Optimistic placeholder rows (`pending_<nonce>`) never carry reactions. */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('pending_');
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
// Row patching (same slice/row discipline as reconcile.ts patchMessage)
// ---------------------------------------------------------------------------

/**
 * Patch one message row's `reactions` array. `update` receives the current
 * summaries and returns the next ones; an empty result REMOVES the key (the
 * wire contract keeps `reactions` ABSENT when a message has none, and the
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
  store.setState((s) => {
    const slice = s.messagesByChannel[channelId];
    if (!slice || !slice.items.some((m) => m.id === messageId)) return {};
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: {
          ...slice,
          items: slice.items.map((m) => {
            if (m.id !== messageId) return m;
            const next = update(((m as MessageWithReactions).reactions ?? []).filter(isSummary));
            // Absent-when-empty mirrors the wire contract; the row hides.
            const row = { ...m } as MessageWithReactions;
            row.reactions = next.length > 0 ? next : undefined;
            return row;
          }),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Reconcile primitives (also the optimistic path of `beginOptimisticReaction`)
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
  store.setState((s) => {
    const slice = s.messagesByChannel[payload.channel_id];
    if (!slice || !slice.items.some((m) => m.id === payload.message_id)) return {};
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [payload.channel_id]: {
          ...slice,
          items: slice.items.map((m) => {
            if (m.id !== payload.message_id) return m;
            const row = { ...m } as MessageWithReactions;
            row.reactions = undefined;
            return row;
          }),
        },
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Own-echo dedup queue
// ---------------------------------------------------------------------------

interface PendingToggle {
  op: 'add' | 'remove';
}

/** In-flight own toggles, keyed `messageId\u0000emoji`. */
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
  const key = ownKey(payload.message_id, payload.emoji);
  const queue = pendingOwnToggles.get(key);
  if (!queue || queue.length === 0) return false;
  const i = queue.findIndex((e) => e.op === op);
  if (i === -1) return false;
  queue.splice(i, 1);
  if (queue.length === 0) pendingOwnToggles.delete(key);
  return true;
}

/** Drop every queued toggle (tests, and session reset when it lands). */
export function resetReactionSeam(): void {
  pendingOwnToggles.clear();
}

// ---------------------------------------------------------------------------
// Optimistic toggle (the chips' / sheet's apply path)
// ---------------------------------------------------------------------------

export interface OptimisticReaction {
  /** The op the REST call must perform (derived from the current chip). */
  op: 'add' | 'remove';
  /** Undo the optimistic patch and forget the pending echo (REST failed). */
  rollback(): void;
}

/**
 * Apply one own toggle optimistically and register the in-flight op. The
 * caller performs the matching `api.addReaction` / `api.removeReaction` and
 * calls `rollback()` on failure. Returns null when the row is a placeholder
 * (never reactable) — the caller skips the REST call.
 */
export function beginOptimisticReaction(
  store: StateStore,
  payload: ReactionTogglePayload,
): OptimisticReaction | null {
  if (isPlaceholderId(payload.message_id)) return null;
  const row = store
    .getState()
    .messagesByChannel[payload.channel_id]?.items.find((m) => m.id === payload.message_id) as
    | MessageWithReactions
    | undefined;
  const mine = row?.reactions?.some((r) => r.emoji === payload.emoji && r.me) === true;
  const op: 'add' | 'remove' = mine ? 'remove' : 'add';
  // Register before the apply so a racing own echo is deduped.
  const pending = markPendingOwnToggle(payload.message_id, payload.emoji, op);
  if (op === 'add') applyReactionAdd(store, payload);
  else applyReactionRemove(store, payload);

  return {
    op,
    rollback() {
      clearPendingOwnToggle(payload.message_id, payload.emoji, pending);
      if (op === 'add') applyReactionRemove(store, payload);
      else applyReactionAdd(store, payload);
    },
  };
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
  return (
    f.op === 0 && typeof f.t === 'string' && typeof f.s === 'number' && typeof f.d !== 'undefined'
  );
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
