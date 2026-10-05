defmodule Cytale.Workspaces.Workspace do
  @moduledoc """
  The per-workspace GenServer (U11) — the blast radius and the fan-out hub.

  One process per workspace (R1): registered via `Cytale.Workspaces.Registry`
  under its integer `workspace_id`, started lazily on first connection or
  first publish through `Cytale.Workspaces.Supervisor`. A workspace's load or
  crash cannot affect any other workspace (AE1): `one_for_one` restarts it, and
  because it holds no process-local state the new process serves fan-out
  immediately.

  State: just `workspace_id`. The process holds no session, channel, permission
  or presence cache (hardening plan 7.10 deleted that unused surface): fan-out
  addresses live sockets through `Cytale.Gateway.PushRegistry`, and the durable
  channel list is read from ScyllaDB by `Cytale.Workspaces.list_channels/1` at
  the call sites that actually need it. A restart therefore rebuilds nothing —
  there is nothing process-local left to rebuild.

  Fan-out: publishes arriving through `Cytale.Publish.WorkspaceProcess` are
  stamped into each connected session's resume buffer via the gateway's own
  `{:cytale_gateway_push, ...}` path (so resume replays fan-out events) and
  delivered best-effort per-PID. Ordering is per-channel monotonic via the
  Snowflake message_id already embedded in the payload.

  Telemetry (U28 asserts on these names):

    * `[:cytale, :fanout, :latency]` — publish→dispatch latency histogram (ms)
    * `[:cytale, :fanout, :delivered]` — count of live-PID deliveries
    * `[:cytale, :fanout, :persisted]` — count of persisted (buffered) events
  """

  use GenServer

  alias Cytale.Gateway.PreEncoded
  alias Cytale.Gateway.Payloads
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces.Registry
  alias Cytale.Workspaces.Supervisor

  require Logger

  defstruct workspace_id: nil

  # -- Client API ---------------------------------------------------------------

  @doc "Start registered under `workspace_id` (via DynamicSupervisor)."
  @spec start_link(integer()) :: GenServer.on_start()
  def start_link(workspace_id) when is_integer(workspace_id) do
    GenServer.start_link(__MODULE__, workspace_id, name: Registry.name(workspace_id))
  end

  @doc "Child spec for the DynamicSupervisor (workspace_id as the arg)."
  def child_spec(workspace_id) when is_integer(workspace_id) do
    %{
      id: {__MODULE__, workspace_id},
      start: {__MODULE__, :start_link, [workspace_id]},
      restart: :transient,
      type: :worker
    }
  end

  @doc """
  Fan an event out to every connected session of the workspace. Ensures the
  process is running first (lazy start on first publish). Fire-and-forget
  from the caller's perspective (REST write path) — always `:ok`.
  """
  @spec fan_out(integer(), {String.t(), map()}, keyword()) :: :ok
  def fan_out(workspace_id, {event_name, _payload} = event, opts \\ [])
      when is_integer(workspace_id) and is_binary(event_name) do
    case Supervisor.ensure_started(workspace_id) do
      {:ok, pid} ->
        # `:accepted_at` (review #20): the monotonic ms the REST layer accepted
        # the write — carried to the socket push so the accept→deliver time is
        # measured where the bytes leave, not where the cast was made.
        GenServer.cast(
          pid,
          {:fan_out, event, System.monotonic_time(:millisecond), Keyword.get(opts, :accepted_at)}
        )

      {:error, reason} ->
        Logger.warning("fan_out: workspace #{workspace_id} could not start: #{inspect(reason)}")
        :ok
    end

    :ok
  end

  # -- Server callbacks -----------------------------------------------------------

  @impl true
  def init(workspace_id) do
    # Nothing to warm: fan-out reads live routes from `PushRegistry`, and the
    # durable channel list is read from ScyllaDB where it is needed. The
    # process owns no cache, so no janitor and no epoch subscription (7.10).
    {:ok, %__MODULE__{workspace_id: workspace_id}}
  end

  @impl true
  def handle_cast({:fan_out, event, started_at}, state),
    do: handle_cast({:fan_out, event, started_at, nil}, state)

  def handle_cast({:fan_out, {event_name, payload} = _event, started_at, accepted_at}, state) do
    t0 = started_at || System.monotonic_time(:millisecond)

    # Payload channel scoping: MESSAGE_CREATE etc. carry a channel_id; deliver
    # to sessions subscribed to that channel via PushRegistry (gateway's own
    # live-push + resume-buffer path — resume replays fan-out events).
    channel_id = payload_channel_id(payload)
    route = route_for(channel_id)

    live = PushRegistry.subscribers(route)

    # Voice plan U4 (KTD6/AM9 — security-critical): CALL_* events are
    # visibility-filtered at fan-out — call existence and rosters are
    # presence-like data for hidden channels, and a subscribed-but-blind
    # session must receive NOTHING. Every recipient is re-checked live
    # through the resolver (the same VIEW_CHANNEL computation the REST gate
    # and the gateway's typing consult run); message-event parity stays
    # unfiltered (a separately-tracked pre-existing issue, per AM9). Call
    # control-plane traffic is low-rate (KTD3), so a per-recipient resolve
    # per CALL_* event is the budgeted cost. Bots fail the resolve
    # claim-less and drop — the compat wire stays voice-free by design.
    live =
      if call_event?(event_name) do
        Enum.filter(live, fn {_pid, user_id} -> call_recipient_visible?(state.workspace_id, channel_id, user_id) end)
      else
        live
      end

    delivered = length(live)

    # #110: a channel-scoped event whose payload names no channel resolves to
    # the workspace-wide route — and `fanout_route_keys/2` subscribes NO session
    # to `{:workspace, :all}`, so the event is published, acked `:ok`, and
    # delivered to nobody. The only witness was the `:delivered` telemetry
    # below, which nothing asserts a floor on; #109's `ThreadUpdate` lived here
    # undetected precisely because silence leaves no other trace.
    #
    # The discriminator is the event CLASS, not the missing key: `PresenceUpdate`,
    # `MemberAdd`/`MemberRemove` and the user-addressed events are SUPPOSED to
    # carry no channel — they ride the workspace key or the user's own keys — so
    # warning on them would be noise, and noise is how a real warning gets
    # ignored. `Payloads.channel_less_events/0` is that list.
    if is_nil(channel_id) and Payloads.channel_scoped?(event_name) do
      Logger.warning(
        "fan_out: channel-scoped #{event_name} payload carries no channel_id " <>
          "(payload id: #{inspect(payload_id(payload))}); it resolved to the " <>
          "workspace-wide route, which no session subscribes to — delivered to " <>
          "#{delivered} sessions"
      )
    end

    # ONE JSON encode for the whole fan-out (hardening plan 2.3): the payload is
    # identical for every recipient and each socket would otherwise encode it
    # again for its own seq-stamped envelope. `nil` for a single recipient (no
    # saving) and for the compat path, which translates before it encodes.
    fragment = PreEncoded.for_fanout(length(live), payload)

    push =
      case accepted_at do
        nil -> {:cytale_gateway_push, self(), {event_name, payload}, fragment}
        at -> {:cytale_gateway_push, self(), {event_name, payload}, fragment, %{accepted_at: at}}
      end

    for {pid, _user_id} <- live do
      send(pid, push)
    end

    # The OFFLINE half of this route (hardening plan 4.2): a member whose
    # session dropped inside its resume window is not in `live` (its socket is
    # gone), and the event goes into that session's record as a buffered
    # dispatch instead of nowhere — so the resume replays it. Sits with DELIVERY
    # (above the best-effort notification/index tail below), because it is part
    # of delivery, not a consequence of it. CALL_* traffic is excluded inside
    # `FanOut.buffer_offline/3` (`Payloads.offline_superseded_events/0`), which
    # is what keeps the AM9 per-recipient visibility filter unbypassable.
    Cytale.Workspaces.FanOut.buffer_offline(route, {event_name, payload})

    # Notifications plan U4: the message has reached every subscribed session;
    # now decide who should be TOLD. Non-raising — a delivery problem must
    # never cost a member the message.
    #
    # U13: the search index write follows (a DELETE unindexes — #76, else a
    # ghost document poisons the compat search route). Fire-and-forget — an
    # index failure never blocks chat (search degrades, per the plan).
    #
    # #142: BOTH legs are best-effort consequences of the delivery, not part
    # of it, and they run OFF the fan-out's critical path. This handler is a
    # single process per workspace: the notification resolution and the index
    # write are several DB round trips PER EVENT, and a GenServer that pays
    # them inline delays every QUEUED event behind them — under transient DB
    # latency a burst backs up for tens of seconds and a thread reply's
    # `ThreadMessageCreate` leg lands >15s behind its `MessageCreate` leg
    # (exactly the #142 live-store window; the legs are adjacent casts, so
    # the deadline can even fall BETWEEN them). Spawning the work keeps the
    # handler at ETS reads + sends, so the next cast's legs dispatch
    # immediately.
    #
    # BOUNDED, not a bare `Task.start` (review finding #11): every fan-out event
    # spawned an unsupervised, UNCAPPED process, and each one's notification leg
    # can issue ~4N queries, so a burst of M messages put M concurrent tasks
    # against a 10-connection pool with no shedding and no visibility. This is
    # the same supervisor the push leg already uses (`Delivery`), now given a
    # `max_children` ceiling, so saturation returns `{:error, :max_children}`
    # instead of growing without bound.
    #
    # Best-effort either way: the message is already delivered, the work is
    # rescue-wrapped, nothing downstream awaits it, and a dropped notification
    # leg is a missed push rather than a missed message. Saturation is logged so
    # it is observable rather than silent.
    # The SEARCH leg is NOT in that sheddable task any more (review #21): a
    # burst that hit `max_children` shed the index write with the
    # notification, and a dropped index write is a message search never
    # finds (nothing re-indexes it short of a reconcile). Both index calls are
    # casts to the workspace's IndexWriter — an ETS registry lookup and a
    # send — so they cost this handler nothing measurable and are never shed.
    cond do
      event_name == "MessageCreate" -> index_message(state.workspace_id, payload)
      # An edit re-indexes (an upsert keyed by message_id): without it search
      # kept matching — and showing — the text the author edited away.
      event_name == "MessageUpdate" -> index_message(state.workspace_id, payload)
      event_name == "MessageDelete" -> unindex_message(state.workspace_id, payload)
      true -> :ok
    end

    case Task.Supervisor.start_child(Cytale.Notifications.TaskSupervisor, fn ->
           notify(event_name, payload, live, state.workspace_id)
         end) do
      {:ok, _pid} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "fan_out: notification task not started for #{event_name} " <>
            "(#{inspect(reason)}) — best-effort leg shed at the cap"
        )

        :ok
    end

    # Telemetry (pillars stance — the app instruments itself; U28 asserts
    # against these event names).
    now = System.monotonic_time(:millisecond)
    latency = max(0, now - t0)

    :telemetry.execute([:cytale, :fanout, :latency], %{latency: latency}, %{
      workspace_id: state.workspace_id,
      event: event_name
    })

    :telemetry.execute([:cytale, :fanout, :delivered], %{count: delivered}, %{
      workspace_id: state.workspace_id,
      event: event_name
    })

    :telemetry.execute([:cytale, :fanout, :persisted], %{count: 1}, %{
      workspace_id: state.workspace_id,
      event: event_name
    })

    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # -- Internals ---------------------------------------------------------------

  # The CALL_* channel-keyed classes the U4 filter branch governs (native
  # CamelCase names; CallRing/CallSignal are user-keyed and never pass
  # through this fan-out).
  defp call_event?("CallStart"), do: true
  defp call_event?("CallUpdate"), do: true
  defp call_event?("CallEnd"), do: true
  defp call_event?(_other), do: false

  # One recipient's live VIEW_CHANNEL on the event's channel (KTD3 — the
  # same resolver mapping the REST gates use; PushRegistry entries carry
  # the session's string user id, humans and machine principals alike —
  # claim-less machine ids fail the resolve and drop, fail closed).
  defp call_recipient_visible?(workspace_id, channel_id, user_id) when is_integer(channel_id) do
    claims = %{user_id: int_or_nil(user_id)}

    with {:ok, bits} <- Cytale.Permissions.Principal.resolve(workspace_id, claims, channel_id) do
      Cytale.Permissions.Bitfield.has?(bits, :view_channel)
    else
      _ -> false
    end
  end

  # Degenerate payload (no channel anchor): nothing to check against —
  # deliver as before rather than blanket-dropping the event class.
  defp call_recipient_visible?(_workspace_id, _channel_id, _user_id), do: true

  defp int_or_nil(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp int_or_nil(int) when is_integer(int), do: int
  defp int_or_nil(_other), do: nil

  defp payload_channel_id(payload) when is_map(payload) do
    case payload[:channel_id] || payload["channel_id"] do
      id when is_integer(id) -> id
      id when is_binary(id) -> String.to_integer(id)
      _ -> nil
    end
  end

  defp payload_channel_id(_), do: nil

  # The id the warning names so the silent case is identifiable in the log.
  # Both key styles: the shared builders emit string keys, the native typing
  # builder atoms (`Payloads.typing_start/3`).
  defp payload_id(payload) when is_map(payload), do: payload[:id] || payload["id"]
  defp payload_id(_), do: nil

  # Notifications plan U4: hand the delivered event to the notification
  # dispatcher, which decides per recipient and passes the pushable verdicts
  # to the delivery seam. Best-effort like `index_message/2` below — the
  # message has already been delivered by the time this runs, and a
  # notification problem must never disturb that.
  defp notify(event_name, payload, live, workspace_id) do
    # Only classes the dispatcher has a policy for get audience work. `members`
    # is a full member read plus a per-member permission resolve for a
    # channel-anchored event, and `subscribed` a second member read; both were
    # computed EAGERLY as keyword arguments for every fan-out event — including
    # TypingStart — and then discarded by `verdicts/4`'s guard.
    if Cytale.Notifications.Dispatcher.concerned?(event_name) do
      # The wire payload carries no workspace id (a channel implies it), but a
      # notification's click target needs the whole path to route, so it rides
      # the notification rather than the message.
      payload = Map.put(payload, "workspace_id", workspace_id)

      # ONE roster read, shared by both audience computations. They each used to
      # call `member_ids/1`, and item 1.2 made that read UNCAPPED — so the pair
      # became two full `workspace_members` partition walks per concerned event.
      # (The per-member visibility resolve below is the remaining cost, and the
      # comment on `notifiable_members/3` records the cache that would remove
      # it.)
      ids = member_ids(workspace_id)
      audience = notifiable_members(workspace_id, int_or_nil(payload["channel_id"]), ids)

      Cytale.Notifications.Dispatcher.dispatch(event_name, payload, live,
        workspace_id: workspace_id,
        members: audience,
        # VISIBILITY-FILTERED, and that matters now that `ids` is UNCAPPED.
        # `verdicts/4` merges `subscribed` into the audience unconditionally, so
        # passing the raw roster here pushed a private channel's message content
        # to every workspace member holding a push subscription. The pre-1.2 cap
        # limited that to 50 rows; removing the cap removed the limit without
        # removing the leak. Passing the already-filtered audience closes it.
        subscribed: subscribed_members(audience)
      )
    end

    :ok
  rescue
    e ->
      Logger.warning("notification dispatch failed: #{inspect(e)}")
      :ok
  end

  # WHO SHOULD KNOW, independent of who is connected. Push exists precisely for
  # members the app is closed for, so deriving this from live sessions made push
  # reach only people already reachable another way.
  #
  # Visibility is re-resolved per member, which matters for the case that would
  # otherwise leak: a private channel's mention must not push to the whole
  # workspace. `nil` (a degenerate payload with no channel anchor) means there is
  # nothing to check against, so membership stands — the same call the call path
  # makes. This is the per-message cost of correctness; a cached per-channel
  # visible set (keyed on `{workspace_id, channel_id, RightsEpoch.current/1}`,
  # which the epoch owner already exposes) is the optimization when it earns its
  # keep — and since 1.2 uncapped the roster, it is now the dominant cost of a
  # concerned event in a large workspace.
  defp notifiable_members(_workspace_id, nil, ids), do: ids

  #
  # ONE batch resolve for the whole roster (review #21): this used to run
  # `Principal.resolve/3` per member — 3–4 reads EACH, so a 200-member
  # workspace paid ~800 reads per MessageCreate. `resolve_many/3` reads the
  # workspace row, the channel's overwrites, the members' rows and the union
  # of their roles once each, and evaluates every member in memory through the
  # same internals (bit-for-bit `resolve/3`'s answer). An unknown workspace
  # notifies nobody — the fail-closed answer the per-member loop gave too.
  defp notifiable_members(workspace_id, channel_id, ids) do
    case Cytale.Permissions.Principal.resolve_many(workspace_id, ids, channel_id) do
      {:ok, by_user} ->
        Enum.filter(ids, fn user_id ->
          case Map.get(by_user, user_id) do
            {:ok, bits} -> Cytale.Permissions.Bitfield.has?(bits, :view_channel)
            _ -> false
          end
        end)

      {:error, _} ->
        []
    end
  end

  defp member_ids(workspace_id) do
    # Uncapped by design: this feeds the notification AUDIENCE and the
    # subscription set, neither of which is a page. `list_members/1` defaults to
    # 50 rows, and using it here truncated the audience at the 50 highest
    # user_ids with no signal — the fan-out telemetry counts deliveries, not
    # members skipped.
    Cytale.Workspaces.list_member_ids(workspace_id)
  rescue
    _ -> []
  end

  # Members holding a push target, in ONE query rather than a read per member.
  # Takes the roster rather than re-reading it (see `notify/5`).
  defp subscribed_members(ids) do
    Cytale.Notifications.Subscriptions.by_user_ids(ids)
    |> Map.keys()
    |> MapSet.new()
  rescue
    _ -> MapSet.new()
  end

  # Convert the wire-shaped MESSAGE_CREATE payload (string ids) to the
  # integer-native message map the search behaviour indexes, and hand it to
  # the search seam. Best-effort: any failure is logged, never raised.
  defp index_message(workspace_id, payload) do
    try do
      message = %{
        id: to_int(payload["id"]),
        channel_id: to_int(payload["channel_id"]),
        author_id: to_int(payload["author_id"]),
        content: payload["content"] || "",
        thread_id: payload["thread_id"] && to_int(payload["thread_id"]),
        created_at: parse_iso(payload["created_at"])
      }

      Cytale.Search.TantivyImpl.index(workspace_id, message)
    rescue
      e ->
        Logger.warning("index_message failed: #{Exception.message(e)}")
        :ok
    end
  end

  # #76: the delete half of the index seam — best-effort, mirroring
  # `index_message`. A payload without an id is a no-op rather than a crash.
  defp unindex_message(workspace_id, payload) do
    case to_int(payload["id"]) do
      nil -> :ok
      # The CAST form (review #21): this now runs in the fan-out handler, which
      # must not wait on the writer's delete + commit.
      message_id -> Cytale.Search.IndexWriter.delete_message_async({:workspace, workspace_id}, message_id)
    end
  rescue
    e ->
      Logger.warning("unindex_message failed: #{Exception.message(e)}")
      :ok
  end

  defp to_int(nil), do: nil
  defp to_int(v) when is_integer(v), do: v
  defp to_int(v) when is_binary(v), do: String.to_integer(v)

  defp parse_iso(nil), do: DateTime.utc_now()

  defp parse_iso(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _} -> dt
      _ -> DateTime.utc_now()
    end
  end

  # Per-channel routing when the payload scopes one; workspace-wide otherwise.
  defp route_for(nil), do: {:workspace, :all}

  defp route_for(channel_id) when is_integer(channel_id) do
    PushRegistry.channel_key(Integer.to_string(channel_id))
  end
end
