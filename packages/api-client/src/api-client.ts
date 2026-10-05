/**
 * @cytale/api-client — typed REST client for every `/api/v1` endpoint
 * (U9 contract; tiered surface per the plan's API Surface Design).
 *
 * All list reads are snowflake-cursor paginated (`?before=&after=&limit=`)
 * returning `{ items, cursor }`; all mutating POSTs automatically carry an
 * `Idempotency-Key` header (crypto.randomUUID) so client retries never
 * double-send.
 */

import type {
  AuthTokens,
  NotificationPreferenceSet,
  Channel,
  CreateChannelBody,
  CreateInviteBody,
  CreatePushSubscriptionBody,
  CreateRoleBody,
  CreateThreadBody,
  CreateWorkspaceBody,
  CurrentUser,
  Invite,
  LoginBody,
  Message,
  PasswordResetCompleteBody,
  PermissionOverwrite,
  PublicInvite,
  PushSubscription,
  RegisterBody,
  ReorderChannelsBody,
  Role,
  SearchFilters,
  SearchResult,
  Thread,
  UpdateChannelBody,
  UpdateMessageBody,
  UpdateRoleBody,
  UpdateThreadBody,
  UpdateWorkspaceBody,
  UploadedAttachment,
  User,
  Workspace,
  WorkspaceMember,
} from '@cytale/domain';
import { normalizeChannelType } from '@cytale/domain';
import type {
  ApplicationCommand,
  Bot,
  CallStateResponse,
  ChannelMediaOverride,
  ChannelMediaOverrideView,
  CreatePrincipalBody,
  CreateWebhookBody,
  IceConfigResponse,
  InvokeComponentInteractionBody,
  MessageMark,
  SubmitModalBody,
  InvokeInteractionBody,
  ListParams,
  ListResponse,
  MintedPrincipalCredential,
  MyIntegration,
  NotificationPreference,
  NotificationPreferenceLevel,
  NotificationPreferenceScope,
  CreatedWebhook,
  MyWebhook,
  NotificationTestResult,
  ReactionUsersParams,
  ReactionUsersResponse,
  RegeneratedCredential,
  RequestOptions,
  SendMessageBody,
  ServerConfigDocument,
  ServerConfigSaveResult,
  UpdatePrincipalBody,
  UpdateWebhookBody,
  UploadFile,
  Webhook,
  WorkspaceMediaSettings,
  AuthMethods,
  OidcCallbackBody,
  OidcCallbackResponse,
  OidcStartBody,
  OidcStartResponse,
  WebauthnCredential,
  WebauthnLoginVerifyBody,
  WebauthnOptions,
  WebauthnRegisterVerifyBody,
  LoginResponse,
  TwoFactorEnrollConfirmBody,
  TwoFactorEnrollConfirmResponse,
  TwoFactorEnrollStart,
  TwoFactorStatus,
  TwoFactorVerifyBody,
} from './types.js';
import { ApiError, isNativeFileDescriptor } from './types.js';
import type { ClientErrorPayload } from './client-errors.js';
import { Http, type HttpLayerOptions } from './http.js';

/** People-directory parameters beyond the standard cursor set. */
export interface PeopleParams extends ListParams {
  /** Username-prefix/nickname substring filter (`?query=jan`). */
  query?: string;
}

/** A minted opaque permalink (#118): the token, and the absolute `/m/<token>` URL. */
export interface MintedPermalink {
  token: string;
  /** The server's own absolute URL (public origin), or `''` if it sent none. */
  url: string;
}

/** An opaque permalink read back to its target (#118). Ids are decimal strings. */
export interface ResolvedPermalink {
  channel_id: string;
  message_id: string;
}

/**
 * A fully-paged people read (`listAllPeople`). `truncated` means the page cap
 * stopped the walk with the server still holding pages — the caller decides
 * how loud to be about it (telemetry, a debug log, a "showing N of many").
 */
export interface PeoplePage {
  items: WorkspaceMember[];
  truncated: boolean;
}

const PAGE_DEFAULT = 50;

/**
 * Pages `listAllPeople` follows at most. The server answers 50 people per
 * page by default (max 100), so the cap bounds a single hydration leg at
 * 10 requests / 500 members — the point where "one more page" stops being
 * worth a launch-path round trip.
 */
export const PEOPLE_PAGE_CAP = 10;

export class CytaleApiClient {
  readonly #http: Http;

  constructor(options: HttpLayerOptions) {
    this.#http = new Http(options);
  }

  /** Build the absolute URL for a path (exposed for tests/debugging). */
  buildUrl(path: string): string {
    return this.#http.buildUrl(path);
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /** GET a cursor-paginated list endpoint. */
  async #list<T>(path: string, params?: ListParams): Promise<ListResponse<T>> {
    return await this.#http.request<ListResponse<T>>('GET', withQuery(path, params));
  }

