defmodule CytaleWeb.BotController do
  @moduledoc """
  U4 (bots plan) — zero-ceremony machine-principal minting + lifecycle REST.

  Two scopes, one controller:

    * **Bots** — workspace-scoped (`/api/v1/workspaces/{id}/bots...`), gated
      `manage_workspace` + content_mutation by the router pipeline; the
      workspace in the path is the gate. A bot "belongs to" the workspace
      through its PARENT's membership (the U3 resolver's association rule),
      so the scoped fetch is: principal exists, kind :bot, parent is a
      member — anything else is a 404 with the scope's key (never a
      membership oracle).
    * **Agents** — user-scoped (`/api/v1/bots...`), `:api_auth` +
      RequireVerified, parent = caller, no permission gate. Ownership is
      parent == caller; cross-scope ids (a bot id on the agents routes, or
      vice versa) fail the scope check and 404.

  Lifecycle semantics (KTD6):

    * `name` changes never touch sessions (display metadata only);
    * `restrictions` changes are PROFILE changes — live sessions tear down
      through the reconnectable op-6 Reconnect signal (never 4004, which
      client libraries treat as fatal for a still-valid credential), forcing
      the fresh Identify the narrowing depends on;
    * regenerate/DELETE kill the credential: old token rows die, live
      sessions close 4004, stored resume records purge (Resume cannot
      resurrect). In-flight REST requests complete — revocation bounds the
      NEXT action.

  Only `:human` principals may mint (R1: depth is 1). Tokens are the U1
  `cytbot_` shape, returned exactly once from create/regenerate; every other
  read is metadata only.
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.Principals
  alias Cytale.Accounts.User
  alias Cytale.Gateway.SessionStore
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Snowflake
  alias Cytale.Workspaces
  import CytaleWeb.API.Error, only: [error: 4]

  # Discord-shaped auth-failed close (dead credential, non-reconnectable).
  @close_auth_failed 4004

  # ---------------------------------------------------------------------------
  # Bots (user-owned)
  # ---------------------------------------------------------------------------
  #
  # There is exactly ONE way to provision a machine credential now: a verified
  # human mints it for themselves. The workspace-scoped routes
  # (`/workspaces/{id}/bots`) are GONE (owner decision 2026-09-12): a bot is
  # never workspace-owned — its workspaces appear only as grants in its access
  # document, which the owner sets. That also removes the split where a
  # workspace manager could provision a credential whose authority came from a
  # role rather than from the account it acts for.
  #
  # The vocabulary is bot throughout (the URL, the kind, `cytbot_`, this
  # module) and "Agent" is only ever the WORD a person reads. Every read/write
  # below is deliberately kind-agnostic over machine kinds, so a row minted
  # while a second kind existed stays visible, grantable, rotatable and
  # revocable rather than being stranded.

  @doc "POST /bots — any verified human, for themselves; no permission gate."
  def create_bot(conn, %{"name" => _name} = params), do: do_create(conn, params, :bot)

  def create_bot(conn, _params), do: error(conn, 400, "validation_failed", "name is required")

  # The create bodies are verbatim across kinds (bots plan U4): only the
  # minted kind differs — the router pipeline already carried the gate
  # difference (manage_workspace vs self-scope).
  #
  # `name` is the DISPLAY name and may be anything; `username` is the TAG and
  # must be unique per server. Omitted → derived from the name. Refused (rather
  # than silently altered) when taken, because an explicit tag is a choice.
  defp do_create(conn, params, kind) do
    %{user_id: parent_id} = conn.assigns.current_user

    with :ok <- require_human_minter(conn),
         {:ok, restrictions} <- parse_restrictions(params["restrictions"]),
         {:ok, minted} <-
           Principals.mint(parent_id, kind, params["name"], restrictions, params["username"]) do
      conn
      |> put_status(201)
      |> json(%{"id" => Integer.to_string(minted.user_id), "token" => minted.token})
    else
      {:error, :non_human_minter} ->
        error(conn, 403, "forbidden", "Only human principals may mint machine credentials")

      {:error, :invalid_label} ->
        error(conn, 400, "validation_failed", "name must be 1-100 characters")

      {:error, :invalid_restrictions} ->
        error(conn, 400, "invalid_restrictions", "restrictions must be actions/channels only")

      {:error, :username_taken} ->
        # The caller set the tag themselves or left it to the name — the fix
        # is different (change the tag vs change the name), so say which.
        if params["username"] in [nil, ""] do
          error(
            conn,
            400,
            "username_taken",
            "That name is already taken on this server — pick a different name, or set a Tag below"
          )
        else
          error(conn, 400, "username_taken", "That tag is already taken on this server")
        end

      {:error, :invalid_username} ->
        error(conn, 400, "invalid_username", "The tag must be 2-32 characters of a-z, 0-9, _ . -")

      {:error, :principal_cap} ->
        # B6g: the parent's machine-principal budget (all kinds combined).
        error(conn, 400, "principal_cap", "This account already holds its machine-principal limit (50)")

      {:error, _parent} ->
        error(conn, 403, "forbidden", "Only human principals may mint machine credentials")
    end
  end

  @doc "GET /bots — the caller's machine credentials, metadata only."
  def index_bot(conn, _params) do
    %{user_id: caller_id} = conn.assigns.current_user

    rows =
      caller_id
      |> Principals.list_by_parent()
      |> Enum.filter(&machine_credential?/1)

    users = bot_users_of(rows)

    # The envelope key is part of the contract: `api-client`'s `listBots`
    # unwraps `res.bots` (it read `res.agents` while the route said /agents).
    json(conn, %{"bots" => Enum.map(rows, &list_json(&1, Map.get(users, &1.user_id)))})
  end

  @doc """
  GET /users/@me/integrations — the caller's machine principals (bots and
  agents; webhooks are channel-scoped capability rows, not parent-minted
  principals, and stay on their per-channel surface) with a live-session
  flag. This is the settings gear's "My integrations" rollup: principals
  are parent-anchored, not workspace-pinned (the U3 association rule), so
  ONE parent read is the cross-workspace rollup — metadata only, never
  tokens. Machine callers get an empty list (nothing parents to them).
  """
  def my_integrations(conn, _params) do
    %{user_id: caller_id} = conn.assigns.current_user

    integrations =
      caller_id
      |> Principals.list_by_parent()
      |> then(fn rows ->
        users = bot_users_of(rows)

        Enum.map(rows, fn principal ->
          # Single-node liveness (same discipline as roster presence): live
          # gateway sessions index in-memory on this node.
          principal
          |> list_json(Map.get(users, principal.user_id))
          |> Map.put("online", SessionStore.principal_sessions(principal.user_id) != [])
        end)
      end)

    json(conn, %{"integrations" => integrations})
  end

  @doc "PATCH /bots/{id} — name and/or restrictions (same semantics as bots)."
  def update_bot(conn, %{"id" => id} = params) do
    %{user_id: caller_id} = conn.assigns.current_user

    with {:ok, principal_id} <- Snowflake.parse(id),
         {:ok, principal} <- fetch_owned_bot(principal_id, caller_id) do
      update_principal(conn, principal, params)
    else
      _ -> error(conn, 404, "bot_not_found", "No such bot for this user")
    end
  end

  @doc "POST /bots/{id}/regenerate — rotate the once-only credential."
  def regenerate_bot(conn, %{"id" => id}) do
    %{user_id: caller_id} = conn.assigns.current_user

    with {:ok, principal_id} <- Snowflake.parse(id),
         {:ok, principal} <- fetch_owned_bot(principal_id, caller_id) do
      rotate_and_respond(conn, principal)
    else
      _ -> error(conn, 404, "bot_not_found", "No such bot for this user")
    end
  end

  @doc """
  POST /bots/{id}/avatar — owner-scoped image upload (#126). Same pipeline
  and limits as the human avatar path; sets `avatar_url` atomically with the
  upload. The OWNER uploads — a credential cannot (require_human everywhere).
  """
  def upload_avatar(conn, %{"id" => id} = params) do
    %{user_id: caller_id} = conn.assigns.current_user

    with {:ok, principal_id} <- Snowflake.parse(id),
         {:ok, principal} <- fetch_owned_bot(principal_id, caller_id) do
      do_upload_avatar(conn, principal, params)
    else
      _ -> error(conn, 404, "bot_not_found", "No such bot for this user")
    end
  end

  defp do_upload_avatar(conn, principal, params) do
    current = User.get(principal.user_id)

    with {:ok, upload} <- Cytale.Attachments.Upload.extract(params),
         {:ok, descriptor} <- Cytale.Attachments.Upload.validate_and_store(upload, :avatar) do
      # Preserve the display name; only the avatar moves (update_profile!
      # writes both fields atomically).
      :ok = User.update_profile!(principal.user_id, current && current.display_name, descriptor["url"])

      # Broadcast the USERS row (display_name + avatar_url live there, not on
      # the principal).
      broadcast_bot_update(User.get(principal.user_id))
      json(conn, %{"bot" => principal_json(Principals.get(principal.user_id))})
    else
      {:error, :no_file} ->
        error(conn, 400, "validation_failed", "A file upload is required.")

      {:error, :too_large} ->
        cap_mb =
          String.trim_trailing(
            to_string(Float.round(Cytale.Config.avatar_max_upload_bytes() / 1024 / 1024, 1)),
            ".0"
          )

        error(conn, 413, "file_too_large", "Avatar exceeds the #{cap_mb} MB cap.")

      {:error, :dimensions_exceeded} ->
        max_dim = Cytale.Config.avatar_max_dimension()

        error(conn, 400, "validation_failed", "Avatar image must be at most #{max_dim} pixels on a side.")

      {:error, :disallowed_mime} ->
        error(conn, 415, "unsupported_media_type", "Avatars must be PNG, JPEG, GIF, or WebP.")

      {:error, :volume_full} ->
        error(conn, 507, "storage_full", "Attachment storage is full; try again later.")
    end
  end

  @doc "DELETE /bots/{id}/avatar — back to the initial-letter fallback."
  def clear_avatar(conn, %{"id" => id}) do
    %{user_id: caller_id} = conn.assigns.current_user

    with {:ok, principal_id} <- Snowflake.parse(id),
         {:ok, principal} <- fetch_owned_bot(principal_id, caller_id) do
      current = User.get(principal.user_id)
      :ok = User.update_profile!(principal.user_id, current && current.display_name, nil)

      broadcast_bot_update(User.get(principal.user_id))
      json(conn, %{"bot" => principal_json(Principals.get(principal.user_id))})
    else
      _ -> error(conn, 404, "bot_not_found", "No such bot for this user")
    end
  end

  # Live avatar/name convergence for a machine principal — the SAME
  # UserUpdate a person's profile write publishes (CytaleWeb.MemberEvents):
  # `username` stays the bot's handle, the label rides `display_name`.
  defp broadcast_bot_update(user) when is_map(user), do: CytaleWeb.MemberEvents.announce_profile(user)

  @doc "DELETE /bots/{id} — revoke + 4004 teardown, 204."
  def delete_bot(conn, %{"id" => id}) do
    %{user_id: caller_id} = conn.assigns.current_user

    with {:ok, principal_id} <- Snowflake.parse(id),
         {:ok, principal} <- fetch_owned_bot(principal_id, caller_id) do
      revoke_and_teardown(conn, principal)
    else
      _ -> error(conn, 404, "bot_not_found", "No such bot for this user")
    end
  end

  # ---------------------------------------------------------------------------
  # Shared mutation body (PATCH semantics are scope-independent)
  # ---------------------------------------------------------------------------

  # `access` on the wire is the access document itself (see Cytale.Access); an
  # absent key means "untouched", and an invalid one is refused before anything
  # is written (never stored as the fail-closed default by accident).
  defp parse_access(nil), do: {:ok, nil}

  defp parse_access(document) do
    case Cytale.Access.parse(document) do
      {:ok, parsed} -> {:ok, parsed}
      {:error, _reason} -> {:error, :invalid_access}
    end
  end

  # A bot's label is its display name, and a shown name is unique in a
  # workspace (owner decision 2026-10-04): the same rule a person's display
  # name meets, over the workspaces the bot is a member of (its grants).
  # Bots and people, one rule (Workspaces.name_taken?/3).
  #
  # Two ways a chosen label enters a workspace, both checked: a RENAME (in
  # every workspace the bot will belong to) and a GRANT (in each workspace the
  # bot is entering — its owner chose to bring that name there). `new_access`
  # is the document being written, nil when the patch does not touch access.
  defp unique_label(principal, name, new_access) do
    current = User.get(principal.user_id)
    current_label = current && current.display_name
    label = if is_binary(name), do: String.trim(name), else: current_label
    renamed? = is_binary(name) and label != current_label

    before = Workspaces.associated_workspace_ids(principal.parent_user_id, principal.access)
    after_ws = Workspaces.associated_workspace_ids(principal.parent_user_id, new_access || principal.access)
    to_check = if renamed?, do: after_ws, else: after_ws -- before

    case is_binary(label) and Workspaces.name_taken_in(to_check, label, principal.user_id) do
      ws_id when is_integer(ws_id) ->
        {:error, {:name_taken, (Workspaces.get_workspace(ws_id) || %{name: "a workspace"}).name}}

      _ ->
        :ok
    end
  end

  defp update_principal(conn, principal, params) do
    name = params["name"]
    restrictions_touched? = Map.has_key?(params, "restrictions")
    access_touched? = Map.has_key?(params, "access")

    if is_nil(name) and not restrictions_touched? and not access_touched? do
      error(conn, 400, "validation_failed", "nothing to update: name, restrictions or access required")
    else
      with :ok <- validate_name(name),
           {:ok, canonical} <- parse_restrictions(params["restrictions"]),
           {:ok, access} <- parse_access(params["access"]),
           :ok <- unique_label(principal, name, if(access_touched?, do: access)) do
        if name do
          # A rename must NOT clobber the avatar: write back the row's
          # current avatar_url (update_profile! sets both fields).
          current = User.get(principal.user_id)
          :ok = User.update_profile!(principal.user_id, String.trim(name), current && current.avatar_url)

          # Label renames are roster-visible (the label is the display name) —
          # converge live sessions exactly as a person's profile write does:
          # the handle stays in `username`, the new label rides `display_name`.
          CytaleWeb.MemberEvents.announce_profile(principal.user_id)
        end

        if restrictions_touched? do
          :ok = Principals.update_restrictions(principal.user_id, canonical)
        end

        if access_touched? do
          # The GRANT write (agent model): the whole document in one call, so
          # the tree can never be half-applied. Validation happens in
          # parse_access above, before anything is persisted.
          :ok = Principals.update_access(principal.user_id, access)
        end

        if restrictions_touched? or access_touched? do
          # Profile mutation (R3): an authority change tears down live sessions
          # via the reconnectable op-7/op-6 Reconnect — the still-valid
          # credential must re-Identify, never be bricked with 4004 (KTD6) —
          # and re-identifying is also how a live session picks the new
          # document up (a resume re-authenticates from the token). Name-only
          # patches carry no session effect.
          :ok = SessionStore.reconnect_principal_sessions(principal.user_id)
        end

        if access_touched? do
          # KTD4, the passive half: the epoch bump is what makes any consumer
          # holding a memo recompute its visible set. The universe bumped is
          # every workspace the PARENT belongs to, which is exactly the memo's
          # key set — `Workspaces.workspaces_of_user/1` derives a machine's
          # membership from its parent (`membership_owner_id/1`), so a
          # workspace the agent could see before the write and one it can see
          # after are both in that set by construction. Over-bumping costs a
          # recompute; a missed bump is an authority bug (KTD4).
          #
          # The agent's own live sessions are already torn down above, so this
          # pair is not how a normal grant change reaches them: it is the net
          # under the seam — a session that registered inside the teardown's
          # enumeration window, or a client that re-Identified concurrently,
          # recomputes against the CURRENT document instead of keeping the
          # memo it built from the snapshot it identified with.
          for workspace_id <- Workspaces.workspace_ids_of_user(principal.parent_user_id) do
            RightsEpoch.bump(workspace_id)
          end

          CytaleWeb.GatewaySocket.refresh_principal_routes(principal.parent_user_id)
        end

        updated = Principals.get(principal.user_id)

        if access_touched? do
          # A grant is how a machine becomes a member (membership by
          # association): announce it the way a person's join is announced,
          # so open clients name the bot — and badge it — the moment it posts.
          CytaleWeb.MemberEvents.announce_grant_change(principal, principal.access, updated && updated.access)
        end

        json(conn, principal_json(updated))
      else
        {:error, :invalid_label} ->
          error(conn, 400, "validation_failed", "name must be 1-100 characters")

        {:error, :invalid_restrictions} ->
          error(conn, 400, "invalid_restrictions", "restrictions must be actions/channels only")

        {:error, :invalid_access} ->
          error(conn, 400, "invalid_access", "access must be a valid access document")

        {:error, {:name_taken, workspace_name}} ->
          error(conn, 409, "name_taken", "Someone in #{workspace_name} already goes by that name.")
      end
    end
  end

  defp validate_name(nil), do: :ok

  # U4's name rule is Principals' ONE label rule (mint and rename share it).
  defp validate_name(name) when is_binary(name), do: Principals.validate_label(name)
  defp validate_name(_), do: {:error, :invalid_label}

  defp parse_restrictions(nil), do: {:ok, nil}
  defp parse_restrictions(restrictions), do: Principals.validate_restrictions(restrictions)

  # Revoke every existing credential row, mint exactly one fresh `cytbot_`
  # token for the SAME principal, then close live sessions 4004 (the old
  # credential is dead immediately; a session identified with the new token
  # in the microseconds before the close simply re-Identifies).
  defp rotate_credential!(principal_id) do
    :ok = Principals.revoke(principal_id)
    token = Principals.mint_credential(principal_id, DateTime.utc_now() |> DateTime.truncate(:millisecond))
    :ok = SessionStore.close_principal_sessions(principal_id, @close_auth_failed)
    token
  end

  # Shared action tails (bots plan U4): regenerate/delete answer identically
  # for bots and agents once the kind-specific scope fetch has resolved the
  # principal — only the scoping `with` legs differ per surface.
  defp rotate_and_respond(conn, principal) do
    token = rotate_credential!(principal.user_id)
    conn |> put_status(201) |> json(%{"token" => token})
  end

  defp revoke_and_teardown(conn, principal) do
    # The rosters it leaves, read while the grant that defines them still
    # exists (membership by association dies with the principal row).
    departures = CytaleWeb.MemberEvents.departures(principal.user_id)

    # Bot DELETE = full removal: credential, sessions, provenance rows (the
    # users row stays for attribution) — and via the liveness filter, its
    # application commands stop listing/invoking everywhere.
    :ok = Principals.delete_machine_principal!(principal.user_id)
    :ok = SessionStore.close_principal_sessions(principal.user_id, @close_auth_failed)

    # Leaves every roster live, exactly as a revoked grant does.
    CytaleWeb.MemberEvents.announce_departures(departures)
    send_resp(conn, :no_content, "")
  end

  # -- scoping -------------------------------------------------------------------

  # A bot belongs to a workspace through its parent's membership (the same
  # association the U3 resolver uses). Unknown kind / unknown parent / parent
  # not a member → the scoped 404: no oracle about which leg failed.
  # The caller must be the PARENT of the credential — the only ownership rule
  # there is now that a workspace can no longer own one. Both machine kinds
  # pass: a `:bot` row minted under the retired workspace route is still the
  # caller's to grant, rotate and revoke (see the section note above).
  defp fetch_owned_bot(principal_id, caller_id) do
    case Principals.get(principal_id) do
      %{kind: kind, parent_user_id: ^caller_id} = principal when kind in [:agent, :bot] ->
        {:ok, principal}

      _ ->
        {:error, :not_found}
    end
  end

  # R1/R5: only :human principals may mint sub-identities (depth is 1). The
  # auth plug always sets :kind (human or machine).
  defp require_human_minter(conn) do
    case conn.assigns.current_user do
      %{kind: :human} -> :ok
      _ -> {:error, :non_human_minter}
    end
  end

  # Member ids of a workspace, before-cursor paginated to bound the
  # partition read (hundreds-scale: pages of 100 until a short page).
  # list_members orders user_id descending, so each page's last id is the
  # next page's cursor.
  # -- rendering -------------------------------------------------------------------

  # PATCH response: full metadata incl. the effective restrictions policy.
  defp principal_json(principal) do
    principal
    |> list_json(User.get(principal.user_id))
    |> Map.put("restrictions", principal.restrictions)
  end

  # List metadata contract: id, name, kind, created_at — NEVER tokens. The
  # access document rides along too (it is a policy, not a secret): the list is
  # where an owner SEES that an agent holds nothing yet (R6/U8's cut), and a
  # surface that has to render a grant needs the grant, not a summary of it.
  defp list_json(principal, user) do
    %{
      "id" => Integer.to_string(principal.user_id),
      "name" => principal.label,
      # The tag a person sees and can reference. It lives on the credential's
      # USERS row (the identity a bot shares with any account), so callers pass
      # the row in from ONE batched read rather than the auth-hot principal
      # read — which also carries the avatar_url (#126).
      "username" => user && user.username,
      "avatar_url" => user && user.avatar_url,
      "kind" => Atom.to_string(principal.kind),
      "created_at" => principal.created_at && DateTime.to_iso8601(principal.created_at),
      "access" => Cytale.Access.to_map(principal.access)
    }
  end

  # -- shared helpers ---------------------------------------------------------------

  # What this surface calls an agent: a machine credential the caller owns. The
  # `:bot` kind survives on rows minted before the workspace route was retired,
  # and it is an agent in every sense that matters here. A webhook is NOT — it
  # is a channel-scoped capability URL with its own surface, not a principal the
  # caller operates as an identity.
  defp machine_credential?(principal), do: principal.kind in [:agent, :bot]

  # The tag for a batch of principals: ONE `users IN ?` read (the same batched
  # shape the roster uses).
  defp bot_users_of(principals) do
    principals
    |> Enum.map(& &1.user_id)
    |> Cytale.Accounts.User.get_many()
  end
end
