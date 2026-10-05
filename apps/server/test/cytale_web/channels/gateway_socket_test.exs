defmodule CytaleWeb.GatewaySocketTest do
  @moduledoc """
  U10 wire-level gateway lifecycle tests, driven against a REAL Bandit
  listener with `CytaleWeb.GatewaySocket` mounted: Hello → Identify → Ready →
  heartbeats → compression → resume (buffered replay, single-use token,
  identity binding, expiry) → client commands (TYPING_START throttle,
  MESSAGE_ACK) → protocol violations (close codes) → planned drain.
  """

  use Cytale.GatewayCase, async: false

  import Bitwise

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces

  setup_all do
    # Re-arm the Snowflake cell in case another module cleared
    # persistent_term (same defensive setup as the teardown suite).
    :ok = Cytale.Snowflake.ensure_init()
    :ok
  end

  setup do
    port = start_gateway!()
    # #53: the module's shared identity needs a REAL viewable channel BEFORE it
    # identifies — the visibility memo is seeded at Identify, so a channel
    # created afterwards is not in it. Per-test, because the suite's data is
    # truncated between tests (a module-level fixture would be wiped).
    _ = typing_channel_id()
    # The hidden channel must exist BEFORE Identify: the route set is computed
    # there, and a channel created afterwards is subscribed to by nobody.
    _ = hidden_channel_id()
    %{port: port}
  end

  # ---------------------------------------------------------------------------
  # Lifecycle: Hello → Identify → Ready → heartbeats
  # ---------------------------------------------------------------------------

  describe "connection lifecycle" do
    test "connect delivers Hello with heartbeat interval, compression offer and version", %{
      port: port
    } do
      conn = connect!(port)
      hello = conn.hello

      assert hello["d"]["heartbeat_interval"] == 30_000
      assert hello["d"]["v"] == 1
      assert "zstd_stream" in conn.hello["d"]["compression_modes"]
      assert "zlib_stream" in conn.hello["d"]["compression_modes"]
    end

    test "Identify with a valid token mints a session and dispatches READY", %{port: port} do
      conn = connect!(port)
      ready = identify!(conn, valid_token())

      assert ready["v"] == 1
      assert is_binary(ready["session_id"])
      assert byte_size(ready["resume_token"]) == 32
      assert ready["user"]["username"] != nil

      assert {:ok, %Session{} = stored} = lookup(ready["session_id"])
      assert stored.resume_token == ready["resume_token"]
      assert stored.user.id != nil
      assert Session.live?(stored)
    end

    test "heartbeats are acknowledged and keep the link alive", %{port: port} do
      conn = connect!(port)
      identify!(conn, valid_token())

      send_frame!(conn, 1, nil)

      assert next_op!(conn, 11, 5_000)
    end

    test "second Identify on an established connection is a protocol violation (4005)", %{
      port: port
    } do
      conn = connect!(port)
      identify!(conn, valid_token())

      send_frame!(conn, 2, %{"token" => valid_token(), "v" => 1, "compress" => nil})

      # The identify's own presence announce (and its U4 CallSync
      # establishment backfill) may interleave before the close.
      code = assert_closed_skipping!(conn, 5_000, ["PresenceUpdate", "CallSync", "ReadStateSync"])
      assert code == 4005
    end

    test "client-initiated close terminates cleanly (terminate stamps disconnect)", %{port: port} do
      conn = connect!(port)
      ready = identify!(conn, valid_token())

      send_close!(conn, 1000)

      # The deferred self-announce (and the U4 CallSync backfill) may
      # interleave before the close frame.
      code = assert_closed_skipping!(conn, 5_000, ["PresenceUpdate", "CallSync", "ReadStateSync"])
      assert code == 1000

      # The stored session survives for the resume window, marked disconnected.
      wait_until(fn ->
        case lookup(ready["session_id"]) do
          {:ok, %Session{} = s} -> not Session.live?(s)
          _ -> false
        end
      end)
    end
  end

  # ---------------------------------------------------------------------------
  # Auth / version / decode failures
  # ---------------------------------------------------------------------------

  describe "identify failures" do
    test "invalid token → close 4004 auth failure", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(invalid_token()))

      assert assert_closed!(conn, 5_000) == 4004
    end

    test "malformed token → close 4004 after InvalidSession(false)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, identify_d(123))

      # Frames flushed before the close must include InvalidSession resumable=false.
      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4004
    end

    test "unsupported gateway version → close 4012", %{port: port} do
      conn = connect!(port)

      send_frame!(conn, 2, identify_d(valid_token()) |> Map.put("v", 99))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4012
    end

    test "missing v → close 4001 decode error", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 2, %{"token" => valid_token(), "compress" => nil})

      assert assert_closed!(conn, 5_000) == 4001
    end

    # U7: the gate is keyed on credential type AFTER auth — a native (Stub)
    # credential presenting the compat version is still 4012, exactly as
    # before the reorder.
    test "native Identify with v=10 (compat version) → close 4012", %{port: port} do
      conn = connect!(port)

      send_frame!(conn, 2, identify_d(valid_token()) |> Map.put("v", 10))

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4012
    end

    # U7: Hello echoes the connection URL's requested version (compat
    # clients arrive via /gateway/bot's ?v=10 URL).
    test "Hello echoes the connection URL version (?v=10)", %{port: port} do
      conn = connect!(port, v: 10)
      assert conn.hello["d"]["v"] == 10
    end

    test "an `intents` field on a NATIVE Identify is ignored (native unchanged)", %{port: port} do
      conn = connect!(port)

      ready =
        identify!(conn,
          raw_d: %{
            "token" => valid_token(),
            "v" => 1,
            "intents" => 2561,
            "compress" => nil,
            "properties" => %{"os" => "test", "browser" => "gateway_case", "device" => "test"}
          }
        )

      assert ready["v"] == 1
      assert is_binary(ready["session_id"])
    end
  end

  describe "decode / opcode violations" do
    test "invalid JSON → close 4001", %{port: port} do
      conn = connect!(port)
      send_raw!(conn, "this is not json")

      assert assert_closed!(conn, 5_000) == 4001
    end

    test "unknown opcode (voice legacy 4) → close 4002", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 4, nil)

      assert assert_closed!(conn, 5_000) == 4002
    end

    # 24 is FOCUS_UPDATE as of the notifications plan (U5), so the probe moved
    # to 25 — the first still-unassigned reserved slot.
    test "unknown opcode (reserved-undefined 25) → close 4002 (no gap consumption)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 25, nil)

      assert assert_closed!(conn, 5_000) == 4002
    end

    # Calls plan U1: ops 22/23 are DEFINED on the wire (mirrored in
    # Cytale.Gateway.Opcode) but no call room consumes them yet — routing
    # lands in U4. Pre-U4 they are accepted no-ops on an authenticated
    # session, exactly like op 3 before presence wiring.
    test "voice ops 22/23 are accepted no-ops pre-U4 (connection survives)", %{port: port} do
      conn = connect!(port)
      identify!(conn, valid_token())

      send_frame!(conn, 22, %{"channel_id" => "123", "action" => "start"})
      send_frame!(conn, 23, %{"channel_id" => "123", "kind" => "sdp", "body" => "v=0"})

      # The link is still alive: a heartbeat round-trip proves no close.
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end

    test "voice ops 22/23 before Identify → close 4003 (command gate)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 22, %{"channel_id" => "123", "action" => "join"})

      assert assert_closed!(conn, 5_000) == 4003
    end

    test "server-only opcode (op 11) from the client → close 4002", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 11, nil)

      assert assert_closed!(conn, 5_000) == 4002
    end

    test "non-object envelope → close 4001", %{port: port} do
      conn = connect!(port)
      send_raw!(conn, "[1,2,3]")

      assert assert_closed!(conn, 5_000) == 4001
    end
  end

  # ---------------------------------------------------------------------------
  # Resume (F3 / AE2)
  # ---------------------------------------------------------------------------

  describe "resume" do
    test "drop → reconnect → Resume replays buffered events from seq+1", %{port: port} do
      # Session 1: identify and observe two fan-out dispatches.
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      token = ready["resume_token"]

      # Drive events to this user's sockets: a typing event on a channel the
      # socket subscribed to, and a second one for good measure. The deferred
      # self-announce may interleave anywhere — select by content, and keep
      # every seq claim RELATIVE (the announce consumes a seq when it lands
      # first).
      user_id = ready["user"]["id"]
      user_key = PushRegistry.user_key(user_id)

      # Every test here signs in as the same user, and the previous test's
      # socket closes asynchronously after its client dies. Until it is gone
      # it still counts as a live subscriber on the user key, and the
      # offline-delivery assertion below sees 1 instead of 0. Wait for this
      # socket to be the user's only one.
      wait_until(fn -> length(PushRegistry.subscribers(user_key)) == 1 end, 250)

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      f1 = next_event!(conn1, "TypingStart", 5_000)
      f2 = next_event!(conn1, "TypingStart", 5_000)
      assert f2["s"] == f1["s"] + 1
      last_seen_seq = f2["s"]

      # Drop.
      Cytale.Test.WSClient.stop(conn1.pid)

      # The drop itself must make the session ADDRESSABLE for its routes while
      # it is inside the resume window (hardening plan 4.2): terminate/2 holds
      # the routes it captured before `drop_session/1` erased them. Wait for it,
      # rather than racing the socket's terminate.
      wait_until(fn -> sid in PushRegistry.held_sessions(user_key) end)

      # Feed one MORE event while disconnected THROUGH THE PRODUCTION SEAM — the
      # user-addressed delivery the read-ack/profile/DM origins call. It finds no
      # live socket (the registry has no pid for this session any more) and must
      # land in the held session's resume buffer; the previous version of this
      # test wrote that buffer by hand, which is exactly the gap 4.2 closed.
      {:ok, %Session{} = dropped_before} = lookup(sid)

      assert Cytale.Workspaces.FanOut.deliver_user_keys(
               [String.to_integer(user_id)],
               {"MessageAck", %{"channel_id" => "c1", "user_id" => user_id}}
             ) == 0

      # The offline append is a cast since review #21 (the fan-out must never
      # block on a shard); read the record once the shards have applied it.
      Cytale.Gateway.SessionStore.await_offline_appends()

      {:ok, %Session{} = dropped} = lookup(sid)
      assert dropped.seq == dropped_before.seq + 1
      env_seq = dropped.seq

      # Session 2: reconnect and resume from the last processed seq.
      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => last_seen_seq,
        "resume_token" => token
      })

      resumed = next_event!(conn2, "Resumed", 5_000)
      assert resumed["op"] == 0

      replay = next_event!(conn2, "MessageAck", 5_000)
      assert replay["s"] == env_seq

      # Nothing further buffered — silence now (heartbeats keep the link).
      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)

      # Adoption retires the offline hold: the live socket is the record's
      # writer again, so the fan-out must stop buffering for this session. (The
      # suite's stub identity is shared, so older tests' dropped sessions may
      # still be held on this same user key — assert about THIS session.)
      refute sid in PushRegistry.held_sessions(user_key)

      # The resume token is single-use: it no longer matches the stored record.
      assert {:ok, %Session{} = stored} = lookup(sid)
      refute stored.resume_token == token
      assert Session.live?(stored)
    end

    test "a HIDDEN channel's buffered event is never replayed (native, plan 4.2)", %{port: port} do
      # The security half of the durable offline buffer. A session's held routes
      # are EVERY channel of every workspace it belongs to (`fanout_route_keys/2`)
      # — visibility is enforced in the SOCKET (`visible_dispatch?`), not by the
      # route. So the fan-out can buffer an event the live gate would have
      # dropped, and the replay must apply the same gate: rights may have
      # narrowed, or (here) the channel may never have been visible at all.
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      token = ready["resume_token"]
      user_id = ready["user"]["id"]

      hidden = hidden_channel_id()

      # Live: the hidden channel's event is delivered to the route and DROPPED by
      # the socket gate, so nothing reaches the wire (the behaviour the replay
      # must match). This also drains the join-time presence traffic.
      publish_message(hidden, "live-secret")
      Cytale.Gateway.SessionStore.await_offline_appends()
      refute_next_event!(conn1, "MessageCreate", 300)

      last_seq = current_seq(sid)
      Cytale.Test.WSClient.stop(conn1.pid)
      wait_until(fn -> sid in PushRegistry.held_sessions(PushRegistry.user_key(user_id)) end)

      # Away: the fan-out appends it to the record (the property 4.2 adds).
      publish_message(hidden, "buffered-secret")
      Cytale.Gateway.SessionStore.await_offline_appends()
      {:ok, %Session{} = dropped} = lookup(sid)

      assert Enum.any?(
               Session.buffered_after(dropped, last_seq),
               &(&1.t == "MessageCreate" and &1.d["content"] == "buffered-secret")
             ),
             "the hidden channel's event never entered the buffer — this test proves nothing"

      # Resume: the buffered event must NOT reach the wire.
      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => last_seq,
        "resume_token" => token
      })

      assert %{"t" => "Resumed"} = next_json!(conn2, 5_000)
      refute_next_event!(conn2, "MessageCreate", 500)

      # The socket is otherwise healthy (the filter did not swallow control flows).
      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)
    end

    test "a push still queued when the socket stops is buffered for the resume (review #22)", %{port: port} do
      # The fan-out addressed this socket while it was LIVE, so the offline
      # path skipped the session for that event — and when the socket stopped
      # with the push still in its mailbox, the event used to die with it.
      # terminate/2 now drains such pushes into the record before stamping the
      # disconnect.
      conn = connect!(port)
      ready = identify!(conn, valid_token())
      sid = ready["session_id"]
      user_id = ready["user"]["id"]

      {socket_pid, ^sid} =
        user_id
        |> String.to_integer()
        |> Cytale.Gateway.SessionStore.principal_sessions()
        |> Enum.find(fn {_pid, session_id} -> session_id == sid end)

      last_seq = current_seq(sid)

      # Hold the socket still so the stop is handled BEFORE the push: the push
      # is guaranteed to be sitting in the mailbox when terminate runs.
      :ok = :sys.suspend(socket_pid)
      send(socket_pid, :cytale_principal_reconnect)

      marker = "queued-behind-stop-#{System.unique_integer([:positive])}"

      send(
        socket_pid,
        {:cytale_gateway_push, self(),
         {"MessageAck", %{"channel_id" => "1", "message_ids" => ["2"], "marker" => marker}}, nil}
      )

      :ok = :sys.resume(socket_pid)
      await_disconnected!(sid)

      {:ok, %Session{} = dropped} = lookup(sid)

      assert Enum.any?(Session.buffered_after(dropped, last_seq), &(&1.d["marker"] == marker)),
             "the queued push never reached the resume buffer"
    end

    test "a TYPING_START on a known channel reads no channel row (review #22)", %{port: port} do
      conn = connect!(port)
      identify!(conn, valid_token())

      channel = typing_channel_id()
      {:ok, ws_id} = Cytale.Publish.ChannelRoutes.fetch(String.to_integer(channel)) |> warm_route(channel)

      parent = self()
      handler = "typing-reads-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler,
          [:xandra, :execute_query, :start],
          fn _event, _m, meta, _ -> send(parent, {:stmt, meta.query.statement}) end,
          nil
        )

      on_exit(fn -> :telemetry.detach(handler) end)

      send_frame!(conn, 20, %{"channel_id" => channel})
      # A heartbeat round trip: the typing op above has been handled once it answers.
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      :telemetry.detach(handler)

      reads = for {:stmt, s} <- flush_messages(), String.contains?(s, "channels_by_id"), do: s
      assert reads == [], "the typing gate read the channel row: #{inspect(reads)}"
      assert is_integer(ws_id)
    end

    test "a publish carrying its accept time is measured at the socket push (review #20)", %{port: port} do
      conn = connect!(port)
      identify!(conn, valid_token())

      parent = self()
      handler = "deliver-ms-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler,
          [:cytale, :message, :deliver_ms],
          fn _event, measurements, meta, _ -> send(parent, {:deliver_ms, measurements, meta}) end,
          nil
        )

      on_exit(fn -> :telemetry.detach(handler) end)

      accepted_at = System.monotonic_time(:millisecond) - 7

      Cytale.Workspaces.FanOut.deliver(
        typing_channel_id(),
        {"MessageCreate",
         %{
           "id" => Integer.to_string(Cytale.Snowflake.next()),
           "channel_id" => typing_channel_id(),
           "content" => "timed"
         }},
        resolved: :channel,
        accepted_at: accepted_at
      )

      assert next_event!(conn, "MessageCreate", 5_000)["d"]["content"] == "timed"
      assert_receive {:deliver_ms, %{duration_ms: ms}, %{event: "MessageCreate"}}, 2_000
      assert ms >= 7
    end

    test "resume token is single-use: a second resume with it fails", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      token = ready["resume_token"]
      Cytale.Test.WSClient.stop(conn1.pid)

      # The client-side stop is asynchronous: until the server's socket has run
      # terminate/2, the session is still held by a LIVE process and a resume
      # is (correctly) refused "already live elsewhere" — op 9 on the FIRST
      # resume, which is not what this test is about.
      await_disconnected!(sid)

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => token
      })

      assert %{"t" => "Resumed"} = next_json!(conn2, 5_000)

      conn3 = connect!(port)

      send_frame!(conn3, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => token
      })

      code = assert_closed!(conn3, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000
    end

    test "stolen session_id without the token cannot replay the buffer", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => ready["user"]["id"]},
        ready["user"]["id"]
      )

      assert next_json!(conn1, 5_000)["s"] == 1

      Cytale.Test.WSClient.stop(conn1.pid)

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => "wrong-token-entirely-0000000000000000"
      })

      code = assert_closed!(conn2, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000

      # The victim's session must NOT have been consumed by the attempt.
      assert {:ok, %Session{} = stored} = lookup(sid)
      assert stored.resume_token != nil
    end

    # -- #52 follow-up: sessions whose holder died UNTRAPPABLY ----------------
    #
    # `max_heap_size` with `kill: true` is untrappable, so terminate/1 never
    # runs: the record keeps phase :connected with no process behind it, and
    # nothing recorded the drop. These pins reach that state deterministically
    # with `Process.exit(pid, :kill)` — the SAME VM state the bound produces
    # (gateway_socket_heap_test drives the real bound end to end).

    test "an untrappably-killed session is adopted by Resume, not forced into a full sync",
         %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      token = ready["resume_token"]
      user_id = ready["user"]["id"]

      # One dispatch the client actually receives, so the resume has a seq to
      # resume FROM.
      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      last_seen_seq = next_event!(conn1, "TypingStart", 5_000)["s"]

      kill_untrappably!(sid)

      # The phantom an untrappable kill leaves: still "live" by phase, with no
      # process behind it.
      assert {:ok, %Session{} = orphan} = lookup(sid)
      assert Session.live?(orphan)

      # An event lands while nothing holds the session (buffered, unread).
      {buffered, env} =
        Session.buffer_event(orphan, "MessageAck", %{"channel_id" => "c1", "user_id" => user_id})

      :ok = SessionStore.update(buffered)

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => last_seen_seq,
        "resume_token" => token
      })

      # ADOPTED. Before this fix it was refused ("session already live
      # elsewhere"), so a bound-killed client had to re-Identify and full-sync.
      assert %{"t" => "Resumed"} = next_event!(conn2, "Resumed", 5_000)

      # …and continuity survived the death: the buffered event replays.
      replay = next_event!(conn2, "MessageAck", 5_000)
      assert replay["s"] == env.s
    end

    test "an abandoned session expires on its last sign of life, not its creation", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      user_id = ready["user"]["id"]

      # A session that had been LIVE far longer than the resume window when its
      # holder died. Its last heartbeat (armed at Identify) is the only record
      # of when that happened; creation is 20 minutes ago, past the 10-minute
      # floor.
      assert {:ok, %Session{} = stored} = lookup(sid)
      :ok = SessionStore.update(%{stored | created_at_ms: now() - 20 * 60 * 1000})
      assert {:ok, %Session{last_heartbeat_at_ms: beat}} = lookup(sid)
      assert is_integer(beat)

      kill_untrappably!(sid)

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => ready["resume_token"]
      })

      assert %{"t" => "Resumed"} = next_event!(conn2, "Resumed", 5_000)
    end

    test "a LIVE holder still refuses Resume — the refusal is liveness, not the record's phase",
         %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => ready["resume_token"]
      })

      # The security property the phase check stood in for: a session another
      # connection is USING cannot be taken over.
      code = assert_closed!(conn2, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000

      # …and the holder is untouched by the attempt.
      send_frame!(conn1, 1, nil)
      assert next_op!(conn1, 11, 5_000)
    end

    test "resume bound to a DIFFERENT authenticated identity is refused", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]

      Cytale.Test.WSClient.stop(conn1.pid)

      # A different synthetic identity (stub maps tokens deterministically).
      other_token = "cytale_" <> String.duplicate("z", 16)
      other_id = (:erlang.phash2(other_token, 900_000) + 100_000) |> to_string()

      # Guard: the mapping really must differ from the victim's.
      victim = ready["user"]["id"]
      assert other_id != victim, "test token collision; pick another token"

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => other_token,
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => ready["resume_token"]
      })

      code = assert_closed!(conn2, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000
    end

    test "resume of an unknown session → InvalidSession(false) → close 4000", %{port: port} do
      conn = connect!(port)

      send_frame!(conn, 5, %{
        "token" => valid_token(),
        "session_id" => "sdoesnotexist12345678",
        "seq" => 0,
        "resume_token" => "t" <> String.duplicate("x", 31)
      })

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000
    end

    test "resume past the hard resume-window floor is refused", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      Cytale.Test.WSClient.stop(conn1.pid)

      # Wait for the socket to fully terminate: terminate/1 stamps
      # last_disconnect_at_ms, so a stop that has not yet landed on the
      # server would REVERT the stamp we are about to force-expire with.
      wait_until(fn ->
        case lookup(sid) do
          {:ok, %Session{} = s} -> s.phase == :disconnected
          _ -> false
        end
      end)

      {:ok, %Session{} = stored} = lookup(sid)

      :ok =
        SessionStore.update(%{
          stored
          | last_disconnect_at_ms: now() - Cytale.Config.resume_window_floor_ms() - 1
        })

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      code = assert_closed!(conn2, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000
    end

    test "resume seq ahead of the server high-water mark → close 4007", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      Cytale.Test.WSClient.stop(conn1.pid)
      # Same race as the single-use test: a still-live holder answers 4000.
      await_disconnected!(ready["session_id"])

      conn2 = connect!(port)

      # Ahead BY CONSTRUCTION: a session now buffers more than a handful of
      # events by the time it disconnects (READY's roster, the deferred
      # read-state sync, queued pushes drained into the buffer on terminate),
      # so a small literal like 50 could be at or behind the high-water mark
      # and resume normally (CI run 2772: "Resumed", replayed_events 15).
      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => ready["session_id"],
        "seq" => 1_000_000_000,
        "resume_token" => ready["resume_token"]
      })

      assert assert_closed!(conn2, 5_000) == 4007
    end

    # B1: the buffer is capped with oldest-eviction — a resume whose seq
    # predates the eviction watermark must take the fresh-Identify path
    # (InvalidSession d:false), never a silent partial replay.
    test "resume below the eviction watermark → InvalidSession(false), fresh Identify", %{
      port: port
    } do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      Cytale.Test.WSClient.stop(conn1.pid)

      wait_until(fn ->
        match?({:ok, %Session{phase: :disconnected}}, lookup(sid))
      end)

      # Flood the stored record through the pure transition until eviction
      # has dropped the earliest seqs (buffer_cap retained, seq beyond it).
      {:ok, %Session{} = stored} = lookup(sid)

      flooded =
        Enum.reduce(1..(Session.buffer_cap() + 40), stored, fn i, acc ->
          acc |> Session.buffer_event("Flood#{i}", %{"i" => i}) |> elem(0)
        end)

      :ok = SessionStore.update(flooded)

      # The boundary is relative to the pre-flood seq: whether the deferred
      # self-announce consumed a seq before the disconnect is immaterial.
      assert Session.oldest_buffered_seq(flooded) == stored.seq + 41

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        # One below the eviction boundary: an envelope below the oldest
        # retained was evicted unseen — a replay would silently skip it.
        "seq" => Session.oldest_buffered_seq(flooded) - 2,
        "resume_token" => ready["resume_token"]
      })

      # The refused resume is the resumable=false shape: re-Identify, never
      # a replay that silently skips the evicted window. (The deferred
      # self-announce may interleave before the close.)
      assert next_op!(conn2, 9, 5_000) == %{"op" => 9, "d" => false}
      code = assert_closed_skipping!(conn2, 5_000, ["PresenceUpdate", "ReadStateSync"])
      assert code == 4000

      # The victim session was NOT consumed by the refused attempt (the
      # token survives for a valid in-watermark resume).
      assert {:ok, %Session{} = after_refusal} = lookup(sid)
      assert after_refusal.resume_token == ready["resume_token"]
    end

    test "resume inside the watermark replays exactly (gap-free)", %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, valid_token())
      sid = ready["session_id"]
      Cytale.Test.WSClient.stop(conn1.pid)

      wait_until(fn ->
        match?({:ok, %Session{phase: :disconnected}}, lookup(sid))
      end)

      {:ok, %Session{} = stored} = lookup(sid)

      flooded =
        Enum.reduce(1..(Session.buffer_cap() + 40), stored, fn i, acc ->
          acc |> Session.buffer_event("Flood#{i}", %{"i" => i}) |> elem(0)
        end)

      :ok = SessionStore.update(flooded)

      # Client sits ON the watermark boundary: everything past its seq is
      # retained — the replay must be exactly the retained window, in order.
      client_seq = Session.oldest_buffered_seq(flooded) - 1

      conn2 = connect!(port)

      send_frame!(conn2, 5, %{
        "token" => valid_token(),
        "session_id" => sid,
        "seq" => client_seq,
        "resume_token" => ready["resume_token"]
      })

      resumed = next_json!(conn2, 5_000)
      assert resumed["t"] == "Resumed"
      assert resumed["d"]["replayed_events"] == Session.buffer_cap()

      replay =
        Enum.map(1..Session.buffer_cap(), fn _ -> next_json!(conn2, 5_000) end)

      assert Enum.map(replay, & &1["s"]) == Enum.to_list((client_seq + 1)..flooded.seq)
    end
  end

  # ---------------------------------------------------------------------------
  # Compression (zstd + zlib round-trips through the real listener)
  # ---------------------------------------------------------------------------

  describe "compression" do
    test "zstd_stream session: binary frames round-trip and heartbeats flow", %{port: port} do
      conn = connect!(port, compress: "zstd_stream")
      ready = identify!(conn, valid_token())
      assert is_binary(ready["session_id"])

      # Fan-out dispatch arrives as a BINARY frame the client can decompress.
      user_id = ready["user"]["id"]

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      assert next_event!(conn, "TypingStart", 5_000)

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end

    test "zlib_stream session: binary frames round-trip end-to-end", %{port: port} do
      conn = connect!(port, compress: "zlib_stream")
      ready = identify!(conn, valid_token())

      user_id = ready["user"]["id"]

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      assert next_event!(conn, "TypingStart", 5_000)

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end

    # U7 (KTD5): `?compress=zlib-stream` on the connection URL — TRANSPORT
    # compression. The whole wire is one shared zlib stream: Hello arrives
    # BINARY (framed by the sync-flush `00 00 ff ff` suffix), the client's
    # Identify rides the stream too, and every post-handshake frame follows.
    test "?compress=zlib-stream: transport-compressed wire incl. Hello and Identify", %{
      port: port
    } do
      conn = connect!(port, transport_compress: true)

      assert conn.hello["op"] == 10
      assert conn.hello["d"]["v"] == 1

      # TRANSPORT compression: Hello itself rode a BINARY frame through the
      # shared zlib stream (payload compression sends the handshake as TEXT).
      assert Cytale.Test.WSClient.frame_counts(conn.pid) == %{text: 0, binary: 1}

      ready = identify!(conn, valid_token())
      assert is_binary(ready["session_id"])

      user_id = ready["user"]["id"]

      push_dispatch(
        "TypingStart",
        %{"channel_id" => typing_channel_id(), "user_id" => user_id},
        user_id
      )

      assert next_event!(conn, "TypingStart", 5_000)

      # Everything so far binary — no text frame ever hit the wire.
      assert Cytale.Test.WSClient.frame_counts(conn.pid).text == 0

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end
  end

  describe "inbound zlib bomb (security Tier 2 #3)" do
    test "a transport frame that inflates past the cap closes 4001 before Identify", %{port: port} do
      conn = connect!(port, transport_compress: true)

      z = :zlib.open()
      :ok = :zlib.deflateInit(z, 9, :deflated, 15, 8, :default)
      bomb = IO.iodata_to_binary(:zlib.deflate(z, :binary.copy(" ", 64 * 1024 * 1024), :sync))
      :zlib.close(z)

      Cytale.Test.WSClient.send_binary(conn.pid, bomb)
      assert assert_closed!(conn, 10_000) == 4001
    end
  end

  # ---------------------------------------------------------------------------
  # Plan 5.13: every handshake's stream contexts are released
  # ---------------------------------------------------------------------------

  describe "compressor lifecycle (plan 5.13)" do
    test "re-identifying N times releases one zlib compressor per handshake", %{port: port} do
      parent = self()
      handler_id = "gateway-compression-close-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:cytale, :gateway, :compression_closed],
          fn _event, _measurements, meta, _config -> send(parent, {:codec_closed, meta.mode}) end,
          nil
        )

      on_exit(fn -> :telemetry.detach(handler_id) end)

      # N handshakes. A same-socket re-Identify is refused 4005 (its own test
      # above), so the "re-identify loop" the plan describes is N fresh
      # connections: each Identify builds a compressor and, before this fix,
      # discarded the previous one unclosed.
      cycles = 12

      for _ <- 1..cycles do
        conn = connect!(port, compress: "zlib_stream")
        assert is_binary(identify!(conn, valid_token())["session_id"])
        send_close!(conn, 1000)

        # terminate/2 released THIS handshake's zlib compressor...
        assert_receive {:codec_closed, :zlib_stream}, 5_000
      end

      # ...exactly once per handshake: no extra close (a double release) and no
      # skipped one. The explicit `Compression.close/1` unit tests above prove
      # the release itself (the handle is dead afterwards); this proves the
      # SOCKET performs it on every handshake.
      refute_receive {:codec_closed, :zlib_stream}, 200
    end
  end

  # ---------------------------------------------------------------------------
  # Client → server commands: TYPING_START throttle, MESSAGE_ACK
  # ---------------------------------------------------------------------------

  describe "client commands" do
    setup do
      # The typing fan-out is visibility-gated (the resolver consult): the
      # STUB identities this suite speaks need real workspace membership for
      # the in-profile leg. The stub maps a token deterministically to
      # `phash2(token, 900_000) + 100_000` (Authenticator.Stub).
      #
      # KEYSPACE HYGIENE: an earlier iteration of the typing test wrote a
      # membership for the CANONICAL valid_token identity; those rows
      # persist across runs (the test keyspace is never dropped) and leak
      # presence noise into every other test's identify. Scrub the canonical
      # identity's memberships here — idempotent, a no-op on a clean keyspace.
      canonical_id = :erlang.phash2(valid_token(), 900_000) + 100_000

      Enum.each(Workspaces.workspaces_of_user(canonical_id), fn ws ->
        :ok = Workspaces.remove_member(ws.workspace_id, canonical_id)
      end)

      {:ok, owner} =
        Cytale.Accounts.User.create(
          "typing_owner#{Cytale.TestNonce.get()}",
          "typing_owner#{Cytale.TestNonce.get()}@example.com",
          "password-123"
        )

      {:ok, ws} =
        Workspaces.create_workspace(owner.user_id, "typing-ws-#{System.unique_integer()}")

      {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "typing-ch")

      # A second workspace whose channel the sender can NEVER see.
      {:ok, other_ws} =
        Workspaces.create_workspace(owner.user_id, "typing-other-#{System.unique_integer()}")

      {:ok, hidden} = Workspaces.create_channel(other_ws.workspace_id, "typing-hidden")

      {:ok, channel: channel, hidden: hidden}
    end

    test "a typing signal with a WARM memo resolves no permissions (plan 5.3)", %{
      port: port,
      channel: channel
    } do
      # The gate the item names: the typing path used to run
      # `PrincipalRights.resolve/3` per signal — the member + workspace roles
      # load and the channel's overwrites load — on top of the channel read.
      # The session's visible-set memo (the SAME set the dispatch gate enforces)
      # now answers it, so a warm memo costs one channel read and one MapSet
      # membership, and NO permission query.
      token = "cytale_typing_m" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

      conn = connect!(port)
      ready = identify!(conn, token)
      uid = String.to_integer(ready["user"]["id"])
      :ok = Workspaces.add_member(channel.workspace_id, uid, uid)

      # Human (native) sessions re-join routes on their next connection, so the
      # membership write needs a fresh Identify — which also WARMS the memo.
      Cytale.Test.WSClient.stop(conn.pid)
      conn = connect!(port)
      identify!(conn, token)
      settle!(conn)

      stmts =
        capture_statements(fn ->
          send_frame!(conn, 20, %{"channel_id" => Integer.to_string(channel.channel_id), "thread_id" => nil})
          Process.sleep(300)
        end)

      permission_reads =
        Enum.filter(stmts, fn stmt ->
          String.contains?(stmt, "channel_overwrites") or String.contains?(stmt, ".roles ") or
            String.contains?(stmt, "workspace_members")
        end)

      assert permission_reads == [],
             "the typing gate re-resolved permissions with a warm memo: #{inspect(permission_reads)}"

      # …and the signal still fans out (the memo answered yes, it did not
      # swallow the event).
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end

    test "TYPING_START fans out to visible-channel subscribers, throttled to ~1/sec; out-of-profile signals are silently dropped",
         %{port: port, channel: channel, hidden: hidden} do
      # UNIQUE synthetic identities (never the canonical valid_token user —
      # a membership written for the shared identity would leak presence
      # noise into every other test's identify for the rest of the run and
      # across runs, since the test keyspace persists).
      sender_token =
        "cytale_typing_s" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

      receiver_token =
        "cytale_typing_r" <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

      sender = connect!(port)
      sender_ready = identify!(sender, sender_token)

      receiver = connect!(port)
      identify!(receiver, receiver_token)

      # Both stub identities join the workspace (membership ⇒ @everyone view).
      # Ids per Authenticator.Stub: phash2(token, 900_000) + 100_000.
      sender_id = String.to_integer(sender_ready["user"]["id"])
      receiver_id = :erlang.phash2(receiver_token, 900_000) + 100_000

      :ok = Workspaces.add_member(channel.workspace_id, sender_id, sender_id)
      :ok = Workspaces.add_member(channel.workspace_id, receiver_id, receiver_id)

      # The join poke refreshes live principal routes... for MACHINE
      # principals. Human (native) sessions re-join on their next
      # connection, so re-identify after the membership write.
      Cytale.Test.WSClient.stop(sender.pid)
      Cytale.Test.WSClient.stop(receiver.pid)

      sender = connect!(port)
      sender_ready = identify!(sender, sender_token)
      settle!(sender)

      receiver = connect!(port)
      identify!(receiver, receiver_token)
      settle!(receiver)

      # The receiver's join announce reaches the sender's socket too —
      # settle the sender AFTER both identities are up so the typing
      # assertions below start from a quiet mailbox on both sides.
      settle!(sender)

      channel_str = Integer.to_string(channel.channel_id)
      d = %{"channel_id" => channel_str, "thread_id" => nil}

      send_frame!(sender, 20, d)
      send_frame!(sender, 20, d)

      # First: delivered to the receiver (but not echoed to the sender).
      frame = next_json!(receiver, 5_000)
      assert frame["t"] == "TypingStart"
      assert frame["d"]["channel_id"] == channel_str
      assert frame["d"]["user_id"] == sender_ready["user"]["id"]
      assert frame["d"]["timestamp"] != nil

      # Second within the window: swallowed silently (throttled).
      send_frame!(sender, 20, d)

      # Receiver gets nothing new; sender never gets an echo.
      assert {:error, :timeout} == try_recv(receiver.pid, 700)
      assert {:error, :timeout} == try_recv(sender.pid, 200)

      # Out-of-profile: a channel in a workspace the sender does not belong
      # to is silently dropped (no fan, no protocol error — the link stays
      # alive and answers heartbeats).
      send_frame!(sender, 20, %{"channel_id" => Integer.to_string(hidden.channel_id)})
      assert {:error, :timeout} == try_recv(receiver.pid, 400)

      send_frame!(sender, 1, nil)
      assert next_op!(sender, 11, 5_000)
    end

    # Consume queued self-announces (PresenceUpdate fan-out at join) until
    # the wire goes quiet — a member identity's identify is no longer silent.
    defp settle!(conn) do
      case Cytale.Test.WSClient.recv(conn.pid, 300) do
        {:text, _} -> settle!(conn)
        {:binary, _} -> settle!(conn)
        _other -> :ok
      end
    end

    test "MESSAGE_ACK is recorded and acknowledged without a REST round-trip", %{port: port} do
      conn = connect!(port)
      ready = identify!(conn, valid_token())

      send_frame!(conn, 21, %{"channel_id" => "c7", "message_ids" => ["1000", "1001"]})

      # The matched ack shape comes back to the user's own sockets (the
      # identify-time CallSync backfill may land first — skip past it).
      frame = next_event!(conn, "MessageAck", 5_000)
      assert frame["t"] == "MessageAck"
      assert frame["d"]["channel_id"] == "c7"
      assert frame["d"]["message_ids"] == ["1000", "1001"]
      assert frame["d"]["user_id"] == ready["user"]["id"]
      assert frame["d"]["acknowledged_at"] != nil
    end

    test "commands before Identify are rejected (4003)", %{port: port} do
      conn = connect!(port)
      send_frame!(conn, 20, %{"channel_id" => "c1"})

      assert assert_closed!(conn, 5_000) == 4003
    end
  end

  # ---------------------------------------------------------------------------
  # Heartbeat death + planned drain
  # ---------------------------------------------------------------------------

  describe "dead links and drain" do
    test "a silent link is closed by the heartbeat checker (session survives for resume)", %{
      port: port
    } do
      conn = connect!(port)
      ready = identify!(conn, valid_token())
      sid = ready["session_id"]

      # Simulate a dead link: stamp the last heartbeat deep in the past, then
      # run the socket's own checker at once instead of waiting out its
      # interval/2 (15s) timer.
      #
      # The socket is the record's single writer (update_local is an
      # unserialized ETS read-modify-write), so this test's write can be lost:
      # a dispatch the socket buffers after Identify (presence, CallSync,
      # ReadStateSync) may read the record before our stamp and write it back
      # after, restoring a fresh heartbeat. That lost update is why this test
      # used to wait 47s and still see nothing. So re-stamp and re-check until
      # the socket goes down, rather than trusting one write.
      socket_pid = SessionStore.claim_holder(sid)
      assert is_pid(socket_pid)
      ref = Process.monitor(socket_pid)
      assert kill_link_by_heartbeat(sid, socket_pid, ref, 20)

      code = assert_closed_skipping!(conn, 5_000, ["PresenceUpdate", "CallSync", "ReadStateSync"])
      assert code == 4009

      # Session record survives the window for resume.
      assert {:ok, %Session{}} = lookup(sid)
    end

    test "drain_shutdown/0 schedules staggered Reconnect frames to live sockets", %{port: port} do
      conn = connect!(port)
      identify!(conn, valid_token())

      CytaleWeb.GatewaySocket.drain_shutdown()

      # The deferred self-announce may interleave before the Reconnect frame.
      assert next_op!(conn, 6, 5_000) == %{"op" => 6}
    end
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp identify_d(token) do
    %{
      "token" => token,
      "v" => 1,
      "compress" => nil,
      "properties" => %{"os" => "test", "browser" => "gateway_case", "device" => "test"}
    }
  end

  # Through the store's public read (the record lives on its phash2-routed
  # record shard).
  # Kill a user's live gateway socket the way `max_heap_size` does:
  # UNTRAPPABLE, so terminate/1 never runs and nothing records the drop. The
  # server-side socket is reachable only through the push registry.
  # Kill THE session's socket — the pid holding its claim. Every test here
  # signs in as the same user, so "the first subscriber on the user's key"
  # could be an earlier test's socket still closing; killing that one left
  # this session's socket alive, and the Resume was (correctly) refused as
  # "session already live elsewhere" (CI runs 2780 and earlier).
  defp kill_untrappably!(session_id) do
    socket_pid =
      case SessionStore.claim_holder(session_id) do
        pid when is_pid(pid) -> pid
        nil -> flunk("no live holder recorded for session #{session_id}")
      end

    ref = Process.monitor(socket_pid)
    Process.exit(socket_pid, :kill)
    assert_receive {:DOWN, ^ref, :process, ^socket_pid, :killed}, 5_000
  end

  # The route cache warmed the way the first consult warms it.
  defp warm_route({:ok, ws_id}, _channel), do: {:ok, ws_id}

  defp warm_route(:error, channel) do
    %{workspace_id: ws_id} = Workspaces.get_channel(String.to_integer(channel))
    :ok = Cytale.Publish.ChannelRoutes.put(String.to_integer(channel), ws_id)
    {:ok, ws_id}
  end

  defp flush_messages(acc \\ []) do
    receive do
      msg -> flush_messages([msg | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # Stamp `sid`'s last heartbeat past the dead threshold and fire the
  # socket's checker; true once the socket is down, retrying a lost stamp.
  defp kill_link_by_heartbeat(_sid, _pid, _ref, 0), do: false

  defp kill_link_by_heartbeat(sid, socket_pid, ref, attempts) do
    {:ok, %Session{} = stored} = lookup(sid)

    :ok =
      SessionStore.update(%{
        stored
        | last_heartbeat_at_ms: now() - 30_000 * (Session.max_missed_heartbeats() + 1)
      })

    send(socket_pid, :check_heartbeats)

    receive do
      {:DOWN, ^ref, :process, ^socket_pid, _reason} -> true
    after
      500 -> kill_link_by_heartbeat(sid, socket_pid, ref, attempts - 1)
    end
  end

  defp lookup(sid) do
    case Cytale.Gateway.SessionStore.get(sid) do
      %Session{} = s -> {:ok, s}
      nil -> {:error, :not_found}
    end
  end

  defp now, do: System.system_time(:millisecond)

  # A REAL channel this module's shared identity can VIEW.
  #
  # #53 gates typing fan-out on the anchor channel like every other
  # channel-scoped dispatch, so the placeholder ids this suite used to push
  # ("c1"/"c9" — channels that do not exist, and so can never be viewed) are no
  # longer deliverable. The Stub authenticator maps `valid_token/0` to ONE fixed
  # identity, so one workspace per TEST serves every call site here; `setup/0`
  # creates it before the test body identifies, because the visibility memo is
  # seeded at Identify and never learns about a channel created later. Cached in
  # the test PROCESS — the suite's data is truncated between tests, so anything
  # longer-lived than that would dangle.
  defp typing_channel_id do
    key = {__MODULE__, :typing_channel}

    case Process.get(key) do
      nil ->
        uid = :erlang.phash2(valid_token(), 900_000) + 100_000

        {:ok, ws} =
          Workspaces.create_workspace(uid, "u10-wire-#{System.unique_integer([:positive])}")

        {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
        id = Integer.to_string(ch.channel_id)
        Process.put(key, id)
        id

      id ->
        id
    end
  end

  # A channel in the shared identity's workspace that it CANNOT view: a member
  # overwrite denying VIEW_CHANNEL, plus the epoch bump that makes every session's
  # memo recompute. Cached per test process (the suite's data is truncated
  # between tests).
  defp hidden_channel_id do
    key = {__MODULE__, :hidden_channel}

    case Process.get(key) do
      nil ->
        uid = :erlang.phash2(valid_token(), 900_000) + 100_000
        # A workspace the identity is only a MEMBER of: the shared identity OWNS
        # the `typing_channel_id/0` workspace, and an owner's view is not something
        # a member overwrite is meant to take away — so the deny below needs a
        # workspace where it is an ordinary member.
        owner = uid + 1
        {:ok, ws} = Workspaces.create_workspace(owner, "hidden-#{System.unique_integer([:positive])}")
        :ok = Workspaces.add_member(ws.workspace_id, uid, owner)
        {:ok, hidden} = Workspaces.create_channel(ws.workspace_id, "secret")
        deny = Bitfield.bit(:view_channel) ||| Bitfield.bit(:send_messages)
        Workspaces.put_overwrite(hidden.channel_id, :member, uid, 0, deny)
        Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)
        id = Integer.to_string(hidden.channel_id)
        Process.put(key, id)
        id

      id ->
        id
    end
  end

  defp publish_message(channel_id, content) do
    Cytale.Workspaces.FanOut.deliver(
      channel_id,
      {"MessageCreate",
       %{
         "id" => Integer.to_string(Cytale.Snowflake.next()),
         "channel_id" => channel_id,
         "content" => content
       }},
      resolved: :channel
    )
  end

  defp current_seq(sid) do
    {:ok, %Session{seq: seq}} = lookup(sid)
    seq
  end

  @doc false
  def push_dispatch(event_name, payload, user_id) do
    # Fan out through the same machinery production code uses: address the
    # user's live sockets via the PushRegistry and let each socket sequence +
    # buffer the dispatch itself.
    recipients =
      Cytale.Gateway.PushRegistry.subscribers(Cytale.Gateway.PushRegistry.user_key(user_id))

    for {pid, _uid} <- recipients do
      send(pid, {:cytale_gateway_push, self(), {event_name, payload}})
    end

    :ok
  end

  # The stub maps token → phash2(token, 900_000) + 100_000; the canonical
  # valid_token() maps to the identity READY reported, so tests that need to
  # RE-authenticate as the same identity reuse it directly.
  # Statement capture (the message-suite pattern): every simple statement the
  # node executes while `fun` runs, as text — so a test can assert a COUNT or an
  # ABSENCE rather than trusting the shape of a call graph.
  defp capture_statements(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "gateway-typing-stmts-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          send(parent, {:stmt, ref, statement_text(metadata.query)})
        end,
        parent
      )

    result = fun.()
    statements = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)
    {statements, result} |> elem(0)
  end

  defp drain_statements(ref) do
    receive do
      {:stmt, ^ref, text} -> [text | drain_statements(ref)]
    after
      50 -> []
    end
  end

  defp statement_text(%Xandra.Batch{queries: queries}) do
    queries
    |> Enum.map(&Map.get(&1, :statement, ""))
    |> Enum.join("; ")
  end

  defp statement_text(query), do: Map.get(query, :statement)

  defp try_recv(pid, timeout) do
    Cytale.Test.WSClient.recv(pid, timeout)
  end

  # The server-side socket has finished terminate/2: the record is stamped
  # disconnected AND the claim is released (terminate unclaims just after the
  # stamp, and a resume's claim is refused while a live holder remains).
  defp await_disconnected!(sid) do
    wait_until(fn ->
      match?({:ok, %Session{phase: :disconnected}}, lookup(sid)) and
        not Cytale.Gateway.SessionStore.claim_held_by_live?(sid)
    end)
  end

  defp wait_until(fun, tries \\ 50)

  defp wait_until(_fun, 0), do: flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.(), do: :ok, else: Process.sleep(20) && wait_until(fun, tries - 1)
  end
end
