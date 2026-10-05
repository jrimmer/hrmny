/**
 * Cytale gateway event catalog — payload interfaces, the event-name union,
 * the runtime registry, and the typed event-name -> payload mapping used for
 * exhaustive dispatch.
 *
 * Dispatch frames (op 0) carry `t: EventName`; consumers switch on `t` and
 * get a precise payload type via `EventNameToPayload` / `EventPayloadMap`.
 * Client->server command payloads and lifecycle control payloads live in
 * payloads.ts and are reused here.
 */

import {
  isSnowflake,
  type GatewayServerTypingStartPayload,
  type CallSourceKind,
  type MessageAckServerAck,
  type Snowflake,
} from './payloads.js';

// ---------------------------------------------------------------------------
// Event payload interfaces
// ---------------------------------------------------------------------------

export type MessageCreate = {
  id: Snowflake;
  channel_id: Snowflake;
  /** Present when the message lives inside a thread; null for channel messages. */
  thread_id: Snowflake | null;
  /** Inline-reply reference (Discord message_reference); absent on old rows. */
  reply_to_id?: Snowflake | null;
  /** Receiver-side snapshot of the referenced message (context-line render
   * without a fetch); absent when reply_to_id is null or the original is
   * gone. */
  referenced?: {
    message_id: Snowflake;
    author_id: Snowflake;
    author_username: string | null;
    content: string;
  } | null;
  author_id: Snowflake;
  content: string;
  created_at: string;
  edited_at: string | null;
  /** Whether this message's `@everyone`/`@here` was allowed to notify (the
   * author held MENTION_EVERYONE — Discord's field). Carried on the create
   * path only; absent on history reads and edits. */
  mention_everyone?: boolean;
  /** The users this message may notify directly — present ONLY when the
   * sender narrowed its mentions with Discord's `allowed_mentions` (absent =
   * every `<@id>` in the content, plus the replied-to author). Includes the
   * replied-to author when `replied_user` allowed it. Create path only, like
   * `mention_everyone`: absent on history reads and edits. */
  mention_user_ids?: Snowflake[];
  /** Action rows (components plan, R2): present only on machine-authored
   * messages that stored components — absent otherwise (the embeds
   * precedent). Verbatim bot JSON, platform-opaque (KD1). */
  components?: MessageActionRow[];
  /** Embeds (bots plan U10): present only when the message stored some —
   * absent otherwise. Verbatim bot/webhook JSON, store-and-forward, except
   * that an EXTERNAL media source gains Discord's proxy key, minted per
   * render by the server's media proxy: `image.proxy_url`,
   * `thumbnail.proxy_url`, `author.proxy_icon_url`, `footer.proxy_icon_url`
   * (a same-origin `/api/v1/media/proxy?…` path). Clients load the proxy key,
   * never the source URL — the app's CSP admits no third-party image. */
  embeds?: Record<string, unknown>[];
  /** The Markdown images in `content` (`![alt](url)`), as a map from each
   * external source URL — exactly as the parse's image node carries it — to
   * its signed same-origin proxy URL. Present only when the body has one;
   * minted per render (it expires like an attachment URL, so a refetched
   * message carries fresh ones). An image whose source has no entry renders
   * as a plain link. */
  content_proxy_urls?: Record<string, string>;
  /** The send's client key (Discord's MESSAGE_CREATE `nonce`): the body
   * `nonce` or Idempotency-Key the author's POST carried, echoed on the
   * create's own 201 and dispatch so the author's client settles its pending
   * row by it exactly. Absent when the send carried none, and on history
   * reads and edits (it is never stored). Delivered to every recipient; only
   * the author's client has a pending row it can match. */
  nonce?: string;
};

export type MessageUpdate = {
  id: Snowflake;
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  content: string;
  edited_at: string | null;
  /** The message's CURRENT action rows (components plan, R2 — the
   * approval-card flip); present whenever the message has any, absent when
   * it has none. A replace-to-empty rides `[]` (clears the card). */
  components?: MessageActionRow[];
  /** The message's CURRENT embeds on a card flip (type-7 / `@original`
   * edits carry the key always, `[]` when cleared); absent on a plain
   * content edit of a message without embeds — absent means unchanged. */
  embeds?: Record<string, unknown>[];
  /** As `MessageCreate.content_proxy_urls`, for the CURRENT content: an edit
   * re-renders it, and its absence means the edited body has no external
   * Markdown image. */
  content_proxy_urls?: Record<string, string>;
};

/**
 * A stored top-level component row (components plan, R1): the platform
 * validates a shallow shape (`type: 1` action row wrapping a `components`
 * array of buttons/selects) and routes the JSON verbatim — `custom_id` is
 * the bot's namespace, never interpreted (KD1). Unknown keys ride untouched.
 */
export type MessageActionRow = {
  type: number;
  components?: unknown[];
} & Record<string, unknown>;

/** Deletion is terminal; only identity fields ride the wire. */
export type MessageDelete = {
  id: Snowflake;
  channel_id: Snowflake;
  thread_id: Snowflake | null;
};

/**
 * A principal reacted to a message (Unicode emoji). `emoji` is the raw
 * Unicode emoji text (e.g. 👍) — Cytale has no custom-emoji system, so the
 * compat wire's Discord `emoji.id` is always null. Emitted on state-changing
 * adds only: an idempotent re-add emits nothing.
 */
