defmodule Cytale.SnowflakeTest do
  use ExUnit.Case, async: false

  alias Cytale.Snowflake

  # Single shared generation surface (atomics are node-global): keep tests
  # serial to make monotonicity assertions meaningful.
  setup do
    :ok = Snowflake.ensure_init()
    :ok
  end

  describe "generation" do
    test "ids are positive 64-bit integers (sign bit 0)" do
      for _ <- 1..1000 do
        id = Snowflake.next()
        assert is_integer(id)
        assert id > 0
        assert id < Bitwise.bsl(1, 63)
      end
    end

    test "monotonically increasing within a single worker" do
      ids = for _ <- 1..5000, do: Snowflake.next()
      assert ids == Enum.sort(ids)
      # Strictly increasing: no duplicates at all.
      assert length(Enum.uniq(ids)) == length(ids)
    end

    test "rapid generation (10_000 ids tight loop) produces no duplicates" do
      ids = for _ <- 1..10_000, do: Snowflake.next()
      assert length(Enum.uniq(ids)) == 10_000
    end

    test "sequence rollover within one millisecond still yields unique, ordered ids" do
      # Exhaust well beyond one millisecond's 4096 budget; the generator must
      # roll forward without duplicating or regressing.
      ids = for _ <- 1..9000, do: Snowflake.next()
      assert ids == Enum.sort(Enum.uniq(ids))
    end

    test "ids encode their generation timestamp" do
      before = System.system_time(:millisecond)
      id = Snowflake.next()
      after_ms = System.system_time(:millisecond)

      ts = Snowflake.timestamp_ms(id)
      assert ts in before..after_ms
    end

    test "a floor AHEAD of the wall clock mints from the floor — monotonic, unique, never blocking (review #24)" do
      # The restart case: the previous run's high-water mark is ahead of this
      # run's clock. Kept tiny (the cell is node-global and never lowers), and
      # the test waits the floor out before returning so no later test sees
      # ids ahead of the wall clock.
      floor = System.system_time(:millisecond) + 20
      :ok = Snowflake.raise_floor(floor)

      # 5 000 ids straddle a logical millisecond boundary (4 096 per ms).
      ids = for _ <- 1..5_000, do: Snowflake.next()

      assert ids == Enum.sort(Enum.uniq(ids))
      assert Enum.all?(ids, &(Snowflake.timestamp_ms(&1) > floor))

      # Raising to an OLDER mark is a no-op: the floor never goes back.
      :ok = Snowflake.raise_floor(floor - 1_000)
      assert Snowflake.timestamp_ms(Snowflake.next()) > floor

      Process.sleep(max(0, Snowflake.high_water_ms() - System.system_time(:millisecond)) + 2)
    end

    test "ids encode the configured worker id" do
      id = Snowflake.next()
      assert Snowflake.worker_id_of(id) == Snowflake.worker_id()
    end
  end

  describe "decode helpers" do
    test "timestamp_ms/worker_id_of/sequence_of round-trip the layout" do
      id = Snowflake.next()

      assert Snowflake.timestamp_ms(id) >= Snowflake.epoch_ms()
      assert Snowflake.worker_id_of(id) in 0..1023
      assert Snowflake.sequence_of(id) in 0..4095
    end

    test "compare/2 orders chronologically" do
      a = Snowflake.next()
      b = Snowflake.next()

      assert Snowflake.compare(a, b) == :lt
      assert Snowflake.compare(b, a) == :gt
      assert Snowflake.compare(a, a) == :eq
    end
  end

  describe "wire serialization (>53-bit JSON safety)" do
    test "to_string/1 yields decimal strings" do
      id = Snowflake.next()
      str = Snowflake.to_string(id)
      assert is_binary(str)
      assert String.match?(str, ~r/^[1-9][0-9]*$/)
      assert String.to_integer(str) == id
    end

    test "generated ids exceed JavaScript's 53-bit safe-integer range" do
      # The whole point of string serialization: once the timestamp field
      # passes 2^31 ms above the epoch (~24.9 days — long since true at any
      # plausible run date), ids pass 2^53 and MUST NOT travel as JSON numbers.
      id = Snowflake.next()

      assert Snowflake.timestamp_ms(id) - Snowflake.epoch_ms() > Bitwise.bsl(1, 31),
             "precondition drifted: ids would now be 53-bit-safe and the wire rule could relax"

      assert id > 9_007_199_254_740_992
    end

    test "parse/1 round-trips to_string/1 and rejects garbage" do
      id = Snowflake.next()
      assert {:ok, ^id} = id |> Snowflake.to_string() |> Snowflake.parse()
      assert {:ok, ^id} = Snowflake.parse(id)
      assert :error = Snowflake.parse("not-an-id")
      assert :error = Snowflake.parse("12abc")
      assert :error = Snowflake.parse("0")
      assert :error = Snowflake.parse("-5")
      assert :error = Snowflake.parse(nil)
    end
  end

  describe "bit budget" do
    test "timestamp field headroom reaches past year 2090 (41-bit budget)" do
      limit = Snowflake.timestamp_field_limit_ms()
      datetime = DateTime.from_unix!(limit, :millisecond)
      assert datetime.year > 2090
    end
  end

  describe "boot validation" do
    test "validate_worker_id!/0 accepts the default (0) and rejects out-of-range" do
      assert :ok = Snowflake.validate_worker_id!()

      original = Cytale.Config.snowflake_worker_id()

      Application.put_env(:cytale, Cytale.Config, Keyword.put(app_env(), :snowflake_worker_id, 1024))

      assert_raise ArgumentError, ~r/invalid SNOWFLAKE_WORKER_ID/, fn ->
        Snowflake.validate_worker_id!()
      end

      Application.put_env(:cytale, Cytale.Config, Keyword.put(app_env(), :snowflake_worker_id, original))
      assert :ok = Snowflake.validate_worker_id!()
    end

    defp app_env do
      Application.get_env(:cytale, Cytale.Config, [])
    end
  end
end
