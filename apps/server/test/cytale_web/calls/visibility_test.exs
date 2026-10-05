defmodule CytaleWeb.Calls.VisibilityTest do
  @moduledoc """
  Voice plan U4 — KTD6/AM9 (security-critical): CALL_* channel-keyed events
  are visibility-filtered at fan-out, and CALL_SYNC is filtered per
  recipient. A subscribed-but-blind session (member whose VIEW_CHANNEL is
  denied by a channel overwrite) receives NONE of the channel's CALL_*
  events AND no CALL_SYNC entry for the hidden channel — call existence and
  rosters must not leak.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Calls
  alias Cytale.Workspaces

  setup do
    port = start_gateway!()

    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)
    on_exit(fn -> Application.put_env(:cytale, Cytale.Publish, old_publish || Cytale.Publish.Log) end)

    {:ok, port: port}
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_u4vis_" <> run_nonce() <> String.duplicate("v", 8)
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

  # Frames until every event in `names` has arrived, or the deadline passes.
  # A quiet-gap collector (`collect_events!`) is flaky here: CallStart and
  # CallUpdate reach the viewer through the workspace process, each behind a
  # per-recipient VIEW_CHANNEL resolve, while CallRing goes straight to user
  # keys — against a remote ScyllaDB the CallUpdate can trail the ring by
  # more than 300 ms, and the old collector returned without it.
  defp collect_until!(conn, names, timeout_ms) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    do_collect_until(conn, MapSet.new(names), deadline, [])
  end

  defp do_collect_until(conn, pending, deadline, acc) do
    remaining = deadline - System.monotonic_time(:millisecond)

    if MapSet.size(pending) == 0 or remaining <= 0 do
      Enum.reverse(acc)
    else
      case next_frame(conn, remaining) do
        {:ok, json} -> do_collect_until(conn, MapSet.delete(pending, json["t"]), deadline, [json | acc])
        {:closed, _code} -> Enum.reverse(acc)
      end
    end
  rescue
    ExUnit.AssertionError -> Enum.reverse(acc)
  end

  defp collect_rest!(conn) do
    case next_frame(conn, 300) do
      {:ok, json} -> [json | collect_rest!(conn)]
      {:closed, _code} -> []
    end
  rescue
    ExUnit.AssertionError -> []
  end

  test "a no-VIEW_CHANNEL session gets no channel CALL_* and no CALL_SYNC entry", %{port: port} do
    token_owner = run_token()
    token_viewer = run_token()
    token_blind = run_token()
    uid_owner = stub_uid(token_owner)
    uid_viewer = stub_uid(token_viewer)
    uid_blind = stub_uid(token_blind)

    {:ok, ws} = Workspaces.create_workspace(uid_owner, "u4-vis-" <> run_nonce())
    :ok = Workspaces.add_member(ws.workspace_id, uid_viewer, uid_owner, [])
    :ok = Workspaces.add_member(ws.workspace_id, uid_blind, uid_owner, [])
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "secret")

    {conn_owner, _} = identify_on(port, token_owner)
    {conn_viewer, _} = identify_on(port, token_viewer)
    {conn_blind, _} = identify_on(port, token_blind)

    # The blind member's membership is revoked AFTER its route join — the
    # socket keeps its (now-blind) channel subscription until the next
    # refresh, which is exactly the subscribed-but-blind shape AM9 guards.
    :ok = Workspaces.remove_member(ws.workspace_id, uid_blind)

    # Sanity: the blind session IS subscribed to the channel key (the route
    # join lists every ws channel) — only the fan-out filter stands between
    # it and a leak.
    ch_key = Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(ch.channel_id))

    assert Enum.any?(Cytale.Gateway.PushRegistry.subscribers(ch_key), fn {_pid, uid} ->
             uid == Integer.to_string(uid_blind)
           end)

    drain_pending!(conn_owner)
    drain_pending!(conn_viewer)
    drain_pending!(conn_blind)

    # The blind member's FRESH Identify mid-call: its CALL_SYNC contains NO
    # entry for the hidden channel (the per-recipient filter).
    send_frame!(conn_owner, 22, %{
      "channel_id" => Integer.to_string(ch.channel_id),
      "action" => "start",
      "ring" => true
    })

    # The viewer (control arm) receives the full burst — proving emission.
    viewer_frames = collect_until!(conn_viewer, ["CallStart", "CallUpdate"], 5_000)
    assert Enum.find(viewer_frames, &(&1["t"] == "CallStart"))
    assert Enum.find(viewer_frames, &(&1["t"] == "CallUpdate"))

    # …the blind session receives nothing on the channel key. No CallRing
    # either: ring targets pass the same live VIEW check (AM9).
    refute_next_event!(conn_blind, "CallStart", 700)
    refute_next_event!(conn_blind, "CallUpdate", 300)
    refute_next_event!(conn_blind, "CallRing", 300)
    refute_next_event!(conn_blind, "CallEnd", 300)

    # A fresh Identify of the blind member mid-call: the backfill's calls
    # list has NO entry for the hidden channel (dm_calls are empty too).
    {conn_blind2, _} = identify_on(port, token_blind)
    sync = next_event!(conn_blind2, "CallSync", 5_000)
    assert sync["d"]["calls"] == []
    assert sync["d"]["dm_calls"] == []

    # The viewer's own fresh sync DOES carry the live call.
    {conn_viewer2, _} = identify_on(port, token_viewer)
    sync_v = next_event!(conn_viewer2, "CallSync", 5_000)
    assert [%{"channel_id" => ch_s}] = sync_v["d"]["calls"]
    assert ch_s == Integer.to_string(ch.channel_id)

    Calls.leave_call(ch.channel_id, uid_owner)
  end
end
