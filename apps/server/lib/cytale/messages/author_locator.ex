defmodule Cytale.Messages.AuthorLocator do
  @moduledoc """
  U14 — per-author message-locator maintenance.

  The `author_messages` table maps `(author_id, message_id) -> (channel_id,
  bucket)`, written at message-persist time by `Cytale.Messages.create_message/1`
  (same write path, no scans). This module is the read side of that contract:
  it enumerates the `(channel_id, bucket)` partitions a given author has
  written to, so the account-deletion sweep (U14) can tombstone exactly those
  partitions without a blind scan over unknown ones.

  The locator is the plan's "no blind fan-out over unknown partitions"
  mechanism — the sweep walks the author's own locator rows, never the whole
  `messages` table.
  """

  alias Cytale.Repo

  @doc """
  Distinct `(channel_id, bucket)` partitions the author has messages in.
  The sweep tombstones each partition once (a partition may hold many of the
  author's messages).
  """
  @spec list_partitions(integer()) :: [{integer(), integer()}]
  def list_partitions(author_id) when is_integer(author_id) do
    # `stream_rows!/3` for the same reason `list_messages/1` below uses it
    # (hardening plan 4.1): `execute!/3` stops at the first driver page, so an
    # author with more than 10k locator rows would leave whole partitions
    # un-tombstoned. (`count/1` walks the same way since PERF-13 — no aggregate
    # or page-bounded read left in this module.)
    rows =
      Repo.stream_rows!(
        "SELECT channel_id, bucket FROM {{K}}.author_messages WHERE author_id = ?",
        [{"bigint", author_id}]
      )
      |> Enum.to_list()

    rows
    |> Enum.map(fn r -> {r["channel_id"], r["bucket"]} end)
    |> Enum.uniq()
  end

  @doc """
  The author's message locator rows as `{channel_id, bucket, message_id}`
  triples — the full primary key of each authored message. The sweep
  tombstones each message by its full key (no ALLOW FILTERING, no blind
  scans over a partition's other authors).
  """
  @spec list_messages(integer()) :: [{integer(), integer(), integer()}]
  def list_messages(author_id) when is_integer(author_id) do
    # `stream_rows!/3`, NOT `execute!/3` (hardening plan 4.1). `execute!` returns
    # only the FIRST driver page (10k rows by default), so an author with more
    # than that had every message past the first page left UNTOMBSTONED by the
    # account-deletion sweep — a privacy guarantee that silently did not hold.
    # `Cytale.Repo`'s own moduledoc documents this exact trap (the revoked-token
    # scan was the same class); this call site had not adopted the rule.
    rows =
      Repo.stream_rows!(
        "SELECT channel_id, bucket, message_id FROM {{K}}.author_messages WHERE author_id = ?",
        [{"bigint", author_id}]
      )

    Enum.map(rows, fn r -> {r["channel_id"], r["bucket"], r["message_id"]} end)
  end

  @doc """
  Count of locator rows for an author (sweep progress / diagnostics).

  PERF-13: `SELECT COUNT(*)` is gone — ScyllaDB computes it as a full
  partition scan server-side with no better cost profile than reading the rows,
  and it is one more aggregate shape to keep driver-compatible. This counts the
  locator's primary-key columns through `stream_rows!/3` (the same LIMIT-free
  partition walk `list_messages/1` does, which the sweep itself already pays
  for), so the total stays EXACT — the caller's contract — at no additional
  cost class.
  """
  @spec count(integer()) :: integer()
  def count(author_id) when is_integer(author_id) do
    Repo.stream_rows!(
      "SELECT message_id FROM {{K}}.author_messages WHERE author_id = ?",
      [{"bigint", author_id}]
    )
    |> Enum.count()
  end
end