export type MessageReactionAdd = {
  channel_id: Snowflake;
  message_id: Snowflake;
  user_id: Snowflake;
  emoji: string;
};

/** A principal's reaction was removed (own remove or a manage_messages clear). */
export type MessageReactionRemove = {
  channel_id: Snowflake;
  message_id: Snowflake;
  user_id: Snowflake;
  emoji: string;
};

/** Every reaction left a message (manage_messages clear-all; identity fields only). */
export type MessageReactionRemoveAll = {
  channel_id: Snowflake;
  message_id: Snowflake;
};

/**
 * Read acknowledgement fan-out. Shape mirrors the server acknowledgement of
 * the client->server MESSAGE_ACK command (see MessageAckServerAck).
 */
export type MessageAck = MessageAckServerAck;

/**
 * A channel was created in a workspace. The payload is the same object the
 * REST create/read path emits (`ChannelController.channel_json/1`), because a
 * reader must not have to render two different readings of one row.
 *
 * `type` and `parent_id` are the two fields a client CANNOT otherwise derive —
 * every gateway Channel event historically omitted `type` entirely, so a
 * client had no choice but to treat every new channel as text. A category
 * created mid-session therefore rendered as a text channel, and a channel made
 * inside one lost its grouping, until a reload replaced the row from REST
 * (fixed 2026-09-15). `type` is the server's numeric column (0 = text,
 * 1 = category); the api-client normalizes it on REST reads, and the gateway
 * reader normalizes it in `applyGatewayEvent`.
 */
export type ChannelCreate = {
  id: Snowflake;
  workspace_id: Snowflake | null;
  name: string;
  /** The server's channel-type column: 0 = text, 1 = category. */
  type?: 0 | 1;
  /** The category this channel is filed under; null when ungrouped. */
  parent_id?: Snowflake | null;
  topic?: string | null;
  position: number;
  last_message_id?: Snowflake | null;
  created_at: string;
};

/** Partial update: absent keys are unchanged; explicit null clears (where allowed). */
export type ChannelUpdate = {
  id: Snowflake;
  name?: string;
  topic?: string | null;
  position?: number;
};

export type ChannelDelete = {
  id: Snowflake;
  workspace_id?: Snowflake;
};

/**
 * Profile mutation broadcast (avatar render pass): a display-name/avatar
 * write fans out to every workspace + DM the user touches. Public user
 * shape only — never email.
 *
 * One shape for people and machines: `username` is always the handle (the
 * @tag); a bot/agent's label rides `display_name`, as a person's display
 * name does. A reducer must not clobber a field the event does not carry.
 */
export type UserUpdate = {
  id: Snowflake;
  /** The account's handle — never a display label. */
  username: string;
  display_name?: string | null;
  avatar_url?: string | null;
};

export type ThreadCreate = {
  id: Snowflake;
  channel_id: Snowflake;
  /**
   * The seed message the thread hangs off; `null` for a standalone thread.
   * What lets a client that did NOT create the thread (a bot, a webhook,
   * another person, another device) draw the reply indicator on the seed.
   * Optional because a server that predates it omits it — an absent key
   * means "not stated", never "no anchor", so a reducer must not let it
   * erase an anchor it already holds.
   */
  parent_message_id?: Snowflake | null;
  name: string;
  created_by: Snowflake;
  created_at: string;
};

export type ThreadUpdate = {
  id: Snowflake;
  /**
   * Parent channel. Load-bearing on the wire, not just informative: the
   * server's fan-out routes a publish by the channel the PAYLOAD names, so a
   * payload without one is delivered to nobody (see Threads.Events.thread_update/2).
   */
  channel_id: Snowflake;
  /**
   * The thread's seed message, restated (it never changes) so a client that
   * missed the create still learns where the indicator goes. Same absent-key
   * rule as ThreadCreate's.
   */
  parent_message_id?: Snowflake | null;
  name?: string;
  archived?: boolean;
};

export type ThreadDelete = {
  id: Snowflake;
  /**
   * Parent channel. Load-bearing on the wire, not just informative: the
   * server's fan-out routes a publish by the channel the PAYLOAD names, so a
   * payload without one is delivered to nobody (see Threads.Events.thread_delete/1,
   * which always emits it).
   */
  channel_id: Snowflake;
};

export type ThreadMemberAdd = {
  thread_id: Snowflake;
  user_id: Snowflake;
};

export type ThreadMemberRemove = {
  thread_id: Snowflake;
  user_id: Snowflake;
};

/** Bulk sync of a workspace's thread list (e.g. after reconnect fallback). */
export type ThreadListSync = {
  workspace_id: Snowflake;
  threads: ThreadCreate[];
};

