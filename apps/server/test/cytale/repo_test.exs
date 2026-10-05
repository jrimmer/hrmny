defmodule Cytale.RepoTest do
  @moduledoc """
  U6 integration tests — real ScyllaDB round-trips against the per-run
  `cytale_test` keyspace (recreated idempotently), exercised through the
  same `Cytale.Repo` cluster pool the app uses.
  """

  use Cytale.ScyllaCase, async: false

  @keyspace Cytale.Repo.keyspace()

  # ScyllaCase owns the pool + one-time schema apply (the per-test drop/reapply
  # here cost ~20s of DDL per test and blew the 60s timeout under load — the
  # exact pathology ScyllaCase was extracted to fix). Tests isolate via unique
  # snowflake channel ids, which this module already mints per test.

  test "schema applies idempotently (apply twice, verify passes)" do
    :ok = Cytale.Migrations.apply!()
    :ok = Cytale.Migrations.verify!()
  end

  # #47: the post-apply column reconciliation (Scylla has no ALTER ADD IF
  # NOT EXISTS) — a pre-existing keyspace missing a schema-file column must
  # be healed by apply!, not merely flagged by verify!.
  test "reconcile_columns!: a dropped column is re-ADDed by apply! (icon_url)" do
    Cytale.Repo.execute!("ALTER TABLE #{@keyspace}.workspaces DROP icon_url")

    # Verify catches the gap first (the drift it exists to flag)…
    assert_raise Cytale.Migrations.Error, ~r/missing columns.*icon_url/, fn ->
      Cytale.Migrations.verify!()
    end

    # …apply! heals it via the system_schema diff, and the column round-trips.
    :ok = Cytale.Migrations.apply!()
    :ok = Cytale.Migrations.verify!()

    ws_id = Cytale.Snowflake.next()
    url = "/api/v1/attachments/" <> String.duplicate("ab", 32)
    :ok = Cytale.Workspaces.set_icon(ws_id, url)
    assert Cytale.Workspaces.get_workspace(ws_id).icon_url == url
  end

  # The cd8abeb crash loop (2026-09-16): parse_columns/1 captured an inline
  # `PRIMARY KEY` suffix as part of the column TYPE, so a table the schema
  # file itself declares could never pass verify! against system_schema's
  # bare type — drift on every boot of image cd8abeb. This is the missing
  # test: a real inline-PK table, applied and verified end to end, in the
  # exact DDL form that detonated.
  test "verify! accepts an inline-PRIMARY-KEY column (any valid CQL style boots)" do
    inline_stmt = """
    CREATE TABLE IF NOT EXISTS {{keyspace}}.inline_pk_probe (
        name_lower   text PRIMARY KEY,
        workspace_id bigint
    );
    """

    :ok = Cytale.Migrations.apply!(inline_stmt)
    :ok = Cytale.Migrations.verify!(inline_stmt)

    # And the drift detector still works on this table: a hand-widened type
    # (int instead of bigint) must be flagged, proving the strip did not
    # silently weaken the comparison.
    Cytale.Repo.execute!("DROP TABLE #{@keyspace}.inline_pk_probe")
    :ok = Cytale.Migrations.apply!(String.replace(inline_stmt, "workspace_id bigint", "workspace_id int"))

    assert_raise Cytale.Migrations.Error, ~r/schema drift.*inline_pk_probe/, fn ->
      Cytale.Migrations.verify!(inline_stmt)
    end

    # Restore the suite's table shape.
    Cytale.Repo.execute!("DROP TABLE #{@keyspace}.inline_pk_probe")
    :ok = Cytale.Migrations.apply!(inline_stmt)
  end

  test "verify! detects drift when an expected table is missing" do
    Cytale.Repo.execute!("DROP TABLE #{@keyspace}.messages")

    assert_raise Cytale.Migrations.Error, ~r/missing columns/, fn ->
      Cytale.Migrations.verify!()
    end

    # REBUILD: the schema persists across modules under ScyllaCase (no
    # per-test drop/reapply), so a leaked drop would break every later
    # module touching messages. apply! is idempotent (IF NOT EXISTS).
    :ok = Cytale.Migrations.apply!()
    :ok = Cytale.Migrations.verify!()
  end

  # The keyspace-bloat warning is a dev-loop diagnostic (dev.exs opts in), but
  # its contract matters wherever it runs: it must never be the reason a boot
  # fails, and it must actually fire past the threshold.
  test "keyspace-bloat warning is silent when healthy" do
    assert :ok = Cytale.Migrations.warn_if_keyspace_count_high()
    assert :ok = Cytale.Migrations.warn_if_keyspace_count_high(1_000_000)
  end

  test "keyspace-bloat warning fires past the threshold and names the remedy" do
    log =
      ExUnit.CaptureLog.capture_log(fn ->
        assert :ok = Cytale.Migrations.warn_if_keyspace_count_high(0)
      end)

    assert log =~ "keyspaces"
    assert log =~ "scripts/scylla-reset.sh"
    assert log =~ "AGENTS.md"
  end

  test "message round-trip: insert, read back, values match" do
    channel_id = Cytale.Snowflake.next()
    bucket = bucket_for(channel_ts_ms(channel_id))
    message_id = Cytale.Snowflake.next()
    author_id = Cytale.Snowflake.next()
    created_at = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    :ok =
      insert_message(%{
        channel_id: channel_id,
        bucket: bucket,
        message_id: message_id,
        author_id: author_id,
        content: "hello scylla",
        thread_id: nil,
        created_at: created_at,
        edited_at: nil,
        attachments: []
      })

    assert {:ok, rows} =
             Cytale.Repo.execute(
               "SELECT message_id, channel_id, bucket, author_id, content, thread_id, created_at FROM #{Cytale.Repo.keyspace()}.messages WHERE channel_id = ? AND bucket = ? AND message_id = ?",
               [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
             )

    assert [%Xandra.Page{}] = [rows]
    assert [row] = Enum.to_list(rows)
    assert row["message_id"] == message_id
    assert row["channel_id"] == channel_id
    assert row["bucket"] == bucket
    assert row["author_id"] == author_id
    assert row["content"] == "hello scylla"
    assert row["thread_id"] == nil
  end

  test "clustering order DESC: newest-first without ORDER BY (plan test scenario)" do
    channel_id = Cytale.Snowflake.next()
    ts = channel_ts_ms(channel_id)
    bucket = bucket_for(ts)

    ids =
      Enum.map(1..5, fn i ->
        id = ts * 4096 + i

        :ok =
          insert_message(%{
            channel_id: channel_id,
            bucket: bucket,
            message_id: id,
            author_id: Cytale.Snowflake.next(),
            content: "m#{i}",
            thread_id: nil,
            created_at: ms_to_dt(ts),
            edited_at: nil,
            attachments: []
          })

        id
      end)

    assert {:ok, page} =
             Cytale.Repo.execute(
               "SELECT message_id FROM #{Cytale.Repo.keyspace()}.messages WHERE channel_id = ? AND bucket = ? LIMIT 3",
               [{"bigint", channel_id}, {"int", bucket}]
             )

    got = Enum.map(Enum.to_list(page), & &1["message_id"])
    # LIMIT 3 over DESC clustering returns the 3 NEWEST ids first.
    assert got == ids |> Enum.reverse() |> Enum.take(3)
  end

  test "7-day buckets: same channel, two buckets, queries stay partition-scoped" do
    channel_id = Cytale.Snowflake.next()
    base_ms = channel_ts_ms(channel_id)
    bucket_a = bucket_for(base_ms)
    bucket_b = bucket_for(base_ms + 8 * 24 * 3600 * 1000)

    :ok =
      insert_message(%{
        channel_id: channel_id,
        bucket: bucket_a,
        message_id: base_ms * 4096 + 1,
        author_id: Cytale.Snowflake.next(),
        content: "old",
        thread_id: nil,
        created_at: ms_to_dt(base_ms),
        edited_at: nil,
        attachments: []
      })

    :ok =
      insert_message(%{
        channel_id: channel_id,
        bucket: bucket_b,
        message_id: (base_ms + 8 * 24 * 3600 * 1000) * 4096 + 1,
        author_id: Cytale.Snowflake.next(),
        content: "newer",
        thread_id: nil,
        created_at: ms_to_dt(base_ms + 8 * 24 * 3600 * 1000),
        edited_at: nil,
        attachments: []
      })

    assert {:ok, page_a} =
             Cytale.Repo.execute(
               "SELECT content FROM #{Cytale.Repo.keyspace()}.messages WHERE channel_id = ? AND bucket = ?",
               [{"bigint", channel_id}, {"int", bucket_a}]
             )

    assert [%{"content" => "old"}] = Enum.to_list(page_a)
  end

  test "consistency: LOCAL_QUORUM accepted on a query (single-node RF=1)" do
    assert {:ok, _page} =
             Cytale.Repo.execute("SELECT release_version FROM system.local", [], consistency: :local_quorum)
  end

  # ----- helpers ---------------------------------------------------------------

  defp insert_message(%{} = m) do
    params = [
      {"bigint", m.channel_id},
      {"int", m.bucket},
      {"bigint", m.message_id},
      {"bigint", m.author_id},
      {"text", m.content},
      {"bigint", m.thread_id},
      {"timestamp", m.created_at},
      {"timestamp", m.edited_at},
      {"list<frozen<map<text, text>>>", m.attachments}
    ]

    case Cytale.Repo.execute(
           "INSERT INTO #{Cytale.Repo.keyspace()}.messages (channel_id, bucket, message_id, author_id, content, thread_id, created_at, edited_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
           params
         ) do
      {:ok, %Xandra.Void{}} -> :ok
      {:error, err} -> flunk("INSERT failed: #{Exception.message(err)}")
    end
  end

  # Cytale epoch is 2026-01-01 (U5). Snowflake ids carry ms since it.
  @cytale_epoch_ms 1_767_225_600_000

  defp channel_ts_ms(id), do: Bitwise.bsr(id, 22) + @cytale_epoch_ms

  # Bucket = floor(ms / 7 days) — the plan's U6 bucket rule (enforced app-side).
  defp bucket_for(ms), do: div(ms, 7 * 24 * 3600 * 1000)

  defp ms_to_dt(ms), do: DateTime.from_unix!(ms, :millisecond)
end
