defmodule Cytale.Calls.Events do
  @moduledoc """
  Call gateway event payload builders (voice plan U3) — the wire contract
  shared with the `@cytale/protocol` package (CamelCase event names,
  snowflake ids as decimal strings, ISO timestamps), matching U1's
  `CallStart`/`CallUpdate`/`CallEnd`/`CallRing` types. These build the `d`
  payloads; U4 fills in real fan-out delivery through `Cytale.Publish`.

  U3 emits NOTHING: the room reports transitions to the configured sink
  (behaviour below), whose default is a no-op. U4 swaps the sink for the
  visibility-filtered publisher without touching the room's state machine.
  """

  # The room's event seam. `emit/2` implementations receive the dispatch
  # event name (:call_start | :call_update | :call_end | :call_ring |
  # :call_signal) and the built `d` payload map.
  defmodule Sink do
    @moduledoc """
    The room's event seam. `emit/2` receives the dispatch event name
    (:call_start | :call_update | :call_end | :call_ring | :call_signal)
    and the built `d` payload map. The default implementation (`NoopSink`)
    discards everything — U3 ships the room with no emission, U4 provides
    the real one, U5's media plane rides the same seam with
    :call_signal (exactly one target participant per emission).
    """

    @callback emit(event :: atom(), payload :: map()) :: :ok
  end

  # The no-op sink U3 runs under: transitions are reported here and dropped.
  # Selected via `config :cytale, calls: [event_sink: module]`.
  defmodule NoopSink do
    @behaviour Cytale.Calls.Events.Sink

    @impl true
    def emit(_event, _payload), do: :ok
  end

  # The configured sink, read per-transition (a test or U4 can swap it at
  # runtime without restarting rooms).
  @doc false
  @spec sink() :: module()
  def sink, do: Cytale.Config.calls_event_sink()

  @doc "Fire a transition at the configured sink (no-op by default)."
  @spec emit(atom(), map()) :: :ok
  def emit(event, payload), do: :ok = sink().emit(event, payload)

  @doc "CALL_START payload. `thread_id` is nil on DM calls (R11)."
  @spec call_start(integer(), integer(), integer() | nil, integer(), DateTime.t()) :: map()
  def call_start(channel_id, call_id, thread_id, started_by, started_at) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "call_id" => Integer.to_string(call_id),
      "thread_id" => thread_id && Integer.to_string(thread_id),
      "started_by" => Integer.to_string(started_by),
      "started_at" => DateTime.to_iso8601(started_at)
    }
  end

  @doc """
  CALL_UPDATE payload — one voice-leg transition. `state` is the wire
  CallUpdateState string (`joined | left | muted | unmuted | deafened |
  undeafened | displaced | forced_leave`, plus the V2 source states
  `camera_on | camera_off | screen_on | screen_off | screen_audio_on |
  screen_audio_off`); `leg` is the target leg's opaque session
  discriminator (AM8); `source` names the published source for the V2
  source states (nil on leg-level states).
  """
  @spec call_update(integer(), integer(), integer(), String.t(), String.t(), String.t() | nil) ::
          map()
  def call_update(channel_id, call_id, user_id, leg, state, source \\ nil) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "call_id" => Integer.to_string(call_id),
      "user_id" => Integer.to_string(user_id),
      "leg" => leg,
      "state" => state
    }
    |> maybe_source(source)
  end

  defp maybe_source(payload, nil), do: payload

  defp maybe_source(payload, source), do: Map.put(payload, "source", source)

  @doc """
  CALL_END payload. `reason` is the wire CallEndReason string
  (`last_left` — the idle sweep after the last participant left; `swept` —
  boot-time or crash-recovery cleanup of a stale row, R8).
  """
  @spec call_end(integer(), integer(), String.t(), DateTime.t()) :: map()
  def call_end(channel_id, call_id, reason, ended_at) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "call_id" => Integer.to_string(call_id),
      "reason" => reason,
      "ended_at" => DateTime.to_iso8601(ended_at)
    }
  end

  @doc "CALL_RING payload (one recipient, user-keyed at delivery — U4)."
  @spec call_ring(integer(), integer(), integer()) :: map()
  def call_ring(channel_id, call_id, from_user) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "call_id" => Integer.to_string(call_id),
      "from_user" => Integer.to_string(from_user)
    }
  end

  @doc """
  CALL_SIGNAL payload (U5 media plane → one participant): `kind` is
  `"sdp" | "ice"`; `body` is the opaque, self-describing JSON blob (SDP
  bodies are `ExWebRTC.SessionDescription.to_json/1` maps encoded; ICE
  bodies are `ExWebRTC.ICECandidate.to_json/1` maps encoded). `user_id`
  names the TARGET — the publisher delivers the wire `CallSignal`
  `{channel_id, body}` to that user's key (KTD3: CallSignal is user-keyed,
  so `kind` never rides the wire; the body is self-describing).
  """
  @spec call_signal(integer(), integer(), String.t(), String.t()) :: map()
  def call_signal(channel_id, user_id, kind, body) do
    %{
      "channel_id" => Integer.to_string(channel_id),
      "user_id" => Integer.to_string(user_id),
      "kind" => kind,
      "body" => body
    }
  end

  @doc """
  CALL_SYNC payload (U4 backfill): the recipient's live channel calls plus
  their live DM calls, rosters included (mute/deafen). Inputs are room
  snapshots (`Cytale.Calls.Room.snapshot/0` shapes); the caller has ALREADY
  applied the per-recipient visibility filter — a channel entry appears only
  when the recipient's live-resolved visible set contains the channel, a DM
  entry only when they participate.
  """
  @spec call_sync([map()], [map()]) :: map()
  def call_sync(channel_snapshots, dm_snapshots) when is_list(channel_snapshots) and is_list(dm_snapshots) do
    %{
      "calls" => Enum.map(channel_snapshots, &sync_entry/1),
      "dm_calls" => Enum.map(dm_snapshots, &sync_dm_entry/1)
    }
  end

  defp sync_entry(snapshot) do
    %{
      "channel_id" => Integer.to_string(snapshot.channel_id),
      "call_id" => Integer.to_string(snapshot.call_id),
      "thread_id" => snapshot.thread_id && Integer.to_string(snapshot.thread_id),
      "participants" => sync_roster(snapshot.participants)
    }
  end

  defp sync_dm_entry(snapshot) do
    %{
      "channel_id" => Integer.to_string(snapshot.channel_id),
      "call_id" => Integer.to_string(snapshot.call_id),
      "participants" => sync_roster(snapshot.participants)
    }
  end

  @doc """
  ONE participant in the shared wire shape: `user_id`/`mute`/`deafen`, plus
  `sources` when the participant has published any (V2, R3).

  This is the single roster builder. CALL_SYNC's entries use it, and so does the
  REST `GET /channels/:id/call` projection (`CallController.live_json/1`) — that
  sharing is the fix for hardening plan 6.5: the REST projection emitted the
  three V1 fields by hand, so the V2 `sources` list was invisible to every
  TypeScript consumer of the REST shape even though the dispatch carried it.
  """
  @spec roster_entry(map()) :: map()
  def roster_entry(p) do
    %{"user_id" => Integer.to_string(p.user_id), "mute" => p.mute, "deafen" => p.deafen}
    |> maybe_sources(Map.get(p, :sources))
  end

  defp sync_roster(participants), do: Enum.map(participants, &roster_entry/1)

  # V2 (R3): backfill carries each participant's live published sources
  # (`since` feeds the stage-follows-most-recent order, VM4). Absent ≡
  # audio-only (additive: V1-shaped rosters stay valid).
  defp maybe_sources(entry, nil), do: entry

  defp maybe_sources(entry, sources) when sources == %{} do
    entry
  end

  defp maybe_sources(entry, sources) do
    Map.put(entry, "sources", sync_sources(sources))
  end

  defp sync_sources(sources) do
    Enum.map(sources, fn {source, %{since: since}} ->
      %{"source" => Atom.to_string(source), "since" => DateTime.to_iso8601(since)}
    end)
  end
