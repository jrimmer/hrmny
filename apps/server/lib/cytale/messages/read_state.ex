defmodule Cytale.Messages.ReadState do
  @moduledoc """
  One writer and one reader for per-member read state (plan U1, R17).

  Before this module the table had two inline writers — the native ack route
  and its compat twin — and no reader at all in production code. Delivery
  decisions and unread badges therefore could not agree, because only one side
  could be asked.

  ## Two directions, two columns

  `last_read_id` is INCLUSIVE: this message and everything before it is read.
  That alone cannot express "mark this message unread", because moving the
  watermark *to* the marked message leaves it read. `unread_floor` carries the
  other direction and is EXCLUSIVE: this message and everything after it is
  unread.

  A member can hold both at once — the floor can sit *below* the watermark,
  which is exactly the state "mark an old message unread while newer messages
  stay read". `unread_since?/3` resolves the pair, and it is the only place
  that should be asked.

  ## Partial writes

  Each caller supplies only the columns it is authoritative for. This is
  load-bearing, not a convenience: the ack path owns `last_read_id` and
  supplies counters, and if a write also blanked `unread_floor` it would
  silently clear an unread range the member set by hand. Scylla has no
  "column absent vs. explicitly null" distinction on write, so a `nil` value
  means *do not touch this column* rather than *set it to null*. Clearing is
  explicit, through `clear_unread_floor/2`.
  """

  alias Cytale.Repo

  @type state :: %{last_read_id: integer() | nil, unread_floor: integer() | nil}

  @doc """
  Write the columns the caller owns. Keys may be atoms or strings; a `nil`
  value leaves that column as it was.

  Unknown keys are ignored, so a caller can spread a wider params map in
  without tripping the query builder.
  """
  @spec write(integer(), integer(), map()) :: :ok
  def write(user_id, channel_id, attrs) when is_integer(user_id) and is_integer(channel_id) do
    {assignments, params} = build_assignments(attrs)

    # Prepared (review #23): the read-ack hot path. The statement text varies
    # only with WHICH columns are assigned (a handful of shapes), so the
    # prepared cache holds one entry per shape.
    Repo.query!(
      "INSERT INTO {{K}}.read_state (user_id, channel_id#{column_list(assignments)}) VALUES (?, ?#{placeholder_list(assignments)})",
      [{"bigint", user_id}, {"bigint", channel_id} | params]
    )

    :ok
  end

  @doc "Clear an explicit unread floor, leaving the watermark in place."
  @spec clear_unread_floor(integer(), integer()) :: :ok
  def clear_unread_floor(user_id, channel_id)
      when is_integer(user_id) and is_integer(channel_id) do
    Repo.execute!(
      "DELETE unread_floor FROM {{K}}.read_state WHERE user_id = ? AND channel_id = ?",
      [{"bigint", user_id}, {"bigint", channel_id}]
    )

    :ok
  end

  @doc """
  Tell the member's OWN sessions what their read state for `channel_id` now
  is (#54) — `ReadStateUpdate`, one authoritative channel entry in the
  `ReadStateSync` entry shape. Sent whenever the server moves read state the
  client did not move itself: a fired reminder, and a floor set or cleared on
  one device (so the member's other devices converge). User-addressed: it
  never reaches anyone else.
  """
  @spec broadcast_update(integer(), integer()) :: :ok
  def broadcast_update(user_id, channel_id) when is_integer(user_id) and is_integer(channel_id) do
    state = get(user_id, channel_id)

    payload = %{
      "channel_id" => Integer.to_string(channel_id),
      "last_read_id" => state && state.last_read_id && Integer.to_string(state.last_read_id),
      "unread_floor" => state && state.unread_floor && Integer.to_string(state.unread_floor),
      "unread_count" => unread_count(user_id, channel_id, state),
      # Lane D #2: the mention half, so a reminder or another device's floor
      # change moves the "@" badge too (nil = could not be read).
      "mention_count" => unread_mention_count(user_id, channel_id, state)
    }

    CytaleWeb.GatewaySocket.fan_out(
      Cytale.Gateway.PushRegistry.user_key(Integer.to_string(user_id)),
      {"ReadStateUpdate", payload}
    )
  end

  @doc "The member's stored read state for a channel, or `nil` when none exists."
  @spec get(integer(), integer()) :: state() | nil
  def get(user_id, channel_id) when is_integer(user_id) and is_integer(channel_id) do
    case Repo.query!(
           "SELECT last_read_id, unread_floor FROM {{K}}.read_state WHERE user_id = ? AND channel_id = ?",
           [{"bigint", user_id}, {"bigint", channel_id}]
         )
         |> Enum.to_list() do
      [%{"last_read_id" => last_read, "unread_floor" => floor}] ->
        %{last_read_id: last_read, unread_floor: floor}

      [] ->
        nil
    end
  end

  @doc """
  Every read-state row a member holds, keyed by the channel (or, for a thread
  ack, the thread id that occupies that column).

  One partition read. This is the source for the session-start sync: without
  it a reconnecting client can only start empty, which is why the badge used
  to disagree with what a member had already read.
  """
  @spec all_for_user(integer()) :: [
          %{channel_id: integer(), last_read_id: integer() | nil, unread_floor: integer() | nil}
        ]
  def all_for_user(user_id) when is_integer(user_id) do
    Repo.execute!(
      "SELECT channel_id, last_read_id, unread_floor FROM {{K}}.read_state WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.map(fn row ->
      %{
        channel_id: row["channel_id"],
        last_read_id: row["last_read_id"],
        unread_floor: row["unread_floor"]
      }
    end)
  end

  @doc """
  Whether `message_id` is unread for this member.

  When an explicit floor exists it wins: the member said "this is unread", and
  an acknowledgement that happened afterwards would otherwise contradict
  them. Otherwise the inclusive watermark decides.
  """
  @spec unread_since(integer(), integer(), integer()) :: boolean()
  def unread_since(user_id, channel_id, message_id)
      when is_integer(message_id) do
    case get(user_id, channel_id) do
      nil -> true
      %{unread_floor: floor} when is_integer(floor) -> message_id >= floor
      %{last_read_id: nil} -> true
      %{last_read_id: last_read} -> message_id > last_read
    end
  end

  # ---------------------------------------------------------------------------
  # The unread COUNT (U2, R22a) — the query that produces a badge
  # ---------------------------------------------------------------------------
  #
  # `all_for_user/1` gives watermarks, not counts: a watermark is a position and
  # a badge is a number, and a client that has loaded nothing for a channel
  # cannot turn one into the other. This is that number.
  #
  # The shape of the answer, stated because a badge is not an audit:
  #
  #   * a message counts as unread when it is NOT a thread reply (the channel
  #     timeline hides those — `Cytale.Messages.history/2` filters them the same
  #     way) and was not written by the member themselves (the client's own
  #     per-message derivation skips their own messages, so a server count that
  #     included them would make the two disagree about the same channel);
  #   * the floor, when one is set, wins over the watermark — the same rule
  #     `unread_since/3` applies;
  #   * the count is BOUNDED: it walks back at most `max_buckets/0` buckets
  #     (7-day buckets, so 21 days) and never reports more than `count_cap/0`.
  #     A channel with more unread than that reports the cap, and a channel
  #     whose unread is older than the window reports 0 — the badge is a
  #     bounded statement about the recent window, not an unbounded count.
  #
  # Cost, stated plainly: one bounded, LIMIT-ed row read per bucket walked (at
  # most `max_buckets/0`) per channel asked about. The session-start sync asks
  # about every channel the session can see, because R22a's whole point is the
  # channels the client has loaded nothing for; the walk stops the moment the
  # cap is reached, which is the common case for a busy channel.

  # The count never exceeds this; the client renders "the cap or more".
  @count_cap 99

  # How far back the walk goes. Three 7-day buckets covers the window a
  # terminal badge is about without turning one session start into a scan of a
  # channel's history.
  @max_buckets 3

  @doc "The largest count reported; a busier channel reports exactly this."
  @spec count_cap() :: pos_integer()
  def count_cap, do: @count_cap

  @doc "How many 7-day buckets back the count walks."
  @spec max_buckets() :: pos_integer()
  def max_buckets, do: @max_buckets

  @doc """
  The unread count for one channel, given the member's read state for it (or
  `nil` when there is no row — a channel the member has never acknowledged,
  where every message in the walked window is unread).
  """
  @spec unread_count(integer(), integer(), state() | nil) :: non_neg_integer()
  def unread_count(user_id, channel_id, state)
      when is_integer(user_id) and is_integer(channel_id) do
    now_bucket = bucket_of(System.system_time(:millisecond))
    stop_bucket = stop_bucket(state, now_bucket)

    count_buckets(user_id, channel_id, state, now_bucket, stop_bucket, 0)
  end

  @doc """
  Counts for many channels at once: `%{channel_id => count}`.

  `states` maps channel id to the member's stored state (or omits it, which
  means "never acknowledged"). Channels absent from the result map had a
  storage failure; callers treat a missing key as "not reported" rather than as
  zero, so a broken read cannot silently clear a badge.

  PERF-01: the per-channel walks are independent (each channel's buckets are
  its own partitions), so they run CONCURRENTLY instead of as one serial chain
  — a session-start sync asks about every visible channel, and each walk is up
  to `max_buckets/0` bounded reads. The merge stays `ordered: true` so the
  result map is deterministic for a given input, and the error contract is
  exactly `count_for/3`'s: a failed (or abnormally-dead) walk contributes NO
  key rather than a zero.
  """
  @spec unread_counts(integer(), [integer()], %{optional(integer()) => state()}) ::
          %{optional(integer()) => non_neg_integer()}
  def unread_counts(user_id, channel_ids, states)
      when is_integer(user_id) and is_list(channel_ids) and is_map(states) do
    # max_concurrency must be >= 1 for Task.async_stream; the min() keeps a
    # session start from opening one task per channel on a huge roster.
    concurrency = max(1, min(8, length(channel_ids)))

    channel_ids
    |> Task.async_stream(
      fn channel_id -> {channel_id, count_for(user_id, channel_id, Map.get(states, channel_id))} end,
      max_concurrency: concurrency,
      ordered: true
    )
    |> Enum.reduce(%{}, fn
      {:ok, {channel_id, {:ok, count}}}, acc -> Map.put(acc, channel_id, count)
      # count_for/3 already rescues every leg-internal failure to :error; an
      # :exit can only mean the leg PROCESS died, which is the same "not
      # reported" outcome — absent key, never a zero.
      {:ok, {_channel_id, :error}}, acc -> acc
      {:exit, _reason}, acc -> acc
    end)
  end

  # ---------------------------------------------------------------------------
  # The unread MENTION count (lane D #2) — the badge's "@" half
  # ---------------------------------------------------------------------------
  #
  # The client used to learn mentions only from live traffic, so a reload
  # showed every channel's mention badge as zero. The durable fact already
  # exists: `mention_events` (the #117 inbox) holds one row per message that
  # addressed the member. This turns those EVENTS into a per-channel number
  # through the ONE position — the watermark (and a hand-set floor, which
  # outranks it, exactly as `unread_since/3` rules) — so it is a projection of
  # the read state, not a second one: nothing here is written, and a mention
  # at or below the watermark never counts even when its inbox row is still
  # open. Channel-timeline mentions only (a thread reply's row belongs to its
  # thread's read, the same split the unread count makes).

  # One bounded partition read: the member's newest open mention rows. A member
  # with more open mentions than this reports a lower bound, which a badge that
  # renders "99+" long before this cap cannot distinguish.
  @mention_scan 500

  @doc """
  Unread mention counts for the member, by channel: `{:ok, %{channel_id =>
  count}}` (channels with none are absent — callers default them to 0), or
  `:error` when the backlog could not be read (callers report "not reported",
  never zero). `states` is the member's read state by channel, as
  `unread_counts/3` takes it.
  """
  @spec unread_mention_counts(integer(), %{optional(integer()) => state()}) ::
          {:ok, %{optional(integer()) => pos_integer()}} | :error
  def unread_mention_counts(user_id, states) when is_integer(user_id) and is_map(states) do
    counts =
      Repo.execute!(
        "SELECT message_id, channel_id, thread_id FROM {{K}}.mention_events WHERE user_id = ? LIMIT #{@mention_scan}",
        [{"bigint", user_id}]
      )
      |> Enum.reduce(%{}, fn row, acc ->
        channel_id = row["channel_id"]

        if is_nil(row["thread_id"]) and mention_unread?(row["message_id"], Map.get(states, channel_id)) do
          Map.update(acc, channel_id, 1, &(&1 + 1))
        else
          acc
        end
      end)

    {:ok, counts}
  rescue
    # A badge, not a gate: a failed read reports nothing rather than zero.
    _error -> :error
  end

  @doc "One channel's unread mention count (nil when it could not be read)."
  @spec unread_mention_count(integer(), integer(), state() | nil) :: non_neg_integer() | nil
  def unread_mention_count(user_id, channel_id, state) do
    states = if state, do: %{channel_id => state}, else: %{}

    case unread_mention_counts(user_id, states) do
      {:ok, counts} -> Map.get(counts, channel_id, 0)
      :error -> nil
    end
  end

  defp mention_unread?(message_id, state) when is_integer(message_id) do
    case bound(state) do
      nil -> true
      {:gte, floor} -> message_id >= floor
      {:gt, last} -> message_id > last
    end
  end

  defp mention_unread?(_message_id, _state), do: false

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp count_for(user_id, channel_id, state) do
    {:ok, unread_count(user_id, channel_id, state)}
  rescue
    # A count is a badge, not a gate: a read failure reports "not reported"
    # rather than clearing (or inventing) unread state.
    _error -> :error
  end

  # The bound the count counts above: the floor's message (inclusive) when a
  # floor is set, else messages strictly newer than the watermark, else every
  # message in the window.
  defp count_buckets(_user_id, _channel_id, _state, bucket, stop_bucket, acc)
       when bucket < stop_bucket or acc >= @count_cap,
       do: acc

  defp count_buckets(user_id, channel_id, state, bucket, stop_bucket, acc) do
    count = bucket_count(user_id, channel_id, state, bucket)
    count_buckets(user_id, channel_id, state, bucket - 1, stop_bucket, min(acc + count, @count_cap))
  end

  defp stop_bucket(state, now_bucket) do
    oldest = now_bucket - (@max_buckets - 1)

    case bound(state) do
      nil ->
        oldest

      {_comparison, message_id} ->
        max(bucket_of(Cytale.Snowflake.timestamp_ms(message_id)), oldest)
    end
  end

  defp bound(%{unread_floor: floor}) when is_integer(floor), do: {:gte, floor}
  defp bound(%{last_read_id: last}) when is_integer(last), do: {:gt, last}
  defp bound(_state), do: nil

  defp bucket_count(user_id, channel_id, state, bucket) do
    {stmt, params} = count_stmt(channel_id, state, bucket)

    Repo.execute!(stmt, params)
    |> Enum.count(fn row ->
      # Thread replies belong to their thread's read, and a member's own
      # messages never count as unread for them (see the section comment).
      is_nil(row["thread_id"]) and row["author_id"] != user_id
    end)
  end

  # The row cap is a compile-time constant and is INTERPOLATED rather than
  # bound: a bind marker in LIMIT is one more thing the driver and the server
  # have to agree about, and a constant integer cannot be injected into.
  defp count_stmt(channel_id, state, bucket) do
    base =
      "SELECT message_id, author_id, thread_id FROM {{K}}.messages " <>
        "WHERE channel_id = ? AND bucket = ?"

    case bound(state) do
      nil ->
        {base <> " LIMIT #{@count_cap}", [{"bigint", channel_id}, {"int", bucket}]}

      {:gte, message_id} ->
        {base <> " AND message_id >= ? LIMIT #{@count_cap}",
         [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]}

      {:gt, message_id} ->
        {base <> " AND message_id > ? LIMIT #{@count_cap}",
         [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]}
    end
  end

  defp bucket_of(ms), do: Cytale.Messages.bucket_for(ms)

  defp build_assignments(attrs) do
    attrs
    |> normalize_keys()
    |> Enum.reduce({[], []}, fn
      {_key, nil}, acc -> acc
      {:last_read_id, value}, {cols, params} -> add("last_read_id", value, cols, params)
      {:unread_floor, value}, {cols, params} -> add("unread_floor", value, cols, params)
      {_other, _value}, acc -> acc
    end)
  end

  defp normalize_keys(attrs) do
    Enum.map(attrs, fn
      {key, value} when is_binary(key) -> {safe_key(key), value}
      {key, value} -> {key, value}
    end)
  end

  defp safe_key("last_read_id"), do: :last_read_id
  defp safe_key("unread_floor"), do: :unread_floor
  defp safe_key(_other), do: :ignored

  defp add(column, value, cols, params), do: {[column | cols], params ++ [{"bigint", value}]}

  defp column_list([]), do: ""
  defp column_list(cols), do: ", " <> Enum.join(Enum.reverse(cols), ", ")

  defp placeholder_list([]), do: ""
  defp placeholder_list(cols), do: ", " <> Enum.map_join(cols, ", ", fn _ -> "?" end)
end
