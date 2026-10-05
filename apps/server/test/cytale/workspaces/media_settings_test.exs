defmodule Cytale.Workspaces.MediaSettingsTest do
  @moduledoc """
  Calls V2 plan U8 (R16/R17) — the media-settings context: settings
  round-trip + defaults, the owner/admin and manage-channels gates, the
  overrides-allowed precondition, and the effective-capability matrix
  (master × override × null × overrides_allowed) the U3 op gates consult.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces
  alias Cytale.Workspaces.MediaSettings

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp make_user(prefix) do
    {:ok, user} = User.create(run_unique(prefix), run_unique(prefix <> "@example.com"), "password-123")
    user
  end

  defp human_claims(user) do
    %{
      user_id: user.user_id,
      username: user.username,
      verified: true,
      kind: :human,
      parent_user_id: nil,
      restrictions: nil
    }
  end

  # Owner + plain member + manage-channels member + admin (manage_workspace)
  # over one workspace with two sibling channels.
  defp seed_workspace do
    owner = make_user("ms_owner")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("Media WS"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, run_unique("general"))
    {:ok, sibling} = Workspaces.create_channel(ws.workspace_id, run_unique("random"))

    member = make_user("ms_member")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id, [])

    # manage_channels (not manage_workspace) — the channel-manager tier.
    manager = make_user("ms_manager")
    :ok = Workspaces.add_member(ws.workspace_id, manager.user_id, owner.user_id, [])

    {:ok, mgr_role} =
      Workspaces.create_role(ws.workspace_id, run_unique("Channel Mgr"),
        permissions: Bitfield.bit(:manage_channels),
        position: 1
      )

    :ok = Workspaces.grant_role(ws.workspace_id, manager.user_id, mgr_role.role_id)

    # manage_workspace — the admin tier (owner holds it implicitly).
    admin = make_user("ms_admin")
    :ok = Workspaces.add_member(ws.workspace_id, admin.user_id, owner.user_id, [])

    {:ok, admin_role} =
      Workspaces.create_role(ws.workspace_id, run_unique("Media Admin"),
        permissions: Bitfield.bit(:manage_workspace),
        position: 2
      )

    :ok = Workspaces.grant_role(ws.workspace_id, admin.user_id, admin_role.role_id)

    %{
      owner: owner,
      member: member,
      manager: manager,
      admin: admin,
      ws_id: ws.workspace_id,
      ch: ch.channel_id,
      sibling: sibling.channel_id
    }
  end

  defp allow_overrides(ctx) do
    {:ok, _} =
      MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{
        overrides_allowed: true
      })

    :ok
  end

  describe "workspace master settings" do
    test "absent row → defaults: everything enabled, overrides disallowed" do
      %{ws_id: ws_id} = seed_workspace()

      assert MediaSettings.get_workspace_settings(ws_id) == %{
               calls: true,
               video: true,
               screenshare: true,
               overrides_allowed: false
             }
    end

    test "owner PUT round-trips; partial PUT keeps the other keys" do
      ctx = seed_workspace()

      assert {:ok, %{video: false}} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{video: false})

      assert MediaSettings.get_workspace_settings(ctx.ws_id) == %{
               calls: true,
               video: false,
               screenshare: true,
               overrides_allowed: false
             }

      assert {:ok, _} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{
                 calls: false,
                 overrides_allowed: true
               })

      assert MediaSettings.get_workspace_settings(ctx.ws_id) == %{
               calls: false,
               video: false,
               screenshare: true,
               overrides_allowed: true
             }
    end

    test "admin (manage_workspace role) may PUT; plain member may not" do
      ctx = seed_workspace()

      assert {:ok, _} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.admin), %{screenshare: false})

      assert {:error, :forbidden} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.member), %{screenshare: true})

      # The member's rejected write never landed.
      assert MediaSettings.get_workspace_settings(ctx.ws_id).screenshare == false
    end

    test "channel manager (manage_channels only) may NOT PUT workspace settings" do
      ctx = seed_workspace()

      assert {:error, :forbidden} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.manager), %{video: false})
    end

    test "unknown workspace → {:error, :not_found}" do
      %{member: member} = seed_workspace()

      assert {:error, :not_found} =
               MediaSettings.put_workspace_settings(Cytale.Snowflake.next(), human_claims(member), %{video: false})
    end

    test "non-member actor → {:error, :forbidden} (no membership oracle)" do
      ctx = seed_workspace()
      outsider = make_user("ms_outsider")

      assert {:error, :forbidden} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(outsider), %{video: false})
    end
  end

  describe "channel overrides" do
    test "absent row → all-NULL (inherit master)" do
      ctx = seed_workspace()

      assert MediaSettings.get_channel_override(ctx.ch) == %{calls: nil, video: nil, screenshare: nil}
    end

    test "manager PUT round-trips while overrides are allowed; null resets to inherit" do
      ctx = seed_workspace()
      :ok = allow_overrides(ctx)

      assert {:ok, %{calls: false, video: true, screenshare: nil}} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.manager), %{
                 calls: false,
                 video: true
               })

      assert MediaSettings.get_channel_override(ctx.ch) == %{calls: false, video: true, screenshare: nil}

      # null resets that capability to inherit.
      assert {:ok, %{calls: nil}} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.manager), %{calls: nil})

      assert MediaSettings.get_channel_override(ctx.ch) == %{calls: nil, video: true, screenshare: nil}
    end

    test "PUT rejected while overrides_allowed is false (the 409-shape conflict)" do
      ctx = seed_workspace()

      assert {:error, :overrides_not_allowed} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.owner), %{video: false})
    end

    test "plain member (no manage_channels) → {:error, :forbidden}" do
      ctx = seed_workspace()
      :ok = allow_overrides(ctx)

      assert {:error, :forbidden} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.member), %{video: false})
    end

    test "unknown channel and DM id → {:error, :unknown_channel} (anti-enumeration)" do
      ctx = seed_workspace()
      :ok = allow_overrides(ctx)

      assert {:error, :unknown_channel} =
               MediaSettings.put_channel_override(Cytale.Snowflake.next(), human_claims(ctx.owner), %{
                 video: false
               })

      assert {:error, :unknown_channel} =
               MediaSettings.get_channel_override_view(Cytale.Snowflake.next(), human_claims(ctx.owner))
    end

    test "non-member actor → {:error, :unknown_channel} on the override paths" do
      ctx = seed_workspace()
      :ok = allow_overrides(ctx)
      outsider = make_user("ms_outsider")

      assert {:error, :unknown_channel} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(outsider), %{video: false})
    end

    test "manager GET view carries override + master + the flag" do
      ctx = seed_workspace()

      assert {:ok, view} = MediaSettings.get_channel_override_view(ctx.ch, human_claims(ctx.manager))
      assert view.override == %{calls: nil, video: nil, screenshare: nil}
      assert view.master.overrides_allowed == false
    end
  end

  describe "effective_capabilities (the U3 op-gate seam)" do
    test "nil workspace (DM) → all true (DM calls skip capability checks)" do
      assert MediaSettings.effective_capabilities(nil, Cytale.Snowflake.next()) == %{
               calls: true,
               video: true,
               screenshare: true
             }
    end

    test "defaults: absent rows → all true" do
      ctx = seed_workspace()

      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.ch) == %{
               calls: true,
               video: true,
               screenshare: true
             }
    end

    test "master off applies everywhere while overrides are disallowed (rows stay inert)" do
      ctx = seed_workspace()

      # Sneak an override row in while allowed, then disallow overrides:
      # the row must go inert, master everywhere (R16).
      :ok = allow_overrides(ctx)

      assert {:ok, _} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.manager), %{video: false})

      assert {:ok, _} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{
                 overrides_allowed: false,
                 screenshare: false
               })

      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.ch) == %{
               calls: true,
               video: true,
               screenshare: false
             }

      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.sibling) == %{
               calls: true,
               video: true,
               screenshare: false
             }
    end

    test "the full matrix: override-then-master with NULLs inheriting" do
      ctx = seed_workspace()

      # master: calls=false, video=true, screenshare=true; overrides allowed.
      assert {:ok, _} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{
                 calls: false,
                 overrides_allowed: true
               })

      # override on the channel: video=false explicit; screenshare reset to
      # NULL (inherit); calls true (flips the master off→on for here).
      assert {:ok, _} =
               MediaSettings.put_channel_override(ctx.ch, human_claims(ctx.manager), %{
                 calls: true,
                 video: false,
                 screenshare: nil
               })

      # Effective: calls ← override (true), video ← override (false),
      # screenshare ← NULL → master (true).
      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.ch) == %{
               calls: true,
               video: false,
               screenshare: true
             }

      # The sibling channel: pure master.
      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.sibling) == %{
               calls: false,
               video: true,
               screenshare: true
             }
    end

    test "master toggled mid-call is gate-time only: capabilities change, nothing evicts" do
      ctx = seed_workspace()
      :ok = allow_overrides(ctx)

      # (The eviction posture itself is U3's; this pins that resolution is a
      # pure function of the current rows — flipping the master flips the
      # answer for the NEXT check, no side channel involved.)
      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.ch).video == true

      assert {:ok, _} =
               MediaSettings.put_workspace_settings(ctx.ws_id, human_claims(ctx.owner), %{video: false})

      assert MediaSettings.effective_capabilities(ctx.ws_id, ctx.ch).video == false
    end
  end
end
