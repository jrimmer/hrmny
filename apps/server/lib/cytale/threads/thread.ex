defmodule Cytale.Threads.Thread do
  @moduledoc """
  Thread state (U12) — thread-as-subchannel.

  A thread is created from a channel message; its Snowflake id is the parent
  message's id (Discord-shaped). Thread replies live in the same `messages`
  table with `thread_id` set. Metadata is denormalized onto the `threads`
  row (`member_count`, `message_count`, `latest_reply_id`, `latest_reply_at`)
  for sidebar/preview display, and mirrored onto `threads_by_id` so the
  fan-out path can resolve thread → channel without scanning.

  All ids are integer-native here; the wire layer (`Cytale.Threads.Events`)
  stringifies snowflakes per the protocol package.
  """

  require Logger

  alias Cytale.Repo
  alias Cytale.Threads.Member

  # How many times a reply-count LWT re-reads and retries before giving up.
  # Contention here is two replies to the SAME thread landing together, so this
  # is generous.
  @reply_lwt_attempts 8

  @typedoc "A thread row (integer-native ids)."
  @type t :: %{
          thread_id: integer(),
          channel_id: integer(),
          parent_message_id: integer(),
          name: String.t(),
          archived: boolean(),
          member_count: integer(),
          message_count: integer(),
          latest_reply_id: integer() | nil,
          latest_reply_at: DateTime.t() | nil,
          created_at: DateTime.t()
        }

  @doc "Create a thread from a channel message. `thread_id == parent_message_id`."
  @spec create(integer(), integer(), String.t(), integer()) :: {:ok, t()} | {:error, :message_not_found}
  def create(channel_id, parent_message_id, name, created_by)
      when is_integer(channel_id) and is_integer(parent_message_id) and is_binary(name) and
             is_integer(created_by) do
    case Cytale.Messages.get_message(channel_id, parent_message_id) do
      nil ->
        {:error, :message_not_found}

      %{id: ^parent_message_id} ->
        {:ok, insert_thread(parent_message_id, channel_id, parent_message_id, name, created_by)}
    end
  end

  @doc """
  Start a thread with a FRESH Snowflake id (the compat thread-write routes,
  bots plan B-2 — Discord mints new thread-channel ids; the pinned-id
  `create/4` stays the U12 hot-path fixture shape). `parent_message_id` may
  be nil — Discord's standalone thread start has no anchoring message.
  A non-nil anchor message must exist (`{:error, :message_not_found}`).
  """
  @spec start(integer(), integer() | nil, String.t(), integer()) ::
          {:ok, t()} | {:error, :message_not_found}
  def start(channel_id, parent_message_id, name, created_by)
      when is_integer(channel_id) and is_binary(name) and is_integer(created_by) do
    case parent_message_id do
      nil ->
        {:ok, insert_thread(Cytale.Snowflake.next(), channel_id, nil, name, created_by)}

      message_id when is_integer(message_id) ->
        if Cytale.Messages.get_message(channel_id, message_id),
          do: {:ok, insert_thread(Cytale.Snowflake.next(), channel_id, message_id, name, created_by)},
          else: {:error, :message_not_found}
    end
  end

  # The dual write (per-workspace partition + by-id lookup) both create/4
  # and start/4 share.
  defp insert_thread(thread_id, channel_id, parent_message_id, name, created_by) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    cols =
      "channel_id, thread_id, parent_message_id, name, created_by, archived, member_count, message_count, latest_reply_id, latest_reply_at, created_at"

    params = [
      {"bigint", channel_id},
      {"bigint", thread_id},
      {"bigint", parent_message_id},
      {"text", name},
      {"bigint", created_by},
      {"boolean", false},
      {"int", 0},
      {"bigint", 0},
      {"bigint", nil},
      {"timestamp", nil},
      {"timestamp", now}
    ]

    Repo.execute!(
      "INSERT INTO {{K}}.threads (#{cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params
    )

    Repo.execute!(
      "INSERT INTO {{K}}.threads_by_id (#{cols}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params
    )

    %{
      thread_id: thread_id,
      channel_id: channel_id,
      parent_message_id: parent_message_id,
      name: name,
      created_by: created_by,
      archived: false,
      member_count: 0,
      message_count: 0,
      latest_reply_id: nil,
      latest_reply_at: nil,
      created_at: now
    }
  end

  @doc "Fetch a thread by id (via the thread_id lookup row)."
  @spec get(integer()) :: t() | nil
  def get(thread_id) when is_integer(thread_id) do
    rows =
      Repo.execute!(
        "SELECT thread_id, channel_id, parent_message_id, name, created_by, archived, member_count, message_count, latest_reply_id, latest_reply_at, created_at FROM {{K}}.threads_by_id WHERE thread_id = ?",
        [{"bigint", thread_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] -> row_to_thread(r)
      [] -> nil
    end
  end

  @doc """
  Delete a thread (#74): its membership rows, its id-lookup row, and its row in
  the parent channel's partition.

  Discord treats a thread as a channel, so `DELETE /channels/{thread_id}`
  removes it — this is what makes the compat surface's thread creation
  reversible instead of permanent debris. What disappears is everything that
  made the thread listable and openable; the thread's MESSAGES stay in the
  message table (keyed by the thread id) and become unreachable rather than
  deleted. Sweeping those is deliberate separate work: the table is
  TimeWindow-compacted, so a delete writes tombstones either way.

  `thread_members` is partitioned by thread_id, so its whole partition goes in
  one statement; `thread_members_by_user` is partitioned by USER, so the member
  ids come from that partition read first.
  """
  @spec delete(integer(), integer()) :: :ok
  def delete(thread_id, channel_id) when is_integer(thread_id) and is_integer(channel_id) do
    for user_id <- Member.user_ids(thread_id) do
      Repo.execute!(
        "DELETE FROM {{K}}.thread_members_by_user WHERE user_id = ? AND thread_id = ?",
        [{"bigint", user_id}, {"bigint", thread_id}]
      )
    end

    Repo.execute!(
      "DELETE FROM {{K}}.thread_members WHERE thread_id = ?",
      [{"bigint", thread_id}]
    )

    Repo.execute!(
      "DELETE FROM {{K}}.threads_by_id WHERE thread_id = ?",
      [{"bigint", thread_id}]
    )

    Repo.execute!(
      "DELETE FROM {{K}}.threads WHERE channel_id = ? AND thread_id = ?",
      [{"bigint", channel_id}, {"bigint", thread_id}]
    )

    :ok
  end

  @doc "List threads in a channel (newest-first via DESC clustering)."
  @spec list_in_channel(integer()) :: [t()]
  def list_in_channel(channel_id) when is_integer(channel_id) do
    Repo.execute!(
      "SELECT channel_id, thread_id, parent_message_id, name, created_by, archived, member_count, message_count, latest_reply_id, latest_reply_at, created_at FROM {{K}}.threads WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
    |> Enum.map(&row_to_thread/1)
  end

  @doc "Archive (or unarchive) a thread."
  @spec set_archived(integer(), boolean()) :: :ok
  def set_archived(thread_id, archived) when is_integer(thread_id) and is_boolean(archived) do
    Repo.execute!(
      "UPDATE {{K}}.threads SET archived = ? WHERE channel_id = ? AND thread_id = ?",
      [{"boolean", archived}, {"bigint", channel_id_of(thread_id)}, {"bigint", thread_id}]
    )

    Repo.execute!(
      "UPDATE {{K}}.threads_by_id SET archived = ? WHERE thread_id = ?",
      [{"boolean", archived}, {"bigint", thread_id}]
    )

    :ok
  end

  @doc """
  Record a reply: bump `message_count`, set `latest_reply_id`/`latest_reply_at`
  (only forward — a stale delivery never regresses the latest reply), and
  increment the per-thread member count when the author is a new follower.
  Returns `:ok`.

  The count and the latest-reply pair are SEPARATE concerns, and this is where
  they are: EVERY recorded reply moves the count (the reply row is the authority
  and is written once per reply), while only a forward reply moves
  `latest_reply_id`/`_at`. The previous code skipped both together when the
  reply was not forward, which under concurrency dropped the counts of replies
  that happened to arrive after a newer one had already landed.
  """
  @spec record_reply(integer(), integer(), DateTime.t()) :: :ok
  def record_reply(thread_id, reply_id, replied_at)
      when is_integer(thread_id) and is_integer(reply_id) do
    # A read-modify-write pair made exactly-once by an OPTIMISTIC LWT (hardening
    # plan 4.3): read the row, then write `message_count = <observed + 1>` only
    # `IF message_count = <observed>`. Two concurrent replies can no longer both
    # write `n + 1` — the loser's condition fails, it re-reads and tries again.
    #
    # The obvious alternative is ILLEGAL here and was measured, not guessed:
    # `SET message_count = message_count + 1` is rejected ("Invalid operation
    # (message_count = message_count + 1) for non counter column message_count").
    # A relative increment needs a `counter` column, and a counter may not share
    # a table with regular columns — `threads` carries eleven. (`reaction_counts`
    # COULD become a counter and did; invites' `use_count` cannot and moves by
    # the same LWT pattern in `Workspaces.accept_invite/2`.)
    #
    # Both denormalized mirrors are moved, each by its OWN loop: they are
    # separate rows, and a conflict on one must not leave the other behind.
    # Exhausting the attempts leaves at worst a stale count in a mirror — the
    # reply ROW is the authority and is already written — so it warns rather
    # than failing the caller.
    case get(thread_id) do
      nil ->
        :ok

      %{channel_id: channel_id} ->
        sync_reply_row(
          fn -> get(thread_id) end,
          fn count, reply, at, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads_by_id SET message_count = ?, latest_reply_id = ?, latest_reply_at = ? WHERE thread_id = ? IF message_count = ?",
              [
                {"bigint", count},
                {"bigint", reply},
                {"timestamp", at},
                {"bigint", thread_id},
                {"bigint", observed}
              ]
            )
          end,
          reply_id,
          replied_at,
          @reply_lwt_attempts
        )

        sync_reply_row(
          fn -> get_in_channel(channel_id, thread_id) end,
          fn count, reply, at, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads SET message_count = ?, latest_reply_id = ?, latest_reply_at = ? WHERE channel_id = ? AND thread_id = ? IF message_count = ?",
              [
                {"bigint", count},
                {"bigint", reply},
                {"timestamp", at},
                {"bigint", channel_id},
                {"bigint", thread_id},
                {"bigint", observed}
              ]
            )
          end,
          reply_id,
          replied_at,
          @reply_lwt_attempts
        )

        :ok
    end
  end

  defp lwt_reply(statement, params) do
    if Repo.lwt_applied?(Repo.execute!(statement, params)), do: :applied, else: :stale
  end

  # One mirror's optimistic loop. `read` re-reads THAT row (the two mirrors can
  # be at different points after a conflict), `write` issues the conditional
  # update against the count it observed. The forward-only rule is applied to the
  # LATEST fields inside the write, from the row the condition is anchored on —
  # never to the count.
  defp sync_reply_row(read, write, reply_id, replied_at, attempts) do
    row = read.()

    cond do
      is_nil(row) ->
        :ok

      attempts == 0 ->
        Logger.warning(
          "threads: reply count LWT never applied after #{@reply_lwt_attempts} attempts " <>
            "(thread #{inspect(reply_id)}); a mirrored message_count may lag — queued for recount"
        )

        # Review #24: the lag is no longer permanent — the recount job
        # rederives the count from the thread's reply locator.
        Cytale.Maintenance.Recount.mark_thread(row.thread_id)

      true ->
        forward? = is_nil(row.latest_reply_id) or reply_id > row.latest_reply_id
        latest = if forward?, do: reply_id, else: row.latest_reply_id
        at = if forward?, do: replied_at, else: row.latest_reply_at

        case write.(row.message_count + 1, latest, at, row.message_count) do
          :applied -> :ok
          :stale -> sync_reply_row(read, write, reply_id, replied_at, attempts - 1)
        end
    end
  end

  # The parent-channel mirror of one thread row (the by-id read is the public
  # `get/1`; this is the other half of the same dual write).
  defp get_in_channel(channel_id, thread_id) do
    rows =
      Repo.execute!(
        "SELECT channel_id, thread_id, parent_message_id, name, created_by, archived, member_count, message_count, latest_reply_id, latest_reply_at, created_at FROM {{K}}.threads WHERE channel_id = ? AND thread_id = ?",
        [{"bigint", channel_id}, {"bigint", thread_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] -> row_to_thread(r)
      [] -> nil
    end
  end

  @doc """
  A reply was deleted: take it out of the thread's `message_count` (#106).

  The creation half is `record_reply/3`; without this one the count only ever
  grew, so a deleted reply stayed in every seed indicator. Same optimistic LWT
  over both mirrors, floored at zero. `latest_reply_*` is left alone — it is the
  last activity, and that happened; recomputing it would need a replies scan.
  """
  @spec record_reply_removed(integer()) :: :ok
  def record_reply_removed(thread_id) when is_integer(thread_id) do
    case get(thread_id) do
      nil ->
        :ok

      %{channel_id: channel_id} ->
        sync_count_row(
          fn -> get(thread_id) end,
          fn new_count, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads_by_id SET message_count = ? WHERE thread_id = ? IF message_count = ?",
              [{"bigint", new_count}, {"bigint", thread_id}, {"bigint", observed}]
            )
          end,
          @reply_lwt_attempts
        )

        sync_count_row(
          fn -> get_in_channel(channel_id, thread_id) end,
          fn new_count, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads SET message_count = ? WHERE channel_id = ? AND thread_id = ? IF message_count = ?",
              [
                {"bigint", new_count},
                {"bigint", channel_id},
                {"bigint", thread_id},
                {"bigint", observed}
              ]
            )
          end,
          @reply_lwt_attempts
        )

        :ok
    end
  end

  defp sync_count_row(read, write, attempts) do
    case read.() do
      nil ->
        :ok

      row ->
        observed = row.message_count || 0

        case write.(max(observed - 1, 0), observed) do
          :applied ->
            :ok

          :stale when attempts > 1 ->
            sync_count_row(read, write, attempts - 1)

          :stale ->
            Logger.warning(
              "threads: reply-removal LWT never applied after #{@reply_lwt_attempts} attempts " <>
                "(thread #{inspect(row.thread_id)}); a mirrored message_count may lag — queued for recount"
            )

            Cytale.Maintenance.Recount.mark_thread(row.thread_id)
        end
    end
  end

  # A thread with more replies than this is not recounted by the repair job
  # (the count would take an unbounded walk); it keeps the lag and says so.
  @recount_cap 10_000

  @doc """
  Rederive `message_count` from the thread's reply locator (review #24): the
  repair for a mirror whose optimistic LWT gave up under contention (the
  reply ROWS are the authority; the count is a denormalized mirror). Counts
  the locator rows whose message still exists, then writes each mirror
  conditionally on the count it observed — a reply racing the recount makes
  that write `:stale`, and the thread is simply queued again.

  Returns `:ok` (both mirrors agree with the rows now), `:retry` (a
  concurrent reply moved a mirror — try again later), or `:skipped` (no such
  thread, or more than #{@recount_cap} replies).
  """
  @spec recount(integer()) :: :ok | :retry | :skipped
  def recount(thread_id) when is_integer(thread_id) do
    with %{channel_id: channel_id} <- get(thread_id),
         {:ok, actual} <- live_reply_count(thread_id) do
      results = [
        recount_row(fn -> get(thread_id) end, actual, fn observed ->
          lwt_reply(
            "UPDATE {{K}}.threads_by_id SET message_count = ? WHERE thread_id = ? IF message_count = ?",
            [{"bigint", actual}, {"bigint", thread_id}, {"bigint", observed}]
          )
        end),
        recount_row(fn -> get_in_channel(channel_id, thread_id) end, actual, fn observed ->
          lwt_reply(
            "UPDATE {{K}}.threads SET message_count = ? WHERE channel_id = ? AND thread_id = ? IF message_count = ?",
            [{"bigint", actual}, {"bigint", channel_id}, {"bigint", thread_id}, {"bigint", observed}]
          )
        end)
      ]

      if Enum.all?(results, &(&1 == :ok)), do: :ok, else: :retry
    else
      _ -> :skipped
    end
  end

  defp recount_row(read, actual, write) do
    case read.() do
      nil -> :ok
      %{message_count: ^actual} -> :ok
      row -> if write.(row.message_count) == :applied, do: :ok, else: :retry
    end
  end

  # The locator rows whose message still exists (a delete that did not know
  # its thread leaves a locator row behind; hydration skips those, so the
  # count must too).
  defp live_reply_count(thread_id) do
    rows =
      "SELECT message_id, channel_id FROM {{K}}.thread_messages WHERE thread_id = ? LIMIT #{@recount_cap + 1}"
      |> Repo.execute!([{"bigint", thread_id}])
      |> Enum.to_list()

    if length(rows) > @recount_cap do
      :too_many
    else
      live =
        rows
        |> Enum.map(&{&1["channel_id"], &1["message_id"]})
        |> Enum.chunk_every(100)
        |> Enum.map(&map_size(Cytale.Messages.get_many(&1)))
        |> Enum.sum()

      {:ok, live}
    end
  end

  @doc "Increment the thread's member_count (a new follower joined)."
  @spec bump_member_count(integer()) :: :ok
  def bump_member_count(thread_id) when is_integer(thread_id) do
    adjust_member_count(thread_id, &(&1 + 1))
  end

  @doc "Decrement the thread's member_count (a follower left)."
  @spec decrement_member_count(integer()) :: :ok
  def decrement_member_count(thread_id) when is_integer(thread_id) do
    adjust_member_count(thread_id, &max(&1 - 1, 0))
  end

  # Same optimistic-LWT treatment as `record_reply/3`, and for the same reason:
  # the member count is a read-modify-write over two mirrored rows, so two
  # concurrent joins both wrote `n + 1` and the sidebar drifted permanently low.
  #
  # `adjust` maps the observed count to the new one, which is also what lets the
  # floor-at-zero decrement survive a conflict: it is computed from the value the
  # LWT is conditioning on, not from the stale one.
  defp adjust_member_count(thread_id, adjust) do
    case get(thread_id) do
      nil ->
        :ok

      %{channel_id: channel_id} ->
        sync_member_row(
          fn -> get(thread_id) end,
          fn new_count, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads_by_id SET member_count = ? WHERE thread_id = ? IF member_count = ?",
              [{"int", new_count}, {"bigint", thread_id}, {"int", observed}]
            )
          end,
          adjust,
          @reply_lwt_attempts
        )

        sync_member_row(
          fn -> get_in_channel(channel_id, thread_id) end,
          fn new_count, observed ->
            lwt_reply(
              "UPDATE {{K}}.threads SET member_count = ? WHERE channel_id = ? AND thread_id = ? IF member_count = ?",
              [
                {"int", new_count},
                {"bigint", channel_id},
                {"bigint", thread_id},
                {"int", observed}
              ]
            )
          end,
          adjust,
          @reply_lwt_attempts
        )

        :ok
    end
  end

  defp sync_member_row(read, write, adjust, attempts) do
    case read.() do
      nil ->
        :ok

      row ->
        case write.(adjust.(row.member_count), row.member_count) do
          :applied ->
            :ok

          :stale when attempts > 1 ->
            sync_member_row(read, write, adjust, attempts - 1)

          :stale ->
            Logger.warning(
              "threads: member_count LWT never applied after #{@reply_lwt_attempts} attempts " <>
                "(thread #{inspect(row.thread_id)}); a mirrored member_count may lag"
            )

            :ok
        end
    end
  end

  # -- Internals ---------------------------------------------------------------

  defp channel_id_of(thread_id) do
    case get(thread_id) do
      %{channel_id: cid} -> cid
      nil -> 0
    end
  end

  defp row_to_thread(r) do
    %{
      thread_id: r["thread_id"],
      channel_id: r["channel_id"],
      parent_message_id: r["parent_message_id"],
      name: r["name"],
      created_by: r["created_by"],
      archived: r["archived"],
      member_count: r["member_count"],
      message_count: r["message_count"],
      latest_reply_id: r["latest_reply_id"],
      latest_reply_at: r["latest_reply_at"],
      created_at: r["created_at"]
    }
  end
end
