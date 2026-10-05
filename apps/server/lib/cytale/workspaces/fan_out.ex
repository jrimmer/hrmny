defmodule Cytale.Workspaces.FanOut do
  @moduledoc """
  Per-PID best-effort fan-out (U11). At single-node launch scale simple
  per-PID delivery through PushRegistry subscriptions is sufficient (the
  Manifold optimization is multi-node only — documented future threshold).

  Delivery goes through the gateway socket's `{:cytale_gateway_push, ...}`
  path, which stamps each session's resume buffer under the store lock BEFORE
  the wire write — so a client that drops mid-flight resumes exactly.

  Ordering: per-channel monotonic via the Snowflake message_id carried in the
  payload; the gateway stamps per-session seqs in delivery order.

  DM channels (bots plan B-1) have no workspace and no channel-key
  subscribers — `deliver/2` resolves a DM channel and addresses BOTH
  participants' user keys instead (every live session of each participant,
  including the sender's own). The per-session gates decide the rest: the
  compat dispatch filter checks DM recipient membership, native sessions
  pass through untouched.

  Backpressure (PERF-06): the send to a live socket is guarded by that
  socket's mailbox depth — `Process.info(pid, :message_queue_len)` against
  `Cytale.Config.fan_out_shed_threshold/0` (default 200) — but ONLY for the
  best-effort event classes: `TypingStart` and `PresenceUpdate` are skipped
  for a recipient whose queue is over the line, silently (no per-shed log —
  a wedged client would turn every event into spam). Message, call and
  read-state events are the product and are NEVER shed: they are what the
  resume buffer exists to protect. Neither shed class can be missed by a
  healthy client: presence is re-snapshotted on the next sync and a typing
  indicator expires on the receiver's own clock.

  Pre-encoding (hardening plan 2.3): every route encodes the payload once
  and hands each socket the `PreEncoded` fragment to splice. A caller that
  already holds an encode for the event passes it via the `:fragment` opt
  (PERF-07 — the UserUpdate publish encodes once for ALL of its routes)
  and every route reuses it.
  """

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Gateway.PreEncoded
  alias Cytale.Gateway.Payloads
  alias Cytale.Gateway.SessionStore

  @doc """
  Deliver `{event_name, payload}` to every live session subscribed to
  `channel_id` (decimal-string key per PushRegistry) — or, when the id is a
  DM channel, to both participants' user-key sessions. Best-effort: dead PIDs
  are filtered at the registry; send failures (e.g. :noproc on a just-died
  PID) are swallowed per the plan's "best-effort, clients resume" contract.

  Options:

    * `:except` — one exclusion applied on every route, either

        * a pid — that one socket is skipped (the origin process), or
        * `{:user, user_id}` — EVERY live session of that principal is
          skipped (the typing rule, #80: a `TypingStart` is for everyone
          except the user who is typing, "not even your other sessions").
          The gateway op used to exclude only the origin pid, which still
          echoed the signal back to the typing member's second device; the
          compat dialect's `self_typing?/3` filter is the same rule and this
          is the shared seam that applies it to both wires.

      Ids compare in their string form: the registry holds the wire
      (decimal-string) id while the REST origins hand the claims' integer id.
      Any OTHER shape raises `ArgumentError` naming it (fail closed): it is
      never treated as "exclude nobody".

    * `:fragment` — a `PreEncoded` fragment for this event already encoded by
      the caller (PERF-07): reused for every route of this delivery instead
      of re-encoding per route. Absent (the default), each route pre-encodes
      only when that route's recipient count amortises the walk.

  Returns the number of live targets attempted.
  """
  @spec deliver(integer() | String.t(), {String.t(), map()}, keyword()) :: non_neg_integer()
  def deliver(channel_id, {event_name, _payload} = event, opts \\ []) when is_binary(event_name) do
    except = Keyword.get(opts, :except, :none)
    # Validate the shape BEFORE any routing or registry read: an unrecognized
    # `:except` used to fall through `excluded?/3`'s catch-all, which excluded
    # NOBODY — silent over-delivery with no signal, the reverse of the
    # documented fail-closed posture (hardening plan 7.14). Fail loudly and
    # name the shape instead.
    validate_except!(except)

    case route(channel_id, opts) do
      :channel ->
        deliver_route(PushRegistry.channel_key(to_string(channel_id)), event, except, opts)

      {:dm, user_keys} ->
        Enum.reduce(user_keys, 0, fn key, acc -> acc + deliver_route(key, event, except, opts) end)
    end
  end

  # Which route this channel takes. `resolved:` lets a caller that ALREADY knows
  # the channel's kind say so — a permission resolve that accepted the channel, or
  # the publish path's own DM lookup — instead of paying a second `dm_channels`
  # read for an answer it holds (hardening plan 5.2). `Publish.publish/2` was
  # reading that table twice for one DM message (once to discover the channel is
  # not a workspace channel, once here), and every typing signal on an ordinary
  # channel paid a read to learn it was not a DM.
  #
  # The default stays `:resolve`: a caller that does not know must not guess, or a
  # DM event would be routed to a channel key nobody subscribes to.
  defp route(channel_id, opts) do
    case Keyword.get(opts, :resolved) do
      :channel ->
        :channel

      {:dm, %{user_ids: user_ids}} ->
        {:dm, dm_keys(user_ids)}

      _ ->
        # `dm_targets/1` answers in its own vocabulary (keys or nil); this is where
        # that becomes the route this function's callers branch on.
        case dm_targets(channel_id) do
          nil -> :channel
          user_keys -> {:dm, user_keys}
        end
    end
  end

  @doc """
  Deliver an event to every session subscribed to a workspace (the
  STRING-id workspace key sessions actually register under — the workspace
  process's channel-less `{:workspace, :all}` route matches nobody).
  Options are `deliver/3`'s (`:except` is fixed to `:none` here; `:fragment`
  passes through — the UserUpdate publish reuses one encode across legs,
  PERF-07). Returns the number of live targets attempted.
  """
  @spec deliver_workspace(integer(), {String.t(), map()}, keyword()) :: non_neg_integer()
  def deliver_workspace(workspace_id, {event_name, _payload} = event, opts \\ [])
      when is_binary(event_name) do
    deliver_route(PushRegistry.workspace_key(Integer.to_string(workspace_id)), event, :none, opts)
  end

  @doc """
  Deliver an event to each given user's sessions exactly once (the
  UserUpdate DM leg: participant ids are already in hand — no per-DM
  channel re-resolution, no duplicate self pushes). Options are `deliver/3`'s
  (`:except` is fixed to `:none` here; `:fragment` passes through, PERF-07).
  Returns the number of live targets attempted.
  """
  @spec deliver_user_keys([integer()], {String.t(), map()}, keyword()) :: non_neg_integer()
  def deliver_user_keys(user_ids, {event_name, _payload} = event, opts \\ [])
      when is_binary(event_name) and is_list(user_ids) do
    Enum.reduce(user_ids, 0, fn uid, acc ->
      acc + deliver_route(PushRegistry.user_key(Integer.to_string(uid)), event, :none, opts)
    end)
  end

  defp deliver_route(route, {_event_name, _payload} = event, except, opts) do
    event_name = elem(event, 0)

    live =
      route
      |> PushRegistry.subscribers()
      |> Enum.reject(fn {pid, user_id} -> excluded?(pid, user_id, except) end)

    # ONE encode for the whole route (hardening plan 2.3) — see
    # `PreEncoded.for_fanout/2`. A caller-supplied fragment (PERF-07: the
    # UserUpdate publish encodes once for ALL its routes) is reused verbatim,
    # however many routes it spans.
    fragment = Keyword.get(opts, :fragment) || PreEncoded.for_fanout(length(live), elem(event, 1))

    # `:accepted_at` (review #20) rides a 5th element so the socket can time
    # accept→deliver at its push; every other delivery keeps the 4-tuple.
    push =
      case Keyword.get(opts, :accepted_at) do
        nil -> {:cytale_gateway_push, self(), event, fragment}
        at -> {:cytale_gateway_push, self(), event, fragment, %{accepted_at: at}}
      end

    for {pid, _user_id} <- live do
      if deliver?(pid, event_name) do
        send(pid, push)
      end
    end

    # The OFFLINE half of this route (hardening plan 4.2): sessions that dropped
    # inside their resume window are not in `subscribers/1` — their socket is
    # gone — but they are still addressable, and the event goes into their
    # record's resume buffer instead of nowhere. Runs AFTER the live sends: the
    # buffered write is a cross-process call (the shard serializes it) and must
    # never delay a connected recipient.
    buffer_offline(route, event, except)

    length(live)
  end

  @doc """
  Append `{event_name, payload}` to the resume buffer of every disconnected-but-
  resumable session held for `route` (hardening plan 4.2, owner decision (a): a
  durable offline buffer in the session record).

  Before this, a publication during the resume window reached nobody, stamped no
  seq and consumed nothing — so `replay_complete?/2` was satisfied and the client
  resumed believing it was current, with those events gone for good.

  Two guards decide what is eligible:

    * the RECORD must be a `:disconnected` `:native` one. Compat is skipped by
      design: its replay goes through `GatewayDialect.filter_replay/5` against
      current visibility, and its buffer is fed by the socket's own translated
      dispatch path — appending an untranslated native payload there would put
      native shapes on the Discord wire. Compat keeps its previous behaviour
      (full REST sync on reconnect), which is the documented residual.
    * the EVENT must be `Payloads.offline_bufferable?/1` — what the Resume tail
      re-derives (presence, read state, calls) or what is ephemeral by contract
      (typing) is not worth a stale replay.

  `:except` is honored for the `{:user, id}` form (the typing rule, #80) using
  the record's own user id; a pid exclusion can never match a session whose
  socket is gone. The writes go through `SessionStore.append_offline/4`, which is
  the shard's SERIALIZED read-modify-write (the disconnected record has no live
  claim holder, so the single-writer invariant that licenses `update_local/2`
  does not apply, and two publishers can race for one record), grouped into ONE
  call per shard so a mass disconnect cannot turn one publish into one blocking
  shard call per offline member. It is also best-effort by construction: a shard
  that is slow or restarting logs and drops the append rather than killing the
  publisher.

  A hold whose record has vanished (expired, swept, or deleted while this ran)
  is released by the store, exactly like `subscribers/1` reclaims a dead pid.
  """
  @spec buffer_offline(PushRegistry.route_key(), {String.t(), map()}, term()) :: :ok
  def buffer_offline(route, {event_name, payload}, except \\ :none) do
    if Payloads.offline_bufferable?(event_name) do
      route
      |> PushRegistry.held_sessions()
      |> SessionStore.append_offline(event_name, payload, except)
    end

    :ok
  end

  # `:except` (see `deliver/3`): `:none` excludes nothing, a pid excludes one
  # socket, `{:user, id}` excludes the principal's every live session. The
  # string-form comparison covers both id shapes the call sites hold — the
  # registry's wire id vs the REST origins' integer claims id. The final clause
  # is unreachable through `deliver/3` (which validates first) but is kept
  # fail-closed anyway so no future direct caller can silently over-deliver.
  defp excluded?(_pid, _user_id, :none), do: false
  defp excluded?(pid, _user_id, except_pid) when is_pid(except_pid), do: pid == except_pid

  defp excluded?(_pid, user_id, {:user, except_user}) do
    not is_nil(user_id) and not is_nil(except_user) and
      to_string(user_id) == to_string(except_user)
  end

  defp excluded?(_pid, _user_id, other), do: raise(ArgumentError, except_error(other))

  # The one message every unrecognized `:except` shape raises with — named so
  # the log line identifies the offending value.
  defp validate_except!(:none), do: :ok
  defp validate_except!(except) when is_pid(except), do: :ok
  defp validate_except!({:user, _user_id}), do: :ok
  defp validate_except!(other), do: raise(ArgumentError, except_error(other))

  defp except_error(other) do
    "Cytale.Workspaces.FanOut.deliver/3: unrecognized :except shape #{inspect(other)} — " <>
      "expected :none, a pid, or {:user, user_id}; refusing to route rather than over-deliver"
  end

  # -- Live-send backpressure (PERF-06) ---------------------------------------------

  # Deliver to this live socket, or shed? The mailbox probe runs ONLY for the
  # sheddable classes — message/call/state events never pay a Process.info.
  defp deliver?(pid, event_name) do
    not sheddable?(event_name) or not wedged?(pid)
  end

  # The best-effort classes, and only them (PERF-06): a typing indicator
  # expires on the receiver's own clock and presence is re-snapshotted on the
  # next sync, so a skipped one costs a healthy client nothing and a stalled
  # client nothing it was going to render anyway. Message/call/read-state
  # events are the product — never shed, never probed.
  defp sheddable?("TypingStart"), do: true
  defp sheddable?("PresenceUpdate"), do: true
  defp sheddable?(_event_name), do: false

  # A stalled client stops draining its mailbox; every send it never consumes
  # grows the queue without bound. Above `Cytale.Config.fan_out_shed_threshold/0`
  # the sheddable classes are skipped — silently, deliberately: a wedged
  # client must not turn every event into a log line. `nil` info is a pid that
  # died between the registry read and here — nothing left to protect.
  defp wedged?(pid) do
    case Process.info(pid, :message_queue_len) do
      {:message_queue_len, len} -> len > Cytale.Config.fan_out_shed_threshold()
      nil -> false
    end
  end

  # DM channels: the participants' user keys (nil when not a DM — the
  # ordinary channel-key path).
  defp dm_targets(channel_id) do
    id =
      case channel_id do
        int when is_integer(int) ->
          int

        bin when is_binary(bin) ->
          case Integer.parse(bin) do
            {int, ""} -> int
            _ -> nil
          end

        _ ->
          nil
      end

    case id && Cytale.Workspaces.get_dm(id) do
      %{user_ids: user_ids} -> dm_keys(user_ids)
      _ -> nil
    end
  end

  @doc false
  @spec dm_keys([integer()] | nil) :: [PushRegistry.route_key()]
  def dm_keys(user_ids), do: Enum.map(user_ids || [], &PushRegistry.user_key(Integer.to_string(&1)))
end
