defmodule Cytale.Snowflake.ClockTest do
  @moduledoc """
  Review #24: the Snowflake high-water lease. A restart whose clock stepped
  back must not re-issue an id the previous run already minted — a repeated
  `messages` primary key is an upsert that silently overwrites a message.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Snowflake
  alias Cytale.Snowflake.Clock

  # A worker id no node in the suite runs as, so the rows are this test's own.
  defp worker, do: 900 + rem(System.unique_integer([:positive]), 100)

  test "persist writes a mark AHEAD of every id already issued" do
    w = worker()
    last = Snowflake.next()

    mark = Clock.persist(w)

    assert Clock.persisted_high_water(w) == mark
    assert mark > Snowflake.timestamp_ms(last)
    assert mark > System.system_time(:millisecond)
  end

  test "restore raises the generator's floor to the previous run's mark" do
    w = worker()
    # The previous run's mark, slightly AHEAD of this run's clock (the
    # stepped-back restart). Tiny, because the cell is node-global and never
    # lowers; the test waits it out before returning.
    mark = System.system_time(:millisecond) + 25

    Cytale.Repo.execute!(
      "UPDATE #{Cytale.Repo.keyspace()}.snowflake_clock SET high_water_ms = ? WHERE worker_id = ?",
      [{"bigint", mark}, {"int", w}]
    )

    assert {:ok, ^mark} = Clock.restore(w)
    assert Snowflake.timestamp_ms(Snowflake.next()) > mark

    Process.sleep(max(0, Snowflake.high_water_ms() - System.system_time(:millisecond)) + 2)
  end

  test "no mark yet (a first boot) restores nothing and changes nothing" do
    assert {:ok, nil} = Clock.restore(worker())
  end
end
