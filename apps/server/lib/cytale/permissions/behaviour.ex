defmodule Cytale.Permissions.Behaviour do
  @moduledoc """
  The permission-engine seam (U7, R6).

  Callers depend on this behaviour, never on an implementation. Today the
  pure-Elixir `Cytale.Permissions.ElixirImpl` satisfies it; a future Rustler
  NIF module (dirty_cpu) satisfies it later WITHOUT touching call sites —
  that is the whole point of the seam.

  Two capability groups live on the seam:

    * `evaluate/2` — the 8-step Discord resolution algorithm
      (workspace roles + channel overwrites → effective permissions).
    * `can_manage_role?/3` — role-hierarchy predicates (resolved open
      question, 2026-08-27): EVERY role/overwrite mutation path (REST U9,
      gateway handlers) must gate through these. Strict positional ordering:
      the actor's highest role position must EXCEED the target's position.
      The workspace owner is exempt. ADMINISTRATOR does NOT bypass
      hierarchy — the predicate sees positions only, never permissions.
      Denials surface as a distinct API error key (U9 envelope).
  """

  @typedoc "A role-shaped input: id, permissions bitfield, position."
  @type role_input :: %{
          required(:id) => term(),
          required(:permissions) => Cytale.Permissions.Bitfield.t(),
          optional(:everyone) => boolean(),
          optional(:position) => integer()
        }

  @typedoc """
  A channel overwrite: `target_type` (:role | :member), `target_id`, and the
  allow/deny bitfields.
  """
  @type overwrite_input :: %{
          required(:target_type) => :role | :member,
          required(:target_id) => term(),
          required(:allow) => Cytale.Permissions.Bitfield.t(),
          required(:deny) => Cytale.Permissions.Bitfield.t()
        }

  @typedoc "Evaluation options. `:member_id` scopes steps 7–8 to that member."
  @type eval_opt :: {:member_id, term()}

  @callback evaluate([role_input()], [overwrite_input()]) :: Cytale.Permissions.Bitfield.t()

  @callback evaluate([role_input()], [overwrite_input()], [eval_opt()]) ::
              Cytale.Permissions.Bitfield.t()

  @doc """
  Hierarchy predicate: may an actor whose roles hold `actor_positions`
  manage a role at `target_position`?

    * strict ordering — actor's MAX position must be > target position;
    * equal position is denied (you cannot manage a role at your own level);
    * `:owner => true` opts exempt (workspace owner manages everything);
    * `:administrator => true` changes NOTHING — admin does not bypass
      hierarchy (Discord-conformant).
  """
  @callback can_manage_role?([integer()], integer(), keyword()) :: boolean()

  # Convenience delegating forms so callers can invoke the predicate through
  # the behaviour module directly (impl passed explicitly — no global config).
  def evaluate(impl, roles, overwrites, opts \\ [])

  def evaluate(impl, roles, overwrites, opts) when is_atom(impl) and is_list(opts) do
    if function_exported?(impl, :evaluate, 3) do
      impl.evaluate(roles, overwrites, opts)
    else
      impl.evaluate(roles, overwrites)
    end
  end

  def can_manage_role?(impl, actor_positions, target_position, opts \\ [])

  def can_manage_role?(impl, actor_positions, target_position, opts)
      when is_atom(impl) and is_list(opts) do
    impl.can_manage_role?(actor_positions, target_position, opts)
  end
end
