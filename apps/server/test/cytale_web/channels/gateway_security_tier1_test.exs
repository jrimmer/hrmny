defmodule CytaleWeb.Channels.GatewaySecurityTier1Test do
  @moduledoc """
  Security tier 1 #7 — three ways a NATIVE gateway session kept learning what
  it no longer (or never) had the right to:

    * (a) channel-anchored events the native visibility gate did not list —
      reactions and thread update/delete — reached sessions that cannot view
      the channel;
    * (b) a KICKED member's live sockets stayed subscribed to the workspace
      (and its held, resumable sessions kept buffering it), and workspace-level
      events (presence, member add/remove) were never membership-filtered on
      the native wire;
    * (c) `Auth.revoke_all_sessions/1` (password reset, refresh-replay
      detection) bumped the credential epoch but left already-identified
      sockets streaming.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest, only: [build_conn: 0, delete: 2]
  import Plug.Conn, only: [put_req_header: 3]

  alias Cytale.Gateway.{Payloads, PushRegistry}
  alias Cytale.Permissions.{Bitfield, RightsEpoch}
  alias Cytale.Workspaces
  alias Cytale.Workspaces.FanOut
  alias CytaleWeb.Compat.GatewayDialect

  @endpoint CytaleWeb.Endpoint

  setup do
    {:ok, port: start_gateway!()}
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_t1_" <> run_nonce() <> String.duplicate("t", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp workspace!(owner_token, member_tokens, channel_names) do
    owner = stub_uid(owner_token)
    {:ok, ws} = Workspaces.create_workspace(owner, "t1-" <> run_nonce())

    for t <- member_tokens, do: :ok = Workspaces.add_member(ws.workspace_id, stub_uid(t), owner, [])

    channels =
      Map.new(channel_names, fn name ->
        {:ok, ch} = Workspaces.create_channel(ws.workspace_id, name <> run_nonce())
        {String.to_atom(name), ch.channel_id}
      end)

    {ws, channels}
  end

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    drain!(conn)
    {conn, ready}
  end

  defp drain!(conn) do
    case next_frame(conn, 250) do
      {:ok, _} -> drain!(conn)
      {:closed, _} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  defp wait_until(fun, tries \\ 100) do
    cond do
      fun.() -> true
      tries == 0 -> flunk("condition never held")
      true -> Process.sleep(50) && wait_until(fun, tries - 1)
    end
  end

  # -- (a) ------------------------------------------------------------------------

  test "(a) the native gate covers every channel-anchored event Payloads classifies" do
    native = MapSet.new(GatewayDialect.native_channel_anchored_events())

    for event <- Payloads.channel_anchored_events() do
      assert MapSet.member?(native, event), "#{event} is channel-anchored but not gated on the native wire"
    end
  end

  test "(a) reactions and thread update/delete in a hidden channel never reach a non-viewer",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
    Workspaces.put_overwrite(ch.secret, :member, uid_b, 0, Bitfield.bit(:view_channel))
    RightsEpoch.bump(ws.workspace_id)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    reaction = %{
      "channel_id" => Integer.to_string(ch.secret),
      "message_id" => "1",
      "user_id" => Integer.to_string(uid_a),
      "emoji" => %{"name" => "🔥"}
    }

    thread = %{"id" => "2", "channel_id" => Integer.to_string(ch.secret), "name" => "private plans"}

    for {event, payload} <- [
          {"MessageReactionAdd", reaction},
          {"MessageReactionRemove", reaction},
          {"MessageReactionRemoveAll", Map.take(reaction, ["channel_id", "message_id"])},
          {"ThreadUpdate", thread},
          {"ThreadDelete", Map.take(thread, ["id", "channel_id"])}
        ] do
      assert FanOut.deliver(ch.secret, {event, payload}) >= 1
      # The viewer receives it — the event demonstrably reached the fan-out…
      assert next_event!(conn_a, event, 5_000)
      # …and the non-viewer never does.
      refute_next_event!(conn_b, event, 500)
    end

    # Not a blanket mute: B still gets the channel it can see.
    general = Map.put(reaction, "channel_id", Integer.to_string(ch.general))
    assert FanOut.deliver(ch.general, {"MessageReactionAdd", general}) >= 1
    assert next_event!(conn_b, "MessageReactionAdd", 5_000)
  end

  # -- #6's gateway twin -------------------------------------------------------------

  test "(#6) READY's channel roster names only channels the session may view", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
    Workspaces.put_overwrite(ch.secret, :member, uid_b, 0, Bitfield.bit(:view_channel))
    RightsEpoch.bump(ws.workspace_id)

    {_conn_b, ready_b} = identify_on(port, token_b)
    ids = Enum.map(ready_b["channels"] || [], & &1["id"])
    assert Integer.to_string(ch.general) in ids
    refute Integer.to_string(ch.secret) in ids

    {_conn_a, ready_a} = identify_on(port, token_a)
    assert Integer.to_string(ch.secret) in Enum.map(ready_a["channels"] || [], & &1["id"])
  end

  # -- (b) ------------------------------------------------------------------------

  test "(b) a kicked member's live socket drops the workspace's routes and its events",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["general"])
    ws_key = PushRegistry.workspace_key(Integer.to_string(ws.workspace_id))
    b_id = Integer.to_string(uid_b)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    assert Enum.any?(PushRegistry.subscribers(ws_key), fn {_pid, uid} -> uid == b_id end)

    # The kick, through the real route (the owner's access token).
    owner_jwt = Cytale.Accounts.Auth.issue_access_token(uid_a, "t1owner", true)

    resp =
      build_conn()
      |> put_req_header("authorization", "Bearer " <> owner_jwt)
      |> put_req_header("accept", "application/json")
      |> delete("/api/v1/workspaces/#{ws.workspace_id}/members/#{uid_b}")

    assert resp.status == 200

    # The kicked member still learns it was removed…
    assert next_event!(conn_b, "MemberRemove", 5_000)["d"]["user_id"] == b_id

    # …then its socket re-syncs routes without the workspace.
    wait_until(fn -> not Enum.any?(PushRegistry.subscribers(ws_key), fn {_pid, uid} -> uid == b_id end) end)

    channel_key = PushRegistry.channel_key(Integer.to_string(ch.general))
    refute Enum.any?(PushRegistry.subscribers(channel_key), fn {_pid, uid} -> uid == b_id end)

    # Workspace-level events stop reaching it (the membership filter).
    presence = %{
      "user_id" => Integer.to_string(uid_a),
      "status" => "online",
      "workspace_id" => Integer.to_string(ws.workspace_id)
    }

    send(conn_b_socket_pid(b_id), {:cytale_gateway_push, self(), {"PresenceUpdate", presence}})
    refute_next_event!(conn_b, "PresenceUpdate", 500)
    _ = conn_a
  end

  test "(b) a kicked member's HELD (resumable) session stops being addressed by the workspace",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_b = stub_uid(token_b)

    {ws, _ch} = workspace!(token_a, [token_b], ["general"])
    ws_key = PushRegistry.workspace_key(Integer.to_string(ws.workspace_id))

    {conn_b, ready} = identify_on(port, token_b)
    sid = ready["session_id"]

    Cytale.Test.WSClient.stop(conn_b.pid)
    wait_until(fn -> sid in PushRegistry.held_sessions(ws_key) end)

    :ok = Workspaces.remove_member(ws.workspace_id, uid_b)
    :ok = CytaleWeb.GatewaySocket.revoke_workspace_routes(uid_b, ws.workspace_id)

    refute sid in PushRegistry.held_sessions(ws_key)
    # Its own user key stays held — the session is still resumable, just not
    # for this workspace.
    assert sid in PushRegistry.held_sessions(PushRegistry.user_key(Integer.to_string(uid_b)))
  end

  test "(b) native workspace-level events are membership-filtered" do
    token_a = run_token()
    token_b = run_token()
    {ws, _ch} = workspace!(token_a, [], ["general"])
    identity = %{id: Integer.to_string(stub_uid(token_b)), username: "b"}

    payload = %{"user" => %{"id" => "1"}, "workspace_id" => Integer.to_string(ws.workspace_id)}

    assert {_visible, false} = GatewayDialect.visible_dispatch?(nil, identity, "MemberAdd", payload)

    # A member receives it.
    :ok = Workspaces.add_member(ws.workspace_id, stub_uid(token_b), stub_uid(token_a), [])
    assert {_visible, true} = GatewayDialect.visible_dispatch?(nil, identity, "MemberAdd", payload)

    # The removal notice about the identity ITSELF always passes.
    self_removed = %{"user_id" => identity.id, "workspace_id" => "123"}
    assert {_visible, true} = GatewayDialect.visible_dispatch?(nil, identity, "MemberRemove", self_removed)
  end

  # -- (c) ------------------------------------------------------------------------

  test "(c) revoke_all_sessions closes live sockets 4004 and purges resumable records",
       %{port: port} do
    token = run_token()
    uid = stub_uid(token)

    # One dropped-but-resumable session, and one live one.
    {dropped, ready_dropped} = identify_on(port, token)
    Cytale.Test.WSClient.stop(dropped.pid)
    wait_until(fn -> match?(%{phase: :disconnected}, SessionStore.get(ready_dropped["session_id"])) end)

    {live, ready_live} = identify_on(port, token)

    assert ready_dropped["session_id"] in SessionStore.user_session_ids(uid)
    assert ready_live["session_id"] in SessionStore.user_session_ids(uid)

    :ok = Cytale.Accounts.Auth.revoke_all_sessions(uid)

    assert assert_closed_skipping!(live, 5_000, ["PresenceUpdate"]) == 4004
    assert SessionStore.user_session_ids(uid) == []
    assert SessionStore.get(ready_dropped["session_id"]) == nil
  end

  # The live socket pid for a stub user id, from the registry's user key.
  defp conn_b_socket_pid(user_id) do
    [{pid, _} | _] = PushRegistry.subscribers(PushRegistry.user_key(user_id))
    pid
  end
end