export type ThreadMessageCreate = {
  id: Snowflake;
  /**
   * Parent channel. Load-bearing on the wire, not just informative: the
   * server's fan-out routes a publish by the channel the PAYLOAD names, so a
   * payload without one is delivered to nobody (see Threads.Events.thread_message_create/1).
   * The wire has always carried it — Messages.Message.to_wire/1, the production
   * producer, emits it — only this type omitted it.
   */
  channel_id: Snowflake;
  thread_id: Snowflake;
  /** Inline-reply reference, exactly as `MessageCreate` declares it. The base
   * made `Messages.Message.to_wire/1` send it for thread messages too so a live
   * reply shows its reply bar without a refetch; the type had not caught up, so
   * the manifest gate reported the field as an untyped additive one. */
  reply_to_id?: Snowflake | null;
  /** The replied-to message's snapshot, as `MessageCreate` carries it: a thread
   * reply to a message in the same thread renders its context line live. */
  referenced?: MessageCreate['referenced'];
  /** As `MessageCreate.mention_everyone`. */
  mention_everyone?: boolean;
  /** As `MessageCreate.mention_user_ids`. */
  mention_user_ids?: Snowflake[];
  author_id: Snowflake;
  content: string;
  created_at: string;
  edited_at: string | null;
  /** Embeds, as `MessageCreate.embeds`: present only when the reply stored
   * some (a bot's card posted into a thread). */
  embeds?: MessageCreate['embeds'];
  /** As `MessageCreate.content_proxy_urls`. */
  content_proxy_urls?: MessageCreate['content_proxy_urls'];
  /** Action rows, as `MessageCreate.components` — a bot's card in a thread
   * is the channel card, field for field. */
  components?: MessageActionRow[];
  /** The send's client key, as `MessageCreate.nonce`. */
  nonce?: string;
};

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';

export type PresenceUpdate = {
  user_id: Snowflake;
  status: PresenceStatus;
  last_seen_at: string;
  /**
   * Owning workspace of THIS copy (the announce fans one per membership).
   * Additive (bots plan B-3): native clients may ignore it; the compat
   * gateway translation reads it as the Discord guild_id.
   */
  workspace_id?: Snowflake;
};

/**
 * Server fan-out variant of the typing signal (client->server half lives in
 * payloads.ts as GatewayClientTypingStartPayload). Server-throttled at
 * ~1/sec/user/channel before emission.
 */
export type TypingStart = {
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  user_id: Snowflake;
  /** Unix epoch milliseconds when the signal was registered. */
  timestamp: number;
};

export type Ready = {
  v: number;
  session_id: string;
  /**
   * Single-use resume secret: issued at session establishment, invalidated on
   * successful Resume use, bound to the authenticated identity (U10).
   */
  resume_token: string;
  heartbeat_interval: number;
  user: { id: Snowflake; username: string };
  /**
   * The server's media-plane master switch (ticket #124): voice calls, video
   * and screen share. false → the client hides Start-call affordances and
   * renders an honest "calls are off on this server" state; the real gate is
   * server-side (call start/join + the ICE mint refuse regardless). Additive
   * and OPTIONAL: servers predating the switch omit it, and an absent field
   * reads as enabled (that server has no kill switch — permissions govern).
   */
  media_enabled?: boolean;
  /**
   * The session's entity roster (lane D #5), native sessions only. The
   * handshake already reads every workspace and its channels to join the
   * fan-out routes; READY hands those rows over in the REST readers' own wire
   * shapes, so a client paints its sidebar without a REST waterfall.
   *
   * All three are OPTIONAL: an older server omits them, and a client must
   * read absence as "not provided" (fall back to REST), never as "none".
   * `dm_channels: null` is the server saying the DM read failed — same
   * fallback.
   */
  workspaces?: ReadyWorkspace[];
  channels?: ReadyChannel[];
  dm_channels?: ReadyDmChannel[] | null;
};

/** One READY workspace row — `GET /users/@me/workspaces`'s shape. */
export type ReadyWorkspace = {
  id: Snowflake;
  name: string;
  owner_id: Snowflake | null;
  created_at: string;
  icon_url?: string | null;
};

/**
 * One READY channel row — `GET /workspaces/{id}/channels`'s shape. `type` is
 * the server's raw column (a client normalizes it the way its REST boundary
 * does).
 */
export type ReadyChannel = {
  id: Snowflake;
  workspace_id: Snowflake | null;
  name: string;
  type: unknown;
  parent_id?: Snowflake | null;
  topic?: string | null;
  position: number;
  last_message_id?: Snowflake | null;
};

/** One READY DM row — `GET /users/@me/channels`'s shape. */
export type ReadyDmChannel = {
  id: Snowflake;
  user_ids: Snowflake[];
  recipients: {
    id: Snowflake;
    username: string | null;
    display_name?: string | null;
    avatar_url?: string | null;
  }[];
  created_at?: string | null;
  last_message_id?: Snowflake | null;
};

export type Resumed = {
  replayed_events: number;
  heartbeat_interval: number;
  /**
   * The session's NEXT single-use resume token — the one presented was
   * consumed by this Resume. Optional: older servers sent none.
   */
  resume_token?: string;
};

export type RoleCreate = {
  id: Snowflake;
  workspace_id: Snowflake;
  name: string;
  /** Permission bitfield serialized as a decimal string (preserves >53 bits). */
  permissions: string;
  position: number;
  color: number | null;
};

export type RoleUpdate = {
  id: Snowflake;
  name?: string;
  permissions?: string;
  position?: number;
  color?: number | null;
};

export type RoleDelete = {
  id: Snowflake;
  workspace_id?: Snowflake;
};

/**
 * A member joined — a person through an invite, or a machine principal through
 * its owner's GRANT (membership by association). The payload is the people
 * page's roster row plus `workspace_id`; every key past the original three is
 * additive (absent on older servers), and it is what lets a client name and
 * badge a bot granted after it hydrated.
 */
