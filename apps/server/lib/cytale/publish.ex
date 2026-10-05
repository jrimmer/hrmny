defmodule Cytale.Publish do
  @moduledoc """
  Fan-out seam (U9): REST writes publish realtime events through this
  behaviour; the workspace-process implementation (U11) fans out to gateway
  subscribers. Until U11 lands, `Cytale.Publish.Log` is the configured
  implementation — it logs the event at :info (visible in tests via
  `capture_log`) and always succeeds, so REST writes are complete without
  the realtime tier.

  U11 swaps the configured impl for the workspace-process registry version
  WITHOUT touching call sites — that is the seam's whole point.
  """

  @typedoc "A dispatch-shaped publish: protocol event name + payload."
  @type event :: {String.t(), map()}

  @callback publish(channel_id :: integer(), event()) :: :ok

  # User-scoped dispatches (UserUpdate): the audience is every workspace
  # the user belongs to plus every DM channel they participate in — there
  # is no single channel to key on, hence the second arity on the seam.
  @callback publish_user_update(user_id :: integer(), event()) :: :ok

  @doc "Configured implementation module (default: the pre-U11 logger)."
  @spec impl() :: module()
  def impl do
    Application.get_env(:cytale, __MODULE__, Cytale.Publish.Log)
  end

  @doc "Publish a realtime event for a channel (fire-and-forget from REST's view)."
  @spec publish(integer(), event()) :: :ok
  def publish(channel_id, {event_name, _} = event) when is_integer(channel_id) and is_binary(event_name) do
    impl().publish(channel_id, event)
  end

  @doc """
  `publish/2` with what the caller already knows (review #18):

    * `:route` — `{:channel, workspace_id}` or `{:dm, dm_row}`, as the
      permission gate resolved it (`conn.assigns.channel_route`). The fan-out
      then skips the channel→workspace lookup and, for a DM, the
      `dm_channels` read — a DM send used to read that row ~7 times.
    * `:accepted_at` — the monotonic ms the REST layer ACCEPTED the write;
      the socket emits `[:cytale, :message, :deliver_ms]` against it at the
      wire push (review #20's accept→deliver measurement).

  Implementations without a `publish/3` fall back to `publish/2`.
  """
  @spec publish(integer(), event(), keyword()) :: :ok
  def publish(channel_id, {event_name, _} = event, opts)
      when is_integer(channel_id) and is_binary(event_name) and is_list(opts) do
    impl = impl()

    if function_exported?(impl, :publish, 3),
      do: impl.publish(channel_id, event, opts),
      else: impl.publish(channel_id, event)
  end

  @doc """
  Publish a user-profile event (UserUpdate) to every workspace and DM the
  user touches. Fire-and-forget from REST's view, same as `publish/2`.
  """
  @spec publish_user_update(integer(), event()) :: :ok
  def publish_user_update(user_id, {event_name, _} = event)
      when is_integer(user_id) and is_binary(event_name) do
    impl().publish_user_update(user_id, event)
  end
end

defmodule Cytale.Publish.Log do
  @moduledoc """
  Pre-U11 implementation: logs the published event. Kept as the :test
  default so DB-backed suites stay hermetic (no workspace processes spin up
  during auth/controller tests); the workspace-process implementation is
  exercised in its own unit tests plus the publish-seam test.
  """

  @behaviour Cytale.Publish

  require Logger

  @impl true
  def publish(channel_id, {event_name, payload}) do
    Logger.info("[publish] channel=#{channel_id} event=#{event_name} payload=#{inspect(payload)}")
    :ok
  end

  @impl true
  def publish_user_update(user_id, {event_name, payload}) do
    Logger.info("[publish:user] user=#{user_id} event=#{event_name} payload=#{inspect(payload)}")
    :ok
  end
end

