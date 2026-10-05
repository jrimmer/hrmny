/**
 * @cytale/tui — the reaction surface in column two (U14; R24, R26a).
 *
 * A member sees the reactions on a message, adds one, and removes their own.
 * This module is the half of that sentence the browser does not share: the Ink
 * line the pane draws, and the two runtime seams behind it — the optimistic
 * toggle and the gateway fold.
 *
 * ---------------------------------------------------------------------------
 * What it draws, and why it is only a line
 * ---------------------------------------------------------------------------
 *
 * A chip is `emoji count` — `👍 3` — and the member's OWN chips are bracketed
 * (`[👍 3]`). The brackets are the non-colour channel the unit asks for, the
 * same rule U6's focus markers and U5's phase markers follow: a monochrome
 * terminal and a colour-blind member read the same thing a colour would have
 * carried, and nothing here emits an SGR sequence of its own. The chip row's
 * SPELLING lives in `format/rows.ts` (`reactionLine`), because it is a line of
 * the pane's row budget; this module is the surface that draws it and the
 * machinery that changes it.
 *
 * The emoji itself never reaches a cell as the server's string. `readReactions`
 * renders a glyph from `format/rows.ts`'s own palette when it knows the emoji
 * and a stable ASCII short name (`:u1fae0:`) when it does not — so a terminal
 * with no emoji font still shows something legible, and a hostile value cannot
 * arrive through the chip (R26a).
 *
 * ---------------------------------------------------------------------------
 * The wire, and the shape this reader trusts
 * ---------------------------------------------------------------------------
 *
 * Reactions are read from the message row the SHARED store holds — the flat
 * `/api/v1` array `[{emoji, count, me}]` (`CytaleApiClient`'s `ReactionSummary`;
 * `message_controller.ex` computes `me` against the calling viewer). The nested
 * Discord form (`{count, me, emoji: {id, name}}`) is the v10-compat dialect
 * (`message_codec.ex`'s `reactions_from_native/1`) and is not read: this
 * client's REST leg is `/api/v1`, so a row carrying that shape would be another
 * client's data path, and half-reading it would draw an emoji of `undefined`.
 *
 * ---------------------------------------------------------------------------
 * The fold, and why it is HERE rather than in @cytale/state
 * ---------------------------------------------------------------------------
 *
 * `@cytale/state` accepts the three reaction dispatches as PASS-THROUGH no-ops
 * (`reconcile.ts`: "Reaction dispatches are reconciled by the apps/web reactions
 * seam"), because the seam belongs to the client that renders reactions. This
 * is the terminal's seam, and it mirrors `apps/web/src/features/messages/
 * reactions.ts` exactly — same structural payload guards, same row-patch
 * discipline (find the slice → patch the one row by id → immutable copy), same
 * own-echo dedup — because two clients that fold the same frames differently is
 * how one message ends up with two counts.
 *
 * ORDERING (load-bearing, the same contract web's seam documents): this fold
 * must run BEFORE the shared dispatcher. `applyGatewayEvent` advances
 * `lastSeq`, and the replay gate below (`s <= lastSeq` drops, reconcile.ts's
 * rule) must read the PRE-dispatch value or a replayed frame is applied twice.
 * The session manager gives it exactly that seat:
 * `SessionManagerOptions.gatewayPreprocessors` runs a seam on every frame
 * before `applyGatewayEvent` — register {@link applyReactionEvent} there.
 *
 * ---------------------------------------------------------------------------
 * What is deliberately NOT offered: removing someone else's reaction
 * ---------------------------------------------------------------------------
 *
 * V1 has the member's own toggle and nothing else (R24). The routes that remove
 * another principal's reaction (`DELETE .../reactions/{emoji}/{user_id}` and
 * the two clear routes) are `manage_messages` moderation surfaces, not a chat
 * affordance, and this client does not present them: the member can take their
 * own reaction back, and a message the member cannot react to stays readable
 * rather than becoming a moderation tool. Nothing here guesses at that surface
 * — a chip the member did not react with is display only, and the only mutation
 * this module can send is its own `@me` add or remove.
 */