  /** POST with automatic Idempotency-Key (crypto.randomUUID). */
  async #post<T>(path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    return await this.#http.request<T>('POST', path, {
      ...options,
      body,
      idempotencyKey: options.idempotencyKey ?? newIdempotencyKey(),
    });
  }

  async #patch<T>(path: string, body: unknown): Promise<T> {
    return await this.#http.request<T>('PATCH', path, { body });
  }

  async #put<T>(path: string, body: unknown): Promise<T> {
    return await this.#http.request<T>('PUT', path, { body });
  }

  async #delete<T>(path: string): Promise<T> {
    return await this.#http.request<T>('DELETE', path);
  }

  // -----------------------------------------------------------------------
  // Auth & accounts (/auth/*) — unauthenticated by definition
  // -----------------------------------------------------------------------

  async register(body: RegisterBody): Promise<AuthTokens> {
    return await this.#http.request('POST', '/auth/register', { body, auth: false });
  }

  async verifyEmail(body: { token: string }): Promise<void> {
    await this.#http.request('POST', '/auth/verify-email', { body, auth: false });
  }

  async resendVerification(email: string): Promise<void> {
    await this.#http.request('POST', '/auth/resend-verification', {
      body: { email },
      auth: false,
    });
  }

  async login(body: LoginBody): Promise<AuthTokens> {
    return await this.#http.request('POST', '/auth/login', { body, auth: false });
  }

  /**
   * #127 — the SAME POST /auth/login, typed for every branch it can take when
   * the server's 2FA switch is on (`totp_pending` / `enrollment_required` +
   * grant, or the classic pair). `login()` stays narrow-typed because the
   * shared SessionManager (web/native/terminal) accepts only the pair; only a
   * 2FA-aware caller (the web login page) needs the union.
   */
  async loginRaw(body: LoginBody): Promise<LoginResponse> {
    return await this.#http.request('POST', '/auth/login', { body, auth: false });
  }

  /**
   * Token refresh. Normally automatic (single-flight on 401 via Http); call
   * directly to rotate proactively before access-token expiry.
   */
  async refreshToken(): Promise<CurrentUser | null> {
    // Lane D #4: the exchange carries the account (the `@me` shape) on a
    // current server — handed back so a restore skips its `/users/@me` read.
    const { user } = await this.#http.refreshTokens();
    return isCurrentUser(user) ? user : null;
  }

  async requestPasswordReset(email: string): Promise<void> {
    await this.#http.request('POST', '/auth/password-reset/request', {
      body: { email },
      auth: false,
    });
  }

  async completePasswordReset(body: PasswordResetCompleteBody): Promise<void> {
    await this.#http.request('POST', '/auth/password-reset/complete', { body, auth: false });
  }

  // -----------------------------------------------------------------------
  // WebAuthn passkeys (#36)
  // -----------------------------------------------------------------------

  /**
   * GET /auth/methods — the login page's "which buttons" read. The passkey
   * bottom button renders only when the server says `webauthn: true`.
   */
  async getAuthMethods(): Promise<AuthMethods> {
    return await this.#http.request('GET', '/auth/methods', { auth: false });
  }

  /**
   * The WebAuthn ceremonies themselves happen in the BROWSER
   * (`navigator.credentials` via @simplewebauthn/browser); these methods only
   * carry the server round trips around them.
   */

  /** login/options — pre-auth, discoverable (no identifier: no oracle). */
  async webauthnLoginOptions(): Promise<WebauthnOptions> {
    return await this.#http.request('POST', '/auth/webauthn/login/options', { auth: false });
  }

  /** login/verify — returns the SAME AuthTokens pair as login(). */
  async webauthnLoginVerify(body: WebauthnLoginVerifyBody): Promise<AuthTokens> {
    return await this.#http.request('POST', '/auth/webauthn/login/verify', { body, auth: false });
  }

  /** register/options — authenticated; mints a single-use enrollment challenge. */
  async webauthnRegisterOptions(): Promise<WebauthnOptions> {
    return await this.#post('/auth/webauthn/register/options');
  }

  /** register/verify — attests and stores the credential. */
  async webauthnRegisterVerify(
    body: WebauthnRegisterVerifyBody
  ): Promise<{ credential: WebauthnCredential }> {
    return await this.#post('/auth/webauthn/register/verify', body);
  }

  /** The account's enrolled passkeys (settings list). */
  async listWebauthnCredentials(): Promise<{ credentials: WebauthnCredential[] }> {
    return await this.#http.request('GET', '/users/@me/webauthn/credentials');
  }

  /** Revoke one passkey (removing the server rows IS the revocation). */
  async deleteWebauthnCredential(credentialId: string): Promise<void> {
    await this.#delete(`/users/@me/webauthn/credentials/${encodeURIComponent(credentialId)}`);
  }

  // -----------------------------------------------------------------------
  // TOTP two-factor (#127)
  // -----------------------------------------------------------------------

  /**
   * POST /auth/2fa/verify — the enrolled account's login step: a live
   * `:totp` grant (minted by this login's password step) + the 6-digit code
   * swap for the SAME token pair login() returns. Refusals are ONE uniform
   * 401 (no oracle between a dead grant, an expired step, and a wrong code).
   */
  async twoFactorVerify(body: TwoFactorVerifyBody): Promise<AuthTokens> {
    return await this.#http.request('POST', '/auth/2fa/verify', { body, auth: false });
  }

  /**
   * POST /auth/2fa/enroll/start — generate the candidate secret. With a
   * `grant` (the forced login walk) the call is pre-auth and the grant
   * answers for the account; without one (settings) the Bearer does.
   * Returns the base32 secret + the otpauth URI the client renders as a QR.
   */
  async twoFactorEnrollStart(grant?: string): Promise<TwoFactorEnrollStart> {
    if (grant !== undefined) {
      return await this.#http.request('POST', '/auth/2fa/enroll/start', {
        body: { grant },
        auth: false,
      });
    }
    return await this.#post('/auth/2fa/enroll/start');
  }

  /**
   * POST /auth/2fa/enroll/confirm — verify the code against the candidate
   * secret; success arms the enrollment. The grant path's success CONSUMES
   * the grant and mints the token pair (the walk's exit into the shell); the
   * settings path just confirms (`{"enrolled": true}`).
   */
  async twoFactorEnrollConfirm(body: TwoFactorEnrollConfirmBody): Promise<TwoFactorEnrollConfirmResponse> {
    if (body.grant !== undefined) {
      return await this.#http.request('POST', '/auth/2fa/enroll/confirm', {
        body,
        auth: false,
      });
    }
    return await this.#post('/auth/2fa/enroll/confirm', { code: body.code });
  }

  /** GET /users/@me/two-factor — the settings read: the mode + this account's enrollment. */
  async twoFactorStatus(): Promise<TwoFactorStatus> {
    return await this.#http.request('GET', '/users/@me/two-factor');
  }

  /**
   * DELETE /users/@me/two-factor — remove the enrollment. Allowed while the
   * switch is on by design: the next password login simply re-prompts.
   */
  async twoFactorDelete(): Promise<void> {
    await this.#delete('/users/@me/two-factor');
  }

  // -----------------------------------------------------------------------
  // Instance OIDC federated sign-in (#12)
  // -----------------------------------------------------------------------

  /**
   * POST /auth/oidc/start — mint the single-use ceremony and get the
   * provider's authorize URL. The BROWSER follows it (a full-page redirect),
   * never fetch.
   */
  async oidcStart(body: OidcStartBody = {}): Promise<OidcStartResponse> {
    return await this.#http.request('POST', '/auth/oidc/start', { body, auth: false });
  }

  /** POST /auth/oidc/callback — the SAME AuthTokens pair as login(), plus the sanitized return_to. */
  async oidcCallback(body: OidcCallbackBody): Promise<OidcCallbackResponse> {
    return await this.#http.request('POST', '/auth/oidc/callback', { body, auth: false });
  }

  /** Self-service account deletion (soft-delete tombstone cascade). */
  async deleteAccount(): Promise<void> {
    await this.#delete('/account');
  }

  /**
   * DELETE /users/@me/sessions — revoke EVERY refresh token for the caller
   * (all devices, this one included) and close live gateway sockets. The
   * caller follows with a local logout; no session survives to ride.
   */
  async revokeAllSessions(): Promise<void> {
    await this.#delete('/users/@me/sessions');
  }

  // -----------------------------------------------------------------------
  // Server settings (#121, operator tier)
  // -----------------------------------------------------------------------

  /**
   * GET /admin/config — the current EDITABLE document plus per-key metadata
   * (type, scope, description) for the editor's help text. NEVER carries a
   * secret: secrets live in secrets.json and are not served, ever.
   */
  async getServerConfig(): Promise<ServerConfigDocument> {
    return await this.#http.request('GET', '/admin/config');
  }

  /**
   * PUT /admin/config — validate against the server schema → atomic write →
   * hot-apply the changed runtime-scoped keys. `restart_required` is true
   * when any boot-scoped key moved (follow with `restartServer`).
   */
  async putServerConfig(config: Record<string, unknown>): Promise<ServerConfigSaveResult> {
    return await this.#put('/admin/config', config);
  }

  /**
   * POST /admin/restart — graceful stop; the response is SENT before the
   * node goes down. Poll `/health` (same origin, unauthenticated) until it
   * answers, then reload.
   */
  async restartServer(): Promise<void> {
    await this.#post('/admin/restart');
  }

  // -----------------------------------------------------------------------
  // Client-error ingest (#88)
  // -----------------------------------------------------------------------

  /**
   * POST /client-errors — one client-side failure report.
   *
   * The route is UNAUTHENTICATED on the server (the most valuable crash to
   * capture happens on the login page, before anyone has a token), and
   * carrying a token when there is one is what makes the row user-attributed
   * rather than anonymous — the server decides, the client only presents.
   *
   * Deliberately built on `request` rather than `#post`: an Idempotency-Key
   * would be meaningless here (a duplicate is prevented client-side by
   * fingerprinting, and the key generator is not present in every runtime),
   * and no failure of this call may escalate into session machinery.
   */
  async reportClientError(payload: ClientErrorPayload): Promise<void> {
    await this.#http.request<void>('POST', '/client-errors', { body: payload });
  }

  // -----------------------------------------------------------------------
  // Users (@me + people directory)
  // -----------------------------------------------------------------------

  async getCurrentUser(): Promise<CurrentUser> {
    return await this.#http.request('GET', '/users/@me');
  }

  async updateCurrentUser(
    patch: Partial<Pick<User, 'display_name' | 'avatar_url'>>
  ): Promise<CurrentUser> {
    return await this.#http.request('PATCH', '/users/@me', { body: patch });
  }

  /**
   * Set or clear (null/blank) a workspace nickname (#169):
   * `PATCH /workspaces/{id}/members/{user_id|@me}`. Your own needs
   * CHANGE_NICKNAME; anyone else's MANAGE_NICKNAMES above them in the role
   * hierarchy. The server announces `MemberUpdate`, which every client
   * (this one included) applies to its store.
   */
  async setNickname(
    workspaceId: string,
    userId: string | '@me',
    nickname: string | null,
  ): Promise<{ workspace_id: string; user_id: string; nickname: string | null }> {
    return await this.#http.request('PATCH', `/workspaces/${workspaceId}/members/${userId}`, {
      body: { nickname },
    });
  }

  /**
   * People directory: `GET /workspaces/{id}/people?query=&before=&after=&limit=`
   * backed by the ScyllaDB membership query with Discord-style pagination.
   */
  async listPeople(workspaceId: string, params: PeopleParams = {}): Promise<ListResponse<WorkspaceMember>> {
    // Server route answers with {"people": [...], "next_before": ...}
    // (UserController.people), not {"items": [...]} — unwrap it here. Returning
    // the raw envelope left `.items` undefined for every caller, which threw
    // inside the mobile hydrator's setState and silently left the roster empty.
    const searchParams = toSearchParams(params as Record<string, unknown>);
    const res = await this.#http.request<{
      people?: WorkspaceMember[];
      items?: WorkspaceMember[];
      next_before?: string | null;
    }>('GET', `/workspaces/${workspaceId}/people${searchParams.size ? `?${searchParams}` : ''}`);
    const items = res.people ?? res.items ?? [];
    return {
      items,
      cursor: { before: res.next_before ?? null, after: null, limit: items.length },
    };
  }

  /**
   * Every page of the people directory, following the server's `next_before`
   * cursor. A single `listPeople` read truncates silently: the server's
   * default page is 50, and it answers `next_before: null` only when the
   * roster is exhausted (a short HUMAN page — machine entries ride along and
   * never key the cursor, so the page can carry more rows than `limit`).
   *
   * Bounded by design: at most `PEOPLE_PAGE_CAP` pages. `truncated` reports
   * that the cap was hit with pages still outstanding — the read is partial
   * BY CHOICE and the caller owns the note (this layer has no logger).
   */
  async listAllPeople(workspaceId: string, params: PeopleParams = {}): Promise<PeoplePage> {
    const items: WorkspaceMember[] = [];
    let before: string | null = null;

    for (let page = 0; page < PEOPLE_PAGE_CAP; page++) {
      const res = await this.listPeople(
        workspaceId,
        before === null ? params : { ...params, before },
      );
      items.push(...res.items);

      const next = res.cursor.before;
      // Exhausted, or the cursor failed to advance (a server bug we must not
      // turn into an infinite launch-path loop).
      if (next === null || next === before) return { items, truncated: false };
      before = next;
    }

    return { items, truncated: true };
  }

  async getPerson(workspaceId: string, userId: string): Promise<WorkspaceMember> {
    return await this.#http.request('GET', `/workspaces/${workspaceId}/people/${userId}`);
  }

  // -----------------------------------------------------------------------
  // Workspaces
  // -----------------------------------------------------------------------

  async createWorkspace(body: CreateWorkspaceBody): Promise<Workspace> {
    // POST /workspaces returns the {"workspace": ...} envelope (unified
    // with every other workspace write) — unwrap it here.
    const res = await this.#post<{ workspace: Workspace }>('/workspaces', body);
    return res.workspace;
  }

  async listWorkspaces(): Promise<ListResponse<Workspace>> {
    // Server route is GET /users/@me/workspaces with envelope {"workspaces": [...]}
    // (U9). Unwrap to ListResponse.
    const res = await this.#http.request<{ workspaces?: Workspace[]; items?: Workspace[] }>(
      'GET',
      '/users/@me/workspaces',
    );
    const items = res.workspaces ?? res.items ?? [];
    return { items, cursor: { before: null, after: null, limit: items.length } };
  }

  async getWorkspace(id: string): Promise<Workspace> {
    return await this.#http.request('GET', `/workspaces/${id}`);
  }

  /**
   * The CALLER's effective workspace-level permission bits (decimal-string
   * bitfield), read off `GET /workspaces/{id}` — `null` when the server does
   * not report them (older servers). Channel overwrites do not apply here.
   */
  async getWorkspacePermissions(id: string): Promise<string | null> {
    const res = await this.#http.request<{ permissions?: string | null }>(
      'GET',
      `/workspaces/${id}?limit=1`,
    );
    return typeof res.permissions === 'string' ? res.permissions : null;
  }

  async updateWorkspace(id: string, body: UpdateWorkspaceBody): Promise<{ workspace: Workspace }> {
    // The PATCH returns the {workspace} envelope raw (same shape as the
    // icon upload endpoint).
    return await this.#patch(`/workspaces/${id}`, body);
  }

  async deleteWorkspace(id: string): Promise<void> {
    await this.#delete(`/workspaces/${id}`);
  }

  // -----------------------------------------------------------------------
  // Channels
  // -----------------------------------------------------------------------

  /** Wire → domain channel: the server's numeric type column becomes the
   *  string union, and parent_id normalizes to string|null. */
  #normalizeChannel(ch: Channel): Channel {
    const raw = ch as unknown as { type?: unknown; parent_id?: string | null };
    return {
      ...ch,
      type: normalizeChannelType(raw.type),
      parent_id: raw.parent_id ?? null,
    };
  }

  async createChannel(workspaceId: string, body: CreateChannelBody): Promise<Channel> {
    // Server envelope: {"channel": {...}} (U9) — unwrap so consumers get the
    // channel itself.
    const res = await this.#post<{ channel?: Channel }>(`/workspaces/${workspaceId}/channels`, body);
    return this.#normalizeChannel(res.channel ?? (res as unknown as Channel));
  }

  /**
   * Thread roster for a channel. Archived threads are excluded by default;
   * pass `includeArchived` for the channel's Threads list panel.
   */
  async listThreads(
    channelId: string,
    opts: { includeArchived?: boolean } = {},
  ): Promise<Thread[]> {
    const query = opts.includeArchived ? '?include_archived=true' : '';
    const res = await this.#http.request<{ threads?: Thread[] }>(
      'GET',
      `/channels/${channelId}/threads${query}`,
    );
    return res.threads ?? [];
  }

  /**
   * POST /channels/{channel_id}/messages/{message_id}/threads — start a
   * thread hanging off a parent message (U22). The name is REQUIRED by the
   * server contract (validation_failed otherwise). Returns the created
   * thread; the ThreadCreate gateway publish converges other clients.
   */
  async startThread(channelId: string, messageId: string, name: string): Promise<Thread> {
    const res = await this.#post<{ thread?: Thread }>(
      `/channels/${channelId}/messages/${messageId}/threads`,
      { name },
    );
    if (!res.thread) throw new Error('Thread start returned no thread.');
    return res.thread;
  }

  async listChannels(workspaceId: string): Promise<ListResponse<Channel>> {
    // Server envelope: {"channels": [...]} (U9). Unwrap to ListResponse.
    const res = await this.#http.request<{ channels?: Channel[]; items?: Channel[] }>(
      'GET',
      `/workspaces/${workspaceId}/channels`,
    );
    const items = (res.channels ?? res.items ?? []).map((ch) => this.#normalizeChannel(ch));
    return { items, cursor: { before: null, after: null, limit: items.length } };
  }

  async getChannel(id: string): Promise<Channel> {
    return this.#normalizeChannel(await this.#http.request('GET', `/channels/${id}`));
  }

  async updateChannel(id: string, body: UpdateChannelBody): Promise<Channel> {
    return this.#normalizeChannel(await this.#patch(`/channels/${id}`, body));
  }

  async deleteChannel(id: string): Promise<void> {
    await this.#delete(`/channels/${id}`);
  }

  /** POST /workspaces/{id}/channels/reorder — full desired display order. */
  async reorderChannels(workspaceId: string, body: ReorderChannelsBody): Promise<{ channels: Channel[] }> {
    return await this.#post(`/workspaces/${workspaceId}/channels/reorder`, body);
  }

  // -----------------------------------------------------------------------
  // Voice calls (calls plan U1 — durable per-channel call surface)
  // -----------------------------------------------------------------------

  /**
   * GET /channels/{id}/call — the standing call-log thread anchor, the live
   * call + roster (if any), and a bounded recently-ended list. All three
   * fields are always present; `live` is null when idle. View-gated by the
   * uniform channel gate (404 anti-enumeration). The thread id feeds the
   * store's call-log exclusion (R5, via setCallLogThread); the boundary
   * records feed U9's log surfaces.
   */
  async getCall(channelId: string): Promise<CallStateResponse> {
    return await this.#http.request('GET', `/channels/${channelId}/call`);
  }

  /**
   * PATCH /channels/{id}/call-notification-mute — set or clear the caller's
   * per-room ring mute (calls plan U4/U11, AM6's durable setting; the server
   * excludes muted members from CALL_RING delivery). Body `{"muted": bool}`;
   * the server echoes `{"muted": bool}`.
   */
  async setCallNotificationMute(
    channelId: string,
    muted: boolean
  ): Promise<{ muted: boolean }> {
    return await this.#patch(`/channels/${channelId}/call-notification-mute`, { muted });
  }

  /** Clear the per-room ring mute (PATCH with `{"muted": false}`). */
  async clearCallNotificationMute(channelId: string): Promise<{ muted: boolean }> {
    return await this.setCallNotificationMute(channelId, false);
  }

  /**
   * GET /calls/ice — the caller's ICE configuration for call media (calls
   * plan U12): the minted TURN entry when the deploy configures TURN, else
   * [] (host candidates — the no-TURN degradation). Credentials are
   * short-lived (~1h); fetch fresh at call-join time.
   */
  async getIceServers(): Promise<IceConfigResponse> {
    return await this.#http.request('GET', '/calls/ice');
  }

  // -----------------------------------------------------------------------
  // Workspace media settings (calls V2 plan U8 — R16/R17)
  // -----------------------------------------------------------------------

  /**
   * GET /workspaces/{id}/media-settings — the workspace's master media
   * toggles (owner/admin; a member without `manage_workspace` gets 403,
   * which the settings surface renders as its permission-denied state).
   */
  async getWorkspaceMediaSettings(workspaceId: string): Promise<WorkspaceMediaSettings> {
    const res = await this.#http.request<{ media_settings?: WorkspaceMediaSettings }>(
      'GET',
      `/workspaces/${workspaceId}/media-settings`,
    );
    return res.media_settings ?? (res as unknown as WorkspaceMediaSettings);
  }

  /**
   * PUT /workspaces/{id}/media-settings — partial update; absent keys keep
   * their current values. Returns the merged settings (the server echo is
   * authoritative).
   */
  async putWorkspaceMediaSettings(
    workspaceId: string,
    patch: Partial<WorkspaceMediaSettings>
  ): Promise<WorkspaceMediaSettings> {
    const res = await this.#put<{ media_settings?: WorkspaceMediaSettings }>(
      `/workspaces/${workspaceId}/media-settings`,
      patch
    );
    return res.media_settings ?? (res as unknown as WorkspaceMediaSettings);
  }

  /**
   * GET /channels/{id}/media-override — the channel's tri-state override +
   * the workspace master + `overrides_allowed` in one read (manage-channels
   * tier; plain members 403 — callers treat that as "override affordances
   * hidden"). DM and foreign channels render the anti-enumeration 404.
   */
  async getChannelMediaOverride(channelId: string): Promise<ChannelMediaOverrideView> {
    return await this.#http.request('GET', `/channels/${channelId}/media-override`);
  }

  /**
   * PUT /channels/{id}/media-override — write the channel's FULL tri-state
   * override map (a boolean sets the explicit value; null resets that
   * capability to inherit the master). Echoes the full view. A workspace
   * with overrides disallowed answers 409 `overrides_not_allowed`.
   */
  async putChannelMediaOverride(
    channelId: string,
    override: ChannelMediaOverride
  ): Promise<ChannelMediaOverrideView> {
    return await this.#put(`/channels/${channelId}/media-override`, override);
  }

  // -----------------------------------------------------------------------
  // Messages
  // -----------------------------------------------------------------------

  /**
   * Channel history — newest-first page before/after an id cursor. Returns
   * typed `Message[]` directly (spec happy-path shape).
   *
   * Exactly U9's `GET /channels/{id}/messages?before=<snowflake>&limit=50`.
   */
  async getMessages(channelId: string, params: ListParams = {}): Promise<Message[]> {
    const page = await this.getMessagePage(channelId, params);
    return page.items;
  }

  /** Same read but including cursor metadata for deep-pagination loops. */
  async getMessagePage(channelId: string, params: ListParams = {}): Promise<ListResponse<Message>> {
    // Server envelope: {"messages": [...], "oldest_id", "newest_id"} (U9,
    // #152). Unwrap.
    const res = await this.#http.request<HistoryEnvelope>(
      'GET',
      `/channels/${channelId}/messages${withQueryText(params)}`
    );
    return historyPage(res, params);
  }

  /**
   * Resolve ONE message by id (#114) — `GET /channels/{id}/messages/{mid}`,
   * the permalink read `docs/protocol/rest.md` advertises.
   *
   * Used when a message LINK points at something outside the loaded window:
   * the caller merges the row and scrolls to it. A message that no longer
   * exists — or a channel the caller may not read — rejects with the route's
   * single uniform 404 (`ApiError.status === 404`, indistinguishable by
   * design), which is what "this message is gone" is derived from.
   */
  async getMessage(channelId: string, messageId: string): Promise<Message> {
    const res = await this.#http.request<{ message?: Message }>(
      'GET',
      `/channels/${channelId}/messages/${messageId}`
    );
    return res.message ?? (res as unknown as Message);
  }

  /**
   * Send a channel message. `body.attachments` (SendMessageBody) binds
   * previously-uploaded attachment rows into the message at create time.
   */
  async sendMessage(
    channelId: string,
    body: SendMessageBody,
    idempotencyKey?: string,
    options: { timeoutMs?: number } = {}
  ): Promise<Message> {
    // Server envelope: {"message": {...}} — unwrap here, once, so consumers
    // never re-derive the shape (and can't build rows from the envelope's
    // top level).
    const res = await this.#post<{ message?: Message }>(`/channels/${channelId}/messages`, body, {
      idempotencyKey,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return res.message ?? (res as unknown as Message);
  }

  async editMessage(channelId: string, messageId: string, body: UpdateMessageBody): Promise<Message> {
    const res = await this.#patch<{ message?: Message }>(
      `/channels/${channelId}/messages/${messageId}`,
      body,
    );
    return res.message ?? (res as unknown as Message);
  }

  async deleteMessage(channelId: string, messageId: string): Promise<void> {
    await this.#delete(`/channels/${channelId}/messages/${messageId}`);
  }

  /**
   * Mint an opaque permalink for a message (#118) — `POST /permalinks`.
   *
   * The token is keyed server-side, so this is the ONLY way a client gets one:
   * "Copy Link" calls this and writes the returned `url` (`…/m/<token>`) to the
   * clipboard. Both ends are member-gated on the CHANNEL, so a caller who
   * cannot read the channel gets the same 404 a nonexistent channel gets —
   * which is what the callers' failure affordance keys on (a failed mint is
   * reported AS a failure, never papered over with a stale link).
   *
   * The server also returns `url`, built from the deployment's public origin —
   * for clients that have no origin of their own (the terminal, a bot). The
   * web client builds its own through `permalinkOrigin()`, because in the
   * packaged shell `location.origin` is `tauri://localhost`.
   */
  async mintPermalink(channelId: string, messageId: string): Promise<MintedPermalink> {
    const res = await this.#http.request<{ token?: string; url?: string }>('POST', '/permalinks', {
      body: { channel_id: channelId, message_id: messageId },
    });
    if (!res.token) {
      throw new ApiError({
        key: 'malformed_response',
        code: 50201,
        message: 'Permalink mint returned no token',
        status: 502,
      });
    }
    return { token: res.token, url: res.url ?? '' };
  }

  /**
   * Read an opaque permalink back to its ids (#118) — `GET /permalinks/{token}`,
   * what the SPA calls when a visitor opens `/m/{token}`.
   *
   * Gated identically to the mint, and every miss is ONE 404: an unknown token,
   * a tampered one, and a channel the caller cannot see are indistinguishable
   * (`ApiError.status === 404`), so this call can never be used to learn that a
   * channel exists. The caller turns the pair into the ordinary
   * `#/…message/…` route and reuses the #114 landing.
   */
  async resolvePermalink(token: string): Promise<ResolvedPermalink> {
    const res = await this.#http.request<{ channel_id?: string; message_id?: string }>(
      'GET',
      `/permalinks/${encodeURIComponent(token)}`
    );
    if (!res.channel_id || !res.message_id) {
      throw new ApiError({
        key: 'malformed_response',
        code: 50201,
        message: 'Permalink resolve returned no target',
        status: 502,
      });
    }
    return { channel_id: res.channel_id, message_id: res.message_id };
  }

  /**
   * Read-state fallback for non-realtime paths (POST /channels/{id}/ack).
   *
   * The server requires a NON-EMPTY `message_ids` LIST and 400s on anything
   * else (`CytaleWeb.MessageController.ack/2` matches
   * `%{"message_ids" => ids} when is_list(ids) and ids != []`, and its
   * catch-all clause answers `validation_failed` / "message_ids is required").
   * The single-`message_id` body this method used to send carried no such key
   * and so failed every call; it had no production caller until the terminal
   * client became its first one. The ack owns the watermark only — the server
   * never clears `unread_floor` here.
   *
   * `unreadFloor` is the route's optional second half (U2, terminal plan R22).
   * `last_read_id` is INCLUSIVE, so the ack alone can only ever mark things
   * read; a floor is the only way to say "this message is unread" and have the
   * server remember it. It is a message id — that message is unread and
   * everything older is read — and `null` clears it.
   *
   * The three states are deliberately distinct and the body reflects all
   * three: omitted key leaves the floor alone (what every pre-floor caller
   * wants, and what the server does when the key is absent), `null` clears it,
   * and an id sets it.
   */
  async ackChannel(
    channelId: string,
    messageId: string,
    options: { readonly unreadFloor?: string | null } = {},
  ): Promise<void> {
    const body: Record<string, unknown> = { message_ids: [messageId] };
    if ('unreadFloor' in options) body.unread_floor = options.unreadFloor;
    await this.#post(`/channels/${channelId}/ack`, body);
  }

  // -----------------------------------------------------------------------
  // Reactions (own-reaction toggle + reactor listing; raw-Unicode emoji only)
  // -----------------------------------------------------------------------

  /**
   * Add the caller's own reaction (`PUT /channels/{id}/messages/{mid}/
   * reactions/{emoji}/@me` → 204). Emoji is raw Unicode, percent-encoded
   * into the path segment.
   */
  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.#http.request(
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  /** Remove the caller's own reaction (DELETE @me route → 204). */
  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await this.#delete(
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`,
    );
  }

  /**
   * Page through a reaction's users (`GET .../reactions/{emoji}?limit=&after=`
   * → `{"users": [...], "next_after"}`). `next_after` feeds the next call's
   * `after`; null (or a short page) ends the loop.
   */
  async listReactionUsers(
    channelId: string,
    messageId: string,
    emoji: string,
    params: ReactionUsersParams = {},
  ): Promise<ReactionUsersResponse> {
    return await this.#http.request(
      'GET',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}${withQueryText(params)}`,
    );
  }

  // -----------------------------------------------------------------------
  // Threads
  // -----------------------------------------------------------------------

  async getThread(threadId: string): Promise<Thread> {
    return await this.#http.request('GET', `/threads/${threadId}`);
  }

  async updateThread(threadId: string, body: UpdateThreadBody): Promise<Thread> {
    // Server envelope: {"thread": {...}} (ThreadController.update, #109) —
    // unwrap it here so callers get the thread the same way every other
    // thread read hands it over, and never a raw envelope.
    const res = await this.#patch<{ thread?: Thread }>(`/threads/${threadId}`, body);
    return res.thread ?? (res as unknown as Thread);
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.#delete(`/threads/${threadId}`);
  }

  async getThreadMessages(threadId: string, params: ListParams = {}): Promise<Message[]> {
    return (await this.getThreadMessagePage(threadId, params)).items;
  }

  /**
   * A thread's replies with real cursors (#152). The read is thread-scoped
   * server-side, so a page SHORTER than the requested limit means there is
   * nothing further in that direction — `before: oldest_id` pages older,
   * `after: newest_id` pages newer.
   */
  async getThreadMessagePage(threadId: string, params: ListParams = {}): Promise<ListResponse<Message>> {
    const res = await this.#http.request<HistoryEnvelope>(
      'GET',
      `/threads/${threadId}/messages${withQueryText(params)}`
    );
    return historyPage(res, params);
  }

  async sendThreadMessage(
    threadId: string,
    body: SendMessageBody,
    idempotencyKey?: string,
    options: { timeoutMs?: number } = {}
  ): Promise<Message> {
    const res = await this.#post<{ message?: Message }>(`/threads/${threadId}/messages`, body, {
      idempotencyKey,
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
    return res.message ?? (res as unknown as Message);
  }

  /**
   * Follow/unfollow a thread — PATCH /threads/{id}/members/@me {notify}
   * (the shipped contract; the older `/threads/{id}/follow` shape does not
   * exist server-side and silently 404'd the bell toggle).
   */
  async followThread(threadId: string): Promise<void> {
    await this.#patch(`/threads/${threadId}/members/@me`, { notify: true });
  }

  async unfollowThread(threadId: string): Promise<void> {
    await this.#patch(`/threads/${threadId}/members/@me`, { notify: false });
  }

  /**
   * Mark a thread unread — PATCH members/@me with an explicit null read
   * state (the server treats an absent key as unchanged, null as cleared).
   */
  async markThreadUnread(threadId: string): Promise<void> {
    await this.#patch(`/threads/${threadId}/members/@me`, { last_read_id: null });
  }

  /** Leave a thread (drops the caller's membership + unread state). */
  async leaveThread(threadId: string): Promise<void> {
    await this.#delete(`/threads/${threadId}/members/@me`);
  }

  // -----------------------------------------------------------------------
  // Roles (admin-tier CRUD gated by permissions server-side)
  // -----------------------------------------------------------------------

  async createRole(workspaceId: string, body: CreateRoleBody): Promise<Role> {
    return await this.#post(`/workspaces/${workspaceId}/roles`, body);
  }

  async listRoles(workspaceId: string): Promise<ListResponse<Role>> {
    // Server route answers with the envelope {"roles": [...]} (RoleController),
    // not {"items": [...]} — unwrap it here so `.items` is never undefined.
    const res = await this.#http.request<{ roles?: Role[]; items?: Role[] }>(
      'GET',
      `/workspaces/${workspaceId}/roles`,
    );
    const items = res.roles ?? res.items ?? [];
    return { items, cursor: { before: null, after: null, limit: items.length } };
  }

  async updateRole(workspaceId: string, roleId: string, body: UpdateRoleBody): Promise<Role> {
    return await this.#patch(`/admin/workspaces/${workspaceId}/roles/${roleId}`, body);
  }

  async deleteRole(workspaceId: string, roleId: string): Promise<void> {
    await this.#delete(`/admin/workspaces/${workspaceId}/roles/${roleId}`);
  }

  /** Replace a channel's overwrite set (admin tier; hierarchy-gated). */
  async putChannelOverwrites(
    channelId: string,
    overwrites: PermissionOverwrite[]
  ): Promise<{ overwrites: PermissionOverwrite[] }> {
    return await this.#put(`/channels/${channelId}/overwrites`, { overwrites });
  }

  // -----------------------------------------------------------------------
  // Invites
  // -----------------------------------------------------------------------

  /** Create a revocable, optionally-expiring invite. */
  async createInvite(workspaceId: string, body: CreateInviteBody = {}): Promise<Invite> {
    return await this.#post(`/workspaces/${workspaceId}/invites`, body);
  }

  async listInvites(workspaceId: string): Promise<ListResponse<Invite>> {
    return await this.#list(`/workspaces/${workspaceId}/invites`);
  }

  async revokeInvite(workspaceId: string, code: string): Promise<void> {
    await this.#delete(`/admin/workspaces/${workspaceId}/invites/${code}`);
  }

  /** Admin invite governance: every workspace invite, not just own. */
  async adminListInvites(workspaceId: string): Promise<ListResponse<Invite>> {
    return await this.#list(`/admin/workspaces/${workspaceId}/invites`);
  }

  /** Public (no-auth) invite resolution for the join flow (U20). */
  async resolveInvite(code: string): Promise<PublicInvite> {
    return await this.#http.request('GET', `/invites/${code}`, { auth: false });
  }

  // -----------------------------------------------------------------------
  // DMs
  // -----------------------------------------------------------------------

  /**
   * Wire → domain DM channel. `GET/POST` DM rows carry
   * `{id, user_ids, recipients, created_at, last_message_id}` — no `type`,
   * `workspace_id`, or `name`. The rows are DMs by definition, so the type
   * is completed rather than derived (the same normalization the TUI's
   * hydration owns until this boundary was fixed here); without it every
   * row fails the DM column's `type === 'dm'` filter.
   */
  #normalizeDmChannel(row: Channel): Channel {
    return {
      ...row,
      type: 'dm',
      workspace_id: row.workspace_id ?? null,
      name: row.name ?? '',
      parent_id: row.parent_id ?? null,
    };
  }

  async listDMChannels(_params: ListParams = {}): Promise<ListResponse<Channel>> {
    // Server route is GET /users/@me/channels with envelope {"channels": [...]}
    // (U9) — unwrap to ListResponse, like listChannels/listWorkspaces. The
    // endpoint is not paginated (the param is accepted and ignored).
    const res = await this.#http.request<{ channels?: Channel[]; items?: Channel[] }>(
      'GET',
      '/users/@me/channels',
    );
    const items = (res.channels ?? res.items ?? []).map((ch) => this.#normalizeDmChannel(ch));
    return { items, cursor: { before: null, after: null, limit: items.length } };
  }

  /**
   * Open (or fetch) the 1:1 DM with a user — `POST /users/{user_id}/channels`.
   * The server dedupes: an existing pair's row returns with 200, a fresh one
   * with 201; both bodies are the same `{channel}` envelope.
   */
  async createDM(userId: string): Promise<Channel> {
    const res = await this.#post<{ channel?: Channel }>(`/users/${userId}/channels`);
    const channel = res.channel ?? (res as unknown as Channel);
    return this.#normalizeDmChannel(channel);
  }

  /**
   * NOT WIRED server-side: no group-DM route exists (only the 1:1
   * `POST /users/:user_id/channels`). Declared for the Discord-parity
   * surface; calling it today surfaces the server's validation error.
   */
  async createGroupDM(body: { recipient_ids: string[]; name?: string }): Promise<Channel> {
    return await this.#post('/users/@me/channels', body);
  }

  async sendDM(channelId: string, content: string, idempotencyKey?: string): Promise<Message> {
    return await this.sendMessage(channelId, { content }, idempotencyKey);
  }

  // -----------------------------------------------------------------------
  // Search (workspace + DM segment per U13's two-segment topology)
  // -----------------------------------------------------------------------

  /** Workspace-segment message search with from:/in:/before:/after: filters. */
  async searchWorkspace(
    workspaceId: string,
    q: string,
    filters: SearchFilters & ListParams = {}
  ): Promise<SearchResult> {
    const params = toSearchParams(filters as Record<string, unknown>);
    params.set('q', q);
    return await this.#http.request('GET', `/workspaces/${workspaceId}/search?${params}`);
  }

  /** DM-segment search against the dedicated `_dm` index segment. */
  async searchDMs(q: string, filters: SearchFilters & ListParams = {}): Promise<SearchResult> {
    const params = toSearchParams(filters as Record<string, unknown>);
    params.set('q', q);
    return await this.#http.request('GET', `/users/@me/search?${params}`);
  }

  // -----------------------------------------------------------------------
  // Machine principals — bots (workspace-scoped, manage_workspace-gated)
  // -----------------------------------------------------------------------
  // Bots (user-owned) — createBot / listBots / updateBot / regenerateBotToken
  // / deleteBot below. There is no workspace-scoped bot surface any more: a
  // machine credential is always user-owned and its workspaces appear only as
  // grants in its access document. The vocabulary is bot (the URL, the kind,
  // `cytbot_`); "Agent" is only the word the UI shows.

  // -----------------------------------------------------------------------
  // Machine principals — agents (user-scoped; the caller's own)
  // -----------------------------------------------------------------------

  /**
   * Mint a personal agent (parent = caller). Unverified callers → 403
   * `ACCOUNT_UNVERIFIED`; machine callers → 403. Response carries the
   * once-only credential.
   */
  async createBot(body: CreatePrincipalBody): Promise<MintedPrincipalCredential> {
    return await this.#post('/bots', body);
  }

  /** List the caller's agents (metadata only; `{"agents": [...]}`). */
  async listBots(): Promise<Bot[]> {
    const res = await this.#http.request<{ bots?: Bot[] }>('GET', '/bots');
    return res.bots ?? [];
  }

  /** Rename and/or change an agent's restrictions (same semantics as bots). */
  async updateBot(botId: string, body: UpdatePrincipalBody): Promise<Bot> {
    return await this.#patch(`/bots/${botId}`, body);
  }

  /** Rotate an agent's credential (same rotation semantics as bots). */
  async regenerateBotToken(botId: string): Promise<RegeneratedCredential> {
    return await this.#post(`/bots/${botId}/regenerate`);
  }

  /** Revoke an agent (idempotent; 4004 teardown; provenance survives). */
  async deleteBot(botId: string): Promise<void> {
    await this.#delete(`/bots/${botId}`);
  }

  /**
   * Upload an avatar for a bot (#126): multipart `file`, raster images, the
   * same limits as the human avatar path. Owner-scoped — the caller must be
   * the bot's parent. Sets `avatar_url` atomically with the upload; the
   * response carries the updated row.
   */
  async setBotAvatar(botId: string, file: UploadFile, filename?: string): Promise<Bot> {
    const form = new FormData();
    appendUploadFile(form, 'file', file, filename);
    return await this.#post(`/bots/${botId}/avatar`, form);
  }

  /** Clear a bot's avatar — back to the initial-letter fallback. */
  async clearBotAvatar(botId: string): Promise<Bot> {
    return await this.#delete(`/bots/${botId}/avatar`);
  }

  /**
   * GET /users/@me/integrations — the caller's machine principals (bots +
   * agents) with a live-session flag: the settings surface's cross-workspace
   * "My integrations" rollup. Metadata only, never tokens.
   */
  async listMyIntegrations(): Promise<MyIntegration[]> {
    const res = await this.#http.request<{ integrations?: MyIntegration[] }>(
      'GET',
      '/users/@me/integrations',
    );
    return res.integrations ?? [];
  }

  // -----------------------------------------------------------------------
  // Notification preferences (notifications plan U2/U10)
  // -----------------------------------------------------------------------

  /**
   * GET /users/@me/notification-preferences — every override the caller holds.
   *
   * Only OVERRIDES come back. An entity with no row inherits, and the surface
   * resolves that locally so it can name the layer that decided each level.
   */
  async listNotificationPreferences(): Promise<NotificationPreference[]> {
    const res = await this.#http.request<{ preferences?: NotificationPreference[] }>(
      'GET',
      '/users/@me/notification-preferences',
    );
    return res.preferences ?? [];
  }

  /**
   * GET /users/@me/notification-preferences — the overrides AND the
   * per-workspace "Suppress @everyone and @here" switch, in one read.
   *
   * The shared preference store (`@cytale/state`'s notification preferences)
   * hydrates from this; `listNotificationPreferences` stays for callers that
   * only need the levels. An older server that sends no switch list reads as
   * "nothing suppressed", which is the server-side default too.
   */
  async getNotificationPreferences(): Promise<NotificationPreferenceSet> {
    const res = await this.#http.request<Partial<NotificationPreferenceSet>>(
      'GET',
      '/users/@me/notification-preferences',
    );
    return {
      preferences: res.preferences ?? [],
      suppress_broadcasts: res.suppress_broadcasts ?? [],
    };
  }

  /**
   * PUT /users/@me/notification-preferences with `suppress_broadcasts` — turn
   * a workspace's "Suppress @everyone and @here" switch on or off. Off deletes
   * the server row (absent = broadcasts count).
   */
  async setBroadcastSuppression(workspaceId: string, suppress: boolean): Promise<void> {
    await this.#put('/users/@me/notification-preferences', {
      scope: 'workspace',
      entity_id: workspaceId,
      suppress_broadcasts: suppress,
    });
  }

  /**
   * PUT /users/@me/notification-preferences — set one layer's level.
   *
   * `entityId` is required for the workspace, channel (a workspace channel or
   * a DM) and thread layers and omitted for the account layer, which has
   * exactly one setting.
   */
  async setNotificationPreference(
    scope: NotificationPreferenceScope,
    level: NotificationPreferenceLevel,
    entityId?: string,
  ): Promise<void> {
    await this.#put('/users/@me/notification-preferences', {
      scope,
      level,
      ...(entityId === undefined ? {} : { entity_id: entityId }),
    });
  }

  /** DELETE /users/@me/notification-preferences/{scope}/{entity_id} — return an entity to inherit. */
  async clearNotificationPreference(
    scope: NotificationPreferenceScope,
    entityId: string,
  ): Promise<void> {
    await this.#delete(`/users/@me/notification-preferences/${scope}/${entityId}`);
  }

  // -----------------------------------------------------------------------
  // Webhooks. Two readers, deliberately different shapes:
  //   * the CREATOR's own list (below) — the only read carrying the URL;
  //   * the DESTINATION's governance read (`listWebhooks`) — no URL, because
  //     its reader is a channel manager who is usually not the creator.
  // -----------------------------------------------------------------------

  /**
   * Create an incoming webhook for a channel. The response carries the full
   * capability URL — to its creator, ONCE.
   *
   * That "once" is a deliberate divergence from Discord, which re-views the
   * token on every channel list read; see `listWebhooks`.
   */
  async createWebhook(channelId: string, body: CreateWebhookBody): Promise<CreatedWebhook> {
    return await this.#post(`/channels/${channelId}/webhooks`, body);
  }

  /**
   * A channel's webhooks, WITHOUT capability URLs — the destination's
   * governance read. A manager sees what posts into their channel and can stop
   * it; the token is not theirs. The creator's own read is `listMyWebhooks`.
   */
  async listWebhooks(channelId: string): Promise<Webhook[]> {
    const res = await this.#http.request<{ webhooks?: Webhook[] }>(
      'GET',
      `/channels/${channelId}/webhooks`,
    );
    return res.webhooks ?? [];
  }

  /**
   * The caller's OWN webhooks, with the capability URL and the named
   * destination of each.
   *
   * Not channel-scoped on purpose: the creator can list, rename and revoke
   * their webhook without holding `manage_channels` on the destination, which
   * is what stops a departed member's URL from outliving every stop.
   */
  async listMyWebhooks(): Promise<MyWebhook[]> {
    const res = await this.#http.request<{ webhooks?: MyWebhook[] }>(
      'GET',
      '/users/@me/webhooks',
    );
    return res.webhooks ?? [];
  }

  /** Rename one of YOUR OWN webhooks (`{"webhook": {...}}` envelope). */
  async updateMyWebhook(webhookId: string, body: UpdateWebhookBody): Promise<MyWebhook> {
    const res = await this.#patch<{ webhook?: MyWebhook }>(`/webhooks/${webhookId}`, body);
    return res.webhook ?? (res as unknown as MyWebhook);
  }

  /** Revoke one of YOUR OWN webhooks (capability rows die; execute 404s after). */
  async deleteMyWebhook(webhookId: string): Promise<void> {
    await this.#delete(`/webhooks/${webhookId}`);
  }

  /**
   * Rename a webhook as the destination's MANAGER. Kept alongside the owner
   * path because a channel's managers must be able to stop what posts into it
   * (`docs/protocol/rest.md`, KD3).
   */
  async updateWebhook(
    channelId: string,
    webhookId: string,
    body: UpdateWebhookBody
  ): Promise<Webhook> {
    const res = await this.#patch<{ webhook?: Webhook }>(
      `/channels/${channelId}/webhooks/${webhookId}`,
      body
    );
    return res.webhook ?? (res as unknown as Webhook);
  }

  /** Delete a webhook as the destination's MANAGER. */
  async deleteWebhook(channelId: string, webhookId: string): Promise<void> {
    await this.#delete(`/channels/${channelId}/webhooks/${webhookId}`);
  }

  // -----------------------------------------------------------------------
  // Application commands & interactions (bots plan U8)
  // -----------------------------------------------------------------------

  /**
   * The workspace's registered commands (all applications) for the composer
   * palette. Member-gated server-side (non-members → 403). Envelope:
   * `{"commands": [...]}` with `options` as the registered JSON array.
   */
  async listWorkspaceCommands(workspaceId: string): Promise<ApplicationCommand[]> {
    const res = await this.#http.request<{ commands?: ApplicationCommand[] }>(
      'GET',
      `/workspaces/${workspaceId}/commands`,
    );
    return res.commands ?? [];
  }

  /**
   * Invoke an application command as the human caller. The server checks the
   * caller's send right on the target channel (403 otherwise) and returns
   * 202/201 with `{"interaction_id": "..."}` once the InteractionCreate has
   * fanned to the bot's sessions — the bot's response arrives LATER as a
   * normal gateway message authored by the bot principal.
   */
  async invokeInteraction(
    body: InvokeInteractionBody
  ): Promise<{ interaction_id: string }> {
    return await this.#post('/interactions', body);
  }

  /**
   * Click a message component as the human caller (components plan U2 — the
   * message-keyed `POST /interactions` variant; the server dispatches it
   * before the command shape). Verifies the click against the message's
   * CURRENT stored components, applies owning-bot liveness + the clicker's
   * send right, and answers 202 with `{"interaction_id": "..."}` once the
   * type-3 InteractionCreate has fanned to the bot's sessions — the bot's
   * response arrives later (a MessageUpdate flip for type 7, an ordinary
   * bot-authored message for type 4/followups). The body's optional `nonce`
   * comes back on the `InteractionSuccess` gateway event the server sends
   * the clicker when the bot answers in any way (deferred acks included).
   * A dead owning bot answers 410 `component_unavailable`; a stale/forged
   * click answers 400.
   */
  async invokeComponentInteraction(
    body: InvokeComponentInteractionBody
  ): Promise<{ interaction_id: string }> {
    return await this.#post('/interactions', body);
  }

  /**
   * Submit a modal (#30) — the answers to a form a bot opened (callback
   * type 9, delivered as the `InteractionModal` gateway event) on one of the
   * caller's own interactions. 202 `{"interaction_id"}` once the MODAL_SUBMIT
   * has fanned to the bot. `400 modal_unavailable` for an expired, already
   * submitted, or someone else's form; `400 validation_failed` when the
   * answers do not match its fields (the form stays submittable); `410` when
   * the bot is gone.
   */
  async submitModal(body: SubmitModalBody): Promise<{ interaction_id: string }> {
    return await this.#post('/interactions', body);
  }

  // -----------------------------------------------------------------------
  // Message marks (#54) — the caller's own; nobody else can see them.
  // -----------------------------------------------------------------------

  /** The caller's pending marks, soonest first (only in readable channels). */
  async listMarks(): Promise<MessageMark[]> {
    const res = await this.#http.request<{ marks?: MessageMark[] }>('GET', '/users/@me/marks');
    return res.marks ?? [];
  }

  /**
   * Set — or re-set; one mark per kind per message — a mark due at `dueAt`
   * (an absolute instant: presets like "tomorrow" resolve in the caller's own
   * zone before they get here). 404 when the message is not readable; 400 for
   * a past / too-distant instant or a thread reply; 409 past the cap.
   */
  async setMark(kind: string, channelId: string, messageId: string, dueAt: Date | string): Promise<MessageMark> {
    const due_at = typeof dueAt === 'string' ? dueAt : dueAt.toISOString();
    const res = await this.#put<{ mark?: MessageMark }>(
      `/users/@me/marks/${kind}/channels/${channelId}/messages/${messageId}`,
      { due_at },
    );
    return res.mark as MessageMark;
  }

  /** Cancel a pending mark. */
  async cancelMark(kind: string, channelId: string, messageId: string): Promise<void> {
    await this.#delete(`/users/@me/marks/${kind}/channels/${channelId}/messages/${messageId}`);
  }

  // -----------------------------------------------------------------------
  // Push subscriptions
  // -----------------------------------------------------------------------

  /**
   * The instance's VAPID public key, which `pushManager.subscribe()` needs.
   *
   * Unauthenticated on the server (it is public by construction), but fetched
   * through this client so the base URL and error handling stay in one place.
   * Returns null when the instance has no push configured, which is a state a
   * surface renders rather than an error it reports.
   */
  async getVapidPublicKey(): Promise<string | null> {
    try {
      const res = await this.#http.request<{ key?: string }>(
        'GET',
        '/push/vapid-public-key',
      );
      return res.key ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Register this browser's push subscription.
   *
   * The path is `/users/@me/push-subscriptions`, NOT `/push/subscriptions` —
   * the wrappers here shipped pointing at a route that never existed, which is
   * why they were unusable as written (the original ticket flagged it).
   *
   * The server keys the row by `sha256(endpoint)` and rejects an unknown
   * `target_type`, so `target_type` is sent only when a caller sets one.
   */
  async createPushSubscription(
    body: CreatePushSubscriptionBody & { target_type?: 'web' | 'mobile' },
  ): Promise<{ registered: boolean; target_type?: string }> {
    return await this.#post('/users/@me/push-subscriptions', body);
  }

  /**
   * Remove one subscription.
   *
   * Addressed by ENDPOINT, not id: the server's row has no id to speak of, and
   * the endpoint is what a push service reports as gone — so removal from a
   * send failure and removal from the client use the same key.
   */
  async deletePushSubscription(endpoint: string): Promise<void> {
    await this.#http.request<void>('DELETE', '/users/@me/push-subscriptions', {
      body: { endpoint },
    });
  }

  /**
   * Fire a test notification at the CALLER's own devices.
   *
   * No target parameter exists — the server scopes the send to whoever
   * presents the credential, so this cannot notify anyone else. The response
   * is a transport report rather than a delivery verdict: `targets` is how
   * many browsers/installations this account has registered, `sent` is how
   * many of those accepted the push, and `outcomes` names what happened to
   * each one. The three failures have three different fixes, which is why
   * they are reported apart rather than collapsed into a boolean.
   */
  async sendTestNotification(message?: string): Promise<NotificationTestResult> {
    return await this.#post('/users/@me/notifications/test', message ? { message } : {});
  }

  // -----------------------------------------------------------------------
  // Attachments & images
  // -----------------------------------------------------------------------

  /**
   * Channel-scoped attachment upload — the composer's path. The file rides
   * the channel it will post into (`POST /channels/{id}/attachments`,
   * FormData) and the returned metadata rows bind into the follow-up
   * message's `attachments` array (SendMessageBody).
   *
   * `file` is a browser `File`/`Blob` (web) or an RN `{uri, name, type}`
   * descriptor (native) — see `appendUploadFile`.
   */
  async uploadChannelAttachment(
    channelId: string,
    file: UploadFile,
    filename?: string
  ): Promise<UploadedAttachment> {
    const form = new FormData();
    appendUploadFile(form, 'file', file, filename);
    // The server answers {"attachment": descriptor} — UNWRAP it. Returning
    // the envelope whole made every send carry attachments: [{attachment: …}],
    // which the create-message validation rejects (non-scalar descriptor),
    // so a message whose upload SUCCEEDED could never send with its image
    // (owner report 2026-09-16; mocked e2e fixtures returned flat descriptors
    // and never caught it).
    const res = await this.#post<{ attachment?: UploadedAttachment }>(
      `/channels/${channelId}/attachments`,
      form
    );
    return res.attachment ?? (res as unknown as UploadedAttachment);
  }

  /**
   * Avatar upload (`POST /users/@me/avatar`, multipart `file`): 10 MB cap,
   * raster images only. Atomic set-with-upload — the response carries the
   * updated user (avatar_url points at the content-addressed blob path).
   */
  async uploadAvatar(file: UploadFile, filename?: string): Promise<{ user: CurrentUser }> {
    const form = new FormData();
    appendUploadFile(form, 'file', file, filename);
    return await this.#post('/users/@me/avatar', form);
  }

  /**
   * Workspace icon upload (`POST /workspaces/{id}/icon`, multipart `file`):
   * admin-gated server-side, same image-only cap as avatars. Returns the
   * updated workspace.
   */
  async uploadWorkspaceIcon(
    workspaceId: string,
    file: UploadFile,
    filename?: string
  ): Promise<{ workspace: Workspace }> {
    const form = new FormData();
    appendUploadFile(form, 'file', file, filename);
    return await this.#post(`/workspaces/${workspaceId}/icon`, form);
  }
}

