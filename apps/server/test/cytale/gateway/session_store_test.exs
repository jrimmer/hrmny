defmodule Cytale.Gateway.SessionStoreTest do
  @moduledoc """
  U4 (bots plan, KTD6) — the principal→session index and the two teardown
  operations on top of it: `close_principal_sessions/2` (revocation: 4004 +
  record purge so Resume cannot resurrect) and `reconnect_principal_sessions/1`
  (restriction-profile change: the reconnectable signal AND a record purge —
  the credential stays valid, but the narrowing must force a fresh Identify,
  so a Resume cannot resurrect the pre-narrowing restrictions frozen in the
  stored record). Registration is socket-driven (`track_principal/2` from
  the owning process) and dead pids are filtered at read time.

  The session-cap SLOT table (KTD15's atomic claim) is exercised here too:
  `claim_principal_slot/2` + `release_principal_slots/1`.

  The store + its ETS tables run under the app supervision tree for the
  whole test run; async:true is safe because every fixture key (principal
  id, session id) is unique per test.
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.{PushRegistry, Session, SessionStore}

  defp unique_int, do: :erlang.unique_integer([:positive, :monotonic])

  # A stand-in socket process: registers itself under `principal_id` exactly
  # as GatewaySocket does at Identify/Resume success (the TRACKING runs in
  # the socket's own process — self() is the registered pid), then surfaces
  # the two principal-targeted teardown messages to the test.
  defp spawn_tracked!(principal_id) do
    parent = self()

    pid = spawn(fn -> socket_loop(parent) end)

    session_id = "s#{unique_int()}"

    {:ok, %Session{}} =
      SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id))

    send(pid, {:track, principal_id, session_id, parent})

    receive do
      {:tracked, ^session_id} -> :ok
    after
      1_000 -> flunk("socket process never tracked")
    end

    {pid, session_id}
  end

  defp socket_loop(parent) do
    receive do
      {:track, principal_id, session_id, reply_to} ->
        :ok = SessionStore.track_principal(principal_id, session_id)
        send(reply_to, {:tracked, session_id})
        socket_loop(parent)

      {:cytale_principal_close, code} ->
        send(parent, {:closed, code})
        socket_loop(parent)

      :cytale_principal_reconnect ->
        send(parent, :reconnect)
        socket_loop(parent)

      :stop ->
        :ok
    end
  end

  describe "track_principal/2 + principal_sessions/1" do
    test "registers a live {pid, session_id} pair and reads it back" do
      principal_id = unique_int()
      {pid, session_id} = spawn_tracked!(principal_id)

      assert SessionStore.principal_sessions(principal_id) == [{pid, session_id}]
      send(pid, :stop)
    end

    test "a principal's second live session is additive (multi-connection)" do
      principal_id = unique_int()
      {pid, session_id} = spawn_tracked!(principal_id)
      {pid2, session_id2} = spawn_tracked!(principal_id)

      sessions = SessionStore.principal_sessions(principal_id)
      assert {pid, session_id} in sessions
      assert {pid2, session_id2} in sessions
      assert length(sessions) == 2
    end

    test "entries from crashed sockets are filtered at read time" do
      principal_id = unique_int()
      {pid, _session_id} = spawn_tracked!(principal_id)
      {pid2, session_id2} = spawn_tracked!(principal_id)

      ref = Process.monitor(pid)
      Process.exit(pid, :kill)
      assert_receive {:DOWN, ^ref, _, _, _}, 1_000

      assert SessionStore.principal_sessions(principal_id) == [{pid2, session_id2}]
      send(pid2, :stop)
    end

    test "unknown principal reads empty" do
      assert SessionStore.principal_sessions(unique_int()) == []
    end

    test "untrack_principal/1 drops only that pid's entries" do
      principal_id = unique_int()
      other_id = unique_int()

      {pid, session_id} = spawn_tracked!(principal_id)
      {_pid2, _session_id2} = spawn_tracked!(principal_id)
      {pid3, session_id3} = spawn_tracked!(other_id)

      # The socket's terminate path unregisters itself.
      :ok = SessionStore.untrack_principal(pid)

      sessions = SessionStore.principal_sessions(principal_id)
      assert {pid, session_id} not in sessions
      assert length(sessions) == 1
      assert SessionStore.principal_sessions(other_id) == [{pid3, session_id3}]
    end
  end

  describe "close_principal_sessions/2 (revocation teardown)" do
    test "delivers the close code to every live socket AND purges the records" do
      principal_id = unique_int()
      {pid, session_id} = spawn_tracked!(principal_id)
      {pid2, session_id2} = spawn_tracked!(principal_id)

      :ok = SessionStore.close_principal_sessions(principal_id, 4004)

      assert_receive {:closed, 4004}, 1_000
      assert_receive {:closed, 4004}, 1_000

      # Resume cannot resurrect: stored records and their claims are gone.
      assert SessionStore.get(session_id) == nil
      assert SessionStore.get(session_id2) == nil
      refute SessionStore.claimed?(session_id)
    end

    test "other principals are untouched by a teardown" do
      doomed = unique_int()
      bystander = unique_int()

      {_pid, _session_id} = spawn_tracked!(doomed)
      {pid3, session_id3} = spawn_tracked!(bystander)

      :ok = SessionStore.close_principal_sessions(doomed, 4004)
      assert_receive {:closed, 4004}, 1_000

      assert %Session{} = SessionStore.get(session_id3)
      send(pid3, :stop)
    end

    test "close of an untracked principal is a no-op :ok" do
      assert SessionStore.close_principal_sessions(unique_int(), 4004) == :ok
    end
  end

  describe "reconnect_principal_sessions/1 (restriction-profile teardown)" do
    test "delivers the reconnect signal AND purges the records (fresh Identify forced)" do
      principal_id = unique_int()
      {pid, session_id} = spawn_tracked!(principal_id)

      :ok = SessionStore.reconnect_principal_sessions(principal_id)

      assert_receive :reconnect, 1_000

      # The credential stays valid (no 4004), but the stored record is GONE:
      # a post-teardown Resume is refused and the client must re-Identify —
      # a Resume would otherwise resurrect the pre-narrowing restrictions
      # frozen in the record (A1).
      assert SessionStore.get(session_id) == nil
      refute SessionStore.claimed?(session_id)
      send(pid, :stop)
    end

    test "reconnect of an untracked principal is a no-op :ok" do
      assert SessionStore.reconnect_principal_sessions(unique_int()) == :ok
    end
  end

  describe "#52 claim holder liveness + orphan recovery" do
    test "a claim whose holder died is a PHANTOM: taken over, not blocking" do
      session_id = "s#{unique_int()}"
      {:ok, _} = SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id))

      # A claim from a process that dies UNTRAPPABLY (no cleanup runs) — the
      # shape #52's max_heap_size kill leaves behind.
      holder = spawn_holder!(session_id)
      assert SessionStore.claim_holder_state(session_id) == :alive

      Process.exit(holder, :kill)
      eventually!(fn -> SessionStore.claim_holder_state(session_id) == :dead end)

      # The marker is still there, but it is no longer LIVE.
      assert SessionStore.claimed?(session_id)
      refute SessionStore.claim_held_by_live?(session_id)

      # The next claimer takes it over instead of being locked out until the
      # session expires — which is what used to happen.
      assert {:ok, :claimed} = SessionStore.claim(session_id)
      assert SessionStore.claim_holder_state(session_id) == :alive
      assert SessionStore.claim_held_by_live?(session_id)
    end

    test "a claim held by a LIVE process is refused (no hijack)", _ do
      session_id = "s#{unique_int()}"
      {:ok, _} = SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id))

      holder = spawn_holder!(session_id)
      assert SessionStore.claim_holder_state(session_id) == :alive

      # From THIS process: refused, and the holder is undisturbed.
      assert {:error, :already_claimed} = SessionStore.claim(session_id)
      assert Process.alive?(holder)
      assert SessionStore.claim_held_by_live?(session_id)

      send(holder, :stop)
    end

    # the sweep reaches the database
    @tag :scylla
    test "the sweeper recovers an untrappably-dead session and then reaps it" do
      session_id = "s#{unique_int()}"
      long_ago = System.system_time(:millisecond) - 20 * 60 * 1000

      # Created (and last alive) well past the resume window — without
      # recovery this record would sit `:connected` forever: the sweep
      # deliberately never reaps a live-looking record, so it and its replay
      # buffer would leak, one per untrappable death.
      {:ok, _} =
        SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id, now_ms: long_ago))

      holder = spawn_holder!(session_id)
      Process.exit(holder, :kill)
      eventually!(fn -> SessionStore.claim_holder_state(session_id) == :dead end)

      # It is ALSO held for offline delivery (hardening plan 4.2): the sweep must
      # retire that hold with the record, or every later fan-out on the route
      # would keep writing envelopes into a hole nobody can replay.
      sweep_key = PushRegistry.user_key("sweep-#{unique_int()}")
      :ok = PushRegistry.hold_session(session_id, [sweep_key])
      assert PushRegistry.held_sessions(sweep_key) == [session_id]

      # The phantom is reaped: recovered at its last sign of life (20 min ago)
      # and therefore expired on the next pass — record and marker both gone.
      # Before the recovery it sat `:connected` forever ("live sessions are
      # never swept"), leaking its replay buffer on every untrappable death.
      eventually!(fn -> SessionStore.get(session_id) == nil end)
      refute SessionStore.claimed?(session_id)
      assert PushRegistry.held_sessions(sweep_key) == []
    end

    test "a LIVE holder's session is never recovered, however old its clock", _ do
      session_id = "s#{unique_int()}"
      long_ago = System.system_time(:millisecond) - 20 * 60 * 1000

      {:ok, _} =
        SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id, now_ms: long_ago))

      holder = spawn_holder!(session_id)

      # Recovery is keyed on the HOLDER being dead, not on how stale the
      # record's clock looks: a live session must never be reaped out from
      # under its socket.
      Process.sleep(2_500)

      assert %Session{phase: :connected} = SessionStore.get(session_id)
      assert SessionStore.claim_held_by_live?(session_id)

      send(holder, :stop)
    end

    test "a recovered orphan is also HELD for offline delivery (4.2)" do
      # The socket that dies untrappably never runs terminate/2, so it never
      # writes the offline hold either. Its session is still resumable once the
      # sweep recovers it — so without holding here, the resume window would keep
      # the original hole: events published during it reach nobody while
      # `replay_complete?/2` still accepts the resume.
      session_id = "s#{unique_int()}"
      key = PushRegistry.channel_key("orphan-#{unique_int()}")
      now = System.system_time(:millisecond)

      {:ok, _} =
        SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: session_id, now_ms: now))

      holder = spawn_holder!(session_id)

      :ok = PushRegistry.subscribe(key, "1", holder)
      Process.exit(holder, :kill)
      eventually!(fn -> SessionStore.claim_holder_state(session_id) == :dead end)

      # A fan-out on one of the dead socket's routes runs FIRST (that is the
      # ordinary case — traffic beats the one-second sweep), which reclaims its
      # route rows. The reclaim must not also erase the routes the recovery
      # needs, or the orphan is "recovered" as resumable with an EMPTY address
      # book and its resume window silently drops everything.
      assert PushRegistry.subscribers(key) == []
      assert PushRegistry.session_keys(holder) == [key]

      eventually!(fn -> session_id in PushRegistry.held_sessions(key) end)

      # …and the sweep retires the parked entry once the hold owns the routes.
      eventually!(fn -> PushRegistry.session_keys(holder) == [] end)

      on_exit(fn ->
        PushRegistry.release_held(session_id)
        SessionStore.delete(session_id)
      end)
    end

    # A stand-in claim holder: claims in its OWN process (so the marker records
    # that pid) and then idles until killed or told to stop.
    defp spawn_holder!(session_id) do
      parent = self()

      pid =
        spawn(fn ->
          {:ok, :claimed} = SessionStore.claim(session_id)
          send(parent, {:claimed, self()})

          receive do
            :stop -> :ok
          end
        end)

      receive do
        {:claimed, ^pid} -> :ok
      after
        1_000 -> flunk("holder never claimed")
      end

      pid
    end

    defp eventually!(fun, tries \\ 300)

    defp eventually!(_fun, 0), do: flunk("condition not met in time")

    defp eventually!(fun, tries) do
      if fun.(), do: :ok, else: Process.sleep(20) && eventually!(fun, tries - 1)
    end
  end

  describe "expiry sweep (PERF-04 sweep index)" do
    # Regression: the index rows were inserted as `{anchor, session_id}`,
    # which keys an ETS row on `anchor` ALONE — the walk never matched a key,
    # so no disconnected session was ever reaped, and two sessions sharing an
    # anchor millisecond overwrote each other's entry.
    test "disconnected sessions past the window are reaped, two sharing one anchor ms included" do
      long_ago = System.system_time(:millisecond) - 20 * 60 * 1000

      # Two ids that route to the SAME shard, so their entries share one index.
      first = "sweep-a-#{unique_int()}"
      shard = :erlang.phash2(first, 8)

      second =
        Stream.repeatedly(fn -> "sweep-b-#{unique_int()}" end)
        |> Enum.find(&(:erlang.phash2(&1, 8) == shard))

      for id <- [first, second] do
        record =
          %{id: "1", username: "u"}
          |> Session.new(session_id: id, now_ms: long_ago)
          |> Session.mark_disconnected(long_ago)

        {:ok, _} = SessionStore.put(record)
      end

      # A disconnected record inside the window is NOT reaped.
      fresh = "sweep-fresh-#{unique_int()}"
      now = System.system_time(:millisecond)

      {:ok, _} =
        SessionStore.put(
          %{id: "1", username: "u"}
          |> Session.new(session_id: fresh, now_ms: now)
          |> Session.mark_disconnected(now)
        )

      eventually!(fn -> SessionStore.get(first) == nil and SessionStore.get(second) == nil end)
      assert %Session{phase: :disconnected} = SessionStore.get(fresh)

      SessionStore.delete(fresh)
    end
  end

  describe "session-cap slots (KTD15 — atomic claim)" do
    test "claims distinct slots up to the cap, then reports full" do
      principal_id = unique_int()

      slots =
        for i <- 1..3, i <= 3 do
          assert {:ok, slot} = SessionStore.claim_principal_slot(principal_id, 3)
          slot
        end

      assert Enum.sort(slots) == [1, 2, 3]
      assert {:error, :full} = SessionStore.claim_principal_slot(principal_id, 3)
      :ok = SessionStore.release_principal_slots(self())
    end

    test "concurrent claims never overshoot the cap (no TOCTOU)" do
      principal_id = unique_int()
      cap = 4
      parent = self()

      # cap-2 pre-held + 2x cap concurrent claimers: exactly 2 win. The
      # claimers stay alive until the assertions complete — a dead holder's
      # slot is legitimately reclaimable, so winners must not exit mid-race.
      assert {:ok, _} = SessionStore.claim_principal_slot(principal_id, cap)
      assert {:ok, _} = SessionStore.claim_principal_slot(principal_id, cap)

      claimers =
        for _ <- 1..(cap * 2) do
          spawn_link(fn ->
            send(parent, {:claim, self(), SessionStore.claim_principal_slot(principal_id, cap)})
            receive(do: (:release -> :ok))
          end)
        end

      results =
        for _ <- 1..(cap * 2) do
          receive do
            {:claim, _pid, r} -> r
          after
            1_000 -> flunk("claim never reported")
          end
        end

      # cap - pre-held(2) slots remain; the swarm cannot exceed them.
      winners = results |> Enum.filter(&match?({:ok, _}, &1)) |> length()
      assert winners == 2
      losers = results |> Enum.filter(&match?({:error, :full}, &1)) |> length()
      assert losers == cap * 2 - 2

      Enum.each(claimers, &send(&1, :release))

      # A different principal's cap is independent.
      assert {:ok, _} = SessionStore.claim_principal_slot(unique_int(), cap)
      :ok = SessionStore.release_principal_slots(self())
    end

    test "release_principal_slots frees the slot for the next claim" do
      principal_id = unique_int()

      # Claim in the test process, release, reclaim.
      assert {:ok, slot} = SessionStore.claim_principal_slot(principal_id, 1)
      assert {:error, :full} = SessionStore.claim_principal_slot(principal_id, 1)
      :ok = SessionStore.release_principal_slots(self())
      assert {:ok, ^slot} = SessionStore.claim_principal_slot(principal_id, 1)
      :ok = SessionStore.release_principal_slots(self())
    end

    test "a slot held by a dead process is reclaimed on the next claim" do
      principal_id = unique_int()
      parent = self()

      # Unlinked: the test kills the holder, and a :kill on a linked pid
      # would take the test down with it.
      holder =
        spawn(fn ->
          {:ok, _} = SessionStore.claim_principal_slot(principal_id, 1)
          send(parent, :claimed)
          :timer.sleep(:infinity)
        end)

      assert_receive :claimed, 1_000

      # Holder dies without running terminate (crash): the slot reclaims.
      Process.exit(holder, :kill)
      assert {:ok, _} = SessionStore.claim_principal_slot(principal_id, 1)
      :ok = SessionStore.release_principal_slots(self())
    end

    test "untrack_principal releases slots alongside the index entries" do
      principal_id = unique_int()
      parent = self()

      pid =
        spawn_link(fn ->
          {:ok, _} = SessionStore.claim_principal_slot(principal_id, 1)
          send(parent, :claimed)

          receive do
            :stop -> :ok
          end
        end)

      assert_receive :claimed, 1_000
      :ok = SessionStore.untrack_principal(pid)
      send(pid, :stop)

      assert {:ok, _} = SessionStore.claim_principal_slot(principal_id, 1)
      :ok = SessionStore.release_principal_slots(self())
    end
  end

  describe "sharded lock-free hot path (direct ETS from the claim holder)" do
    # The dispatch-buffer path now runs as a direct ETS read-modify-write in
    # the calling (claim-holding) process, spread over 8 record shards. N
    # writers hammering M DISTINCT sessions in parallel must land EVERY
    # append: per-session seq stays gapless, the buffer holds exactly the
    # session's appends (cap is 1000 — far above these counts), and no
    # update is lost to shard routing or concurrency.
    test "N parallel writers appending to M distinct sessions never lose an append" do
      session_ids =
        for _ <- 1..8 do
          sid = "s#{unique_int()}"

          assert {:ok, %Session{}} =
                   SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: sid))

          sid
        end

      appends = 300
      parent = self()

      for sid <- session_ids do
        spawn(fn ->
          fun = fn %Session{} = rec ->
            {updated, _env} = Session.buffer_event(rec, "TestEvent", %{"sid" => sid})
            updated
          end

          for _ <- 1..appends do
            assert {:ok, %Session{}} = SessionStore.update_local(sid, fun)
          end

          send(parent, {:done, sid})
        end)
      end

      for sid <- session_ids do
        assert_receive {:done, ^sid}, 10_000
      end

      for sid <- session_ids do
        assert %Session{} = stored = SessionStore.get(sid)
        assert stored.seq == appends, "lost appends on #{sid}: seq #{stored.seq} != #{appends}"

        seqs =
          stored
          |> Session.buffered_after(0)
          |> Enum.map(& &1.s)

        assert seqs == Enum.to_list(1..appends), "gap or duplicate seq on #{sid}"
      end
    end

    test "update_local on an unknown session is {:error, :unknown_session} and never creates" do
      sid = "s#{unique_int()}"

      # The fun must never run against nil — creation is the serialized
      # path's concern (update_with), not the lock-free hot path's.
      fun = fn _rec -> flunk("update_local fun must not run for an absent record") end

      assert {:error, :unknown_session} = SessionStore.update_local(sid, fun)
      assert SessionStore.get(sid) == nil
    end

    test "update_local reports a bad fun return WITHOUT corrupting the stored record" do
      sid = "s#{unique_int()}"
      session = %{Session.new(%{id: "1", username: "u"}, session_id: sid) | seq: 7}
      {:ok, ^session} = SessionStore.put(session)

      assert {:error, {:bad_update_return, :garbage}} =
               SessionStore.update_local(sid, fn _rec -> :garbage end)

      assert %Session{seq: 7} = SessionStore.get(sid)
    end

    test "update_local fun raising reports the error and leaves the record intact" do
      sid = "s#{unique_int()}"
      {:ok, _session} = SessionStore.put(Session.new(%{id: "1", username: "u"}, session_id: sid))

      assert {:error, {:update_fun_raised, %RuntimeError{}}} =
               SessionStore.update_local(sid, fn _rec -> raise RuntimeError, "boom" end)

      assert %Session{seq: 0} = SessionStore.get(sid)
    end

    # Claim uniqueness under the sharded layout: the marker row is an ETS
    # insert_new on the session's OWN shard, so N concurrent claimers of one
    # session_id produce exactly one winner — the atomicity is ETS's, not a
    # GenServer's.
    test "concurrent claims of one session_id have exactly one LIVE winner" do
      sid = "s#{unique_int()}"
      parent = self()

      # The claimers HOLD their claim (stay alive until released) — the
      # invariant is "at most one live connection per session", so a claimer
      # that has already exited is not a contender. (A dead holder's claim is
      # a phantom and is taken over — #52; the session-cap SLOT claim has
      # always had the same dead-holder rule, see `claim_slot/2`.)
      claimers =
        for _ <- 1..8 do
          spawn(fn ->
            result = SessionStore.claim(sid)
            send(parent, {:claim, self(), result})

            receive do
              :release -> :ok
            end
          end)
        end

      reports =
        for _ <- 1..8 do
          receive do
            {:claim, pid, r} -> {pid, r}
          after
            1_000 -> flunk("claim never reported")
          end
        end

      results = Enum.map(reports, &elem(&1, 1))
      assert Enum.count(results, &(&1 == {:ok, :claimed})) == 1
      assert Enum.count(results, &(&1 == {:error, :already_claimed})) == 7

      # Kill the winner untrappably: the claim it held is now a phantom, and
      # the next claimer takes it over rather than being locked out. The
      # winner is the claimer that REPORTED the claim — every claimer is still
      # alive (they all wait for :release), so "the first live one" is only
      # the winner when the first-spawned claimer happened to win the race.
      {winner, _} = Enum.find(reports, fn {_pid, r} -> r == {:ok, :claimed} end)
      Process.exit(winner, :kill)
      eventually!(fn -> SessionStore.claim_holder_state(sid) == :dead end)

      assert {:ok, :claimed} = SessionStore.claim(sid)
      assert SessionStore.claim_held_by_live?(sid)

      for pid <- claimers, Process.alive?(pid), do: send(pid, :release)
      :ok = SessionStore.unclaim(sid)
    end
  end
end