import { Text } from 'ink';
import type { ReactElement } from 'react';

import type { StateStore } from '@cytale/state';

import {
  describeCause,
  reactionChipOf,
  reactionLine,
  readReactions,
  type ReactionChip,
} from '../format/rows.js';

/** The INERT copy a refusal reads as; each one is a whole line on its own. */
const SIGNED_OUT = '✖ Sign in to react.';
const NOT_SENT = '✖ This message has not been sent yet.';
const ADD_FAILED = '✖ Could not add your reaction.';
const REMOVE_FAILED = '✖ Could not remove your reaction.';

/**
 * Optimistic placeholder rows (`pending_<nonce>`, `@cytale/state`'s convention)
 * are the member's own send, not server truth: there is no message id to react
 * to yet, and the confirmed server row is what becomes reactable — the same
 * rule the browser's toggle applies.
 */
function isPlaceholderId(id: string): boolean {
  return id.startsWith('pending_');
}

// ---------------------------------------------------------------------------
// The surface
// ---------------------------------------------------------------------------

export interface ReactionChipsProps {
  /** The row's chips, as `format/rows.ts` projected them. */
  readonly reactions: readonly ReactionChip[] | undefined;
}

/**
 * The chip row under a message. Nothing at all when the message has no
 * reactions: not an empty line, and not a zero — the reader never states a
 * count it has not been told.
 */
export function ReactionChips({ reactions }: ReactionChipsProps): ReactElement | null {
  const line = reactionLine({ reactions });
  if (line === null) return null;
  return <Text wrap="truncate">{line}</Text>;
}

// ---------------------------------------------------------------------------
// Payload contracts (decimal-string ids; raw-Unicode emoji — no custom emoji)
// ---------------------------------------------------------------------------

/** `MessageReactionAdd` / `MessageReactionRemove` dispatch payload. */
interface ReactionTogglePayload {
  channel_id: string;
  message_id: string;
  user_id: string;
  emoji: string;
}

/** `MessageReactionRemoveAll` dispatch payload (identity fields only). */
interface ReactionRemoveAllPayload {
  channel_id: string;
  message_id: string;
}

/** Structural guard for a frame that came off the wire, so its fields can be read. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The toggle payload the server publishes, or null when the frame is not one. */
function togglePayload(frame: unknown): ReactionTogglePayload | null {
  if (!isObject(frame)) return null;
  const d = frame.d;
  if (!isObject(d)) return null;
  return typeof d.channel_id === 'string' &&
    typeof d.message_id === 'string' &&
    typeof d.user_id === 'string' &&
    typeof d.emoji === 'string' &&
    d.emoji !== ''
    ? {
        channel_id: d.channel_id,
        message_id: d.message_id,
        user_id: d.user_id,
        emoji: d.emoji,
      }
    : null;
}

/** The remove-all payload, or null when the frame is not one. */
function removeAllPayload(frame: unknown): ReactionRemoveAllPayload | null {
  if (!isObject(frame)) return null;
  const d = frame.d;
  if (!isObject(d)) return null;
  return typeof d.channel_id === 'string' && typeof d.message_id === 'string'
    ? { channel_id: d.channel_id, message_id: d.message_id }
    : null;
}

/** A gateway dispatch frame, viewed structurally (untrusted input). */
interface DispatchFrame {
  readonly op: number;
  readonly t: string;
  readonly s: number;
  readonly d: unknown;
}

function isDispatchFrame(value: unknown): value is DispatchFrame {
  return (
    isObject(value) &&
    value.op === 0 &&
    typeof value.t === 'string' &&
    typeof value.s === 'number' &&
    value.d !== undefined
  );
}

// ---------------------------------------------------------------------------
// Row patching (the same slice/row discipline reconcile.ts patches a message by)
// ---------------------------------------------------------------------------

/** The row's reactions as the wire holds them (`{emoji, count, me}`). */
type WireReaction = { emoji: string; count: number; me: boolean };

