defmodule CytaleWeb.GatewayReadyRosterTest do
  @moduledoc """
  Lane D #5 — the native READY carries the session's entity roster.

  The handshake already fetched every workspace and its channels (the route
  join's preload) and threw them away; the client then re-read the same rows
  over REST in a serial waterfall before the sidebar could paint. READY now
  hands them over in the REST readers' own wire shapes, and the read-state
  sync — a bounded walk per visible channel — no longer holds READY back.
  """

  use Cytale.GatewayCase, async: false

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
    "cytale_rdy_#{ns}_" <> Cytale.TestNonce.get() <> String.duplicate("z", 6)
  end

  defp stub_id_for(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp next_event(conn, wanted, tries \\ 40)

  defp next_event(_conn, _wanted, 0), do: nil

  defp next_event(conn, wanted, tries) do
    case next_frame(conn, 2_000) do
      {:ok, %{"t" => ^wanted} = frame} -> frame
      {:ok, _other} -> next_event(conn, wanted, tries - 1)
      _ -> nil
    end
  end

  test "READY carries the member's workspaces, their channels and the DM list", %{port: port} do
    token = run_token("roster")
    uid = stub_id_for(token)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "rdy_o#{Cytale.TestNonce.get()}",
        "rdy_o#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "rdy-ws-#{System.unique_integer()}")
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "rdy-general")
    :ok = Workspaces.add_member(ws.workspace_id, uid, uid)

    # A workspace the member is NOT in: its rows must not ride this READY.
    {:ok, other_ws} = Workspaces.create_workspace(owner.user_id, "rdy-other-#{System.unique_integer()}")
    {:ok, other_ch} = Workspaces.create_channel(other_ws.workspace_id, "rdy-hidden")

    conn = connect!(port)
    ready = identify!(conn, token)

    ws_id = Integer.to_string(ws.workspace_id)
    assert [%{"id" => ^ws_id, "name" => _, "owner_id" => _}] = ready["workspaces"]

    channel_ids = Enum.map(ready["channels"], & &1["id"])
    assert Integer.to_string(general.channel_id) in channel_ids
    refute Integer.to_string(other_ch.channel_id) in channel_ids

    row = Enum.find(ready["channels"], &(&1["id"] == Integer.to_string(general.channel_id)))
    # The REST channel reader's shape, field for field.
    assert row["workspace_id"] == ws_id
    assert row["name"] == "rdy-general"
    assert Map.has_key?(row, "type") and Map.has_key?(row, "position")

    # A stub identity has no DMs; the key is present and a list (null is
    # reserved for "the read failed — fall back to REST").
    assert ready["dm_channels"] == []
  end

  test "the read-state sync still follows READY on the wire", %{port: port} do
    token = run_token("order")

    conn = connect!(port)
    _ready = identify!(conn, token)

    assert next_event(conn, "ReadStateSync"), "the deferred sync must still arrive after READY"
  end
end
