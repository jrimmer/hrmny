defmodule VoiceSidecar.Participant do
  @moduledoc """
  One headless voice participant: a real `ExWebRTC.PeerConnection` driven by
  the Cytale gateway wire (Identify → op-22 join → server offers applied and
  answered via op 23, ICE trickled both ways), a synthetic RTP pump on the
  negotiated send leg, and inbound RTP counting on the server's egress legs.

  **V2 video legs (calls V2 plan U7):** offers arrive as envelope-v2 bodies
  (`{"v":2,"type":"offer","sdp":...,"tracks":[{mid,user_id,source,rids?}]}`).
  The participant unwraps the envelope, applies the INNER (wire-munged) SDP —
  ex_webrtc's answerer accepts the rid-spliced text, per the spike — attaches
  one video track per recvonly video m-line (the PUBLISHER shape: e_webrtc
  0.17 cannot originate rid encodings, so sidecar video is single-layer
  fallback-style — the honest ceiling for a library-only publisher), drives
  op-22 publish/unpublish/video_want itself, pumps video-rate RTP per
  published source, and counts inbound RTP per (user, source) using the
  manifest's mid attribution (never m-line order). Per-source counters live
  in the shared ETS table `VoiceSidecar.VideoStats`; coarse totals stay in
  the atomics stride (`sent`/`received` remain AUDIO-only so the V1 delivery
  math keeps its meaning).

  Doctrine boundary (README.md): the envelope/op handling here is hand-rolled
  ON PURPOSE and FOR THE SIDECAR ONLY — the TS harness (`tools/load-test/src/
  voice/`) imports the real `@cytale/protocol` codecs and owns every
  CALL_* assertion. This process is the "real WebRTC remote end" pure TS
  cannot be (plan U13's pinned decomposition).

  Process shape: this process owns the ex_webrtc PC (controlling_process) and
  one linked WS GenServer; a reader child blocks on `WS.recv/2` and forwards
  `{:ws_text, raw}` / `{:ws_closed, code}` into our mailbox so PC messages and
  wire messages interleave fairly. Stats land in a shared `:atomics` array
  (fixed stride, see `stride/0`) that the app's ticker snapshots for the
  VOICE_TICK lines.
  """

  alias ExWebRTC.{
    ICECandidate,
    MediaStreamTrack,
    PeerConnection,
    RTPCodecParameters,
    SessionDescription
  }

  alias VoiceSidecar.WS

  require Logger

  @audio_codec %RTPCodecParameters{
    payload_type: 111,
    mime_type: "audio/opus",
    clock_rate: 48_000,
    channels: 2
  }

  # Matches the server's create_leg pinning (media.ex) — VP8 at pt 96 keeps
  # the answer's video codec intersection exact (the spike's arm-b posture).
  @video_codec %RTPCodecParameters{
    payload_type: 96,
    mime_type: "video/VP8",
    clock_rate: 90_000
  }

  @video_sources ["camera", "screen"]

  # atomics slots (1-based; stride below) — the layout contract with VoiceSidecar
  @s_connected 1
  @s_sent 2
  @s_received 3
  @s_last_latency 4
  @s_max_latency 5
  @s_offers 6
  @s_answers 7
  @s_ice_sent 8
  @s_inbound_tracks 9
  @s_connected_after 10
  @s_ws_closed 11
  # V2 (U7) additions:
  @s_max_sdp_bytes 12
  @s_pc_failures 13
  @s_video_sent 14
  @s_video_received 15
  @s_max_video_latency 16
  @s_churn_toggles 17
  @stride 18

  @doc "Atomics array stride (shared layout contract with VoiceSidecar)."
  def stride, do: @stride

  defstruct [
    :parent,
    :label,
    :ws,
    :pc,
    :track_id,
    :channel_id,
    :stats,
    :idx,
    :turn,
    :pps,
    :payload_bytes,
    :beat_ref,
    :pump_ref,
    :pump_base_ns,
    :user_id,
    :video,
    :video_pps,
    :video_bytes,
    :publish_delay_ms,
    :tiles,
    :churn_interval_ms,
    :camera_count,
    :screen_count,
    pump_k: 0,
    started_mono: nil,
    last_seq: nil,
    remote_set: false,
    ice_queue: [],
    pump_on: false,
    ws_dead: false,
    signal_queue: [],
    signal_last_mono: nil,
    video_scheduled: false,
    video_tracks_added: 0,
    # manifest mid -> {user_id, source} for EGRESS entries (streams we RECEIVE)
    manifest: %{},
    # manifest mid -> source for INGEST entries (our own attach targets)
    ingest_raw: %{},
    # inbound track_id -> {user_id, source} (resolved via transceiver mid)
    inbound: %{},
    # tracks awaiting attribution ({:track, t} raced the manifest fold)
    pending_tracks: [],
    # source -> track_id of OUR latest publish-generation track
    source_tracks: %{},
    # sources we have published (op-22 sent; media awaits/rides the m-line)
    published: MapSet.new(),
    # source -> pump state (video RTP pump per published source)
    vpumps: %{},
    # publish-churn storm: toggles remaining (each flips camera publish)
    churn_rounds_left: 0
  ]

  # The gateway throttles op 23 at 50 ms per session+channel (KTD3). On
  # loopback ex_webrtc gathers candidates instantly, so an SDP answer and its
  # trickled ICE can land inside one throttle window and the LATTER would be
  # silently dropped — pace all op-23 sends above the window (a real
  # browser's gathering latency does this naturally). SDP ANSWERS jump the
  # queue: at N=25 one renegotiation trickles ~1 candidate per m-line (50+),
  # so an answer queued behind the flood drains in seconds — past the room's
  # 5 s answer deadline, which rebuilds the leg into a re-offer loop
  # (measured live, U7: two receivers stalled at zero delivery until answers
  # were prioritized).
  @op23_gap_ms 60

  @doc """
  Run one participant to completion (returns on :stop, or after the WS died
  and the parent's window closes). Failures never crash the app: a broken
  participant parks with ws_closed marked until :stop.
  """
  def run(parent, opts) do
    Process.flag(:trap_exit, true)

    state = %__MODULE__{
      parent: parent,
      label: Keyword.fetch!(opts, :label),
      ws: nil,
      pc: nil,
      track_id: nil,
      channel_id: Keyword.fetch!(opts, :channel_id),
      stats: Keyword.fetch!(opts, :stats),
      idx: Keyword.fetch!(opts, :idx),
      turn: Keyword.get(opts, :turn),
      pps: Keyword.get(opts, :pps, 50),
      payload_bytes: Keyword.get(opts, :payload_bytes, 160),
      started_mono: System.monotonic_time(:millisecond),
      pump_base_ns: nil,
      pump_k: 0,
      user_id: nil,
      video: Keyword.get(opts, :video, false),
      video_pps: Keyword.get(opts, :video_pps, 200),
      video_bytes: Keyword.get(opts, :video_bytes, 1_000),
      publish_delay_ms: Keyword.get(opts, :publish_delay_ms, 2_000),
      tiles: Keyword.get(opts, :tiles),
      churn_interval_ms: Keyword.get(opts, :churn_interval_ms, 400),
      camera_count: Keyword.get(opts, :camera_count, 0),
      screen_count: Keyword.get(opts, :screen_count, 0),
      churn_rounds_left: Keyword.get(opts, :churn_rounds, 0)
    }

    case handshake_and_join(state, opts) do
      {:ok, state} ->
        parent_pid = self()
        _reader = spawn_link(fn -> reader_loop(parent_pid, state.ws) end)
        _ = Process.send_after(self(), :send_beat, 20_000)
        loop(state)

      {:error, reason} ->
        Logger.warning("sidecar[#{state.label}] setup failed: #{inspect(reason)}")
        mark_dead(state)
        wait_for_stop(state)
    end
  end

  # -- setup: WS → HELLO → Identify → READY → PC + track → op-22 join ------------

  defp handshake_and_join(state, opts) do
    host = Keyword.fetch!(opts, :host)
    port = Keyword.fetch!(opts, :port)
    path = Keyword.get(opts, :path, "/gateway/websocket")

    with {:ok, ws} <- WS.start_link(host, port, path, tls: Keyword.get(opts, :tls, false)),
         {:ok, %{"op" => 10}} <- recv_json(ws, 10_000),
         :ok <- identify(ws, opts),
         {:ok, %{"op" => 0, "t" => "Ready"} = frame} <- wait_ready(ws, 20_000),
         {:ok, pc, track_id} <- create_pc(state) do
      # Our own user id names our manifest INGEST entries (publish targets).
      user_id =
        case frame do
          %{"d" => %{"user" => %{"id" => id}}} when is_binary(id) -> id
          %{"d" => %{"user" => %{"id" => id}}} -> to_string(id)
          _ -> nil
        end

      :ok =
        WS.send_text(ws, encode(%{op: 22, d: %{channel_id: state.channel_id, action: "join"}}))

      {:ok, %{state | ws: ws, pc: pc, track_id: track_id, user_id: user_id}}
    else
      {:error, reason} -> {:error, reason}
      other -> {:error, {:unexpected, other}}
    end
  end

  defp identify(ws, opts) do
    payload = %{
      token: Keyword.fetch!(opts, :token),
      v: 1,
      compress: nil,
      properties: %{
        "$os" => "sidecar",
        "$browser" => "voice-sidecar",
        "$device" => "voice-sidecar"
      }
    }

    :ok = WS.send_text(ws, encode(%{op: 2, d: payload}))
    # An early beat marks the link alive (the server arms the deadline at
    # Identify success; beating immediately is never wrong).
    :ok = WS.send_text(ws, encode(%{op: 1, d: nil}))
    :ok
  end

  defp wait_ready(ws, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    wait_ready_loop(ws, deadline)
  end

  defp wait_ready_loop(ws, deadline) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if remaining <= 0 do
      {:error, :ready_timeout}
    else
      case recv_json(ws, remaining) do
        {:ok, %{"op" => 0, "t" => "Ready"} = frame} -> {:ok, frame}
        {:ok, _other} -> wait_ready_loop(ws, deadline)
        {:error, reason} -> {:error, reason}
      end
    end
  end

  defp create_pc(state) do
    ice_servers =
      case state.turn do
        nil -> []
        turn -> [%{urls: turn.url, username: turn.username, credential: turn.password}]
      end

    opts = [
      controlling_process: self(),
      ice_servers: ice_servers,
      ice_transport_policy: if(state.turn, do: :relay, else: :all),
      # Same-host media: keep IPv4 host candidates only — the macOS IPv6
      # privacy addresses rotate and an IPv6 self-pair can blackhole DTLS.
      ice_ip_filter: fn ip -> tuple_size(ip) == 4 end,
      audio_codecs: [@audio_codec],
      video_codecs: if(state.video, do: [@video_codec], else: [])
    ]

    with {:ok, pc} <- PeerConnection.start_link(opts),
         track = MediaStreamTrack.new(:audio),
         {:ok, _transceiver} <- PeerConnection.add_track(pc, track) do
      {:ok, pc, track.id}
    else
      {:error, reason} -> {:error, reason}
      other -> {:error, {:pc_setup, other}}
    end
  end

  # -- the main loop ---------------------------------------------------------------

  defp loop(state) do
    receive do
      :stop ->
        teardown(state)
        :ok

      {:ws_text, raw} ->
        state |> handle_wire(raw) |> loop()

      {:ws_closed, code} ->
        Logger.info("sidecar[#{state.label}] ws closed (#{inspect(code)})")
        state = mark_dead(state)
        if state.ws, do: WS.stop(state.ws)
        state |> stop_pump() |> stop_all_vpumps() |> loop()

      {:EXIT, _pid, reason} when reason in [:normal, :shutdown] ->
        loop(state)

      {:EXIT, _pid, reason} ->
        # Reader child or WS/PC crash — treat the leg as dead, keep reporting.
        Logger.warning("sidecar[#{state.label}] linked process exited: #{inspect(reason)}")
        state = mark_dead(state)
        state |> stop_pump() |> stop_all_vpumps() |> loop()

      {:ex_webrtc, pc, msg} when pc == state.pc ->
        state |> handle_ex_webrtc(msg) |> loop()

      :send_beat ->
        beat(state)
        _ = Process.send_after(self(), :send_beat, 20_000)
        loop(state)

      :pump_tick ->
        state |> pump() |> loop()

      {:vpump_tick, source} ->
        state |> vpump(source) |> loop()

      :flush_signal ->
        state |> flush_signals() |> loop()

      :publish_sources ->
        state |> publish_camera() |> loop()

      :publish_screen ->
        state |> publish_source(:screen) |> loop()

      :send_video_want ->
        state |> send_video_want() |> loop()

      :churn_toggle ->
        state |> churn_toggle() |> loop()

      other ->
        Logger.debug("sidecar[#{state.label}] ignored #{inspect(other)}")
        loop(state)
    end
  end

  # Wire frames: the envelope + the two call ops the sidecar needs.
  defp handle_wire(state, raw) do
    case Jason.decode(raw) do
      {:ok, %{"op" => 0, "t" => t} = frame} ->
        state = %{state | last_seq: frame["s"] || state.last_seq}

        case t do
          "CallSignal" -> handle_signal(state, frame["d"])
          _other -> state
        end

      {:ok, %{"op" => 1}} ->
        # Server-requested heartbeat: answer immediately.
        beat(state)
        state

      {:ok, %{"op" => 9, "d" => resumable}} ->
        Logger.warning(
          "sidecar[#{state.label}] invalid_session (resumable=#{resumable}) — stopping pump"
        )

        state = mark_dead(state)
        stop_pump(state)

      {:ok, %{"op" => _other}} ->
        state

      {:error, _} ->
        state
    end
  end

  defp handle_signal(state, %{"channel_id" => ch, "body" => body})
       when ch == state.channel_id or is_nil(ch) do
    case Jason.decode(body) do
      {:ok, %{"type" => "offer", "sdp" => _sdp} = json} ->
        # The U7 envelope-edge live measurement: the largest CALL_SIGNAL body
        # this leg ever saw, against the 128 KiB cap (VM14).
        base = state.idx * @stride
        bytes = byte_size(body)

        if bytes > :atomics.get(state.stats, base + @s_max_sdp_bytes),
          do: :atomics.put(state.stats, base + @s_max_sdp_bytes, bytes)

        apply_offer(state, json)

      {:ok, %{"type" => "answer"}} ->
        # The server is the sole offerer; answers never arrive here.
        state

      {:ok, %{"candidate" => _, "sdpMid" => _, "sdpMLineIndex" => _} = json} ->
        apply_ice(state, json)

      _ ->
        state
    end
  end

  defp handle_signal(state, _other), do: state

  # Apply one server offer. V2 bodies are envelope-wrapped
  # (`{"v":2,"type":"offer","sdp":...,"tracks":[...]}`): unwrap, fold the
  # manifest (egress mid -> {owner, source} for the streams WE receive;
  # ingest mid -> source for our own attach targets), make sure we hold one
  # video track per live recvonly video m-line (the publisher shape — tracks
  # are added at publish time; the SDP count is the ordering safety net),
  # then set remote → answer → set local → op 23 — the browser shape (the
  # web client's pumpOffers): the answer goes out immediately, candidates
  # trickle as gathered (paced above the gateway's op-23 throttle), and
  # gathering-complete sends the standard empty-candidate end-of-candidates
  # body (ex_ice's regular nomination otherwise waits on its 10 s EoC
  # fallback). All GenServer calls — offers serialize by construction
  # (glare-safe); ex_webrtc 0.17 setters return :ok, creators {:ok, desc}.
  defp apply_offer(state, json) do
    base = state.idx * @stride
    {inner, manifest_entries} = unwrap_offer(json)

    state = fold_manifest(state, manifest_entries)
    state = ensure_video_tracks(state, inner["sdp"])

    answer =
      pc_call(fn ->
        offer = SessionDescription.from_json(inner)
        :ok = PeerConnection.set_remote_description(state.pc, offer)
        {:ok, answer} = PeerConnection.create_answer(state.pc)
        :ok = PeerConnection.set_local_description(state.pc, answer)
        {:ok, answer}
      end)

    if answer == :error do
      # Keep the failure observable — a dropped renegotiation otherwise
      # surfaces only as the room's answer-deadline rebuild.
      Logger.warning(
        "sidecar[#{state.label}] offer apply failed (mid set: #{inspect(Map.keys(state.ingest_raw))})"
      )
    end

    case answer do
      {:ok, answer} ->
        state = pace_signal(state, "sdp", Jason.encode!(SessionDescription.to_json(answer)))

        :atomics.add_get(state.stats, base + @s_offers, 1)
        :atomics.add_get(state.stats, base + @s_answers, 1)
        state = reconcile_source_tracks(state)
        state = attribute_pending_tracks(state)
        # Video pumps start once an applied offer's manifest names OUR ingest
        # m-line for a published source (the m-line exists — RTP has
        # somewhere to land). Idempotent per source.
        state = start_published_vpumps(state)
        flush_ice(%{state | remote_set: true})

      :error ->
        # Malformed/early offer — the room re-offers on the next roster change.
        state
    end
  end

  # Envelope v2 → {inner v1-shaped offer json, manifest entries}; plain v1
  # offers pass through with an empty manifest (V1-server tolerance).
  defp unwrap_offer(%{"v" => 2, "type" => "offer", "sdp" => sdp, "tracks" => tracks}) do
    {%{"type" => "offer", "sdp" => sdp}, tracks}
  end

  defp unwrap_offer(%{"type" => "offer"} = json), do: {json, []}

  # Fold the manifest: EGRESS entries (user_id names the stream's OWNER —
  # an entry whose user is the VIEWER is an ingest/attach target, not a
  # stream we receive) go to mid -> {user_id, source}; our own entries go to
  # the raw ingest map mid -> source. Later offers override (mids are stable
  # across renegotiations; dead mids simply stop carrying tracks).
  defp fold_manifest(state, entries) do
    {egress, ingest} =
      Enum.reduce(entries, {state.manifest, state.ingest_raw}, fn e, {eg, ing} ->
        case e do
          %{"mid" => mid, "user_id" => user, "source" => source}
          when is_binary(mid) and is_binary(user) and is_binary(source) ->
            if state.user_id != nil and user == state.user_id do
              {eg, Map.put(ing, mid, source)}
            else
              {Map.put(eg, mid, {user, source}), ing}
            end

          _ ->
            {eg, ing}
        end
      end)

    %{state | manifest: egress, ingest_raw: ingest}
  end

  # Count live (non-port-0) recvonly VIDEO m-sections in the offered SDP —
  # the number of video tracks the answer must carry send directions on.
  # Tracks are normally added at publish time (before the renegotiated offer
  # can arrive); this count is the ordering safety net.
  defp ensure_video_tracks(state, _sdp) when state.video == false, do: state

  defp ensure_video_tracks(state, sdp) do
    need = count_recvonly_video_mlines(sdp || "")

    if need > state.video_tracks_added do
      Enum.reduce((state.video_tracks_added + 1)..need, state, fn _i, acc ->
        add_video_track(acc)
      end)
    else
      state
    end
  end

  defp count_recvonly_video_mlines(sdp) do
    sdp
    |> String.split(~r{\r?\n}, trim: true)
    |> chunk_mlines()
    |> Enum.count(fn [m_line | _] = lines ->
      String.starts_with?(m_line, "m=video") and
        not rejected_mline?(m_line) and
        Enum.any?(lines, &(&1 == "a=recvonly"))
    end)
  end

  defp rejected_mline?(m_line) do
    case String.split(m_line, " ") do
      ["m=video", port | _] -> port == "0"
      _ -> false
    end
  end

  defp chunk_mlines(lines) do
    Enum.chunk_while(
      lines,
      [],
      fn line, acc ->
        if String.starts_with?(line, "m=") and acc != [] do
          {:cont, Enum.reverse(acc), [line]}
        else
          {:cont, [line | acc]}
        end
      end,
      fn acc -> {:cont, Enum.reverse(acc), []} end
    )
  end

  # After answering: bind OUR sendonly video transceivers to sources via the
  # manifest's ingest mids (self-heals any m-line binding swap — the same
  # mid-keyed discipline the web client's send-side binding uses, KTD1).
  defp reconcile_source_tracks(state) do
    if state.ingest_raw == %{} do
      state
    else
      transceivers = pc_call(fn -> PeerConnection.get_transceivers(state.pc) end) || []


      by_mid = Map.new(transceivers, fn t -> {t.mid, t} end)

      source_tracks =
        Enum.reduce(state.ingest_raw, state.source_tracks, fn {mid, source}, acc ->
          case by_mid[mid] do
            nil ->
              acc

            t ->
              # ingest sources are the server's fixed manifest vocabulary;
              # pumps key on atoms.
              Map.put(acc, String.to_atom(source), sender_track_id(t))
          end
        end)
        |> Map.reject(fn {_source, tid} -> is_nil(tid) end)

      %{state | source_tracks: source_tracks}
    end
  end

  defp sender_track_id(transceiver) do
    case transceiver.sender && transceiver.sender.track do
      %{id: id} -> id
      _ -> nil
    end
  end

  # Attribute {:track, t} notifications that raced ahead of the manifest
  # fold (they fire while set_remote_description runs — our mailbox already
  # holds the offer, so a retry here always resolves).
  defp attribute_pending_tracks(state) do
    {still_pending, inbound} =
      Enum.map_reduce(state.pending_tracks, state.inbound, fn track, acc ->
        case resolve_inbound(state, track) do
          nil -> {track, acc}
          attribution -> {nil, Map.put(acc, track.id, attribution)}
        end
      end)

    %{state | pending_tracks: Enum.reject(still_pending, &is_nil/1), inbound: inbound}
  end

  defp resolve_inbound(state, track) do
    transceivers = pc_call(fn -> PeerConnection.get_transceivers(state.pc) end) || []

    mid =
      Enum.find_value(transceivers, fn t ->
        if t.receiver && t.receiver.track && t.receiver.track.id == track.id, do: t.mid
      end)

    case mid do
      nil -> nil
      m -> state.manifest[m]
    end
  end

  # -- op-22 publish / video_want / churn (the V2 control plane) --------------------

  defp publish_camera(state) do
    state = if state.idx < state.camera_count, do: publish_source(state, :camera), else: state

    # The screen publish (when assigned) rides its own small delay so the
    # two ingest m-lines land in a deterministic order.
    if state.idx < state.screen_count do
      _ = Process.send_after(self(), :publish_screen, 300)
      state
    else
      state
    end
  end

  defp publish_source(state, source) when source in [:camera, :screen] do
    state = add_video_track(state)

    if state.ws && not state.ws_dead do
      WS.send_text(
        state.ws,
        encode(%{op: 22, d: %{channel_id: state.channel_id, action: "publish", source: source}})
      )
    end

    %{state | published: MapSet.put(state.published, source)}
  end

  defp unpublish_source(state, source) when source in [:camera, :screen] do
    if state.ws && not state.ws_dead do
      WS.send_text(
        state.ws,
        encode(%{op: 22, d: %{channel_id: state.channel_id, action: "unpublish", source: source}})
      )
    end

    # Stop OUR transceiver holding that source's track — mirrors the room's
    # stop of its ingest transceiver (the m-line dies with port 0 on the
    # next offer; a fresh track is added on the next publish so the fresh
    # m-line always finds an associable transceiver).
    state = stop_source_transceiver(state, source)
    state = stop_vpump(state, source)

    %{state | published: MapSet.delete(state.published, source)}
  end

  # Mint one ASSOCIABLE send transceiver for a video publish. NOT
  # add_track: its W3C reuse rule (`can_add_track?` — first same-kind
  # transceiver with no sender track and a non-sending current_direction)
  # would hand the track to a RECVONLY EGRESS transceiver (another
  # participant's stream) whenever one exists before we publish — the
  # mid-binding then lands on the wrong m-line and the publisher's own
  # ingest m-line goes trackless (measured live, U7). The remote-offer
  # matcher (`associable?`) only ever binds `added_by_add_track`
  # transceivers onto recvonly m-lines, so an explicitly-created one is
  # deterministic: it binds to the NEXT unbound ingest m-line of the same
  # kind, never an egress (sendonly) one. `added_by_add_track` is an
  # internal flag RTPTransceiver.new reads from its options — 0.17's
  # add_transceiver forwards options verbatim (verified against the pinned
  # dep's source); the sidecar pins == 0.17 and this is the sidecar-only
  # doctrine boundary anyway.
  defp add_video_track(state) do
    track = MediaStreamTrack.new(:video)

    res =
      pc_call(fn ->
        PeerConnection.add_transceiver(state.pc, track,
          direction: :sendrecv,
          added_by_add_track: true
        )
      end)


    case res do
      {:ok, _tr} -> %{state | video_tracks_added: state.video_tracks_added + 1}
      :error -> state
    end
  end

  defp stop_source_transceiver(state, source) do
    track_id = Map.get(state.source_tracks, source)

    if track_id do
      transceivers = pc_call(fn -> PeerConnection.get_transceivers(state.pc) end) || []

      Enum.each(transceivers, fn t ->
        if t.sender && t.sender.track && t.sender.track.id == track_id do
          _ = pc_call(fn -> PeerConnection.stop_transceiver(state.pc, t.id) end)
        end
      end)
    end

    state
  end

  defp send_video_want(state) do
    if state.tiles && state.ws && not state.ws_dead do
      WS.send_text(
        state.ws,
        encode(%{
          op: 22,
          d: %{
            channel_id: state.channel_id,
            action: "state",
            video_want: %{tiles: state.tiles}
          }
        })
      )
    end

    state
  end

  # The publish-churn storm (U7 shape c): rapid publish/unpublish of the
  # camera at line rate — the glare guard's coalescing is the target; the
  # op-22 publish/unpublish path is throttle-exempt by design (KTD3). The
  # storm ends with the camera published (the steady window follows).
  defp churn_toggle(state) do
    base = state.idx * @stride

    if state.churn_rounds_left <= 0 do
      if not MapSet.member?(state.published, :camera) do
        publish_source(state, :camera)
      else
        state
      end
    else
      :atomics.add_get(state.stats, base + @s_churn_toggles, 1)

      state =
        if MapSet.member?(state.published, :camera),
          do: unpublish_source(state, :camera),
          else: publish_source(state, :camera)

      %{state | churn_rounds_left: state.churn_rounds_left - 1}
      |> tap(fn s -> _ = Process.send_after(self(), :churn_toggle, s.churn_interval_ms) end)
    end
  end

  # -- op-23 pacing (the 50 ms/session/channel throttle; see @op23_gap_ms) --

  defp pace_signal(state, kind, body) do
    now = System.monotonic_time(:millisecond)
    # NOTE: nil (never sent) must mean "long enough ago" — the monotonic
    # clock's origin is arbitrary and CAN be negative, so `|| 0` would
    # compute a hugely negative delta and queue forever.
    since = if state.signal_last_mono, do: now - state.signal_last_mono, else: @op23_gap_ms

    if since >= @op23_gap_ms do
      send_signal_now(state, kind, body)
    else
      # Answers first (see @op23_gap_ms note); candidates keep arrival order.
      queue =
        if kind == "sdp",
          do: [{kind, body} | state.signal_queue],
          else: state.signal_queue ++ [{kind, body}]
      state = %{state | signal_queue: queue}
      _ = Process.send_after(self(), :flush_signal, @op23_gap_ms - since + 1)
      state
    end
  end

  defp flush_signals(state) do
    now = System.monotonic_time(:millisecond)

    {sdps, ices} = Enum.split_with(state.signal_queue, fn {kind, _} -> kind == "sdp" end)
    ordered = sdps ++ ices

    state =
      Enum.reduce(ordered, %{state | signal_queue: []}, fn {kind, body}, acc ->
        since = if acc.signal_last_mono, do: now - acc.signal_last_mono, else: @op23_gap_ms

        if since >= @op23_gap_ms do
          send_signal_now(acc, kind, body)
        else
          %{acc | signal_queue: acc.signal_queue ++ [{kind, body}]}
        end
      end)

    if state.signal_queue != [] do
      _ = Process.send_after(self(), :flush_signal, @op23_gap_ms)
    end

    state
  end

  defp send_signal_now(state, kind, body) do
    if state.ws && not state.ws_dead do
      WS.send_text(
        state.ws,
        encode(%{op: 23, d: %{channel_id: state.channel_id, kind: kind, body: body}})
      )
    end

    %{state | signal_last_mono: System.monotonic_time(:millisecond)}
  end

  defp apply_ice(state, json) do
    if state.remote_set do
      add_ice(state, json)
    else
      # Candidates racing the first remote description: queue (the web
      # client's iceQueue pattern).
      %{state | ice_queue: [json | state.ice_queue]}
    end
  end

  defp add_ice(state, json) do
    case safe_ice_from_json(json) do
      {:ok, cand} ->
        _ = pc_call(fn -> PeerConnection.add_ice_candidate(state.pc, cand) end)
        state

      :error ->
        state
    end
  end

  defp flush_ice(state) do
    state =
      Enum.reduce(Enum.reverse(state.ice_queue), state, fn json, acc ->
        add_ice(acc, json)
      end)

    %{state | ice_queue: []}
  end

  defp safe_ice_from_json(json) do
    {:ok, ICECandidate.from_json(json)}
  rescue
    _ -> :error
  end

  # ex_webrtc notifications from OUR PC only.
  defp handle_ex_webrtc(state, {:ice_candidate, candidate}) do
    base = state.idx * @stride

    state = pace_signal(state, "ice", Jason.encode!(ICECandidate.to_json(candidate)))
    :atomics.add_get(state.stats, base + @s_ice_sent, 1)
    state
  end

  defp handle_ex_webrtc(state, {:track, track}) do
    base = state.idx * @stride
    :atomics.add_get(state.stats, base + @s_inbound_tracks, 1)

    case resolve_inbound(state, track) do
      nil -> %{state | pending_tracks: [track | state.pending_tracks]}
      attribution -> %{state | inbound: Map.put(state.inbound, track.id, attribution)}
    end
  end

  defp handle_ex_webrtc(state, {:ice_gathering_state_change, :complete}) do
    # End-of-candidates: without it ex_ice's regular nomination waits on the
    # 10 s EoC fallback timer (ex_webrtc's documented interop requirement) —
    # the room relays the standard empty-candidate body to the server PC.
    pace_signal(
      state,
      "ice",
      Jason.encode!(%{"candidate" => "", "sdpMid" => nil, "sdpMLineIndex" => nil})
    )
  end

  defp handle_ex_webrtc(state, {:connection_state_change, :connected}) do
    base = state.idx * @stride

    if :atomics.exchange(state.stats, base + @s_connected, 1) == 0 do
      after_ms = System.monotonic_time(:millisecond) - state.started_mono
      :atomics.put(state.stats, base + @s_connected_after, after_ms)
      Logger.info("sidecar[#{state.label}] connected after #{after_ms}ms")
    end

    state = start_pump(state)

    # V2: the publish / video_want / churn schedule arms once, from the
    # first connect (publishes need the negotiated audio leg settled first).
    if state.video and not state.video_scheduled do
      _ = Process.send_after(self(), :publish_sources, state.publish_delay_ms)
      if state.tiles, do: _ = Process.send_after(self(), :send_video_want, 1_000)

      if state.churn_rounds_left > 0,
        do: _ = Process.send_after(self(), :churn_toggle, state.publish_delay_ms + 3_000)

      %{state | video_scheduled: true}
    else
      state
    end
  end

  defp handle_ex_webrtc(state, {:connection_state_change, other}) do
    base = state.idx * @stride

    if other in [:failed, :disconnected] do
      # A server-leg rebuild (answer deadline / ICE restart) surfaces here —
      # the U7 churn scenario asserts these stay at zero (no leg drops).
      :atomics.add_get(state.stats, base + @s_pc_failures, 1)
      Logger.info("sidecar[#{state.label}] connection #{other}")
    end

    state
  end

  defp handle_ex_webrtc(state, {:rtp, track_id, _rid, packet}) do
    base = state.idx * @stride
    attribution = Map.get(state.inbound, track_id)
    video? = match?({_, s} when s in @video_sources, attribution)

    case packet.payload do
      <<ts_ns::128, _::binary>> ->
        latency = System.os_time(:nanosecond) - ts_ns

        if video? do
          if latency > :atomics.get(state.stats, base + @s_max_video_latency),
            do: :atomics.put(state.stats, base + @s_max_video_latency, latency)
        else
          _ = :atomics.exchange(state.stats, base + @s_last_latency, latency)

          if latency > :atomics.get(state.stats, base + @s_max_latency),
            do: :atomics.put(state.stats, base + @s_max_latency, latency)
        end

      _ ->
        :ok
    end

    if video? do
      :atomics.add_get(state.stats, base + @s_video_received, 1)
      {user, source} = attribution
      video_bump({state.idx, :recv_v, user, source})
    else
      :atomics.add_get(state.stats, base + @s_received, 1)
    end

    state
  end

  defp handle_ex_webrtc(state, _other), do: state

  # -- the audio pump (spike fanout.ex pattern) ------------------------------------

  defp start_pump(%{pump_on: true} = state), do: state
  defp start_pump(%{pps: pps} = state) when pps <= 0, do: state

  defp start_pump(state) do
    state = %{state | pump_on: true, pump_base_ns: System.os_time(:nanosecond), pump_k: 0}
    %{state | pump_ref: Process.send_after(self(), :pump_tick, 20)}
  end

  defp stop_pump(%{pump_on: false} = state), do: state

  defp stop_pump(state) do
    if state.pump_ref, do: Process.cancel_timer(state.pump_ref)
    %{state | pump_on: false, pump_ref: nil, pump_base_ns: nil}
  end

  defp pump(%{pump_on: true, pc: pc, track_id: track_id} = state) do
    base = state.idx * @stride
    k = state.pump_k + 1
    now = System.os_time(:nanosecond)
    ts = div((now - state.pump_base_ns) * @audio_codec.clock_rate, 1_000_000_000)
    payload_bits = (state.payload_bytes - 16) * 8
    payload = <<now::128, 0::size(payload_bits)>>

    packet = ExRTP.Packet.new(payload, timestamp: ts, sequence_number: rem(k, 65_536))

    case pc_call(fn -> PeerConnection.send_rtp(pc, track_id, packet) end) do
      :ok -> :atomics.add_get(state.stats, base + @s_sent, 1)
      :error -> :ok
    end

    interval_ns = div(1_000_000_000, state.pps)
    target = state.pump_base_ns + k * interval_ns
    sleep_us = max(div(target - System.os_time(:nanosecond), 1_000), 0)

    %{
      state
      | pump_k: k,
        pump_ref: Process.send_after(self(), :pump_tick, div(sleep_us, 1_000) + 1)
    }
  end

  defp pump(state), do: state

  # -- the video pumps (one per published source; 90 kHz clock) ----------------------

  defp start_published_vpumps(state) do
    Enum.reduce(state.published, state, &start_vpump(&2, &1))
  end

  defp start_vpump(state, source) do
    track_id = Map.get(state.source_tracks, source)




    with true <- state.video,
         false <- Map.has_key?(state.vpumps, source),
         tid when not is_nil(tid) <- track_id,
         true <- ingest_ready?(state, source) do
      pump = %{
        track_id: tid,
        k: 0,
        base_ns: System.os_time(:nanosecond),
        ref: Process.send_after(self(), {:vpump_tick, source}, 20)
      }

      %{state | vpumps: Map.put(state.vpumps, source, pump)}
    else
      _ -> state
    end
  end

  # A source's pump starts only once some applied offer's manifest carried
  # OUR ingest entry for it (the server's recvonly m-line exists — the
  # packets have a destination).
  defp ingest_ready?(state, source) do
    Atom.to_string(source) in Map.values(state.ingest_raw)
  end

  defp stop_vpump(state, source) do
    case Map.pop(state.vpumps, source) do
      {nil, _} ->
        state

      {pump, vpumps} ->
        if pump.ref, do: Process.cancel_timer(pump.ref)
        %{state | vpumps: vpumps}
    end
  end

  defp stop_all_vpumps(state) do
    Enum.reduce(Map.keys(state.vpumps), state, &stop_vpump(&2, &1))
  end

  defp vpump(state, source) do
    base = state.idx * @stride

    case state.vpumps[source] do
      nil ->
        state

      pump ->
        k = pump.k + 1
        now = System.os_time(:nanosecond)
        ts = div((now - pump.base_ns) * @video_codec.clock_rate, 1_000_000_000)
        payload_bits = (state.video_bytes - 16) * 8
        payload = <<now::128, 0::size(payload_bits)>>

        packet = ExRTP.Packet.new(payload, timestamp: ts, sequence_number: rem(k, 65_536))

        case pc_call(fn -> PeerConnection.send_rtp(state.pc, pump.track_id, packet) end) do
          :ok ->
            :atomics.add_get(state.stats, base + @s_video_sent, 1)
            video_bump({state.idx, :sent_v, "self", Atom.to_string(source)})

          :error ->
            :ok
        end

        interval_ns = div(1_000_000_000, max(state.video_pps, 1))
        target = pump.base_ns + k * interval_ns
        sleep_us = max(div(target - System.os_time(:nanosecond), 1_000), 0)

        pump = %{
          pump
          | k: k,
            ref: Process.send_after(self(), {:vpump_tick, source}, div(sleep_us, 1_000) + 1)
        }

        %{state | vpumps: Map.put(state.vpumps, source, pump)}
    end
  end

  # -- shared ETS per-source counters (the app's ticker snapshots them) --------------

  @video_tab VoiceSidecar.VideoStats

  defp video_bump(key) do
    try do
      :ets.update_counter(@video_tab, key, {2, 1}, {key, 0})
    rescue
      _ -> :ok
    end
  end

  # -- misc ---------------------------------------------------------------------------

  defp beat(%{ws_dead: true}), do: :ok

  defp beat(state) do
    if state.ws, do: WS.send_text(state.ws, encode(%{op: 1, d: state.last_seq}))
  catch
    _kind, _reason -> :ok
  end

  defp mark_dead(state) do
    base = state.idx * @stride
    :atomics.exchange(state.stats, base + @s_connected, 0)
    :atomics.put(state.stats, base + @s_ws_closed, 1)
    %{state | ws_dead: true}
  end

  defp teardown(state) do
    if state.ws do
      _ =
        WS.send_text(
          state.ws,
          encode(%{op: 22, d: %{channel_id: state.channel_id, action: "leave"}})
        )

      WS.stop(state.ws)
    end

    state = stop_all_vpumps(state)

    if state.pc do
      _ = pc_call(fn -> PeerConnection.close(state.pc) end)
      _ = pc_call(fn -> PeerConnection.stop(state.pc) end)
    end
  end

  defp wait_for_stop(state) do
    receive do
      :stop ->
        teardown(state)
        :ok

      _other ->
        wait_for_stop(state)
    after
      120_000 -> :ok
    end
  end

  # Best-effort PC call: a dead PC exits — never crash the participant.
  defp pc_call(fun) do
    fun.()
  catch
    :exit, _reason -> :error
    _kind, _reason -> :error
  end

  defp recv_json(ws, timeout) do
    case WS.recv(ws, timeout) do
      {:text, raw} -> Jason.decode(raw)
      {:closed, code} -> {:error, {:closed, code}}
      {:error, :timeout} -> {:error, :timeout}
    end
  end

  defp encode(frame), do: Jason.encode!(frame)

  # Reader child: forwards WS text frames into the participant's mailbox.
  defp reader_loop(parent, ws) do
    case WS.recv(ws, 30_000) do
      {:text, raw} ->
        send(parent, {:ws_text, raw})
        reader_loop(parent, ws)

      {:closed, code} ->
        send(parent, {:ws_closed, code})

      {:error, :timeout} ->
        reader_loop(parent, ws)
    end
  end
end
