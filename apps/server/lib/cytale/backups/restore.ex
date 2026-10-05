defmodule Cytale.Backups.Restore do
  @moduledoc """
  The restore half of #120: upload → exhaustive validation → stage → marker →
  restart into RESTORE MODE, where a supervised restore runs before the
  endpoint serves.

  ## Why restart rather than live-restore

  A live restore would serve half-restored state. Restore-mode is the classic
  pattern: the operator's POST never touches live data — it VALIDATES and
  STAGES, writes a marker naming the staged archive, and calls
  `Cytale.ServerConfig.initiate_restart/0` (the same graceful stop #121's
  restart route uses; the compose policy / dev watchdog brings the node
  back). The next boot sees the marker and boots WITHOUT the endpoint until
  the restore has fully applied.

  ## The boot flow (wired in `Cytale.Application`)

    1. `marker_present?/0` — no marker: normal boot, nothing here runs.
    2. Marker present: the supervision tree starts WITHOUT `CytaleWeb.Endpoint`
       (and without the backup scheduler — a backup must never run mid-restore)
       and one supervised task runs `complete_boot/0`:
         * validate the staged archive AGAIN (the marker could name a damaged
           file; validation failure = REFUSE TO SERVE, loudly, with the staged
           archive intact — a failed restore must never half-apply);
         * truncate every whitelisted app table, replay the rows (prepared
           INSERTs), verify per-table counts against the manifest;
         * materialise the secrets section through
           `Cytale.ServerConfig.write_secrets/1` (0600, boot-read with
           precedence over env) — including the SSH CA key FILE and
           `secret_key_base`, so sign-in survives;
         * trigger the search rebuild (`Cytale.Search.Rebuild` — the index is
           derived and was never in the archive);
         * clear the marker, THEN start the endpoint in the tree. The instance
           comes up WORKING.
    3. Any failure: the marker is annotated `failed` (errors recorded), a
       CRITICAL line logs, and the node stays up WITHOUT serving — inspectable,
       not crash-looping, and every retry path (fix the archive, remove the
       marker, restart) stays in the operator's hands.

  ## Validation is enumerated, not vibes

  Every failure names its check:

    * manifest: readable JSON, right `format`, `format_version` not NEWER than
      this build understands (older-than-minimum is a refusal too);
    * per-part SHA-256 over the exact bytes on disk;
    * table whitelist against `priv/scylla_schema.cql` (the schema file IS the
      whitelist — a table the archive names outside it is refused outright, as
      is any table part the manifest does not declare);
    * per-row shape against the table's known columns (unknown column = refuse;
      per-column type checked by the same codec that wrote it);
    * row-count sanity: each part's actual line count equals the manifest's;
    * attachment hash verification: every blob hashes to its own name.

  ## Memory boundedness

  Validation streams every part line by line (`File.stream!` + incremental
  SHA-256) — one line, one hash context. Replay uses prepared statements, one
  row at a time. Nothing table-sized is ever in memory.
  """

  alias Cytale.Backups.Archive
  alias Cytale.Repo
  alias Cytale.ServerConfig

  require Logger

  @format Archive.format()
  @min_format_version 1
  @max_format_version Archive.format_version()
  @stream_chunk 65_536

  # The explicit confirm token the POST body must carry — a destructive surface
  # is not confirmed by `{}`.
  @confirm_token "REPLACE-ALL-DATA"

  @member_re ~r{^[A-Za-z0-9_][A-Za-z0-9_/.-]*$}

  @type errors :: [%{required(:check) => String.t(), required(:message) => String.t()}]

  # -- the marker -------------------------------------------------------------------

  @doc "The restore marker: beside the config file, on the same durable volume."
  @spec marker_path() :: String.t()
  def marker_path do
    Path.join(Path.dirname(ServerConfig.config_path()), "restore-marker.json")
  end

  @spec marker_present?() :: boolean()
  def marker_present?, do: File.regular?(marker_path())

  @spec read_marker() :: map() | nil
  def read_marker do
    case File.read(marker_path()) do
      {:ok, raw} ->
        case Jason.decode(raw) do
          {:ok, %{} = marker} -> marker
          _ -> nil
        end

      _ ->
        nil
    end
  end

  @spec clear_marker() :: :ok
  def clear_marker do
    File.rm(marker_path())
    :ok
  end

  defp write_marker(marker) do
    case ServerConfig.write_atomic(marker_path(), Jason.encode!(marker), 0o600) do
      :ok -> :ok
      {:error, reason} -> raise "restore marker could not be written: #{inspect(reason)}"
    end
  end

  # -- intake: stage + mark -----------------------------------------------------------

  @doc """
  The POST body's confirm token. Exported so the controller and its tests
  never diverge on the literal.
  """
  @spec confirm_token() :: String.t()
  def confirm_token, do: @confirm_token

  @doc "The restore upload size cap (bytes); file-only config, default 10 GB."
  @spec max_restore_bytes() :: pos_integer()
  def max_restore_bytes do
    case Application.get_env(:cytale, :backups, []) do
      kw when is_list(kw) ->
        case Keyword.get(kw, :max_restore_bytes) do
          n when is_integer(n) and n > 0 -> n
          _ -> 10 * 1_024 * 1_024 * 1_024
        end

      %{} = m ->
        case m[:max_restore_bytes] do
          n when is_integer(n) and n > 0 -> n
          _ -> 10 * 1_024 * 1_024 * 1_024
        end

      _ ->
        10 * 1_024 * 1_024 * 1_024
    end
  end

  @doc """
  Take an archive from the host (`path` — the v1 intake is a staged-path form:
  the operator drops the archive on the host and names it; an in-request
  upload through Phoenix would buffer a restore-sized body in the VM), copy
  it to the durable staged location, extract, and validate. On success write
  the MARKER naming the staged archive. Live data is never touched.

  Returns `{:ok, marker}` or `{:error, {:check_name, [%{check, message}]}}`.
  """
  @spec stage(String.t(), keyword()) ::
          {:ok, map()} | {:error, {:staging, errors()}} | {:error, {:validation, errors()}}
  def stage(path, opts \\ []) when is_binary(path) do
    cond do
      not File.regular?(path) ->
        {:error, {:staging, [%{check: "archive", message: "no readable file at #{path}"}]}}

      true ->
        %{size: size} = File.stat!(path)

        if size > max_restore_bytes() do
          {:error,
           {:staging, [%{check: "size", message: "archive is #{size} bytes; the cap is #{max_restore_bytes()}"}]}}
        else
          stage_valid(path, opts)
        end
    end
  end

  defp stage_valid(path, opts) do
    root = Path.join(Archive.resolve_dir(Keyword.get(opts, :dir)), "staged")
    id = Keyword.get(opts, :id) || Archive.new_id()
    tar = Path.join(root, "#{id}.tar")
    extract_dir = Path.join(root, id)

    File.rm_rf!(extract_dir)
    File.rm(tar)
    File.mkdir_p!(root)

    try do
      # Durable copy first: the marker must name a file that outlives this boot.
      stream_copy(path, tar)
      File.chmod!(tar, 0o600)

      case extract(tar, extract_dir) do
        :ok ->
          case validate_dir(extract_dir) do
            :ok ->
              {:ok, manifest} = read_manifest(extract_dir)

              marker = %{
                "status" => "staged",
                "archive" => tar,
                "staged_dir" => extract_dir,
                "created_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
                "format_version" => manifest["format_version"],
                # The summary rides the marker for the boot log; NEVER the
                # secret values.
                "totals" => %{
                  "tables" => manifest["totals"]["tables"],
                  "rows" => manifest["totals"]["rows"]
                }
              }

              write_marker(marker)
              {:ok, marker}

            {:error, errors} ->
              {:error, {:validation, errors}}
          end

        {:error, errors} ->
          {:error, {:staging, errors}}
      end
    rescue
      e -> {:error, {:staging, [%{check: "staging", message: Exception.message(e)}]}}
    end
  end

  # -- extraction ------------------------------------------------------------------------

  defp extract(tar, dir) do
    case safe_members(tar) do
      {:ok, _names} ->
        case :erl_tar.extract(tar, [{:cwd, dir}]) do
          :ok -> :ok
          {:error, reason} -> {:error, [%{check: "extract", message: "tar extraction failed: #{inspect(reason)}"}]}
        end

      {:error, errors} ->
        {:error, errors}
    end
  end

  # Path-traversal guard of our own, before erl_tar sees the file: every member
  # must be a relative, plain, sane name. `..`, absolute paths, and oddballs
  # refuse BEFORE anything touches disk.
  defp safe_members(tar) do
    case :erl_tar.table(String.to_charlist(tar), [:compressed]) do
      {:ok, members} ->
        # Without :verbose the table is bare names (charlists); match both
        # shapes so a future :verbose flag cannot silently break the guard.
        names =
          Enum.map(members, fn
            name when is_list(name) -> List.to_string(name)
            {_kind, name, _info} -> List.to_string(name)
          end)

        bad = Enum.find(names, fn name -> not Regex.match?(@member_re, name) or String.contains?(name, "..") end)

        if bad do
          {:error, [%{check: "members", message: "unsafe tar member name: #{inspect(bad)}"}]}
        else
          {:ok, names}
        end

      {:error, reason} ->
        {:error, [%{check: "tar", message: "not a readable tar archive: #{inspect(reason)}"}]}
    end
  end

  # -- validation -------------------------------------------------------------------------

  @doc """
  Exhaustively validate an EXTRACTED archive directory. `:ok` or
  `{:error, errors}` — never raises, never touches the database.

  "Exhaustively" is load-bearing: every part's checksum and line count are
  checked, every row must carry EXACTLY the schema's columns for its table, and
  every value is decoded with the archive codec against its column's declared
  type. That is what makes the destructive step in `apply_staged/2` safe to run
  at all — see the invariant documented there.

  KNOWN CONSEQUENCE of the exact-columns rule (hardening plan 4.7): the expected
  column set is the LIVE schema's, so an archive whose table predates a column
  added since is REFUSED rather than restored with that column null. That is the
  deliberate direction — `Archive.encode_row/2` writes every column precisely so a
  restore can tell "null" from "absent", and a silent null is the corruption this
  rule exists to prevent — but two `format_version: 1` archives are therefore not
  equally restorable, and a future column addition is a restore-compatibility
  event worth naming in the release notes.
  """
  @spec validate_dir(String.t()) :: :ok | {:error, errors()}
  def validate_dir(dir) do
    errors =
      with_manifest(dir, fn manifest ->
        manifest_errors(manifest) ++
          tables_errors(dir, manifest) ++
          attachments_errors(dir, manifest)
      end)

    case errors do
      [] -> :ok
      errors -> {:error, errors}
    end
  end

  defp with_manifest(dir, fun) do
    case File.read(Path.join(dir, "manifest.json")) do
      {:ok, raw} ->
        case Jason.decode(raw) do
          {:ok, %{} = manifest} -> fun.(manifest)
          _ -> [%{check: "manifest", message: "manifest.json is not a JSON object"}]
        end

      _ ->
        [%{check: "manifest", message: "manifest.json is missing or unreadable"}]
    end
  end

  defp manifest_errors(manifest) do
    cond do
      manifest["format"] != @format ->
        [%{check: "format", message: "expected format #{@format}, got #{inspect(manifest["format"])}"}]

      not is_integer(manifest["format_version"]) ->
        [%{check: "version", message: "format_version must be an integer, got #{inspect(manifest["format_version"])}"}]

      manifest["format_version"] > @max_format_version ->
        [
          %{
            check: "version",
            message:
              "archive format v#{manifest["format_version"]} is NEWER than this server understands " <>
                "(v#{@max_format_version}) — upgrade this server before restoring"
          }
        ]

      manifest["format_version"] < @min_format_version ->
        [%{check: "version", message: "format_version #{manifest["format_version"]} is below the supported minimum"}]

      not is_map(manifest["tables"]) or map_size(manifest["tables"]) == 0 ->
        [%{check: "tables", message: "manifest lists no tables"}]

      true ->
        []
    end
  end

  defp tables_errors(dir, manifest) do
    whitelist = Archive.whitelist() |> Map.new(fn {t, cols} -> {t, cols} end)
    manifest_tables = manifest["tables"]

    unknown =
      manifest_tables
      |> Map.keys()
      |> Enum.reject(&Map.has_key?(whitelist, &1))

    on_disk = dir_tables(dir)

    undeclared = Enum.reject(on_disk, &Map.has_key?(manifest_tables, &1))

    cond do
      unknown != [] ->
        [
          %{
            check: "whitelist",
            message:
              "archive names table(s) NOT in this server's schema whitelist " <>
                "(#{Enum.map_join(unknown, ", ", &inspect/1)}) — refusing: nothing outside " <>
                "priv/scylla_schema.cql is ever restored"
          }
        ]

      undeclared != [] ->
        [
          %{
            check: "agreement",
            message:
              "archive holds table part(s) the manifest does not declare: " <>
                Enum.map_join(undeclared, ", ", &inspect/1)
          }
        ]

      true ->
        Enum.flat_map(manifest_tables, fn {table, spec} -> table_errors(dir, table, spec, whitelist[table]) end)
    end
  end

  defp dir_tables(dir) do
    case File.ls(Path.join(dir, "tables")) do
      {:ok, files} ->
        files |> Enum.filter(&String.ends_with?(&1, ".jsonl")) |> Enum.map(&Path.basename(&1, ".jsonl"))

      _ ->
        []
    end
  end

  # Per-table: the part exists, its byte checksum matches, its actual line
  # count equals the manifest's, and every line is a row of KNOWN columns in
  # valid shape for those columns' types.
  defp table_errors(dir, table, spec, columns) do
    path = Path.join(dir, "tables/#{table}.jsonl")

    cond do
      not is_map(spec) ->
        [%{check: "manifest", message: "table #{table}: entry must be an object"}]

      not File.regular?(path) ->
        [%{check: "part", message: "table #{table}: part file is missing"}]

      true ->
        actual_sha = file_sha256(path)

        sha_errors =
          if actual_sha == spec["sha256"] do
            []
          else
            [
              %{
                check: "checksum",
                message:
                  "table #{table}: part checksum mismatch (manifest #{inspect(spec["sha256"])}, actual #{actual_sha})"
              }
            ]
          end

        sha_errors ++ row_errors(path, table, columns, spec)
    end
  end

  # Streaming pass: one line, one decode, one hash update. This is the
  # row-count sanity AND the per-row shape check in a single bounded-memory
  # walk.
  defp row_errors(path, table, columns, spec) do
    column_map = Map.new(columns || [], fn {c, t} -> {c, t} end)

    {count, _ctx, errors} =
      path
      |> File.stream!([:read, :binary, read_ahead: @stream_chunk])
      |> Enum.reduce({0, :crypto.hash_init(:sha256), []}, fn line, {n, ctx, errs} ->
        ctx = :crypto.hash_update(ctx, line)

        case row_error(line, table, column_map) do
          nil ->
            {n + 1, ctx, errs}

          message when length(errs) < 10 ->
            {n + 1, ctx, [%{check: "row", message: "table #{table} line #{n + 1}: #{message}"} | errs]}

          _message ->
            {n + 1, ctx, errs}
        end
      end)

    count_errors =
      if count == spec["rows"] do
        []
      else
        [%{check: "rows", message: "table #{table}: manifest says #{spec["rows"]} row(s), part holds #{count}"}]
      end

    Enum.reverse(errors) ++ count_errors
  end

  defp row_error(line, table, column_map) do
    case Jason.decode(String.trim_trailing(line, "\n")) do
      {:ok, %{} = row} ->
        unknown = row |> Map.keys() |> Enum.reject(&Map.has_key?(column_map, &1))
        missing = column_map |> Map.keys() |> Enum.reject(&Map.has_key?(row, &1))

        cond do
          unknown != [] ->
            "unknown column(s) #{Enum.map_join(unknown, ", ", &inspect/1)} — not in the schema for #{table}"

          # The writer's contract (`Archive.encode_row/2`) is that EVERY schema
          # column is present with nulls explicit, precisely so a restore can tell
          # "column is null" from "column is absent". Checking only the unknown
          # direction left the other half unenforced: `replay_all/2` reads
          # `row[column]`, so an absent column restored as NULL silently, with a
          # matching row count and no error anywhere. Hardening plan 4.7.
          missing != [] ->
            "missing column(s) #{Enum.map_join(missing, ", ", &inspect/1)} — every schema column " <>
              "must be present; nulls are explicit"

          true ->
            Enum.find_value(row, fn {column, value} ->
              case Archive.decode_value(value, Map.fetch!(column_map, column)) do
                {:ok, _} -> nil
                {:error, message} -> "column #{inspect(column)}: #{message}"
              end
            end)
        end

      _ ->
        "not a JSON object line"
    end
  end

  defp attachments_errors(dir, manifest) do
    manifest["attachments"]["blobs"]
    |> List.wrap()
    |> Enum.flat_map(fn blob ->
      path = Path.join(dir, blob["file"])
      hash = blob["hash"]

      cond do
        not is_binary(hash) ->
          [%{check: "attachments", message: "blob entry without a hash: #{inspect(blob["file"])}"}]

        not File.regular?(path) ->
          [%{check: "attachments", message: "blob #{hash} is missing from the archive"}]

        file_sha256(path) != hash ->
          [%{check: "attachments", message: "blob #{hash}: content does not hash to its name"}]

        true ->
          []
      end
    end)
  end

  defp file_sha256(path) do
    ctx =
      File.open!(path, [:read, :binary], fn f ->
        f
        |> IO.binstream(@stream_chunk)
        |> Enum.reduce(:crypto.hash_init(:sha256), &:crypto.hash_update(&2, &1))
      end)

    Base.encode16(:crypto.hash_final(ctx), case: :lower)
  end

  # -- apply (boot restore-mode) -------------------------------------------------------------

  @doc """
  Restore from the CURRENT marker. Runs in the boot task while the endpoint
  is NOT in the tree: validate again → truncate → replay → verify →
  materialise secrets → rebuild search → clear marker. Any failure returns
  `{:error, errors}` and the caller refuses to serve.
  """
  @spec complete_boot() :: :ok | {:error, errors()}
  def complete_boot do
    marker = read_marker()

    if marker do
      case apply_staged(marker["staged_dir"], marker) do
        :ok ->
          :ok

        {:error, errors} ->
          annotate_failed(marker, errors)
          {:error, errors}
      end
    else
      {:error, [%{check: "marker", message: "restore marker vanished before the restore ran"}]}
    end
  end

  # The boot task body (Cytale.Application passes the supervisor it started
  # under): apply the restore, then add the endpoint — and the backup
  # scheduler — back into the tree. On ANY failure the node stays up WITHOUT
  # serving: a CRITICAL logs now and every 60s after, and the marker (with
  # the recorded errors) plus the intact staged archive wait for the operator.
  @spec boot_task(module()) :: :ok | :refused
  def boot_task(supervisor \\ Cytale.Supervisor) do
    case restore_boot() do
      :ok ->
        Logger.warning("RESTORE: applied cleanly — starting the endpoint, the node serves again")

        {:ok, _} = Supervisor.start_child(supervisor, CytaleWeb.Endpoint)
        {:ok, _} = Supervisor.start_child(supervisor, Cytale.Backups.Scheduler)

        :ok

      {:error, errors} ->
        refuse_loudly(errors)
        :refused
    end
  end

  # A release boot skips the apply-schema-on-boot flag; a restore replays into
  # the CURRENT schema, so apply idempotently first. Unreachable ScyllaDB is
  # caught — refusing to serve is the only honest answer to "cannot reach the
  # database I am about to replace".
  defp restore_boot do
    :ok = Cytale.Migrations.apply!()
    complete_boot()
  rescue
    e -> {:error, [%{check: "schema", message: "schema could not be applied before restore: " <> Exception.message(e)}]}
  end

  defp refuse_loudly(errors) do
    detail = Enum.map_join(errors, "\n  ", fn e -> "[#{e.check}] #{e.message}" end)
    marker = marker_path()

    Logger.critical(
      "RESTORE REFUSED — the staged archive FAILED and the node will NOT serve " <>
        "(a failed restore must never half-apply).\n  #{detail}\n  " <>
        "The staged archive is intact (see #{marker}). Fix it, remove the marker, and " <>
        "restart to retry — or restore from another archive."
    )

    # The refusal must stay loud long after the boot lines scroll away.
    :timer.apply_interval(
      60_000,
      Logger,
      :critical,
      ["RESTORE REFUSED — this node is UP but NOT SERVING (restore marker present; last attempt failed). See #{marker}"]
    )

    :ok
  end

  defp annotate_failed(marker, errors) do
    failed =
      marker
      |> Map.put("status", "failed")
      |> Map.put("failed_at", DateTime.utc_now() |> DateTime.to_iso8601())
      |> Map.put("errors", Enum.map(errors, fn e -> %{"check" => e.check, "message" => e.message} end))

    # Best-effort: the boot log carries the same errors either way.
    _ = ServerConfig.write_atomic(marker_path(), Jason.encode!(failed), 0o600)
    :ok
  end

  @doc """
  Apply an extracted (or extractable) staged archive to the LIVE database:
  validate first, then truncate, then replay, then verify. The caller owns the
  DB pool.

  THE INVARIANT (hardening plan 4.7): nothing destructive runs until
  `validate_dir/1` has passed. Truncating first and discovering at row N of
  table 40 that the payload cannot be applied leaves live data gone, half
  restored, and the node up-but-dark — the worst state in the system, reached
  from the one code path whose entire job is recovery.

  `validate_dir/1` therefore has to be able to answer the question offline, and
  it does: checksum and line count per part, the table's exact schema columns per
  row, the archive codec's type check per value, and a hash check per attachment.

  What no offline check can cover, and how each is handled: a connection lost
  mid-replay, and a filesystem that fills while attachments are copied. Both are
  infrastructure failures, so the posture is the one already in place — the error
  is returned, the marker is NOT cleared (the node refuses to serve and the boot
  retries), and the staged archive is still on disk to re-apply.
  """
  @spec apply_staged(String.t(), map() | nil) :: :ok | {:error, errors()}
  def apply_staged(dir, marker \\ nil) do
    with :ok <- validate_dir(dir) do
      {:ok, manifest} = read_manifest(dir)
      started = System.monotonic_time(:millisecond)

      Logger.warning(
        "RESTORE: applying staged archive #{Path.basename(to_string(marker && marker["archive"]))} " <>
          "(#{manifest["totals"]["tables"]} table(s), #{manifest["totals"]["rows"]} row(s)) — " <>
          "live data is being replaced"
      )

      # Hardening plan 4.7: the destructive step follows, and until now a replay
      # failure at row N left live data truncated and half-applied with nothing
      # to go back to. Snapshot the CURRENT state first; it is deleted once
      # `verify_counts` passes and KEPT (its path reported) on any failure.
      snapshot = safety_snapshot()

      with_snapshot_note(
        try do
          truncate_app_tables!()
          errors = replay_all(dir, manifest)

          case errors do
            [] ->
              attachment_errors = restore_attachments(dir, manifest)
              :ok = recount_attachment_bytes()

              case attachment_errors do
                [] ->
                  case verify_counts(manifest) do
                    :ok ->
                      materialize_secrets(manifest)
                      rebuild_search()
                      clear_marker_if_matches(marker)
                      discard_snapshot(snapshot)

                      Logger.warning(
                        "RESTORE: complete in #{System.monotonic_time(:millisecond) - started}ms — " <>
                          "marker cleared, search rebuilt"
                      )

                      :ok

                    {:error, errors} ->
                      {:error, errors}
                  end

                errors ->
                  {:error, errors}
              end

            errors ->
              {:error, errors}
          end
        rescue
          e -> {:error, [%{check: "apply", message: Exception.message(e)}]}
        end,
        snapshot
      )
    end
  end

  defp read_manifest(dir) do
    with {:ok, raw} <- File.read(Path.join(dir, "manifest.json")),
         {:ok, manifest} <- Jason.decode(raw) do
      {:ok, manifest}
    else
      _ -> raise "manifest.json unreadable in staged archive"
    end
  end

  # -- pre-restore safety snapshot (hardening plan 4.7) ----------------------------

  # The snapshot lives in a SUBDIRECTORY of the backup root: `prune/2` lists only
  # the root's `*.tar` + sidecar pairs, so a snapshot can never occupy a
  # retention slot or be mistaken for a real backup, and `sweep_staging/2` never
  # sees it. A snapshot failure is a WARNING, not a refusal: refusing a restore
  # because the disk is full is the disaster the operator is already recovering
  # from, and the archive is still validated before the truncate.
  defp safety_snapshot do
    # `Archive.safety_dir/1` owns the name: the quiet-time sweep that bounds
    # this directory (plan 4.7) reads the same helper, so the writer and the
    # reclaimer cannot drift.
    dir = Cytale.Backups.Archive.safety_dir(Cytale.Backups.Archive.resolve_dir(nil))

    # `Archive.write/1` returns `{:ok, summary}` and RAISES on failure, so the
    # rescue below is the only failure path there is.
    {:ok, %{path: path}} = Cytale.Backups.Archive.write(dir: dir)
    Logger.warning("RESTORE: pre-restore snapshot written to #{path}")
    path
  rescue
    e ->
      Logger.warning("RESTORE: pre-restore snapshot failed (#{Exception.message(e)}) — continuing")
      nil
  end

  defp discard_snapshot(nil), do: :ok

  defp discard_snapshot(path) do
    File.rm(path)
    File.rm(String.replace_suffix(path, ".tar", ".manifest.json"))
    :ok
  end

  defp with_snapshot_note({:error, errors}, nil), do: {:error, errors}

  defp with_snapshot_note({:error, errors}, path),
    do: {:error, errors ++ [%{check: "pre_restore_snapshot", message: "kept for recovery at #{path}"}]}

  defp with_snapshot_note(other, _path), do: other

  @doc "Truncate every whitelisted app table (the destructive step)."
  @spec truncate_app_tables!() :: :ok
  def truncate_app_tables! do
    ks = Repo.keyspace()

    Archive.whitelist()
    |> Enum.each(fn {table, _cols} ->
      truncate_with_retry("#{ks}.#{table}")
    end)

    :ok
  end

  # A 49-table sweep is many sequential round trips; a container's connection
  # can drop mid-sweep (seen once as seastar closed_error). One quick retry
  # keeps a transient blip from failing an otherwise clean restore — TRUNCATE
  # is idempotent, so a retry can never double-apply.
  @max_truncate_retries 2

  defp truncate_with_retry(stmt, attempts \\ @max_truncate_retries) do
    Repo.execute!("TRUNCATE #{stmt}", [], timeout: 60_000)
  rescue
    e in [Xandra.Error, Xandra.ConnectionError] ->
      if attempts <= 0, do: reraise(e, __STACKTRACE__)

      Logger.warning("truncate #{stmt} failed (#{Exception.message(e)}) — retrying (#{attempts} left)")
      Process.sleep(500)
      truncate_with_retry(stmt, attempts - 1)
  end

  defp replay_all(dir, manifest) do
    ks = Repo.keyspace()
    whitelist = Archive.whitelist() |> Map.new()

    manifest["tables"]
    |> Enum.flat_map(fn {table, _spec} ->
      columns = whitelist[table]
      # The replay lives on the DELTAS of a truncated table: for every ordinary
      # table an INSERT restores the row, and for a counter table (hardening plan
      # 4.3 made `reaction_counts.count` one) CQL refuses INSERT outright — so it
      # replays as `SET c = c + ?`, which lands the archived value exactly
      # because the truncate already took the table to zero.
      {statement, bound_columns} = replay_shape(ks, table, columns)
      {:ok, prepared} = Repo.prepare(statement, timeout: 30_000)

      dir
      |> Path.join("tables/#{table}.jsonl")
      |> File.stream!([:read, :binary, read_ahead: @stream_chunk])
      |> Enum.flat_map(fn line ->
        {:ok, row} = Jason.decode(String.trim_trailing(line, "\n"))

        values =
          Enum.map(bound_columns, fn {column, type} ->
            {:ok, decoded} = Archive.decode_value(row[column], type)
            decoded
          end)

        case Repo.execute_prepared(prepared, values, timeout: 30_000) do
          {:ok, _} -> []
          {:error, err} -> [%{check: "replay", message: "table #{table}: #{Exception.message(err)}"}]
        end
      end)
    end)
  end

  # Quote EVERY identifier: the schema legitimately carries the reserved
  # words "allow"/"deny", and quoted lowercase is byte-identical to bare
  # lowercase for every other column.
  defp insert_statement(ks, table, columns) do
    names = Enum.map_join(columns, ", ", fn {c, _t} -> ~s("#{c}") end)
    marks = Enum.map_join(columns, ", ", fn _ -> "?" end)

    "INSERT INTO #{ks}.\"#{table}\" (#{names}) VALUES (#{marks})"
  end

  # Which statement replays this table, and in which order its values bind.
  #
  # A COUNTER table cannot be INSERTed ("INSERT statements are not allowed on
  # counter tables, use UPDATE instead"), so it replays as one delta per row with
  # the primary key in the WHERE clause. The key columns are not in the archive —
  # it stores values, not schema — so they come from the live schema, which is
  # also where their kind and order live. The bound order is the STATEMENT's:
  # the SET columns first, then the key columns.
  defp replay_shape(ks, table, columns) do
    if Enum.any?(columns, fn {_c, type} -> type == "counter" end) do
      keys = key_columns(ks, table)
      sets = Enum.reject(columns, fn {c, _t} -> c in keys end)

      bound =
        sets ++
          Enum.map(keys, fn key -> Enum.find(columns, fn {c, _t} -> c == key end) end)

      {counter_update_statement(ks, table, sets, keys), bound}
    else
      {insert_statement(ks, table, columns), columns}
    end
  end

  defp counter_update_statement(ks, table, sets, keys) do
    set_clause = Enum.map_join(sets, ", ", fn {c, _t} -> ~s("#{c}" = "#{c}" + ?) end)
    where_clause = Enum.map_join(keys, " AND ", fn key -> ~s("#{key}" = ?) end)

    "UPDATE #{ks}.\"#{table}\" SET #{set_clause} WHERE #{where_clause}"
  end

  defp key_columns(ks, table) do
    Repo.stream_rows!(
      "SELECT column_name, kind, position FROM system_schema.columns WHERE keyspace_name = ? AND table_name = ?",
      [{"text", ks}, {"text", table}]
    )
    |> Enum.filter(fn row -> row["kind"] in ["partition_key", "clustering"] end)
    |> Enum.sort_by(fn row -> {row["kind"] == "clustering", row["position"]} end)
    |> Enum.map(& &1["column_name"])
  end

  # One COUNT per table — an aggregate, not a materialized set (the same
  # discipline Scan.count_messages uses per bucket).
  # Blobs go back into the content-addressed store under their hash (idempotent
  # by construction), with their .meta sidecars — the store serves
  # content-type/filename from the sidecar, so a restore that dropped it would
  # half-work. Any mismatch is a restore error, not a silent skip.
  defp restore_attachments(dir, manifest) do
    manifest["attachments"]["blobs"]
    |> List.wrap()
    |> Enum.flat_map(fn blob ->
      hash = blob["hash"]
      src = Path.join(dir, blob["file"])

      cond do
        not is_binary(hash) ->
          [%{check: "attachments", message: "blob entry without a hash: #{inspect(blob["file"])}"}]

        file_sha256(src) != hash ->
          [%{check: "attachments", message: "blob #{hash}: content does not hash to its name"}]

        true ->
          File.mkdir_p!(Cytale.Attachments.Store.root())
          File.cp!(src, Cytale.Attachments.Store.path(hash))

          meta_src = src <> ".meta"

          if File.regular?(meta_src) do
            File.cp!(meta_src, Cytale.Attachments.Store.path(hash) <> ".meta")
          end

          []
      end
    end)
  end

  # The attachment restore copies blobs STRAIGHT into the store (`File.cp!` —
  # the blobs are already on disk in the archive, so reading them into memory to
  # go through `Store.put/3` would be worse), which leaves the store's running
  # byte counter stale. One recount after the loop re-derives it (hardening plan
  # 5.11).
  defp recount_attachment_bytes do
    Cytale.Attachments.Store.recount()
    :ok
  end

  defp verify_counts(manifest) do
    ks = Repo.keyspace()

    errors =
      manifest["tables"]
      |> Enum.flat_map(fn {table, spec} ->
        rows =
          Repo.execute!("SELECT COUNT(*) AS n FROM #{ks}.#{table}", [], timeout: 60_000)
          |> Enum.to_list()

        actual =
          case rows do
            [%{"n" => n}] when is_integer(n) -> n
            _ -> -1
          end

        if actual == spec["rows"] do
          []
        else
          [
            %{
              check: "verify",
              message: "table #{table}: manifest says #{spec["rows"]} row(s), live table holds #{actual}"
            }
          ]
        end
      end)

    case errors do
      [] -> :ok
      errors -> {:error, errors}
    end
  end

  # Secrets: the special ssh_ca_key entry becomes the FILE (path + content);
  # everything else goes through write_secrets/1 — the #121 seam that
  # validates, writes 0600, and applies (including secret_key_base into the
  # endpoint's config, so sign-in machinery survives the restore).
  defp materialize_secrets(manifest) do
    case manifest["secrets"]["values"] do
      values when is_map(values) and map_size(values) > 0 ->
        values = materialize_ssh_ca_key(values)

        case ServerConfig.write_secrets(values) do
          :ok ->
            Logger.warning("RESTORE: secrets materialised (#{map_size(values)} key(s), 0600)")

          {:error, errors} ->
            Logger.error(
              "RESTORE: secrets.json REJECTED (#{inspect(errors)}) — the restored instance " <>
                "will come up on env credentials"
            )
        end

      _ ->
        Logger.warning("RESTORE: archive carries no secrets section values — env credentials stay authoritative")
    end

    :ok
  end

  defp materialize_ssh_ca_key(values) do
    case values["ssh_ca_key"] do
      %{"path" => path, "content" => b64} when is_binary(path) and is_binary(b64) ->
        target = write_ca_key_file(path, Base.decode64!(b64))
        values |> Map.put("ssh_ca_key_path", target) |> Map.delete("ssh_ca_key")

      %{"path" => path} when is_binary(path) ->
        values |> Map.put("ssh_ca_key_path", path) |> Map.delete("ssh_ca_key")

      _ ->
        values
    end
  end

  # Write the CA key at ITS path; when that path is not writable on this host,
  # fall back beside secrets.json and let the applied value point there.
  defp write_ca_key_file(path, content) do
    if write_0600(path, content) do
      path
    else
      fallback = Path.join(Path.dirname(ServerConfig.secrets_path()), "ssh_ca_key")
      :ok = write_0600!(fallback, content)

      Logger.warning("RESTORE: SSH CA key could not be written at #{path} — materialised at #{fallback} instead")

      fallback
    end
  end

  defp write_0600(path, content) do
    case File.mkdir_p(Path.dirname(path)) do
      :ok ->
        case File.write(path, content) do
          :ok ->
            File.chmod(path, 0o600)
            true

          _ ->
            false
        end

      _ ->
        false
    end
  end

  defp write_0600!(path, content) do
    File.mkdir_p!(Path.dirname(path))
    File.write!(path, content)
    File.chmod!(path, 0o600)
    :ok
  end

  # The search index was never in the archive (derived data): restore triggers
  # the #89 rebuild for every restored workspace. A rebuild failure is logged
  # loud and NON-fatal (the data is intact; the drift check names the gap).
  defp rebuild_search do
    ks = Repo.keyspace()

    workspace_ids =
      Repo.stream_rows!("SELECT workspace_id FROM #{ks}.workspaces", [], page_size: 1_000)
      |> Enum.map(& &1["workspace_id"])

    Enum.each(workspace_ids, fn ws_id ->
      # rebuild/2's spec is {:ok, map} — a crash is the failure mode the
      # rescue owns; any other shape would be a match error, caught the same.
      try do
        {:ok, stats} = Cytale.Search.Rebuild.rebuild(ws_id)
        Logger.info("RESTORE: search rebuild ran for workspace #{ws_id} (#{stats.messages} document(s))")
      rescue
        e -> Logger.error("RESTORE: search rebuild FAILED for workspace #{ws_id}: #{Exception.message(e)}")
      end
    end)

    :ok
  end

  defp clear_marker_if_matches(marker) do
    current = read_marker()

    if marker == nil or current == marker do
      clear_marker()
    else
      Logger.warning("RESTORE: marker changed during apply — leaving it for inspection")
    end

    :ok
  end

  # -- helpers ---------------------------------------------------------------------------

  defp stream_copy(src, dst) do
    File.open!(src, [:read, :binary], fn s ->
      File.open!(dst, [:write, :binary], fn d ->
        s |> IO.binstream(@stream_chunk) |> Enum.each(&IO.binwrite(d, &1))
      end)
    end)
  end
end
