defmodule Cytale.Backups.ArchiveRestoreTest do
  @moduledoc """
  #120 — the archive format, the enumerated validation refusals, and THE
  ROUND TRIP, which is the acceptance:

      seed a real workspace (channels, messages incl. a thread, an attachment
      through the REAL store) → backup → WIPE the app tables (truncate) →
      run boot-restore from the archive → the pre-backup message is readable,
      the attachment fetches by hash, the search rebuild ran, and the
      sign-in machinery (secret_key_base) was RESTORED, not regenerated.

  The validation-failure tests prove each refusal happens WITHOUT touching
  live data: tampered checksum, unknown table, version too new, truncated
  archive file. The paging proof drives page_size 2 across a 5-row table —
  every row crossing a page boundary exported (the #89 trap).
  """

  use Cytale.ScyllaCase, async: false
  @moduletag timeout: 1_500_000

  alias Cytale.Accounts.User
  alias Cytale.Attachments.Store
  alias Cytale.Backups.{Archive, Restore}
  alias Cytale.Search.Scan
  alias Cytale.{Messages, Workspaces}

  setup do
    # Random suffixes: fresh test VMs restart unique_integer's counter, and a
    # reused tmp name would find stale archives/markers from an earlier run.
    tmp = Path.join(System.tmp_dir!(), "cytale_bk_arch_#{rand()}")
    att_tmp = Path.join(System.tmp_dir!(), "cytale_bk_att_#{rand()}")
    idx_tmp = Path.join(System.tmp_dir!(), "cytale_bk_idx_#{rand()}")

    File.mkdir_p!(tmp)
    File.mkdir_p!(att_tmp)
    File.mkdir_p!(idx_tmp)

    backups_env = Application.get_env(:cytale, :backups)
    att_env = Application.get_env(:cytale, :attachments_root)
    cfg_env = Application.get_env(:cytale, Cytale.Config)
    endpoint_env = Application.get_env(:cytale, CytaleWeb.Endpoint)
    secrets_env = Application.get_env(:cytale, :server_secrets)
    config_path_env = Application.get_env(:cytale, :server_config_path)

    Application.put_env(:cytale, :attachments_root, att_tmp)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(cfg_env || [], :search_index_root, idx_tmp))

    # The marker + the secrets file live beside the config path; point THAT at
    # the test tmp so restore's durable writes never touch a real file.
    Application.put_env(:cytale, :server_config_path, Path.join(tmp, "server-config.json"))

    {:ok, author} =
      User.create("bka_" <> Cytale.TestNonce.get(), "bka_#{Cytale.TestNonce.get()}@example.com", "password-123")

    {:ok, peer} =
      User.create("bkb_" <> Cytale.TestNonce.get(), "bkb_#{Cytale.TestNonce.get()}@example.com", "password-123")

    on_exit(fn ->
      Application.put_env(:cytale, :backups, backups_env)
      Application.put_env(:cytale, :attachments_root, att_env)
      Application.put_env(:cytale, Cytale.Config, cfg_env)
      Application.put_env(:cytale, CytaleWeb.Endpoint, endpoint_env)
      Application.put_env(:cytale, :server_secrets, secrets_env)
      restore_env(:server_config_path, config_path_env)
      File.rm_rf!(tmp)
      File.rm_rf!(att_tmp)
      File.rm_rf!(idx_tmp)
    end)

    {:ok, author: author, peer: peer, tmp: tmp}
  end

  defp restore_env(_key, nil), do: Application.delete_env(:cytale, :server_config_path)
  defp restore_env(key, value), do: Application.put_env(:cytale, key, value)

  defp rand, do: :crypto.strong_rand_bytes(8) |> Base.encode16(case: :lower)

  defp nonce, do: Cytale.TestNonce.get()

  # -- fixtures ------------------------------------------------------------------

  defp seed_workspace(%{author: author, peer: peer}) do
    {:ok, ws} = Workspaces.create_workspace(author.user_id, "BackupRT " <> nonce())
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, random} = Workspaces.create_channel(ws.workspace_id, "random")
    :ok = Workspaces.add_member(ws.workspace_id, peer.user_id, author.user_id)

    {:ok, root} =
      Messages.create_message(%{
        channel_id: general.channel_id,
        author_id: author.user_id,
        content: "the pre-backup message"
      })

    {:ok, other} =
      Messages.create_message(%{channel_id: general.channel_id, author_id: peer.user_id, content: "other root"})

    {:ok, reply} =
      Messages.create_message(%{
        channel_id: general.channel_id,
        author_id: author.user_id,
        content: "a reply",
        reply_to_id: other.id
      })

    {:ok, thread} = Cytale.Threads.Thread.create(general.channel_id, root.id, "thread on root", author.user_id)

    {:ok, tr1} =
      Messages.create_message(%{
        channel_id: general.channel_id,
        author_id: peer.user_id,
        content: "thread reply 1",
        thread_id: thread.thread_id
      })

    for i <- 1..2 do
      {:ok, _} =
        Messages.create_message(%{channel_id: random.channel_id, author_id: author.user_id, content: "rand #{i}"})
    end

    # A REACTION, so the counter tally table has a row to carry: since hardening
    # plan 4.3 `reaction_counts.count` is a `counter`, which CQL refuses to
    # replay with INSERT — the restore path replays it as a delta instead, and
    # this is the fixture that proves it (two reactions, one from each member).
    :ok = Cytale.Messages.Reactions.add(general.channel_id, root.id, author.user_id, "👍")
    :ok = Cytale.Messages.Reactions.add(general.channel_id, root.id, peer.user_id, "👍")

    # An attachment through the REAL store, referenced by the root message.
    blob = "backup fixture payload " <> (:crypto.strong_rand_bytes(64) |> Base.encode64())
    {:ok, descriptor} = Store.put(blob, "notes.txt", "text/plain")

    {:ok, _att_msg} =
      Messages.create_message(%{
        channel_id: general.channel_id,
        author_id: author.user_id,
        content: "with file",
        attachments: [descriptor]
      })

    %{
      ws: ws.workspace_id,
      general: general.channel_id,
      random: random.channel_id,
      thread_id: thread.thread_id,
      root_id: root.id,
      other_id: other.id,
      reply_id: reply.id,
      tr1_id: tr1.id,
      blob: blob,
      blob_hash: Store.hash(blob),
      message_count: 7
    }
  end

  defp secret_mailer_key do
    key = "mk-120-#{nonce()}"
    Application.put_env(:cytale, :server_secrets, %{"mailer_api_key" => key})
    key
  end

  defp build_backup(tmp, opts \\ []) do
    assert {:ok, summary} = Archive.write(Keyword.merge([dir: tmp], opts))
    summary
  end

  defp extract(tar_path, dest) do
    File.mkdir_p!(dest)
    :ok = :erl_tar.extract(String.to_charlist(tar_path), [{:cwd, dest}])
    dest
  end

  defp read_manifest(dir) do
    {:ok, raw} = File.read(Path.join(dir, "manifest.json"))
    {:ok, manifest} = Jason.decode(raw)
    manifest
  end

  defp write_manifest(dir, manifest), do: File.write!(Path.join(dir, "manifest.json"), Jason.encode!(manifest))

  # ==============================================================================
  # THE ARCHIVE FORMAT
  # ==============================================================================

  test "the archive carries the manifest contract: format, secrets notice, exclusions, DM scope", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    assert summary.tables > 40, "every app table in the whitelist gets a part"
    assert summary.rows > 0
    assert String.starts_with?(summary.id, "bk-")

    # The archive FILE is 0600 (hardening plan 4.9: it carries live credentials).
    # This assertion is the reason the fix works at all: the first attempt chmod-ed
    # the path BEFORE `assemble_tar/4`, whose `File.rm/1` discarded that file — so
    # the archive was created at the process umask (0644) and nothing failed. The
    # mode has to be asserted on the artifact, not on the code that means to set it.
    %{mode: archive_mode} = File.stat!(summary.path)
    assert Bitwise.band(archive_mode, 0o777) == 0o600

    # The listing SIDECAR never carries secret values.
    assert summary.manifest["secrets"]["notice"] =~ "LIVE CREDENTIALS"
    assert Map.has_key?(summary.manifest["secrets"], "present")
    refute Map.has_key?(summary.manifest["secrets"], "values")

    dir = extract(summary.path, Path.join(tmp, "inspect"))
    manifest = read_manifest(dir)

    assert manifest["format"] == "cytale-server-backup"
    assert manifest["format_version"] == 1
    assert manifest["keyspace"] == Cytale.Repo.keyspace()

    # SECRETS ARE IN the archive (owner decision 2026-09-14) — with the
    # plain-words credentials notice.
    assert manifest["secrets"]["notice"] =~ "LIVE CREDENTIALS"

    assert manifest["secrets"]["values"]["mailer_api_key"] ==
             Application.get_env(:cytale, :server_secrets)["mailer_api_key"]

    skb = Application.get_env(:cytale, CytaleWeb.Endpoint) |> Keyword.get(:secret_key_base)
    assert manifest["secrets"]["values"]["secret_key_base"] == skb

    # Exclusions + scope, stated in plain words.
    assert manifest["exclusions"]["search_index"] =~ "DERIVED"
    assert manifest["exclusions"]["scylla_system_schema"] =~ "NOT"
    assert manifest["exclusions"]["host_state"] =~ "NOT"
    assert manifest["scope"]["direct_messages"] =~ "INCLUDED"

    # Parts are on disk where the manifest says, with matching names.
    Enum.each(manifest["tables"], fn {table, spec} ->
      assert File.regular?(Path.join(dir, spec["file"])), "part for #{table}"
      assert spec["sha256"] =~ ~r/^[0-9a-f]{64}$/
    end)

    # The attachment blob rides the archive, keyed by its content hash.
    assert [%{"hash" => hash}] = manifest["attachments"]["blobs"]
    assert File.regular?(Path.join(dir, "attachments/#{hash}"))
    assert File.regular?(Path.join(dir, "attachments/#{hash}.meta"))
  end

  test "paging proof: rows crossing page boundaries all exported (page_size 2)", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})

    # 5 channel messages total (3 general + 2 random); pages of 2 → every
    # boundary crossed; `execute!` would have truncated at 10k, a page_size
    # of 2 proves the stream walks to the END. The archive holds the WHOLE
    # keyspace (other tests' rows ride along), so the assert is: the manifest
    # count equals the part's actual lines AND covers this workspace's rows.
    summary = build_backup(tmp, page_size: 2)

    dir = extract(summary.path, Path.join(tmp, "inspect"))
    manifest = read_manifest(dir)

    manifest_rows = manifest["tables"]["messages"]["rows"]
    assert manifest_rows >= seed.message_count

    lines =
      dir
      |> Path.join("tables/messages.jsonl")
      |> File.stream!()
      |> Enum.count()

    assert lines == manifest_rows

    # The same pass that counts validates: a fresh extract validates clean.
    dir2 = extract(summary.path, Path.join(tmp, "inspect2"))
    assert :ok = Restore.validate_dir(dir2)
  end

  # ==============================================================================
  # THE ROUND TRIP — the acceptance
  # ==============================================================================

  test "backup → wipe → boot-restore: the instance serves the pre-backup world", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    original_skb = Application.get_env(:cytale, CytaleWeb.Endpoint) |> Keyword.get(:secret_key_base)
    mailer_key = secret_mailer_key()

    # 1. BACKUP (through the real intake: stage + marker).
    summary = build_backup(tmp)
    assert {:ok, marker} = Restore.stage(summary.path, dir: tmp)
    assert marker["status"] == "staged"
    assert Restore.marker_present?()

    # 2. THE WIPE — the disaster.
    :ok = Restore.truncate_app_tables!()
    assert is_nil(Messages.get_message(seed.general, seed.root_id))

    # 3. Sabotage the sign-in machinery, as a regeneration would: the restore
    #    must put the ORIGINAL back, not keep the replacement.
    Application.put_env(
      :cytale,
      CytaleWeb.Endpoint,
      Keyword.put(Application.get_env(:cytale, CytaleWeb.Endpoint), :secret_key_base, "regenerated-not-the-original")
    )

    # 4. BOOT-RESTORE: validate → truncate → replay → verify → attachments →
    #    secrets → search rebuild.
    assert :ok = Restore.apply_staged(marker["staged_dir"], marker)

    # The pre-restore SAFETY SNAPSHOT (hardening plan 4.7) was taken — the
    # restore reaches this line only through it — and DISCARDED once
    # `verify_counts` passed: the directory exists (the snapshot was written
    # into it) and holds no archive now. The FAILURE half of the gate — a replay
    # failure KEEPS the snapshot and names it — is its own test below; the
    # refusal tests cannot cover it, because every one of them is stopped by
    # `validate_dir` before the destructive step and so never needs a snapshot.
    safety_dir = Path.join(Cytale.Backups.Archive.resolve_dir(nil), ".restore-safety")
    assert File.dir?(safety_dir), "the pre-restore snapshot was never taken"
    assert File.ls!(safety_dir) == [], "a successful restore left its safety snapshot behind"

    # 5. THE INSTANCE SERVES: the pre-backup message is readable.
    restored = Messages.get_message(seed.general, seed.root_id)
    assert restored && restored.content == "the pre-backup message"

    # The reaction tally came back — a COUNTER table, replayed as a delta.
    assert Cytale.Messages.Reactions.summary(seed.general, seed.root_id) == [
             %{emoji: "👍", count: 2}
           ]

    # The thread + reply structure came back.
    reply = Messages.get_message(seed.general, seed.reply_id)
    assert reply && reply.content == "a reply" && reply.reply_to_id == seed.other_id

    tr1 = Messages.get_message(seed.general, seed.tr1_id)
    assert tr1 && tr1.content == "thread reply 1" && tr1.thread_id == seed.thread_id

    # The attachment fetches BY HASH, with its metadata sidecar.
    assert {:ok, blob} = Store.get(seed.blob_hash)
    assert blob == seed.blob
    assert {:ok, meta} = Store.get_meta(seed.blob_hash)
    assert meta["content_type"] == "text/plain"

    # The search rebuild RAN: the index holds the restored messages.
    assert {:ok, searcher} = Scan.index_searcher(seed.ws)
    assert Scan.index_document_count(searcher) >= seed.message_count

    # Sign-in machinery: secret_key_base RESTORED (not regenerated), the
    # mailer key rides the secrets file (0600), and secret/1 serves it.
    current_skb = Application.get_env(:cytale, CytaleWeb.Endpoint) |> Keyword.get(:secret_key_base)
    assert current_skb == original_skb
    assert Cytale.ServerConfig.secret("secret_key_base") == original_skb
    assert Cytale.ServerConfig.secret("mailer_api_key") == mailer_key

    %{mode: mode} = File.stat!(Cytale.ServerConfig.secrets_path())
    # stat's mode carries the file-type bits too (0o100600) — mask to perms.
    assert Bitwise.band(mode, 0o777) == 0o600

    # The marker was cleared on success — the node boots normally from here.
    refute Restore.marker_present?()
  end

  # ==============================================================================
  # VALIDATION REFUSALS — each refuses cleanly WITHOUT touching live data
  # ==============================================================================

  # Plan 4.7. The plan's stated failure was "a type failure at row N of table 40";
  # that one is already impossible (the row walk decodes every value with the
  # archive codec, so a type failure IS a validation failure — measured, not
  # assumed). The reachable half of the same hazard is a row missing a column:
  # `replay_all/2` reads `row[column]`, so an absent column restored as NULL with
  # a matching row count, no error and no trace — while the writer's contract
  # (`Archive.encode_row/2`) is that every column is present, nulls explicit.
  test "a payload with a row missing a column refuses BEFORE the destructive step", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "missing_col"))
    manifest = read_manifest(dir)

    # A payload that is otherwise perfect: valid JSON, right line count, and the
    # checksum repaired so this cannot pass or fail on a checksum technicality.
    path = Path.join(dir, "tables/channels.jsonl")
    lines = File.read!(path) |> String.split("\n", trim: true)
    assert length(lines) >= 2

    dropped = lines |> Enum.at(1) |> Jason.decode!() |> Map.delete("workspace_id")
    assert Map.has_key?(dropped, "name")

    lines = List.replace_at(lines, 1, Jason.encode!(dropped))
    File.write!(path, Enum.join(lines, "\n") <> "\n")
    manifest = put_in(manifest, ["tables", "channels", "sha256"], sha256_of(path))
    write_manifest(dir, manifest)

    # Refused, and refused on the row — naming the column and its line.
    assert {:error, errors} = Restore.validate_dir(dir)

    assert Enum.any?(errors, fn e ->
             e.check == "row" and String.contains?(e.message, "line 2") and
               String.contains?(e.message, "workspace_id")
           end)

    # ...and the destructive entry point refuses for the same reason. Order
    # matters: had the assertion above failed, this test would already have
    # aborted, so a pre-fix run cannot truncate anything on its way to failing.
    assert {:error, apply_errors} = Restore.apply_staged(dir)
    assert Enum.any?(apply_errors, &(&1.check == "row"))

    # Live data intact, which is the plan's actual requirement.
    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  # Plan 4.7's own claim is that "a type failure IS a validation failure — the
  # row walk decodes every value with the archive codec". For a narrow CQL
  # integer that claim was FALSE, and silently so. The codec only required a
  # non-negative integer, while the prepared EXECUTE path encodes each bound
  # value by the PREPARED METADATA's type — so an out-of-range value is
  # TRUNCATED by the driver rather than refused. Measured directly against
  # ScyllaDB on this box before the range check existed: `3_000_000_000` bound
  # for an `int` column landed as `-1294967296`, the row count still matched, and
  # `apply_staged/2` returned `:ok`. A restore could therefore corrupt data and
  # report success.
  #
  # That makes this the plan's stated hazard after all, and it is the shape the
  # gate needs: a value that passes every structural check and still cannot be
  # applied. It has to be caught by the OFFLINE pass, because by the time the
  # replay could notice, the truncate has already happened.
  test "an out-of-range integer for a narrow CQL type refuses BEFORE the destructive step", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "int_range"))
    manifest = read_manifest(dir)

    path = Path.join(dir, "tables/author_messages.jsonl")
    lines = File.read!(path) |> String.split("\n", trim: true)
    assert lines != [], "the fixture wrote no locator rows to corrupt"

    # `author_messages.bucket` is a CQL `int` (the key is author_id/message_id),
    # so the row keeps its key, its shape and its count, and only this one value
    # is past 2^31.
    corrupt = lines |> hd() |> Jason.decode!() |> Map.put("bucket", 3_000_000_000)
    File.write!(path, Enum.join([Jason.encode!(corrupt) | tl(lines)], "\n") <> "\n")

    manifest = put_in(manifest, ["tables", "author_messages", "sha256"], sha256_of(path))
    write_manifest(dir, manifest)

    # Refused by the OFFLINE walk, naming the column, the value and the bound.
    assert {:error, errors} = Restore.validate_dir(dir)

    assert Enum.any?(errors, fn e ->
             e.check == "row" and String.contains?(e.message, "bucket") and
               String.contains?(e.message, "3000000000") and String.contains?(e.message, "int")
           end),
           "expected the row walk to refuse the wide value, got #{inspect(errors)}"

    # ...and the destructive entry point refuses for the same reason, BEFORE the
    # truncate. Order matters: the assertion above must fail first, so a pre-fix
    # run cannot reach this line and truncate on its way to failing.
    assert {:error, apply_errors} = Restore.apply_staged(dir)
    assert Enum.any?(apply_errors, &(&1.check == "row"))
    refute Enum.any?(apply_errors, &(&1.check == "replay"))

    # Live data intact — the pre-fix path had already destroyed it by now.
    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  # Plan 4.7, the FAILURE half — the one the refusals above cannot reach.
  #
  # Every refusal above is caught by `validate_dir`, i.e. BEFORE
  # `truncate_app_tables!`, so none of them can show what the operator has left
  # once the destructive step has already run. The snapshot exists for exactly
  # that window, so the gate has to fail a restore INSIDE it.
  #
  # The injection is a duplicated row in a part file. The manifest's checksum and
  # line count are repaired, so the OFFLINE pass is clean — but the two lines
  # share a primary key, so the replay's INSERT overwrites and the live table
  # ends one row short of what the manifest promises. That fails in
  # `verify_counts` — after the truncate, after the replay, after the
  # attachments — which is precisely the window the snapshot covers.
  test "a post-replay verification failure keeps the safety snapshot and names its path", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "verify_fail"))
    manifest = read_manifest(dir)

    path = Path.join(dir, "tables/workspaces.jsonl")
    lines = File.read!(path) |> String.split("\n", trim: true)
    assert lines != [], "the fixture wrote no workspace rows to duplicate"

    rows = manifest["tables"]["workspaces"]["rows"]
    assert rows == length(lines)

    # One row, twice: same key, so the count cannot move.
    File.write!(path, Enum.join(lines ++ [hd(lines)], "\n") <> "\n")

    manifest =
      manifest
      |> put_in(["tables", "workspaces", "sha256"], sha256_of(path))
      |> put_in(["tables", "workspaces", "rows"], rows + 1)
      |> update_in(["totals", "rows"], &(&1 + 1))

    write_manifest(dir, manifest)

    # The offline pass is clean: checksum, line count, every row valid. Asserted,
    # not assumed — if this stops passing, the test no longer proves anything
    # about the failure half.
    assert :ok = Restore.validate_dir(dir)

    safety_dir = Path.join(Archive.resolve_dir(nil), ".restore-safety")

    # The shared safety dir is repo-local and gitignored, and the round-trip test
    # asserts it is EMPTY after a successful restore. Clean up on exit so test
    # order cannot decide whether that assertion holds.
    on_exit(fn -> File.rm_rf!(safety_dir) end)

    assert {:error, errors} = Restore.apply_staged(dir)

    # 1. The failure is the post-replay verification, so the truncate and the
    #    replay have already run: the snapshot has something worth keeping.
    assert Enum.any?(errors, &(&1.check == "verify")),
           "expected a verify error, got #{inspect(errors)}"

    refute Enum.any?(errors, &(&1.check == "row"))

    # 2. The snapshot was KEPT (the success path discards it) and the error NAMES
    #    it, so an operator reading the boot log or the failed marker does not
    #    have to guess where recovery lives.
    note = Enum.find(errors, &(&1.check == "pre_restore_snapshot"))
    assert note, "the failure did not report the safety snapshot: #{inspect(errors)}"
    assert note.message =~ "kept for recovery at"

    assert [snapshot] = Path.wildcard(Path.join(safety_dir, "*.tar")),
           "the safety snapshot was not kept on disk under #{safety_dir}"

    assert note.message =~ snapshot
    assert File.stat!(snapshot).size > 0

    # 3. It is a real archive, not a half-written file, and it still holds the
    #    world the truncate destroyed — the recovery the plan asks for, not
    #    merely a file on disk.
    snap = extract(snapshot, Path.join(tmp, "safety_extract"))
    assert :ok = Restore.validate_dir(snap)

    assert snap
           |> Path.join("tables/messages.jsonl")
           |> File.read!()
           |> String.contains?("the pre-backup message"),
           "the kept snapshot does not carry the pre-restore data"

    # The seed's own attachment blob is in there too: the snapshot is taken from
    # the live attachments root, not from the archive being replayed.
    assert snap |> Path.join("attachments/#{seed.blob_hash}") |> File.regular?()
  end

  test "a TAMPERED CHECKSUM refuses validation and touches nothing", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "tampered"))

    File.write!(
      Path.join(dir, "tables/channels.jsonl"),
      File.read!(Path.join(dir, "tables/channels.jsonl")) <> "injected\n"
    )

    assert {:error, errors} = Restore.validate_dir(dir)
    assert Enum.any?(errors, &(&1.check == "checksum" and String.contains?(&1.message, "channels")))

    # Live data untouched.
    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  test "an UNKNOWN TABLE (outside the schema whitelist) refuses outright", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "unknown"))
    manifest = read_manifest(dir)

    evil = Path.join(dir, "tables/evil_table.jsonl")
    File.write!(evil, "")

    manifest =
      put_in(manifest, ["tables", "evil_table"], %{
        "file" => "tables/evil_table.jsonl",
        "rows" => 0,
        "sha256" => sha256_of(evil)
      })

    write_manifest(dir, manifest)

    assert {:error, errors} = Restore.validate_dir(dir)

    assert Enum.any?(errors, fn e ->
             e.check == "whitelist" and String.contains?(e.message, "evil_table")
           end)

    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  test "a VERSION TOO NEW refuses with an upgrade hint", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    dir = extract(summary.path, Path.join(tmp, "newer"))
    manifest = read_manifest(dir) |> Map.put("format_version", 99)
    write_manifest(dir, manifest)

    assert {:error, errors} = Restore.validate_dir(dir)
    assert Enum.any?(errors, &(&1.check == "version" and String.contains?(&1.message, "NEWER")))

    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  test "a TRUNCATED ARCHIVE FILE refuses at intake", %{author: author, peer: peer, tmp: tmp} do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    bytes = File.read!(summary.path)
    truncated = Path.join(tmp, "truncated.tar")
    File.write!(truncated, binary_part(bytes, 0, div(byte_size(bytes), 2)))

    assert {:error, {:staging, _errors}} = Restore.stage(truncated, dir: tmp)
    refute Restore.marker_present?()

    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)
  end

  test "boot_task REFUSES TO SERVE when the staged archive fails at boot", %{
    author: author,
    peer: peer,
    tmp: tmp
  } do
    seed = seed_workspace(%{author: author, peer: peer})
    summary = build_backup(tmp)

    assert {:ok, marker} = Restore.stage(summary.path, dir: tmp)

    # Corrupt the STAGED part after intake: what the next boot would see.
    File.write!(Path.join(marker["staged_dir"], "tables/channels.jsonl"), "corrupted bytes\n")

    {:ok, sup} = Supervisor.start_link([], strategy: :one_for_one)

    logged =
      capture_log(fn ->
        assert :refused = Restore.boot_task(sup)
      end)

    assert logged =~ "RESTORE REFUSED"

    # The marker records the failure for the operator; no endpoint child was
    # started (the node refuses to serve); live data is untouched.
    failed = Restore.read_marker()
    assert failed["status"] == "failed"
    assert is_list(failed["errors"]) and failed["errors"] != []

    assert Supervisor.count_children(sup).specs == 0
    assert %{content: "the pre-backup message"} = Messages.get_message(seed.general, seed.root_id)

    Supervisor.stop(sup)
    Restore.clear_marker()
  end

  # -- helpers ---------------------------------------------------------------------

  defp sha256_of(path) do
    Base.encode16(:crypto.hash(:sha256, File.read!(path)), case: :lower)
  end
end
