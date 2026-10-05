defmodule Cytale.Permissions.CacheTest do
  @moduledoc """
  U7 — versioned permission cache.

  Covers the plan's cache scenarios:
    * miss computes and caches with the CURRENT role_version
    * hit returns the cached value without recomputing
    * role_version bump → stale entry orphaned (lazy invalidation), next
      check recomputes — no re-login (AE4)
    * different (user, channel) keys are independent
    * computes are counted to distinguish hit from miss paths
  """

  use ExUnit.Case, async: true

  alias Cytale.Permissions.Cache

  setup do
    cache = Cache.new(:perm_cache_test)
    on_exit(fn -> Cache.teardown(cache) end)
    %{cache: cache}
  end

  test "miss computes, caches under the given role_version, and counts the compute", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b1010
    end

    assert Cache.get_or_compute(cache, :user1, :chan1, 1, compute) == 0b1010
    assert :counters.get(calls, 1) == 1
  end

  test "hit returns the cached value WITHOUT recomputing", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b1010
    end

    assert Cache.get_or_compute(cache, :user1, :chan1, 1, compute) == 0b1010
    assert Cache.get_or_compute(cache, :user1, :chan1, 1, compute) == 0b1010
    assert Cache.get_or_compute(cache, :user1, :chan1, 1, compute) == 0b1010
    assert :counters.get(calls, 1) == 1, "hit path must not recompute"
  end

  test "role_version bump lazily invalidates: next check recomputes (AE4, no re-login)", %{cache: cache} do
    calls = :counters.new(1, [:atomics])
    counter = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      # perms change after the bump — the recompute must observe it
      if :counters.get(counter, 1) == 0, do: 0b0001, else: 0b0011
    end

    assert Cache.get_or_compute(cache, :user1, :chan1, 3, compute) == 0b0001
    assert Cache.get_or_compute(cache, :user1, :chan1, 3, compute) == 0b0001

    # THE BUMP (e.g. a role's permissions changed): same key, version 4.
    :counters.add(counter, 1, 1)
    assert Cache.get_or_compute(cache, :user1, :chan1, 4, compute) == 0b0011
    # and the new entry serves hits at v4
    assert Cache.get_or_compute(cache, :user1, :chan1, 4, compute) == 0b0011
    assert :counters.get(calls, 1) == 2
  end

  test "downgrade (older role_version) is also a miss — version equality is the rule", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b1
    end

    Cache.get_or_compute(cache, :user1, :chan1, 5, compute)
    Cache.get_or_compute(cache, :user1, :chan1, 4, compute)
    assert :counters.get(calls, 1) == 2
  end

  test "keys are independent per (user_id, channel_id)", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b1111
    end

    Cache.get_or_compute(cache, :user1, :chan1, 1, compute)
    Cache.get_or_compute(cache, :user1, :chan2, 1, compute)
    Cache.get_or_compute(cache, :user2, :chan1, 1, compute)
    assert :counters.get(calls, 1) == 3

    # each key now serves hits
    Cache.get_or_compute(cache, :user1, :chan1, 1, compute)
    Cache.get_or_compute(cache, :user1, :chan2, 1, compute)
    Cache.get_or_compute(cache, :user2, :chan1, 1, compute)
    assert :counters.get(calls, 1) == 3
  end

  test "bump does not fan out: other keys' entries at the old version are simply orphaned", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b10
    end

    Cache.get_or_compute(cache, :user1, :chan1, 1, compute)
    Cache.get_or_compute(cache, :user2, :chan1, 1, compute)
    assert :counters.get(calls, 1) == 2

    # bump recomputes user1 only; user2's stale entry is NOT rewritten —
    # no O(users × channels) write fan-out (plan requirement). user1's key
    # is replaced in place; user2's orphan remains until swept.
    Cache.get_or_compute(cache, :user1, :chan1, 2, compute)
    assert :counters.get(calls, 1) == 3
    assert Cache.size(cache) == 2, "same key replaced in place; the other key's orphan remains"
  end

  test "sweep/1 drops entries below the given version floor", %{cache: cache} do
    calls = :counters.new(1, [:atomics])

    compute = fn ->
      :counters.add(calls, 1, 1)
      0b10
    end

    Cache.get_or_compute(cache, :user1, :chan1, 1, compute)
    Cache.get_or_compute(cache, :user2, :chan1, 2, compute)
    assert Cache.size(cache) == 2

    Cache.sweep(cache, 2)
    assert Cache.size(cache) == 1, "only the v2 entry survives the sweep"
    # and it still serves a hit
    Cache.get_or_compute(cache, :user2, :chan1, 2, compute)
    assert :counters.get(calls, 1) == 2
  end
end
