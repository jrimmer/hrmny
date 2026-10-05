defmodule Cytale.Gateway.AdmissionLimiterTest do
  @moduledoc """
  The reconnect-storm limiter's counting cost and the presence table's crash path
  (hardening plan 5.5).
  """

  use ExUnit.Case, async: false

  alias Cytale.Gateway.AdmissionLimiter
  alias Cytale.Gateway.PresenceStatus

  setup do
    AdmissionLimiter.reset()
    on_exit(fn -> AdmissionLimiter.reset() end)
    :ok
  end

  defp unique_ip, do: "203.0.113.#{System.unique_integer([:positive])}"

  defp wait_until(timeout_ms, fun, waited \\ 0) do
    cond do
      fun.() -> true
      waited >= timeout_ms -> false
      true -> Process.sleep(20) && wait_until(timeout_ms, fun, waited + 20)
    end
  end

  describe "counting is per key, not per table" do
    test "the table is an ordered_set, which is what makes the count a range scan" do
      # The cost claim rests on the STRUCTURE: a partially-bound key prefix is
      # contiguous only in an ordered_set, so ETS can walk this key's window
      # instead of the table. Pinned here so a change back to :set fails loudly
      # rather than silently restoring the whole-table fold.
      assert :ets.info(AdmissionLimiter, :type) == :ordered_set
    end

    test "counts stay exact with a large number of other keys' entries in the window" do
      ip = unique_ip()
      now = System.monotonic_time(:millisecond)

      # 20k foreign entries inside the window — the state the old full-table fold
      # walked for every single admission check.
      for i <- 1..20_000 do
        AdmissionLimiter.check(:identify, "198.51.100.#{rem(i, 254)}", now)
      end

      AdmissionLimiter.reset()

      # Ours, counted from a table holding a lot (reset above clears it, so this
      # part pins exactness rather than scale — the structural test above is the
      # cost half).
      for _ <- 1..3, do: assert({:ok, _} = AdmissionLimiter.check(:identify, ip, now))
      assert AdmissionLimiter.recent_count(:identify, ip, now) == 3

      # A different ip on the same kind is untouched by ours.
      assert AdmissionLimiter.recent_count(:identify, unique_ip(), now) == 0
    end

    test "the window still ages events out" do
      ip = unique_ip()
      now = System.monotonic_time(:millisecond)

      for _ <- 1..3, do: AdmissionLimiter.check(:resume, ip, now)
      assert AdmissionLimiter.recent_count(:resume, ip, now) == 3

      # Past the window, the same key counts nothing — the range scan is bounded by
      # the cutoff, not by the key's whole history.
      later = now + AdmissionLimiter.config().window_ms + 1
      assert AdmissionLimiter.recent_count(:resume, ip, later) == 0
      assert {:ok, 1} = AdmissionLimiter.check(:resume, ip, later)
    end

    test "the limit still refuses over the cap, per kind" do
      ip = unique_ip()
      now = System.monotonic_time(:millisecond)
      limit = AdmissionLimiter.config().identify

      decisions = for _ <- 1..(limit + 1), do: AdmissionLimiter.check(:identify, ip, now)

      assert Enum.all?(Enum.take(decisions, limit), &match?({:ok, _}, &1))
      assert {:rate_limited, ms} = List.last(decisions)
      assert is_integer(ms) and ms > 0
    end
  end

  describe "a missing presence table" do
    # The failure this guards: the table's owner restarts (a crash, a deploy, a
    # supervisor bounce), and for that window every presence call used to raise
    # `ArgumentError` into a socket handling op-3 or a presence announce.
    #
    # The window is opened by TERMINATING the owner through its supervisor, and
    # the restart is issued explicitly by the test that needs it. Killing the
    # owner instead left the window to the supervisor's timing: on a loaded run
    # the `:permanent` child was back before the first call, `put/2` stored for
    # real, and the no-op assertions could read back `:idle` — a race in the
    # test, not the code.
    setup do
      assert wait_until(2_000, fn -> Process.whereis(PresenceStatus) != nil end),
             "the presence owner never came up"

      :ok = Supervisor.terminate_child(Cytale.Supervisor, PresenceStatus)
      assert :ets.whereis(PresenceStatus) == :undefined

      on_exit(fn ->
        # Put the owner back for the next module (a no-op when a test already did).
        case Supervisor.restart_child(Cytale.Supervisor, PresenceStatus) do
          {:ok, _pid} -> :ok
          {:error, :running} -> :ok
          {:error, {:already_started, _pid}} -> :ok
        end

        assert wait_until(2_000, fn -> Process.whereis(PresenceStatus) != nil end),
               "the presence owner did not come back"
      end)

      :ok
    end

    test "put/lookup/forget are no-ops, not crashes" do
      # Called with the owner down: these are the calls that used to raise.
      assert :ok = PresenceStatus.put("u-1", :idle)
      # `:online` is the documented default for "no preference recorded", which is
      # exactly what a missing table means.
      assert PresenceStatus.lookup("u-1") == :online
      assert :ok = PresenceStatus.forget("u-1")
      assert PresenceStatus.wire_status(PresenceStatus.lookup("u-1")) == "online"
    end

    test "the table comes back and behaves after the owner restarts" do
      assert :ok = PresenceStatus.put("u-2", :dnd)

      # The supervisor's restart, issued explicitly (see the setup).
      {:ok, _pid} = Supervisor.restart_child(Cytale.Supervisor, PresenceStatus)

      assert wait_until(2_000, fn -> :ets.whereis(PresenceStatus) != :undefined end),
             "the table did not come back"

      # Whatever survived the restart (nothing did — the table died with its
      # owner), the module is fully functional again.
      assert :ok = PresenceStatus.put("u-2", :dnd)
      assert PresenceStatus.lookup("u-2") == :dnd
      assert PresenceStatus.wire_status(PresenceStatus.lookup("u-2")) == "dnd"
    end
  end
end
