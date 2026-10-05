defmodule Cytale.Calls.CallsTest do
  @moduledoc """
  Voice plan U3 — the calls context: Scylla round-trips (calls rows
  open/close, call_threads reuse, notification_mutes), the boot sweep
  (R8's `swept` arm), recently-ended history, and the permission gates
  (KTD7/AM2: START_CALL default-on via the resolve-time @everyone base,
  channel-overwrite deny blocks, VIEW_CHANNEL live checks, DM
  participation-is-authorization).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls
  alias Cytale.Permissions.Bitfield
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @short_sweep 300

  setup do
    # Short idle sweep so every started call can be ended deterministically
    # within its test (no lingering open rows — the sweep_stale count
    # assertions below count GLOBAL open rows).
    old_calls = Application.get_env(:cytale, :calls, [])

    Application.put_env(
      :cytale,
      :calls,
      Keyword.merge(old_calls, empty_sweep_ms: @short_sweep, session_grace_ms: 150)
    )

    on_exit(fn -> Application.put_env(:cytale, :calls, old_calls) end)
    :ok
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp spawn_session do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  # Start a call, then end it by sweeping (leave + wait out the window).
  defp start_and_sweep(channel_id, user_id) do
    session = spawn_session()
    {:ok, %{call_id: call_id}} = Calls.start_call(channel_id, user_id, session)
    Process.exit(session, :kill)
    :ok = Calls.leave_call(channel_id, user_id)
    eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)
    call_id
  end

  defp eventually(timeout_ms, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout_ms

    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) >= deadline do
        false
      else
        Process.sleep(25)
        eventually(timeout_ms, fun)
      end
    end
  end

  defp ks, do: Cytale.ScyllaCase.keyspace()

  defp call_rows(channel_id) do
    Cytale.Repo.execute!(
      "SELECT call_id, started_by, started_at, ended_at, ended_reason, thread_id FROM #{ks()}.calls WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
  end

  defp open_index_rows(channel_id) do
    Cytale.Repo.execute!(
      "SELECT call_id FROM #{ks()}.open_calls WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.map(& &1["call_id"])
  end

  # A statement capture over Xandra's query telemetry, used by the 4.13 sweep
  # test. The handler runs in the emitting connection process, so a short settle
  # before draining is all the ordering slack this needs.
  #
  # `\.calls\b` deliberately does NOT match `open_calls`: the index is the table
  # the sweep is supposed to walk, `calls` is the one it must not scan.
  defp capture_calls_statements(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "calls-sweep-stmts-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          send(parent, {:stmt, ref, metadata.query.statement})
        end,
        parent
      )

    result = fun.()
    Process.sleep(50)
    statements = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)

    {Enum.filter(statements, &Regex.match?(~r/\.calls\b/, &1)), result}
  end

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  # -- ScyllaCase round-trips -----------------------------------------------------------

  test "calls row opens at start and closes at end (reason last_left)" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()
    session = spawn_session()
    {:ok, %{call_id: call_id}} = Calls.start_call(channel_id, starter, session)

    assert [%{"call_id" => ^call_id, "ended_at" => nil, "ended_reason" => nil}] = call_rows(channel_id)

    Process.exit(session, :kill)
    :ok = Calls.leave_call(channel_id, starter)
    assert eventually(3_000, fn -> is_nil(Calls.room_pid(channel_id)) end)

    assert [%{"call_id" => ^call_id, "ended_at" => %DateTime{}, "ended_reason" => "last_left"}] =
             call_rows(channel_id)
  end

  test "recently_ended_calls lists ended calls newest-first, bounded" do
    channel_id = Cytale.Snowflake.next()
    user = Cytale.Snowflake.next()
    first = start_and_sweep(channel_id, user)
    second = start_and_sweep(channel_id, user)

    assert second > first, "snowflakes are chronological"

    ended = Calls.recently_ended_calls(channel_id)
    assert length(ended) == 2
    assert [%{call_id: ^second}, %{call_id: ^first}] = ended
    assert Enum.all?(ended, &(&1.ended_reason == "last_left" and match?(%DateTime{}, &1.ended_at)))

    assert [%{call_id: ^second}] = Calls.recently_ended_calls(channel_id, 1)
  end

  test "call_threads mapping is created once and reused by later calls" do
    channel_id = Cytale.Snowflake.next()
    user = Cytale.Snowflake.next()

    first = start_and_sweep(channel_id, user)
    second = start_and_sweep(channel_id, user)

    assert second != first

    # One mapping row, one standing thread — reused, never duplicated.
    assert Cytale.Calls.Log.thread_id(channel_id) != nil
    rows = call_rows(channel_id)
    assert length(rows) == 2
    assert Enum.map(rows, & &1["thread_id"]) |> Enum.uniq() |> length() == 1

    threads = Thread.list_in_channel(channel_id)
    assert [%{name: "Call log"}] = Enum.filter(threads, &(&1.name == "Call log"))
  end

  test "notification_mutes set/get/clear round-trip, default unmuted" do
    user = Cytale.Snowflake.next()
    channel_id = Cytale.Snowflake.next()

    assert Calls.notification_muted?(user, channel_id) == false

    :ok = Calls.set_notification_mute(user, channel_id, true)
    assert Calls.notification_muted?(user, channel_id) == true

    # Mute is per-channel, not per-user-global.
    other = Cytale.Snowflake.next()
    assert Calls.notification_muted?(user, other) == false

    :ok = Calls.set_notification_mute(user, channel_id, false)
    assert Calls.notification_muted?(user, channel_id) == false
  end

  # -- Boot sweep (R8) -------------------------------------------------------------------

  test "sweep_stale closes open rows with no live room, as swept" do
    # Boot semantics first: whatever earlier runs (or a crashed server — the
    # keyspace persists across BEAM exits, which is exactly the restart
    # case R8's boot sweep exists for) left open gets closed now.
    _ = Calls.sweep_stale()

    channel_id = Cytale.Snowflake.next()
    user = Cytale.Snowflake.next()
    session = spawn_session()
    {:ok, %{call_id: call_id, room: room}} = Calls.start_call(channel_id, user, session)

    # The live index (plan 4.13) names this call — that is what lets the sweep
    # find it below without scanning history.
    assert open_index_rows(channel_id) == [call_id]

    # A live room shields its row from the sweep.
    assert Calls.sweep_stale() == 0
    assert [%{"ended_at" => nil}] = call_rows(channel_id)

    # Hard-remove the room (terminate + no restart — the "no live room" state
    # a crashed server or a lost registry leaves behind).
    :ok = Cytale.Calls.RoomSupervisor.stop_room(room)
    assert is_nil(Calls.room_pid(channel_id))

    assert Calls.sweep_stale() == 1

    assert [%{"call_id" => ^call_id, "ended_at" => %DateTime{}, "ended_reason" => "swept"}] =
             call_rows(channel_id)

    # Closing releases the index row, or the sweep would revisit it forever.
    assert open_index_rows(channel_id) == []

    # Idempotent: nothing left to close.
    assert Calls.sweep_stale() == 0
  end

  # Plan 4.13's own race: the sweep runs at boot AFTER the endpoint starts
  # serving, so a call can start on a channel between the sweep's read and its
  # index release. Releasing by identity makes the late release a no-op instead of
  # deleting the newer call's row — which would leave a live call invisible to the
  # next sweep, i.e. exactly the orphaned open row the index exists to prevent.
  test "releasing one call's index row does not take out a newer call's" do
    channel_id = Cytale.Snowflake.next()
    superseded = 9_700_000_000_000_001
    newer = 9_700_000_000_000_002

    # The abandoned call holds the row…
    :ok = Calls.mark_open(channel_id, superseded)
    assert open_index_rows(channel_id) == [superseded]

    # …a new call starts on the same channel while the sweep is mid-flight, and
    # takes the row (one row per channel: the index tracks the LATEST call).
    :ok = Calls.mark_open(channel_id, newer)
    assert open_index_rows(channel_id) == [newer]

    # The sweep's late release names the call it read, so it must not match.
    :ok = Calls.mark_closed(channel_id, superseded)
    assert open_index_rows(channel_id) == [newer]

    # Control on the guard, so it is not simply refusing every release: the
    # owner of the row does release it.
    :ok = Calls.mark_closed(channel_id, newer)
    assert open_index_rows(channel_id) == []
  end

  # Plan 4.13: the sweep must not pay for call HISTORY. `calls` is partitioned by
  # channel and never pruned, so the old `SELECT ... FROM calls` scan read every
  # call ever made at every boot, under a 30s timeout.
  test "the boot sweep's cost is independent of call history" do
    # Start from a clean slate: the count below is global.
    _ = Calls.sweep_stale()

    # History: N ended calls, one channel each (the shape a long-lived instance
    # accumulates). Plus one abandoned LIVE call — an open `calls` row with an
    # index row and no room — which is the sweep's actual work.
    seed_history = fn from, to ->
      for i <- from..to do
        Cytale.Repo.execute!(
          "INSERT INTO #{ks()}.calls (channel_id, call_id, started_by, started_at, ended_at, ended_reason, thread_id, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [
            {"bigint", 9_300_000_000_000_000 + i},
            {"bigint", 9_400_000_000_000_000 + i},
            {"bigint", 1},
            {"timestamp", DateTime.utc_now()},
            {"timestamp", DateTime.utc_now()},
            {"text", "last_left"},
            {"bigint", nil},
            {"text", nil}
          ]
        )
      end
    end

    abandon_call = fn channel_id, call_id ->
      now = DateTime.utc_now()

      Cytale.Repo.execute!(
        "INSERT INTO #{ks()}.calls (channel_id, call_id, started_by, started_at, ended_at, ended_reason, thread_id, name) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [
          {"bigint", channel_id},
          {"bigint", call_id},
          {"bigint", 1},
          {"timestamp", now},
          {"timestamp", nil},
          {"text", nil},
          {"bigint", nil},
          {"text", nil}
        ]
      )

      # Raw insert rather than `Calls.mark_open/2`: this test measures the SWEEP,
      # so its fixture must not depend on the function whose effect the
      # measurement is about. That the index IS written on the normal path is
      # pinned by the sweep test above (a `start_call` row is found and closed).
      Cytale.Repo.execute!(
        "INSERT INTO #{ks()}.open_calls (channel_id, call_id) VALUES (?, ?)",
        [{"bigint", channel_id}, {"bigint", call_id}]
      )
    end

    seed_history.(1, 200)
    abandon_call.(9_500_000_000_000_001, 9_600_000_000_000_001)

    {first_stmts, closed} = capture_calls_statements(fn -> Calls.sweep_stale() end)
    assert closed == 1

    # Two statements: one point read of the candidate and one close UPDATE —
    # both partition-scoped. The regression this pins is the bare
    # `SELECT channel_id, call_id, ended_at FROM calls`, one more historical row
    # at a time.
    assert length(first_stmts) == 2, "sweep ran #{length(first_stmts)} calls statements: #{inspect(first_stmts)}"

    assert Enum.all?(first_stmts, &String.contains?(&1, "WHERE")),
           "the sweep issued an unbounded scan of calls: #{inspect(first_stmts)}"

    assert [read, update] = first_stmts
    assert read =~ "SELECT ended_at"
    assert update =~ "UPDATE"

    # The claim, measured rather than asserted structurally: double the history
    # and the sweep's `calls` work does not move.
    seed_history.(201, 400)
    abandon_call.(9_500_000_000_000_002, 9_600_000_000_000_002)

    {second_stmts, closed_again} = capture_calls_statements(fn -> Calls.sweep_stale() end)
    assert closed_again >= 1

    # The sweep is GLOBAL: another open `calls` row can appear between the two
    # measurements (a room from an earlier module whose idle timer fires here — it
    # did, in a full-suite run), and each extra candidate costs exactly one point
    # read plus one close. So the claim is a BOUND per candidate, not equality:
    # the work stays proportional to live calls and never to the 400 history rows.
    assert length(second_stmts) <= length(first_stmts) + 2 * (closed_again - 1)
    assert Enum.all?(second_stmts, &String.contains?(&1, "WHERE"))

    # And the index row is gone, so the sweep is idempotent (the existing sweep
    # test asserts the same for a room-killed call).
    assert Calls.sweep_stale() == 0
  end

  # -- Permission gates (KTD7/AM2 seam for U4) ----------------------------------------------

  defp seed_workspace do
    {:ok, owner} =
      Cytale.Accounts.User.create(run_unique("owner"), run_unique("owner@gate.example.com"), "password-123")

    {:ok, member} =
      Cytale.Accounts.User.create(run_unique("member"), run_unique("member@gate.example.com"), "password-123")

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Gate WS"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, run_unique("chan"))
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id, [])
    %{owner: owner, member: member, ws: ws, ch: ch}
  end

  test "can_start_call?: plain member default-on; channel deny blocks; DM rules" do
    %{owner: owner, member: member, ws: ws, ch: ch} = seed_workspace()

    # Default-on for a plain member (the resolve-time @everyone base).
    assert Calls.can_start_call?(ch.channel_id, member.user_id) == true
    assert Calls.can_start_call?(ch.channel_id, owner.user_id) == true

    # Explicit channel overwrite denying START_CALL blocks start.
    Workspaces.put_overwrite(ch.channel_id, :member, member.user_id, 0, Bitfield.bit(:start_call))
    assert Calls.can_start_call?(ch.channel_id, member.user_id) == false
    # ... without touching join (VIEW_CHANNEL still holds).
    assert Calls.can_join_call?(ch.channel_id, member.user_id) == true

    # A member denied VIEW_CHANNEL cannot join either.
    Workspaces.put_overwrite(ch.channel_id, :member, member.user_id, 0, Bitfield.bit(:view_channel))
    assert Calls.can_join_call?(ch.channel_id, member.user_id) == false

    # Non-members and unknown channels fail closed.
    {:ok, outsider} = Cytale.Accounts.User.create(run_unique("out"), run_unique("out@gate.example.com"), "password-123")
    assert Calls.can_start_call?(ch.channel_id, outsider.user_id) == false
    assert Calls.can_start_call?(Cytale.Snowflake.next(), member.user_id) == false

    # DMs: participation IS authorization.
    {:ok, dm} = Workspaces.open_dm(owner.user_id, member.user_id)
    assert Calls.can_start_call?(dm.channel_id, member.user_id) == true
    assert Calls.can_join_call?(dm.channel_id, member.user_id) == true
    assert Calls.can_start_call?(dm.channel_id, outsider.user_id) == false

    _ = ws
  end
end
