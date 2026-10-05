defmodule Cytale.StrictClockTest do
  @moduledoc """
  The `USING TIMESTAMP` operation stamp (components plan KTD4): the LWW margin
  (`tombstone ts`, `inserts ts + 1`) only holds while two operations cannot share
  a stamp, which is what this clock guarantees and `System.system_time/1` does
  not. The consequence of a collision is exercised in
  `Cytale.Messages.MessageTest`'s "same operation stamp … MERGES both lists".
  """

  use ExUnit.Case, async: true

  alias Cytale.StrictClock

  test "successive calls are strictly increasing" do
    values = for _ <- 1..20_000, do: StrictClock.now_us()

    assert values == Enum.sort(values), "the clock went backwards"
    assert length(Enum.uniq(values)) == length(values), "the clock repeated a value"
  end

  test "a burst advances by at most one unit per call, and never behind the wall clock" do
    calls = 5_000
    before = StrictClock.now_us()
    before_wall = System.system_time(:microsecond)

    for _ <- 1..calls, do: StrictClock.now_us()

    after_value = StrictClock.now_us()
    after_wall = System.system_time(:microsecond)

    # A bump clock may run AHEAD of the wall clock — one microsecond per call while
    # the wall clock stands still. That is deliberately inert here: the stamps are
    # ordering tokens, nothing ever reads a write time back (`writetime()` appears
    # nowhere in the codebase), and callers take ONE stamp per operation rather
    # than one per row. What must hold is that the lead is bounded by the calls
    # made plus real elapsed time.
    elapsed = after_wall - before_wall

    assert after_value - before <= calls + 1 + elapsed,
           "the clock ran #{after_value - before - elapsed}µs ahead of its calls"

    # …and never BEHIND it, which is the floor half of `max(wall, last + 1)`.
    assert after_value >= after_wall
  end

  test "concurrent callers each get a distinct, increasing value" do
    parent = self()

    tasks =
      for _ <- 1..16 do
        Task.async(fn ->
          send(parent, {:ready, self()})

          receive do
            :go -> :ok
          end

          for _ <- 1..250, do: StrictClock.now_us()
        end)
      end

    for _ <- 1..16 do
      receive do
        {:ready, pid} -> send(pid, :go)
      after
        5_000 -> flunk("a caller never reached the barrier")
      end
    end

    values = tasks |> Task.await_many(30_000) |> List.flatten()

    assert length(values) == 16 * 250
    assert length(Enum.uniq(values)) == length(values), "two concurrent callers shared a stamp"
  end

  test "ensure_init/0 is idempotent and does not reset the sequence" do
    first = StrictClock.now_us()
    assert :ok = StrictClock.ensure_init()
    assert StrictClock.now_us() > first
  end
end