export type MemberAdd = {
  workspace_id: Snowflake;
  /** `display_name`: the account's display name (#168; a machine's label). */
  user: { id: Snowflake; username: string; display_name?: string | null; avatar_url?: string | null };
  joined_at: string;
  /** The workspace nickname, shown before the display name (a machine's label). */
  nickname?: string | null;
  roles?: Snowflake[];
  /** The roster row's principal kind — the badge. */
  kind?: 'human' | 'bot' | 'agent' | 'webhook';
  /** Machine principals only: the owning person. */
  parent_user_id?: Snowflake;
  /** Bots/agents only: who it will hold a DM with. */
  dm_support?: 'humans' | 'everyone' | 'none';
};

/**
 * A member's workspace nickname changed (#169) — a person's or a bot's, by
 * themselves (CHANGE_NICKNAME) or by a member with MANAGE_NICKNAMES.
 * `nickname` is null when cleared. Clients store it per workspace; the name
 * shown is the nickname, else the account's display name, else the username.
 */
export type MemberUpdate = {
  workspace_id: Snowflake;
  user_id: Snowflake;
  nickname: string | null;
};

export type MemberRemove = {
  workspace_id: Snowflake;
  user_id: Snowflake;
};

export type AccountDelete = {
  user_id: Snowflake;
  deleted_at: string;
};

/**
 * A human invoked an application command (bots plan U8) or clicked a message
 * component (components plan U2 — `kind: 'component'`). Fanned to the BOT's
 * own sessions only (user-keyed, application-addressed) — the invoking human
 * gets the REST 202, then `InteractionSuccess` when the bot answers. `token`
 * is the short-lived callback credential
 * for POST /api/v10/interactions/{id}/{token}/callback.
 *
 * Command invocations carry `command` + `options`; component clicks carry the
 * component fields (`custom_id`, `component_type`, `values?`, `message_id`,
 * `message`, `app_permissions`) and OMIT `command`/`options`. DM-channel
 * component clicks omit `workspace_id`.
 */
export type InteractionCreate = {
  id: Snowflake;
  token: string;
  application_id: Snowflake;
  /** Discriminator (components plan U2, KTD9): 'component' marks a type-3
   * MESSAGE_COMPONENT interaction, 'modal_submit' a type-5 MODAL_SUBMIT
   * (#30); absent for command invocations. */
  kind?: 'component' | 'modal_submit';
  /** Command invocations only. */
  command?: { id: Snowflake; name: string };
  /** Flat name → value map exactly as the invoker supplied it (commands only). */
  options?: Record<string, unknown>;
  channel_id: Snowflake;
  /** Owning workspace; ABSENT on DM-channel component clicks. */
  workspace_id?: Snowflake;
  /** Component clicks (and modal submits opened from one) on a THREAD
   * message: the thread's id. `channel_id` stays the parent channel; the
   * compat dialect renders this id as Discord's `channel_id`. */
  thread_id?: Snowflake;
  user: { id: Snowflake; username: string };
  /** Component clicks only: the clicked message's id. */
  message_id?: Snowflake;
  /** Component clicks only: the bot's opaque control namespace (1–100 chars). */
  custom_id?: string;
  /** Component clicks only: 2 (button) | 3 (string select). */
  component_type?: number;
  /** String-select clicks only: the chosen stored option values. */
  values?: string[];
  /** Component clicks only: the owning bot's resolved channel bitfield
   * (integer; DM clicks carry the full participation bitfield). */
  app_permissions?: number;
  /** Component clicks only: the clicked message row snapshot (bot-authored,
   * components joined) — the source of the compat wire's `d.message`. Also on
   * a modal submit whose modal was opened from a component click. */
  message?: Record<string, unknown>;
  /** Modal submits only (#30): one action row per text input, in the modal's
   * order, each carrying the submitted value. (`custom_id` above is the
   * MODAL's.) */
  components?: ModalAnswerRow[];
};

/** A text input as a bot defines it in a modal (#30, Discord component type 4). */
export type ModalTextInput = {
  type: 4;
  custom_id: string;
  /** 1 = short (single line), 2 = paragraph. */
  style: 1 | 2;
  label: string;
  min_length: number;
  max_length: number;
  required: boolean;
  /** Prefill. */
  value?: string;
  placeholder?: string;
};

/** One submitted answer row of a MODAL_SUBMIT. */
export type ModalAnswerRow = {
  type: 1;
  components: [{ type: 4; custom_id: string; value: string }];
};

/**
 * A bot answered one of THIS user's interactions with a modal (callback
 * type 9, #30). Delivered to the invoking user's sessions only; the session
 * that holds `interaction_id` (from its click's 202) opens it. Submit with
 * `POST /interactions {kind: "modal_submit", interaction_id, custom_id,
 * components}` — once, within the interaction's 15-minute life.
 */
export type InteractionModal = {
  interaction_id: Snowflake;
  application_id: Snowflake;
  channel_id: Snowflake;
  custom_id: string;
  title: string;
  /** 1–5 rows, each exactly one text input — normalized by the server
   * (defaults filled, unknown keys dropped). */
  components: { type: 1; components: [ModalTextInput] }[];
};

