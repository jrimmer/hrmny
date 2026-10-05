defmodule CytaleWeb.Nicknames do
  @moduledoc """
  Per-workspace nicknames (#169) — the ONE path both the native route
  (`PATCH /workspaces/:id/members/@me|:user_id`) and the Discord-compatible one
  (`PATCH /guilds/:id/members/@me|:user_id`) go through, for people and machine
  principals alike (bots and people get the same capability through the same
  code path).

  Authorization, Discord's model:

    * your OWN nickname needs CHANGE_NICKNAME (in the @everyone base; a bot
      holds it through a `read_write` grant, ANDed with its owner's bits) or
      MANAGE_NICKNAMES;
    * ANYONE ELSE's needs MANAGE_NICKNAMES plus the hierarchy gate
      (`Hierarchy.manage_nickname/3`: never the owner unless you are the
      owner, and only below your highest role).

  A nickname must not be a name another member of the workspace is already
  shown by (`Workspaces.name_taken?/3`, owner decision 2026-10-04).

  On success the change is stored (`Workspaces.set_nickname/3`) and announced
  to the workspace as `MemberUpdate`.
  """

  alias Cytale.Permissions.{Bitfield, Hierarchy}
  alias Cytale.Permissions.Principal, as: PrincipalRights
  alias Cytale.Workspaces

  @type error :: :unknown_workspace | :not_member | :forbidden | :invalid_nickname | :name_taken

  @doc """
  Set `target_user_id`'s nickname in `workspace_id` as the principal `claims`
  (nil or blank clears). `{:ok, nickname_or_nil}` or `{:error, reason}`.
  """
  @spec change(integer(), map(), integer(), String.t() | nil) :: {:ok, String.t() | nil} | {:error, error()}
  def change(workspace_id, claims, target_user_id, nickname)
      when is_integer(workspace_id) and is_map(claims) and is_integer(target_user_id) do
    with true <- Workspaces.get_workspace(workspace_id) != nil || {:error, :unknown_workspace},
         {:ok, bits} <- actor_bits(workspace_id, claims),
         true <- Workspaces.roster_entry(workspace_id, target_user_id) != nil || {:error, :not_member},
         :ok <- authorize(workspace_id, claims, target_user_id, bits),
         :ok <- unique(workspace_id, target_user_id, nickname),
         {:ok, nick} <- Workspaces.set_nickname(workspace_id, target_user_id, nickname) do
      :ok = CytaleWeb.MemberEvents.announce_nickname(workspace_id, target_user_id, nick)
      {:ok, nick}
    end
  end

  # A caller who cannot see the workspace at all reads exactly like an unknown
  # workspace (no existence oracle — the members list's rule).
  defp actor_bits(workspace_id, claims) do
    case PrincipalRights.resolve(workspace_id, claims, nil) do
      {:ok, bits} when is_integer(bits) -> {:ok, bits}
      _ -> {:error, :unknown_workspace}
    end
  end

  # A shown name is unique in a workspace (owner decision 2026-10-04): a
  # nickname another member is already shown by (nickname, display name or
  # username) is refused. Clearing is always allowed.
  defp unique(_workspace_id, _target, nil), do: :ok

  defp unique(workspace_id, target, nickname) when is_binary(nickname) do
    if String.trim(nickname) != "" and Workspaces.name_taken?(workspace_id, nickname, target),
      do: {:error, :name_taken},
      else: :ok
  end

  defp unique(_workspace_id, _target, _other), do: :ok

  defp authorize(_workspace_id, %{user_id: self_id}, self_id, bits) do
    if Bitfield.has?(bits, :change_nickname) or Bitfield.has?(bits, :manage_nicknames),
      do: :ok,
      else: {:error, :forbidden}
  end

  defp authorize(workspace_id, claims, target_user_id, bits) do
    with true <- Bitfield.has?(bits, :manage_nicknames) || {:error, :forbidden},
         :ok <- Hierarchy.manage_nickname(workspace_id, claims, target_user_id) do
      :ok
    end
  end
end
