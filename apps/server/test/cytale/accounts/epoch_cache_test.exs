defmodule Cytale.Accounts.EpochCacheTest do
  @moduledoc """
  Review #19: the credential-epoch memo behind the per-request auth check. A
  revocation (an epoch bump) must be seen by the very next check — the memo
  is written through, and a fill that raced a bump can never overwrite it.
  """

  use ExUnit.Case, async: true

  alias Cytale.Accounts.EpochCache

  defp user, do: 7_000_000_000 + System.unique_integer([:positive])

  test "a miss reads once and then serves the memo" do
    u = user()
    reads = :counters.new(1, [])
    read = fn -> :counters.add(reads, 1, 1) && {:ok, 3} end

    assert {:ok, 3} = EpochCache.fetch(u, read)
    assert {:ok, 3} = EpochCache.fetch(u, read)
    assert :counters.get(reads, 1) == 1
  end

  test "a bump's write-through is seen by the next check without a read" do
    u = user()
    assert {:ok, 0} = EpochCache.fetch(u, fn -> {:ok, 0} end)

    :ok = EpochCache.put(u, 1)
    assert {:ok, 1} = EpochCache.fetch(u, fn -> flunk("the memo must answer") end)
  end

  test "a fill that read the OLD epoch before a bump cannot overwrite the bump" do
    u = user()

    # The read returns the pre-bump value, but the bump lands while it runs.
    stale_read = fn ->
      :ok = EpochCache.put(u, 5)
      {:ok, 4}
    end

    assert {:ok, 5} = EpochCache.fetch(u, stale_read)
    assert {:ok, 5} = EpochCache.fetch(u, fn -> flunk("the memo must answer") end)
  end

  test "a failed read is not memoized" do
    u = user()
    assert :error = EpochCache.fetch(u, fn -> :error end)
    assert {:ok, 2} = EpochCache.fetch(u, fn -> {:ok, 2} end)
  end
end