/**
 * The bot ANSWERED one of this user's interactions (Discord's
 * INTERACTION_SUCCESS). Delivered to the invoking user's sessions only, once
 * per interaction, at the bot's first answer of any kind: callback type 4
 * (reply), 5 (deferred reply), 6 (deferred update), 7 (update the message),
 * 9 (modal), or a followup / `@original` edit made without an initial
 * response. A client resolves a pending click or command by `nonce` (the one
 * its POST sent — known before the 202, which this can outrun) or by
 * `interaction_id`.
 */
export type InteractionSuccess = {
  interaction_id: Snowflake;
  /** The `nonce` the invoking POST sent; null when it sent none. */
  nonce: string | null;
  application_id: Snowflake;
  /** Where the interaction happened (the parent channel for a thread card). */
  channel_id: Snowflake;
  /** The thread, for a card inside one; null otherwise. */
  thread_id: Snowflake | null;
  /** The clicked message (component clicks and modals opened from one);
   * null for a command. */
  message_id: Snowflake | null;
  /** The clicked control's custom_id (a modal submit's: the modal's); null
   * for a command. */
  custom_id: string | null;
  /** How the bot answered: the callback type (4, 5, 6, 7, 9); 4 for a
   * followup or a materialized deferred reply, 7 for an `@original` edit. */
  response_type: number;
};

// ---------------------------------------------------------------------------
// Voice-call events (calls plan U1 — KTD3: they ride the main gateway as
// ordinary sequenced dispatches; there is no dedicated voice websocket)
// ---------------------------------------------------------------------------

/**
 * One published media source on a participant's leg (calls V2 plan R3/KTD1):
 * the roster's source-state, so late joiners and non-offer moments have
 * attribution without parsing SDP. `since` is the publish time (ISO 8601) —
 * the recency input for stage-follows-most-recent-sharer (VM4).
 */
export type CallSourceState = {
  source: CallSourceKind;
  since?: string;
};

/**
 * Roster member projection shared by CALL_SYNC entries (and the REST live
 * call). Mute/deafen are the server-visible voice states; speaking never
 * rides the gateway (AM5 — clients compute it locally from received audio).
 *
 * V2 additive (calls V2 plan U2): `sources` lists the participant's live
 * published sources; ABSENT or empty means audio-only (no camera, screen,
 * or share-audio tracks). Microphone audio is not a source — it is the V1
 * call itself.
 */
export type CallParticipant = {
  user_id: Snowflake;
  mute: boolean;
  deafen: boolean;
  /** Live published sources (V2); absent/empty = audio-only participant. */
  sources?: CallSourceState[];
};

/** A live channel call inside CALL_SYNC: roster + the standing call-log thread. */
export type CallSyncEntry = {
  channel_id: Snowflake;
  call_id: Snowflake;
  /** The channel's standing call-log thread (created on first call, reused). */
  thread_id: Snowflake;
  participants: CallParticipant[];
};

/** A live DM call inside CALL_SYNC: no thread, no durable artifact (R11). */
export type CallSyncDmEntry = {
  channel_id: Snowflake;
  call_id: Snowflake;
  participants: CallParticipant[];
};

/**
 * Every CALL_UPDATE leg state. The exhaustive runtime list mirrors the
 * `CallUpdateState` union exactly (asserted in tests) so dispatchers can
 * switch exhaustively and reject unknown values. The six `*_on`/`*_off`
 * values are V2 additive (calls V2 plan U2): per-source publish-state
 * transitions, paired with the `source?` field on the same event.
 */
export const CALL_UPDATE_STATES = [
  'joined',
  'left',
  'muted',
  'unmuted',
  'deafened',
  'undeafened',
  'displaced',
  'forced_leave',
  'camera_on',
  'camera_off',
  'screen_on',
  'screen_off',
  'screen_audio_on',
  'screen_audio_off',
] as const;

export type CallUpdateState = (typeof CALL_UPDATE_STATES)[number];

/** True iff `value` is a defined CALL_UPDATE leg state. */
export function isCallUpdateState(value: unknown): value is CallUpdateState {
  return (
    typeof value === 'string' &&
    (CALL_UPDATE_STATES as readonly string[]).includes(value)
  );
}

/** Why a call ended: ordinary empty-sweep expiry (`last_left`), or crash-recovery adoption / boot sweep (`swept`). */
export const CALL_END_REASONS = ['last_left', 'swept'] as const;

export type CallEndReason = (typeof CALL_END_REASONS)[number];

/** True iff `value` is a defined CALL_END reason. */
export function isCallEndReason(value: unknown): value is CallEndReason {
  return (
    typeof value === 'string' &&
    (CALL_END_REASONS as readonly string[]).includes(value)
  );
}

/**
 * A call started in a channel. Channel-keyed with the visibility filter
 * (compat sessions never receive it — the compat wire stays voice-free);
 * DM calls fan out to both participants' user keys with `thread_id: null`
 * (DM rooms skip the call log, R11).
 */
export type CallStart = {
  channel_id: Snowflake;
  call_id: Snowflake;
  /** Standing call-log thread for channel calls; null on DM calls. */
  thread_id: Snowflake | null;
  started_by: Snowflake;
  started_at: string;
};

/**
 * One voice-leg transition inside a live call. Channel-keyed with the
 * visibility filter (user keys on DM calls). `leg` is the target session
 * discriminator (AM8: one voice state per user per call) — each device
 * attributes joined/displaced/forced_leave against its own leg.
 *
 * V2 additive (calls V2 plan U2): the six source states
 * (`camera_on`…`screen_audio_off`) carry `source` naming the affected
 * source; it is absent on every V1 state.
 */
