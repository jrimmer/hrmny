defmodule CytaleWeb.Router do
  @moduledoc """
  REST router + gateway WebSocket mount.

  Scopes mirror the plan's API surface: `/health` (liveness), `/api/v1`
  (feature endpoints arrive unit by unit — U8 auth, U12 channels/messages),
  the U10 gateway at `/gateway/websocket` via WebSockAdapter, and the
  Discord-compat prefixes `/api/v10` + `/api` (bots plan U6 — Bot-scheme
  machine credentials only, Discord shapes).
  """

  use CytaleWeb, :router

  # A database that cannot answer becomes 503 + Retry-After instead of an opaque
  # 500; every other exception is re-raised, so bug behaviour is unchanged
  # (hardening plan 1.7). The logic lives in `CytaleWeb.ErrorHandler` so it is
  # testable without a database.
  #
  # HERE, not in the endpoint. At the endpoint `Plug.ErrorHandler` is the
  # OUTERMOST wrapper, and `Phoenix.Endpoint.RenderErrors` catches the exception
  # inside it, renders and sends a 500, then re-raises — so Plug.ErrorHandler
  # sees `{:plug_conn, :sent}` and never calls `handle_errors/2`. The 503 was
  # therefore never sent: review measured the adapter receiving Phoenix's 500
  # with zero handler invocations, and 503 + `retry-after: 5` once the handler
  # moved in here, inside Phoenix's render try.
  use Plug.ErrorHandler

  pipeline :api do
    plug(:accepts, ["json"])
  end

  # Pre-auth credential surface (U8 login/register/refresh/reset): no
  # authentication by design, but rate-limited per IP (#35 S-P1-6 — argon2
  # makes every attempt deliberate CPU cost; the bucket blunts brute force
  # and register-spam). Distinct :auth bucket so ops can tune it without
  # touching the authenticated :api budget.
  pipeline :auth_surface do
    plug(:accepts, ["json"])
    plug(CytaleWeb.Plugs.RateLimit, bucket: :auth, limit: 30, window_ms: 10_000)
  end

  # Authenticated API surface (U9): Bearer JWT → current_user, then rate
  # limiting. Per-scope permission + verification plugs mount below.
  pipeline :api_auth do
    plug(:accepts, ["json"])
    plug(CytaleWeb.Plugs.Auth)
    plug(CytaleWeb.Plugs.RateLimit, bucket: :api, limit: 50, window_ms: 10_000)
    # The one send budget (message sends only — `CytaleWeb.SendRoutes`),
    # shared with the compat surface below.
    plug(CytaleWeb.Plugs.SendBudget)
  end

  # Pre-auth surface that still gets the per-IP rate limit (the Auth plug
  # keys the bucket on user id when present, IP otherwise).
  pipeline :api_rate_limited do
    plug(:accepts, ["json"])
    plug(CytaleWeb.Plugs.RateLimit, bucket: :api, limit: 50, window_ms: 10_000)
  end

  # Client-error ingest (#88). Two things make this pipeline different from
  # every other one:
  #
  #   * `OptionalAuth` — the route MUST accept unauthenticated posts, because
  #     the most valuable crash to capture happens on the login page, before
  #     anyone is authenticated. A credential is still resolved when present,
  #     so the report is attributed to its account instead of filed anonymous.
  #   * its OWN tight per-IP bucket (10 / 60s). `:api` is 50/10s keyed per
  #     ACCOUNT once a principal resolves; an anonymous flood has no account to
  #     key on, so the dam is the IP bucket and it is deliberately the
  #     narrowest one in the router — this is a low-volume, best-effort sink,
  #     and one abusive client must not be able to fill it.
  pipeline :client_error_ingest do
    plug(:accepts, ["json"])
    plug(CytaleWeb.Plugs.OptionalAuth)
    plug(CytaleWeb.Plugs.RateLimit, bucket: :client_errors, limit: 10, window_ms: 60_000)
  end

  # Content-producing mutations: the SINGLE verification choke point plus the
  # idempotency replay guard. `verified AND permitted` — verification first,
  # so an unverified account must not learn permission state (U8 contract).
  pipeline :content_mutation do
    plug(CytaleWeb.Plugs.RequireVerified)
    plug(CytaleWeb.Plugs.Idempotency)
  end

  # Per-surface permission gates (U7 engine; the workspace owner has implicit
  # full permissions — see CytaleWeb.Plugs.RequirePermitted).
  pipeline :can_send_messages do
    plug(CytaleWeb.Plugs.RequirePermitted, permission: :send_messages)
  end

  pipeline :can_manage_channels do
    plug(CytaleWeb.Plugs.RequirePermitted, permission: :manage_channels)
  end

  pipeline :can_manage_roles do
    plug(CytaleWeb.Plugs.RequirePermitted, permission: :manage_roles)
  end

  pipeline :can_manage_workspace do
    plug(CytaleWeb.Plugs.RequirePermitted, permission: :manage_workspace)
  end

  pipeline :can_kick_members do
    plug(CytaleWeb.Plugs.RequirePermitted, permission: :kick_members)
  end

  # Person-only identity acts (joining, owning, login/terminal credentials):
  # a bot/agent/webhook credential is refused — see CytaleWeb.Plugs.RequireHuman.
  pipeline :human_only do
    plug(CytaleWeb.Plugs.RequireHuman)
  end

  # Verified-only requests that are not content-producing (the ICE mint):
  # the single verification choke point without the idempotency guard.
  pipeline :verified do
    plug(CytaleWeb.Plugs.RequireVerified)
  end

  # Platform-operator tier (#33): the env-allowlist gate behind
  # CYTALE_ADMIN_USER_IDS — operator ⇒ trusted (no separate verified check).
  pipeline :operator do
    plug(CytaleWeb.Plugs.RequireOperator)
  end

  scope "/", CytaleWeb do
    pipe_through(:api)

    # Liveness — consults nothing. This is the deploy health-gate's URL.
    get("/health", HealthController, :show)
    # Readiness (#87): 503 when a dependency is down. This is what an OFF-BOX
    # prober hits; the shallow one above reports "ok" for a node whose database
    # is gone, which is the failure mode #87 exists to catch.
    get("/health/ready", HealthController, :ready)
    # The Prometheus scrape surface (#87). Gated by CYTALE_METRICS_TOKEN, and a
    # 404 when no token is configured — fail-closed, because telemetry names
    # workspaces and event classes. See docs/monitoring.md.
    get("/metrics", MetricsController, :show)

    # The VAPID public key a browser needs to subscribe (notifications plan
    # U6). Unauthenticated because it is a public key — it authorizes nothing,
    # and gating it would only mean the subscribe flow breaks when a credential
    # expires. 503 when push is unconfigured, so "this instance has no push" is
    # distinguishable from "the key is blank".
    get("/api/v1/push/vapid-public-key", PushKeyController, :show)
  end

  # Versioned API surface.
  scope "/api/v1", CytaleWeb do
    pipe_through(:auth_surface)

    # Auth (U8) — no authentication pipeline on these routes by design.
    post("/auth/register", AuthController, :register)
    post("/auth/verify-email", AuthController, :verify_email)
    post("/auth/resend-verification", AuthController, :resend_verification)
    post("/auth/login", AuthController, :login)
    post("/auth/refresh", AuthController, :refresh)
    post("/auth/logout", AuthController, :logout)
    post("/auth/password-reset/request", AuthController, :request_password_reset)
    post("/auth/password-reset/complete", AuthController, :complete_password_reset)
  end

  # -- WebAuthn passkey surface (ticket #36) ------------------------------------
  # PRE-AUTH half: the discoverable login ceremony (no identifier in — the
  # browser's picker chooses the identity) plus the methods read the login
  # page uses to decide whether the bottom button renders. Same per-IP :auth
  # dam as the password surface: these endpoints mint session tokens, so
  # every attempt stays deliberate.
  scope "/api/v1", CytaleWeb do
    pipe_through(:auth_surface)

    get("/auth/methods", WebAuthnController, :methods)
    post("/auth/webauthn/login/options", WebAuthnController, :login_options)
    post("/auth/webauthn/login/verify", WebAuthnController, :login_verify)

    # -- TOTP two-factor (ticket #127) ------------------------------------------
    # The PRE-AUTH half of the 2FA gate, riding the same per-IP :auth dam as
    # the password surface (verify and grant-confirm MINT session tokens, so
    # every attempt stays deliberate). Authentication here is the GRANT the
    # password step minted (or, for the settings enroll flow, a Bearer the
    # controller resolves itself) — no Auth pipeline by design, exactly like
    # the login surface above. verify swaps a `:totp` grant for the real
    # token pair; enroll/start + enroll/confirm are the forced walk an
    # `:enrollment` grant drives (and the settings surface's same endpoints).
    post("/auth/2fa/verify", TwoFactorController, :verify)
    post("/auth/2fa/enroll/start", TwoFactorController, :enroll_start)
    post("/auth/2fa/enroll/confirm", TwoFactorController, :enroll_confirm)

    # -- Instance OIDC federated sign-in (ticket #12) ---------------------------
    # The two pre-auth halves of the authorization-code ceremony, riding the
    # SAME per-IP :auth dam as the password surface (both mint session
    # tokens, so both stay deliberate). start mints the single-use
    # state/nonce/PKCE transaction and returns the provider's authorize URL;
    # callback exchanges the code server-side, validates the ID token
    # outright (JWKS signature, iss/aud/nonce/exp), resolves the identity,
    # and issues the ordinary token pair — the uniform 401 invalid_credentials
    # is the ONLY refusal shape (a failed login never distinguishes "no
    # account" from "bad token"). Deliberately undeclared-public in the
    # authorization matrix, the same posture as POST /auth/login.
    post("/auth/oidc/start", OIDCController, :start)
    post("/auth/oidc/callback", OIDCController, :callback)
  end

  # AUTHENTICATED half: enrollment. register/verify MINTS A LOGIN credential
  # for the account, so the verification choke point applies (the S-P2-13
  # rule as applied to SSH-certificate issuance); register/options keeps the
  # pair consistent. The settings routes are the owner's own list and
  # revocation — deletion of the rows IS the revocation.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:human_only)
    pipe_through(:content_mutation)

    post("/auth/webauthn/register/options", WebAuthnController, :register_options)
    post("/auth/webauthn/register/verify", WebAuthnController, :register_verify)
  end

  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)

    get("/users/@me/webauthn/credentials", WebAuthnController, :index)
    delete("/users/@me/webauthn/credentials/:credential_id", WebAuthnController, :delete)

    # TOTP two-factor settings pair (#127): the owner's enrollment status and
    # removal. Plain :api_auth like the passkey list/delete — reads and
    # identity-scoped security actions, self-scoped by the session's account
    # id. Removal while the switch is on is allowed by design: the next
    # password login re-prompts enrollment (no self-lockout).
    get("/users/@me/two-factor", TwoFactorController, :status)
    delete("/users/@me/two-factor", TwoFactorController, :delete)
  end

  # -- Invite surface (join flow, U20) ------------------------------------------
  # Resolve is PUBLIC (plan U9/U20 + protocol.md: the unauthenticated invite
  # landing must resolve a code before login-or-register; the uniform 404
  # keeps it a non-oracle). Accept requires identity — you join as yourself.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_rate_limited)

    get("/invites/:code", InviteController, :show)
  end

  # -- Client-error ingest (#88) ------------------------------------------------
  # The sink behind every client's crash/failure report. Unauthenticated on
  # purpose (the login-page crash is the one worth the most and has no session
  # to present) and rate-limited tightly per IP; see the :client_error_ingest
  # pipeline above for why both of those are deliberate.
  scope "/api/v1", CytaleWeb do
    pipe_through(:client_error_ingest)

    post("/client-errors", ClientErrorController, :create)
  end

  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:human_only)

    post("/invites/:code", InviteController, :accept)
  end

  # Identity-scoped writes that mint memberships/credentials: behind the
  # verification choke point (#35 S-P2-13 — an unverified account must not
  # become a workspace OWNER, open DMs, or mint push credentials).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:human_only)
    pipe_through(:content_mutation)

    post("/workspaces", WorkspaceController, :create)
  end

  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)

    post("/users/:user_id/channels", DmController, :create)
    post("/users/@me/push-subscriptions", PushController, :create)

    # Avatar upload (upload consolidation): image-only upload purpose,
    # atomic set-with-upload — a content-producing mutation, so the
    # verification choke point applies like every other upload surface.
    post("/users/@me/avatar", UserController, :upload_avatar)
  end

  # SSH certificate surface (U2, terminal plan): a member's own stored public
  # keys and the certificates this server issues for them. Verified posture —
  # issuing a certificate MINTS A CREDENTIAL, so the verification choke point
  # applies exactly as it does to minting an agent token (bots plan R5). Every
  # route is `@me`-scoped and keys on the session's account id; the certificate's
  # principal is derived from the session and never read from the body (R3a).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:human_only)
    pipe_through(:content_mutation)

    post("/users/@me/ssh/certificates", SshCertificateController, :issue)
    get("/users/@me/ssh/certificates", SshCertificateController, :index)
    post("/users/@me/ssh/certificates/:key_id/reissue", SshCertificateController, :reissue)
    delete("/users/@me/ssh/certificates/:key_id", SshCertificateController, :delete)
  end

  # NOTE — the session bridge is deliberately ABSENT from this router. It is
  # served by `CytaleWeb.BridgeServer`'s own plug server with its own route table,
  # because a route table belongs to the ENDPOINT: any route here would be served
  # on the listener `deploy/Caddyfile` proxies on the public edge, which R8a
  # forbids. `CytaleWeb.AuthorizationMatrix.bridge_declarations/0` declares it and
  # the bridge's suite asserts this absence.

  # -- App tier (authenticated, member-scoped) ----------------------------------
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)

    # Current-user surface
    get("/users/@me", UserController, :show_me)
    patch("/users/@me", UserController, :update_me)
    delete("/account", AccountController, :delete)
    get("/users/@me/workspaces", WorkspaceController, :index)
    get("/users/@me/channels", DmController, :index)
    delete("/users/@me/push-subscriptions", PushController, :delete)

    # User settings (the gear surface): the caller's machine principals in
    # one read (the "My integrations" rollup) and whole-account session
    # revocation. Plain :api_auth by design — a read and an identity-scoped
    # security action, neither gated on content mutation or verification.
    get("/users/@me/integrations", BotController, :my_integrations)
    delete("/users/@me/sessions", AccountController, :revoke_all_sessions)

    # Notification preferences (plan U2): the account / workspace / channel
    # (incl. DMs) / thread ladder, plus the per-workspace "Suppress @everyone
    # and @here" switch (2026-09-27). Plain :api_auth — a member's own settings, and the write
    # validates its target through membership rather than through a content
    # bit (a member may legitimately quiet a channel they can read).
    get("/users/@me/notification-preferences", NotificationPreferenceController, :index)
    put("/users/@me/notification-preferences", NotificationPreferenceController, :upsert)

    delete(
      "/users/@me/notification-preferences/:scope/:entity_id",
      NotificationPreferenceController,
      :clear
    )

    # The notifications settings surface's "send me a test" button. Plain
    # :api_auth and NO target parameter — the partition key is the caller, so
    # a member can only ever notify themselves (the same privacy shape as
    # `/users/@me/inbox` below). The operator probe on the admin tier answers
    # the different question "can I reach that OTHER member".
    post("/users/@me/notifications/test", NotificationSelfTestController, :create)

    # Mention inbox (#117): the server-backed "where was I needed" backlog —
    # message-level rows, one partition per member, deep-linked by #114's
    # permalinks. Plain :api_auth and no resource param: the partition key IS
    # the caller, so no request can name another member's inbox (the #113
    # bookmark privacy test) and there is no cross-member row to gate. Reads
    # are cursor-paginated (`before`, the API's one cursor shape); both
    # deletes remove ROWS only and never move the channel's read watermark —
    # answering a mention is not reading a channel.
    # Cmd-K omnisearch: the caller's own reachable messages — workspace hits
    # are visible-channel-filtered per workspace, DM hits are the caller's own
    # conversations. Plain :api_auth, self-scoped by the partition keys.
    get("/users/@me/omnisearch", SearchController, :omnisearch)

    get("/users/@me/inbox", InboxController, :index)
    delete("/users/@me/inbox", InboxController, :sweep)
    delete("/users/@me/inbox/:message_id", InboxController, :dismiss)

    # Message marks (#54): one route family keyed by kind ("Remind me…" is
    # `snooze`). Self-scoped like the inbox, and the write additionally
    # proves the caller can READ the target — the channel rides the path so
    # the authorization matrix sees it (channel_gate in-controller, one 404).
    get("/users/@me/marks", MarksController, :index)
    put("/users/@me/marks/:kind/channels/:channel_id/messages/:message_id", MarksController, :set)
    delete("/users/@me/marks/:kind/channels/:channel_id/messages/:message_id", MarksController, :cancel)

    # Workspaces (create rides content_mutation above — owner-minting is
    # a verified act).
    get("/workspaces/:workspace_id", WorkspaceController, :show)
    get("/workspaces/:workspace_id/members", WorkspaceController, :members)
    post("/workspaces/:workspace_id/invites", InviteController, :create)

    # People directory (U24/U26 contract)
    get("/workspaces/:workspace_id/people", UserController, :people)

    # Application commands (bots plan U8, KTD13): the composer's command
    # list — member-gated in-controller through the resolver (any member).
    get("/workspaces/:workspace_id/commands", InteractionController, :index)

    # Search (U13 two-segment topology: workspace + DM segments; handlers land
    # with the search NIF — the route contract is fixed here).
    get("/workspaces/:workspace_id/search", SearchController, :workspace)
    get("/dm/search", SearchController, :dm)

    # Roles — reads; mutations live in the can_manage_roles scope below.
    get("/workspaces/:workspace_id/roles", RoleController, :index)
    get("/workspaces/:workspace_id/roles/:role_id", RoleController, :show)

    # Channels — reads; mutations live in the can_manage_channels scope below.
    get("/workspaces/:workspace_id/channels", ChannelController, :index)
    get("/channels/:channel_id", ChannelController, :show)
    get("/channels/:channel_id/overwrites", ChannelController, :overwrites)
    get("/channels/:channel_id/threads", ThreadController, :index_channel_threads)

    # Calls (voice plan U4): the durable call surface — standing call-log
    # thread, live call + roster, recently ended. The uniform channel gate
    # (VIEW_CHANNEL / DM participation) renders the 404 anti-enumeration
    # shape in-controller.
    get("/channels/:channel_id/call", CallController, :show)

    # Workspace media settings (calls V2 plan U8, R16/R17): the channel
    # manager's override read — the channel's tri-state override, the
    # workspace master, and overrides_allowed. Manage-channels gated
    # in-controller through the uniform channel gate (404 anti-enumeration
    # for foreign channels; DM channels carry no override surface).
    # (/calls/ice lives with the V1 call routes further down — kept once.)
    get("/channels/:channel_id/media-override", MediaSettingsController, :show_override)

    # Messages (mutations ride the content_mutation pipeline: RequireVerified
    # → Idempotency → RequirePermitted).
    get("/channels/:channel_id/messages", MessageController, :index)

    # Permalink resolver (#114): one message by id, the read `rest.md` has
    # advertised since U9 but nothing routed. Member-gated in-controller
    # through the SAME uniform channel seam the history read uses — an
    # ungated resolver is a cross-workspace read oracle, and the 404 it
    # renders is ONE shape for every miss (foreign channel, unknown channel,
    # unknown message) so it cannot be used as an existence oracle either.
    get("/channels/:channel_id/messages/:message_id", MessageController, :show)

    # Opaque permalinks (#118, option B): ONE token that decodes back to a
    # message, with nothing stored behind it. POST mints on the Copy Link click;
    # GET is what the SPA calls when a visitor opens `/m/<token>`. Both run the
    # SAME uniform gate as the resolver directly above (view rights / DM
    # participation, byte-identical 404 for every miss), because a checker that
    # can distinguish "not allowed" from "does not exist" is a channel oracle.
    # No sensitive path param — the token is opaque — so the authorization
    # matrix needs no declaration (sensitive_params/0 matches ids, not tokens).
    post("/permalinks", PermalinkController, :create)
    get("/permalinks/:token", PermalinkController, :show)

    # Reactions — member-gated read (view rights via the resolver; the
    # mutation routes live in the content_mutation scope below).
    get("/channels/:channel_id/messages/:message_id/reactions/:emoji", ReactionController, :list)

    # Threads (U12 contract surfaces; handlers thin over Messages). READS
    # gate in-controller through the shared parent-channel seam (#35 P0-1);
    # the follow-state writes ride the verification choke point (same
    # posture as the ack fallback) with the same in-controller gate.
    get("/threads/:thread_id/messages", ThreadController, :index)
    get("/threads/:thread_id/members", ThreadController, :members)
  end

  # Thread follow-state writes: verified (S-P2-13), gated in-controller on
  # the parent channel's view right — the 404 anti-enumeration shape.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)

    post("/threads/:thread_id/members", ThreadController, :join)
    delete("/threads/:thread_id/members/@me", ThreadController, :leave)
    patch("/threads/:thread_id/members/@me", ThreadController, :update_follow)

    # #109: archive/unarchive a thread — its creator, or a moderator of the
    # PARENT channel (the gate resolves there). Verified + in-controller, the
    # same posture as the follow writes above.
    patch("/threads/:thread_id", ThreadController, :update)

    # Calls (voice plan U12): the ICE-config delivery path — the minted
    # TURN entry for call media (ephemeral credentials, ~1h validity).
    # Principal-scoped, not channel-scoped: one ICE config per caller.
    # Verified-only (S-P1-11): open registration must not mint unlimited
    # relay credentials.
    get("/calls/ice", CallController, :ice)
  end

  # Message writes: SEND_MESSAGES (after the verification choke point).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_send_messages)

    post("/channels/:channel_id/messages", MessageController, :create)
  end

  # Attachment upload (U21a): content-producing mutation — the view-only gate
  # applies via the content_mutation pipeline (RequireVerified).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_send_messages)

    post("/channels/:channel_id/attachments", AttachmentController, :create)
  end

  # Attachment blob serving (content-addressed). No auth pipeline — `<img>`
  # cannot carry a bearer — but not public: message attachments need a live
  # signed URL (`?e=&s=`, minted per render — Cytale.Attachments.SignedUrl);
  # only avatar/icon blobs serve unsigned (AttachmentController.show/2).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api)

    get("/attachments/:hash", AttachmentController, :show)
  end

  # External images, served from our origin (Cytale.MediaProxy): the CSP's
  # `img-src 'self'` admits no third-party host. No auth pipeline, for the
  # attachment route's reason — only a live signature minted by a message
  # render (`?u=&e=&s=`) is served; the controller refuses everything else
  # before fetching anything.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api)

    get("/media/proxy", MediaProxyController, :show)
  end

  # Author/admin message management: SEND_MESSAGES surface (edit/delete are
  # author-checked in-controller; the MANAGE_MESSAGES admin path is a plug seam).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_send_messages)

    patch("/channels/:channel_id/messages/:message_id", MessageController, :update)
    delete("/channels/:channel_id/messages/:message_id", MessageController, :delete)
    post("/channels/:channel_id/messages/:message_id/threads", ThreadController, :start)
    post("/threads/:thread_id/messages", ThreadController, :reply)
  end

  # ACK/typing: realtime-command REST fallbacks — authenticated, verified.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)

    post("/channels/:channel_id/ack", MessageController, :ack)
    post("/channels/:channel_id/typing", MessageController, :typing)

    # Calls (voice plan U4): the ring notification-mute set/clear (AM6's
    # durable per-user-per-channel table; CALL_RING delivery excludes
    # muted members). Same channel gate as the GET above.
    patch("/channels/:channel_id/call-notification-mute", CallController, :set_notification_mute)

    # Channel media overrides (calls V2 plan U8, R16): manage-channels
    # tier, gated in-controller through the SAME uniform channel gate
    # (foreign channel → the identical 404; DM → 404); a workspace with
    # overrides disallowed answers the 409 `overrides_not_allowed` state
    # conflict.
    put("/channels/:channel_id/media-override", MediaSettingsController, :put_override)

    # Reactions (Unicode emoji): own add/remove + the manage_messages admin
    # clears. Gates run in-controller through the SAME uniform channel-gate
    # seam the typing route uses (view rights via the resolver, parent
    # fallback + restrictions); the admin routes check manage_messages
    # against the gate's bitfield. Own-routes first: the @me segment must
    # not fall into the :user_id route.
    put("/channels/:channel_id/messages/:message_id/reactions/:emoji/@me", ReactionController, :add)
    delete("/channels/:channel_id/messages/:message_id/reactions/:emoji/@me", ReactionController, :remove_own)
    delete("/channels/:channel_id/messages/:message_id/reactions/:emoji/:user_id", ReactionController, :remove_user)
    delete("/channels/:channel_id/messages/:message_id/reactions/:emoji", ReactionController, :clear_emoji)
    delete("/channels/:channel_id/messages/:message_id/reactions", ReactionController, :clear_all)

    # Command invocation (bots plan U8, KTD13): the native endpoint U9's
    # composer calls — verified human, send-right checked in-controller on
    # the target channel (no workspace-path permission plug: the channel IS
    # the scope).
    post("/interactions", InteractionController, :create)
  end

  # Channel creation: MANAGE_CHANNELS.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_manage_channels)

    post("/workspaces/:workspace_id/channels", ChannelController, :create)
  end

  # Channel management mutations: MANAGE_CHANNELS.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_manage_channels)

    patch("/channels/:channel_id", ChannelController, :update)
    delete("/channels/:channel_id", ChannelController, :delete)
    put("/channels/:channel_id/overwrites", ChannelController, :put_overwrite)
    delete("/channels/:channel_id/overwrites/:target_id", ChannelController, :delete_overwrite)

    # Webhook management (bots plan U11): channel-scoped under the same gate.
    # These four are the DESTINATION's governance surface — a manager sees what
    # posts into their channel and can stop it — so the READ carries no `url`:
    # the capability token belongs to the creator, not to whoever manages the
    # channel (KD3). Creation still returns it once, to its creator. Execution
    # lives on the UNAUTHENTICATED surface below.
    post("/channels/:channel_id/webhooks", WebhookController, :create)
    get("/channels/:channel_id/webhooks", WebhookController, :index)
    patch("/channels/:channel_id/webhooks/:id", WebhookController, :update)
    delete("/channels/:channel_id/webhooks/:id", WebhookController, :delete)
  end

  # Webhook OWNERSHIP (KD2): a user's own webhooks, and the owner's lifecycle
  # actions. Deliberately NOT channel-gated — the point of these routes is that
  # losing `manage_channels` on the destination must not strand the webhook you
  # minted, and the creator is the only reader who sees the capability URL.
  # Ownership is enforced in-controller from the principal the mint already
  # wrote (`Webhooks.owner?/2`), with not-the-owner and not-found collapsed to
  # the same answer so the id space is not enumerable.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)

    get("/users/@me/webhooks", WebhookController, :mine)

    # Rename and revoke are content mutations (the verified gate applies);
    # the read above is a plain read.
    pipe_through(:content_mutation)

    patch("/webhooks/:id", WebhookController, :owner_update)
    delete("/webhooks/:id", WebhookController, :owner_delete)
  end

  # Role management: MANAGE_ROLES.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_manage_roles)

    post("/workspaces/:workspace_id/roles", RoleController, :create)
    patch("/workspaces/:workspace_id/roles/:role_id", RoleController, :update)
    delete("/workspaces/:workspace_id/roles/:role_id", RoleController, :delete)
    put("/workspaces/:workspace_id/roles/:role_id/members/:user_id", RoleController, :grant)
    delete("/workspaces/:workspace_id/roles/:role_id/members/:user_id", RoleController, :revoke)
  end

  # Workspace nicknames (#169): no route-level permission — your own needs
  # CHANGE_NICKNAME, anyone else's MANAGE_NICKNAMES plus the hierarchy gate,
  # both decided in CytaleWeb.Nicknames (people and bots, one path).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)

    patch("/workspaces/:workspace_id/members/:user_id", WorkspaceController, :update_member)
  end

  # Member removal: KICK_MEMBERS (plus the in-controller hierarchy gate —
  # never the owner, never yourself, never a member at or above your top role).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_kick_members)

    delete("/workspaces/:workspace_id/members/:user_id", WorkspaceController, :kick)
  end

  # Workspace management: MANAGE_WORKSPACE (owner tier).
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)
    pipe_through(:can_manage_workspace)

    patch("/workspaces/:workspace_id", WorkspaceController, :update)
    post("/workspaces/:workspace_id/icon", WorkspaceController, :upload_icon)
    delete("/workspaces/:workspace_id", WorkspaceController, :delete)

    # Workspace media settings (calls V2 plan U8, R16): the master media
    # toggles — owner/admin tier exactly like PATCH /workspaces/{id}.
    get("/workspaces/:workspace_id/media-settings", MediaSettingsController, :show_workspace)
    put("/workspaces/:workspace_id/media-settings", MediaSettingsController, :put_workspace)
  end

  # Workspace-scoped bots are RETIRED (owner decision 2026-09-12): a machine
  # credential is always user-owned, and its authority comes from the access
  # grant its owner sets — never from a role in a workspace. The routes that
  # lived here (`/workspaces/:workspace_id/bots`, gated on manage_workspace)
  # are gone; `/bots` below is the only provisioning path — the URL says bot,
  # like the kind, the token prefix (`cytbot_`) and this controller's name. The
  # UI word for it is Agent (see docs/protocol/rest.md).

  # Bots (U4, bots plan): user-owned machine principals — any verified human
  # mints for themselves (RequireVerified via content_mutation; the idempotency
  # replay guard rides along no-op without the header). No permission gate by
  # design (R5). One internal vocabulary: bot.
  scope "/api/v1", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:content_mutation)

    post("/bots", BotController, :create_bot)
    get("/bots", BotController, :index_bot)
    patch("/bots/:id", BotController, :update_bot)
    post("/bots/:id/regenerate", BotController, :regenerate_bot)
    post("/bots/:id/avatar", BotController, :upload_avatar)
    delete("/bots/:id/avatar", BotController, :clear_avatar)
    delete("/bots/:id", BotController, :delete_bot)
  end

  # Admin tier (`/api/v1/admin/...`) — OPERATOR surface (#33): the env
  # allowlist gate (CYTALE_ADMIN_USER_IDS via runtime.exs) rides AFTER auth;
  # the plug fails closed for everyone when the allowlist is unset.
  scope "/api/v1/admin", CytaleWeb do
    pipe_through(:api_auth)
    pipe_through(:operator)

    get("/workspaces/:workspace_id/audit", AdminController, :audit)
    get("/workspaces/:workspace_id/deletion-cascade/:user_id", AdminController, :deletion_cascade)
    get("/invites", AdminController, :invites)
    get("/metrics", AdminController, :metrics)
    post("/metrics/reset", AdminController, :reset_metrics)

    # Search index maintenance (#89): the admin tier's first MUTATING routes,
    # so they are operator-gated like the reads beside them. The GET is the
    # drift check — counts PLUS the sampled missing/orphaned ids, which is what
    # makes a repair surgical instead of a rebuild. The rebuild is single-flight
    # and asynchronous: it answers 202 with a job id, or 409 with the one
    # already running, because it walks a whole workspace and must never run
    # inside the request (see Search.RebuildRunner).
    get("/workspaces/:workspace_id/search/status", AdminController, :search_status)
    post("/workspaces/:workspace_id/search/repair", AdminController, :search_repair)
    post("/workspaces/:workspace_id/search/rebuild", AdminController, :search_rebuild)
    get("/search/rebuilds", AdminController, :search_rebuilds)
    # Server backups (#120): scheduler-produced archives (list + operator
    # download) and the destructive restore intake (staged path + explicit
    # confirm token; boot restore-mode applies it before the endpoint serves).
    get("/backups", BackupController, :index)
    get("/backups/:id/download", BackupController, :download)
    post("/backups/restore", BackupController, :restore)

    # Notification probe: send a real push to a member's devices, out of band.
    # Operator-gated like the rest of this tier because it notifies a real
    # person; it exists because answering "can this member be notified at all"
    # previously took four deploys and a console session.
    post("/notifications/test", NotificationProbeController, :create)

    # Client-error read (#88): the last N reports grouped by fingerprint. On
    # this tier because a report's route is a map of where people were — and
    # because there is no dashboard, so the operator is the reader.
    get("/client-errors", ClientErrorController, :read)

    # Server configuration (#121): the operator's one JSON config file. The
    # GET serves the EDITABLE document (never a secret — secrets live in
    # secrets.json, which no route reads); the PUT validates against
    # Cytale.ServerConfig.Schema, writes atomically, and hot-applies the
    # runtime-scoped keys (restart_required names the boot-scoped ones).
    # The restart route answers FIRST, then System.stop(0) — the compose
    # policy / dev watchdog brings the node back.
    get("/config", ServerConfigController, :show)
    put("/config", ServerConfigController, :update)
    post("/restart", ServerConfigController, :restart)
  end

  # -- Interaction continuation (components plan U3, KTD5): Discord's ------
  # webhook-shaped followup/@original routes for interaction tokens — the
  # URLs discord.js `deferReply`/`deferUpdate` → `editReply`/`followUp`
  # target. Like the callback route, NO Bot-auth pipeline: the URL token is
  # the credential (resolved WITHOUT an interaction id segment).
  #
  # The BARE /api alias is deliberately mounted IN FRONT of the webhook
  # execute surface below: its two-segment POST shape
  # (/api/webhooks/{id}/{token}) is IDENTICAL to webhook execute — definition
  # order wins, so the interaction handler runs first and falls through to
  # WebhookController.execute for pairs that are not outstanding interaction
  # tokens (webhook behavior unchanged). Under /api/v10 there is no overlap.
  scope "/api", CytaleWeb do
    pipe_through([:api, :compat_json])

    post("/webhooks/:application_id/:token", InteractionController, :followup_create_bare)
    get("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_show)
    patch("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_update)
    delete("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_delete)
  end

  scope "/api/v10", CytaleWeb do
    pipe_through([:api, :compat_json])

    post("/webhooks/:application_id/:token", InteractionController, :followup_create)
    get("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_show)
    patch("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_update)
    delete("/webhooks/:application_id/:token/messages/@original", InteractionController, :original_delete)
  end

  # -- Webhook execute (bots plan U11, R12): the UNAUTHENTICATED capability --
  # surface. The URL token IS the credential — deliberately NO Auth plug and
  # NO permission gate at execute (KD8: validity = webhook row + channel
  # existing); the per-webhook rate bucket + the anti-enumeration 10015 404s
  # live in the controller. Mounted BEFORE the compat scopes and the SPA
  # fallback — definition order wins.
  #
  # NOTE (components plan U3): the bare JSON execute POST line is GONE from
  # this scope — the interaction continuation route above
  # (`POST /api/webhooks/:application_id/:token`) owns the identical path
  # shape in front of it (definition order) and DELEGATES non-interaction
  # pairs to `WebhookController.execute` unchanged, so the webhook wire is
  # byte-identical through one matched route instead of a dead shadowed one.
  scope "/api/webhooks", CytaleWeb do
    pipe_through(:api)

    get("/:webhook_id/:token", WebhookController, :info)
    post("/:webhook_id/:token/slack", WebhookController, :execute_slack)
    post("/:webhook_id/:token/github", WebhookController, :execute_github)
  end

  # -- Interaction callback (bots plan U8, KTD13): the URL token IS the ------
  # credential — deliberately NO Bot-auth pipeline here (Discord libraries
  # send no Authorization header on this route). Token verification, the
  # resolver-gated bot message create, and the 204 live in the controller.
  # Both compat prefixes serve it, before the authed compat scopes below.
  scope "/api/v10", CytaleWeb do
    pipe_through([:api, :compat_json])

    post("/interactions/:interaction_id/:token/callback", InteractionController, :callback)
  end

  scope "/api", CytaleWeb do
    pipe_through([:api, :compat_json])

    post("/interactions/:interaction_id/:token/callback", InteractionController, :callback)
  end

  # -- Compat REST (bots plan U6, R7): the Discord-versioned prefix plus the --
  # bare unversioned alias, both Bot-scheme-only with Discord shapes and the
  # full X-RateLimit-* set. `/gateway/bot` rides INSIDE the scopes (Discord
  # serves it under the API base); U7's docs point libraries here via the
  # base URL. Mounted BEFORE the SPA fallback — definition order wins.
  pipeline :compat do
    plug(:accepts, ["json"])
    # FIRST, so the dialect is on the conn before anything can raise. The
    # response DIALECT decides which error envelope the handler renders
    # (Discord's bare `{code, message}` vs the native `{error: {...}}`), and no
    # path prefix can decide it: `/api/v10` carries BOTH native and compat
    # scopes, and the bare `/api` alias serves compat while `/api/v1` and
    # `/api/webhooks` are native.
    plug(:assign_compat_dialect)
    # Discord framing (item 1, #61): compat bodies render EXACTLY
    # `application/json` — discord.py decides JSON-ness by exact header
    # comparison, so Phoenix's default `; charset=utf-8` turns every body
    # into untranslatable text.
    plug(CytaleWeb.Compat.JsonContentType)
    # B2: the IP-keyed flood dam runs BEFORE BotAuth — failed auth is never
    # rate-limited by the per-principal buckets (there is no principal yet),
    # and each attempt would otherwise cost a Scylla token read. High
    # ceiling (30/10s/IP default): valid traffic stays governed by the
    # per-principal route buckets applied below.
    plug(CytaleWeb.Compat.PreAuthRateLimit)
    plug(CytaleWeb.Compat.BotAuth)
    plug(CytaleWeb.Compat.RateLimit)
    # The one send budget every send route shares (native included).
    plug(CytaleWeb.Plugs.SendBudget)
  end

  # The NO-Authorization compat routes (interaction callback, followup
  # continuation) ride the native :api pipeline for auth purposes — the URL
  # token IS the credential there, so BotAuth must not run. They are still
  # Discord-facing, though, so the compat framing rides here rather than
  # widening :api (native responses keep Phoenix's charset default).
  pipeline :compat_json do
    plug(:assign_compat_dialect)
    plug(CytaleWeb.Compat.JsonContentType)
  end

  # Marks the conn so `CytaleWeb.ErrorHandler` renders THIS audience's
  # documented error shape. Private because it exists only for `plug(:...)`.
  defp assign_compat_dialect(conn, _opts), do: assign(conn, :error_dialect, :compat)

  # One table, TWO prefixes (hardening plan 3.8): the /api/v10 and bare /api
  # compat surfaces were byte-identical route lists maintained by hand, so a
  # route added to one could silently go missing on the other. `scope/3` in a
  # comprehension keeps them provably the same table.
  for prefix <- ~w(/api/v10 /api) do
    scope prefix, CytaleWeb.Compat do
      pipe_through(:compat)

      get("/users/@me", UsersController, :me)
      get("/users/@me/guilds", UsersController, :guilds)
      get("/guilds/:guild_id", UsersController, :guild)
      get("/guilds/:guild_id/channels", UsersController, :guild_channels)
      # Nicknames (#169): Modify Current Member / Modify Guild Member's `nick`.
      patch("/guilds/:guild_id/members/:user_id", MembersController, :update)
      get("/gateway/bot", GatewayController, :show)
      # The application object (#61 item 2): discord.py's `Client.login()`
      # fetches it BEFORE the socket opens (the /oauth2/ form), discord.js uses
      # the bare one — one action, both routes.
      get("/applications/@me", ApplicationController, :me)
      get("/oauth2/applications/@me", ApplicationController, :me)
      # Bot DMs (bots plan B-1): Discord's user-DM routes; messages/reactions/
      # typing on the DM channel id ride the standard channel routes below
      # (the channel gate resolves recipient membership). The DM search route
      # is B-4's CYTALE EXTENSION.
      post("/users/@me/channels", DmController, :create)
      get("/users/@me/channels", DmController, :index)
      get("/users/@me/channels/:channel_id/messages/search", SearchController, :dm)
      # Application commands (bots plan U8, KTD13): guild → workspace; the
      # {bot_id}-must-be-self binding + workspace-rights gate live in the
      # controller. GET is #133 — the READ half: discord.py-family safe sync
      # (fetch → diff → PUT) and discord.js `guild.commands.fetch()` begin with
      # this collection GET; without the route the fetch raises before any PUT.
      put("/applications/:application_id/guilds/:workspace_id/commands", ApplicationController, :bulk_upsert)
      post("/applications/:application_id/guilds/:workspace_id/commands", ApplicationController, :create)
      get("/applications/:application_id/guilds/:workspace_id/commands", ApplicationController, :index)
      get("/channels/:channel_id", ChannelsController, :show)
      # #75: Discord's Modify Channel — the write half of the channel object
      # (name/topic/position), MANAGE_CHANNELS-gated in-controller.
      patch("/channels/:channel_id", ChannelsController, :update)
      # #74: threads were write-only — created, then unresolvable by every read
      # route. Discord models a thread AS a channel, so the read route resolves one
      # and DELETE removes one; discovery is the guild-scoped active listing plus
      # the channel's archived listing.
      delete("/channels/:channel_id", ChannelsController, :delete)
      get("/guilds/:guild_id/threads/active", ThreadsController, :active)
      get("/channels/:channel_id/threads/archived/public", ThreadsController, :archived)
      get("/channels/:channel_id/messages", MessagesController, :index)
      post("/channels/:channel_id/messages", MessagesController, :create)
      patch("/channels/:channel_id/messages/:message_id", MessagesController, :update)
      delete("/channels/:channel_id/messages/:message_id", MessagesController, :delete)
      post("/channels/:channel_id/messages/:message_id/ack", MessagesController, :ack)
      post("/channels/:channel_id/typing", ChannelsController, :typing)
      # Channel search (B-4 CYTALE EXTENSION — literal segment, declared
      # before any :message_id-shaped GET could shadow it).
      get("/channels/:channel_id/messages/search", SearchController, :channel)
      # Thread writes (bots plan B-2): Discord's thread start/join/leave.
      post("/channels/:channel_id/messages/:message_id/threads", ThreadsController, :start_from_message)
      post("/channels/:channel_id/threads", ThreadsController, :start_standalone)
      put("/channels/:channel_id/thread-members/@me", ThreadsController, :join)
      delete("/channels/:channel_id/thread-members/@me", ThreadsController, :leave)
      # #83 compat-surface remainder: the thread-member ROSTER reads (Discord's
      # fetch_members + the self-membership check; the native twin is
      # GET /threads/:id/members). @me before any :user_id-shaped route.
      get("/channels/:channel_id/thread-members", ThreadsController, :members_index)
      get("/channels/:channel_id/thread-members/@me", ThreadsController, :member_me)
      # Reactions (Discord-shaped): @me routes first so the segment never
      # falls into the :user_id route.
      put("/channels/:channel_id/messages/:message_id/reactions/:emoji/@me", ReactionsController, :add)
      delete("/channels/:channel_id/messages/:message_id/reactions/:emoji/@me", ReactionsController, :remove_own)
      get("/channels/:channel_id/messages/:message_id/reactions/:emoji", ReactionsController, :list)
      delete("/channels/:channel_id/messages/:message_id/reactions/:emoji/:user_id", ReactionsController, :remove_user)
      delete("/channels/:channel_id/messages/:message_id/reactions/:emoji", ReactionsController, :clear_emoji)
      delete("/channels/:channel_id/messages/:message_id/reactions", ReactionsController, :clear_all)
    end
  end

  # Real-time gateway (U10): raw WebSock protocol, NOT Phoenix channels —
  # the wire format is the U2 gateway envelope exactly.
  scope "/", CytaleWeb do
    get("/gateway/websocket", GatewayController, :upgrade)
  end

  # -- SPA fallback (MUST be last: Phoenix matches in definition order) ------
  # Any unmatched GET that isn't an API path serves the built web client's
  # index.html (client-side hash routing owns navigation past /#/).
  scope "/", CytaleWeb do
    pipe_through(:api)

    get("/*path", HealthController, :spa)
  end

  @impl Plug.ErrorHandler
  def handle_errors(conn, assigns), do: CytaleWeb.ErrorHandler.handle_errors(conn, assigns)
end
