defmodule Cytale.Calls.RoomTest do
  @moduledoc """
  Voice plan U3 — the room process: one-live invariant (AM16 loser
  auto-joins), durable boundaries (calls row + standing thread), the idle
  sweep (AM10, short config here), session-DOWN grace + re-bind (AM4),
  displacement (AM8), DM no-artifact rooms (R11), and crash restart ending
  the stale call (R8's crash-recovery arm). The event sink is a recorder —
  proving the seam U4 swaps in works — while the default no-op sink is the
  shipped behavior.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls
  alias Cytale.Threads.Thread

  # The recorder: forwards room transitions to the listening test process
  # through a unique persistent_term key (cleared in on_exit — never a
  # global wipe, the ScyllaCase persistent_term lesson).
  defmodule RecordingSink do
    @behaviour Cytale.Calls.Events.Sink

    @key {__MODULE__, :listener}

    def listen(pid), do: :persistent_term.put(@key, pid)
    def unlisten, do: :persistent_term.erase(@key)

    @impl true
    def emit(event, payload) do
      case :persistent_term.get(@key, nil) do
        nil ->
          :ok

        pid ->
          send(pid, {:sink_event, event, payload})
          :ok
      end
    end
  end

  @short_sweep 400
  @short_grace 250

  setup do
    # Short windows (config-overridable per AM10/AM4) + the recorder sink.
    old_calls = Application.get_env(:cytale, :calls, [])

    Application.put_env(
      :cytale,
      :calls,
      Keyword.merge(old_calls,
        empty_sweep_ms: @short_sweep,
        session_grace_ms: @short_grace,
        event_sink: RecordingSink
      )
    )

    RecordingSink.listen(self())

    on_exit(fn ->
      Application.put_env(:cytale, :calls, old_calls)
      RecordingSink.unlisten()
    end)

    :ok
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # A stand-in for the gateway session process the room monitors.
  defp spawn_session do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  defp start(channel_id, user_id) do
    session = spawn_session()
    {:ok, result} = Calls.start_call(channel_id, user_id, session)
    {result, session}
  end

  # Leave everyone and wait out the (short) sweep so no room lingers past
  # its test — the sweep_stale count assertions in calls_test depend on it.
  defp cleanup_call(channel_id) do
    case Calls.live_call(channel_id) do
      nil ->
        :ok

      snapshot ->
        Enum.each(snapshot.participants, &Calls.leave_call(channel_id, &1.user_id))
        eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)
    end

    :ok
  end

  defp eventually(timeout_ms, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms
    eventually_loop(deadline, fun)
  end

  defp eventually_loop(deadline, fun) do
    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) >= deadline do
        false
      else
        Process.sleep(25)
        eventually_loop(deadline, fun)
      end
    end
  end

  defp ks, do: Cytale.ScyllaCase.keyspace()

  defp call_row(channel_id, call_id) do
    Cytale.Repo.execute!(
      "SELECT call_id, started_by, started_at, ended_at, ended_reason, thread_id FROM #{ks()}.calls WHERE channel_id = ? AND call_id = ?",
      [{"bigint", channel_id}, {"bigint", call_id}]
    )
    |> Enum.to_list()
    |> case do
      [row] -> row
      [] -> nil
    end
  end

  defp open_rows(channel_id) do
    Cytale.Repo.execute!(
      "SELECT call_id, ended_at FROM #{ks()}.calls WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
    |> Enum.filter(&is_nil(&1["ended_at"]))
  end

  defp drain_sink_events(ms \\ 100) do
    receive do
      {:sink_event, event, payload} -> [{event, payload} | drain_sink_events(ms)]
    after
      ms -> []
    end
  end

  # -- Start: durable boundaries -----------------------------------------------------

  test "start creates the open calls row and the standing call-log thread" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {%{action: :started, call_id: call_id, thread_id: thread_id, leg_id: leg}, _session} = start(channel_id, starter)

    assert is_binary(leg)

    # The row: open, attributed, linked to the standing thread.
    row = call_row(channel_id, call_id)
    assert row["started_by"] == starter
    assert row["ended_at"] == nil
    assert row["ended_reason"] == nil
    assert row["thread_id"] == thread_id

    # The standing thread: anchorless, system-named, mapped.
    assert %{} = t = Thread.get(thread_id)
    assert t.name == "Call log"
    assert t.parent_message_id == nil
    assert Cytale.Calls.Log.thread_id(channel_id) == thread_id

    # Live snapshot from the registry (never Scylla).
    snapshot = Calls.live_call(channel_id)
    assert snapshot.call_id == call_id
    assert snapshot.thread_id == thread_id
    assert snapshot.dm == false
    assert snapshot.started_by == starter
    assert [%{user_id: ^starter, mute: false, deafen: false}] = snapshot.participants

    # The seam saw call_start + joined (payload shapes per U1's wire types).
    events = drain_sink_events()

    assert {:call_start,
            %{
              "channel_id" => ch_s,
              "call_id" => call_s,
              "thread_id" => th_s,
              "started_by" => sb_s,
              "started_at" => at_s
            }} =
             List.keyfind(events, :call_start, 0)

    assert ch_s == Integer.to_string(channel_id)
    assert call_s == Integer.to_string(call_id)
    assert th_s == Integer.to_string(thread_id)
    assert sb_s == Integer.to_string(starter)
    assert String.contains?(at_s, "T")

    assert {:call_update, %{"state" => "joined", "leg" => ^leg}} = List.keyfind(events, :call_update, 0)

    cleanup_call(channel_id)
  end

  test "second start while live auto-joins the same call (AM16 — no second room)" do
    channel_id = Cytale.Snowflake.next()
    a = Cytale.Snowflake.next()
    b = Cytale.Snowflake.next()

    {%{call_id: call_id, action: :started}, _sa} = start(channel_id, a)
    session_b = spawn_session()
    {:ok, %{call_id: call_id2, action: :joined, leg_id: leg_b}} = Calls.start_call(channel_id, b, session_b)

    assert call_id2 == call_id
    assert length(Calls.live_call(channel_id).participants) == 2
    # One room only (the registry's unique key).
    assert Calls.room_pid(channel_id) != nil

    # The loser's join is a real leg on the live call.
    assert Enum.any?(Calls.live_call(channel_id).participants, &(&1.user_id == b and &1.leg == leg_b))

    cleanup_call(channel_id)
  end

  # -- Idle sweep (AM10) --------------------------------------------------------------

  test "empty room is swept after the window and the row closes as last_left" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {%{call_id: call_id}, session} = start(channel_id, starter)

    :ok = Calls.leave_call(channel_id, starter)
    Process.exit(session, :kill)

    assert eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)
    assert Calls.live_call(channel_id) == nil

    row = call_row(channel_id, call_id)
    assert row["ended_at"] != nil
    assert row["ended_reason"] == "last_left"

    assert {:call_end, %{"reason" => "last_left"}} =
             List.keyfind(drain_sink_events(), :call_end, 0)
  end

  test "rejoin within the sweep window keeps the same call" do
    channel_id = Cytale.Snowflake.next()
    a = Cytale.Snowflake.next()
    b = Cytale.Snowflake.next()
    {%{call_id: call_id}, _sa} = start(channel_id, a)

    :ok = Calls.leave_call(channel_id, a)

    # Still inside the 400ms window: B joins, the call survives.
    session_b = spawn_session()
    {:ok, %{call_id: call_id2}} = Calls.join_call(channel_id, b, session_b)
    assert call_id2 == call_id

    Process.sleep(@short_sweep + 200)
    assert Calls.live_call(channel_id) != nil, "rejoin must cancel the idle sweep"
    assert call_row(channel_id, call_id)["ended_at"] == nil

    cleanup_call(channel_id)
  end

  # -- Session grace (AM4) -------------------------------------------------------------

  test "session DOWN keeps the leg through grace; grace expiry removes it" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {%{call_id: call_id}, session} = start(channel_id, starter)

    Process.exit(session, :kill)
    Process.sleep(50)

    # Inside the 250ms grace the leg stands.
    assert [%{user_id: ^starter}] = Calls.live_call(channel_id).participants

    # After grace: removed → empty → idle sweep ends the call.
    assert eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)
    assert call_row(channel_id, call_id)["ended_reason"] == "last_left"
    assert Enum.any?(drain_sink_events(), &match?({:call_update, %{"state" => "left"}}, &1))
  end

  test "a re-bound pid within grace cancels it (the Resume path)" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {_result, session} = start(channel_id, starter)

    Process.exit(session, :kill)

    # Re-bind quickly: same user, NEW session pid.
    session2 = spawn_session()
    {:ok, _} = Calls.join_call(channel_id, starter, session2)

    # Well past the grace window the leg is still there — the re-bind won.
    Process.sleep(@short_grace + 300)
    assert [%{user_id: ^starter}] = Calls.live_call(channel_id).participants

    cleanup_call(channel_id)
  end

  test "a second device's join displaces the first leg (AM8)" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {_result, session1} = start(channel_id, starter)
    drain_sink_events()

    session2 = spawn_session()
    {:ok, %{leg_id: leg2}} = Calls.join_call(channel_id, starter, session2)

    # ONE voice state per user: the new leg won.
    assert [%{user_id: ^starter, leg: ^leg2}] = Calls.live_call(channel_id).participants

    # The loser's own leg discriminator carried the displaced update.
    assert {:call_update, %{"state" => "displaced"}} =
             List.keyfind(drain_sink_events(), :call_update, 0)

    Process.exit(session1, :kill)
    Process.exit(session2, :kill)
    cleanup_call(channel_id)
  end

  # -- Voice state ----------------------------------------------------------------------

  test "mute/deafen state transitions (deafen implies mute, AM12)" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {_result, _session} = start(channel_id, starter)
    drain_sink_events()

    assert {:ok, %{mute: true, deafen: true}} = Calls.update_participant(channel_id, starter, %{deafen: true})
    assert {:ok, %{mute: true, deafen: false}} = Calls.update_participant(channel_id, starter, %{deafen: false})
    assert {:ok, %{mute: false, deafen: false}} = Calls.update_participant(channel_id, starter, %{mute: false})

    # Wire transitions via the seam, in order.
    states =
      drain_sink_events()
      |> Enum.filter(&match?({:call_update, _}, &1))
      |> Enum.map(fn {:call_update, %{"state" => s}} -> s end)

    assert states == ["deafened", "undeafened", "unmuted"]

    assert {:error, :not_participant} = Calls.update_participant(channel_id, Cytale.Snowflake.next(), %{mute: true})
    assert {:error, :no_live_call} = Calls.update_participant(Cytale.Snowflake.next(), starter, %{mute: true})
    assert {:error, :no_live_call} = Calls.join_call(Cytale.Snowflake.next(), starter, spawn_session())

    cleanup_call(channel_id)
  end

  # -- DM rooms (R11) --------------------------------------------------------------------

  test "DM room: no thread linkage and no calls row at all" do
    {:ok, ua} = Cytale.Accounts.User.create(run_nonce() <> "-dm-a", run_nonce() <> "a@dm.example.com", "password-123")
    {:ok, ub} = Cytale.Accounts.User.create(run_nonce() <> "-dm-b", run_nonce() <> "b@dm.example.com", "password-123")
    {:ok, dm} = Cytale.Workspaces.open_dm(ua.user_id, ub.user_id)

    {%{action: :started, call_id: call_id, thread_id: thread_id}, _session} = start(dm.channel_id, ua.user_id)

    assert thread_id == nil

    snapshot = Calls.live_call(dm.channel_id)
    assert snapshot.dm == true
    assert snapshot.thread_id == nil

    # No durable artifact: no row, no standing-thread mapping.
    assert call_row(dm.channel_id, call_id) == nil
    assert open_rows(dm.channel_id) == []
    assert Cytale.Calls.Log.thread_id(dm.channel_id) == nil

    # DM payloads: a null thread_id on CallStart (U1's shape), a joined leg.
    events = drain_sink_events()
    assert {:call_start, %{"thread_id" => nil, "channel_id" => ch_s}} = List.keyfind(events, :call_start, 0)
    assert ch_s == Integer.to_string(dm.channel_id)
    assert {:call_update, %{"state" => "joined"}} = List.keyfind(events, :call_update, 0)

    cleanup_call(dm.channel_id)
  end

  # -- Crash recovery (R8) -----------------------------------------------------------------

  test "room crash restarts, adopts the open row, and the empty sweep ends it as swept" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    {%{call_id: call_id}, session} = start(channel_id, starter)
    pid_before = Calls.room_pid(channel_id)
    drain_sink_events()

    # Crash: the supervisor restarts the (permanent) room; init re-adopts
    # the open row with NO participants — no ghosts.
    Process.exit(pid_before, :kill)
    Process.exit(session, :kill)

    assert eventually(3_000, fn ->
             pid = Calls.room_pid(channel_id)
             pid != nil and pid != pid_before
           end)

    # The adopted room's empty sweep closes the stale call (reason `swept`,
    # per R8's crash-recovery arm) and the room terminates.
    assert eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)

    row = call_row(channel_id, call_id)
    assert row["ended_at"] != nil
    assert row["ended_reason"] == "swept"
  end
end