defmodule Cytale.Publish.WorkspaceProcess do
  @moduledoc """
  The U11 fan-out implementation: routes a publish through the channel's
  workspace process (`Cytale.Workspaces.Supervisor` lazy-starts it), which
  stamps connected sessions' resume buffers and pushes to live PIDs.

  Channel → workspace resolution is one partition-keyed point query on
  `channels_by_id` (U9 schema); an unknown channel publishes nowhere (the
  REST layer 404s first — this is a last-line no-op).
  """

  @behaviour Cytale.Publish

  require Logger

  @impl true
  def publish(channel_id, event) when is_integer(channel_id), do: publish(channel_id, event, [])

  @doc "`Cytale.Publish.publish/3`: a pre-resolved `:route` skips the lookups."
  def publish(channel_id, event, opts) when is_integer(channel_id) do
    fan_opts = Keyword.take(opts, [:accepted_at])

    case Keyword.get(opts, :route) do
      {:channel, workspace_id} when is_integer(workspace_id) ->
        Cytale.Workspaces.Workspace.fan_out(workspace_id, event, fan_opts)

      {:dm, %{user_ids: _} = dm} ->
        Cytale.Workspaces.FanOut.deliver(channel_id, event, [resolved: {:dm, dm}] ++ fan_opts)
        :ok

      _unresolved ->
        publish_resolving(channel_id, event, fan_opts)
    end
  end

  defp publish_resolving(channel_id, event, fan_opts) do
    case cached_workspace_id_for(channel_id) do
      {:ok, workspace_id} ->
        Cytale.Workspaces.Workspace.fan_out(workspace_id, event, fan_opts)

      :error ->
        # DM channels have no workspace row — the shared DM-aware delivery
        # addresses both participants' user-key sessions directly (B-1). An
        # unknown channel (no DM row either) still drops with the log.
        case Cytale.Workspaces.get_dm(channel_id) do
          nil ->
            Logger.warning("[publish] unknown channel #{channel_id}; event dropped")
            :ok

          dm ->
            # The row is in hand: say so, rather than making the fan-out read the
            # same partition again (hardening plan 5.2).
            Cytale.Workspaces.FanOut.deliver(channel_id, event, [resolved: {:dm, dm}] ++ fan_opts)
            :ok
        end
    end
  end

  # The steady-state route: the cache first (hardening plan 5.1), the query only
  # on a miss. A channel's workspace is immutable, so a hit can never be stale
  # while the cache owner lives — see `Cytale.Publish.ChannelRoutes`.
  defp cached_workspace_id_for(channel_id) do
    case Cytale.Publish.ChannelRoutes.fetch(channel_id) do
      {:ok, workspace_id} ->
        {:ok, workspace_id}

      :error ->
        case workspace_id_for(channel_id) do
          {:ok, workspace_id} = ok ->
            :ok = Cytale.Publish.ChannelRoutes.put(channel_id, workspace_id)
            ok

          :error ->
            :error
        end
    end
  end

  # One point query on the channel-id lookup row (partition-keyed, no scan).
  # Prepared (hardening 1.8): this was the per-publish read, so it was paying a
  # coordinator parse per event; it now runs once per channel (plan 5.1).
  defp workspace_id_for(channel_id) do
    rows =
      Cytale.Repo.query!(
        "SELECT workspace_id FROM {{K}}.channels_by_id WHERE channel_id = ?"
        |> String.replace("{{K}}", Cytale.Repo.keyspace()),
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [%{"workspace_id" => ws_id}] -> {:ok, ws_id}
      _ -> :error
    end
  end

  @impl true
  def publish_user_update(user_id, {_event_name, _} = event) do
    # Workspace legs: sessions subscribe under the STRING-id workspace key
    # (the workspace process's channel-less {:workspace, :all} route
    # matches nobody), so deliver directly — ids only, no per-workspace
    # point reads on a profile write.
    #
    # The read legs degrade gracefully (mirror of Workspace.fan_out's own
    # posture): the profile write is already committed by the time this
    # runs, so a mid-fan-out Scylla failure must surface as a warning and
    # a skipped realtime converge — not a 500 on a committed write.
    workspaces =
      try do
        Cytale.Workspaces.workspace_ids_of_user(user_id)
      rescue
        e ->
          Logger.warning("publish_user_update: workspace read failed for #{user_id}: #{inspect(e)}")
          []
      end

    # DM legs: the dms_of_user rows already carry each channel's
    # participants — deliver each DISTINCT user key once (no per-DM
    # re-resolution, no duplicate self pushes).
    user_ids =
      try do
        user_id
        |> Cytale.Workspaces.dms_of_user()
        |> Enum.flat_map(&(&1.user_ids || []))
        |> Enum.uniq()
      rescue
        e ->
          Logger.warning("publish_user_update: dm read failed for #{user_id}: #{inspect(e)}")
          []
      end

    # PERF-07: ONE encode for the whole publish. The audience spans as many
    # routes as the user has workspaces plus every distinct DM participant's
    # user key, and each route used to decide its own pre-encode — shared only
    # within a route with >1 recipients, so a 3-workspace member paid up to 3
    # encodes of the same bytes. The fragment rides the opts through
    # `FanOut.deliver_workspace/3` / `deliver_user_keys/3` and every route
    # reuses it. No route at all (both reads came up empty) encodes nothing —
    # the walk would feed zero sockets.
    fragment =
      if workspaces == [] and user_ids == [],
        do: nil,
        else: Cytale.Gateway.PreEncoded.encode(elem(event, 1))

    for ws_id <- workspaces do
      Cytale.Workspaces.FanOut.deliver_workspace(ws_id, event, fragment: fragment)
    end

    Cytale.Workspaces.FanOut.deliver_user_keys(user_ids, event, fragment: fragment)

    :ok
  end
end
