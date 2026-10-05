defmodule CytaleWeb.MemberEvents do
  @moduledoc """
  Live workspace-membership announcements — ONE path for people and machines.

  A client names every author, thread starter and reply target from its member
  roster. The roster is read once per session (the people page) and then kept
  current by `MemberAdd`/`MemberRemove`. People always had their `MemberAdd`
  (invite accept, register-with-invite); a machine principal did not: it
  becomes a member by ASSOCIATION (its owner's grant for the workspace), and
  nothing announced a grant. A bot granted after a viewer's client hydrated
  therefore never reached that roster, and its messages and threads rendered
  its raw snowflake — and the thread header fell back to the seed author, the
  viewer (2026-10-02, the Hermes approval threads).

  So association changes announce exactly like a join does, through the same
  payload — the people row's wire shape (`Cytale.Workspaces.roster_entry_wire/1`:
  name, avatar, kind, parent) plus `workspace_id`:

    * `announce_join/2` — a person joined: their `MemberAdd`, then one for each
      of their machine principals the join associates (an `all`-mode grant
      reaches the new workspace the moment the owner does).
    * `announce_grant_change/3` — an owner rewrote a machine principal's
      access: `MemberAdd` for each workspace it newly reaches, `MemberRemove`
      for each it no longer does.

  Departures are the mirror image, and they take two steps because the
  association has to be read BEFORE the rows that define it are deleted:
  `departures/1,2` lists who is about to leave which roster (a person and
  every machine of theirs that rode their membership there; or one machine and
  every workspace its grant reached), the caller removes, then
  `announce_departures/1` sends one `MemberRemove` each. Kick, account
  deletion and bot deletion go through it (a webhook is never a roster member:
  it holds no grant, so its deletion leaves no roster).

  Profile changes (`announce_profile/1`) publish the ONE `UserUpdate` shape
  for people and machines alike: `username` is always the account's handle
  (the @tag) and `display_name` the name it shows — a bot's label rides
  `display_name` exactly as a person's display name does.
  """

  alias Cytale.Accounts.Principals
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces

  @doc "A person joined `workspace_id`: announce them and the machines they bring."
  @spec announce_join(integer(), integer()) :: :ok
  def announce_join(workspace_id, user_id) do
    announce_add(workspace_id, user_id)

    for principal <- Principals.list_by_parent(user_id) do
      announce_add(workspace_id, principal.user_id)
    end

    :ok
  end

  @doc """
  A machine principal's access document changed from `old_access` to the
  stored one: announce the workspaces it entered and left.
  """
  @spec announce_grant_change(map(), map() | nil, map() | nil) :: :ok
  def announce_grant_change(%{user_id: user_id, parent_user_id: parent_user_id}, old_access, new_access)
      when is_integer(parent_user_id) do
    before = MapSet.new(Workspaces.associated_workspace_ids(parent_user_id, old_access))
    now = MapSet.new(Workspaces.associated_workspace_ids(parent_user_id, new_access))

    for workspace_id <- MapSet.difference(now, before), do: announce_add(workspace_id, user_id)
    for workspace_id <- MapSet.difference(before, now), do: announce_remove(workspace_id, user_id)

    :ok
  end

  def announce_grant_change(_principal, _old_access, _new_access), do: :ok

  @typedoc "One roster departure: `{workspace_id, member_id}`."
  @type departure :: {integer(), integer()}

  @doc """
  Who leaves which roster when `user_id` goes — read BEFORE the removal.

    * a person: every workspace they belong to, plus, in each, every machine
      principal of theirs associated there (membership by association ends
      with the owner's membership);
    * a machine principal: every workspace its grant reaches.
  """
  @spec departures(integer()) :: [departure()]
  def departures(user_id) when is_integer(user_id) do
    case Principals.get(user_id) do
      %{parent_user_id: parent_user_id, access: access} when is_integer(parent_user_id) ->
        for workspace_id <- Workspaces.associated_workspace_ids(parent_user_id, access), do: {workspace_id, user_id}

      _ ->
        person_departures(user_id, Workspaces.workspace_ids_of_user(user_id))
    end
  end

  @doc "`departures/1` restricted to one workspace (a person removed from it — a kick)."
  @spec departures(integer(), integer()) :: [departure()]
  def departures(user_id, workspace_id) when is_integer(user_id) and is_integer(workspace_id) do
    user_id |> departures() |> Enum.filter(fn {ws, _id} -> ws == workspace_id end)
  end

  @doc "Announce departures (from `departures/1,2`): one `MemberRemove` each."
  @spec announce_departures([departure()]) :: :ok
  def announce_departures(departures) when is_list(departures) do
    Enum.each(departures, fn {workspace_id, user_id} -> announce_remove(workspace_id, user_id) end)
  end

  @doc """
  A profile changed (a person's display name or avatar; a bot's label or
  avatar; a webhook's name): publish the account's `UserUpdate` to every
  workspace and DM it touches. Read from the stored row, so what goes out is
  what a reload would read. `username` is the handle — a machine row minted
  without one (a webhook) carries its label there, as the roster does.
  """
  @spec announce_profile(integer() | map() | nil) :: :ok
  def announce_profile(user_id) when is_integer(user_id), do: announce_profile(Cytale.Accounts.User.get(user_id))
  def announce_profile(nil), do: :ok

  def announce_profile(%{user_id: user_id} = user) do
    Cytale.Publish.publish_user_update(user_id, {
      "UserUpdate",
      %{
        "id" => Integer.to_string(user_id),
        "username" => user.username || user.display_name,
        "display_name" => user.display_name,
        "avatar_url" => user.avatar_url
      }
    })
  end

  # A person's departures: their own membership rows plus, per workspace, the
  # machines of theirs whose grant reaches it.
  defp person_departures(_user_id, []), do: []

  defp person_departures(user_id, workspace_ids) do
    machines = Principals.list_by_parent(user_id)

    Enum.flat_map(workspace_ids, fn workspace_id ->
      associated =
        for principal <- machines,
            Cytale.Access.level_for_workspace(principal.access, workspace_id) != :none,
            do: {workspace_id, principal.user_id}

      [{workspace_id, user_id} | associated]
    end)
  end

  # The roster entry decides membership: no entry (not associated after all —
  # e.g. a race with a leave) means nothing to announce.
  defp announce_add(workspace_id, user_id) do
    case Workspaces.roster_entry(workspace_id, user_id) do
      nil -> :ok
      entry -> fan_out(workspace_id, {"MemberAdd", member_add(workspace_id, Workspaces.roster_entry_wire(entry))})
    end
  end

  # Spelled out (not `Map.put` on the row) so the payload's keys are written
  # down at the emission site the protocol manifest reads. `parent_user_id`
  # and `dm_support` ride only where the row has them, as on the people page.
  defp member_add(workspace_id, row) do
    %{
      "workspace_id" => Integer.to_string(workspace_id),
      "user" => row["user"],
      "nickname" => row["nickname"],
      "joined_at" => row["joined_at"],
      "roles" => row["roles"],
      "kind" => row["kind"],
      "parent_user_id" => row["parent_user_id"],
      "dm_support" => row["dm_support"]
    }
    |> Map.reject(fn {key, value} -> key in ["parent_user_id", "dm_support"] and is_nil(value) end)
  end

  defp announce_remove(workspace_id, user_id) do
    fan_out(
      workspace_id,
      {"MemberRemove", %{"user_id" => Integer.to_string(user_id), "workspace_id" => Integer.to_string(workspace_id)}}
    )
  end

  @doc """
  A member's workspace nickname changed (#169): `MemberUpdate` to the
  workspace, so every open client re-renders the name at once. `nickname` is
  null when cleared. Spelled out at the emission site the protocol manifest
  reads.
  """
  @spec announce_nickname(integer(), integer(), String.t() | nil) :: :ok
  def announce_nickname(workspace_id, user_id, nickname) do
    fan_out(
      workspace_id,
      {"MemberUpdate",
       %{
         "workspace_id" => Integer.to_string(workspace_id),
         "user_id" => Integer.to_string(user_id),
         "nickname" => nickname
       }}
    )
  end

  defp fan_out(workspace_id, envelope) do
    CytaleWeb.GatewaySocket.fan_out(PushRegistry.workspace_key(Integer.to_string(workspace_id)), envelope)
    :ok
  end
end
