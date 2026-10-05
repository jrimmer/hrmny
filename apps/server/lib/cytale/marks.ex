defmodule Cytale.Marks do
  @moduledoc """
  Message marks (#54): one primitive for user-assigned message state.

  A mark is `(target message, kind, due_at?)`. The kind decides everything
  else (`Cytale.Marks.Kind`): who may see it, what it does to the read model,
  and whether it is consumed at a due time. v1 registers one private timed
  kind, `snooze` ("Remind me…").

  ## Storage (KTD5)

  * `message_marks_by_user` — the AUTHORITATIVE row for a private mark,
    partitioned by owner, keyed `(kind, target_id)` so a second mark on the
    same message re-sets it.
  * `message_marks_by_due` — the sweep's index by due minute. Its `state` is a
    cache; the sweep's FENCE re-reads the authoritative row and fires only when
    that row is `pending` and names the same `due_at` (R14). A re-set or a
    cancel therefore never has to find and delete an index row.

  `state` moves `pending → fired | cancelled | missed`, and a NULL state reads
  as terminal. Every write supplies a TTL: the authoritative row lives until
  its due time plus the lookback plus retention; the due row until its due time
  plus the sweep interval, the lookback and slack — an index row that expired
  AT its due time would be a reminder deleted before it could fire.

  ## Privacy (KD4, R2)

  Every read here is keyed by the caller's own user id: there is no function
  that lists another principal's marks, and nothing in this module fans out.
  """

  alias Cytale.Marks.Kinds
  alias Cytale.Repo

  @kinds %{"snooze" => Kinds.Snooze}

  # R13: a user's pending marks are bounded.
  @max_pending_per_user 500
  # KTD4: the sweeper's clamp, and how late a missed reminder may still fire.
  @sweep_interval_ms 30_000
  @lookback_ms 12 * 60 * 60 * 1000
  # How long a terminal row (fired / cancelled / missed) is retained.
  @retention_ms 7 * 24 * 60 * 60 * 1000
  @due_slack_ms 60 * 60 * 1000

  @type mark :: %{
          user_id: integer(),
          kind: String.t(),
          target_id: integer(),
          channel_id: integer(),
          mark_id: integer(),
          due_at: DateTime.t() | nil,
          state: String.t() | nil,
          created_at: DateTime.t() | nil
        }

  @doc "The registered kinds, id → module."
  @spec kinds() :: %{String.t() => module()}
  def kinds, do: @kinds

  @doc "Resolve a kind id; an unknown id never reaches storage."
  @spec kind(term()) :: {:ok, module()} | {:error, :unknown_kind}
  def kind(id) when is_binary(id) do
    case Map.fetch(@kinds, id) do
      {:ok, mod} -> {:ok, mod}
      :error -> {:error, :unknown_kind}
    end
  end

  def kind(_), do: {:error, :unknown_kind}

  def max_pending_per_user, do: @max_pending_per_user
  def sweep_interval_ms, do: @sweep_interval_ms
  def lookback_ms, do: @lookback_ms

  @doc "The minute bucket a due instant is indexed under."
  @spec due_bucket(integer()) :: integer()
  def due_bucket(due_ms) when is_integer(due_ms), do: div(due_ms, 60_000)

  @doc """
  Set (or RE-SET) a mark of `kind_id` on `message` for `user_id`, due at
  `due_ms` (unix milliseconds).

  `message` is the FETCHED row (`%{id, channel_id, thread_id}`): the caller has
  already proven the owner may read it, and the stored channel comes from it,
  never from a request body (R12). Refusals, each before any write: an
  unknown kind (`:unknown_kind`), a shared kind (`:unsupported_kind` — no v1
  shared kind exists), a thread-reply target (`:thread_target` — a thread's
  read state is a second store, out of v1), the kind's due-time rule
  (`:due_at_in_past`, `:due_at_beyond_horizon`, `:due_at_required`), and the
  per-user cap (`:cap_reached` — a re-set of an existing mark never counts
  against it).
  """
  @spec set(integer(), String.t(), map(), integer() | nil, integer()) ::
          {:ok, mark()}
          | {:error,
             :unknown_kind
             | :unsupported_kind
             | :thread_target
             | :due_at_in_past
             | :due_at_beyond_horizon
             | :due_at_required
             | :cap_reached}
  def set(user_id, kind_id, message, due_ms, now_ms \\ System.system_time(:millisecond))
      when is_integer(user_id) and is_map(message) do
    with {:ok, kind} <- kind(kind_id),
         :ok <- if(kind.visibility() == :private, do: :ok, else: {:error, :unsupported_kind}),
         :ok <- if(message[:thread_id] in [nil], do: :ok, else: {:error, :thread_target}),
         :ok <- kind.validate_due(due_ms, now_ms) do
      existing = get(user_id, kind_id, message.id)

      with :ok <- cap_ok(user_id, existing) do
        mark_id = if existing, do: existing.mark_id, else: Cytale.Snowflake.next()
        due_at = DateTime.from_unix!(due_ms, :millisecond)
        created_at = (existing && existing.created_at) || DateTime.from_unix!(now_ms, :millisecond)

        Repo.execute!(
          "INSERT INTO {{K}}.message_marks_by_user (user_id, kind, target_id, channel_id, mark_id, due_at, state, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?) USING TTL ?",
          [
            {"bigint", user_id},
            {"text", kind_id},
            {"bigint", message.id},
            {"bigint", message.channel_id},
            {"bigint", mark_id},
            {"timestamp", due_at},
            {"timestamp", created_at},
            {"int", ttl_secs(due_ms + @lookback_ms + @retention_ms, now_ms)}
          ]
        )

        Repo.execute!(
          "INSERT INTO {{K}}.message_marks_by_due (due_bucket, due_at, mark_id, user_id, kind, target_id, channel_id, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending') USING TTL ?",
          [
            {"bigint", due_bucket(due_ms)},
            {"timestamp", due_at},
            {"bigint", mark_id},
            {"bigint", user_id},
            {"text", kind_id},
            {"bigint", message.id},
            {"bigint", message.channel_id},
            {"int", ttl_secs(due_ms + @sweep_interval_ms + @lookback_ms + @due_slack_ms, now_ms)}
          ]
        )

        # A re-set leaves the previous index row behind; the fence already
        # refuses it (its due_at no longer matches), and marking it here keeps
        # the cache honest for anyone reading the index.
        if existing && existing.state == "pending" && existing.due_at do
          mark_due_row(existing, "cancelled", now_ms)
        end

        telemetry(:set, kind_id)
        {:ok, get(user_id, kind_id, message.id)}
      end
    end
  end

  @doc """
  Cancel a pending mark. `:not_found` for a mark that does not exist or is
  no longer pending — cancelling twice is not an error the caller can use to
  learn anything.
  """
  @spec cancel(integer(), String.t(), integer(), integer()) :: :ok | {:error, :not_found | :unknown_kind}
  def cancel(user_id, kind_id, target_id, now_ms \\ System.system_time(:millisecond)) do
    with {:ok, _kind} <- kind(kind_id) do
      case get(user_id, kind_id, target_id) do
        %{state: "pending"} = mark ->
          :ok = transition(mark, "cancelled", now_ms)
          telemetry(:cancelled, kind_id)

        _ ->
          {:error, :not_found}
      end
    end
  end

  @doc "One of the owner's marks, or nil."
  @spec get(integer(), String.t(), integer()) :: mark() | nil
  def get(user_id, kind_id, target_id) do
    "SELECT user_id, kind, target_id, channel_id, mark_id, due_at, state, created_at FROM {{K}}.message_marks_by_user WHERE user_id = ? AND kind = ? AND target_id = ?"
    |> Repo.execute!([{"bigint", user_id}, {"text", kind_id}, {"bigint", target_id}])
    |> Enum.to_list()
    |> case do
      [row] -> row_to_mark(row)
      [] -> nil
    end
  end

  @doc """
  The owner's PENDING marks — the only list read (R7: the action shows its
  pending time). Keyed by the caller's own id; there is no other-user variant.
  """
  @spec list_pending(integer(), integer()) :: [mark()]
  def list_pending(user_id, now_ms \\ System.system_time(:millisecond)) when is_integer(user_id) do
    {pending, stale} =
      user_id
      |> all_rows()
      |> Enum.filter(&(&1.state == "pending"))
      |> Enum.split_with(&(is_nil(&1.due_at) or DateTime.to_unix(&1.due_at, :millisecond) >= now_ms - @lookback_ms))

    # A mark due longer ago than the lookback never fires (the sweeper would
    # resolve it `missed`, but only for windows it walks) — resolve it here
    # too, so no read path ever presents it as still pending.
    Enum.each(stale, &transition(&1, "missed", now_ms))
    pending
  end

  @doc """
  Move a mark to a terminal `state` on BOTH rows, with retention TTLs. The
  authoritative row is written first: it is what the fence reads.
  """
  @spec transition(mark(), String.t(), integer()) :: :ok
  def transition(mark, state, now_ms \\ System.system_time(:millisecond))
      when state in ["fired", "cancelled", "missed"] do
    Repo.execute!(
      "UPDATE {{K}}.message_marks_by_user USING TTL ? SET state = ?, channel_id = ?, mark_id = ?, due_at = ?, created_at = ? WHERE user_id = ? AND kind = ? AND target_id = ?",
      [
        {"int", ttl_secs(now_ms + @retention_ms, now_ms)},
        {"text", state},
        {"bigint", mark.channel_id},
        {"bigint", mark.mark_id},
        {"timestamp", mark.due_at},
        {"timestamp", mark.created_at},
        {"bigint", mark.user_id},
        {"text", mark.kind},
        {"bigint", mark.target_id}
      ]
    )

    if mark.due_at, do: mark_due_row(mark, state, now_ms)
    :ok
  end

  # The index row of `mark` (its bucket / due_at / mark_id) takes `state`.
  defp mark_due_row(mark, state, now_ms) do
    due_ms = DateTime.to_unix(mark.due_at, :millisecond)

    Repo.execute!(
      "UPDATE {{K}}.message_marks_by_due USING TTL ? SET state = ?, user_id = ?, kind = ?, target_id = ?, channel_id = ? WHERE due_bucket = ? AND due_at = ? AND mark_id = ?",
      [
        {"int", ttl_secs(now_ms + @retention_ms, now_ms)},
        {"text", state},
        {"bigint", mark.user_id},
        {"text", mark.kind},
        {"bigint", mark.target_id},
        {"bigint", mark.channel_id},
        {"bigint", due_bucket(due_ms)},
        {"timestamp", mark.due_at},
        {"bigint", mark.mark_id}
      ]
    )

    :ok
  end

  @doc """
  Remove every mark `user_id` owns (account deletion, #54 U8): one partition
  delete of the authoritative table. Index rows in `message_marks_by_due` are
  left to their TTLs — the fence finds no authoritative row and fires nothing.
  """
  @spec delete_all_for_user(integer()) :: :ok
  def delete_all_for_user(user_id) when is_integer(user_id) do
    Repo.execute!("DELETE FROM {{K}}.message_marks_by_user WHERE user_id = ?", [{"bigint", user_id}])
    :ok
  end

  # Labels: the kind and the outcome only — never an id (R2).
  defp telemetry(state, kind_id), do: :telemetry.execute([:cytale, :marks, state], %{count: 1}, %{kind: kind_id})

  defp all_rows(user_id) do
    "SELECT user_id, kind, target_id, channel_id, mark_id, due_at, state, created_at FROM {{K}}.message_marks_by_user WHERE user_id = ?"
    |> Repo.stream_rows!([{"bigint", user_id}])
    |> Enum.map(&row_to_mark/1)
  end

  # A re-set of an existing pending mark is not a new mark.
  defp cap_ok(_user_id, %{state: "pending"}), do: :ok

  defp cap_ok(user_id, _existing) do
    if length(list_pending(user_id)) >= @max_pending_per_user, do: {:error, :cap_reached}, else: :ok
  end

  # A clamped, positive TTL (seconds) until `until_ms`. Never zero or negative:
  # an overdue fire's retention arithmetic must not raise or disable the TTL.
  defp ttl_secs(until_ms, now_ms), do: max(div(until_ms - now_ms + 999, 1000), 60)

  defp row_to_mark(row) do
    %{
      user_id: row["user_id"],
      kind: row["kind"],
      target_id: row["target_id"],
      channel_id: row["channel_id"],
      mark_id: row["mark_id"],
      due_at: row["due_at"],
      # NULL reads as terminal — never as pending (a lapsed cell must not
      # resurrect a cancelled mark).
      state: row["state"],
      created_at: row["created_at"]
    }
  end
end
