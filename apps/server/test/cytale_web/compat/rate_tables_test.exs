defmodule CytaleWeb.Compat.RateTablesTest do
  @moduledoc """
  B2 — the rate-table sweeper: expired fixed-window rows (`window_end < now`)
  are deleted across EVERY table the owner holds (compat route buckets,
  webhook pair/miss buckets, the pre-auth IP dam), keeping the tables
  bounded against one-shot flood keys. Correctness never depends on the
  sweep (`RateLimit.consume/5` rolls closed windows itself) — this is the
  growth bound.
  """

  use ExUnit.Case, async: true

  alias CytaleWeb.Compat.RateTables

  # The idempotency cache's name, spelled literally rather than through an
  # accessor: this test has to COMPILE against the pre-fix code to observe the
  # red failure, and the accessor does not exist there yet.
  @idempotency_table :cytale_idempotency_cache

  defp tables do
    [RateTables.compat_table(), RateTables.webhook_table(), RateTables.preauth_table()]
  end

  defp ensure_tables! do
    # The owner GenServer normally creates these under the app tree; the
    # guard mirrors the pipeline_test pattern for hermetic runs.
    for table <- tables() do
      if :ets.whereis(table) == :undefined do
        :ets.new(table, [:set, :named_table, :public, read_concurrency: true])
      end
    end
  end

  # Hardening plan 1.4. The plug used to create this table lazily, from
  # whichever Bandit connection process first saw an Idempotency-Key, so the
  # table died with that connection — exactly the failure this module's own
  # @moduledoc records for the rate tables ("the table died when that process
  # was recycled"), the reason #90 migrated the native table here, and the one
  # table left behind.
  test "the idempotency cache is created and owned by the long-lived owner" do
    owner = Process.whereis(RateTables)
    assert is_pid(owner), "RateTables must be running under the app tree"

    # Existence is the first half: before the fix the table appeared only once
    # a keyed POST arrived, so it is absent on a freshly booted node.
    assert :ets.whereis(@idempotency_table) != :undefined,
           "the idempotency cache must exist before any request touches it"

    # Ownership is the half that matters: a table created by a request process
    # is a table that dies with it, silently turning every retry into a
    # duplicate write.
    assert :ets.info(@idempotency_table, :owner) == owner,
           "the idempotency cache must be owned by RateTables, not a request process"
  end

  # The owner's sweeper must understand this table's row shape too. The rate
  # tables carry `{key, count, window_end}`; the idempotency cache carries
  # `{key, body_hash, status, body, exp}`. A sweeper that only matched the
  # first shape would leave every expired idempotency row in place forever.
  test "sweep/0 removes expired idempotency rows by their own expiry shape" do
    ensure_idempotency_table!()

    now = System.system_time(:millisecond)
    nonce = System.unique_integer([:positive, :monotonic])
    expired = {:idem_sweep_expired, nonce}
    live = {:idem_sweep_live, nonce}

    :ets.insert(@idempotency_table, {expired, 12_345, 201, ~s({"ok":true}), now - 1})
    :ets.insert(@idempotency_table, {live, 12_345, 201, ~s({"ok":true}), now + 60_000})

    assert RateTables.sweep() >= 1

    assert :ets.lookup(@idempotency_table, expired) == []
    assert [{^live, 12_345, 201, _body, _exp}] = :ets.lookup(@idempotency_table, live)

    :ets.delete(@idempotency_table, live)
  end

  # Hermetic runs (no app tree) still need the table present; the owner creates
  # it in a real boot, and this mirrors `ensure_tables!/0`'s posture.
  defp ensure_idempotency_table! do
    if :ets.whereis(@idempotency_table) == :undefined do
      :ets.new(@idempotency_table, [:set, :named_table, :public, read_concurrency: true])
    end
  end

  test "sweep/0 removes expired rows and keeps live windows in every owned table" do
    ensure_tables!()

    now = System.system_time(:millisecond)
    nonce = System.unique_integer([:positive, :monotonic])
    expired = {:sweep_test_expired, nonce}
    live = {:sweep_test_live, nonce}

    for table <- tables() do
      :ets.insert(table, {expired, 7, now - 1})
      :ets.insert(table, {live, 3, now + 60_000})
    end

    removed = RateTables.sweep()

    # At least our three expired rows (concurrent suites may contribute more).
    assert removed >= 3

    for table <- tables() do
      assert :ets.lookup(table, expired) == []
      assert [{^live, 3, _}] = :ets.lookup(table, live)
      :ets.delete(table, live)
    end
  end
end
