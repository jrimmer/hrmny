defmodule Cytale.StrictClock do
  @moduledoc """
  A STRICTLY increasing microsecond clock, for `USING TIMESTAMP` operation
  stamps.

  `System.system_time(:microsecond)` is not enough for a last-write-wins
  construction that stamps a whole operation at one instant. It can return the
  SAME microsecond to two concurrent operations, and the construction's margin
  (tombstone at `ts`, inserts at `ts + 1`) then makes each operation's inserts
  newer than the other's tombstone — so BOTH survive and the two lists MERGE
  instead of one winning. That is not a theoretical hazard: it is what
  `CytaleWeb.Controllers.InteractionControllerTest`'s "two concurrent type-7s …
  final state is EXACTLY one list (LWW, no mix)" failed with under full-suite
  load (`messages.ex`'s `replace_side_rows/4`).

  This clock never repeats a value within the instance: it returns the wall
  clock unless the wall clock has not advanced past the last value handed out, in
  which case it returns `last + 1`. Lock-free, one `compare_exchange` per call,
  and only on paths that already pay a Scylla write.

  Monotonic, not unique-across-restarts: after a restart the wall clock is past
  the previous run's values (which is all the LWW ordering needs — every stamp
  comes from this one source). Single-node launch scale, like the rest of the
  side-row LWW construction; a multi-node deployment would need the stamp to
  come from a shared sequencer, which is the same caveat the Snowflake worker-id
  rule carries.

  A burst of calls can leave the value AHEAD of the wall clock by one microsecond
  per call, because the bump engages whenever the wall clock has not moved. That is
  deliberately inert: `USING TIMESTAMP` values are ordering tokens, nothing in the
  codebase reads a write time back (`writetime()` appears nowhere), and callers
  take ONE stamp per operation rather than one per row — so the lead is bounded by
  the number of operations, not by their size.
  """

  @cell_key :cytale_strict_clock_cell

  @doc """
  Ensure the atomics cell exists. Idempotent; called from the application boot
  path (beside `Cytale.Snowflake.ensure_init/0`) and safe to call ad hoc.
  """
  @spec ensure_init() :: :ok
  def ensure_init do
    case :persistent_term.get(@cell_key, :missing) do
      :missing -> :persistent_term.put(@cell_key, :atomics.new(1, signed: true))
      _ref -> :ok
    end

    :ok
  end

  @doc """
  The next strictly increasing microsecond value.
  """
  @spec now_us() :: integer()
  def now_us do
    ensure_init()
    ref = :persistent_term.get(@cell_key)
    bump(ref, System.system_time(:microsecond), :atomics.get(ref, 1))
  end

  # `:atomics.compare_exchange/4` returns `:ok` on success or the CURRENT value
  # when another process got there first — in which case our computed value is
  # stale and the retry (with the new floor) is what keeps the sequence strict.
  defp bump(ref, now, last) do
    ts = max(now, last + 1)

    case :atomics.compare_exchange(ref, 1, last, ts) do
      :ok -> ts
      current -> bump(ref, now, current)
    end
  end
end