/**
 * Patch one message row's `reactions` array. `update` receives the row's
 * current chips and returns the next ones; an empty result REMOVES the key,
 * because the wire keeps `reactions` ABSENT when a message has none and the
 * chip row renders only when it is present. Placeholder rows, a missing slice,
 * and a message this pane does not hold are all no-ops that write NOTHING at
 * all: the fold can never invent a row, and a frame about a message this client
 * is not holding must not notify every subscriber of a store change it did not
 * make.
 */
function patchReactions(
  store: StateStore,
  channelId: string,
  messageId: string,
  update: (current: readonly ReactionChip[]) => readonly ReactionChip[],
): void {
  if (isPlaceholderId(messageId)) return;
  const held = store.getState().messagesByChannel[channelId];
  if (held === undefined || !held.items.some((m) => m.id === messageId)) return;
  store.setState((s) => {
    const slice = s.messagesByChannel[channelId];
    // Re-checked inside the updater (zustand's own contract), though the read
    // above cannot go stale: nothing runs between the two in a single-threaded
    // runtime, so this is the guard the writer keeps, not a second decision.
    if (slice === undefined || !slice.items.some((m) => m.id === messageId)) return {};
    return {
      messagesByChannel: {
        ...s.messagesByChannel,
        [channelId]: {
          ...slice,
          items: slice.items.map((m) => {
            if (m.id !== messageId) return m;
            const next = update(readReactions(m));
            const row = { ...m } as typeof m & { reactions?: WireReaction[] | null };
            row.reactions = next.length > 0 ? next.map(toWire) : undefined;
            return row;
          }),
        },
      },
    };
  });
}

/** A chip back to the wire shape a write stores (labels are derived on read). */
function toWire(chip: ReactionChip): WireReaction {
  return { emoji: chip.emoji, count: chip.count, me: chip.me };
}

// ---------------------------------------------------------------------------
// Reconcile primitives (also the optimistic path of toggleOwnReaction)
// ---------------------------------------------------------------------------

/**
 * Apply one `MessageReactionAdd`. Idempotent for the member's own adds: an own
 * add over a chip already marked `me` is an echo or a retry, and re-applying it
 * is exactly how a count doubles. A payload whose emoji is not one this client
 * can draw is a no-op rather than a chip with an invented glyph.
 */
function applyReactionAdd(store: StateStore, payload: ReactionTogglePayload): void {
  const me = store.getState().currentUser?.id ?? null;
  const mine = me !== null && payload.user_id === me;
  patchReactions(store, payload.channel_id, payload.message_id, (chips) => {
    const existing = chips.find((chip) => chip.emoji === payload.emoji);
    if (existing === undefined) {
      const fresh = reactionChipOf(payload.emoji, 1, mine);
      return fresh === null ? chips : [...chips, fresh];
    }
    if (mine && existing.me) return chips;
    return chips.map((chip) =>
      chip.emoji === payload.emoji
        ? (reactionChipOf(chip.emoji, chip.count + 1, chip.me || mine) ?? chip)
        : chip,
    );
  });
}

/**
 * Apply one `MessageReactionRemove`. An own remove flips `me` off; a count that
 * reaches zero drops the chip, which is what the wire's absent key means.
 */
function applyReactionRemove(store: StateStore, payload: ReactionTogglePayload): void {
  const me = store.getState().currentUser?.id ?? null;
  const mine = me !== null && payload.user_id === me;
  patchReactions(store, payload.channel_id, payload.message_id, (chips) => {
    const existing = chips.find((chip) => chip.emoji === payload.emoji);
    if (existing === undefined) return chips;
    if (mine && !existing.me) return chips; // not ours — a duplicate remove
    const count = Math.max(existing.count - 1, 0);
    if (count <= 0) return chips.filter((chip) => chip.emoji !== payload.emoji);
    return chips.map((chip) =>
      chip.emoji === payload.emoji
        ? (reactionChipOf(chip.emoji, count, mine ? false : chip.me) ?? chip)
        : chip,
    );
  });
}

/** Apply `MessageReactionRemoveAll` — the whole chip row goes. */
function applyReactionRemoveAll(store: StateStore, payload: ReactionRemoveAllPayload): void {
  patchReactions(store, payload.channel_id, payload.message_id, () => []);
}

