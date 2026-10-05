defmodule Cytale.Permissions.Hierarchy do
  @moduledoc """
  Role-hierarchy enforcement (#35 P0-4) — the shared gate every role
  mutation must pass, beside the resolver so every current and future
  surface (native REST today; compat/gateway ops when they grow role
  routes) inherits it. Wraps U7's `can_manage_role?` predicate (strict
  position bound — ADMINISTRATOR deliberately does NOT bypass) with the two
  guards the controller layer never enforced:

    * **No self-targeting grants/revokes** — a MANAGE_ROLES holder granting
      themselves a role they don't hold is self-service escalation.
    * **No mutating a role the actor holds** — editing your own role's
      permission bitfield (e.g. adding `administrator`, which short-circuits
      evaluate to the full bitfield) is the same escalation with one request.

  The workspace owner manages every role unconditionally (U7's owner rule).
  A non-owner manager must hold a role STRICTLY above the target's position
  (equal is denied), and an edit may not move a role to or above the
  actor's own maximum position (it would strand it beyond the actor's
  manage bound — Discord's rule).

  The verdict is `:ok | {:error, :forbidden}` — callers render their own
  surface-appropriate denial; the gate never leaks whether the target role
  exists (existence probes ride the controller's own 404 paths AFTER this
  gate passes).
  """

  alias Cytale.Permissions.Principal
  alias Cytale.Workspaces

  @type verdict :: :ok | {:error, :forbidden}

  @type opt ::
          {:target_position, integer()}
          | {:new_position, integer() | nil}
          | {:target_role_id, integer() | nil}
          | {:target_user_id, integer() | nil}

  @doc """
  Gate a role mutation. `opts`:

    * `:target_position` (required) — the target role's CURRENT position
      (for `create`, the position the new role would take).
    * `:new_position` — for edits: the position the role would MOVE to.
    * `:target_role_id` — for edits/deletes: detects the self-held guard.
    * `:target_user_id` — for grants/revokes: detects the self-target guard.
  """
  @spec manage_role(integer(), Principal.claims(), [opt()]) :: verdict
  def manage_role(workspace_id, claims, opts) when is_integer(workspace_id) and is_map(claims) do
    case Workspaces.get_workspace(workspace_id) do
      %{owner_id: owner_id} when owner_id == claims.user_id ->
        :ok

      %{} ->
        member_verdict(workspace_id, claims, opts)

      nil ->
        # Unknown workspace: fail closed — the controller's own existence
        # check renders the 404 for the probes that follow.
        {:error, :forbidden}
    end
  end

  @doc """
  Gate the permission BITS a role mutation would confer: every bit `adding`
  names must already be in the actor's effective WORKSPACE bits (the one
  resolver — the owner and ADMINISTRATOR holders resolve to the full set, and
  a machine principal to its parent's reach ∩ its grant). Without this, a
  MANAGE_ROLES holder could mint a role carrying ADMINISTRATOR below their own
  position, and a peer (or an alt) holding it would out-rank everyone.

  `adding` is the bits the mutation ADDS (a create: all of them; an edit: the
  new mask minus the role's current one), so a manager can still edit — or
  strip bits from — a role that already carries bits they do not hold.
  """
  @spec grant_bits(integer(), Principal.claims(), non_neg_integer()) :: verdict
  def grant_bits(_workspace_id, _claims, 0), do: :ok

  def grant_bits(workspace_id, claims, adding) when is_integer(workspace_id) and is_integer(adding) do
    case Principal.resolve(workspace_id, claims, nil) do
      {:ok, actor_bits} ->
        if Bitwise.band(adding, Bitwise.bnot(actor_bits)) == 0, do: :ok, else: {:error, :forbidden}

      _ ->
        {:error, :forbidden}
    end
  end

  @doc """
  Gate removing (kicking) `target_user_id` from the workspace — Discord's
  rule: never the owner, never yourself, and a non-owner actor must hold a
  role STRICTLY above the target's highest role (equal is denied, the same
  strict bound as `manage_role/3`). The owner may remove anyone else.
  ADMINISTRATOR does not bypass the position bound.
  """
  @spec kick_member(integer(), Principal.claims(), integer()) :: verdict
  def kick_member(workspace_id, claims, target_user_id)
      when is_integer(workspace_id) and is_map(claims) and is_integer(target_user_id) do
    case Workspaces.get_workspace(workspace_id) do
      nil ->
        {:error, :forbidden}

      %{owner_id: owner_id} ->
        cond do
          target_user_id == owner_id -> {:error, :forbidden}
          target_user_id == claims.user_id -> {:error, :forbidden}
          claims.user_id == owner_id -> :ok
          true -> outranks?(workspace_id, claims.user_id, target_user_id)
        end
    end
  end

  @doc """
  Gate setting ANOTHER member's workspace nickname with MANAGE_NICKNAMES
  (#169) — Discord's rule, the kick rule's shape: never the owner (unless the
  owner is the actor), and a non-owner actor must hold a role STRICTLY above
  the target's highest. Your own nickname is CHANGE_NICKNAME's business, not
  this gate's. A machine principal holds no roles, so it sits at position 0.
  """
  @spec manage_nickname(integer(), Principal.claims(), integer()) :: verdict
  def manage_nickname(workspace_id, claims, target_user_id)
      when is_integer(workspace_id) and is_map(claims) and is_integer(target_user_id) do
    case Workspaces.get_workspace(workspace_id) do
      nil ->
        {:error, :forbidden}

      %{owner_id: owner_id} ->
        cond do
          claims.user_id == owner_id ->
            :ok

          target_user_id == owner_id ->
            {:error, :forbidden}

          Workspaces.get_member(workspace_id, target_user_id) == nil ->
            outranks_position?(workspace_id, claims.user_id, 0)

          true ->
            outranks?(workspace_id, claims.user_id, target_user_id)
        end
    end
  end

  defp outranks_position?(workspace_id, actor_id, target_position) do
    case Principal.load_member_roles(workspace_id, actor_id) do
      {:ok, actor_roles} ->
        if top_position(actor_roles) > target_position, do: :ok, else: {:error, :forbidden}

      {:error, :not_found} ->
        {:error, :forbidden}
    end
  end

  defp outranks?(workspace_id, actor_id, target_id) do
    with {:ok, actor_roles} <- Principal.load_member_roles(workspace_id, actor_id),
         {:ok, target_roles} <- Principal.load_member_roles(workspace_id, target_id) do
      if top_position(actor_roles) > top_position(target_roles), do: :ok, else: {:error, :forbidden}
    else
      {:error, :not_found} -> {:error, :forbidden}
    end
  end

  # The highest position among the roles a member HOLDS (the synthetic
  # @everyone base is not held; a member with no roles sits at 0).
  defp top_position(roles) do
    case Enum.reject(roles, & &1.everyone) do
      [] -> 0
      held -> held |> Enum.map(& &1.position) |> Enum.max()
    end
  end

  defp member_verdict(workspace_id, claims, opts) do
    with {:ok, roles} <- Principal.load_member_roles(workspace_id, claims.user_id) do
      # load_member_roles prepends the synthetic @everyone base (position 0)
      # — it is not a role the actor "holds" and never the bound provider.
      held = Enum.reject(roles, & &1.everyone)
      max_position = if held == [], do: 0, else: held |> Enum.map(& &1.position) |> Enum.max()

      target_position = Keyword.fetch!(opts, :target_position)
      new_position = Keyword.get(opts, :new_position)
      target_role_id = Keyword.get(opts, :target_role_id)
      target_user_id = Keyword.get(opts, :target_user_id)

      cond do
        # Strict bound: equal position denied (can_manage_role?'s contract).
        max_position <= target_position ->
          {:error, :forbidden}

        # An edit may not move the role to or above the actor's bound.
        is_integer(new_position) and max_position <= new_position ->
          {:error, :forbidden}

        # No granting/revoking to or from yourself.
        is_integer(target_user_id) and target_user_id == claims.user_id ->
          {:error, :forbidden}

        # No mutating a role you hold (permission-bitfiled self-elevation).
        is_integer(target_role_id) and Enum.any?(held, &(&1.id == target_role_id)) ->
          {:error, :forbidden}

        true ->
          :ok
      end
    else
      # Not a member (or unreadable membership): fail closed.
      {:error, :not_found} -> {:error, :forbidden}
    end
  end
end
