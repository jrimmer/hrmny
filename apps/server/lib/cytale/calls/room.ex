defmodule Cytale.Calls.Room do
  @moduledoc """
  One live call (voice plan U3, KTD4): a GenServer per live call under
  `Cytale.Calls.RoomSupervisor`, registered by channel_id in
  `Cytale.Calls.RoomRegistry` — the registry's unique key IS the one-live-
  per-channel invariant (KD3's policy point). Live state is ephemeral
  presence-like state; Scylla only sees durable boundaries (the `calls` row
  the room opens at start and closes at end) and the standing-log mapping.

  Lifecycle (R8):

      started → participants join/leave/re-bind (grace on session DOWN)
      empty ──┬─ rejoin within the sweep window → live again (same call)
              └─ empty_sweep_ms expires → ended (reason `last_left`)

  A CRASHED room restarts under the supervisor (:transient — abnormal exits
  restart, the deliberate end-of-call `:normal` stop is final): init re-reads
  the channel's newest `calls` row and ADOPTS it when still open — in-memory
  participants are gone (never resurrected as ghosts) and the empty sweep
  ends the stale call with reason `swept` (the crash-recovery arm of R8)
  unless someone genuinely rejoins first.

  Session binding (AM4): each participant entry monitors the owner's current
  gateway session process; a DOWN arms a `session_grace_ms` window (~30s)
  during which a re-bound pid (same user, fresh monitor — the Resume path)
  keeps the voice leg. Grace expiry removes the participant.

  One voice state per user (AM8): a second join by the same user displaces
  the first leg (fresh monitor + leg id).

  DM rooms (R11): `init` detects a `dm_channels` row for the channel id and
  then writes NO `calls` row and creates NO standing thread — nothing in V1
  reads DM call history, so DM calls leave no artifact.

  U3 emits nothing on the gateway: transitions are reported to the
  configured `Cytale.Calls.Events.Sink` (no-op default); U4 swaps the sink
  for the visibility-filtered publisher without touching this state machine.

  U4 additions on this state machine: the live VIEW_CHANNEL check at every
  join/state (AM2 — the gateway consults first, the room re-checks under its
  own serialization), mid-call epoch eviction (AM3 — the room subscribes to
  `RightsEpoch` bumps for its workspace and force-leaves every participant
  whose live VIEW_CHANNEL failed), the Resume re-bind (AM4 — `rebind/3`
  swaps the monitored session process for the same user WITHOUT minting a
  new leg or emitting displacement), the once-per-call ring (AM6/AM17 —
  honored at start or via `ring/2` when the call has not rung yet), and the
  opaque op-23 signal mailbox (U5 consumes `{:call_signal, ...}`).

  U5 media hooks: the room owns the SFU media plane (`Cytale.Calls.Media`)
  — a server PeerConnection per participant, negotiated over the op-23/
  CALL_SIGNAL seam. Every roster mutation funnels through `sync_media/1`
  (join/displacement/leave/grace/eviction), the op-23 mailbox feeds
  answers/ICE into the PCs, ex_webrtc notifications arrive here because
  the room is each PC's controlling process, PCs LINK to the room
  (trap_exit: a room crash takes its PCs down — no orphans — and a PC
  crash reaches the room as an EXIT, not a link-kill), and voice-unavailable
  removals (PC crash, or a second `:failed` after the one ICE restart)
  leave through the same `left` wire state as an ordinary leave.
  """

  use GenServer, restart: :transient

  alias Cytale.Calls.Events
  alias Cytale.Calls.Log
  alias Cytale.Calls.Media
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc "A participant leg (integer-native ids; `leg` is the AM8 wire discriminator)."
  @type participant :: %{
          session_pid: pid() | nil,
          monitor: reference() | nil,
          leg_id: String.t(),
          mute: boolean(),
          deafen: boolean(),
          grace_timer: reference() | nil,
          sources: %{Cytale.Calls.Media.source_kind() => %{since: DateTime.t()}}
        }

  @typedoc "The room snapshot `state/1` returns (roster without internals)."
  @type snapshot :: %{
          required(:channel_id) => integer(),
          required(:call_id) => integer(),
          required(:thread_id) => integer() | nil,
          required(:started_by) => integer(),
          required(:started_at) => DateTime.t(),
          required(:dm) => boolean(),
          required(:ring) => boolean(),
          required(:workspace_id) => integer() | nil,
          required(:participants) => [%{user_id: integer(), mute: boolean(), deafen: boolean(), leg: String.t()}]
        }

  @enforce_keys [:channel_id, :call_id, :thread_id, :started_by, :started_at, :dm]
  defstruct @enforce_keys ++
              [
                ring: false,
                workspace_id: nil,
                participants: %{},
                empty_since: nil,
                sweep_timer: nil,
                # U5: the SFU media plane (server PC per participant). The
                # room process IS its owner/controlling process.
                media: %Media{},
                # true when a restarted room adopted an open row (crash
                # recovery): the empty sweep then ends it as `swept`, not
                # `last_left` (R8), and no call_start re-emission happens.
                stale_adoption: false
              ]

  # -- Client API (the Cytale.Calls context is the public surface) ---------------

  @doc """
  Start the room for `channel_id`. The via-name under `RoomRegistry` is the
  one-live invariant: a second start fails with `{:error, {:already_started,
  pid}}`, which the supervisor/context normalize into a JOIN of the live
  call (AM16 — the loser auto-joins, no error surface).
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts) do
    channel_id = Keyword.fetch!(opts, :channel_id)
    started_by = Keyword.fetch!(opts, :started_by)
    ring = Keyword.get(opts, :ring, false)

    GenServer.start_link(__MODULE__, {channel_id, started_by, ring},
      name: {:via, Registry, {Cytale.Calls.RoomRegistry, channel_id}}
    )
  end

  @doc "Join (or re-bind/displace, AM8). Returns the leg descriptor."
  @spec join(GenServer.server(), integer(), pid()) ::
          {:ok, %{call_id: integer(), thread_id: integer() | nil, leg_id: String.t()}}
  def join(room, user_id, session_pid) when is_integer(user_id) and is_pid(session_pid) do
    GenServer.call(room, {:join, user_id, session_pid})
  end

  @doc "Leave (idempotent — leaving when not a participant is :ok)."
  @spec leave(GenServer.server(), integer()) :: :ok
  def leave(room, user_id) when is_integer(user_id), do: GenServer.call(room, {:leave, user_id})

  @doc "V2: publish a source (the gateway bit/capability-consulted op lands here)."
  @spec publish(GenServer.server(), integer(), Cytale.Calls.Media.source_kind()) ::
          {:ok, :ok} | {:error, term()}
  def publish(room, user_id, source),
    do: GenServer.call(room, {:publish, user_id, source})

  @doc "V2: unpublish a source (idempotent)."
  @spec unpublish(GenServer.server(), integer(), Cytale.Calls.Media.source_kind()) ::
          {:ok, :ok} | {:error, term()}
  def unpublish(room, user_id, source),
    do: GenServer.call(room, {:unpublish, user_id, source})

  @doc "V2: the viewer's adaptive tile budget (the gateway's 2s window guards rate)."
  @spec video_want(GenServer.server(), integer(), non_neg_integer()) :: {:ok, :ok}
  def video_want(room, user_id, tiles) when is_integer(tiles) and tiles >= 0,
    do: GenServer.call(room, {:video_want, user_id, tiles})

  @doc """
  V2 (P2): the listen-only mic upgrade — the client bound its mic locally
  and said so via op-22 `state` (`mic_granted: true`, routed here by the
  gateway's state handler). The server is the sole offerer, so the room
  re-offers the leg or the upgrade stays silent. Participant-only (a
  no-op otherwise).
  """
  @spec mic_ready(GenServer.server(), integer()) :: :ok
  def mic_ready(room, user_id) when is_integer(user_id),
    do: GenServer.call(room, {:mic_ready, user_id})

  @doc "V2: the room's published-source roster (tests/ops introspection)."
  @spec sources(GenServer.server()) :: %{integer() => map()}
  def sources(room), do: GenServer.call(room, :sources)

  @doc """
  Update the participant's voice state (`mute`/`deafen` booleans). Deafen
  implies self-mute (AM12); un-deafening does NOT un-mute. Returns the
  updated participant or `{:error, :not_participant}`.
  """
  @spec update_state(GenServer.server(), integer(), %{optional(:mute) => boolean(), optional(:deafen) => boolean()}) ::
          {:ok, participant()} | {:error, :not_participant}
  def update_state(room, user_id, changes) when is_map(changes) do
    GenServer.call(room, {:update_state, user_id, changes})
  end

  @doc """
  Re-bind the monitored session process for `user_id` to `session_pid`
  (AM4 — the Resume path: a re-adopted session runs in a NEW process, and
  without a re-bind every quick reconnect would arm the liveness grace).
  Keeps the leg (same leg id, same mute/deafen), cancels any armed grace,
  and emits NOTHING — a re-bind is not a voice-leg transition. No-op when
  the user is not a participant (nothing to re-bind).
  """
  @spec rebind(GenServer.server(), integer(), pid()) :: :ok
  def rebind(room, user_id, session_pid) when is_integer(user_id) and is_pid(session_pid) do
    GenServer.call(room, {:rebind, user_id, session_pid})
  end

  @doc """
  Ring the room's connected members on `from_user`'s behalf (AM17
  ring-after-start). Once per call (AM6): a call that already rang (at start
  or via an earlier state action) ignores further requests.
  """
  @spec ring(GenServer.server(), integer()) :: :ok
  def ring(room, from_user) when is_integer(from_user), do: GenServer.call(room, {:ring, from_user})

  @doc "True when `user_id` currently holds a leg in this call."
  @spec participant?(GenServer.server(), integer()) :: boolean()
  def participant?(room, user_id) when is_integer(user_id), do: GenServer.call(room, {:participant?, user_id})

  @doc "The room snapshot (roster without monitors/timers)."
  @spec state(GenServer.server()) :: snapshot()
  def state(room), do: GenServer.call(room, :state)

  @doc "U5 introspection: the call's live server-PC pids, by user id."
  @spec media_pcs(GenServer.server()) :: %{integer() => pid()}
  def media_pcs(room), do: GenServer.call(room, :media_pcs)

  # -- Init: durable writes, adoption, sweep arming --------------------------------

  @impl true
  def init({channel_id, started_by, ring}) do
    # U5: PCs link to the room — trap exits so a PC crash arrives as a
    # message (voice-unavailable removal) instead of killing the room (and
    # so the room's own death reliably takes its PCs with it).
    Process.flag(:trap_exit, true)

    dm? = not is_nil(Workspaces.get_dm(channel_id))
    # The channel's workspace (nil on DMs and on unresolvable channel ids —
    # the U3 room tests' bare snowflakes): caps bucketing + the AM3 epoch
    # subscription key.
    ws_id = if dm?, do: nil, else: workspace_of(channel_id)

    state =
      if dm? do
        # R11 no-artifact: no `calls` row, no standing thread, ever.
        now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
        call_id = Cytale.Snowflake.next()

        # The seam report (no-op until U4): a fresh DM call exists, with a
        # null thread_id per U1's CallStart shape.
        :ok = Events.emit(:call_start, Events.call_start(channel_id, call_id, nil, started_by, now))

        struct!(
          __MODULE__,
          channel_id: channel_id,
          call_id: call_id,
          thread_id: nil,
          started_by: started_by,
          started_at: now,
          dm: true,
          ring: ring
        )
      else
        open_channel_call(channel_id, started_by, ring)
      end

    state = %{state | workspace_id: ws_id}

    # AM3: a workspace channel's room hears rights-epoch bumps and
    # re-checks every participant's live VIEW_CHANNEL (mid-call revocation
    # evicts immediately). DM rooms never subscribe — participation IS
    # authorization there, and DM membership never changes in V1.
    if ws_id, do: RightsEpoch.subscribe(ws_id)

    # AM6: the start's ring request is honored exactly once, at birth —
    # never again on a crashed room's stale-adoption restart (clients dedupe
    # on call_id regardless).
    if state.ring and not state.stale_adoption, do: emit_ring(state, started_by)

    {:ok, arm_empty_sweep(state)}
  end

  defp workspace_of(channel_id) do
    case Workspaces.get_channel(channel_id) do
      %{workspace_id: ws_id} when is_integer(ws_id) -> ws_id
      _ -> nil
    end
  end

  # Channel rooms: adopt the newest row when it is still open (a crashed
  # room's restart — see moduledoc), else open a fresh one linked to the
  # standing call-log thread. The starter's join follows synchronously; the
  # sweep armed below covers both the fresh start and the crashed-and-
  # abandoned case. (An open row buried under a CLOSED newest row would
  # violate one-live and is left to the boot sweep — it cannot occur while
  # rooms are the only row writers, and the `open_calls` index would name it
  # even though this lookup cannot see it.)
  defp open_channel_call(channel_id, started_by, ring) do
    case newest_row(channel_id) do
      %{
        "call_id" => call_id,
        "started_by" => row_by,
        "started_at" => started_at,
        "ended_at" => nil,
        "thread_id" => thread_id
      } ->
        # Re-assert the live index for an adopted call: the process that wrote
        # the row may have crashed before indexing it, and an open `calls` row
        # missing from the index is exactly what the boot sweep would miss.
        # Idempotent, so the normal case is a cheap overwrite.
        :ok = Cytale.Calls.mark_open(channel_id, call_id)

        struct!(
          __MODULE__,
          channel_id: channel_id,
          call_id: call_id,
          thread_id: thread_id,
          started_by: row_by,
          started_at: started_at,
          dm: false,
          ring: ring,
          stale_adoption: true
        )

      _ ->
        call_id = Cytale.Snowflake.next()
        now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
        {:ok, thread_id} = Log.ensure_thread(channel_id, started_by)

        # Index before the row (see `Cytale.Calls.mark_open/2`), and give the
        # index row back if the row write fails — otherwise a failed start
        # leaves a candidate that the next sweep has to read and discard.
        :ok = Cytale.Calls.mark_open(channel_id, call_id)

        try do
          Repo.execute!(
            "INSERT INTO {{K}}.calls (channel_id, call_id, started_by, started_at, ended_at, ended_reason, thread_id, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            [
              {"bigint", channel_id},
              {"bigint", call_id},
              {"bigint", started_by},
              {"timestamp", now},
              {"timestamp", nil},
              {"text", nil},
              {"bigint", thread_id},
              {"text", nil}
            ]
          )
        rescue
          e ->
            Cytale.Calls.mark_closed(channel_id)
            reraise e, __STACKTRACE__
        end

        # The seam report (no-op until U4): a fresh call exists.
        :ok = Events.emit(:call_start, Events.call_start(channel_id, call_id, thread_id, started_by, now))

        struct!(
          __MODULE__,
          channel_id: channel_id,
          call_id: call_id,
          thread_id: thread_id,
          started_by: started_by,
          started_at: now,
          dm: false,
          ring: ring
        )
    end
  end

  # Newest-first by call_id DESC clustering; LIMIT 1 without ALLOW FILTERING.
  defp newest_row(channel_id) do
    rows =
      Repo.execute!(
        "SELECT call_id, started_by, started_at, ended_at, thread_id FROM {{K}}.calls WHERE channel_id = ? LIMIT 1",
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [row] -> row
      [] -> nil
    end
  end

  # -- Calls -----------------------------------------------------------------------

  @impl true
  def handle_call({:join, user_id, session_pid}, _from, state) do
    if join_permitted?(state, user_id) do
      {result, state} = join_state(user_id, session_pid, state)
      {:reply, {:ok, result}, state}
    else
      # AM2: the room live-checks VIEW_CHANNEL under its own serialization —
      # the gateway consults first, this is the defense-in-depth re-check.
      {:reply, {:error, :cannot_view}, state}
    end
  end

  def handle_call({:leave, user_id}, _from, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:reply, :ok, state}

      participant ->
        :ok =
          Events.emit(
            :call_update,
            Events.call_update(state.channel_id, state.call_id, user_id, participant.leg_id, "left")
          )

        state = drop_participant(state, user_id, participant)
        {:reply, :ok, maybe_empty(sync_media(state))}
    end
  end

  def handle_call({:update_state, user_id, changes}, _from, state) do
    cond do
      not Map.has_key?(state.participants, user_id) ->
        {:reply, {:error, :not_participant}, state}

      not join_permitted?(state, user_id) ->
        # AM2's live re-check rides every op (the epoch bump evicts within
        # ms, but the op path re-checks too).
        {:reply, {:error, :cannot_view}, state}

      true ->
        participant = Map.get(state.participants, user_id)

        deafen = Map.get(changes, :deafen, participant.deafen)
        # AM12: deafen implies self-mute; un-deafening keeps an explicit mute.
        mute =
          if deafen,
            do: true,
            else: Map.get(changes, :mute, participant.mute)

        updated = %{participant | mute: mute, deafen: deafen}
        state = put_participant(state, user_id, updated)

        emit_state_change(state, user_id, participant, updated)

        {:reply, {:ok, updated}, state}
    end
  end

  # AM4 re-bind: swap the monitored session process, keep the leg entirely.
  def handle_call({:rebind, user_id, session_pid}, _from, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:reply, :ok, state}

      participant ->
        if participant.monitor, do: Process.demonitor(participant.monitor, [:flush])
        state = cancel_grace(state, user_id)
        monitor = Process.monitor(session_pid)
        participant = %{participant | session_pid: session_pid, monitor: monitor}
        {:reply, :ok, put_participant(state, user_id, participant)}
    end
  end

  # AM6/AM17: ring-after-start — honored at most once per call.
  def handle_call({:ring, from_user}, _from, state) do
    if state.ring do
      {:reply, :ok, state}
    else
      emit_ring(state, from_user)
      {:reply, :ok, %{state | ring: true}}
    end
  end

  def handle_call({:participant?, user_id}, _from, state) do
    {:reply, Map.has_key?(state.participants, user_id), state}
  end

  # V2 (R1/R13/KTD3): publish a source. The gateway consulted the bit
  # (SEND_VIDEO for camera, SHARE_SCREEN for screen+screen_audio) and the
  # media-settings capability first (twin-check); the room re-serializes
  # under itself, emits the source-state CALL_UPDATE, and reconciles the
  # media plane (the publisher's ingest grows, everyone's egress grows).
  def handle_call({:publish, user_id, source}, _from, state) do
    with :ok <- publish_permitted?(state, user_id, source) do
      participant = Map.get(state.participants, user_id)
      sources = Map.put(participant.sources || %{}, source, %{since: DateTime.utc_now()})
      state = put_participant(state, user_id, %{participant | sources: sources})

      emit_one(state, user_id, participant.leg_id, wire_on(source), Atom.to_string(source))

      state = %{
        state
        | media: Media.set_source(state.media, user_id, state.channel_id, source, true, Map.keys(state.participants))
      }

      {:reply, {:ok, :ok}, state}
    else
      {:error, reason} -> {:reply, {:error, reason}, state}
    end
  end

  # V2: unpublish — also the track-death path (the client reports the
  # browser stop-bar/window-close/OS-revoke through the same op, R4).
  def handle_call({:unpublish, user_id, source}, _from, state) do
    case Map.get(state.participants, user_id) do
      nil ->
        {:reply, {:error, :not_participant}, state}

      participant ->
        if Map.has_key?(participant.sources || %{}, source) do
          sources = Map.delete(participant.sources || %{}, source)
          state = put_participant(state, user_id, %{participant | sources: sources})
          emit_one(state, user_id, participant.leg_id, wire_off(source), Atom.to_string(source))

          state = %{
            state
            | media:
                Media.set_source(state.media, user_id, state.channel_id, source, false, Map.keys(state.participants))
          }

          {:reply, {:ok, :ok}, state}
        else
          {:reply, {:ok, :ok}, state}
        end
    end
  end

  # V2 (KTD7): the viewer's adaptive-tile budget. The gateway enforces the
  # ~2s window on the op; the room just records it (the media plane reads
  # it at forward time).
  def handle_call({:video_want, user_id, tiles}, _from, state) do
    {:reply, {:ok, :ok}, %{state | media: Media.set_want(state.media, user_id, tiles)}}
  end

  # V2 (P2): the listen-only upgrade — re-offer the participant's leg so
  # their locally-bound mic attaches on the fresh answer.
  def handle_call({:mic_ready, user_id}, _from, state) do
    if Map.has_key?(state.participants, user_id) do
      {:reply, :ok, %{state | media: Media.reoffer_leg(state.media, state.channel_id, user_id)}}
    else
      {:reply, :ok, state}
    end
  end

  # V2: introspection for tests — the room's published-source truth.
  def handle_call(:sources, _from, state) do
    {:reply, Map.new(state.participants, fn {u, p} -> {u, p.sources || %{}} end), state}
  end

  def handle_call(:state, _from, state) do
    {:reply, snapshot(state), state}
  end

  # U5 test/ops introspection: the room's live server-PC pids (the media
  # harness kills one to prove the room survives PC death).
  def handle_call(:media_pcs, _from, state) do
    {:reply, Map.new(state.media.legs, fn {user_id, leg} -> {user_id, leg.pc} end), state}
  end

  # -- Monitors, grace, sweep --------------------------------------------------------

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    case find_by_monitor(state, ref) do
      nil ->
        {:noreply, state}

      {user_id, participant} ->
        # AM4: keep the leg through the grace window — a Resume re-binding
        # the (new) session process arrives as a join and cancels it. The
        # expiry message is guarded by the participant still being
        # monitor-less (a re-bound leg has a live session_pid and ignores
        # a stale expiry; FIFO ordering puts any stale expiry ahead of the
        # next DOWN).
        timer = Process.send_after(self(), {:grace_expired, user_id}, grace_ms())

        participant = %{participant | session_pid: nil, monitor: nil, grace_timer: timer}
        {:noreply, put_participant(state, user_id, participant)}
    end
  end

  def handle_info({:grace_expired, user_id}, state) do
    case Map.get(state.participants, user_id) do
      # The leg never re-bound: grace expired, remove it.
      %{session_pid: nil, monitor: nil} = participant ->
        :ok =
          Events.emit(
            :call_update,
            Events.call_update(state.channel_id, state.call_id, user_id, participant.leg_id, "left")
          )

        state = drop_participant(state, user_id, participant)
        {:noreply, maybe_empty(sync_media(state))}

      # Re-bound (or already removed) — stale expiry, ignore.
      _ ->
        {:noreply, state}
    end
  end

  def handle_info(:sweep_empty, state) do
    if map_size(state.participants) == 0 do
      end_call(state, if(state.stale_adoption, do: "swept", else: "last_left"))
    else
      # Stale timer raced a join (the join cancels, but the message may
      # already be in flight) — the call is live, keep going.
      {:noreply, state}
    end
  end

  # AM3 mid-call eviction: a rights-epoch bump for THIS room's workspace
  # re-checks every participant's live VIEW_CHANNEL — failures are
  # force-left (media teardown signal for U5 + the roster update). The call
  # itself survives until the empty sweep if everyone goes.
  def handle_info({:rights_epoch_bumped, ws_id, _epoch}, state) do
    if state.workspace_id == ws_id do
      {state, evicted} =
        Enum.reduce(state.participants, {state, []}, fn {user_id, participant}, {acc, gone} ->
          if join_permitted?(acc, user_id) do
            {acc, gone}
          else
            :ok =
              Events.emit(
                :call_update,
                Events.call_update(acc.channel_id, acc.call_id, user_id, participant.leg_id, "forced_leave")
              )

            {drop_participant(acc, user_id, participant), [user_id | gone]}
          end
        end)

      # V2 (R13/KTD6): per-source recheck — a failed SEND_VIDEO/SHARE_SCREEN
      # unpublishes that source with a notice; only a failed VIEW_CHANNEL
      # evicted above. Nothing to do for DM rooms (no bits there).
      state =
        Enum.reduce(state.participants, state, fn {user_id, participant}, acc ->
          Enum.reduce(Map.keys(participant.sources || %{}), acc, fn source, acc2 ->
            case source_permitted?(acc2, user_id, source) do
              :ok -> acc2
              {:error, _} -> unpublish_silent(acc2, user_id, source)
            end
          end)
        end)

      if evicted != [], do: :telemetry.execute([:cytale, :calls, :forced_leave], %{count: length(evicted)}, %{})

      {:noreply, maybe_empty(sync_media(state))}
    else
      {:noreply, state}
    end
  end

  # op 23 relay mailbox (U4→U5): the gateway validated the sender IS a
  # current participant and forwarded the opaque body tagged with the
  # sender's session. The media plane applies SDP answers and ICE
  # candidates; anything malformed/early is dropped inside (never a crash
  # on unmatched traffic).
  def handle_info({:call_signal, user_id, _session_pid, kind, body}, state) do
    media =
      Media.handle_signal(state.media, state.channel_id, user_id, kind, body, Map.keys(state.participants))

    {:noreply, %{state | media: media}}
  end

  # U5: every ex_webrtc notification from a server PC (the room is each
  # PC's controlling process). RTP forwards (minus deafened recipients,
  # AM12), local ICE trickles out, :failed drives the restart-once-then-
  # remove policy, and {:remove, user_id} is the voice-unavailable exit.
  def handle_info({:ex_webrtc, pc, msg}, state) do
    case Media.handle_ex_webrtc(state.media, state.channel_id, {:ex_webrtc, pc, msg}, deafened_users(state)) do
      {:ok, media} ->
        {:noreply, %{state | media: media}}

      {:remove, user_id, media} ->
        {:noreply, remove_for_media_failure(%{state | media: media}, user_id)}
    end
  end

  # U5: PCs link to the room (trap_exit) — a PC crash is a message, never
  # a room-killer; our own stops arrive here as :normal with the leg
  # already forgotten (ignored inside Media.pc_exit).
  def handle_info({:EXIT, pc, reason}, state) do
    case Media.pc_exit(state.media, pc, reason) do
      {:ok, media} ->
        {:noreply, %{state | media: media}}

      {:remove, user_id, media} ->
        {:noreply, remove_for_media_failure(%{state | media: media}, user_id)}
    end
  end

  # -- End path ----------------------------------------------------------------------

  defp end_call(state, reason) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    unless state.dm do
      Repo.execute!(
        "UPDATE {{K}}.calls SET ended_at = ?, ended_reason = ? WHERE channel_id = ? AND call_id = ?",
        [
          {"timestamp", now},
          {"text", reason},
          {"bigint", state.channel_id},
          {"bigint", state.call_id}
        ]
      )

      # Release the live index LAST (hardening plan 4.13). If this write is lost
      # — process killed here — the row survives as a candidate that the next
      # sweep reads once and discards; releasing it FIRST would leave an open
      # `calls` row the sweep cannot see, which is the orphan the sweep exists
      # to close.
      Cytale.Calls.mark_closed(state.channel_id)
    end

    if state.workspace_id, do: RightsEpoch.unsubscribe(state.workspace_id)

    # U5: every server PC goes down with the room (no orphan processes —
    # the room's exit also kills the linked PCs, this is the graceful arm).
    Media.teardown_all(state.media)

    :ok = Events.emit(:call_end, Events.call_end(state.channel_id, state.call_id, reason, now))

    # Demonitors are unnecessary (monitors die with the process); the
    # registry entry is reclaimed by the name system on exit.
    {:stop, :normal, state}
  end

  # -- Internals ---------------------------------------------------------------------

  # U5: reconcile the media fleet against the current roster — called after
  # EVERY participants-map mutation (join/displacement/leave/grace/eviction/
  # media-failure removal).
  defp sync_media(state) do
    %{state | media: Media.roster_changed(state.media, state.channel_id, Map.keys(state.participants))}
  end

  # U5: the AM12 forwarding exclusion set (deafened participants receive
  # nothing; mute never gates the sender — a muted client stops sending).
  defp deafened_users(state) do
    MapSet.new(for {user_id, p} <- state.participants, p.deafen, do: user_id)
  end

  # U5 voice-unavailable exit (PC crash, or a second :failed after the one
  # ICE restart): the leg leaves with the ordinary `left` wire state and
  # everyone else's egress reconciles through the roster sync.
  defp remove_for_media_failure(state, user_id) do
    case Map.get(state.participants, user_id) do
      nil ->
        state

      participant ->
        :ok =
          Events.emit(
            :call_update,
            Events.call_update(state.channel_id, state.call_id, user_id, participant.leg_id, "left")
          )

        state = drop_participant(state, user_id, participant)
        maybe_empty(sync_media(state))
    end
  end

  # The live join gate. DM rooms: participation. Workspace channels: the
  # resolver's VIEW_CHANNEL (the same check `Cytale.Calls.can_join_call?/2`
  # runs). A channel with NO resolvable row (the U3 room tests' bare
  # snowflake ids) has nothing to check against — and cannot be reached
  # through the gateway, whose own gate rejects unknown channels first.
  defp join_permitted?(%{dm: true, channel_id: channel_id}, user_id) do
    Workspaces.get_dm(channel_id) |> Workspaces.dm_participant?(user_id)
  end

  defp join_permitted?(%{workspace_id: nil}, _user_id), do: true

  defp join_permitted?(%{channel_id: channel_id}, user_id) do
    Cytale.Calls.can_join_call?(channel_id, user_id)
  end

  # V2 publish gate (R13/KTD3): participant + bit + media-setting
  # capability. DM rooms skip the bit and the CHANNEL override (workspace
  # master still governs — R16 applies to DMs too; the master check rides
  # can_publish_source? below). Channel rooms: SEND_VIDEO for camera,
  # SHARE_SCREEN for screen and screen_audio (share-audio is at least as
  # sensitive as the screen — never ungated).
  defp publish_permitted?(state, user_id, source) do
    cond do
      not Map.has_key?(state.participants, user_id) -> {:error, :not_participant}
      true -> source_permitted?(state, user_id, source)
    end
  end

  # DM rooms: participation IS authorization — capability checks are
  # vacuous there by the landed U8 contract (effective_capabilities(nil,
  # _) is all-true), so DMs permit every source. The channel clause below
  # carries the real check. A channel with NO resolvable row (the U3 room
  # tests' bare snowflake ids) mirrors join_permitted?'s escape: the
  # gateway's own gate rejects unknown channels first in production.
  defp source_permitted?(%{dm: true}, _user_id, _source), do: :ok

  defp source_permitted?(%{workspace_id: nil}, _user_id, _source), do: :ok

  defp source_permitted?(%{workspace_id: ws_id, channel_id: channel_id}, user_id, source) do
    caps = Cytale.Workspaces.MediaSettings.effective_capabilities(ws_id, channel_id)

    if caps[source_cap_key(source)] and
         Cytale.Calls.can_publish_source?(channel_id, user_id, source) do
      :ok
    else
      {:error, :denied}
    end
  end

  defp source_cap_key(:camera), do: :video
  defp source_cap_key(_screen_or_share_audio), do: :screenshare

  defp wire_on(:camera), do: "camera_on"
  defp wire_on(:screen), do: "screen_on"
  defp wire_on(:screen_audio), do: "screen_audio_on"

  defp wire_off(:camera), do: "camera_off"
  defp wire_off(:screen), do: "screen_off"
  defp wire_off(:screen_audio), do: "screen_audio_off"

  # The epoch arm's silent unpublish (no client op): roster event only.
  defp unpublish_silent(state, user_id, source) do
    case Map.get(state.participants, user_id) do
      nil ->
        state

      participant ->
        participant = %{participant | sources: Map.delete(participant.sources || %{}, source)}
        state = put_participant(state, user_id, participant)
        emit_one(state, user_id, participant.leg_id, wire_off(source), Atom.to_string(source))

        %{
          state
          | media: Media.set_source(state.media, user_id, state.channel_id, source, false, Map.keys(state.participants))
        }
    end
  end

  # The join body (shared by the permitted join clause): mint the leg,
  # displace an existing one (AM8), clear emptiness, report `joined`.
  # Returns `{result, new_state}` — the caller replies with the former and
  # continues with the latter.
  defp join_state(user_id, session_pid, state) do
    leg_id = Integer.to_string(Cytale.Snowflake.next())
    monitor = Process.monitor(session_pid)

    state =
      case Map.get(state.participants, user_id) do
        nil ->
          put_participant(state, user_id, %{
            session_pid: session_pid,
            monitor: monitor,
            leg_id: leg_id,
            mute: false,
            deafen: false,
            grace_timer: nil,
            sources: %{}
          })

        # AM8 displacement: the second device's join replaces the first leg
        # (fresh monitor + leg id); the loser learns via `displaced` on its
        # own leg discriminator. Covers the grace case too: a re-bind
        # (same user, new pid) cancels the grace timer instead of losing
        # the voice leg (AM4). U5: the old PC is dropped outright — the
        # trailing roster sync builds a fresh one for the new device.
        existing ->
          cancel_grace(state, user_id)

          :ok =
            Events.emit(
              :call_update,
              Events.call_update(state.channel_id, state.call_id, user_id, existing.leg_id, "displaced")
            )

          if existing.monitor, do: Process.demonitor(existing.monitor, [:flush])

          state = %{state | media: Media.drop_leg(state.media, user_id)}

          put_participant(state, user_id, %{
            session_pid: session_pid,
            monitor: monitor,
            leg_id: leg_id,
            mute: existing.mute,
            deafen: existing.deafen,
            grace_timer: nil,
            sources: %{}
          })
      end

    # Any join clears emptiness, cancels the idle sweep, and de-flags a
    # stale adoption (from here on the call is genuinely live again).
    state = cancel_sweep(%{state | empty_since: nil, stale_adoption: false})

    :ok =
      Events.emit(
        :call_update,
        Events.call_update(state.channel_id, state.call_id, user_id, leg_id, "joined")
      )

    # U5: a new leg means a new server PC (and egress churn for everyone
    # else) — reconcile the media fleet against the post-join roster.
    state = sync_media(state)

    {%{call_id: state.call_id, thread_id: state.thread_id, leg_id: leg_id}, state}
  end

  defp maybe_empty(state) do
    if map_size(state.participants) == 0,
      do: arm_empty_sweep(%{state | empty_since: DateTime.utc_now() |> DateTime.truncate(:millisecond)}),
      else: state
  end

  defp arm_empty_sweep(state) do
    cancel_sweep(state)
    timer = Process.send_after(self(), :sweep_empty, sweep_ms())
    %{state | empty_since: DateTime.utc_now() |> DateTime.truncate(:millisecond), sweep_timer: timer}
  end

  defp cancel_sweep(state) do
    if state.sweep_timer, do: Process.cancel_timer(state.sweep_timer)
    %{state | sweep_timer: nil}
  end

  defp cancel_grace(state, user_id) do
    case Map.get(state.participants, user_id) do
      %{grace_timer: timer} = participant when not is_nil(timer) ->
        Process.cancel_timer(timer)
        put_participant(state, user_id, %{participant | grace_timer: nil})

      _ ->
        state
    end
  end

  defp put_participant(state, user_id, participant),
    do: %{state | participants: Map.put(state.participants, user_id, participant)}

  defp drop_participant(state, user_id, participant) do
    if participant.monitor, do: Process.demonitor(participant.monitor, [:flush])
    if participant.grace_timer, do: Process.cancel_timer(participant.grace_timer)
    %{state | participants: Map.delete(state.participants, user_id)}
  end

  defp find_by_monitor(state, ref) do
    Enum.find(state.participants, fn {_uid, p} -> p.monitor == ref end)
  end

  # Deafen/mute wire transitions: the deafen change wins when both flip
  # (deafened implies the mute — AM12 — so one state covers it).
  defp emit_state_change(state, user_id, previous, updated) do
    cond do
      previous.deafen != updated.deafen ->
        emit_one(state, user_id, updated.leg_id, if(updated.deafen, do: "deafened", else: "undeafened"))

      previous.mute != updated.mute ->
        emit_one(state, user_id, updated.leg_id, if(updated.mute, do: "muted", else: "unmuted"))

      true ->
        :ok
    end
  end

  defp emit_one(state, user_id, leg, wire_state, source \\ nil) do
    Events.emit(:call_update, Events.call_update(state.channel_id, state.call_id, user_id, leg, wire_state, source))
  end

  # AM6: one ring per call — the sink computes the eligible targets
  # (connected, live VIEW_CHANNEL, not notification-muted; U4's publisher).
  defp emit_ring(state, from_user) do
    :ok = Events.emit(:call_ring, Events.call_ring(state.channel_id, state.call_id, from_user))
  end

  defp snapshot(state) do
    %{
      channel_id: state.channel_id,
      call_id: state.call_id,
      thread_id: state.thread_id,
      started_by: state.started_by,
      started_at: state.started_at,
      dm: state.dm,
      ring: state.ring,
      workspace_id: state.workspace_id,
      participants:
        Enum.map(state.participants, fn {user_id, p} ->
          %{user_id: user_id, mute: p.mute, deafen: p.deafen, leg: p.leg_id, sources: p.sources}
        end)
    }
  end

  defp sweep_ms, do: Cytale.Config.calls_empty_sweep_ms()
  defp grace_ms, do: Cytale.Config.calls_session_grace_ms()
end