end

defmodule Cytale.Calls.Events.PublisherSink do
  @moduledoc """
  The U4 sink (KTD3/AM9): the room's transitions published onto the gateway
  through the standard fan-out seams.

    * `CallStart` / `CallUpdate` / `CallEnd` — `Cytale.Publish.publish/2` on
      the channel: workspace channels ride the channel key THROUGH THE
      VISIBILITY FILTER (the workspace fan-out's CALL_* branch re-checks
      every recipient's live VIEW_CHANNEL — non-viewers receive nothing,
      KTD6/AM9); DM channels auto-address both participants' user keys via
      the publish seam's DM fallback (R11: user-keyed, `thread_id: null`).
    * `CallRing` — user-keyed point-to-point to the ELIGIBLE targets the
      sink computes itself (AM6): connected members who pass a live
      VIEW_CHANNEL check (viewers only, AM9) minus the notification-muted
      (the durable U3 table) minus the ring's initiator.
    * `CallSignal` (U5) — user-keyed point-to-point to exactly ONE target
      participant (the room's sole-offer SDP pushes and ICE trickle); the
      wire body is the opaque self-describing JSON blob.

  Compat (bot) sessions are excluded by construction: the compat dialect's
  dispatch filter has no CALL_* intent mapping, so the events never reach a
  compat wire (documented divergence — the compat wire stays voice-free).
  """

  @behaviour Cytale.Calls.Events.Sink

  alias Cytale.Calls
  alias Cytale.Gateway.PushRegistry

  @ring_event "CallRing"

  @impl true
  def emit(event, %{"channel_id" => channel_id} = payload)
      when event in [:call_start, :call_update, :call_end] do
    name =
      case event do
        :call_start -> "CallStart"
        :call_update -> "CallUpdate"
        :call_end -> "CallEnd"
      end

    # The publish seam is fire-and-forget from here (its DM fallback returns
    # a delivery count, not :ok) — the Sink contract owns the :ok.
    _ = Cytale.Publish.publish(String.to_integer(channel_id), {name, payload})
    :ok
  end

  def emit(:call_ring, %{"channel_id" => channel_id} = payload) do
    cid = String.to_integer(channel_id)
    from_user = String.to_integer(payload["from_user"])

    for user_id <- ring_targets(cid, from_user) do
      deliver_user_key(user_id, {@ring_event, payload})
    end

    :ok
  end

  # U5 media signaling: exactly one target participant per emission (the
  # room's sole-offer SDP pushes and ICE trickle). The wire CallSignal is
  # {channel_id, body} — `kind` stays server-side, the body is
  # self-describing (SDP json or ICE-candidate json).
  def emit(:call_signal, %{"user_id" => user_id} = payload) do
    wire = %{"channel_id" => payload["channel_id"], "body" => payload["body"]}
    deliver_user_key(String.to_integer(user_id), {"CallSignal", wire})
  end

  # AM6 target computation: CONNECTED members (a live session exists) who
  # pass the live VIEW_CHANNEL check (the room's join gate — viewers only,
  # AM9) minus notification-muted ones (the durable U3 table) minus the
  # initiator. DM rings address the DM's participants (participation IS
  # authorization) with the same connected/muted/exclusion rules; DM ring
  # defaults on (AM7) because the gateway defaults `ring` true for DM starts.
  defp ring_targets(channel_id, from_user) do
    dm_targets =
      case Cytale.Workspaces.get_dm(channel_id) do
        %{user_ids: user_ids} -> user_ids || []
        _ -> nil
      end

    connected =
      case dm_targets do
        nil ->
          PushRegistry.subscribers(PushRegistry.channel_key(Integer.to_string(channel_id)))
          |> Enum.map(fn {_pid, user_id} -> String.to_integer(user_id) end)
          |> Enum.uniq()

        ids ->
          Enum.filter(ids, fn uid ->
            PushRegistry.subscribers(PushRegistry.user_key(Integer.to_string(uid))) != []
          end)
      end

    connected
    |> Enum.reject(&(&1 == from_user))
    |> Enum.filter(&Calls.can_join_call?(channel_id, &1))
    |> Enum.reject(&Calls.notification_muted?(&1, channel_id))
  end

  # User-keyed point-to-point (every live session of the target user).
  defp deliver_user_key(user_id, event) do
    for {pid, _uid} <- PushRegistry.subscribers(PushRegistry.user_key(Integer.to_string(user_id))) do
      send(pid, {:cytale_gateway_push, self(), event})
    end

    :ok
  end
end
