/**
 * Cytale gateway payload shapes — client-to-server commands and the
 * server-to-client control payloads they elicit, plus the Snowflake type.
 *
 * Everything here is JSON-wire-exact: snowflakes ride as strings so 64-bit
 * IDs survive JSON round-trips with zero precision loss.
 */

import type { CompressionMode } from './opcodes.js';

export type { CompressionMode };

// ---------------------------------------------------------------------------
// Snowflake
// ---------------------------------------------------------------------------

/**
 * A Cytale snowflake: the canonical representation is a decimal string. The
 * string (not number) encoding is mandatory — snowflakes are 64-bit and JS
 * numbers lose precision beyond 2^53 - 1. Plain string alias, so JSON
 * round-trips stay trivial.
 */
export type Snowflake = string;

const SNOWFLAKE_RE = /^\d{1,19}$/;

/** int64 maximum as a string, used for overflow rejection in makeSnowflake. */
export const INT64_MAX = '9223372036854775807';

/**
 * Construct a Snowflake from a trusted local source (DB generator, fixture).
 * Validates shape and int64 range; throws rather than silently accepting a
 * value the wire contract can't carry.
 *
 * IDs arriving off the wire are validated as digit strings via `isSnowflake`.
 */
export function makeSnowflake(value: string): Snowflake {
  if (typeof value !== 'string') {
    throw new TypeError(`snowflake must be a string, got ${typeof value}`);
  }
  if (!SNOWFLAKE_RE.test(value)) {
    throw new TypeError(`snowflake must be 1-19 ASCII digits, got ${JSON.stringify(value)}`);
  }
  if (value.length > INT64_MAX.length || (value.length === INT64_MAX.length && value > INT64_MAX)) {
    throw new RangeError(`snowflake exceeds int64 range: ${value}`);
  }
  return value;
}

/**
 * Structural check for values arriving off the wire: non-empty ASCII digit
 * string of at most 19 digits (int64 max). Leading zeros accepted so the
 * guard covers any plausible encoded form; ordering semantics belong to the
 * server which emits fixed-width ids.
 */
export function isSnowflake(value: unknown): value is Snowflake {
  return typeof value === 'string' && SNOWFLAKE_RE.test(value);
}

// ---------------------------------------------------------------------------
// Protocol version
// ---------------------------------------------------------------------------

/**
 * Gateway protocol version, sent by clients inside Identify.v (R11 pins the
 * launch policy; negotiation handled by the gateway client in U15).
 */
export const GATEWAY_VERSION = 1;

// ---------------------------------------------------------------------------
// Client -> server lifecycle payloads
// ---------------------------------------------------------------------------

/** Client environment description sent with Identify. Discord-shaped. */
export interface IdentifyProperties {
  os: string;
  browser: string;
  device: string;
}

/** Neutral defaults for `Identify.properties`; first-party clients override `os`/`device`. */
export const CLIENT_HELLO: IdentifyProperties = {
  os: 'unknown',
  browser: 'cytale',
  device: 'cytale',
};

/** op 2 Identify — session start. */
export interface GatewayIdentifyPayload {
  /** Auth token issued by REST login (validated per U10). */
  token: string;
  /** Requested gateway protocol version. */
  v: number;
  /** Requested stream compression codec, or null for none. */
  compress: CompressionMode | null;
  properties: IdentifyProperties;
  /**
   * Intent bitmask (bots plan U7, compat sessions only — `cytbot_`
   * credentials). Optional on the wire: absent means 0 (lifecycle only).
   * The server honors GUILDS (1<<0), GUILD_MESSAGES (1<<9) and
   * GUILD_MESSAGE_TYPING (1<<11); other KNOWN Discord intent bits connect
   * but deliver nothing for them; UNKNOWN bits close the connection with
   * 4013. Native (`cytale_`) sessions ignore the field entirely.
   */
  intents?: number;
}

/** op 5 Resume — resume a dropped session within the resume window. */
export interface GatewayResumePayload {
  session_id: string;
  /** Last dispatch sequence number the client processed. */
  seq: number;
  /**
   * Single-use secret issued by the server at session establishment (carried
   * in Ready), invalidated on successful use, and bound to the authenticated
   * identity (per U10) — possession alone must not let a different identity
   * adopt a session.
   */
  resume_token: string;
  /**
   * Fresh REST auth token re-proving the caller's identity on the NEW socket.
   * The shipped U10 server re-authenticates every Resume before adopting the
   * session (`d["token"]`); without it the server answers Invalid Session
   * (resumable=false). Same token semantics as Identify.
   */
  token: string;
}

// ---------------------------------------------------------------------------
// Server -> client lifecycle payloads
// ---------------------------------------------------------------------------

/** op 10 Hello — first server frame after connect. */
export interface GatewayHelloPayload {
  /** Heartbeat period in milliseconds; client pings on this cadence. */
  heartbeat_interval: number;
}

/** op 9 InvalidSession — session cannot continue (payload = resumable flag). */
export type InvalidSessionData = boolean;

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

