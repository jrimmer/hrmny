defmodule Cytale.Backups.Archive do
  @moduledoc """
  The server backup archive (#120) — a logical, app-level image of EVERY
  application table, rebuilt into a running instance by
  `Cytale.Backups.Restore`.

  ## The format is the contract

  One plain tar (the workspace-export feature was removed, but its dependency-free tar writer survives here)
  holding:

    * `manifest.json` — written LAST so its counts and checksums describe the
      completed archive: format + app version, exported-at, the table list
      with per-table row counts and SHA-256 per part, the attachment blob
      list, and the exclusions in plain words.
    * `tables/<table>.jsonl` — one part per application table. The table list
      IS the whitelist: derived from `priv/scylla_schema.cql` through
      `Cytale.Migrations.expected_schema/0`, and restore refuses any table
      not in it. Rows are raw table rows typed by the schema's own column
      types, written oldest-consistent per partition (ScyllaDB returns
      clustering order; restore replays exactly what was read).
    * `attachments/<sha256>` (+ `.meta` sidecars) — blobs copied from the
      content-addressed store. Dedup is free: the store is already
      content-addressed, so a week of dailies carries each distinct blob
      once per archive and the manifest references hashes.
    * `secrets` (inside the manifest) — the live credentials, so a restore is
      COMPLETE (owner decision 2026-09-14): `secret_key_base`, the mailer API
      key, the TURN shared secret, the session-bridge credential, and the SSH
      CA key as PATH + FILE CONTENT (restore must be able to materialise the
      file). Collected through `Cytale.ServerConfig.secret/1` (file > env)
      — the same read path the running consumers use. The manifest says in
      plain words that it contains live credentials; the archive file and its
      sidecar are written 0600.

  ## Memory boundedness

  The same argument #116's export makes, unchanged: the box also runs
  ScyllaDB under a documented memory confinement. Every table read goes
  through `Repo.stream_rows!/3` (`execute!/3` truncates at the first Xandra
  page — the #89 incident class), re-chunked to `:page_size`, each chunk
  encoded and appended line by line with the part's SHA-256 computed
  incrementally. Blobs stream through a fixed 64 KB buffer. The accumulated
  state is O(distinct attachment hashes) — never O(rows).
  """

  alias Cytale.Attachments.Store
  alias Cytale.Backups.Metrics
  alias Cytale.Backups.Tar
  alias Cytale.Repo
  alias Cytale.ServerConfig

  require Logger

  @format "cytale-server-backup"
  @format_version 1
  @driver_page_size 10_000
  @stream_chunk 65_536
  @hash_re ~r/^[0-9a-f]{64}$/
  # The random suffix is base64url (`[A-Za-z0-9_-]`) — the class the regex
  # must accept, or prune would refuse to date REAL archives.
  @id_re ~r/^bk-[0-9]{8}T[0-9]{6}Z-[0-9A-Za-z_-]+$/

  # -- types -------------------------------------------------------------------------

  # The JSON shapes the codec understands, derived from the schema file's own
  # column types. A new CQL type in the schema must be taught here — failing
  # loudly is the point: a backup that silently mangles a column type is worse
  # than one that refuses to build.
  @int_types ~w(bigint int smallint tinyint varint counter)
  @text_types ~w(text varchar ascii)

  @doc "The format marker restore validates against."
  @spec format() :: String.t()
  def format, do: @format

  @doc "The format version restore accepts (this version or older-but-1)."
  @spec format_version() :: pos_integer()
  def format_version, do: @format_version

  # Tables the schema derives but a BACKUP must not carry. `open_calls` indexes
  # the calls that are live RIGHT NOW (hardening plan 4.13): an archive of it is
  # stale by definition because the rooms it names do not survive a restore, and
  # including it actively hurts on the way back —
  #
  #   * the restore's TRUNCATE would wipe the index of the RUNNING node, blinding
  #     the sweep to calls that really are live;
  #   * the replayed rows would re-index calls that no longer exist (the sweep
  #     clears them, but only at the next boot);
  #   * `verify_counts` compares against a table live rooms write, which is not a
  #     fair test: observed under full-suite load as "table open_calls: manifest
  #     says 10 row(s), live table holds 9".
  #
  # Nothing is lost: `Room.open_channel_call/3` re-indexes on the channel's next
  # call, and any open `calls` row is reachable by the boot sweep's backfill.
  #
  # NOTE for an archive written BEFORE this exclusion: it carries an `open_calls`
  # part, and restore refuses a table outside the whitelist. Pre-launch archives
  # are disposable (the same posture as the 4.13 upgrade note in the schema).
  @backup_excluded ~w(open_calls)

  @doc "The table whitelist + column types, derived from the schema file."
  @spec whitelist() :: [{String.t(), [{String.t(), String.t()}]}]
  def whitelist do
    Cytale.Migrations.expected_schema()
    |> Enum.reject(fn {table, _cols} -> table in @backup_excluded end)
  end

  @doc "Build one backup archive. Returns `{:ok, summary}`."
  @spec write(keyword()) :: {:ok, map()}
  def write(opts \\ []) do
    dir = resolve_dir(Keyword.get(opts, :dir))
    page_size = opts |> Keyword.get(:page_size, 500) |> clamp_page_size()
    id = Keyword.get(opts, :id) || new_id()
    tables = whitelist() |> Enum.sort()

    File.mkdir_p!(dir)
    work = Path.join(dir, ".staging-#{id}")
    File.rm_rf!(work)
    File.mkdir_p!(Path.join(work, "tables"))
    File.mkdir_p!(Path.join(work, "attachments"))

    # Hardening plan 4.8: the tar is BUILT INSIDE the staging dir and renamed to
    # its final path only once the sidecar is written. An interrupted run (docker
    # SIGKILLs the container on stop; `stop_grace_period` in compose.yaml now
    # gives it two minutes to finish) therefore leaves a `.staging-<id>/` dir
    # behind, never a PARTIAL `<id>.tar` sitting where a reader would take it for
    # a real archive.
    tar_path = Path.join(dir, "#{id}.tar")
    staged_tar = Path.join(work, "#{id}.tar")
    File.rm(tar_path)

    try do
      summary = build(id, dir, work, staged_tar, tar_path, tables, page_size)
      {:ok, summary}
    rescue
      e ->
        File.rm_rf!(work)
        File.rm(tar_path)
        reraise(e, __STACKTRACE__)
    end
  end

  @doc """
  Reclaim abandoned `.staging-*` build directories (hardening plan 4.8).

  A staging dir is removed by the run that owns it; this is for the runs that
  never got there (a SIGKILL, a host power loss). AGE-GUARDED, because prune
  shares the directory with a backup that may be RUNNING right now: only dirs
  whose mtime is older than `older_than_ms` are touched, and a live build keeps
  writing into its own.
  """
  @spec sweep_staging(String.t(), pos_integer()) :: non_neg_integer()
  def sweep_staging(dir, older_than_ms \\ 6 * 60 * 60 * 1000) do
    cutoff = System.system_time(:millisecond) - older_than_ms

    case File.ls(dir) do
      {:ok, entries} ->
        entries
        |> Enum.filter(&String.starts_with?(&1, ".staging-"))
        |> Enum.count(fn entry ->
          path = Path.join(dir, entry)

          case File.stat(path, time: :posix) do
            {:ok, %{type: :directory, mtime: mtime}} when mtime * 1000 < cutoff ->
              File.rm_rf!(path)
              Logger.info("backup sweep: removed abandoned staging dir #{entry}")
              true

            _ ->
              false
          end
        end)

      {:error, reason} ->
        # "Cannot read the backup root" must not look like "nothing to sweep":
        # the difference is whether abandoned staging dirs are piling up.
        Logger.warning("backup sweep: cannot list #{dir} (#{inspect(reason)}) — nothing swept")
        0
    end
  end

  @safety_dir ".restore-safety"

  @doc """
  The directory holding the KEPT pre-restore safety snapshots (hardening plan
  4.7). A subdirectory of the backup root on purpose: `prune/2` lists only the
  root's `<id>.tar` + sidecar pairs, so a snapshot can never occupy a retention
  slot or be mistaken for a real backup.
  """
  @spec safety_dir(String.t()) :: String.t()
  def safety_dir(dir), do: Path.join(dir, @safety_dir)

  @doc """
  Bound the kept safety snapshots (hardening plan 4.7).

  `Restore.apply_staged/2` writes a FULL-database snapshot before its
  destructive step and keeps it when the restore fails — deliberately, so the
  operator has something to go back to. Nothing else reclaims those files
  (`prune/2` cannot see into the subdirectory and `sweep_staging/2` matches only
  `.staging-*`), so a repeatedly-failing restore leaves one more full archive
  per attempt until the volume fills — at which point `safety_snapshot/0`'s
  rescue degrades to a warning and the NEXT restore proceeds with no safety net
  at all. That is the failure this bounds.

  Keeps the newest `keep` snapshots (ids sort chronologically) with their
  sidecars and removes the rest, and runs the ordinary age-guarded staging
  sweep INSIDE the directory so a snapshot build killed mid-write is reclaimed
  too. Called from the same quiet-time pass as `prune/2`, so a kept snapshot
  survives until the operator has had a chance to use it.
  """
  @spec sweep_safety(String.t(), pos_integer()) :: non_neg_integer()
  def sweep_safety(dir, keep \\ 1) when is_integer(keep) and keep >= 1 do
    safety = safety_dir(dir)

    # Age-guarded, so a snapshot being written RIGHT NOW is untouched.
    _ = sweep_staging(safety)

    case File.ls(safety) do
      {:ok, entries} ->
        entries
        |> Enum.filter(&String.ends_with?(&1, ".tar"))
        |> Enum.filter(&valid_id?(Path.basename(&1, ".tar")))
        |> Enum.sort(:desc)
        |> Enum.drop(keep)
        |> Enum.count(fn stale ->
          id = Path.basename(stale, ".tar")

          case File.rm(Path.join(safety, stale)) do
            :ok ->
              File.rm(Path.join(safety, "#{id}.manifest.json"))
              Logger.info("backup sweep: removed superseded safety snapshot #{id}")
              true

            _ ->
              false
          end
        end)

      _ ->
        0
    end
  end

  # -- the build ---------------------------------------------------------------------

  defp build(id, dir, work, staged_tar, tar_path, tables, page_size) do
    # One paged full-table read per whitelisted table; each part is typed by
    # the schema's own column list and checksummed as it is written. The
    # distinct attachment hashes ride along in the encoder's accumulator.
    {parts_rev, hashes, total_rows} =
      Enum.reduce(tables, {[], MapSet.new(), 0}, fn {table, columns}, {parts, hashes, total} ->
        {rows, sha, hashes} =
          write_table_part(
            Path.join(work, "tables/#{table}.jsonl"),
            columns,
            Repo.stream_rows!("SELECT * FROM #{Repo.keyspace()}.#{table}", [], page_size: page_size),
            page_size,
            hashes
          )

        Logger.info("backup #{id}: table #{table} — #{rows} row(s)")

        part = %{"table" => table, "file" => "tables/#{table}.jsonl", "rows" => rows, "sha256" => sha}

        {[
           part | parts
         ], hashes, total + rows}
      end)

    parts = Enum.reverse(parts_rev)

    {blobs, missing} = copy_attachments(hashes, work)

    secrets = secrets_section()

    manifest =
      manifest(id, tables, parts, total_rows, blobs, missing, secrets)

    manifest_path = Path.join(work, "manifest.json")

    # Mode before content, same rule as the tar: the manifest carries the
    # `secrets_section/0` values, and `File.write!` would otherwise create it at
    # the umask in a 0755 staging dir and only be corrected afterwards.
    File.touch!(manifest_path)
    File.chmod!(manifest_path, 0o600)
    File.write!(manifest_path, Jason.encode!(manifest))

    # The archive's mode is set INSIDE `assemble_tar/4`, immediately after its
    # `File.rm/1` — see the note there for why a chmod at this level cannot work.
    bytes = assemble_tar(staged_tar, work, parts, blobs)

    # The LISTING sidecar: the manifest without the secret VALUES (the
    # /admin/backups list reads these so a listing never touches credentials).
    sidecar = Map.put(manifest, "secrets", %{"notice" => secrets["notice"], "present" => Map.keys(secrets["values"])})

    :ok = ServerConfig.write_atomic(Path.join(dir, "#{id}.manifest.json"), Jason.encode!(sidecar), 0o600)

    # The sidecar EXISTS now, which is what makes the archive real to a reader
    # (`Backups.Scheduler.prune/2` counts only tar+sidecar pairs), so this is the
    # moment the tar may take its final name.
    :ok = File.rename(staged_tar, tar_path)

    File.rm_rf!(work)

    %{
      id: id,
      path: tar_path,
      bytes: bytes,
      rows: total_rows,
      tables: length(parts),
      attachments: %{included: length(blobs), missing: length(missing)},
      secrets: Map.keys(secrets["values"]),
      manifest: sidecar
    }
  end

  # -- the JSONL part writer ----------------------------------------------------------

  # One chunk (≤ page_size rows) in memory at a time; the SHA-256 is computed
  # over the exact bytes as they are appended, so nothing is re-read to
  # checksum it.
  defp write_table_part(path, columns, stream, page_size, hashes0) do
    {rows, ctx, hashes} =
      File.open!(path, [:write, :binary], fn io ->
        stream
        |> Stream.chunk_every(page_size)
        |> Enum.reduce({0, :crypto.hash_init(:sha256), hashes0}, fn chunk, {rows, ctx, hashes} ->
          {lines, hashes} =
            Enum.map_reduce(chunk, hashes, fn row, acc ->
              {[Jason.encode_to_iodata!(encode_row(row, columns)), ?\n], collect_hashes(row, columns, acc)}
            end)

          IO.binwrite(io, lines)
          ctx = :crypto.hash_update(ctx, lines)
          {rows + length(chunk), ctx, hashes}
        end)
      end)

    {rows, Base.encode16(:crypto.hash_final(ctx), case: :lower), hashes}
  end

  # The row JSON: EVERY schema column present, nulls explicit (restore must
  # distinguish "column null" from "column unknown" — the latter is a refusal).
  defp encode_row(row, columns) do
    Map.new(columns, fn {column, type} ->
      {column, encode_value(row[column], type)}
    end)
  end

  defp collect_hashes(row, columns, acc) do
    case Enum.find(columns, fn {c, _t} -> c == "attachments" end) do
      nil ->
        acc

      {"attachments", _type} ->
        row["attachments"]
        |> List.wrap()
        |> Enum.reduce(acc, fn att, acc ->
          case attachment_hash(att) do
            nil -> acc
            h -> MapSet.put(acc, h)
          end
        end)
    end
  end

  # -- the value codec (schema-type-driven) ---------------------------------------------

  @doc false
  def encode_value(nil, _type), do: nil
  def encode_value(v, type) when type in @int_types, do: expect_int!(v, type)
  def encode_value(v, type) when type in @text_types, do: expect_binary!(v, type)
  def encode_value(v, "boolean"), do: expect_boolean!(v)

  def encode_value(%DateTime{} = dt, "timestamp"), do: DateTime.to_iso8601(dt)

  def encode_value(%NaiveDateTime{} = dt, "timestamp"), do: NaiveDateTime.to_iso8601(dt)

  def encode_value(v, "timestamp"), do: raise(ArgumentError, "backup codec: bad timestamp value #{inspect(v)}")

  def encode_value(v, "list<" <> _ = type) do
    inner = inner_type(type)
    Enum.map(expect_list!(v, type), &encode_value(&1, inner))
  end

  def encode_value(v, "map<" <> _ = type) do
    [k_type, v_type] = map_types(type)
    Map.new(expect_map!(v, type), fn {k, val} -> {encode_value(k, k_type), encode_value(val, v_type)} end)
  end

  def encode_value(_v, type), do: raise(ArgumentError, "backup codec: unknown CQL type #{inspect(type)}")

  @doc false
  def decode_value(nil, _type), do: {:ok, nil}

  # The width check is load-bearing, not politeness. The prepared EXECUTE path
  # encodes each bound value by the PREPARED METADATA's type, so an integer that
  # does not fit the column is TRUNCATED by the driver rather than refused:
  # measured on this box, `3_000_000_000` bound for a CQL `int` column lands as
  # `-1294967296`, the row count still matches, and the restore reports success.
  # The offline walk is the only place that sees the value before the
  # destructive step, so the range check has to live here. `varint` is
  # arbitrary-precision and deliberately has no bound.
  def decode_value(v, type) when type in @int_types do
    if is_integer(v) and v >= 0 do
      decode_int_range(v, type)
    else
      {:error, "expected a non-negative integer, got #{inspect(v)}"}
    end
  end

  def decode_value(v, type) when type in @text_types,
    do: if(is_binary(v), do: {:ok, v}, else: {:error, "expected a string, got #{inspect(v)}"})

  def decode_value(v, "boolean"),
    do: if(is_boolean(v), do: {:ok, v}, else: {:error, "expected true/false, got #{inspect(v)}"})

  # from_iso8601 RAISES on bad input (its spec has no :error) — catch it here
  # so a corrupt part reports as a validation error, not a crash.
  def decode_value(v, "timestamp") when is_binary(v) do
    {:ok, dt, _offset} = DateTime.from_iso8601(v)
    {:ok, dt}
  rescue
    _ in ArgumentError -> {:error, "expected an ISO8601 timestamp, got #{inspect(v)}"}
  end

  def decode_value(v, "timestamp"), do: {:error, "expected an ISO8601 timestamp string, got #{inspect(v)}"}

  def decode_value(v, "list<" <> _ = type) when is_list(v) do
    inner = inner_type(type)

    v
    |> Enum.reduce_while({:ok, []}, fn item, {:ok, acc} ->
      case decode_value(item, inner) do
        {:ok, dec} -> {:cont, {:ok, [dec | acc]}}
        {:error, e} -> {:halt, {:error, e}}
      end
    end)
    |> case do
      {:ok, dec} -> {:ok, Enum.reverse(dec)}
      {:error, e} -> {:error, e}
    end
  end

  def decode_value(v, "list<" <> _ = _type), do: {:error, "expected a list, got #{inspect(v)}"}

  def decode_value(v, "map<" <> _ = type) when is_map(v) do
    [k_type, v_type] = map_types(type)

    v
    |> Enum.reduce_while({:ok, %{}}, fn {k, val}, {:ok, acc} ->
      with {:ok, dk} <- decode_value(k, k_type),
           {:ok, dv} <- decode_value(val, v_type) do
        {:cont, {:ok, Map.put(acc, dk, dv)}}
      else
        {:error, e} -> {:halt, {:error, e}}
      end
    end)
    |> case do
      {:ok, dec} -> {:ok, dec}
      {:error, e} -> {:error, e}
    end
  end

  def decode_value(v, "map<" <> _ = _type), do: {:error, "expected an object, got #{inspect(v)}"}

  def decode_value(_v, type), do: {:error, "unknown CQL type #{inspect(type)}"}

  defp expect_int!(v, _type) when is_integer(v), do: v
  defp expect_int!(v, type), do: raise(ArgumentError, "backup codec: #{type} value is not an integer: #{inspect(v)}")

  # The signed maximum of each fixed-width CQL integer. `varint` is absent on
  # purpose: arbitrary precision, no bound.
  @int_max %{
    "tinyint" => 127,
    "smallint" => 32_767,
    "int" => 2_147_483_647,
    "bigint" => 9_223_372_036_854_775_807,
    "counter" => 9_223_372_036_854_775_807
  }

  defp decode_int_range(v, type) do
    case @int_max do
      %{^type => max} when v > max ->
        {:error, "#{v} does not fit CQL #{type} (max #{max}) — the driver would truncate it silently"}

      _ ->
        {:ok, v}
    end
  end

  defp expect_binary!(v, _type) when is_binary(v), do: v

  defp expect_binary!(v, type),
    do: raise(ArgumentError, "backup codec: #{type} value is not a string: #{inspect(v)}")

  defp expect_boolean!(v) when is_boolean(v), do: v

  defp expect_boolean!(v),
    do: raise(ArgumentError, "backup codec: boolean value is not true/false: #{inspect(v)}")

  defp expect_list!(v, _type) when is_list(v), do: v

  defp expect_list!(v, type),
    do: raise(ArgumentError, "backup codec: #{type} value is not a list: #{inspect(v)}")

  defp expect_map!(v, _type) when is_map(v), do: v

  defp expect_map!(v, type),
    do: raise(ArgumentError, "backup codec: #{type} value is not a map: #{inspect(v)}")

  # "list<frozen<map<text, text>>>" → "map<text, text>"; "list<bigint>" → "bigint".
  defp inner_type("list<" <> rest), do: String.replace_suffix(rest, ">", "") |> strip_frozen()
  defp inner_type(type), do: type

  defp strip_frozen("frozen<" <> rest), do: String.replace_suffix(rest, ">", "")
  defp strip_frozen(t), do: t

  # "map<text, text>" → ["text", "text"]. One pass over the charlist tracking
  # angle-bracket depth, splitting at the comma at depth 0 — so a nested
  # collection inside a map type still splits at the RIGHT comma.
  defp map_types(type) do
    "map<" <> rest = type
    inner = String.replace_suffix(rest, ">", "")
    {a, b} = split_top_comma(inner)
    [strip_frozen(String.trim(a)), strip_frozen(String.trim(b))]
  end

  defp split_top_comma(inner), do: do_split_top(String.to_charlist(inner), 0, [])

  defp do_split_top([], _depth, acc), do: {List.to_string(Enum.reverse(acc)), ""}

  defp do_split_top([?< | rest], depth, acc), do: do_split_top(rest, depth + 1, [?< | acc])
  defp do_split_top([?> | rest], depth, acc), do: do_split_top(rest, depth - 1, [?> | acc])

  defp do_split_top([?, | rest], 0, acc), do: {List.to_string(Enum.reverse(acc)), List.to_string(rest)}

  defp do_split_top([char | rest], depth, acc), do: do_split_top(rest, depth, [char | acc])

  # -- secrets -------------------------------------------------------------------------

  @doc """
  The archive's secrets section: every live credential the running instance
  holds, collected through the sanctioned read paths. `ssh_ca_key` carries
  PATH + CONTENT so restore can materialise the FILE.
  """
  @spec secrets_section() :: %{optional(String.t()) => term()}
  def secrets_section do
    values =
      %{}
      |> maybe_put("secret_key_base", endpoint_secret_key_base())
      |> maybe_put("mailer_api_key", ServerConfig.secret("mailer_api_key"))
      |> maybe_put("turn_secret", ServerConfig.secret("turn_secret"))
      |> maybe_put("session_bridge_credential", ServerConfig.secret("session_bridge_credential"))
      |> maybe_put_ssh_ca()

    %{
      "notice" =>
        "THIS ARCHIVE CONTAINS LIVE CREDENTIALS: it can send mail as this instance, mint SSH " <>
          "certificates, derive TURN credentials, and sign sessions. It was written 0600 on the " <>
          "backups volume; downloads are operator-gated. Store any copy no more openly.",
      "values" => values
    }
  end

  defp endpoint_secret_key_base do
    case Application.get_env(:cytale, CytaleWeb.Endpoint) do
      kw when is_list(kw) -> present_binary(Keyword.get(kw, :secret_key_base))
      %{} = m -> present_binary(m[:secret_key_base])
      _ -> nil
    end
  end

  defp maybe_put_ssh_ca(values) do
    case ServerConfig.secret("ssh_ca_key_path") do
      nil ->
        values

      path when is_binary(path) ->
        entry = %{"path" => path}

        entry =
          case File.read(path) do
            {:ok, content} -> Map.put(entry, "content", Base.encode64(content))
            _ -> entry
          end

        Map.put(values, "ssh_ca_key", entry)
    end
  end

  defp present_binary(v) when is_binary(v) and byte_size(v) > 0, do: v
  defp present_binary(_), do: nil

  defp maybe_put(map, _k, nil), do: map
  defp maybe_put(map, k, v), do: Map.put(map, k, v)

  # -- attachments -----------------------------------------------------------------------

  # The stored descriptor is a string map (url/filename/content_type/size + optional id);
  # the content address is the URL's last segment (or the explicit id) when it is a
  # content hash. The same rule #116's export applies.
  defp attachment_hash(att) when is_map(att) do
    from_url =
      case att["url"] do
        url when is_binary(url) ->
          h = url |> String.split("/") |> List.last()
          if Regex.match?(@hash_re, h), do: h, else: nil

        _ ->
          nil
      end

    from_url ||
      case att["id"] do
        h when is_binary(h) -> if Regex.match?(@hash_re, h), do: h, else: nil
        _ -> nil
      end
  end

  defp attachment_hash(_), do: nil

  # Copy each referenced blob + its .meta sidecar ONCE, verifying the content
  # address while copying. A blob the store no longer holds is recorded as
  # missing — never silently dropped, never fatal (the message row still names
  # the hash; the manifest is the honest record).
  defp copy_attachments(hashes, work) do
    hashes
    |> MapSet.to_list()
    |> Enum.sort()
    |> Enum.reduce({[], []}, fn hash, {blobs, missing} ->
      src = Store.path(hash)

      case File.stat(src) do
        {:ok, %{size: size}} when size >= 0 ->
          dst = Path.join(work, "attachments/#{hash}")
          sha = stream_copy(src, dst)

          if sha == hash do
            meta = if File.exists?(src <> ".meta"), do: File.read!(src <> ".meta"), else: nil
            if meta, do: File.write!(Path.join(work, "attachments/#{hash}.meta"), meta)

            {[
               %{"file" => "attachments/#{hash}", "hash" => hash, "size" => size, "sha256" => sha}
               | blobs
             ], missing}
          else
            File.rm(dst)
            {blobs, [%{"hash" => hash, "reason" => "content did not match its hash in the store"} | missing]}
          end

        _ ->
          {blobs, [%{"hash" => hash, "reason" => "not found in the attachment store at backup time"} | missing]}
      end
    end)
    |> then(fn {b, m} -> {Enum.reverse(b), Enum.reverse(m)} end)
  end

  # Fixed 64 KB buffer: the blob is never whole in memory; SHA-256 rides the same pass.
  defp stream_copy(src, dst) do
    ctx =
      File.open!(src, [:read, :binary], fn s ->
        File.open!(dst, [:write, :binary], fn d ->
          s
          |> IO.binstream(@stream_chunk)
          |> Enum.reduce(:crypto.hash_init(:sha256), fn chunk, ctx ->
            IO.binwrite(d, chunk)
            :crypto.hash_update(ctx, chunk)
          end)
        end)
      end)

    Base.encode16(:crypto.hash_final(ctx), case: :lower)
  end

  # -- the manifest -----------------------------------------------------------------------

  defp manifest(id, tables, parts, total_rows, blobs, missing, secrets) do
    %{
      "format" => @format,
      "format_version" => @format_version,
      "app_version" => app_version(),
      "backup_id" => id,
      "keyspace" => Repo.keyspace(),
      "exported_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "tables" => Map.new(parts, fn part -> {part["table"], part} end),
      "totals" => %{"tables" => length(tables), "rows" => total_rows},
      "attachments" => %{
        "blobs" => blobs,
        "missing" => missing,
        "note" =>
          "blobs are keyed by their content hash; message rows reference them by that hash. " <>
            "A blob the store no longer holds is listed under \"missing\" rather than dropped silently."
      },
      "secrets" => secrets,
      "exclusions" => %{
        "search_index" =>
          "The search index is DERIVED data, rebuildable from the messages table; it is not part " <>
            "of the archive. Restore triggers the search rebuild automatically.",
        "scylla_system_schema" =>
          "The database's own system schema (replication settings, compaction, topology) is NOT " <>
            "included — this is an app-level logical backup. Only the application tables are.",
        "host_state" =>
          "Anything on the host outside this application and the attachments volume — the proxy " <>
            "config, the eturnal settings, SSH host keys, cron, the operating system itself — is " <>
            "NOT included. Restore brings the APP back, not the machine.",
        "live_call_index" =>
          "The live-call index (`open_calls`) is RUNTIME state, not data: it names the calls that " <>
            "are live at the moment of the backup, and those calls do not survive a restore. It is " <>
            "rebuilt as calls start (and by the boot sweep), so it is not in the archive."
      },
      "scope" => %{
        "direct_messages" =>
          "INCLUDED. Unlike the member-facing workspace export (#116) — which excludes DMs as " <>
            "other people's private data — this is the operator's whole-instance backup: the DM " <>
            "tables (dm_channels, dms_of_user) and DM messages ride in the messages table like " <>
            "every other channel. Operator-gated for that reason.",
        "deleted_rows" =>
          "Rows deleted before the backup are ABSENT, not tombstoned: the archive is a faithful " <>
            "image of the tables at backup time. Counts and part rows agree by construction."
      },
      "manifest_note" =>
        "This manifest is written LAST: its row counts and sha256 checksums describe the completed " <>
          "archive. Verify a part by hashing its bytes and comparing."
    }
  end

  defp app_version, do: Application.spec(:cytale, :vsn) |> to_string()

  # -- tar assembly ------------------------------------------------------------------------

  # Manifest first (0600 — the credentials notice is not idle), then the parts
  # and blobs. Content streams from disk through fixed buffers.
  defp assemble_tar(tar_path, work, parts, blobs) do
    File.rm(tar_path)

    # Hardening plan 4.9: the archive holds LIVE CREDENTIALS (config values and
    # secrets — owner-visible decision 2026-09-14), so it must be 0600 from its
    # first byte. The mode has to be set HERE, after the `File.rm/1` above and
    # before the open: `File.rm` discards any file a caller pre-touched, and
    # `File.open!(path, [:write, :binary])` creates a fresh inode at the process
    # umask (0644 under the default 022) when the file does not exist. Setting it
    # before `File.open!` is what makes the open REUSE the 0600 inode.
    #
    # Measured, not assumed: the first attempt at this fix chmod-ed before
    # calling this function, and the `rm` here threw that away — the archive sat
    # at 0644 for its whole life while the comment claimed no window remained.
    File.touch!(tar_path)
    File.chmod!(tar_path, 0o600)

    manifest_data = File.read!(Path.join(work, "manifest.json"))

    File.open!(tar_path, [:write, :binary], fn io ->
      Tar.append_entry(io, "manifest.json", {:data, manifest_data}, mode: "600")
      # Directories need the traverse (x) bit or extraction cannot create the
      # files inside them — the FILES are the secrets (0600), not the dirs.
      Tar.append_entry(io, "tables/", :dir, mode: "700")

      Enum.each(parts, fn part ->
        path = Path.join(work, part["file"])
        Tar.append_entry(io, part["file"], {:file, path, File.stat!(path).size}, mode: "600")
      end)

      Tar.append_entry(io, "attachments/", :dir, mode: "700")

      Enum.each(blobs, fn blob ->
        path = Path.join(work, blob["file"])
        Tar.append_entry(io, blob["file"], {:file, path, File.stat!(path).size}, mode: "600")

        meta_path = path <> ".meta"

        if File.exists?(meta_path) do
          Tar.append_entry(io, blob["file"] <> ".meta", {:file, meta_path, File.stat!(meta_path).size}, mode: "600")
        end
      end)

      # Two zero blocks end the archive (the POSIX minimum).
      IO.binwrite(io, :binary.copy(<<0>>, 1024))
    end)

    File.stat!(tar_path).size
  end

  # -- listing ------------------------------------------------------------------------------

  @doc """
  Every finished backup, newest first, from the listing sidecars: id, created
  at, byte size, table/row totals, secret keys present. NEVER the secret
  values — the sidecar omits them by construction.
  """
  @spec list(String.t() | nil) :: [map()]
  def list(dir \\ nil) do
    dir = resolve_dir(dir)

    case File.ls(dir) do
      {:ok, files} ->
        files
        |> Enum.filter(&String.ends_with?(&1, ".manifest.json"))
        |> Enum.sort(:desc)
        |> Enum.map(fn sidecar ->
          id = String.replace_suffix(sidecar, ".manifest.json", "")
          tar = Path.join(dir, "#{id}.tar")

          case File.read(Path.join(dir, sidecar)) do
            {:ok, raw} ->
              case Jason.decode(raw) do
                {:ok, manifest} ->
                  %{
                    "id" => id,
                    "created_at" => manifest["exported_at"],
                    "bytes" => file_size(tar),
                    "tables" => get_in(manifest, ["totals", "tables"]),
                    "rows" => get_in(manifest, ["totals", "rows"]),
                    "secrets" => manifest["secrets"],
                    "format_version" => manifest["format_version"]
                  }

                :error ->
                  %{"id" => id, "bytes" => file_size(tar), "error" => "unreadable manifest sidecar"}
              end

            _ ->
              %{"id" => id, "bytes" => file_size(tar), "error" => "unreadable manifest sidecar"}
          end
        end)

      _ ->
        []
    end
  end

  defp file_size(path) do
    case File.stat(path) do
      {:ok, %{size: size}} -> size
      _ -> nil
    end
  end

  # -- ids / dirs -----------------------------------------------------------------------------

  @doc "A new backup id: sortable timestamp + random suffix (`bk-20260914T191530Z-ab12cd34`)."
  @spec new_id() :: String.t()
  def new_id do
    ts = DateTime.utc_now() |> Calendar.strftime("%Y%m%dT%H%M%SZ")
    "bk-" <> ts <> "-" <> Base.url_encode64(:crypto.strong_rand_bytes(6), padding: false)
  end

  @doc "True when `id` has the backup-id shape (download-path safety: no traversal)."
  @spec valid_id?(term()) :: boolean()
  def valid_id?(id) when is_binary(id), do: Regex.match?(@id_re, id)
  def valid_id?(_), do: false

  @doc "The backup root: the explicit dir, else the file-only `backups.dir` config, absolute."
  @spec resolve_dir(String.t() | nil) :: String.t()
  def resolve_dir(nil), do: Path.absname(ServerConfig.backup_dir())
  def resolve_dir(dir) when is_binary(dir) and dir != "", do: Path.absname(dir)
  def resolve_dir(_), do: resolve_dir(nil)

  defp clamp_page_size(n) when is_integer(n) and n > 0, do: min(n, @driver_page_size)
  defp clamp_page_size(_), do: 500

  # Metrics is touched here only to guarantee its table exists before the first
  # run records into it (a test may run the archive without the scheduler).
  @doc false
  def ensure_metrics, do: Metrics.init()
end
