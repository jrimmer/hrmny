defmodule CytaleWeb.Channels.GatewayMembershipGrantTest do
  @moduledoc """
  #111 — a session that identifies BEFORE its membership exists is deaf:
  READY hydrates an empty membership set, so the session subscribed to no
  workspace/channel keys, and the later REST membership grant never
  re-subscribed the live socket. The measured shape: a post-grant
  MESSAGE_CREATE in the new workspace reached a fellow member but never the
  joiner — no error, healthy heartbeat, fixed only by a reload.

  The grant paths now poke the joiner's live sessions by USER key
  (`refresh_user_routes/1`, the #55/KTD4 poke family), and this file pins the
  routing at the wire: after the grant the SAME socket process receives the
  new workspace's channel dispatches with no re-Identify, while a
  pre-existing member's route set is untouched.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces
  alias Cytale.Workspaces.FanOut

  setup do
    port = start_gateway!()
    %{port: port}
  end

  # -- fixtures (mirror of the #51/#55 wire suites) ---------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # Unique token → unique Stub identity (the authenticator's phash2 mapping).
  defp run_token, do: "cytale_s111_" <> run_nonce() <> String.duplicate("s", 8)

  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    drain_pending!(conn)
    {conn, ready}
  end

  # Swallow every already-queued dispatch (join announces fan out to all
  # subscribed sockets) until the socket is quiet.
  defp drain_pending!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # The native message projection (what REST posts fan out).
  defp message_payload(channel_id, author_id, content) do
    %{
      "id" => Integer.to_string(Cytale.Snowflake.next()),
      "channel_id" => Integer.to_string(channel_id),
      "author_id" => Integer.to_string(author_id),
      "content" => content,
      "thread_id" => nil,
      "reply_to_id" => nil,
      "created_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "edited_at" => nil,
      "attachments" => []
    }
  end

  defp fan_message(channel_id, author_id, content) do
    FanOut.deliver(channel_id, {"MessageCreate", message_payload(channel_id, author_id, content)})
  end

  # The poke is a `send/2` — the socket re-joins in its OWN process — so a
  # test that fans right after the grant waits for the subscription rather
  # than assuming it (same discipline as the #55 suite).
  defp wait_for_session_key!(_pid, _key, 0), do: flunk("route never joined")

  defp wait_for_session_key!(pid, key, tries) do
    if key in PushRegistry.session_keys(pid) do
      :ok
    else
      Process.sleep(20)
      wait_for_session_key!(pid, key, tries - 1)
    end
  end

  defp socket_pid!(user_id) do
    assert [{pid, ^user_id}] = PushRegistry.subscribers(PushRegistry.user_key(user_id))
    pid
  end

  # -- the deafness (measured in #111) ----------------------------------------

  test "a session that identified before its grant hears the new workspace after it, no reconnect",
       %{port: port} do
    owner_token = run_token()
    joiner_token = run_token()
    owner_uid = stub_uid(owner_token)

    {:ok, %{workspace_id: ws_id}} = Workspaces.create_workspace(owner_uid, "s111-" <> run_nonce())
    {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")

    # Boot BEFORE membership: READY hydrates an empty membership set, so the
    # session holds only its implicit user key.
    {joiner_conn, ready} = identify_on(port, joiner_token)
    joiner_uid = ready["user"]["id"]
    joiner_pid = socket_pid!(joiner_uid)
    refute PushRegistry.workspace_key(Integer.to_string(ws_id)) in PushRegistry.session_keys(joiner_pid)

    # Pre-grant: the channel's events are addressed to nobody on this socket
    # (this is the measured deafness — correct while not a member, fatal if it
    # persisted past the grant).
    fan_message(ch_id, owner_uid, "before-grant")
    refute_next_event!(joiner_conn, "MessageCreate", 700)

    # The grant, then the production poke (`invite accept`'s own choreography:
    # write the membership, bump the workspace's rights epoch, refresh the
    # live sessions' routes).
    :ok = Workspaces.add_member(ws_id, stub_uid(joiner_token), owner_uid)
    RightsEpoch.bump(ws_id)
    :ok = CytaleWeb.GatewaySocket.refresh_user_routes(stub_uid(joiner_token))

    wait_for_session_key!(
      joiner_pid,
      PushRegistry.workspace_key(Integer.to_string(ws_id)),
      100
    )

    # The SAME socket process picked the routes up (no close, no re-Identify —
    # the client never re-subscribed; the conn under test is the original one).
    assert [{^joiner_pid, ^joiner_uid}] =
             PushRegistry.subscribers(PushRegistry.user_key(joiner_uid))

    assert PushRegistry.channel_key(Integer.to_string(ch_id)) in PushRegistry.session_keys(joiner_pid)

    fan_message(ch_id, owner_uid, "after-grant")
    dispatch = next_event!(joiner_conn, "MessageCreate", 5_000)
    assert dispatch["d"]["channel_id"] == Integer.to_string(ch_id)
    assert dispatch["d"]["content"] == "after-grant"
  end

  # Deliberately NO epoch bump here: the deaf-booted session's visible memo is
  # EMPTY, so `epoch_moved?/1` could never notice the new workspace (it only
  # inspects workspaces the memo already lists). The poke's rejoin must be
  # self-sufficient — this pins that against a future "simplification".
  test "a grant re-subscribes by workspace AND channel keys in one sync", %{port: port} do
    owner_token = run_token()
    joiner_token = run_token()
    owner_uid = stub_uid(owner_token)

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(owner_uid, "s111-keys-" <> run_nonce())

    {:ok, %{channel_id: ch_a}} = Workspaces.create_channel(ws_id, "a")
    {:ok, %{channel_id: ch_b}} = Workspaces.create_channel(ws_id, "b")

    {joiner_conn, ready} = identify_on(port, joiner_token)
    joiner_pid = socket_pid!(ready["user"]["id"])

    :ok = Workspaces.add_member(ws_id, stub_uid(joiner_token), owner_uid)
    :ok = CytaleWeb.GatewaySocket.refresh_user_routes(stub_uid(joiner_token))

    wait_for_session_key!(
      joiner_pid,
      PushRegistry.workspace_key(Integer.to_string(ws_id)),
      100
    )

    keys = PushRegistry.session_keys(joiner_pid)
    ws_key = PushRegistry.workspace_key(Integer.to_string(ws_id))
    assert ws_key in keys
    assert PushRegistry.channel_key(Integer.to_string(ch_a)) in keys
    assert PushRegistry.channel_key(Integer.to_string(ch_b)) in keys

    # Both channels deliver on the same live conn.
    fan_message(ch_a, owner_uid, "on-a")
    assert next_event!(joiner_conn, "MessageCreate", 5_000)["d"]["content"] == "on-a"
    fan_message(ch_b, owner_uid, "on-b")
    assert next_event!(joiner_conn, "MessageCreate", 5_000)["d"]["content"] == "on-b"
  end

  # -- the bystander ----------------------------------------------------------

  test "a pre-existing member's routing is untouched by another member's grant", %{port: port} do
    owner_token = run_token()
    joiner_token = run_token()
    owner_uid = stub_uid(owner_token)

    {:ok, %{workspace_id: ws_id}} =
      Workspaces.create_workspace(owner_uid, "s111-bystander-" <> run_nonce())

    {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")

    # The owner identifies AFTER the roster exists: a fully routed member.
    {owner_conn, owner_ready} = identify_on(port, owner_token)
    owner_pid = socket_pid!(owner_ready["user"]["id"])
    keys_before = PushRegistry.session_keys(owner_pid)

    # The joiner boots deaf, then is granted.
    {_joiner_conn, joiner_ready} = identify_on(port, joiner_token)
    joiner_pid = socket_pid!(joiner_ready["user"]["id"])

    :ok = Workspaces.add_member(ws_id, stub_uid(joiner_token), owner_uid)
    RightsEpoch.bump(ws_id)
    :ok = CytaleWeb.GatewaySocket.refresh_user_routes(stub_uid(joiner_token))

    # The grant's poke is addressed to the JOINER's user key only — the
    # owner's socket receives nothing and its key set is byte-identical.
    assert PushRegistry.session_keys(owner_pid) == keys_before

    wait_for_session_key!(
      joiner_pid,
      PushRegistry.workspace_key(Integer.to_string(ws_id)),
      100
    )

    # The owner's key set STILL matches, and the channel still delivers.
    assert PushRegistry.session_keys(owner_pid) == keys_before
    fan_message(ch_id, owner_uid, "still-routed")
    assert next_event!(owner_conn, "MessageCreate", 5_000)["d"]["content"] == "still-routed"
  end
end
