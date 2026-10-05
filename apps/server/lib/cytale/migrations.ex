defmodule Cytale.Migrations do
  @moduledoc """
  ScyllaDB schema lifecycle (U6): apply `priv/scylla_schema.cql` idempotently
  and verify the applied schema matches what this node expects.

  * `apply!/0` — ensure the keyspace exists and every `CREATE TABLE` has run.
    Every statement in the schema file is idempotent (`IF NOT EXISTS`), so this
    is safe to run at every boot (dev) and from the release migration entry
    point (prod).
  * `verify!/0` — assert every expected table exists and its columns match the
    schema file (name + type). A drift raises loudly at boot rather than
    surfacing later as a runtime query error.

  Statements are split on `;` at top level (the schema file contains no
  semicolons inside string literals), trimmed, and executed one by one through
  `Cytale.Repo`. DDL in ScyllaDB is globally consistent schema agreement; each
  statement waits for schema agreement server-side before acknowledging.
  """

  @schema_path "priv/scylla_schema.cql"

  # The one table whose COLUMN TYPE changed after launch (hardening plan 4.3):
  # `reaction_counts.count` was an application-managed `bigint` mirror and is now
  # a real `counter`.
  @counter_tables [{"reaction_counts", "count"}]

  # How many aggregated tallies a counter conversion flushes to its sidecar at a
  # time: the memory bound of the recount (see `recount_into_sidecar!/3`).
  @recount_chunk 5_000

  # The cluster pool starts async, so the first handshake may still be in
  # flight when boot reaches apply!/0 (tunneled/remote Scylla adds latency the
  # in-memory check can't). Give it a bounded grace window before declaring
  # the cluster unreachable. Schema statements are raft/LWT round-trips on
  # Scylla — the same hops inflate their latency, so they run with a generous
  # explicit call timeout instead of the driver default.
  @grace_ms 15_000
  @grace_poll_ms 250
  @schema_timeout_ms 30_000
  @comment_re ~r/^\s*--/

  defmodule Error do
    @moduledoc "Raised when schema apply or verify fails."
    defexception [:message]
  end

  @doc "Path of the bundled schema file."
  @spec schema_path() :: String.t()
  def schema_path, do: @schema_path

  @doc """
  Parse the schema file into individual CQL statements (comments stripped).
  Exported for tests and for the release migration mix task.
  """
  @spec statements(String.t() | nil, String.t() | nil) :: [String.t()]
  def statements(schema \\ nil, keyspace \\ nil) do
    schema
    |> Kernel.||(read_schema())
    |> substitute_keyspace(keyspace || Cytale.Repo.keyspace())
    |> strip_comments()
    |> String.split(";")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == ""))
  end

  @doc """
  Apply the schema (idempotent). Raises `Cytale.Migrations.Error` on any
  statement failure or when the cluster is unreachable.
  """
  @spec apply!(String.t() | nil, keyword()) :: :ok
  def apply!(schema \\ nil, opts \\ []) do
    keyspace = Keyword.get(opts, :keyspace, Cytale.Repo.keyspace())
    stmts = statements(schema, keyspace)

    unless connected?() do
      raise Error, "cannot apply schema: ScyllaDB is not reachable via Cytale.Repo"
    end

    # Read BEFORE the DDL below creates it: the locator backfill runs only for a
    # keyspace gaining the table now (or one whose backfill was interrupted).
    thread_locator_existed? = table_exists?(keyspace, "thread_messages")

    Enum.each(stmts, fn stmt ->
      case Cytale.Repo.execute(stmt, [], timeout: @schema_timeout_ms) do
        {:ok, _result} ->
          :ok

        {:error, %Xandra.Error{} = err} ->
          raise Error, "schema statement failed: #{inspect(stmt)} — #{Exception.message(err)}"

        {:error, err} ->
          raise Error,
                "schema statement failed (connection): #{inspect(stmt)} — #{Exception.message(err)}"
      end
    end)

    # ONE system_schema read feeds both steps (each used to take its own).
    live = live_schema(keyspace)

    convert_counter_columns!(stmts, keyspace, live)
    reconcile_columns!(stmts, keyspace, live)

    if defines_tables?(stmts, ["messages", "thread_messages"]),
      do: backfill_thread_locator!(keyspace, thread_locator_existed?),
      else: :ok
  end

  # Whether the schema being applied creates every named table. The locator
  # backfill needs both ends; a partial schema (the migration tests apply
  # several) has nothing to index and must not scan a table it never created.
  defp defines_tables?(stmts, tables) do
    Enum.all?(tables, fn table ->
      Enum.any?(stmts, &Regex.match?(~r/CREATE TABLE IF NOT EXISTS \S+\.#{table}\s*\(/i, &1))
    end)
  end

  # -- thread reply locator backfill (#152) ---------------------------------------
  #
  # `thread_messages` indexes every reply by its thread. Replies written before
  # the table existed have no row, and a thread read over the locator alone
  # would silently drop them — so the first boot that creates the table indexes
  # the existing replies from the authority, `messages`.
  #
  # Crash safety is the sidecar pattern above in miniature: a MARKER table is
  # created before the scan and dropped only after it completes, so
  #
  #   * table absent before this boot       -> mark, backfill, unmark
  #   * table present + marker present      -> an earlier backfill died: rerun
  #   * table present + no marker           -> done (the common, free case)
  #
  # Inserts are idempotent (same primary key, same values), so a rerun is safe.
  # The scan is one streamed pass over `messages` — paid once per keyspace, on
  # the boot that introduces the table. Same single-node assumption as the
  # counter conversion: this runs before the node serves traffic.
  @thread_locator_marker "thread_messages_backfill"

  defp backfill_thread_locator!(ks, existed?) do
    cond do
      not existed? ->
        execute_ddl!("CREATE TABLE IF NOT EXISTS #{ks}.#{@thread_locator_marker} (k int PRIMARY KEY)")
        run_thread_locator_backfill!(ks)

      table_exists?(ks, @thread_locator_marker) ->
        run_thread_locator_backfill!(ks)

      true ->
        :ok
    end
  end

  defp run_thread_locator_backfill!(ks) do
    "SELECT channel_id, bucket, message_id, thread_id FROM #{ks}.messages"
    |> Cytale.Repo.stream_rows!()
    |> Stream.filter(&(&1["thread_id"] != nil))
    |> Stream.chunk_every(100)
    |> Enum.each(fn chunk ->
      Cytale.Repo.batch!(
        Enum.map(chunk, fn row ->
          {"INSERT INTO #{ks}.thread_messages (thread_id, message_id, channel_id, bucket) VALUES (?, ?, ?, ?)",
           [
             {"bigint", row["thread_id"]},
             {"bigint", row["message_id"]},
             {"bigint", row["channel_id"]},
             {"int", row["bucket"]}
           ]}
        end),
        timeout: @schema_timeout_ms
      )
    end)

    execute_ddl!("DROP TABLE IF EXISTS #{ks}.#{@thread_locator_marker}")
    :ok
  end

  # `CREATE TABLE IF NOT EXISTS` cannot change a column's TYPE, and Scylla
  # refuses the obvious ALTER outright: on a table created without a counter
  # column, `ALTER ... ADD count counter` fails with "Cannot add a counter column
  # (count) in a non counter column family" — and dropping the old column first
  # does NOT clear that flag (both probed against ScyllaDB 2026.2, 2026-09-21).
  # The only conversion is a table rewrite, and a rewrite has a window in which
  # the only copy of the data is one that a crash can take: the naive
  # read -> DROP -> re-CREATE -> write-back leaves an EMPTY, already-`counter`
  # table behind if it dies after the DROP, and every later boot then skips the
  # conversion forever (the type check cannot tell "converted" from "truncated").
  #
  # So the rewrite stages its source data in a SIDECAR TABLE (`<table>_legacy`)
  # that doubles as the completion marker:
  #
  #   1. create the sidecar (if absent) and fill it with a RECOUNT of the
  #      authority — `reactions_by_message` — streamed in bounded chunks. The
  #      existence rows are the reaction set; the tally is only a mirror of them,
  #      so rebuilding from them also REPAIRS whatever drift the old
  #      read-modify-write left behind instead of carrying it across.
  #   2. DROP the real table and re-CREATE it from the schema file (counter).
  #   3. write the recount back as `+ n` deltas (a counter row cannot be created
  #      at 0, and 0 is what a filtered read already means).
  #   4. DROP the sidecar — the completion step.
  #
  # Recovery is then decided by the pair (live type, sidecar present):
  #
  #   * legacy type            -> nothing was dropped yet; the sidecar (if any)
  #                               is partial, so TRUNCATE it and recount.
  #   * `counter` + no sidecar -> converted, or never needed: done.
  #   * `counter` + sidecar    -> step 2 or 3 was interrupted; DROP/re-CREATE and
  #                               backfill from the (complete) sidecar.
  #
  # The sidecar is invisible to `verify!` and to the backup whitelist (both read
  # the schema file), and it exists only for the duration of a conversion.
  #
  # SINGLE-NODE assumption, the same one `reconcile_columns!` documents: this runs
  # at boot, before the node serves traffic, so nothing writes during it. Two
  # nodes booting concurrently against a not-yet-converted keyspace would both
  # convert, and both would then backfill from their own complete sidecar — the
  # second DROP/re-CREATE/backfill is idempotent, but the interleaving is not
  # defended. Serialize migrations (boot lock or a one-shot migration job) before
  # the first multi-node deploy, exactly as the ALTER race requires.
  defp convert_counter_columns!(stmts, keyspace, live) do
    Enum.each(@counter_tables, fn {table, column} ->
      sidecar = sidecar_table(table)

      case {live_column_type(live, table, column), table_exists?(keyspace, sidecar)} do
        {nil, _} ->
          # Fresh keyspace: `apply!` just created the table with the new type.
          :ok

        {type, false} ->
          if normalize_type(type) != "counter", do: stage_then_convert!(stmts, keyspace, table, column)

        {type, true} ->
          if normalize_type(type) == "counter",
            do: recover_conversion!(stmts, keyspace, table),
            else: stage_then_convert!(stmts, keyspace, table, column)
      end
    end)
  end

  defp stage_then_convert!(stmts, ks, table, column) do
    sidecar = sidecar_table(table)

    execute_ddl!(sidecar_ddl!(stmts, ks, table, column))
    # The legacy table is still intact, so anything the sidecar holds is partial.
    execute_ddl!("TRUNCATE #{ks}.#{sidecar}")
    recount_into_sidecar!(ks, table, sidecar)
    recover_conversion!(stmts, ks, table)
  end

  defp recover_conversion!(stmts, ks, table) do
    column = column_of(table)
    sidecar = sidecar_table(table)

    execute_ddl!("DROP TABLE #{ks}.#{table}")
    execute_ddl!(create_table_statement!(stmts, table))
    backfill_from_sidecar!(ks, table, column, sidecar)
    execute_ddl!("DROP TABLE #{ks}.#{sidecar}")

    :ok
  end

  # Rebuild the tallies from the existence rows, chunked so memory stays bounded
  # by @recount_chunk rows rather than by the table: stream, aggregate in a map,
  # flush the map into the sidecar, repeat.
  defp recount_into_sidecar!(ks, table, sidecar) do
    ks
    |> authority_counts!()
    |> Enum.chunk_every(@recount_chunk)
    |> Enum.each(fn chunk ->
      Cytale.Repo.batch!(
        Enum.map(chunk, fn {{channel_id, bucket, message_id, emoji}, tally} ->
          {"INSERT INTO #{ks}.#{sidecar} (channel_id, bucket, message_id, emoji, #{column_of(table)}) VALUES (?, ?, ?, ?, ?)",
           [
             {"bigint", channel_id},
             {"int", bucket},
             {"bigint", message_id},
             {"text", emoji},
             {"bigint", tally}
           ]}
        end),
        timeout: @schema_timeout_ms
      )
    end)

    :ok
  end

  # `{{key}, tally}` entries for every emoji anybody has reacted with. The
  # authority is `reactions_by_message` (one row per (message, emoji, user)) —
  # NOT the mirror being replaced — so a drifted mirror is repaired rather than
  # copied forward.
  defp authority_counts!(ks) do
    ks
    |> authority_query()
    |> Cytale.Repo.stream_rows!()
    |> Enum.reduce(%{}, fn row, acc ->
      key = {row["channel_id"], row["bucket"], row["message_id"], row["emoji"]}
      Map.update(acc, key, 1, &(&1 + 1))
    end)
    |> Enum.to_list()
  end

  defp authority_query(ks) do
    "SELECT channel_id, bucket, message_id, emoji FROM #{ks}.reactions_by_message"
  end

  defp backfill_from_sidecar!(ks, table, column, sidecar) do
    ks
    |> sidecar_query(sidecar)
    |> Cytale.Repo.stream_rows!()
    |> Stream.chunk_every(100)
    |> Enum.each(fn chunk ->
      Cytale.Repo.batch!(
        Enum.map(chunk, fn row ->
          {"UPDATE #{ks}.#{table} SET #{column} = #{column} + ? WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ?",
           [
             {"bigint", row["tally"]},
             {"bigint", row["channel_id"]},
             {"int", row["bucket"]},
             {"bigint", row["message_id"]},
             {"text", row["emoji"]}
           ]}
        end),
        timeout: @schema_timeout_ms
      )
    end)

    :ok
  end

  defp sidecar_query(ks, sidecar),
    do: "SELECT count AS tally, channel_id, bucket, message_id, emoji FROM #{ks}.#{sidecar}"

  # The sidecar's shape is the real table's own CREATE (so the primary key can
  # never drift from it), renamed and with the tally column widened back to
  # `bigint` — a sidecar cannot hold a counter.
  defp sidecar_ddl!(stmts, ks, table, column) do
    create_table_statement!(stmts, table)
    |> String.replace("#{ks}.#{table}", "#{ks}.#{sidecar_table(table)}", global: false)
    |> String.replace("#{column}       counter", "#{column}       bigint")
    |> String.replace("#{column} counter", "#{column} bigint")
  end

  defp sidecar_table(table), do: "#{table}_legacy"

  defp column_of(table) do
    Enum.find_value(@counter_tables, fn
      {^table, column} -> column
      _ -> nil
    end)
  end

  defp table_exists?(keyspace, table) do
    case Cytale.Repo.stream_rows!(
           "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
           [{"text", keyspace}, {"text", table}]
         )
         |> Enum.take(1) do
      [] -> false
      _ -> true
    end
  end

  # The CREATE statement for `table` straight out of the schema file — the one
  # source of truth for the post-conversion shape.
  defp create_table_statement!(stmts, table) do
    pattern = ~r/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w{}]+\.)?#{table}\s*\(/i

    Enum.find(stmts, &Regex.match?(pattern, &1)) ||
      raise Error, "no CREATE TABLE for #{table} in the schema file"
  end

  defp execute_ddl!(stmt) do
    case Cytale.Repo.execute(stmt, [], timeout: @schema_timeout_ms) do
      {:ok, _} -> :ok
      {:error, err} -> raise Error, "schema statement failed: #{inspect(stmt)} — #{Exception.message(err)}"
    end
  end

  defp live_column_type(schema, table, column),
    do: schema |> Map.get(table, %{}) |> Map.get(column)

  # `CREATE TABLE IF NOT EXISTS` is a no-op on an EXISTING table, so a column
  # added to the schema file never reaches keyspace created before it existed
  # (and Scylla has no `ALTER ... ADD IF NOT EXISTS`). Post-apply, diff the
  # expected columns against system_schema and issue plain ALTERs for the
  # gaps — the same reconciliation verify! checks, made true instead of
  # asserted. Fresh keyspaces find nothing to do.
  #
  # SINGLE-NODE assumption: two nodes booting concurrently against a
  # not-yet-reconciled keyspace can both observe the gap and race the
  # ALTER — the loser fails its boot with "column already exists" and
  # self-heals on restart. The first multi-node deploy must serialize
  # migrations (boot-lock or a one-shot migration job) before this
  # assumption stops holding.
  defp reconcile_columns!(stmts, keyspace, live) do
    Enum.each(expected_schema(stmts), fn {table, columns} ->
      present = Map.get(live, table, %{})

      Enum.each(columns, fn {column, type} ->
        unless Map.has_key?(present, column) do
          stmt = "ALTER TABLE #{keyspace}.#{table} ADD #{column} #{type}"

          case Cytale.Repo.execute(stmt, [], timeout: @schema_timeout_ms) do
            {:ok, _} -> :ok
            {:error, err} -> raise Error, "schema statement failed: #{inspect(stmt)} — #{Exception.message(err)}"
          end
        end
      end)
    end)
  end

  @doc """
  Verify the live keyspace matches the schema file: every expected table
  exists and every expected column is present with the expected type.
  Raises `Cytale.Migrations.Error` describing the first drift found.
  """
  @spec verify!(String.t() | nil, keyword()) :: :ok
  def verify!(schema \\ nil, opts \\ []) do
    keyspace = Keyword.get(opts, :keyspace, Cytale.Repo.keyspace())
    expected = expected_schema(statements(schema, keyspace))
    live = live_schema(keyspace)

    Enum.each(expected, fn {table, columns} ->
      present = Map.get(live, table, %{})

      missing = for {column, _type} <- columns, not Map.has_key?(present, column), do: column

      unless missing == [] do
        raise Error,
              "schema drift on #{Cytale.Repo.keyspace()}.#{table}: missing columns #{inspect(missing)}"
      end

      bad_type =
        Enum.find(columns, fn {col, type} ->
          case Map.fetch(present, col) do
            {:ok, live_type} -> normalize_type(live_type) != normalize_type(type)
            :error -> false
          end
        end)

      case bad_type do
        nil -> :ok
        {col, type} -> raise Error, "schema drift on #{keyspace}.#{table}.#{col}: expected #{type}"
      end
    end)

    :ok
  end

  @type expected_column :: {String.t(), String.t()}

  # A healthy dev database holds the system keyspaces plus `cytale` plus a
  # handful of live test keyspaces — call it 10. 15 leaves room for several
  # parallel agents before it gets noisy.
  @keyspace_warn_threshold 15

  @doc """
  Warn when the node holds far more keyspaces than a healthy dev database.

  Boot time and memory scale with the total table count across ALL keyspaces
  (see the moduledoc note in `scripts/scylla-reset.sh`), and a hard-killed test
  run leaks a one-off keyspace that nothing reclaims. Without this the only
  signal is a boot that has quietly become minutes long, and acting on it means
  already knowing the reset script exists. This puts the count, the remedy, and
  the pointer in the boot log instead.

  Warn-only by design — a bloated node still works, so this must never be the
  reason a boot fails, and every failure path is swallowed.

  Opt-in (`config :cytale, warn_on_scylla_keyspace_bloat: true`, set in
  dev.exs): it is a dev-loop diagnostic, not something a release should log.
  """
  @spec warn_if_keyspace_count_high(pos_integer()) :: :ok
  def warn_if_keyspace_count_high(threshold \\ @keyspace_warn_threshold) do
    count =
      Cytale.Repo.stream_rows!("SELECT keyspace_name FROM system_schema.keyspaces")
      |> Enum.count()

    if count > threshold do
      require Logger

      Logger.warning(
        "ScyllaDB is holding #{count} keyspaces (a healthy dev database has ~#{threshold}).\n" <>
          "Boot time and memory scale with the total table count across ALL keyspaces, and\n" <>
          "hard-killed test runs leak one-off keyspaces that nothing reclaims. Reclaim them:\n" <>
          "    scripts/scylla-reset.sh            # dry run — lists what would go\n" <>
          "    scripts/scylla-reset.sh --apply\n" <>
          "See \"Dev-loop database hygiene\" in AGENTS.md."
      )
    end

    :ok
  rescue
    # Diagnostics must never be the reason a boot fails.
    _ -> :ok
  end

  @doc """
  Derive `{table, columns}` from parsed CREATE TABLE statements (best-effort
  regex parse of the CQL we control — the schema file is in-repo and simple).
  """
  @spec expected_schema([String.t()]) :: [{String.t(), [expected_column()]}]
  def expected_schema(stmts \\ nil) do
    stmts
    |> Kernel.||(statements())
    |> Enum.flat_map(fn stmt ->
      case Regex.run(
             ~r/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w{}]+\.)?(\w+)\s*\(/is,
             stmt
           ) do
        [_full, _maybe_keyspace, table] ->
          cols = parse_columns(stmt)

          [{table, cols}]

        _ ->
          []
      end
    end)
  end

  # ----- Internals ---------------------------------------------------------------

  # The schema file is keyspace-parameterized (`{{keyspace}}`); resolve it to
  # the configured keyspace (dev/prod `cytale`, test `cytale_test`) so the same
  # file applies everywhere.
  defp substitute_keyspace(text, keyspace) do
    String.replace(text, "{{keyspace}}", keyspace)
  end

  defp read_schema do
    case File.read(schema_path()) do
      {:ok, body} ->
        body

      {:error, reason} ->
        raise Error,
              "cannot read schema file #{schema_path()} (cwd: #{inspect(File.cwd!())}): #{inspect(reason)}"
    end
  end

  # Line comments only (-- prefix). Runs BEFORE statement splitting so a
  # semicolon inside a comment can never split a statement.
  defp strip_comments(text) do
    text
    |> String.split("\n")
    |> Enum.reject(&Regex.match?(@comment_re, &1))
    |> Enum.join("\n")
  end

  defp connected?(deadline \\ now_ms() + @grace_ms) do
    case GenServer.whereis(Cytale.Repo) do
      nil -> false
      _ -> Cytale.Repo.connected?() or wait_connected?(deadline)
    end
  end

  defp wait_connected?(deadline) do
    if now_ms() < deadline do
      Process.sleep(@grace_poll_ms)
      connected?(deadline)
    else
      false
    end
  end

  defp now_ms, do: System.monotonic_time(:millisecond)

  # The keyspace's whole column map as `%{table => %{column => type}}` in ONE
  # read. `verify!`/`reconcile_columns!` used to issue a separate system_schema
  # query per table AND per column — ~330 serial round trips on every dev boot,
  # which dev.exs pays on every restart (apply + verify at boot). One
  # keyspace-wide read replaces all of them.
  #
  # Streamed rather than `execute!` for the same reason the moduledoc gives:
  # `execute!` returns only the first page and truncates silently past it.
  defp live_schema(keyspace) do
    Cytale.Repo.stream_rows!(
      "SELECT table_name, column_name, type FROM system_schema.columns WHERE keyspace_name = ?",
      [{"text", keyspace}]
    )
    |> Enum.reduce(%{}, fn %{"table_name" => table, "column_name" => column, "type" => type}, acc ->
      Map.update(acc, table, %{column => type}, &Map.put(&1, column, type))
    end)
  end

  # CQL types are case-insensitive; system_schema reports lowercase.
  defp normalize_type(type), do: type |> String.downcase() |> String.trim()

  # Parse the column section of a CREATE TABLE: everything up to the PRIMARY
  # KEY clause, one column per line (our schema file format), skipping frozen
  # collection internals because we split on commas only at line starts.
  defp parse_columns(stmt) do
    body =
      case Regex.run(~r/\((.*?)\)\s*(?:WITH|;|$)/s, stmt, dotall: true) do
        [_full, inner] -> inner
        _ -> ""
      end

    body
    |> String.split("\n")
    |> Enum.map(&String.trim/1)
    |> Enum.reject(&(&1 == "" or String.starts_with?(&1, "PRIMARY KEY")))
    |> Enum.flat_map(fn line ->
      case Regex.run(~r/^(\w+)\s+([a-z0-9_<>,\s()\[\]]+?)\s*(?:,)?$/i, line) do
        [_full, name, type] ->
          # An inline `PRIMARY KEY` suffix is KEY SYNTAX, not part of the
          # type: `name_lower text PRIMARY KEY` declares a text column that
          # is the partition key. Capturing it whole made verify! compare
          # "text primary key" against system_schema's bare "text" — drift on
          # every boot, on a schema apply! had just written itself (the
          # cd8abeb crash loop, 2026-09-16). Strip it; any valid CQL style
          # must be able to boot.
          [{name, collapse_ws(type) |> strip_inline_pk()}]

        _ ->
          []
      end
    end)
    |> Enum.reject(fn {name, _} -> name in ["PRIMARY", "KEY"] end)
  end

  defp collapse_ws(s), do: s |> String.replace(~r/\s+/, " ") |> String.trim()

  defp strip_inline_pk(type), do: String.replace(type, ~r/\s*PRIMARY\s+KEY$/i, "")
end
