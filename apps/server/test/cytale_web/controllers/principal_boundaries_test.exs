defmodule CytaleWeb.Controllers.PrincipalBoundariesTest do
  @moduledoc """
  Security tier 1 #9 — where a machine credential (or a plain member) could
  step outside the boundary its grant draws:

    * (a) a bot token could accept invites and create workspaces — minting
      memberships of its own, outside its parent's reach;
    * (b) any member could mint invites (no CREATE_INVITES check);
    * (c) re-accepting an invite as an existing member wiped their roles;
    * (d) the access document's `dms` level was never enforced;
    * (e) machine principals could hold SSH certificates / passkeys, and a JWT
      naming a machine resolved as a HUMAN (the session-bridge half lives in
      `SessionBridgeControllerTest`).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Permissions.Bitfield
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp unique(base), do: base <> Cytale.TestNonce.get()

  defp human! do
    {:ok, user} = User.create(unique("pb_u"), unique("pb_u") <> "@example.com", "password-123")
    :ok = User.mark_verified!(user.user_id)
    user
  end

  defp json_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp as_human(user),
    do:
      put_req_header(
        json_conn(),
        "authorization",
        "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true)
      )

  defp as_bot(principal), do: put_req_header(json_conn(), "authorization", "Bot " <> principal.token)

  defp workspace!(owner) do
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, unique("pb-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, unique("pb-ch"))
    {ws, ch}
  end

  # -- (a) ----------------------------------------------------------------------

  describe "(a) machine principals cannot join or create workspaces" do
    test "a bot token is refused on POST /invites/:code and POST /workspaces" do
      owner = human!()
      {ws, _ch} = workspace!(owner)
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, unique("pb bot"))
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id, max_age_s: 600)

      resp = post(as_bot(bot), "/api/v1/invites/#{invite.invite_code}", %{})
      assert resp.status == 403
      assert Workspaces.get_member(ws.workspace_id, bot.user_id) == nil
      assert Workspaces.get_invite(invite.invite_code).use_count == 0

      name = unique("botws")
      resp = post(as_bot(bot), "/api/v1/workspaces", %{"name" => name})
      assert resp.status == 403
      # Nothing was created: the (unique) name is still free for a person.
      assert {:ok, _} = Workspaces.create_workspace(owner.user_id, name)
    end

    test "a person still accepts and creates" do
      owner = human!()
      joiner = human!()
      {ws, _ch} = workspace!(owner)
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id, max_age_s: 600)

      assert post(as_human(joiner), "/api/v1/invites/#{invite.invite_code}", %{}).status == 200
      assert post(as_human(joiner), "/api/v1/workspaces", %{"name" => unique("mine")}).status == 201
    end
  end

  # -- (b) ----------------------------------------------------------------------

  describe "(b) minting an invite requires CREATE_INVITES" do
    test "a plain member is refused; a member with the bit and the owner are not" do
      owner = human!()
      member = human!()
      {ws, _ch} = workspace!(owner)
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id, [])

      assert post(as_human(member), "/api/v1/workspaces/#{ws.workspace_id}/invites", %{}).status == 403

      {:ok, role} =
        Workspaces.create_role(ws.workspace_id, unique("Inviters"),
          permissions: Bitfield.bit(:create_invites),
          position: 1
        )

      :ok = Workspaces.grant_role(ws.workspace_id, member.user_id, role.role_id)
      assert post(as_human(member), "/api/v1/workspaces/#{ws.workspace_id}/invites", %{}).status == 201
      assert post(as_human(owner), "/api/v1/workspaces/#{ws.workspace_id}/invites", %{}).status == 201
    end
  end

  # -- (c) ----------------------------------------------------------------------

  describe "(c) re-accepting an invite is a no-op for an existing member" do
    test "their roles survive and no use is consumed" do
      owner = human!()
      member = human!()
      {ws, _ch} = workspace!(owner)
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id, [])
      {:ok, role} = Workspaces.create_role(ws.workspace_id, unique("Mods"), permissions: 0, position: 1)
      :ok = Workspaces.grant_role(ws.workspace_id, member.user_id, role.role_id)
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id, max_age_s: 600, max_uses: 1)

      resp = post(as_human(member), "/api/v1/invites/#{invite.invite_code}", %{})
      assert resp.status == 200

      assert role.role_id in (Workspaces.get_member(ws.workspace_id, member.user_id).roles || [])
      assert Workspaces.get_invite(invite.invite_code).use_count == 0
    end
  end

  # -- (d) ----------------------------------------------------------------------

  describe "(d) the access document's dms level is enforced" do
    defp agent_with_dms(parent, level) do
      {:ok, bot} = Principals.mint(parent.user_id, :bot, unique("pb dm bot"))

      AgentGrants.grant(bot, %{
        version: 1,
        dms: level,
        dm_support: :humans,
        workspaces: %{mode: :none, level: nil, grants: %{}}
      })
      |> Map.put(:token, bot.token)
    end

    test "an agent with dms: :none cannot open a DM (native and compat)" do
      parent = human!()
      bot = agent_with_dms(parent, :none)

      assert post(as_bot(bot), "/api/v1/users/#{parent.user_id}/channels", %{}).status == 403

      resp = post(as_bot(bot), "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(parent.user_id)})
      assert resp.status == 403
    end

    test "an agent with dms: :none cannot read or post in a DM a person opened with it" do
      parent = human!()
      bot = agent_with_dms(parent, :none)
      {:ok, dm} = Workspaces.open_dm(parent.user_id, bot.user_id)

      assert get(as_bot(bot), "/api/v1/channels/#{dm.channel_id}/messages").status == 404
      assert post(as_bot(bot), "/api/v1/channels/#{dm.channel_id}/messages", %{"content" => "hi"}).status == 404
      assert get(as_bot(bot), "/api/v10/channels/#{dm.channel_id}/messages").status == 404
    end

    test "dms: :read reads but cannot post; dms: :read_write does both and may open" do
      parent = human!()
      reader = agent_with_dms(parent, :read)
      {:ok, dm} = Workspaces.open_dm(parent.user_id, reader.user_id)

      assert get(as_bot(reader), "/api/v1/channels/#{dm.channel_id}/messages").status == 200
      assert post(as_bot(reader), "/api/v1/channels/#{dm.channel_id}/messages", %{"content" => "hi"}).status == 403
      assert post(as_bot(reader), "/api/v1/users/#{parent.user_id}/channels", %{}).status == 403

      writer = agent_with_dms(parent, :read_write)
      resp = post(as_bot(writer), "/api/v1/users/#{parent.user_id}/channels", %{})
      assert resp.status in [200, 201]
      dm_id = Jason.decode!(resp.resp_body)["channel"]["id"]
      assert post(as_bot(writer), "/api/v1/channels/#{dm_id}/messages", %{"content" => "hello"}).status == 201
    end

    test "people are unaffected" do
      a = human!()
      b = human!()
      {:ok, dm} = Workspaces.open_dm(a.user_id, b.user_id)
      assert post(as_human(b), "/api/v1/channels/#{dm.channel_id}/messages", %{"content" => "hey"}).status == 201
    end
  end

  # -- (e) ----------------------------------------------------------------------

  describe "(e) machine principals hold no human login credentials" do
    test "SSH certificate and WebAuthn registration routes refuse a bot token" do
      owner = human!()
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, unique("pb cred bot"))

      assert post(as_bot(bot), "/api/v1/users/@me/ssh/certificates", %{"public_key" => "ssh-ed25519 AAAA"}).status ==
               403

      assert get(as_bot(bot), "/api/v1/users/@me/ssh/certificates").status == 403
      assert post(as_bot(bot), "/api/v1/auth/webauthn/register/options", %{}).status == 403
    end

    test "a JWT whose subject is a machine principal is a 401" do
      owner = human!()
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, unique("pb jwt bot"))
      forged = Auth.issue_access_token(bot.user_id, "botjwt", true)

      resp = get(put_req_header(json_conn(), "authorization", "Bearer " <> forged), "/api/v1/users/@me")
      assert resp.status == 401

      # The same bot's own credential still authenticates.
      assert get(as_bot(bot), "/api/v1/users/@me").status == 200
      # And a person's JWT is untouched.
      assert get(as_human(owner), "/api/v1/users/@me").status == 200
    end
  end
end
