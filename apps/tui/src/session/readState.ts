/**
 * @cytale/tui — read state: the badge, the acknowledgement, and the unread
 * floor (U10; R22, R22a).
 *
 * ---------------------------------------------------------------------------
 * Why this module exists: the badge a column-one badge exists to show
 * ---------------------------------------------------------------------------
 *
 * The measured bug this unit fixes is not a rendering bug. A badge derived from
 * the messages the client has LOADED is zero for every channel the client has
 * never opened — and a channel the member has never opened is exactly the one a
 * column-one badge exists to surface. Locally accrued unread (`unread_count` in
 * `@cytale/state`) only exists for channels this client has seen gateway
 * traffic on, so the number a member needs most is the number the local store
 * cannot produce.
 *
 * Three facts, each owned by another unit, are what make it fixable here:
 *
 *   * U2 put the server's own count on the wire (`unread_count` on each
 *     READ_STATE_SYNC entry, for EVERY channel the session can see, including
 *     channels with no `read_state` row at all).
 *   * U11 folded that count and the exclusive floor into the store, and taught
 *     `deriveChannelBadge` to prefer the server count when there is no slice.
 *   * U2 also made `POST /channels/{id}/ack` persist the watermark — the
 *     gateway ack fans out without persisting, so the REST route is the only
 *     path that actually moves read state on the server.
 *
 * So this module owns no derivation of its own: `readBadge` delegates to
 * `@cytale/state`'s `deriveChannelBadge`, which is the single reader of the
 * watermark/floor/server-count triple, and `readBoundary` is a projection of
 * the same store. Nothing is fetched, cached, or mirrored here.
 *
 * ---------------------------------------------------------------------------
 * Where the read boundary is captured (approach step 3), and why not in the pane
 * ---------------------------------------------------------------------------
 *
 * `markRead` reads the store AT CALL TIME. The shell calls it from its
 * selection handler — one level up from the message pane — and that is
 * load-bearing, not stylistic: the pane-level shape is recorded as
 * measured-and-blocked upstream (web's `MessagePane` ack effect), because the
 * ack it fires clears the session-local slice before the list has rows, and the
 * landing that follows is destroyed. Capturing the boundary in the handler
 * means the boundary is the newest row the member could actually see when they
 * selected the conversation, and no later write to the store can move it.
 *
 * The boundary is the newest SERVER row in the channel's loaded slice, skipping
 * the `pending_*` optimistic placeholders a send leaves there (they are not
 * message ids on the wire; acking one throws in the gateway client's
 * validation). A channel whose messages have never been loaded has no slice, so
 * the boundary falls back to the channel record's own server-supplied
 * `last_message_id`: that is still the server's fact about the channel, and
 * without it opening a never-loaded channel — the R22a case — could never clear
 * its badge. A channel with neither has nothing to acknowledge, and no request
 * is made.
 *
 * ---------------------------------------------------------------------------
 * Acknowledgement is PERSIST-FIRST, deliberately
 * ---------------------------------------------------------------------------
 *
 * The REST ack is written and AWAITED before anything local changes. The store
 * is cleared only once the server has taken the watermark, so a failed ack (an
 * offline link, a 403, a channel the member just lost access to) leaves the
 * badge exactly where it was rather than optimistically clearing a state the
 * server does not have. The clear itself is `@cytale/state`'s
 * `markChannelRead`, so the watermark's monotonicity and the floor's survival
 * ride the one implementation of both rules.
 *
 * The one field that rule does not reach is `server_unread_count`, which a
 * loaded channel's badge ignores and an unloaded one's badge is made of. A
 * channel with no slice therefore gets the server count zeroed on top — after
 * the same successful ack — or the badge R22a exists for would outlive the
 * acknowledgement that cleared it.
 *
 * ---------------------------------------------------------------------------
 * Marking a message unread is the EXCLUSIVE floor (approach step 4)
 * ---------------------------------------------------------------------------
 *
 * `last_read_id` is inclusive, so it cannot express "this message is unread" —
 * moving the watermark TO the message leaves it read. The floor can:
 * `unread_floor` says this message and everything after it is unread, whatever
 * the watermark claims, and U2 accepts it on the ack route (`unread_floor` in
 * the body) where it is applied in the same request as the watermark it does
 * not contradict.
 *
 * The floor is written with a watermark that is NOT moved backwards: the
 * request carries the current boundary, so marking an old message unread leaves
 * the newer messages read — the state `Cytale.Messages.ReadState` documents as
 * "the floor sits below the watermark".
 *
 * The local write is the one place this module reaches past `@cytale/state`'s
 * exported writers: U11 landed the `unread_floor` FIELD but no floor writer, and
 * the store's own `unreadByChannel` slice is written directly here (the way
 * `reconcile.ts` writes it) so the badge reflects the floor immediately. The
 * right home for that write is a `setUnreadFloor` export in
 * `packages/state/src/unread.ts`; this unit may not edit that package.
 *
 * ---------------------------------------------------------------------------
 * The states this surface has, and the ones it does not
 * ---------------------------------------------------------------------------
 *
 *   * `loading` — the server count arrives on the gateway's session-establishment
 *     sync. Before it lands there is simply no unread entry, so every badge is
 *     absent. That is honest: the client does not yet know of unread work rather
 *     than knowing there is none, and it is why a badge appears on its own a
 *     dispatch instead of through a fetch this module would have to own.
 *   * `empty` — a channel with no messages, or everything read, has no badge.
 *     One rendering (`readBadge === 0`), not two states.
 *   * `error`/`offline` — a transport that rejects. Every write path here
 *     reports the failure as an outcome VALUE and leaves the store untouched,
 *     so the shell can say nothing at all — which is the correct rendering,
 *     because the badge still tells the truth.
 *   * There is no `permission-denied` or `view-only` state of its own: the ack
 *     route enforces the channel gate server-side, and a refusal arrives as a
 *     failed write, which is the same value as any other failure.
 *
 * Mentions are deliberately NOT here: R22 covers badges only, and the plan
 * leaves a mention indicator an open question.
 */
