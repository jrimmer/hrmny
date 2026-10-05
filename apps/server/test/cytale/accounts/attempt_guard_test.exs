defmodule Cytale.Accounts.AttemptGuardTest do
  use ExUnit.Case, async: false

  # Reaches the database directly (no ScyllaCase) — excluded from a no-DB run.
  @moduletag :scylla

  @moduledoc """
  S3 — the dam's own contract: count, lock, clear, sweep.

  Rows are seeded DIRECTLY into the (public, named) table — the
  pipeline_test / rate_limit_plug_test pattern — so the lock's exact edge is
  observed without looping ten real failures through argon2. The wire-level
  lockout (what a client actually receives) is pinned in
  auth_controller_test.
  """

  alias Cytale.Accounts.AttemptGuard

  @window 15 * 60 * 1000
  @lock 15 * 60 * 1000

  setup do
    # A leaked row from another module's test must not shift the threshold.
    # `:ets.delete_all_objects/1` returns `true` (it is not an `:ok | {:error, _}`
    # function), so the old `:ok =` match raised in SETUP and failed all eight
    # tests in this file — on the base tip too (measured in a worktree at
    # `9afe390`: `Result: 0/8 passed`, same MatchError at this line).
    true = :ets.delete_all_objects(AttemptGuard)
    on_exit(fn -> :ets.delete_all_objects(AttemptGuard) end)
    :ok
  end

  describe "keys" do
    test "identifier keys normalize exactly like User.get_by_identifier (trim + downcase)" do
      assert AttemptGuard.identifier_key("  Alice@Example.COM \n") ==
               {:identifier, "alice@example.com"}

      assert AttemptGuard.password_reset_key(" Bob@Example.com ") ==
               {:password_reset, "bob@example.com"}

      assert AttemptGuard.totp_key(123) == {:totp, 123}
    end
  end

  describe "login keys: per-network hard lock + global dam (security Tier 2 #2)" do
    @attacker {203, 0, 113, 9}
    @owner {198, 51, 100, 4}

    test "an attacker network's failures lock only that network, never the owner's" do
      attacker = AttemptGuard.login_keys("Owner@Example.com", @attacker)
      owner = AttemptGuard.login_keys(" owner@example.com", @owner)

      for _ <- 1..Cytale.Config.attempt_guard_max_failures(), do: :ok = AttemptGuard.fail_login(attacker)

      assert {:error, :locked, _} = AttemptGuard.check_login(attacker)
      assert AttemptGuard.check_login(owner) == :ok
    end

    test "the global dam trips at its own (far higher) threshold, and a known network passes it" do
      global_max = Cytale.Config.attempt_guard_identifier_max_failures()
      assert global_max > Cytale.Config.attempt_guard_max_failures()

      owner = AttemptGuard.login_keys("victim", @owner)
      :ok = AttemptGuard.succeed_login(owner)

      # A distributed guesser: many networks, each below its own lock.
      for n <- 1..global_max do
        :ok = AttemptGuard.fail_login(AttemptGuard.login_keys("victim", {10, 0, div(n, 256), rem(n, 256)}))
      end

      stranger = AttemptGuard.login_keys("victim", {192, 0, 2, 200})
      assert {:error, :locked, _} = AttemptGuard.check_login(stranger)

      # The owner's known network is not locked out by strangers.
      assert AttemptGuard.check_login(owner) == :ok
    end

    test "success clears the network's count and leaves the global count" do
      keys = AttemptGuard.login_keys("clear-me", @owner)
      for _ <- 1..3, do: :ok = AttemptGuard.fail_login(keys)
      :ok = AttemptGuard.succeed_login(keys)

      assert :ets.lookup(AttemptGuard, keys.ip) == []
      assert [{_, _, 3, 0}] = :ets.lookup(AttemptGuard, keys.global)
      assert [{_, expires_at, 0, 0}] = :ets.lookup(AttemptGuard, keys.known)
      assert expires_at > System.system_time(:millisecond)
    end
  end

  describe "count → lock" do
    test "an unlocked key checks :ok, and failures below the threshold keep it so" do
      key = AttemptGuard.identifier_key("dam-1@example.com")

      assert AttemptGuard.check(key) == :ok

      for _ <- 1..(Cytale.Config.attempt_guard_max_failures() - 1) do
        :ok = AttemptGuard.fail(key)
      end

      assert AttemptGuard.check(key) == :ok
    end

    test "the threshold failure trips the lock, with retry time out of the lock budget" do
      key = AttemptGuard.identifier_key("dam-2@example.com")
      max = Cytale.Config.attempt_guard_max_failures()

      for _ <- 1..(max - 1) do
        :ok = AttemptGuard.fail(key)
      end

      assert AttemptGuard.check(key) == :ok

      :ok = AttemptGuard.fail(key)

      assert {:error, :locked, retry_ms} = AttemptGuard.check(key)
      assert retry_ms > 0 and retry_ms <= Cytale.Config.attempt_guard_lock_ms()
    end

    test "a window whose end has passed restarts counting from one" do
      key = AttemptGuard.identifier_key("dam-3@example.com")

      # A window that rolled a moment ago, already at the threshold: the next
      # failure starts a FRESH window (count 1), not a lock.
      now = System.system_time(:millisecond)
      true = :ets.insert(AttemptGuard, {key, now - 1, Cytale.Config.attempt_guard_max_failures(), 0})

      :ok = AttemptGuard.fail(key)

      assert [{^key, window_end, 1, 0}] = :ets.lookup(AttemptGuard, key)
      assert window_end > now
      assert AttemptGuard.check(key) == :ok
    end

    test "failures during a lock do not extend it" do
      key = AttemptGuard.identifier_key("dam-4@example.com")
      now = System.system_time(:millisecond)
      locked_until = now + @lock
      true = :ets.insert(AttemptGuard, {key, now + @window, 10, locked_until})

      :ok = AttemptGuard.fail(key)

      assert [{^key, _window, _count, ^locked_until}] = :ets.lookup(AttemptGuard, key)
    end
  end

  describe "clear" do
    test "a success leaves no weight behind" do
      key = AttemptGuard.identifier_key("dam-5@example.com")

      for _ <- 1..(Cytale.Config.attempt_guard_max_failures() - 1) do
        :ok = AttemptGuard.fail(key)
      end

      assert AttemptGuard.check(key) == :ok
      :ok = AttemptGuard.clear(key)
      assert AttemptGuard.check(key) == :ok
      assert :ets.lookup(AttemptGuard, key) == []
    end

    test "clearing a locked key releases it immediately" do
      key = AttemptGuard.totp_key(4242)
      now = System.system_time(:millisecond)
      true = :ets.insert(AttemptGuard, {key, now + @window, 10, now + @lock})

      assert {:error, :locked, _} = AttemptGuard.check(key)

      :ok = AttemptGuard.clear(key)
      assert AttemptGuard.check(key) == :ok
    end
  end

  describe "the sweep" do
    test "drops fully-expired rows and keeps live ones" do
      now = System.system_time(:millisecond)
      dead = AttemptGuard.identifier_key("sweep-dead@example.com")
      alive = AttemptGuard.identifier_key("sweep-alive@example.com")
      locked = AttemptGuard.totp_key(777)

      # Window AND lock both past: garbage.
      true = :ets.insert(AttemptGuard, {dead, now - 1, 3, now - 1})
      # Window alive: still the dam's memory.
      true = :ets.insert(AttemptGuard, {alive, now + @window, 3, 0})
      # Window past but LOCKED: the lock is exactly why the row exists.
      true = :ets.insert(AttemptGuard, {locked, now - 1, 10, now + @lock})

      send(AttemptGuard, :sweep)
      wait_until(fn -> :ets.lookup(AttemptGuard, dead) == [] end)

      assert :ets.lookup(AttemptGuard, alive) != []
      assert :ets.lookup(AttemptGuard, locked) != []
      assert {:error, :locked, _} = AttemptGuard.check(locked)
    end
  end

  defp wait_until(fun, tries \\ 100)
  defp wait_until(_fun, 0), do: flunk("the sweep never observed the expired row")

  defp wait_until(fun, tries) do
    if fun.() do
      :ok
    else
      Process.sleep(10)
      wait_until(fun, tries - 1)
    end
  end
end
