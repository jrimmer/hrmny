defmodule CytaleWeb.Compat.RateTables do
  use GenServer

  @compat_table :cytale_compat_rate_limit
  @webhook_table :cytale_webhook_rate_limit
  @preauth_table :cytale_compat_preauth_rate_limit
  @native_table :cytale_rate_limit
  @idempotency_table :cytale_idempotency_cache

  # Tables whose rows are fixed-window buckets shaped `{key, count, window_end}`.
  @window_tables [@compat_table, @webhook_table, @preauth_table, @native_table]

  # Sweep cadence for expired bucket rows (B2): fixed-window rows whose
  # window has closed are deleted so the tables stay bounded no matter how
  # many distinct principals/IPs/webhook pairs pass through.
  @sweep_interval_ms 60_000

  @moduledoc """
  Long-lived owner of every rate-limit ETS table (KTD9):

    * `#{@compat_table}` — the compat REST plug's route-template buckets;
    * `#{@webhook_table}` — the per-webhook execute buckets (U11) + the
      per-IP miss-path dam (B2);
    * `#{@preauth_table}` — the pre-auth per-IP dam in front of BotAuth (B2);
    * `#{@native_table}` — the native `/api/v1` plug's per-ACCOUNT buckets and
      the per-IP ceiling behind them (`CytaleWeb.Plugs.RateLimit`, #90);
    * `#{@idempotency_table}` — `CytaleWeb.Plugs.Idempotency`'s replay store
      (hardening plan 1.4). Same bug, third instance: the plug created this
      table lazily from whichever Bandit connection process first saw an
      `Idempotency-Key`, so it died with that connection and a client retry
      after a dropped connection re-executed the controller — duplicating the
      write the header exists to prevent, silently, because the guarantee was
      unenforceable rather than erroring.

  The tables used to be lazily created by WHOEVER hit them first — a Bandit
  connection process — so the table died when that process was recycled
  (badarg 500s + a full bucket reset on every recycle). Mirroring
  `Cytale.Permissions.RightsEpoch`'s shape, this GenServer (started under the
  root supervision tree — the long-lived-owner rule) creates the tables at
  boot; connection processes only ever READ/WRITE the public named tables.

  #90 closed the last hole of that class: the NATIVE table was still created
  on first use by the request process that happened to arrive first, so every
  counter it held reset the moment that process (or its keep-alive
  connection) ended — per-account budgets and per-IP ceilings could not
  accumulate, and whether a 429 fired at all depended on connection reuse.
  The native table is now owned here like the rest.

  The owner also runs the periodic sweeper (B2, the `Interactions.TokenStore`
  pattern): every `#{@sweep_interval_ms}` ms, rows in EVERY owned table whose
  expiry is in the past are deleted. Correctness never depends on the sweep
  (`RateLimit.consume/5` rolls closed windows itself) — it bounds the tables'
  growth from one-shot flood keys (forged webhook pairs, rotated IPs) that
  would otherwise never be touched again.
  """

  # -- client API ------------------------------------------------------------

  @doc "Starts the table owner + sweeper (idempotent under the app tree)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc "The compat REST plug's rate-limit table (public, named)."
  @spec compat_table() :: atom()
  def compat_table, do: @compat_table

  @doc "The per-webhook execute rate-limit table (public, named)."
  @spec webhook_table() :: atom()
  def webhook_table, do: @webhook_table

  @doc "The pre-auth per-IP rate-limit table (public, named)."
  @spec preauth_table() :: atom()
  def preauth_table, do: @preauth_table

  @doc """
  The NATIVE plug's rate-limit table (public, named): `CytaleWeb.Plugs.RateLimit`'s
  per-account buckets and the per-IP ceiling behind them (#90).
  """
  @spec native_table() :: atom()
  def native_table, do: @native_table

  @doc """
  `CytaleWeb.Plugs.Idempotency`'s replay store (public, named).

  Owned here rather than created on demand by the plug, so the store outlives
  every connection that reads it (hardening plan 1.4).
  """
  @spec idempotency_table() :: atom()
  def idempotency_table, do: @idempotency_table

  @doc """
  Delete every expired row across ALL owned tables. Returns the number of rows
  removed (tests/telemetry). Safe pre-boot: a missing table simply contributes
  zero.

  Two row shapes are owned here, so this understands both rather than each
  table growing its own sweep on a request path:

    * rate buckets — `{key, count, window_end}`, expired at `window_end`;
    * the idempotency replay store — `{key, body_hash, status, body, exp}`,
      expired at `exp`.
  """
  @spec sweep() :: non_neg_integer()
  def sweep do
    now = System.system_time(:millisecond)

    window_removed =
      @window_tables
      |> Enum.map(fn table ->
        sweep_matching(table, fn
          {key, _count, window_end} ->
            if window_end < now, do: {:delete, key}, else: :keep

          _other ->
            :keep
        end)
      end)
      |> Enum.sum()

    expiry_removed =
      sweep_matching(@idempotency_table, fn
        {key, _hash, _status, _body, exp} ->
          if exp < now, do: {:delete, key}, else: :keep

        _other ->
          :keep
      end)

    window_removed + expiry_removed
  end

  # Fold-and-delete over one table, with the shape test supplied by the caller.
  # A missing table contributes zero (safe pre-boot and in hermetic runs).
  defp sweep_matching(table, classify) do
    if :ets.whereis(table) == :undefined do
      0
    else
      :ets.foldl(
        fn object, acc ->
          case classify.(object) do
            {:delete, key} ->
              :ets.delete(table, key)
              acc + 1

            :keep ->
              acc
          end
        end,
        0,
        table
      )
    end
  end

  # -- GenServer ---------------------------------------------------------------

  @impl true
  def init(:ok) do
    # The owner creates the tables (they die with the owner — a supervised
    # long-lived process — never with a request process); :public +
    # read_concurrency lets every request read/write counters without
    # touching the owner.
    for table <- owned_tables() do
      if :ets.whereis(table) == :undefined do
        :ets.new(table, [:set, :named_table, :public, read_concurrency: true])
      end
    end

    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:sweep, state) do
    sweep()
    Process.send_after(self(), :sweep, @sweep_interval_ms)
    {:noreply, state}
  end

  # Every table this owner creates at boot and sweeps. One list, so the owner
  # and the sweeper can never disagree about what is owned (a table created
  # here but missing from the sweep would grow forever).
  defp owned_tables, do: @window_tables ++ [@idempotency_table]
end
