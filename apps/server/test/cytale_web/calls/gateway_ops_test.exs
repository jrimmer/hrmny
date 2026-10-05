defmodule CytaleWeb.Calls.GatewayOpsTest do
  @moduledoc """
  Voice plan U4 — ops 22/23 over real RFC6455 clients: start/join/leave/
  state routing, the ring mechanics (start + ring-after-start, once per
  call, mute exclusion), op-23 validation (participant check, 64 KiB cap,
  throttle), the AM-side caps, silent permission denials, and the DM room
  branch (no thread, no calls row).
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Calls
  alias Cytale.Workspaces

  setup do
    port = start_gateway!()

    # Real fan-out for call events (the :test default Publish.Log only
    # logs) — the workspace-process impl carries the CALL_* visibility
    # filter under test in visibility_test.
    old_publish = Application.get_env(:cytale, Cytale.Publish)

    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      case old_publish do
        nil -> Application.delete_env(:cytale, Cytale.Publish)
        v -> Application.put_env(:cytale, Cytale.Publish, v)
      end
    end)

    {:ok, port: port}
  end

  # -- fixtures -------------------------------------------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # Unique token → unique Stub identity (the authenticator's phash2 mapping).
  defp run_token, do: "cytale_u4ops_" <> run_nonce() <> String.duplicate("o", 8)

  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  # A workspace with `names` channels, owned by token_a's identity, with
  # every extra token's identity a plain member (@everyone view+send+start).
  defp workspace!(token_a, extra_tokens, channel_names) do
    uid_a = stub_uid(token_a)

    {:ok, ws} = Workspaces.create_workspace(uid_a, "u4-ops-" <> run_nonce())

    for token <- extra_tokens do
      :ok = Workspaces.add_member(ws.workspace_id, stub_uid(token), uid_a, [])
    end

    channels =
      Map.new(channel_names, fn name ->
        {:ok, ch} = Workspaces.create_channel(ws.workspace_id, name)
        {String.to_atom(name), ch.channel_id}
      end)

    {ws, channels}
  end

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    drain_pending!(conn)
    {conn, ready}
  end

  defp drain_pending!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # Frames until every wanted event has arrived, or the deadline passes. A
  # want is an event name or a predicate on the decoded frame. The quiet-gap
  # collector above is flaky for any burst whose parts travel different paths
  # or trail an unrelated dispatch: against a remote ScyllaDB the channel-keyed
  # CallUpdate can lag the direct CallRing (CI run 2620), or a late
  # PresenceUpdate can open the window and the CallUpdate miss it (d03ca880).
  # Assertions that name the event they need wait for exactly that event.
  defp collect_until!(conn, wants, timeout_ms \\ 5_000) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_collect_until(conn, Enum.map(wants, &want_fun/1), deadline, [])
  end

  defp want_fun(name) when is_binary(name), do: &(&1["t"] == name)
  defp want_fun(fun) when is_function(fun, 1), do: fun

  defp do_collect_until(conn, pending, deadline, acc) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if pending == [] or remaining <= 0 do
      Enum.reverse(acc)
    else
      case next_frame(conn, remaining) do
        {:ok, json} -> do_collect_until(conn, Enum.reject(pending, & &1.(json)), deadline, [json | acc])
        {:closed, _code} -> Enum.reverse(acc)
      end
    end
  rescue
    ExUnit.AssertionError -> Enum.reverse(acc)
  end

  # Want: a CallUpdate for `user_id` in `state`.
  defp update_of(user_id, state),
    do: &(&1["t"] == "CallUpdate" and &1["d"]["user_id"] == user_id and &1["d"]["state"] == state)

  defp event(frames, name), do: Enum.find(frames, &(&1["t"] == name))

  defp event(frames, name, user_id, state),
    do: Enum.find(frames, &(&1["t"] == name and &1["d"]["user_id"] == user_id and &1["d"]["state"] == state))

  # Poll until fun holds (the op round-trip is async through the socket).
  defp eventually!(timeout_ms, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    assert loop_until(deadline, fun), "condition not met within #{timeout_ms}ms"
    :ok
  end

  defp loop_until(deadline, fun) do
    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) >= deadline do
        false
      else
        Process.sleep(25)
        loop_until(deadline, fun)
      end
    end
  end

  defp call_op!(conn, action, channel_id, extra \\ %{}) do
    send_frame!(conn, 22, Map.merge(%{"channel_id" => Integer.to_string(channel_id), "action" => action}, extra))
  end

  defp end_call!(channel_id) do
    case Calls.live_call(channel_id) do
      nil -> :ok
      snap -> Enum.each(snap.participants, &Calls.leave_call(channel_id, &1.user_id))
    end
  end

  defp attach_telemetry!(id, event_name) do
    test_pid = self()

    :ok =
      :telemetry.attach(
        id,
        event_name,
        fn _e, _m, meta, _c ->
          # The handler runs in the EMITTING process (the socket or the room) —
          # the test pid must be captured here, not self() at invocation.
          send(test_pid, {:telemetry, event_name, meta})
        end,
        nil
      )

    on_exit(fn -> :telemetry.detach(id) end)
  end

  defp open_rows(channel_id) do
    Cytale.Repo.execute!(
      "SELECT call_id, ended_at FROM #{Cytale.ScyllaCase.keyspace()}.calls WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
  end

  # -- happy paths ----------------------------------------------------------------

  test "start → filtered CallStart + joined roster; join → CallUpdate joined; ring reaches the connected viewer", %{
    port: port
  } do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # A starts with ring; B collects the whole burst (ring rides the direct
    # user-key path, start/joined the workspace cast — order not guaranteed).
    call_op!(conn_a, "start", ch_id, %{"ring" => true})
    frames = collect_until!(conn_b, ["CallStart", "CallUpdate", "CallRing"])

    start_ev = assert event(frames, "CallStart")
    assert start_ev["d"]["channel_id"] == Integer.to_string(ch_id)
    assert start_ev["d"]["thread_id"]
    assert start_ev["d"]["started_by"] == Integer.to_string(stub_uid(token_a))

    # The starter's join arrived as a roster update (channel-keyed).
    joined = assert event(frames, "CallUpdate")
    assert joined["d"]["state"] == "joined"
    assert joined["d"]["user_id"] == Integer.to_string(stub_uid(token_a))
    assert is_binary(joined["d"]["leg"])

    # Ring: B is connected, a viewer, not muted — the payload is B's to act on.
    ring = assert event(frames, "CallRing")
    assert ring["d"]["channel_id"] == Integer.to_string(ch_id)
    assert ring["d"]["from_user"] == Integer.to_string(stub_uid(token_a))

    uid_b_s = Integer.to_string(stub_uid(token_b))

    # B joins → A hears the roster update (A's own joined may land in the
    # same burst — select by user).
    call_op!(conn_b, "join", ch_id)
    assert event(collect_until!(conn_a, [update_of(uid_b_s, "joined")]), "CallUpdate", uid_b_s, "joined")

    # B updates own state → deafen implies mute; the deafened event wins
    # when both flip (AM12).
    Process.sleep(1_000)
    call_op!(conn_b, "state", ch_id, %{"mute" => true, "deafen" => true})
    assert event(collect_until!(conn_a, [update_of(uid_b_s, "deafened")]), "CallUpdate", uid_b_s, "deafened")

    # Leave is honored with a left update.
    Process.sleep(1_000)
    call_op!(conn_b, "leave", ch_id)
    assert event(collect_until!(conn_a, [update_of(uid_b_s, "left")]), "CallUpdate", uid_b_s, "left")

    end_call!(ch_id)
  end

  test "ring-after-start via the state action; once per call", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # Silent start (no ring flag).
    call_op!(conn_a, "start", ch_id)
    _start_ev = next_event!(conn_b, "CallStart", 5_000)
    drain_pending!(conn_b)
    refute_next_event!(conn_b, "CallRing", 500)

    # Ring-after-start (AM17) summons the room… (past the op-22 throttle
    # window — same {op, channel} key as the start).
    Process.sleep(1_000)
    call_op!(conn_a, "state", ch_id, %{"ring" => true})
    assert next_event!(conn_b, "CallRing", 5_000)["d"]["call_id"]

    # …exactly once per call: a second state-ring is ignored (AM6). The op
    # throttle (900 ms) is elapsed by the refute window.
    Process.sleep(1_000)
    call_op!(conn_a, "state", ch_id, %{"ring" => true})
    refute_next_event!(conn_b, "CallRing", 700)

    end_call!(ch_id)
  end

  test "notification-muted members get no ring (AM6)", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id, other: other_id}} = workspace!(token_a, [token_b], ["general", "other"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # B mutes the channel's rings through the durable table.
    :ok = Calls.set_notification_mute(stub_uid(token_b), ch_id, true)

    call_op!(conn_a, "start", ch_id, %{"ring" => true})
    _start_ev = next_event!(conn_b, "CallStart", 5_000)
    refute_next_event!(conn_b, "CallRing", 700)

    # Un-mute restores delivery on the NEXT call (a fresh channel — the
    # first room stays live until its 60s sweep after A's leave).
    :ok = Calls.set_notification_mute(stub_uid(token_b), ch_id, false)
    call_op!(conn_a, "leave", ch_id)
    drain_pending!(conn_b)

    Process.sleep(1_000)
    call_op!(conn_a, "start", other_id, %{"ring" => true})
    frames = collect_until!(conn_b, ["CallStart", "CallRing"])
    assert event(frames, "CallStart")
    assert event(frames, "CallRing")

    end_call!(ch_id)
    end_call!(other_id)
  end

  test "op 22 on a DM channel: DM-flavored room (no thread, no calls row), ring defaults on", %{port: port} do
    # open_dm validates real user rows, so this test rides REAL accounts and
    # JWTs (the human half of the authenticator swapped in for the module).
    old_impl = Application.get_env(:cytale, :human_impl)
    Application.put_env(:cytale, :human_impl, Cytale.Gateway.Authenticator.JWT)
    on_exit(fn -> Application.put_env(:cytale, :human_impl, old_impl) end)

    {:ok, ua} =
      Cytale.Accounts.User.create(run_nonce() <> "-dm-a", run_nonce() <> "a@u4ops.example.com", "password-123")

    {:ok, ub} =
      Cytale.Accounts.User.create(run_nonce() <> "-dm-b", run_nonce() <> "b@u4ops.example.com", "password-123")

    token_a = Cytale.Accounts.Auth.issue_access_token(ua.user_id, ua.username, true)
    token_b = Cytale.Accounts.Auth.issue_access_token(ub.user_id, ub.username, true)

    {:ok, dm} = Workspaces.open_dm(ua.user_id, ub.user_id)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # No explicit ring flag: DM starts ring by default (AM7).
    call_op!(conn_a, "start", dm.channel_id)
    frames = collect_until!(conn_b, ["CallStart", "CallRing"])

    start_ev = assert event(frames, "CallStart")
    assert start_ev["d"]["channel_id"] == Integer.to_string(dm.channel_id)
    assert start_ev["d"]["thread_id"] == nil
    assert start_ev["d"]["started_by"] == Integer.to_string(ua.user_id)

    ring = assert event(frames, "CallRing")
    assert ring["d"]["channel_id"] == Integer.to_string(dm.channel_id)

    # No durable artifact (R11): no mapping row, no calls row.
    assert Calls.Log.thread_id(dm.channel_id) == nil
    assert open_rows(dm.channel_id) == []

    # The DM room is live in the registry with dm: true.
    assert %{dm: true} = Calls.live_call(dm.channel_id)

    end_call!(dm.channel_id)
  end

  # -- error paths ------------------------------------------------------------------

  test "start without START_CALL is a silent no-op with telemetry", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    # Channel overwrite denying START_CALL for B (member-target).
    Workspaces.put_overwrite(ch_id, :member, stub_uid(token_b), 0, Cytale.Permissions.Bitfield.bit(:start_call))

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    attach_telemetry!(:u4_start_denied, [:cytale, :calls, :op_error])

    call_op!(conn_b, "start", ch_id, %{"ring" => true})

    assert_receive {:telemetry, [:cytale, :calls, :op_error], %{op: "start", reason: :start_denied}}, 5_000

    # No room, no events, no protocol error — the socket stays alive.
    assert Calls.room_pid(ch_id) == nil
    drain_pending!(conn_a)
    refute_next_event!(conn_a, "CallStart", 500)
    send_frame!(conn_b, 1, nil)
    assert next_op!(conn_b, 11, 5_000)
  end

  test "op 23 from a non-participant is silently dropped; oversize bodies are rejected", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    attach_telemetry!(:u4_signal_drop, [:cytale, :calls, :signal_dropped])

    # A starts (participant); B never joins — B's signal is a silent drop.
    call_op!(conn_a, "start", ch_id)
    _start_ev = next_event!(conn_b, "CallStart", 5_000)

    send_frame!(conn_b, 23, %{
      "channel_id" => Integer.to_string(ch_id),
      "kind" => "sdp",
      "body" => "v=0..."
    })

    assert_receive {:telemetry, [:cytale, :calls, :signal_dropped], %{reason: :non_participant}}, 5_000

    # No protocol error — the socket lives.
    send_frame!(conn_b, 1, nil)
    assert next_op!(conn_b, 11, 5_000)

    # A (participant) sends an oversize body: 131073 bytes > the 128 KiB cap
    # (CALL_SIGNAL_BODY_MAX_BYTES — raised from 64 KiB by the V2 spike, VM14).
    Process.sleep(100)

    send_frame!(conn_a, 23, %{
      "channel_id" => Integer.to_string(ch_id),
      "kind" => "ice",
      "body" => String.duplicate("x", 131_073)
    })

    assert_receive {:telemetry, [:cytale, :calls, :signal_dropped], %{reason: :oversize}}, 5_000

    # The boundary itself passes ingress (exactly 131072 bytes) — a
    # participant signal is forwarded, not dropped.
    Process.sleep(100)

    send_frame!(conn_a, 23, %{
      "channel_id" => Integer.to_string(ch_id),
      "kind" => "ice",
      "body" => String.duplicate("y", 131_072)
    })

    refute_receive {:telemetry, [:cytale, :calls, :signal_dropped], %{reason: :oversize}}, 500

    end_call!(ch_id)
  end

  test "throttle saturation: a second rapid op 23 is silently swallowed with telemetry", %{port: port} do
    token_a = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    call_op!(conn_a, "start", ch_id)

    attach_telemetry!(:u4_throttle, [:cytale, :gateway, :call_throttled])

    # Two rapid ICE signals inside the 50 ms window: the second is
    # throttled (sdp bodies are exempt from the window — their own test).
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "ice", "body" => "a"})
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "ice", "body" => "b"})

    assert_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_signal"}}, 5_000

    # Alive and well-formed frames still flow (heartbeat round-trip).
    send_frame!(conn_a, 1, nil)
    assert next_op!(conn_a, 11, 5_000)

    end_call!(ch_id)
  end

  test "sdp answers bypass the 50 ms signal window; ice stays windowed", %{port: port} do
    token_a = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    call_op!(conn_a, "start", ch_id)
    eventually!(5_000, fn -> is_pid(Calls.room_pid(ch_id)) end)

    attach_telemetry!(:v2_sdp_window, [:cytale, :gateway, :call_throttled])

    uid = stub_uid(token_a)
    room = Calls.room_pid(ch_id)
    # Watch the room's mailbox: an sdp body inside the window must ARRIVE
    # (a dropped answer wedges the leg until the answer-deadline rebuild).
    :erlang.trace(room, true, [:receive])
    on_exit(fn -> :erlang.trace(room, false, [:receive]) end)

    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "sdp", "body" => "a"})
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "sdp", "body" => "b"})

    assert_receive {:trace, ^room, :receive, {:call_signal, ^uid, _session, "sdp", "a"}}, 5_000
    assert_receive {:trace, ^room, :receive, {:call_signal, ^uid, _session, "sdp", "b"}}, 5_000
    refute_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_signal"}}, 200

    :erlang.trace(room, false, [:receive])

    # ICE candidates keep the window (they are the burst the cap exists
    # for): past the sdp pair, two rapid ices still throttle the second.
    Process.sleep(60)
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "ice", "body" => "c"})
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "ice", "body" => "d"})

    assert_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_signal"}}, 5_000

    send_frame!(conn_a, 1, nil)
    assert next_op!(conn_a, 11, 5_000)

    end_call!(ch_id)
  end

  test "leave within the op-22 throttle window of its join is honored (no ghost leg)", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    attach_telemetry!(:u4_leave_window, [:cytale, :gateway, :call_throttled])

    call_op!(conn_a, "start", ch_id)
    _start_ev = next_event!(conn_b, "CallStart", 5_000)
    drain_pending!(conn_a)

    # Join and leave back-to-back — both well inside B's 900 ms op-22
    # window on this channel. The leave MUST land (its clause is "always
    # honored"); throttling it would strand a ghost leg until the sweep.
    call_op!(conn_b, "join", ch_id)
    call_op!(conn_b, "leave", ch_id)

    uid_b_s = Integer.to_string(stub_uid(token_b))
    # Both ops went out back-to-back (the window semantics live in the
    # SENDING, already done); the collection waits for both updates. 15 s,
    # not the 5 s default (#174): both updates ride the workspace fan-out in
    # order, and under a full suite's load the second once landed after a
    # 5 s window closed. A real ghost leg (the leave dropped) still fails —
    # just later, and with the frames that did arrive in the message.
    frames = collect_until!(conn_a, [update_of(uid_b_s, "joined"), update_of(uid_b_s, "left")], 15_000)
    assert event(frames, "CallUpdate", uid_b_s, "joined"), "no joined update in #{inspect(frames)}"
    assert event(frames, "CallUpdate", uid_b_s, "left"), "no left update (a ghost leg?) in #{inspect(frames)}"

    # And the room agrees: B is not a participant any more.
    eventually!(5_000, fn ->
      case Calls.room_pid(ch_id) do
        nil -> true
        room -> not Cytale.Calls.Room.participant?(room, stub_uid(token_b))
      end
    end)

    # The leave itself never tripped the throttle.
    refute_received {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_state_update"}}

    end_call!(ch_id)
  end

  test "publish/unpublish ride their own 300 ms window; state ops are never suppressed by a publish burst",
       %{port: port} do
    token_a = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    call_op!(conn_a, "start", ch_id)
    eventually!(5_000, fn -> is_pid(Calls.room_pid(ch_id)) end)
    # Past the 900 ms state window the start stamped (the state-op probe
    # below must be throttled ONLY by a publish's stamp, never by start's).
    Process.sleep(1_000)

    attach_telemetry!(:v2_publish_window, [:cytale, :gateway, :call_throttled])

    uid_a = stub_uid(token_a)

    sources_of = fn source ->
      case Calls.live_call(ch_id) do
        %{participants: ps} ->
          Enum.find_value(ps, fn
            %{user_id: ^uid_a, sources: s} -> Map.has_key?(s || %{}, source)
            _ -> false
          end)

        _ ->
          false
      end
    end

    muted? = fn ->
      case Calls.live_call(ch_id) do
        %{participants: ps} -> Enum.any?(ps, &(&1.user_id == uid_a and &1.mute == true))
        _ -> false
      end
    end

    # The first publish lands: camera reaches the room's source roster.
    call_op!(conn_a, "publish", ch_id, %{"source" => "camera"})
    eventually!(5_000, fn -> sources_of.(:camera) end)

    # A second publish 200 ms later — inside the publish window (SEC-1:
    # not a full exemption) — is throttled with its own op label.
    Process.sleep(200)
    call_op!(conn_a, "publish", ch_id, %{"source" => "screen"})
    assert_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_publish"}}, 5_000

    # A state op IMMEDIATELY after the publish burst is honored (COR-6:
    # publish no longer stamps the shared 900 ms state key).
    call_op!(conn_a, "state", ch_id, %{"mute" => true})
    eventually!(5_000, muted?)

    # A publish 400 ms after the last honored stamp clears the window:
    # the screen publish lands.
    Process.sleep(400)
    call_op!(conn_a, "publish", ch_id, %{"source" => "screen"})
    eventually!(5_000, fn -> sources_of.(:screen) end)

    end_call!(ch_id)
  end

  test "throttle buckets key on the parsed channel id: '1' and '01' share one bucket (ops 22/23)", %{port: port} do
    token_a = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [], ["general"])

    {conn_a, _} = identify_on(port, token_a)

    attach_telemetry!(:u4_int_key, [:cytale, :gateway, :call_throttled])

    padded = "0" <> Integer.to_string(ch_id)

    # op 22: the first state stamps the bucket; the zero-padded twin (same
    # channel, distinct string) must be THROTTLED — one canonical bucket.
    call_op!(conn_a, "state", ch_id, %{"mute" => true})
    send_frame!(conn_a, 22, %{"channel_id" => padded, "action" => "state", "mute" => true})

    assert_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_state_update"}}, 5_000

    # op 23: same collapse (separate bucket, same canonicalization) — ice
    # kind: sdp bodies bypass the throttle window entirely.
    send_frame!(conn_a, 23, %{"channel_id" => Integer.to_string(ch_id), "kind" => "ice", "body" => "a"})
    send_frame!(conn_a, 23, %{"channel_id" => padded, "kind" => "ice", "body" => "b"})

    assert_receive {:telemetry, [:cytale, :gateway, :call_throttled], %{op: "call_signal"}}, 5_000

    # A non-parseable channel id is a silent drop that never stamps: the
    # socket stays alive and the very next real op 23 still lands.
    Process.sleep(60)

    send_frame!(conn_a, 23, %{"channel_id" => "not-an-int", "kind" => "sdp", "body" => "x"})
    send_frame!(conn_a, 1, nil)
    assert next_op!(conn_a, 11, 5_000)
  end

  test "per-user leg cap (2): a third concurrent call is rejected with op-level telemetry", %{port: port} do
    token_a = run_token()
    {_ws, %{one: ch1, two: ch2, three: ch3}} = workspace!(token_a, [], ["one", "two", "three"])

    {conn_a, _} = identify_on(port, token_a)

    attach_telemetry!(:u4_caps, [:cytale, :calls, :op_error])

    call_op!(conn_a, "start", ch1)
    call_op!(conn_a, "start", ch2)

    eventually!(5_000, fn -> match?(%{participants: [_ | _]}, Calls.live_call(ch1)) end)
    eventually!(5_000, fn -> match?(%{participants: [_ | _]}, Calls.live_call(ch2)) end)

    # Two legs held; a third is over the cap.
    call_op!(conn_a, "start", ch3)
    assert_receive {:telemetry, [:cytale, :calls, :op_error], %{op: "start", reason: :caps_exceeded_user}}, 5_000
    assert Calls.room_pid(ch3) == nil

    # Re-joining a room the user already legs in displaces the own leg —
    # never a cap.
    call_op!(conn_a, "join", ch1)
    refute_receive {:telemetry, [:cytale, :calls, :op_error], %{reason: :caps_exceeded_user}}, 500

    end_call!(ch1)
    end_call!(ch2)
  end

  test "per-workspace PC ceiling: aggregate rejection with op-level telemetry", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    # A tiny ceiling for the test: one aggregate leg across the workspace.
    old_calls = Application.get_env(:cytale, :calls)
    Application.put_env(:cytale, :calls, workspace_pc_ceiling: 1)

    on_exit(fn ->
      case old_calls do
        nil -> Application.delete_env(:cytale, :calls)
        v -> Application.put_env(:cytale, :calls, v)
      end
    end)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    attach_telemetry!(:u4_ws_ceiling, [:cytale, :calls, :op_error])

    call_op!(conn_a, "start", ch_id)
    eventually!(5_000, fn -> match?(%{participants: [_ | _]}, Calls.live_call(ch_id)) end)

    Process.sleep(1_000)
    call_op!(conn_b, "join", ch_id)

    assert_receive {:telemetry, [:cytale, :calls, :op_error], %{op: "join", reason: :caps_exceeded_workspace}}, 5_000
    eventually!(5_000, fn -> match?(%{participants: [_]}, Calls.live_call(ch_id)) end)

    end_call!(ch_id)
  end

  test "malformed op 22/23 payloads close 4001 (decode error)", %{port: port} do
    {conn_a, _} = identify_on(port, run_token())

    send_frame!(conn_a, 22, %{"channel_id" => "123", "action" => "explode"})
    assert assert_closed!(conn_a, 5_000) == 4001
  end
end
