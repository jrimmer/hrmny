defmodule Cytale.Calls.MediaTest do
  @moduledoc """
  Voice plan U5 — the SFU media plane: server PCs negotiated over the
  op-23/CALL_SIGNAL seam (ex_webrtc itself as the remote end — the spike's
  fanout-harness technique, driven at the room's signal-handling seam
  rather than a real websocket), the forwarding loop with AM12 deafen
  exclusion and client-side mute, PC failure (crash and :failed →
  restart-once → removal), the sole-offer renegotiation with the glare
  guard, teardown on room end (no orphan processes), and loopback-only ICE
  (no TURN).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls
  alias Cytale.Calls.Room
  alias ExWebRTC.{ICECandidate, MediaStreamTrack, PeerConnection, SessionDescription}

  # The recorder (room_test pattern): room transitions + U5 media signals
  # forwarded to the listening test process.
  defmodule RecordingSink do
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

  @short_sweep 400

  setup do
    old_calls = Application.get_env(:cytale, :calls, [])

    Application.put_env(
      :cytale,
      :calls,
      Keyword.merge(old_calls, empty_sweep_ms: @short_sweep, event_sink: RecordingSink)
    )

    RecordingSink.listen(self())

    on_exit(fn ->
      Application.put_env(:cytale, :calls, old_calls)
      RecordingSink.unlisten()
    end)

    :ok
  end

  # -- Harness: the fake browser (a test-process-owned ex_webrtc PC) ---------------------

  defp spawn_session do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  # The first participant: starts the call, consumes the initial offer.
  defp start_connected(channel_id, user_id) do
    session = spawn_session()
    {:ok, _} = Calls.start_call(channel_id, user_id, session)
    room = Calls.room_pid(channel_id)
    offer = next_signal!(user_id, "sdp")
    client = connect_client!(client_ctx(room, channel_id, user_id, session), offer)
    %{user_id => client}
  end

  # A later participant: joins, consumes their fresh offer, then answers
  # the one renegotiation offer every existing participant received.
  defp join_connected(channel_id, prev, user_id) do
    session = spawn_session()
    {:ok, _} = Calls.join_call(channel_id, user_id, session)
    room = Calls.room_pid(channel_id)
    offer = next_signal!(user_id, "sdp")
    client = connect_client!(client_ctx(room, channel_id, user_id, session), offer)
    clients = Map.put(prev, user_id, client)
    drain_renegotiations!(clients)
    clients
  end

  defp client_ctx(room, channel_id, user_id, session),
    do: %{room: room, channel_id: channel_id, user_id: user_id, session: session}

  # V2 offers are envelope-v2 bodies ({"v":2,"type":"offer","sdp":...,
  # "tracks":[...]}): the fake browser applies the inner SDP (the spike's
  # library arm showed ex_webrtc's answerer accepts even the rid-spliced
  # text; it just cannot ORIGINATE rids — that half is browser-only).
  defp unwrap_offer(%{"v" => 2, "sdp" => sdp, "type" => "offer"}),
    do: %{"type" => "offer", "sdp" => sdp}

  defp unwrap_offer(v1_json) when is_map(v1_json), do: v1_json

  defp connect_client!(ctx, offer_json) do
    offer_json = unwrap_offer(offer_json)
    # NOT linked. A fake browser is a harness, not code under test, and its
    # WebRTC stack (ex_dtls) can die when the SERVER closes its end of the leg
    # (a :failed removal, the call ending): its DTLS transport stops with the
    # malformed reason `{[], []}` while handling the server's close alert, and
    # takes the PeerConnection with it. Linked, that took the TEST down with
    # `ErlangError []` in `gen_server.terminate/10` (CI, the run on 3f0073e4;
    # and the ICE-restart test here, at the deliberate removal). A browser that
    # dies early still fails the test where it matters: its media assertions.
    # The server's side of the same exchange is the room's own PCs, which it
    # links and traps (a PC exit is a voice-unavailable removal, never a room
    # crash).
    {:ok, pc} = PeerConnection.start(controlling_process: self())
    mic = MediaStreamTrack.new(:audio)

    # The browser shape: apply the offer, attach the mic to the offered
    # ingest m-line, tighten it to sendonly (the honest SFU answer).
    :ok = PeerConnection.set_remote_description(pc, SessionDescription.from_json(offer_json))
    {:ok, _sender} = PeerConnection.add_track(pc, mic)

    for transceiver <- PeerConnection.get_transceivers(pc),
        transceiver.sender.track != nil and transceiver.sender.track.id == mic.id do
      :ok = PeerConnection.set_transceiver_direction(pc, transceiver.id, :sendonly)
    end

    {:ok, answer} = PeerConnection.create_answer(pc)
    :ok = PeerConnection.set_local_description(pc, answer)
    send_op23!(ctx, "sdp", Jason.encode!(SessionDescription.to_json(answer)))
    Map.put(ctx, :pc, pc) |> Map.put(:mic, mic)
  end

  # Apply a later server offer (roster renegotiation / ICE restart).
  defp apply_offer!(%{pc: pc} = ctx, offer_json) do
    offer_json = unwrap_offer(offer_json)
    :ok = PeerConnection.set_remote_description(pc, SessionDescription.from_json(offer_json))
    {:ok, answer} = PeerConnection.create_answer(pc)
    :ok = PeerConnection.set_local_description(pc, answer)
    send_op23!(ctx, "sdp", Jason.encode!(SessionDescription.to_json(answer)))
  end

  defp send_op23!(%{room: room, user_id: user_id, session: session}, kind, body) do
    send(room, {:call_signal, user_id, session, kind, body})
  end

  # After a join, every already-connected client has exactly one pending
  # renegotiation offer — answer them all (recursive drain: the glare guard
  # means there is at most one outstanding offer per user at a time).
  defp drain_renegotiations!(clients) do
    Enum.each(clients, fn {user_id, client} ->
      case poll_signal(user_id, "sdp") do
        nil -> :ok
        offer -> apply_offer!(client, offer)
      end
    end)
  end

  # Relay both ways' trickled ICE until every client PC reports connected.
  defp await_connected!(clients, timeout \\ 20_000) do
    deadline = System.monotonic_time(:millisecond) + timeout

    case await_loop(clients, MapSet.new(), deadline) do
      {:ok, _connected} ->
        :ok

      {:timeout, connected} ->
        missing = for {uid, c} <- clients, not MapSet.member?(connected, c.pc), do: uid
        flunk("not connected within #{timeout}ms: #{inspect(missing)}")
    end
  end

  defp await_loop(clients, connected, deadline) do
    if map_size(clients) == MapSet.size(connected) do
      {:ok, connected}
    else
      left = max(deadline - System.monotonic_time(:millisecond), 0)

      receive do
        {:ex_webrtc, pc, {:connection_state_change, :connected}} ->
          await_loop(clients, MapSet.put(connected, pc), deadline)

        {:ex_webrtc, pc, {:ice_candidate, candidate}} ->
          relay_client_ice!(clients, pc, candidate)
          await_loop(clients, connected, deadline)

        {:sink_event, :call_signal, %{"user_id" => user_id, "kind" => "ice", "body" => body}} ->
          with %{pc: pc} <- clients[user_id] do
            _ = PeerConnection.add_ice_candidate(pc, ICECandidate.from_json(Jason.decode!(body)))
          end

          await_loop(clients, connected, deadline)

        {:ex_webrtc, _pc, _other} ->
          await_loop(clients, connected, deadline)

        {:sink_event, _event, _payload} ->
          await_loop(clients, connected, deadline)
      after
        left -> {:timeout, connected}
      end
    end
  end

  defp relay_client_ice!(clients, pc, candidate) do
    case Enum.find(clients, fn {_uid, c} -> c.pc == pc end) do
      {_uid, client} ->
        send_op23!(client, "ice", Jason.encode!(ICECandidate.to_json(candidate)))

      nil ->
        :ok
    end
  end

  # Pump synthetic RTP from one client's mic, recording arrivals (with
  # end-to-end latency) at every receiver while ICE keeps flowing.
  defp pump_and_collect(sender, clients, receivers, packets, interval_ms) do
    receiver_map = Map.new(for r <- receivers, do: {clients[r].pc, true})
    by_pc = for {uid, c} <- clients, into: %{}, do: {c.pc, uid}

    acc =
      Enum.reduce(1..packets, %{}, fn i, acc ->
        # Monotonic across the WHOLE test: RTP receivers drop re-used low
        # sequence numbers as stale duplicates (a per-phase reset froze the
        # ingest after the first pump).
        seq = System.unique_integer([:positive, :monotonic])
        now = System.os_time(:nanosecond)
        packet = ExRTP.Packet.new(<<now::128, seq::32>>, timestamp: seq, sequence_number: rem(seq, 65_536))
        PeerConnection.send_rtp(sender.pc, sender.mic.id, packet)
        collect_rtp(clients, receiver_map, by_pc, System.monotonic_time(:millisecond) + interval_ms, acc)
      end)

    collect_rtp(clients, receiver_map, by_pc, System.monotonic_time(:millisecond) + 500, acc)
  end

  # Collects until the DEADLINE, not until the first message: every clause
  # recurses. (It used to return after ONE message of any kind, so a pump of N
  # packets could count at most N+1 arrivals across ALL receivers — fine when
  # the 20 ms windows interleave arrivals evenly, and a guaranteed failure when
  # CPU pressure lets one receiver's packets queue ahead of another's: the
  # receivers' PCs got every packet while the test counted one, CI red twice.)
  defp collect_rtp(clients, receiver_map, by_pc, deadline, acc) do
    left = max(deadline - System.monotonic_time(:millisecond), 0)

    receive do
      {:ex_webrtc, pc, {:rtp, _track_id, _rid, packet}} when is_map_key(receiver_map, pc) ->
        <<sent_ns::128, seq::32>> = packet.payload
        # Microsecond precision: loopback hops are sub-millisecond.
        latency_us = div(System.os_time(:nanosecond) - sent_ns, 1_000)
        entry = %{seq: seq, latency_us: latency_us}
        collect_rtp(clients, receiver_map, by_pc, deadline, Map.update(acc, by_pc[pc], [entry], &[entry | &1]))

      {:ex_webrtc, pc, {:ice_candidate, candidate}} ->
        relay_client_ice!(clients, pc, candidate)
        collect_rtp(clients, receiver_map, by_pc, deadline, acc)

      {:sink_event, :call_signal, %{"user_id" => user_id, "kind" => "ice", "body" => body}} ->
        with %{pc: pc} <- clients[user_id] do
          _ = PeerConnection.add_ice_candidate(pc, ICECandidate.from_json(Jason.decode!(body)))
        end

        collect_rtp(clients, receiver_map, by_pc, deadline, acc)

      {:ex_webrtc, _pc, _other} ->
        collect_rtp(clients, receiver_map, by_pc, deadline, acc)

      {:sink_event, _event, _payload} ->
        collect_rtp(clients, receiver_map, by_pc, deadline, acc)
    after
      left -> acc
    end
  end

  # -- Harness: sink readers / misc ------------------------------------------------------

  defp next_signal!(user_id, kind, timeout \\ 10_000) do
    user_id_s = Integer.to_string(user_id)

    receive do
      {:sink_event, :call_signal, %{"user_id" => ^user_id_s, "kind" => ^kind, "body" => body}} ->
        Jason.decode!(body)
    after
      timeout -> flunk("no #{kind} signal for user #{user_id} within #{timeout}ms")
    end
  end

  defp poll_signal(user_id, kind) do
    user_id_s = Integer.to_string(user_id)

    receive do
      {:sink_event, :call_signal, %{"user_id" => ^user_id_s, "kind" => ^kind, "body" => body}} ->
        Jason.decode!(body)
    after
      150 -> nil
    end
  end

  # Await one wire call_update (user + state) WITHOUT discarding media
  # signals: everything else is buffered and re-queued afterwards (a plain
  # drain would eat renegotiation offers the test still needs).
  defp wait_call_update!(user_id, state, timeout \\ 5_000) do
    case wait_cu_loop(Integer.to_string(user_id), state, timeout, []) do
      {:ok, payload, buffered} ->
        Enum.each(buffered, &send(self(), &1))
        payload

      {:timeout, buffered} ->
        Enum.each(buffered, &send(self(), &1))
        flunk("no call_update #{state} for user #{user_id} within #{timeout}ms")
    end
  end

  defp wait_cu_loop(uid, state, timeout, buffered) do
    receive do
      {:sink_event, :call_update, %{"user_id" => ^uid, "state" => ^state} = payload} ->
        {:ok, payload, buffered}

      other ->
        wait_cu_loop(uid, state, timeout, [other | buffered])
    after
      timeout -> {:timeout, buffered}
    end
  end

  defp drain_sink_events(ms \\ 100) do
    receive do
      {:sink_event, event, payload} -> [{event, payload} | drain_sink_events(ms)]
    after
      ms -> []
    end
  end

  # Active audio m-lines only: a stopped transceiver stays as a REJECTED
  # (port-0) m-line in later offers (JSEP m-line preservation) — those do
  # not count as carried tracks.
  defp count_audio_mlines(%{"sdp" => sdp}) do
    sdp
    |> String.split(["\r\n", "\n"])
    |> Enum.filter(&String.starts_with?(&1, "m=audio "))
    |> Enum.count(&(&1 |> String.split(" ") |> Enum.at(1) != "0"))
  end

  # Settling time before a "receives nothing" assertion: discard RTP for
  # `ms` (in-flight packets from before the state change).
  defp settle(clients, ms) do
    pcs = Map.new(for {_uid, c} <- clients, do: {c.pc, true})
    left = max(ms, 0)

    receive do
      {:ex_webrtc, pc, {:rtp, _t, _r, _p}} when is_map_key(pcs, pc) -> settle(clients, ms)
      {:ex_webrtc, _pc, _other} -> settle(clients, ms)
      {:sink_event, _e, _p} -> settle(clients, ms)
    after
      left -> :ok
    end
  end

  defp cleanup!(channel_id, clients) do
    snapshot = Calls.live_call(channel_id)

    if snapshot do
      Enum.each(snapshot.participants, &Calls.leave_call(channel_id, &1.user_id))
    end

    eventually_true?(5_000, fn -> is_nil(Calls.room_pid(channel_id)) end)

    Enum.each(clients, fn {_uid, c} ->
      stop_browser(c.pc)
      send(c.session, :stop)
    end)
  end

  # A fake browser may already be gone: the server closing ITS end of a leg
  # (a :failed removal, the call ending) is exactly when the browser's DTLS
  # transport can die on the alert (see connect_client!/2). Stopping a dead
  # PC is not a failure of the code under test.
  defp stop_browser(pc) do
    PeerConnection.stop(pc)
  catch
    :exit, _ -> :ok
  end

  defp eventually_true?(timeout_ms, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    eventually_loop(deadline, fun)
  end

  defp eventually_loop(deadline, fun) do
    cond do
      fun.() ->
        true

      System.monotonic_time(:millisecond) >= deadline ->
        false

      true ->
        Process.sleep(25)
        eventually_loop(deadline, fun)
    end
  end

  # -- (a)+(f) Happy path: seam negotiation, forwarding, loopback ICE --------------------

  test "server PCs negotiate over the op-23/CALL_SIGNAL seam and forward RTP to every other participant" do
    # (f): the suite runs with NO STUN/TURN — loopback host ICE is all a
    # connected pair ever needs here.
    assert Cytale.Calls.ICE.config().ice_servers == []

    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()
    p3 = Cytale.Snowflake.next()

    clients =
      start_connected(channel_id, p1)
      |> then(&join_connected(channel_id, &1, p2))
      |> then(&join_connected(channel_id, &1, p3))

    await_connected!(clients)
    drain_sink_events()

    # RTP pumped by P1's test PC arrives at BOTH subscriber test PCs.
    arrivals = pump_and_collect(clients[p1], clients, [p2, p3], 40, 20)

    for user_id <- [p2, p3] do
      entries = Map.get(arrivals, user_id, [])
      assert length(entries) >= 10, "user #{user_id} received #{length(entries)} packets"

      latencies = entries |> Enum.map(& &1.latency_us) |> Enum.sort()
      max_latency = List.last(latencies)
      # In-suite sanity (not perf): loopback fan-out well under 250ms.
      assert max_latency < 250_000, "user #{user_id} max latency #{max_latency}us"
      # Evidence line for the U5 report (observed, not asserted).
      median = Enum.at(latencies, div(length(latencies), 2))
      IO.puts("U5 latency user=#{user_id} packets=#{length(entries)} median=#{median}us max=#{max_latency}us")
    end

    # Sequence continuity sanity: P2/P3 saw the same stream P1 pumped.
    seqs = arrivals[p2] |> Enum.map(& &1.seq) |> Enum.uniq() |> length()
    assert seqs >= 10

    cleanup!(channel_id, clients)
  end

  # -- (b) Deafen exclusion (AM12) and client-side mute ----------------------------------

  test "deafen stops forwarding TO the deafened participant; mute is client-side" do
    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()
    p3 = Cytale.Snowflake.next()

    clients =
      start_connected(channel_id, p1)
      |> then(&join_connected(channel_id, &1, p2))
      |> then(&join_connected(channel_id, &1, p3))

    await_connected!(clients)
    drain_sink_events()

    # Baseline: everyone hears P1.
    baseline = pump_and_collect(clients[p1], clients, [p2, p3], 10, 20)
    assert length(Map.get(baseline, p2, [])) >= 3
    assert length(Map.get(baseline, p3, [])) >= 3

    # P2 deafens: state event flows; P2's egress goes silent, P3 unaffected.
    assert {:ok, %{deafen: true, mute: true}} = Calls.update_participant(channel_id, p2, %{deafen: true})
    assert %{"state" => "deafened", "user_id" => p2_s} = wait_call_update!(p2, "deafened")
    assert p2_s == Integer.to_string(p2)

    settle(clients, 300)
    deafened = pump_and_collect(clients[p1], clients, [p2, p3], 15, 20)
    assert Map.get(deafened, p2, []) == []
    assert length(Map.get(deafened, p3, [])) >= 5

    # Un-deafening restores P2's feed (the exclusion was the deafen flag,
    # not a torn-down PC).
    assert {:ok, _} = Calls.update_participant(channel_id, p2, %{deafen: false})
    _ = wait_call_update!(p2, "undeafened")
    restored = pump_and_collect(clients[p1], clients, [p2, p3], 15, 20)
    assert length(Map.get(restored, p2, [])) >= 5
    assert length(Map.get(restored, p3, [])) >= 5

    # P1 client-mutes: the client stops sending (no server gate), the mute
    # state event flows, and — with P1 silent — P3's stream still reaches
    # the (now un-deafened) others: mute never blocks RECEIVING.
    assert {:ok, _} = Calls.update_participant(channel_id, p1, %{mute: true})
    assert %{"state" => "muted", "user_id" => p1_s} = wait_call_update!(p1, "muted")
    assert p1_s == Integer.to_string(p1)

    settle(clients, 300)
    from_p3 = pump_and_collect(clients[p3], clients, [p1, p2], 15, 20)
    assert length(Map.get(from_p3, p1, [])) >= 5
    assert length(Map.get(from_p3, p2, [])) >= 5

    cleanup!(channel_id, clients)
  end

  # -- (c1) PC crash: voice-unavailable removal, room survives ---------------------------

  test "a killed server PC removes its participant; the room survives and renegotiates the rest" do
    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()
    p3 = Cytale.Snowflake.next()

    clients =
      start_connected(channel_id, p1)
      |> then(&join_connected(channel_id, &1, p2))
      |> then(&join_connected(channel_id, &1, p3))

    await_connected!(clients)
    drain_sink_events()

    room = Calls.room_pid(channel_id)
    assert map_size(Room.media_pcs(room)) == 3

    Process.exit(Room.media_pcs(room)[p1], :kill)

    # Voice-unavailable: P1 left (wire state `left`), the roster shrank,
    # the room itself lives on.
    assert %{"state" => "left", "user_id" => p1_s} = wait_call_update!(p1, "left")
    assert p1_s == Integer.to_string(p1)

    roster = Calls.live_call(channel_id).participants |> Enum.map(& &1.user_id) |> MapSet.new()
    assert roster == MapSet.new([p2, p3])
    assert Process.alive?(room)

    # P1's PC is gone; P2/P3 renegotiated (each one new offer, P1's egress
    # m-line stopped: 2 audio m-lines — ingest + the other survivor).
    pcs = Room.media_pcs(room)
    assert Map.has_key?(pcs, p2) and Map.has_key?(pcs, p3) and not Map.has_key?(pcs, p1)

    offer_p2 = next_signal!(p2, "sdp")
    offer_p3 = next_signal!(p3, "sdp")
    assert count_audio_mlines(offer_p2) == 2
    assert count_audio_mlines(offer_p3) == 2
    apply_offer!(clients[p2], offer_p2)
    apply_offer!(clients[p3], offer_p3)

    # The survivors keep forwarding after the removal (settling first:
    # the removal's renegotiation work queues briefly in the room).
    settle(clients, 500)
    arrivals = pump_and_collect(clients[p3], clients, [p2], 20, 20)

    assert length(Map.get(arrivals, p2, [])) >= 3

    cleanup!(channel_id, clients)
  end

  # -- (c2) :failed → one ICE restart → still failed → removal ---------------------------

  test "connection :failed gets one ICE restart; a second :failed removes the participant" do
    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()

    clients =
      start_connected(channel_id, p1)
      |> then(&join_connected(channel_id, &1, p2))

    await_connected!(clients)
    drain_sink_events()

    room = Calls.room_pid(channel_id)
    pc_p1 = Room.media_pcs(room)[p1]

    # First :failed — driven at the message seam (the room cannot tell a
    # real ex_webrtc notification from this one): one restart offer.
    send(room, {:ex_webrtc, pc_p1, {:connection_state_change, :failed}})
    restart_offer = next_signal!(p1, "sdp")
    assert restart_offer["type"] == "offer"
    apply_offer!(clients[p1], restart_offer)

    assert match?(%{participants: [%{user_id: ^p1}, %{user_id: ^p2}]}, Calls.live_call(channel_id))

    # Second :failed — the restart was spent: removal, room survives.
    send(room, {:ex_webrtc, pc_p1, {:connection_state_change, :failed}})

    assert %{"state" => "left", "user_id" => p1_s} = wait_call_update!(p1, "left")
    assert p1_s == Integer.to_string(p1)
    assert Process.alive?(room)
    assert match?(%{participants: [%{user_id: ^p2}]}, Calls.live_call(channel_id))

    # P2 renegotiated down to just their ingest m-line.
    offer_p2 = next_signal!(p2, "sdp")
    assert count_audio_mlines(offer_p2) == 1
    apply_offer!(clients[p2], offer_p2)

    cleanup!(channel_id, clients)
  end

  # -- (d) Roster-change renegotiation + the glare guard --------------------------------

  test "a join renegotiates existing participants; changes queue behind an un-answered offer" do
    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()
    p3 = Cytale.Snowflake.next()

    # P1 starts and P2 joins; BOTH initial offers stay un-answered — then
    # P1 answers, P2 stays pending (the glare setup).
    session_p1 = spawn_session()
    {:ok, _} = Calls.start_call(channel_id, p1, session_p1)
    room = Calls.room_pid(channel_id)
    offer_p1_initial = next_signal!(p1, "sdp")
    assert count_audio_mlines(offer_p1_initial) == 1

    session_p2 = spawn_session()
    {:ok, _} = Calls.join_call(channel_id, p2, session_p2)
    offer_p2_initial = next_signal!(p2, "sdp")

    # P1's renegotiation offer (P2's egress added) queued behind P1's
    # un-answered initial offer — it must NOT be on the wire yet.
    assert poll_signal(p1, "sdp") == nil

    client_p1 = connect_client!(client_ctx(room, channel_id, p1, session_p1), offer_p1_initial)

    # The answer flushes the queued roster change: offer #2 arrives with
    # the added egress m-line.
    offer_p1_renego = next_signal!(p1, "sdp")
    assert count_audio_mlines(offer_p1_renego) == 2
    apply_offer!(client_p1, offer_p1_renego)

    # P2 connects (fresh PC, two m-lines) — then P3 joins.
    client_p2 = connect_client!(client_ctx(room, channel_id, p2, session_p2), offer_p2_initial)
    assert count_audio_mlines(offer_p2_initial) == 2

    clients = %{p1 => client_p1, p2 => client_p2}
    drain_renegotiations!(clients)
    drain_sink_events()

    session_p3 = spawn_session()
    {:ok, _} = Calls.join_call(channel_id, p3, session_p3)

    # The join produced new offers to P1 and P2, each carrying P3's added
    # track (three audio m-lines: ingest + two egress).
    offer_p1 = next_signal!(p1, "sdp")
    offer_p2 = next_signal!(p2, "sdp")
    assert count_audio_mlines(offer_p1) == 3
    assert count_audio_mlines(offer_p2) == 3
    apply_offer!(clients[p1], offer_p1)
    apply_offer!(clients[p2], offer_p2)

    # And P3's own fresh offer carries both existing participants.
    offer_p3 = next_signal!(p3, "sdp")
    assert count_audio_mlines(offer_p3) == 3

    client_p3 = connect_client!(client_ctx(room, channel_id, p3, session_p3), offer_p3)
    clients = Map.put(clients, p3, client_p3)
    drain_renegotiations!(clients)
    await_connected!(clients)

    # End-to-end after the glare sequence: audio flows between all three.
    arrivals = pump_and_collect(clients[p1], clients, [p2, p3], 20, 20)
    assert length(Map.get(arrivals, p2, [])) >= 5
    assert length(Map.get(arrivals, p3, [])) >= 5

    cleanup!(channel_id, clients)
  end

  # -- (e) Room end tears down every PC ---------------------------------------------------

  test "room end tears down all server PCs — no orphan processes" do
    # By pid, not by count (#172): a PC left by the previous test can still be
    # shutting down here, and its exit moved a global count by one (13
    # expected, 12 seen on CI). The pids running now are not this room's,
    # whether or not they exit while it runs.
    before = MapSet.new(PeerConnection.get_all_running())
    ours = fn -> Enum.reject(PeerConnection.get_all_running(), &MapSet.member?(before, &1)) end

    channel_id = Cytale.Snowflake.next()
    p1 = Cytale.Snowflake.next()
    p2 = Cytale.Snowflake.next()
    p3 = Cytale.Snowflake.next()

    clients =
      start_connected(channel_id, p1)
      |> then(&join_connected(channel_id, &1, p2))
      |> then(&join_connected(channel_id, &1, p3))

    await_connected!(clients)

    # 3 server PCs + 3 client PCs.
    room_pcs = ours.()
    assert length(room_pcs) == 6

    # Everyone leaves → the empty sweep ends the call → the room exits →
    # its linked PCs go down with it.
    Enum.each([p1, p2, p3], &Calls.leave_call(channel_id, &1))
    assert eventually_true?(5_000, fn -> is_nil(Calls.room_pid(channel_id)) end)

    Enum.each(clients, fn {_uid, c} ->
      stop_browser(c.pc)
      send(c.session, :stop)
    end)

    assert eventually_true?(5_000, fn ->
             not Enum.any?(room_pcs, &Process.alive?/1)
           end)
  end
end