/** op 1 Heartbeat — null before the client has seen a sequence number. */
export type HeartbeatData = number | null;

// ---------------------------------------------------------------------------
// Cytale reserved-range command payloads (ops >= RESERVED_OP_MIN)
// ---------------------------------------------------------------------------

/** op 20 TYPING_START_CLIENT — client -> server typing signal. */
export interface GatewayClientTypingStartPayload {
  channel_id: Snowflake;
  /** Optional: signal applies to a thread rather than the parent channel. */
  thread_id?: Snowflake;
}

/**
 * TypingStart as fanned out by the server after throttling (~1/sec/user/
 * channel). This is also the payload carried by the `TypingStart` dispatch
 * event (mapped in events.ts).
 */
export interface GatewayServerTypingStartPayload {
  channel_id: Snowflake;
  thread_id: Snowflake | null;
  user_id: Snowflake;
  /** Unix epoch milliseconds when the typing signal was registered. */
  timestamp: number;
}

/** op 21 MESSAGE_ACK — client -> server read acknowledgement command body. */
export interface GatewayClientMessageAckPayload {
  channel_id: Snowflake;
  message_ids: Snowflake[];
}

/**
 * Server-side acknowledgement shape matching MESSAGE_ACK, mirrored back to
 * interested clients so multi-device read state converges. Also the request
 * body contract for the REST fallback `POST /channels/{id}/ack`.
 */
export interface MessageAckServerAck {
  channel_id: Snowflake;
  message_ids: Snowflake[];
  user_id: Snowflake;
  acknowledged_at: string;
}

// ---------------------------------------------------------------------------
// Voice-call command payloads (calls plan U1 — ops 22/23; calls V2 plan U2
// extends op 22 with the publish vocabulary + video_want)
// ---------------------------------------------------------------------------

/**
 * op 22 CALL_STATE_UPDATE actions: the voice-call control-plane verbs.
 * `publish`/`unpublish` are additive (calls V2 plan KTD3) — V1 servers
 * reject them as unknown actions, V2 surfaces below ride on them.
 *
 * Throttle classification (V1's TS never modeled it; gateway.md documents it
 * and the gateway enforces it): `publish`/`unpublish` are EXEMPT from the
 * op-22 state throttle exactly the way `leave` is (the gateway's own-bypass
 * clause — rapid publish toggles are legitimate client behavior); the
 * client debounces chatty UI at ~300 ms anyway. Every other action rides
 * the typing-style window, with one V2 carve-out: `state` ops carrying
 * `video_want` get a dedicated loose ~2 s window — a window, NOT an
 * exemption (KTD7).
 */
export const CALL_CONTROL_ACTIONS = [
  'start',
  'join',
  'leave',
  'state',
  'publish',
  'unpublish',
] as const;

export type CallControlAction = (typeof CALL_CONTROL_ACTIONS)[number];

/** True iff `value` is a defined CALL_STATE_UPDATE action. */
export function isCallControlAction(value: unknown): value is CallControlAction {
  return (
    typeof value === 'string' &&
    (CALL_CONTROL_ACTIONS as readonly string[]).includes(value)
  );
}

/**
 * Publishable media sources in a call (calls V2 plan KTD3): `camera` (webcam
 * video), `screen` (screenshare video), `screen_audio` (the optional audio
 * track that rides a screenshare). Microphone audio is NOT a source — it is
 * the V1 call itself (mute/deafen state), never published/unpublished.
 *
 * The same discriminant keys the op-22 `publish`/`unpublish` actions, the
 * CALL_UPDATE `source?` field, the CALL_SYNC roster `sources[]` entries, and
 * the CALL_SIGNAL offer-envelope manifest (events.ts) — one vocabulary,
 * every surface.
 */
export const CALL_SOURCE_KINDS = ['camera', 'screen', 'screen_audio'] as const;

export type CallSourceKind = (typeof CALL_SOURCE_KINDS)[number];