// ---------------------------------------------------------------------------
// Own-echo dedup
// ---------------------------------------------------------------------------

/**
 * In-flight own toggles, keyed by (message, emoji). The optimistic apply has
 * ALREADY reflected them, so the server's own echo of the same toggle must be
 * consumed without applying again. An echo from the member's OTHER device
 * matches no entry and applies normally, which is exactly right: that device's
 * reaction is news to us.
 *
 * Why a queue and not just idempotence: a member pressing the toggle twice in
 * quick succession has two own operations in flight, and the guards in
 * `applyReactionAdd` / `applyReactionRemove` cannot tell the two echoes apart —
 * the first echo would be applied over the second optimistic state. One entry
 * per own operation is what keeps a double toggle landing back where the member
 * left it.
 *
 * An entry's life: registered before the request, cleared when the request
 * FAILS (no echo will follow — the rollback path), consumed by the echo of its
 * own operation. A write that succeeds while the link drops before its fan-out
 * leaves one entry behind, which is the one case where a later add from the
 * member's other device could be swallowed; making that exact needs a rule that
 * ages an entry out (a sequence watermark on the frame rather than a match on
 * its op), which is a change to this seam's contract and so is recorded here
 * rather than guessed at.
 */
interface PendingToggle {
  readonly op: 'add' | 'remove';
}

const pendingOwnToggles = new Map<string, PendingToggle[]>();

function ownKey(messageId: string, emoji: string): string {
  return `${messageId}\u0000${emoji}`;
}

