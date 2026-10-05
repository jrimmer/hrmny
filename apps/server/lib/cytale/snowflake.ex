defmodule Cytale.Snowflake do
  @moduledoc """
  64-bit Snowflake ID generation (U5) — chronologically sortable,
  collision-free within a worker, no coordination bottleneck.

  Layout (Discord-shaped, 64 bits total):

      1 sign bit (always 0)
      41 bits  milliseconds since the Cytale epoch
      10 bits  worker id (0..1023, node-local from config)
      12 bits  per-millisecond sequence (4096 ids/ms/worker)

  The epoch is {@epoch_ms} (2026-01-01T00:00:00Z) — a fixed, documented
  offset chosen inside the product's lifetime.

  Generation is lock-free: timestamp AND sequence are packed into a single
  64-bit `:atomics` cell — `((ms - epoch) <<< 12) | seq` — and each id is
  minted with one `compare_exchange`. Packing both fields together is what
  makes the millisecond rollover atomic (a two-cell design can reuse
  sequence numbers when a reset races an increment). There is no GenServer
  on the hot path. If 4096 ids are consumed inside one millisecond the
  callers spin (with a yield) until the wall clock advances — ids never
  regress. A stepped-back system clock never moves the cell's timestamp
  backwards either: ids are minted from the cell's own time until the wall
  clock catches up (see `do_next/1`), and `Cytale.Snowflake.Clock` carries
  the cell's high-water mark across restarts (`raise_floor/1`).

  `message_id` Snowflakes are the ScyllaDB clustering key (DESC, U6) —
  chronological order for free, no separate `ORDER BY`.

  Worker-ID assignment (resolved before implementation, 2026-08-27):
  node-local, config-derived (`SNOWFLAKE_WORKER_ID` env var validated into
  0..1023 at boot beside the fail-fast secrets check); single-node launch
  uses 0. The no-two-running-nodes-share-an-ID rule lives in the ops runbook.

  On the wire and in JSON every id is a DECIMAL STRING (>53-bit JSON safety,
  U2 convention). This module generates integers; `to_string/1` / `parse/1`
  keep the boundary discipline explicit.
  """

  @epoch_ms 1_767_225_600_000
  # Discord-shaped field widths
  @worker_bits 10
  @sequence_bits 12
  @max_worker_id 1023
  @max_sequence 4095
  # 41 bits of ms above the epoch (~69 years of headroom)
  @timestamp_limit Bitwise.bsl(1, 41)

  @typedoc "A 64-bit Snowflake id (integer form; string form at the JSON boundary)."
  @type t :: pos_integer()

  @doc "Fixed Cytale epoch: 2026-01-01T00:00:00Z in milliseconds."
  @spec epoch_ms :: integer()
  def epoch_ms, do: @epoch_ms

  @doc "Validated worker id for this node (0..1023)."
  @spec worker_id :: 0..unquote(@max_worker_id)
  def worker_id, do: Cytale.Config.snowflake_worker_id()

  @cell_key :cytale_snowflake_cell

  @doc """
  Ensures the atomics cell exists (called from the application boot path;
  also safe to call ad hoc — idempotent).
  """
  @spec ensure_init() :: :ok
  def ensure_init do
    case :persistent_term.get(@cell_key, :missing) do
      :missing ->
        :persistent_term.put(@cell_key, :atomics.new(1, signed: false))

      _ref ->
        :ok
    end

    :ok
  end

  @doc """
  Generate the next id. Strictly monotonic per worker; under sequence
  exhaustion within one millisecond, callers spin until the next
  millisecond rather than emit a duplicate or a regressed id.
  """
  @spec next() :: t()
  def next do
    ensure_init()
    do_next(now_ms())
  end

  defp do_next(now) do
    ref = :persistent_term.get(@cell_key)
    cur = :atomics.get(ref, 1)
    # Cell layout: ((ms - epoch) <<< sequence_bits) | seq
    cur_rel = Bitwise.bsr(cur, @sequence_bits)
    cur_seq = Bitwise.band(cur, @max_sequence)
    now_rel = now - @epoch_ms

    cond do
      now_rel > cur_rel ->
        # New millisecond: reset sequence to 0 as part of the SAME atomic
        # advance (single CAS — no window where sequence can be reused).
        new = Bitwise.bsl(now_rel, @sequence_bits)

        case :atomics.compare_exchange(ref, 1, cur, new) do
          :ok -> compose(now_rel, 0)
          _stale -> do_next(now_ms())
        end

      now_rel == cur_rel and cur_seq < @max_sequence ->
        # Same millisecond: strictly increment the packed sequence.
        case :atomics.compare_exchange(ref, 1, cur, cur + 1) do
          :ok -> compose(cur_rel, cur_seq + 1)
          _stale -> do_next(now_ms())
        end

      now_rel < cur_rel ->
        # The wall clock is BEHIND the cell: an NTP step back, or a restart
        # whose clock stepped back past ids the previous run issued — the
        # cell was seeded from the persisted high-water mark
        # (`Cytale.Snowflake.Clock`, review #24). Mint from the CELL's time
        # instead of waiting for the wall clock to catch up: the next sequence
        # in the cell's millisecond, or the cell's next millisecond once that
        # one is used up. Ids stay unique and strictly increasing, their
        # timestamps run a little ahead of the wall clock until it catches up,
        # and nothing blocks — a step back of minutes used to spin every
        # caller for minutes.
        new = if cur_seq < @max_sequence, do: cur + 1, else: Bitwise.bsl(cur_rel + 1, @sequence_bits)

        case :atomics.compare_exchange(ref, 1, cur, new) do
          :ok -> compose(Bitwise.bsr(new, @sequence_bits), Bitwise.band(new, @max_sequence))
          _stale -> do_next(now_ms())
        end

      true ->
        # Sequence exhausted for this millisecond: yield, then retry — the
        # wall clock moves on within the millisecond.
        Process.sleep(0)
        do_next(now_ms())
    end
  end

  @doc """
  Raise the generator's floor to `ms` (a wall-clock millisecond): every id
  minted afterwards is newer than ANY id whose timestamp is at or below it.
  `Cytale.Snowflake.Clock` seeds it at boot from the high-water mark the
  previous run persisted, so ids stay monotonic ACROSS restarts even when the
  clock stepped back in between (VM guests drift) — without it, a repeated
  id would silently overwrite a stored message (`messages` INSERTs are
  upserts). Never lowers the floor.
  """
  @spec raise_floor(integer()) :: :ok
  def raise_floor(ms) when is_integer(ms) do
    ensure_init()
    ref = :persistent_term.get(@cell_key)
    target = Bitwise.bsl(max(ms - @epoch_ms, 0), @sequence_bits) + @max_sequence
    do_raise_floor(ref, target)
  end

  defp do_raise_floor(ref, target) do
    cur = :atomics.get(ref, 1)

    cond do
      cur >= target ->
        :ok

      :atomics.compare_exchange(ref, 1, cur, target) == :ok ->
        :ok

      true ->
        do_raise_floor(ref, target)
    end
  end

  @doc "The generator's current high-water mark as a wall-clock millisecond."
  @spec high_water_ms() :: integer()
  def high_water_ms do
    ensure_init()
    Bitwise.bsr(:atomics.get(:persistent_term.get(@cell_key), 1), @sequence_bits) + @epoch_ms
  end

  defp compose(rel_ms, seq) do
    id =
      Bitwise.bsl(rel_ms, @worker_bits + @sequence_bits)
      |> Bitwise.bor(Bitwise.bsl(worker_id(), @sequence_bits))
      |> Bitwise.bor(seq)

    if id >= Bitwise.bsl(1, 63), do: raise("snowflake exceeds 63 bits"), else: id
  end

  # ---- Decode helpers -------------------------------------------------------

  @doc "Extract the generation wall-clock timestamp (ms) from an id."
  @spec timestamp_ms(t()) :: integer()
  def timestamp_ms(id) when is_integer(id) and id > 0 do
    Bitwise.bsr(id, @worker_bits + @sequence_bits) + @epoch_ms
  end

  @doc "Extract the worker id that generated an id."
  @spec worker_id_of(t()) :: 0..unquote(@max_worker_id)
  def worker_id_of(id) when is_integer(id) and id > 0 do
    Bitwise.bsr(Bitwise.band(id, Bitwise.bsl(@max_worker_id, @sequence_bits)), @sequence_bits)
  end

  @doc "Extract the per-millisecond sequence of an id."
  @spec sequence_of(t()) :: 0..unquote(@max_sequence)
  def sequence_of(id) when is_integer(id) and id > 0 do
    Bitwise.band(id, @max_sequence)
  end

  @doc "Chronological compare of two ids (ids sort by generation time)."
  @spec compare(t(), t()) :: :lt | :eq | :gt
  def compare(a, b) when is_integer(a) and is_integer(b) and a > 0 and b > 0 do
    cond do
      a < b -> :lt
      a > b -> :gt
      true -> :eq
    end
  end

  # ---- JSON-boundary helpers (>53-bit safety discipline) ----------------------

  @doc "Serialize an id for the wire: decimal string, never a JSON number."
  @spec to_string(t()) :: String.t()
  def to_string(id) when is_integer(id) and id > 0, do: Integer.to_string(id)

  @doc "Parse a decimal-string id from the wire. Accepts integers too (lenient in, strict out)."
  @spec parse(String.t() | t()) :: {:ok, t()} | :error
  def parse(id) when is_integer(id) and id > 0, do: {:ok, id}

  def parse(id) when is_binary(id) do
    case Integer.parse(id) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  def parse(_), do: :error

  @doc """
  Fail-fast boot validation of the worker id (Resolved Before Implementation,
  2026-08-27): `SNOWFLAKE_WORKER_ID` (via `Cytale.Config`) must be an integer
  in 0..1023. Single-node launch uses 0. Raises at boot on bad values — a
  misconfigured worker id would silently corrupt every generated id.
  """
  @spec validate_worker_id!() :: :ok
  def validate_worker_id! do
    case worker_id() do
      id when is_integer(id) and id >= 0 and id <= @max_worker_id ->
        :ok

      other ->
        raise ArgumentError,
              "invalid SNOWFLAKE_WORKER_ID: #{inspect(other)} — must be an integer in 0..#{@max_worker_id}"
    end
  end

  defp now_ms, do: System.system_time(:millisecond)

  # Guard: timestamp field headroom check usable in tests.
  @doc false
  @spec timestamp_field_limit_ms :: integer()
  def timestamp_field_limit_ms, do: @epoch_ms + @timestamp_limit
end
