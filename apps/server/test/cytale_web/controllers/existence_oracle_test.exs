defmodule CytaleWeb.Controllers.ExistenceOracleTest do
  @moduledoc """
  Tier 3 (B) finding 11 — "doesn't exist" and "you are not a member / cannot
  see it" are ONE answer (404). 403 remains only for a member who can see the
  resource but lacks the bit. Notification preferences accept a channel only
  when the member can VIEW it.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Notifications.Preferences
  alias Cytale.Permissions.{Bitfield, RightsEpoch}
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp uniq(base), do: base <> "eo" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

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

  setup do
    owner = create_user()
    member = create_user()
    stranger = create_user()
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, uniq("eo-ws"))
    {:ok, open} = Workspaces.create_channel(ws.workspace_id, "open")
    {:ok, secret} = Workspaces.create_channel(ws.workspace_id, "secret")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    Workspaces.put_overwrite(secret.channel_id, :member, member.user_id, 0, Bitfield.bit(:view_channel))
    RightsEpoch.bump(ws.workspace_id)

    %{owner: owner, member: member, stranger: stranger, ws: ws, open: open, secret: secret}
  end

  test "a non-member gets the unknown-id 404 for a real workspace and a real channel", ctx do
    unknown_ws = 123_456_789_012_345_678
    unknown_ch = 123_456_789_012_345_679

    for {real, fake} <- [
          {"/api/v1/workspaces/#{ctx.ws.workspace_id}/members", "/api/v1/workspaces/#{unknown_ws}/members"},
          {"/api/v1/channels/#{ctx.open.channel_id}/messages", "/api/v1/channels/#{unknown_ch}/messages"}
        ] do
      a = get(as(ctx.stranger), real)
      b = get(as(ctx.stranger), fake)
      assert a.status == 404, "#{real} answered #{a.status}"
      assert {a.status, json_response(a, 404)["error"]["key"]} == {b.status, json_response(b, 404)["error"]["key"]}
    end

    # A workspace-level mutation route (plug-gated) too.
    resp = post(as(ctx.stranger), "/api/v1/workspaces/#{ctx.ws.workspace_id}/roles", %{"name" => "x"})
    assert %{"error" => %{"key" => "workspace_not_found"}} = json_response(resp, 404)
  end

  test "a member who cannot see a channel gets 404; lacking a bit on a visible one stays 403", ctx do
    hidden = post(as(ctx.member), "/api/v1/channels/#{ctx.secret.channel_id}/messages", %{"content" => "hi"})
    assert %{"error" => %{"key" => "channel_not_found"}} = json_response(hidden, 404)

    # Visible channel, missing MANAGE_CHANNELS: the one legitimate 403.
    denied = post(as(ctx.member), "/api/v1/channels/#{ctx.open.channel_id}/webhooks", %{"name" => "X"})
    assert %{"error" => %{"key" => "forbidden"}} = json_response(denied, 403)
  end

  test "notification preferences need VIEW on the channel, not bare membership", ctx do
    put_level = fn channel ->
      put(as(ctx.member), "/api/v1/users/@me/notification-preferences", %{
        "scope" => "channel",
        "entity_id" => Integer.to_string(channel.channel_id),
        "level" => "all"
      })
    end

    assert put_level.(ctx.secret).status in [403, 404]
    assert Preferences.all(ctx.member.user_id) == %{}

    assert put_level.(ctx.open).status == 200
  end
end
