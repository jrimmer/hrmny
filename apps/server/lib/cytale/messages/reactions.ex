defmodule Cytale.Messages.Reactions do
  @moduledoc """
  Unicode-emoji message reactions (Discord-shaped): existence rows in
  `reactions_by_message` (one row per (message, emoji, user) — existence IS
  the reaction) plus a real `counter` tally per (message, emoji) in
  `reaction_counts` (hardening plan 4.3).

  The tally is applied SERVER-SIDE (`count = count + ?`) so concurrent adds
  cannot lose an update; the existence row is written with `IF NOT EXISTS` and
  is the GATE that decides `:ok`/`:noop`, so only the winner of a race moves the
  tally. `summary/2` filters `count > 0` — a counter row cannot be created at
  zero and the last removal writes `-1` down to 0 rather than deleting the row
  (a delete would race a concurrent `+1` and lose the whole tally), so a zero
  row may linger and "no reactions" is a zero count, not an absent row.

  `emoji` is the raw Unicode emoji text (e.g. "👍") — a text clustering key.
  Cytale has no custom-emoji system; `:name:` syntax is rejected at
  validation (`validate_emoji/1`) and the compat wire always renders
  `emoji.id = null`.

  Semantics (binding):

    * `add/4` is IDEMPOTENT — an existence row that already exists (or a
      simultaneous add that won the `IF NOT EXISTS` gate) returns `:noop` with
      NO tally move; the caller emits no event for a no-op.
    * At most 20 DISTINCT emojis per message (Discord's cap) —
      the 21st distinct add is `{:error, :too_many_emojis}`.
    * Message delete cascades both tables (partition DELETE — see
      `Cytale.Messages.delete_message/2`).

  Partition rule mirrors the messages table: bucket =
  `Cytale.Snowflake.timestamp_ms(message_id) / 7 days` (the message's own
  bucket, `Cytale.Messages.bucket_for/1`).
  """

  alias Cytale.Messages
  alias Cytale.Repo

  @typedoc "One summary entry: the emoji text plus its server-side tally."
  @type summary_entry :: %{emoji: String.t(), count: integer()}

  # Discord's cap: 20 distinct emojis per message.
  @max_emojis 20
  # Emoji budget: 1–14 UTF-8 bytes (≤ 7 codepoints of 4-byte emoji-class
  # characters), no colon (custom-emoji `:name:` syntax is rejected — Cytale
  # has no emoji system).
  @max_emoji_bytes 14

  @doc "The per-message distinct-emoji cap (Discord parity)."
  @spec max_emojis() :: pos_integer()
  def max_emojis, do: @max_emojis

  @doc """
  Validate an emoji payload: a non-empty UTF-8 binary of 1–#{@max_emoji_bytes}
  bytes containing no colon (custom-emoji `:name:` syntax is rejected —
  `emoji.id` is always null on the wire).
  """
  @spec validate_emoji(term()) :: :ok | {:error, :invalid_emoji}
  def validate_emoji(emoji) when is_binary(emoji) do
    cond do
      byte_size(emoji) == 0 -> {:error, :invalid_emoji}
      byte_size(emoji) > @max_emoji_bytes -> {:error, :invalid_emoji}
      not String.valid?(emoji) -> {:error, :invalid_emoji}
      String.contains?(emoji, ":") -> {:error, :invalid_emoji}
      true -> :ok
    end
  end

  def validate_emoji(_), do: {:error, :invalid_emoji}

  @doc """
  Add `user_id`'s `emoji` reaction on a message. Idempotent: when the existence
  row already exists (or a simultaneous add won it) the result is `:noop` — NO
  tally move, and the caller emits no event. Returns:

    * `:ok` — the reaction landed (0→1 or n→n+1); emit MessageReactionAdd.
    * `:noop` — already reacted; state unchanged, emit nothing.
    * `{:error, :invalid_emoji}` / `{:error, :too_many_emojis}` — 400-class.
  """
  @spec add(integer(), integer(), integer(), String.t()) ::
          :ok | :noop | {:error, :invalid_emoji | :too_many_emojis}
  def add(channel_id, message_id, user_id, emoji)
      when is_integer(channel_id) and is_integer(message_id) and is_integer(user_id) do
    with :ok <- validate_emoji(emoji) do
      counts = summary(channel_id, message_id)

      cond do
        # A NEW distinct emoji past Discord's cap: nothing lands. The cap is a
        # read, so two simultaneous adds of two DIFFERENT new emojis at the
        # boundary can both pass (pre-existing, unrelated to the tally).
        count_of(counts, emoji) == nil and length(counts) >= @max_emojis ->
          {:error, :too_many_emojis}

        # The existence row's `IF NOT EXISTS` result IS the decision (O3): one
        # simultaneous double-add by the same user used to read `:absent` twice
        # and move the tally twice.
        insert_reaction_row(channel_id, message_id, user_id, emoji) == :inserted ->
          :ok = bump_or_queue_recount(channel_id, message_id, emoji, 1)
          :ok

        true ->
          :noop
      end
    end
  end

  @doc """
  Remove `user_id`'s own reaction. Idempotent: an absent row is `:noop` (no
  event). A successful remove moves the tally (n→n-1; 1→0 leaves a zero row that
  reads filter — see the moduledoc).
  """
  @spec remove(integer(), integer(), integer(), String.t()) :: :ok | :noop | {:error, :invalid_emoji}
  def remove(channel_id, message_id, user_id, emoji), do: do_remove(channel_id, message_id, user_id, emoji)

  @doc """
  Remove ANOTHER principal's reaction (the `manage_messages` per-user admin
  path). Same semantics as `remove/4` — the acting principal's rights are
  the controller's gate, not this layer's.
  """
  @spec remove_user_reaction(integer(), integer(), integer(), String.t()) ::
          :ok | :noop | {:error, :invalid_emoji}
  def remove_user_reaction(channel_id, message_id, user_id, emoji),
    do: do_remove(channel_id, message_id, user_id, emoji)

  defp do_remove(channel_id, message_id, user_id, emoji) do
    with :ok <- validate_emoji(emoji) do
      # `IF EXISTS` decides exactly-once the same way the add gate does: only the
      # call that actually removed the row moves the tally.
      case delete_reaction_row(channel_id, message_id, user_id, emoji) do
        :deleted ->
          :ok = bump_or_queue_recount(channel_id, message_id, emoji, -1)
          :ok

        :absent ->
          :noop
      end
    end
  end

  @doc """
  Clear ONE emoji for everyone (Discord's `DELETE .../reactions/{emoji}`,
  `manage_messages`). `except_user_id` optionally spares one user's row (the
  acting manager's own). Returns `{:ok, removed_user_ids}` — the caller
  emits one MessageReactionRemove PER REMOVED USER (Discord's behavior);
  the tally is written down by exactly what was removed, and never below zero.
  """
  @spec remove_others(integer(), integer(), String.t(), integer() | nil) ::
          {:ok, [integer()]} | {:error, :invalid_emoji}
  def remove_others(channel_id, message_id, emoji, except_user_id \\ nil) do
    with :ok <- validate_emoji(emoji) do
      # The tally BEFORE the sweep, which is also the clamp on the delta below.
      current = count_of(summary(channel_id, message_id), emoji) || 0

      removed =
        reaction_users(channel_id, message_id, emoji, nil, nil)
        |> Enum.reject(&(&1 == except_user_id))

      delete_reaction_rows(channel_id, message_id, emoji, removed)

      # ONE delta for the whole sweep, clamped to the tally we read. One
      # conditional delete per reactor would be exact but costs a serialized
      # LWT round per reactor inside a single partition — hundreds of Paxos
      # rounds on a trending message, for a `manage_messages` action. The clamp
      # is what makes the cheap version safe: two overlapping sweeps of the same
      # emoji can each subtract, but the tally can never be driven NEGATIVE (a
      # negative tally is invisible to every read while the existence rows
      # remain, which would be worse than a count that is merely low).
      delta = -min(length(removed), current)
      if delta < 0, do: :ok = bump_count(channel_id, message_id, emoji, delta)

      {:ok, removed}
    end
  end

  # The rows go in ONE unlogged batch per page (no LWT: the sweep is
  # unconditional — every listed user's row goes, and a row that a concurrent
  # removal already took is simply gone).
  defp delete_reaction_rows(channel_id, message_id, emoji, user_ids) do
    user_ids
    |> Enum.chunk_every(100)
    |> Enum.each(fn chunk ->
      Repo.batch!(
        Enum.map(chunk, fn user_id ->
          {"DELETE FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ? AND user_id = ?",
           pk_params(channel_id, message_id) ++ [{"text", emoji}, {"bigint", user_id}]}
        end)
      )
    end)

    :ok
  end

  @doc """
  Clear EVERY reaction on a message (Discord's `DELETE .../reactions`,
  `manage_messages`). The existence rows die wholesale (one partition DELETE on
  a normal table); the tallies are ZEROED rather than deleted, because a CQL
  counter DELETE would make every later reaction on this message invisible (see
  `bump_count/4`). Returns `:ok` — the caller emits ONE MessageReactionRemoveAll
  (Discord emits REMOVE_ALL only for the full clear).
  """
  @spec remove_all(integer(), integer()) :: :ok
  def remove_all(channel_id, message_id) do
    # Read the tallies BEFORE the existence rows go: they are what the counter
    # deltas below subtract, and `summary/2` is already the filtered view.
    tallies = summary(channel_id, message_id)

    Repo.execute!(
      "DELETE FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      pk_params(channel_id, message_id)
    )

    for %{emoji: emoji, count: count} <- tallies, count > 0 do
      :ok = bump_count(channel_id, message_id, emoji, -count)
    end

    :ok
  end

  @doc """
  Users who reacted with `emoji`, ascending by user_id (the clustering
  order). `after` is an exclusive cursor on user_id; `limit` bounds the
  page (the caller caps at 100, Discord's ceiling). Returns
  `{user_ids, next_after}` — `next_after` is the cursor for the next page
  (nil when exhausted).
  """
  @spec list_users(integer(), integer(), String.t(), keyword()) :: {[integer()], integer() | nil}
  def list_users(channel_id, message_id, emoji, opts \\ []) do
    limit = Keyword.get(opts, :limit, 100)
    after_id = Keyword.get(opts, :after)

    reaction_users(channel_id, message_id, emoji, after_id, limit + 1)
    |> case do
      [] ->
        {[], nil}

      users when length(users) > limit ->
        page = Enum.take(users, limit)
        {page, List.last(page)}

      users ->
        {users, nil}
    end
  end

  @doc "Every emoji count for a message (the counts partition read). Absent rows are zero — an empty list means no reactions."
  @spec summary(integer(), integer()) :: [summary_entry()]
  def summary(channel_id, message_id) do
    Repo.execute!(
      "SELECT emoji, count FROM {{K}}.reaction_counts WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      pk_params(channel_id, message_id)
    )
    |> Enum.to_list()
    |> Enum.map(fn row -> %{emoji: row["emoji"], count: row["count"] || 0} end)
    # A zero tally is "no reactions": the counter row lingers there (see the
    # moduledoc) rather than being deleted.
    |> Enum.filter(&(&1.count > 0))
  end

  @doc "The set of emojis `user_id` reacted with on a message (the `me` flags)."
  @spec me_flags(integer(), integer(), integer()) :: MapSet.t(String.t())
  def me_flags(channel_id, message_id, user_id) do
    Repo.execute!(
      "SELECT emoji, user_id FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      pk_params(channel_id, message_id)
    )
    |> Enum.filter(&(&1["user_id"] == user_id))
    |> Enum.map(& &1["emoji"])
    |> MapSet.new()
  end

  @doc """
  The native `"reactions"` JSON array for a message projection — `nil` when
  the message has no reactions (the key is ABSENT on the wire), else entries
  `%{"emoji" => e, "count" => n, "me" => bool}`. `me` is computed against
  `viewer_id` (nil viewer ⇒ `me: false` — the fan-out projection has no
  single recipient).

  This is the SINGLE-MESSAGE form (two point reads). A page must use
  `render_many/3`, which answers the same shapes with a bounded number of reads
  (hardening plan 2.1).
  """
  @spec render(integer(), integer(), integer() | nil) :: [map()] | nil
  def render(channel_id, message_id, viewer_id \\ nil) do
    rows = [%{id: message_id, bucket: bucket(message_id)}]
    render_many(channel_id, rows, viewer_id) |> Map.get(message_id)
  end

  @typedoc "A page row: anything carrying `:id`, plus `:bucket` when the caller has it."
  @type render_row :: %{required(:id) => integer(), optional(:bucket) => integer()}

  @doc """
  `render/3` for a WHOLE PAGE, in a bounded number of reads (hardening plan
  2.1).

  `render/3` per message made `GET /channels/:id/messages` issue 2 point reads
  per row — 200 for a 100-message page, plus the same again on the compat twin.
  Both reaction tables are partitioned `(channel_id, bucket, message_id)`, so the
  ids are grouped by bucket and read with ONE `message_id IN ?` statement per
  bucket (a page is one channel, so that is one or two statements), and the
  viewer's `me` flags — needed only for messages that HAVE reactions — come back
  in one more.

  Returns `%{message_id => [entry]}` with ONLY the messages that have reactions;
  a message absent from the map has none, which is exactly `render/3`'s `nil`
  (the wire key stays absent).

  Row volume note: the batched `me` read pulls the page's `reactions_by_message`
  rows and filters the viewer in memory, so a page holding a heavily reacted
  message moves that message's reaction rows. The alternative — one read per
  reacted message — trades round trips for rows, and the plan chose one round
  trip; the per-row payload is three short columns.
  """
  @spec render_many(integer(), [render_row()], integer() | nil) :: %{optional(integer()) => [map()]}
  def render_many(_channel_id, [], _viewer_id), do: %{}

  def render_many(channel_id, rows, viewer_id) do
    by_bucket = rows |> Enum.group_by(&bucket_of/1, & &1.id)

    counts = counts_by_message(channel_id, by_bucket)

    case Map.keys(counts) do
      [] ->
        %{}

      reacted_ids ->
        mine = if viewer_id, do: mine_by_message(channel_id, by_bucket, reacted_ids, viewer_id), else: %{}

        Map.new(counts, fn {message_id, entries} ->
          mine_for = Map.get(mine, message_id, MapSet.new())

          rendered =
            Enum.map(entries, fn %{emoji: emoji, count: count} ->
              %{"emoji" => emoji, "count" => count, "me" => MapSet.member?(mine_for, emoji)}
            end)

          {message_id, rendered}
        end)
    end
  end

  # One round trip per bucket group: the partition key's message_id component
  # takes the whole page's ids. Rows arrive cluster-ordered (`emoji ASC`) within
  # each message, so appending preserves `summary/2`'s order. A zero tally is
  # dropped here for the same reason `summary/2` filters it: the counter row
  # lingers after the last removal (see the moduledoc), and the wire must not
  # carry an emoji nobody reacted with.
  defp counts_by_message(channel_id, by_bucket) do
    Enum.reduce(by_bucket, %{}, fn {bucket, ids}, acc ->
      Repo.execute!(
        "SELECT message_id, emoji, count FROM {{K}}.reaction_counts WHERE channel_id = ? AND bucket = ? AND message_id IN ?",
        [{"bigint", channel_id}, {"int", bucket}, {"list<bigint>", ids}]
      )
      |> Enum.reduce(acc, fn row, inner ->
        if (row["count"] || 0) > 0 do
          entry = %{emoji: row["emoji"], count: row["count"]}
          Map.update(inner, row["message_id"], [entry], &(&1 ++ [entry]))
        else
          inner
        end
      end)
    end)
  end

  # The viewer's own emojis, for the messages that have any, in one read per
  # bucket group; the `user_id` filter runs here because it is the LAST
  # clustering column (filtering it server-side would need ALLOW FILTERING).
  defp mine_by_message(channel_id, by_bucket, reacted_ids, viewer_id) do
    reacted = MapSet.new(reacted_ids)

    Enum.reduce(by_bucket, %{}, fn {bucket, ids}, acc ->
      wanted = Enum.filter(ids, &MapSet.member?(reacted, &1))

      if wanted == [] do
        acc
      else
        Repo.execute!(
          "SELECT message_id, emoji, user_id FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id IN ?",
          [{"bigint", channel_id}, {"int", bucket}, {"list<bigint>", wanted}]
        )
        |> Enum.reduce(acc, fn row, inner ->
          if row["user_id"] == viewer_id do
            Map.update(inner, row["message_id"], MapSet.new([row["emoji"]]), &MapSet.put(&1, row["emoji"]))
          else
            inner
          end
        end)
      end
    end)
  end

  # Page rows carry the bucket from storage; a caller with only an id (the
  # single-message form, or a wire map) gets it derived exactly as the keys are.
  defp bucket_of(%{bucket: bucket}) when is_integer(bucket), do: bucket
  defp bucket_of(%{id: id}), do: bucket(id)

  # -- internals -----------------------------------------------------------------

  defp bucket(message_id), do: Messages.bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

  defp pk_params(channel_id, message_id),
    do: [{"bigint", channel_id}, {"int", bucket(message_id)}, {"bigint", message_id}]

  # The existence row's conditional write IS the idempotence decision
  # (hardening plan 4.3, O3): `:inserted` ⇒ this call created the reaction and
  # owns the tally move, `:exists` ⇒ another call already did.
  defp insert_reaction_row(channel_id, message_id, user_id, emoji) do
    page =
      Repo.query!(
        "INSERT INTO {{K}}.reactions_by_message (channel_id, bucket, message_id, emoji, user_id) VALUES (?, ?, ?, ?, ?) IF NOT EXISTS",
        [
          {"bigint", channel_id},
          {"int", bucket(message_id)},
          {"bigint", message_id},
          {"text", emoji},
          {"bigint", user_id}
        ]
      )

    if Repo.lwt_applied?(page), do: :inserted, else: :exists
  end

  # `:deleted` ⇒ this call removed the row and owns the tally move.
  defp delete_reaction_row(channel_id, message_id, user_id, emoji) do
    page =
      Repo.query!(
        "DELETE FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ? AND user_id = ? IF EXISTS",
        pk_params(channel_id, message_id) ++ [{"text", emoji}, {"bigint", user_id}]
      )

    if Repo.lwt_applied?(page), do: :deleted, else: :absent
  end

  # The tally move: a SERVER-SIDE delta. `= ?` on a counter is rejected
  # ("Invalid operation ... for counter column"), and a row delete on the way to
  # zero races a concurrent `+1` (the delete lands last and the whole tally is
  # gone while the existence rows remain), so zero is a value here, not an
  # absence — `summary/2` filters it.
  #
  # NEVER DELETE a counter row or partition for a message that can still receive
  # reactions: a CQL counter DELETE leaves a tombstone that DISCARDS the
  # increments written after it (probed against ScyllaDB 2026.2 — `count = count
  # + 1` after a row delete, and after a partition delete, reads back as absent
  # until the tombstone is compacted away). That is why `remove_all/2` zeroes the
  # tally instead of deleting it, and why `Messages.delete_message/2` — whose
  # message id can never be reused — is the only place a counter partition delete
  # is safe.
  # The existence row (the LWT above) and the tally are SEPARATE statements —
  # a counter cannot join a conditional batch — so a failure between them
  # leaves the tally off by one while the row is right. The row is the
  # authority and has landed, so the caller still gets `:ok` (it IS the
  # outcome); the message is queued for `recount/2` (review #24) instead of
  # the drift being permanent.
  defp bump_or_queue_recount(channel_id, message_id, emoji, delta) do
    bump_count(channel_id, message_id, emoji, delta)
  rescue
    e ->
      require Logger
      Logger.warning("reaction tally bump failed (#{Exception.message(e)}); queued for recount")
      Cytale.Maintenance.Recount.mark_reactions(channel_id, message_id)
      :ok
  end

  @doc """
  Rederive a message's per-emoji tallies from its existence rows (review #24)
  and move each counter by the difference. The counters are read before and
  after the rows; if they moved in between (a reaction landed mid-recount) the
  repair is NOT applied — a delta computed across a concurrent write would
  itself be wrong — and `:retry` asks to be queued again. `:ok` otherwise.
  """
  @spec recount(integer(), integer()) :: :ok | :retry
  def recount(channel_id, message_id) when is_integer(channel_id) and is_integer(message_id) do
    before = raw_tallies(channel_id, message_id)

    actual =
      Repo.execute!(
        "SELECT emoji FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ?",
        pk_params(channel_id, message_id)
      )
      |> Enum.map(& &1["emoji"])
      |> Enum.frequencies()

    if raw_tallies(channel_id, message_id) != before do
      :retry
    else
      (Map.keys(before) ++ Map.keys(actual))
      |> Enum.uniq()
      |> Enum.each(fn emoji ->
        case Map.get(actual, emoji, 0) - Map.get(before, emoji, 0) do
          0 -> :ok
          delta -> :ok = bump_count(channel_id, message_id, emoji, delta)
        end
      end)

      :ok
    end
  end

  # The counters as stored, zero rows included (`summary/2` filters those).
  defp raw_tallies(channel_id, message_id) do
    Repo.execute!(
      "SELECT emoji, count FROM {{K}}.reaction_counts WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      pk_params(channel_id, message_id)
    )
    |> Map.new(fn row -> {row["emoji"], row["count"] || 0} end)
  end

  defp bump_count(channel_id, message_id, emoji, delta) when is_integer(delta) do
    Repo.query!(
      "UPDATE {{K}}.reaction_counts SET count = count + ? WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ?",
      [{"bigint", delta}] ++ pk_params(channel_id, message_id) ++ [{"text", emoji}]
    )

    :ok
  end

  defp reaction_users(channel_id, message_id, emoji, after_id, limit) do
    {stmt, params} =
      if after_id do
        {"SELECT user_id FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ? AND user_id > ?",
         pk_params(channel_id, message_id) ++ [{"text", emoji}, {"bigint", after_id}]}
      else
        {"SELECT user_id FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ? AND emoji = ?",
         pk_params(channel_id, message_id) ++ [{"text", emoji}]}
      end

    {stmt, params} =
      if limit, do: {stmt <> " LIMIT #{limit}", params}, else: {stmt, params}

    Repo.execute!(stmt, params)
    |> Enum.to_list()
    |> Enum.map(& &1["user_id"])
  end

  defp count_of(counts, emoji) do
    case Enum.find(counts, &(&1.emoji == emoji)) do
      %{count: count} -> count
      nil -> nil
    end
  end
end
