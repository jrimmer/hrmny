defmodule Cytale.Workspaces do
  @moduledoc """
  Workspace + channel + membership persistence (U9): the CRUD layer under the
  REST controllers. Partition-key-first queries only — no joins, no
  ALLOW FILTERING. All ids are integer snowflakes; string conversion is the
  controllers' boundary job.
  """

  require Logger

  alias Cytale.Repo

  # How many times a contended invite reservation re-reads before refusing. The
  # contention is two people accepting the SAME code at the same moment.
  @invite_lwt_attempts 8

  # -- workspaces ----------------------------------------------------------------

  @doc "Create a workspace; the creator becomes owner and first member."
  @spec create_workspace(integer(), String.t()) :: {:ok, map()} | {:error, :invalid_name | :name_taken}
  def create_workspace(owner_id, name) when is_binary(name) and byte_size(name) >= 2 and byte_size(name) <= 100 do
    # Names are unique INSTANCE-WIDE, case-insensitively (owner direction
    # 2026-09-15). The claim is a lightweight transaction: exactly one of two
    # concurrent creates for the same name wins, before any workspace row is
    # written.
    name_lower = String.downcase(name)

    # The id is minted BEFORE the claim, and the claim carries it (hardening plan
    # 4.11). It used to be minted later, so the LWT wrote a THROWAWAY snowflake
    # and a second plain INSERT overwrote it with the real id — which meant a
    # crash between the two left the name claimed by an id belonging to nothing,
    # permanently blocking a name that no workspace actually held. Now the claim
    # always names the real workspace, so that state is at least detectable.
    workspace_id = Cytale.Snowflake.next()

    case claim_workspace_name(name_lower, workspace_id) do
      :ok ->
        try do
          create_workspace_claimed(owner_id, name, workspace_id)
        rescue
          e ->
            # The claim is released on ANY failure, which is what makes this a
            # fix rather than a tidier ordering: previously a failed create (a
            # write error, a crashed member insert) burned the name forever, and
            # nothing could tell a real claim from a phantom.
            rollback_workspace_create(workspace_id, owner_id, name_lower)
            reraise e, __STACKTRACE__
        end

      :error ->
        {:error, :name_taken}
    end
  end

  def create_workspace(_owner_id, _name), do: {:error, :invalid_name}

  defp create_workspace_claimed(owner_id, name, workspace_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.workspaces (workspace_id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
      [{"bigint", workspace_id}, {"text", name}, {"bigint", owner_id}, {"timestamp", now}]
    )

    # NO second `workspaces_by_name` write: the LWT claim above already inserted
    # that row, with this exact workspace_id. The old code re-INSERTed it purely
    # to correct the throwaway id it had written — a redundant round trip that
    # only existed because of the ordering this change removes.
    :ok = add_member(workspace_id, owner_id, owner_id, [])

    {:ok,
     %{
       workspace_id: workspace_id,
       name: name,
       owner_id: owner_id,
       created_at: now,
       icon_url: nil
     }}
  end

  # Undo a partially-written create, called only from the error path.
  #
  # The guarantee is about EXCEPTIONS, not crashes, and the difference is worth
  # stating exactly: the durable writes a create can make are undone in reverse
  # order, so a create that FAILS returns the instance to its previous state. A
  # process killed between the claim and the row write (SIGKILL, OOM, a deploy)
  # runs no rescue at all, so it can still leave a claim whose workspace does not
  # exist — the state this item set out to remove. What changed is that the claim
  # now names the REAL workspace id, so that phantom is identifiable
  # (`workspaces_by_name` naming an id with no `workspaces` row) and can be
  # reconciled; the throwaway id it used to hold made it indistinguishable from a
  # live claim. Releasing the claim alone would not be enough even here: the
  # `workspaces` row is written before the member rows, so a failure in
  # `add_member` would otherwise leave a workspace no one can see while its NAME
  # went back on the market, i.e. two workspaces under one name.
  defp rollback_workspace_create(workspace_id, owner_id, name_lower) do
    safe(fn -> remove_member(workspace_id, owner_id) end)
    safe(fn -> delete_workspace_row(workspace_id) end)
    safe(fn -> release_workspace_name(name_lower) end)
    :ok
  end

  # Best-effort execution: on a rollback path no cleanup step may replace the
  # original failure with one of its own, so every step is independently
  # forgiving rather than chained inside one rescue.
  defp safe(fun) do
    fun.()
    :ok
  rescue
    _ -> :ok
  end

  defp delete_workspace_row(workspace_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.workspaces WHERE workspace_id = ?",
      [{"bigint", workspace_id}]
    )

    rights_changed(workspace_id)
  end

  # The atomic claim. `Repo.execute` (not !) so an errored LWT is a refusal,
  # never a crash — the same posture as the webauthn credential-id claim.
  #
  # The claimed id is the workspace's REAL id, passed in by the caller. An LWT
  # that errors is reported as `:error`, which callers must read as "not
  # claimed" — do NOT invent a third state here: an errored LWT may or may not
  # have applied, and treating it as a refusal is what makes concurrent creates
  # safe.
  #
  # The uncertainty is cleaned up rather than merely acknowledged: before
  # answering `:error` the claim is released IF it holds OUR id. That is a no-op
  # when the LWT did not apply (the row, if any, names another workspace) and
  # removes the phantom when it did, so a write timeout cannot burn a name for
  # good. It only works because the claim carries the real id — a conditional
  # release of a throwaway id could not tell our own row from a stranger's.
  defp claim_workspace_name(name_lower, workspace_id) do
    case Repo.execute(
           "INSERT INTO {{K}}.workspaces_by_name (name_lower, workspace_id) VALUES (?, ?) IF NOT EXISTS",
           [{"text", name_lower}, {"bigint", workspace_id}]
         ) do
      {:ok, page} ->
        case page |> Enum.to_list() |> List.first() do
          %{"[applied]" => true} ->
            :ok

          _other ->
            # A genuine duplicate: the row belongs to another workspace, so there
            # is nothing of ours to clean up and no release is attempted. Stated
            # so the two error paths are not read as one.
            :error
        end

      {:error, _reason} ->
        safe(fn -> release_workspace_name_if_ours(name_lower, workspace_id) end)
        :error
    end
  end

  @doc """
  Release a name claim ONLY if it holds this exact workspace id — the LWT
  counterpart of `release_workspace_name/1`.

  Safe against any concurrent claimer for the same name: the id is a snowflake
  this caller minted, so a row naming it cannot belong to anyone else. Used to
  clean up after an LWT that may or may not have applied (a write timeout), where
  an unconditional release would be right only half the time.
  """
  @spec release_workspace_name_if_ours(String.t(), integer()) :: :ok
  def release_workspace_name_if_ours(name_lower, workspace_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.workspaces_by_name WHERE name_lower = ? IF workspace_id = ?",
      [{"text", name_lower}, {"bigint", workspace_id}]
    )

    :ok
  end

  # Give back a name claim. Note this does NOT check who holds the claim: it is
  # only ever called for a claim this process just took, immediately after
  # deciding not to keep it.
  defp release_workspace_name(name_lower) do
    Repo.execute!(
      "DELETE FROM {{K}}.workspaces_by_name WHERE name_lower = ?",
      [{"text", name_lower}]
    )

    :ok
  end

  @doc "Fetch a workspace."
  @spec get_workspace(integer()) :: map() | nil
  def get_workspace(workspace_id) do
    # Prepared (review #23): the permission resolve reads it per gated request.
    rows =
      Repo.query!(
        "SELECT workspace_id, name, owner_id, created_at, icon_url, deleted_at FROM {{K}}.workspaces WHERE workspace_id = ?",
        [{"bigint", workspace_id}]
      )
      |> Enum.to_list()

    # A tombstoned (deleted) workspace reads as absent — this one read is what
    # every gate (the permission resolver, the hierarchy gate, the controllers'
    # existence checks, invites) consults, so the tombstone refuses them all.
    case rows do
      [%{"deleted_at" => nil} = r] -> row_to_workspace(r)
      _ -> nil
    end
  end

  # The one workspace-row projection (the point read above and the batched
  # membership read in `workspaces_of_user/1` must not drift).
  defp row_to_workspace(r) do
    %{
      workspace_id: r["workspace_id"],
      name: r["name"],
      owner_id: r["owner_id"],
      created_at: r["created_at"],
      icon_url: r["icon_url"]
    }
  end

  @doc """
  Delete a workspace (owner surface) — the synchronous half.

    1. TOMBSTONE first: `deleted_at` on the row makes `get_workspace/1` answer
       nil, so every gate refuses the workspace from this write on (and its
       invites with it — `get_invite/1` refuses a code whose workspace is
       gone). The rights epoch bump drops every memoized resolve.
    2. The name claim is released, so the name can be used again.
    3. Every channel's webhooks are deleted — the unauthenticated execute
       route checks only the webhook row and its channel, not the workspace.
    4. Every human membership row is removed (ids read uncapped, via
       `list_member_ids/1`).

  Returns `{:ok, %{member_ids: ids, channel_ids: ids}}` so the caller can tell
  the members' live sessions and release their routes, then hand the channel
  rows to `purge_workspace_channels/2` (asynchronous: the tombstone already
  made them unreachable). Messages are left in place, unreachable: every read
  of one goes through its channel row and then the workspace.
  """
  @spec delete_workspace(integer()) ::
          {:ok, %{member_ids: [integer()], channel_ids: [integer()]}} | {:error, :not_found}
  def delete_workspace(workspace_id) when is_integer(workspace_id) do
    case get_workspace(workspace_id) do
      nil ->
        {:error, :not_found}

      ws ->
        now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

        Repo.execute!(
          "UPDATE {{K}}.workspaces SET deleted_at = ? WHERE workspace_id = ?",
          [{"timestamp", now}, {"bigint", workspace_id}]
        )

        Cytale.Permissions.RightsEpoch.bump(workspace_id)

        safe(fn -> release_workspace_name_if_ours(String.downcase(ws.name), workspace_id) end)

        channel_ids = Enum.map(list_channels(workspace_id), & &1.channel_id)
        Enum.each(channel_ids, &Cytale.Webhooks.delete_for_channel/1)

        member_ids = list_member_ids(workspace_id)
        Enum.each(member_ids, &remove_member(workspace_id, &1))

        {:ok, %{member_ids: member_ids, channel_ids: channel_ids}}
    end
  end

  @doc """
  The asynchronous half of `delete_workspace/1`: drop the tombstoned
  workspace's channel rows (both write paths, the route cache, any webhook
  that raced the synchronous sweep). Idempotent and best-effort per channel.
  """
  @spec purge_workspace_channels(integer(), [integer()]) :: :ok
  def purge_workspace_channels(workspace_id, channel_ids) when is_integer(workspace_id) do
    Enum.each(channel_ids, fn channel_id -> safe(fn -> delete_channel(channel_id) end) end)
    :ok
  end

  @doc """
  Rename (admin surface).

  Renaming has to move the instance-wide name claim, not just the display name
  (hardening plan 4.11 / owner decision O2): it claims the NEW name with the
  LWT, writes the row, then releases the OLD claim. A rename that only updated
  `workspaces.name` left the old claim behind and the new name unclaimed, so
  another workspace could be created under the new name — two workspaces sharing
  a name, which is exactly what the table exists to prevent.
  """
  @spec rename_workspace(integer(), String.t()) ::
          :ok | {:error, :invalid_name | :name_taken | :not_found}
  def rename_workspace(workspace_id, name)
      when is_binary(name) and byte_size(name) >= 2 and byte_size(name) <= 100 do
    new_lower = String.downcase(name)

    case get_workspace(workspace_id) do
      nil ->
        {:error, :not_found}

      %{name: current_name} ->
        old_lower = String.downcase(current_name)

        # Same claim key (an identical or case-only rename): there is nothing to
        # claim or release — the LWT would report `:error` against our own row
        # and turn a trivial case fix into a false "name taken".
        if new_lower == old_lower do
          write_workspace_name(workspace_id, name)
        else
          case claim_workspace_name(new_lower, workspace_id) do
            :ok ->
              try do
                write_workspace_name(workspace_id, name)
                safe(fn -> release_workspace_name(old_lower) end)
                :ok
              rescue
                e ->
                  # The new claim is given back so a failed rename leaves the
                  # workspace under its old, still-claimed name rather than
                  # squatting on a name it does not display.
                  safe(fn -> release_workspace_name(new_lower) end)
                  reraise e, __STACKTRACE__
              end

            :error ->
              {:error, :name_taken}
          end
        end
    end
  end

  def rename_workspace(_, _), do: {:error, :invalid_name}

  defp write_workspace_name(workspace_id, name) do
    Repo.execute!(
      "UPDATE {{K}}.workspaces SET name = ? WHERE workspace_id = ?",
      [{"text", name}, {"bigint", workspace_id}]
    )

    :ok
  end

  @doc """
  Set/clear the workspace icon url (admin surface; the url is an
  attachment-path value minted by the icon upload endpoint, or nil to clear).
  """
  @spec set_icon(integer(), String.t() | nil) :: :ok
  def set_icon(workspace_id, icon_url) when is_binary(icon_url) or is_nil(icon_url) do
    Repo.execute!(
      "UPDATE {{K}}.workspaces SET icon_url = ? WHERE workspace_id = ?",
      [{"text", icon_url}, {"bigint", workspace_id}]
    )

    :ok
  end

  @doc """
  Id-only variant of `workspaces_of_user/1` for fan-out callers that need
  no workspace rows (UserUpdate publish, gateway route joins): the same
  partition read plus parent-principal fallback, WITHOUT the per-workspace
  `get_workspace` point reads.
  """
  @spec workspace_ids_of_user(integer()) :: [integer()]
  def workspace_ids_of_user(user_id) do
    rows =
      Repo.execute!(
        "SELECT workspace_id FROM {{K}}.workspaces_of_user WHERE user_id = ?",
        [{"bigint", membership_owner_id(user_id)}]
      )
      |> Enum.to_list()

    Enum.map(rows, & &1["workspace_id"])
  end

  @doc """
  Workspaces the user belongs to (workspaces_of_user partition). Machine
  principals carry no membership rows of their own — R1 derives their
  membership from the parent — so a principal resolves through
  `principals.parent_user_id` (one point read) to the parent's rows. This is
  the index the gateway's join_fanout_routes/presence announce consume:
  without the fallback a `cytbot_` socket subscribes to nothing.
  """
  @spec workspaces_of_user(integer()) :: [map()]
  def workspaces_of_user(user_id) do
    rows =
      Repo.execute!(
        "SELECT workspace_id FROM {{K}}.workspaces_of_user WHERE user_id = ?",
        [{"bigint", membership_owner_id(user_id)}]
      )
      |> Enum.to_list()

    ids = Enum.map(rows, & &1["workspace_id"])

    # ONE point read for the whole membership set (hardening plan 5.8):
    # `workspaces` is keyed by `workspace_id`, so `IN ?` is a single-partition-key
    # batch. The old shape called `get_workspace/1` once per membership, which is
    # the gateway's join/presence path paying one round trip per workspace a
    # member belongs to.
    case ids do
      [] ->
        []

      _ ->
        Repo.execute!(
          "SELECT workspace_id, name, owner_id, created_at, icon_url, deleted_at FROM {{K}}.workspaces WHERE workspace_id IN ?",
          [{"list<bigint>", ids}]
        )
        |> Enum.to_list()
        |> Enum.filter(&is_nil(&1["deleted_at"]))
        |> Enum.map(&row_to_workspace/1)
    end
  end

  # R1 membership derivation: a machine principal belongs where its PARENT
  # belongs; its own workspaces_of_user partition is empty by design.
  defp membership_owner_id(user_id) do
    case Cytale.Accounts.Principals.get(user_id) do
      %{parent_user_id: parent_user_id} -> parent_user_id
      nil -> user_id
    end
  end

  # -- membership ------------------------------------------------------------------

  @doc "Add a member. Creates the @everyone role assignment context implicitly."
  @spec add_member(integer(), integer(), integer(), [integer()]) :: :ok
  def add_member(workspace_id, user_id, _invited_by, roles \\ []) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.workspace_members (workspace_id, user_id, nickname, joined_at, roles) VALUES (?, ?, ?, ?, ?)",
      [
        {"bigint", workspace_id},
        {"bigint", user_id},
        {"text", nil},
        {"timestamp", now},
        {"list<bigint>", roles}
      ]
    )

    Repo.execute!(
      "INSERT INTO {{K}}.workspaces_of_user (user_id, workspace_id) VALUES (?, ?)",
      [{"bigint", user_id}, {"bigint", workspace_id}]
    )

    rights_changed(workspace_id)
  end

  # Every write that can change what a member's resolve returns — membership,
  # role rows, held roles, overwrites, the workspace row — bumps the
  # workspace's `RightsEpoch` HERE, at the data layer, AFTER the write. The
  # permission memo (`Principal.resolve_cached/3`) and the gateway visibility
  # memo are versioned by that epoch, so a bump is what makes the next check
  # see the new rows. The controllers bumped some of these paths already; a
  # data-layer bump is what covers every caller (compat routes, the deletion
  # sweep, tests, future surfaces) instead of trusting each one to remember.
  # A redundant bump costs one recompute, never correctness.
  defp rights_changed(workspace_id) when is_integer(workspace_id) do
    Cytale.Permissions.RightsEpoch.bump_quietly(workspace_id)
  end

  defp rights_changed(_workspace_id), do: :ok

  # An overwrite is keyed by channel: its workspace comes from the route cache
  # when warm, else from the channel row.
  defp channel_rights_changed(channel_id) do
    case Cytale.Publish.ChannelRoutes.fetch(channel_id) do
      {:ok, workspace_id} ->
        rights_changed(workspace_id)

      :error ->
        case get_channel(channel_id) do
          %{workspace_id: workspace_id} -> rights_changed(workspace_id)
          _ -> :ok
        end
    end
  end

  @doc "Member row for a user in a workspace (nil when not a member)."
  @spec get_member(integer(), integer()) :: map() | nil
  def get_member(workspace_id, user_id) do
    rows =
      Repo.execute!(
        "SELECT workspace_id, user_id, nickname, joined_at, roles FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id = ?",
        [{"bigint", workspace_id}, {"bigint", user_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] ->
        %{
          workspace_id: r["workspace_id"],
          user_id: r["user_id"],
          nickname: r["nickname"],
          joined_at: r["joined_at"],
          roles: r["roles"]
        }

      [] ->
        nil
    end
  end

  @doc """
  Member directory page (people query, U24/U26 contract): partition-keyed
  read of workspace_members, `before`-cursor paginated by user_id, name
  filter applied in-memory on the bounded page (the plan's U13-approach
  directory contract keeps the read partition-scoped; the username join is
  resolved per member row via users).

  Roster synthesis (bots plan U5, R4/R6): with `include_principals: true`
  every human member row is followed by its machine principals
  (subs_by_parent) — a machine principal belongs where its parent is a
  member (R1), so a member parent's principals all belong here. The page's
  synthesis is BATCHED (PERF-5, B5): one subs_by_parent `IN` read, one
  principals read, one users read — never per-member queries. Synthesized
  entries ride the parent's row group carrying `kind` (:bot | :agent |
  :webhook) and `parent_user_id`; human rows carry `kind: :human` and a nil
  parent. INVARIANT: machine principals never get workspace_members (or
  workspaces_of_user) rows — cursors stay keyed on human user_ids and
  `limit` bounds the human page (synthesis is additive on top of it).
  Callers that paginate or count on the human roster (bot listing, admin
  audit, search filters) keep the default and stay human-only.
  """
  @spec list_members(integer(), keyword()) :: [map()]
  def list_members(workspace_id, opts \\ []) do
    limit = min(Keyword.get(opts, :limit, 50), 100)
    before = Keyword.get(opts, :before)
    query = Keyword.get(opts, :query)
    include_principals = Keyword.get(opts, :include_principals, false)

    {stmt, params} =
      if before do
        {"SELECT user_id, nickname, joined_at, roles FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id < ?",
         [{"bigint", workspace_id}, {"bigint", before}]}
      else
        {"SELECT user_id, nickname, joined_at, roles FROM {{K}}.workspace_members WHERE workspace_id = ?",
         [{"bigint", workspace_id}]}
      end

    rows =
      Repo.execute!(stmt, params)
      |> Enum.to_list()
      |> Enum.sort_by(& &1["user_id"], :desc)

    # Non-null keyword pages stay bounded by the partition's member list; the
    # read is partition-keyed (no ALLOW FILTERING).
    rows
    |> maybe_filter_by_name(query)
    |> Enum.take(limit)
    |> expand_page(include_principals, workspace_id)
  end

  @doc """
  EVERY human member id of `workspace_id` — uncapped, ids only.

  `list_members/2` is a PAGE: it defaults to `limit: 50` (clamped to 100) because
  it serves user-facing rosters. An audience is not a page. Feeding the paged
  reader into the notification path silently truncated the audience at the 50
  highest `user_id`s, so in any workspace larger than that nobody beyond #50 was
  ever notified and nothing announced the loss — the fan-out telemetry reports
  what was delivered, not who was skipped.

  Partition-keyed, so no scan and no ALLOW FILTERING. Read through
  `stream_rows!/3` rather than `execute!/3`: the latter returns only the first
  driver page, which is the truncation trap `Cytale.Repo` documents.
  """
  @spec list_member_ids(integer()) :: [integer()]
  def list_member_ids(workspace_id) when is_integer(workspace_id) do
    Repo.stream_rows!(
      "SELECT user_id FROM {{K}}.workspace_members WHERE workspace_id = ?",
      [{"bigint", workspace_id}]
    )
    |> Enum.map(& &1["user_id"])
    |> Enum.reject(&is_nil/1)
  end

  # A BOUNDED member count for Discord's `approximate_member_count` (hardening
  # plan 5.10). The field is APPROXIMATE by contract, and the caller only needs a
  # number: this reads ids only, one driver page, capped — where the shape it
  # replaces paged 1000 FULL member rows (nickname, joined_at, roles) and called
  # `length/1` on them, then threw them away.
  @approximate_member_cap 1_000

  @doc "A bounded member count (ids only, capped at #{@approximate_member_cap})."
  @spec approximate_member_count(integer()) :: non_neg_integer()
  def approximate_member_count(workspace_id) when is_integer(workspace_id) do
    Repo.execute!(
      "SELECT user_id FROM {{K}}.workspace_members WHERE workspace_id = ? LIMIT ?",
      [{"bigint", workspace_id}, {"int", @approximate_member_cap}]
    )
    |> Enum.count()
  end

  # PERF-5 (B5): the page's synthesis is batched — ONE `subs_by_parent IN ?`
  # index read over the page's parent ids (an IN over partition keys), ONE
  # `principals IN ?` + ONE `users IN ?` inside list_by_parents, ONE
  # `users IN ?` for the human rows. Groups assemble in memory preserving
  # the page's human order (user_id desc — cursor semantics unchanged) and
  # each parent group's principal_id ascending, exactly the per-member
  # `list_by_parent/1` + `User.get/1` shape minus the per-row reads.
  defp expand_page(page, true, workspace_id) do
    parent_ids = Enum.map(page, & &1["user_id"])

    subs_by_parent = Cytale.Accounts.Principals.list_by_parents(parent_ids)
    users_by_id = Cytale.Accounts.User.get_many(parent_ids)

    # The machine rows' TAGS come from their users rows (the principal row
    # carries the label, not the username) — ONE extra batched read for the
    # whole page, the same shape as the human lookup above.
    machine_ids =
      subs_by_parent
      |> Map.values()
      |> List.flatten()
      |> Enum.map(& &1.user_id)

    machine_users = Cytale.Accounts.User.get_many(machine_ids)
    # Their workspace nicknames (#169): one batched read for the page.
    machine_nicks = machine_nicknames(workspace_id, machine_ids)

    Enum.flat_map(page, fn row ->
      machine_principals = Map.get(subs_by_parent, row["user_id"], [])

      [
        human_member_entry(row, Map.get(users_by_id, row["user_id"]))
        | synthesized_entries(machine_principals, workspace_id, machine_users, machine_nicks)
      ]
    end)
  end

  defp expand_page(page, false, _workspace_id), do: Enum.map(page, &human_member_entry(&1, nil))

  defp human_member_entry(row, user) do
    user = user || Cytale.Accounts.User.get(row["user_id"])

    %{
      user_id: row["user_id"],
      username: user && user.username,
      # The account's display name (#168): shown when the member has no
      # workspace nickname, ahead of the username (Discord's global_name).
      display_name: user && user.display_name,
      avatar_url: user && user.avatar_url,
      nickname: row["nickname"],
      joined_at: row["joined_at"],
      roles: row["roles"],
      kind: :human,
      parent_user_id: nil
    }
  end

  # Machine entries follow their parent's row: kind/parent from provenance,
  # label as username, principal_id ascending (list_by_parents' order).
  #
  # MEMBERSHIP BY ASSOCIATION: no association, no membership. A member is
  # someone who has been positively associated with this workspace — a human by
  # a membership row, a machine credential by a GRANT (its owner gave it this
  # workspace, at read or read-write). Nothing is a member by default, and
  # nothing is a member merely because it was not excluded.
  #
  # The parent's membership is NOT the machine's association: it is the
  # capability floor the resolver intersects the grant with (a bot cannot reach
  # a workspace its owner cannot), which is why a grant to a workspace the
  # parent never joined is inert rather than a second membership path.
  #
  # So the association test here is the grant's level for THIS workspace.
  # Before it, a credential at `None` was listed as a member everywhere its
  # parent had ever joined — an enumeration leak and a lie about its reach
  # (R12: an un-granted agent gets nothing anywhere).
  # `nicknames`: the machines' per-workspace nicknames (#169), read ONCE by
  # the caller for the whole page (`machine_nicknames/2`), never per row.
  defp synthesized_entries(principals, workspace_id, machine_users, nicknames) do
    principals
    |> Enum.filter(&(Cytale.Access.level_for_workspace(&1.access, workspace_id) != :none))
    |> Enum.map(fn principal ->
      # The TAG is the credential's real username — a machine credential is a
      # user, so it has one. `label` is only the display name (and the fallback
      # for rows minted before usernames were assigned).
      user = Map.get(machine_users, principal.user_id)

      username =
        case user do
          %{username: u} when is_binary(u) -> u
          _ -> principal.label
        end

      %{
        user_id: principal.user_id,
        username: username,
        # The label is the credential's display name (#168: one shape for
        # people and machines; `nickname` keeps carrying it for older clients).
        display_name: principal.label,
        # The credential's avatar (#126) — same row, same batched read.
        avatar_url: user && user.avatar_url,
        # The workspace nickname the bot (or a member with Manage Nicknames)
        # set (#169); nil when none, and the roster shows the label — its
        # display name — with the @tag beneath, the same rule as a person.
        nickname: Map.get(nicknames, principal.user_id),
        joined_at: principal.created_at,
        roles: [],
        kind: principal.kind,
        parent_user_id: principal.parent_user_id,
        # Read here (the access document is already in hand) so the decorator
        # below can republish it without a second read.
        dm_support: Cytale.Access.dm_support(principal.access)
      }
    end)
  end

  defp maybe_filter_by_name(rows, nil), do: rows

  defp maybe_filter_by_name(rows, query) when is_binary(query) do
    q = String.downcase(query)

    Enum.filter(rows, fn r ->
      user = Cytale.Accounts.User.get(r["user_id"])

      # Every name a member is shown by (#168): nickname, display name, handle.
      [r["nickname"], user && user.display_name, user && user.username]
      |> Enum.any?(&(is_binary(&1) and String.contains?(String.downcase(&1), q)))
    end)
  end

  # -- roster projection ----------------------------------------------------------

  @doc """
  Attribution data (R6, bots plan U5) for a rendered roster/directory entry:
  every entry self-describes its kind ("human" for member rows); machine
  entries additionally carry the parent's decimal id. Decorates the
  `list_members/2` projection at every rendering surface (users/people,
  workspaces/show, members) — ONE definition beside the projection.
  """
  @spec put_attribution(map(), map()) :: map()
  def put_attribution(entry, %{kind: kind, parent_user_id: nil} = row) do
    entry
    |> Map.put("kind", kind && Atom.to_string(kind))
    |> put_dm_support(row)
  end

  def put_attribution(entry, %{kind: kind, parent_user_id: parent_user_id} = row)
      when is_integer(parent_user_id) do
    entry
    |> Map.put("kind", Atom.to_string(kind))
    |> Map.put("parent_user_id", Integer.to_string(parent_user_id))
    |> put_dm_support(row)
  end

  # WHO a machine principal will hold a DM with — the picker marks a row it
  # cannot open instead of letting the attempt fail after the fact (owner
  # direction 2026-09-15). Humans carry no policy: nothing gates messaging them.
  defp put_dm_support(entry, %{kind: kind, dm_support: support})
       when kind in [:bot, :agent] and support in [:humans, :everyone, :none] do
    Map.put(entry, "dm_support", Atom.to_string(support))
  end

  defp put_dm_support(entry, _row), do: entry

  @doc """
  ONE roster entry: the row `list_members(…, include_principals: true)` renders
  for `user_id` in `workspace_id`, or nil when the id is not associated with
  the workspace. See `roster_entries/2`, which this is the one-id case of.
  """
  @spec roster_entry(integer(), integer()) :: map() | nil
  def roster_entry(workspace_id, user_id) when is_integer(workspace_id) and is_integer(user_id) do
    workspace_id |> roster_entries([user_id]) |> List.first()
  end

  @doc """
  The roster entries for a SET of ids in `workspace_id` — the rows the people
  page renders for them, in the order asked, with every id that is not
  associated with the workspace left out. A human resolves by their membership
  row; a machine principal by its parent's membership AND its grant for this
  workspace — the same association test the page synthesis applies
  (`synthesized_entries/3`), so a live announcement, a lookup and a page read
  can never disagree about who belongs.

  This is how a client names a member it has not paged to: the people page is
  a page (50 by default), a workspace of thousands is many pages, and a client
  needs a name only for the ids it actually renders. Batched: one
  `workspace_members … IN ?`, one `principals IN ?`, one parents' membership
  `IN ?` and one `users IN ?` per kind — never per-id reads.
  """
  @spec roster_entries(integer(), [integer()]) :: [map()]
  def roster_entries(_workspace_id, []), do: []

  def roster_entries(workspace_id, user_ids) when is_integer(workspace_id) and is_list(user_ids) do
    ids = Enum.uniq(user_ids)
    principals = Cytale.Accounts.Principals.get_many(ids)
    {machine_ids, human_ids} = Enum.split_with(ids, &Map.has_key?(principals, &1))

    parent_ids = principals |> Map.values() |> Enum.map(& &1.parent_user_id) |> Enum.filter(&is_integer/1)
    member_rows = member_rows(workspace_id, Enum.uniq(human_ids ++ parent_ids))

    humans_users = Cytale.Accounts.User.get_many(Enum.filter(human_ids, &Map.has_key?(member_rows, &1)))

    humans =
      Enum.reduce(human_ids, %{}, fn id, acc ->
        case member_rows do
          %{^id => row} -> Map.put(acc, id, human_member_entry(row, Map.get(humans_users, id)))
          _ -> acc
        end
      end)

    machines =
      machine_ids
      |> Enum.map(&principals[&1])
      |> Enum.filter(&Map.has_key?(member_rows, &1.parent_user_id))
      |> synthesized_entries(
        workspace_id,
        Cytale.Accounts.User.get_many(machine_ids),
        machine_nicknames(workspace_id, machine_ids)
      )
      |> Map.new(&{&1.user_id, &1})

    ids |> Enum.map(&(Map.get(humans, &1) || Map.get(machines, &1))) |> Enum.reject(&is_nil/1)
  end

  # Machine principals' workspace nicknames (#169), keyed by user id: one
  # partition-keyed `IN` read. Absent = no nickname.
  defp machine_nicknames(_workspace_id, []), do: %{}

  defp machine_nicknames(workspace_id, user_ids) do
    Repo.execute!(
      "SELECT user_id, nickname FROM {{K}}.workspace_machine_nicknames WHERE workspace_id = ? AND user_id IN ?",
      [{"bigint", workspace_id}, {"list<bigint>", user_ids}]
    )
    |> Enum.to_list()
    |> Enum.reject(&is_nil(&1["nickname"]))
    |> Map.new(&{&1["user_id"], &1["nickname"]})
  end

  # -- unique shown names (owner decision 2026-10-04) ------------------------

  @doc """
  The comparison form of a shown name: trimmed, Unicode NFKC-normalized (so
  compatibility look-alikes such as full-width letters fold together) and
  case-folded. Two names that normalize equal are the same name.
  """
  @spec normalize_shown_name(String.t()) :: String.t()
  def normalize_shown_name(name) when is_binary(name) do
    name |> String.trim() |> :unicode.characters_to_nfkc_binary() |> String.downcase()
  end

  @doc """
  Is `name` already a name someone ELSE in `workspace_id` is shown by — their
  workspace nickname, display name or username, people and bots alike? The
  owner decided (2026-10-04) that a shown name must be unique in a workspace,
  so the name a member CHOOSES (a nickname, a display name, a bot's label) is
  refused when it collides. `except_user_id` is the member choosing it (their
  own names never collide with themselves).

  Reads the whole roster in pages of 100 (people plus their granted
  machines), so it costs a roster walk: it runs when a name is chosen, never
  on a read path.
  """
  @spec name_taken?(integer(), String.t(), integer()) :: boolean()
  def name_taken?(workspace_id, name, except_user_id)
      when is_integer(workspace_id) and is_binary(name) and is_integer(except_user_id) do
    wanted = normalize_shown_name(name)
    wanted != "" and taken_in_pages?(workspace_id, wanted, except_user_id, nil)
  end

  @doc "The first of `workspace_ids` where `name` is taken (see `name_taken?/3`), or nil."
  @spec name_taken_in(Enumerable.t(), String.t(), integer()) :: integer() | nil
  def name_taken_in(workspace_ids, name, except_user_id) do
    Enum.find(workspace_ids, &name_taken?(&1, name, except_user_id))
  end

  @roster_walk_page 100

  defp taken_in_pages?(workspace_id, wanted, except_user_id, before) do
    page = list_members(workspace_id, limit: @roster_walk_page, before: before, include_principals: true)

    collides? =
      Enum.any?(page, fn m ->
        m.user_id != except_user_id and
          Enum.any?([m.nickname, Map.get(m, :display_name), m.username], fn shown ->
            is_binary(shown) and normalize_shown_name(shown) == wanted
          end)
      end)

    humans = Enum.filter(page, &(Map.get(&1, :kind, :human) == :human))

    cond do
      collides? -> true
      length(humans) < @roster_walk_page -> false
      true -> taken_in_pages?(workspace_id, wanted, except_user_id, humans |> List.last() |> Map.fetch!(:user_id))
    end
  end

  @nickname_max 32

  @doc """
  Set (or clear, with nil) `user_id`'s nickname in `workspace_id` (#169) — a
  person's on their membership row, a machine principal's in
  `workspace_machine_nicknames` (it has no membership row). The caller has
  already authorized the change; this validates and stores. Trimmed; blank
  clears; at most #{@nickname_max} characters (Discord's limit).

  Returns `{:ok, nickname_or_nil}`, `{:error, :not_member}` when the id is not
  associated with the workspace, or `{:error, :invalid_nickname}`.
  """
  @spec set_nickname(integer(), integer(), String.t() | nil) ::
          {:ok, String.t() | nil} | {:error, :not_member | :invalid_nickname}
  def set_nickname(workspace_id, user_id, nickname) when is_integer(workspace_id) and is_integer(user_id) do
    with {:ok, nick} <- normalize_nickname(nickname) do
      cond do
        get_member(workspace_id, user_id) != nil ->
          Repo.execute!(
            "UPDATE {{K}}.workspace_members SET nickname = ? WHERE workspace_id = ? AND user_id = ?",
            [{"text", nick}, {"bigint", workspace_id}, {"bigint", user_id}]
          )

          {:ok, nick}

        roster_entry(workspace_id, user_id) != nil ->
          if nick do
            Repo.execute!(
              "INSERT INTO {{K}}.workspace_machine_nicknames (workspace_id, user_id, nickname) VALUES (?, ?, ?)",
              [{"bigint", workspace_id}, {"bigint", user_id}, {"text", nick}]
            )
          else
            Repo.execute!(
              "DELETE FROM {{K}}.workspace_machine_nicknames WHERE workspace_id = ? AND user_id = ?",
              [{"bigint", workspace_id}, {"bigint", user_id}]
            )
          end

          {:ok, nick}

        true ->
          {:error, :not_member}
      end
    end
  end

  defp normalize_nickname(nil), do: {:ok, nil}

  defp normalize_nickname(nick) when is_binary(nick) do
    case String.trim(nick) do
      "" -> {:ok, nil}
      trimmed -> if String.length(trimmed) <= @nickname_max, do: {:ok, trimmed}, else: {:error, :invalid_nickname}
    end
  end

  defp normalize_nickname(_), do: {:error, :invalid_nickname}

  # Membership rows for a set of ids (partition-keyed `IN` on the clustering
  # key), keyed by user id, in the shape `human_member_entry/2` reads.
  defp member_rows(_workspace_id, []), do: %{}

  defp member_rows(workspace_id, user_ids) do
    Repo.execute!(
      "SELECT user_id, nickname, joined_at, roles FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id IN ?",
      [{"bigint", workspace_id}, {"list<bigint>", user_ids}]
    )
    |> Enum.to_list()
    |> Map.new(&{&1["user_id"], &1})
  end

  @doc """
  The wire shape of one roster entry — the people page's row (`user` with id,
  username, display name and avatar, `nickname`, `joined_at`, `roles`, plus the attribution
  keys). The people read and the live `MemberAdd` both render through this, so
  a member that arrives live carries exactly what a reload would have read:
  the display name, the avatar and the kind badge, for people and machines
  alike.
  """
  @spec roster_entry_wire(map()) :: map()
  def roster_entry_wire(m) do
    %{
      "user" => %{
        "id" => Integer.to_string(m.user_id),
        "username" => m.username,
        "display_name" => Map.get(m, :display_name),
        "avatar_url" => m.avatar_url
      },
      "nickname" => m.nickname,
      "joined_at" => m.joined_at && DateTime.to_iso8601(m.joined_at),
      "roles" => Enum.map(m.roles || [], &Integer.to_string/1)
    }
    |> put_attribution(m)
  end

  @doc """
  The workspaces a machine principal is ASSOCIATED with under `access`: its
  parent's workspaces where the grant's level is not `:none` (membership by
  association — see `synthesized_entries/3`).
  """
  @spec associated_workspace_ids(integer(), map() | nil) :: [integer()]
  def associated_workspace_ids(parent_user_id, access) when is_integer(parent_user_id) do
    parent_user_id
    |> workspace_ids_of_user()
    |> Enum.filter(&(Cytale.Access.level_for_workspace(access, &1) != :none))
  end

  @doc "Remove a member (kick / leave)."
  @spec remove_member(integer(), integer()) :: :ok
  def remove_member(workspace_id, user_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.workspace_members WHERE workspace_id = ? AND user_id = ?",
      [{"bigint", workspace_id}, {"bigint", user_id}]
    )

    Repo.execute!(
      "DELETE FROM {{K}}.workspaces_of_user WHERE user_id = ? AND workspace_id = ?",
      [{"bigint", user_id}, {"bigint", workspace_id}]
    )

    rights_changed(workspace_id)
  end

  # -- channels ----------------------------------------------------------------------

  @typedoc "Channel types: 0 = text, 1 = category."
  @type channel_type :: 0 | 1

  @doc "Create a channel in a workspace (both write paths: per-workspace + by-id)."
  @spec create_channel(integer(), String.t(), keyword()) :: {:ok, map()} | {:error, :invalid_name}
  def create_channel(workspace_id, name, opts \\ [])
      when is_binary(name) and byte_size(name) >= 1 and byte_size(name) <= 100 do
    channel_id = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
    created_by = Keyword.get(opts, :created_by)
    type = Keyword.get(opts, :type, 0)
    parent_id = Keyword.get(opts, :parent_id)
    topic = Keyword.get(opts, :topic)
    position = Keyword.get(opts, :position, 0)

    cols = ~s(channel_id, workspace_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id)
    vals = "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"

    params = [
      {"bigint", channel_id},
      {"bigint", workspace_id},
      {"text", name},
      {"int", type},
      {"bigint", parent_id},
      {"text", topic},
      {"int", position},
      {"bigint", created_by},
      {"timestamp", now},
      {"bigint", nil}
    ]

    Repo.execute!(
      "INSERT INTO {{K}}.channels (#{cols}) VALUES #{vals}",
      params
    )

    Repo.execute!(
      "INSERT INTO {{K}}.channels_by_id (channel_id, workspace_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      params
    )

    # A new channel changes every member's VISIBLE SET (the gateway memo and
    # its shared cache are versioned by this epoch), even though no one's bits
    # on existing channels moved.
    rights_changed(workspace_id)

    {:ok,
     %{
       channel_id: channel_id,
       workspace_id: workspace_id,
       name: name,
       type: type,
       parent_id: parent_id,
       topic: topic,
       position: position,
       created_by: created_by,
       created_at: now,
       last_message_id: nil
     }}
  end

  @doc """
  Validate a channel's `parent_id` (Tier 3 B, 10d): nil (no category) is
  always fine; otherwise it must name a CATEGORY (type 1) of the SAME
  workspace, never the channel itself, and a category cannot sit inside
  another (one level of grouping, Discord's rule). Without this a channel
  could be filed under another workspace's channel id — a cross-workspace
  existence probe and a sidebar the client cannot render.
  """
  @spec check_channel_parent(integer(), integer() | nil, channel_type(), integer() | nil) ::
          :ok | {:error, :invalid_parent}
  def check_channel_parent(_workspace_id, nil, _own_type, _own_id), do: :ok

  def check_channel_parent(workspace_id, parent_id, own_type, own_id) when is_integer(parent_id) do
    case get_channel(parent_id) do
      %{workspace_id: ^workspace_id, type: 1, channel_id: id} when id != own_id and own_type != 1 -> :ok
      _ -> {:error, :invalid_parent}
    end
  end

  def check_channel_parent(_workspace_id, _parent_id, _own_type, _own_id), do: {:error, :invalid_parent}

  @doc "Fetch a channel (by-id lookup table)."
  @spec get_channel(integer()) :: map() | nil
  def get_channel(channel_id) do
    # Prepared (hardening 1.8): this is the single hottest point read in the
    # system — the message send path, the typing visibility gate and the
    # message projection all land here.
    rows =
      Repo.query!(
        "SELECT channel_id, workspace_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id FROM {{K}}.channels_by_id WHERE channel_id = ?",
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] -> row_to_channel(r)
      [] -> nil
    end
  end

  @doc "Channels of a workspace, category-first then position order."
  @spec list_channels(integer()) :: [map()]
  def list_channels(workspace_id) do
    Repo.execute!(
      "SELECT channel_id, workspace_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id FROM {{K}}.channels WHERE workspace_id = ?",
      [{"bigint", workspace_id}]
    )
    |> Enum.to_list()
    |> Enum.map(&row_to_channel/1)
    |> Enum.sort_by(fn c -> {c.type == 0, c.position, c.channel_id} end)
  end

  @doc "Update mutable channel fields."
  @spec update_channel(integer(), map()) :: :ok
  def update_channel(channel_id, changes) do
    ch = get_channel(channel_id) || %{}
    name = Map.get(changes, :name, ch.name)
    topic = Map.get(changes, :topic, ch.topic)
    position = Map.get(changes, :position, ch.position)
    parent_id = Map.get(changes, :parent_id, ch.parent_id)

    Repo.execute!(
      "UPDATE {{K}}.channels_by_id SET name = ?, topic = ?, position = ?, parent_id = ? WHERE channel_id = ?",
      [
        {"text", name},
        {"text", topic},
        {"int", position || 0},
        {"bigint", parent_id},
        {"bigint", channel_id}
      ]
    )

    if ch.workspace_id do
      Repo.execute!(
        "UPDATE {{K}}.channels SET name = ?, topic = ?, position = ?, parent_id = ? WHERE workspace_id = ? AND channel_id = ?",
        [
          {"text", name},
          {"text", topic},
          {"int", position || 0},
          {"bigint", parent_id},
          {"bigint", ch.workspace_id},
          {"bigint", channel_id}
        ]
      )
    end

    :ok
  end

  @doc "Delete a channel from both write paths."
  @spec delete_channel(integer()) :: :ok
  def delete_channel(channel_id) do
    ch = get_channel(channel_id)

    Repo.execute!(
      "DELETE FROM {{K}}.channels_by_id WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )

    if ch && ch.workspace_id do
      Repo.execute!(
        "DELETE FROM {{K}}.channels WHERE workspace_id = ? AND channel_id = ?",
        [{"bigint", ch.workspace_id}, {"bigint", channel_id}]
      )
    end

    # Webhook cascade (bots plan U11, R12): the channel's webhooks die with
    # it via webhooks_by_channel — execute 404s from then on (and the
    # channel-existence backstop covers any index drift).
    Cytale.Webhooks.delete_for_channel(channel_id)

    # The route cache must stop answering for this id: the permission gate
    # reads it as "the channel exists". The rights epoch is deliberately NOT
    # bumped (the controller's #53 choice): the viewers' visibility memos at
    # the last epoch are the only record that can still admit the
    # ChannelDelete that tells them the channel is gone. A memoized resolve
    # for the deleted channel is unreachable — the gate 404s on the missing
    # route before it asks.
    Cytale.Publish.ChannelRoutes.forget(channel_id)

    :ok
  end

  # -- roles -------------------------------------------------------------------------

  @doc "Create a role. Returns the role map."
  @spec create_role(integer(), String.t(), keyword()) :: {:ok, map()} | {:error, :invalid_name}
  def create_role(workspace_id, name, opts \\ []) when is_binary(name) and byte_size(name) >= 1 do
    role_id = Cytale.Snowflake.next()
    permissions = Keyword.get(opts, :permissions, 0)
    position = Keyword.get(opts, :position, 1)
    color = Keyword.get(opts, :color)

    Repo.execute!(
      "INSERT INTO {{K}}.roles (workspace_id, role_id, name, permissions, position, color) VALUES (?, ?, ?, ?, ?, ?)",
      [
        {"bigint", workspace_id},
        {"bigint", role_id},
        {"text", name},
        {"bigint", permissions},
        {"int", position},
        {"int", color}
      ]
    )

    {:ok,
     %{
       role_id: role_id,
       workspace_id: workspace_id,
       name: name,
       permissions: permissions,
       position: position,
       color: color
     }}
  end

  @doc "Roles of a workspace (position DESC — highest first, hierarchy order)."
  @spec list_roles(integer()) :: [map()]
  def list_roles(workspace_id) do
    Repo.execute!(
      "SELECT role_id, name, permissions, position, color FROM {{K}}.roles WHERE workspace_id = ?",
      [{"bigint", workspace_id}]
    )
    |> Enum.to_list()
    |> Enum.map(fn r ->
      %{
        role_id: r["role_id"],
        name: r["name"],
        permissions: r["permissions"],
        position: r["position"],
        color: r["color"]
      }
    end)
    |> Enum.sort_by(& &1.position, :desc)
  end

  @doc "One role by id (nil when it does not exist in the workspace)."
  @spec get_role(integer(), integer()) :: map() | nil
  def get_role(workspace_id, role_id) do
    case Repo.execute!(
           "SELECT role_id, name, permissions, position, color FROM {{K}}.roles WHERE workspace_id = ? AND role_id = ?",
           [{"bigint", workspace_id}, {"bigint", role_id}]
         )
         |> Enum.to_list() do
      [r] ->
        %{
          role_id: r["role_id"],
          name: r["name"],
          permissions: r["permissions"],
          position: r["position"],
          color: r["color"]
        }

      [] ->
        nil
    end
  end

  @doc "Update a role (permission bitfield as integer, position, color, name)."
  @spec update_role(integer(), integer(), map()) :: :ok
  def update_role(workspace_id, role_id, changes) do
    # ONE point read for the role being updated (hardening plan 5.7): the old
    # shape listed the workspace's whole roles partition to merge defaults into
    # the touched fields, so editing the last role in a 100-role workspace read
    # all 100.
    existing = get_role(workspace_id, role_id) || %{name: nil, permissions: 0, position: 1, color: nil}

    name = Map.get(changes, :name, existing.name)
    permissions = Map.get(changes, :permissions, existing.permissions)
    position = Map.get(changes, :position, existing.position)
    color = Map.get(changes, :color, existing.color)

    Repo.execute!(
      "UPDATE {{K}}.roles SET name = ?, permissions = ?, position = ?, color = ? WHERE workspace_id = ? AND role_id = ?",
      [
        {"text", name},
        {"bigint", permissions},
        {"int", position},
        {"int", color},
        {"bigint", workspace_id},
        {"bigint", role_id}
      ]
    )

    rights_changed(workspace_id)
  end

  @doc "Delete a role."
  @spec delete_role(integer(), integer()) :: :ok
  def delete_role(workspace_id, role_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.roles WHERE workspace_id = ? AND role_id = ?",
      [{"bigint", workspace_id}, {"bigint", role_id}]
    )

    rights_changed(workspace_id)
  end

  @doc "Grant a role to a member (idempotent — list membership)."
  @spec grant_role(integer(), integer(), integer()) :: :ok
  def grant_role(workspace_id, user_id, role_id) do
    member = get_member(workspace_id, user_id) || return_error()

    # ALREADY HELD: no write at all. Keeps the common repeat-grant path
    # idempotent, which a bare `roles + ?` cannot (Scylla's list append does not
    # dedupe).
    if role_id in (member.roles || []) do
      :ok
    else
      # SERVER-SIDE append, not a whole-list replace (hardening plan 4.3). The
      # old code read the list, computed a new one and wrote it back, so two
      # concurrent grants — or a grant racing a revoke — lost whichever write
      # landed first. `roles = roles + ?` merges in the database instead.
      #
      # Residual, recorded rather than hidden: two SIMULTANEOUS grants of the
      # SAME role can both append, leaving a duplicate id. Permission checks
      # filter through a MapSet of role ids so duplicates cannot grant anything
      # extra, and `revoke_role`'s `-` removes every occurrence, so the cost is a
      # repeated id in roster payloads rather than a security or correctness
      # hole.
      Repo.execute!(
        "UPDATE {{K}}.workspace_members SET roles = roles + ? WHERE workspace_id = ? AND user_id = ?",
        [{"list<bigint>", [role_id]}, {"bigint", workspace_id}, {"bigint", user_id}]
      )

      rights_changed(workspace_id)
    end
  end

  @doc "Revoke a role from a member."
  @spec revoke_role(integer(), integer(), integer()) :: :ok
  def revoke_role(workspace_id, user_id, role_id) do
    member = get_member(workspace_id, user_id) || return_error()

    # SERVER-SIDE removal (hardening plan 4.3), same reasoning as `grant_role/3`:
    # the old read-compute-write lost a concurrent grant. Scylla's list `-`
    # removes EVERY occurrence of the value, so this is also what cleans up a
    # duplicate left by two simultaneous grants.
    if role_id in (member.roles || []) do
      Repo.execute!(
        "UPDATE {{K}}.workspace_members SET roles = roles - ? WHERE workspace_id = ? AND user_id = ?",
        [{"list<bigint>", [role_id]}, {"bigint", workspace_id}, {"bigint", user_id}]
      )

      rights_changed(workspace_id)
    end

    :ok
  end

  defp return_error, do: raise(ArgumentError, "not a member")

  # -- overwrites ----------------------------------------------------------------------

  @doc "Upsert a channel overwrite (target_type 0=role, 1=member)."
  @spec put_overwrite(integer(), :role | :member, integer(), integer(), integer()) :: :ok
  def put_overwrite(channel_id, target_type, target_id, allow, deny) do
    tt = if target_type == :role, do: 0, else: 1

    # A nil mask would be written as a NULL column, and the resolver reduces
    # masks with `Bitwise.bor/2` — a NULL there used to crash the SESSION's
    # visibility computation (and with it the socket, close 4000). Normalize at
    # the write so the bad row cannot exist, and tolerate it on read
    # (`Principal.overwrite_input/1`) so one already-written row cannot.
    allow = allow || 0
    deny = deny || 0

    Repo.execute!(
      ~s"INSERT INTO {{K}}.channel_overwrites (channel_id, target_id, target_type, \"allow\", \"deny\") VALUES (?, ?, ?, ?, ?)",
      [
        {"bigint", channel_id},
        {"bigint", target_id},
        {"int", tt},
        {"bigint", allow},
        {"bigint", deny}
      ]
    )

    channel_rights_changed(channel_id)
  end

  @doc "Delete a channel overwrite."
  @spec delete_overwrite(integer(), integer()) :: :ok
  def delete_overwrite(channel_id, target_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.channel_overwrites WHERE channel_id = ? AND target_id = ?",
      [{"bigint", channel_id}, {"bigint", target_id}]
    )

    channel_rights_changed(channel_id)
  end

  @doc "Overwrites of a channel, as U7 overwrite inputs."
  @spec overwrites(integer()) :: [map()]
  def overwrites(channel_id) do
    Repo.execute!(
      ~s"SELECT target_id, target_type, \"allow\", \"deny\" FROM {{K}}.channel_overwrites WHERE channel_id = ?",
      [{"bigint", channel_id}]
    )
    |> Enum.to_list()
    |> Enum.map(fn r ->
      %{
        target_id: r["target_id"],
        target_type: if(r["target_type"] == 0, do: :role, else: :member),
        allow: r["allow"],
        deny: r["deny"]
      }
    end)
  end

  # -- invites ----------------------------------------------------------------------

  @doc "Create an invite for a workspace (random URL-safe code, optional max age/uses)."
  @spec create_invite(integer(), integer(), keyword()) :: {:ok, map()}
  def create_invite(workspace_id, created_by, opts \\ []) do
    code = :crypto.strong_rand_bytes(8) |> Base.url_encode64(padding: false)
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
    max_age_s = Keyword.get(opts, :max_age_s, 86_400)
    expires_at = DateTime.add(now, max_age_s, :second)
    max_uses = Keyword.get(opts, :max_uses, 0)

    Repo.execute!(
      "INSERT INTO {{K}}.invites (invite_code, workspace_id, created_by, created_at, expires_at, max_uses, use_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        {"text", code},
        {"bigint", workspace_id},
        {"bigint", created_by},
        {"timestamp", now},
        {"timestamp", expires_at},
        {"int", max_uses},
        {"bigint", 0}
      ]
    )

    {:ok,
     %{
       invite_code: code,
       workspace_id: workspace_id,
       created_by: created_by,
       created_at: now,
       expires_at: expires_at,
       max_uses: max_uses,
       use_count: 0
     }}
  end

  @doc "Resolve an invite (nil when unknown/expired/revoked)."
  @spec get_invite(String.t()) :: map() | nil
  def get_invite(code) when is_binary(code) do
    rows =
      Repo.execute!(
        "SELECT invite_code, workspace_id, created_by, created_at, expires_at, max_uses, use_count FROM {{K}}.invites WHERE invite_code = ?",
        [{"text", code}]
      )
      |> Enum.to_list()

    case rows do
      [r] ->
        invited = %{
          invite_code: r["invite_code"],
          workspace_id: r["workspace_id"],
          created_by: r["created_by"],
          created_at: r["created_at"],
          expires_at: r["expires_at"],
          max_uses: r["max_uses"],
          use_count: r["use_count"]
        }

        # A deleted workspace's codes die with it (there is no per-workspace
        # invite index to sweep): `get_workspace/1` refuses the tombstone.
        if DateTime.compare(invited.expires_at, DateTime.utc_now()) == :gt and
             (invited.max_uses == 0 or invited.use_count < invited.max_uses) and
             get_workspace(invited.workspace_id) != nil do
          invited
        else
          nil
        end

      [] ->
        nil
    end
  end

  @doc "Accept an invite: reserve a use, then add the member."
  @spec accept_invite(String.t(), integer()) :: {:ok, map()} | {:error, :invalid_invite}
  def accept_invite(code, user_id) do
    # An EXISTING member accepting is a no-op (the invite answers as valid, the
    # returned map says `already_member: true`): `add_member/4` is an upsert
    # that writes `roles = []`, so re-accepting any invite used to strip every
    # role the member held — and burn a use of the invite doing it.
    case get_invite(code) do
      %{workspace_id: workspace_id} = invite ->
        if get_member(workspace_id, user_id) != nil,
          do: {:ok, Map.put(invite, :already_member, true)},
          else: accept_new_member(code, user_id)

      nil ->
        {:error, :invalid_invite}
    end
  end

  defp accept_new_member(code, user_id) do
    # The use is RESERVED before the member is added (hardening plan 4.3). The
    # old order — add the member, then write `use_count + 1` — both lost updates
    # under concurrency and let two simultaneous accepts past `max_uses`: both
    # read `max_uses - 1`, both were let in, and both wrote the same `+ 1`.
    #
    # The conditional write is the GATE: the reservation succeeds only if the
    # count is still the one we read, so it is also what enforces `max_uses`
    # (the re-read inside the retry calls `get_invite/1`, which refuses an
    # exhausted or expired invite). Reserving first means a failure between the
    # two steps over-counts by one, where the opposite order would admit one use
    # too many — and the over-count is COMPENSATED rather than left behind, so a
    # transient write failure does not burn the last seat of a capped invite.
    with {:ok, invite} <- reserve_invite_use(code, @invite_lwt_attempts) do
      try do
        :ok = add_member(invite.workspace_id, user_id, invite.created_by, [])
        {:ok, invite}
      rescue
        e ->
          release_invite_use(code, invite.use_count + 1)
          reraise e, __STACKTRACE__
      end
    end
  end

  # Give back the seat a failed acceptance reserved. Conditional on the count we
  # wrote (`use_count + 1`), so it cannot undo somebody ELSE's reservation: if
  # another accept already moved it, this is a no-op and the over-count stands
  # (the cost of the crash-window residual, not of a failure we observed).
  defp release_invite_use(code, reserved_count) do
    case Repo.execute(
           "UPDATE {{K}}.invites SET use_count = ? WHERE invite_code = ? IF use_count = ?",
           [{"bigint", reserved_count - 1}, {"text", code}, {"bigint", reserved_count}]
         ) do
      {:ok, page} ->
        unless Repo.lwt_applied?(page) do
          Logger.warning(
            "accept_invite: could not give back the reserved use of #{code} " <>
              "(use_count moved past #{reserved_count}) — the invite is one use heavier"
          )
        end

        :ok

      {:error, _reason} ->
        :ok
    end
  end

  defp reserve_invite_use(_code, 0), do: {:error, :invalid_invite}

  defp reserve_invite_use(code, attempts) do
    case get_invite(code) do
      nil ->
        {:error, :invalid_invite}

      invite ->
        case Repo.execute(
               "UPDATE {{K}}.invites SET use_count = ? WHERE invite_code = ? IF use_count = ?",
               [
                 {"bigint", invite.use_count + 1},
                 {"text", code},
                 {"bigint", invite.use_count}
               ]
             ) do
          {:ok, page} ->
            if Repo.lwt_applied?(page),
              do: {:ok, invite},
              else: reserve_invite_use(code, attempts - 1)

          {:error, err} ->
            raise err
        end
    end
  end

  @doc "Revoke (delete) an invite."
  @spec revoke_invite(String.t()) :: :ok
  def revoke_invite(code) do
    Repo.execute!(
      "DELETE FROM {{K}}.invites WHERE invite_code = ?",
      [{"text", code}]
    )

    :ok
  end

  # -- DM channels -----------------------------------------------------------------

  @doc """
  Open (or fetch) a 1:1 DM channel between two principals (B-1 makes the
  paths machine-principal-aware). Kind guard, Discord's rule: only
  :human ↔ :human and :human ↔ machine pairs may open a DM — machine ↔
  machine is `{:error, :invalid_pair}` (Discord disallows bot-to-bot DMs),
  and webhooks are not DM-able at all (they carry no credential and no
  session; a webhook recipient could never read the channel).

  Deduplication is index-backed (the `dms_of_user` partition): an existing
  pair's row is returned with `created?: false`, and BOTH participants'
  index rows are written on create — the read side of
  `GET /users/@me/channels`.
  """
  @spec open_dm(integer(), integer(), keyword()) ::
          {:ok, map()} | {:error, :invalid_pair | :unknown_user | :dm_not_permitted | :no_shared_workspace}
  def open_dm(user_a, user_b, opts \\ [])

  def open_dm(user_a, user_b, opts) when user_a != user_b do
    with {:ok, _} <- dm_pair_allowed?(user_a, user_b),
         :ok <- check_dm_reach(user_a, user_b, opts),
         {:ok, dm, created?} <- open_dm_row(user_a, user_b) do
      {:ok, Map.put(dm, :created?, created?)}
    end
  end

  def open_dm(user_a, user_a, _opts), do: {:error, :invalid_pair}

  # `require_shared: true` — what the REST surfaces ask for (Tier 3 B, 9a): a
  # caller may open a NEW conversation only with someone they share a
  # workspace with (or with their own machine principal / its parent). Without
  # it any account could DM any user id on the server — spam and a user-id
  # enumeration surface. An EXISTING DM always reopens. Library callers
  # (fixtures, the interaction runtime) keep the unconditional form.
  defp check_dm_reach(user_a, user_b, opts) do
    cond do
      not Keyword.get(opts, :require_shared, false) -> :ok
      find_dm(user_a, user_b) != nil -> :ok
      shares_workspace?(user_a, user_b) -> :ok
      parent_pair?(user_a, user_b) -> :ok
      true -> {:error, :no_shared_workspace}
    end
  end

  defp shares_workspace?(user_a, user_b) do
    mine = MapSet.new(workspace_ids_of_user(user_a))
    Enum.any?(workspace_ids_of_user(user_b), &MapSet.member?(mine, &1))
  end

  defp parent_pair?(user_a, user_b) do
    parent_of(user_a) == user_b or parent_of(user_b) == user_a
  end

  defp parent_of(user_id) do
    case Cytale.Accounts.Principals.get(user_id) do
      %{parent_user_id: parent} -> parent
      _ -> nil
    end
  end

  defp open_dm_row(user_a, user_b) do
    case find_dm(user_a, user_b) do
      nil ->
        channel_id = Cytale.Snowflake.next()
        now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
        user_ids = Enum.sort([user_a, user_b])

        Repo.execute!(
          "INSERT INTO {{K}}.dm_channels (channel_id, user_ids, created_at, last_message_id) VALUES (?, ?, ?, ?)",
          [{"bigint", channel_id}, {"list<bigint>", user_ids}, {"timestamp", now}, {"bigint", nil}]
        )

        Enum.each(user_ids, fn uid ->
          Repo.execute!(
            "INSERT INTO {{K}}.dms_of_user (user_id, channel_id, user_ids, created_at, last_message_id) VALUES (?, ?, ?, ?, ?)",
            [
              {"bigint", uid},
              {"bigint", channel_id},
              {"list<bigint>", user_ids},
              {"timestamp", now},
              {"bigint", nil}
            ]
          )
        end)

        {:ok, %{channel_id: channel_id, user_ids: user_ids, created_at: now, last_message_id: nil}, true}

      dm ->
        {:ok, dm, false}
    end
  end

  # The DM kind guard: at least one side must be :human, and neither side may
  # be a webhook (machine ↔ machine rejected, Discord parity). Rationale:
  # loop prevention — two autonomous clients in a private channel ping-pong
  # with no human watching; agents that need to interact belong in a shared
  # workspace channel. Decision of record + reversal note: compat.md's
  # "Kind guard" paragraph.
  defp dm_pair_allowed?(user_a, user_b) do
    with {:ok, a} <- dm_side(user_a),
         {:ok, b} <- dm_side(user_b) do
      cond do
        # Webhooks are one-way transports, never conversation partners.
        a.kind == :webhook or b.kind == :webhook -> {:error, :invalid_pair}
        # The INITIATOR (`user_a`, the caller) opening a DM as a machine needs
        # its access document's DM grant at `:read_write` — `dms: :none` (the
        # default) or `:read` means it may not start conversations.
        a.kind != :human and a.dms != :read_write -> {:error, :dm_not_permitted}
        # Two people are always allowed: the policy below is the AGENT's.
        a.kind == :human and b.kind == :human -> {:ok, :pair}
        # Anything with a machine in it asks that machine's DM-support policy
        # (owner direction 2026-09-15): :humans (the default) accepts people
        # only, :everyone also accepts other agents, :none accepts nobody.
        dm_support_allows?(a, b) -> {:ok, :pair}
        true -> {:error, :dm_not_permitted}
      end
    end
  end

  # One side of a DM pair: its kind, plus its DM-support policy when it is a
  # machine (a person has no document to consult and accepts every kind whose
  # own policy accepts them).
  defp dm_side(user_id) do
    case Cytale.Accounts.Principals.kind_of(user_id) do
      nil ->
        {:error, :unknown_user}

      :human ->
        {:ok, %{kind: :human, support: :everyone}}

      kind ->
        case Cytale.Accounts.Principals.get(user_id) do
          %{access: access} ->
            {:ok,
             %{
               kind: kind,
               support: Cytale.Access.dm_support(access),
               dms: Cytale.Access.dms_level(access || Cytale.Access.default())
             }}

          _ ->
            {:error, :unknown_user}
        end
    end
  end

  # BOTH sides must accept the other's kind — the stricter policy wins, which is
  # what keeps two `:humans` agents from messaging each other exactly as the old
  # blanket machine↔machine refusal did.
  defp dm_support_allows?(a, b), do: accepts?(a, b.kind) and accepts?(b, a.kind)

  defp accepts?(%{kind: :human}, _other_kind), do: true
  defp accepts?(%{support: support}, :human), do: support in [:humans, :everyone]
  # Any OTHER machine kind (bot ↔ agent included). This clause used to bind
  # `_machine` in both the map and the second argument — one variable twice,
  # so it matched only a machine of the SAME kind and a bot ↔ agent pair fell
  # through every clause (FunctionClauseError → 500).
  defp accepts?(%{support: support}, _other_machine_kind), do: support == :everyone

  @doc "Fetch a DM channel row by id (nil for workspace channels and unknown ids)."
  @spec get_dm(integer()) :: map() | nil
  def get_dm(channel_id) when is_integer(channel_id) do
    # Prepared (hardening 1.8): `FanOut.deliver/3` calls this on every
    # delivery, including every typing signal, and the message create path
    # asks again — so it is a per-event read on a hot path.
    rows =
      Repo.query!(
        "SELECT channel_id, user_ids, created_at, last_message_id FROM {{K}}.dm_channels WHERE channel_id = ?",
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [r] -> dm_row(r)
      [] -> nil
    end
  end

  @doc "DM channel participation (B-1's authorization rule: participation IS authorization)."
  @spec dm_participant?(map() | nil, integer()) :: boolean()
  def dm_participant?(%{user_ids: user_ids}, user_id) when is_integer(user_id),
    do: user_id in (user_ids || [])

  def dm_participant?(_dm, _user_id), do: false

  @doc """
  DM channels the user participates in — the `dms_of_user` index partition
  (bots plan B-1; formerly a DOCUMENTED STUB). Machine principals carry
  their OWN rows here (unlike workspace membership, which derives from the
  parent): a DM's participants are exactly the two ids in the pair.
  """
  @spec dms_of_user(integer()) :: [map()]
  def dms_of_user(user_id) do
    Repo.execute!(
      "SELECT channel_id, user_ids, created_at, last_message_id FROM {{K}}.dms_of_user WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.to_list()
    |> Enum.map(&dm_row/1)
  end

  @doc """
  Denormalize `last_message_id` onto a DM channel's rows (dm_channels + both
  participants' dms_of_user index rows) after a message create. Returns
  `:dm` when the id IS a DM channel (the caller then skips the workspace
  channels denormalization — a Scylla UPDATE on the missing channels_by_id
  row would UPSERT a phantom workspace channel), `:not_dm` otherwise.
  Best-effort: failures swallow to `:not_dm`-equivalent (the message is
  already persisted).
  """
  @spec maybe_touch_dm(integer(), integer()) :: :dm | :not_dm
  def maybe_touch_dm(channel_id, message_id)
      when is_integer(channel_id) and is_integer(message_id) do
    case get_dm(channel_id) do
      nil ->
        :not_dm

      dm ->
        Repo.execute!(
          "UPDATE {{K}}.dm_channels SET last_message_id = ? WHERE channel_id = ?",
          [{"bigint", message_id}, {"bigint", channel_id}]
        )

        Enum.each(dm.user_ids || [], fn uid ->
          Repo.execute!(
            "UPDATE {{K}}.dms_of_user SET last_message_id = ? WHERE user_id = ? AND channel_id = ?",
            [{"bigint", message_id}, {"bigint", uid}, {"bigint", channel_id}]
          )
        end)

        :dm
    end
  rescue
    _ -> :not_dm
  end

  defp dm_row(r),
    do: %{
      channel_id: r["channel_id"],
      user_ids: r["user_ids"],
      created_at: r["created_at"],
      last_message_id: r["last_message_id"]
    }

  # The pair→channel lookup against the caller's OWN index partition (the
  # former :persistent_term shim was in-process only and minted a NEW channel
  # per call across processes; the index makes open_dm idempotent).
  defp find_dm(user_a, user_b) do
    pair = Enum.sort([user_a, user_b])

    Enum.find_value(dms_of_user(user_a), fn dm ->
      Enum.sort(dm.user_ids || []) == pair && dm
    end)
  end

  # -- push subscriptions --------------------------------------------------------------

  @doc """
  Register (or refresh) a push subscription.

  `target_type` distinguishes a browser push endpoint from a mobile device
  token (notifications plan R14). Registration is browser-only today, so the
  default is that; the column exists so a mobile token is a second kind of row
  rather than a second table.
  """
  @spec put_push_subscription(integer(), String.t(), String.t(), String.t()) :: :ok
  def put_push_subscription(user_id, endpoint, keys_blob, target_type \\ "web") do
    hash = Base.encode16(:crypto.hash(:sha256, endpoint), case: :lower)
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.push_subscriptions (user_id, subscription_hash, endpoint, keys_blob, target_type, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        {"bigint", user_id},
        {"text", hash},
        {"text", endpoint},
        {"text", keys_blob},
        {"text", target_type},
        {"timestamp", now}
      ]
    )

    :ok
  end

  @doc "Remove a web-push subscription by endpoint."
  @spec delete_push_subscription(integer(), String.t()) :: :ok
  def delete_push_subscription(user_id, endpoint) do
    hash = Base.encode16(:crypto.hash(:sha256, endpoint), case: :lower)

    Repo.execute!(
      "DELETE FROM {{K}}.push_subscriptions WHERE user_id = ? AND subscription_hash = ?",
      [{"bigint", user_id}, {"text", hash}]
    )

    :ok
  end

  # -- internals -----------------------------------------------------------------

  defp row_to_channel(r) do
    %{
      channel_id: r["channel_id"],
      workspace_id: r["workspace_id"],
      name: r["name"],
      type: r["type"],
      parent_id: r["parent_id"],
      topic: r["topic"],
      position: r["position"],
      created_by: r["created_by"],
      created_at: r["created_at"],
      last_message_id: r["last_message_id"]
    }
  end
end
