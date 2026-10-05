defmodule CytaleWeb.Calls.RightsEpochTest do
  @moduledoc """
  Voice plan U4 — AM3 mid-call eviction: a RightsEpoch bump notifies the
  room (the epoch's subscriber feed), the room re-checks every
  participant's live VIEW_CHANNEL, failures are force-left (`forced_leave`
  CallUpdate + participant removal). The evicted member's own socket no
  longer qualifies for the channel's CALL_* deliveries (KTD6/AM9), so the
  roster update reaches the REMAINING viewers.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Calls
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces

  setup do
    port = start_gateway!()

    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)
    on_exit(fn -> Application.put_env(:cytale, Cytale.Publish, old_publish || Cytale.Publish.Log) end)

    {:ok, port: port}
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_u4ep_" <> run_nonce() <> String.duplicate("e", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
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

  defp collect_events!(conn) do
    case next_frame(conn, 5_000) do
      {:ok, json} -> [json | collect_rest!(conn)]
      {:closed, _code} -> []
    end
  rescue
    ExUnit.AssertionError -> []
  end

  defp collect_rest!(conn) do
    case next_frame(conn, 300) do
      {:ok, json} -> [json | collect_rest!(conn)]
      {:closed, _code} -> []
    end
  rescue
    ExUnit.AssertionError -> []
  end

  test "epoch bump revoking VIEW_CHANNEL mid-call force-leaves the participant", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {:ok, ws} = Workspaces.create_workspace(uid_a, "u4-ep-" <> run_nonce())
    :ok = Workspaces.add_member(ws.workspace_id, uid_b, uid_a, [])
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)
    drain_pending!(conn_a)
    drain_pending!(conn_b)

    # A starts, B joins — both legs live.
    send_frame!(conn_a, 22, %{"channel_id" => Integer.to_string(ch.channel_id), "action" => "start"})
    Process.sleep(1_000)
    send_frame!(conn_b, 22, %{"channel_id" => Integer.to_string(ch.channel_id), "action" => "join"})
    Process.sleep(500)

    snapshot = Calls.live_call(ch.channel_id)
    assert length(snapshot.participants) == 2

    # Mid-call revocation: B's VIEW is denied, the epoch moves.
    Workspaces.put_overwrite(ch.channel_id, :member, uid_b, 0, Bitfield.bit(:view_channel))
    assert RightsEpoch.bump(ws.workspace_id) > 0

    # The remaining viewer (A) hears the forced_leave roster update…
    frames = collect_events!(conn_a)
    forced = Enum.find(frames, &(&1["t"] == "CallUpdate" and &1["d"]["state"] == "forced_leave"))
    assert forced["d"]["user_id"] == Integer.to_string(uid_b)

    # …and the room no longer holds B's leg.
    snapshot = Calls.live_call(ch.channel_id)
    assert Enum.map(snapshot.participants, & &1.user_id) == [uid_a]

    Calls.leave_call(ch.channel_id, uid_a)
  end
end
