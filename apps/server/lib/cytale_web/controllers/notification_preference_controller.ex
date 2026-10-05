defmodule CytaleWeb.NotificationPreferenceController do
  @moduledoc """
  The member-facing notification preference surface (plan U2, R5/R6/R22).

  Four layers, one shape: the account default, a workspace, a channel (a
  workspace channel OR a direct message), or a thread. A stored row is an
  OVERRIDE — an entity the member never touched has no row,
  which is what "inherit" means and what lets the settings surface say what the
  member actually chose rather than what the resolved value happens to be.

  ## Why this validates scope

  A preference is a claim about a workspace or channel the member belongs to,
  and the notification decision reads these rows. An unvalidated write would
  let a member accumulate rows pointing at other workspaces, so every write
  resolves the target through membership before storing. A target the member
  cannot reach is refused rather than stored — the same anti-enumeration
  posture the channel routes use, since a created-then-refused pair would leak
  which ids exist.

  ## The broadcast switch

  "Suppress @everyone and @here" is a per-workspace boolean, not a level. It
  rides the workspace layer's PUT as `suppress_broadcasts` (alone or next to a
  `level`) and comes back from the GET as its own list,
  `suppress_broadcasts: [workspace_id]`, rather than inside `preferences`:
  every shipped client builds its override map from that list, and a row whose
  "level" is not a level would be a lie there.
  """

  use CytaleWeb, :controller

  alias Cytale.Notifications.Preferences
  alias Cytale.Workspaces
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "GET /users/@me/notification-preferences — every override the member holds."
  def index(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    all = Preferences.all(user_id)

    preferences =
      for {%{scope: scope, entity_id: entity_id}, level} <- all, scope != :broadcasts do
        %{
          "scope" => Atom.to_string(scope),
          "entity_id" => Integer.to_string(entity_id),
          "level" => level
        }
      end

    suppress =
      all
      |> Preferences.broadcast_suppressions()
      |> Enum.sort()
      |> Enum.map(&Integer.to_string/1)

    json(conn, %{"preferences" => preferences, "suppress_broadcasts" => suppress})
  end

  @doc """
  PUT /users/@me/notification-preferences — set one layer.

  `entity_id` is required for the workspace, channel and thread layers and
  ignored for the account layer, which has exactly one setting.

  The workspace layer also takes `suppress_broadcasts` (boolean), with or
  without a `level`: the switch and the level are independent, so a client can
  flip one without restating the other. Both are validated BEFORE either is
  written, so a bad level never leaves a half-applied switch behind.
  """
  def upsert(conn, params) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, scope} <- parse_scope(params["scope"]),
         {:ok, entity_id} <- resolve_entity(scope, params["entity_id"]),
         {:ok, suppress} <- parse_suppress(scope, params),
         :ok <- require_something(params["level"], suppress),
         :ok <- validate_level(params["level"]),
         :ok <- authorize_scope(scope, entity_id, conn.assigns.current_user),
         :ok <- maybe_set_level(user_id, scope, entity_id, params["level"]),
         :ok <- maybe_set_suppress(user_id, entity_id, suppress) do
      body =
        %{"scope" => Atom.to_string(scope), "entity_id" => Integer.to_string(entity_id)}
        |> maybe_put("level", params["level"])
        |> maybe_put("suppress_broadcasts", suppress)

      json(conn, body)
    else
      {:error, :invalid_scope} ->
        error(conn, 400, "validation_failed", "scope must be account, workspace, channel, or thread")

      {:error, :invalid_suppress} ->
        error(conn, 400, "validation_failed", "suppress_broadcasts must be a boolean, on the workspace scope")

      {:error, :invalid_entity} ->
        error(conn, 400, "validation_failed", "entity_id must be a snowflake id")

      {:error, :missing_entity} ->
        error(conn, 400, "validation_failed", "entity_id is required for this scope")

      {:error, :invalid_level} ->
        error(conn, 400, "validation_failed", "level must be all, mentions, or mute")

      {:error, :forbidden} ->
        error(conn, 404, "not_found", "No such workspace or channel")

      {:error, _other} ->
        error(conn, 400, "validation_failed", "could not store that preference")
    end
  end

  @doc "DELETE /users/@me/notification-preferences/:scope/:entity_id — return the entity to inherit."
  def clear(conn, %{"scope" => scope_param, "entity_id" => entity_param}) do
    %{user_id: user_id} = conn.assigns.current_user

    with {:ok, scope} <- parse_scope(scope_param),
         {:ok, entity_id} <- parse_entity(entity_param),
         :ok <- Preferences.clear(user_id, scope, entity_id) do
      json(conn, %{"cleared" => true, "scope" => scope_param, "entity_id" => entity_param})
    else
      {:error, :invalid_scope} ->
        error(conn, 400, "validation_failed", "scope must be account, workspace, channel, or thread")

      {:error, :invalid_entity} ->
        error(conn, 400, "validation_failed", "entity_id must be a snowflake id")

      _ ->
        error(conn, 400, "validation_failed", "could not clear that preference")
    end
  end

  # -- internals -----------------------------------------------------------------

  defp parse_scope("account"), do: {:ok, :account}
  defp parse_scope("workspace"), do: {:ok, :workspace}
  defp parse_scope("channel"), do: {:ok, :channel}
  defp parse_scope("thread"), do: {:ok, :thread}
  defp parse_scope(_other), do: {:error, :invalid_scope}

  # Absent = "not touching the switch" (nil); only the workspace layer has one.
  defp parse_suppress(_scope, %{"suppress_broadcasts" => nil}), do: {:ok, nil}

  defp parse_suppress(:workspace, %{"suppress_broadcasts" => value}) when is_boolean(value),
    do: {:ok, value}

  defp parse_suppress(_scope, %{"suppress_broadcasts" => _value}), do: {:error, :invalid_suppress}
  defp parse_suppress(_scope, _params), do: {:ok, nil}

  # A PUT that names neither a level nor the switch is a malformed level write
  # (the pre-switch contract), not a silent no-op.
  defp require_something(nil, nil), do: {:error, :invalid_level}
  defp require_something(_level, _suppress), do: :ok

  # Validated up front (not only inside `set_level/4`) so a bad level refuses
  # the whole PUT before the switch half is written.
  defp validate_level(nil), do: :ok

  defp validate_level(level) when is_binary(level) do
    if level in Preferences.levels(), do: :ok, else: {:error, :invalid_level}
  end

  defp validate_level(_level), do: {:error, :invalid_level}

  defp maybe_set_level(_user_id, _scope, _entity_id, nil), do: :ok

  defp maybe_set_level(user_id, scope, entity_id, level),
    do: Preferences.set_level(user_id, scope, entity_id, level)

  defp maybe_set_suppress(_user_id, _workspace_id, nil), do: :ok

  defp maybe_set_suppress(user_id, workspace_id, value),
    do: Preferences.set_suppress_broadcasts(user_id, workspace_id, value)

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  # The account layer is a singleton: the caller is not naming a target, so an
  # absent entity_id is correct rather than malformed.
  defp resolve_entity(:account, _value), do: {:ok, Preferences.account_entity()}

  defp resolve_entity(_scope, nil), do: {:error, :missing_entity}

  defp resolve_entity(_scope, value) when is_binary(value), do: parse_entity(value)

  defp resolve_entity(_scope, value) when is_integer(value) and value > 0, do: {:ok, value}
  defp resolve_entity(_scope, _value), do: {:error, :invalid_entity}

  defp parse_entity(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> {:error, :invalid_entity}
    end
  end

  defp parse_entity(_value), do: {:error, :invalid_entity}

  defp authorize_scope(:account, _entity_id, _claims), do: :ok

  defp authorize_scope(:workspace, workspace_id, claims) do
    if Workspaces.get_member(workspace_id, claims.user_id), do: :ok, else: {:error, :forbidden}
  end

  # A channel is a workspace channel (membership decides) or a direct message
  # (participation decides — B-1's rule: participation IS authorization). A DM
  # level is how a member quiets one conversation, and it inherits the ACCOUNT
  # layer because a DM has no workspace above it.
  defp authorize_scope(:channel, channel_id, claims) do
    case Workspaces.get_channel(channel_id) do
      # VIEW, not bare membership: a member who cannot see a private channel
      # must not be able to probe or configure it (the same resolver the REST
      # channel gate uses).
      %{workspace_id: workspace_id} ->
        case Cytale.Permissions.Principal.resolve(workspace_id, claims, channel_id) do
          {:ok, bits} ->
            if Cytale.Permissions.Bitfield.has?(bits, :view_channel), do: :ok, else: {:error, :forbidden}

          _ ->
            {:error, :forbidden}
        end

      nil ->
        if Workspaces.dm_participant?(Workspaces.get_dm(channel_id), claims.user_id),
          do: :ok,
          else: {:error, :forbidden}
    end
  end

  # A thread is authorized through the channel it lives in — the same
  # question, one hop up.
  defp authorize_scope(:thread, thread_id, claims) do
    case Cytale.Threads.Thread.get(thread_id) do
      %{channel_id: channel_id} -> authorize_scope(:channel, channel_id, claims)
      nil -> {:error, :forbidden}
    end
  end
end