/** Register an in-flight own toggle (called just before the optimistic apply). */
function markPendingOwnToggle(
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

/** Drop a pending own toggle (the REST failure path — no echo will follow). */
function clearPendingOwnToggle(messageId: string, emoji: string, entry: PendingToggle): void {
  const key = ownKey(messageId, emoji);
  const queue = pendingOwnToggles.get(key);
  if (queue === undefined) return;
  const at = queue.indexOf(entry);
  if (at >= 0) queue.splice(at, 1);
  if (queue.length === 0) pendingOwnToggles.delete(key);
}

/**
 * True when the member's own echo matches a queued optimistic toggle, which
 * must therefore be swallowed. Own echoes with no queue entry come from another
 * device and return false, so they apply.
 */
function consumeOwnEcho(
  store: StateStore,
  payload: ReactionTogglePayload,
  op: 'add' | 'remove',
): boolean {
  const me = store.getState().currentUser?.id;
  if (me === undefined || payload.user_id !== me) return false;
  const key = ownKey(payload.message_id, payload.emoji);
  const queue = pendingOwnToggles.get(key);
  if (queue === undefined || queue.length === 0) return false;
  const at = queue.findIndex((entry) => entry.op === op);
  if (at === -1) return false;
  queue.splice(at, 1);
  if (queue.length === 0) pendingOwnToggles.delete(key);
  return true;
}

// ---------------------------------------------------------------------------
// The gateway fold
// ---------------------------------------------------------------------------

/**
 * Apply one dispatch frame's reaction effects to the shared store. Returns true
 * when the frame WAS a reaction dispatch (applied, or deduped against an
 * optimistic toggle) and false for every other frame — so the caller can pipe
 * the whole dispatch stream through unfiltered, the same contract
 * `applyGatewayEvent` offers.
 *
 * A frame that does not carry a well-formed payload is an accepted no-op: it
 * returns false and writes NOTHING, which is what keeps a malformed frame from
 * half-applying itself over a message's reaction set.
 */
export function applyReactionEvent(store: StateStore, frame: unknown): boolean {
  if (!isDispatchFrame(frame)) return false;
  // Ready/Resumed never reach here (they are not reaction dispatches), and the
  // replay gate is reconcile.ts's own rule: a sequence already applied is not
  // applied again.
  if (frame.s <= store.getState().lastSeq) return false;

  switch (frame.t) {
    case 'MessageReactionAdd': {
      const payload = togglePayload(frame);
      if (payload === null) return false;
      if (!consumeOwnEcho(store, payload, 'add')) applyReactionAdd(store, payload);
      return true;
    }
    case 'MessageReactionRemove': {
      const payload = togglePayload(frame);
      if (payload === null) return false;
      if (!consumeOwnEcho(store, payload, 'remove')) applyReactionRemove(store, payload);
      return true;
    }
    case 'MessageReactionRemoveAll': {
      const payload = removeAllPayload(frame);
      if (payload === null) return false;
      applyReactionRemoveAll(store, payload);
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// The member's own toggle
// ---------------------------------------------------------------------------

/** The two routes this client uses, as the api client offers them. */
export interface ReactionApi {
  addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
}

export interface ToggleOwnReactionInput {
  readonly store: StateStore;
  /** The session's REST client (`session.manager.api`). */
  readonly api: ReactionApi;
  readonly channelId: string;
  readonly messageId: string;
  /** The raw emoji, as an existing chip carries it. */
  readonly emoji: string;
}

/**
 * What became of a toggle: whether the store holds the change the member asked
 * for, which operation it was, and — when it failed — one INERT line saying
 * why. `op: null` means nothing was asked of the server (no session, or a
 * message that has not been sent yet).
 */
export interface ReactionOutcome {
  readonly applied: boolean;
  readonly op: 'add' | 'remove' | null;
  readonly error: string | null;
}

/**
 * Toggle the member's own reaction, optimistically.
 *
 * The chip moves FIRST (the member's keypress is acknowledged before a round
 * trip), the request goes out over the api client's own `@me` routes, and the
 * server's echo is swallowed by the pending queue — so the count converges on
 * the server's answer instead of on how many times the store was written. A
 * failure puts the chip back EXACTLY as it was and releases the queue entry, so
 * a later add is a real add again.
 *
 * Removing another member's reaction is not offered here at all: this seam can
 * only ever address the caller's own reaction (R24, V1 scope).
 */
export async function toggleOwnReaction(
  input: ToggleOwnReactionInput,
): Promise<ReactionOutcome> {
  const { store, api, channelId, messageId, emoji } = input;
  const me = store.getState().currentUser?.id ?? null;
  if (me === null) return { applied: false, op: null, error: SIGNED_OUT };
  if (isPlaceholderId(messageId)) {
    return { applied: false, op: null, error: NOT_SENT };
  }

  const mine = readReactions(rowOf(store, channelId, messageId)).some(
    (chip) => chip.emoji === emoji && chip.me,
  );
  const op: 'add' | 'remove' = mine ? 'remove' : 'add';
  const payload: ReactionTogglePayload = {
    channel_id: channelId,
    message_id: messageId,
    user_id: me,
    emoji,
  };
  // Registered BEFORE the optimistic apply: a racing own echo must find the
  // entry, or it would be applied on top of the change already in the store.
  const pending = markPendingOwnToggle(messageId, emoji, op);
  const rollback = (): void => {
    clearPendingOwnToggle(messageId, emoji, pending);
    // The inverse apply restores the chip exactly: the optimistic change set
    // (or cleared) the `me` flag the inverse operation reads.
    if (op === 'add') applyReactionRemove(store, payload);
    else applyReactionAdd(store, payload);
  };

  try {
    if (op === 'add') {
      applyReactionAdd(store, payload);
      await api.addReaction(channelId, messageId, emoji);
    } else {
      applyReactionRemove(store, payload);
      await api.removeReaction(channelId, messageId, emoji);
    }
    return { applied: true, op, error: null };
  } catch (err) {
    rollback();
    const cause = describeCause(err);
    const base = op === 'add' ? ADD_FAILED : REMOVE_FAILED;
    return { applied: false, op, error: cause === '' ? base : `${base} (${cause})` };
  }
}

/** The stored row's current reactions, or an empty set when it is not held. */
function rowOf(store: StateStore, channelId: string, messageId: string): { reactions?: unknown } {
  const item = store
    .getState()
    .messagesByChannel[channelId]?.items.find((candidate) => candidate.id === messageId);
  return (item ?? {}) as { reactions?: unknown };
}
