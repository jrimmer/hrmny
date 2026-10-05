defmodule Cytale.Permissions.BehaviourTest do
  @moduledoc """
  U7 — the behaviour seam and the 8-step resolution algorithm.

  Covers every plan test scenario:
    * role grants SEND_MESSAGES at workspace level → member can send
    * member whose roles lack it cannot
    * ADMINISTRATOR bypasses ALL channel overwrites (returns all)
    * channel-level deny overrides workspace-level allow
    * member overwrite (steps 7–8) wins over role deny
  plus the hierarchy fixpoints from the resolved open question (2026-08-27):
    * strict positional ordering (equal position denied)
    * self-target denied
    * workspace-owner exempt
    * ADMINISTRATOR does NOT bypass hierarchy
  """

  use ExUnit.Case, async: true

  import Bitwise

  alias Cytale.Permissions.{Behaviour, Bitfield, ElixirImpl}

  # -- input shorthands ---------------------------------------------------------

  defp everyone(perms), do: %{id: :everyone, permissions: perms, everyone: true}

  defp role(id, perms), do: %{id: id, permissions: perms}

  defp ow_role(target_id, allow, deny),
    do: %{target_type: :role, target_id: target_id, allow: allow, deny: deny}

  defp ow_member(target_id, allow, deny),
    do: %{target_type: :member, target_id: target_id, allow: allow, deny: deny}

  defp evaluate(roles, overwrites), do: Behaviour.evaluate(ElixirImpl, roles, overwrites)

  @send Bitfield.bit(:send_messages)
  @view Bitfield.bit(:view_channel)
  @manage Bitfield.bit(:manage_channels)

  # -- the seam -------------------------------------------------------------------

  test "ElixirImpl satisfies the behaviour (callback exists, impl compiles)" do
    functions = Behaviour.behaviour_info(:callbacks)

    assert {:evaluate, 2} in functions
    assert {:can_manage_role?, 3} in functions
  end

  # -- 8-step resolution ------------------------------------------------------------

  test "role granting SEND_MESSAGES at workspace level → member can send" do
    perms = evaluate([everyone(@view), role(:devs, @send)], [])

    assert Bitfield.has?(perms, :send_messages)
    assert Bitfield.has?(perms, :view_channel)
  end

  test "member whose roles lack SEND_MESSAGES cannot send" do
    perms = evaluate([everyone(@view), role(:lurkers, 0)], [])

    refute Bitfield.has?(perms, :send_messages)
  end

  test "channel @everyone deny overrides workspace-level allow (step 3)" do
    # everyone role grants send; channel denies send for @everyone
    perms = evaluate([everyone(@view ||| @send)], [ow_role(:everyone, 0, @send)])

    refute Bitfield.has?(perms, :send_messages)
    assert Bitfield.has?(perms, :view_channel)
  end

  test "channel @everyone allow grants bits the workspace never gave (step 4)" do
    perms = evaluate([everyone(0)], [ow_role(:everyone, @view, 0)])

    assert Bitfield.has?(perms, :view_channel)
  end

  test "per-role channel allow re-grants after @everyone deny (step 6 over 3)" do
    # Discord precedence: role allows beat the @everyone deny.
    perms =
      evaluate(
        [everyone(@view ||| @send), role(:devs, @send)],
        [ow_role(:everyone, 0, @send), ow_role(:devs, @send, 0)]
      )

    assert Bitfield.has?(perms, :send_messages)
  end

  test "per-role deny strips a workspace-granted bit (step 5)" do
    perms =
      evaluate(
        [everyone(@view), role(:muted, @send)],
        [ow_role(:muted, 0, @send)]
      )

    refute Bitfield.has?(perms, :send_messages)
  end

  test "member overwrite allow wins over role deny (steps 7–8, later stage wins)" do
    perms =
      evaluate(
        [everyone(@view), role(:muted, @send)],
        [ow_role(:muted, 0, @send), ow_member(:user_1, @send, 0)]
      )

    assert Bitfield.has?(perms, :send_messages)
  end

  test "member overwrite deny strips everything below it (step 7)" do
    perms =
      evaluate(
        [everyone(@view ||| @send ||| @manage)],
        [ow_member(:user_1, 0, @manage)]
      )

    refute Bitfield.has?(perms, :manage_channels)
    assert Bitfield.has?(perms, :send_messages)
  end

  test "evaluate/2 treats member overwrites as caller-scoped (plan's 2-arg callback)" do
    # The 2-arg callback has no member identity: the CALLER supplies this
    # member's overwrite. The deny below therefore applies.
    perms =
      evaluate(
        [everyone(@view ||| @send)],
        [ow_member(:user_1, 0, @send)]
      )

    refute Bitfield.has?(perms, :send_messages)
  end

  test "member-scoped evaluation: deny hits only the named member" do
    perms =
      Behaviour.evaluate(ElixirImpl, [everyone(@view ||| @send)], [ow_member(:user_1, 0, @send)], member_id: :user_1)

    refute Bitfield.has?(perms, :send_messages)

    perms_other =
      Behaviour.evaluate(ElixirImpl, [everyone(@view ||| @send)], [ow_member(:user_1, 0, @send)], member_id: :user_2)

    assert Bitfield.has?(perms_other, :send_messages)
  end

  # -- ADMINISTRATOR bypass -------------------------------------------------------

  test "ADMINISTRATOR bypasses ALL channel overwrites (returns the full bitfield)" do
    admin = Bitfield.administrator()

    perms =
      evaluate(
        [everyone(admin)],
        [
          ow_role(:everyone, 0, Bitfield.all()),
          ow_role(:devs, 0, Bitfield.all()),
          ow_member(:user_1, 0, Bitfield.all())
        ]
      )

    assert perms == Bitfield.all()
  end

  test "ADMINISTRATOR held on ANY role (not just @everyone) triggers the bypass" do
    perms =
      evaluate(
        [everyone(@view), role(:boss, Bitfield.administrator())],
        [ow_role(:everyone, 0, Bitfield.all())]
      )

    assert perms == Bitfield.all()
  end

  test "without ADMINISTRATOR, overwrites apply even against strong role grants" do
    strong = Bitfield.all() - Bitfield.administrator()

    perms =
      evaluate(
        [everyone(@view), role(:devs, strong)],
        [ow_role(:devs, 0, @send)]
      )

    refute Bitfield.has?(perms, :send_messages)
    assert perms != Bitfield.all()
  end

  # -- role hierarchy (resolved open question, 2026-08-27) ----------------------------

  test "hierarchy: actor's highest position must EXCEED the target's (strict ordering)" do
    assert Behaviour.can_manage_role?(ElixirImpl, [10, 5], 9)
    refute Behaviour.can_manage_role?(ElixirImpl, [10, 5], 10)
    refute Behaviour.can_manage_role?(ElixirImpl, [10], 11)
  end

  test "hierarchy fixpoint: equal-position target denied" do
    refute Behaviour.can_manage_role?(ElixirImpl, [7], 7)
    refute Behaviour.can_manage_role?(ElixirImpl, [7, 3], 7)
  end

  test "hierarchy fixpoint: self-target denied (managing your own top role)" do
    # The actor's own top role is at position 7; targeting that same role is
    # an equal-position target → denied even though "it's mine".
    refute Behaviour.can_manage_role?(ElixirImpl, [7], 7)
  end

  test "hierarchy fixpoint: workspace owner is exempt" do
    assert Behaviour.can_manage_role?(ElixirImpl, [1], 100, owner: true)
    # owner exemption does not extend to non-owners
    refute Behaviour.can_manage_role?(ElixirImpl, [1], 2, owner: false)
  end

  test "hierarchy: ADMINISTRATOR alone does NOT bypass the position bound" do
    # Documented on the seam: the predicate never sees permissions, only
    # positions — an admin flag passed in changes nothing.
    refute Behaviour.can_manage_role?(ElixirImpl, [3], 7, administrator: true)
  end
end