/**
 * Append an upload part for either runtime. Browsers take
 * `append(field, blob, filename)`; RN's `FormData` polyfill takes the
 * descriptor as the VALUE and ignores a third argument (it has no filename
 * parameter — the name rides the descriptor).
 */
function appendUploadFile(
  form: FormData,
  field: string,
  file: UploadFile,
  filename?: string
): void {
  if (isNativeFileDescriptor(file)) {
    form.append(field, file as unknown as Blob);
    return;
  }
  // Only name the part when a name was given: Node's FormData (undici, as of
  // Node 22.23) stringifies an explicit `undefined` third argument, so the
  // part went up named "undefined" instead of keeping the File's own name.
  if (filename !== undefined) form.append(field, file, filename);
  else form.append(field, file);
}

// ---------------------------------------------------------------------------
// Module helpers
// ---------------------------------------------------------------------------

function withQueryText(params?: ListParams): string {
  if (!params) return '';
  const search = toSearchParams(params as Record<string, unknown>);
  return search.size === 0 ? '' : `?${search}`;
}

function withQuery(path: string, params?: ListParams): string {
  if (!params) return path;
  const search = toSearchParams(params as Record<string, unknown>);
  return search.size === 0 ? path : `${path}?${search}`;
}

function toSearchParams(input: Record<string, unknown>): URLSearchParams {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    out.set(key, String(value));
  }
  return out;
}

/** A refresh/login `user` usable as the signed-in account (it has an id). */
function isCurrentUser(value: unknown): value is CurrentUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    (value as { id: string }).id !== ''
  );
}

function newIdempotencyKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** The history envelope both indexes return (U9 channel, #152 thread). */
interface HistoryEnvelope {
  messages?: Message[];
  items?: Message[];
  // Older servers sent `false` for an empty channel page.
  oldest_id?: string | null | false;
  newest_id?: string | null;
}

function historyPage(res: HistoryEnvelope, params: ListParams): ListResponse<Message> {
  return {
    items: res.messages ?? res.items ?? [],
    cursor: {
      before: res.oldest_id || null,
      after: res.newest_id ?? null,
      limit: params.limit ?? PAGE_DEFAULT,
    },
  };
}
