defmodule Cytale.MigrationsTest do
  @moduledoc """
  The one schema change that is not a plain `CREATE TABLE IF NOT EXISTS`
  (hardening plan 4.3): `reaction_counts.count` was an application-managed
  `bigint` and is now a real `counter`.

  Scylla cannot ALTER its way there — `ALTER ... ADD count counter` on a table
  created without a counter column fails with "Cannot add a counter column
  (count) in a non counter column family", and dropping the old column first
  does not clear the flag (both probed against ScyllaDB 2026.2). The conversion
  is therefore a STAGED table rewrite, and this suite drives the real one against
  a scratch keyspace: legacy shape in, tallies carried across, drift repaired, a
  CRASHED conversion recovered from its sidecar, and a second run that must NOT
  double-count.

  `Migrations.apply!/2` and `verify!/2` take `keyspace:` for exactly this — the
  alternative would be pointing the whole configured keyspace at a legacy shape,
  which no concurrent suite could survive.
  """

  use ExUnit.Case, async: false

  # Reaches the database directly (no ScyllaCase) — excluded from a no-DB run.
  @moduletag :scylla

  alias Cytale.Migrations
  alias Cytale.Repo

  @counter_schema """
  CREATE TABLE IF NOT EXISTS {{keyspace}}.reactions_by_message (
      channel_id  bigint,
      bucket      int,
      message_id  bigint,
      emoji       text,
      user_id     bigint,
      PRIMARY KEY ((channel_id, bucket, message_id), emoji, user_id)
  ) WITH CLUSTERING ORDER BY (emoji ASC, user_id ASC);

  CREATE TABLE IF NOT EXISTS {{keyspace}}.reaction_counts (
      channel_id  bigint,
      bucket      int,
      message_id  bigint,
      emoji       text,
      count       counter,
      PRIMARY KEY ((channel_id, bucket, message_id), emoji)
  ) WITH CLUSTERING ORDER BY (emoji ASC);
  """

  @legacy_schema """
  CREATE TABLE IF NOT EXISTS {{keyspace}}.reactions_by_message (
      channel_id  bigint,
      bucket      int,
      message_id  bigint,
      emoji       text,
      user_id     bigint,
      PRIMARY KEY ((channel_id, bucket, message_id), emoji, user_id)
  ) WITH CLUSTERING ORDER BY (emoji ASC, user_id ASC);

  CREATE TABLE IF NOT EXISTS {{keyspace}}.reaction_counts (
      channel_id  bigint,
      bucket      int,
      message_id  bigint,
      emoji       text,
      count       bigint,
      PRIMARY KEY ((channel_id, bucket, message_id), emoji)
  ) WITH CLUSTERING ORDER BY (emoji ASC);
  """

  @sidecar_ddl """
  CREATE TABLE IF NOT EXISTS {{keyspace}}.reaction_counts_legacy (
      channel_id  bigint,
      bucket      int,
      message_id  bigint,
      emoji       text,
      count       bigint,
      PRIMARY KEY ((channel_id, bucket, message_id), emoji)
  ) WITH CLUSTERING ORDER BY (emoji ASC);
  """

  setup do
    keyspace = "cytale_migr_#{System.unique_integer([:positive, :monotonic])}"

    Repo.execute!("CREATE KEYSPACE #{keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}")

    on_exit(fn -> Repo.execute!("DROP KEYSPACE IF EXISTS #{keyspace}") end)

    {:ok, keyspace: keyspace}
  end

  test "a legacy bigint tally table is converted, and its tallies survive", %{keyspace: ks} do
    apply_raw!(@legacy_schema, ks)

    seed_reactions(ks, "👍", 2)
    seed_reactions(ks, "👀", 5)
    write_tally(ks, "reaction_counts", "👍", 2)
    write_tally(ks, "reaction_counts", "👀", 5)

    assert column_type(ks, "count") == "bigint"

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)
    :ok = Migrations.verify!(@counter_schema, keyspace: ks)

    assert column_type(ks, "count") == "counter"
    assert tallies(ks) == %{"👍" => 2, "👀" => 5}
    refute sidecar_present?(ks)

    # …and it really is a counter: a server-side delta applies without a read.
    Repo.execute!(
      "UPDATE #{ks}.reaction_counts SET count = count + ? WHERE channel_id = 1 AND bucket = 1 AND message_id = 1 AND emoji = ?",
      [{"bigint", 3}, {"text", "👍"}]
    )

    assert tallies(ks)["👍"] == 5
  end

  test "the conversion REBUILDS from the existence rows, repairing a drifted mirror",
       %{keyspace: ks} do
    # The old read-modify-write could leave the mirror wrong (and `remove_others`
    # could drop a tally row while a spared reactor's row survived). The tally is
    # a mirror of the existence rows, which are the authority, so the conversion
    # recounts instead of copying the drift forward.
    apply_raw!(@legacy_schema, ks)

    seed_reactions(ks, "👍", 2)
    write_tally(ks, "reaction_counts", "👍", 99)

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)

    assert tallies(ks) == %{"👍" => 2}
  end

  test "an interrupted conversion is recovered from the sidecar on the next boot",
       %{keyspace: ks} do
    # The failure the staging table exists for: the DROP + re-CREATE landed (so
    # the type is already `counter`) and the process died before the backfill. The
    # type check alone would skip the conversion forever and leave the tallies
    # empty; the sidecar proves the conversion started and still holds the data.
    apply_raw!(@counter_schema, ks)
    apply_raw!(@sidecar_ddl, ks)

    write_tally(ks, "reaction_counts_legacy", "👍", 4)
    # A PARTIAL backfill, as an interrupted step 3 would leave it.
    Repo.execute!(
      "UPDATE #{ks}.reaction_counts SET count = count + 1 WHERE channel_id = 1 AND bucket = 1 AND message_id = 1 AND emoji = '👍'"
    )

    assert tallies(ks) == %{"👍" => 1}

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)
    :ok = Migrations.verify!(@counter_schema, keyspace: ks)

    assert tallies(ks) == %{"👍" => 4}, "the recovered conversion did not use the sidecar"
    refute sidecar_present?(ks), "the sidecar must be dropped once the conversion completes"
  end

  test "a partial sidecar is discarded and recounted while the legacy table survives",
       %{keyspace: ks} do
    # The other crash point: the sidecar was being filled when the process died,
    # and the real table is still the legacy shape. Nothing was dropped, so the
    # sidecar is untrustworthy and the conversion recounts from the authority.
    apply_raw!(@legacy_schema, ks)
    apply_raw!(@sidecar_ddl, ks)

    seed_reactions(ks, "👀", 3)
    write_tally(ks, "reaction_counts", "👀", 3)
    write_tally(ks, "reaction_counts_legacy", "stale", 7)

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)

    assert tallies(ks) == %{"👀" => 3}
    refute sidecar_present?(ks)
  end

  test "a second apply does NOT double-count (the conversion is one-way)", %{keyspace: ks} do
    apply_raw!(@legacy_schema, ks)
    seed_reactions(ks, "👍", 4)
    write_tally(ks, "reaction_counts", "👍", 4)

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)
    assert tallies(ks) == %{"👍" => 4}

    :ok = Migrations.apply!(@counter_schema, keyspace: ks)
    :ok = Migrations.apply!(@counter_schema, keyspace: ks)

    assert tallies(ks) == %{"👍" => 4},
           "a repeated apply re-ran the backfill and double-counted the tallies"
  end

  test "a fresh keyspace is created as a counter and needs no conversion", %{keyspace: ks} do
    :ok = Migrations.apply!(@counter_schema, keyspace: ks)
    :ok = Migrations.verify!(@counter_schema, keyspace: ks)

    assert column_type(ks, "count") == "counter"
    refute sidecar_present?(ks)
  end

  test "verify! reports the legacy shape as drift (which is what triggers the apply)",
       %{keyspace: ks} do
    apply_raw!(@legacy_schema, ks)

    assert_raise Migrations.Error, ~r/schema drift/, fn ->
      Migrations.verify!(@counter_schema, keyspace: ks)
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp subst(schema, ks), do: String.replace(schema, "{{keyspace}}", ks)

  # Create the LEGACY shape without going through `apply!` (which would convert
  # it on the spot — that is the code under test). One statement at a time,
  # because Xandra runs a single statement per call.
  defp apply_raw!(schema, ks) do
    for stmt <- Migrations.statements(schema, ks), do: Repo.execute!(stmt)
    :ok
  end

  # `n` existence rows for one emoji: the authority the conversion recounts.
  defp seed_reactions(ks, emoji, n) do
    Enum.each(1..n, fn user_id ->
      Repo.execute!(
        "INSERT INTO #{ks}.reactions_by_message (channel_id, bucket, message_id, emoji, user_id) VALUES (1, 1, 1, ?, ?)",
        [{"text", emoji}, {"bigint", user_id}]
      )
    end)
  end

  defp write_tally(ks, table, emoji, count) do
    Repo.execute!(
      "INSERT INTO #{ks}.#{table} (channel_id, bucket, message_id, emoji, count) VALUES (1, 1, 1, ?, ?)",
      [{"text", emoji}, {"bigint", count}]
    )
  end

  defp tallies(ks) do
    Repo.execute!(
      "SELECT emoji, count FROM #{ks}.reaction_counts WHERE channel_id = 1 AND bucket = 1 AND message_id = 1"
    )
    |> Enum.to_list()
    |> Map.new(fn row -> {row["emoji"], row["count"]} end)
  end

  defp sidecar_present?(ks) do
    Repo.execute!(
      "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
      [{"text", ks}, {"text", "reaction_counts_legacy"}]
    )
    |> Enum.to_list() != []
  end

  defp column_type(ks, column) do
    Repo.execute!(
      "SELECT type FROM system_schema.columns WHERE keyspace_name = ? AND table_name = 'reaction_counts' AND column_name = ?",
      [{"text", ks}, {"text", column}]
    )
    |> Enum.to_list()
    |> case do
      [%{"type" => type}] -> type
      other -> flunk("no column #{column} in #{ks}.reaction_counts: #{inspect(other)}")
    end
  end
end