/** True iff `value` is a defined publishable call media source kind. */
export function isCallSourceKind(value: unknown): value is CallSourceKind {
  return (
    typeof value === 'string' &&
    (CALL_SOURCE_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Receiver quality ceilings for `video_want` (calls V2 plan KTD7/R9): the
 * receiver's declared max layer, honored by the server alongside
 * congestion-driven selection in the simulcast branch (GO branch only —
 * absent simulcast the publisher's single capped stream is the stream).
 * Ordered high > medium > low; conceptually the f/h/q rid layers.
 */
export const VIDEO_QUALITY_PREFERENCES = ['high', 'medium', 'low'] as const;

export type VideoQualityPreference = (typeof VIDEO_QUALITY_PREFERENCES)[number];

/** True iff `value` is a defined video quality preference. */
export function isVideoQualityPreference(value: unknown): value is VideoQualityPreference {
  return (
    typeof value === 'string' &&
    (VIDEO_QUALITY_PREFERENCES as readonly string[]).includes(value)
  );
}

/**
 * The receiver's adaptive viewing declaration (calls V2 plan KTD7): emitted
 * by the getStats ladder on the `state` action. `tiles` is the live-tile
 * budget the receiver sustains (participants beyond it render as avatar
 * tiles); `max_quality` is the simulcast-layer ceiling (absent = server's
 * congestion-driven selection alone).
 */
export interface VideoWant {
  /** Live video tiles the receiver declares it sustains (floor 1, stage-only). */
  tiles: number;
  /** Max simulcast quality layer requested (simulcast branch only). */
  max_quality?: VideoQualityPreference;
}

/**
 * op 22 CALL_STATE_UPDATE — client -> server voice-call control plane.
 *
 * One command shape covers the verbs (calls plan KTD3: call control rides
 * the main gateway — no dedicated voice socket):
 * - `start`: begin a call in the channel (or join the live one — a start
 *   racing an existing call resolves as a join, one-live policy).
 * - `join` / `leave`: enter / exit the live call.
 * - `state`: update own voice state (mute/deafen toggles, listen-only mic
 *   upgrade) and/or ring.
 * - `publish` / `unpublish`: start/stop sending a media source into the
 *   call (calls V2 plan KTD3 — camera video, screen, share audio; V1's
 *   audio-only call grows a per-source publish vocabulary).
 */
export interface GatewayCallStateUpdatePayload {
  channel_id: Snowflake;
  action: CallControlAction;
  /**
   * `state` action only: desired mute flag. Absent = unchanged. Deafen
   * implies self-mute (AM12).
   */
  mute?: boolean;
  /** `state` action only: desired deafen flag (stops server-side forwarding
   * to this participant and implies mute — AM12). Absent = unchanged. */
  deafen?: boolean;
  /**
   * `state` action only (VM5 retryMic): listen-only upgrade signal — the
   * room re-offers the mic m-line for this leg. The mic is NOT a publish
   * source (it is the V1 call itself), so a listen-only leg regaining its
   * microphone rides `state` instead of `publish`. Absent = unchanged;
   * `false` is never sent (there is no downgrade path on the wire).
   */
  mic_granted?: boolean;
  /**
   * Allowed on `start` AND on `state` — ring-after-start (AM17: a silent
   * starter alone in a call can summon the room without restarting).
   * Absent = silent (no ring).
   */
  ring?: boolean;
  /**
   * `publish` / `unpublish` actions only (calls V2 plan KTD3): the source
   * being started/stopped. Absent on every V1 action and on `state`.
   * Gating (enforced server-side by U3, never here): `camera` requires
   * SEND_VIDEO; BOTH `screen` and `screen_audio` require SHARE_SCREEN
   * (share-audio is at least as sensitive as the screen — never ungated).
   * DM rooms skip the bit checks entirely (participation is authorization).
   */
  source?: CallSourceKind;
  /**
   * `state` action only (calls V2 plan KTD7): the receiver's adaptive
   * viewing declaration — how many live video tiles it sustains and (simulcast
   * branch only) its max-quality preference. Absent = unchanged.
   *
   * Throttle classification (gateway.md is normative): a `video_want`-bearing
   * op rides a DEDICATED loose window (~2 s) — it is NOT exempt from the
   * state throttle (the only server-side bound on the permission-resolver
   * path); the ladder's ~10 s cadence cannot legitimately need faster.
   */
  video_want?: VideoWant;
}

/** Opaque media-signaling relay kinds (op 23). */
export const CALL_SIGNAL_KINDS = ['sdp', 'ice'] as const;

export type CallSignalKind = (typeof CALL_SIGNAL_KINDS)[number];

/** True iff `value` is a defined CALL_SIGNAL kind. */
export function isCallSignalKind(value: unknown): value is CallSignalKind {
  return (
    typeof value === 'string' &&
    (CALL_SIGNAL_KINDS as readonly string[]).includes(value)
  );
}

/**
 * Hard server-enforced cap on the op-23 `body` string (and the CALL_SIGNAL
 * event body): 128 KiB = 131072 bytes UTF-8 (raised from 64 KiB by the V2 spike:
 * 25-participant simulcast offers measured 64,536 B at the old cap and multi-share
 * worst cases up to 167,639 B — research doc "V2 spike" arm b). Larger bodies are
 * rejected at
 * ingress (U4); the constant is shared so clients pre-size and the load
 * harness probes the exact boundary.
 */
export const CALL_SIGNAL_BODY_MAX_BYTES = 131_072;

/**
 * op 23 CALL_SIGNAL — client -> server opaque media-signaling relay
 * (`kind: sdp|ice`). The gateway never interprets `body`; it forwards it to
 * the channel's call room tagged with the sender's session (U5 consumes).
 *
 * Server-enforced (U4): the sender must be a CURRENT participant of the
 * live call on `channel_id` (else silent drop), the body is capped at
 * {@link CALL_SIGNAL_BODY_MAX_BYTES}, and both call ops carry a typing-style
 * per-session throttle.
 */
export interface GatewayCallSignalPayload {
  channel_id: Snowflake;
  kind: CallSignalKind;
  /** Opaque signaling blob (SDP or ICE candidate payload as a string). */
  body: string;
}
