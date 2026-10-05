defmodule Cytale.Telemetry.StatsTest do
  @moduledoc """
  Hardening plan 7.13 — the sample ring is bounded by TIME, not by
  `:duplicate_bag` iteration order.

  The old trim walked `:ets.lookup/2` with `Enum.take_while(&old?/1)`: it trusted
  old samples to be contiguous and first. `:duplicate_bag` returns rows in
  insertion order (and the order is unspecified), so one fresh sample landing
  between two stale ones stopped the walk and left the trailing stale rows in
  the table forever — an unbounded ring. `:ets.select_delete/2` removes every
  row below the cutoff in one pass, whatever the order.
  """

  use ExUnit.Case, async: false

  alias Cytale.Telemetry.Stats

  setup do
    Stats.reset()
    on_exit(&Stats.reset/0)
    :ok
  end

  test "trim drops every sample below the cutoff even when fresh rows interleave" do
    key = :fanout_dispatch_ms
    now = System.monotonic_time(:millisecond)
    stale = now - 120_000

    # stale, fresh, stale — insertion order is `:duplicate_bag`'s lookup order
    # on this runtime, which is exactly the shape `take_while` mishandles.
    :ets.insert(Stats.Samples, {key, stale, 1, nil})
    :ets.insert(Stats.Samples, {key, now, 2, nil})
    :ets.insert(Stats.Samples, {key, stale, 3, nil})

    send(Stats, :trim)
    # The system message is handled after the `:trim` info, so once it replies
    # the trim has completed.
    _ = :sys.get_state(Stats)

    leftover =
      :ets.select(Stats.Samples, [
        {{key, :"$1", :_, :_}, [{:<, :"$1", now - 60_000}], [:"$_"]}
      ])

    assert leftover == [], "trim left stale samples in the ring: #{inspect(leftover)}"

    assert Enum.any?(:ets.lookup(Stats.Samples, key), &match?({_, ^now, 2, _}, &1)),
           "trim dropped the in-window sample too"
  end

  test "repeated trim bounds the ring regardless of insertion order" do
    key = :scylla_insert_ms
    now = System.monotonic_time(:millisecond)
    stale = now - 120_000

    # Each round puts many stale rows ahead of a fresh row. Under the old walk
    # every round after the first stranded its whole stale tail. Timestamps are
    # unique across rounds: `:ets.delete_object/2` on a duplicate_bag removes
    # every copy of an identical tuple, so repeated values would mask the bug.
    for round <- 1..20 do
      for i <- 1..50, do: :ets.insert(Stats.Samples, {key, stale - round * 1_000 - i, i, nil})
      :ets.insert(Stats.Samples, {key, now, -1, nil})
    end

    send(Stats, :trim)
    _ = :sys.get_state(Stats)

    below =
      :ets.select_count(Stats.Samples, [
        {{key, :"$1", :_, :_}, [{:<, :"$1", now - 60_000}], [true]}
      ])

    assert below == 0, "trim left #{below} samples below the cutoff"
  end
end
