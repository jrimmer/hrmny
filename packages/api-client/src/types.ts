/**
 * @cytale/api-client — shared client types.
 *
 * The domain package owns the canonical entity interfaces; this module adds
 * transport-scoped contracts (error envelope, token plumbing, request
 * options, list envelope) and re-exports the domain types the client's
 * methods consume.
 */

import type {
  AuthTokens,
  CreateMessageBody,
  ListCursor,
  Message,
  NotificationPreference,
  NotificationPreferenceLevel,
  NotificationPreferenceScope,
  NotificationTestResult,
  SearchFilters,
  UploadedAttachment,
  UserRef,
} from '@cytale/domain';
import type { CallEndReason, CallParticipant } from '@cytale/protocol';

export type {
  AuthTokens,
  NotificationPreference,
  NotificationPreferenceLevel,
  NotificationPreferenceScope,
  NotificationTestResult,
};

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/** Shape of a REST failure body (the plan's single error envelope). */
export interface ApiErrorShape {
  key: string;
  code: number;
  message: string;
  /** HTTP status kept alongside for typed catch-site narrowing. */
  status?: number;
  /**
   * The server's request id for this call (`x-request-id` response header,
   * set by `Plug.RequestId` on every Phoenix response — #88). This is what
   * makes a client-side report traceable INTO the server logs instead of a
   * dead end: grep the logs for this value and the same request is there.
   *
   * `null` when the response carried none (a transport failure, a proxy, a
   * non-Phoenix hop) — never fabricated client-side.
   */
  requestId?: string | null;
  /**
   * The underlying failure, for a transport error (`network_error`): Node's
   * fetch rejects with a TypeError whose own `cause` carries the TLS or socket
   * code (`CERT_HAS_EXPIRED`, `ECONNREFUSED`, …). Kept so a caller can tell an
   * untrusted certificate from an unreachable host; absent for HTTP errors.
   */
  cause?: unknown;
  /**
   * How long the server asked the caller to wait before trying again, in
   * milliseconds — from `Retry-After` (seconds or an HTTP date), else the
   * rate-limit reset headers (`X-RateLimit-Reset-After` seconds, or
   * Discord's `X-RateLimit-Reset` epoch seconds). Set on a `429` (and a
   * `503 service_unavailable`); `null` when the response carried no hint.
   */
  retryAfterMs?: number | null;
  /**
   * WHICH limit a `429` hit — the envelope's `scope`, else the
   * `X-RateLimit-Scope` header: `conversation` (the send budget in one channel
   * or thread), `sender` (the send budget across conversations), `account`,
   * or `ip` (see `RateLimitScope`). Any other value passes through as-is;
   * `null` when the response named none (every non-429, and the login /
   * two-factor attempt locks). A caller treats anything but a scope it knows
   * as the widest limit.
   */
  rateLimitScope?: string | null;
}

/** The `scope` values a native `429` names today (docs/protocol/rest.md). */
export type RateLimitScope = 'conversation' | 'sender' | 'account' | 'ip';

/**
 * Typed error class carrying the server's `{error:{key,code,message}}`
 * fields for typed catch-site narrowing (`err.key === 'ACCOUNT_UNVERIFIED'`).
 */
export class ApiError extends Error {
  readonly key: string;
  readonly code: number;
  override readonly message: string;
  readonly status: number;
  /**
   * The server's request id (`x-request-id`), or null when the response had
   * none. See `ApiErrorShape.requestId` — this is the traceability handle.
   */
  readonly requestId: string | null;
  /** The server's retry hint in ms (see `ApiErrorShape.retryAfterMs`), or null. */
  readonly retryAfterMs: number | null;
  /** The limit a 429 hit (see `ApiErrorShape.rateLimitScope`), or null. */
  readonly rateLimitScope: string | null;

