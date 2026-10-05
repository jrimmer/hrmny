defmodule CytaleWeb.Controllers.WorkspaceDeleteKickTest do
  @moduledoc """
  Tier 3 (B) findings 3 and 4:

    * `DELETE /workspaces/:id` is a real delete — tombstoned first, then its
      webhooks, invites and every membership go; afterwards members AND the
      owner get 404 everywhere, invite codes fail, and the name is free;
    * kick needs KICK_MEMBERS and passes the hierarchy gate: never the owner,
      never yourself, never a member at or above the actor's top role.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Permissions.Bitfield
  alias Cytale.{Webhooks, Workspaces}

  @endpoint CytaleWeb.Endpoint

  defp uniq(base), do: base <> "dk" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

  defp create_user do
    name = uniq("u")
    {:ok, user} = User.create(name, name <> "@example.com", "password-123")
    user
  end

  defp as(user) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp role!(ws_id, bits, position) do
    {:ok, role} =
      Workspaces.create_role(ws_id, uniq("r"),
        permissions: Enum.reduce(bits, 0, &Bitwise.bor(Bitfield.bit(&1), &2)),
        position: position
      )

    role
  end

  describe "DELETE /workspaces/:id (finding 3)" do
    setup do
      owner = create_user()
      member = create_user()
      name = uniq("del-ws")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, name)
      {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "general")
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, owner.user_id)
      {:ok, webhook} = Webhooks.create_webhook(channel.channel_id, "Hook", owner.user_id)

      %{owner: owner, member: member, ws: ws, name: name, channel: channel, invite: invite, webhook: webhook}
    end

    test "a member cannot delete; the owner's delete takes everything with it", ctx do
      ws_id = ctx.ws.workspace_id
      ch_id = ctx.channel.channel_id

      assert delete(as(ctx.member), "/api/v1/workspaces/#{ws_id}").status in [403, 404]
      assert get(as(ctx.member), "/api/v1/workspaces/#{ws_id}").status == 200

      resp = delete(as(ctx.owner), "/api/v1/workspaces/#{ws_id}")
      assert %{"deleted" => _} = json_response(resp, 200)

      for user <- [ctx.member, ctx.owner] do
        assert get(as(user), "/api/v1/workspaces/#{ws_id}").status == 404
        assert get(as(user), "/api/v1/workspaces/#{ws_id}/members").status == 404
        assert get(as(user), "/api/v1/channels/#{ch_id}/messages").status == 404
        assert post(as(user), "/api/v1/channels/#{ch_id}/messages", %{"content" => "hi"}).status == 404
        assert get(as(user), "/api/v1/workspaces/#{ws_id}/channels").status == 404

        %{"workspaces" => mine} = json_response(get(as(user), "/api/v1/users/@me/workspaces"), 200)
        refute Enum.any?(mine, &(&1["id"] == Integer.to_string(ws_id)))
      end

      # The tombstone: the row read answers nil, the memberships are gone.
      assert Workspaces.get_workspace(ws_id) == nil
      assert Workspaces.list_member_ids(ws_id) == []

      # A second delete is a plain 404.
      assert delete(as(ctx.owner), "/api/v1/workspaces/#{ws_id}").status == 404
    end

    test "invite codes stop working", ctx do
      assert delete(as(ctx.owner), "/api/v1/workspaces/#{ctx.ws.workspace_id}").status == 200

      stranger = create_user()
      assert Workspaces.get_invite(ctx.invite.invite_code) == nil
      assert get(as(stranger), "/api/v1/invites/#{ctx.invite.invite_code}").status == 404
      assert post(as(stranger), "/api/v1/invites/#{ctx.invite.invite_code}", %{}).status in [404, 410]
      assert Workspaces.list_member_ids(ctx.ws.workspace_id) == []
    end

    test "webhooks are revoked", ctx do
      assert delete(as(ctx.owner), "/api/v1/workspaces/#{ctx.ws.workspace_id}").status == 200
      assert Webhooks.resolve_by_url_token(ctx.webhook.id, ctx.webhook.token) == nil

      resp =
        build_conn()
        |> put_req_header("content-type", "application/json")
        |> post("/api/webhooks/#{ctx.webhook.id}/#{ctx.webhook.token}", %{"content" => "still here?"})

      assert resp.status == 404
    end

    test "the name is released and the channel rows are purged in the background", ctx do
      assert delete(as(ctx.owner), "/api/v1/workspaces/#{ctx.ws.workspace_id}").status == 200
      assert {:ok, _} = Workspaces.create_workspace(ctx.owner.user_id, ctx.name)

      assert wait_until(5_000, fn -> Workspaces.get_channel(ctx.channel.channel_id) == nil end)
    end
  end

  describe "kick (finding 4)" do
    setup do
      owner = create_user()
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, uniq("kick-ws"))
      %{owner: owner, ws: ws}
    end

    defp join(ws, owner) do
      user = create_user()
      :ok = Workspaces.add_member(ws.workspace_id, user.user_id, owner.user_id)
      user
    end

    defp kick(actor, ws, target),
      do: delete(as(actor), "/api/v1/workspaces/#{ws.workspace_id}/members/#{target.user_id}")

    test "MANAGE_WORKSPACE alone is not enough; KICK_MEMBERS is", %{owner: owner, ws: ws} do
      manager = join(ws, owner)
      kicker = join(ws, owner)
      target = join(ws, owner)

      Workspaces.grant_role(ws.workspace_id, manager.user_id, role!(ws.workspace_id, [:manage_workspace], 5).role_id)
      Workspaces.grant_role(ws.workspace_id, kicker.user_id, role!(ws.workspace_id, [:kick_members], 5).role_id)

      assert kick(manager, ws, target).status == 403
      assert Workspaces.get_member(ws.workspace_id, target.user_id) != nil

      assert kick(kicker, ws, target).status == 200
      assert Workspaces.get_member(ws.workspace_id, target.user_id) == nil
    end

    test "nobody kicks the owner, and an actor cannot kick at or above their own top role", %{owner: owner, ws: ws} do
      high = join(ws, owner)
      peer = join(ws, owner)
      low = join(ws, owner)

      kick_role = role!(ws.workspace_id, [:kick_members, :administrator], 5)
      Workspaces.grant_role(ws.workspace_id, high.user_id, kick_role.role_id)
      Workspaces.grant_role(ws.workspace_id, peer.user_id, kick_role.role_id)
      Workspaces.grant_role(ws.workspace_id, low.user_id, role!(ws.workspace_id, [], 2).role_id)

      # The owner: never (even for an ADMINISTRATOR holder).
      resp = kick(high, ws, owner)
      assert %{"error" => %{"key" => "forbidden"}} = json_response(resp, 403)
      assert Workspaces.get_member(ws.workspace_id, owner.user_id) != nil

      # Equal position: denied (strict bound).
      assert kick(high, ws, peer).status == 403
      # Yourself: denied.
      assert kick(high, ws, high).status == 403
      # Strictly below: allowed.
      assert kick(high, ws, low).status == 200

      # The owner may kick anyone else.
      assert kick(owner, ws, peer).status == 200
    end
  end

  describe "GET /workspaces/:id reports the caller's workspace bits (finding 9b)" do
    test "a plain member lacks CREATE_INVITES; a role that grants it shows up" do
      owner = create_user()
      member = create_user()
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, uniq("perm-ws"))
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)

      bits_of = fn user ->
        %{"permissions" => p} = json_response(get(as(user), "/api/v1/workspaces/#{ws.workspace_id}"), 200)
        String.to_integer(p)
      end

      refute Bitfield.has?(bits_of.(member), :create_invites)
      assert Bitfield.has?(bits_of.(owner), :create_invites)

      Workspaces.grant_role(ws.workspace_id, member.user_id, role!(ws.workspace_id, [:create_invites], 3).role_id)
      assert Bitfield.has?(bits_of.(member), :create_invites)
    end
  end

  defp wait_until(ms, fun) when ms <= 0, do: fun.()

  defp wait_until(ms, fun) do
    if fun.() do
      true
    else
      Process.sleep(50)
      wait_until(ms - 50, fun)
    end
  end
end
