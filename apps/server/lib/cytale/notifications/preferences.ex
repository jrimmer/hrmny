defmodule Cytale.Notifications.Preferences do
  @moduledoc """
  The notification preference hierarchy (plan U2, R5/R6/R7).

  A member's effective notification level is resolved from up to three stored
  layers, most specific first: channel → workspace → account. **An absent row
  means inherit**, so a member who never configured anything has written
  nothing — which is what makes "what did this member actually choose"
  answerable without reconstructing a cascade, and it is the property Discord
  lacks. See `Cytale.Notifications.Resolver` for the walk; this module is only
  storage.

  ## Why one table

  All three layers live in one user-partitioned table so the per-message
  decision costs one partition read rather than a lookup per layer. The
  clustering key is `(scope, entity_id)` rather than `entity_id` alone:
  workspace and channel ids are separate Snowflake namespaces that a caller
  could hand over mixed up, and clustering on the pair keeps them from
  colliding onto one row.

  ## Levels

  `"all"` | `"mentions"` | `"mute"`, plus absent meaning inherit. The closed
  set lives here rather than in the schema, so adding a level is a code change
  and not a migration. The vocabulary deliberately describes what it overrides
  (`"all"` = all activity, not "the channel default") so an override reads
  correctly on its own, without the cascade in view.

  ## The broadcast switch (a row type, not a level)

  "Mentions only" INCLUDES `@everyone`/`@here` by default (owner direction,
  2026-09-27). A member may opt a whole workspace out of broadcasts with
  "Suppress @everyone and @here": a `:broadcasts` row (scope code 4) keyed by
  the workspace id, whose `level` column holds the literal `"suppress"`.
  Absent means broadcasts count; there is no stored "off" — clearing is a
  DELETE, the same absent-means-default rule as every level.

  It lives in THIS table rather than a new one on purpose: the fan-out path
  already reads the member's whole partition once per decision
  (`all/1`), so the switch rides that read for free instead of adding a
  second per-recipient round trip. The resolver never looks at it — the walk
  only asks for the thread/channel/workspace/account keys by name — so the
  row cannot masquerade as a level.
  """

  alias Cytale.Repo

  @levels ~w(all mentions mute)
  @scopes %{account: 0, workspace: 1, channel: 2, thread: 3, broadcasts: 4}
  @broadcasts_code 4
  @suppress "suppress"
  @account_entity 0

  @typedoc """
  The layer a level is stored at.

  `:thread` is a layer rather than a widening of the thread membership row's
  `notify` flag: that flag means *follow* (it is what the Home badge tiers
  read), while a level means *how loudly*. A thread with no level row inherits
  its channel, which is the behavior R7 asks for.
  """
  @type scope :: :account | :workspace | :channel | :thread | :broadcasts
  @type level :: String.t()

  @doc "The levels a caller may set, for surfaces that render the ladder."
  @spec levels() :: [level()]
  def levels, do: @levels

  @doc """
  Store one layer's level. Creating or replacing is the same write, so a
  repeated set is idempotent.
  """
  @spec set_level(integer(), scope(), integer(), level()) ::
          :ok | {:error, :invalid_level | :invalid_scope}
  def set_level(user_id, scope, entity_id, level)
      when is_integer(user_id) and is_integer(entity_id) do
    # The broadcast switch is not a level: `set_suppress_broadcasts/3` owns
    # that row, so a level can never be written into it by a scope mix-up.
    with {:ok, scope_int} <- level_scope_code(scope),
         :ok <- validate_level(level) do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.notification_preferences (user_id, scope, entity_id, level, updated_at) VALUES (?, ?, ?, ?, ?)",
        [
          {"bigint", user_id},
          {"int", scope_int},
          {"bigint", entity_id},
          {"text", level},
          {"timestamp", now}
        ]
      )

      :ok
    end
  end

  @doc "The level stored for one layer, or `nil` when the member set none."
  @spec get(integer(), scope(), integer()) :: level() | nil
  def get(user_id, scope, entity_id)
      when is_integer(user_id) and is_integer(entity_id) do
    case scope_code(scope) do
      {:ok, scope_int} ->
        Repo.execute!(
          "SELECT level FROM {{K}}.notification_preferences WHERE user_id = ? AND scope = ? AND entity_id = ?",
          [{"bigint", user_id}, {"int", scope_int}, {"bigint", entity_id}]
        )
        |> Enum.to_list()
        |> case do
          [%{"level" => level}] -> level
          [] -> nil
        end

      _ ->
        nil
    end
  end

  @doc """
  Every override the member holds, keyed by `%{scope: _, entity_id: _}`.

  One partition read, which is why the caller can afford this per decision.
  """
  @spec all(integer()) :: %{map() => level()}
  def all(user_id) when is_integer(user_id) do
    Repo.execute!(
      "SELECT scope, entity_id, level FROM {{K}}.notification_preferences WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.reduce(%{}, fn row, acc ->
      Map.put(acc, %{scope: scope_atom(row["scope"]), entity_id: row["entity_id"]}, row["level"])
    end)
  end

  @doc "Remove one layer's override, returning that entity to inherit."
  @spec clear(integer(), scope(), integer()) :: :ok | {:error, :invalid_scope}
  def clear(user_id, scope, entity_id)
      when is_integer(user_id) and is_integer(entity_id) do
    case scope_code(scope) do
      {:ok, scope_int} ->
        Repo.execute!(
          "DELETE FROM {{K}}.notification_preferences WHERE user_id = ? AND scope = ? AND entity_id = ?",
          [{"bigint", user_id}, {"int", scope_int}, {"bigint", entity_id}]
        )

        :ok

      error ->
        error
    end
  end

  @doc """
  Remove every override for one member. The subscription-lifecycle hook:
  revoking all sessions and deleting an account must not leave a removed
  member's preferences behind (R19).
  """
  @spec clear_all(integer()) :: :ok
  def clear_all(user_id) when is_integer(user_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.notification_preferences WHERE user_id = ?",
      [{"bigint", user_id}]
    )

    :ok
  end

  @doc """
  Turn the workspace's broadcast suppression on or off for one member.

  On writes the `:broadcasts` row; off DELETEs it (absent = broadcasts count),
  so a member who never touched the switch and one who turned it back off
  hold the same nothing.
  """
  @spec set_suppress_broadcasts(integer(), integer(), boolean()) :: :ok
  def set_suppress_broadcasts(user_id, workspace_id, true)
      when is_integer(user_id) and is_integer(workspace_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.notification_preferences (user_id, scope, entity_id, level, updated_at) VALUES (?, ?, ?, ?, ?)",
      [
        {"bigint", user_id},
        {"int", @broadcasts_code},
        {"bigint", workspace_id},
        {"text", @suppress},
        {"timestamp", now}
      ]
    )

    :ok
  end

  def set_suppress_broadcasts(user_id, workspace_id, false)
      when is_integer(user_id) and is_integer(workspace_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.notification_preferences WHERE user_id = ? AND scope = ? AND entity_id = ?",
      [{"bigint", user_id}, {"int", @broadcasts_code}, {"bigint", workspace_id}]
    )

    :ok
  end

  @doc """
  Whether an already-loaded preference map (`all/1`) suppresses broadcasts in
  this workspace. Pure, so the per-recipient policy stays storage-free.
  """
  @spec suppresses_broadcasts?(%{map() => level()}, integer() | nil) :: boolean()
  def suppresses_broadcasts?(_preferences, nil), do: false

  def suppresses_broadcasts?(preferences, workspace_id) when is_map(preferences) do
    Map.has_key?(preferences, %{scope: :broadcasts, entity_id: workspace_id})
  end

  @doc "The workspace ids whose broadcasts the member suppresses, from a loaded map."
  @spec broadcast_suppressions(%{map() => level()}) :: [integer()]
  def broadcast_suppressions(preferences) when is_map(preferences) do
    for {%{scope: :broadcasts, entity_id: workspace_id}, _value} <- preferences,
        do: workspace_id
  end

  @doc """
  Of `user_ids`, the ones who suppress broadcasts in `workspace_id`.

  The inbox's broadcast leg asks this for a whole audience at once: ONE
  multi-partition read per chunk (`user_id IN ?` with the clustering key
  pinned) rather than a partition read per member, which is what keeps an
  `@everyone` in a large workspace from turning into N round trips.
  """
  @spec suppressing_broadcasts([integer()], integer()) :: MapSet.t(integer())
  def suppressing_broadcasts([], _workspace_id), do: MapSet.new()

  def suppressing_broadcasts(user_ids, workspace_id)
      when is_list(user_ids) and is_integer(workspace_id) do
    user_ids
    |> Enum.chunk_every(100)
    |> Enum.flat_map(fn chunk ->
      Repo.execute!(
        "SELECT user_id FROM {{K}}.notification_preferences WHERE user_id IN ? AND scope = ? AND entity_id = ?",
        [{"list<bigint>", chunk}, {"int", @broadcasts_code}, {"bigint", workspace_id}]
      )
      |> Enum.map(& &1["user_id"])
    end)
    |> MapSet.new()
  end

  @doc "The entity id the account layer uses. A singleton by convention."
  @spec account_entity() :: integer()
  def account_entity, do: @account_entity

  # -- internals -----------------------------------------------------------------

  defp validate_level(level) when level in @levels, do: :ok
  defp validate_level(_other), do: {:error, :invalid_level}

  defp level_scope_code(:broadcasts), do: {:error, :invalid_scope}
  defp level_scope_code(scope), do: scope_code(scope)

  defp scope_code(scope) do
    case Map.fetch(@scopes, scope) do
      {:ok, code} -> {:ok, code}
      :error -> {:error, :invalid_scope}
    end
  end

  # An unrecognised persisted code reads as the account layer rather than
  # crashing a decision: a row written by a newer deploy that this node does
  # not understand must not take the notification path down.
  defp scope_atom(0), do: :account
  defp scope_atom(1), do: :workspace
  defp scope_atom(2), do: :channel
  defp scope_atom(3), do: :thread
  defp scope_atom(4), do: :broadcasts
  defp scope_atom(_other), do: :account
end
