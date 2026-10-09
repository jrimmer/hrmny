defmodule CytaleWeb.Compat.GatewayDialect do
  @moduledoc """
  The Discord compat dialect of the gateway (U7/KTD5), extracted beside
  `CytaleWeb.Compat.MessageCodec` so `CytaleWeb.GatewaySocket` stays
  lifecycle + wire I/O. Everything that is compat-dialect-shaped lives here:

    * the Discord intent bitmask table + validation — unknown bits close
      4013 (terminal, non-reconnectable), known-but-unsupported bits connect
      and deliver nothing (allow-silent), absent intents = 0
      (lifecycle-only session);
    * the credential-keyed mode helpers — `session_mode/1` (the VERIFIED
      identity decides the dialect, never the client), the Identify version
      gate (`v` = 10 or the interop `v` = 1 for compat, exactly 1 for
      native), `parse_intents/2`;
    * the intents ⊗ visible-set dispatch filter + native → Discord
      translation of live dispatches (`filter_dispatch/6`) — the socket's
      push handler runs this BEFORE buffering, so a filtered event never
      consumes a seq and resume replay stays filtered-consistent;
    * the per-socket visibility memo (parent∩restrictions, epoch-checked)
      with its refresh rule (`refresh_visibility/3`), and the resume-replay
      re-filter whose unknown-envelope default is FAIL-CLOSED
      (drop + `[:cytale, :gateway, :replay_dropped]` telemetry);
    * the compat handshake (`handshake/3`): the Discord READY plus one
      synthesized GUILD_CREATE per in-profile workspace.

  Every function runs INSIDE the owning socket process and takes the state
  slices it needs explicitly — the visible-set memo, the per-socket author
  cache, the verified identity, the intents — never the socket state
  wholesale. Wire pushes, seq-stamping/buffering, heartbeat, teardown and
  the push-handler filter hook itself remain in the socket, which folds the
  returned slices back into its state.
  """

  require Bitwise

  alias Cytale.Gateway.{AuthorCache, Opcode, PresenceStatus, ProtocolError, PushRegistry, Session}
  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.Cache
  alias Cytale.Permissions.Principal, as: PrincipalRights
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Accounts.Principals
  alias Cytale.Threads
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{GatewayUrl, MessageCodec}

  # Close codes carried by the dialect's own validation raises (the shared
  # Discord-shaped table lives on the socket; these mirror the codes it uses
  # for the same violations).
  @close_decode_error 4001
  @close_invalid_version 4012
  @close_invalid_intents 4013

  # The Discord gateway version `/gateway/bot` advertises (compat sessions).
  @compat_version 10

  # Safety-net lifetime of a shared visible-set memo entry (review #19); the
  # rights epoch is the invalidation, this only bounds a missed bump.
  @visible_cache_ttl_ms 30_000

  # The native wire version — MUST stay in sync with `GatewaySocket`'s
  # `@accepted_version` (the compat Identify gate admits interop v=1).
  @accepted_version 1

  # Discord's intent bitmask. SUPPORTED (delivered): GUILDS, GUILD_MEMBERS,
  # GUILD_PRESENCES, GUILD_MESSAGES, GUILD_MESSAGE_REACTIONS,
  # GUILD_MESSAGE_TYPING, DIRECT_MESSAGES, DIRECT_MESSAGE_REACTIONS,
  # DIRECT_MESSAGE_TYPING. KNOWN but unsupported: connect and deliver nothing
  # (allow-silent). UNKNOWN bits (anything outside the mask, e.g. 1<<26):
  # close 4013 — terminal, non-reconnectable (Discord semantics).
  @intent_guilds Bitwise.bsl(1, 0)
  @intent_guild_members Bitwise.bsl(1, 1)
  @intent_guild_presences Bitwise.bsl(1, 8)
  @intent_guild_messages Bitwise.bsl(1, 9)
  @intent_guild_message_reactions Bitwise.bsl(1, 10)
  @intent_guild_message_typing Bitwise.bsl(1, 11)
  @intent_direct_messages Bitwise.bsl(1, 12)
  @intent_direct_message_reactions Bitwise.bsl(1, 13)
  @intent_direct_message_typing Bitwise.bsl(1, 14)

  @known_intents Enum.sum([
                   Bitwise.bsl(1, 0),
                   Bitwise.bsl(1, 1),
                   Bitwise.bsl(1, 2),
                   Bitwise.bsl(1, 3),
                   Bitwise.bsl(1, 4),
                   Bitwise.bsl(1, 5),
                   Bitwise.bsl(1, 6),
                   Bitwise.bsl(1, 7),
                   Bitwise.bsl(1, 8),
                   Bitwise.bsl(1, 9),
                   Bitwise.bsl(1, 10),
                   Bitwise.bsl(1, 11),
                   Bitwise.bsl(1, 12),
                   Bitwise.bsl(1, 13),
                   Bitwise.bsl(1, 14),
                   Bitwise.bsl(1, 15),
                   Bitwise.bsl(1, 16),
                   Bitwise.bsl(1, 20),
                   Bitwise.bsl(1, 21),
                   Bitwise.bsl(1, 24),
                   Bitwise.bsl(1, 25)
                 ])

  @typedoc "Gateway identity as verified at Identify/Resume (string snowflakes)."
  @type identity :: map()

  @typedoc """
  Per-socket visibility memo: workspace_id => {epoch, MapSet(visible
  channel ids)} under parent∩restrictions.
  """
  @type visible :: %{optional(integer()) => {integer(), MapSet.t(integer())}}

  @doc "The intent bits whose events this gateway actually delivers."
  @spec supported_intents() :: non_neg_integer()
  def supported_intents,
    do:
      @intent_guilds
      |> Bitwise.bor(@intent_guild_members)
      |> Bitwise.bor(@intent_guild_presences)
      |> Bitwise.bor(@intent_guild_messages)
      |> Bitwise.bor(@intent_guild_message_reactions)
      |> Bitwise.bor(@intent_guild_message_typing)
      |> Bitwise.bor(@intent_direct_messages)
      |> Bitwise.bor(@intent_direct_message_reactions)
      |> Bitwise.bor(@intent_direct_message_typing)

  # -- Mode helpers (the VERIFIED credential decides the dialect, KTD5) ------

  # KTD5: `cytbot_` machine credentials speak the compat dialect; everything
  # else is native and byte-identical to the pre-U7 gateway.
  @doc false
  @spec session_mode(map()) :: :native | :compat
  def session_mode(%{kind: kind}) when kind in [:bot, :agent], do: :compat
  def session_mode(_identity), do: :native

  @doc false
  @spec check_identify_version!(:native | :compat, term()) :: :ok
  def check_identify_version!(:native, version) do
    unless is_integer(version) do
      raise ProtocolError.new(@close_decode_error, "identify.v missing or non-integer")
    end

    if version != @accepted_version do
      raise ProtocolError.new(
              @close_invalid_version,
              "unsupported gateway version #{inspect(version)}",
              [Session.invalid_session_frame(false)]
            )
    end
  end

  def check_identify_version!(:compat, nil), do: :ok

  def check_identify_version!(:compat, version) when is_integer(version) do
    # v=10 is what /gateway/bot advertises; v=1 rides the interop window
    # (a client library configured with the native version still connects).
    unless version in [@compat_version, @accepted_version] do
      raise ProtocolError.new(
              @close_invalid_version,
              "unsupported gateway version #{inspect(version)}",
              [Session.invalid_session_frame(false)]
            )
    end
  end

  def check_identify_version!(:compat, _non_integer),
    do: raise(ProtocolError.new(@close_decode_error, "identify.v non-integer"))

  # Intents (compat only; native Identifies ignore the field entirely):
  # absent = 0 (lifecycle-only session). Unknown bits close 4013 below in
  # validate_intents!/1; known-but-unsupported bits connect and deliver
  # nothing for them (allow-silent — a refused handshake reads as outage to
  # a client library, KTD5).
  @doc false
  @spec parse_intents!(:native | :compat, term()) :: non_neg_integer()
  def parse_intents!(:native, _), do: 0

  def parse_intents!(:compat, nil), do: 0

  def parse_intents!(:compat, intents) when is_integer(intents) and intents >= 0 do
    validate_intents!(intents)
    intents
  end

  def parse_intents!(:compat, non_int) when is_integer(non_int),
    do: raise(ProtocolError.new(@close_invalid_intents, "invalid intents #{inspect(non_int)}"))

  def parse_intents!(:compat, _),
    do: raise(ProtocolError.new(@close_decode_error, "identify.intents non-integer"))

  defp validate_intents!(intents) do
    unknown = Bitwise.band(intents, Bitwise.bnot(@known_intents))

    if unknown != 0 do
      raise ProtocolError.new(@close_invalid_intents, "unknown intent bits #{inspect(unknown)}")
    end
  end

  # -- Shared gateway URL (the compat READY's resume_gateway_url source) -----

  # The resume_gateway_url handed to compat READYs comes from the SHARED
  # compat gateway URL builder (`CytaleWeb.Compat.GatewayUrl` — the same one
  # `/gateway/bot` serves), so the websocket scheme mapping (http→ws,
  # https→wss) and the ?v/&encoding suffix can never drift between the two
  # surfaces. The socket calls this at upgrade; rebuilt from the upgrade
  # request.
  @doc false
  @spec gateway_base_url(Plug.Conn.t()) :: String.t()
  def gateway_base_url(conn),
    do: GatewayUrl.websocket_url(conn)

  # -- U7 visibility: parent∩restrictions visible-set memo (KTD4/KTD5) --------
  #
  # The memo maps workspace_id → {epoch, MapSet(visible channel ids)}; it is
  # held in socket state and passed in / returned explicitly here. Refresh
  # rule: compare each key's epoch against `RightsEpoch.current/1` (a
  # lock-free ETS read) and recompute ONLY moved epochs; `rejoin:` (member-
  # add / epoch move) additionally re-lists the workspace set and re-runs
  # the route join when it CHANGED — new workspace keys get subscribed, dead
  # ones dropped, no reconnect.

  @doc """
  Refresh the visible-set memo against current rights epochs. `visible` is
  the memo as held in socket state (`nil` before the handshake seeds it);
  `identity` the VERIFIED gateway identity.

  Options:

    * `:rejoin` — force a full re-list even when no epoch moved (the
      member-add poke);
    * `:notify` — when the workspace SET changed, `send(self(),
      :cytale_rejoin_routes)` so the socket rebuilds its fan-out routes in
      place (handshake seeding passes `false` — go_connected JUST built the
      routes for this set); runs inside the socket process, so `self()` is
      the owning socket;
    * `:preloaded` — handshake preloads, plumbed for the seeding call shape.

  Steady state costs only lock-free epoch ETS reads; a moved epoch (or an
  explicit rejoin poke) triggers a FULL re-list — recomputing every set AND
  diffing the workspace keys, so joins subscribe new keys and kicks/deletes
  drop dead ones. Kicked-out workspaces vanish from the memo entirely:
  their channels then fail every membership test (fail closed).
  """
  @spec refresh_visibility(visible() | nil, identity(), keyword()) :: visible()
  def refresh_visibility(visible, identity, opts \\ [])

  def refresh_visibility(nil, identity, opts),
    do:
      full_visibility_refresh(nil, identity,
        notify: Keyword.get(opts, :notify, true),
        preloaded: Keyword.get(opts, :preloaded)
      )

  def refresh_visibility(visible, identity, opts) do
    if Keyword.get(opts, :rejoin, false) do
      full_visibility_refresh(visible, identity, preloaded: Keyword.get(opts, :preloaded), fresh: true)
    else
      case moved_workspaces(visible) do
        [] -> visible
        moved -> partial_visibility_refresh(visible, identity, moved, opts)
      end
    end
  end

  defp moved_workspaces(visible) do
    for {ws_id, {epoch, _set}} <- visible, RightsEpoch.current(ws_id) != epoch, do: ws_id
  end

  # Review #19: a moved epoch recomputes ONLY the workspaces whose epoch moved.
  # The full refresh re-listed the member's workspaces and recomputed EVERY
  # workspace's set (a channel list + a batch resolve each), inline on the
  # socket, before the event that noticed the move could be delivered — so
  # one role edit in one workspace cost every connected member a recompute of
  # all their workspaces. The workspace SET cannot change without the member
  # being poked (`:cytale_refresh_routes`, which forces the full path), with
  # one exception this handles: a kick or a workspace deletion moves the
  # epoch of the workspace that was LEFT. That shows up here as a resolve that
  # no longer admits the member, and anything but a clean answer falls back to
  # the full refresh, which re-lists the set and re-joins the routes.
  defp partial_visibility_refresh(visible, identity, moved, _opts) do
    identity = current_identity(identity)

    Enum.reduce_while(moved, visible, fn ws_id, acc ->
      epoch = RightsEpoch.current(ws_id)

      case member_visible_set(ws_id, identity, epoch, false) do
        {:ok, set} ->
          {:cont, Map.put(acc, ws_id, {epoch, set})}

        :error ->
          {:halt, full_visibility_refresh(visible, identity, preloaded: nil, fresh: true)}
      end
    end)
  end

  defp full_visibility_refresh(old_visible, identity, opts) do
    # The handshake/resume preload (one membership + channel fetch) feeds the
    # memo too — that is its documented purpose, and without threading it here
    # every Identify re-listed every workspace's channels on top of the fetch
    # it had just done. Only the CALLERS whose preload is fresh for this
    # computation pass one (handshake, resume replay); a lazy epoch recompute
    # passes none and re-lists, since its preload would be stale.
    preloaded = Keyword.get(opts, :preloaded)

    # KTD4: a full refresh happens because something moved the rights epoch (a
    # grant write, a member add, a role change) or because we are seeding —
    # both are moments when a machine principal's document may have changed
    # under a live session. The memo is the dispatch filter's enforcement
    # input, so it must recompute against the CURRENT document, never the
    # snapshot the session identified with; otherwise a grant change would only
    # take effect at the next Identify. One row read here (machine kinds only),
    # and steady state — no epoch move — stays a lock-free ETS compare.
    identity = current_identity(identity)

    # `fresh:` (a forced rejoin, or the fallback from a partial refresh) skips
    # the shared cache's READ — the caller has a reason to distrust what the
    # epoch says — but still stores what it computed for the next socket.
    fresh? = Keyword.get(opts, :fresh, false)

    visible =
      Map.new(preloaded_workspace_ids(preloaded) || workspace_ids_of(identity.id), fn ws_id ->
        epoch = RightsEpoch.current(ws_id)
        channels = preloaded_channels(preloaded, ws_id)

        {ws_id, {epoch, cached_visible_set(ws_id, identity, epoch, channels, fresh?)}}
      end)

    set_changed = Map.keys(visible) != Map.keys(old_visible || %{})

    # The workspace SET changed (join/kick/delete): re-run the subscription
    # computation so future events for the delta actually ARRIVE (or stop
    # arriving) at this socket. The dispatch filter remains the enforcement
    # point; routes are delivery plumbing. (Handshake seeding passes
    # notify: false — go_connected JUST built the routes for this set.)
    if set_changed and Keyword.get(opts, :notify, true),
      do: send(self(), :cytale_rejoin_routes)

    visible
  end

  defp visible_channel?(visible, channel_id) when is_integer(channel_id),
    do: visible_anchor(visible, channel_id) != nil

  defp visible_channel?(_visible, _non_integer), do: false

  # The handshake preload's channel rows for one workspace (nil when no
  # preload was handed in — `compute_visible_set/3` then lists them itself).
  defp preloaded_channels(%{channels_by_ws: by_ws}, ws_id) when is_map(by_ws),
    do: Map.get(by_ws, ws_id)

  defp preloaded_channels(_preloaded, _ws_id), do: nil

  # The handshake preload's workspace ids (lane D #5): the seeding refresh used
  # to re-read the membership the preload had just read — the same
  # `workspaces_of_user` query, on the Identify critical path. Only a FRESH
  # preload is handed in (see `full_visibility_refresh/3`), so reusing it here
  # is as current as the re-read was; nil (no preload) re-reads.
  defp preloaded_workspace_ids(%{workspaces: workspaces}) when is_list(workspaces),
    do: Enum.map(workspaces, & &1.workspace_id)

  defp preloaded_workspace_ids(_preloaded), do: nil

  # The membership test that also reports WHICH workspace's visible set
  # admitted the anchor: {anchor_channel_id, owning_workspace_id}. The
  # translate path consumes both (the owning workspace IS the guild_id,
  # KTD7), so the channel row is never re-read just to learn it.
  defp visible_anchor(visible, channel_id) when is_integer(channel_id) do
    Enum.find_value(visible, fn {ws_id, {_epoch, set}} ->
      MapSet.member?(set, channel_id) && {channel_id, ws_id}
    end)
  end

  defp visible_anchor(_visible, _non_integer), do: nil

  # Workspace membership as the compat wire spells it: the guild id (decimal
  # string) against the visible set's workspace keys.
  defp guild_member?(visible, guild_id) do
    Enum.any?(visible, fn {ws_id, _} -> Integer.to_string(ws_id) == guild_id end)
  end

  # The channel a dispatch is ABOUT — its parent channel for thread events
  # (thread visibility rides the parent's rights). Fail closed: no anchor,
  # no delivery.
  #
  # PERF-3 (B3a): ThreadMessageCreate's payload carries the PARENT
  # channel_id (the native wire projection from Message.to_wire) — take it
  # directly; only a degenerate payload without it falls back to the
  # thread-row read (one DB hop per session per event otherwise).
  defp dispatch_channel_anchor("ThreadMessageCreate", payload),
    do: int_id(payload["channel_id"]) || thread_parent(payload["thread_id"])

  # `int_id/1`: the anchor is compared against the memo's INTEGER channel ids;
  # the wire payload carries the string snowflake.
  defp dispatch_channel_anchor("ThreadUpdate", payload),
    do: int_id(payload["channel_id"]) || thread_parent(payload["id"])

  # UserUpdate is native-only (avatar render pass): profile events carry
  # no channel anchor and stay off the compat wire — Discord's USER_UPDATE
  # is CDN-hash shaped, which our URL-based payload cannot map (the codec
  # renders "avatar" => nil). The explicit nil also skips the generic
  # clause's wasted point read of the payload's USER id misread as a
  # channel id.
  defp dispatch_channel_anchor("UserUpdate", _payload), do: nil

  defp dispatch_channel_anchor(_event, payload),
    do: int_id(payload["channel_id"] || payload["id"] || payload[:channel_id] || payload[:id])

  # ISO-8601 wire string → DateTime (nil for anything unparseable), for the
  # payload-shaped rows the degraded paths build (#69).
  defp parse_iso(value) when is_binary(value) do
    case DateTime.from_iso8601(value) do
      {:ok, dt, _offset} -> dt
      _ -> nil
    end
  end

  defp parse_iso(_), do: nil

  defp int_id(int) when is_integer(int), do: int

  defp int_id(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {int, ""} -> int
      _ -> nil
    end
  end

  defp int_id(_), do: nil

  # String-or-atom keyed payload field access (the reaction fan-outs arrive
  # string-keyed from the REST seam; the atom fallback mirrors the codec's
  # leniency for degenerate shapes).
  defp field(payload, key) when is_binary(key),
    do: Map.get(payload, key) || Map.get(payload, String.to_atom(key))

  # KTD4's document re-read: a machine identity's `access` is a snapshot taken
  # at Identify, and the row is the truth. A row that is gone (the principal
  # was deleted under the session) keeps the snapshot — revocation is the
  # teardown path's job, and this function must never be the thing that widens
  # a reach.
  defp current_identity(%{kind: kind, id: id} = identity) do
    if PrincipalRights.machine_kind?(kind) do
      case int_id(id) do
        nil ->
          identity

        user_id ->
          case Principals.get(user_id) do
            %{access: access} -> Map.put(identity, :access, access)
            _ -> identity
          end
      end
    else
      identity
    end
  end

  defp current_identity(identity), do: identity

  # Per-workspace visible channels under parent∩restrictions: the SAME
  # resolver the REST gates use (KTD3 — one mapping, two enforcement
  # points), evaluated per channel with view_channel as the read bit. The
  # resolver's batch entry loads member+roles ONCE for the whole workspace
  # (the former per-channel resolve re-fetched them per channel);
  # `channels` accepts the handshake's preloaded rows.
  #
  # SHARED across sockets (review #19): a member's visible set in a workspace
  # is a function of the workspace's rights epoch — every membership, role,
  # overwrite and channel write bumps it at the data layer — so the answer is
  # memoized in the permission cache under that epoch and every socket of the
  # member (phone, desktop, a second tab) reuses one computation instead of
  # each paying a channel list plus a batch resolve. Humans only: a machine
  # principal's set also depends on its access document, which no epoch
  # versions. Only a CLEAN resolve is memoized.
  defp cached_visible_set(ws_id, identity, epoch, channels, fresh?) do
    case member_visible_set(ws_id, identity, epoch, fresh?, channels) do
      {:ok, set} -> set
      :error -> MapSet.new()
    end
  end

  defp member_visible_set(ws_id, identity, epoch, fresh?, channels \\ nil) do
    claims = principal_claims(identity)
    compute = fn -> compute_visible_set(ws_id, claims, channels) end
    cache = RightsEpoch.perm_cache()

    cond do
      cache == nil or not is_integer(claims.user_id) or PrincipalRights.machine_kind?(claims.kind) ->
        compute.()

      fresh? ->
        result = compute.()

        if match?({:ok, _}, result),
          do: :ok = Cache.put(cache, claims.user_id, {:visible, ws_id}, epoch, result, ttl_ms: @visible_cache_ttl_ms)

        result

      true ->
        Cache.get_or_compute(cache, claims.user_id, {:visible, ws_id}, epoch, compute,
          ttl_ms: @visible_cache_ttl_ms,
          store?: &match?({:ok, _}, &1)
        )
    end
  end

  # The resolver's verdict, not just the filtered ids: `{:ok, set}` for a clean
  # resolve, `:error` when the workspace no longer admits the principal (kick,
  # deletion) — which `visible_channel_ids/3` flattens into an empty set.
  defp compute_visible_set(ws_id, claims, preloaded_channels) do
    channels = preloaded_channels || Workspaces.list_channels(ws_id)
    channel_ids = Enum.map(channels, & &1.channel_id)

    case PrincipalRights.resolve_channels(ws_id, claims, channel_ids) do
      {:ok, by_channel} -> {:ok, viewable_ids(channel_ids, by_channel)}
      _ -> :error
    end
  end

  defp viewable_ids(channel_ids, by_channel) do
    channel_ids
    |> Enum.filter(fn channel_id ->
      case Map.get(by_channel, channel_id) do
        {:ok, bits} -> Bitfield.has?(bits, :view_channel)
        _ -> false
      end
    end)
    |> MapSet.new()
  end

  @doc """
  The principal's VIEWABLE channel ids in one workspace — the ONE visibility
  computation. The gateway's per-socket memo calls it (with the handshake's
  preloaded channel list, when it has one) and so does the REST thread surface
  (#74), so "which channels may this principal see?" has a single answer rather
  than one per transport.

  `claims` is the resolver's claims shape, which is what both `conn.assigns
  .current_user` and `principal_claims/1` produce.
  """
  @spec visible_channel_ids(integer(), map(), [map()] | nil) :: MapSet.t(integer())
  def visible_channel_ids(ws_id, claims, preloaded_channels \\ nil) do
    channels = preloaded_channels || Workspaces.list_channels(ws_id)
    channel_ids = Enum.map(channels, & &1.channel_id)

    case PrincipalRights.resolve_channels(ws_id, claims, channel_ids) do
      {:ok, by_channel} ->
        Enum.filter(channel_ids, fn channel_id ->
          case Map.get(by_channel, channel_id) do
            {:ok, bits} -> Bitfield.has?(bits, :view_channel)
            _ -> false
          end
        end)
        |> MapSet.new()

      _ ->
        MapSet.new()
    end
  end

  # Gateway identity (string ids) → resolver claims (int ids). Also the
  # claims shape behind the socket's per-request typing-gate consult.
  @doc false
  @spec principal_claims(identity()) :: %{
          user_id: integer() | nil,
          kind: atom() | nil,
          parent_user_id: integer() | nil,
          restrictions: term()
        }
  def principal_claims(identity) do
    %{
      user_id: int_id(identity.id),
      kind: Map.get(identity, :kind),
      parent_user_id: Map.get(identity, :parent_id),
      restrictions: Map.get(identity, :restrictions),
      access: Map.get(identity, :access)
    }
  end

  defp workspace_ids_of(user_id) do
    case Integer.parse(user_id) do
      {int, ""} ->
        Workspaces.workspaces_of_user(int) |> Enum.map(& &1.workspace_id)

      _ ->
        []
    end
  end

  # -- U7 compat dispatch: filter (intents ⊗ visibility) then translate ------

  @doc """
  The intents ⊗ visible-set dispatch filter + translate step of the compat
  push path. Takes the session's slices — intents, the visible-set memo,
  the per-socket author cache, the VERIFIED identity — and returns
  `{visible, author_cache, result}`: the (possibly refreshed) memo and
  author cache to fold back into socket state, plus either the translated
  `{name, payload}` (SCREAMING_SNAKE name + Discord payload shape) or
  `:drop`.

  The memo refreshes (epoch move ⇒ recompute) BEFORE the membership test
  (R9): a rights change reflects on the very next dispatch without any
  reconnect. The anchor — the channel a dispatch is about — resolves ONCE
  against the memo; a miss drops the event (fail closed). Native sessions
  never reach HERE (no intents, no translation): they run the same visibility
  half through `visible_dispatch?/4`, added by #51.
  """
  @spec filter_dispatch(non_neg_integer(), visible() | nil, map(), identity(), String.t(), map()) ::
          {visible() | nil, map(), {String.t(), map()} | :drop}
  def filter_dispatch(intents, visible, author_cache, identity, event_name, payload) do
    # R9: every principal-visible surface is computed under
    # parent∩restrictions — the visibility memo refreshes (epoch move ⇒
    # recompute) BEFORE the membership test, so a rights change reflects
    # on the very next dispatch without any reconnect.
    visible = refresh_visibility(visible, identity)

    cond do
      native_only?(event_name) ->
        # Native-client state with no Discord counterpart: a compat session
        # (a bot) must never receive it RAW through the catch-all translation.
        {visible, author_cache, :drop}

      application_addressed?(event_name) ->
        {author_cache, translated} = translate_dispatch(author_cache, event_name, payload, nil)
        {visible, author_cache, translated}

      workspace_addressed?(event_name) ->
        # Member/presence events anchor on the WORKSPACE (no channel): guild
        # membership gates delivery, the owning intent bit gates the class.
        # SELF-presence never delivers (Discord parity: a client never
        # receives PRESENCE_UPDATE for itself — the join-time self-announce
        # would otherwise consume a seq on every compat session).
        guild_id = field(payload, "workspace_id")

        if not self_presence?(event_name, payload, identity) and
             guild_member?(visible, guild_id) and workspace_intent_ok?(intents, event_name) do
          {author_cache, translated} = translate_dispatch(author_cache, event_name, payload, nil)
          {visible, author_cache, translated}
        else
          {visible, author_cache, :drop}
        end

      self_typing?(event_name, payload, identity) ->
        # Discord does NOT echo a user's own TYPING_START back to that user's
        # sessions (#77): a typing indicator is for OTHER people. Every other
        # class here DOES reach the actor as well — a reaction the actor added
        # is delivered back to it, which #72/#73 depend on.
        {visible, author_cache, :drop}

      thread_reply_channel_copy?(event_name, payload) ->
        # The dual emission's channel leg (#83 compat-surface remainder): a
        # thread reply publishes BOTH a parent-anchored `MessageCreate` and the
        # thread-scoped `ThreadMessageCreate` (U12), but Discord never delivers
        # a thread reply to the PARENT channel — a compat session that consumed
        # both legs rendered the reply twice (inline in the parent, where no
        # thread marker marks it, and in the thread). The thread leg carries
        # the identical payload, anchors on the same parent's visibility and
        # rides the same GUILD_MESSAGES intent, so dropping this leg loses
        # nothing and fixes the placement. Native sessions (the web client
        # filters the channel timeline by thread_id) keep both legs verbatim.
        {visible, author_cache, :drop}

      true ->
        # The anchor resolves ONCE here: the membership test hands the
        # translate path both the anchor channel id and its OWNING
        # workspace — ThreadMessageCreate's payload channel_id,
        # ThreadUpdate's parent re-read, and every guild_id_of_channel
        # lookup below collapse into this single resolution (zero re-reads).
        anchor_id = dispatch_channel_anchor(event_name, payload)

        case anchor(visible, anchor_id, identity) do
          {_anchor_id, ws_id} = anchor_pair when is_integer(ws_id) ->
            if guild_intent_ok?(intents, event_name) do
              {author_cache, translated} =
                translate_dispatch(author_cache, event_name, payload, anchor_pair)

              {visible, author_cache, translated}
            else
              {visible, author_cache, :drop}
            end

          {_anchor_id, :dm} = anchor_pair ->
            # DM-anchored events (B-1): recipient membership gates delivery
            # (participation IS authorization — the workspace visible-set
            # cannot see a DM), and the DIRECT_* intent bits gate the class.
            if dm_intent_ok?(intents, event_name) do
              {author_cache, translated} =
                translate_dispatch(author_cache, event_name, payload, anchor_pair)

              {visible, author_cache, translated}
            else
              {visible, author_cache, :drop}
            end

          nil ->
            {visible, author_cache, :drop}
        end
    end
  end

  # -- #51 (+ #53): the NATIVE dispatch visibility gate -----------------------

  @doc """
  The native twin of `filter_dispatch/6` (#51 content, #53 activity + metadata):
  the same visible-set memo, the same anchor resolution, and the same
  membership test — WITHOUT the pieces that are compat-only (no intents gate:
  native sessions declare none; no translation: the native wire is already
  native).

  Until this existed the native path was an explicit no-op, so the MACHINE
  dialect was more strictly permissioned than the first-party human one —
  backwards, since a bot's visibility derives from its parent human's. The
  REST read of the same data has been gated by `Authorize.channel_gate/2`
  since #35 P0-1; without this, the socket was a second door onto it.

  Scoped to the event classes that are ABOUT a channel (`channel_anchored?/1`).
  Everything else passes untouched, and deliberately so: a shape-based rule
  ("payload carries an id") mis-anchors the classes that are not
  channel-addressed — `UserUpdate` carries a USER id, `MessageAck` is
  user-addressed, and the presence/member events carry a workspace id. Those
  would resolve to nothing and be silently dropped. A new channel-scoped
  event must be added to that list to be gated.

  Fail-closed for a listed event whose anchor does not resolve: the anchor is
  the channel the dispatch is ABOUT, and an unresolvable one is exactly the
  case where delivery would be a guess (see `anchor/3` for the classes).

  Returns `{visible, deliver?}` — the (possibly recomputed) memo for the
  caller to fold back into socket state. `notify: false`: the caller's rejoin
  poke is compat-only today, so asking for it would queue a no-op message per
  recompute.
  """
  @spec visible_dispatch?(visible() | nil, identity(), String.t(), map()) ::
          {visible() | nil, boolean()}
  def visible_dispatch?(visible, identity, event_name, payload) do
    cond do
      channel_anchored?(event_name) ->
        visible = refresh_visibility(visible, identity, notify: false)
        anchor_id = dispatch_channel_anchor(event_name, payload)

        {visible, match?({_anchor_id, _owner}, anchor(visible, anchor_id, identity))}

      workspace_addressed?(event_name) ->
        # Member/presence events anchor on the WORKSPACE: deliver only while the
        # identity is still a member (compat's `guild_member?` rule). A kicked
        # member's socket otherwise kept receiving the workspace's roster and
        # presence until it reconnected. The one exception is the removal
        # notice about the identity ITSELF — that is how its client learns it
        # was removed.
        visible = refresh_visibility(visible, identity, notify: false)
        guild_id = field(payload, "workspace_id")

        {visible, self_removal?(event_name, payload, identity) or guild_member?(visible, guild_id)}

      true ->
        {visible, true}
    end
  end

  defp self_removal?("MemberRemove", payload, identity),
    do: int_id(field(payload, "user_id")) == int_id(identity.id)

  defp self_removal?(_event, _payload, _identity), do: false

  # The native event classes that are ABOUT a channel — the gate's whole scope
  # (#51 content, #53 activity + metadata). Every one resolves an anchor the
  # memo can decide:
  #
  #   * CONTENT: message create/update/delete and the thread-reply twin (whose
  #     `channel_id` is the PARENT channel — thread visibility rides the
  #     parent's rights);
  #   * ACTIVITY: `TypingStart`. Both source gates check the SENDER only
  #     (`Authorize` on the REST route, `typing_visible?` on the gateway op),
  #     never the recipients — so without this a non-viewer still learns a
  #     hidden channel is active;
  #   * METADATA: channel create/update/delete and `ThreadCreate`. These work
  #     through the epoch choreography `channel_controller` documents: CREATE
  #     bumps the workspace epoch BEFORE fan-out, so every session's memo
  #     recomputes and admits the new channel for viewers only; DELETE
  #     deliberately does NOT bump, so the stale last-epoch set is the only
  #     record that can admit it (and only for sessions that could see it).
  #     Known fragility, SHARED WITH COMPAT (which gates the same way):
  #     an unrelated rights mutation between a delete and its dispatch
  #     triggers a recompute, and the deleted channel drops out of the memo —
  #     the event is then lost for viewers too, leaving a stale row until
  #     reload. Metadata-only, and cheaper than the alternative (keeping
  #     deleted channels in the memo).
  #
  # Deliberately NOT here, with reasons:
  #   * `UserUpdate` / `MessageAck` — user-addressed, and mis-anchored by any
  #     shape-based rule (`UserUpdate` carries a USER id; gating `MessageAck`
  #     would risk the multi-device ack path for no security gain, since the
  #     acker has already passed the REST channel gate).
  #   * Workspace-addressed membership/presence (`MemberAdd`, `MemberRemove`,
  #     `PresenceUpdate`) and application-addressed (`InteractionCreate`) —
  #     no channel anchor at all; the subscription's own membership scope
  #     decides their audience.
  #
  # DERIVED, not hand-listed: every event `Cytale.Gateway.Payloads` classifies
  # as channel-anchored (content, reactions, thread lifecycle, typing, calls),
  # plus the channel-lifecycle metadata events. The hand-kept list had drifted
  # — reactions and `ThreadUpdate`/`ThreadDelete` reached sessions that could
  # not see the channel (reaction emoji + message ids, private thread names).
  @native_channel_anchored Cytale.Gateway.Payloads.channel_anchored_events() ++
                             ~w(ChannelCreate ChannelUpdate ChannelDelete)

  @doc false
  @spec native_channel_anchored_events() :: [String.t()]
  def native_channel_anchored_events, do: @native_channel_anchored

  defp channel_anchored?(event_name), do: event_name in @native_channel_anchored

  # The anchor classification: the memo's visible-set first (cheap, no
  # reads), then — on a miss — ONE point read to tell a DM channel the
  # identity PARTICIPATES in from everything else (unknown id,
  # out-of-profile workspace channel, someone else's DM — all fail closed;
  # DM channels never appear in a workspace visible-set, so the read runs
  # only for visible-miss anchors). Workspace anchors are
  # {channel_id, workspace_id}; a DM anchor is {channel_id, :dm} (the
  # translation renders guild_id nil on it, Discord's DM shape).
  defp anchor(visible, channel_id, identity) do
    case visible_anchor(visible, channel_id) do
      {_anchor_id, _ws_id} = found ->
        found

      nil when is_integer(channel_id) ->
        case Workspaces.get_dm(channel_id) do
          nil -> nil
          dm -> dm_participant_anchor(dm, identity)
        end

      nil ->
        nil
    end
  end

  defp dm_participant_anchor(dm, identity) do
    if dm_readable?(dm, identity),
      do: {dm.channel_id, :dm},
      else: nil
  end

  # A DM reaches a session only when its principal PARTICIPATES and, for a
  # machine, its access document grants DM view (`Principal.dm_bits/1` —
  # `dms: :none`, the default, grants nothing). The REST DM gate
  # (`Authorize.dm_gate/2`) applies the same two tests; without the second
  # one here a bot whose DM grant was withdrawn still received every DM
  # message over the gateway (Tier 3 B, 12c).
  defp dm_readable?(dm, identity) do
    Workspaces.dm_participant?(dm, int_id(identity.id)) and
      Bitfield.has?(PrincipalRights.dm_bits(identity), :view_channel)
  end

  # INTERACTION_CREATE is APPLICATION-ADDRESSED (bots plan U8, KTD13): it is
  # a point-to-point dispatch to the bot's own sessions (fanned to its user
  # key at invocation), not a broadcast the intents ⊗ visible-set filter
  # governs — Discord has no interaction intent, and a restrictions-narrowed
  # bot must still learn it was invoked (its callback is separately gated by
  # the resolver). Documented divergence (docs/protocol/compat.md).
  # User-addressed native state (#54 `ReadStateUpdate` — a fired mark moving
  # the owner's read state; #30 `InteractionModal` — a form for the HUMAN who
  # invoked). Neither exists in Discord's protocol, so neither is translated.
  # `InteractionSuccess` is Discord's INTERACTION_SUCCESS, which Discord sends
  # only to the USER client that made the interaction; only humans invoke
  # here (the clicker gate), so a bot's compat session is never its
  # audience — it stays native.
  defp native_only?(event), do: event in ~w(ReadStateUpdate InteractionModal InteractionSuccess)

  defp application_addressed?("InteractionCreate"), do: true
  defp application_addressed?(_event), do: false

  # Workspace-addressed (B-3): events about a workspace's MEMBERSHIP and
  # PRESENCE — no channel anchor; guild membership + the owning intent bit
  # gate them.
  defp workspace_addressed?("MemberAdd"), do: true
  defp workspace_addressed?("MemberRemove"), do: true
  defp workspace_addressed?("MemberUpdate"), do: true
  defp workspace_addressed?("PresenceUpdate"), do: true
  defp workspace_addressed?(_event), do: false

  # The join-time self-announce: a session's own presence never delivers to
  # itself (Discord parity — the client owns its status).
  defp self_presence?("PresenceUpdate", payload, identity),
    do: int_id(field(payload, "user_id")) == int_id(identity.id)

  defp self_presence?(_event, _payload, _identity), do: false

  # Discord's typing rule (#77): a TYPING_START is for everyone EXCEPT the user
  # who is typing — not even their other sessions. The native wire keeps its own
  # (long-standing) behaviour; this is the compat contract.
  defp self_typing?("TypingStart", payload, identity) do
    # `field/2`, because the compat typing route publishes an ATOM-keyed map
    # (`user_id: ...`) while the reaction fan-outs are string-keyed — reading
    # only the string key silently made this exclusion a no-op.
    typing = int_id(field(payload, "user_id"))

    not is_nil(typing) and typing == int_id(identity.id)
  end

  defp self_typing?(_event, _payload, _identity), do: false

  # The parent-anchored leg of a thread reply's dual emission (U12): a
  # `MessageCreate` whose payload carries `thread_id`. See the drop clause in
  # `filter_dispatch/6`. `field/2` because the hot path publishes string-keyed
  # wires while test harnesses hand it atom-keyed message_json.
  defp thread_reply_channel_copy?("MessageCreate", payload),
    do: field(payload, "thread_id") != nil

  defp thread_reply_channel_copy?(_event, _payload), do: false

  # Re-point a translated message object onto the THREAD when the native
  # payload says the message is a thread reply (the MESSAGE_UPDATE rule).
  defp maybe_rethread(message, payload) do
    case field(payload, "thread_id") do
      nil -> message
      thread_id -> Map.put(message, "channel_id", thread_id)
    end
  end

  # Intents gate: which bit an event class rides. Lifecycle (RESUMED etc.)
  # never passes through the push handler. Events with no supported intent
  # mapping (roles, read-state, thread-membership) are NOT delivered to
  # compat sessions — a documented divergence pinned in
  # docs/protocol/gateway.md.
  @intent_by_event %{
    "MessageCreate" => @intent_guild_messages,
    "MessageUpdate" => @intent_guild_messages,
    "MessageDelete" => @intent_guild_messages,
    "ThreadMessageCreate" => @intent_guild_messages,
    "MessageReactionAdd" => @intent_guild_message_reactions,
    "MessageReactionRemove" => @intent_guild_message_reactions,
    "MessageReactionRemoveAll" => @intent_guild_message_reactions,
    "ChannelCreate" => @intent_guilds,
    "ChannelUpdate" => @intent_guilds,
    "ChannelDelete" => @intent_guilds,
    "ThreadCreate" => @intent_guilds,
    "ThreadUpdate" => @intent_guilds,
    "ThreadDelete" => @intent_guilds,
    "TypingStart" => @intent_guild_message_typing
  }

  # B-3: workspace-anchored classes.
  @workspace_intent_by_event %{
    "MemberAdd" => @intent_guild_members,
    "MemberRemove" => @intent_guild_members,
    "MemberUpdate" => @intent_guild_members,
    "PresenceUpdate" => @intent_guild_presences
  }

  # B-1: DM-anchored classes ride the DIRECT_* bits (Discord's split — a
  # guild intent never unlocks a DM event and vice versa).
  @dm_intent_by_event %{
    "MessageCreate" => @intent_direct_messages,
    "MessageUpdate" => @intent_direct_messages,
    "MessageDelete" => @intent_direct_messages,
    "MessageReactionAdd" => @intent_direct_message_reactions,
    "MessageReactionRemove" => @intent_direct_message_reactions,
    "MessageReactionRemoveAll" => @intent_direct_message_reactions,
    "TypingStart" => @intent_direct_message_typing
  }

  for {event, intent} <- @intent_by_event do
    defp guild_intent_ok?(intents, unquote(event)),
      do: Bitwise.band(intents, unquote(intent)) != 0
  end

  for {event, intent} <- @workspace_intent_by_event do
    defp workspace_intent_ok?(intents, unquote(event)),
      do: Bitwise.band(intents, unquote(intent)) != 0
  end

  for {event, intent} <- @dm_intent_by_event do
    defp dm_intent_ok?(intents, unquote(event)), do: Bitwise.band(intents, unquote(intent)) != 0
  end

  # Application-addressed events ride no intent bit (see
  # application_addressed?/1) — always admitted to translation.
  defp guild_intent_ok?(_intents, "InteractionCreate"), do: true

  defp guild_intent_ok?(_intents, _event), do: false

  defp workspace_intent_ok?(_intents, _event), do: false

  # DM delivery is recipient-gated upstream (the anchor classification reads
  # the dm row); a DM-anchored event with no DIRECT_* mapping (e.g. thread
  # events — DMs have no threads) never delivers.
  defp dm_intent_ok?(_intents, _event), do: false

  # Translation table (KTD5): native CamelCase → SCREAMING_SNAKE, payloads →
  # Discord shapes via the shared compat codec. `guild_id` (the owning
  # workspace, KTD7) rides on message/channel/typing objects and comes from
  # the ANCHOR the membership test resolved (anchor_guild/1) — the owning
  # workspace without a channel-row re-read.
  #
  # Clauses return `{author_cache, {name, payload}}`: the message-family
  # clauses thread the socket's author cache (PERF-2, B3b) — the payload's
  # author resolves ONCE per author per TTL through
  # `Cytale.Gateway.AuthorCache` (fallback resolver
  # `MessageCodec.resolve_author/1`, byte-identical output), and the
  # pre-resolved entry rides into the codec so a cache hit costs zero point
  # reads.
  defp translate_dispatch(author_cache, "MessageCreate" = _event, payload, anchor) do
    {author_cache, resolved} = resolve_native_author(author_cache, payload)

    {author_cache, {"MESSAGE_CREATE", MessageCodec.message_from_native(payload, anchor_guild(anchor), resolved)}}
  end

  defp translate_dispatch(author_cache, "MessageUpdate" = _event, payload, anchor) do
    {author_cache, resolved} = resolve_native_author(author_cache, payload)

    translated = MessageCodec.message_from_native(payload, anchor_guild(anchor), resolved)

    # A thread reply's edit lands ON the thread (#83 compat-surface remainder):
    # the native wire anchors the event on the parent channel (the dual
    # emission's storage partition) with `thread_id` set, but Discord's
    # MESSAGE_UPDATE for a thread message carries the THREAD id — a client
    # keys its message cache on (channel_id, id) and would never match the
    # parent-anchored copy. The payload carries the thread id (the native
    # message_json projection), so no read is needed.
    {author_cache, {"MESSAGE_UPDATE", maybe_rethread(translated, payload)}}
  end

  defp translate_dispatch(author_cache, "MessageDelete" = _event, payload, anchor) do
    # Same thread rule as MESSAGE_UPDATE above: a thread reply's delete is
    # reported on the THREAD (payload `thread_id`), not the parent partition.
    channel = field(payload, "thread_id") || payload["channel_id"]

    {author_cache,
     {"MESSAGE_DELETE",
      %{
        "id" => payload["id"],
        "channel_id" => channel && to_string(channel),
        "guild_id" => anchor_guild(anchor)
      }}}
  end

  defp translate_dispatch(author_cache, "ThreadMessageCreate" = _event, payload, anchor) do
    # A thread reply renders as MESSAGE_CREATE on the THREAD channel; the
    # anchor IS the thread's parent channel (dispatch_channel_anchor
    # resolved it from the payload's channel_id, thread-row fallback).
    {author_cache, resolved} = resolve_native_author(author_cache, payload)

    {author_cache, {"MESSAGE_CREATE", MessageCodec.thread_message_from_native(payload, anchor_guild(anchor), resolved)}}
  end

  defp translate_dispatch(author_cache, "ChannelCreate" = _event, payload, {anchor_id, _ws_id}),
    do: {author_cache, {"CHANNEL_CREATE", channel_object(anchor_id, payload)}}

  defp translate_dispatch(author_cache, "ChannelUpdate" = _event, payload, {anchor_id, _ws_id}),
    do: {author_cache, {"CHANNEL_UPDATE", channel_object(anchor_id, payload)}}

  defp translate_dispatch(author_cache, "ChannelDelete" = _event, payload, _anchor) do
    # The channel row is already GONE at fan-out time, and the epoch is
    # deliberately NOT bumped on delete (channel_controller): the stale
    # memo is the only record CHANNEL_DELETE visibility can be decided
    # against. guild_id therefore keeps the degraded row lookup the event
    # has always used (row gone → nil) — the anchor's owning workspace is
    # NOT substituted, or the deletion would resurrect the guild id.
    {author_cache,
     {"CHANNEL_DELETE",
      %{
        "id" => payload["id"],
        "guild_id" => guild_id_of_channel(payload["id"])
      }}}
  end

  defp translate_dispatch(author_cache, "ThreadCreate" = _event, payload, _anchor) do
    {author_cache, {"THREAD_CREATE", thread_object(payload)}}
  end

  defp translate_dispatch(author_cache, "ThreadUpdate" = _event, payload, anchor) do
    {author_cache, {"THREAD_UPDATE", thread_object(payload, anchor)}}
  end

  defp translate_dispatch(author_cache, "ThreadDelete" = _event, payload, anchor) do
    {author_cache,
     {"THREAD_DELETE",
      %{
        "id" => payload["id"],
        "guild_id" => anchor_guild(anchor),
        "parent_id" => payload["channel_id"] && Integer.to_string(payload["channel_id"])
      }}}
  end

  defp translate_dispatch(author_cache, "TypingStart" = _event, payload, anchor),
    do: {author_cache, {"TYPING_START", MessageCodec.typing_from_native(payload, anchor_guild(anchor))}}

  # Reactions (Discord shapes): ADD carries `member.user` for the reacting
  # principal (INTERACTION_CREATE's pattern — resolved ONCE through the
  # per-socket author cache); REMOVE is the same shape minus `member`;
  # REMOVE_ALL carries identity fields only. `emoji` is Discord's emoji
  # object with a ALWAYS-null id (Cytale has no custom-emoji system).
  defp translate_dispatch(author_cache, "MessageReactionAdd" = _event, payload, anchor) do
    # member.user for the reacting principal (INTERACTION_CREATE's pattern),
    # resolved ONCE per principal per TTL through the per-socket cache.
    {author_cache, entry} =
      case int_id(payload["user_id"]) do
        nil ->
          {author_cache, MessageCodec.resolve_author(-1)}

        user_id ->
          AuthorCache.resolve(
            author_cache,
            user_id,
            System.system_time(:millisecond),
            &MessageCodec.resolve_author/1
          )
      end

    {author_cache,
     {"MESSAGE_REACTION_ADD",
      %{
        "user_id" => field(payload, "user_id"),
        "channel_id" => field(payload, "channel_id"),
        "message_id" => field(payload, "message_id"),
        # `type` is REQUIRED (#72): discord.py's `RawReactionActionEvent`
        # indexes `data['type']` unguarded (`raw_models.py`), so a reaction
        # killed the client's own gateway task — and a bot that ACKS with a
        # reaction therefore disconnected itself on every inbound message.
        # 0 = NORMAL (the only one we produce); 1 = BURST.
        "type" => 0,
        "emoji" => %{"id" => nil, "name" => payload["emoji"]},
        "guild_id" => anchor_guild(anchor),
        # The reactor as a guild member, in the ONE member shape (#73). A
        # client builds a Member from this and indexes `roles` unguarded, so
        # the thin `%{"user" => …}` this used to emit raised KeyError('roles')
        # INSIDE the gateway task — worse than #72 in that a reaction fires on
        # every bot ack, so the acknowledgement disconnected the client and the
        # reply it was acknowledging was thrown away.
        "member" => MessageCodec.member(elem(entry, 0), anchor_guild(anchor))
      }}}
  end

  defp translate_dispatch(author_cache, "MessageReactionRemove" = _event, payload, anchor) do
    {author_cache,
     {"MESSAGE_REACTION_REMOVE",
      %{
        "user_id" => field(payload, "user_id"),
        "channel_id" => field(payload, "channel_id"),
        "message_id" => field(payload, "message_id"),
        "type" => 0,
        "emoji" => %{"id" => nil, "name" => payload["emoji"]},
        "guild_id" => anchor_guild(anchor)
      }}}
  end

  defp translate_dispatch(author_cache, "MessageReactionRemoveAll" = _event, payload, anchor) do
    {author_cache,
     {"MESSAGE_REACTION_REMOVE_ALL",
      %{
        "channel_id" => field(payload, "channel_id"),
        "message_id" => field(payload, "message_id"),
        "guild_id" => anchor_guild(anchor)
      }}}
  end

  defp translate_dispatch(author_cache, "InteractionCreate" = _event, payload, _anchor),
    do: {author_cache, {"INTERACTION_CREATE", MessageCodec.interaction_from_native(payload)}}

  # B-3 — member/presence (workspace-anchored; guild_id from the payload's
  # workspace_id, the fan-out's owning workspace). GUILD_MEMBER_ADD carries
  # Discord's member shape (user/roles/joined_at); REMOVE the {guild, user}
  # pair; PRESENCE_UPDATE maps the native status 1:1 (online/idle/dnd/
  # offline — Discord's four) with empty activities/client_status (Cytale
  # has no activity model).
  defp translate_dispatch(author_cache, "MemberAdd" = _event, payload, _anchor) do
    user = payload["user"] || %{}
    guild_id = field(payload, "workspace_id")

    member =
      MessageCodec.member(
        MessageCodec.user_object(%{
          user_id: int_id(user["id"]) || -1,
          username: user["username"] || "unknown-user",
          display_name: user["display_name"],
          # A machine's MemberAdd (a grant) carries its kind: `bot: true`,
          # exactly as its messages' author objects say.
          kind: member_kind(payload["kind"])
        }),
        guild_id
      )

    # Discord's GUILD_MEMBER_ADD `d` IS the member object plus `guild_id`, so the
    # event adds one key to the ONE member shape (#73) instead of restating it.
    # The shape it replaces sent `roles: []`, which survives the client's
    # unguarded `map(int, roles)` but is a second, thinner statement about the
    # same object — a member always has @everyone.
    {author_cache, {"GUILD_MEMBER_ADD", Map.put(member, "guild_id", guild_id)}}
  end

  # A nickname change (#169) → GUILD_MEMBER_UPDATE: Discord's `d` is the
  # member object plus `guild_id`, and discord.py reads `roles` unguarded, so
  # it is the ONE member shape (`MessageCodec.member/3`) with the new `nick`.
  # The payload names only the user id; the user object resolves through the
  # per-socket author cache, as GUILD_MEMBER_REMOVE's does.
  defp translate_dispatch(author_cache, "MemberUpdate" = _event, payload, _anchor) do
    guild_id = field(payload, "workspace_id")

    {author_cache, {user, _kind}} =
      case int_id(payload["user_id"]) do
        nil ->
          {author_cache, MessageCodec.resolve_author(-1)}

        user_id ->
          AuthorCache.resolve(author_cache, user_id, System.system_time(:millisecond), &MessageCodec.resolve_author/1)
      end

    member = MessageCodec.member(user, guild_id, nick: payload["nickname"])
    {author_cache, {"GUILD_MEMBER_UPDATE", Map.put(member, "guild_id", guild_id)}}
  end

  defp translate_dispatch(author_cache, "MemberRemove" = _event, payload, _anchor) do
    # The payload carries only user_id + workspace_id — the user object
    # resolves through the per-socket author cache (one read per principal
    # per TTL).
    {author_cache, entry} =
      case int_id(payload["user_id"]) do
        nil ->
          {author_cache, MessageCodec.resolve_author(-1)}

        user_id ->
          AuthorCache.resolve(
            author_cache,
            user_id,
            System.system_time(:millisecond),
            &MessageCodec.resolve_author/1
          )
      end

    {author_cache,
     {"GUILD_MEMBER_REMOVE",
      %{
        "guild_id" => field(payload, "workspace_id"),
        "user" => elem(entry, 0)
      }}}
  end

  defp translate_dispatch(author_cache, "PresenceUpdate" = _event, payload, _anchor) do
    {author_cache, user_entry} =
      case int_id(field(payload, "user_id")) do
        nil ->
          {author_cache, MessageCodec.resolve_author(-1)}

        user_id ->
          AuthorCache.resolve(
            author_cache,
            user_id,
            System.system_time(:millisecond),
            &MessageCodec.resolve_author/1
          )
      end

    {author_cache,
     {"PRESENCE_UPDATE",
      %{
        "user" => %{
          "id" => field(payload, "user_id"),
          "username" => elem(user_entry, 0)["username"]
        },
        "guild_id" => field(payload, "workspace_id"),
        "status" => field(payload, "status"),
        "activities" => [],
        "client_status" => %{}
      }}}
  end

  defp translate_dispatch(author_cache, event_name, payload, _anchor),
    do: {author_cache, {event_name, payload}}

  # PERF-2 (B3b): resolve the payload's author through the per-socket
  # cache; returns the updated cache plus the single-entry pre-resolved map
  # the codec consumes (empty when the payload carries no usable author
  # id — the codec then renders its tombstone).
  defp resolve_native_author(author_cache, payload) do
    case int_id(payload["author_id"]) do
      nil ->
        {author_cache, %{}}

      author_id ->
        {cache, entry} =
          AuthorCache.resolve(
            author_cache,
            author_id,
            System.system_time(:millisecond),
            &MessageCodec.resolve_author/1
          )

        {cache, %{author_id => entry}}
    end
  end

  # The owning workspace of the anchor channel, as the compat wire's
  # guild_id (decimal string). Application-addressed events carry no anchor;
  # DM-anchored events carry NO guild_id (Discord's DM shape — the anchor's
  # marker is :dm, never an integer).
  defp anchor_guild({_anchor_id, :dm}), do: nil
  defp anchor_guild({_anchor_id, ws_id}) when is_integer(ws_id), do: Integer.to_string(ws_id)
  defp anchor_guild(nil), do: nil

  defp anchor_channel_id({anchor_id, _ws_id}), do: anchor_id
  defp anchor_channel_id(nil), do: nil

  # The channel row as a Discord channel object (one point read; the row
  # exists by fan-out time for every event except ChannelDelete).
  #
  # #70: the DISPATCH reports the event's own change. `ChannelUpdate`'s payload
  # is built by the controller from the POST-WRITE row, so it already states
  # the new name and position; this projection's own point read is a SECOND
  # read of that row and can disagree with it (observed on a channel renamed
  # before the fan-out, where the dispatch carried the creation name). The
  # event's stated fields win; the field SET is untouched, which is the part
  # that must keep agreeing with the handshake inventory (#69).
  defp channel_object(channel_id, payload) do
    case channel_row(channel_id) do
      %{} = ch ->
        MessageCodec.channel(ch)

      # The row is gone (a delete racing the dispatch). Emit the SAME shape
      # built from the id alone rather than a subset: a client indexes
      # `position` unguarded (#64), so a thin object here is the same crash one
      # path over — and this is the only channel shape in the dialect (#69).
      nil ->
        MessageCodec.channel(payload_channel_row(channel_id))
    end
    |> report_string("name", payload)
    |> report_string("topic", payload)
    |> report_id("parent_id", payload)
    |> report_integer("position", payload)
  end

  defp payload_channel_row(channel_id) do
    %{
      channel_id: int_id(channel_id),
      workspace_id: nil,
      name: nil,
      topic: nil,
      parent_id: nil,
      type: 0,
      position: 0,
      last_message_id: nil
    }
  end

  defp channel_row(channel_id) when is_integer(channel_id), do: Workspaces.get_channel(channel_id)

  defp channel_row(channel_id) when is_binary(channel_id),
    do: channel_row(int_id(channel_id))

  defp channel_row(_), do: nil

  defp guild_id_of_channel(channel_id) do
    case channel_row(channel_id) do
      %{workspace_id: ws_id} when is_integer(ws_id) -> Integer.to_string(ws_id)
      _ -> nil
    end
  end

  # ONE thread shape (#69). Both dispatch clauses hand a ROW to the codec's
  # builder — the same function the GUILD_CREATE `threads[]` inventory uses —
  # so the two projections cannot disagree about a thread object again. The
  # #64 fix protected the inventory and left this path thin, and the gap only
  # became visible once #68 stopped dropping THREAD_CREATE: the first dispatch
  # that reached a real client killed its gateway task on `KeyError:
  # 'message_count'`.
  #
  # `Threads.Thread.get/1` is the same point read the parent anchor needs
  # (thread creates/updates are rare — not a hot path), and a thread whose row
  # is already gone degrades to a payload-shaped row, which is complete by
  # construction rather than a subset.
  defp thread_object(payload, anchor) do
    build_thread_object(
      payload,
      anchor_channel_id(anchor),
      anchor_guild(anchor),
      load_thread(payload["id"])
    )
  end

  # #71: Discord's THREAD_CREATE carries `newly_created` — "whether the thread
  # was newly created" — and discord.py (state.py: the `if not has_thread`
  # branch) uses it to choose between dispatching `thread_create` and
  # `thread_join`. Without it `data.get('newly_created')` is falsy, so every
  # library concludes the bot was ADDED to an existing thread: the payload
  # parses fine, the socket stays healthy, and `on_thread_create` never fires.
  # It is EVENT metadata, not part of the thread object, so the arity-2
  # ThreadUpdate clause keeps it out and the handshake inventory does not carry
  # it — which is exactly why the parity assertion admits this one key.
  defp thread_object(payload) do
    row = load_thread(payload["id"])
    parent = int_id(payload["channel_id"]) || (row && row.channel_id)

    build_thread_object(payload, parent, guild_id_of_channel(parent), row)
    |> Map.put("newly_created", true)
  end

  defp build_thread_object(payload, parent, guild_id, row) do
    MessageCodec.thread_channel(row || payload_thread_row(payload, parent), guild_id)
    |> report_event_change(payload)
  end

  # A dispatch is the authoritative report of the change it carries: the row is
  # a point read that can lag or lead the event, so a field the EVENT states
  # wins over the same field in the row. The field SET is untouched — that is
  # the parity guarantee (#69) — and everything the payload does not state
  # (message_count, member_count, thread_metadata's timestamps) still comes from
  # the row, which is the only source for it.
  defp report_event_change(object, payload) do
    object
    |> report_string("name", payload)
    |> report_archived(payload)
  end

  defp report_string(object, key, payload) do
    case Map.fetch(payload, key) do
      {:ok, value} when is_binary(value) -> Map.put(object, key, value)
      _ -> object
    end
  end

  # An ID the event states: the payload carries it as a decimal string (or nil
  # for "no parent"), so a binary is the only renderable value.
  defp report_id(object, key, payload) do
    case Map.fetch(payload, key) do
      {:ok, value} when is_binary(value) -> Map.put(object, key, value)
      {:ok, nil} -> Map.put(object, key, nil)
      _ -> object
    end
  end

  defp report_integer(object, key, payload) do
    case Map.fetch(payload, key) do
      {:ok, value} when is_integer(value) -> Map.put(object, key, value)
      _ -> object
    end
  end

  # `archived` lands INSIDE thread_metadata — the only place the shared shape
  # carries it. Hoisting it to the top level would add a key the handshake
  # inventory does not have, which is the divergence #69 exists to close.
  defp report_archived(object, payload) do
    case Map.fetch(payload, "archived") do
      {:ok, archived} when is_boolean(archived) ->
        Map.update(object, "thread_metadata", %{}, &Map.put(&1, "archived", archived))

      _ ->
        object
    end
  end

  defp load_thread(thread_id) do
    case int_id(thread_id) do
      nil -> nil
      id -> Threads.Thread.get(id)
    end
  end

  # Every field `MessageCodec.thread_channel/2` reads, present — so a delete
  # racing the dispatch still renders a complete Discord object.
  defp payload_thread_row(payload, parent) do
    %{
      thread_id: int_id(payload["id"]),
      channel_id: parent,
      name: payload["name"],
      created_by: int_id(payload["created_by"]),
      archived: Map.get(payload, "archived", false),
      message_count: 0,
      member_count: 0,
      latest_reply_at: nil,
      created_at: parse_iso(payload["created_at"])
    }
  end

  @spec thread_parent(term()) :: integer() | nil
  defp thread_parent(thread_id) when is_binary(thread_id),
    do: thread_parent(int_id(thread_id))

  defp thread_parent(thread_id) when is_integer(thread_id) do
    case Threads.Thread.get(thread_id) do
      %{channel_id: channel_id} when is_integer(channel_id) -> channel_id
      _ -> nil
    end
  end

  defp thread_parent(_), do: nil

  # -- Compat handshake (Discord READY + GUILD_CREATE synthesis, KTD5) -------

  @doc """
  The compat handshake (KTD5): a Discord-shaped READY — v, user with
  bot:true/discriminator "0"/global_name, guilds as unavailable stubs,
  session_id, resume_gateway_url — followed immediately by one synthesized
  GUILD_CREATE per in-profile workspace (guild object carrying its channels
  plus the `threads` inventory — the parent-visible thread channel objects,
  C-1): Discord libraries build their guild AND thread caches from
  GUILD_CREATE and guild-guarded handlers are the majority pattern.

  Returns `{ready, guild_creates, visible}` — the READY frame, the
  GUILD_CREATE payloads (the socket seq-stamps + buffers them so a Resume
  replays them exactly), and the seeded visibility memo to store back on
  the socket.
  """
  @spec handshake(Session.t(), String.t() | nil, map()) :: {map(), [map()], visible()}
  def handshake(%Session{} = session, gateway_base_url, preloaded) do
    workspaces = preloaded.workspaces

    # Seed the visibility memo (the same parent∩restrictions computation the
    # dispatch filter uses) and carry ONLY in-profile channels in each guild
    # object — GUILD_CREATE is a principal-visible surface like any other.
    visible = refresh_visibility(nil, session.user, notify: false, preloaded: preloaded)

    ready = %{
      op: Opcode.dispatch(),
      t: "READY",
      s: 0,
      d: %{
        "v" => @compat_version,
        "user" =>
          MessageCodec.user_object(%{
            user_id: String.to_integer(session.user.id),
            username: session.user.username,
            kind: Map.get(session.user, :kind)
          }),
        "guilds" => Enum.map(workspaces, &MessageCodec.guild_stub/1),
        "session_id" => session.session_id,
        # Cytale extension on the Discord shape (Discord libraries ignore
        # it): the single-use resume secret from the native READY contract —
        # Resume requires it, so a compat client that wants replay-driven
        # resume (the soak bot leg) carries it from here.
        "resume_token" => session.resume_token,
        "resume_gateway_url" => resume_gateway_url(gateway_base_url),
        # REQUIRED by `AutoShardedConnectionState.parse_ready`, which indexes
        # `data['shard'][0]` unguarded: a plain `discord.Client` reads only
        # `guilds`/`user`, but the AutoSharded client dies on a READY without
        # it. One shard, so the canonical `[shard_id, shard_count]` is [0, 1]
        # — matching the `shards: 1` this surface advertises in
        # `/gateway/bot`.
        "shard" => [0, 1],
        "application" => %{"id" => session.user.id, "flags" => MessageCodec.application_flags()}
      }
    }

    guild_creates =
      workspaces
      |> Enum.filter(fn ws -> Map.has_key?(visible, ws.workspace_id) end)
      |> Enum.map(fn ws ->
        channels = guild_channels(visible, ws, preloaded.channels_by_ws[ws.workspace_id])
        # `session.user` rides along for #63's self-member, and the live set
        # for the presence snapshot (#64-class spirit fix: a bootstrap that
        # says nobody is online is schema-valid and useless).
        MessageCodec.guild(
          ws,
          channels,
          guild_threads(ws, channels),
          session.user,
          guild_presences(ws.workspace_id)
        )
      end)

    {ready, guild_creates, visible}
  end

  # DISCORD-SHAPED PRESENCES for the GUILD_CREATE bootstrap: Discord includes a
  # presence object per member whose status it knows, and `Guild._from_data`
  # matches them against members by `user.id` (dropping unknowns), so this is
  # exactly "the members who are connected to this workspace right now".
  #
  # Sources: the routing table answers WHO is live, PresenceStatus answers what
  # they broadcast (invisible → "offline"). Both are ETS reads, so a bootstrap
  # costs two lookups per live user, no queries. Deliberately INCLUDES the
  # connecting session (a snapshot of a live set that contains you, unlike the
  # presence EVENT stream, which never carries your own presence).
  defp guild_presences(workspace_id) do
    workspace_id
    |> Integer.to_string()
    |> PushRegistry.workspace_key()
    |> PushRegistry.subscribers()
    |> Enum.map(fn {_pid, user_id} -> user_id end)
    |> Enum.uniq()
    |> Enum.map(fn user_id ->
      status = PresenceStatus.wire_status(PresenceStatus.lookup(user_id))

      %{
        "user" => %{"id" => user_id},
        "status" => status,
        "activities" => [],
        "client_status" => %{"desktop" => status}
      }
    end)
  end

  # Only in-profile channels ride the guild object; a zero-visibility
  # workspace gets NO GUILD_CREATE at all (it would leak the workspace name
  # — the READY stub carries only the id, which the agent's own routing
  # already knows).
  defp guild_channels(visible, ws, channels) do
    case Map.get(visible, ws.workspace_id) do
      {_epoch, set} ->
        channels = channels || Workspaces.list_channels(ws.workspace_id)
        Enum.filter(channels, &MapSet.member?(set, &1.channel_id))

      _ ->
        []
    end
  end

  # C-1 — the guild object's `threads` inventory (discord.js builds its
  # thread cache from it at connect). Thread visibility rides the PARENT
  # channel's rights: only threads under the session's VISIBLE channels are
  # listed (the `threads` table partitions on channel_id — one bounded query
  # per visible channel, a one-time Identify cost), capped at 100 per guild
  # (Discord's GUILD_CREATE carries an unbounded list; Cytale truncates so a
  # thread-heavy workspace cannot bloat the Identify burst — documented
  # divergence in compat.md).
  #
  # The cap keeps the threads most likely to be spoken in: open ones first,
  # then the most recently active. It used to keep whichever 100 came first in
  # channel order, so a bot that reconnected in a busy workspace could lose a
  # thread it had answered in a day earlier; the next reply there looked like
  # a plain channel message, and Hermes tried to start a thread inside the
  # thread (2026-10-08). A thread the cap still drops is announced on its next
  # message (`thread_announcement/2`).
  @max_guild_threads 100

  @spec guild_threads(map(), [map()]) :: [map()]
  defp guild_threads(_ws, visible_channels) do
    visible_channels
    |> Enum.map(& &1.channel_id)
    |> Enum.flat_map(&Threads.Thread.list_in_channel/1)
    # Ties (same-millisecond stamps) fall to the newer id, so the pick is stable.
    |> Enum.sort_by(fn t -> {!!t.archived, -activity_us(t), -t.thread_id} end)
    |> Enum.take(@max_guild_threads)
  end

  defp activity_us(t) do
    case t.latest_reply_at || t.created_at do
      %DateTime{} = at -> DateTime.to_unix(at, :microsecond)
      _ -> 0
    end
  end

  @doc """
  THREAD_CREATE for a thread this session was never told about, sent just
  before the first message from it. Discord's GUILD_CREATE lists every open
  thread; ours stops at #{@max_guild_threads}, so without this a library
  meets a message whose channel it has no record of, and discord.py hands it
  over as a plain channel (2026-10-08: Hermes tried to start a thread inside
  the thread). No `newly_created`: the thread is not new, and Discord sends the
  same shape when a thread becomes visible to a client (discord.py files it as
  a join). `nil` when the thread row is gone.
  """
  @spec thread_announcement(String.t(), String.t() | nil) :: map() | nil
  def thread_announcement(thread_id, guild_id) do
    case load_thread(thread_id) do
      nil -> nil
      row -> MessageCodec.thread_channel(row, guild_id)
    end
  end

  # gateway_base_url is ALREADY the full shared URL (GatewayUrl.ws_url at
  # upgrade time — ws(s) scheme, ?v=10&encoding=json suffix included).
  defp resume_gateway_url(base) when is_binary(base), do: base

  defp resume_gateway_url(_base), do: nil

  @doc """
  Is `channel_id` in the SESSION'S memo for `ws_id`?

  The cheap consult the per-event gates use instead of a fresh rights resolve
  (hardening plan 5.3): the memo is the same visible set the dispatch gate
  enforces (`visible_dispatch?/4`), refreshed lazily when a rights epoch moved, so
  a warm answer is one ETS compare plus a `MapSet` membership — the resolver's
  roles-partition read and the channel's overwrite reads do not run. Returns
  `{visible, boolean}` so the caller can keep a refresh it triggered.
  """
  @spec visible_channel_in_memo?(visible() | nil, identity(), integer(), integer()) ::
          {visible() | nil, boolean()}
  def visible_channel_in_memo?(visible, identity, ws_id, channel_id) do
    visible = refresh_visibility(visible, identity)

    case Map.get(visible, ws_id) do
      {_epoch, set} -> {visible, MapSet.member?(set, channel_id)}
      nil -> {visible, false}
    end
  end

  # -- Resume replay re-filter (U7 R9) ----------------------------------------

  @doc """
  Resume replay re-filter (U7 R9): buffered envelopes whose channel is no longer
  visible (or whose guild's workspace was lost) never reach the wire — the buffer
  was filtered when written, but rights may have narrowed while the link was
  down. The re-derivation runs under the freshly verified identity (restrictions
  as of THIS resume, not the Identify-time snapshot). Dropped envelopes leave a
  seq GAP the client tolerates — its dispatch gate drops any `s` at or below the
  applied `lastSeq`, so a hole is just a larger step
  (`packages/state/src/reconcile.ts`).

  Returns `{visible, envelopes}` — the refreshed memo (the resumed socket
  re-derives lazily, so the caller may discard it) and the filtered envelopes.

  BOTH dialects are filtered, and native filtering is new with the durable
  offline buffer (hardening plan 4.2). Native used to replay byte-identically,
  which was only safe while the buffer could exclusively hold events the LIVE
  gate had already admitted — the socket's `visible_dispatch?/4` check is where
  channel visibility is enforced, and a session's held routes are every channel
  of every workspace it belongs to (`fanout_route_keys/2`).
  """
  @spec filter_replay(:native | :compat, visible() | nil, identity(), [map()], map() | nil) ::
          {visible() | nil, [map()]}
  def filter_replay(:native, visible, identity, envelopes, preloaded) do
    visible = refresh_visibility(visible, identity, preloaded: preloaded)

    {visible, kept} =
      Enum.reduce(envelopes, {visible, []}, fn env, {vis, acc} ->
        {vis, deliver?} = visible_dispatch?(vis, identity, env.t, env.d)
        if deliver?, do: {vis, [env | acc]}, else: {vis, acc}
      end)

    {visible, Enum.reverse(kept)}
  end

  def filter_replay(:compat, visible, identity, envelopes, preloaded) do
    visible = refresh_visibility(visible, identity, preloaded: preloaded)

    {visible, Enum.filter(envelopes, fn env -> replay_visible?(visible, identity, env) end)}
  end

  # Buffered envelopes are ALREADY translated (filtered at buffer time):
  # SCREAMING names, string channel/guild ids. Every KNOWN event type has an
  # explicit anchor clause; the DEFAULT clause is FAIL-CLOSED (drop + a
  # telemetry counter) — an unrecognized buffered envelope must never
  # over-deliver on replay.
  defp replay_visible?(visible, identity, %{t: "MESSAGE_CREATE", d: %{"channel_id" => channel_id}}),
    do: channel_visible_on_replay?(visible, identity, channel_id)

  defp replay_visible?(visible, identity, %{t: "MESSAGE_UPDATE", d: %{"channel_id" => channel_id}}),
    do: channel_visible_on_replay?(visible, identity, channel_id)

  defp replay_visible?(visible, identity, %{t: "MESSAGE_DELETE", d: %{"channel_id" => channel_id}}),
    do: channel_visible_on_replay?(visible, identity, channel_id)

  defp replay_visible?(visible, identity, %{t: "TYPING_START", d: %{"channel_id" => channel_id}}),
    do: channel_visible_on_replay?(visible, identity, channel_id)

  # MESSAGE_REACTION_* anchor on the reaction's channel (reactions ride the
  # message's parent channel partition — a thread message's reactions anchor
  # on the parent, never on a thread id).
  defp replay_visible?(visible, identity, %{
         t: "MESSAGE_REACTION_ADD",
         d: %{"channel_id" => channel_id}
       }),
       do: channel_visible_on_replay?(visible, identity, channel_id)

  defp replay_visible?(visible, identity, %{
         t: "MESSAGE_REACTION_REMOVE",
         d: %{"channel_id" => channel_id}
       }),
       do: channel_visible_on_replay?(visible, identity, channel_id)

  defp replay_visible?(visible, identity, %{
         t: "MESSAGE_REACTION_REMOVE_ALL",
         d: %{"channel_id" => channel_id}
       }),
       do: channel_visible_on_replay?(visible, identity, channel_id)

  # THREAD_* envelopes anchor on the thread's PARENT channel: parent_id when
  # the translation carried it, else resolved from the thread row.
  defp replay_visible?(visible, _identity, %{t: "THREAD_CREATE", d: %{} = d}),
    do: thread_envelope_visible?(visible, d)

  defp replay_visible?(visible, _identity, %{t: "THREAD_UPDATE", d: %{} = d}),
    do: thread_envelope_visible?(visible, d)

  defp replay_visible?(visible, _identity, %{t: "THREAD_DELETE", d: %{} = d}),
    do: thread_envelope_visible?(visible, d)

  # CHANNEL_* anchor on workspace membership, like GUILD_CREATE: the channel
  # row may already be gone (delete), and the translated envelope carries the
  # owning guild id — a nil guild_id (degraded delete lookup) is fail-closed.
  defp replay_visible?(visible, _identity, %{t: "CHANNEL_" <> _, d: %{"guild_id" => guild_id}})
       when is_binary(guild_id),
       do: guild_member?(visible, guild_id)

  defp replay_visible?(visible, _identity, %{t: "GUILD_CREATE", d: %{"id" => guild_id}}),
    do: guild_member?(visible, guild_id)

  # B-3: member/presence envelopes anchor on workspace membership (the
  # translated payloads carry the owning guild id).
  defp replay_visible?(visible, _identity, %{t: "GUILD_MEMBER_ADD", d: %{"guild_id" => guild_id}})
       when is_binary(guild_id),
       do: guild_member?(visible, guild_id)

  defp replay_visible?(visible, _identity, %{
         t: "GUILD_MEMBER_REMOVE",
         d: %{"guild_id" => guild_id}
       })
       when is_binary(guild_id),
       do: guild_member?(visible, guild_id)

  defp replay_visible?(visible, _identity, %{t: "GUILD_MEMBER_UPDATE", d: %{"guild_id" => guild_id}})
       when is_binary(guild_id),
       do: guild_member?(visible, guild_id)

  defp replay_visible?(visible, _identity, %{t: "PRESENCE_UPDATE", d: %{"guild_id" => guild_id}})
       when is_binary(guild_id),
       do: guild_member?(visible, guild_id)

  # Application-addressed (U8, KTD13): point-to-point to the bot's own
  # sessions — admitted at push time without the visibility filter, and the
  # replay keeps that contract (the callback gate is where restrictions
  # bite, not delivery).
  defp replay_visible?(_visible, _identity, %{t: "INTERACTION_CREATE"}), do: true

  defp replay_visible?(_visible, _identity, env) do
    :telemetry.execute(
      [:cytale, :gateway, :replay_dropped],
      %{count: 1},
      %{event: env[:t]}
    )

    false
  end

  # Thread replies translate to MESSAGE_CREATE ON the thread channel (the
  # buffered envelope carries the THREAD id as channel_id) — thread
  # visibility rides the PARENT channel's rights, so a channel_id that is
  # not itself visible is resolved through the thread row before the
  # membership test decides. DM channel ids (B-1) resolve through recipient
  # membership instead (DM-anchored envelopes carry no guild_id).
  defp channel_visible_on_replay?(visible, identity, channel_id) do
    id = int_id(channel_id)

    cond do
      visible_channel?(visible, id) ->
        true

      true ->
        case thread_parent(id) do
          parent when is_integer(parent) ->
            visible_channel?(visible, parent)

          _ ->
            case Workspaces.get_dm(id) do
              nil -> false
              dm -> dm_readable?(dm, identity)
            end
        end
    end
  end

  defp thread_envelope_visible?(visible, d) do
    case int_id(d["parent_id"]) || thread_parent(d["id"]) do
      parent when is_integer(parent) -> visible_channel?(visible, parent)
      _ -> false
    end
  end

  # The native MemberAdd's `kind` (absent on older payloads → a person).
  defp member_kind(kind) when kind in ["bot", "agent", "webhook"], do: String.to_existing_atom(kind)
  defp member_kind(_kind), do: :human
end
