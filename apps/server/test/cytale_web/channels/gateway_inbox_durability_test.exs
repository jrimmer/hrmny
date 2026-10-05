defmodule CytaleWeb.GatewayInboxDurabilityTest do
  @moduledoc """
  #117 — the reload is the test.

  The defect the ticket is named for is a lifecycle one: the client's unread
  and mention slices are session-local and cleared on READY, so anything built
  on them empties on every reload. The fix is that the mention backlog is
  STORAGE, written by the message write and read by the boot read — so this
  suite drives the lifecycle itself and asserts the backlog is indifferent to
  it:

    * a fresh IDENTIFY (the reload path) changes nothing about it;
    * the read state the fresh session is hydrated with is still the one
      watermark, and the ack that keeps it current still works over the wire.

  The member identity here is the gateway suite's deterministic stub (the
  gateway authenticator is the Stub in :test), which is exactly the shape
  `gateway_read_state_sync_test` uses.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Inbox
  alias Cytale.Messages
  alias Cytale.Messages.ReadState
  alias Cytale.Workspaces

  setup_all do
    :ok = Cytale.Snowflake.ensure_init()
    :ok
  end

  setup do
    port = start_gateway!()
    %{port: port}
  end

  defp run_token(ns) do
    "cytale_inb_#{ns}_" <> Cytale.TestNonce.get() <> String.duplicate("z", 6)
  end

  defp stub_id_for(token), do: :erlang.phash2(token, 900_000) + 100_000

  # A workspace + channel the stub identity can actually see, so the resolver
  # (and therefore the mention write) accepts it.
  defp visible_channel(owner_id, token) do
    {:ok, ws} = Workspaces.create_workspace(owner_id, "inb-ws-#{System.unique_integer()}")
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "inb-ch")
    :ok = Workspaces.add_member(ws.workspace_id, stub_id_for(token), stub_id_for(token))
    {ws, channel}
  end

  defp await_event(conn, wanted, tries \\ 40)

  defp await_event(_conn, _wanted, 0), do: nil

  defp await_event(conn, wanted, tries) do
    case next_frame(conn, 2_000) do
      {:ok, %{"t" => ^wanted} = frame} -> frame
      {:ok, _other} -> await_event(conn, wanted, tries - 1)
      _ -> nil
    end
  end

  # The socket's storage leg is best-effort and runs after the wire echo, so
  # poll until it lands (or the deadline passes — the assertion then reports
  # the real state).
  defp eventually(timeout \\ 3_000, fun)

  defp eventually(timeout, _fun) when timeout <= 0, do: false

  defp eventually(timeout, fun) do
    if fun.(),
      do: true,
      else:
        (
          Process.sleep(50)
          eventually(timeout - 50, fun)
        )
  end

  test "a mention records while the member is away, and a fresh READY keeps it", %{port: port} do
    token = run_token("away")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "inb_o#{Cytale.TestNonce.get()}",
        "inb_o#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {_ws, channel} = visible_channel(owner.user_id, token)
    ch_id = channel.channel_id

    # --- session 1: the member connects, sees an empty backlog, and leaves.
    conn1 = connect!(port)
    identify!(conn1, token)
    assert {[], nil} = Inbox.list_for_user(uid)
    send_close!(conn1, 1000)

    # --- the member is AWAY. The mention lands with no session of theirs
    # anywhere: the message write is what records it.
    {:ok, _message} =
      Messages.create_message(%{
        channel_id: ch_id,
        author_id: owner.user_id,
        content: "while you were out <@#{uid}>"
      })

    assert {[item], _} = Inbox.list_for_user(uid)

    # --- session 2: a FRESH session (new id, new READY) — the reload path.
    conn2 = connect!(port)
    ready = identify!(conn2, token)
    assert ready["user"]["id"] == Integer.to_string(uid)

    # The establishment tail still hydrates read state (the one watermark), and
    # the backlog the reload needs is STILL THERE — that is the whole ticket.
    frame = await_event(conn2, "ReadStateSync")
    assert frame, "a fresh READY must still deliver the read-state sync"

    assert {[still_there], _} = Inbox.list_for_user(uid)
    assert still_there["message_id"] == item["message_id"]
    assert still_there["excerpt"] =~ "while you were out"
  end

  test "a member with no session is still mentionable (nobody is told to be online)", %{port: port} do
    token = run_token("nosession")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "inb_n#{Cytale.TestNonce.get()}",
        "inb_n#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {_ws, channel} = visible_channel(owner.user_id, token)

    # No connect!/identify! at all.
    {:ok, _} =
      Messages.create_message(%{
        channel_id: channel.channel_id,
        author_id: owner.user_id,
        content: "<@#{uid}> are you there?"
      })

    assert {[_], _} = Inbox.list_for_user(uid)
    _ = port
  end

  test "op 21 MESSAGE_ACK persists the watermark and answers the mentions it covers", %{port: port} do
    token = run_token("ack")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "inb_k#{Cytale.TestNonce.get()}",
        "inb_k#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {_ws, channel} = visible_channel(owner.user_id, token)
    ch_id = channel.channel_id

    {:ok, message} =
      Messages.create_message(%{
        channel_id: ch_id,
        author_id: owner.user_id,
        content: "<@#{uid}> ack me"
      })

    assert {[_], _} = Inbox.list_for_user(uid)

    conn = connect!(port)
    identify!(conn, token)

    send_frame!(conn, 21, %{
      "channel_id" => Integer.to_string(ch_id),
      "message_ids" => [Integer.to_string(message.id)]
    })

    # The echo is unchanged (that shape is the wire contract).
    frame = next_event!(conn, "MessageAck", 5_000)
    assert frame["d"]["message_ids"] == [Integer.to_string(message.id)]

    # The durable half: the ONE watermark moved, and the ack answered the
    # mention it covered.
    assert eventually(fn ->
             case ReadState.get(uid, ch_id) do
               %{last_read_id: read} -> read == message.id
               _ -> false
             end
           end),
           "the ack must persist the watermark"

    assert eventually(fn -> Inbox.list_for_user(uid) == {[], nil} end),
           "the acknowledgment must answer the mentions it covers"
  end

  test "op 21 does not write read state for a channel the member cannot see", %{port: port} do
    token = run_token("bogus")
    uid = stub_id_for(token)

    conn = connect!(port)
    identify!(conn, token)

    # A shape-valid but unknown channel id: the echo still goes back (every
    # existing client contract), and NOTHING is written.
    send_frame!(conn, 21, %{"channel_id" => "c7", "message_ids" => ["1000"]})
    frame = next_event!(conn, "MessageAck", 5_000)
    assert frame["d"]["channel_id"] == "c7"

    assert ReadState.all_for_user(uid) == []
  end
end
