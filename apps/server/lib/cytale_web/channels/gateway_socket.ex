defmodule CytaleWeb.GatewaySocket do
  @moduledoc """
  The Cytale real-time gateway (U10): a raw `WebSock` handler mounted at
  `GET /gateway/websocket` via WebSockAdapter, speaking the Discord-shaped
  protocol of U2 (`packages/protocol`).

      connect ─▶ Hello(op 10) ─▶ Identify(op 2) | Resume(op 5)
                ◀─ READY / Resumed dispatch        │
                      │                            │
             steady state: op1 → op11 heartbeats, seq-numbered dispatches,
             TYPING_START(20) throttled fan-out, MESSAGE_ACK(21) ack loop

  A raw WebSock (rather than Phoenix.Socket) keeps the wire format exactly the
  U2 envelope — no channel framing — while owning compression and close codes.

  ## Session modes (U7, KTD5 — keyed on credential type)

  The wire dialect is decided by the VERIFIED identity, never the client:

    * `:native` (`cytale_` / human JWT): CamelCase dispatch names, minimal
      READY, `v` = 1 — byte-identical to the pre-U7 gateway.
    * `:compat` (`cytbot_` machine credentials): Discord READY + a
      synthesized GUILD_CREATE per workspace, SCREAMING_SNAKE dispatch names
      with Discord payload shapes (shared compat codec), intents from
      Identify, and the intents ⊗ visible-set dispatch filter (before
      buffering — filtered events never consume a seq, so resume replay is
      filtered-consistent). Version gate: `v` = 10 or the interop `v` = 1;
      an absent `v` is accepted (Discord libraries carry the version in the
      connection URL, which Hello echoes back in `d.v`).

  The dialect mechanics themselves — the intents table + validation, the
  dispatch filter + translation, the visibility memo, the resume replay
  re-filter and the READY/GUILD_CREATE handshake — live in
  `CytaleWeb.Compat.GatewayDialect`; this socket owns lifecycle + wire I/O
  and folds the dialect's returned state slices (visible-set memo, author
  cache) back into its own state.

  `?compress=zlib-stream` on the connection URL opts the whole transport into
  the shared zlib stream (every frame binary-compressed, `00 00 ff ff`
  framing) — Discord's transport compression, distinct from the per-payload
  `d.compress` negotiation.

  ## Phases (`state.phase`)

      :awaiting_hello → :identifying → :connected

  * `init/1` sends Hello(op 10) carrying `heartbeat_interval`, supported
    compression modes and accepted protocol version inside `d`.
  * Identify passing auth + version checks mints + claims a session and
    dispatches READY; Resume on a stored session takes the replay path.
  * Dispatches flow through `buffer_and_send_dispatch/3`, keeping the resume
    buffer in the stored session record and the wire push in lockstep.
  * Heartbeats refresh a wall-clock last-beat stamp; periodic checks close
    links whose last beat is older than `Session.max_missed_heartbeats/0`
    intervals.

  ## Planned-shutdown drain

  The endpoint's shutdown drain hook calls `drain_shutdown/0`: Reconnect
  frames (op 6 native / op 7 compat — the Discord dialect maps its Resume to
  6, so the server-pushed Reconnect there is 7) go to every live session
  staggered ~4/sec with ±40% jitter before Bandit closes sockets (server
  half of U19's client-side jitter policy).
  """

  @behaviour WebSock
  require Logger

  alias Cytale.Accounts.Principals
  alias Cytale.Gateway.AdmissionLimiter
  alias Cytale.Gateway.Authenticator
  alias Cytale.Gateway.Compression
  alias Cytale.Gateway.Opcode
  alias Cytale.Gateway.ProtocolError
  alias Cytale.Gateway.PreEncoded
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Gateway.Session
  alias Cytale.Gateway.PresenceStatus
  alias Cytale.Gateway.SessionStore
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.GatewayDialect

  # -- Tunables ---------------------------------------------------------------

  @heartbeat_interval_ms 30_000
  # Per user+channel TYPING_START floor (review #22). Clients emit about once
  # per ~5 s while composing (the receiver expires an indicator after 8 s), so
  # this never swallows a well-behaved emit — even one on a 1 s cadence still
  # refreshes receivers well inside their expiry — while a client that ignores
  # its own interval fans out at most once per window.
  @typing_throttle_ms 2_500
  @accepted_version 1

  # Voice call ops (calls plan U4). op 22 is human-paced control (start/
  # join/leave/state + ring) — the typing window. op 23 is bursty-but-brief
  # media signaling (SDP answers + ICE trails, KTD3) — a tight window that
  # still caps the stream well under the resume-buffer budget. Both swallow
  # silently on saturation (typing precedent) and count
  # `[:cytale, :gateway, :call_throttled]`.
  @call_op_throttle_ms 900
  @call_signal_throttle_ms 50

  # V2 SEC-1/COR-6: publish/unpublish get their OWN window (keyed
  # {:call_publish, cid}, stamped only by these actions) — full exemption
  # would remove the only bound on the resolver-consulting op, while
  # stamping the shared 900 ms key let a publish burst suppress
  # same-session state ops. Rapid toggles stay legitimate (KTD3): 300 ms
  # is under the room's renegotiation coalescing anyway.
  @publish_throttle_ms 300

  # op 23 body cap (CALL_SIGNAL_BODY_MAX_BYTES — raised to 128 KiB by the V2
  # spike (arm b): 25-participant simulcast offers + multi-share worst cases
  # breach 64 KiB; see the research doc's "V2 spike" section.
  # constant the protocol package mirrors).
  @call_signal_body_max_bytes 131_072

  @call_actions ~w(start join leave state publish unpublish)
  @video_want_window_ms 2_000
  @call_signal_kinds ~w(sdp ice)

  # WebSocket close codes (Discord-shaped)
  @close_unknown_error 4000
  @close_decode_error 4001
  @close_unknown_opcode 4002
  @close_not_authenticated 4003
  @close_auth_failed 4004
  @close_already_authenticated 4005
  @close_invalid_seq 4007
  @close_rate_limited 4008
  @close_session_timeout 4009

  @doc "The intent bits whose events this gateway actually delivers."
  @spec supported_intents() :: non_neg_integer()
  defdelegate supported_intents(), to: GatewayDialect

  defstruct [
    :compressor,
    :decoder,
    :phase,
    :session_id,
    :user_id,
    :identity,
    :typing_last_at,
    :remote_ip,
    :last_sent_seq,
    :gateway_base_url,
    :url_v,
    :visible,
    # PERF-2 (B3b): author_id => {expires_at_ms, {author_object, kind}} —
    # `Cytale.Gateway.AuthorCache` owns the rules; one Principals/Users
    # read per author per TTL instead of per dispatch.
    author_cache: %{},
    mode: :native,
    intents: 0,
    transport_mode: nil,
    typing_emitted: 0,
    acks_recorded: 0,
    # #117: scope_id => the watermark this socket already persisted, so a
    # repeated ack of an id it has already written skips the storage round
    # trip. Session-local by design (it is an optimization, never a source of
    # truth — storage is read back for the advance guard).
    acks_advanced: %{},
    # Calls plan U4: per-session call-op throttle stamps, keyed
    # {op_name, channel_id} (the typing throttle mechanism, both call ops).
    call_last_at: %{},
    # Inbound frame budget (5a): the current window's start (monotonic ms)
    # and the frames counted in it. Every frame counts — heartbeats
    # included — like Discord's 120 / 60 s.
    frame_window_at: nil,
    frame_count: 0,
    # Presence op 3 throttle (5c): monotonic stamps of the accepted updates
    # inside the current window, newest first.
    presence_stamps: []
  ]

  @type t :: %__MODULE__{}

  # -- Upgrade mount ------------------------------------------------------------

  @doc "Router upgrade hook."
  @spec upgrade(Plug.Conn.t()) :: Plug.Conn.t()
  def upgrade(%Plug.Conn{} = conn) do
    query = Plug.Conn.fetch_query_params(conn).query_params

    # Transport compression (owner direction 2026-09-23: stop dancing around
    # zstd): `?compress=` selects the WHOLE-WIRE codec — `zlib-stream` (the
    # zlib-WRAPPED stream, #61 item 3; the only transport pre-zstd libraries
    # speak) or `zstd-stream` (Discord's modern default — discord.py ≥2.5
    # speaks ZSTD ONLY, and its Identify `compress: true` refers to TRANSPORT
    # compression, not legacy per-payload zlib; leaving zstd un-honored made
    # such clients read no-transport text frames while the boolean armed our
    # per-payload zlib — the first binary frame then detonated their zstd
    # decompressor. The discord.py leg found it live 2026-09-23).
    #
    # A negotiated transport OWNS the wire: every frame, handshake included,
    # rides the one stream (see connection_codec/wire_frames), and the
    # Identify payload negotiation is inert under it.
    transport_mode =
      case query["compress"] do
        c when c in ["zlib-stream", "zlib_stream"] -> :zlib_stream_transport
        # The persistent STREAMING context — each message is a flushed chunk
        # of ONE zstd stream, which is what discord.py's decompressor feeds
        # on per message (verified against both its stdlib and zstandard
        # paths 2026-09-23; one-shot independent frames break its stdlib
        # object on the second message).
        c when c in ["zstd-stream", "zstd_stream"] -> :zstd_stream
        _ -> nil
      end

    compressor =
      if transport_mode,
        do: Compression.init(transport_mode),
        else: Compression.init(:none)

    # Inbound decoding exists solely for zlib-transport clients that compress
    # their own frames (the defensive decoder the zlib era shipped). Zstd
    # transports send plain JSON text inbound — Discord's transport
    # compression is server→client — so nothing to decode there.
    decoder =
      if transport_mode == :zlib_stream_transport,
        do: Compression.decoder_init(:zlib_stream_transport),
        else: Compression.decoder_init(:none)

    state = %__MODULE__{
      compressor: compressor,
      decoder: decoder,
      phase: :awaiting_hello,
      typing_last_at: %{},
      # The CLIENT address CytaleWeb.Plugs.RemoteIp derived from the trusted
      # proxy's X-Forwarded-For — the TCP peer is Caddy for every socket.
      remote_ip: format_ip(conn.remote_ip),
      # Discord compat: the connection URL carries the requested version
      # (compat clients arrive via `/gateway/bot`'s ?v=10 URL) — Hello
      # echoes it back. `?compress=` selects transport compression (zlib
      # or zstd stream over EVERY frame).
      url_v: parse_url_v(query["v"]),
      # Compat READY's resume_gateway_url source: the SHARED compat gateway
      # URL builder (CytaleWeb.Compat.GatewayUrl via the dialect — the same
      # one /gateway/bot serves), rebuilt from the upgrade request.
      gateway_base_url: GatewayDialect.gateway_base_url(conn),
      transport_mode: transport_mode
    }

    WebSockAdapter.upgrade(conn, __MODULE__, state,
      timeout: 90_000,
      max_frame_size: 1_000_000
    )
  end

  defp parse_url_v(term), do: int_id(term)

  defp format_ip({a, b, c, d}), do: "#{a}.#{b}.#{c}.#{d}"
  defp format_ip(tuple) when is_tuple(tuple), do: inspect(tuple)
  defp format_ip(_), do: "unknown"

  # --------------------------------------------------------------------------
  # WebSock callbacks
  # --------------------------------------------------------------------------

  @impl true
  def init(state) do
    # #52: bound this session's memory. The fan-out writes into this process's
    # mailbox with an unguarded send/2, so a client that stops draining the
    # wire queues the backlog HERE — and at launch the gateway, every
    # workspace, and presence share one VM (single node by design), so an
    # unbounded mailbox is a whole-deployment outage. The VM kills the process
    # at the bound instead.
    #
    # `kill: true` is untrappable, so terminate/1 does NOT run on this path:
    # the dead PID drops out of PushRegistry at read time (liveness-filtered)
    # and the session's principal slot is reclaimed by the dead-holder check,
    # but the session record is left `:connected` with the drop UNRECORDED.
    # That is recovered where the record is next used — the resume path
    # discovers the abandoned session (`recover_abandoned/1`) and the shard
    # sweeper reaps it — so the client's cost is its connection, not its
    # session: it resumes rather than re-identifying and full-syncing.
    #
    # `size` is in WORDS (the VM's unit); config carries bytes.
    Process.flag(:max_heap_size, %{
      size: div(Cytale.Config.gateway_socket_max_heap_bytes(), :erlang.system_info(:wordsize)),
      kill: true,
      error_logger: true,
      # Count refc binaries too (Tier 2 #3): a backlog of shared dispatch
      # bodies or inflated frames lives OFF-heap and would escape the bound.
      include_shared_binaries: true
    })

    # Arm the heartbeat checker at socket birth (not at Identify): the first
    # link-liveness deadline must not drift by a full interval from when the
    # handshake completes. Unauthenticated sockets no-op inside the checker.
    Process.send_after(self(), :check_heartbeats, div(@heartbeat_interval_ms, 2))

    # 5b: a socket that never identifies (or resumes) is closed — an
    # unauthenticated connection must not hold a process and a Hello forever.
    Process.send_after(self(), :identify_deadline, Cytale.Config.gateway_identify_timeout_ms())

    hello =
      Session.hello_frame(@heartbeat_interval_ms)
      |> Map.update!(:d, fn d ->
        # Echo the connection URL's requested version (compat clients arrive
        # via /gateway/bot's ?v=10 URL; native connections see v=1).
        Map.merge(d, %{
          compression_modes: Session.hello_compression_offer(),
          v: hello_version(state)
        })
      end)

    {:push, encode_many(state.compressor, [hello]), %{state | phase: :identifying}}
  end

  defp hello_version(%__MODULE__{url_v: v}) when is_integer(v), do: v
  defp hello_version(_state), do: @accepted_version

  @impl true
  def handle_in({data, opcode: opcode}, state) do
    case count_frame(state) do
      {:ok, state} ->
        handle_frame(data, opcode, state)

      :over_budget ->
        Logger.info("gateway close #{@close_rate_limited}: inbound frame budget exceeded")
        {:stop, :normal, @close_rate_limited, [], state}
    end
  end

  # 5a: the per-socket inbound budget — `gateway_frame_budget/0` frames per
  # `gateway_frame_window_ms/0` (default 120 / 60 s, Discord's figure), a
  # fixed window anchored at its first frame. Every frame counts before it is
  # even decoded, so a flood of garbage or of cheap ops (typing, acks,
  # presence) is bounded the same way; the close is 4008 (rate limited).
  defp count_frame(%__MODULE__{} = state) do
    now = System.monotonic_time(:millisecond)
    window = Cytale.Config.gateway_frame_window_ms()

    {started, count} =
      case state.frame_window_at do
        at when is_integer(at) and now - at < window -> {at, state.frame_count + 1}
        _ -> {now, 1}
      end

    if count > Cytale.Config.gateway_frame_budget(),
      do: :over_budget,
      else: {:ok, %{state | frame_window_at: started, frame_count: count}}
  end

  defp dispatch_push(state, event_name, payload, pre_encoded) do
    if state.mode == :compat do
      try do
        gateway_push(state, event_name, payload, pre_encoded)
      rescue
        e ->
          Logger.error(
            "gateway compat dispatch dropped (translate error) " <>
              "session=#{inspect(state.session_id)} event=#{event_name}: " <>
              Exception.format(:error, e, __STACKTRACE__)
          )

          :telemetry.execute([:cytale, :gateway, :compat_push_error], %{}, %{
            event: event_name,
            session_id: state.session_id
          })

          {:ok, state}
      end
    else
      gateway_push(state, event_name, payload, pre_encoded)
    end
  end

  @impl true
  def handle_info(:check_heartbeats, state) do
    Process.send_after(self(), :check_heartbeats, div(@heartbeat_interval_ms, 2))

    with sid when is_binary(sid) <- state.session_id,
         %Session{} = session <- SessionStore.get(sid) do
      check_link(session, state)
    else
      _ -> {:ok, state}
    end
  end

  # 5b: the Identify deadline. A socket still unidentified (no session bound)
  # when it fires is closed 4003 (not authenticated).
  def handle_info(:identify_deadline, %__MODULE__{session_id: nil} = state) do
    Logger.info("gateway close #{@close_not_authenticated}: no Identify within the deadline")
    {:stop, :normal, @close_not_authenticated, [], state}
  end

  def handle_info(:identify_deadline, state), do: {:ok, state}

  def handle_info(:drain_now, state), do: drain_this_socket(state)

  # Principal-targeted teardown (bots plan U4, KTD6): the credential died
  # (revoke/regenerate/parent-delete) — close 4004, non-reconnectable. The
  # store already purged the session record, so Resume cannot resurrect.
  def handle_info({:cytale_principal_close, close_code}, state)
      when is_integer(close_code) do
    {:stop, :normal, close_code, [], state}
  end

  # Restriction-profile teardown: push the server Reconnect frame (the
  # credential is STILL VALID — 4004 would brick every live bot client,
  # KTD6), then close; the client library reconnects and re-Identifies,
  # picking up the narrowed profile. The frame is DIALECT-AWARE: compat
  # (Discord) sessions receive op 7 — on their wire, op 6 is the CLIENT
  # Resume — while native sessions keep the native op 6. Mirror of the drain
  # path's frame encoding.
  def handle_info(:cytale_principal_reconnect, state) do
    {:stop, :normal, 1000, encode_many(state.compressor, [Session.reconnect_frame(state.mode)]), state}
  end

  # Session-backed fan-out dispatches (typing, acks, later MESSAGE_CREATE):
  # seq-stamped into the stored record BY THIS SOCKET (the claim holder is
  # the record's single writer — direct ETS, no store GenServer hop),
  # appended to the resume buffer, THEN written to the wire — a client that
  # drops right after receiving seq N can Resume from N exactly.
  #
  # U7 compat sessions: the intents ⊗ visible-set filter runs HERE, BEFORE
  # buffer_dispatch — a filtered event never consumes a seq, so the resume
  # replay stays filtered-consistent. Survivors are translated (SCREAMING
  # dispatch names + Discord payload shapes via the shared compat codec).
  #
  # The compat translate+buffer path does point reads (channel/thread rows,
  # author resolution) and is best-effort by contract: a raising translation
  # is LOGGED + counted and the event DROPPED for that session (fail closed —
  # never over-deliver, never crash the socket; a poisoned payload must not
  # take the link down). Native sessions run the same pipeline WITHOUT the
  # wrapper: they do no reads on this path (no translation, buffer is
  # store-only) and stay byte-identical to the pre-U7 gateway.
  # `pre_encoded` (hardening plan 2.3): the fan-out already JSON-encoded this
  # payload once for every recipient. It is usable only when nothing rewrote the
  # payload on the way in — see `gateway_push/4`.
  def handle_info({:cytale_gateway_push, _from_pid, {event_name, payload}, pre_encoded}, state)
      when is_binary(event_name) do
    dispatch_push(state, event_name, payload, pre_encoded)
  end

  # The measured form (review #20): the publisher carried the monotonic ms the
  # REST layer ACCEPTED the write, and `[:cytale, :message, :deliver_ms]` is
  # emitted here — at the push to this recipient's wire — so the number is
  # accept→deliver end to end (persist, publish cast, fan-out queue, this
  # socket's mailbox), not a slice of it. A dropped (filtered) event records
  # nothing: it was never delivered.
  def handle_info({:cytale_gateway_push, _from_pid, {event_name, payload}, pre_encoded, meta}, state)
      when is_binary(event_name) do
    result = dispatch_push(state, event_name, payload, pre_encoded)

    case {result, meta} do
      {{:push, _frames, _state}, %{accepted_at: accepted_at}} when is_integer(accepted_at) ->
        :telemetry.execute(
          [:cytale, :message, :deliver_ms],
          %{duration_ms: max(0, System.monotonic_time(:millisecond) - accepted_at)},
          %{event: event_name}
        )

      _ ->
        :ok
    end

    result
  end

  # The 3-element form still exists: point-to-point senders (the call-event
  # deliverer, the relay, the socket's own self-pushes) have exactly one
  # recipient, so there is nothing to pre-encode and no fragment to carry.
  def handle_info({:cytale_gateway_push, _from_pid, {event_name, payload}}, state)
      when is_binary(event_name) do
    dispatch_push(state, event_name, payload, nil)
  end

  # KTD4's member-add consumer clause: a parent joining a workspace bumps the
  # epoch AND actively pokes the parent's live principal sessions (lazy
  # epoch checks alone cannot discover events that never reach the socket —
  # the NEW workspace's routes must be subscribed before its events flow).
  #
  # #55 widened what the poke MEANS: it now also announces a channel ADDED to a
  # workspace the session already belongs to. The memo refresh alone cannot
  # cover that case — the workspace SET is unchanged, so nothing re-subscribes
  # — which is why both identified clauses re-sync routes explicitly. The memo
  # stays the enforcement point; routes are delivery plumbing.
  def handle_info(:cytale_refresh_routes, %__MODULE__{mode: :compat} = state) do
    visible = GatewayDialect.refresh_visibility(state.visible, state.identity, rejoin: true)
    refresh_fanout_routes(state.identity.id)
    {:ok, %{state | visible: visible}}
  end

  def handle_info(:cytale_refresh_routes, %__MODULE__{identity: %{id: user_id}} = state) do
    # #111: the NATIVE twin of the compat clause above — same shape, same
    # rejoin. Routes alone are not enough here: a session that identified
    # before the membership seeded an EMPTY visible memo, and `epoch_moved?/1`
    # only inspects workspaces the memo already lists, so a NEW workspace never
    # trips it — every channel-anchored dispatch (MESSAGE_CREATE among them,
    # the exact event #111 measured) stays fail-closed dropped despite the
    # fresh route keys. `rejoin: true` forces the full re-list (current
    # memberships in, new workspace admitted); a workspace-SET change
    # additionally queues the `:cytale_rejoin_routes` join tail (routes +
    # presence establishment) — the same establishment a fresh join would
    # have run.
    visible = GatewayDialect.refresh_visibility(state.visible, state.identity, rejoin: true)
    refresh_fanout_routes(user_id)
    {:ok, %{state | visible: visible}}
  end

  def handle_info(:cytale_refresh_routes, state), do: {:ok, state}

  # Route-set delta (join/kick/delete detected by refresh_visibility):
  # rebuild this socket's fan-out subscriptions in place — the sync is
  # insert-first, so an additive rejoin (new workspace) never drops the
  # socket's existing routes mid-flight.
  def handle_info(:cytale_rejoin_routes, %__MODULE__{identity: %{id: user_id}} = state) do
    join_fanout_routes(user_id)
    {:ok, state}
  end

  def handle_info(:cytale_rejoin_routes, state), do: {:ok, state}

  # Anything else (stray :check_heartbeats before Identify, etc.) is ignored.
  # The deferred read-state sync (lane D #5): queued by the Identify/Resume
  # tails so READY/RESUMED leave first. A socket that went away (or never
  # finished identifying) in between has nothing to sync.
  def handle_info(:cytale_emit_read_state_sync, %__MODULE__{phase: :connected} = state) do
    emit_read_state_sync(state)
    {:ok, state}
  end

  def handle_info(_msg, state), do: {:ok, state}

  # The shared push body (see the compat-wrapped handle_info above): filter
  # (compat), translate, seq-stamp + buffer, then wire-push.
  defp gateway_push(state, event_name, payload, pre_encoded) do
    case compat_dispatch(state, event_name, payload) do
      {state, :drop} ->
        {:ok, state}

      {state, {name, compat_payload}} ->
        # The fragment rides only when the payload came through UNTRANSLATED: a
        # compat dialect rewrites the shape, so its bytes are not these bytes.
        # `===` is structural, and a native pass-through is the identical term
        # (hardening plan 2.3).
        fragment = if pre_encoded != nil and compat_payload === payload, do: pre_encoded, else: nil

        case buffer_dispatch(state, name, compat_payload, fragment) do
          {envelope, :ok} ->
            {:push, encode_many(state.compressor, [envelope]), state}

          {_envelope, {:error, :unknown_session}} ->
            # Record gone (expired/swept mid-flight): deliver live anyway but
            # sequence-less — the client full-syncs; nothing to resume against.
            fallback = %{op: Opcode.dispatch(), t: name, s: 0, d: compat_payload}
            {:push, encode_many(state.compressor, [fallback]), state}
        end
    end
  end

  # -- U7 visibility: the principal-route poke (KTD4's active half) -----------
  #
  # The per-socket memo itself (workspace_id → {epoch, MapSet(visible channel
  # ids)}, refreshed against `RightsEpoch.current/1`, rejoining routes when
  # the workspace set changes) lives in `CytaleWeb.Compat.GatewayDialect`;
  # this side only POKES live principal sockets so their next refresh sees
  # the new workspace before its events flow.

  @doc """
  KTD4's active half: refresh route subscriptions for every LIVE machine
  session of `parent_user_id` (called by the member-add paths after the
  epoch bump). The poke re-runs each socket's join computation additively —
  the new workspace's events reach live agents without a reconnect.
  """
  @spec refresh_principal_routes(integer()) :: :ok
  def refresh_principal_routes(parent_user_id) when is_integer(parent_user_id) do
    for principal <- Principals.list_by_parent(parent_user_id),
        {pid, _session_id} <- SessionStore.principal_sessions(principal.user_id) do
      send(pid, :cytale_refresh_routes)
    end

    :ok
  end

  @doc """
  #55, the channel-lifecycle twin of `refresh_principal_routes/1`: poke every
  LIVE session of `workspace_id` so it re-joins its routes.

  Routes are computed at Identify/Resume only, so a channel created afterwards
  has no `{:channel, id}` subscription on any live session — and every
  channel-keyed dispatch about it (a rename, a new thread) is addressed to
  nobody, viewer included. The workspace-scoped announce (`ChannelCreate`) still
  arrives because that one rides the WORKSPACE key, which every member session
  already holds; that is exactly why the gap is easy to miss.

  Called by the channel-create path after its epoch bump. The registry is the
  session list here (a session holds its workspace key for every workspace it
  belongs to), and the poke is a bare `send/2` — the socket does the re-join in
  its own process, so this stays cheap and never blocks the request.
  """
  @spec refresh_workspace_routes(integer()) :: :ok
  def refresh_workspace_routes(workspace_id) when is_integer(workspace_id) do
    workspace_id
    |> Integer.to_string()
    |> PushRegistry.workspace_key()
    |> PushRegistry.subscribers()
    |> Enum.each(fn {pid, _user_id} -> send(pid, :cytale_refresh_routes) end)

    :ok
  end

  @doc """
  #111, the membership-grant twin of `refresh_principal_routes/1` (bots) and
  `refresh_workspace_routes/1` (#55): poke every LIVE session of `user_id`
  itself so it re-joins its routes.

  A session that identified BEFORE the membership existed subscribed to
  nothing for the new workspace (READY hydrated an empty membership set), and
  no later REST write re-subscribed the live socket — every channel-keyed
  dispatch in that workspace was addressed to nobody on it, with no error and
  a healthy heartbeat: deaf until a reload re-hydrated the membership. The
  address is the USER key, which every READY'd session implicitly holds in
  both dialects, so one poke reaches all of the user's sockets; each socket
  re-syncs its routes additively in its own process (`:cytale_refresh_routes`
  → `PushRegistry.sync_session/3`, insert-first). This is deliberately a
  sibling of — not a replacement for — `refresh_principal_routes/1`: machine
  principals carry DIFFERENT user ids than their parent, so the grant paths
  call both.

  Called by the membership-create paths (invite accept, workspace create)
  after the write commits.
  """
  @spec refresh_user_routes(integer()) :: :ok
  def refresh_user_routes(user_id) when is_integer(user_id) do
    user_id
    |> Integer.to_string()
    |> PushRegistry.user_key()
    |> PushRegistry.subscribers()
    |> Enum.each(fn {pid, _user_id} -> send(pid, :cytale_refresh_routes) end)

    :ok
  end

  @doc """
  Membership LOSS (a kick): the inverse of the grant pokes above. Pokes every
  live session of `user_id` — and of the machine principals it parents — to
  re-sync its routes against its CURRENT memberships (the sync removes the
  lost workspace's keys and the memo refresh drops the workspace), and
  releases the workspace's keys from the user's held, resumable sessions so
  the offline buffer stops collecting its events for them.
  """
  @spec revoke_workspace_routes(integer(), integer()) :: :ok
  def revoke_workspace_routes(user_id, workspace_id) when is_integer(user_id) and is_integer(workspace_id) do
    channel_ids = Enum.map(Workspaces.list_channels(workspace_id), & &1.channel_id)
    revoke_workspace_routes(user_id, workspace_id, channel_ids)
  end

  @doc """
  `revoke_workspace_routes/2` with the workspace's channel ids supplied — the
  workspace delete revokes every member's routes and reads the channel list
  once instead of once per member.
  """
  @spec revoke_workspace_routes(integer(), integer(), [integer()]) :: :ok
  def revoke_workspace_routes(user_id, workspace_id, channel_ids)
      when is_integer(user_id) and is_integer(workspace_id) and is_list(channel_ids) do
    refresh_user_routes(user_id)
    refresh_principal_routes(user_id)

    ws = Integer.to_string(workspace_id)

    keys =
      [PushRegistry.workspace_key(ws)] ++
        Enum.map(channel_ids, &PushRegistry.channel_key(Integer.to_string(&1)))

    SessionStore.release_user_routes(user_id, keys)
  end

  defp int_id(int) when is_integer(int), do: int

  defp int_id(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp int_id(_), do: nil

  # -- U7 compat dispatch: filter (intents ⊗ visibility) then translate ------
  #
  # The filter + translate machinery itself (intents gate, visible-anchor
  # membership, translation to Discord shapes) lives in
  # `CytaleWeb.Compat.GatewayDialect` — this is the push-handler hook that
  # runs it BEFORE buffer_dispatch, folding the returned memo/author-cache
  # slices back into socket state.

  # Native sessions before Identify hold no identity — and no routes, so
  # nothing can reach them; pass through rather than resolve rights for a
  # principal that does not exist yet. (Unreachable in practice: routes are
  # joined only after Identify succeeds.)
  defp compat_dispatch(%__MODULE__{mode: :native, identity: nil} = state, event_name, payload),
    do: {state, {event_name, payload}}

  # Native sessions: no intents, no translation — but #51's visibility gate
  # DOES apply, the native twin of the REST channel gate. A channel-anchored
  # dispatch this identity cannot VIEW never reaches the wire and never
  # enters the resume buffer: a dropped event never consumes a seq, so replay
  # stays filtered-consistent (the discipline the compat path already keeps).
  defp compat_dispatch(%__MODULE__{mode: :native} = state, event_name, payload) do
    {visible, deliver?} =
      GatewayDialect.visible_dispatch?(state.visible, state.identity, event_name, payload)

    state = %{state | visible: visible}

    if deliver?, do: {state, {event_name, payload}}, else: {state, :drop}
  end

  defp compat_dispatch(%__MODULE__{mode: :compat} = state, event_name, payload) do
    {visible, author_cache, result} =
      GatewayDialect.filter_dispatch(
        state.intents,
        state.visible,
        state.author_cache,
        state.identity,
        event_name,
        payload
      )

    {%{state | visible: visible, author_cache: author_cache}, result}
  end

  @impl true
  def terminate(reason, state) do
    # #26 forensics: every close lands here with the closer's reason.
    Logger.info(
      "gateway terminate: " <>
        inspect(reason, limit: 60) <>
        " session=" <> inspect(state.session_id) <> " user=" <> inspect(state.user_id)
    )

    # Plan 5.13: release this socket's stream contexts BEFORE the session
    # bookkeeping below (a storage hiccup must not strand a zlib handle). The
    # outbound compressor owns the zlib handle / zstd NIF reference and the
    # decoder the inbound zlib inflater on a transport connection; both
    # releases are no-ops on a `:none` codec and idempotent on a re-close.
    Compression.close(state.compressor)
    Compression.close(state.decoder)

    if state.session_id do
      SessionStore.untrack_principal(self())

      # Captured BEFORE `drop_session/1` erases them (hardening plan 4.2): these
      # are the routes that keep this session ADDRESSABLE while it is
      # disconnected-but-resumable (`FanOut.buffer_offline/3` resolves held
      # sessions per route and appends to this record's buffer).
      routes = PushRegistry.session_keys(self())

      # Review #22: pushes the fan-out already SENT to this socket but that it
      # never got to handle are still in the mailbox. They were addressed to a
      # live socket, so the offline path skipped this session for them — and
      # dropping the mailbox lost them for good. Buffer them into the record
      # now, while this process still holds the session's claim (the
      # single-writer invariant `buffer_dispatch/4` relies on), so the resume
      # replays them in order ahead of anything the offline path appends.
      drain_pending_pushes(state)

      case SessionStore.get(state.session_id) do
        nil ->
          :ok

        %Session{} = session ->
          marked = Session.mark_disconnected(session, System.system_time(:millisecond))

          case SessionStore.update(marked) do
            :ok -> hold_offline(marked, routes)
            {:error, _gone} -> :ok
          end

          SessionStore.unclaim(state.session_id)
      end

      PushRegistry.drop_session(self())
    end

    # Presence is per-USER, not per-socket: only when this was the user's last
    # live socket does the workspace roster see them go offline. (Stale entries
    # from crashed sockets are filtered by liveness at read time.)
    if state.user_id do
      case PushRegistry.subscribers(PushRegistry.user_key(state.user_id)) do
        [] ->
          PresenceStatus.forget(state.user_id)
          announce_presence(state.user_id, "offline")

        _live ->
          :ok
      end
    end

    :ok
  end

  # Keep a dropped session addressable for its routes while it is inside its
  # resume window (hardening plan 4.2, owner decision (a): a durable offline
  # buffer in the session record). `FanOut.buffer_offline/3` finds it there and
  # appends later events to this record instead of dropping them, so the resume
  # replay carries them and `replay_complete?/2` is no longer satisfied by a
  # silently-empty window.
  #
  # NATIVE only, deliberately: a compat session's buffer is fed by the socket's
  # translated dispatch path and re-filtered at replay
  # (`GatewayDialect.filter_replay/5`), so appending an untranslated native
  # payload there would put native shapes on the Discord wire. Compat keeps the
  # reconnect it already had — Invalid Session, then a fresh Identify and a REST
  # full sync — which is the documented residual of this fix.
  #
  # Nothing else to check: the record was JUST stamped disconnected, so it cannot
  # be past its window; the shard sweep releases the hold when it deletes the
  # record, and the resume path releases it on adoption.
  defp hold_offline(%Session{mode: :native} = session, routes) do
    PushRegistry.hold_session(session.session_id, routes)
  end

  defp hold_offline(_session, _routes), do: :ok

  # The mailbox drain behind terminate's buffering (review #22). NATIVE
  # sessions only — the ones the offline hold covers: a compat session is
  # never resumed from a replay (full REST sync), so there is nothing to feed.
  # Each drained push runs the same visibility gate a live push would
  # (`compat_dispatch/3` — a dispatch this identity cannot view must not
  # enter the buffer) and the same seq-stamped `buffer_dispatch/4`. Bounded
  # by the mailbox as it stands (`after 0`), and by the session buffer's own
  # cap; best-effort — a failure here must not stop the rest of terminate.
  @terminate_drain_cap 1_000
  defp drain_pending_pushes(%__MODULE__{mode: :native, session_id: sid} = state) when is_binary(sid) do
    drain_pushes(state, @terminate_drain_cap)
  rescue
    e ->
      Logger.warning("gateway terminate: mailbox drain failed: #{Exception.message(e)}")
      :ok
  end

  defp drain_pending_pushes(_state), do: :ok

  defp drain_pushes(_state, 0), do: :ok

  defp drain_pushes(state, budget) do
    receive do
      {:cytale_gateway_push, _from, {name, payload}, _fragment, _meta} when is_binary(name) ->
        drain_one(state, name, payload, budget)

      {:cytale_gateway_push, _from, {name, payload}, _fragment} when is_binary(name) ->
        drain_one(state, name, payload, budget)

      {:cytale_gateway_push, _from, {name, payload}} when is_binary(name) ->
        drain_one(state, name, payload, budget)
    after
      0 -> :ok
    end
  end

  # The offline path's eligibility rule applies here too: what the Resume tail
  # re-derives (presence, read state, calls) or what is ephemeral (typing) is
  # not worth a stale replay.
  defp drain_one(state, name, payload, budget) do
    state =
      if Cytale.Gateway.Payloads.offline_bufferable?(name) do
        case compat_dispatch(state, name, payload) do
          {state, :drop} ->
            state

          {state, {name, payload}} ->
            _ = buffer_dispatch(state, name, payload)
            state
        end
      else
        state
      end

    drain_pushes(state, budget - 1)
  end

  # --------------------------------------------------------------------------
  # Inbound pipeline
  # --------------------------------------------------------------------------

  defp handle_frame(data, opcode, state) do
    data
    |> inflate_inbound(opcode, state)
    |> decode_json()
    |> decode_envelope()
    |> route_op(state)
  rescue
    e in ProtocolError ->
      Logger.info("gateway close #{e.code}: #{e.reason}")
      stop_with_frames(state, e)

    other ->
      # The stack matters: `inspect(other)` alone says WHAT raised, and a bare
      # `%ArithmeticError{}` or `%FunctionClauseError{}` names neither the op nor
      # the line. This is the only path that closes a socket with 4000, so the
      # trace is what makes such a close diagnosable from the log.
      Logger.error("gateway crash: #{inspect(other)}\n" <> Exception.format(:error, other, __STACKTRACE__))

      {:stop, :normal, @close_unknown_error, [], state}
  end

  # The frame OPCODE decides decoding, never the connection's codec alone
  # (#61 item 4). Discord's transport compression is server→client: every
  # real client library sends plain JSON TEXT frames (discord.py has no
  # outbound compressor at all), so a text frame on a `?compress=zlib-stream`
  # connection is Identify-and-everything-else, NOT an inflater input.
  # Feeding it to the deflate inflater — what dropping the opcode did — closed
  # real clients with 4001 on their first frame.
  #
  # Binary frames DO ride the transport stream when the connection opted in;
  # on an uncompressed connection a binary frame stays what it always was:
  # plain JSON in a binary frame.
  defp inflate_inbound(data, :binary, %__MODULE__{decoder: %{mode: mode}} = state) when mode != :none,
    do: decompress_inbound(data, state.decoder)

  defp inflate_inbound(data, _opcode, _state), do: data

  defp decompress_inbound(bin, decoder) do
    case Compression.decoder_feed(decoder, bin) do
      {:ok, json} ->
        json

      {:error, reason} ->
        raise ProtocolError.new(@close_decode_error, "decode error: #{inspect(reason)}")
    end
  end

  defp decode_json(json) when is_binary(json) do
    case Jason.decode(json) do
      {:ok, value} -> value
      {:error, _} -> raise ProtocolError.new(@close_decode_error, "invalid JSON")
    end
  end

  defp decode_json(_other),
    do: raise(ProtocolError.new(@close_decode_error, "non-binary frame body"))

  defp decode_envelope(decoded) when is_map(decoded) do
    cond do
      not Map.has_key?(decoded, "op") ->
        raise ProtocolError.new(@close_decode_error, "missing op field")

      not is_integer(decoded["op"]) ->
        raise ProtocolError.new(@close_decode_error, "non-integer op")

      true ->
        case Opcode.from_code(decoded["op"]) do
          {:ok, name} ->
            {name, decoded}

          :error ->
            raise ProtocolError.new(@close_unknown_opcode, "unknown opcode #{decoded["op"]}")
        end
    end
  end

  defp decode_envelope(_other),
    do: raise(ProtocolError.new(@close_decode_error, "envelope must be an object"))

  defp stop_with_frames(state, %ProtocolError{} = err) do
    encoded = encode_many(state.compressor, err.frames)
    {:stop, :normal, err.code, encoded, state}
  end

  # --------------------------------------------------------------------------
  # Opcode routing
  # --------------------------------------------------------------------------

  defp route_op({:heartbeat, _frame}, state), do: op_heartbeat(state)

  # One live session per connection: Identify/Resume after READY is a
  # protocol violation (close 4005, Discord-shaped) — the client should
  # open a fresh socket instead of re-handshaking an established one.
  # MUST precede the identify/resume clauses (first match wins).
  defp route_op({name, _frame}, %__MODULE__{phase: :connected} = _state)
       when name in [:identify, :resume] do
    raise ProtocolError.new(@close_already_authenticated, "already authenticated")
  end

  defp route_op({:identify, frame}, state),
    do: gated(state.remote_ip, :identify, fn -> op_identify(frame, state) end)

  defp route_op({:resume, frame}, state),
    do: gated(state.remote_ip, :resume, fn -> op_resume(frame, state) end)

  defp route_op({:presence_update, frame}, state), do: op_presence_update(frame, state)

  defp route_op({:typing_start_client, frame}, state), do: op_typing_start(frame, state)
  defp route_op({:message_ack, frame}, state), do: op_message_ack(frame, state)
  defp route_op({:focus_update, frame}, state), do: op_focus_update(frame, state)

  # Voice-call command ops (calls plan U1/U4): op 22 is the call control
  # plane (start/join/leave/state, ring on start AND state — AM17), op 23
  # the opaque media-signaling relay (validated, size-capped, throttled,
  # forwarded to the room tagged with the sender's session — U5 consumes).
  #
  # Compat sessions NEVER leg into a call (the compat wire stays
  # voice-free, U1) — ops 22/23 from a compat client are silent no-ops
  # with op_error telemetry (the emit_call_sync compat precedent).
  defp route_op({name, _frame}, %__MODULE__{mode: :compat} = state)
       when name in [:call_state_update, :call_signal] do
    :telemetry.execute([:cytale, :calls, :op_error], %{}, %{
      op: Atom.to_string(name),
      reason: :compat_session
    })

    push_ok(state, [])
  end

  defp route_op({:call_state_update, frame}, state) do
    op_call_state_update(frame, state)
  end

  defp route_op({:call_signal, frame}, state), do: op_call_signal(frame, state)

  # Discord spends op 6 on client-initiated RESUME (its Reconnect is op 7),
  # so a `cytbot_` credential sending op 6 is RESUMING, not violating the
  # protocol (#67). Native sessions keep the refusal: their resume is op 5,
  # and op 6 from them is still a protocol violation.
  defp route_op({:reconnect, frame}, state) do
    if compat_resume?(frame),
      do: op_resume(frame, state, :compat),
      else: raise(ProtocolError.new(@close_unknown_opcode, "reconnect is server-to-client only"))
  end

  defp route_op({name, _frame}, _state)
       when name in [:dispatch, :hello, :heartbeat_ack, :invalid_session] do
    raise ProtocolError.new(@close_unknown_opcode, "#{name} is server-to-client only")
  end

  # Admission gate wrapper: refusal becomes a rate-limit close.
  defp gated(ip, kind, fun) do
    case AdmissionLimiter.check(kind, ip) do
      {:ok, _count} ->
        fun.()

      {:rate_limited, retry_ms} ->
        raise ProtocolError.new(@close_rate_limited, "rate limited, retry in #{retry_ms}ms")
    end
  end

  # --------------------------------------------------------------------------
  # op 1 Heartbeat → op 11 HeartbeatACK
  # --------------------------------------------------------------------------

  # 5b: before Identify there is no session to keep alive, so a heartbeat is
  # not acknowledged (a pre-Identify socket cannot use beats to look healthy);
  # it is ignored rather than refused, because Discord clients may start their
  # heartbeat loop before their Identify lands. The Identify deadline bounds
  # the socket either way.
  defp op_heartbeat(%__MODULE__{session_id: nil} = state), do: push_ok(state, [])

  defp op_heartbeat(state) do
    now_wall = System.system_time(:millisecond)

    case touch_session(state.session_id, fn
           nil ->
             nil

           %Session{} = rec ->
             {:ok, updated} = Session.heartbeat_received(rec, now_wall)
             updated
         end) do
      {:ok, _updated} ->
        push_ok(state, [Session.heartbeat_ack_frame()])

      {:error, :unknown_session} ->
        raise ProtocolError.new(
                @close_not_authenticated,
                "heartbeat before Identify",
                [Session.invalid_session_frame(false)]
              )
    end
  end

  # Run `fun` against the stored record for this socket's session, if any.
  # Lock-free hot path: THIS socket holds the session's live claim, so it is
  # the record's single writer — the heartbeat stamp is a direct ETS
  # read-modify-write in this process. The serialized `update_with/2` is
  # reserved for correctness-critical work (Resume adoption).
  defp touch_session(nil, _fun), do: {:ok, nil}

  defp touch_session(session_id, fun) do
    case SessionStore.update_local(session_id, fun) do
      {:ok, %Session{}} = ok -> ok
      {:ok, nil} -> {:error, :unknown_session}
      {:error, :unknown_session} -> {:error, :unknown_session}
      other -> other
    end
  end

  # --------------------------------------------------------------------------
  # op 2 Identify
  # --------------------------------------------------------------------------

  defp op_identify(frame, state) do
    d = require_map(frame["d"], "identify.d")
    token = d["token"]

    unless is_binary(token) do
      raise ProtocolError.new(@close_auth_failed, "identify.token missing")
    end

    compress_mode =
      case Compression.parse_mode(d["compress"]) do
        {:ok, mode} -> mode
        :error -> raise ProtocolError.new(@close_decode_error, "unknown compression mode")
      end

    # Auth FIRST, then the version gate keyed on the VERIFIED credential type
    # (KTD5): which wire dialect this connection speaks is a property of the
    # identity, never of what the client claims.
    case Authenticator.verify_token(token) do
      {:ok, identity} ->
        user = Map.put_new(identity, :username, "user#{identity.id}")
        mode = GatewayDialect.session_mode(user)
        GatewayDialect.check_identify_version!(mode, d["v"])
        intents = GatewayDialect.parse_intents!(mode, d["intents"])
        check_session_cap!(mode, user)
        admit_session(user, compress_mode, state, mode: mode, intents: intents)

      {:error, :malformed} ->
        raise ProtocolError.new(
                @close_auth_failed,
                "malformed token",
                [Session.invalid_session_frame(false)]
              )

      {:error, :invalid} ->
        raise ProtocolError.new(@close_auth_failed, "authentication failed")
    end
  end

  # KTD15: per-principal concurrent-session cap (default 8, config
  # overridable) claimed ATOMICALLY at Identify beside the admission limiter
  # — the slot claim is an ETS insert_new on {principal_id, slot}, so N
  # concurrent Identifies can never overshoot the cap the way the former
  # read-count-then-track raced. The claim is keyed to THIS socket process
  # and released on terminate (SessionStore.untrack_principal/1). Machine
  # principals only — humans keep unrestricted multi-device. Discord has no
  # dedicated close code; 4008 (rate limited) carries the semantics and is
  # documented as such in docs/protocol/gateway.md.
  # 5d: native (human) sessions keep multi-device, but live + held records
  # per user are bounded (`gateway_native_session_cap/0`, default 20): the
  # oldest HELD session is evicted to make room, and only a user with that
  # many genuinely LIVE sockets is refused (4008, like the machine cap).
  defp check_session_cap!(:native, identity) do
    with user_id when is_integer(user_id) <- int_id(identity.id),
         {:error, :full} <- SessionStore.make_room_for_user_session(user_id, native_session_cap()) do
      raise ProtocolError.new(
              @close_rate_limited,
              "session cap reached (#{native_session_cap()} sessions per user)"
            )
    else
      _ -> :ok
    end
  end

  defp check_session_cap!(:compat, identity) do
    case int_id(identity.id) do
      nil ->
        :ok

      principal_id ->
        case SessionStore.claim_principal_slot(principal_id, session_cap()) do
          {:ok, _slot} ->
            :ok

          {:error, :full} ->
            raise ProtocolError.new(
                    @close_rate_limited,
                    "session cap reached (#{session_cap()} concurrent sessions per principal)"
                  )
        end
    end
  end

  defp session_cap, do: Cytale.Config.gateway_session_cap()
  defp native_session_cap, do: Cytale.Config.gateway_native_session_cap()

  # Mint + claim a fresh session for this connection and dispatch READY.
  defp admit_session(identity, compress_mode, state, opts) do
    session =
      Session.new(identity,
        now_ms: System.system_time(:millisecond),
        compress: compress_mode,
        mode: Keyword.get(opts, :mode, :native),
        intents: Keyword.get(opts, :intents, 0)
      )

    case SessionStore.claim(session.session_id) do
      {:ok, :claimed} ->
        {:ok, session} = SessionStore.put(session)
        go_connected(session, state)

      {:error, :already_claimed} ->
        raise ProtocolError.new(@close_unknown_error, "session claim race, retry identify")
    end
  end

  # Shared tail of Identify/Resume success: claim registry slots, wire the
  # session into socket state, upgrade the server→client compressor, emit
  # READY. Handshake frames themselves always travel plaintext (see
  # wire_frames/2) — compression starts with the next streamed frame, EXCEPT
  # on transport-compressed connections where the whole wire is the stream.
  defp go_connected(%Session{} = session, state) do
    # Identify success arms the heartbeat deadline (an unbroken link must
    # still die if the client never sends a single beat). The checker process
    # itself is armed once in init/1.
    {:ok, session} = Session.heartbeat_received(session, System.system_time(:millisecond))
    :ok = SessionStore.update(Session.mark_connected(session))
    track_session_principal(session)

    # ONE membership + channel fetch feeds every Identify-time consumer: the
    # route join (native + compat alike), the compat handshake's guild
    # objects, and the visibility memo seeding — the handshake formerly
    # listed workspaces/channels 2-3x across these.
    preloaded = session_preloads(session.user.id)

    join_fanout_routes(session.user.id, preloaded)

    # A transport-compressed connection keeps its upgrade-time zlib stream
    # for the WHOLE wire (shared history cannot restart); `d.compress`
    # payload negotiation is a no-op there.
    {compressor, decoder} = connection_codec(state, session.compress)
    release_replaced_codec(state, compressor, decoder)

    socket_state = %{
      state
      | phase: :connected,
        session_id: session.session_id,
        user_id: session.user.id,
        identity: session.user,
        mode: session.mode,
        intents: session.intents,
        typing_last_at: %{},
        compressor: compressor,
        decoder: decoder
    }

    case session.mode do
      :compat ->
        {ready, guild_creates, visible} =
          GatewayDialect.handshake(session, state.gateway_base_url, preloaded)

        socket_state = %{socket_state | visible: visible}

        # GUILD_CREATEs are real dispatches: seq-stamped + buffered so a
        # Resume replays them exactly (a reconnecting library rebuilds its
        # guild cache from the replay).
        guild_frames =
          Enum.map(guild_creates, fn payload ->
            {envelope, :ok} = buffer_dispatch(socket_state, "GUILD_CREATE", payload)
            envelope
          end)

        {:push, wire_frames(socket_state, [ready | guild_frames]), socket_state}

      :native ->
        # #51: seed the visibility memo the native dispatch gate consults —
        # the same parent∩restrictions computation the compat handshake seeds
        # for its own filter (one mapping, two enforcement points, KTD3), fed
        # by the SAME preload the route join just used (no extra fetch).
        # Seeding here means the gate costs a MapSet lookup per dispatch
        # rather than a rights resolve; it recomputes only when a rights
        # mutation bumps the workspace epoch. notify: false — the routes for
        # this set were just built above; a mid-session refresh (the #111
        # member-add poke) rejoins with its own explicit rejoin flag, so
        # seeding must not queue a rejoin behind it.
        socket_state = %{
          socket_state
          | visible:
              GatewayDialect.refresh_visibility(nil, session.user,
                notify: false,
                preloaded: preloaded
              )
        }

        ready = %{
          op: Opcode.dispatch(),
          t: "Ready",
          s: 0,
          d: %{
            v: @accepted_version,
            session_id: session.session_id,
            resume_token: session.resume_token,
            heartbeat_interval: @heartbeat_interval_ms,
            user: %{id: session.user.id, username: session.user.username},
            # Lane D #5: the session's entity roster rides READY. The handshake
            # already fetched every workspace and its channels (`preloaded`,
            # the route join's input) and used to throw them away — the client
            # then re-read the same rows over REST (workspaces → channels per
            # workspace → DMs), a serial waterfall between the socket opening
            # and the sidebar painting. The rows are the REST readers' own
            # serializers, so a client can treat either source identically.
            # `dm_channels` is null when that read failed: the client then
            # falls back to its REST read instead of rendering "no DMs".
            workspaces: ready_workspaces(preloaded),
            channels: ready_channels(preloaded, socket_state.visible),
            dm_channels: ready_dm_channels(session.user.id),
            # Ticket #124's declarative seam: the media master switch rides
            # the handshake EVERY authenticated client already performs at
            # boot — the client hides the Start-call affordances without a
            # round-trip-per-click and renders an honest "calls are off on
            # this server" state. Chosen over extending GET /auth/methods
            # (read only by the pre-auth login page — the signed-in shell
            # would need a NEW boot fetch). Compat (bot) READYs stay
            # voice-free by documented divergence; no field there.
            media_enabled: Cytale.Config.media_enabled?()
          }
        }

        # Calls U4: the establishment backfill (CALL_SYNC, per-recipient
        # filtered + the AM4 re-bind) rides right after the route join.
        emit_call_sync(socket_state)

        # Notifications plan U1: the same tail carries the read-state sync, so
        # a cold client starts with the member's real unread state rather than
        # empty slices. Lane D #5: computed AFTER READY is on the wire — the
        # sync walks every visible channel's unread window (bounded reads per
        # channel), and doing that inline held READY back by the whole walk.
        # The self-message is handled once this callback has pushed READY, so
        # the order on the wire is unchanged (READY, then the sync).
        send(self(), :cytale_emit_read_state_sync)

        {:push, wire_frames(socket_state, [ready]), socket_state}
    end
  end

  # --------------------------------------------------------------------------
  # op 5 Resume
  # --------------------------------------------------------------------------

  defp op_resume(frame, state), do: op_resume(frame, state, :native)

  # Discord's client-initiated recovery is op 6 RESUME — the SAME number our
  # native protocol spends on the server→client Reconnect op, which is why a
  # Discord client's resume landed in the "server-to-client only" clause and
  # closed 4002 (#67). 4002 is classified as RESUMABLE by Discord clients, so
  # a correct client retried Resume forever and never reached the Identify
  # fallback that works: every socket drop (deploy, restart, blip) deafened
  # every bot, while cytale still counted it online.
  #
  # The dialect is a property of the CREDENTIAL (KTD5), so the payload's token
  # decides: a `cytbot_` credential is a Discord client resuming. Native
  # connections never send op 6, so nothing else changes meaning.
  defp compat_resume?(%{"d" => %{"token" => token}}) when is_binary(token),
    do: String.starts_with?(token, "cytbot_")

  defp compat_resume?(_), do: false

  defp op_resume(frame, state, adoption) do
    if state.phase != :identifying do
      raise ProtocolError.new(@close_unknown_opcode, "resume after ready")
    end

    d = require_map(frame["d"], "resume.d")
    sid = d["session_id"]
    seq = d["seq"]
    token = d["resume_token"]

    unless is_binary(sid) and is_integer(seq) and seq >= 0 do
      raise ProtocolError.new(@close_decode_error, "resume payload malformed")
    end

    # A Resume must itself authenticate: the fresh connection proves the SAME
    # identity as the session being adopted before anything else is checked.
    # The VERIFIED identity (not the session record's frozen copy) rides the
    # state from here on: a restriction-profile change made while the link
    # was down must govern the resumed session's visibility, never the
    # pre-narrowing snapshot stored at Identify time.
    #
    # For a COMPAT resume this credential IS the entire adoption proof — the
    # Discord frame carries no single-use resume token — and the identity
    # match below is what keeps it equivalent to the native check: only the
    # principal that owned the session can adopt it.
    state =
      case authenticate_frame_token(d["token"]) do
        {:ok, identity} -> %{state | user_id: identity.id, identity: identity}
        {:error, _why} -> invalid_session(state, "resume authentication failed")
      end

    stored = SessionStore.get(sid) |> recover_abandoned()

    cond do
      is_nil(stored) ->
        invalid_session(state, "unknown session")

      expired?(stored) ->
        SessionStore.delete(stored.session_id)
        SessionStore.unclaim(stored.session_id)
        invalid_session(state, "session expired (resume window)")

      adoption == :native and not is_binary(token) ->
        invalid_session(state, "resume_token missing")

      # Constant-time compare (S-P2-15): the resume token is a bearer
      # secret; every other secret compare in the codebase already is.
      adoption == :native and
          (not is_binary(stored.resume_token) or
             not Plug.Crypto.secure_compare(token, stored.resume_token)) ->
        invalid_session(state, "resume_token mismatch")

      state.user_id != stored_user_id(stored) ->
        invalid_session(state, "session identity mismatch")

      # The refusal is LIVENESS, not the record's phase (#52): a connection
      # that died untrappably leaves phase :connected with nothing behind it,
      # so a phase test would lock its own client out of resume forever. A
      # session another connection is genuinely USING still refuses.
      Session.live?(stored) and SessionStore.claim_held_by_live?(stored.session_id) ->
        invalid_session(state, "session already live elsewhere")

      seq > stored.seq ->
        raise ProtocolError.new(
                @close_invalid_seq,
                "resume seq #{seq} ahead of server high-water-mark #{stored.seq}"
              )

      # B1: a seq below the buffer's eviction watermark means envelopes the
      # client has NOT seen were already evicted — a replay would silently
      # skip them. Refuse resumable-refused (fresh Identify + REST full-sync)
      # through the same InvalidSession(false) path as every other refusal.
      not Session.replay_complete?(stored, seq) ->
        invalid_session(
          state,
          "resume seq #{seq} older than the buffered watermark " <>
            "#{Session.oldest_buffered_seq(stored) - 1} (evicted; full-sync required)"
        )

      # The message-loss window this `cond` used to document (hardening plan 4.2)
      # is CLOSED: terminate/2 holds the session's routes
      # (`hold_offline/2` → `PushRegistry.hold_session/2`), every fan-out seam
      # appends later events to the disconnected record
      # (`Cytale.Workspaces.FanOut.buffer_offline/3` → `SessionStore.append_offline/4`),
      # and the replay below carries them because they consumed seqs.
      #
      # What REMAINS, deliberately, and is not a silent hole:
      #
      #   * a COMPAT session is never held — its replay is re-filtered against
      #     current visibility and its buffer holds translated envelopes, so it
      #     still reconnects with a full REST sync instead of a replay
      #     (`FanOut.buffer_offline/3`);
      #   * (closed, review #22) the live routes are joined BEFORE the revive,
      #     so no event published during the adoption reaches neither the
      #     buffer nor the subscription — an overlap may deliver it twice,
      #     which the client dedupes by id;
      #   * the buffer is bounded at `Session.buffer_cap/0` envelopes, and a
      #     resume from below the eviction watermark is refused by the check above
      #     (fresh Identify + REST full sync), so an over-cap gap is loud.
      true ->
        perform_resume(stored, seq, state)
    end
  end

  defp authenticate_frame_token(token) when is_binary(token),
    do: Authenticator.verify_token(token)

  defp authenticate_frame_token(_), do: {:error, :malformed}

  defp stored_user_id(%Session{user: user}), do: user.id

  # KTD6 teardown index: register the socket process under the bound
  # principal so revoke/regenerate/parent-delete (close 4004) and
  # restriction-profile changes (op-6 Reconnect) can find its live sessions.
  # Identities are always decimal-string snowflakes; a non-numeric id simply
  # never registers (nothing to tear down).
  defp track_session_principal(%Session{} = session) do
    case int_id(session.user.id) do
      nil -> :ok
      principal_id -> SessionStore.track_principal(principal_id, session.session_id)
    end
  end

  # Window anchored on the LAST DISCONNECT: a session that only dropped
  # moments ago stays resumable for the full window regardless of how long
  # it was live before the drop.
  defp expired?(%Session{} = stored) do
    anchor = stored.last_disconnect_at_ms || stored.created_at_ms

    anchor != nil and
      System.system_time(:millisecond) - anchor > Cytale.Config.resume_window_floor_ms()
  end

  # Token consumed + revive + fresh heartbeat deadline — under the OWNING
  # SHARD's serialization (SessionStore.update_with is the correctness-
  # RESERVED path: two connections racing to adopt the same session must
  # not interleave their adoptions). The socket ADOPTS the freshly verified
  # identity (`state.identity`,
  # re-derived from the token at the top of op_resume) — NOT the stored
  # record's frozen copy — so the resumed session runs under the credential's
  # CURRENT restrictions (R1: evaluated at check time); session_id, seq, and
  # the replay buffer keep their continuity from the stored record.
  defp perform_resume(stored, seq, state) do
    # Take the session's claim for THIS process. The old holder may be a dead
    # process (an untrappable kill left the marker behind) — `claim/1` takes
    # over from a dead holder and refuses a live one, so this doubles as the
    # race guard behind the liveness check above. Identifying always claimed;
    # without claiming here a resumed session would hold NO marker, and the
    # next liveness consult would misread it as abandoned.
    case SessionStore.claim(stored.session_id) do
      {:ok, :claimed} -> :ok
      {:error, :already_claimed} -> invalid_session(state, "session already live elsewhere")
    end

    # ONE membership + channel fetch feeds the route join, the replay
    # re-filter's visibility refresh and any lazy epoch recompute below.
    preloaded = session_preloads(state.identity.id)

    # JOIN THE LIVE ROUTES FIRST (review #22 — this used to run last). The
    # revive below flips the record to `:connected`, from which moment the
    # offline path (`SessionStore.append_offline/4`) no longer buffers for it;
    # with the join AFTER the revive, an event published in between reached
    # neither the buffer nor this socket and was silently lost. Joined first,
    # every event lands in at least one of them: before the revive it is
    # buffered (and replayed below) AND queued in this mailbox; after it, it
    # is queued in this mailbox and pushed live once this handler returns. The
    # overlap can deliver an event twice — the client dedupes by id — which is
    # the right side of that trade.
    join_fanout_routes(state.identity.id, preloaded)

    {:ok, session} =
      SessionStore.update_with(stored.session_id, fn rec ->
        if rec do
          # The presented token is spent; a FRESH one is minted and handed to
          # the client in Resumed (5f) — clearing it without a replacement
          # meant a resumed session could never be resumed a second time.
          revived = %{rec | resume_token: Session.generate_resume_token()}

          {:ok, revived} =
            revived
            |> Session.mark_connected()
            |> Session.heartbeat_received(System.system_time(:millisecond))

          revived
        end
      end)

    envelopes = Session.buffered_after(session, seq)

    # Adopted: the socket is the session's writer again, so the offline hold
    # retires (hardening plan 4.2). Released AFTER the buffered envelopes were
    # read above, so nothing lands in the buffer between the read and the
    # release without being replayed — and the live routes were joined before
    # the revive (above), so there is no window in which an event reaches
    # neither.
    PushRegistry.release_held(session.session_id)

    # BOTH dialects re-filter the replay against CURRENT visibility (R9: no
    # over-delivery — the buffer was written while the link was down, and the
    # offline buffer in particular is fed by the FAN-OUT, which has no visibility
    # context), from the same preload the route join used.
    {_visible, envelopes} =
      GatewayDialect.filter_replay(
        stored.mode,
        state.visible,
        state.identity,
        envelopes,
        preloaded
      )

    track_session_principal(session)

    resumed_first = %{
      op: Opcode.dispatch(),
      t: if(stored.mode == :compat, do: "RESUMED", else: "Resumed"),
      s: 0,
      d: %{
        replayed_events: length(envelopes),
        heartbeat_interval: @heartbeat_interval_ms,
        # The next Resume's single-use token (5f).
        resume_token: session.resume_token
      }
    }

    frames = [resumed_first | envelopes]

    Process.send_after(self(), :check_heartbeats, div(@heartbeat_interval_ms, 2))

    {compressor, decoder} = connection_codec(state, session.compress || :none)
    release_replaced_codec(state, compressor, decoder)

    socket_state = %{
      state
      | phase: :connected,
        session_id: session.session_id,
        user_id: state.identity.id,
        identity: state.identity,
        mode: stored.mode,
        intents: stored.intents,
        typing_last_at: %{},
        compressor: compressor,
        decoder: decoder
    }

    # Calls U4: the Resume establishment tail — CALL_SYNC backfill (fresh,
    # per-recipient filtered — rights may have narrowed while the link was
    # down) plus the AM4 re-bind that keeps the user's voice legs through
    # the reconnect (the room swaps its monitor to THIS process and cancels
    # any armed grace). The replayed envelopes above already carry the
    # buffered CALL_* dispatches in seq order.
    emit_call_sync(socket_state)
    # Notifications plan U1: a resumed session re-hydrates read state too —
    # the member may have read or marked unread on another device while this
    # one was away. Deferred past the RESUMED push like the Identify tail
    # (lane D #5): the replay is what the client is waiting for.
    send(self(), :cytale_emit_read_state_sync)

    {:push, wire_frames(socket_state, frames), socket_state}
  end

  # A session whose holder died UNTRAPPABLY (#52's max_heap_size kill, a
  # VM-level crash) is left `:connected` with nothing behind it: terminate/1
  # never ran, so the drop was never recorded. Discover that here, at the first
  # use of the record, and stamp the disconnect at the LAST SIGN OF LIFE — the
  # last heartbeat, which is at most one interval before the death.
  #
  # Never "now": that would let an abandoned session be kept resumable forever
  # by re-attempting it. Stamping the heartbeat also makes the record
  # reap-able — `Session.expired?/3` anchors on the disconnect, and the shard
  # sweeper deliberately never reaps a `:connected` record.
  #
  # Gated on the CLAIM, so a session a live connection is using is never
  # touched. The call site sits above the resume `cond`, so the expiry check
  # below it anchors on the recovered stamp. A `:disconnected` record is
  # already recovered — leave it.
  defp recover_abandoned(nil), do: nil

  defp recover_abandoned(%Session{phase: :connected} = stored) do
    if SessionStore.claim_held_by_live?(stored.session_id) do
      stored
    else
      at = stored.last_heartbeat_at_ms || stored.created_at_ms || System.system_time(:millisecond)
      recovered = Session.mark_disconnected(stored, at)
      :ok = SessionStore.update(recovered)
      recovered
    end
  end

  defp recover_abandoned(stored), do: stored

  # InvalidSession(false) then close — the client must re-Identify.
  defp invalid_session(_state, why) do
    Logger.info("gateway resume refused: #{why}")
    raise ProtocolError.new(@close_unknown_error, why, [Session.invalid_session_frame(false)])
  end

  # --------------------------------------------------------------------------
  # op 20 TYPING_START (client → server, throttled fan-out)
  # --------------------------------------------------------------------------

  defp op_typing_start(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "typing.d")
    raw_channel_id = d["channel_id"]

    unless is_binary(raw_channel_id) do
      raise ProtocolError.new(@close_decode_error, "typing.d.channel_id missing")
    end

    now_mono = System.monotonic_time(:millisecond)

    # 5e: the throttle is keyed on the PARSED id and the canonical decimal
    # string is what fans out — "0123", "123" and " 123" were three keys (and
    # three unthrottled streams) for one channel, echoed verbatim.
    cid = int_id_strict_or_nil(raw_channel_id)
    channel_id = cid && Integer.to_string(cid)
    key = {state.user_id, cid}
    last = Map.get(state.typing_last_at, key)

    cond do
      is_nil(cid) ->
        # Not a channel id at all: nothing to fan out, nothing to stamp.
        push_ok(state, [])

      is_integer(last) and now_mono - last < @typing_throttle_ms ->
        # Throttled: silently swallowed per the ~1/sec/user/channel rule.
        push_ok(state, [])

      true ->
        typing_emit(state, d, cid, channel_id, key, now_mono)
    end
  end

  # The typing gate: the signal fans out only when THIS session's principal
  # can view the channel. Misses (unknown channel, non-member, out-of-profile
  # restrictions, a thread that is not this channel's) are silently dropped —
  # typing is a best-effort signal, and a close or error here would be a
  # visibility oracle. The throttle window is stamped either way so a
  # dropped-signal stream cannot hammer the gate unthrottled.
  #
  # ONE consult answers BOTH questions (hardening plan 5.3): whether this
  # session may fan the signal out, and WHICH route it takes. It reads the
  # session's visible-set memo — the same set the live dispatch gate enforces
  # — instead of re-resolving rights (a roles-partition read plus the
  # overwrite reads) on every typing signal, and the DM row it already has
  # rides into the fan-out as `resolved:`, so the fan-out does not look the
  # channel kind up again (5.2). A field note (#53): the payload's
  # `channel_id` is what the RECEIVER's gate anchors on.
  defp typing_emit(state, d, cid, channel_id, key, now_mono) do
    stamped = %{state | typing_last_at: Map.put(state.typing_last_at, key, now_mono)}

    with {:ok, thread_id} <- typing_thread(d, cid),
         {state, route} when route != :hidden <- channel_access(stamped, channel_id) do
      # ONE builder for this event (Cytale.Gateway.Payloads): this origin used
      # to send integer ids while both REST origins sent strings.
      payload = Cytale.Gateway.Payloads.typing_start(channel_id, state.user_id, thread_id)

      # DM channels address both participants' user-key sessions (B-1);
      # workspace channels ride the channel key. Either way the TYPING
      # USER'S every session is excluded — not just the origin socket
      # (#80): excluding the process alone still echoed the signal to the
      # typing member's other device, where the mounted indicator
      # (useTyping, no self-filter) rendered "you are typing" back at
      # them. Discord's rule, and the one the compat dialect already
      # applies at its own dispatch filter (`self_typing?/3`, #77).
      Cytale.Workspaces.FanOut.deliver(
        channel_id,
        {"TypingStart", payload},
        except: {:user, state.user_id},
        resolved: resolved_route(route)
      )

      push_ok(%{state | typing_emitted: state.typing_emitted + 1}, [])
    else
      {state, :hidden} -> push_ok(state, [])
      :hidden -> push_ok(stamped, [])
    end
  end

  # 5e: a `thread_id` must name a thread OF THIS CHANNEL (canonicalized like
  # the channel id); anything else drops the signal — it would otherwise put a
  # typing indicator into an arbitrary thread id on receivers.
  defp typing_thread(d, cid) do
    case thread_id_of(d) do
      nil ->
        {:ok, nil}

      raw ->
        with tid when is_integer(tid) <- int_id_strict_or_nil(raw),
             %{channel_id: ^cid} <- Cytale.Threads.Thread.get(tid) do
          {:ok, Integer.to_string(tid)}
        else
          _ -> :hidden
        end
    end
  end

  defp int_id_strict_or_nil(bin) do
    case int_id_strict(bin) do
      {:ok, int} -> int
      _ -> nil
    end
  end

  # The fan-out's `resolved:` option: `:channel` for a workspace channel, the DM
  # row itself when the consult already read it.
  defp resolved_route(:channel), do: :channel
  defp resolved_route({:dm, row}), do: {:dm, row}

  # The session's access to a channel AND the route its event takes, in one
  # consult (hardening plan 5.3). Returns `{state, :hidden | :channel | {:dm,
  # row}}` — the state carrying a memo that may have been refreshed here, which
  # is what makes the next consult cheap.
  #
  #   * workspace channel: the SESSION'S VISIBLE-SET MEMO answers it. That memo
  #     is the same set `visible_dispatch?/4` enforces on every dispatch, so the
  #     answer cannot drift from the live gate — and it is one ETS compare plus a
  #     set membership when warm, where the resolver (`PrincipalRights.resolve/3`)
  #     reads the roles partition and the channel's overwrites. The memo refreshes
  #     itself lazily when a rights epoch moved, so a narrowing still lands before
  #     the next fan-out.
  #   * DM: participation IS authorization (B-1), and DMs are not in the memo —
  #     so this is the membership consult, whose row the caller passes on as the
  #     fan-out's `resolved:`.
  #   * anything else (unknown id, no membership): `:hidden`.
  defp channel_access(%__MODULE__{} = state, channel_id) do
    with cid when is_integer(cid) <- int_id(channel_id) do
      case channel_workspace(cid) do
        %{workspace_id: ws_id} ->
          {visible, ok} =
            GatewayDialect.visible_channel_in_memo?(state.visible, state.identity, ws_id, cid)

          {%{state | visible: visible}, if(ok, do: :channel, else: :hidden)}

        nil ->
          case Workspaces.get_dm(cid) do
            nil ->
              {state, :hidden}

            dm ->
              if Workspaces.dm_participant?(dm, int_id(state.identity.id)),
                do: {state, {:dm, dm}},
                else: {state, :hidden}
          end
      end
    else
      _ -> {state, :hidden}
    end
  end

  # The boolean form, for the consults whose callers cannot thread the memo back
  # (the read-ack gate's `with` chain and the resume-time CALL_SYNC filter). A
  # refresh they compute is recomputed by the next consult; both paths run once
  # per user action or per reconnect, not per event.
  # The channel → workspace route for `channel_access/2` (review #22): the
  # publish seam's cache (`ChannelRoutes`, immutable per channel, tombstoned on
  # delete) answers the steady state — every typing emit and every read ack
  # used to pay a `channels_by_id` read here. A miss reads the row and warms
  # the cache; `nil` means "not a workspace channel" (the DM branch).
  defp channel_workspace(cid) do
    case Cytale.Publish.ChannelRoutes.fetch(cid) do
      {:ok, ws_id} ->
        %{workspace_id: ws_id}

      :error ->
        case Workspaces.get_channel(cid) do
          %{workspace_id: ws_id} = channel when is_integer(ws_id) ->
            :ok = Cytale.Publish.ChannelRoutes.put(cid, ws_id)
            channel

          other ->
            other
        end
    end
  end

  defp session_visible_channel?(state, channel_id) do
    case channel_access(state, channel_id) do
      {_state, :hidden} -> false
      {_state, _route} -> true
    end
  end

  defp thread_id_of(%{"thread_id" => tid}) when is_binary(tid), do: tid
  defp thread_id_of(_), do: nil

  # --------------------------------------------------------------------------
  # op 21 MESSAGE_ACK (client → server read acks + matched ack shape back)
  # --------------------------------------------------------------------------

  defp op_message_ack(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "message_ack.d")
    channel_id = d["channel_id"]
    message_ids = d["message_ids"]

    unless is_binary(channel_id) and is_list(message_ids) and message_ids != [] and
             Enum.all?(message_ids, &is_binary/1) do
      raise ProtocolError.new(@close_decode_error, "message_ack payload malformed")
    end

    payload = %{
      channel_id: channel_id,
      message_ids: message_ids,
      user_id: state.user_id,
      acknowledged_at: DateTime.utc_now() |> DateTime.to_iso8601()
    }

    fan_out(PushRegistry.user_key(state.user_id), {"MessageAck", payload}, except: :none)

    # #117: the durable half of the SAME ack.
    #
    # This op used to be a pure echo — the ack cleared the acker's own client
    # slice and told their other devices, and nothing reached storage. That is
    # the defect the ticket is named for: nothing about "what I had read" (and
    # therefore nothing about "what needed me") survived a reload, because the
    # only ack the shipping clients send is this one. The echo above stays
    # EXACTLY as it was (its shape is the wire contract, and a client that
    # acks a channel it cannot see still gets its own echo), while the storage
    # write is gated the way the REST ack is.
    {:ok, state} = persist_ack(state, channel_id, message_ids)

    {:ok, %{state | acks_recorded: state.acks_recorded + 1}}
  end

  # The ack's storage leg: the watermark (the ONE read state, INCLUSIVE) plus
  # the mention rows the watermark covers.
  #
  # Visibility-gated on the SAME resolver the REST ack uses, so a bogus or
  # foreign id cannot plant a `read_state` row (the #35 IDOR class the REST
  # route closed). The scope may be a channel OR a thread: the client's thread
  # ack sends the THREAD id in `channel_id` (the `read_state` column
  # convention), so a thread resolves through its parent channel — the parent's
  # view right is the thread's, the same rule the thread routes apply.
  #
  # The watermark NEVER REGRESSES. That guard is not decoration: before this
  # write existed the web client's watermark could not move at all, and a
  # device that opens a channel with a short page would otherwise ack an OLDER
  # id than a device that read further, un-reading messages for the whole
  # account. The stored value is read back and the older of the two is
  # discarded.
  #
  # Cost ON THIS SOCKET: the visibility consult (the visible-set memo for a
  # workspace channel) and a cast — the storage reads and writes run in
  # `Cytale.Messages.AckWriter` (review #20). A repeat of a watermark this
  # socket already handed over is skipped outright by the per-socket memo,
  # which is the shape a re-render or a reconnect storm takes.
  #
  # Best-effort throughout: the ack's job on the wire is the echo, and a
  # storage problem must never close a member's link. `message_ids` are
  # client-supplied strings, so a non-snowflake id skips the write rather than
  # poisoning it.
  defp persist_ack(state, scope_id, message_ids) do
    with {:ok, scope} <- int_id_strict(scope_id),
         {:ok, watermark} <- max_snowflake(message_ids),
         false <- already_persisted?(state, scope, watermark),
         true <- ack_scope_visible?(state, scope),
         user_id when is_integer(user_id) <- state_user_id(state) do
      # Review #20: the storage round trips (the stored watermark, the upsert,
      # and #117's mention answer — reading a channel ANSWERS the mentions it
      # covers) run in `Cytale.Messages.AckWriter`, per-user ordered and
      # coalesced, never in this socket: an ack must not hold up the pushes
      # queued behind it. The never-regress guard lives there, against the
      # stored value; the memo here only skips re-sending what this socket
      # already handed over.
      :ok = Cytale.Messages.AckWriter.persist(user_id, scope, watermark)

      {:ok, %{state | acks_advanced: Map.put(state.acks_advanced, scope, watermark)}}
    else
      _ -> {:ok, state}
    end
  rescue
    e ->
      Logger.warning("gateway ack persist failed: #{Exception.message(e)}")
      {:ok, state}
  end

  defp already_persisted?(%__MODULE__{acks_advanced: memo}, scope, watermark),
    do: Map.get(memo, scope, 0) >= watermark

  defp state_user_id(state), do: int_id(state.user_id)

  defp max_snowflake(ids) do
    Enum.reduce_while(ids, {:ok, nil}, fn id, {:ok, acc} ->
      case int_id_strict(id) do
        {:ok, v} -> {:cont, {:ok, max(v, acc || v)}}
        :error -> {:halt, :error}
      end
    end)
  end

  defp int_id_strict(id) when is_binary(id) do
    case Integer.parse(id) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  defp int_id_strict(_id), do: :error

  # A thread id is not a channel: resolve it to its parent before the view
  # check (the thread gate's rule — a thread's authorization IS its parent
  # channel's). The channel/DM path is tried FIRST because that is the common
  # case and it is what `session_visible_channel?` already answers.
  defp ack_scope_visible?(state, scope_id) do
    if session_visible_channel?(state, scope_id) do
      true
    else
      case Cytale.Threads.Thread.get(scope_id) do
        %{channel_id: parent_id} -> session_visible_channel?(state, parent_id)
        nil -> false
      end
    end
  end

  # op 24 FOCUS_UPDATE: is THIS session the one the member is looking at?
  # Delivery reads it so one event does not notify every device — the focused
  # session is already showing the thing, so the notification belongs on the
  # others. A compat session never claims focus: machine principals are not
  # "looking at" anything, and letting one claim focus would suppress the
  # human's own notifications.
  defp op_focus_update(frame, %__MODULE__{mode: :compat} = state) do
    _ = frame
    push_ok(state, [])
  end

  defp op_focus_update(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "focus_update.d")
    focused = d["focused"]

    unless is_boolean(focused) do
      raise ProtocolError.new(@close_decode_error, "focus_update.focused must be a boolean")
    end

    # `state.user_id` is the WIRE form (a string snowflake), not an integer —
    # the store keys on the integer, so it must be coerced here. Without this
    # the store's integer guard rejects the call and the socket's crash handler
    # turns it into a silent close.
    case int_id(state.user_id) do
      nil ->
        raise ProtocolError.new(@close_decode_error, "focus_update has no principal")

      user_id ->
        :ok = Cytale.Notifications.Focus.report(user_id, state.session_id, focused)
    end

    push_ok(state, [])
  end

  defp require_connected!(%__MODULE__{phase: :connected}), do: :ok

  defp require_connected!(_state) do
    raise ProtocolError.new(@close_not_authenticated, "command before Identify")
  end

  # --------------------------------------------------------------------------
  # op 22 CALL_STATE_UPDATE (client → server voice-call control plane, U4)
  # --------------------------------------------------------------------------

  # The typing throttle mechanism verbatim (per-session per-channel last-at
  # map, silent swallow on saturation) — plus telemetry, which typing does
  # not carry. The stamp lands EITHER WAY (accepted or dropped) so a stream
  # of denied starts cannot hammer the permission resolver unthrottled.
  defp op_call_state_update(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "call_state.d")
    channel_id = d["channel_id"]
    action = d["action"]

    unless is_binary(channel_id) and action in @call_actions do
      raise ProtocolError.new(@close_decode_error, "call_state.d malformed")
    end

    now_mono = System.monotonic_time(:millisecond)

    # Throttle keys on the PARSED channel id: distinct strings for one
    # channel ("1" vs "01") collapse into one bucket, and a non-parseable
    # id never touches the map (bounded by real channel ids, not garbage).
    case int_id(channel_id) do
      nil ->
        {d, state} = gate_video_want(d, nil, state)
        route_call_action(action, d, channel_id, state)
        push_ok(state, [])

      cid ->
        # publish/unpublish ride their OWN window — keyed {:call_publish,
        # cid}, checked and stamped only by these actions (SEC-1: a bound
        # survives; COR-6: they no longer touch the shared 900 ms key, so
        # a publish burst cannot suppress same-session state ops).
        if action in ["publish", "unpublish"] do
          pkey = {:call_publish, cid}
          plast = Map.get(state.call_last_at, pkey)

          if is_integer(plast) and now_mono - plast < @publish_throttle_ms do
            :telemetry.execute([:cytale, :gateway, :call_throttled], %{}, %{op: "call_publish"})
            push_ok(state, [])
          else
            state = %{state | call_last_at: Map.put(state.call_last_at, pkey, now_mono)}
            {d, state} = gate_video_want(d, cid, state)
            route_call_action(action, d, channel_id, state)
            push_ok(state, [])
          end
        else
          key = {:call_state_update, cid}
          last = Map.get(state.call_last_at, key)

          # `leave` bypasses the window ("always honored" — a throttled
          # leave ghosts the leg); start/join/state share the 900 ms key,
          # stamped only by these actions.
          if action != "leave" and is_integer(last) and now_mono - last < @call_op_throttle_ms do
            :telemetry.execute([:cytale, :gateway, :call_throttled], %{}, %{
              op: "call_state_update"
            })

            push_ok(state, [])
          else
            state = %{state | call_last_at: Map.put(state.call_last_at, key, now_mono)}
            {d, state} = gate_video_want(d, cid, state)
            route_call_action(action, d, channel_id, state)
            push_ok(state, [])
          end
        end
    end
  end

  # `start`: the typing-gate precedent twice over — START_CALL (default-on,
  # channel-overridable, KTD7) AND a live VIEW_CHANNEL consult — then the
  # room (the loser of a one-live race auto-joins, AM16). Ring defaults ON
  # for DM channels (AM7) and otherwise rides the explicit `ring` flag.
  #
  # The media master switch (#124) is the FIRST consult — the instance-level
  # gate ABOVE permissions — as a `<-` step so its refusal carries the
  # SPECIFIC telemetry reason (countable — the #87 "calls refused" signal);
  # `Cytale.Calls.start_call/4` re-checks (the authoritative chokepoint).
  # The wire stays silent per the non-oracle doctrine: clients learn the
  # state declaratively (READY's `media_enabled`), never by probing.
  defp route_call_action("start", d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id),
         :ok <- media_gate(),
         true <- Cytale.Calls.can_start_call?(cid, uid),
         true <- Cytale.Calls.can_join_call?(cid, uid),
         :ok <- call_caps(cid, uid) do
      dm? = Workspaces.get_dm(cid) != nil
      ring = if is_boolean(d["ring"]), do: d["ring"], else: dm?
      Cytale.Calls.start_call(cid, uid, self(), ring: ring)
    else
      {:error, :media_disabled} ->
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{op: "start", reason: :media_disabled})
        :ok

      {:error, cap_reason} ->
        # The AM-side caps (per-user legs / per-workspace PC ceiling): an
        # op-level rejection — no close, no error surface — with telemetry.
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{op: "start", reason: cap_reason})
        :ok

      _miss ->
        # Unknown channel, non-member, or a denied bit: silently dropped —
        # the typing non-oracle doctrine (no visibility oracle), counted.
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{
          op: "start",
          reason: :start_denied
        })

        :ok
    end
  end

  # `join`: a live VIEW_CHANNEL consult (the room re-checks under its own
  # serialization too, AM2), the caps, then the room. Misses are silent —
  # a join for a channel the session cannot view does not exist. The media
  # master switch refuses FIRST (above permissions; NEW joins only — existing
  # participants re-bind, the standing-call edge) and is counted distinctly,
  # like start's.
  defp route_call_action("join", _d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id),
         :ok <- media_gate(),
         true <- Cytale.Calls.can_join_call?(cid, uid),
         :ok <- call_caps(cid, uid) do
      Cytale.Calls.join_call(cid, uid, self())
    else
      {:error, :media_disabled} ->
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{op: "join", reason: :media_disabled})
        :ok

      {:error, cap_reason} ->
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{op: "join", reason: cap_reason})
        :ok

      _miss ->
        :ok
    end

    :ok
  end

  # `leave` is always honored (leaving a call reveals nothing); unknown
  # channels and absent calls no-op through the context.
  defp route_call_action("leave", _d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id) do
      Cytale.Calls.leave_call(cid, uid)
    else
      _ -> :ok
    end
  end

  # `state`: mute/deafen on the caller's OWN leg (participant-only, silently
  # ignored otherwise), ring-after-start (AM17, honored once per call), and
  # the AM4 session re-fresh — any op re-binds the room's monitor to the
  # CURRENT socket process.
  defp route_call_action("state", d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id),
         room when is_pid(room) <- Cytale.Calls.room_pid(cid),
         true <- Cytale.Calls.can_join_call?(cid, uid),
         true <- Cytale.Calls.Room.participant?(room, uid) do
      changes =
        %{}
        |> maybe_call_change(d, "mute", :mute)
        |> maybe_call_change(d, "deafen", :deafen)

      if changes != %{}, do: Cytale.Calls.update_participant(cid, uid, changes)

      if is_map_key(d, "video_want") do
        case d["video_want"] do
          %{"tiles" => tiles} when is_integer(tiles) and tiles >= 0 ->
            Cytale.Calls.Room.video_want(room, uid, tiles)

          _ ->
            :ok
        end
      end

      Cytale.Calls.Room.rebind(room, uid, self())
      # V2 (P2): the listen-only mic upgrade — the client bound its mic
      # locally; the server (sole offerer) re-offers the leg or the
      # upgrade stays silent.
      if d["mic_granted"] == true, do: Cytale.Calls.Room.mic_ready(room, uid)
      if d["ring"] == true, do: Cytale.Calls.Room.ring(room, uid)
    else
      _ -> :ok
    end

    :ok
  end

  # V2 (KTD3/KTD7): publish/unpublish — the gateway consults the bit AND
  # the media-setting capability (the twin-check doctrine; the room
  # re-checks under its own serialization). `source` must be a known kind;
  # screen_audio rides the screen bit (never ungated).
  defp route_call_action("publish", d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id),
         source when source in ["camera", "screen", "screen_audio"] <- d["source"],
         room when is_pid(room) <- Cytale.Calls.room_pid(cid),
         true <- Cytale.Calls.Room.participant?(room, uid),
         true <- gateway_publish_permits?(cid, uid, source) do
      Cytale.Calls.Room.publish(room, uid, String.to_existing_atom(source))
    else
      _miss ->
        :telemetry.execute([:cytale, :calls, :op_error], %{}, %{
          op: "publish",
          reason: :publish_denied
        })

        :ok
    end

    :ok
  end

  defp route_call_action("unpublish", d, channel_id, %__MODULE__{identity: identity} = _state) do
    with cid when is_integer(cid) <- int_id(channel_id),
         uid when is_integer(uid) <- int_id(identity.id),
         source when source in ["camera", "screen", "screen_audio"] <- d["source"],
         room when is_pid(room) <- Cytale.Calls.room_pid(cid),
         true <- Cytale.Calls.Room.participant?(room, uid) do
      Cytale.Calls.Room.unpublish(room, uid, String.to_existing_atom(source))
    else
      _ -> :ok
    end

    :ok
  end

  # The gateway's publish consult: bit (SEND_VIDEO/SHARE_SCREEN) + media
  # setting (override-then-master). DMs pass through the context's
  # dm_authorized? arm (participation is authorization).
  defp gateway_publish_permits?(cid, uid, source) do
    source_atom = String.to_existing_atom(source)

    caps =
      with %{workspace_id: ws_id} <- Workspaces.get_channel(cid) do
        Cytale.Workspaces.MediaSettings.effective_capabilities(ws_id, cid)
      else
        _ -> %{calls: true, video: true, screenshare: true}
      end

    cap_key = if source_atom == :camera, do: :video, else: :screenshare
    caps[cap_key] and Cytale.Calls.can_publish_source?(cid, uid, source_atom)
  end

  # The per-request media master switch as an op-chain step: :ok to proceed,
  # `{:error, :media_disabled}` for the specific telemetry arm. Reads the
  # same runtime-scoped config the context gate re-checks.
  defp media_gate do
    if Cytale.Config.media_enabled?(), do: :ok, else: {:error, :media_disabled}
  end

  # video_want (KTD7): the adaptive budget rides the state action but
  # gets its OWN ~2s window — stamped on the same call_last_at map. An
  # in-window want is STRIPPED from the payload (the state action's other
  # changes still land); an out-of-window want passes and stamps.
  defp gate_video_want(d, cid, %__MODULE__{identity: identity} = state) do
    case d["video_want"] do
      %{"tiles" => tiles} when is_integer(tiles) and tiles >= 0 ->
        uid = int_id(identity.id)
        now_mono = System.monotonic_time(:millisecond)
        key = {:video_want, uid, cid}
        last = Map.get(state.call_last_at, key)

        if is_integer(last) and now_mono - last < @video_want_window_ms do
          :telemetry.execute([:cytale, :gateway, :call_throttled], %{}, %{op: "video_want"})
          {Map.delete(d, "video_want"), state}
        else
          {d, %{state | call_last_at: Map.put(state.call_last_at, key, now_mono)}}
        end

      _ ->
        {d, state}
    end
  end

  defp maybe_call_change(acc, d, wire_key, key) do
    case d[wire_key] do
      value when is_boolean(value) -> Map.put(acc, key, value)
      _ -> acc
    end
  end

  defp call_caps(channel_id, user_id) do
    case Cytale.Calls.within_caps?(channel_id, user_id) do
      {:ok, :ok} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  # --------------------------------------------------------------------------
  # op 23 CALL_SIGNAL (client → server opaque media-signaling relay, U4)
  # --------------------------------------------------------------------------

  defp op_call_signal(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "call_signal.d")
    channel_id = d["channel_id"]
    kind = d["kind"]
    body = d["body"]

    unless is_binary(channel_id) and kind in @call_signal_kinds and is_binary(body) do
      raise ProtocolError.new(@close_decode_error, "call_signal.d malformed")
    end

    now_mono = System.monotonic_time(:millisecond)

    # Throttle keys on the PARSED channel id (same canonicalization as op
    # 22): a non-parseable id is a silent drop that never touches the map
    # (it cannot grow on garbage keys).
    case int_id(channel_id) do
      nil ->
        :telemetry.execute([:cytale, :calls, :signal_dropped], %{}, %{reason: :non_participant})
        push_ok(state, [])

      cid ->
        key = {:call_signal, cid}
        last = Map.get(state.call_last_at, key)

        cond do
          # SDP bodies bypass the 50 ms window (op-22's leave-exemption
          # shape): an answer is one-per-negotiation, and dropping one
          # wedges the leg until the room's answer-deadline rebuild —
          # measured live at 1-3/25 legs zero-delivery when an answer
          # landed within a candidate burst. ICE candidates stay windowed
          # (they ARE the burst); oversize-cap and participant checks
          # still apply to every body.
          kind != "sdp" and is_integer(last) and now_mono - last < @call_signal_throttle_ms ->
            :telemetry.execute([:cytale, :gateway, :call_throttled], %{}, %{op: "call_signal"})
            push_ok(state, [])

          byte_size(body) > @call_signal_body_max_bytes ->
            drop_signal(state, key, now_mono, :oversize)

          true ->
            state = %{state | call_last_at: Map.put(state.call_last_at, key, now_mono)}

            with uid when is_integer(uid) <- int_id(state.user_id),
                 room when is_pid(room) <- Cytale.Calls.room_pid(cid),
                 true <- Cytale.Calls.Room.participant?(room, uid) do
              # Opaque forward to the room, tagged with the sender's session
              # (U5's media plane consumes; the gateway never interprets).
              send(room, {:call_signal, uid, self(), kind, body})
            else
              _ ->
                # Non-participant (or no live call): silent drop — the typing
                # non-oracle precedent. Never an error surface.
                :telemetry.execute([:cytale, :calls, :signal_dropped], %{}, %{
                  reason: :non_participant
                })

                :ok
            end

            push_ok(state, [])
        end
    end
  end

  defp drop_signal(state, key, now_mono, reason) do
    :telemetry.execute([:cytale, :calls, :signal_dropped], %{}, %{reason: reason})
    # The stamp lands even on the rejected body: an oversize stream must
    # not reset its own throttle window per attempt.
    push_ok(%{state | call_last_at: Map.put(state.call_last_at, key, now_mono)}, [])
  end

  # --------------------------------------------------------------------------
  # op 3 PRESENCE_UPDATE (client → server activity status; server owns
  # connect-driven online/offline, the client only declares idle/dnd here —
  # client-declared "offline" (invisibility) is cut from launch)
  # --------------------------------------------------------------------------

  @presence_client_statuses ~w(online idle dnd invisible)

  defp op_presence_update(frame, state) do
    require_connected!(state)
    d = require_map(frame["d"], "presence.d")
    status = d["status"]

    unless is_binary(status) and status in @presence_client_statuses do
      raise ProtocolError.new(@close_decode_error, "presence.d.status invalid")
    end

    preferred = String.to_existing_atom(status)
    now = System.monotonic_time(:millisecond)
    window = Cytale.Config.gateway_presence_window_ms()
    recent = Enum.filter(state.presence_stamps, &(now - &1 < window))

    cond do
      # 5c: a per-socket throttle (default 5 per 20 s) — over it the update is
      # silently swallowed (the typing precedent): each accepted change fans
      # out to every workspace the user belongs to.
      length(recent) >= Cytale.Config.gateway_presence_budget() ->
        push_ok(%{state | presence_stamps: recent}, [])

      # …and only an actual CHANGE fans out: re-sending the current status is
      # a no-op, not a broadcast.
      PresenceStatus.lookup(state.user_id) == preferred ->
        push_ok(%{state | presence_stamps: recent}, [])

      true ->
        PresenceStatus.put(state.user_id, preferred)
        announce_presence(state.user_id, wire_status(preferred))
        push_ok(%{state | presence_stamps: [now | recent]}, [])
    end
  end

  # Invisible is display-honest, not stealth: the user stays fully routed,
  # but the wire says "offline" to everyone (including their own other
  # devices). No server-side join/snapshot leak.
  defp wire_status(:invisible), do: "offline"
  defp wire_status(:online), do: "online"
  defp wire_status(:idle), do: "idle"
  defp wire_status(:dnd), do: "dnd"

  # --------------------------------------------------------------------------
  # Fan-out helpers + outbound encoding
  # --------------------------------------------------------------------------

  @doc """
  Join every fan-out route this user's session cares about: one channel key
  per reachable channel (MESSAGE_CREATE, TYPING_START, reads) and one
  workspace key per membership (presence scope). Runs after READY/Resumed —
  without it, channel-scoped fan-out has zero targets and live events never
  reach any socket.

  U7: the route set syncs through `PushRegistry.sync_session/3` (insert
  first, then remove stale) — a mid-session refresh (parent joined/kicked)
  never exposes a gap to a concurrent fan-out reader the way a full
  drop-and-rejoin would.
  """
  @spec join_fanout_routes(String.t()) :: :ok
  @spec join_fanout_routes(String.t(), map() | nil) :: :ok
  def join_fanout_routes(user_id, preloaded \\ nil) do
    ws_ids =
      case preloaded do
        %{workspaces: workspaces} -> Enum.map(workspaces, & &1.workspace_id)
        nil -> workspace_ids_of(user_id)
      end

    sync_fanout_routes(user_id, ws_ids, preloaded && preloaded.channels_by_ws)

    # Backfill who's already live BEFORE the self-announce so the newcomer's
    # roster fills first.
    send_presence_snapshot(user_id, ws_ids)
    announce_presence(user_id, wire_status(PresenceStatus.lookup(user_id)))
    :ok
  end

  # Re-join routes WITHOUT the establishment tail's presence work (#55): a
  # mid-session refresh is not a (re)connection, and re-announcing presence to
  # every workspace on each channel create would be pure noise.
  defp refresh_fanout_routes(user_id) do
    sync_fanout_routes(user_id, workspace_ids_of(user_id), nil)
  end

  # The ONE place the desired key set is computed and applied. `sync_session/3`
  # is additive — inserts first, then removes stale keys — so an additive
  # rejoin never exposes a gap to a concurrent fan-out reader.
  defp sync_fanout_routes(user_id, ws_ids, channels_by_ws) do
    PushRegistry.sync_session(self(), user_id, fanout_route_keys(ws_ids, channels_by_ws))
    :ok
  end

  # The full desired key set for a user's memberships (the drain alias rides
  # on every live socket — planned-shutdown fan-out addressing). Preloaded
  # channel rows (the handshake's single fetch) skip the per-workspace
  # re-list.
  defp fanout_route_keys(ws_ids, channels_by_ws) do
    Enum.flat_map(ws_ids, fn ws_id ->
      ws_key = PushRegistry.workspace_key(Integer.to_string(ws_id))

      channels =
        (channels_by_ws && Map.get(channels_by_ws, ws_id)) || Workspaces.list_channels(ws_id)

      channel_keys =
        Enum.map(channels, fn ch ->
          PushRegistry.channel_key(Integer.to_string(ch.channel_id))
        end)

      [ws_key | channel_keys]
    end) ++ [{:drain, :all}]
  end

  # Broadcast a presence status to every workspace the user belongs to,
  # including the announcing socket itself (the client store applies it like
  # any other member's status). The payload carries the workspace_id it rode
  # (B-3: the same fan reaches each membership's subscribers, and the compat
  # translation needs the owning guild per copy — an additive native field).
  @spec announce_presence(String.t(), String.t()) :: :ok
  defp announce_presence(user_id, status) do
    now = DateTime.to_iso8601(DateTime.utc_now())

    for ws_id <- workspace_ids_of(user_id) do
      payload = %{
        user_id: user_id,
        status: status,
        last_seen_at: now,
        workspace_id: Integer.to_string(ws_id)
      }

      fan_out(PushRegistry.workspace_key(Integer.to_string(ws_id)), {"PresenceUpdate", payload})
    end

    :ok
  end

  # Join-time backfill: the announce only reaches sockets subscribed NOW, so
  # a newcomer learns nothing about members who connected earlier. The
  # registry already knows every live socket per workspace — fold its
  # distinct user ids (this socket excluded) into a burst of PresenceUpdates
  # addressed to this socket alone, before the self-announce. No extra
  # state: the route table IS the presence store for the launch's
  # single-node scope.
  @spec send_presence_snapshot(String.t(), [integer()]) :: :ok
  defp send_presence_snapshot(user_id, ws_ids) do
    for ws_id <- ws_ids do
      ws_key = PushRegistry.workspace_key(Integer.to_string(ws_id))

      live_users =
        PushRegistry.subscribers(ws_key)
        |> Enum.map(fn {_pid, uid} -> uid end)
        |> Enum.uniq()
        |> Enum.reject(&(&1 == user_id))

      now = DateTime.to_iso8601(DateTime.utc_now())

      for uid <- live_users do
        payload = %{
          user_id: uid,
          status: wire_status(PresenceStatus.lookup(uid)),
          last_seen_at: now,
          workspace_id: Integer.to_string(ws_id)
        }

        send(self(), {:cytale_gateway_push, self(), {"PresenceUpdate", payload}})
      end
    end

    :ok
  end

  defp workspace_ids_of(user_id) do
    case Integer.parse(user_id) do
      {int, ""} ->
        Workspaces.workspaces_of_user(int) |> Enum.map(& &1.workspace_id)

      _ ->
        []
    end
  end

  # --------------------------------------------------------------------------
  # Calls plan U4: CALL_SYNC backfill + the AM4 re-bind
  # --------------------------------------------------------------------------

  # After the fan-out routes join (Identify AND Resume — the shared
  # establishment tail): the session's live-call roster backfill, FILTERED
  # PER RECIPIENT — a live channel call appears only when this session's
  # live-resolved visible set contains the channel (session_visible_channel?,
  # the typing-gate consult — never a memo snapshot), DM calls when the user
  # participates. The event rides the standard self-push path, so it is
  # seq-stamped + buffered (resume-replayable) like any dispatch.
  #
  # The same enumeration RE-BINDS every room the user legs in to THIS
  # process (AM4: the room monitors "the owner's current gateway session";
  # Resume adopts the stored session in a new process — without the re-bind,
  # every quick reconnect would arm the liveness grace). Rooms where the
  # user is absent are skipped (their clients re-join per AM14 when the
  # backfill shows them absent).
  #
  # Compat sessions never receive CALL_* (the wire stays voice-free, U1's
  # documented divergence) — but the RE-BIND still runs for them: a bot
  # never legs into a call (op 22/23 are no-ops on compat), so this is
  # vacuously cheap.
  defp emit_call_sync(%__MODULE__{mode: :native, user_id: user_id} = state) do
    uid = int_id(user_id)

    if uid do
      rooms = Cytale.Calls.live_rooms()

      {channel_calls, dm_calls} =
        rooms
        |> Enum.filter(fn {_cid, _pid, snapshot} ->
          session_visible_channel?(state, snapshot.channel_id)
        end)
        |> Enum.split_with(fn {_cid, _pid, snapshot} -> not snapshot.dm end)

      for {_cid, pid, snapshot} <- rooms,
          Enum.any?(snapshot.participants, &(&1.user_id == uid)) do
        Cytale.Calls.Room.rebind(pid, uid, self())
      end

      payload =
        Cytale.Calls.Events.call_sync(
          Enum.map(channel_calls, &elem(&1, 2)),
          Enum.map(dm_calls, &elem(&1, 2))
        )

      send(self(), {:cytale_gateway_push, self(), {"CallSync", payload}})
    end

    :ok
  end

  defp emit_call_sync(%__MODULE__{mode: :compat}) do
    :ok
  end

  # --------------------------------------------------------------------------
  # Notifications plan U1 + terminal plan U2 (R22/R22a): the read-state sync
  # --------------------------------------------------------------------------

  # After the fan-out routes join (Identify AND Resume — the same establishment
  # tail the call sync rides): send this session its own read state, so a cold
  # client HYDRATES its unread slices instead of starting empty.
  #
  # Before this, channel read state was write-only server-side and the client's
  # unread slice was wiped on every fresh READY — so a reload silently lost
  # every "you have already read this", and the badge and the notification
  # decision could not agree about the same message (R17).
  #
  # U2 owns the wire contract this carries (R22/R22a) and settles the case the
  # first shape could not express: a channel with NO `read_state` row. That
  # table is written only by an ack or a floor clear, so a channel the member
  # has never acknowledged has no row, and the old shape — entries built FROM
  # the rows — therefore said nothing about exactly the channel a column-one
  # badge exists to surface. So the entry set is now the SESSION-VISIBLE CHANNEL
  # set, and a row-less channel is an entry with a null watermark, a null floor
  # and a COUNT: unread from the beginning of the count's bounded window, which
  # is the number a cold client with nothing loaded for that channel cannot
  # derive for itself. `unread_count` is null only when the count could not be
  # read — never as a stand-in for zero, so a storage blip cannot clear a badge.
  #
  # Filtered PER SESSION, like the call sync: a channel this session can no
  # longer see is absent rather than zeroed, so losing access does not leak a
  # watermark or a count. Rides the standard self-push path, so it is
  # seq-stamped and buffered like any dispatch and a resume replays it.
  defp emit_read_state_sync(%__MODULE__{mode: :native, user_id: user_id} = state) do
    uid = int_id(user_id)

    if uid do
      rows = Cytale.Messages.ReadState.all_for_user(uid)

      states =
        Map.new(rows, fn row ->
          {row.channel_id, %{last_read_id: row.last_read_id, unread_floor: row.unread_floor}}
        end)

      channel_ids = session_visible_channel_ids(state)

      counts = Cytale.Messages.ReadState.unread_counts(uid, channel_ids, states)

      # Lane D #2: the mention half of the badge. `:error` (the backlog read
      # failed) reports every count as null — "not reported", never zero.
      mentions = Cytale.Messages.ReadState.unread_mention_counts(uid, states)

      entries =
        channel_ids
        |> Enum.sort()
        |> Enum.map(fn channel_id ->
          read = Map.get(states, channel_id)

          %{
            channel_id: Integer.to_string(channel_id),
            last_read_id: read && read.last_read_id && Integer.to_string(read.last_read_id),
            unread_floor: read && read.unread_floor && Integer.to_string(read.unread_floor),
            unread_count: Map.get(counts, channel_id),
            mention_count: mention_count_for(mentions, channel_id)
          }
        end)

      send(self(), {:cytale_gateway_push, self(), {"ReadStateSync", %{channels: entries}}})
    end

    :ok
  end

  defp emit_read_state_sync(%__MODULE__{mode: :compat}), do: :ok

  defp mention_count_for({:ok, by_channel}, channel_id), do: Map.get(by_channel, channel_id, 0)
  defp mention_count_for(:error, _channel_id), do: nil

  # -- READY's entity roster (lane D #5) -------------------------------------

  defp ready_workspaces(%{workspaces: workspaces}),
    do: Enum.map(workspaces, &CytaleWeb.WorkspaceController.workspace_json/1)

  # Only the channels the session may VIEW (the memo seeded just above — the
  # same answer `GET /workspaces/:id/channels` gives): the unfiltered roster
  # named every private channel to every member at connect.
  defp ready_channels(%{workspaces: workspaces, channels_by_ws: by_ws}, visible) do
    Enum.flat_map(workspaces, fn ws ->
      viewable =
        case Map.get(visible || %{}, ws.workspace_id) do
          {_epoch, set} -> set
          nil -> MapSet.new()
        end

      by_ws
      |> Map.get(ws.workspace_id, [])
      |> Enum.filter(&MapSet.member?(viewable, &1.channel_id))
      |> Enum.map(&CytaleWeb.ChannelController.channel_json/1)
    end)
  end

  # Best-effort: the DM list is a convenience on READY, never a reason to fail
  # the handshake. A failed read is `nil` — "not provided" — so the client
  # takes its REST path instead of concluding the member has no DMs.
  defp ready_dm_channels(user_id) do
    case int_id(user_id) do
      nil -> nil
      int -> CytaleWeb.DmController.list_json(int)
    end
  rescue
    _error -> nil
  end

  # Every channel this session can see, from the visibility memo the dispatch
  # gate already maintains (the same resolver the REST channel gate uses, so
  # there is one answer to "can this session see this channel").
  #
  # An EMPTY memo is not "no channels": a fresh connection process resuming a
  # session has not filled it yet (the gate fills it lazily, per channel-anchored
  # event), so it is refreshed here against the live resolver — the same
  # `refresh_visibility(nil, …)` the compat replay path performs, with
  # `notify: false` so no route rejoin is poked.
  defp session_visible_channel_ids(%__MODULE__{visible: visible} = state) do
    case visible_channel_ids(visible) do
      [] ->
        state.identity
        |> then(&GatewayDialect.refresh_visibility(nil, &1, notify: false))
        |> visible_channel_ids()

      ids ->
        ids
    end
  end

  # The memo's shape is `%{workspace_id => {epoch, MapSet.t(channel_id)}}`; a
  # bare MapSet is accepted too so a future memo shape does not silently yield
  # an empty channel set.
  defp visible_channel_ids(%MapSet{} = set), do: MapSet.to_list(set)

  defp visible_channel_ids(visible) when is_map(visible) do
    visible
    |> Enum.flat_map(fn
      {_workspace_id, {_epoch, set}} when is_struct(set, MapSet) -> MapSet.to_list(set)
      {_workspace_id, set} when is_struct(set, MapSet) -> MapSet.to_list(set)
      _other -> []
    end)
    |> Enum.uniq()
  end

  defp visible_channel_ids(_visible), do: []

  # The workspace MAP list behind workspace_ids_of (the compat handshake
  # needs names/owners/channels, not just ids). Machine principals resolve
  # through the parent (R1 fallback inside workspaces_of_user).
  defp principal_workspaces(user_id) do
    case int_id(user_id) do
      nil -> []
      int -> Workspaces.workspaces_of_user(int)
    end
  end

  # The handshake's single fetch: the principal's workspaces plus each
  # workspace's channel rows, consumed by the route join, the compat READY/
  # GUILD_CREATE handshake, and the visibility seeding.
  #
  # Lane D #5: the per-workspace channel lists are independent partition reads,
  # so they run CONCURRENTLY (the ReadState.unread_counts precedent) instead of
  # one serial chain per workspace — a member of many workspaces waited for
  # every list before READY could leave. `ordered: true` keeps the result
  # deterministic; a list that fails raises in the caller exactly as the
  # serial read did (the handshake's existing failure contract).
  defp session_preloads(user_id) do
    workspaces = principal_workspaces(user_id)
    concurrency = max(1, min(8, length(workspaces)))

    channels_by_ws =
      workspaces
      |> Task.async_stream(
        fn ws -> {ws.workspace_id, Workspaces.list_channels(ws.workspace_id)} end,
        max_concurrency: concurrency,
        ordered: true
      )
      |> Map.new(fn {:ok, pair} -> pair end)

    %{workspaces: workspaces, channels_by_ws: channels_by_ws}
  end

  @doc false
  @spec fan_out(PushRegistry.route_key(), {String.t(), map()}, keyword()) :: :ok
  def fan_out(route_key, envelope, opts \\ []) do
    except = Keyword.get(opts, :except, :none)
    recipients = PushRegistry.subscribers(route_key)

    # ONE JSON encode for the whole fan-out (hardening plan 2.3): this helper is
    # a multi-recipient publisher too (MemberAdd, ChannelUpdate, the ack echo), so
    # it carries the same fragment as the workspace fan-out. `nil` when there is
    # nothing to amortise — a single target encodes once in its own socket anyway.
    fragment = PreEncoded.for_fanout(length(recipients), elem(envelope, 1))

    for {pid, _user_id} <- recipients, pid != except do
      send(pid, {:cytale_gateway_push, self(), envelope, fragment})
    end

    # The offline half (hardening plan 4.2): held sessions have no pid left in
    # `recipients`, so the event is appended to their records' resume buffers.
    Cytale.Workspaces.FanOut.buffer_offline(route_key, envelope, except)

    :ok
  end

  # Stamp + persist the next per-session seq and append to the resume buffer.
  # READY/RESUMED never pass through here (s: 0, sequence-less control); every
  # live dispatch gets a monotonic per-session number, recorded in the stored
  # session so resume replays line up exactly with what the client processed.
  defp buffer_dispatch(state, name, payload, fragment \\ nil)

  defp buffer_dispatch(%__MODULE__{session_id: nil}, name, payload, _fragment) do
    {%{op: Opcode.dispatch(), t: name, s: 0, d: payload}, :ok}
  end

  # ONE direct read-modify-write IN THIS PROCESS: this socket holds the
  # session's live claim, so it is the record's single writer — the seq
  # stamp + buffer append is a plain ETS round trip with ZERO store
  # GenServer hops (the pre-U7 layout cost two per dispatch, the update_with
  # era still serialized every session's every event node-wide). The wire
  # envelope is derived locally from the stored record —
  # Session.buffer_event stamps seq + 1, which is exactly the written
  # record's seq.
  defp buffer_dispatch(%__MODULE__{} = state, name, payload, fragment) do
    case SessionStore.update_local(state.session_id, fn
           nil ->
             nil

           %Session{} = rec ->
             {updated, _env} = Session.buffer_event(rec, name, payload)
             updated
         end) do
      {:ok, %Session{seq: seq}} ->
        # The BUFFER holds the payload map (`Session.buffer_event/3` stored it
        # above, and a resume replay re-encodes from it); only the wire envelope
        # takes the fragment, which the fan-out encoded once for every recipient
        # (hardening plan 2.3).
        {%{op: Opcode.dispatch(), t: name, s: seq, d: wire_payload(payload, fragment)}, :ok}

      _ ->
        fallback = %{op: Opcode.dispatch(), t: name, s: 0, d: payload}
        {fallback, {:error, :unknown_session}}
    end
  end

  # The wire `d`: the pre-encoded fragment when the fan-out supplied one, else the
  # payload itself (Jason walks it per session — the pre-2.3 cost).
  defp wire_payload(payload, nil), do: payload
  defp wire_payload(_payload, %PreEncoded{} = fragment), do: fragment

  defp push_ok(state, gateway_frames) when is_list(gateway_frames) do
    {:push, encode_many(state.compressor, gateway_frames), state}
  end

  defp drain_this_socket(state) do
    Logger.info("gateway: draining socket #{inspect(self())}")

    # Dialect-aware (KTD5): native sockets get op 6, compat (Discord) sockets
    # op 7 — on the Discord wire, 6 is the CLIENT Resume.
    {:push, encode_many(state.compressor, [Session.reconnect_frame(state.mode)]), state}
  end

  defp check_link(%Session{} = session, state) do
    now_wall = System.system_time(:millisecond)

    case Session.status(session, now_wall, @heartbeat_interval_ms) do
      {:alive, _missed} ->
        {:ok, state}

      {:dead, missed} ->
        Logger.info("gateway: dead link session=#{session.session_id} missed=#{missed}; closing")

        {:stop, :normal, @close_session_timeout, [], state}
    end
  end

  # Encode a list of gateway envelopes into wire frames under the current codec.
  # Uncompressed sessions speak TEXT frames; compressed sessions speak BINARY
  # (one frame per envelope — no cross-frame concatenation) — this is what the
  # U15 client's inbound demultiplexing expects.
  @spec encode_many(Compression.t(), [map()]) :: [{:text | :binary, binary()}]
  defp encode_many(_compressor, []), do: []

  defp encode_many(compressor, frames) do
    Enum.map(frames, fn f -> encode_frame(compressor, f) end)
  end

  defp encode_frame(%Compression{mode: :none}, payload),
    do: {:text, Jason.encode!(payload)}

  defp encode_frame(compressor, payload), do: {:binary, Compression.encode(compressor, payload)}

  # The connection's post-handshake codec pair: the transport zlib stream
  # when the URL opted in (kept from upgrade — history must not restart), or
  # the Identify/Resume-negotiated payload codec otherwise. Payload
  # compression arms the SERVER→CLIENT compressor only — client frames stay
  # plain JSON text (Discord semantics; no browser ships a zstd compressor,
  # and every shipped client sends plain). Inbound stream decoding exists
  # solely for compat transport compression. (2026-09-07: the former
  # "inbound mirrors outbound" armament 4001-closed real-browser sessions on
  # their first post-Identify command — found live in the V2 walkthrough.)
  defp connection_codec(%__MODULE__{transport_mode: mode} = state, _negotiated) when not is_nil(mode),
    do: {state.compressor, state.decoder}

  defp connection_codec(_state, negotiated),
    do: {Compression.init(negotiated), Compression.decoder_init(:none)}

  # Plan 5.13: a codec pair being REPLACED is released before the new pair is
  # installed. On a transport-compressed connection `connection_codec/2`
  # returns the SAME terms (the one stream must not restart), so the `===`
  # identity check keeps this a no-op there — closing the live stream would
  # break the wire. On a plain connection the upgrade-time pair is
  # `mode: :none`, whose release is itself a no-op; the call exists so a
  # future re-handshake path cannot silently orphan a context.
  defp release_replaced_codec(%__MODULE__{} = state, compressor, decoder) do
    unless compressor === state.compressor, do: Compression.close(state.compressor)
    unless decoder === state.decoder, do: Compression.close(state.decoder)
    :ok
  end

  # Wire frames that must never ride inside a compressed shared-history
  # stream UNLESS the transport itself is compressed: close-path
  # InvalidSession and Resume handshake frames go as plain TEXT even on a
  # payload-compressed connection (the client's inflater may be replaced
  # mid-handshake on the resume path). A `?compress=zlib-stream` transport
  # connection owns ONE zlib stream for the whole wire — every frame,
  # handshake included, rides it as BINARY (Discord transport compression).
  @spec wire_frames(t(), [map()]) :: [{:text | :binary, binary()}]
  defp wire_frames(%__MODULE__{transport_mode: mode} = state, frames) when is_list(frames) and not is_nil(mode) do
    Enum.map(frames, fn frame -> {:binary, Compression.encode(state.compressor, frame)} end)
  end

  defp wire_frames(_state, frames) when is_list(frames) do
    Enum.map(frames, fn frame -> {:text, Jason.encode!(frame)} end)
  end

  defp require_map(nil, what),
    do: raise(ProtocolError.new(@close_decode_error, "#{what} missing"))

  defp require_map(d, _what) when is_map(d), do: d

  defp require_map(_other, what),
    do: raise(ProtocolError.new(@close_decode_error, "#{what} must be an object"))

  # --------------------------------------------------------------------------
  # Planned shutdown drain (staggered Reconnect op 6)
  # --------------------------------------------------------------------------

  @doc """
  Drain hook for planned shutdowns: schedules the server Reconnect frame
  (op 6 native / op 7 compat) to every live gateway socket at ~4/sec ±40%
  jitter, so clients reconnect in a staggered wave instead of one
  synchronous cut. `send` itself is instant; only the SCHEDULING is
  staggered — each socket process pushes the frame whenever its timer fires,
  then keeps serving until Bandit kills it.
  """
  @spec drain_shutdown() :: :ok
  def drain_shutdown do
    for {pid, _user_id} <- PushRegistry.subscribers({:drain, :all}) do
      schedule_drain(pid)
    end

    :ok
  end

  defp schedule_drain(pid) do
    base = div(1000, 4)
    jitter = Enum.random(-40..40)
    Process.send_after(pid, :drain_now, max(base + div(base * jitter, 100), 10))
    :ok
  end
end
