defmodule Cytale.Messages do
  @moduledoc """
  Message persistence (U9): INSERT into the core `messages` table plus the
  `author_messages` locator row (U14's account-deletion sweep), and
  cursor-paginated history reads (newest-first via DESC clustering).

  Embeds (bots plan U10, KTD11): stored side-table rows in `message_embeds`
  (one per embed, JSON verbatim), joined on reads; written on create only and
  cascaded on delete. Components (components plan U1, R1): the action-row
  twin — `message_components` side rows (one per top-level row, JSON
    verbatim, platform-opaque per KD1), written on create via the Bot-auth
    surfaces (compat create; webhook style-5-only rows) and replaced
    WHOLESALE by the interaction callback's type-7 UPDATE_MESSAGE (U3,
    `replace_components/3` — the only mutation path) and cascaded on
    delete. The native human create ignores `components` entirely, so
  "components ⇒ machine author" holds by construction. Author overrides
  (bots plan U11, KTD12): webhook per-message `username`/`avatar_url`
  overrides live in
  `message_author_overrides`, joined on reads the same way and cascaded on
  delete — `author_id` stays the webhook principal. Reactions
  (`Cytale.Messages.Reactions`) cascade on delete the same way: both
  reaction tables partition on the message's own
  (channel_id, bucket, message_id) key.

  Bucket rule (binding): `bucket = floor(created_at_ms / 7 days)` keeps any
  single `(channel_id, bucket)` partition bounded. Message ids come from
  `Cytale.Snowflake.next/0` — chronological sort for free.
  """

  alias Cytale.Messages.AllowedMentions
  alias Cytale.Repo

  @typedoc "A persisted message row (wire shape: snowflake ids as strings is
  the CONTROLLER's job — this layer is integer-native). `author_override` is
  the webhook per-message override map (string-keyed) joined from
  `message_author_overrides` on reads — absent/nil for every human/bot/agent
  message (bots plan U11, KTD12)."
  @type t :: %{
          id: integer(),
          channel_id: integer(),
          bucket: integer(),
          author_id: integer(),
          content: String.t(),
          thread_id: integer() | nil,
          created_at: DateTime.t(),
          edited_at: DateTime.t() | nil,
          attachments: [map()],
          embeds: [map()],
          components: [map()],
          author_override: map() | nil
        }

  @seven_days_ms 7 * 24 * 3600 * 1000

  # R11 embed caps (shared by every accepting surface — compat create today,
  # webhook execute in bots-plan U11).
  @max_embeds 10
  @max_embed_bytes 8 * 1024

  # R1 component caps (Discord's component reference; shared by every
  # accepting surface — compat create now, webhook style-5-only rows now,
  # the interaction-callback replace in the components plan's U3). Multi-
  # select follows Discord's full range since #30 (v1 capped it at 1).
  @max_component_rows 5
  @max_row_components 5
  @max_select_options 25
  @max_component_bytes 8 * 1024
  @max_custom_id 100
  @max_button_label 80
  @max_option_label 100
  @max_option_value 100
  @max_option_description 100
  @max_placeholder 150

  @doc "Bucket for a wall-clock millisecond value (the plan's 7-day rule)."
  @spec bucket_for(integer()) :: non_neg_integer()
  def bucket_for(ms) when is_integer(ms), do: div(ms, @seven_days_ms)

  @doc """
  Denormalize `last_message_id` onto the channel row after a successful
  create — best-effort by contract: a failure is swallowed (the message is
  already persisted; the denormalization is a read-path optimization). The
  ONE definition (B6a) — formerly four copy-pasted `touch_channel/2`
  private helpers across the message/interaction/webhook controllers.

  DM channels (B-1) carry their own denormalized pointer (dm_channels + the
  participants' dms_of_user rows) — the channels_by_id UPDATE must NEVER run
  for a DM id: Scylla UPDATEs are upserts, so it would plant a PHANTOM
  workspace-channel row on the DM's id and poison every channel gate after
  it. `maybe_touch_dm/2` decides which side owns the write.
  """
  @spec touch_last_message(integer(), integer()) :: :ok
  def touch_last_message(channel_id, message_id)
      when is_integer(channel_id) and is_integer(message_id) do
    case Cytale.Workspaces.maybe_touch_dm(channel_id, message_id) do
      :dm ->
        :ok

      :not_dm ->
        Repo.execute!(
          "UPDATE {{K}}.channels_by_id SET last_message_id = ? WHERE channel_id = ?",
          [{"bigint", message_id}, {"bigint", channel_id}]
        )

        :ok
    end
  rescue
    _ -> :ok
  end

  @doc """
  Validate embeds against the R11 caps: an optional list of JSON objects, at
  most #{@max_embeds} entries, each at most #{@max_embed_bytes} bytes serialized
  (`Jason.encode!/1` byte size). Unknown keys WITHIN an embed are fine —
  embeds are store-and-forward (KTD11). Returns `{:error, :invalid_embeds}`
  (the native error key; the compat surface renders it as 50035 Invalid Form
  Body) on a non-list, a non-map entry, too many entries, or an oversized
  embed.
  """
  @spec validate_embeds(term()) :: :ok | {:error, :invalid_embeds}
  def validate_embeds(nil), do: :ok

  def validate_embeds(list) when is_list(list) do
    cond do
      length(list) > @max_embeds -> {:error, :invalid_embeds}
      not Enum.all?(list, &is_map/1) -> {:error, :invalid_embeds}
      not Enum.all?(list, &embed_within_budget?/1) -> {:error, :invalid_embeds}
      true -> :ok
    end
  end

  def validate_embeds(_), do: {:error, :invalid_embeds}

  defp embed_within_budget?(embed), do: byte_size(Jason.encode!(embed)) <= @max_embed_bytes

  @doc """
  Validate components against the R1 caps (Discord's component reference,
  shallow — the embeds posture: known caps are enforced, unknown keys within
  a component ride verbatim; deep JSON is bot-owned). The rules:

    * at most #{@max_component_rows} action rows; each row is a map with
      `type: 1` and a `components` list of 1..#{@max_row_components} entries;
    * a row holds ≤#{@max_row_components} buttons (type 2) OR exactly 1
      string select (type 3) — a mix, or any other child type, is invalid;
    * button `style` ∈ 1..5 (6/premium rejected); styles 1–4 REQUIRE
      `custom_id` (1–#{@max_custom_id} chars) and FORBID `url`; style 5
      (link) FORBIDS `custom_id` and REQUIRES `url` parsed as an absolute
      http/https URL — `javascript:`, `data:`, protocol-relative and every
      other scheme are rejected;
    * `label` ≤ #{@max_button_label} chars and `disabled` (boolean) are
      optional on buttons AND selects;
    * string select: `custom_id` 1–#{@max_custom_id}, `options` 1..
      #{@max_select_options} each `{label ≤ #{@max_option_label}, value ≤
      #{@max_option_value}, description? ≤ #{@max_option_description},
      default? bool, emoji?}`, `placeholder?` ≤ #{@max_placeholder}, and
      Discord's multi-select range (#30): `min_values?` 0–#{@max_select_options}
      and `max_values?` 1–#{@max_select_options}, each defaulting to 1, with
      min ≤ max ≤ the option count;
    * the serialized components array is ≤ #{@max_component_bytes} bytes
      per message.

  Returns `{:error, :invalid_components}` (the native error key; the compat
  surface renders it as 50035 Invalid Form Body) on any violation.
  """
  @spec validate_components(term()) :: :ok | {:error, :invalid_components}
  def validate_components(nil), do: :ok

  def validate_components(list) when is_list(list) do
    cond do
      length(list) > @max_component_rows -> {:error, :invalid_components}
      not Enum.all?(list, &valid_action_row?/1) -> {:error, :invalid_components}
      not component_budget_ok?(list) -> {:error, :invalid_components}
      true -> :ok
    end
  end

  def validate_components(_), do: {:error, :invalid_components}

  defp component_budget_ok?(list), do: byte_size(Jason.encode!(list)) <= @max_component_bytes

  # -- action rows ----------------------------------------------------------------

  defp valid_action_row?(%{"type" => 1, "components" => children}) when is_list(children),
    do: children != [] and length(children) <= @max_row_components and valid_row_children?(children)

  defp valid_action_row?(_), do: false

  # ≤5 buttons OR exactly 1 select (R1). A single-entry row accepts EITHER
  # shape; longer rows must be all-buttons. Any other child type (future
  # Discord types, junk) fails both clauses.
  defp valid_row_children?([%{"type" => 3} = select]),
    do: valid_select?(select)

  defp valid_row_children?(children),
    do: Enum.all?(children, fn child -> is_map(child) and match?(%{"type" => 2}, child) and valid_button?(child) end)

  # -- buttons (type 2) -------------------------------------------------------------

  defp valid_button?(%{"type" => 2, "style" => style} = button)
       when is_integer(style) and style in 1..5 do
    button_style_shape?(button, style) and
      optional_string_cap?(button["label"], @max_button_label) and
      optional_bool?(button["disabled"])
  end

  defp valid_button?(_), do: false

  # Style-specific key lattice: style 5 requires `url` and forbids
  # `custom_id`; styles 1–4 require `custom_id` and forbid `url`.
  defp button_style_shape?(button, 5), do: not Map.has_key?(button, "custom_id") and http_url?(button["url"])

  defp button_style_shape?(button, _custom_style),
    do: not Map.has_key?(button, "url") and custom_id?(button["custom_id"])

  defp custom_id?(id) when is_binary(id), do: String.length(id) in 1..@max_custom_id
  defp custom_id?(_), do: false

  # Absolute http/https only (KTD7): the scheme set is checked at validation
  # AND re-checked at render. A missing scheme (protocol-relative
  # `//evil.com`) or host fails the shape.
  defp http_url?(url) when is_binary(url) do
    case URI.parse(url) do
      %URI{scheme: scheme, host: host}
      when is_binary(scheme) and is_binary(host) and host != "" ->
        String.downcase(scheme) in ["http", "https"]

      _ ->
        false
    end
  end

  defp http_url?(_), do: false

  # -- string selects (type 3) --------------------------------------------------------

  defp valid_select?(%{"type" => 3} = select) do
    custom_id?(select["custom_id"]) and
      options_ok?(select["options"]) and
      optional_string_cap?(select["placeholder"], @max_placeholder) and
      values_range_ok?(select["min_values"], select["max_values"], select["options"]) and
      optional_bool?(select["disabled"])
  end

  defp options_ok?(options) when is_list(options) do
    length(options) in 1..@max_select_options and Enum.all?(options, &valid_option?/1)
  end

  defp options_ok?(_), do: false

  defp valid_option?(option) when is_map(option) do
    required_string_cap?(option["label"], @max_option_label) and
      required_string_cap?(option["value"], @max_option_value) and
      optional_string_cap?(option["description"], @max_option_description) and
      optional_bool?(option["default"])
  end

  defp valid_option?(_), do: false

  # Discord's multi-select range (#30; v1 capped both at 1). Each side
  # defaults to 1 when absent, and the defaults take part in the checks — so
  # `min_values: 2` alone is invalid (it would exceed the default max of 1),
  # and a max beyond the option count could never be satisfied.
  defp values_range_ok?(min_values, max_values, options) when is_list(options) do
    min = if is_nil(min_values), do: 1, else: min_values
    max = if is_nil(max_values), do: 1, else: max_values

    is_integer(min) and is_integer(max) and min in 0..@max_select_options and
      max in 1..@max_select_options and min <= max and max <= length(options)
  end

  defp values_range_ok?(_min, _max, _options), do: false

  # -- shared optional-field shapes ----------------------------------------------------

  defp optional_string_cap?(value, _max) when is_nil(value), do: true
  defp optional_string_cap?(value, max) when is_binary(value), do: String.length(value) <= max
  defp optional_string_cap?(_value, _max), do: false

  defp required_string_cap?(value, max) when is_binary(value), do: String.length(value) in 1..max
  defp required_string_cap?(_value, _max), do: false

  defp optional_bool?(nil), do: true
  defp optional_bool?(value), do: is_boolean(value)

  @doc """
  Persist a message: messages row + author_messages locator + embed side rows
  + component side rows (when present). Returns the stored message (with its
  minted id and bucket).
  """
  @spec create_message(%{
          channel_id: integer(),
          author_id: integer(),
          content: String.t(),
          thread_id: integer() | nil,
          attachments: [map()] | nil,
          embeds: [map()] | nil,
          components: [map()] | nil
        }) :: {:ok, t()} | {:error, term()}
  # Head pins the required keys (shape contract); the body routes through
  # do_create_message — hence the underscore-pinned bindings.
  #
  # Optional attrs beyond the spec above:
  #
  #   * `:id` — a pre-minted Snowflake (the durable send dedupe reserves it
  #     first; see `Cytale.Messages.Nonces`);
  #   * `:channel_kind` — what the caller ALREADY knows the channel to be:
  #     `:channel` (a workspace channel — the DM search leg is skipped without
  #     a `dm_channels` read) or `{:dm, dm}` (the row in hand). Absent, the DM
  #     leg reads the row itself, as it always did;
  #   * `:allowed_mentions` — the sender's parsed `allowed_mentions`
  #     (`Cytale.Messages.AllowedMentions`), applied HERE for every producer:
  #     it narrows the broadcast verdict and the user mentions that notify;
  #   * `:reply_author_id` — the replied-to message's author, for
  #     `allowed_mentions.replied_user`;
  #   * `:mention_everyone` — a verdict the caller already decided (kept for
  #     callers that decide it themselves; it still needs the tokens).
  def create_message(%{channel_id: _channel_id, author_id: _author_id, content: _content} = attrs) do
    do_create_message(attrs)
  end

  # Pillars instrumentation: the plan budgets the INSERT hop at 50ms p99
  # (U9/U11 budget table; asserted by the soak via Telemetry.Stats). It times
  # the write alone — it used to wrap the whole create, so the mention and DM
  # index legs (reads and writes of other tables) were billed to the insert.
  defp timed_insert(channel_id, fun) do
    t0 = System.monotonic_time(:millisecond)
    result = fun.()

    :telemetry.execute(
      [:cytale, :scylla, :insert_duration],
      %{duration_ms: System.monotonic_time(:millisecond) - t0},
      %{channel_id: channel_id}
    )

    result
  end

  defp do_create_message(%{channel_id: channel_id, author_id: author_id, content: content} = attrs) do
    # A caller may hand in a PRE-MINTED id — the durable send dedupe
    # (`Cytale.Messages.Nonces`) reserves the id before the write. The row's
    # time then derives from the id itself, so re-driving a reserved write
    # produces the byte-identical row (an idempotent upsert), never a second
    # message or a moved bucket.
    {id, created_at} =
      case Map.get(attrs, :id) do
        id when is_integer(id) ->
          {id, DateTime.from_unix!(Cytale.Snowflake.timestamp_ms(id), :millisecond)}

        nil ->
          {Cytale.Snowflake.next(), DateTime.utc_now() |> DateTime.truncate(:millisecond)}
      end

    ms = DateTime.to_unix(created_at, :millisecond)
    bucket = bucket_for(ms)
    thread_id = Map.get(attrs, :thread_id)
    reply_to_id = Map.get(attrs, :reply_to_id)
    # Stored unsigned (Tier 2 #4): a client echoing a signed upload URL back
    # must not persist a signature — every render re-signs.
    attachments = attrs |> Map.get(:attachments, []) |> Enum.map(&Cytale.Attachments.SignedUrl.canonical_attachment/1)
    embeds = Map.get(attrs, :embeds, [])
    components = Map.get(attrs, :components, [])
    allowed_mentions = Map.get(attrs, :allowed_mentions)

    attachments_cql = Enum.map(attachments, &stringify_map/1)

    # ONE unlogged batch for the whole write fan (hardening plan 5.6): the message
    # row, its author_messages locator, and one row per embed and per component
    # were 2 + N + M sequential round trips. None of them needs its own write
    # timestamp, which is the condition for batching here (see `Repo.batch!/2`).
    # Embed side rows (bots plan U10, KTD11): one row per embed, JSON verbatim
    # (store-and-forward — unknown keys ride). Written on create only; embeds
    # are immutable after create.
    # Component side rows (components plan U1, KTD1): one row per top-level
    # action row, JSON verbatim — platform-opaque, `custom_id` never
    # interpreted. The type-7 callback is the one replace path
    # (`replace_components/3`, U3); validation ran on the accepting surface.
    statements =
      [
        {"INSERT INTO {{K}}.messages (channel_id, bucket, message_id, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
         [
           {"bigint", channel_id},
           {"int", bucket},
           {"bigint", id},
           {"bigint", author_id},
           {"text", content},
           {"bigint", thread_id},
           {"bigint", reply_to_id},
           {"timestamp", created_at},
           {"timestamp", nil},
           # Bind WITHOUT the frozen<...> wrapper: the schema column stays
           # list<frozen<map<text, text>>> (storage property), but Xandra's
           # value encoder has no {:frozen, _} clause — the DDL-mirroring bind
           # type raised FunctionClauseError on every non-empty attachments
           # list (a dead path until the compat surface first exercised it,
           # bots plan U6). The wire encoding is identical either way.
           {"list<map<text, text>>", attachments_cql}
         ]},
        # author_messages locator (U14 sweep input) — same write path, no scans.
        {"INSERT INTO {{K}}.author_messages (author_id, message_id, channel_id, bucket) VALUES (?, ?, ?, ?)",
         [
           {"bigint", author_id},
           {"bigint", id},
           {"bigint", channel_id},
           {"int", bucket}
         ]}
      ] ++
        thread_locator_insert(thread_id, id, channel_id, bucket)

    :ok = timed_insert(channel_id, fn -> Repo.batch!(statements) end)

    # The embed/component side rows ride their OWN batch, stamped from
    # `Cytale.StrictClock` — the clock `replace_side_rows/4` stamps a replace
    # with. Server-stamped (the default) they lived on the DATABASE's clock
    # while a replace's tombstone lived on the APP's: with the app 0.6 s
    # behind (measured, in a CI microVM guest), a replace's tombstone was
    # "older" than the rows it deleted and the two lists MERGED. One clock for
    # every write in the LWW construction makes it immune to skew. (A batch
    # carries one timestamp — `Repo.batch!/2` — hence the separate batch.)
    case side_row_inserts(id, embeds, components) do
      [] -> :ok
      side_rows -> :ok = Repo.batch!(side_rows, timestamp: Cytale.StrictClock.now_us())
    end

    message = %{
      id: id,
      channel_id: channel_id,
      bucket: bucket,
      author_id: author_id,
      content: content,
      thread_id: thread_id,
      reply_to_id: reply_to_id,
      created_at: created_at,
      edited_at: nil,
      attachments: attachments,
      embeds: embeds,
      components: components,
      # Whether an `@everyone`/`@here` in this message may NOTIFY (the text is
      # kept either way): only when the SENDER's `allowed_mentions` permits it
      # (absent = the default, which does) AND the author holds
      # `mention_everyone` in the channel — `Cytale.Notifications.
      # BroadcastGate` (a webhook resolves as its creator). Resolved here,
      # once, for every producer; the flag rides the message to the inbox leg
      # below and the dispatch wire.
      mention_everyone:
        case Map.get(attrs, :mention_everyone) do
          verdict when is_boolean(verdict) ->
            verdict and Cytale.Notifications.Mentions.broadcast?(content || "")

          _ ->
            AllowedMentions.everyone?(allowed_mentions) and
              Cytale.Notifications.BroadcastGate.permitted?(content, author_id, channel_id)
        end,
      # The users this message may notify directly, when the sender narrowed
      # them with `allowed_mentions` (nil = no restriction: every `<@id>`, and
      # the replied-to author). Rides to the inbox leg and the create's wire
      # (`mention_user_ids`), so the push policy honours the same list.
      mention_user_ids: AllowedMentions.user_ids(allowed_mentions, content, Map.get(attrs, :reply_author_id))
    }

    # #117: the durable mention event, written HERE because this is the one
    # place every producer converges (REST, compat, webhook, interaction) and
    # because it runs BEFORE the caller publishes — so the row a mentioned
    # member's inbox hydrates from can never miss the message that created it.
    # Best-effort inside the module: the message is already stored, and a
    # backlog problem must never cost a member the message.
    #
    # DM search (owner direction 2026-09-15: "DMs should be indexed and
    # searchable"): a DM message is written to BOTH participants' per-user
    # indexes, so the permission is the partition — a query over a user's
    # index can only ever see their own conversations. Workspace messages
    # index on the workspace fan-out instead (Workspace.fan_out), which the
    # :test publish impl does not run; this hook fires on the write seam
    # itself so the segment works in every environment. Best-effort: same
    # terms as the mention write above.
    #
    # PERF-3: the two legs above touch DISJOINT tables (mention_events vs. the
    # search segments) and neither reads the other, so they run CONCURRENTLY
    # instead of as a serial tail on every send. Both legs complete before
    # this function returns — the caller publishes only after
    # `create_message/1` returns, so today's ordering guarantee (the durable
    # mention row can never trail the MessageCreate dispatch) holds exactly as
    # before, and so does each leg's error contract: both rescue internally
    # and are :ok by their own contracts, so a dead leg PROCESS (the one
    # failure shape a Task adds) is logged and absorbed — a best-effort leg
    # must not fail the send, and neither leg can today.
    [
      {:mentions, fn -> Cytale.Inbox.record_mentions(message) end},
      {:dm_index, fn -> index_dm_message(channel_id, message, Map.get(attrs, :channel_kind)) end}
    ]
    |> Task.async_stream(fn {_leg, fun} -> fun.() end, max_concurrency: 4, ordered: true)
    |> Enum.zip([:mentions, :dm_index])
    |> Enum.each(fn
      {{:ok, :ok}, _leg} ->
        :ok

      {{:ok, other}, leg} ->
        # Unreachable while the legs keep their :ok contracts; kept `=`-shaped
        # fail-fast, exactly as the old `:ok = Cytale.Inbox.record_mentions/1`
        # match was, so a contract violation cannot pass silently.
        raise "message create leg #{inspect(leg)} returned #{inspect(other)}"

      {{:exit, reason}, leg} ->
        require Logger
        Logger.warning("message create leg #{inspect(leg)} died: #{inspect(reason)}")
    end)

    {:ok, message}
  end

  # The DM half of the search index seam. One point read resolves the channel;
  # a workspace channel returns nil and nothing happens. A caller that already
  # resolved the channel says so (`:channel_kind`), and the read is skipped —
  # every workspace send used to pay a `dm_channels` read to learn "not a DM".
  defp index_dm_message(_channel_id, _message, :channel), do: :ok

  defp index_dm_message(channel_id, message, kind) do
    dm =
      case kind do
        {:dm, dm} -> dm
        _unknown -> Cytale.Workspaces.get_dm(channel_id)
      end

    case dm do
      %{user_ids: user_ids} when is_list(user_ids) ->
        Enum.each(user_ids, &Cytale.Search.TantivyImpl.index_dm_message(&1, message))

      _ ->
        :ok
    end
  rescue
    e ->
      require Logger
      Logger.warning("dm index write failed: #{Exception.message(e)}")
      :ok
  end

  @doc """
  History page for a channel: newest-first, cursor-paginated. Reads enough
  buckets backwards from `before`'s bucket (or now) to fill `limit` rows.

  `before` is exclusive: rows with message_id strictly less than it.

  `after` (#152) is the forward cursor, also exclusive: the `limit` rows
  CLOSEST to the anchor that are newer than it — "everything since X", paged
  forward by passing the page's newest id as the next `after`. The page is
  still returned newest-first. `before` wins when both are given (the routes
  reject that combination before it gets here).

  `exclude_call_log` (default true) drops the standing call-log thread's
  rows — a CHANNEL-timeline rule; thread-scoped reads (the call log's own
  hydration) pass `false` so those rows survive.
  """
  @spec history(integer(), keyword()) :: [t()]
  def history(channel_id, opts \\ []) do
    limit = min(Keyword.get(opts, :limit, 50), 100)
    before = Keyword.get(opts, :before)
    exclude_call_log = Keyword.get(opts, :exclude_call_log, true)

    case Keyword.get(opts, :after) do
      nil -> history_before(channel_id, before, limit, exclude_call_log)
      after_id -> history_after(channel_id, after_id, limit, exclude_call_log)
    end
  end

  defp history_before(channel_id, before, limit, exclude_call_log) do
    anchor_ms =
      case before do
        nil -> System.system_time(:millisecond)
        id -> Cytale.Snowflake.timestamp_ms(id)
      end

    scan_buckets(channel_id, before, anchor_ms, limit, 3, exclude_call_log)
  end

  # Bucket-bounded scan: walk backwards across up to `max_buckets` buckets,
  # collecting rows until `limit` is met.
  #
  # Each bucket is read in BOUNDED CHUNKS (hardening plan 2.2). It used to be one
  # unbounded `SELECT` per bucket, i.e. Xandra's 10k-row first page of full message
  # rows — content included — to fill a 50-row page, up to three times. The chunk
  # cursor is what keeps the smaller read CORRECT rather than merely cheaper: the
  # timeline filter rejects thread replies, so a bucket whose newest rows are all
  # replies must still be walked to its older plain messages. Stopping at the first
  # short page and moving to an older bucket would strand them — they are newer
  # than the next bucket's rows, so no later page's `before` cursor could reach
  # them.
  @bucket_read_limit 200
  defp scan_buckets(channel_id, before, anchor_ms, limit, max_buckets, exclude_call_log) do
    start_bucket = bucket_for(anchor_ms)

    # Voice plan U4 (R5): the channel timeline EXCLUDES the standing
    # call-log thread's rows (they render in the call log, never inline) —
    # one cheap point-lookup on the `call_threads` mapping (nil mapping =
    # no call ever started here: the filter is a no-op pass-through). The
    # rejection runs INSIDE the loop so `limit` counts only surviving
    # (timeline-visible) rows — an underfilled page keeps scanning older
    # buckets within the cap instead of coming back short.
    # :channel_timeline drops EVERY thread reply (call-log included — Discord
    # hides thread messages from the channel read); :thread_scoped (the
    # thread/call-log hydration, exclude_call_log: false) keeps them.
    timeline_mode = if exclude_call_log, do: :channel_timeline, else: :thread_scoped

    rows =
      Enum.reduce_while(0..(max_buckets - 1), [], fn offset, acc ->
        if length(acc) >= limit do
          {:halt, acc}
        else
          bucket = start_bucket - offset
          {:cont, fill_bucket(channel_id, bucket, before, timeline_mode, acc, limit)}
        end
      end)

    rows
    |> Enum.sort_by(& &1["message_id"], :desc)
    |> Enum.take(limit)
    |> Enum.map(&row_to_message/1)
    |> attach_embeds()
    |> attach_components()
    |> attach_author_overrides()
  end

  # One bucket, chunk by chunk, until the page is full or the bucket is exhausted
  # (a short chunk means "no more rows under this cursor"). Tail-recursive, so a
  # bucket holding many rejected replies costs statements rather than stack.
  defp fill_bucket(channel_id, bucket, cursor, timeline_mode, acc, limit) do
    page = read_bucket(channel_id, bucket, cursor, @bucket_read_limit)

    # `:lists.reverse/2` prepends this chunk's survivors instead of
    # `acc ++ survivors`, which rebuilt the whole accumulator once per chunk
    # (hardening plan 5.14). Accumulation ORDER never reaches the caller: the
    # tail of `scan_buckets/6` sorts by `message_id` DESC before taking
    # `limit`, and ids are unique, so the reversed accumulator yields the
    # identical page.
    acc = :lists.reverse(reject_call_log_rows(page, timeline_mode), acc)

    cond do
      length(acc) >= limit -> acc
      length(page) < @bucket_read_limit -> acc
      true -> fill_bucket(channel_id, bucket, oldest_message_id(page), timeline_mode, acc, limit)
    end
  end

  # Forward read (#152): walk buckets from the anchor's up to now, each in
  # ascending bounded chunks, until `limit` timeline-visible rows are found.
  # Ascending is a reversed-clustering single-partition read, which CQL serves
  # directly. The walk is one small read per bucket in the gap, so an ancient
  # anchor costs a bucket per week between it and now — bounded by the gap,
  # never by channel traffic, and it stops as soon as the page is full.
  defp history_after(channel_id, after_id, limit, exclude_call_log) do
    timeline_mode = if exclude_call_log, do: :channel_timeline, else: :thread_scoped
    first = bucket_for(Cytale.Snowflake.timestamp_ms(after_id))
    last = bucket_for(System.system_time(:millisecond))

    first..max(first, last)//1
    |> Enum.reduce_while([], fn bucket, acc ->
      acc = fill_bucket_forward(channel_id, bucket, after_id, timeline_mode, acc, limit)
      if length(acc) >= limit, do: {:halt, acc}, else: {:cont, acc}
    end)
    |> Enum.sort_by(& &1["message_id"], :asc)
    |> Enum.take(limit)
    |> Enum.sort_by(& &1["message_id"], :desc)
    |> Enum.map(&row_to_message/1)
    |> attach_embeds()
    |> attach_components()
    |> attach_author_overrides()
  end

  defp fill_bucket_forward(channel_id, bucket, cursor, timeline_mode, acc, limit) do
    page =
      Repo.execute!(
        "SELECT message_id, channel_id, bucket, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?",
        [{"bigint", channel_id}, {"int", bucket}, {"bigint", cursor}, {"int", @bucket_read_limit}]
      )
      |> Enum.to_list()

    acc = acc ++ reject_call_log_rows(page, timeline_mode)

    cond do
      length(acc) >= limit -> acc
      length(page) < @bucket_read_limit -> acc
      true -> fill_bucket_forward(channel_id, bucket, List.last(page)["message_id"], timeline_mode, acc, limit)
    end
  end

  @doc """
  A thread's replies, newest-first, from the thread's own locator partition
  (#152) — never a walk of the parent channel. Same cursor contract as
  `history/2`: exclusive `before` (older page) or `after` (newer page, the
  rows closest to the anchor), `limit` capped at 100.

  Because the read is thread-scoped, a page SHORTER than `limit` is proof that
  no more replies exist in that direction — the property the channel walk
  could never give. A locator row whose message is gone (a delete that did not
  know its thread) is skipped, the page refilled from further along, and the
  row removed so the index heals.
  """
  @spec thread_history(integer(), keyword()) :: [t()]
  def thread_history(thread_id, opts \\ []) do
    limit = min(Keyword.get(opts, :limit, 50), 100)

    direction =
      case {Keyword.get(opts, :before), Keyword.get(opts, :after)} do
        {nil, nil} -> {:before, nil}
        {nil, after_id} -> {:after, after_id}
        {before, _} -> {:before, before}
      end

    thread_id
    |> collect_thread_page(direction, limit, [])
    |> Enum.sort_by(& &1.id, :desc)
  end

  defp collect_thread_page(thread_id, {dir, cursor}, limit, acc) do
    want = limit - length(acc)
    rows = read_thread_locator(thread_id, dir, cursor, want)
    found = get_many(Enum.map(rows, &{&1["channel_id"], &1["message_id"]}))

    {live, stale} =
      Enum.split_with(rows, &Map.has_key?(found, {&1["channel_id"], &1["message_id"]}))

    Enum.each(stale, fn row ->
      Repo.execute!(
        "DELETE FROM {{K}}.thread_messages WHERE thread_id = ? AND message_id = ?",
        [{"bigint", thread_id}, {"bigint", row["message_id"]}]
      )
    end)

    acc = acc ++ Enum.map(live, &Map.fetch!(found, {&1["channel_id"], &1["message_id"]}))

    cond do
      # Exhausted: the locator had fewer rows than asked for.
      length(rows) < want -> acc
      length(acc) >= limit -> acc
      # Full read but some rows were stale: continue past the last row read.
      true -> collect_thread_page(thread_id, {dir, List.last(rows)["message_id"]}, limit, acc)
    end
  end

  defp read_thread_locator(thread_id, dir, cursor, limit) do
    {stmt, params} =
      case {dir, cursor} do
        {:before, nil} ->
          {"SELECT message_id, channel_id FROM {{K}}.thread_messages WHERE thread_id = ? LIMIT ?",
           [{"bigint", thread_id}, {"int", limit}]}

        {:before, id} ->
          {"SELECT message_id, channel_id FROM {{K}}.thread_messages WHERE thread_id = ? AND message_id < ? LIMIT ?",
           [{"bigint", thread_id}, {"bigint", id}, {"int", limit}]}

        {:after, id} ->
          {"SELECT message_id, channel_id FROM {{K}}.thread_messages WHERE thread_id = ? AND message_id > ? ORDER BY message_id ASC LIMIT ?",
           [{"bigint", thread_id}, {"bigint", id}, {"int", limit}]}
      end

    stmt |> Repo.execute!(params) |> Enum.to_list()
  end

  # Rows arrive newest-first (clustering order is message_id DESC), so the last
  # one is the next cursor.
  defp oldest_message_id(page), do: page |> List.last() |> Map.fetch!("message_id")

  # Channel timeline = messages with NO thread. Thread replies (any thread,
  # the standing call-log thread included) belong to their thread's read —
  # Discord's channel read hides them too. Thread-scoped reads keep all rows.
  defp reject_call_log_rows(rows, :channel_timeline) do
    Enum.reject(rows, &(&1["thread_id"] != nil))
  end

  defp reject_call_log_rows(rows, :thread_scoped), do: rows

  defp read_bucket(channel_id, bucket, before, limit) do
    {stmt, params} =
      if before do
        {"SELECT message_id, channel_id, bucket, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id < ? LIMIT ?",
         [{"bigint", channel_id}, {"int", bucket}, {"bigint", before}, {"int", limit}]}
      else
        {"SELECT message_id, channel_id, bucket, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? LIMIT ?",
         [{"bigint", channel_id}, {"int", bucket}, {"int", limit}]}
      end

    Repo.execute!(stmt, params)
    |> Enum.to_list()
  end

  @doc "Fetch one message."
  @spec get_message(integer(), integer()) :: t() | nil
  def get_message(channel_id, message_id) do
    bucket = bucket_for(Cytale.Snowflake.timestamp_ms(message_id))

    rows =
      Repo.query!(
        "SELECT message_id, channel_id, bucket, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id = ?",
        [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]
      )
      |> Enum.to_list()

    case rows do
      [row] -> row_to_message(row) |> put_embeds() |> put_components() |> put_author_override()
      [] -> nil
    end
  end

  @doc """
  Fetch a SET of messages by `{channel_id, message_id}` in a bounded number of
  reads (hardening plan 5.9's hydration half).

  Search hydrates its hits one by one today: `get_message/2` costs up to four
  reads (the row, embeds, components, author override), so a 25-hit page paid up
  to 100. This is the same shape as a page render: ONE messages read per
  (channel, bucket) partition group — the partition key, so the `IN ?` is a
  single-partition multi-clustering read — plus ONE read for each side table
  covering every id.

  Returns `%{{channel_id, message_id} => t()}`: ids that are gone (deleted
  messages, the #76 ghost-document case) are simply absent.
  """
  @spec get_many([{integer(), integer()}]) :: %{optional({integer(), integer()}) => t()}
  def get_many(pairs) when is_list(pairs) do
    grouped =
      pairs
      |> Enum.uniq()
      |> Enum.group_by(
        fn {channel_id, message_id} ->
          {channel_id, bucket_for(Cytale.Snowflake.timestamp_ms(message_id))}
        end,
        fn {_channel_id, message_id} -> message_id end
      )

    base =
      Enum.reduce(grouped, %{}, fn {{channel_id, bucket}, ids}, acc ->
        Repo.execute!(
          "SELECT message_id, channel_id, bucket, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id IN ?",
          [{"bigint", channel_id}, {"int", bucket}, {"list<bigint>", ids}]
        )
        |> Enum.to_list()
        |> Enum.reduce(acc, fn row, inner ->
          message = row_to_message(row)
          Map.put(inner, {message.channel_id, message.id}, message)
        end)
      end)

    case Map.values(base) do
      [] ->
        %{}

      messages ->
        ids = Enum.map(messages, & &1.id)
        embeds = embeds_by_message(ids)
        components = components_by_message(ids)
        overrides = author_overrides_by_message(ids)

        Map.new(base, fn {key, message} ->
          {key,
           %{
             message
             | embeds: Map.get(embeds, message.id, []),
               components: Map.get(components, message.id, []),
               author_override: Map.get(overrides, message.id)
           }}
        end)
    end
  end

  @doc "Edit content (PATCH)."
  @spec edit_message(integer(), integer(), String.t()) :: :ok
  def edit_message(channel_id, message_id, new_content) do
    bucket = bucket_for(Cytale.Snowflake.timestamp_ms(message_id))
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "UPDATE {{K}}.messages SET content = ?, edited_at = ? WHERE channel_id = ? AND bucket = ? AND message_id = ?",
      [
        {"text", new_content},
        {"timestamp", now},
        {"bigint", channel_id},
        {"int", bucket},
        {"bigint", message_id}
      ]
    )

    # DM search indexes on this write seam (create/delete below do too);
    # workspace channels reindex on the fan-out's MessageUpdate.
    :ok = Cytale.Search.reindex_dm_message(channel_id, message_id)
    :ok
  end

  @doc """
  Wholesale component replace (components plan U3, R5/KTD4): deletes every
  stored action-row side row for the message and writes `components`
  (ALREADY validated by the accepting surface — the type-7 callback, the
  `@original` PATCH, or a bot's compat message PATCH). This is the ONLY
  mutation path for stored components: creates write once, every edit
  surface replaces through here. `channel_id` pins the
  call shape beside `edit_message/3` (the side table itself keys on
  message_id only).

  Concurrency is last-write-wins PER OPERATION (KTD4, documented — no
  platform serialization; the bot-side mitigation is disabling buttons in
  the first UPDATE): every write of one replace carries the SAME
  `USING TIMESTAMP`, so two racing replaces interleave as two monolithic
  writes — each `(message_id, idx)` row and the delete tombstone resolve to
  the newer operation's clock, and the surviving set is one operation's list.

  That "never a mix" claim is only true while the operation stamps are
  DISTINCT, which is why the stamp comes from `Cytale.StrictClock` rather than
  the wall clock: with two operations stamped at the same microsecond, each
  one's inserts (`ts + 1`) outlive the other's tombstone (`ts`), both lists
  survive, and the result is a merge. The controller's concurrent-click test
  caught exactly that under load.
  """
  @spec replace_components(integer(), integer(), [map()]) :: :ok
  def replace_components(_channel_id, message_id, components) when is_integer(message_id) and is_list(components) do
    replace_side_rows("message_components", "component", message_id, components)
  end

  @doc """
  Wholesale embeds replace (components plan U3, R5 — type-7 `data.embeds`
  rides the same machinery): the `message_components` twin over
  `message_embeds`. A person's embeds stay immutable after create (U10); a
  bot's are replaced by the interaction callback's UPDATE_MESSAGE, the
  `@original` PATCH, or its compat message PATCH.
  """
  @spec replace_embeds(integer(), integer(), [map()]) :: :ok
  def replace_embeds(_channel_id, message_id, embeds) when is_integer(message_id) and is_list(embeds) do
    replace_side_rows("message_embeds", "embed", message_id, embeds)
  end

  # The shared wholesale replace: one tombstone + re-inserts stamped from ONE
  # per-operation clock (the KTD4 LWW construction). Scylla applies row-level
  # LWW by write timestamp and a DELETE WINS ties, so the inserts carry
  # ts+1 (they must outlive their own operation's tombstone — equal stamps
  # would bury them); a LATER operation's tombstone (ts₂ ≥ ts₁+1) still wins
  # the tie-or-newer comparison against the older operation's inserts, so
  # the surviving set is always exactly the newest operation's list.
  defp replace_side_rows(table, value_column, message_id, values) do
    # NOT `System.system_time(:microsecond)` — see `Cytale.StrictClock`: two
    # concurrent replaces can read the same microsecond, and then each
    # operation's inserts (`ts + 1`) outlive the other's tombstone (`ts`), so the
    # two lists MERGE. Strict monotonicity is what the margin below assumes.
    ts = Cytale.StrictClock.now_us()

    Repo.execute!(
      "DELETE FROM {{K}}.#{table} USING TIMESTAMP ? WHERE message_id = ?",
      [{"bigint", ts}, {"bigint", message_id}]
    )

    Enum.with_index(values, fn value, idx ->
      Repo.execute!(
        "INSERT INTO {{K}}.#{table} (message_id, idx, #{value_column}) VALUES (?, ?, ?) USING TIMESTAMP ?",
        [
          {"bigint", message_id},
          {"int", idx},
          {"text", Jason.encode!(value)},
          {"bigint", ts + 1}
        ]
      )
    end)

    :ok
  end

  @doc "Delete (tombstone semantics land in U14; REST delete removes the row)."
  @spec delete_message(integer(), integer(), keyword()) :: :ok
  def delete_message(channel_id, message_id, opts \\ []) do
    bucket = bucket_for(Cytale.Snowflake.timestamp_ms(message_id))
    # A reply's thread locator row (#152) goes with it when the caller knows
    # the thread; one it misses is harmless — hydration drops ids whose
    # message is gone.
    thread_locator_delete =
      case Keyword.get(opts, :thread_id) do
        nil ->
          []

        thread_id ->
          [
            {"DELETE FROM {{K}}.thread_messages WHERE thread_id = ? AND message_id = ?",
             [{"bigint", thread_id}, {"bigint", message_id}]}
          ]
      end

    # ONE unlogged batch for the cascade (hardening plan 5.6): the message row and
    # its four side tables were five sequential DELETEs for one user action. The
    # comments below are preserved per statement because each one explains why that
    # table is in the cascade at all.
    #
    # `reaction_counts` is a COUNTER table since hardening plan 4.3, and CQL
    # forbids mixing counter and non-counter mutations in one batch ("Counter and
    # non-counter mutations cannot exist in the same batch" — the suite caught
    # exactly that when the tally became a real counter). It rides its own
    # single-statement batch: the same round-trip count, two frames.
    :ok =
      Repo.batch!(
        [
          # The message itself.
          {"DELETE FROM {{K}}.messages WHERE channel_id = ? AND bucket = ? AND message_id = ?",
           [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]},
          # Author-override rows cascade the same way (U11).
          {"DELETE FROM {{K}}.message_author_overrides WHERE message_id = ?", [{"bigint", message_id}]},
          # Reaction existence rows die with their whole partition (they are keyed on
          # the message's own (channel_id, bucket, message_id) partition).
          {"DELETE FROM {{K}}.reactions_by_message WHERE channel_id = ? AND bucket = ? AND message_id = ?",
           [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]}
        ] ++ thread_locator_delete
      )

    # Embed + component side rows cascade on the APP clock (StrictClock), in
    # their own batch: they are the rows `replace_side_rows/4` writes with that
    # clock, and a server-stamped tombstone could lose to a replace stamped
    # ahead of the database's clock — the deleted message's card would then
    # outlive it. (Attachments live inline in the messages row; author_messages
    # locator rows stay put for the U14 sweep.)
    :ok =
      Repo.batch!(
        [
          {"DELETE FROM {{K}}.message_embeds WHERE message_id = ?", [{"bigint", message_id}]},
          {"DELETE FROM {{K}}.message_components WHERE message_id = ?", [{"bigint", message_id}]}
        ],
        timestamp: Cytale.StrictClock.now_us()
      )

    :ok =
      Repo.batch!([
        # …and the per-emoji tallies with them. This is the ONE place a counter
        # partition delete is safe (`Cytale.Messages.Reactions.bump_count/4`
        # documents why a counter DELETE is poisonous in general): a Snowflake
        # message id is never reused, so no future reaction can be added here for
        # a tombstone to swallow.
        {"DELETE FROM {{K}}.reaction_counts WHERE channel_id = ? AND bucket = ? AND message_id = ?",
         [{"bigint", channel_id}, {"int", bucket}, {"bigint", message_id}]}
      ])

    # The DM index's delete half (workspace deletes unindex on the fan-out).
    case Cytale.Workspaces.get_dm(channel_id) do
      %{user_ids: user_ids} when is_list(user_ids) ->
        Enum.each(user_ids, &Cytale.Search.TantivyImpl.unindex_dm(&1, message_id))

      _ ->
        :ok
    end

    :ok
  end

  defp side_row_inserts(id, embeds, components) do
    Enum.with_index(embeds, fn embed, idx ->
      {"INSERT INTO {{K}}.message_embeds (message_id, idx, embed) VALUES (?, ?, ?)",
       [{"bigint", id}, {"int", idx}, {"text", Jason.encode!(embed)}]}
    end) ++
      Enum.with_index(components, fn component, idx ->
        {"INSERT INTO {{K}}.message_components (message_id, idx, component) VALUES (?, ?, ?)",
         [{"bigint", id}, {"int", idx}, {"text", Jason.encode!(component)}]}
      end)
  end

  # The thread reply locator (#152): only a reply has one.
  defp thread_locator_insert(nil, _id, _channel_id, _bucket), do: []

  defp thread_locator_insert(thread_id, id, channel_id, bucket) do
    [
      {"INSERT INTO {{K}}.thread_messages (thread_id, message_id, channel_id, bucket) VALUES (?, ?, ?, ?)",
       [{"bigint", thread_id}, {"bigint", id}, {"bigint", channel_id}, {"int", bucket}]}
    ]
  end

  # -- internals -----------------------------------------------------------------

  defp row_to_message(r) do
    %{
      id: r["message_id"],
      channel_id: r["channel_id"],
      bucket: r["bucket"],
      author_id: r["author_id"],
      content: r["content"],
      thread_id: r["thread_id"],
      reply_to_id: r["reply_to_id"],
      created_at: r["created_at"],
      edited_at: r["edited_at"],
      attachments: attachments_from(r["attachments"]),
      # Filled by the embed join below (reads) or set at create time.
      embeds: [],
      # Filled by the component join below (reads) or set at create time.
      components: [],
      # Filled by the override join below (webhook messages only, U11).
      author_override: nil
    }
  end

  # -- embed join (U10) ----------------------------------------------------------

  # One IN query per page (≤100 ids) / one point query for a single message;
  # rows group by message and sort by idx — storage order is wire order.
  defp attach_embeds([]), do: []

  defp attach_embeds(messages) do
    by_message = embeds_by_message(Enum.map(messages, & &1.id))
    Enum.map(messages, &Map.put(&1, :embeds, Map.get(by_message, &1.id, [])))
  end

  defp put_embeds(message) do
    Map.put(message, :embeds, Map.get(embeds_by_message([message.id]), message.id, []))
  end

  defp embeds_by_message(ids) do
    rows =
      Repo.execute!(
        "SELECT message_id, idx, embed FROM {{K}}.message_embeds WHERE message_id IN ?",
        [{"list<bigint>", ids}]
      )
      |> Enum.to_list()

    rows
    |> Enum.group_by(& &1["message_id"])
    |> Map.new(fn {message_id, message_rows} ->
      embeds =
        message_rows
        |> Enum.sort_by(& &1["idx"])
        |> Enum.map(&Jason.decode!(&1["embed"]))

      {message_id, embeds}
    end)
  end

  # -- component join (components plan U1, KTD1) ---------------------------------
  # The embeds twin: one IN query per page (≤100 ids) / one point query for a
  # single message; rows group by message and sort by idx — storage order is
  # wire order, verbatim JSON.

  defp attach_components([]), do: []

  defp attach_components(messages) do
    by_message = components_by_message(Enum.map(messages, & &1.id))
    Enum.map(messages, &Map.put(&1, :components, Map.get(by_message, &1.id, [])))
  end

  defp put_components(message) do
    Map.put(message, :components, Map.get(components_by_message([message.id]), message.id, []))
  end

  defp components_by_message(ids) do
    rows =
      Repo.execute!(
        "SELECT message_id, idx, component FROM {{K}}.message_components WHERE message_id IN ?",
        [{"list<bigint>", ids}]
      )
      |> Enum.to_list()

    rows
    |> Enum.group_by(& &1["message_id"])
    |> Map.new(fn {message_id, message_rows} ->
      components =
        message_rows
        |> Enum.sort_by(& &1["idx"])
        |> Enum.map(&Jason.decode!(&1["component"]))

      {message_id, components}
    end)
  end

  # -- author-override join (U11, KTD12) -----------------------------------------
  # Same shape as the embed join: one IN query per page / one point query for
  # a single message. Rows exist ONLY for webhook executes that carried a
  # username/avatar_url override; every other message reads nil.

  defp attach_author_overrides([]), do: []

  defp attach_author_overrides(messages) do
    by_message = author_overrides_by_message(Enum.map(messages, & &1.id))

    Enum.map(messages, &Map.put(&1, :author_override, Map.get(by_message, &1.id)))
  end

  defp put_author_override(message) do
    Map.put(message, :author_override, Map.get(author_overrides_by_message([message.id]), message.id))
  end

  defp author_overrides_by_message(ids) do
    rows =
      Repo.execute!(
        "SELECT message_id, override_username, override_avatar_url FROM {{K}}.message_author_overrides WHERE message_id IN ?",
        [{"list<bigint>", ids}]
      )
      |> Enum.to_list()

    Map.new(rows, fn row ->
      # `kind`: an override row is only ever written by a webhook execute, so
      # the wire map names its author kind — the client badges the message
      # from the message itself, not only from a roster row (Tier 3 B, 10b).
      override =
        %{"kind" => "webhook"}
        |> maybe_override_field("username", row["override_username"])
        |> maybe_override_field("avatar_url", row["override_avatar_url"])

      {row["message_id"], override}
    end)
  end

  defp maybe_override_field(map, _key, nil), do: map
  defp maybe_override_field(map, key, value), do: Map.put(map, key, value)

  @doc """
  Normalize inbound attachment descriptors for persistence (every create
  surface — native, compat, webhook execute): each entry must be a map that
  carries at least one KNOWN descriptor field (`@attachment_keys` below)
  whose value is a scalar (string/number/boolean); surviving entries are
  stringified (the `attachments` column is
  `list<frozen<map<text, text>>>`). A non-list container, a non-map entry,
  a nil/map/list value, or an entry with NO known field (#136: `[]`, or an
  unknown-keyed map like `{"x":1}` — both passed the old all-scalar check
  vacuously and stored the empty-map stub every reader then rendered as a
  phantom attachment) is `{:error, :invalid_attachments}` — a 400-class
  validation failure on every surface, never a 500 from `to_string/1`.
  """
  @spec normalize_attachments(term()) :: {:ok, [map()]} | {:error, :invalid_attachments}
  def normalize_attachments(nil), do: {:ok, []}

  def normalize_attachments(list) when is_list(list) do
    if Enum.all?(list, &is_map/1) and Enum.all?(list, &scalar_attachment?/1) do
      {:ok, Enum.map(list, &stringify_attachment/1)}
    else
      {:error, :invalid_attachments}
    end
  end

  def normalize_attachments(_), do: {:error, :invalid_attachments}

  # width/height ride the descriptor when the upload sniffed the image
  # dims (C-3); everything persists stringified either way.
  @attachment_keys ["url", "filename", "content_type", "size", "id", "width", "height"]

  # A descriptor map is a map OF descriptor fields: an entry none of whose
  # known keys survive the take is not a descriptor, whatever else it may
  # carry (#136 — the empty map satisfied the old scalar check vacuously).
  defp scalar_attachment?(att) do
    known = Map.take(att, @attachment_keys)
    known != %{} and Enum.all?(known, fn {_k, v} -> scalar?(v) end)
  end

  defp stringify_attachment(att),
    do: att |> Map.take(@attachment_keys) |> Map.new(fn {k, v} -> {k, to_string(v)} end)

  defp scalar?(v), do: is_binary(v) or is_number(v) or is_boolean(v)

  # The numeric descriptor fields: persisted as text (the column is
  # map<text, text>), typed as integers on the native wire.
  @numeric_attachment_keys ["size", "width", "height"]

  @doc """
  Stored attachment descriptors → the native WIRE shape, each `url` SIGNED
  for this render (`Cytale.Attachments.SignedUrl`, Tier 2 #4). Persistence
  stringifies every value, so `size` — and the sniffed image `width`/`height`
  the upload recorded (C-3) — reached clients as strings while the domain
  type says number. This types them as integers, which is what lets a client
  reserve an image's aspect-ratio box before the bytes arrive. A value that
  does not parse as a non-negative integer is dropped from the entry rather
  than sent as a string a numeric reader would misread; `width`/`height`
  stay ABSENT for non-images (never null).
  """
  @spec wire_attachments(term()) :: [map()]
  def wire_attachments(list) when is_list(list),
    do: Enum.map(list, &(&1 |> wire_attachment() |> Cytale.Attachments.SignedUrl.sign_attachment()))

  def wire_attachments(_), do: []

  defp wire_attachment(att) when is_map(att) do
    Enum.reduce(@numeric_attachment_keys, att, fn key, acc ->
      case Map.fetch(acc, key) do
        {:ok, v} when is_integer(v) and v >= 0 ->
          acc

        {:ok, v} when is_binary(v) ->
          case Integer.parse(v) do
            {n, ""} when n >= 0 -> Map.put(acc, key, n)
            _ -> Map.delete(acc, key)
          end

        {:ok, _other} ->
          Map.delete(acc, key)

        :error ->
          acc
      end
    end)
  end

  defp wire_attachment(other), do: other

  # Xandra returns list<map<text,text>> rows as lists of maps already; keep
  # the wire shape JSON-friendly either way.
  defp attachments_from(list) when is_list(list), do: Enum.map(list, &stringify_values/1)
  defp attachments_from(_), do: []

  defp stringify_values(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), to_string(v)} end)
  defp stringify_values(other), do: other

  defp stringify_map(m) when is_map(m), do: Map.new(m, fn {k, v} -> {to_string(k), to_string(v)} end)
end