export type CallUpdate = {
  channel_id: Snowflake;
  call_id: Snowflake;
  user_id: Snowflake;
  /** Opaque session-leg discriminator of the affected leg (AM8). */
  leg: string;
  state: CallUpdateState;
  /** The affected published source (V2 source states only; absent on V1 states). */
  source?: CallSourceKind;
};

/**
 * A call ended terminally. Channel-keyed with the visibility filter (user
 * keys on DM calls). `last_left` is the ordinary empty-sweep expiry after
 * natural emptiness; `swept` marks crash-recovery adoption or the boot
 * sweep (orphaned-row cleanup).
 */
export type CallEnd = {
  channel_id: Snowflake;
  call_id: Snowflake;
  reason: CallEndReason;
  ended_at: string;
};

/**
 * Per-recipient roster backfill, emitted at session establishment
 * (Identify) and after Resume routing. User-keyed. `calls` is filtered per
 * recipient — a live channel call is included only if the recipient's
 * live-resolved visible set contains the channel; `dm_calls` carries the
 * user's live DM calls. Both arrays may be empty.
 */
export type CallSync = {
  calls: CallSyncEntry[];
  dm_calls: CallSyncDmEntry[];
};

/**
 * One channel's read state, as the server holds it.
 *
 * `last_read_id` is the INCLUSIVE watermark (this message and everything
 * before it is read); `unread_floor` is its EXCLUSIVE counterpart (this
 * message and everything after it is unread), which is how "mark this unread"
 * survives an acknowledgement that would otherwise claim it was read.
 *
 * `unread_count` is the server's own count of unread messages for the channel
 * (terminal plan U2, R22a) — the only signal a client has for a channel it has
 * loaded nothing for, where a locally accrued count cannot exist. It is a
 * number for every channel this session can see, INCLUDING a channel the
 * member has never acknowledged: `read_state` has no row for that channel, so
 * it comes back with a null watermark, a null floor and a count covering the
 * server's bounded window (`Cytale.Messages.ReadState` documents the window,
 * the cap, and the rules the count follows).
 *
 * Absent or `null` means the count could not be read — never "zero". A client
 * must treat either as "not reported" and fall back to its own state rather
 * than clearing a badge on a storage blip. The field is optional so a producer
 * that predates it (or a client fixture) stays valid; this server always sends
 * the key.
 */
export type ReadStateSyncEntry = {
  channel_id: Snowflake;
  last_read_id: Snowflake | null;
  unread_floor: Snowflake | null;
  unread_count?: number | null;
  /**
   * The member's open mentions in this channel's timeline ABOVE the read
   * position (lane D #2) — the durable "@" half of the badge, so a reload no
   * longer zeroes it. Same absent/null contract as `unread_count`: "not
   * reported", never zero.
   */
  mention_count?: number | null;
};

/**
 * Session-start read state (notifications plan U1), sent on Identify and on
 * Resume — the cold-start half of what MESSAGE_ACK does live. Without it a
 * reconnecting client starts empty and re-shows what the member has already
 * read.
 *
 * Entries cover the SESSION-VISIBLE channel set rather than only the channels
 * with stored read state, so the channels a member has never opened are
 * reported with their counts (terminal plan U2, R22a). A channel this session
 * cannot see is absent rather than zeroed.
 */
export type ReadStateSync = {
  channels: ReadStateSyncEntry[];
};

/**
 * The server moved one channel's read state that this client did not move
 * itself (#54): a fired reminder (the owner's "Remind me…" came due — the
 * floor now makes the marked message unread), or a floor set/cleared on
 * another of the member's devices. User-addressed; ONE channel entry in the
 * ReadStateSync entry shape, and AUTHORITATIVE for that channel — unlike the
 * session-start sync it applies even when the watermark did not move, and it
 * creates the client row when none exists (a cold client must not drop it).
 */
export type ReadStateUpdate = ReadStateSyncEntry;

/**
 * Ring notification for one recipient (user-keyed). Emitted on ring-enabled
 * start or ring-after-start (AM17) to connected members who pass a live
 * VIEW_CHANNEL check, minus notification-muted ones (AM6); one ring per
 * call, ~30 s life.
 */
export type CallRing = {
  channel_id: Snowflake;
  call_id: Snowflake;
  from_user: Snowflake;
};

/**
 * Opaque media signaling delivered to one recipient (user-keyed). Carries
 * SDP offers/answers and ICE candidates between the room (sole offerer, U5)
 * and the participant. Ephemeral by nature: a replayed CALL_SIGNAL (it is a
 * seq-numbered dispatch like any other) describes a stale negotiation —
 * reconnecting clients discard replayed bodies and await fresh state
 * (CALL_SYNC + the room's re-offer).
 */
export type CallSignal = {
  channel_id: Snowflake;
  /** Opaque signaling blob, capped at 64 KiB (see payloads.ts). */
  body: string;
};

// ---------------------------------------------------------------------------
// CALL_SIGNAL offer envelope v2 (calls V2 plan U2, KTD1 — the track manifest)
// ---------------------------------------------------------------------------

