defmodule CytaleWeb.Compat.MessageCodec do
  @moduledoc """
  KTD10 — the ONE shared compat codec: native rows and claims → Discord
  wire shapes (message / user / channel / attachment objects). Used by the
  compat REST controllers (U6) AND the bot-session gateway codec (U7) —
  never forked per surface.

  Shape rules:

    * ids are decimal strings, ids only — never JSON numbers;
    * `discriminator` is always `"0"` and `global_name` mirrors the username
      (post-migration Discord shape; Cytale has no discriminators);
    * machine principals carry `bot: true` on their user object; a webhook
      author additionally stamps `webhook_id` on the MESSAGE, and a stored
      per-message author override (U11) renders its username on the author
      object while `author_id`/`webhook_id` stay the principal's;
    * replies carry `type: 19`, `message_reference`, and a depth-1
      `referenced_message` snapshot (a dangling/deleted original keeps the
      reference and drops the snapshot — Discord's shape);
    * `mentions` is PROJECTED from the message content, which carries the same
      `<@id>` token Discord uses (the composer's reply-ping path emits it, and
      the shared markdown parser's `MENTION_TOKEN` reads it); `mention_roles`
      stays `[]` (Cytale has no role-mention syntax) and `mention_everyone` is
      false (there is no `@everyone` mention concept — the permission base is
      not a ping).
      `embeds` renders the stored embed array verbatim (`[]` when the message
      stored none — bots plan U10, KTD11 store-and-forward: unknown keys
      within an embed ride untouched); `components` renders the stored action
      rows the same way but stays ABSENT when the message stored none
      (components plan U1, R2 — stored verbatim, never stripped).

  Pure shape functions take plain maps; the author-resolution helpers do
  bounded point reads (`Users`/`Principals`) — never HTTP, never fan-out.
  Divergences from Discord are pinned in docs/protocol/compat.md.
  """

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Messages
  alias Cytale.Workspaces

  @machine_kinds ~w(bot agent webhook)a

  # ---------------------------------------------------------------------------
  # User objects
  # ---------------------------------------------------------------------------

  @doc """
  Discord user object from principal claims (the BotAuth assign shape —
  works for the native auth plug's machine/human shapes alike).
  """
  @spec user_object(map()) :: map()
  def user_object(claims) do
    # `avatar` is ALWAYS null on the compat wire (product invariant, owner
    # 2026-09-16: "we ask for nothing" — docs/architecture/
    # product-invariants.md). Discord's field is a CDN hash, not a URL; any
    # value we put here resolves to a broken image on Discord's host. Null is
    # the correct end state — do not populate it.
    base = %{
      "id" => Integer.to_string(claims.user_id),
      "username" => claims.username,
      "discriminator" => "0",
      # Discord's display name (#168): the account's display name when it has
      # one (a machine's label), else the username, as Discord falls back.
      "global_name" => display_name_or_username(claims),
      "avatar" => nil
    }

    if claims[:kind] in @machine_kinds, do: Map.put(base, "bot", true), else: base
  end

  defp display_name_or_username(claims) do
    case Map.get(claims, :display_name) do
      name when is_binary(name) and name != "" -> name
      _ -> claims.username
    end
  end

  @doc """
  Discord user object for an author id: machine principals resolve to their
  label with `bot: true`; humans resolve to their username; an unknown id
  (row gone) degrades to a tombstone object — never a crash. This is also
  the ONE resolver the gateway socket's per-socket author cache
  (`Cytale.Gateway.AuthorCache`, PERF-2) delegates to — cache miss resolves
  through here and caches the result, so cached and uncached output stay
  byte-identical.
  """
  @spec author_object(integer()) :: map()
  def author_object(author_id), do: resolve_author(author_id) |> elem(0)

  @doc """
  `{user_object, kind}` for an author id — the shared author-resolution
  read (the message builders need the kind for webhook_id).
  """
  @spec resolve_author(integer()) :: {map(), atom()}
  def resolve_author(author_id) do
    case Principals.get(author_id) do
      %{kind: kind} = principal when kind in @machine_kinds ->
        # One handle everywhere: the author object carries the TAG, like
        # the roster, @me and the gateway identity (the label is display only).
        {user_object(%{
           user_id: author_id,
           username: Principals.machine_handle(principal),
           display_name: principal.label,
           kind: kind
         }), kind}

      _ ->
        case User.get(author_id) do
          %{username: username} = user ->
            {user_object(%{
               user_id: author_id,
               username: username,
               display_name: user.display_name,
               kind: :human
             }), :human}

          _ ->
            tombstone_author(author_id)
        end
    end
  end

  # The tombstone the unknown-id path renders (R7's never-crash degradation):
  # a deleted-user object, kind :human.
  defp tombstone_author(author_id),
    do: {user_object(%{user_id: author_id, username: "deleted-user", kind: :human}), :human}

  # ---------------------------------------------------------------------------
  # Message objects
  # ---------------------------------------------------------------------------

  @doc """
  Discord message object for a native message row, resolving the author and
  — for replies — the referenced snapshot (one point read). Pass `referenced`
  when the row is already loaded; `nil` renders Discord's deleted-original
  shape (reference present, snapshot absent).
  """
  @spec message(Messages.t() | map(), map() | nil) :: map()
  def message(msg, referenced \\ nil) do
    {author, kind} = resolve_author(msg.author_id)
    build_message(msg, author, kind, referenced)
  end

  @doc """
  A history page → Discord message objects (newest-first as given). Authors
  and referenced originals are resolved ONCE per distinct id — a 50-message
  page costs one read per distinct author plus one per distinct reply.
  """
  @spec messages([map()]) :: [map()]
  def messages(list) when is_list(list) do
    authors =
      list
      |> Enum.map(& &1.author_id)
      |> Enum.uniq()
      |> Map.new(&{&1, resolve_author(&1)})

    referenced =
      list
      |> Enum.map(& &1.reply_to_id)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq()
      |> Map.new(fn reply_to_id ->
        # Replies reference their own channel: page rows share channel_id.
        channel_id = list |> List.first() |> Map.get(:channel_id)
        {reply_to_id, Messages.get_message(channel_id, reply_to_id)}
      end)

    Enum.map(list, fn msg ->
      {author, kind} = Map.fetch!(authors, msg.author_id)
      build_message(msg, author, kind, Map.get(referenced, msg.reply_to_id))
    end)
  end

  @doc """
  A THREAD's history page → Discord message objects (C-2): Discord treats
  threads as channels, so the objects' `channel_id` IS the thread id — the
  native rows carry the parent channel (replies live in the parent's
  partition with `thread_id` set) and this override rewrites the rendered
  `channel_id` (plus `message_reference.channel_id` and the depth-1
  `referenced_message.channel_id`) onto the thread.
  """
  @spec messages([map()], channel_id: integer()) :: [map()]
  def messages(list, channel_id: thread_id) when is_list(list) and is_integer(thread_id) do
    for msg <- messages(list) do
      rewrite_channel(msg, Integer.to_string(thread_id))
    end
  end

  @doc """
  One stored row → Discord message object ON ITS SCOPE: a thread reply
  (`thread_id` set) renders with the THREAD id as `channel_id` (C-2 — what
  the bot addressed and what its client keys the message cache on), any
  other row exactly as `message/2`. The interaction continuation routes
  answer through this, so a follow-up or `@original` edit of a thread card
  names the thread, as Discord does.
  """
  @spec scoped_message(map(), map() | nil) :: map()
  def scoped_message(msg, referenced \\ nil)

  def scoped_message(%{thread_id: thread_id} = msg, referenced) when is_integer(thread_id),
    do: msg |> message(referenced) |> rewrite_channel(Integer.to_string(thread_id))

  def scoped_message(msg, referenced), do: message(msg, referenced)

  defp rewrite_channel(msg, thread_id_str) do
    msg = Map.put(msg, "channel_id", thread_id_str)

    msg =
      case msg do
        %{"message_reference" => ref} when is_map(ref) ->
          Map.put(msg, "message_reference", Map.put(ref, "channel_id", thread_id_str))

        _ ->
          msg
      end

    # Depth-1 only: the snapshot itself never nests a referenced_message.
    case msg do
      %{"referenced_message" => ref} when is_map(ref) ->
        Map.put(msg, "referenced_message", rewrite_channel(ref, thread_id_str))

      _ ->
        msg
    end
  end

  defp build_message(msg, author, kind, referenced, resolved \\ %{}) do
    # U11 (KTD12): a webhook message's rendered name is the per-message
    # override (when present) ∥ the webhook's display label — the author_id
    # (and webhook_id) stay the principal's, only the name is overridden.
    author = maybe_override_author(author, kind, Map.get(msg, :author_override))

    base =
      %{
        "id" => id_str(msg.id),
        "channel_id" => id_str(msg.channel_id),
        "author" => author,
        "content" => msg.content,
        "timestamp" => msg.created_at && DateTime.to_iso8601(msg.created_at),
        "edited_timestamp" => msg.edited_at && DateTime.to_iso8601(msg.edited_at),
        "tts" => false,
        "mention_everyone" => false,
        "mentions" => mentions(msg.content, resolved),
        "mention_roles" => [],
        "attachments" => attachments(msg.attachments),
        "embeds" => embeds(Map.get(msg, :embeds)),
        "pinned" => false,
        "type" => reply_type(msg.reply_to_id)
      }
      |> maybe_components(Map.get(msg, :components))
      |> put_reference(msg, referenced, resolved)

    if kind == :webhook,
      do: Map.put(base, "webhook_id", id_str(msg.author_id)),
      else: base
  end

  # PERF-2: a pre-resolved author cache hit skips the point read; a miss
  # resolves through the ONE resolver (byte-identical output either way).
  defp cached_author(resolved, author_id) do
    case Map.get(resolved, author_id) do
      {_, _} = entry -> entry
      nil -> resolve_author(author_id)
    end
  end

  # The same token shape the clients parse: `<@123…>` or `<@!123…>`, 1-19
  # digits. (Discord's own regexes allow `<@!?[0-9]{15,20}>`; the bound here
  # matches our Snowflake width and keeps a malformed token out of a query.)
  @mention_token ~r/<@!?(\d{1,19})>/

  # Discord's mention contract, PROJECTED from the stored content (#66).
  #
  # Cytale's native wire form for a mention is the SAME token Discord uses —
  # `<@id>` — produced by the composer's reply-ping path and read back by the
  # shared markdown parser (`MENTION_TOKEN`) and the web/mobile "mentions me"
  # checks. What was missing is the ARRAY: compat messages sent `mentions: []`,
  # so `client.user in message.mentions` was False for a real tag and every
  # `require_mention` bot — the default posture of every framework — correctly
  # concluded it had not been addressed.
  #
  # Full user objects, as Discord sends (discord.py's `User._update` indexes
  # `avatar` unguarded, which our `user_object/1` always carries). Ids resolve
  # through the caller's pre-resolved author cache (PERF-2), so a mention costs
  # the same bounded point read a message author does and never a second read
  # for someone already in the batch.
  #
  # Both Discord spellings are accepted (`<@id>` and the nick form `<@!id>`);
  # ids that do not fit a Snowflake are ignored rather than fed to a query.
  defp mentions(content, resolved) when is_binary(content) do
    @mention_token
    |> Regex.scan(content)
    |> Enum.map(fn [_, id] -> id end)
    |> Enum.uniq()
    |> Enum.flat_map(fn id ->
      case safe_id(id) do
        nil -> []
        user_id -> [cached_author(resolved, user_id) |> elem(0)]
      end
    end)
  end

  defp mentions(_content, _resolved), do: []

  defp safe_id(id) do
    case Integer.parse(id) do
      {n, ""} when n > 0 and n <= 9_223_372_036_854_775_807 -> n
      _ -> nil
    end
  end

  # Ids render as decimal strings; nil/malformed degrade to nil instead of
  # crashing — the gateway push path is best-effort and must never take a
  # socket down over a degenerate payload.
  defp id_str(int) when is_integer(int), do: Integer.to_string(int)
  defp id_str(bin) when is_binary(bin), do: bin
  defp id_str(_), do: nil

  # Components plan U1 (R2): stored action rows ride the Discord message
  # object verbatim — the key is ABSENT when the message stored none
  # (Discord's own shape for component-less messages on this surface; the
  # embeds-precedent optional key).
  defp maybe_components(json, components) when is_list(components) and components != [],
    do: Map.put(json, "components", components)

  defp maybe_components(json, _), do: json

  defp reply_type(reply_to_id) when is_integer(reply_to_id), do: 19
  defp reply_type(_), do: 0

  # Webhook-only (U11): the override row's username replaces the author
  # object's username/global_name — avatar_url rides the NATIVE projection's
  # author_override key (the Discord "avatar" field is a hash, not a URL —
  # never stuff a URL into it). Non-webhook kinds and override-less webhook
  # messages pass through untouched.
  defp maybe_override_author(author, :webhook, %{"username" => username}) when is_binary(username),
    do: author |> Map.put("username", username) |> Map.put("global_name", username)

  defp maybe_override_author(author, _kind, _override), do: author

  # Reference block: message_reference whenever the row carries a reply;
  # referenced_message only when the original's snapshot was resolvable.
  # Depth-1: the snapshot itself never nests a referenced_message.
  defp put_reference(base, msg, referenced, resolved) when is_integer(msg.reply_to_id) do
    base
    |> Map.put(
      "message_reference",
      %{"message_id" => id_str(msg.reply_to_id), "channel_id" => id_str(msg.channel_id)}
    )
    |> maybe_referenced(referenced, resolved)
  end

  defp put_reference(base, _msg, _referenced, _resolved), do: base

  defp maybe_referenced(base, nil, _resolved), do: base

  defp maybe_referenced(base, orig, resolved) do
    {author, _kind} = cached_author(resolved, orig.author_id)
    Map.put(base, "referenced_message", build_message(orig, author, :snapshot, nil, resolved))
  end

  # ---------------------------------------------------------------------------
  # Channel objects
  # ---------------------------------------------------------------------------

  @doc """
  Discord channel object: `guild_id` is the workspace id (Cytale has no
  guild model beyond the workspace mapping), `type` maps native text (0) →
  Discord text (0) and native category (1) → GUILD_CATEGORY (4).

  DM rows (the channel gate's `type: :dm` shape, bots plan B-1) render as
  Discord DM channel objects — `type: 1` with a `recipients` array of user
  objects; `exclude_user_id` drops the CALLING principal from the list
  (Discord's DM channel object carries the OTHER participants).
  """
  @spec channel(map(), integer() | nil) :: map()
  def channel(ch, exclude_user_id \\ nil)

  def channel(%{type: :dm} = ch, exclude_user_id) do
    %{
      "id" => Integer.to_string(ch.channel_id),
      "type" => 1,
      "recipients" =>
        (ch.user_ids || [])
        |> Enum.reject(&(&1 == exclude_user_id))
        |> Enum.map(fn participant ->
          resolve_author(participant) |> elem(0)
        end),
      "last_message_id" => ch.last_message_id && Integer.to_string(ch.last_message_id)
    }
  end

  def channel(ch, _exclude_user_id) do
    %{
      "id" => Integer.to_string(ch.channel_id),
      "name" => ch.name,
      # `topic` and `parent_id` are real Cytale columns the native surface has
      # always served and the compat object dropped (#75). Discord's channel
      # object carries both for text channels; clients render the topic, and a
      # category's id is how a client knows a channel is nested. `Map.get` keeps
      # the shape total for the payload-shaped rows the degraded paths build.
      "topic" => Map.get(ch, :topic),
      "parent_id" => id_str(Map.get(ch, :parent_id)),
      "type" => discord_channel_type(ch.type),
      # `position` is REQUIRED, not cosmetic (#64): discord.py's
      # `TextChannel._update` / `CategoryChannel._update` index
      # `data['position']` unguarded, so a channel without it raises KeyError
      # inside the state parser — which kills `Client.connect()` outright and
      # leaves a bot that looks connected and processes nothing. Real value:
      # Cytale stores it (`channels.position`) and orders the sidebar by it.
      "position" => ch |> Map.get(:position) |> int_or_zero(),
      "last_message_id" => ch.last_message_id && Integer.to_string(ch.last_message_id)
    }
    # guild_id rides ONLY workspace channels — Discord's DM channel object
    # omits the key, and key-presence-with-null is a discord.py breaker (the
    # same rule messages follow via maybe_guild_id/2).
    |> maybe_guild_id(ch.workspace_id && Integer.to_string(ch.workspace_id))
  end

  defp discord_channel_type(1), do: 4
  defp discord_channel_type(_), do: 0

  # ---------------------------------------------------------------------------
  # Guild objects (U7 gateway compat sessions)
  # ---------------------------------------------------------------------------

  # A BOUNDED roster read: a handshake-path caller pays one per VISIBLE
  # workspace at Identify, in the same shape as every other roster cursor
  # (in-Elixir cap, no ALLOW FILTERING). Discord's own member_count is
  # likewise a cap for guilds past its threshold; a workspace larger than
  # @roster_cap reports the cap and `large: true`, never a fabricated total.
  @roster_cap 100

  # Discord's default archive window (24h, in MINUTES — Discord's unit). The
  # key is required by discord.py's thread parser (#64) and Cytale has no
  # archive schedule, so this is a shape value pinned to Discord's own
  # default rather than a policy — see the ledger entry.
  @thread_auto_archive_duration 1440

  # Discord sends integers where our rows may carry nil/malformed values, and
  # the fields below are indexed UNGUARDED by client parsers (so a null is a
  # TypeError even when the key is present). Degrade to 0, never nil.
  defp int_or_zero(v) when is_integer(v), do: v
  defp int_or_zero(_), do: 0

  @doc """
  Discord guild object for a Cytale workspace (U7 compat READY/GUILD_CREATE —
  a workspace IS the guild, KTD7). `channels` ride as Discord channel objects;
  `threads` (C-1) as Discord thread channel objects (`thread_channel/2`).

  `members`/`roles`/`member_count`/`presences` carry what a conformant client
  cannot do without (#63/#64): the workspace's REAL bounded roster (the
  connecting principal always included), one @everyone role, a count that
  describes that roster, and the live presence set. GUILD_CREATE **is**
  Discord's roster bootstrap, and a schema-valid payload with empty arrays
  left clients in a state their own documentation calls impossible:

    * `guild.me` — discord.py `guild.py:734` is an unguarded
      `get_member(self_id)` commented "the self member is ALWAYS cached", so
      an empty roster makes every standard permission check
      (`guild.me.guild_permissions`, `permissions_for(guild.me)`) raise
      AttributeError inside the caller;
    * `guild.default_role` — `guild.py:1054` makes the same assumption about
      the @everyone role, and `member.roles` silently drops its bits when it
      is missing (wrong permission math, no error at all);
    * `guild.member_count` — `None` breaks defensive comparisons
      (`len(guild.members) < guild.member_count` → TypeError).

  So: the connecting principal's OWN member object (Discord always includes
  it), one @everyone role whose id IS the guild id (Discord's identity rule
  for that role — and Cytale's `@everyone` base is a real part of the
  permission model, not a fiction invented here), and a bounded member tally.

  NOT provided, deliberately (each pinned as a ledger entry in
  `docs/protocol/compat.md`, not left as an accident): member enumeration
  BEYOND the cap (no op 8, no member routes), Cytale roles and their
  permission BITS (never projected into Discord's permission integer, so
  permission math over `roles`/`member.roles` reads the @everyone stub
  alone), and `voice_states`.
  """

  @spec guild(map(), [map()], [map()], map() | nil, [map()]) :: map()
  def guild(ws, channels \\ [], threads \\ [], self \\ nil, presences \\ []) do
    guild_id = Integer.to_string(ws.workspace_id)
    roster = roster(ws.workspace_id, guild_id)

    %{
      "id" => guild_id,
      "name" => ws.name,
      "owner_id" => ws.owner_id && Integer.to_string(ws.owner_id),
      "unavailable" => false,
      "channels" => Enum.map(channels, &channel/1),
      "threads" => Enum.map(threads, &thread_channel(&1, guild_id)),
      "members" => ensure_self(roster, self, guild_id),
      "roles" => [everyone_role(guild_id)],
      "presences" => presences,
      # The tally describes the roster in the SAME payload (not a separate
      # number): `member_count` is the size of the true member set, and when
      # the bounded read capped it, `large: true` says "what you have is not
      # all of it" — Discord's own meaning for that flag.
      "member_count" => length(roster),
      "large" => length(roster) >= @roster_cap,
      "voice_states" => [],
      "emojis" => [],
      "stickers" => [],
      "features" => []
    }
  end

  # The REAL roster, bounded — one bulk user read plus one principals read
  # (`include_principals: true`), NOT one point read per member: the flag is
  # what makes the page's name resolution batched (PERF-5 / B5), and machine
  # principals ride their parent's entry, which is how a bot appears in the
  # roster at all (R4: a principal belongs where its parent is a member).
  #
  # This is the same bounded read the handshake already paid for the member
  # tally in the #63 fix — which was ALSO doing up to @roster_cap point reads
  # per visible workspace at Identify, because `include_principals: false`
  # resolves each row through `User.get/1`. One read now serves the roster,
  # the names and the count.
  defp roster(workspace_id, guild_id) do
    workspace_id
    |> Workspaces.list_members(limit: @roster_cap, include_principals: true)
    |> Enum.map(fn m ->
      member(
        user_object(%{
          user_id: m.user_id,
          username: m.username,
          display_name: Map.get(m, :display_name),
          kind: Map.get(m, :kind)
        }),
        guild_id,
        nick: Map.get(m, :nickname),
        joined_at: Map.get(m, :joined_at)
      )
    end)
    |> Enum.reject(&is_nil(&1["user"]["id"]))
  end

  @doc """
  Discord member object — ONE shape for every site that emits one (the roster
  #63, `guild.me`, the reaction's `member` #73, INTERACTION_CREATE, and
  GUILD_MEMBER_ADD).

  `roles` is the only field discord.py indexes UNGUARDED (`member.py`:
  `SnowflakeList(map(int, data['roles']))`), so it is always present and always
  carries the @everyone stub whose id IS the guild id — see the role-bits ledger:
  Cytale's role ids are deliberately NOT projected, because a client summing
  `member.roles` against a `roles` array we cannot describe would compute
  permissions from a stub. Everything else is read defensively by both client
  libraries, so `nick`/`joined_at` are nil when unknown and the flags default to
  Discord's own values (there is no server-side deaf/mute here).

  Takes the ALREADY-BUILT user object: the reaction path resolves it through the
  per-socket author cache, and rebuilding it from parts there would be a second
  projection of the same user — the divergence #69 was about.
  """
  @spec member(map(), String.t() | nil, keyword()) :: map()
  def member(user, guild_id, opts \\ []) when is_map(user) do
    %{
      "user" => user,
      "nick" => Keyword.get(opts, :nick),
      "roles" => roles_for(guild_id),
      "joined_at" => iso(Keyword.get(opts, :joined_at)),
      "flags" => 0,
      "deaf" => false,
      "mute" => false
    }
  end

  # An unresolved guild renders NO roles rather than `[nil]`: the client maps
  # `int` over this list unguarded, so a nil member is the same crash this
  # builder exists to prevent.
  defp roles_for(guild_id) when is_binary(guild_id), do: [guild_id]

  defp roles_for(_), do: []

  # The connecting principal is ALWAYS in `members` — discord.py documents
  # `guild.me` as always cached and resolves it through an unguarded lookup,
  # so a cap that happened to truncate the bot's own parent row must not drop
  # it. Appended (deduped by user id) when the roster read did not include it.
  defp ensure_self(members, nil, _guild_id), do: members

  defp ensure_self(members, self, guild_id) do
    case self_member(self, guild_id) do
      nil ->
        members

      member ->
        id = member["user"]["id"]

        if Enum.any?(members, &(&1["user"]["id"] == id)), do: members, else: members ++ [member]
    end
  end

  # The session identity (`%{id, username, kind}`) as a Discord member — a
  # machine principal on every compat session. An identity we cannot read an
  # id from renders NO member rather than a fabricated one.
  defp self_member(self, guild_id) do
    case self_user_id(self) do
      nil ->
        nil

      user_id ->
        member(
          user_object(%{
            user_id: user_id,
            username: Map.get(self, :username),
            kind: Map.get(self, :kind)
          }),
          guild_id
        )
    end
  end

  defp self_user_id(%{id: id}) when is_integer(id), do: id
  defp self_user_id(%{id: id}) when is_binary(id), do: String.to_integer(id)
  defp self_user_id(_), do: nil

  # Discord identifies @everyone by `id == guild.id`, and `name` is the only
  # other field a Role requires — permissions/position/hoist/managed/
  # mentionable all default client-side.
  defp everyone_role(guild_id), do: %{"id" => guild_id, "name" => "@everyone"}

  @doc """
  Discord thread channel object (type 11 PUBLIC_THREAD) for a native thread
  row — the GUILD_CREATE `threads` inventory (compat handshake, C-1): Discord
  libraries build their thread cache from it at connect. Authorization is the
  CALLER's (the handshake resolves only threads whose parent channel is in
  the session's visible set); `joined` is always false (thread follow state
  is not part of the compat session surface).

  THE thread object. Every surface renders through here — hardening plan 3.6
  counted four "thread_object builders", and they are four INPUT ADAPTERS over
  this one function, not four copies of it:

    * `GatewayDialect.thread_object/2` (a fan-out payload plus its anchor) and
      `/1` (a payload alone, adding Discord's `newly_created` event metadata) —
      the dialect renderer, which afterwards overlays the fields the EVENT states
      onto the row (`report_event_change/2`), because a dispatch is the
      authoritative report of its own change;
    * `Compat.ChannelsController.thread_object/2` (a gated load by thread id);
    * `Compat.ThreadsController.thread_object/2` (a thread row and its channel).

  No field mapping is duplicated between them: the adapters differ in how they
  OBTAIN the row and in the guild id they pass. Adding a second builder is
  therefore a regression, not a consolidation.
  """
  @spec thread_channel(map(), String.t()) :: map()
  def thread_channel(t, guild_id) do
    %{
      "id" => id_str(t.thread_id),
      "guild_id" => guild_id,
      "parent_id" => id_str(t.channel_id),
      "name" => t.name,
      "type" => 11,
      # Discord's thread object carries these four at the TOP level, and
      # discord.py's `Thread._from_data` indexes owner_id / message_count /
      # member_count UNGUARDED (#64): omitting them raises inside the state
      # parser and kills the client the same way a missing channel `position`
      # does. All three are real Cytale data (`Map.get` keeps the shape
      # total for partial maps — this codec's inputs are plain maps).
      "owner_id" => id_str(Map.get(t, :created_by)) || "0",
      "message_count" => int_or_zero(Map.get(t, :message_count)),
      "member_count" => int_or_zero(Map.get(t, :member_count)),
      "thread_metadata" => thread_metadata(t)
    }
  end

  # `Thread._unroll_metadata` reads `archived`, `auto_archive_duration` and
  # `archive_timestamp` unguarded (#64). `locked`/`invitable`/`create_timestamp`
  # are `.get()`-read, so they are optional — sent anyway, and `create_timestamp`
  # replaces the old `thread_created_at` key (which was not a Discord field at
  # all: a documented shape that no client could read).
  defp thread_metadata(t) do
    %{
      "archived" => !!Map.get(t, :archived),
      # DIVERGENCE (ledger): Cytale has no archive SCHEDULE — archiving exists
      # (#109, PATCH /channels/{thread_id}) but nothing expires a thread on a
      # timer — so this is Discord's default 24h, sent because the key is
      # REQUIRED by the parser. It is a shape value, not a policy.
      "auto_archive_duration" => @thread_auto_archive_duration,
      "archive_timestamp" => thread_archive_timestamp(t),
      "locked" => false,
      "invitable" => true,
      "create_timestamp" => iso(Map.get(t, :created_at))
    }
  end

  # DIVERGENCE (ledger): Discord's archive_timestamp is "when this thread
  # archives / archived"; Cytale has no archive schedule, so the closest true
  # fact is the last activity (falling back to creation). Clients only use it for
  # display and archive maths.
  defp thread_archive_timestamp(t) do
    iso(Map.get(t, :latest_reply_at)) || iso(Map.get(t, :created_at)) || iso(DateTime.utc_now())
  end

  defp iso(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
  defp iso(_), do: nil

  @doc """
  The unavailable guild stub Discord READY carries (one per guild; the real
  object follows immediately as GUILD_CREATE).
  """
  @spec guild_stub(map() | integer()) :: map()
  @doc """
  Discord PARTIAL guild object (GET /users/@me/guilds, GET /guilds/{id}) —
  the safe minimum discord.py's Guild._from_data needs (read off the client,
  2.7.1): only `id` is unguarded; everything here is a plain .get. Nested
  collections (channels/members/roles/voice_states) are deliberately ABSENT —
  each carries unguarded shape commitments (Member needs roles; Role needs id;
  #73's exact trap), and "don't send it" is a legitimate answer.
  """
  def partial_guild(%{workspace_id: ws_id, name: name, owner_id: owner_id}) do
    %{
      "id" => Integer.to_string(ws_id),
      "name" => name,
      "icon" => nil,
      "owner_id" => Integer.to_string(owner_id),
      "features" => [],
      "unavailable" => false
    }
  end

  @doc """
  The application capability flags we advertise (#112): `1 << 18`
  (GATEWAY_MESSAGE_CONTENT = 262144) — ENTITLED to the Message Content
  privileged intent, which is Cytale's position: the workspace membership +
  grant is the real privacy boundary, and REST already delivers `content` to
  the same principal. `1 << 19` (..._LIMITED) is deliberately UNSET — Discord
  uses it for "applied but not approved", and Cytale has no approval class.
  The bit stays truthful even if intent enforcement is ever implemented: it
  means entitled, not unconditionally delivered.
  """
  def application_flags, do: Bitwise.bsl(1, 18)

  def guild_stub(%{workspace_id: ws_id}), do: guild_stub(ws_id)
  def guild_stub(ws_id) when is_integer(ws_id), do: %{"id" => Integer.to_string(ws_id), "unavailable" => true}

  # ---------------------------------------------------------------------------
  # Gateway dispatch payloads (U7 compat sessions — native wire → Discord)
  # ---------------------------------------------------------------------------

  @doc """
  Discord message object from the NATIVE `MessageCreate`/`MessageUpdate` wire
  payload (the `message_json` projection, string-keyed) — the U7 compat
  session dispatch translation. `guild_id` is the owning workspace (resolved
  by the caller); replies re-read their original once for the depth-1
  `referenced_message` snapshot (the native payload's `referenced` digest
  carries too few fields for the Discord shape).

  `resolved` (PERF-2, default empty) is the caller's pre-resolved author
  cache — `author_id => {author_object, kind}`: a hit skips the point read
  entirely; a miss falls through to `resolve_author/1` with byte-identical
  output (the gateway socket passes its `Cytale.Gateway.AuthorCache`
  snapshot here; REST callers omit it).
  """
  @spec message_from_native(map(), String.t() | nil, %{optional(integer()) => {map(), atom()}}) ::
          map()
  def message_from_native(payload, guild_id, resolved \\ %{}) when is_map(payload) do
    author_id = int_field(payload, "author_id")

    # Nil author short-circuits straight to the tombstone (the object the
    # unknown-id path builds) — zero point reads.
    {author, kind} =
      if is_nil(author_id), do: tombstone_author(-1), else: cached_author(resolved, author_id)

    pseudo =
      %{
        id: int_field(payload, "id"),
        channel_id: int_field(payload, "channel_id"),
        author_id: author_id,
        content: payload["content"],
        thread_id: payload["thread_id"] && int_field(payload, "thread_id"),
        reply_to_id: payload["reply_to_id"] && int_field(payload, "reply_to_id"),
        created_at: parse_ts(payload["created_at"]),
        edited_at: payload["edited_at"] && parse_ts(payload["edited_at"]),
        attachments: payload["attachments"] || [],
        embeds: payload["embeds"],
        components: payload["components"],
        author_override: payload["author_override"]
      }

    referenced =
      case pseudo.reply_to_id do
        nil -> nil
        reply_to -> Messages.get_message(pseudo.channel_id, reply_to)
      end

    pseudo
    |> build_message(author, kind, referenced, resolved)
    |> maybe_guild_id(guild_id)
    |> maybe_reactions(payload["reactions"])
    |> maybe_nonce(payload["nonce"])
  end

  # Discord's MESSAGE_CREATE `nonce`: the send's client key, when the native
  # wire carries one (the create's own emission; never stored, so history and
  # later updates omit it).
  defp maybe_nonce(shape, nonce) when is_binary(nonce), do: Map.put(shape, "nonce", nonce)
  defp maybe_nonce(shape, _), do: shape

  # guild_id rides a message ONLY for workspace channels: Discord OMITS the
  # key on DM messages, and a null-valued key is not omission — discord.py's
  # _get_guild_channel does int(data['guild_id']) on the key's presence and
  # dies on nil, silently dropping every DM MESSAGE_CREATE (found by the
  # discord.py leg, 2026-09-23).
  defp maybe_guild_id(shape, nil), do: shape
  defp maybe_guild_id(shape, guild_id) when is_binary(guild_id), do: Map.put(shape, "guild_id", guild_id)

  @doc """
  Discord MESSAGE_CREATE object for a thread reply (native
  `ThreadMessageCreate` payload: the message rides the THREAD channel).
  `guild_id` is the owning workspace, resolved by the caller. `resolved`
  (PERF-2, default empty) is the caller's pre-resolved author cache — same
  contract as `message_from_native/3`.

  `attachments` renders the native wire's descriptors (#83 compat-surface
  remainder: the wire carries them — `Messages.Message.to_wire/1` — but this
  projection hardcoded `[]`, so a thread reply with a file reached Discord
  clients with no attachment object at all). `embeds` and `components` ride
  the same way — a thread card is the channel card, field for field.
  """
  @spec thread_message_from_native(map(), String.t() | nil, %{optional(integer()) => {map(), atom()}}) ::
          map()
  def thread_message_from_native(payload, guild_id, resolved \\ %{}) when is_map(payload) do
    {author, _kind} =
      case int_field(payload, "author_id") do
        nil -> tombstone_author(-1)
        author_id -> cached_author(resolved, author_id)
      end

    %{
      "id" => payload["id"],
      "channel_id" => payload["thread_id"],
      "guild_id" => guild_id,
      "author" => author,
      "content" => payload["content"],
      "timestamp" => payload["created_at"],
      "edited_timestamp" => payload["edited_at"],
      "tts" => false,
      "mention_everyone" => false,
      "mentions" => mentions(payload["content"], resolved),
      "mention_roles" => [],
      "attachments" => attachments(payload["attachments"]),
      # A bot's card in a thread (content + embeds + action rows) renders
      # here exactly as `build_message/5` renders it in a channel: the native
      # wire carries both keys when the message stored any
      # (`Messages.Message.to_wire/1`). This hardcoded `[]` once — and the
      # compat POST refused thread embeds/components to keep the 201 honest.
      "embeds" => embeds(payload["embeds"]),
      "pinned" => false,
      "type" => 0
    }
    |> maybe_components(payload["components"])
    |> maybe_thread_reference(payload)
    |> maybe_nonce(payload["nonce"])
  end

  # #155: a thread reply that references another message renders Discord's
  # type-19 (REPLY) shape — `message_reference` with the THREAD id as the
  # channel (the wire's channel for a thread message is its thread). Depth-1
  # snapshot (`referenced_message`) deliberately absent: the native wire
  # carries only the id, so consumers resolve the original on demand — the
  # same builder serves the REST response and the live ThreadMessageCreate
  # dispatch, so the two can never disagree.
  defp maybe_thread_reference(base, payload) do
    case payload["reply_to_id"] do
      id when is_binary(id) and id != "" ->
        base
        |> Map.put("type", 19)
        |> Map.put(
          "message_reference",
          %{"message_id" => id, "channel_id" => base["channel_id"]}
        )

      _ ->
        base
    end
  end

  @doc """
  Discord TYPING_START payload from the native TypingStart dispatch (accepts
  the atom-keyed gateway shape and the string-keyed REST shape alike).
  `timestamp` is Discord's UNIT — Unix epoch SECONDS (discord.js multiplies
  by 1000); the native event carries milliseconds, so the codec converts.

  A thread's typing carries the THREAD id as `channel_id` (#83 compat-surface
  remainder — Discord's wire puts the thread there and a client renders the
  indicator in the thread view; the native payload's `channel_id` stays the
  parent for the fan-out route). A plain channel typing is unchanged.
  """
  @spec typing_from_native(map(), String.t() | nil) :: map()
  def typing_from_native(payload, guild_id) when is_map(payload) do
    %{
      "channel_id" => field(payload, "thread_id") || field(payload, "channel_id"),
      "guild_id" => guild_id,
      "user_id" => field(payload, "user_id"),
      "timestamp" => field(payload, "timestamp") |> epoch_seconds()
    }
  end

  # Native ms → Discord seconds; non-integer values pass through untouched
  # (degenerate payloads degrade, never crash the push path).
  defp epoch_seconds(ms) when is_integer(ms), do: div(ms, 1000)
  defp epoch_seconds(other), do: other

  @doc """
  Discord INTERACTION_CREATE payload from the native InteractionCreate
  dispatch (bots plan U8, KTD13): `{id, application_id, type: 2,
  data: {id, name, options}, guild_id, channel_id, member: {user}, token,
  version: 1}`. The native options map flattens into Discord's name/value
  entry array; `member.user` carries the invoking human.

  The component-click branch (components plan U2, R4/KTD3 — the native
  payload's `kind: "component"` discriminator) renders the type-3 shape:
  `data: {custom_id, component_type, values?}`, the FULL embedded `message`
  (required for type 3 — discord.js constructs a Message from it; built via
  `message/2` from the row snapshot the mint embedded), `member` in
  workspaces vs `user` in DMs (no `guild_id` on DMs), the unconditional
  `entitlements: []` / `authorizing_integration_owners`
  (`%{"0" => ws}` / the user-install `%{"1" => clicker}` on DMs),
  `app_permissions` as a DECIMAL STRING, and `attachment_size_limit`. No
  optional `channel` object rides (the discord.js silent-drop hazard).
  """
  @spec interaction_from_native(map()) :: map()
  # The type-3 (MESSAGE_COMPONENT) branch.
  def interaction_from_native(%{"kind" => "component"} = payload) do
    data =
      %{
        "custom_id" => payload["custom_id"],
        "component_type" => payload["component_type"]
      }
      |> maybe_component_values(payload["values"])

    payload
    |> human_interaction_base(3, data)
    |> Map.put("message", embedded_message(payload["message"]))
  end

  # MODAL_SUBMIT (#30): Discord's type 5. `data` is the modal's custom_id and
  # its action rows of text inputs, each `{type: 4, custom_id, value}` — the
  # shape discord.js's ModalSubmitFields reads. A submit from a component
  # click carries that message, as Discord's does.
  def interaction_from_native(%{"kind" => "modal_submit"} = payload) do
    base =
      human_interaction_base(payload, 5, %{
        "custom_id" => payload["custom_id"],
        "components" => payload["components"] || []
      })

    case payload["message"] do
      nil -> base
      message -> Map.put(base, "message", embedded_message(message))
    end
  end

  # The part of an interaction a HUMAN triggered (types 3 and 5) that is the
  # same for both: identity, the discord.js/discord.py unconditional pins, and
  # the guild-member vs DM-user split.
  defp human_interaction_base(payload, type, data) do
    user = payload["user"] || %{}

    invoker =
      user_object(%{
        user_id: int_field(user, "id") || -1,
        username: user["username"] || "unknown-user",
        kind: :human
      })

    base = %{
      "id" => payload["id"],
      "application_id" => payload["application_id"],
      "type" => type,
      "data" => data,
      # Threads are channels (C-2): a click on a card inside a thread
      # carries the THREAD id, as Discord's does — the id the bot posted the
      # card to, and the one `interaction.channel` must resolve to for the
      # bot's own `channel.send` to land back in the thread. The native
      # payload keeps the parent (storage + fan-out) plus `thread_id`.
      "channel_id" => payload["thread_id"] || payload["channel_id"],
      "token" => payload["token"],
      "version" => 1,
      # discord.js 14.27 unconditional pins (the entitlements lesson, twice
      # over): entitlements.reduce and AuthorizingIntegrationOwners indexing
      # run on EVERY interaction incl. types 3 and 5.
      "entitlements" => [],
      # Discord's bit layout, not Cytale's (#173): a Discord library decodes
      # this field with its own flag positions.
      "app_permissions" =>
        payload
        |> int_field("app_permissions")
        |> Kernel.||(0)
        |> CytaleWeb.Compat.Permissions.to_discord()
        |> Integer.to_string(),
      "attachment_size_limit" => 26_214_400
    }

    case payload["workspace_id"] do
      nil ->
        # DM shape (KTD3): `user` (no member), NO guild_id, the user-install
        # AIO key carrying the invoker.
        base
        |> Map.put("user", invoker)
        |> Map.put("authorizing_integration_owners", %{"1" => invoker["id"]})

      workspace_id ->
        base
        |> Map.put("guild_id", workspace_id)
        # The FULL member, never the thin %{"user" => …} this once shipped:
        # discord.py 2.7's Member.__init__ reads data['roles'] and data['flags']
        # UNGUARDED, so a member without them KeyErrors inside the interaction
        # constructor and KILLS the bot's process — Hermes died on every
        # provider-select click for exactly this reason (2026-09-23). The same
        # #73 lesson the type-2 branch and the reaction path already learned.
        |> Map.put("member", member(invoker, workspace_id))
        |> Map.put("authorizing_integration_owners", %{"0" => workspace_id})
    end
  end

  # The type-2 (APPLICATION_COMMAND) branch.
  def interaction_from_native(payload) when is_map(payload) do
    command = payload["command"] || %{}
    user = payload["user"] || %{}

    %{
      "id" => payload["id"],
      "application_id" => payload["application_id"],
      "type" => 2,
      "data" => %{
        "id" => command["id"],
        "name" => command["name"],
        "type" => 1,
        "options" => interaction_options(payload["options"])
      },
      "guild_id" => payload["workspace_id"],
      "channel_id" => payload["channel_id"],
      # The invoking member, in the ONE member shape (#73): a client builds a
      # Member from this and indexes `roles` unguarded, so the thin
      # `%{"user" => …}` this used to emit killed the client exactly like the
      # reaction's did.
      "member" =>
        member(
          user_object(%{
            user_id: int_field(user, "id") || -1,
            username: user["username"] || "unknown-user",
            kind: :human
          }),
          payload["workspace_id"]
        ),
      "token" => payload["token"],
      "version" => 1,
      # discord.js 14.27 requires both arrays/objects unconditionally:
      # entitlements.reduce(...) and AuthorizingIntegrationOwners reads
      # data[value] — Discord's wire always carries them; omitting either
      # throws inside the library's constructor (guild-install form: type 0).
      "entitlements" => [],
      "authorizing_integration_owners" => %{"0" => payload["workspace_id"]},
      # discord.py 2.7.1 bare-reads this on EVERY interaction (its
      # Interaction constructor sets filesize_limit unconditionally); the
      # type-3 branch already carried it and this branch did not — a
      # chat-input invocation crashed the library (found by the discord.py
      # leg, 2026-09-23).
      "attachment_size_limit" => 26_214_400
    }
  end

  # values ride data only for string-select clicks (non-empty).
  defp maybe_component_values(data, values) when is_list(values) and values != [],
    do: Map.put(data, "values", values)

  defp maybe_component_values(data, _), do: data

  # d.message for type 3: the FULL Discord message object via message/2 —
  # the row snapshot the mint embedded (id/channel_id/components from the
  # stored row; the author resolves as the bot user object). A degenerate
  # payload without a row renders the tombstone shape — the push path
  # degrades, never crashes.
  defp embedded_message(row) when is_map(row), do: scoped_message(row)

  defp embedded_message(_),
    do:
      message(%{
        id: nil,
        channel_id: nil,
        author_id: -1,
        content: nil,
        created_at: nil,
        edited_at: nil,
        attachments: [],
        reply_to_id: nil
      })

  # Discord's data.options: an array of {name, value} entries; the native
  # invocation payload carries a flat map.
  defp interaction_options(options) when is_map(options),
    do: Enum.map(options, fn {name, value} -> %{"name" => to_string(name), "value" => value} end)

  defp interaction_options(options) when is_list(options), do: options
  defp interaction_options(_), do: []

  # String-or-atom keyed payload field access (gateway fan-out payloads mix
  # both shapes today: atom-keyed from the socket, string-keyed from REST).
  defp field(payload, key) when is_binary(key) do
    Map.get(payload, key) || Map.get(payload, String.to_atom(key))
  end

  defp int_field(payload, key) do
    case field(payload, key) do
      int when is_integer(int) ->
        int

      bin when is_binary(bin) ->
        case Integer.parse(bin) do
          {int, ""} -> int
          _ -> nil
        end

      _ ->
        nil
    end
  end

  defp parse_ts(iso) when is_binary(iso) do
    case DateTime.from_iso8601(iso) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_ts(_), do: nil

  # ---------------------------------------------------------------------------
  # Reactions
  # ---------------------------------------------------------------------------

  @doc """
  Discord `reactions` array entries from the native message-JSON reactions
  (`[{"emoji", "count", "me"}]`): `{count, me, emoji: {id: null, name}}` —
  `id` is ALWAYS null (Cytale has no custom-emoji system; the emoji is the
  raw Unicode text as `name`). Consumed by the gateway translation (the
  fan-out projection rides the native payload — zero extra reads) and by
  `put_reactions/4` (the REST paths, viewer-aware).
  """
  @spec reactions_from_native(term()) :: [map()]
  def reactions_from_native(list) when is_list(list) and list != [] do
    Enum.map(list, fn entry ->
      %{
        "count" => entry["count"],
        "me" => !!entry["me"],
        "emoji" => %{"id" => nil, "name" => entry["emoji"]}
      }
    end)
  end

  def reactions_from_native(_), do: []

  @doc """
  Put the Discord `reactions` array onto a BUILT message object, computed
  from the reaction tables for the native row (the REST paths — the `me`
  flag against the CALLING principal). The key stays ABSENT when the
  message has no reactions (Discord's shape: no `reactions` key, never `[]`).
  """
  @spec put_reactions(map(), integer(), integer(), integer() | nil) :: map()
  def put_reactions(object, channel_id, message_id, viewer_id) do
    case Messages.Reactions.render(channel_id, message_id, viewer_id) do
      nil -> object
      entries -> Map.put(object, "reactions", reactions_from_native(entries))
    end
  end

  @doc """
  `put_reactions/4` for a PAGE: one batched reaction read for every message in
  `[{object, row}]` (hardening plan 2.1 — the compat twin of the native page's
  batching).

  The rows must share ONE channel, which is every page-shaped call site (a
  channel's history, a thread's history). A caller holding a mix of channels — the
  compat SEARCH page — groups by channel first and calls this once per group,
  which bounds the reads by the number of channels rather than the number of hits.
  """
  @spec put_reactions_many([{map(), map()}], integer() | nil) :: [map()]
  def put_reactions_many([], _viewer_id), do: []

  def put_reactions_many([{_object, row} | _] = pairs, viewer_id) do
    channel_id = row.channel_id

    rendered =
      Messages.Reactions.render_many(
        channel_id,
        Enum.map(pairs, fn {_object, row} -> Map.take(row, [:id, :bucket]) end),
        viewer_id
      )

    Enum.map(pairs, fn {object, row} ->
      case Map.get(rendered, row.id) do
        nil -> object
        entries -> Map.put(object, "reactions", reactions_from_native(entries))
      end
    end)
  end

  # The fan-out projection's reactions (native `me: false` entries — no
  # single recipient) translate shape-only; absent/empty stays absent.
  defp maybe_reactions(msg, reactions) when is_list(reactions) and reactions != [],
    do: Map.put(msg, "reactions", reactions_from_native(reactions))

  defp maybe_reactions(msg, _), do: msg

  # ---------------------------------------------------------------------------
  # Attachments
  # ---------------------------------------------------------------------------

  @doc """
  Native attachment descriptors (string-valued maps, as persisted) → Discord
  attachment objects. A missing `id` synthesizes the slot index (Discord's
  unstored-attachment shape); `size` (and, when the upload sniffed them,
  `width`/`height` — C-3) coerce to integers.
  """
  @spec attachments(term()) :: [map()]
  def attachments(list) when is_list(list), do: Enum.with_index(list) |> Enum.map(fn {att, i} -> attachment(att, i) end)
  def attachments(_), do: []

  @doc "One native descriptor → one Discord attachment object."
  @spec attachment(map(), non_neg_integer()) :: map()
  def attachment(att, index \\ 0) when is_map(att) do
    # Signed per render (Tier 2 #4) — the same URL for both keys.
    url = Cytale.Attachments.SignedUrl.sign(att["url"])

    %{
      "id" => att["id"] || Integer.to_string(index),
      "filename" => att["filename"],
      "content_type" => att["content_type"],
      "size" => parse_size(att["size"]),
      "url" => url,
      # `proxy_url` is REQUIRED (#64-class, found by the same audit):
      # discord.py's `Attachment.__init__` indexes `data['proxy_url']`
      # unguarded, so EVERY message carrying a file killed the client —
      # terminal, and invisible until someone posts an image. Discord's value
      # is its CDN-proxied copy of the same asset; we serve attachments
      # directly from one origin, so the honest value is the same URL.
      "proxy_url" => url
    }
    |> maybe_dimension("width", att)
    |> maybe_dimension("height", att)
  end

  # C-3: image dims ride the descriptor as INTEGERS when the upload sniffed
  # them; absent for everything else — the key is omitted, never null.
  defp maybe_dimension(object, key, att) do
    case att[key] do
      nil -> object
      value -> Map.put(object, key, parse_size(value))
    end
  end

  defp parse_size(size) when is_integer(size), do: size

  defp parse_size(size) when is_binary(size) do
    case Integer.parse(size) do
      {n, ""} -> n
      _ -> 0
    end
  end

  defp parse_size(_), do: 0

  # ---------------------------------------------------------------------------
  # Embeds
  # ---------------------------------------------------------------------------

  @doc """
  Stored embed objects (already-decoded JSON maps, as persisted) → the
  Discord embed array. Store-and-forward (KTD11): rows ride verbatim — the
  web renders title/description/fields and treats unknown keys as inert —
  except that each external media slot gains Discord's proxy key
  (`image.proxy_url`, `thumbnail.proxy_url`, `author.proxy_icon_url`,
  `footer.proxy_icon_url`), minted per render by `Cytale.MediaProxy`, and a
  producer-sent proxy key is dropped. Non-list input (nil, a row built without embeds) renders `[]` per the
  codec contract.
  """
  @spec embeds(term()) :: [map()]
  def embeds(list) when is_list(list), do: Cytale.MediaProxy.wire_embeds(list)
  def embeds(_), do: []
end
