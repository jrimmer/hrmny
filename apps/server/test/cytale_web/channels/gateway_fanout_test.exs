defmodule CytaleWeb.GatewayFanoutTest do
  @moduledoc """
  Post-READY fan-out routing + presence — the seam between U10's socket and
  U11's delivery machinery that no plan unit owned: Identify/Resume subscribe
  the socket to every reachable channel key and workspace key, presence
  announces ride those keys (online on join, offline on the user's last
  socket drop), and client-declared op-3 statuses fan out to the roster.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces

  setup do
    port = start_gateway!()
    %{port: port}
  end

  # Run-scoped-unique names (ScyllaCase policy: the keyspace is not reset
  # between modules).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # Per-RUN identity: the shared valid_token/0 Stub id is used by the rest of
  # the gateway suite, and workspaces created here would leak join announces
  # into those tests (the test keyspace persists across runs). A unique token
  # maps to a unique throwaway Stub id.
  defp run_token, do: "cytale_fo_" <> run_nonce() <> String.duplicate("x", 8)

  # Swallow every already-queued dispatch (join announces fan out to all
  # subscribed sockets, so counts depend on join order) until the socket is
  # quiet — the next assertion starts from a deterministic empty mailbox.
  defp drain_pending!(conn) do
    case next_frame(conn, 300) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # One identity per test process + namespace: connections sharing a
  # namespace share the identity; "member" differs from the primary one.
  defp test_token(ns \\ "primary") do
    key = {:cytale_fo_token, ns}

    if token = Process.get(key) do
      token
    else
      token = run_token()
      Process.put(key, token)
      token
    end
  end

  defp wait_closed(conn) do
    case next_frame(conn, 5_000) do
      {:closed, code} -> code
      {:ok, _json} -> wait_closed(conn)
    end
  end

  test "identify joins channel + workspace routes and announces presence", %{port: port} do
    conn1 = connect!(port)
    ready1 = identify!(conn1, test_token())
    user_id = ready1["user"]["id"]

    # The workspace is created AFTER conn1 joined (its bootstrap ran against
    # an empty roster); conn2 identifies fresh and picks it up.
    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(user_id), "fanout-ws-" <> run_nonce())

    {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")
    ws_key = PushRegistry.workspace_key(Integer.to_string(ws_id))
    ch_key = PushRegistry.channel_key(Integer.to_string(ch_id))

    conn2 = connect!(port)
    ready2 = identify!(conn2, test_token())
    assert ready2["user"]["id"] == user_id

    # Routes joined…
    assert [{_pid, ^user_id}] = PushRegistry.subscribers(ch_key)
    assert length(PushRegistry.subscribers(ws_key)) >= 1

    # …and the online announce arrived as a seq-stamped PresenceUpdate.
    presence = next_json!(conn2, 5_000)
    assert presence["op"] == 0
    assert presence["t"] == "PresenceUpdate"
    assert presence["d"]["user_id"] == user_id
    assert presence["d"]["status"] == "online"
    assert presence["d"]["last_seen_at"]
  end

  test "MESSAGE_CREATE on a joined channel reaches the live socket", %{port: port} do
    conn1 = connect!(port)
    ready = identify!(conn1, test_token())
    user_id = ready["user"]["id"]

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(user_id), "deliver-ws-" <> run_nonce())

    {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")

    conn2 = connect!(port)
    identify!(conn2, test_token())
    drain_pending!(conn2)

    # The payload carries the channel it is ABOUT: #51's native gate anchors
    # on `channel_id`, and a real post's projection always has one (a message
    # event without it is not a shape the system produces).
    payload = %{"id" => "123", "channel_id" => Integer.to_string(ch_id), "x" => 1}

    Cytale.Workspaces.FanOut.deliver(ch_id, {"MessageCreate", payload})

    dispatch = next_json!(conn2, 5_000)
    assert dispatch["op"] == 0
    assert dispatch["t"] == "MessageCreate"
    assert dispatch["d"] == payload
  end

  test "op-3 status change fans out to the user's other sockets", %{port: port} do
    bootstrap = connect!(port)
    ready = identify!(bootstrap, test_token())
    user_id = ready["user"]["id"]

    {:ok, %{workspace_id: _ws_id}} =
      Workspaces.create_workspace(String.to_integer(user_id), "status-ws-" <> run_nonce())

    # Both sockets join AFTER the workspace exists, so both hold the route.
    conn_a = connect!(port)
    identify!(conn_a, test_token())
    conn_b = connect!(port)
    identify!(conn_b, test_token())
    drain_pending!(conn_a)
    drain_pending!(conn_b)

    send_frame!(conn_a, 3, %{"status" => "dnd"})

    for conn <- [conn_b, conn_a] do
      dispatch = next_json!(conn, 5_000)
      assert dispatch["t"] == "PresenceUpdate"
      assert dispatch["d"]["status"] == "dnd"
      assert dispatch["d"]["user_id"] == user_id
    end
  end

  test "joining sends the workspace's live-presence snapshot to the newcomer", %{port: port} do
    # Bootstrap both identities (learn ids before membership is written).
    boot = connect!(port)
    ready = identify!(boot, test_token())
    owner_id = ready["user"]["id"]

    boot2 = connect!(port)
    ready2 = identify!(boot2, test_token("member"))
    member_id = ready2["user"]["id"]
    refute member_id == owner_id

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(owner_id), "snapshot-ws-" <> run_nonce())

    :ok = Workspaces.add_member(ws_id, String.to_integer(member_id), String.to_integer(owner_id))

    # Real sockets identify AFTER the roster exists: the owner's socket holds
    # the workspace route (and is live), so the member's join must snapshot it.
    owner_conn = connect!(port)
    identify!(owner_conn, test_token())
    drain_pending!(owner_conn)

    member_conn = connect!(port)
    identify!(member_conn, test_token("member"))

    # First dispatch on the newcomer is the snapshot: the owner's live status.
    snap = next_json!(member_conn, 5_000)
    assert snap["op"] == 0 and snap["t"] == "PresenceUpdate"
    assert snap["d"]["user_id"] == owner_id
    assert snap["d"]["status"] == "online"

    # …followed by its own self-announce.
    self_announce = next_json!(member_conn, 5_000)
    assert self_announce["d"]["user_id"] == member_id
    assert self_announce["d"]["status"] == "online"
  end

  test "op-3 invisible announces offline on the wire (display-honest, no stealth)", %{port: port} do
    boot = connect!(port)
    ready = identify!(boot, test_token())
    user_id = ready["user"]["id"]

    boot2 = connect!(port)
    ready2 = identify!(boot2, test_token("member"))
    member_id = ready2["user"]["id"]

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(user_id), "invis-ws-" <> run_nonce())

    :ok = Workspaces.add_member(ws_id, String.to_integer(member_id), String.to_integer(user_id))

    owner_conn = connect!(port)
    identify!(owner_conn, test_token())
    member_conn = connect!(port)
    identify!(member_conn, test_token("member"))
    drain_pending!(owner_conn)
    drain_pending!(member_conn)

    # Owner goes invisible: the member must see OFFLINE (not idle/dnd/online).
    send_frame!(owner_conn, 3, %{"status" => "invisible"})

    dispatch = next_json!(member_conn, 5_000)
    assert dispatch["t"] == "PresenceUpdate"
    assert dispatch["d"]["user_id"] == user_id
    assert dispatch["d"]["status"] == "offline"

    # The preference survives a reconnect: the join announce says offline too.
    send_close!(owner_conn, 1000)
    _code = wait_closed(owner_conn)
    owner_conn2 = connect!(port)
    identify!(owner_conn2, test_token())
    drain_pending!(owner_conn2)

    announce = next_json!(member_conn, 5_000)
    assert announce["t"] == "PresenceUpdate"
    assert announce["d"]["user_id"] == user_id
    assert announce["d"]["status"] == "offline"
  end

  test "stored dnd is honored by a newcomer's presence snapshot", %{port: port} do
    boot = connect!(port)
    ready = identify!(boot, test_token())
    owner_id = ready["user"]["id"]

    boot2 = connect!(port)
    ready2 = identify!(boot2, test_token("member"))
    member_id = ready2["user"]["id"]

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(owner_id), "dnd-ws-" <> run_nonce())

    :ok = Workspaces.add_member(ws_id, String.to_integer(member_id), String.to_integer(owner_id))

    owner_conn = connect!(port)
    identify!(owner_conn, test_token())
    drain_pending!(owner_conn)
    send_frame!(owner_conn, 3, %{"status" => "dnd"})

    # Newcomer joins AFTER the owner declared dnd: the snapshot must carry dnd.
    member_conn = connect!(port)
    identify!(member_conn, test_token("member"))

    snap = next_json!(member_conn, 5_000)
    assert snap["t"] == "PresenceUpdate"
    assert snap["d"]["user_id"] == owner_id
    assert snap["d"]["status"] == "dnd"
  end

  test "op-3 with an invalid status is a decode error (4001)", %{port: port} do
    conn = connect!(port)
    identify!(conn, test_token())
    # Workspaces from earlier tests in the run share this Stub identity —
    # the join announce may be queued ahead of the frame under test.
    drain_pending!(conn)

    # Client-declared "offline" is rejected: offline is server-derived on
    # last-socket close (invisible is the honest way to appear away).
    send_frame!(conn, 3, %{"status" => "offline"})

    assert assert_closed!(conn, 5_000) == 4001
  end

  test "closing the user's last live socket announces offline to the roster", %{port: port} do
    conn1 = connect!(port)
    ready = identify!(conn1, test_token())
    owner_id = ready["user"]["id"]

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(owner_id), "offline-ws-" <> run_nonce())

    # A second member on a second identity observes the roster. Identities
    # must be known before membership is written, so both bootstrap sockets
    # identify BEFORE the workspace exists; the observing member socket
    # (conn3) identifies AFTER add_member so it actually holds the route.
    conn2 = connect!(port)
    ready2 = identify!(conn2, test_token("member"))
    member_id = ready2["user"]["id"]
    refute member_id == owner_id

    :ok = Workspaces.add_member(ws_id, String.to_integer(member_id), String.to_integer(owner_id))

    conn3 = connect!(port)
    ready3 = identify!(conn3, test_token("member"))
    assert ready3["user"]["id"] == member_id
    drain_pending!(conn3)

    # Owner goes away: they were their own last live socket. Any queued join
    # announces may precede the close frame on their socket.
    drain_pending!(conn1)
    send_close!(conn1, 1000)

    code = wait_closed(conn1)
    assert code == 1000

    dispatch = next_json!(conn3, 5_000)
    assert dispatch["t"] == "PresenceUpdate"
    assert dispatch["d"]["user_id"] == owner_id
    assert dispatch["d"]["status"] == "offline"

    # The member is unaffected (per-user presence, not per-workspace).
    assert PushRegistry.subscribers(PushRegistry.user_key(member_id)) != []
  end

  test "closing one of several sockets of the same user does NOT announce offline", %{port: port} do
    bootstrap = connect!(port)
    ready = identify!(bootstrap, test_token())
    user_id = ready["user"]["id"]

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(String.to_integer(user_id), "multitab-ws-" <> run_nonce())

    conn_a = connect!(port)
    identify!(conn_a, test_token())
    conn_b = connect!(port)
    identify!(conn_b, test_token())
    drain_pending!(conn_a)
    drain_pending!(conn_b)

    # conn_a is one of TWO live sockets for this user; its close must not
    # flip the roster to offline.
    send_close!(conn_a, 1000)
    assert {:closed, 1000} = next_frame(conn_a, 5_000)

    assert_raise ExUnit.AssertionError, ~r/timed out/, fn ->
      next_json!(conn_b, 1_000)
    end

    ws_key = PushRegistry.workspace_key(Integer.to_string(ws_id))
    assert PushRegistry.subscribers(ws_key) != []
  end

  describe "publish routing (#109)" do
    # The :test default Publish impl only logs, so the pin below needs the
    # production route configured: Publish.publish → Workspace.fan_out.
    setup do
      old = Application.get_env(:cytale, Cytale.Publish)
      Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

      on_exit(fn ->
        if old,
          do: Application.put_env(:cytale, Cytale.Publish, old),
          else: Application.delete_env(:cytale, Cytale.Publish)
      end)

      :ok
    end

    # `Publish.publish(channel_id, event)` uses its channel ONLY to find the
    # workspace: the process it hands off to routes by the channel the PAYLOAD
    # names, and an unnamed channel resolves to the `{:workspace, :all}` route
    # that `fanout_route_keys/2` gives no session. Such an event is published,
    # acked `:ok`, and delivered to nobody — in silence. #109 hit exactly that:
    # `ThreadUpdate` carried no channel_id, and since the archive write is its
    # first and only producer, nothing had ever exercised the omission.
    test "a channel publish reaches the channel's sockets only when the PAYLOAD names the channel",
         %{port: port} do
      conn1 = connect!(port)
      ready = identify!(conn1, test_token())
      user_id = ready["user"]["id"]

      {:ok, %{workspace_id: ws_id}} =
        Workspaces.create_workspace(String.to_integer(user_id), "route-ws-" <> run_nonce())

      {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")

      conn2 = connect!(port)
      identify!(conn2, test_token())
      drain_pending!(conn2)

      # The shape the archive write sends: channel_id present.
      routed = %{
        "id" => "7300000000000000300",
        "channel_id" => Integer.to_string(ch_id),
        "name" => "incident",
        "archived" => true
      }

      assert :ok = Cytale.Publish.publish(ch_id, {"ThreadUpdate", routed})
      dispatch = next_event!(conn2, "ThreadUpdate", 5_000)
      assert dispatch["d"] == routed

      # The shape that was silently unroutable: same publish args, no channel in
      # the payload. Nothing arrives — which is why the payload BUILDER is the
      # fix rather than a change at the call site.
      unrouted = Map.delete(routed, "channel_id")
      assert :ok = Cytale.Publish.publish(ch_id, {"ThreadUpdate", unrouted})

      assert_raise ExUnit.AssertionError, ~r/no frame arrived/, fn ->
        next_event!(conn2, "ThreadUpdate", 700)
      end
    end
  end
end