/** Version tag of the versioned CALL_SIGNAL body envelope (offers only). */
export const CALL_SIGNAL_ENVELOPE_VERSION = 2;

/**
 * The manifest's source space (calls V2 plan R5/KTD1): the publish
 * vocabulary (`camera` | `screen` | `screen_audio`) PLUS `mic`. `mic` is
 * manifest-only — it is never a publish/unpublish source, a roster
 * `sources[]` entry, or a CALL_UPDATE `source` (microphone audio is the V1
 * call itself; mute/deafen ride `state`) — but its m-line IS
 * manifest-attributed, because audio playback keys on the manifest too
 * (R5 retires V1's positional m-line-order mirror in the same stroke) and
 * the send-side binding pairs same-kind audio sources (mic/share-audio) by
 * mid exactly as it does video ones.
 */
export const CALL_MANIFEST_SOURCES = ['mic', 'camera', 'screen', 'screen_audio'] as const;

export type CallManifestSource = (typeof CALL_MANIFEST_SOURCES)[number];

/** True iff `value` is a valid manifest source (publish vocabulary + `mic`). */
export function isCallManifestSource(value: unknown): value is CallManifestSource {
  return (
    typeof value === 'string' &&
    (CALL_MANIFEST_SOURCES as readonly string[]).includes(value)
  );
}

/**
 * One attributed media track in the offer manifest (calls V2 plan R5/KTD1):
 * `mid` keys the SDP m-line the server Offer assigned the track, `user_id` +
 * `source` attribute it to a participant's source, and `rids` lists the
 * simulcast rid layers riding that m-line (GO-simulcast branch only —
 * absent when the source is a single capped stream). This manifest is the
 * send-side binding key too: clients attach their own published tracks to
 * the leg's ingest m-lines BY MID (never first-free-m-line — same-kind
 * sources otherwise swap when permission prompts resolve out of order).
 */
export type CallSignalManifestEntry = {
  mid: string;
  user_id: Snowflake;
  source: CallManifestSource;
  /** Simulcast rid layers on this m-line (e.g. ["f","h","q"]); absent = single stream. */
  rids?: string[];
};

/**
 * The versioned JSON envelope a V2 server wraps around every SDP OFFER it
 * pushes on the CALL_SIGNAL event body (KTD1): additive and self-describing
 * — V1 offer bodies were already `{"type":"offer","sdp":...}`, v2 adds `v`
 * and the `tracks` manifest. OFFERS ONLY: client answers keep the V1 shape
 * on op 23 (an answer never carries a manifest — the room built the
 * topology), and ICE bodies are unchanged.
 */
export type CallSignalOfferEnvelope = {
  v: typeof CALL_SIGNAL_ENVELOPE_VERSION;
  type: 'offer';
  sdp: string;
  tracks: CallSignalManifestEntry[];
};

/** True iff `value` structurally satisfies {@link CallSignalOfferEnvelope}. */
export function isCallSignalOfferEnvelope(
  value: unknown,
): value is CallSignalOfferEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== CALL_SIGNAL_ENVELOPE_VERSION) return false;
  if (v.type !== 'offer') return false;
  if (typeof v.sdp !== 'string') return false;
  if (!Array.isArray(v.tracks)) return false;
  for (const entry of v.tracks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
    const t = entry as Record<string, unknown>;
    if (typeof t.mid !== 'string' || t.mid.length === 0) return false;
    if (!isSnowflake(t.user_id)) return false;
    if (!isCallManifestSource(t.source)) return false;
    if (t.rids !== undefined) {
      if (!Array.isArray(t.rids)) return false;
      if (!t.rids.every((rid) => typeof rid === 'string')) return false;
    }
  }
  return true;
}

/**
 * Parse a CALL_SIGNAL event `body` string as an offer envelope v2, or null
 * when it is anything else (V1 offer body, V1-shaped answer, ICE candidate
 * payload, or malformed JSON). The manifest-bearing discriminator clients
 * switch on; audio attribution migrates onto it (R5 retires the V1
 * positional m-line-order mirror).
 */
export function parseCallSignalOfferEnvelope(body: string): CallSignalOfferEnvelope | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(body);
  } catch {
    return null;
  }
  return isCallSignalOfferEnvelope(decoded) ? decoded : null;
}

// ---------------------------------------------------------------------------
// Event registry
// ---------------------------------------------------------------------------

/**
 * Union of every dispatchable gateway event name. Adding an event without a
 * matching EventPayloadMap entry fails to compile (and vice versa).
 */
export type EventName =
  | 'MessageCreate'
  | 'MessageUpdate'
  | 'MessageDelete'
  | 'MessageReactionAdd'
  | 'MessageReactionRemove'
  | 'MessageReactionRemoveAll'
  | 'MessageAck'
  | 'ChannelCreate'
  | 'ChannelUpdate'
  | 'ChannelDelete'
  | 'UserUpdate'
  | 'ThreadCreate'
  | 'ThreadUpdate'
  | 'ThreadDelete'
  | 'ThreadMemberAdd'
  | 'ThreadMemberRemove'
  | 'ThreadListSync'
  | 'ThreadMessageCreate'
  | 'PresenceUpdate'
  | 'TypingStart'
  | 'Ready'
  | 'Resumed'
  | 'RoleCreate'
  | 'RoleUpdate'
  | 'RoleDelete'
  | 'MemberAdd'
  | 'MemberRemove'
  | 'MemberUpdate'
  | 'AccountDelete'
  | 'InteractionCreate'
  | 'InteractionModal'
  | 'InteractionSuccess'
  | 'CallStart'
  | 'CallUpdate'
  | 'CallEnd'
  | 'CallSync'
  | 'ReadStateSync'
  | 'ReadStateUpdate'
  | 'CallRing'
  | 'CallSignal';

