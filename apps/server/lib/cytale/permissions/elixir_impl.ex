defmodule Cytale.Permissions.ElixirImpl do
  @moduledoc """
  Pure-Elixir implementation of the permission-engine seam (U7).

  The 8-step Discord resolution algorithm:

    1. start from the @everyone role's permissions (base)
    2. OR in the union of the member's other roles
       (ADMINISTRATOR anywhere → short-circuit to the full bitfield)
    3. AND-NOT the @everyone channel-overwrite deny bits
    4. OR the @everyone channel-overwrite allow bits
    5. AND-NOT the union of per-role deny bits (roles the member holds)
    6. OR the union of per-role allow bits (roles the member holds)
    7. AND-NOT the member overwrite deny bits
    8. OR the member overwrite allow bits

  Later stages win on the same bit (Discord precedence): per-role allows beat
  the @everyone deny; the member overwrite beats role denies. This is the
  plan's deny-union/allow-union form — union-first per stage, so overwrite
  list order never changes the result (the TS mirror in
  packages/domain/src/channel-permissions.ts applies overwrites sequentially;
  the server is the authority and this form is order-independent).

  Pure function over plain data — the first Rust NIF offload candidate:
  swap in behind `Cytale.Permissions.Behaviour` without touching callers.
  """

  @behaviour Cytale.Permissions.Behaviour

  alias Cytale.Permissions.Bitfield

  @impl true
  @spec evaluate([Behaviour.role_input()], [Behaviour.overwrite_input()]) ::
          Bitfield.t()
  def evaluate(roles, overwrites), do: evaluate(roles, overwrites, [])

  @impl true
  @spec evaluate([Behaviour.role_input()], [Behaviour.overwrite_input()], [Behaviour.eval_opt()]) ::
          Bitfield.t()
  def evaluate(roles, overwrites, opts) when is_list(roles) and is_list(overwrites) do
    member_id = Keyword.get(opts, :member_id)

    {everyone_roles, member_roles} =
      Enum.split_with(roles, & &1[:everyone])

    # Step 1: base @everyone (missing/empty → base 0; later steps can grant).
    base =
      case everyone_roles do
        [everyone | _] -> everyone.permissions
        [] -> 0
      end

    # Step 2: OR the union of held roles.
    perms = Enum.reduce(member_roles, base, &Bitwise.bor(&2, &1.permissions))

    # ADMINISTRATOR bypass: short-circuit to ALL before any overwrite applies.
    if Bitfield.has?(perms, :administrator) do
      Bitfield.all()
    else
      everyone_ows =
        Enum.filter(overwrites, &(&1.target_type == :role and &1.target_id == base_everyone_id(everyone_roles, roles)))

      role_ows = Enum.filter(overwrites, &(&1.target_type == :role and &1.target_id in role_ids(member_roles)))

      member_ows =
        case member_id do
          nil -> Enum.filter(overwrites, &(&1.target_type == :member))
          id -> Enum.filter(overwrites, &(&1.target_type == :member and &1.target_id == id))
        end

      perms
      # Steps 3–4: @everyone overwrite (deny then allow).
      |> apply_stage(everyone_ows)
      # Steps 5–6: per-role overwrites (union of denies, union of allows).
      |> apply_stage(role_ows)
      # Steps 7–8: member overwrite. The 2-arg form has no member identity,
      # so the CALLER pre-scopes which member overwrites to pass (plan's
      # evaluate/2 callback); the 3-arg form scopes by :member_id here.
      |> apply_stage(member_ows)
    end
  end

  @impl true
  @spec can_manage_role?([integer()], integer(), keyword()) :: boolean()
  def can_manage_role?(actor_positions, target_position, opts)
      when is_list(actor_positions) and is_integer(target_position) and is_list(opts) do
    cond do
      Keyword.get(opts, :owner, false) ->
        # Workspace owner manages every role regardless of positions.
        true

      actor_positions == [] ->
        false

      true ->
        # Strict ordering: strictly greater. Equal position denied. The
        # :administrator flag is deliberately read and ignored — ADMINISTRATOR
        # does NOT bypass hierarchy.
        _ = Keyword.get(opts, :administrator, false)
        Enum.max(actor_positions) > target_position
    end
  end

  # -- stage application: union of denies, then union of allows ----------------

  defp apply_stage(perms, overwrites) do
    denied = Enum.reduce(overwrites, 0, &Bitwise.bor(&2, &1.deny))
    allowed = Enum.reduce(overwrites, 0, &Bitwise.bor(&2, &1.allow))

    perms
    |> Bitfield.band_not(denied)
    |> Bitwise.bor(allowed)
  end

  defp base_everyone_id([everyone | _], _roles), do: everyone.id
  defp base_everyone_id([], [first | _]), do: first[:id] || :everyone

  defp role_ids(member_roles), do: Enum.map(member_roles, & &1.id)
end
