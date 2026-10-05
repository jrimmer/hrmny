defmodule Cytale.Repo do
  @moduledoc """
  Xandra cluster connection pool (U6) — the single ScyllaDB access seam.

  Wraps `Xandra.Cluster` (pool-per-node with shard awareness and token-aware
  routing, both best-effort per Xandra 0.20) registered as `Cytale.Repo`.
  Contact points, pool size, and the default consistency (`:local_quorum`)
  come from `Cytale.Config` (validated in runtime.exs / test.exs).

  The cluster child starts ASYNC (no `:sync_connect`): `start_link/1` returns
  before any TCP connection exists, so a boot without a reachable ScyllaDB
  does not wedge the supervision tree — the first query surfaces the error.
  `start/0` re-runs `Cytale.Migrations.apply!/0` (idempotent) so a booted node
  always sees an applied schema before its first data access; tests drive the
  pool directly through this module.

  Consistency: every query runs at the configured default (`:local_quorum`);
  individual calls may override per-query via `Xandra`'s `:consistency`.

  Read retries (hardening R-7): `execute/3`, `execute!/3` and `query/3` retry
  a SELECT whose failure is transient (`:read_timeout`, `:unavailable`,
  `:overloaded`, `:server_error`, or any `%Xandra.ConnectionError{}`) up to
  `Cytale.Config.repo_read_retries/0` times (default 2; 0 disables) with a
  small linear backoff — see `with_read_retry/2`. Writes, LWTs and the
  paging/streaming helpers (`stream_rows!/3`, `stream_pages!/2` — a cursor
  cannot be replayed safely mid-stream) are attempted exactly once.
  """

  @cluster_opts_schema_keys [
    :nodes,
    :load_balancing,
    :refresh_topology_interval,
    :target_pools,
    :name,
    :sync_connect,
    :queue_checkouts_before_connecting,
    :pool_size,
    :token_aware_routing,
    :shard_awareness
  ]

  @doc "Child specification for the application supervision tree."
  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts \\ []) do
    %{
      id: {Cytale.Repo, Keyword.get(opts, :name, Cytale.Repo)},
      start: {__MODULE__, :start_link, [opts]},
      type: :worker
    }
  end

  @doc """
  Start the cluster pool. Async-connect by design (see moduledoc): returns
  `{:ok, pid}` even while contact points are still dialing.
  """
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    Xandra.Cluster.start_link(cluster_opts(opts))
  end

  @doc """
  Ensure the cluster is connected and the schema is applied (idempotent).
  Used at dev boot and before integration tests; raises on failure.
  """
  @spec start() :: :ok
  def start do
    {:ok, _pid} = ensure_pool()
    Cytale.Migrations.apply!()
    :ok
  end

  @doc "Stop the named cluster pool (tests)."
  @spec stop(GenServer.server()) :: :ok
  def stop(cluster \\ __MODULE__) do
    case GenServer.whereis(cluster) do
      nil ->
        :ok

      pid ->
        Xandra.Cluster.stop(pid)
    end
  end

  @doc """
  True when at least one node pool is connected (cheap liveness probe).
  """
  @spec connected?(GenServer.server()) :: boolean()
  def connected?(cluster \\ __MODULE__) do
    case Xandra.Cluster.connected_hosts(cluster) do
      [_ | _] -> true
      _ -> false
    end
  end

  # ----- Query surface ---------------------------------------------------------
  # The cluster registers under the name Cytale.Repo, so these helpers target
  # it implicitly — no leading cluster argument to misbind positionally.

  @doc """
  Resolve the `{{K}}` keyspace placeholder in a statement template.

  Every CQL statement in this codebase is written against `{{K}}` so one text
  works in dev, prod and the namespaced test keyspaces, and this is the ONE place
  it becomes concrete (hardening plan 3.1). It used to be a private `keyspace/1`
  helper repeated in 33 modules and wrapped around 245 call sites; folding it in
  here means a call site hands over the template it already wrote.

  Substituting twice is a no-op (the placeholder is gone after the first), so a
  caller that still resolves it — or interpolates `keyspace/0` itself — is
  unaffected.
  """
  @placeholder "{{K}}"
  # One module spelled it this way (`token_store.ex`); both mean the same thing
  # and are resolved here so no call site has to remember which.
  @placeholder_long "{{KEYSPACE}}"

  @spec statement(String.t()) :: String.t()
  def statement(text) when is_binary(text) do
    text
    |> String.replace(@placeholder, keyspace())
    |> String.replace(@placeholder_long, keyspace())
  end

  @doc "Execute a simple (unprepared) statement with bound values."
  @spec execute(Xandra.statement(), Xandra.values(), keyword()) ::
          {:ok, Xandra.result()} | {:error, Xandra.error()}
  def execute(statement, params \\ [], opts \\ []) when is_binary(statement) do
    with_read_retry(statement, fn ->
      Xandra.Cluster.execute(__MODULE__, statement(statement), params, opts)
    end)
  end

  @doc """
  Execute a PREPARED statement with plain (untyped) bound values — the types
  ride the prepared metadata. #120's restore replay prepares one INSERT per
  table and executes it per row through here.
  """
  @spec execute_prepared(Xandra.Prepared.t(), Xandra.values(), keyword()) ::
          {:ok, Xandra.result()} | {:error, Xandra.error()}
  def execute_prepared(%Xandra.Prepared{} = prepared, params \\ [], opts \\ []) do
    Xandra.Cluster.execute(__MODULE__, prepared, params, opts)
  end

  @doc """
  Execute `statement` as a PREPARED query, preparing each distinct statement
  text ONCE (hardening plan 1.8).

  Use this instead of `execute/3` on any path that runs more than once per
  process. A raw string goes to the server as a `%Xandra.Simple{}` QUERY frame:
  re-parsed and re-planned every execution, and — because
  `Xandra.Cluster.routing_token/2` returns `nil` for anything that is not a
  `%Xandra.Prepared{}` — never routed by partition key, so this Repo's
  `token_aware_routing: true` and `shard_awareness: true` had no effect at all.

  Semantically identical to `execute/3` for the value forms this codebase uses:
  same rows, same values, same `{:error, _}` shape on a failed EXECUTE. Values
  arrive in the simple path's typed form — `{"bigint", 123}` — and are unwrapped
  to the bare values a prepared EXECUTE frame requires: the prepared metadata
  already carries each column's type, so sending the type again is what makes
  `Xandra.Protocol.V4.encode_value/2` raise a FunctionClauseError. Accepting the
  typed form keeps `query/3` a drop-in replacement for `execute/3` at a call
  site.

  Two limits worth knowing before converting a call site:

    * The DECLARED type is discarded — encoding follows the prepared metadata.
      A declared type that disagrees with the column's therefore raises out of
      `query/3` rather than returning `{:error, _}`. Every converted call site
      passes `{"bigint", integer}` for a bigint column.
    * `unwrap_values/1` cannot tell a typed pair from a genuine two-element
      tuple VALUE. No column in this schema uses a tuple type (the only frozen
      is `list<frozen<map<text, text>>>`), so this is safe today and would need
      revisiting if one were added.

  `Cytale.Repo.Statements` owns the cache; if its owner is not running the call
  degrades to a fresh prepare (correct, slower) rather than failing.
  """
  @spec query(Xandra.statement(), Xandra.values(), keyword()) ::
          {:ok, Xandra.result()} | {:error, Xandra.error()}
  def query(statement, params \\ [], opts \\ []) when is_binary(statement) do
    statement = statement(statement)

    with {:ok, prepared} <- Cytale.Repo.Statements.fetch_or_prepare(statement) do
      # Reads ride the same retry policy as `execute/3` (the prepared text is
      # the read/write discriminator — writes must stay exactly-once attempted).
      # `%Xandra.Prepared{}` carries its statement text.
      with_read_retry(prepared.statement, fn ->
        execute_prepared(prepared, unwrap_values(params), opts)
      end)
    end
  end

  # The simple path carries `{type, value}`; a prepared EXECUTE carries bare
  # values. No column in this schema is a tuple type, so a two-element tuple
  # here is always the typed form.
  defp unwrap_values(values) when is_list(values) do
    Enum.map(values, fn
      {type, value} when is_atom(type) or is_binary(type) -> value
      bare -> bare
    end)
  end

  defp unwrap_values(other), do: other

  @doc "`query/3`, raising on error — the prepared twin of `execute!/3`."
  @spec query!(Xandra.statement(), Xandra.values(), keyword()) :: Xandra.result()
  def query!(statement, params \\ [], opts \\ []) when is_binary(statement) do
    case query(statement, params, opts) do
      {:ok, result} -> result
      {:error, exception} -> raise exception
    end
  end

  @doc """
  Execute a statement, raising on error.

  Funnels through `execute/3` (hardening R-7): identical exceptions raised on
  failure, and idempotent READS get the same transient-failure retries the
  `{:error, _}` surface does.
  """
  @spec execute!(Xandra.statement(), Xandra.values(), keyword()) :: Xandra.result()
  def execute!(statement, params \\ [], opts \\ []) when is_binary(statement) do
    case execute(statement, params, opts) do
      {:ok, result} -> result
      {:error, exception} -> raise exception
    end
  end

  @doc """
  Did a lightweight transaction (LWT) apply?

  A conditional statement (`INSERT ... IF NOT EXISTS`, `UPDATE ... IF col = ?`,
  `DELETE ... IF EXISTS`) answers with ONE row carrying an `[applied]` column:
  `%{"[applied]" => true}` on a win, and `false` plus the EXISTING row's values
  on a refusal (probed against ScyllaDB 2026.2 — see the `session_bridge` and
  WebAuthn call sites, which each carried a private copy of this pattern).

  Callers use it to make a read-then-write pair exactly-once: the conditional
  write is the gate, and only the winner moves the derived state.
  """
  @spec lwt_applied?(Xandra.result()) :: boolean()
  def lwt_applied?(page) do
    case page |> Enum.to_list() |> List.first() do
      %{"[applied]" => true} -> true
      _refused_or_empty -> false
    end
  end

  @doc """
  Execute several writes as ONE unlogged batch (`hardening plan 5.6`).

  A ROUND-TRIP WIN, NOT ATOMICITY: Scylla applies each statement independently, so
  a batch is for the network cost of a fan of small writes (a message plus its
  embed/component side rows, a message delete and its cascades), never for a
  transaction. Two consequences worth keeping in mind at a call site:

    * the whole batch carries ONE timestamp, so a statement that needs its own
      write time (`USING TIMESTAMP`, the component/embed REPLACE path) must stay a
      standalone statement — `Messages.replace_side_rows/4` deliberately does not
      come through here;
    * statements are RAW (a simple query's values are encoded with their declared
      types, exactly as `execute/3` binds them), so a call site keeps the typed
      `{"bigint", id}` style and no prepared id travels between nodes.

  Raises on the first error, like `execute!/3`: the callers are all writes whose
  failure is already surfaced to their own caller.
  """
  @spec batch!([{String.t(), list()}], keyword()) :: :ok
  def batch!(statements, opts \\ []) when is_list(statements) and statements != [] do
    batch =
      Enum.reduce(statements, Xandra.Batch.new(:unlogged), fn {statement, values}, acc ->
        Xandra.Batch.add(acc, statement(statement), values)
      end)

    Xandra.Cluster.execute!(__MODULE__, batch, opts)
    :ok
  end

  @doc """
  Execute a statement and enumerate EVERY result row across ALL pages,
  raising on error.

  `execute!/3` returns only the FIRST Xandra page (default page size: 10k
  rows) — a result set larger than one page is silently truncated unless
  the caller follows the paging state. Any scan over a table that can grow
  past one page (sweeps, ALLOW FILTERING resolves) must read through here:
  `Principals.revoke/1`'s credential scan truncated at the page boundary
  once the persistent test keyspace's `bot_tokens` crossed 10k rows, and
  revoked tokens kept authenticating.
  """
  @spec stream_rows!(Xandra.statement(), Xandra.values(), keyword()) :: Enumerable.t()
  def stream_rows!(statement, params \\ [], opts \\ []) when is_binary(statement) do
    __MODULE__
    |> Xandra.Cluster.stream_pages!(statement(statement), params, opts)
    |> Stream.flat_map(& &1)
  end

  @doc """
  Prepare a statement through the cluster (token-aware routing uses the
  prepared statement's partition key when all its values are bound).
  """
  @spec prepare(Xandra.statement(), keyword()) ::
          {:ok, Xandra.Prepared.t()} | {:error, Xandra.error()}
  def prepare(statement, opts \\ []) when is_binary(statement) do
    Xandra.Cluster.prepare(__MODULE__, statement(statement), opts)
  end

  @doc """
  Run `fun` with a single node's connection pool — for prepare-and-execute on
  the same node (e.g. retry-strategy-friendly batches of prepared statements).
  """
  @spec run(keyword(), (Xandra.conn() -> result)) :: result when result: var
  def run(opts \\ [], fun) do
    Xandra.Cluster.run(__MODULE__, opts, fun)
  end

  @doc """
  Stream paged results (cursor pagination over huge partitions, e.g. message
  history deep-scrolls). Returns a lazy `Enumerable` of `Xandra.Page`s.
  """
  @spec stream_pages!(Xandra.statement() | Xandra.Prepared.t(), Xandra.values(), keyword()) ::
          Enumerable.t()
  def stream_pages!(query, params \\ [], opts \\ []) do
    Xandra.Cluster.stream_pages!(__MODULE__, query, params, opts)
  end

  @doc """
  The keyspace all Cytale tables live in (used by migrations and tests).
  Configurable per environment (:test uses `cytale_test`).
  """
  @spec keyspace() :: String.t()
  def keyspace, do: Cytale.Config.scylla_keyspace()

  # ----- Read retry (hardening R-7) ---------------------------------------------
  #
  # A Scylla cluster serves a READ again after a transient failure — the
  # coordinator may have timed out waiting for replicas, a node may be
  # overloaded, or the driver may simply have been mid-topology-change. A
  # WRITE must never be retried here: its outcome after a timeout is UNKNOWN
  # (the coordinator may have applied it), so a blind retry can duplicate it —
  # the same reasoning `CytaleWeb.ErrorHandler` documents for answering 500
  # (not 503) on write failures. Statements whose trimmed/upcased text starts
  # with "SELECT" are the reads; everything else (INSERT/UPDATE/DELETE/BATCH,
  # LWTs included) is attempted exactly once.

  # The %Xandra.Error{} reasons a read may be re-asked: the read-timeout /
  # replica-unavailable / overloaded family plus the server's own 0x0000.
  # Deliberately NOT here: :invalid, :unauthorized, :invalid_syntax and the
  # rest of the caller-error family — a retry can never succeed those.
  # (`:write_timeout`/`:write_failure`/`:server_failure` never reach this
  # module's retry at all — writes don't retry.)
  @transient_read_reasons [:read_timeout, :unavailable, :overloaded, :server_error]

  # Linear backoff base: retry N sleeps this many milliseconds times N. Small
  # on purpose — the cluster re-routes on the next attempt, and the caller's
  # request is already waiting.
  @read_retry_backoff_ms 50

  @doc """
  Run `fun` (a read executor returning `{:ok, result} | {:error, exception}`)
  under the module's read-retry policy: when `statement` is a read (trimmed,
  upcased `SELECT` prefix) and `Cytale.Config.repo_read_retries/0` > 0, a
  transient failure (the `@transient_read_reasons` family, or ANY
  `%Xandra.ConnectionError{}` — the cluster re-routes onto a healthy node on
  the next attempt) is retried up to that many times with a small linear
  backoff (`#{@read_retry_backoff_ms}`ms × attempt). Writes and non-transient
  errors return untouched.

  Public so the retry loop is unit-testable with an injected fake executor —
  no live ScyllaDB needed (the same reasoning `CytaleWeb.ErrorHandler`
  records for its pure classifier).
  """
  @spec with_read_retry(String.t(), (-> {:ok, Xandra.result()} | {:error, Xandra.error()})) ::
          {:ok, Xandra.result()} | {:error, Xandra.error()}
  def with_read_retry(statement, fun) when is_binary(statement) and is_function(fun, 0) do
    if read?(statement) and Cytale.Config.repo_read_retries() > 0 do
      read_with_retry(fun, 1)
    else
      fun.()
    end
  end

  defp read?(statement) do
    statement
    |> String.trim()
    |> String.upcase()
    |> String.starts_with?("SELECT")
  end

  # `attempt` is the number of the retry we would be ABOUT to run (1-based);
  # the sleep grows linearly with it.
  defp read_with_retry(fun, attempt) do
    case fun.() do
      {:ok, _result} = ok ->
        ok

      {:error, %Xandra.ConnectionError{}} = error ->
        retry_or_return(error, fun, attempt)

      {:error, %Xandra.Error{reason: reason}} = error when reason in @transient_read_reasons ->
        retry_or_return(error, fun, attempt)

      other ->
        other
    end
  end

  # The budget is read OUTSIDE the guard on purpose: guards cannot invoke
  # remote functions, and a remote call here fails the PROD release compile
  # outright (`MIX_ENV=prod mix release` — observed 2026-09-25, where the
  # tee-piped release step masked the error until smoke-boot missed the
  # binary). Same comparison, plain body.
  defp retry_or_return(error, fun, attempt) do
    if attempt > Cytale.Config.repo_read_retries() do
      error
    else
      Process.sleep(@read_retry_backoff_ms * attempt)
      read_with_retry(fun, attempt + 1)
    end
  end

  # ----- Internals -------------------------------------------------------------

  defp cluster_opts(opts) do
    defaults = [
      nodes: Cytale.Config.scylla_nodes() |> Enum.map(&List.to_string/1),
      pool_size: Cytale.Config.scylla_pool_size(),
      name: __MODULE__,
      default_consistency: Cytale.Config.scylla_default_consistency(),
      # ScyllaDB-specific routing (both best-effort; safe with native protocol
      # v5+ against ScyllaDB 5.2): one connection per shard, prepared queries
      # routed to the primary replica of their partition.
      shard_awareness: true,
      token_aware_routing: true,
      # Stay on this node's data center (single-DC launch topology).
      load_balancing: {Xandra.Cluster.LoadBalancingPolicy.DCAwareRoundRobin, []}
    ]

    merged = Keyword.merge(defaults, opts)

    {cluster_opts, conn_opts} = Keyword.split(merged, @cluster_opts_schema_keys)

    # Any leftover user opts belong to the connection options; Xandra's own
    # NimbleOptions validation surfaces unknown keys loudly.
    cluster_opts ++ conn_opts
  end

  # The pool is owned by the application tree in every env except :test, where
  # tests start (and stop) it on demand so suites without ScyllaDB needs stay
  # hermetic (config/test.exs keeps `include_scylla: false`).
  defp ensure_pool do
    case GenServer.whereis(__MODULE__) do
      nil -> start_link([])
      pid -> {:ok, pid}
    end
  end
end
