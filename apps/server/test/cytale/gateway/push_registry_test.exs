defmodule Cytale.Gateway.PushRegistryTest do
  @moduledoc """
  The route registry's bookkeeping (hardening plan 5.4): a pid-keyed reverse index
  so releasing a session costs its OWN registrations rather than the node's, and a
  reaper so a socket that died without running its terminate stops being walked by
  every later fan-out.
  """

  use ExUnit.Case, async: false

  alias Cytale.Gateway.PushRegistry

  # A registrable process that just sits there (or dies on request).
  defp idle_pid do
    spawn(fn -> Process.sleep(:infinity) end)
  end

  defp route(n), do: PushRegistry.channel_key("test-channel-#{n}-#{System.unique_integer([:positive])}")

  describe "the reverse index" do
    test "an indexed session's keys are its own, and survive other registrations" do
      mine = idle_pid()
      other = idle_pid()
      key = route(1)

      # Someone else's registrations must not change MY answer: the point of the
      # index is that a session's own view costs nothing for the rest of the node.
      for _ <- 1..50 do
        :ok = PushRegistry.subscribe(route(2), "someone-else", idle_pid())
      end

      :ok = PushRegistry.subscribe(key, "u1", mine, [PushRegistry.user_key("u1")])

      keys = PushRegistry.session_keys(mine)
      assert key in keys
      assert PushRegistry.user_key("u1") in keys
      assert length(keys) == 2
      assert PushRegistry.session_keys(other) == []
    end

    test "subscribe accumulates, unsubscribe removes, sync reconciles exactly" do
      pid = idle_pid()
      a = route(3)
      b = route(4)
      c = route(5)

      :ok = PushRegistry.subscribe(a, "u1", pid, [b])
      assert Enum.sort(PushRegistry.session_keys(pid)) == Enum.sort([a, b])

      :ok = PushRegistry.unsubscribe(a, pid)
      assert PushRegistry.session_keys(pid) == [b]

      # A sync is EXACT: what it adds is added, what it drops is dropped, and the
      # index follows (so the next sync does not need the scan).
      :ok = PushRegistry.sync_session(pid, "u1", [PushRegistry.channel_key("x"), c])
      keys = PushRegistry.session_keys(pid)

      assert c in keys
      assert PushRegistry.user_key("u1") in keys
      assert b not in keys
      assert length(keys) == 3
    end

    test "drop_session releases exactly that pid's rows and its index entry" do
      keeper = idle_pid()
      goner = idle_pid()
      shared = route(6)

      :ok = PushRegistry.subscribe(shared, "u1", keeper)
      :ok = PushRegistry.subscribe(shared, "u2", goner)
      :ok = PushRegistry.subscribe(route(7), "u2", goner)

      before = PushRegistry.size()
      indexed_before = PushRegistry.indexed_sessions()

      :ok = PushRegistry.drop_session(goner)

      # Two rows went (one per route the goner held) and one index entry; the
      # keeper's rows are untouched.
      assert PushRegistry.size() == before - 2
      assert PushRegistry.indexed_sessions() == indexed_before - 1
      assert PushRegistry.session_keys(goner) == []
      assert PushRegistry.session_keys(keeper) == [shared]
      assert Enum.map(PushRegistry.subscribers(shared), &elem(&1, 0)) == [keeper]
    end
  end

  describe "the dead-row reaper" do
    test "a socket that died without dropping its session is reclaimed by the next read" do
      dead = idle_pid()
      live = idle_pid()
      key = route(8)

      :ok = PushRegistry.subscribe(key, "dead-user", dead)
      :ok = PushRegistry.subscribe(key, "live-user", live)

      # Kill it WITHOUT unsubscribing: this is the leak — a kill, a supervisor
      # timeout, a socket that never ran its terminate. Its rows stayed in the
      # registry forever, so every later fan-out walked them again.
      ref = Process.monitor(dead)
      Process.exit(dead, :kill)
      assert_receive {:DOWN, ^ref, :process, _, :killed}, 1_000

      before = PushRegistry.size()
      indexed_before = PushRegistry.indexed_sessions()

      # The read filters it out AND reclaims its ROUTE rows. Both counts are
      # RELATIVE: the registry is global, so other cases in this file hold live
      # sessions too.
      assert Enum.map(PushRegistry.subscribers(key), &elem(&1, 1)) == ["live-user"]
      assert PushRegistry.size() == before - 1, "the dead row was not reclaimed"

      # The reverse-index entry is deliberately PARKED, not deleted (hardening
      # plan 4.2): the offline hold needs the dead pid's routes, and the shard
      # sweep reads them within a second and then retires the entry itself. This
      # is what makes an untrappably-dead session's buffer work at all.
      assert PushRegistry.indexed_sessions() == indexed_before, "the dead entry must stay parked"
      assert PushRegistry.session_keys(dead) == [key]

      # The sweep's half: once the routes are held, `drop_session/1` retires it.
      assert :ok = PushRegistry.drop_session(dead)
      assert PushRegistry.indexed_sessions() == indexed_before - 1, "the parked entry was not retired"
      assert PushRegistry.session_keys(dead) == []

      # …and it stays gone: a second read has nothing to filter.
      assert Enum.map(PushRegistry.subscribers(key), &elem(&1, 1)) == ["live-user"]
    end

    test "reaping leaves other sessions on the same route alone" do
      key = route(9)
      pids = for _ <- 1..5, do: idle_pid()
      Enum.each(pids, fn pid -> :ok = PushRegistry.subscribe(key, "u", pid) end)

      [victim | survivors] = pids
      ref = Process.monitor(victim)
      Process.exit(victim, :kill)
      assert_receive {:DOWN, ^ref, :process, _, :killed}, 1_000

      alive = PushRegistry.subscribers(key) |> Enum.map(&elem(&1, 0)) |> Enum.sort()
      assert alive == Enum.sort(survivors)

      # The victim's routes are parked for the sweep (see the test above), and
      # the survivors' registrations are untouched by the reclaim.
      assert PushRegistry.session_keys(victim) == [key]
      for survivor <- survivors, do: assert(PushRegistry.session_keys(survivor) == [key])

      :ok = PushRegistry.drop_session(victim)
      assert PushRegistry.session_keys(victim) == []
    end
  end

  describe "degradation" do
    test "a missing index owner is a miss, never an error or a wrong answer" do
      # The index table is owned by the registry process, so this test cannot
      # remove it without stopping the whole registry. What it CAN pin is the
      # fallback's existence and shape: a pid with no index entry still answers
      # from the route table.
      orphan = idle_pid()
      key = route(10)

      # Write a row WITHOUT the index (the pre-index shape the fallback exists for).
      :ets.insert(PushRegistry, {key, orphan, "legacy"})

      assert PushRegistry.session_keys(orphan) == [key]
      assert PushRegistry.unsubscribe(key, orphan) == :ok
      assert :ets.lookup(PushRegistry, key) == []
    end
  end
end
