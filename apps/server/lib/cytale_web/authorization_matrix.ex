defmodule CytaleWeb.AuthorizationMatrix do
  @moduledoc """
  The declared authorization map (#35 P0-1/S-P3-16) — the router's
  default-deny convention in executable form.

  Every route whose path carries a sensitive resource param — `:channel_id`,
  `:thread_id`, `:workspace_id`, `:user_id` — MUST be declared here, and
  `CytaleWeb.AuthorizationMatrixTest` enforces coverage over
  `CytaleWeb.Router.__routes__/0` (a new sensitive route fails CI until it
  is declared). Pipeline-backed declarations are verified against the
  route's ACTUAL `pipe_through` at test time, so a declaration can't rot
  silently when pipelines are reshuffled.

  Declaration kinds:

    * `{:pipelines, [names], note}` — the route MUST pipe through each named
      pipeline (the plug-level gate).
    * `{:gate, note}` — the gate runs IN-CONTROLLER through the shared seam
      (`CytaleWeb.Compat.Authorize.channel_gate` / the parent-channel thread
      gate / the membership checks). Behavior is covered by the controllers'
      suites; the matrix pins the DECISION.
    * `{:operator, note}` — the platform-operator gate (RequireOperator).
    * `{:public, note}` — deliberately public, with the reason.
    * `{:bridge, [plugs], note}` (in `bridge_declarations/0`, not in
      `declarations/0`) — the session bridge's own listener: the route MUST run
      every named plug and MUST NOT run `CytaleWeb.Plugs.Auth`. It lives in a
      separate map because the bridge is absent from this router BY DESIGN
      (R8a) and the route-resolution checks below would read that absence as a
      vanished route.

  This module is documentation as much as enforcement: it is the one place
  that answers "what protects this route?".
  """

  @doc "The declared gate per sensitive route (`\"VERB /path\" => {kind, note}`)."
  @spec declarations() :: %{optional(String.t()) => {atom(), term(), String.t()}}
  def declarations do
    # -- Native /api/v1 — channels ------------------------------------------------
    %{
      "POST /api/v1/bots" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified human self-scope: a bot is minted FOR the caller (R5 — no permission gate)"},
      "GET /api/v1/bots" =>
        {:pipelines, [:api_auth, :content_mutation],
         "parent-anchored: the caller's own agents, enumerated from the caller's id"},
      "PATCH /api/v1/bots/:id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "owner-scoped in-controller: the caller must be the agent's PARENT (U5's grant write — the whole document)"},
      "POST /api/v1/bots/:id/regenerate" =>
        {:pipelines, [:api_auth, :content_mutation],
         "owner-scoped in-controller: the caller must be the agent's parent (token rotation)"},
      "POST /api/v1/bots/:id/avatar" =>
        {:pipelines, [:api_auth, :content_mutation],
         "owner-scoped in-controller: the caller must be the bot's parent (#126 avatar)"},
      "DELETE /api/v1/bots/:id/avatar" =>
        {:pipelines, [:api_auth, :content_mutation],
         "owner-scoped in-controller: the caller must be the bot's parent (#126 avatar clear)"},
      "DELETE /api/v1/bots/:id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "owner-scoped in-controller: the caller must be the agent's parent (revocation)"},
      "GET /api/v1/channels/:channel_id" =>
        {:gate, "channel_gate in-controller: view right (DM object for participants)"},
      "GET /api/v1/channels/:channel_id/overwrites" =>
        {:gate, "channel_gate in-controller: view right (overwrite targets are sensitive)"},
      "GET /api/v1/channels/:channel_id/threads" => {:gate, "channel_gate in-controller: view right (thread roster)"},
      "GET /api/v1/channels/:channel_id/call" =>
        {:gate, "channel_gate in-controller: view right (404 anti-enumeration)"},
      "GET /api/v1/channels/:channel_id/media-override" =>
        {:gate,
         "channel_gate in-controller: view right + MANAGE_CHANNELS tier (calls V2 U8 — 404 anti-enumeration; DM 404)"},
      "PUT /api/v1/channels/:channel_id/media-override" =>
        {:gate,
         "channel_gate in-controller: view right + MANAGE_CHANNELS tier (calls V2 U8 — 404 anti-enumeration; DM 404; overrides_not_allowed 409)"},
      "GET /api/v1/channels/:channel_id/messages" =>
        {:gate, "channel_gate in-controller: view right (#35 P0-1 — was existence-only)"},
      "GET /api/v1/channels/:channel_id/messages/:message_id" =>
        {:gate,
         "channel_gate in-controller: view right + one uniform 404 for every miss (#114 permalink resolver — an ungated resolver is a cross-workspace read oracle)"},
      "GET /api/v1/channels/:channel_id/messages/:message_id/reactions/:emoji" =>
        {:gate, "channel_gate in-controller: view right"},
      "POST /api/v1/channels/:channel_id/messages" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages], "verified + SEND_MESSAGES"},
      "POST /api/v1/channels/:channel_id/attachments" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages], "verified + SEND_MESSAGES"},
      "POST /api/v1/users/@me/avatar" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified self (documented though not param-sensitive): image-only shared upload path"},
      "PATCH /api/v1/channels/:channel_id/messages/:message_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages],
         "verified + SEND_MESSAGES; author-checked in-controller"},
      "DELETE /api/v1/channels/:channel_id/messages/:message_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages],
         "verified + SEND_MESSAGES; author-checked in-controller"},
      "POST /api/v1/channels/:channel_id/messages/:message_id/threads" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages],
         "verified + SEND_MESSAGES on the parent channel"},
      "POST /api/v1/channels/:channel_id/ack" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified; channel_gate in-controller (#35 P0-1 — read_state was writable cross-workspace)"},
      "POST /api/v1/channels/:channel_id/typing" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate in-controller"},
      "PATCH /api/v1/channels/:channel_id/call-notification-mute" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate in-controller"},
      "PUT /api/v1/channels/:channel_id/messages/:message_id/reactions/:emoji/@me" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate in-controller"},
      "DELETE /api/v1/channels/:channel_id/messages/:message_id/reactions/:emoji/@me" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate in-controller"},
      "DELETE /api/v1/channels/:channel_id/messages/:message_id/reactions/:emoji/:user_id" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate + MANAGE_MESSAGES in-controller"},
      "DELETE /api/v1/channels/:channel_id/messages/:message_id/reactions/:emoji" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate + MANAGE_MESSAGES in-controller"},
      "DELETE /api/v1/channels/:channel_id/messages/:message_id/reactions" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; channel_gate + MANAGE_MESSAGES in-controller"},
      "PATCH /api/v1/channels/:channel_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "DELETE /api/v1/channels/:channel_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "PUT /api/v1/channels/:channel_id/overwrites" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "DELETE /api/v1/channels/:channel_id/overwrites/:target_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "POST /api/v1/channels/:channel_id/webhooks" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "GET /api/v1/channels/:channel_id/webhooks" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "PATCH /api/v1/channels/:channel_id/webhooks/:id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "DELETE /api/v1/channels/:channel_id/webhooks/:id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      # -- Native /api/v1 — webhook OWNERSHIP (KD2/KD3) -----------------------------
      # The creator's path over their own webhook, deliberately OUTSIDE the
      # channel gate: a webhook's token is exempt from every downstream rights
      # check by design, so its creator must be able to stop it without holding
      # `manage_channels` on the destination. Ownership is the principal the
      # mint already wrote, enforced in-controller (`Webhooks.owner?/2`), and
      # not-the-owner renders the SAME not-found as an unknown id so the id
      # space stays unenumerable. Declared although `:id` is not in
      # `sensitive_params/0` — the defaults-deny scan cannot see the ownership
      # rule, and the declaration is where it is written down.
      "GET /api/v1/users/@me/webhooks" =>
        {:pipelines, [:api_auth],
         "self-scope: the caller's own webhooks, enumerated from the caller's account id; the only read that carries the capability URL"},
      "PATCH /api/v1/webhooks/:id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified; owner-only in-controller (Webhooks.owner?/2), with not-the-owner collapsed to the uniform not-found"},
      "DELETE /api/v1/webhooks/:id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified; owner-only in-controller — the creator's stop on their own capability"},
      # -- Native /api/v1 — threads (gates through the PARENT channel) ---------------
      "GET /api/v1/threads/:thread_id/messages" =>
        {:gate, "parent channel_gate in-controller (#35 P0-1 — was existence-only)"},
      "GET /api/v1/threads/:thread_id/members" => {:gate, "parent channel_gate in-controller (#35 P0-1)"},
      "POST /api/v1/threads/:thread_id/members" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; parent channel_gate in-controller (#35 P0-1/S-P2-13)"},
      "DELETE /api/v1/threads/:thread_id/members/@me" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; parent channel_gate in-controller (#35 P0-1/S-P2-13)"},
      "PATCH /api/v1/threads/:thread_id/members/@me" =>
        {:pipelines, [:api_auth, :content_mutation], "verified; parent channel_gate in-controller (#35 P0-1/S-P2-13)"},
      "POST /api/v1/threads/:thread_id/messages" =>
        {:pipelines, [:api_auth, :content_mutation, :can_send_messages],
         "verified + SEND_MESSAGES resolved through the plug's :thread_id branch"},
      "PATCH /api/v1/threads/:thread_id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified; parent channel_gate + creator-or-(manage_messages|manage_threads) in-controller (#109)"},

      # -- Native /api/v1/admin — search index maintenance (#89) ------------------
      "GET /api/v1/admin/workspaces/:workspace_id/search/status" =>
        {:pipelines, [:api_auth, :operator], "operator tier; drift check, sampled ids (#89)"},
      "POST /api/v1/admin/workspaces/:workspace_id/search/repair" =>
        {:pipelines, [:api_auth, :operator], "operator tier; surgical orphan repair (#89)"},
      "POST /api/v1/admin/workspaces/:workspace_id/search/rebuild" =>
        {:pipelines, [:api_auth, :operator], "operator tier; single-flight async rebuild (#89)"},
      "GET /api/v1/admin/search/rebuilds" =>
        {:pipelines, [:api_auth, :operator], "operator tier; rebuild progress (param-less, documented)"},
      # -- Native /api/v1/admin — server backups (#120) -----------------------------
      "GET /api/v1/admin/backups" =>
        {:pipelines, [:api_auth, :operator],
         "operator tier; archive list — an archive contains live credentials (#120)"},
      "GET /api/v1/admin/backups/:id/download" =>
        {:pipelines, [:api_auth, :operator], "operator tier; streams the archive — live credentials ride it (#120)"},
      "POST /api/v1/admin/backups/restore" =>
        {:pipelines, [:api_auth, :operator],
         "operator tier; destructive restore intake — stages + validates, writes the restore marker, restart into restore-mode; requires the explicit confirm token (#120)"},
      # -- Native /api/v1/admin — notification probe ---------------------------------
      "POST /api/v1/admin/notifications/test" =>
        {:pipelines, [:api_auth, :operator],
         "operator tier; sends a real push to a real member's devices, out of band (#85 follow-up)"},
      # -- Native /api/v1 — workspaces ------------------------------------------------
      "GET /api/v1/workspaces/:workspace_id" => {:gate, "membership check in-controller (404 anti-oracle)"},
      "GET /api/v1/workspaces/:workspace_id/members" => {:gate, "resolver in-controller (member-visible roster)"},
      "GET /api/v1/workspaces/:workspace_id/people" => {:gate, "membership check in-controller"},
      "GET /api/v1/workspaces/:workspace_id/commands" =>
        {:gate, "membership check in-controller (composer command list)"},
      "GET /api/v1/workspaces/:workspace_id/search" => {:gate, "membership check in-controller"},
      "GET /api/v1/workspaces/:workspace_id/roles" =>
        {:gate, "membership check in-controller (#35 P0-1 — role metadata was world-readable)"},
      "GET /api/v1/workspaces/:workspace_id/roles/:role_id" => {:gate, "membership check in-controller (#35 P0-1)"},
      "POST /api/v1/workspaces/:workspace_id/invites" =>
        {:gate,
         "membership (404 anti-oracle) + CREATE_INVITES (403) in-controller through the resolver — bare membership let any member hand the workspace to outsiders"},
      "GET /api/v1/workspaces/:workspace_id/channels" => {:gate, "membership check in-controller"},
      "POST /api/v1/workspaces/:workspace_id/channels" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_channels], "verified + MANAGE_CHANNELS"},
      "PATCH /api/v1/workspaces/:workspace_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_workspace], "verified + MANAGE_WORKSPACE"},
      "GET /api/v1/workspaces/:workspace_id/media-settings" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_workspace],
         "verified + MANAGE_WORKSPACE (calls V2 U8 — master media toggles)"},
      "PUT /api/v1/workspaces/:workspace_id/media-settings" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_workspace],
         "verified + MANAGE_WORKSPACE (calls V2 U8 — master media toggles)"},
      "POST /api/v1/workspaces/:workspace_id/icon" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_workspace],
         "verified + MANAGE_WORKSPACE (icon upload — image-only shared upload path)"},
      "DELETE /api/v1/workspaces/:workspace_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_workspace], "verified + MANAGE_WORKSPACE"},
      "DELETE /api/v1/workspaces/:workspace_id/members/:user_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_kick_members],
         "verified + KICK_MEMBERS (kick) + in-controller hierarchy gate"},
      "PATCH /api/v1/workspaces/:workspace_id/members/:user_id" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified + CytaleWeb.Nicknames (#169): own nickname CHANGE_NICKNAME, anyone else's MANAGE_NICKNAMES + Hierarchy.manage_nickname; a non-member reads as an unknown workspace"},
      # -- Native /api/v1 — roles (pipeline MANAGE_ROLES + the hierarchy gate) --------
      "POST /api/v1/workspaces/:workspace_id/roles" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_roles],
         "verified + MANAGE_ROLES + Hierarchy.manage_role (position bound) in-controller"},
      "PATCH /api/v1/workspaces/:workspace_id/roles/:role_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_roles],
         "verified + MANAGE_ROLES + Hierarchy.manage_role (#35 P0-4) in-controller"},
      "DELETE /api/v1/workspaces/:workspace_id/roles/:role_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_roles],
         "verified + MANAGE_ROLES + Hierarchy.manage_role (#35 P0-4) in-controller"},
      "PUT /api/v1/workspaces/:workspace_id/roles/:role_id/members/:user_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_roles],
         "verified + MANAGE_ROLES + Hierarchy.manage_role (no self-grant, #35 P0-4)"},
      "DELETE /api/v1/workspaces/:workspace_id/roles/:role_id/members/:user_id" =>
        {:pipelines, [:api_auth, :content_mutation, :can_manage_roles],
         "verified + MANAGE_ROLES + Hierarchy.manage_role (no self-revoke, #35 P0-4)"},
      # -- Native /api/v1 — identity-scoped writes (verified posture, S-P2-13) --------
      "POST /api/v1/users/:user_id/channels" =>
        {:pipelines, [:api_auth, :content_mutation],
         "verified (S-P2-13): DM-open is a write; participation gates the channel after"},
      "POST /api/v1/workspaces" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified (S-P2-13): an unverified account must not mint itself an owner role"},
      # -- Native /api/v1 — SSH certificates (U2, terminal plan) -----------------------
      # Declared although no path segment here is in `sensitive_params/0` (the
      # routes are `@me`-scoped and the only param is an opaque key id): a route
      # the default-deny scan cannot see is a route only a declaration covers.
      "POST /api/v1/users/@me/ssh/certificates" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified self-scope: the principal is derived from the SESSION, never the body (R3a/R4)"},
      "GET /api/v1/users/@me/ssh/certificates" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "self-scope: the caller's own keys and certificates, enumerated from the caller's account id (R5)"},
      "POST /api/v1/users/@me/ssh/certificates/:key_id/reissue" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified self-scope: the stored key is read back from the caller's own account, so a foreign key id is not found (R6)"},
      "DELETE /api/v1/users/@me/ssh/certificates/:key_id" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified self-scope: removal of the caller's own stored key — the only revocation this surface has (R5a)"},
      # -- Native /api/v1 — WebAuthn passkeys (#36) -------------------------------------
      # Declared although no path segment is in `sensitive_params/0` (the
      # settings routes are `@me`-scoped; the only param is an opaque
      # credential id): enrollment MINTS A LOGIN credential, so its gate is
      # worth pinning in the same terms as the SSH-certificate mint above.
      # The pre-auth ceremony half (/auth/webauthn/login/*) is deliberately
      # undeclared-public — the same posture as POST /auth/login — and its
      # uniform invalid_credentials refusal is the anti-oracle.
      "POST /api/v1/auth/webauthn/register/options" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified self-scope: the challenge is minted FOR the caller's account id, never a body id"},
      "POST /api/v1/auth/webauthn/register/verify" =>
        {:pipelines, [:api_auth, :human_only, :content_mutation],
         "verified self-scope: enrollment mints a LOGIN credential for the CALLER's account (the S-P2-13 rule, as for SSH-certificate issuance)"},
      "GET /api/v1/users/@me/webauthn/credentials" =>
        {:pipelines, [:api_auth], "self-scope: the caller's own passkeys, enumerated from the caller's account id"},
      "DELETE /api/v1/users/@me/webauthn/credentials/:credential_id" =>
        {:pipelines, [:api_auth],
         "self-scope revocation: removing the caller's own passkey — plain :api_auth like DELETE /users/@me/sessions (an identity-scoped security action, not content); not-yours and not-found collapse to one 404"},
      # -- TOTP two-factor (#127) ---------------------------------------------------------
      # Declared although no path segment is in `sensitive_params/0` (the
      # settings pair is `@me`-scoped; the pre-auth half carries no params at
      # all): the gate here is the GRANT — a short-lived single-purpose ticket
      # the password step minted — and that decision is worth pinning in the
      # same terms as every other token-minting surface. Deliberately
      # undeclared-public in the pipeline sense (they ride :auth_surface like
      # POST /auth/login), with the grant/bearer check in-controller.
      "POST /api/v1/auth/2fa/verify" =>
        {:public,
         "#127: the enrolled login's second factor — authenticated by the :totp GRANT the password step minted (single-use, ~5-min TTL, failure-budgeted), which alone can reach the token mint; a wrong/spent/expired grant is the uniform 401, no oracle"},
      "POST /api/v1/auth/2fa/enroll/start" =>
        {:public,
         "#127: enrollment ceremony start — authenticated in-controller by an :enrollment GRANT (the forced walk) or the caller's Bearer (settings); mints the candidate secret only, arms nothing"},
      "POST /api/v1/auth/2fa/enroll/confirm" =>
        {:public,
         "#127: enrollment ceremony confirm — the code must verify against the candidate secret before the enrollment arms; the grant path's success is the ONLY exit from the forced walk into a token pair"},
      "GET /api/v1/users/@me/two-factor" =>
        {:pipelines, [:api_auth],
         "self-scope: the caller's own enrollment status, keyed by the session's account id (#127)"},
      "DELETE /api/v1/users/@me/two-factor" =>
        {:pipelines, [:api_auth],
         "self-scope removal: the caller's own enrollment — plain :api_auth like DELETE /users/@me/webauthn/credentials (an identity-scoped security action); removing while the switch is on just re-prompts enrollment at the next password login (#127)"},
      # Declared although no path segment is in `sensitive_params/0` (#117): the
      # mention inbox's partition key IS the caller, so there are no other
      # member's rows to address and no cross-member read to gate — the shape of
      # the surface IS the privacy property (#113's bookmark test). Marking done
      # deletes ROWS only and never writes `read_state`, so an inbox action
      # cannot move a channel's read watermark.
      "GET /api/v1/users/@me/omnisearch" =>
        {:pipelines, [:api_auth],
         "self-scope Cmd-K search: workspace hits pass the per-workspace visible-channel gate, DM hits come from the caller's own dms_of_user index — participation is the authorization"},
      "GET /api/v1/users/@me/inbox" =>
        {:pipelines, [:api_auth],
         "self-scope: keyed by the caller's own account id, so no request can name another member's inbox"},
      "DELETE /api/v1/users/@me/inbox" =>
        {:pipelines, [:api_auth],
         "self-scope bulk sweep: deletes the caller's own rows only — the watermark is untouched"},
      "DELETE /api/v1/users/@me/inbox/:message_id" =>
        {:pipelines, [:api_auth],
         "self-scope per-item done: the delete is keyed by (caller, message), so a foreign message id can never reach another member's row"},
      "GET /api/v1/users/@me/marks" =>
        {:pipelines, [:api_auth],
         "self-scope (#54): the caller's own pending marks, identifiers and times only, filtered to channels channel_gate still admits"},
      "PUT /api/v1/users/@me/marks/:kind/channels/:channel_id/messages/:message_id" =>
        {:gate,
         "channel_gate in-controller (#54 R12): a mark needs a message the caller can READ; the stored channel is the fetched message's; one 404 for every miss"},
      "DELETE /api/v1/users/@me/marks/:kind/channels/:channel_id/messages/:message_id" =>
        {:gate,
         "channel_gate in-controller (#54): cancel is keyed by (caller, kind, message) and gated like the set; one 404 for every miss"},
      # Declared although the route is param-less — the notifications
      # settings' "send me a test" button, which the default-deny scan cannot
      # see. It is the strongest self-scope shape in the router: there is NO
      # target parameter at all, so the send is keyed by the caller's own
      # account id and a member cannot notify anyone but themselves. The
      # operator probe on the admin tier is the other half — it answers "can I
      # reach that OTHER member" and carries RequireOperator for it.
      "POST /api/v1/users/@me/notifications/test" =>
        {:pipelines, [:api_auth],
         "self-scope: no target parameter exists — the push is fanned out to the caller's own registered devices only"},
      # -- Operator tier ---------------------------------------------------------------
      "GET /api/v1/admin/workspaces/:workspace_id/audit" =>
        {:operator, "RequireOperator (#33): CYTALE_ADMIN_USER_IDS allowlist, fail-closed"},
      "GET /api/v1/admin/workspaces/:workspace_id/deletion-cascade/:user_id" => {:operator, "RequireOperator (#33)"},
      # Declared although no path segment is in `sensitive_params/0`: the read
      # returns route/message/request-id data across all clients, which is at
      # least as sensitive as a workspace id, and the default-deny scan cannot
      # see a param-less route.
      "GET /api/v1/admin/client-errors" =>
        {:operator,
         "RequireOperator (#33): a client error's route is a map of where people were, so the grouped read is operator-only (#88)"},
      # Server configuration (#121) — declared although param-less, same
      # reasoning: the config document, the write to it, and the restart
      # switch are the most powerful surfaces on the node.
      "GET /api/v1/admin/config" =>
        {:operator,
         "RequireOperator (#33): the served document carries NO secrets (secrets.json is never GET-served) (#121)"},
      "PUT /api/v1/admin/config" =>
        {:operator,
         "RequireOperator (#33): schema-validated atomic write; hot-applies runtime keys, restart_required on boot-scoped change (#121)"},
      "POST /api/v1/admin/restart" =>
        {:operator,
         "RequireOperator (#33): graceful System.stop(0); the container policy/dev watchdog brings the node back (#121)"},
      # -- UNAUTHENTICATED by design (#88) ----------------------------------------------
      "POST /api/v1/client-errors" =>
        {:public,
         "client-error ingest: the most valuable crash to capture is the login-page one, which has no session to present. OptionalAuth attributes it when a credential IS present; the tight per-IP :client_errors bucket is the dam, and the write is content-blind by construction"},
      # -- Capability surfaces -----------------------------------------------------------
      "GET /api/v1/attachments/:hash" =>
        {:public,
         "signed URLs (Tier 2 #4): message attachments need a live ?e=&s= HMAC minted per render; only avatar/icon blobs (public profile media) serve unsigned; SVG uploads banned, vetted-inline-only serving"},
      "GET /api/v10/users/@me/channels/:channel_id/messages/search" =>
        {:gate, "compat B-4: DM participation IS authorization (in-controller)"},
      "GET /api/users/@me/channels/:channel_id/messages/search" =>
        {:gate, "compat B-4: DM participation IS authorization (in-controller)"},
      "GET /api/v10/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "POST /api/v10/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "PUT /api/v10/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "GET /api/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "POST /api/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "PUT /api/applications/:application_id/guilds/:workspace_id/commands" =>
        {:gate, "compat KTD13: {bot_id}-must-be-self + workspace rights in-controller"},
      "PATCH /api/v10/guilds/:guild_id/members/:user_id" =>
        {:gate,
         "compat #169: CytaleWeb.Nicknames — the bot's own nick needs CHANGE_NICKNAME (read_write grant ∩ owner), anyone else's MANAGE_NICKNAMES (never in a grant) + hierarchy"},
      "PATCH /api/guilds/:guild_id/members/:user_id" =>
        {:gate,
         "compat #169: CytaleWeb.Nicknames — the bot's own nick needs CHANGE_NICKNAME (read_write grant ∩ owner), anyone else's MANAGE_NICKNAMES (never in a grant) + hierarchy"}
    }
    |> then(fn native ->
      # The compat channel/thread/reaction surface: every route gates through
      # the ONE shared seam (Authorize.channel_gate + action bits) — verified
      # by the #35 audit across all compat controllers. Declared as a class
      # to keep this map readable; the test expands it over the router.
      # Explicit entries above (the application-command routes) win.
      compat =
        CytaleWeb.Router.__routes__()
        |> Enum.filter(&(String.starts_with?(&1.path, "/api/v10/") or String.starts_with?(&1.path, "/api/channels/")))
        |> Enum.map(&{"#{&1.verb |> to_string() |> String.upcase()} #{&1.path}", &1.plug})
        |> Enum.filter(fn {key, _} ->
          Enum.any?(sensitive_params(), &String.contains?(key, &1))
        end)

      Enum.reduce(compat, native, fn {key, plug}, acc ->
        note =
          if String.contains?(Atom.to_string(plug), "Reactions"),
            do: "compat: channel_gate + action bit in-controller",
            else: "compat: channel_gate in-controller (view / read_message_history / send_messages)"

        Map.put_new(acc, key, {:gate, note})
      end)
    end)
  end

  @doc "Path params whose presence makes a route sensitive."
  @spec sensitive_params() :: [String.t()]
  def sensitive_params, do: [":channel_id", ":thread_id", ":workspace_id", ":user_id", ":hash"]

  @doc """
  The session bridge's declaration (R8/R8a): `"VERB /path" => {kind, payload,
  note}` with the kind `:bridge` whose payload is the plug list the route MUST
  run.

  Two facts this asserts, because both are load-bearing:

    * the bridge route runs `CytaleWeb.Plugs.BridgeAuth` — the credential gate
      — and **NOT** `CytaleWeb.Plugs.Auth`: a member token is not a bridge
      credential and must never be one, and the two surfaces must not share a
      gate by accident;
    * the route is served by `CytaleWeb.BridgeServer`'s own plug server, which
      is why it is absent from `CytaleWeb.Router.__routes__/0` — the absence is
      the R8a property (a route on the app router would be reachable through
      the public edge, which proxies that listener).

  Kept out of `declarations/0` so the app router's route-resolution checks do
  not read the deliberate absence as a vanished route.
  """
  @spec bridge_declarations() :: %{optional(String.t()) => {atom(), [module()], String.t()}}
  def bridge_declarations do
    %{
      "POST /internal/ssh/session" =>
        {:bridge, [CytaleWeb.Plugs.BridgeAuth],
         "machine caller holding the bridge credential (constant-time, over SHA-256 hashes); " <>
           "serial + principal + fingerprint bound to an issuance THIS server made (R8); " <>
           "not :api_auth — a member token never reaches the bridge"}
    }
  end
end
