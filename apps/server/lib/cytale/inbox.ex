defmodule Cytale.Inbox do
  @moduledoc """
  The mention inbox (#117) — the durable per-member answer to "where was I
  needed", as opposed to "what is new".

  Home already answers the second question at CHANNEL granularity ("#release
  has 4 unread"), from the client's unread slices. This module answers the
  first at MESSAGE granularity, from storage: one row per message that
  addressed the member, readable by nobody else, surviving a reload, and
  deep-linkable to the message itself.

  ## The record is an event log, not a second read state

  `mention_events` holds EVENTS (this message addressed you) and
  `read_state` holds a POSITION (you read up to here). Nothing here
  is consulted to decide whether a message is read, and nothing here stores a
  count: a badge, the in-pane divider and this backlog all derive from
  `read_state.last_read_id`, which stays the ONE watermark and stays INCLUSIVE
  (product invariant #2 — `docs/architecture/product-invariants.md`). The
  visible consequence is what the surface *is*: a list of sentences, not a
  second set of numbers.

  ## What is deliberately NOT here (#117's non-goals, in code)

  * **No read receipts.** Every row is keyed by the member it is about and the
    read path is self-scoped (`list_for_user/2` answers for `user_id` alone),
    so no route — and no query in this module — can tell anyone who read what.
    A mention inbox must never become a way to see other people's attention.
  * **No visibility into another member's inbox.** The partition key IS the
    member; there is no cross-member read to gate because there is no
    cross-member query.
  * **No counts.** `list_for_user/2` returns rows. A count would be the second
    set of unread numbers this ticket forbids; the client's badge keeps coming
    from `read_state`.
  * **No push or email.** Delivery policy is #85's; this table is the durable
    counterpart a notification can point at, not a delivery channel.
  * **No second read state.** "Done" is a DELETE of an event row, never a
    watermark write: clearing an inbox row must not move the channel's read
    position, and moving the read position (an ack) is what deletes the rows it
    covers.

  ## What is recorded, and who is not told

  A row is written for every member the message actually addresses who can
  STILL see the channel (`record_mentions/1`) — connected or not, which is the
  whole point: a mention that arrives while the member is away is exactly the
  mention a session-local slice loses. Recipients are re-checked through the
  one principal resolver (the same VIEW_CHANNEL computation the REST gate and
  the gateway use), so a mention cannot reach a member who has since lost
  access, and a machine principal with no view right is not parked a row.

  Scope, stated plainly: direct mentions (`<@id>` / `<@!id>`, kind
  `"mention"`) AND broadcasts (`@everyone` / `@here`, kind `"broadcast"`, one
  row per member who can see the channel — unless that member switched on
  "Suppress @everyone and @here" for the workspace), on workspace-channel
  messages, including thread replies (which carry the parent channel in
  `channel_id`). Broadcasts joined on 2026-09-27: "Mentions only" includes
  them, and the mention badge is a projection of these rows. "Reply to me"
  and "thread I follow" are the later increments the ticket names, and a DM is
  skipped on purpose — the whole DM is addressed to its participants, so a row
  would restate the DM's own unread rather than distinguish anything.
  """

  alias Cytale.Messages.ReadState
  alias Cytale.Notifications.{Mentions, Preferences}
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Principal
  alias Cytale.Repo
  alias Cytale.Workspaces

  @limit_default 50
  @limit_max 100

  # The stored quote's cap. Long enough for the sentence that addressed the
  # member, short enough that one row is a row.
  @excerpt_chars 240

  # How many rows `mark_done_through/3` walks while looking for the rows an
  # acknowledgment covers. Rows are ordered newest-first, so walking stops as
  # soon as the ids fall below the watermark — this cap only bounds the
  # pathological case (an extremely old watermark with an enormous backlog).
  @sweep_scan 200

  # PERF-9: mention rows expire after 90 days. A mention is an actionable
  # event ("where was I needed"), not a permanent record — with the TTL, a
  # member's partition stays proportional to the OPEN backlog even if some
  # mentions are never answered, instead of growing forever.
  @mention_event_ttl_seconds 7_776_000

  # PERF-2: the mention inserts fan across DIFFERENT user_id partitions and are
  # idempotent inserts, so they ride ONE unlogged batch per chunk (a
  # round-trip win — `Repo.batch!/2`'s contract, atomicity irrelevant). The cap
  # bounds the batch for a pathologically wide mention list.
  @mention_insert_batch_cap 64

  @doc "The excerpt length cap (tests assert on it)."
  @spec excerpt_chars() :: pos_integer()
  def excerpt_chars, do: @excerpt_chars

  @doc "The page size a caller that names none gets."
  @spec limit_default() :: pos_integer()
  def limit_default, do: @limit_default

  # ---------------------------------------------------------------------------
  # Write side — called from the message write path
  # ---------------------------------------------------------------------------

  @doc """
  Record the mention events a just-persisted message created: one row per
  member it addresses who can see the channel and is not the author.

  Called from `Cytale.Messages.create_message/1` — the one place every
  producer (REST, compat, webhook, bot interaction) converges, and BEFORE the
  caller publishes the message, so the durable event never trails the
  delivery: a client that hydrates the moment the message lands cannot miss
  the row.

  Best-effort by contract: the message is already stored when this runs, and a
  failure here must never cost the member the message (the `index_message`
  discipline on the fan-out path). A message with no mention token does no
  storage work at all.
  """
  @spec record_mentions(map()) :: :ok
  def record_mentions(%{channel_id: channel_id, author_id: author_id, id: message_id} = message)
      when is_integer(channel_id) and is_integer(author_id) and is_integer(message_id) do
    content = Map.get(message, :content) || ""

    # The ONE tokenizer ("one tokenizer serves every caller" —
    # `Cytale.Notifications.Mentions`): a second mention grammar here is how
    # the codec and the policy already drifted apart once.
    #
    # A sender that narrowed its mentions (`allowed_mentions`) handed the
    # allowed list over on the message (`mention_user_ids`, nil = no
    # restriction): a suppressed `<@id>` stays text and records nothing.
    # Only CONTENT mentions make rows — `replied_user` puts the replied-to
    # author on that list for the push policy, but a reply has never been an
    # inbox event, so it is not one here.
    allowed = Map.get(message, :mention_user_ids)

    mentioned =
      content
      |> Mentions.user_ids()
      |> Enum.reject(&(&1 == author_id))
      |> Enum.filter(&Cytale.Messages.AllowedMentions.notifies?(allowed, &1))

    # `@everyone`/`@here` ADDRESS every member who can see the channel (owner
    # direction 2026-09-27: "Mentions only" includes them, for delivery AND
    # for the mention badge — and the badge is a projection of these rows).
    #
    # …but only when the AUTHOR may broadcast (`mention_everyone` in the
    # channel — `Cytale.Notifications.BroadcastGate`). The write path decides
    # that once and hands it over on the message; a caller without the flag is
    # resolved here, fail-closed.
    broadcast? =
      Mentions.broadcast?(content) and
        Map.get_lazy(message, :mention_everyone, fn ->
          Cytale.Notifications.BroadcastGate.author_holds_bit?(author_id, channel_id)
        end) == true

    if mentioned == [] and not broadcast? do
      :ok
    else
      record_for(mentioned, broadcast?, channel_id, message_id, author_id, content, message)
    end
  rescue
    e ->
      require Logger
      Logger.warning("inbox: mention recording failed (#{Exception.message(e)})")
      :ok
  end

  def record_mentions(_message), do: :ok

  # One `channels_by_id` read for the whole message (every row shares it), then
  # ONE resolver call for the whole mention set (`Principal.resolve_many/3` —
  # PERF-2: the workspace and channel rows load once, so per-user work is only
  # the membership evaluation), then the inserts ride ONE unlogged batch per
  # 64 recipients (different partitions, idempotent inserts, atomicity
  # irrelevant — `Repo.batch!/2`'s contract).
  defp record_for(ids, broadcast?, channel_id, message_id, author_id, content, message) do
    case Workspaces.get_channel(channel_id) do
      nil ->
        # A DM (or an unknown channel): deliberately not recorded (see the
        # moduledoc) — a DM is addressed to its participants as a whole.
        :ok

      %{workspace_id: workspace_id} ->
        created_at =
          Map.get(message, :created_at) ||
            DateTime.utc_now() |> DateTime.truncate(:millisecond)

        excerpt = excerpt(content)
        thread_id = Map.get(message, :thread_id)

        direct = if ids == [], do: [], else: recipients(ids, workspace_id, channel_id)

        # A member both named AND broadcast to gets ONE row, the direct one:
        # the badge counts a message once, and "mentioned you" is the more
        # specific sentence.
        broadcast =
          if broadcast?,
            do: broadcast_recipients(workspace_id, channel_id, [author_id | ids]),
            else: []

        (Enum.map(direct, &{&1, "mention"}) ++ Enum.map(broadcast, &{&1, "broadcast"}))
        |> Enum.map(fn {user_id, kind} ->
          mention_event_insert(user_id, kind, channel_id, message_id, thread_id, author_id, excerpt, created_at)
        end)
        |> Enum.chunk_every(@mention_insert_batch_cap)
        |> Enum.each(&Repo.batch!/1)

        :ok
    end
  end

  # Everyone a broadcast addresses: the workspace's members who can see the
  # channel, minus `exclude` (the author, and the directly-mentioned, who get
  # their own row), minus every member who switched on "Suppress @everyone and
  # @here" for this workspace.
  #
  # `@here` is recorded exactly like `@everyone`. "Here" is a presence claim
  # about the moment of sending, and a badge that a member reads LATER is not
  # the place to re-litigate who was online — the policy treats the two tokens
  # as one class for the same reason.
  #
  # Cost: one member-id read, one resolve per 100 members (`resolve_many/3`
  # reads the shared rows once per call), one multi-partition suppression read
  # per 100, then the batched inserts. Bounded by the workspace, not by the
  # connected set, which is the point: a broadcast that lands while a member
  # is away is exactly the one a live-only count would lose.
  defp broadcast_recipients(workspace_id, channel_id, exclude) do
    excluded = MapSet.new(exclude)

    candidates =
      workspace_id
      |> Workspaces.list_member_ids()
      |> Enum.reject(&MapSet.member?(excluded, &1))

    viewers =
      candidates
      |> Enum.chunk_every(100)
      |> Enum.flat_map(&recipients(&1, workspace_id, channel_id))

    suppressing = Preferences.suppressing_broadcasts(viewers, workspace_id)
    Enum.reject(viewers, &MapSet.member?(suppressing, &1))
  end

  # The mentioned users who can STILL see the channel, in mention order. The
  # visibility computation is the ONE resolver (`Principal.resolve_many/3`,
  # the REST gate's VIEW_CHANNEL answer with the reads hoisted): a mention
  # cannot reach a member who has since lost access, a machine principal with
  # no view right is not parked a row, and an unknown workspace (deleted under
  # us) resolves nothing — best-effort, like the whole write side.
  defp recipients(ids, workspace_id, channel_id) do
    case Principal.resolve_many(workspace_id, ids, channel_id) do
      {:ok, by_user} ->
        Enum.filter(ids, fn user_id ->
          case Map.get(by_user, user_id) do
            {:ok, bits} -> Bitfield.has?(bits, :view_channel)
            _other -> false
          end
        end)

      {:error, _not_found} ->
        []
    end
  end

  # PERF-9: the TTL is a compile-time constant and is INTERPOLATED for the same
  # reason read_state's LIMIT is — a constant integer cannot be injected into,
  # and there is nothing for the driver and server to negotiate a bind over.
  defp mention_event_insert(user_id, kind, channel_id, message_id, thread_id, author_id, excerpt, created_at) do
    {"INSERT INTO {{K}}.mention_events (user_id, message_id, channel_id, thread_id, author_id, kind, excerpt, created_at) " <>
       "VALUES (?, ?, ?, ?, ?, ?, ?, ?) USING TTL #{@mention_event_ttl_seconds}",
     [
       {"bigint", user_id},
       {"bigint", message_id},
       {"bigint", channel_id},
       {"bigint", thread_id},
       {"bigint", author_id},
       {"text", kind},
       {"text", excerpt},
       {"timestamp", created_at}
     ]}
  end

  # The reader's own view right, through the one resolver (the REST gate's
  # computation) — the READ side of the backlog uses this per distinct channel
  # on the page; the WRITE side resolves its whole mention set through
  # `resolve_many/3` above.
  defp visible?(workspace_id, channel_id, user_id) do
    case Principal.resolve(workspace_id, %{user_id: user_id}, channel_id) do
      {:ok, bits} -> Bitfield.has?(bits, :view_channel)
      _ -> false
    end
  end

  defp excerpt(content) when is_binary(content), do: String.slice(content, 0, @excerpt_chars)
  defp excerpt(_content), do: ""

  # ---------------------------------------------------------------------------
  # Read side — the member's own backlog
  # ---------------------------------------------------------------------------

  @doc """
  The member's open backlog, newest first: `{items, oldest_id}` where
  `oldest_id` is the cursor for the next page (`before:`, LIKE every other
  paginated read) or nil when the page is the last one.

  `before` is a message id: rows strictly older than it. Names ride along
  (`author_username`) so a row is renderable before the roster hydrates, and
  `excerpt` is the message's CURRENT text (see `hydrate/2`): a deleted
  message's row is dropped and an edited one shows its edit.

  Rows the member can no longer see are DROPPED, not zeroed: losing access to
  a channel must not leave its content in a backlog (the `ReadStateSync`
  discipline for watermarks). One resolve per distinct channel, because a
  member's open backlog is a handful of channels at most.
  """
  @spec list_for_user(integer(), keyword()) :: {[map()], String.t() | nil}
  def list_for_user(user_id, opts \\ []) when is_integer(user_id) do
    limit = limit(Keyword.get(opts, :limit))
    before = Keyword.get(opts, :before)

    {stmt, params} =
      if is_integer(before) do
        {"SELECT message_id, channel_id, thread_id, author_id, kind, excerpt, created_at FROM {{K}}.mention_events " <>
           "WHERE user_id = ? AND message_id < ? LIMIT #{limit}", [{"bigint", user_id}, {"bigint", before}]}
      else
        {"SELECT message_id, channel_id, thread_id, author_id, kind, excerpt, created_at FROM {{K}}.mention_events " <>
           "WHERE user_id = ? LIMIT #{limit}", [{"bigint", user_id}]}
      end

    rows =
      Repo.execute!(stmt, params)
      |> Enum.to_list()

    visible_by_channel = visibility(rows, user_id)
    visible_rows = Enum.filter(rows, &Map.get(visible_by_channel, &1["channel_id"], false))
    live_rows = hydrate(user_id, visible_rows)
    authors = usernames(live_rows)

    items = Enum.map(live_rows, &to_item(&1, authors))

    oldest =
      case List.last(items) do
        nil -> nil
        item -> item["message_id"]
      end

    {items, oldest}
  end

  # One resolve per DISTINCT channel on the page (not per row): the backlog is
  # a handful of channels, and the same channel's rows must not each pay for
  # the same answer. An unknown channel (a DM — never recorded here — or a
  # channel that has since been deleted) resolves to false, so no row outlives
  # the channel's own existence.
  defp visibility(rows, user_id) do
    rows
    |> Enum.map(& &1["channel_id"])
    |> Enum.uniq()
    |> Map.new(fn channel_id ->
      case Workspaces.get_channel(channel_id) do
        nil -> {channel_id, false}
        %{workspace_id: workspace_id} -> {channel_id, visible?(workspace_id, channel_id, user_id)}
      end
    end)
  end

  # The excerpt is the message's CURRENT content, read at list time — never
  # the copy stored with the row. The stored copy would otherwise outlive the
  # message: a delete, an edit, an account-deletion sweep or any later purge
  # path would each have to find and rewrite every member's row (a broadcast
  # parks one per member), and the one that forgets leaks the old text for
  # the row's 90-day TTL. Reading `messages` makes the message the one source:
  # a row whose message is gone is dropped (and deleted, best-effort, so the
  # mention badge stops counting it), and an edit shows through at once.
  #
  # Cost: `Messages.get_many/1` — one read per (channel, bucket) group on the
  # page plus one per side table, bounded by the page size (at most 100 rows).
  defp hydrate(_user_id, []), do: []

  defp hydrate(user_id, rows) do
    live =
      rows
      |> Enum.map(&{&1["channel_id"], &1["message_id"]})
      |> Cytale.Messages.get_many()

    {kept, gone} =
      Enum.split_with(rows, &Map.has_key?(live, {&1["channel_id"], &1["message_id"]}))

    Enum.each(gone, &forget_gone(user_id, &1["message_id"]))

    Enum.map(kept, fn row ->
      message = Map.fetch!(live, {row["channel_id"], row["message_id"]})
      %{row | "excerpt" => excerpt(message.content)}
    end)
  end

  defp forget_gone(user_id, message_id) do
    mark_done(user_id, message_id)
  rescue
    _ -> :ok
  end

  # One batched author read for the page (never per row) — `User.get_many`
  # is the roster's own batch primitive.
  defp usernames([]), do: %{}

  defp usernames(rows) do
    rows
    |> Enum.map(& &1["author_id"])
    |> Enum.uniq()
    |> Cytale.Accounts.User.get_many()
    |> Map.new(fn {id, user} -> {id, user.username} end)
  end

  # The wire shape: decimal-string ids like every other id on the API, the
  # excerpt, and the two names a row needs to be readable.
  defp to_item(row, authors) do
    %{
      "message_id" => Integer.to_string(row["message_id"]),
      "channel_id" => Integer.to_string(row["channel_id"]),
      "thread_id" => row["thread_id"] && Integer.to_string(row["thread_id"]),
      "author_id" => Integer.to_string(row["author_id"]),
      "author_username" => Map.get(authors, row["author_id"]),
      "kind" => row["kind"],
      "excerpt" => row["excerpt"],
      "created_at" => row["created_at"] && DateTime.to_iso8601(row["created_at"])
    }
  end

  # ---------------------------------------------------------------------------
  # Done — per item, whole backlog, and "an ack covered this row"
  # ---------------------------------------------------------------------------

  @doc """
  Answer one mention (the row's own "done"). Idempotent, and DELIBERATELY
  SILENT about whether the row existed: this is the member's own backlog, so
  there is nothing to hide and nothing to disclose — a repeated done is a
  no-op, not an error.

  A delete, not a flag, is the "done" this design chose: the row exists while
  it is something the member still has to answer, and the partition therefore
  stays proportional to the OPEN backlog rather than to every mention ever
  received. The durable record of "I read up to here" stays the watermark.
  """
  @spec mark_done(integer(), integer()) :: :ok
  def mark_done(user_id, message_id) when is_integer(user_id) and is_integer(message_id) do
    Repo.query!(
      "DELETE FROM {{K}}.mention_events WHERE user_id = ? AND message_id = ?",
      [{"bigint", user_id}, {"bigint", message_id}]
    )

    :ok
  end

  @doc """
  Sweep the whole backlog (the surface's bulk "mark all done"). Returns the
  number of rows removed so the surface can report what happened.

  A partition delete — one statement for every row this member holds, which is
  exactly why the partition key is the member.
  """
  @spec mark_all_done(integer()) :: non_neg_integer()
  def mark_all_done(user_id) when is_integer(user_id) do
    before = count_for_user(user_id)

    Repo.execute!("DELETE FROM {{K}}.mention_events WHERE user_id = ?", [
      {"bigint", user_id}
    ])

    before
  end

  @doc """
  An acknowledgement covered up to `message_id` on `scope_id` — delete the
  rows it answers.

  `scope_id` is the id the ack wrote its watermark under, which is the SAME
  vocabulary `read_state` uses: a channel id for a channel ack, a THREAD id
  for a thread ack (the client acks a thread with the thread's id, and the
  thread's own watermark is what answers a thread mention). So the match is
  structural:

    * `message_id` at or below the watermark — the row the ack covers;
    * the row's `thread_id` when `scope_id` is a thread, else the row's
      `channel_id` with a null `thread_id` — the tier the ack spoke about. A
      channel ack must NOT answer a thread mention: the channel timeline hides
      thread replies, so reading the channel is not reading the thread (and
      the thread has its own watermark for exactly this reason).

  The bound is the watermark UNLESS the member set an `unread_floor` by hand,
  which outranks it (`ReadState.unread_since/3`): "this message and everything
  after it is unread". A mention at or after the floor is therefore NOT
  answered by an ack that covers the watermark, because deleting it would hide
  exactly the message the member said they had not dealt with yet.

  Cost: two bounded point/partition reads (the member's read state for the
  scope, then the backlog) plus a point delete per answered row. Called from
  the ack paths — the same hop that already writes the watermark, which is
  what "extend the ack, do not invent a second mechanism" means. Best-effort
  like the rest of the write side.

  Returns the number of rows removed.
  """
  @spec mark_done_through(integer(), integer(), integer(), keyword()) :: non_neg_integer()
  def mark_done_through(user_id, scope_id, message_id, opts \\ [])
      when is_integer(user_id) and is_integer(scope_id) and is_integer(message_id) do
    # The backlog FIRST (review #20): a member with no open mention in this
    # scope — the overwhelmingly common ack — is answered by this one bounded
    # partition read, and the read-state read the floor check needs is never
    # made. The watermark is an upper bound on the floor-adjusted bound, so a
    # row it does not cover cannot be covered by the adjusted one either.
    candidates =
      Repo.query!(
        "SELECT message_id, channel_id, thread_id FROM {{K}}.mention_events WHERE user_id = ? LIMIT #{@sweep_scan}",
        [{"bigint", user_id}]
      )
      |> Enum.to_list()
      |> Enum.filter(&covered_by?(&1, scope_id, message_id))

    covered =
      case candidates do
        [] ->
          []

        rows ->
          # `:read_state` — a caller that already read the member's read state
          # for this scope (the ack writer) hands it over instead of a re-read.
          bound =
            case Keyword.fetch(opts, :read_state) do
              {:ok, read_state} -> floor_bound(read_state, message_id)
              :error -> answered_bound(user_id, scope_id, message_id)
            end

          rows
          |> Enum.filter(&covered_by?(&1, scope_id, bound))
          |> Enum.map(& &1["message_id"])
      end

    Enum.each(covered, &mark_done(user_id, &1))
    length(covered)
  rescue
    e ->
      require Logger
      Logger.warning("inbox: ack sweep failed (#{Exception.message(e)})")
      0
  end

  # The highest message an acknowledgement answers on this scope, with the
  # member's hand-set floor applied when there is one (see the doc above).
  defp answered_bound(user_id, scope_id, message_id),
    do: floor_bound(ReadState.get(user_id, scope_id), message_id)

  defp floor_bound(%{unread_floor: floor}, message_id) when is_integer(floor), do: min(message_id, floor - 1)
  defp floor_bound(_read_state, message_id), do: message_id

  defp covered_by?(row, scope_id, message_id) do
    row["message_id"] <= message_id and
      case row["thread_id"] do
        nil -> row["channel_id"] == scope_id
        thread_id -> thread_id == scope_id
      end
  end

  # The bulk sweep's report. Bounded like every other read here; the surface
  # only needs "how many did I clear".
  defp count_for_user(user_id) do
    Repo.execute!(
      "SELECT message_id FROM {{K}}.mention_events WHERE user_id = ? LIMIT #{@sweep_scan}",
      [{"bigint", user_id}]
    )
    |> Enum.count()
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp limit(nil), do: @limit_default

  defp limit(n) when is_integer(n) and n > 0, do: min(n, @limit_max)
  defp limit(_n), do: @limit_default
end