  constructor(shape: ApiErrorShape) {
    super(shape.message, shape.cause !== undefined ? { cause: shape.cause } : undefined);
    this.name = 'ApiError';
    this.key = shape.key;
    this.code = shape.code;
    this.message = shape.message;
    this.status = shape.status ?? 0;
    this.requestId = shape.requestId ?? null;
    this.retryAfterMs = shape.retryAfterMs ?? null;
    this.rateLimitScope = shape.rateLimitScope ?? null;
  }
}

// ---------------------------------------------------------------------------
// Auth token plumbing
// ---------------------------------------------------------------------------

/** Access + refresh pair as issued by /auth/login, /auth/register, refresh. */
export interface StoredTokens extends AuthTokens {
  /** Epoch millis when the access token expires, when known. */
  expires_at?: number | null;
}

/** Seam for credential storage (state store in U17, memory, storage backends). */
export interface TokenProvider {
  getAccessToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  /** Persist rotated tokens after a successful refresh exchange. */
  updateTokens(access: string, refresh: string): Promise<void>;
}

/** Static in-memory TokenProvider (tests, CLIs). */
export function createInMemoryTokenProvider(initial: StoredTokens | null): TokenProvider & {
  setTokens(next: StoredTokens | null): void;
  snapshot(): StoredTokens | null;
} {
  let current = initial;
  return {
    async getAccessToken() {
      return current?.access_token ?? null;
    },
    async getRefreshToken() {
      return current?.refresh_token ?? null;
    },
    async updateTokens(access: string, refresh: string) {
      current = current
        ? { ...current, access_token: access, refresh_token: refresh }
        : { access_token: access, refresh_token: refresh, expires_in: 0 };
    },
    setTokens(next) {
      current = next;
    },
    snapshot() {
      return current;
    },
  };
}

// ---------------------------------------------------------------------------
// Request options and pagination envelope
// ---------------------------------------------------------------------------

export interface RequestOptions {
  headers?: Record<string, string>;
  /**
   * Explicit Idempotency-Key override. When absent on a POST, the client
   * generates `crypto.randomUUID()` automatically (plan convention:
   * mutating POSTs accept Idempotency-Key so retries never double-send).
   */
  idempotencyKey?: string;
  /** Skip Authorization header + refresh-retry machinery (auth endpoints). */
  auth?: false;
  /**
   * Abort the request after this many milliseconds (lane D #22). The call
   * then rejects with an `ApiError` keyed `timeout` (status 0) — for a write
   * that means "outcome UNKNOWN": the server may have applied it, so a retry
   * must present the same Idempotency-Key. Absent = no client-side bound
   * beyond the platform's own.
   */
  timeoutMs?: number;
}

/**
 * Cursor parameters accepted by every list endpoint — snowflake cursor-based
 * `?before=&after=&limit=` (snowflakes sort chronologically, so cursors are
 * both opaque and orderable).
 */
export interface ListParams {
  before?: string | null;
  after?: string | null;
  limit?: number | null;
}

/** Standard list response envelope: items + cursor metadata. */
export interface ListResponse<T> {
  items: T[];
  cursor: ListCursor;
}

