defmodule CytaleWeb.Calls.BackfillTest do
  @moduledoc """
  Voice plan U4 — the CALL_SYNC establishment backfill and the AM4 re-bind:
  a fresh Identify mid-call receives the full roster, a gateway Resume
  mid-call re-binds the room's monitored process without dropping the leg
  (same leg id), buffered CALL_START replays through the resume machinery
  untouched, and a session death beyond the grace window loses the leg.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Calls

  setup do
    port = start_gateway!()

    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    # Short liveness grace: the resume-within-grace and expiry windows are
    # test-scale (production default 30s, AM4).
    old_calls = Application.get_env(:cytale, :calls)
    Application.put_env(:cytale, :calls, session_grace_ms: 800, empty_sweep_ms: 300)

    on_exit(fn ->
      Application.put_env(:cytale, Cytale.Publish, old_publish || Cytale.Publish.Log)

      case old_calls do
        nil -> Application.delete_env(:cytale, :calls)
        v -> Application.put_env(:cytale, :calls, v)
      end
    end)

    {:ok, port: port}
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_u4bf_" <> run_nonce() <> String.duplicate("b", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp workspace!(token_a, extra_tokens) do
    uid_a = stub_uid(token_a)
    {:ok, ws} = Cytale.Workspaces.create_workspace(uid_a, "u4-bf-" <> run_nonce())
    for token <- extra_tokens, do: :ok = Cytale.Workspaces.add_member(ws.workspace_id, stub_uid(token), uid_a, [])
    {:ok, ch} = Cytale.Workspaces.create_channel(ws.workspace_id, "general")
    {ws, ch.channel_id}
  end

  # Identify and return the conn + ready payload.
  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    {conn, ready}
  end

  # Drain to quiet and report the highest dispatch seq seen (the resume
  # cursor — everything at or below it is "processed" by the client).
  defp drain_and_seq!(conn) do
    case next_frame(conn, 300) do
      {:ok, %{"s" => s} = _frame} when is_integer(s) ->
        max(s, drain_and_seq!(conn))

      {:ok, _frame} ->
        drain_and_seq!(conn)

      {:closed, _} ->
        0
    end
  rescue
    ExUnit.AssertionError -> 0
  end

  # The registry name lands BEFORE init completes — wait for the starter's
  # leg too (the join follows init synchronously in the op handler).
  defp wait_until_room!(channel_id) do
    deadline = System.monotonic_time(:millisecond) + 5_000
    loop_room!(deadline, channel_id)
  end

  defp loop_room!(deadline, channel_id) do
    snapshot = Calls.live_call(channel_id)

    cond do
      snapshot != nil and snapshot.participants != [] -> :ok
      System.monotonic_time(:millisecond) >= deadline -> raise("room never appeared")
      true -> Process.sleep(20) && loop_room!(deadline, channel_id)
    end
  end

  defp eventually_room_gone!(channel_id) do
    deadline = System.monotonic_time(:millisecond) + 5_000

    unless loop_gone!(deadline, channel_id), do: raise("room never left")
    :ok
  end

  defp loop_gone!(deadline, channel_id) do
    cond do
      Calls.room_pid(channel_id) == nil -> true
      System.monotonic_time(:millisecond) >= deadline -> false
      true -> Process.sleep(20) && loop_gone!(deadline, channel_id)
    end
  end

  test "fresh Identify mid-call receives CALL_SYNC with the full roster", %{port: port} do
    token_a = run_token()
    token_b = run_token()
    {_ws, ch_id} = workspace!(token_a, [token_b])

    # A is live in a call when B's FRESH session identifies.
    {conn_a, _} = identify_on(port, token_a)
    send_frame!(conn_a, 22, %{"channel_id" => Integer.to_string(ch_id), "action" => "start"})
    wait_until_room!(ch_id)

    {conn_b, _} = identify_on(port, token_b)
    sync = next_event!(conn_b, "CallSync", 5_000)

    assert [%{"channel_id" => ch_s, "call_id" => call_s, "thread_id" => th_s, "participants" => roster}] =
             sync["d"]["calls"]

    assert ch_s == Integer.to_string(ch_id)
    assert call_s
    assert th_s

    assert [%{"user_id" => uid_s, "mute" => false, "deafen" => false}] = roster
    assert uid_s == Integer.to_string(stub_uid(token_a))
    assert sync["d"]["dm_calls"] == []

    Calls.leave_call(ch_id, stub_uid(token_a))
    eventually_room_gone!(ch_id)
  end

  test "Resume mid-call re-binds the room monitor: leg kept, CALL_START replayed", %{port: port} do
    token_a = run_token()
    {_ws, ch_id} = workspace!(token_a, [])

    {conn_a, ready} = identify_on(port, token_a)
    sid = ready["session_id"]
    resume_token = ready["resume_token"]

    # Everything the client has processed BEFORE the call — the resume
    # cursor. The CALL_START that follows lands in the buffer, unprocessed.
    seq = drain_and_seq!(conn_a)

    send_frame!(conn_a, 22, %{"channel_id" => Integer.to_string(ch_id), "action" => "start"})
    wait_until_room!(ch_id)
    leg_before = hd(Calls.live_call(ch_id).participants).leg

    # Drop the link (session process death, AM4) and resume within grace.
    Cytale.Test.WSClient.stop(conn_a.pid)
    Process.sleep(100)

    conn2 = connect!(port)

    send_frame!(conn2, 5, %{
      "token" => token_a,
      "session_id" => sid,
      "seq" => seq,
      "resume_token" => resume_token
    })

    assert next_event!(conn2, "Resumed", 5_000)

    # The buffered CALL_START replays through the untouched seq machinery…
    replayed = next_event!(conn2, "CallStart", 5_000)
    assert replayed["d"]["channel_id"] == Integer.to_string(ch_id)
    assert is_integer(replayed["s"]) and replayed["s"] > seq

    # …a FRESH CallSync follows the backfill, and the re-bind (no
    # displacement, no left) kept the leg: same leg id, same roster slot.
    sync = next_event!(conn2, "CallSync", 5_000)
    assert [%{"participants" => roster}] = sync["d"]["calls"]
    assert hd(roster)["user_id"] == Integer.to_string(stub_uid(token_a))

    assert %{participants: [%{leg: leg_after}]} = Calls.live_call(ch_id)
    assert leg_after == leg_before

    Calls.leave_call(ch_id, stub_uid(token_a))
    eventually_room_gone!(ch_id)
  end

  test "session death beyond the grace window drops the leg", %{port: port} do
    token_a = run_token()
    {_ws, ch_id} = workspace!(token_a, [])

    {conn_a, _} = identify_on(port, token_a)
    send_frame!(conn_a, 22, %{"channel_id" => Integer.to_string(ch_id), "action" => "start"})
    wait_until_room!(ch_id)

    Cytale.Test.WSClient.stop(conn_a.pid)

    # Grace (800ms here) expires with no resume: the participant is removed.
    deadline = System.monotonic_time(:millisecond) + 5_000
    loop_empty!(deadline, ch_id)
  end

  defp loop_empty!(deadline, channel_id) do
    snapshot = Calls.live_call(channel_id)

    cond do
      snapshot == nil or snapshot.participants == [] -> :ok
      System.monotonic_time(:millisecond) >= deadline -> raise("participant never dropped")
      true -> Process.sleep(50) && loop_empty!(deadline, channel_id)
    end
  end
end
