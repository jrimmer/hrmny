defmodule CytaleWeb.Compat.ApplicationController do
  @moduledoc """
  Bots plan U8 (KTD13) — application-command registration over the compat
  applications routes:

      PUT  /applications/{bot_id}/guilds/{workspace_id}/commands   bulk upsert
      POST /applications/{bot_id}/guilds/{workspace_id}/commands   single create
      GET  /applications/{bot_id}/guilds/{workspace_id}/commands   the stored set

  guild → workspace (KTD7). The upsert is rejected unless `{bot_id}` equals
  the authenticated principal AND the resolver returns non-zero rights for
  `{workspace_id}` (KTD13) — the binding means one bot can never grow
  another's command set; the rights gate means a bot whose parent lost
  membership cannot register in that workspace. The GET (#133) applies the
  SAME two gates — it is the read half of the pair (discord.py-family safe
  sync's fetch → diff → PUT and discord.js `guild.commands.fetch()` begin
  here), so a bot can only ever re-read its own registration.
  """

  use CytaleWeb, :controller

  alias Cytale.Interactions
  alias Cytale.Permissions.Principal, as: PrincipalRights
  alias Cytale.Snowflake
  alias CytaleWeb.Compat.{Errors, MessageCodec}

  # The placeholder `verify_key` (64 hex chars, Discord's shape): Cytale has
  # no Ed25519 interaction-signature concept, so there is no real key. A
  # fixed value (rather than a derived one) keeps the response byte-stable
  # across releases — a client that caches it sees no spurious change.
  @verify_key String.duplicate("0", 64)

  @doc "PUT — bulk upsert (Discord libraries' default); echoes the stored array."
  def bulk_upsert(conn, %{"application_id" => app, "workspace_id" => ws}) do
    claims = conn.assigns.current_user

    with {:ok, app_id} <- Snowflake.parse(app),
         {:ok, ws_id} <- Snowflake.parse(ws),
         :ok <- require_self_application(claims, app_id),
         :ok <- require_workspace_rights(claims, ws_id),
         {:ok, list} <- array_body(conn.body_params),
         {:ok, stored} <- Interactions.upsert_commands(ws_id, app_id, list, :replace) do
      json(conn, Enum.map(stored, &command_json/1))
    else
      {:error, :unknown_application} -> Errors.unknown_application(conn)
      {:error, :unknown_guild} -> Errors.not_found(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_body} -> Errors.invalid_form_body(conn)
      _ -> Errors.invalid_form_body(conn)
    end
  end

  @doc "POST — single create (upsert of one command, siblings untouched)."
  def create(conn, %{"application_id" => app, "workspace_id" => ws}) do
    claims = conn.assigns.current_user

    with {:ok, app_id} <- Snowflake.parse(app),
         {:ok, ws_id} <- Snowflake.parse(ws),
         :ok <- require_self_application(claims, app_id),
         :ok <- require_workspace_rights(claims, ws_id),
         {:ok, body} <- object_body(conn.body_params),
         {:ok, [stored]} <- Interactions.upsert_commands(ws_id, app_id, [body], :merge) do
      conn
      |> put_status(201)
      |> json(command_json(stored))
    else
      {:error, :unknown_application} -> Errors.unknown_application(conn)
      {:error, :unknown_guild} -> Errors.not_found(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      {:error, :invalid_body} -> Errors.invalid_form_body(conn)
      _ -> Errors.invalid_form_body(conn)
    end
  end

  @doc """
  GET — the stored command set (Discord's guild-application-commands list),
  the READ half of the write pair above (#133). discord.py-family safe sync
  (fetch → diff → PUT) and discord.js `guild.commands.fetch()` begin with
  this collection GET — without the route the fetch raises (404) and sync
  never reaches its PUT.

  The gates are the writes' gates verbatim (KTD13): the self-application
  binding (a foreign `{application_id}` renders the IDENTICAL 10002 — the
  read is as anti-oracle as the write) and the workspace-rights resolver
  (non-zero rights; unknown workspace → bare 404). The response is the same
  serializer the PUT echo uses, so a client's fetch sees the exact shape its
  own upsert echoed.
  """
  def index(conn, %{"application_id" => app, "workspace_id" => ws}) do
    claims = conn.assigns.current_user

    with {:ok, app_id} <- Snowflake.parse(app),
         {:ok, ws_id} <- Snowflake.parse(ws),
         :ok <- require_self_application(claims, app_id),
         :ok <- require_workspace_rights(claims, ws_id) do
      # The (workspace, application) projection of the live command list —
      # the same single-partition read (partition key workspace_id, clustering
      # application_id/command_id) the composer list uses. list_commands/1's
      # liveness filter is a no-op for these rows (the authenticated
      # application's principal exists by construction), so the projection is
      # exactly the stored set for this application. The per-pair reader in
      # Cytale.Interactions is private and the context is outside this unit's
      # file ownership, hence the in-memory filter rather than a new context
      # function.
      stored =
        ws_id
        |> Interactions.list_commands()
        |> Enum.filter(&(&1.application_id == app_id))

      json(conn, Enum.map(stored, &command_json/1))
    else
      {:error, :unknown_application} -> Errors.unknown_application(conn)
      {:error, :unknown_guild} -> Errors.not_found(conn)
      {:error, :missing_permissions} -> Errors.missing_permissions(conn)
      _ -> Errors.invalid_form_body(conn)
    end
  end

  @doc """
  GET — the authenticated application (#61 item 2), served at BOTH
  `/applications/@me` (discord.js) and `/oauth2/applications/@me`
  (discord.py, and it is fetched by `Client.login()` BEFORE a socket is ever
  opened — a missing route is a 404 on login).

  Shape: `discord.appinfo.AppInfo.__init__` indexes the payload with
  `data[...]` for `id`, `name`, `description`, `icon`, `bot_public`,
  `bot_require_code_grant`, `owner` and `verify_key`, so all eight are
  ALWAYS present (a KeyError would be the same login failure as the 404).
  The application IS the machine principal: `id` is the principal snowflake,
  `owner` its parent human.

  `verify_key` is a fixed placeholder: it is Discord's Ed25519 public key
  for interaction-request signatures, and Cytale neither signs interactions
  nor sends `X-Signature-Ed25519` — there is no key to publish. See the
  ledger entry in `docs/protocol/compat.md`.
  """
  @spec me(Plug.Conn.t(), map()) :: Plug.Conn.t()
  def me(conn, _params) do
    claims = conn.assigns.current_user

    json(conn, %{
      "id" => Integer.to_string(claims.user_id),
      "name" => claims.username,
      "description" => "",
      "icon" => nil,
      "bot_public" => true,
      "bot_require_code_grant" => false,
      "owner" => MessageCodec.author_object(claims.parent_user_id || claims.user_id),
      "verify_key" => @verify_key,
      # #112: the capability SIGNAL clients branch on — without it they infer
      # Message Content is unavailable and skip requesting 1<<15 in Identify.
      "flags" => MessageCodec.application_flags(),
      "team" => nil,
      "tags" => []
    })
  end

  # ---------------------------------------------------------------------------
  # Authorization (KTD13's two registration gates)
  # ---------------------------------------------------------------------------

  # Gate 1 — binding: `{bot_id}` in the path MUST be the authenticated
  # principal itself. A mismatch renders the IDENTICAL 10002 as an unknown
  # application (anti-oracle: writing someone else's command set is
  # indistinguishable from addressing a nonexistent one).
  defp require_self_application(claims, app_id) do
    if claims.user_id == app_id,
      do: :ok,
      else: {:error, :unknown_application}
  end

  # Gate 2 — workspace rights: the resolver must return NON-ZERO effective
  # rights for `{workspace_id}` (KTD13). Unknown workspace → bare 404; no
  # membership (or a restrictions profile that masks every bit) → 403 50001.
  defp require_workspace_rights(claims, ws_id) do
    case PrincipalRights.resolve(ws_id, claims, nil) do
      {:ok, bits} when bits != 0 -> :ok
      {:ok, _zero_bits} -> {:error, :missing_permissions}
      {:error, :not_found} -> {:error, :unknown_guild}
      {:error, :forbidden} -> {:error, :missing_permissions}
    end
  end

  # ---------------------------------------------------------------------------
  # Bodies + shapes
  # ---------------------------------------------------------------------------

  # Discord libraries PUT a bare JSON ARRAY — Plug's JSON parser wraps a
  # non-map root under the "_json" key, so unwrap it first.
  defp array_body(%{"_json" => list}) when is_list(list), do: {:ok, list}
  defp array_body(list) when is_list(list), do: {:ok, list}
  defp array_body(_), do: {:error, :invalid_body}

  defp object_body(body) when is_map(body) and not is_struct(body), do: {:ok, body}
  defp object_body(_), do: {:error, :invalid_body}

  # The Discord application-command object (CHAT_INPUT) — shared by the write
  # echo AND the #133 GET, so a client's fetch sees the exact shape its own
  # PUT/POST echoed.
  #
  # DIVERGENCES — Discord fields that safe-sync diffs read (py-cord's
  # `get_desynced_commands` field compare; the Hermes adapter's fetch →
  # diff → PUT policy) with NO stored counterpart. Registration keeps only
  # name/description/options (`Cytale.Interactions.parse_command/1`), so none
  # of these are invented — the response stays byte-faithful to storage:
  #   * `default_member_permissions`, `nsfw`, `name_localizations`,
  #     `description_localizations`, `contexts`, `integration_types` — absent.
  #     The diffs treat absent as the falsy default, so default payloads (no
  #     permission override, no localizations, no install scopes) diff CLEAN
  #     and safe sync converges; a bot that PUTs a NON-default value sees it
  #     dropped here and re-PUTs every sync — idempotent, since PUT is a full
  #     overwrite. Unimplemented fields would silently LIE about the authz
  #     model (Cytale gates by workspace membership, not Discord permission
  #     bits), which is why they are omitted rather than defaulted.
  #   * `type` is always 1 — faithful, not invented: registration stores
  #     CHAT_INPUT only (the validator has no type field; a context-menu
  #     payload has no `description` and 400s as invalid).
  #   * `version` is fixed "1" — Discord's per-edit monotonic version has no
  #     stored counterpart; no library sync-diff reads it, and the fixed value
  #     keeps responses byte-stable across reads.
  defp command_json(command) do
    %{
      "id" => Integer.to_string(command.command_id),
      "type" => 1,
      "application_id" => Integer.to_string(command.application_id),
      "guild_id" => Integer.to_string(command.workspace_id),
      "name" => command.name,
      "description" => command.description,
      "version" => "1"
    }
    |> maybe_options(command.options)
  end

  defp maybe_options(json, options) when options in [nil, %{}, []], do: json
  defp maybe_options(json, options), do: Map.put(json, "options", options)
end