/** Convenience constructor used by tests and adapters. */
export function toListResponse<T>(items: T[], cursor: ListCursor): ListResponse<T> {
  return { items, cursor };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Naming alias: attachment descriptors now live on domain's
 * CreateMessageBody itself (the composer uploads first via
 * `uploadChannelAttachment`, then binds the returned rows into the POST).
 */
export type SendMessageBody = CreateMessageBody;

// ---------------------------------------------------------------------------
// Uploads (browser File/Blob + React Native descriptors)
// ---------------------------------------------------------------------------

/**
 * React Native's `FormData` file descriptor: a local `file://` URI plus the
 * name and mime type the multipart part must carry. RN's `FormData` accepts
 * this object in place of a `File`/`Blob` (it streams the file from the URI
 * natively); browsers do not understand it, so it must never reach a DOM
 * `FormData`.
 */
export interface NativeFileDescriptor {
  uri: string;
  name: string;
  type: string;
}

/**
 * The upload parameter the three upload methods accept: a browser
 * `File`/`Blob` (web) or an RN descriptor (native). Widening this type is
 * the plan-004 KTD7 seam — web call sites are unchanged.
 */
export type UploadFile = File | Blob | NativeFileDescriptor;

/** True for the RN descriptor shape (duck-typed: `uri` is the tell). */
export function isNativeFileDescriptor(value: unknown): value is NativeFileDescriptor {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<NativeFileDescriptor>;
  return (
    typeof candidate.uri === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.type === 'string'
  );
}

// ---------------------------------------------------------------------------
// Reactions
// ---------------------------------------------------------------------------

/**
 * One emoji's aggregate on a message row — an item of the message JSON's
 * optional `reactions` array (`[{"emoji": "👍", "count": 2, "me": true}]`,
 * ABSENT from the message when it has none). Emoji are raw Unicode; there
 * are no custom emoji anywhere in v1.
 */
export interface ReactionSummary {
  emoji: string;
  count: number;
  /** True when the current user is among the reactors. */
  me: boolean;
}

/**
 * Message widened with the optional `reactions` key. The shared domain
 * `Message` does not declare it yet; REST reads pass it through untouched,
 * so this intersection types the seam without widening the shared model
 * (if the domain later declares the key, the alias stays compatible).
 */
export type MessageWithReactions = Message & {
  reactions?: ReactionSummary[] | null;
};

/** Cursor params of `GET .../reactions/{emoji}` (after-cursor pagination). */
export interface ReactionUsersParams {
  after?: string | null;
  limit?: number | null;
}

/** Row of the reaction-users list — a compact user reference. */
export type ReactionUser = UserRef;

/** Response of `GET .../reactions/{emoji}`: `{"users": [...], "next_after"}`. */
export interface ReactionUsersResponse {
  users: ReactionUser[];
  /** Pass as `after` for the next page; null when the list is exhausted. */
  next_after: string | null;
}

// ---------------------------------------------------------------------------
// Machine principals (bots, agents, webhooks)
// ---------------------------------------------------------------------------

/** Action verbs a restrictions profile may narrow a principal to (R1). */
export type PrincipalAction = 'read' | 'post';

/**
 * Restrictions policy (rest.md "Bots and agents"): `null`/undefined =
 * unrestricted; otherwise an object whose effective rights are the parent's
 * current rights ∩ restrictions, evaluated at check time. `actions` is a
 * subset of `["read", "post"]`; `channels` is an allowlist of channel-id
 * decimal strings (empty/omitted = all channels).
 */
export interface PrincipalRestrictions {
  actions?: PrincipalAction[];
  channels?: string[];
}

/**
 * A grant level on an agent's access tree. `none` grants nothing; `read` is
 * metadata, roster, history, search and receiving events; `read_write` adds
 * sending, attachments, reactions and threads. Nothing outside those groups is
 * grantable at any level — management and moderation are excluded by the
 * capability table, not by a missing option.
 */
export type AccessLevel = 'none' | 'read' | 'read_write';

/** The Workspaces root: one level for every workspace, or explicit grants. */
export type WorkspacesAccessMode = 'none' | 'all' | 'custom';

/** One explicit workspace grant. */
export interface WorkspaceGrant {
  level: AccessLevel;
  /** Per-channel levels; a channel absent from this map inherits nothing. */
  channels: Record<string, AccessLevel>;
}

/**
 * An agent's access document (the whole tree, versioned). The server is the
 * authority: read it, edit it, send the whole thing back — `PATCH` validates
 * the complete document, so the tree can never be half-applied.
 *
 * `server` and `account` are REPORTED by the server and are not the caller's
 * to set (they are fixed at `read`); echo them back unchanged.
 */
export interface AccessDocument {
  /** Document version, stamped by the server. */
  v: number;
  /** Fixed: the agent can resolve the server and what it was granted. */
  server: AccessLevel;
  /** Fixed: the agent's OWN account — its identity, nothing to grant. */
  account: { agent: AccessLevel };
  /** Direct-message reach (semantics land with the DM ticket). */
  dms: AccessLevel;
  /**
   * WHO this agent will hold a DM with (owner direction 2026-09-15):
   * `humans` (the server's default), `everyone` (people and other agents), or
   * `none`. The counterparty axis — `dms` above is the agent's own read/write
   * level on a conversation it already has.
   */
  dm_support?: 'humans' | 'everyone' | 'none';
  workspaces: {
    mode: WorkspacesAccessMode;
    /** The level for `all`; `null` while `grants` are in force. */
    level: AccessLevel | null;
    /**
     * Per-workspace grants. While `mode` is `all` these are RETAINED BUT
     * DORMANT — the root is in force — and clearing the root restores them
     * unchanged. Never rewrite one side when switching modes.
     */
    grants: Record<string, WorkspaceGrant>;
  };
}

/**
 * Metadata row for a BOT — a user-owned machine credential (list reads never
 * carry tokens). One name, one kind: the URL, the kind, the `cytbot_` token
 * prefix and this type all say bot, while "Agent" is only ever the word a
 * person reads. `kind` stays wide because a row minted while a second kind
 * existed still reads out as `agent` — both mean the same thing to a reader.
 */
export interface Bot {
  id: string;
  name: string;
  /** The credential's tag (unique per server); rows minted before tags
   * existed have none and fall back to the name for display. */
  username?: string | null;
  /** The owner-uploaded avatar (#126); null = the initial-letter fallback. */
  avatar_url?: string | null;
  kind: 'bot' | 'agent';
  created_at: string;
  restrictions?: PrincipalRestrictions | null;
  /** The grant, or the all-none default when nothing was granted yet. */
  access?: AccessDocument | null;
}

/**
 * Metadata row from GET /users/@me/integrations — the settings surface's
 * cross-workspace "My integrations" rollup of the caller's machine
 * principals (bots + webhooks), with a live-session flag. Never tokens.
 */
export interface MyIntegration {
  id: string;
  name: string | null;
  kind: 'bot' | 'agent' | 'webhook';
  created_at: string | null;
  online: boolean;
  /** The grant, or the all-none default when nothing was granted yet. */
  access?: AccessDocument | null;
}

/** Channel-scoped incoming webhook; `url` is re-viewable by managers. */
/**
 * A channel's webhook as the DESTINATION's managers read it: what posts into
 * this channel, and what it is called. Deliberately NO `url` — the capability
 * token belongs to the creator, and a manager who is not the creator has no
 * business holding it (KD3). It used to be here; see `MyWebhook` for the read
 * that does carry it.
 */
export interface Webhook {
  id: string;
  name: string;
  channel_id: string;
  created_at?: string | null;
}

/**
 * The CREATE response: the new webhook's id and its capability URL — handed to
 * its creator ONCE. The full row is not returned, because the URL is the only
 * part of it the caller cannot get from a later read.
 */
export interface CreatedWebhook {
  id: string;
  url: string;
}

/** Where a webhook posts — named, so an owner-scoped list needs no workspace id. */
export interface WebhookDestination {
  channel_id: string;
  channel_name: string;
  workspace_id: string | null;
  workspace_name: string | null;
}

/**
 * The CREATOR's own webhook (`GET /users/@me/webhooks`). The only shape that
 * carries `url`, because the caller is the one who can already post with it.
 */
export interface MyWebhook extends Webhook {
  url: string;
  destination: WebhookDestination | null;
}

/** Create/regenerate response: the once-only `cytbot_` credential moment. */
export interface MintedPrincipalCredential {
  id: string;
  token: string;
  name?: string;
  kind?: 'bot' | 'agent';
  created_at?: string;
}

/** Regenerate-only response (the principal row already exists). */
export interface RegeneratedCredential {
  token: string;
}

/** POST body for bot minting (`restrictions` omitted = unrestricted). */
export interface CreatePrincipalBody {
  /** The display name — free-form. */
  name: string;
  /**
   * The tag: unique per server, `[a-zA-Z0-9_.-]{2,32}`. Omitted → derived
   * from the name (suffixed while taken). Supplied → refused on collision,
   * never silently altered.
   */
  username?: string | null;
  restrictions?: PrincipalRestrictions | null;
}

/**
 * PATCH body: metadata rename and/or an authority change. `access` replaces
 * the WHOLE document (one save path — the server validates mode/level
 * consistency before anything is persisted). Sending either `restrictions` or
 * `access` is an authority change: live sessions are told to reconnect.
 */
export interface UpdatePrincipalBody {
  name?: string;
  restrictions?: PrincipalRestrictions | null;
  access?: AccessDocument | null;
}

/** POST body for webhook creation (channel-scoped by the route). */
export interface CreateWebhookBody {
  name: string;
}

/** PATCH body for webhook rename (metadata only). */
export interface UpdateWebhookBody {
  name: string;
}

// ---------------------------------------------------------------------------
// Application commands & interactions (bots plan U8/U9)
// ---------------------------------------------------------------------------

/**
 * One CHAT_INPUT option registration as stored by the compat applications
 * bulk-upsert route (rest.md "Interactions": `options` is a flat JSON array
 * on the command row). v1 renders every option as a free-text input; the
 * `required` flag gates invocation client-side (the server re-validates).
 */
export interface ApplicationCommandOption {
  name: string;
  description: string;
  /** Discord CHAT_INPUT option type number when the bot sent one. */
  type?: number | string;
  required?: boolean;
}

/**
 * Row of `GET /workspaces/{id}/commands` — the workspace's registered
 * commands (all applications) for the composer palette. `application_id` is
 * the owning bot principal: the bot's callback response lands as an ordinary
 * message authored by that principal.
 */
export interface ApplicationCommand {
  id: string;
  application_id: string;
  name: string;
  description: string;
  /** Registered options JSON array; absent/empty → zero-option command. */
  options?: ApplicationCommandOption[] | null;
}

/** Body of `POST /interactions` (human caller, send-right-checked). */
export interface InvokeInteractionBody {
  command_id: string;
  channel_id: string;
  /** Filled option values as a flat JSON map. */
  options?: Record<string, unknown>;
  /** Optional client correlation key (1–64 chars): echoed on the
   * `InteractionSuccess` gateway event when the bot answers. */
  nonce?: string;
}

/**
 * Body of `POST /interactions` — the COMPONENT CLICK variant (components
 * plan U2/KTD2): message-keyed, dispatched by the server BEFORE the command
 * shape. `component_type` is 2 (button) or 3 (string select); `values` is
 * the select's picked option values (single-select v1) and is omitted for
 * buttons.
 */
export interface InvokeComponentInteractionBody {
  channel_id: string;
  message_id: string;
  custom_id: string;
  component_type: number;
  values?: string[];
  /** Optional client correlation key (1–64 chars): echoed on the
   * `InteractionSuccess` gateway event when the bot answers. */
  nonce?: string;
}

/** A message mark (#54) as the owner sees it — identifiers and times only. */
export interface MessageMark {
  /** The kind id; v1 has one, `snooze` ("Remind me…"). */
  kind: string;
  channel_id: string;
  message_id: string;
  /** ISO 8601 instant (timed kinds), or null. */
  due_at: string | null;
  state: 'pending' | 'fired' | 'cancelled' | 'missed';
}

/** A modal submission (#30): the answers to a modal a bot opened on one of
 * the caller's interactions. `components` is one row per text input. */
export interface SubmitModalBody {
  kind: 'modal_submit';
  interaction_id: string;
  custom_id: string;
  components: { type: 1; components: [{ type: 4; custom_id: string; value: string }] }[];
  /** Optional client correlation key (1–64 chars): echoed on the
   * `InteractionSuccess` gateway event when the bot answers. */
  nonce?: string;
}

// ---------------------------------------------------------------------------
// Search query shapes
// ---------------------------------------------------------------------------

/** Wire params for search endpoints (from:/in:/before:/after: serialization). */
export interface SearchQueryParams extends ListParams {
  q: string;
  from?: string;
  in?: string;
  before?: string;
  after?: string;
}

// ---------------------------------------------------------------------------
// Voice-call state (calls plan U1 — GET /channels/{id}/call)
// ---------------------------------------------------------------------------

/**
 * The durable call surface for one channel. All three fields are ALWAYS
 * present: `live` is null when no call is active, `recently_ended` may be
 * empty, and `thread_id` is null only on DM channels (no durable artifact,
 * R11). This is the standing-thread mapping source for the store's R5
 * exclusion and the boundary source for U9's log surfaces.
 */
export interface CallStateResponse {
  /** The channel's standing call-log thread (R4); null on DM channels. */
  thread_id: string | null;
  /** The live call + roster, if one is active. */
  live: LiveCallState | null;
  /** Bounded, newest-first list of the channel's recently ended calls. */
  recently_ended: EndedCallRecord[];
  /**
   * The requester's effective media capabilities (calls V2 plan U8, R17):
   * channel-override-then-master. Additive-optional on the type (the
   * server always sends it) — all-true on DM channels.
   */
  capabilities?: CallCapabilities;
}

/**
 * Effective media capabilities for one channel (calls V2 plan U8, R17) —
 * the honest-gating input clients consume from the call REST surface.
 */
export interface CallCapabilities {
  /** START_CALL resolved server-side for the requester (default-on, channel-overridable; DMs true). Gates the phone affordance. */
  start?: boolean;
  calls: boolean;
  video: boolean;
  screenshare: boolean;
}

/**
 * Live-call projection. `participants` is @cytale/protocol's
 * `CallParticipant` — the SAME roster type CALL_SYNC dispatches, including the
 * V2 `sources` list — imported, never re-declared. The server builds both wire
 * paths from one projection (`Cytale.Calls.Events.roster_entry/1`), so a local
 * shadow here could only ever DROP a field the wire carries (hardening 6.5:
 * the old `CallRosterMember` shadow hid `sources` from every REST consumer).
 */
export interface LiveCallState {
  call_id: string;
  started_by: string;
  started_at: string;
  participants: CallParticipant[];
}

// ---------------------------------------------------------------------------
// Voice-call ICE config (calls plan U12 — GET /calls/ice)
// ---------------------------------------------------------------------------

/**
 * One ICE server entry. The TURN entry carries SHORT-LIVED REST-auth
 * credentials (username = unix expiry, credential = HMAC of the deploy
 * secret) — consumers fetch fresh at call-join time, never cache long.
 */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** GET /calls/ice envelope — `ice_servers` is [] when no TURN is configured. */
export interface IceConfigResponse {
  ice_servers: IceServer[];
}

/** One recently ended call (boundary rows, AM11). */
export interface EndedCallRecord {
  call_id: string;
  started_by: string;
  started_at: string;
  ended_at: string;
  /** `last_left` (ordinary empty-sweep expiry) | `swept` (crash-recovery adoption / boot sweep) — R8. Protocol owns the union (`CallEndReason`). */
  reason: CallEndReason;
}

// ---------------------------------------------------------------------------
// Workspace media settings (calls V2 plan U8 — R16/R17)
// ---------------------------------------------------------------------------

/**
 * The workspace's master media toggles: calls / video / screenshare
 * enable-disable workspace-wide, plus the "channels may override" flag.
 * Absent row → server defaults (all enabled, overrides disallowed).
 */
export interface WorkspaceMediaSettings {
  calls: boolean;
  video: boolean;
  screenshare: boolean;
  overrides_allowed: boolean;
}

/** A channel's tri-state media override (null = inherit the master). */
export interface ChannelMediaOverride {
  calls: boolean | null;
  video: boolean | null;
  screenshare: boolean | null;
}

/**
 * The channel-override management view (one read): the override row, the
 * workspace master, and the `overrides_allowed` flag — the channel
 * manager's visibility rule for the override affordances.
 */
export interface ChannelMediaOverrideView {
  override: ChannelMediaOverride;
  overrides_allowed: boolean;
  master: WorkspaceMediaSettings;
}


// ---------------------------------------------------------------------------
// Server settings (#121, operator tier)
// ---------------------------------------------------------------------------

/** Per-key schema metadata the editor renders as help text. */
export interface ServerConfigKeyMeta {
  /** Human-readable type label, e.g. `boolean`, `enum(hourly | daily | weekly)`. */
  type: string;
  /** `boot` keys need a restart to take effect; `runtime` keys hot-apply. */
  scope: 'boot' | 'runtime';
  description: string;
  default?: unknown;
  /** The allowed values, for enum-shaped keys. */
  allowed?: string[];
}

/** GET /admin/config — the editable document (NEVER secrets) + metadata. */
export interface ServerConfigDocument {
  config: Record<string, unknown>;
  metadata: Record<string, ServerConfigKeyMeta>;
}

/** PUT /admin/config — the save result. */
export interface ServerConfigSaveResult {
  ok: true;
  /** Dot-paths of the keys this save moved. */
  changed: string[];
  /** True when any BOOT-scoped key changed — the node needs a restart. */
  restart_required: boolean;
}

// ---------------------------------------------------------------------------
// WebAuthn passkeys (#36)
// ---------------------------------------------------------------------------

/** GET /auth/methods — which sign-in surfaces the login page renders. */
export interface AuthMethods {
  password: boolean;
  webauthn: boolean;
  /** #12: the OIDC button renders only when the server reports it enabled. */
  oidc?: boolean;
  /** The operator's `oidc.button_label`, advertised only while the surface is enabled. */
  oidc_button_label?: string | null;
  /**
   * #127: the TOTP switch. `false` (or absent on an older server) = the
   * feature is ABSENT client-side too — no login branches, no settings
   * section. The login page already polls this endpoint unauthenticated.
   */
  two_factor?: boolean;
}

// ---------------------------------------------------------------------------
// TOTP two-factor (#127)
// ---------------------------------------------------------------------------

/**
 * The REDUCED identity payload a login 2FA step carries (`id` + `username`
 * only — the response is pre-authentication, so the email is not the wire's
 * business). Enough for the step display ("Signing in as @jordan").
 */
export interface LoginStepUser {
  id: string;
  username: string;
}

/**
 * What POST /auth/login actually returns once the server's 2FA switch can be
 * on (#127). The classic token pair is the OFF shape and the shape every
 * other client knows; the two `status` branches carry an opaque, short-lived,
 * single-purpose GRANT the follow-up call spends:
 *
 *   * `totp_pending` — the account is enrolled; POST /auth/2fa/verify
 *     `{grant, code}` swaps the grant for the token pair.
 *   * `enrollment_required` — mode is on and the password-only account is NOT
 *     enrolled; POST /auth/2fa/enroll/start + enroll/confirm (with the grant)
 *     walk the ceremony whose success mints the pair. Skipping is impossible.
 */
export type LoginResponse =
  | AuthTokens
  | { status: 'totp_pending'; grant: string; user: LoginStepUser }
  | { status: 'enrollment_required'; grant: string; user: LoginStepUser };

/** POST /auth/2fa/enroll/start — the candidate secret's wire shape. */
export interface TwoFactorEnrollStart {
  /** Base32 — the manual-entry string for authenticator apps. */
  secret: string;
  /** The `otpauth://` URI the CLIENT renders as a QR (no server render). */
  otpauth_uri: string;
  algorithm: string;
  digits: number;
  period: number;
}

/**
 * POST /auth/2fa/enroll/confirm — the grant path (the forced login walk)
 * mints the EXACT token pair login returns; the settings (Bearer) path just
 * confirms: `{"enrolled": true}`.
 */
export type TwoFactorEnrollConfirmResponse = AuthTokens | { enrolled: boolean };

/** GET /users/@me/two-factor — the settings read (mode + enrollment). */
export interface TwoFactorStatus {
  /** The server switch, right now (retention: off keeps enrollments but stops challenging). */
  mode_enabled: boolean;
  enrolled: boolean;
  confirmed_at?: string | null;
  last_used_at?: string | null;
}

/** Body of POST /auth/2fa/verify — the enrolled account's login step. */
export interface TwoFactorVerifyBody {
  grant: string;
  code: string;
}

/**
 * Body of POST /auth/2fa/enroll/confirm. `grant` present = the login walk
 * (pre-auth; success mints the pair); absent = the settings flow (the
 * Bearer in the Authorization header answers for the account).
 */
export interface TwoFactorEnrollConfirmBody {
  code: string;
  grant?: string;
}

// ---------------------------------------------------------------------------
// Instance OIDC federated sign-in (#12)
// ---------------------------------------------------------------------------

/** POST /auth/oidc/start — carries the SPA's signed-out continuation (#114). */
export interface OidcStartBody {
  /** A validated relative path server-side; anything else is dropped there. */
  return_to?: string;
}

/** POST /auth/oidc/start — the provider authorize URL to redirect the browser to. */
export interface OidcStartResponse {
  authorize_url: string;
}

/** POST /auth/oidc/callback — the provider redirect's query, forwarded verbatim. */
export interface OidcCallbackBody {
  code: string;
  state: string;
}

/**
 * POST /auth/oidc/callback — the SAME pair POST /auth/login returns, plus
 * the one additive key: the sanitized signed-out continuation the start
 * carried (null → land at "/"). When the matched account has a confirmed
 * TOTP enrollment (and the 2FA switch is on) it is instead the login's
 * `totp_pending` step — POST /auth/2fa/verify swaps the grant for the pair —
 * still carrying `return_to`.
 */
export type OidcCallbackResponse =
  | (AuthTokens & { return_to: string | null })
  | { status: 'totp_pending'; grant: string; user: LoginStepUser; return_to: string | null };

/**
 * A ceremony's server half: the opaque single-use challenge id the client
 * echoes back on verify, plus the PublicKeyCredential{Creation|Request}OptionsJSON
 * the browser consumes (kept loose here — the shape is the WebAuthn spec's).
 */
export interface WebauthnOptions {
  challenge_id: string;
  public_key: Record<string, unknown>;
}

/** A stored passkey as the settings surface lists it. */
export interface WebauthnCredential {
  id: string;
  name: string | null;
  created_at: string;
  last_used_at: string | null;
}

/**
 * register/verify body: the browser's RegistrationResponseJSON passed through
 * VERBATIM (base64url fields, spec camelCase) plus the echo + display name.
 */
export interface WebauthnRegisterVerifyBody {
  challenge_id: string;
  name?: string;
  response: Record<string, unknown>;
}

/**
 * login/verify body: the browser's AuthenticationResponseJSON verbatim plus
 * the challenge echo. Returns the same AuthTokens pair as /auth/login.
 */
export interface WebauthnLoginVerifyBody {
  challenge_id: string;
  response: Record<string, unknown>;
}

/** Domain re-exports used directly at API-client call sites. */
export type { ListCursor, SearchFilters };

