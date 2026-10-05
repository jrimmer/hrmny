defmodule Cytale.Calls.MediaV2Test do
  @moduledoc """
  Calls V2 (U3): per-source publishing, the envelope-v2 manifest, layer-
  selective forwarding with restamping, deafen-keeps-video (R15), tile
  budgets, and the room's source lifecycle + per-source epoch eviction.

  The synthetic-RTP technique: the ex_webrtc fake browser cannot ORIGINATE
  rid-tagged simulcast (the spike's library arm — 0.17 has no send-side
  encodings API), so rid-tagged ingest is driven by sending synthetic
  `{:ex_webrtc, pc, {:rtp, track_id, rid, packet}}` messages to the room
  process — exactly the notifications a real browser's up-flow produces
  (the spike's browser arm measured that shape live). Real-browser
  end-to-end stays U7's leg.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls
  alias Cytale.Calls.Media
  alias Cytale.Snowflake
  alias ExWebRTC.{PeerConnection, SessionDescription}

  defmodule Sink do
    @behaviour Cytale.Calls.Events.Sink

    @key {__MODULE__, :listener}

    def listen(pid), do: :persistent_term.put(@key, pid)
    def unlisten, do: :persistent_term.erase(@key)

    @impl true
    def emit(event, payload) do
      case :persistent_term.get(@key, nil) do
        nil ->
          :ok

        pid ->
          send(pid, {:sink_event, event, payload})
          :ok
      end
    end
  end

  setup do
    old_calls = Application.get_env(:cytale, :calls, [])

    Application.put_env(
      :cytale,
      :calls,
      Keyword.merge(old_calls,
        empty_sweep_ms: 60_000,
        answer_deadline_ms: 5_000,
        event_sink: Sink
      )
    )

    Sink.listen(self())

    on_exit(fn ->
      Application.put_env(:cytale, :calls, old_calls)
      Sink.unlisten()
    end)
  end

  # -- Manifest (R5/KTD1) ----------------------------------------------------------------

  test "publish camera: renegotiation offers carry the envelope-v2 manifest with per-source tracks" do
    {room, clients, [p1, p2]} = connected_pair()

    # p1 publishes their camera (a DM-style bare channel: no bits needed).
    {:ok, :ok} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")

    # BOTH sides get renegotiation offers. p2's names p1's camera as an
    # egress stream; p1's own offer carries their camera INGEST m-line —
    # the one the rid splice rides (a real browser answerer derives its
    # three encodings from it, the spike's arm a).
    offer_p2 = next_sdp!(p2)
    assert offer_p2["v"] == 2
    assert offer_p2["type"] == "offer"
    assert {Integer.to_string(p1), "camera"} in manifest_sources(offer_p2)

    offer_p1 = next_sdp!(p1)
    assert {Integer.to_string(p1), "camera"} in manifest_sources(offer_p1)
    assert offer_p1["sdp"] =~ "a=simulcast:recv q;h;f"
    assert offer_p1["sdp"] =~ "a=rid:q recv"
    answer_all_offers!(clients)

    # The R5 invariant: every manifest egress entry maps to a real
    # transceiver mid, and the roster's sources match the manifest's.
    state = :sys.get_state(room)
    leg_p2 = state.media.legs[p2]
    assert Map.has_key?(leg_p2.egress, {p1, :camera})
    assert Map.has_key?(state.media.legs[p1].ingest_mids, :camera)

    cleanup!(room, clients)
  end

  test "unpublish: the source leaves the roster, everyone's egress, and the ingest attribution" do
    {room, clients, [p1, p2]} = connected_pair()
    {:ok, :ok} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")
    answer_all_offers!(clients)

    # The fake browser attached a camera sender to the ingest m-line — the
    # room attributed the received track ({:track, t} on the answer).
    assert eventually!(2_000, fn -> ingest_track(room, p1, :camera) != nil end)

    {:ok, :ok} = Calls.Room.unpublish(room, p1, :camera)
    wait_source_update!(p1, "camera_off")
    answer_all_offers!(clients)

    state = :sys.get_state(room)
    refute Map.has_key?(state.media.legs[p2].egress, {p1, :camera})
    assert state.media.legs[p1].ingest_mids |> Map.keys() == [:mic]

    # P3: the stopped ingest transceiver's attribution is purged with it —
    # a stale entry would forward late/synthetic RTP for a dead source.
    assert eventually!(2_000, fn -> ingest_track(room, p1, :camera) == nil end)

    cleanup!(room, clients)
  end

  # -- Layer-selective forwarding + restamping (KTD2/the spike's constraint 2) ------------

  test "screen rides the f layer; cameras ride q within the tile budget (decision seam)" do
    # The forwarding DECISIONS (KTD2: stage=f, tiles=q within budget,
    # restamp continuity) are pinned via the [:cytale, :calls, :forward]
    # telemetry seam — real-transport delivery is U7's browser leg (the
    # spike proved the wire; V1's media_test carries the audio-transport
    # proof).
    {room, clients, [p1, p2]} = connected_pair()

    {:ok, _} = Calls.Room.publish(room, p1, :screen)
    wait_source_update!(p1, "screen_on")
    answer_all_offers!(clients)

    # The screen IS the stage: f forwards, q does not.
    events = with_forward_events(fn -> pump_synthetic(room, room_pc(room, p1), :screen, [{"f", 2}, {"q", 2}]) end)

    viewer = p2
    fwd = forward_events(events, viewer, :screen, "f")
    assert length(fwd) == 2, "f-layer forwards (#{inspect(forward_events(events, viewer, :screen, "f"))})"
    assert forward_events(events, viewer, :screen, "q") == []

    cleanup!(room, clients)
  end

  test "the stage owner's camera still forwards at q (only the stage screen is budget-exempt)" do
    {room, clients, [p1, p2]} = connected_pair()

    # The sharer publishes screen AND camera — screen becomes the stage.
    {:ok, _} = Calls.Room.publish(room, p1, :screen)
    wait_source_update!(p1, "screen_on")
    {:ok, _} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")
    answer_all_offers!(clients)

    events =
      with_forward_events(fn ->
        pump_synthetic(room, room_pc(room, p1), :screen, [{"f", 2}])
        pump_synthetic(room, room_pc(room, p1), :camera, [{"q", 2}])
      end)

    # The screen IS the stage: f-layer to everyone (the budget exemption
    # lives in deliver?'s stage arm).
    assert length(forward_events(events, p2, :screen, "f")) == 2

    # …and the SHARER's camera ranks in the tile budget like anyone
    # else's (p2's default budget 9) — the viewer gets the face at q. The
    # old camera_ranking List.delete(stage) starved exactly this camera.
    assert length(forward_events(events, p2, :camera, "q")) == 2

    cleanup!(room, clients)
  end

  test "deafen keeps video flowing, stops mic and share-audio (R15, decision seam)" do
    {room, clients, [p1, p2]} = connected_pair()
    {:ok, _} = Calls.Room.publish(room, p1, :screen)
    wait_source_update!(p1, "screen_on")
    answer_all_offers!(clients)

    # p2 deafens: mic + share-audio stop, video keeps flowing.
    {:ok, _} = GenServer.call(room, {:update_state, p2, %{deafen: true}})
    wait_source_update!(p2, "deafened")

    events =
      with_forward_events(fn ->
        pump_synthetic(room, room_pc(room, p1), :mic, [{nil, 2}])
        pump_synthetic(room, room_pc(room, p1), :screen, [{"f", 2}])
      end)

    # mic: dropped for the deafened p2 (the non-deafened mic path is
    # V1 media_test's proven ground — two participants means p2 is the
    # only viewer here).
    assert forward_events(events, p2, :mic, nil) == []

    # screen video: BOTH — deafen never gates video (R15).
    assert length(forward_events(events, p2, :screen, "f")) == 2

    cleanup!(room, clients)
  end

  # The full epoch → per-source-unpublish flow needs a real workspace's
  # rights (a bare test channel rides the same unresolvable-channel escape
  # join_permitted? has, so nothing is revocable). Its wiring is the
  # rights_epoch_bumped handler's per-source arm, covered with real
  # workspaces in the gateway suites; the source-removal behavior itself
  # is the unpublish test above.
  test "video_want records the budget; sources introspection reflects publishes" do
    {room, clients, [p1, _p2]} = connected_pair()
    {:ok, :ok} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")
    answer_all_offers!(clients)

    plan_before = :sys.get_state(room).media.plan

    {:ok, :ok} = Calls.Room.video_want(room, p1, 4)
    state = :sys.get_state(room)
    assert state.media.wants[p1] == %{tiles: 4}

    # P3: wants ride the DELIVER-time budget, never the cached plan — a
    # budget change must not touch the stage/rank cache (roster and source
    # mutations are its only inputs).
    assert state.media.plan == plan_before

    sources = Calls.Room.sources(room)
    assert %{camera: %{since: %DateTime{}}} = sources[p1]

    cleanup!(room, clients)
  end

  test "displacement drops the displaced leg's published sources (no stale screen in the fresh offer)" do
    {room, clients, [p1, p2]} = connected_pair()

    {:ok, _} = Calls.Room.publish(room, p1, :screen)
    wait_source_update!(p1, "screen_on")
    answer_all_offers!(clients)

    # AM8 displacement: the same user's second device joins — the old PC
    # is dropped outright (drop_leg), and the plane's source roster for
    # that user must go with it: the fresh device re-publishes from
    # scratch, and a surviving sources[p1] would leak the DEAD leg's
    # screen into every later manifest/egress diff.
    {:ok, _} = Calls.join_call(room_channel(room), p1, self())

    state = :sys.get_state(room)
    assert Map.get(state.media.sources, p1, %{}) == %{}

    leg = state.media.legs[p1]
    assert Map.keys(leg.ingest_mids) == [:mic]

    # The fresh leg's first offer carries no screen INGEST entry — on
    # p1's own manifest a {p1, screen} entry could only be the stale
    # ingest (egress never names one's own sources).
    offer = next_sdp!(p1)
    refute {Integer.to_string(p1), "screen"} in manifest_sources(offer)
    answer_all_offers!(clients)

    cleanup!(room, clients)
  end

  # -- Review fixes: deferred ICE restart / mic upgrade / monotonic restamp / wants pruning --

  test ":failed while an offer is outstanding defers the ICE restart to the answer (no wedged leg)" do
    {room, clients, [p1, p2]} = connected_pair()

    # p1's camera publish leaves BOTH legs' offers un-answered (the glare
    # window the :failed is about to land inside).
    {:ok, :ok} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")
    outstanding = next_sdp!(p1)
    _p2_offer = next_sdp!(p2)

    assert :sys.get_state(room).media.legs[p1].offer_outstanding

    # The failure lands INSIDE the glare window: ex_webrtc cannot stack
    # offers, so no restart offer can go out — but the one-restart policy
    # is spent AND the restart itself is deferred, not dropped.
    pc_p1 = room_pc(room, p1)
    send(room, {:ex_webrtc, pc_p1, {:connection_state_change, :failed}})

    leg = :sys.get_state(room).media.legs[p1]
    assert leg.ice_restarted, "the one-restart policy is spent at :failed time"
    assert leg.restart_pending, "the restart must be deferred, not dropped"
    assert leg.offer_outstanding

    # The client answers the outstanding offer — the glare window closes
    # and the deferred restart fires RIGHT THERE (the restart offer IS the
    # follow-up offer).
    answer_with_fake_browser(clients[p1], outstanding)
    restart_offer = next_sdp!(p1)
    assert restart_offer["type"] == "offer"

    # The restart actually re-gathered ICE: fresh ice-ufrag credentials
    # (a plain no-restart offer would keep them and the leg would wedge).
    assert ice_ufrags(restart_offer["sdp"]) != []
    assert ice_ufrags(restart_offer["sdp"]) != ice_ufrags(outstanding["sdp"])

    # The leg settles: flag cleared, policy still spent, room intact.
    answer_with_fake_browser(clients[p1], restart_offer)
    leg = :sys.get_state(room).media.legs[p1]
    assert leg.restart_pending == false
    assert leg.ice_restarted
    assert Map.has_key?(:sys.get_state(room).media.legs, p2)

    cleanup!(room, clients)
  end

  test "mic_ready re-offers a listen-only leg when the client binds its mic" do
    channel_id = Snowflake.next()
    p1 = Snowflake.next()
    p2 = Snowflake.next()
    session1 = self()

    session2 =
      spawn(fn ->
        receive do
          :hold -> :ok
        end
      end)

    {:ok, _} = Calls.start_call(channel_id, p1, session1)
    room = Calls.room_pid(channel_id)
    c1 = fake_browser_ctx(room, channel_id, p1, session1)
    answer_with_fake_browser(c1, next_sdp!(p1))

    # LISTEN-ONLY: p2 answers the initial offer WITHOUT attaching any
    # track (the recvonly ingest m-line answers inactive — nothing flows
    # up, exactly the browser shape of a mic-permission-pending join).
    {:ok, _} = Calls.join_call(channel_id, p2, session2)
    {:ok, pc2} = PeerConnection.start_link(controlling_process: self())
    c2 = Map.put(fake_browser_ctx(room, channel_id, p2, session2), :pc, pc2)
    renegotiation_answer(c2, next_sdp!(p2))
    spawn_link(fn -> drain_pc(pc2) end)

    # p1's renegotiation for the join settles the plane.
    answer_with_fake_browser(c1, next_sdp!(p1))

    # Silence: no further offer is coming for p2 — the upgrade is the
    # SERVER's move (sole offerer) and it has not happened yet.
    assert poll_sdp(p2) == nil

    # The client binds the mic locally and says so (op-22 `state` with
    # `mic_granted: true` routes here through Room.mic_ready).
    :ok = Calls.Room.mic_ready(room, p2)

    offer = next_sdp!(p2)
    assert offer["type"] == "offer"
    assert offer["v"] == 2
    renegotiation_answer(c2, offer)

    cleanup!(room, %{p1 => c1, p2 => c2})
  end

  test "restamp keeps the outgoing ts monotonic when ingest timestamps move backward" do
    {room, clients, [p1, p2]} = connected_pair()

    # Backward-jumping synthetic ingest (a layer switch from an
    # independent clock, or device drift): 1000, 2000, then 1500, 900,
    # 3000. Asserted through the forward telemetry's seq_out/ts_out.
    pc = room_pc(room, p1)
    {_owner, track_id} = ingest_track(room, p1, :mic)

    events =
      with_forward_events(fn ->
        for ts <- [1000, 2000, 1500, 900, 3000] do
          packet = ExRTP.Packet.new(<<ts::128, ts::32>>, timestamp: ts, sequence_number: 0)
          send(room, {:ex_webrtc, pc, {:rtp, track_id, nil, packet}})
        end
      end)

    fwd = forward_events(events, p2, :mic, nil)
    assert length(fwd) == 5

    # The outgoing seq clock ticks +1 per packet (mod 2^16)...
    seqs = Enum.map(fwd, & &1[:seq_out])
    assert Enum.zip(seqs, tl(seqs)) |> Enum.all?(fn {a, b} -> b == rem(a + 1, 65_536) end)

    # ...and ts never regresses: the backward jumps (1500, 900) bump the
    # egress ts_offset so the outgoing clock continues at last+1 (minimal
    # distortion), and the later forward packet (3000) rides the bumped
    # offset. Pre-fix, this was [1000, 2000, 1500, 900, 3000].
    assert Enum.map(fwd, & &1[:ts_out]) == [1000, 2000, 2001, 2002, 4102]

    cleanup!(room, clients)
  end

  test "leaving prunes the departed viewer's wants (no stale tile budget)" do
    {room, clients, [p1, p2]} = connected_pair()
    {:ok, :ok} = Calls.Room.video_want(room, p2, 2)
    assert %{tiles: 2} = :sys.get_state(room).media.wants[p2]

    Calls.Room.leave(room, p2)
    wait_source_update!(p2, "left")

    # forget_leg dropped the wants with the leg (the emit precedes the
    # roster sync, so the assertion retries through the race).
    assert eventually!(2_000, fn ->
             state = :sys.get_state(room)
             not Map.has_key?(state.media.wants, p2) and not Map.has_key?(state.media.legs, p2)
           end)

    cleanup!(room, %{p1 => clients[p1]})
  end

  # -- Room source roster + snapshot backfill (R3) ----------------------------------------

  test "the snapshot carries sources and CALL_SYNC projects them" do
    {room, clients, [p1, _p2]} = connected_pair()
    {:ok, :ok} = Calls.Room.publish(room, p1, :camera)
    wait_source_update!(p1, "camera_on")

    snapshot = Calls.Room.state(room)
    participant = Enum.find(snapshot.participants, &(&1.user_id == p1))
    assert %{camera: %{since: %DateTime{}}} = participant.sources

    payload = Cytale.Calls.Events.call_sync([snapshot], [])
    [%{"participants" => roster}] = payload["calls"]
    entry = Enum.find(roster, &(&1["user_id"] == Integer.to_string(p1)))
    assert %{"source" => "camera", "since" => since} = hd(entry["sources"])
    assert is_binary(since)

    Calls.Room.leave(room, p1)
    for {_uid, ctx} <- clients, do: stop_pc(ctx)
  end

  # -- Helpers ----------------------------------------------------------------------------

  defp connected_pair do
    channel_id = Snowflake.next()
    p1 = Snowflake.next()
    p2 = Snowflake.next()
    session1 = self()

    session2 =
      spawn(fn ->
        receive do
          :hold -> :ok
        end
      end)

    {:ok, _} = Calls.start_call(channel_id, p1, session1)
    room = Calls.room_pid(channel_id)
    c1 = fake_browser_ctx(room, channel_id, p1, session1)
    answer_with_fake_browser(c1, next_sdp!(p1))

    {:ok, _} = Calls.join_call(channel_id, p2, session2)
    c2 = fake_browser_ctx(room, channel_id, p2, session2)
    answer_with_fake_browser(c2, next_sdp!(p2))
    # p1's roster-change renegotiation
    answer_with_fake_browser(c1, next_sdp!(p1))

    {room, %{p1 => c1, p2 => c2}, [p1, p2]}
  end

  defp fake_browser_ctx(room, channel_id, user_id, session),
    do: %{room: room, channel_id: channel_id, user_id: user_id, session: session, pc: nil}

  defp answer_with_fake_browser(%{pc: nil} = ctx, offer) do
    {:ok, pc} = PeerConnection.start_link(controlling_process: self())
    answer_with_fake_browser(%{ctx | pc: pc}, offer)
  end

  # First offer: the browser shape (attach mic + one video track per
  # video m-line, tighten to sendonly). Renegotiation offers: answer
  # as-is — re-attaching onto already-sendonly transceivers trips a 0.17
  # get_direction(:sendonly, :sendonly) FunctionClause (the honest SFU's
  # directions persist across renegotiations; V1's apply_offer! shape).
  # Renegotiation iff the pc already carries a sender track (no helper-
  # local state threading — the callers' maps stay frozen).
  defp answer_with_fake_browser(%{pc: pc} = ctx, offer) do
    if pc_has_sender_track?(pc) do
      renegotiation_answer(ctx, offer)
    else
      first_answer(ctx, offer)
    end
  end

  defp pc_has_sender_track?(pc) do
    Enum.any?(PeerConnection.get_transceivers(pc), &(&1.sender.track != nil))
  end

  defp renegotiation_answer(%{pc: pc} = ctx, offer) do
    inner = %{"type" => "offer", "sdp" => offer["sdp"]}
    :ok = PeerConnection.set_remote_description(pc, SessionDescription.from_json(inner))
    {:ok, answer} = PeerConnection.create_answer(pc)
    :ok = PeerConnection.set_local_description(pc, answer)
    send(ctx.room, {:call_signal, ctx.user_id, ctx.session, "sdp", Jason.encode!(SessionDescription.to_json(answer))})
    ctx
  end

  defp first_answer(%{pc: pc, room: room, user_id: user_id, session: session} = ctx, offer) do
    inner = %{"type" => "offer", "sdp" => offer["sdp"]}

    :ok =
      PeerConnection.set_remote_description(pc, SessionDescription.from_json(inner))

    mic = ExWebRTC.MediaStreamTrack.new(:audio)
    {:ok, _} = PeerConnection.add_track(pc, mic)
    _video_tracks = attach_video_tracks!(pc, inner["sdp"])
    # No explicit direction sets: add_track on the recvonly ingest m-line
    # negotiates sendrecv -> answered sendonly; 0.17 forbids answering a
    # sendonly m-line with sendonly (get_direction table) and its add_track
    # association target is opaque on multi-m-line offers.

    {:ok, answer} = PeerConnection.create_answer(pc)
    :ok = PeerConnection.set_local_description(pc, answer)

    send(room, {:call_signal, user_id, session, "sdp", Jason.encode!(SessionDescription.to_json(answer))})
    spawn_link(fn -> drain_pc(pc) end)
    ctx
  end

  # Attach video senders ONLY to recvonly video m-lines — the publisher's
  # own ingest (where {:track} attribution must fire). Attaching to a
  # sendonly egress m-line means answering sendonly-with-sendonly, which
  # 0.17's get_direction table forbids (an answerer receiving sendonly
  # answers recvonly — the viewer watches, never mirrors).
  defp attach_video_tracks!(pc, sdp) do
    ingest_video =
      sdp
      |> String.split(~r{\r?\n}, trim: true)
      |> chunk_mlines()
      |> Enum.count(fn [m | _] = lines ->
        String.starts_with?(m, "m=video") and "a=recvonly" in lines
      end)

    for _ <- 1..ingest_video do
      track = ExWebRTC.MediaStreamTrack.new(:video)
      {:ok, _} = PeerConnection.add_track(pc, track)
      track.id
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

  defp drain_pc(pc) do
    receive do
      {:ex_webrtc, ^pc, _} -> drain_pc(pc)
    after
      2_000 -> :ok
    end
  end

  # Answer every pending renegotiation offer for every connected client
  # (the glare guard queues roster changes behind un-answered offers).
  defp answer_all_offers!(clients) do
    # Loop until quiet: publish fans an offer to EVERY participant and the
    # glare guard queues follow-ups behind each answer — one 150ms sweep
    # races the mailbox.
    Enum.each(1..12, fn _ ->
      answered =
        Enum.map(clients, fn {uid, ctx} ->
          uid_s = Integer.to_string(uid)

          receive do
            {:sink_event, :call_signal, %{"user_id" => ^uid_s, "kind" => "sdp", "body" => body}} ->
              answer_with_fake_browser(ctx, Jason.decode!(body))
              true
          after
            0 -> false
          end
        end)

      unless Enum.any?(answered), do: :ok
    end)
  end

  defp next_sdp!(user_id, timeout \\ 5_000) do
    uid = Integer.to_string(user_id)

    receive do
      {:sink_event, :call_signal, %{"user_id" => ^uid, "kind" => "sdp", "body" => body}} ->
        Jason.decode!(body)
    after
      timeout -> flunk("no sdp offer for #{user_id} within #{timeout}ms")
    end
  end

  # next_sdp!'s nil-answering twin: nothing on the wire within the window.
  defp poll_sdp(user_id) do
    uid = Integer.to_string(user_id)

    receive do
      {:sink_event, :call_signal, %{"user_id" => ^uid, "kind" => "sdp", "body" => body}} ->
        Jason.decode!(body)
    after
      150 -> nil
    end
  end

  # The ICE username fragments of every m-line (one transport per PC —
  # all equal; an ice_restart mints fresh ones).
  defp ice_ufrags(sdp) do
    sdp
    |> String.split(~r{\r?\n}, trim: true)
    |> Enum.filter(&String.starts_with?(&1, "a=ice-ufrag:"))
  end

  defp eventually!(timeout_ms, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    eventually_loop!(deadline, timeout_ms, fun)
  end

  defp eventually_loop!(deadline, timeout_ms, fun) do
    cond do
      fun.() -> true
      System.monotonic_time(:millisecond) >= deadline -> flunk("condition not met within #{timeout_ms}ms")
      true -> Process.sleep(25) && eventually_loop!(deadline, timeout_ms, fun)
    end
  end

  defp wait_source_update!(user_id, state, timeout \\ 5_000) do
    uid = Integer.to_string(user_id)

    receive do
      {:sink_event, :call_update, %{"user_id" => ^uid, "state" => ^state}} ->
        :ok
    after
      timeout -> flunk("no call_update #{state} for #{user_id}")
    end
  end

  defp manifest_sources(offer) do
    for t <- offer["tracks"], do: {t["user_id"], t["source"]}
  end

  defp with_forward_events(fun) do
    test_pid = self()

    handler = fn _event, measurements, env, _config ->
      send(test_pid, {:forward_event, Map.merge(env, measurements)})
    end

    :telemetry.attach_many(
      :media_v2_forward,
      [[:cytale, :calls, :forward]],
      handler,
      nil
    )

    fun.()

    # The room processes pumped packets ASYNC: collect until 200ms quiet.
    events = collect_forward_events([], 200)
    :telemetry.detach(:media_v2_forward)
    events
  end

  defp collect_forward_events(acc, quiet_ms) do
    receive do
      {:forward_event, event} -> collect_forward_events([event | acc], quiet_ms)
    after
      quiet_ms -> Enum.reverse(acc)
    end
  end

  defp forward_events(events, viewer, source, rid) do
    Enum.filter(events, fn e ->
      e[:viewer] == viewer and e[:source] == source and e[:rid] == rid and e[:forwarded]
    end)
  end

  defp room_channel(room) do
    room |> :sys.get_state() |> Map.get(:channel_id)
  end

  defp room_pc(room, user_id) do
    room |> :sys.get_state() |> get_in([Access.key!(:media), Access.key!(:legs), user_id, Access.key!(:pc)])
  end

  defp ingest_track(room, user_id, source) do
    state = :sys.get_state(room)
    leg = state.media.legs[user_id]

    Enum.find_value(leg.ingress, fn {track_id, {owner, src}} ->
      src == source && {owner, track_id}
    end)
  end

  # Synthetic up-flow: rid-tagged packets injected as the exact
  # notifications the room's PCs would deliver ({:ex_webrtc, pc, ...}).
  defp pump_synthetic(room, pc, source, rid_packets, ingest \\ nil) do
    state = :sys.get_state(room)
    {owner, track_id} = ingest || ingest_track(room, owner_of(state, pc), source)

    for {rid, n} <- rid_packets, i <- 1..n do
      now = System.os_time(:nanosecond)
      packet = ExRTP.Packet.new(<<now::128, i::32>>, timestamp: i, sequence_number: rem(i, 65_536))
      send(room, {:ex_webrtc, pc, {:rtp, track_id, rid, packet}})
    end

    _ = owner
    :ok
  end

  defp owner_of(state, pc) do
    state.media.by_pc[pc]
  end

  # Collect what OUR test process receives from client PCs (the forwarded
  # down-flow surfaces as client-PC {:rtp, ...} notifications here).
  defp receive_rtp_seqs(window_ms) do
    deadline = System.monotonic_time(:millisecond) + window_ms

    receive_rtp_loop(deadline, [])
  end

  defp receive_rtp_loop(deadline, acc) do
    left = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:ex_webrtc, _pc, {:rtp, _track_id, _rid, packet}} ->
        receive_rtp_loop(deadline, [%{seq: packet.sequence_number} | acc])

      {:ex_webrtc, _pc, _other} ->
        receive_rtp_loop(deadline, acc)

      {:sink_event, _event, _payload} ->
        receive_rtp_loop(deadline, acc)
    after
      left -> Enum.reverse(acc)
    end
  end

  # Relay both ways' trickled ICE until quiet, so every client PC's
  # transport comes up (V1's await_connected! pattern, compressed: we
  # don't assert connected here, we just let the trickle drain).
  defp settle_media!(room, clients, quiet_ms \\ 400) do
    deadline = System.monotonic_time(:millisecond) + 4_000

    settle_loop(room, clients, deadline, System.monotonic_time(:millisecond) + quiet_ms, quiet_ms)
  end

  defp settle_loop(room, clients, deadline, quiet_until, quiet_ms) do
    now = System.monotonic_time(:millisecond)

    cond do
      now > deadline ->
        :ok

      now > quiet_until ->
        :ok

      true ->
        receive do
          {:ex_webrtc, pc, {:ice_candidate, candidate}} ->
            case Enum.find(clients, fn {_uid, c} -> c.pc == pc end) do
              {_uid, ctx} ->
                send(
                  room,
                  {:call_signal, ctx.user_id, ctx.session, "ice",
                   Jason.encode!(ExWebRTC.ICECandidate.to_json(candidate))}
                )

              nil ->
                :ok
            end

            settle_loop(room, clients, deadline, System.monotonic_time(:millisecond) + quiet_ms, quiet_ms)

          {:sink_event, :call_signal, %{"user_id" => user_id, "kind" => "ice", "body" => body}} ->
            uid = String.to_integer(user_id)

            with %{pc: pc} when pc != nil <- clients[uid] do
              _ = ExWebRTC.PeerConnection.add_ice_candidate(pc, ExWebRTC.ICECandidate.from_json(Jason.decode!(body)))
            end

            settle_loop(room, clients, deadline, System.monotonic_time(:millisecond) + quiet_ms, quiet_ms)

          {:ex_webrtc, _pc, _other} ->
            settle_loop(room, clients, deadline, quiet_until, quiet_ms)

          {:sink_event, _event, _payload} ->
            settle_loop(room, clients, deadline, quiet_until, quiet_ms)
        after
          quiet_ms -> :ok
        end
    end
  end

  defp cleanup!(room, clients) do
    Enum.each(clients, fn {_uid, ctx} -> stop_pc(ctx) end)

    for {user_id, _} <- :sys.get_state(room).participants do
      Calls.Room.leave(room, user_id)
    end
  end

  defp stop_pc(%{pc: pc}) when is_pid(pc), do: PeerConnection.stop(pc)
  defp stop_pc(_), do: :ok
end