import { isAfter, isSnowflake } from '@cytale/domain';
import type { Snowflake } from '@cytale/protocol';
import { deriveChannelBadge, markChannelRead, type StateStore } from '@cytale/state';

// ---------------------------------------------------------------------------
// The transport (the two REST writes, one route)
// ---------------------------------------------------------------------------

/**
 * What this module needs from `@cytale/api-client`: `POST /channels/{id}/ack`,
 * in the two shapes the route accepts.
 *
 * `ack` is the watermark write — the body `{ message_ids: [messageId] }` the
 * route requires (`CytaleWeb.MessageController.ack/2` matches a non-empty list
 * and 400s otherwise; the singular `message_id` this api-client method used to
 * send failed every call).
 *
 * `setUnreadFloor` is the same route carrying the floor, and it is OPTIONAL
 * because no shipped method can send that body yet: `CytaleApiClient`'s
 * `ackChannel(channelId, messageId)` cannot, and its `Http` layer is private. A
 * transport without it is not a broken transport — `markUnread` reports
 * `unsupported` and writes nothing, so the client never shows a floor the
 * server does not have.
 */
export interface ReadStateTransport {
  /** Persist the watermark (`POST /channels/{id}/ack`). */
  ack(channelId: string, messageId: string): Promise<void>;
  /**
   * Persist the exclusive floor on the same route. `message_ids` must be
   * non-empty (the route's own guard) and carries the watermark the floor sits
   * below; `unread_floor` is the message the member marked.
   */
  setUnreadFloor?(
    channelId: string,
    body: { readonly message_ids: readonly string[]; readonly unread_floor: string },
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * What a mark-read did. Every branch is a distinct fact, and only `read`
 * changed anything — the rest exist so a caller never has to guess why a badge
 * did or did not clear.
 */
export type MarkReadOutcome =
  /** The server took the watermark and the store was cleared. */
  | { readonly status: 'read'; readonly channelId: string; readonly boundary: Snowflake }
  /** Nothing to clear: the badge was already zero, so no request was made. */
  | { readonly status: 'already-read'; readonly channelId: string; readonly boundary: Snowflake }
  /** No message to acknowledge: no slice and no `last_message_id`. Nothing sent. */
  | { readonly status: 'no-boundary'; readonly channelId: string }
  /** The write failed (offline, refused, …). The badge is UNCHANGED. */
  | {
      readonly status: 'failed';
      readonly channelId: string;
      readonly boundary: Snowflake;
      readonly error: unknown;
    };

/** What a mark-unread did. Only `unread` changed anything. */
export type MarkUnreadOutcome =
  /** The server took the floor and the store reflects it. */
  | { readonly status: 'unread'; readonly channelId: string; readonly floor: Snowflake }
  /** The transport cannot carry a floor body (see `ReadStateTransport`). */
  | { readonly status: 'unsupported'; readonly channelId: string; readonly floor: Snowflake }
  /** The id is not a server message id (an optimistic placeholder). Not sent. */
  | { readonly status: 'not-a-message'; readonly channelId: string; readonly floor: Snowflake }
  /** The write failed. The floor the server holds is untouched. */
  | {
      readonly status: 'failed';
      readonly channelId: string;
      readonly floor: Snowflake;
      readonly error: unknown;
    };

// ---------------------------------------------------------------------------
// The store projections (the only readers of read state)
// ---------------------------------------------------------------------------

/**
 * A channel's unread badge, from the server-supplied state.
 *
 * Delegation, on purpose: `deriveChannelBadge` is `@cytale/state`'s single
 * reader of the watermark + floor + server-count triple, and the three clients
 * must not derive three different numbers from the same fields. This function
 * exists so the terminal has ONE name for the badge and the "it comes from the
 * server" rule has one home.
 */
export function readBadge(store: StateStore, channelId: string): number {
  return deriveChannelBadge(store, channelId);
}

/**
 * The read boundary for a channel: the newest SERVER message id this client can
 * see for it, or null when there is nothing to acknowledge.
 *
 * The loaded slice wins (it is what the member is looking at), skipping
 * `pending_*` placeholders; a channel with no slice falls back to the channel
 * record's `last_message_id`, which is the server's own fact and the only
 * boundary an unloaded channel has.
 */
export function readBoundary(store: StateStore, channelId: string): Snowflake | null {
  const state = store.getState();
  const slice = state.messagesByChannel[channelId];
  const newest = slice?.items.find((row) => isSnowflake(row.id));
  if (newest !== undefined) return newest.id;

  const record = state.channels[channelId]?.last_message_id;
  return isSnowflake(record) ? record : null;
}

// ---------------------------------------------------------------------------
// The controller
// ---------------------------------------------------------------------------

export interface ReadStateOptions {
  /** The shared store the shell renders and the gateway fills. */
  readonly store: StateStore;
  /** The REST writes. Structural, so the api-client and a test fake both fit. */
  readonly transport: ReadStateTransport;
}

export interface ReadState {
  /** The channel's badge, from the server's unread state (R22a). */
  badge(channelId: string): number;
  /** The boundary `markRead` would acknowledge right now. */
  boundary(channelId: string): Snowflake | null;
  /**
   * Acknowledge a conversation. Called from the SELECTION HANDLER (one level up
   * from the message pane, see the header) and from the `r` binding; the
   * boundary is whatever the store holds at THIS moment.
   */
  markRead(channelId: string): Promise<MarkReadOutcome>;
  /** Mark one message unread, via the exclusive floor. */
  markUnread(channelId: string, messageId: string): Promise<MarkUnreadOutcome>;
}

/**
 * Clear the local unread entry for a channel the server has acknowledged.
 *
 * `markChannelRead` owns the watermark rule (never regress) and carries the
 * entry through so a hand-set floor survives an ack — the same rule the server's
 * own ack path applies by skipping the floor column.
 */
function clearLocalRead(store: StateStore, channelId: string, boundary: Snowflake): void {
  markChannelRead(store, channelId, boundary);

  // `markChannelRead` does not touch the server's count, and for a channel with
  // NO slice that count is the whole badge (R22a). Zeroing it is not optimism:
  // the ack already landed, so this is the server's new value echoed, and the
  // next read-state sync re-reports it. A loaded channel is left alone — its
  // badge is derived from the slice, which the watermark above just cleared.
  if (store.getState().messagesByChannel[channelId] !== undefined) return;
  store.setState((state) => {
    const entry = state.unreadByChannel[channelId];
    if (entry === undefined || entry.server_unread_count == null) return {};
    return {
      unreadByChannel: { ...state.unreadByChannel, [channelId]: { ...entry, server_unread_count: 0 } },
    };
  });
}

/**
 * Write the floor into the store, leaving the watermark, the counts, and the
 * server's count exactly as they were (a mark-unread is not a read).
 */
function setFloorLocally(store: StateStore, channelId: string, floor: Snowflake): void {
  store.setState((state) => {
    const current = state.unreadByChannel[channelId] ?? { last_read_id: null, unread_count: 0, mention_count: 0 };
    return {
      unreadByChannel: { ...state.unreadByChannel, [channelId]: { ...current, unread_floor: floor } },
    };
  });
}

/**
 * The read-state controller the shell and its host share.
 *
 * Stateless beyond its two dependencies: every call reads the store and the
 * transport, so a reconnect (which replaces the store's unread slices) and a
 * renewed token (which the api-client's own provider republishes) need no
 * rebinding here.
 */
export function createReadState(options: ReadStateOptions): ReadState {
  const { store, transport } = options;

  return {
    badge: (channelId) => readBadge(store, channelId),
    boundary: (channelId) => readBoundary(store, channelId),

    async markRead(channelId) {
      const boundary = readBoundary(store, channelId);
      if (boundary === null) return { status: 'no-boundary', channelId };

      // Nothing to clear and nothing to tell the server: an ack here would be a
      // write per keystroke across a list the member has already read. (A
      // successfully acknowledged channel is this case immediately.)
      if (readBadge(store, channelId) === 0) return { status: 'already-read', channelId, boundary };

      try {
        await transport.ack(channelId, boundary);
      } catch (error) {
        // The server did not take the watermark, so nothing local changes: the
        // badge stays exactly as it was.
        return { status: 'failed', channelId, boundary, error };
      }

      clearLocalRead(store, channelId, boundary);
      return { status: 'read', channelId, boundary };
    },

    async markUnread(channelId, messageId) {
      if (!isSnowflake(messageId)) return { status: 'not-a-message', channelId, floor: messageId };

      const setUnreadFloor = transport.setUnreadFloor;
      if (setUnreadFloor === undefined) return { status: 'unsupported', channelId, floor: messageId };

      // The watermark travels with the floor and is not moved backwards: the
      // newest row this client can see when it is not newer than the marked
      // message, else the marked message itself (the route requires a non-empty
      // `message_ids`, and no boundary means there is nothing newer to keep
      // read).
      const boundary = readBoundary(store, channelId);
      const watermark = boundary !== null && isAfter(boundary, messageId) ? boundary : messageId;

      try {
        await setUnreadFloor(channelId, { message_ids: [watermark], unread_floor: messageId });
      } catch (error) {
        // No floor the server does not have: the local state is left as the
        // last sync reported it.
        return { status: 'failed', channelId, floor: messageId, error };
      }

      setFloorLocally(store, channelId, messageId);
      return { status: 'unread', channelId, floor: messageId };
    },
  };
}
