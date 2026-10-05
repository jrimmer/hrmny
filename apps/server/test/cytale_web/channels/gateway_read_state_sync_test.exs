defmodule CytaleWeb.GatewayReadStateSyncTest do
  @moduledoc """
  U1's remainder (notifications plan) — read state reaches a cold client.

  Before this, channel read state was write-only server-side and the client's
  unread slice was wiped on every fresh READY. So a reload silently lost every
  "you have already read this": the badge re-showed read messages, and the
  notification decision and the badge could not agree about the same message
  (R17).

  This is the seam that makes them agree, so the test that matters is the
  round trip: acknowledge on the wire, reconnect, and find the agreement
  still there.
  """

  use Cytale.GatewayCase, async: false

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
    "cytale_rss_#{ns}_" <> Cytale.TestNonce.get() <> String.duplicate("y", 6)
  end

  defp stub_id_for(token), do: :erlang.phash2(token, 900_000) + 100_000

  # A workspace + channel the stub identity can actually see, so the sync's
  # visibility filter passes.
  defp visible_channel(owner_id, token) do
    {:ok, ws} = Workspaces.create_workspace(owner_id, "rss-ws-#{System.unique_integer()}")
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "rss-ch")
    :ok = Workspaces.add_member(ws.workspace_id, stub_id_for(token), stub_id_for(token))
    {ws, channel}
  end

  # Establishment emits several dispatches (CallSync, the read-state sync, and
  # presence traffic) in no fixed order, so read until the wanted one appears.
  defp await_event(conn, wanted, tries \\ 40)

  defp await_event(_conn, _wanted, 0), do: nil

  defp await_event(conn, wanted, tries) do
    case next_frame(conn, 2_000) do
      {:ok, %{"t" => ^wanted} = frame} -> frame
      {:ok, _other} -> await_event(conn, wanted, tries - 1)
      _ -> nil
    end
  end

  test "Identify delivers this session's read state", %{port: port} do
    token = run_token("ident")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "rss_own#{Cytale.TestNonce.get()}",
        "rss_own#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {_ws, channel} = visible_channel(owner.user_id, token)

    # The member has read up to a known point in that channel.
    :ok = ReadState.write(uid, channel.channel_id, %{last_read_id: 555_000})

    conn = connect!(port)
    _ready = identify!(conn, token)

    frame = await_event(conn, "ReadStateSync")
    assert frame, "Identify must deliver a ReadStateSync"

    channels = frame["d"]["channels"]
    entry = Enum.find(channels, &(&1["channel_id"] == Integer.to_string(channel.channel_id)))

    assert entry, "the sync must carry the channel the member has read state for"
    assert entry["last_read_id"] == "555000"
  end

  # Lane D #2: a reload used to zero every mention badge, because the client
  # only learned mentions from live traffic. The sync now carries the count of
  # the member's open mentions ABOVE the watermark — the one position decides,
  # so a mention the member already read past does not count even though its
  # inbox row is still open.
  test "the sync carries the unread mention count, gated by the watermark", %{port: port} do
    token = run_token("mention")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "rss_m#{Cytale.TestNonce.get()}",
        "rss_m#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {ws, channel} = visible_channel(owner.user_id, token)
    {:ok, quiet} = Workspaces.create_channel(ws.workspace_id, "rss-quiet")

    {:ok, read_mention} =
      Cytale.Messages.create_message(%{
        channel_id: channel.channel_id,
        author_id: owner.user_id,
        content: "already seen <@#{uid}>"
      })

    :ok = ReadState.write(uid, channel.channel_id, %{last_read_id: read_mention.id})

    {:ok, _unread_mention} =
      Cytale.Messages.create_message(%{
        channel_id: channel.channel_id,
        author_id: owner.user_id,
        content: "new ping <@#{uid}>"
      })

    conn = connect!(port)
    _ready = identify!(conn, token)

    frame = await_event(conn, "ReadStateSync")
    assert frame

    by_id = Map.new(frame["d"]["channels"], &{&1["channel_id"], &1})

    assert by_id[Integer.to_string(channel.channel_id)]["mention_count"] == 1,
           "only the mention above the watermark counts"

    assert by_id[Integer.to_string(quiet.channel_id)]["mention_count"] == 0,
           "a channel with no open mention reports zero, not null"
  end

  test "a channel the session cannot see is not in the sync", %{port: port} do
    token = run_token("hidden")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "rss_h#{Cytale.TestNonce.get()}",
        "rss_h#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    # A workspace the stub identity is NOT a member of.
    {:ok, hidden_ws} = Workspaces.create_workspace(owner.user_id, "rss-hidden-#{System.unique_integer()}")
    {:ok, hidden_ch} = Workspaces.create_channel(hidden_ws.workspace_id, "rss-hidden-ch")

    # A row exists for it anyway (membership changed since the read).
    :ok = ReadState.write(uid, hidden_ch.channel_id, %{last_read_id: 999_000})

    conn = connect!(port)
    _ready = identify!(conn, token)

    frame = await_event(conn, "ReadStateSync")
    assert frame

    channels = frame["d"]["channels"]

    refute Enum.any?(channels, &(&1["channel_id"] == Integer.to_string(hidden_ch.channel_id))),
           "a watermark for a channel this session cannot see must not leak"
  end

  test "a member with no read state gets an empty sync, not a missing one", %{port: port} do
    token = run_token("empty")

    conn = connect!(port)
    _ready = identify!(conn, token)

    frame = await_event(conn, "ReadStateSync")
    assert frame, "the sync must arrive even when there is nothing to hydrate"
    assert frame["d"]["channels"] == []
  end

  # A literal op-5 resume is NOT covered here. It is wired (the resume
  # establishment tail calls the same emit as Identify), but driving it needs
  # the harness's own session lifecycle: a synthetic resume frame against this
  # suite's connection returns InvalidSession, and asserting on a handshake the
  # test fabricates would prove the test rather than the feature. The Identify
  # round trip above is the cold-start path this unit exists for.
end
