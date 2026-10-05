defmodule Cytale.Permissions.Principal do
  @moduledoc """
  KTD3 (bots plan U3) — the ONE principal-rights resolver: effective rights
  = the parent's CURRENT rights ∩ restrictions, evaluated at check time
  (R1). `resolve/3` serves `RequirePermitted`, the gateway visibility filter
  (U7, later), and roster synthesis, so the intersection logic never forks
  per surface.

  * HUMANS (`kind: :human` or nil) — the permission plug's exact legacy
    path, extracted not rewritten: the workspace owner holds all bits; a
    member evaluates through the 8-step engine
    (`Cytale.Permissions.Behaviour`) over the @everyone base
    (view_channel + send_messages + start_call + send_video + share_screen)
    plus held roles plus channel overwrites.
  * MACHINE principals (:bot | :agent | :webhook) — the PARENT still plays
    the member (so an agent can never reach further than the user it acts
    for), and the AGENT'S ACCESS DOCUMENT decides what it may do inside that
    reach (`Cytale.Access`):

      effective = parent's bits ∩ Access.bits(level the document grants)

    The document is read fresh on every resolve and is FAIL-CLOSED: an
    absent, blank, corrupt or future-versioned document is the all-none
    document, so "no grants" — not "no restriction" — is what a missing
    policy means. This inverts the old model, where a machine principal
    inherited the parent's rights and a flat restriction map narrowed them.

    The level is resolved per workspace and per channel (a workspace grant
    applies to the channels inside it, including ones created later), which
    is why the workspace id rides the resolution context. A machine with no
    grant anywhere resolves to ZERO bits rather than `:forbidden`: the
    callers' view gate then renders the same anti-enumeration shape it gives
    any principal that cannot see a channel.

    `restrictions` (the legacy column) is retained but NO LONGER
    AUTHORITATIVE for machine principals — it is not consulted here.

  Oracle semantics match `RequirePermitted` exactly: an unknown workspace is
  `{:error, :not_found}`; a workspace that exists but does not know the
  (parent) actor is `{:error, :forbidden}` — never a membership oracle. A
  machine principal whose parent user row is gone (or deleted) fails closed.

  `resolve/3` itself never caches: every call re-reads roles and overwrites,
  so a parent's role change reflects on the sub-identity's NEXT resolve. The
  memoized entry point is `resolve_cached/3` (humans only), versioned by
  `Cytale.Permissions.RightsEpoch` (KTD4) like every downstream memo.

  Restrictions rows grow with the bitfield: `@action_bits` is the one place
  to extend when the action vocabulary widens.
  """

  alias Cytale.Access
  alias Cytale.Accounts.User
  alias Cytale.Permissions
  alias Cytale.Permissions.Bitfield
  alias Cytale.Repo
  alias Cytale.Workspaces

  @typedoc """
  Principal claims — the auth plug's `current_user` shape (U2). Humans carry
  `kind: :human` (or none, pre-U2 callers); machine principals carry their
  provenance and restrictions policy.
  """
  @type claims :: %{
          required(:user_id) => integer(),
          optional(:kind) => :human | :bot | :agent | :webhook | nil,
          optional(:parent_user_id) => integer() | nil,
          optional(:restrictions) => map() | nil
        }

  @machine_kinds ~w(bot agent webhook)a

  @doc """
  True when `kind` is a machine principal — the kinds whose reach is a GRANT
  (`Cytale.Access`) over the parent's, rather than membership of their own.
  The ONE list of them (`@machine_kinds`); callers that need to treat machine
  identities differently (the visibility memo's document re-read, KTD4) ask
  here rather than repeating the set.
  """
  @spec machine_kind?(term()) :: boolean()
  def machine_kind?(kind), do: kind in @machine_kinds

  @doc """
  Resolve `claims`'s effective permission bits in `workspace_id`, optionally
  scoped to `channel_id` (channel overwrites apply; the machine channel
  allowlist is enforced).

  Returns `{:ok, bits}` | `{:error, :not_found}` (unknown workspace) |
  `{:error, :forbidden}` (no membership / parent gone / allowlist miss).
  """
  @spec resolve(integer(), claims(), integer() | nil) ::
          {:ok, Bitfield.t()} | {:error, :not_found | :forbidden}
  def resolve(workspace_id, claims, channel_id \\ nil)

  def resolve(workspace_id, %{kind: kind} = claims, channel_id) when kind in @machine_kinds,
    do: resolve_one(workspace_id, claims, channel_id)

  def resolve(workspace_id, claims, channel_id) when is_map(claims),
    do: resolve_one(workspace_id, claims, channel_id)

  @doc """
  A DM PARTICIPANT's bits. For a person, participation is authorization (the
  full bitfield — Discord's DM rule). For a machine principal it is its access
  document's `dms` level: `:none` confers nothing (the DM is invisible to it),
  `:read` the read bits, `:read_write` the read/write bits — the same level →
  bits table the workspace grant uses (`Access.bits/1`), so no DM grant can
  reach a management bit.
  """
  @spec dm_bits(claims()) :: Bitfield.t()
  def dm_bits(%{kind: kind} = claims) when kind in @machine_kinds do
    doc = claims[:access] || Access.default()
    Access.bits(Access.dms_level(doc))
  rescue
    _ -> 0
  end

  def dm_bits(_claims), do: Bitfield.all()

  # Safety-net lifetime of a memoized resolve (`resolve_cached/3`). The epoch is
  # the invalidation; this only bounds how long a mutation path that forgot its
  # bump could serve old bits.
  @resolve_cache_ttl_ms 30_000

  @doc """
  `resolve/3` through the permission memo (`Cytale.Permissions.Cache`, review
  #19): the answer for `{user, workspace, channel}` is reused until the
  workspace's `RightsEpoch` moves — which every rights/membership mutation
  does (`Cytale.Workspaces` bumps at the data layer, after the write).

  The epoch is read BEFORE the compute and the entry is stored under it, so an
  answer computed from rows a concurrent mutation is replacing can never be
  served after that mutation's bump (see the Cache moduledoc).

  HUMAN claims only. A machine principal's answer also depends on its access
  document (and on its parent's liveness), which the auth path re-reads per
  request and which no workspace epoch versions — those resolve uncached,
  exactly as before. `{:error, :not_found}` (an unknown workspace) is never
  memoized. When the epoch owner is not running, everything resolves uncached.
  """
  @spec resolve_cached(integer(), claims(), integer() | nil) ::
          {:ok, Bitfield.t()} | {:error, :not_found | :forbidden}
  def resolve_cached(workspace_id, claims, channel_id \\ nil)

  def resolve_cached(workspace_id, %{kind: kind} = claims, channel_id) when kind in @machine_kinds,
    do: resolve(workspace_id, claims, channel_id)

  def resolve_cached(workspace_id, %{user_id: user_id} = claims, channel_id)
      when is_integer(workspace_id) and is_integer(user_id) do
    alias Cytale.Permissions.RightsEpoch

    with cache when not is_nil(cache) <- RightsEpoch.perm_cache(),
         epoch when is_integer(epoch) <- RightsEpoch.current_or_nil(workspace_id) do
      Cytale.Permissions.Cache.get_or_compute(
        cache,
        user_id,
        {workspace_id, channel_id},
        epoch,
        fn -> resolve(workspace_id, claims, channel_id) end,
        ttl_ms: @resolve_cache_ttl_ms,
        store?: &(&1 != {:error, :not_found})
      )
    else
      _no_memo -> resolve(workspace_id, claims, channel_id)
    end
  end

  def resolve_cached(workspace_id, claims, channel_id), do: resolve(workspace_id, claims, channel_id)

  @doc """
  Batch resolve: the same parent∩restrictions computation as `resolve/3`
  for every channel in `channel_ids` — the gateway's visible-set computation
  (U7) evaluates a whole workspace's channels in ONE call. The member +
  workspace roles load ONCE and the WHOLE channel set's overwrites load in
  ONE `IN ?` read (PERF-4); the per-channel work is in-memory evaluation +
  restrictions, through the SAME internals `resolve/3` runs (the
  single-channel resolve delegates to them — the seam never forks).

  Returns `{:ok, %{channel_id => {:ok, bits} | {:error, :forbidden}}}` (an
  allowlist miss is the only per-channel failure), or the context-level
  `{:error, :not_found | :forbidden}` every channel would have returned.
  """
  @spec resolve_channels(integer(), claims(), [integer()]) ::
          {:ok, %{optional(integer()) => {:ok, Bitfield.t()} | {:error, :forbidden}}}
          | {:error, :not_found | :forbidden}
  def resolve_channels(workspace_id, claims, channel_ids)
      when is_integer(workspace_id) and is_map(claims) and is_list(channel_ids) do
    with {:ok, ctx} <- load_context(workspace_id, claims) do
      # PERF-4 (B4): the whole channel set's overwrites load in ONE `IN`
      # read (the messages.ex embed-join precedent) — the former per-channel
      # load_overwrites was one query per channel. Owners never read
      # overwrites at all (full bits before restrictions).
      overwrites_by_channel = batch_overwrites(ctx, channel_ids)

      {:ok,
       Map.new(channel_ids, fn channel_id ->
         {channel_id, rights_for_channel(ctx, channel_id, overwrites_by_channel)}
       end)}
    end
  end

  # -- many-principal resolution (hardening PERF-2) --------------------------------

  @doc """
  Batch resolve across USERS (hardening PERF-2): the same result as
  `resolve/3` for each PLAIN user id (`%{user_id: id}` human claims — the
  shape the mention recorder asks with), scoped to ONE channel, with the
  workspace and channel rows read ONCE for the whole set:

    * the workspace row (owner) — one read, shared;
    * the channel's overwrites — one read, shared (skipped entirely when
      every named user is the owner, exactly as `resolve/3` skips it);
    * the membership rows — ONE `user_id IN ?` read inside the workspace
      partition, and the union of every member's role ids in ONE `role_id IN ?`
      read (the PERF-4 precedent). Per-user work is then purely in-memory:
      owner check, role-input assembly through the SAME `role_inputs/2`
      builder `load_member_roles/2` uses, and the same 8-step evaluation +
      grant `resolve/3` runs. The seam does not fork — a user's bits here are
      bit-for-bit `resolve/3`'s answer for them.

  Returns `{:ok, %{user_id => {:ok, bits} | {:error, :forbidden}}}`, or the
  context-level `{:error, :not_found}` (unknown workspace) every user would
  have returned. Machine-kind claims are deliberately out of scope: a mention
  token names a USER, and `%{user_id: id}` resolves as a human — the same
  reading `resolve/3` gives that shape.
  """
  @spec resolve_many(integer(), [integer()], integer()) ::
          {:ok, %{optional(integer()) => {:ok, Bitfield.t()} | {:error, :forbidden}}}
          | {:error, :not_found}
  def resolve_many(workspace_id, user_ids, channel_id)
      when is_integer(workspace_id) and is_list(user_ids) and is_integer(channel_id) do
    user_ids = Enum.uniq(user_ids)
    owner_id = workspace_owner(workspace_id)

    cond do
      # Unknown workspace → 404 semantics, never a permission oracle.
      is_nil(owner_id) ->
        {:error, :not_found}

      true ->
        non_owners = Enum.reject(user_ids, &(&1 == owner_id))

        # Owners never read overwrites or roles (full bits before
        # restrictions) — so a set of owners alone does no data reads at all.
        overwrites =
          if non_owners == [] do
            %{}
          else
            batch_overwrites(%{owner?: false}, [channel_id])
          end

        roles_of = member_roles_by_user(workspace_id, non_owners)

        # ONE read for the UNION of every member's held roles (a single
        # workspace partition); per-member input lists are then assembled
        # in memory. Empty union → no roles read at all.
        role_rows_by_id =
          roles_of
          |> Map.values()
          |> List.flatten()
          |> Enum.uniq()
          |> then(&roles_by_id(workspace_id, &1))

        all_role_rows = Map.values(role_rows_by_id)

        {:ok,
         Map.new(user_ids, fn user_id ->
           {user_id, rights_for_user(user_id, owner_id, workspace_id, channel_id, roles_of, all_role_rows, overwrites)}
         end)}
    end
  end

  # One user's answer inside a preloaded context — the shared internals
  # (`rights_for_channel`/`grant`) do the evaluation, so this is `resolve/3`
  # with the reads hoisted, not a second evaluator.
  defp rights_for_user(user_id, owner_id, workspace_id, channel_id, roles_of, all_role_rows, overwrites) do
    cond do
      user_id == owner_id ->
        # The workspace OWNER holds implicit full permissions (Discord R5);
        # humans carry no access document, so grant/2 passes the bits through.
        grant(Bitfield.all(), %{policy: nil}, channel_id)

      true ->
        case Map.get(roles_of, user_id) do
          nil ->
            {:error, :forbidden}

          role_ids ->
            # The same rows, filtered to this member's ids, in the same
            # clustering order `load_member_roles/2`'s single-user read
            # returns them — identical inputs to the 8-step engine.
            role_rows = Enum.filter(all_role_rows, &(&1["role_id"] in role_ids))

            ctx = %{
              owner?: false,
              member_id: user_id,
              member_roles: role_inputs(workspace_id, role_rows),
              policy: nil,
              workspace_id: workspace_id
            }

            rights_for_channel(ctx, channel_id, overwrites)
        end
    end
  end

  # Membership rows for MANY users in ONE read (single workspace partition,
  # `user_id IN ?` over the clustering key). Absent users are absent from the
  # map (the `{:error, :forbidden}` case).
  defp member_roles_by_user(_workspace_id, []), do: %{}

  defp member_roles_by_user(workspace_id, user_ids) do
    Repo.query!(
      "SELECT user_id, roles FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id IN ?",
      [{"bigint", workspace_id}, {"list<bigint>", user_ids}]
    )
    |> Enum.to_list()
    # An empty list<bigint> round-trips back as nil through Xandra —
    # normalize so the @everyone-only member path never sees nil.
    |> Map.new(fn row -> {row["user_id"], row["roles"] || []} end)
  end

  # The union read as a lookup map (empty union reads nothing).
  defp roles_by_id(_workspace_id, []), do: %{}

  defp roles_by_id(workspace_id, role_ids) do
    load_roles(workspace_id, role_ids)
    |> Map.new(fn row -> {row["role_id"], row} end)
  end

  # -- the single-principal internals (resolve/3's own path) ----------------------

  defp resolve_one(workspace_id, claims, channel_id) do
    with {:ok, ctx} <- load_context(workspace_id, claims) do
      rights_for_channel(ctx, channel_id, batch_overwrites(ctx, [channel_id]))
    end
  end

  # The pre-channel context: WHO plays the member in this workspace (the
  # machine's parent — R1; the human themself), whether that user is the
  # owner, the member roles when not, and the restrictions policy to
  # intersect. Loaded once per resolve — and once for a whole channel page
  # through resolve_channels/3.
  defp load_context(workspace_id, claims) do
    case actor_of(claims) do
      {:machine, parent_user_id, access} ->
        cond do
          is_nil(parent_user_id) ->
            {:error, :forbidden}

          not parent_alive?(parent_user_id) ->
            # Fail closed: a machine principal outliving its parent user row
            # resolves to nothing (no rights, no membership oracle).
            {:error, :forbidden}

          true ->
            owner_or_member(workspace_id, parent_user_id, {:access, access})
        end

      {:human, user_id} ->
        owner_or_member(workspace_id, user_id, nil)
    end
  end

  defp actor_of(%{kind: kind} = claims) when kind in @machine_kinds do
    # An absent document is the all-none default, never "unrestricted": claims
    # built by hand (or before a grant exists) grant nothing.
    {:machine, claims[:parent_user_id], claims[:access] || Access.default()}
  end

  defp actor_of(%{user_id: user_id}), do: {:human, user_id}

  # `policy` is the machine principal's access document or nil for humans; it
  # rides the context so the per-channel evaluation never re-reads it.
  defp owner_or_member(workspace_id, user_id, policy) do
    case workspace_owner(workspace_id) do
      # Unknown workspace → 404 semantics (never a permission oracle).
      nil ->
        {:error, :not_found}

      # The workspace OWNER holds implicit full permissions (Discord R5);
      # owner-exempt flows THROUGH the parent for machines, then intersects
      # restrictions in rights_for_channel below.
      ^user_id ->
        {:ok, %{owner?: true, member_roles: [], policy: policy, workspace_id: workspace_id}}

      _owner_id ->
        case load_member_roles(workspace_id, user_id) do
          {:ok, roles} ->
            # `member_id` is WHO plays the member (the machine's parent for a
            # bot/agent): steps 7–8 apply only that user's member overwrites.
            {:ok, %{owner?: false, member_id: user_id, member_roles: roles, policy: policy, workspace_id: workspace_id}}

          # The workspace exists but does not know the actor (or the machine's
          # parent) → the sub-identity is a nobody here.
          {:error, :not_found} ->
            {:error, :forbidden}
        end
    end
  end

  # Humans (and machine parents) evaluate through the 8-step engine
  # (`Cytale.Permissions.Behaviour`) over the @everyone base plus held roles
  # plus the channel's overwrites; machines then intersect restrictions.
  # `overwrites_by_channel` is the batched page read (resolve_channels) or a
  # single-entry map (resolve_one) — the evaluation itself is shared.
  #
  # The VIEW GATE (Discord semantics): at channel scope, a principal without
  # VIEW_CHANNEL holds NO channel bits at all — "cannot see, but can send /
  # read history / react" is not a state any surface may act on. Applied here,
  # on the one resolver, so REST, the gateway and the compat dialect agree.
  defp rights_for_channel(ctx, channel_id, overwrites_by_channel) do
    case channel_bits(ctx, channel_id, overwrites_by_channel) do
      {:ok, bits} when not is_nil(channel_id) ->
        if Bitfield.has?(bits, :view_channel), do: {:ok, bits}, else: {:ok, 0}

      other ->
        other
    end
  end

  defp channel_bits(%{owner?: true} = ctx, channel_id, _overwrites_by_channel),
    do: grant(Bitfield.all(), ctx, channel_id)

  defp channel_bits(
         %{owner?: false, member_roles: roles, member_id: member_id} = ctx,
         channel_id,
         overwrites_by_channel
       )
       when is_integer(member_id) do
    overwrites = Map.get(overwrites_by_channel, channel_id, [])
    # `member_id:` is load-bearing: without it the engine applies EVERY member
    # overwrite on the channel to whoever is being resolved — one member's
    # allow (or deny) would reach every other member.
    bits = Permissions.Behaviour.evaluate(Permissions.ElixirImpl, roles, overwrites, member_id: member_id)
    grant(bits, ctx, channel_id)
  end

  # -- the agent's grant (KTD3: one mapping, every surface) ---------------------

  # Humans carry no document: their bits are their bits.
  defp grant(bits, %{policy: nil}, _channel_id), do: {:ok, bits}

  # A machine's effective bits are its PARENT'S reach intersected with what the
  # document grants at this workspace/channel. The intersection is the whole
  # safety story: a grant can only narrow the user's own access, never widen it,
  # and an ungranted node contributes zero bits.
  defp grant(parent_bits, %{policy: {:access, doc}, workspace_id: workspace_id}, channel_id) do
    level =
      if is_nil(channel_id),
        do: Access.level_for_workspace(doc, workspace_id),
        else: Access.level_for_channel(doc, workspace_id, channel_id)

    {:ok, Bitwise.band(parent_bits, Access.bits(level))}
  end

  # -- membership + evaluation ---------------------------------------------------

  defp parent_alive?(parent_user_id) do
    case User.get(parent_user_id) do
      %{deleted_at: nil} -> true
      _ -> false
    end
  end

  defp workspace_owner(workspace_id) do
    case Workspaces.get_workspace(workspace_id) do
      %{owner_id: owner} -> owner
      _ -> nil
    end
  end

  # -- data loading (partition-keyed point queries only) --------------------------

  @doc """
  Member roles for the user in a workspace: the @everyone role shape plus
  every role row the member holds, as U7 `role_input` maps. (Extracted
  verbatim from `CytaleWeb.Plugs.RequirePermitted`, which now delegates
  here.)
  """
  @spec load_member_roles(integer(), integer()) :: {:ok, [map()]} | {:error, :not_found}
  def load_member_roles(workspace_id, user_id) do
    member_rows =
      Repo.query!(
        "SELECT user_id, roles FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id = ?",
        [{"bigint", workspace_id}, {"bigint", user_id}]
      )
      |> Enum.to_list()

    case member_rows do
      [%{"roles" => role_ids}] ->
        # An empty list<bigint> round-trips back as nil through Xandra —
        # normalize so the @everyone-only member path never sees nil.
        role_ids = role_ids || []
        role_rows = load_roles(workspace_id, role_ids)

        {:ok, role_inputs(workspace_id, role_rows)}

      _ ->
        {:error, :not_found}
    end
  end

  # The U7 `role_input` list for a member: the @everyone base plus one input
  # per held role row. The ONE construction — `load_member_roles/2` and
  # `resolve_many/3` both build it through here, so the single-member and the
  # many-member resolution can never fork on the base or the shape.
  defp role_inputs(workspace_id, role_rows) do
    [everyone_role(workspace_id) | Enum.map(role_rows, &role_input/1)]
  end

  # @everyone base: view + send + start-call (voice plan U3, KTD7 —
  # resolve-time default-on, NOT an @everyone roles row: there is no
  # @everyone row anywhere, the base is synthesized here, so every
  # member of every existing and new workspace gains START_CALL with
  # no data fix and stays channel-overridable through the normal
  # 8-step engine below). Members join via invites carrying no
  # explicit roles — without the send bit every non-owner member lands
  # permanently mute (view-only @everyone + admin-only role creation
  # never intersect).
  #
  # ADD_REACTIONS (Tier 3 B, 10c) joins it too: the reaction add route now
  # CHECKS the bit, so it must be default-on for members (Discord's
  # @everyone default) and deniable per channel through an overwrite.
  #
  # Calls V2 plan U2 (R13/VM7): SEND_VIDEO + SHARE_SCREEN join the
  # same resolve-time base by the same START_CALL precedent —
  # default-on for every member, channel-overridable through the normal
  # 8-step engine, no data fix.
  #
  # CHANGE_NICKNAME (#169) joins it by the same precedent: every member may
  # set their own workspace nickname (Discord's @everyone default), with no
  # data fix for existing workspaces.
  defp everyone_role(workspace_id) do
    %{
      id: {:everyone, workspace_id},
      permissions:
        Enum.reduce(
          [
            :view_channel,
            :send_messages,
            :add_reactions,
            :start_call,
            :send_video,
            :share_screen,
            :change_nickname
          ],
          0,
          &Bitfield.bor(Bitfield.bit(&1), &2)
        ),
      everyone: true,
      position: 0
    }
  end

  defp role_input(r) do
    %{
      id: r["role_id"],
      permissions: r["permissions"],
      everyone: false,
      position: r["position"]
    }
  end

  defp load_roles(_workspace_id, []), do: []

  defp load_roles(workspace_id, role_ids) do
    # A single-partition multi-clustering read (hardening plan 5.7): `roles` is
    # keyed `(workspace_id, role_id)`, so `role_id IN ?` reads exactly the roles
    # this member holds. The old shape read the workspace's ENTIRE roles
    # partition and filtered in memory, which made every REST gate and gateway op
    # scale with the workspace's total role count — a 100-role workspace paid 100
    # decoded rows to evaluate one member's three.
    Repo.query!(
      "SELECT role_id, name, permissions, position FROM {{K}}.roles WHERE workspace_id = ? AND role_id IN ?",
      [{"bigint", workspace_id}, {"list<bigint>", Enum.uniq(role_ids)}]
    )
    |> Enum.to_list()
  end

  # Channel overwrites for a whole channel set in ONE `IN ?` read
  # (partition keys — the messages.ex embed-join bind precedent). Owners
  # never need them (full bits before restrictions), and a nil channel id
  # (workspace-level evaluation) simply resolves to no overwrites.
  defp batch_overwrites(%{owner?: true}, _channel_ids), do: %{}

  defp batch_overwrites(%{owner?: false}, channel_ids) do
    channel_ids = channel_ids |> Enum.reject(&is_nil/1) |> Enum.uniq()

    if channel_ids == [] do
      %{}
    else
      rows =
        Repo.query!(
          ~s'SELECT channel_id, target_id, target_type, "allow", "deny" FROM {{K}}.channel_overwrites WHERE channel_id IN ?',
          [{"list<bigint>", channel_ids}]
        )
        |> Enum.to_list()

      rows
      |> Enum.group_by(& &1["channel_id"], &overwrite_input/1)
    end
  end

  # A NULL bitfield column is NO BITS, not a crash. This was found the hard way:
  # `ElixirImpl.apply_stage/2` reduces the overwrite set with `Bitwise.bor/2`, and
  # a single null `allow`/`deny` raised `:erlang.bor(0, nil)` inside the SESSION's
  # visibility computation — which happens on the socket process, so the socket
  # closed 4000 at Identify. Nil-tolerance belongs here, at the one place a row
  # becomes an overwrite input (the semantics of a missing mask are "none").
  defp overwrite_input(r) do
    %{
      target_id: r["target_id"],
      target_type: if(r["target_type"] == 0, do: :role, else: :member),
      allow: r["allow"] || 0,
      deny: r["deny"] || 0
    }
  end
end