/**
 * Event-name -> payload mapping: the exhaustive dispatch table consumed by
 * U15/U17/U28. Kept value-level exhaustive against EventName by the checked
 * assertion below.
 */
export interface EventPayloadMap {
  MessageCreate: MessageCreate;
  MessageUpdate: MessageUpdate;
  MessageDelete: MessageDelete;
  MessageReactionAdd: MessageReactionAdd;
  MessageReactionRemove: MessageReactionRemove;
  MessageReactionRemoveAll: MessageReactionRemoveAll;
  MessageAck: MessageAck;
  ChannelCreate: ChannelCreate;
  ChannelUpdate: ChannelUpdate;
  ChannelDelete: ChannelDelete;
  UserUpdate: UserUpdate;
  ThreadCreate: ThreadCreate;
  ThreadUpdate: ThreadUpdate;
  ThreadDelete: ThreadDelete;
  ThreadMemberAdd: ThreadMemberAdd;
  ThreadMemberRemove: ThreadMemberRemove;
  ThreadListSync: ThreadListSync;
  ThreadMessageCreate: ThreadMessageCreate;
  PresenceUpdate: PresenceUpdate;
  TypingStart: TypingStart;
  Ready: Ready;
  Resumed: Resumed;
  RoleCreate: RoleCreate;
  RoleUpdate: RoleUpdate;
  RoleDelete: RoleDelete;
  MemberAdd: MemberAdd;
  MemberRemove: MemberRemove;
  MemberUpdate: MemberUpdate;
  AccountDelete: AccountDelete;
  InteractionCreate: InteractionCreate;
  InteractionModal: InteractionModal;
  InteractionSuccess: InteractionSuccess;
  CallStart: CallStart;
  CallUpdate: CallUpdate;
  CallEnd: CallEnd;
  CallSync: CallSync;
  ReadStateSync: ReadStateSync;
  ReadStateUpdate: ReadStateUpdate;
  CallRing: CallRing;
  CallSignal: CallSignal;
}

/** Payload lookup by event name (identical to EventPayloadMap; dispatch sugar). */
export type EventNameToPayload<T extends EventName = EventName> = EventPayloadMap[T];

/** Compile-time proof that the map's key set equals the EventName union exactly. */
type _KeySetMismatch =
  | Exclude<keyof EventPayloadMap, EventName>
  | Exclude<EventName, keyof EventPayloadMap>;
type _ExhaustivePayloadMap = [_KeySetMismatch] extends [never] ? true : never;
const _EXHAUSTIVE: _ExhaustivePayloadMap = true;
void _EXHAUSTIVE;

/** Runtime set of every defined event name (mirrors EventName exactly). */
export const GATEWAY_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  'MessageCreate',
  'MessageUpdate',
  'MessageDelete',
  'MessageReactionAdd',
  'MessageReactionRemove',
  'MessageReactionRemoveAll',
  'MessageAck',
  'ChannelCreate',
  'ChannelUpdate',
  'ChannelDelete',
  'UserUpdate',
  'ThreadCreate',
  'ThreadUpdate',
  'ThreadDelete',
  'ThreadMemberAdd',
  'ThreadMemberRemove',
  'ThreadListSync',
  'ThreadMessageCreate',
  'PresenceUpdate',
  'TypingStart',
  'Ready',
  'Resumed',
  'RoleCreate',
  'RoleUpdate',
  'RoleDelete',
  'MemberAdd',
  'MemberRemove',
  'MemberUpdate',
  'AccountDelete',
  'InteractionCreate',
  'InteractionModal',
  'InteractionSuccess',
  'CallStart',
  'CallUpdate',
  'CallEnd',
  'CallSync',
  'ReadStateSync',
  'ReadStateUpdate',
  'CallRing',
  'CallSignal',
]);

/**
 * Array form of GATEWAY_EVENTS (stable order). Deliberately kept public
 * (hardening 7.6): a documented, test-pinned export of the package index —
 * the array form for consumers that iterate or order the set.
 */
export const EVENT_NAMES: readonly EventName[] = [...GATEWAY_EVENTS];

/** True iff `value` is a known gateway event name. */
export function isEventName(value: unknown): value is EventName {
  return typeof value === 'string' && (GATEWAY_EVENTS as ReadonlySet<string>).has(value);
}

// ---------------------------------------------------------------------------
// Dispatch envelope types (op 0)
// ---------------------------------------------------------------------------

/**
 * Discriminated union over every gateway dispatch event: narrow via `switch
 * (event.t)` and each branch's `d` gets its precise payload type. Distributed
 * over the event-name union so `GatewayEvent` (unparameterized) is a proper
 * discriminated union rather than one instantiation holding a payload union.
 */
export type GatewayEvent<T extends EventName = EventName> = T extends unknown
  ? {
      op: 0;
      t: T;
      s: number;
      d: EventPayloadMap[T];
    }
  : never;
