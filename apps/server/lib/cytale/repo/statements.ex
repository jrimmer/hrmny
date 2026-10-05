defmodule Cytale.Repo.Statements do
  @moduledoc """
  Long-lived owner of the prepared-statement cache (hardening plan 1.8).

  ## Why this exists

  Every query in this application was sent as a raw CQL string. Xandra wraps a
  string in `%Xandra.Simple{}` and sends it as a QUERY frame — so the
  coordinator re-parses and re-plans the same statement on every execution —
  and, more consequentially, `Xandra.Cluster` computes its routing token with
  `routing_token/2`, which returns `nil` for anything that is not a
  `%Xandra.Prepared{}`:

      defp routing_token(%Prepared{} = prepared, params), do: Token.compute(...)
      defp routing_token(_query, _params), do: nil

  `Cytale.Repo` sets `token_aware_routing: true` and `shard_awareness: true`,
  and with a string query neither could ever engage. Prepared statements fix
  both: the server parses once, and the cluster can route by partition key.

  ## Shape

  Mirroring `Cytale.Permissions.RightsEpoch` and `CytaleWeb.Compat.RateTables`
  (the long-lived-owner rule): this GenServer owns a public named ETS table and
  never sits on the query path. Readers do a lock-free `:ets.lookup`; a miss
  prepares through `Cytale.Repo` and writes the result directly into the public
  table. There is no per-query GenServer call.

  ## Degradation

  If this owner is not running (a hermetic test boot, or a crash window before
  the supervisor restarts it), `fetch_or_prepare/1` returns a miss and the
  caller prepares — correct, just slower. A missing cache must never be a
  correctness problem.

  ## Statement ids are per-node

  `Xandra.Cluster.prepare/2` prepares on one node, so the id it returns is that
  node's. Executing it elsewhere makes the server answer "unprepared" and
  Xandra re-prepares transparently; a schema change invalidates ids the same
  way. Both are handled by the driver, so a cached struct is always safe to
  attempt.
  """

  use GenServer

  @table __MODULE__

  @doc "Starts the cache owner."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc "The public, named cache table (exposed for tests and diagnostics)."
  @spec table() :: atom()
  def table, do: @table

  @doc """
  Return the cached prepared statement for `statement`, preparing and caching
  it on a miss.

  `statement` must already carry its keyspace (the callers pass
  `…`), so the cache key is the exact text Xandra prepares and
  matches the driver's own `{statement, keyspace}` cache key.
  """
  @spec fetch_or_prepare(String.t()) :: {:ok, Xandra.Prepared.t()} | {:error, term()}
  def fetch_or_prepare(statement) when is_binary(statement) do
    case lookup(statement) do
      {:ok, prepared} ->
        {:ok, prepared}

      :error ->
        case Cytale.Repo.prepare(statement) do
          {:ok, prepared} = ok ->
            cache(statement, prepared)
            ok

          {:error, _reason} = error ->
            error
        end
    end
  end

  @doc "Number of cached statements (tests/diagnostics)."
  @spec size() :: non_neg_integer()
  def size do
    if :ets.whereis(@table) == :undefined, do: 0, else: :ets.info(@table, :size)
  end

  # A concurrent double-miss prepares twice and both writes are valid prepared
  # statements for the same text — last write wins, no coordination needed.
  #
  # try/catch rather than an `:ets.whereis` guard: the guard-then-op pair is a
  # TOCTOU (the owner can die between the two calls and the op then raises
  # ArgumentError straight out of `Repo.query/3`, which this module's contract
  # says must never happen), and it resolved the table NAME twice on the hot
  # read path, where a tid would be resolved once.
  defp cache(statement, prepared) do
    true = :ets.insert(@table, {statement, prepared})
    :ok
  catch
    :error, :badarg -> :ok
  end

  defp lookup(statement) do
    case :ets.lookup(@table, statement) do
      [{^statement, prepared}] -> {:ok, prepared}
      [] -> :error
    end
  catch
    :error, :badarg -> :error
  end

  @impl true
  def init(:ok) do
    # Public + read_concurrency: every request reads without touching the owner.
    :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    {:ok, %{}}
  end
end
