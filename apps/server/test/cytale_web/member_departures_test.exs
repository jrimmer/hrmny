defmodule CytaleWeb.MemberDeparturesTest do
  @moduledoc """
  Every way a member leaves a workspace announces `MemberRemove` through ONE
  path, `CytaleWeb.MemberEvents` (2026-10-02): deleting a bot (every workspace
  its grant reached — the same event a revoked grant sends), a kick (the person
  and the machines whose membership rode on theirs), an account deletion. A
  webhook is never a roster member, so its deletion has nothing to announce.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Deletion, User}
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp nonce, do: "m" <> Cytale.TestNonce.get()

  defp person(base) do
    {:ok, user} = User.create(base <> nonce(), base <> nonce() <> "@example.com", "password-123")
    user
  end

  defp conn_for(user) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp watch(workspace_id) do
    :ok = PushRegistry.subscribe(PushRegistry.workspace_key(Integer.to_string(workspace_id)), "viewer-#{nonce()}")
  end

  defp removes(timeout \\ 1_000) do
    receive do
      {:cytale_gateway_push, _from, {"MemberRemove", payload}, _fragment} -> [payload | removes(200)]
    after
      timeout -> []
    end
  end

  defp remove(ws, id), do: %{"workspace_id" => Integer.to_string(ws), "user_id" => Integer.to_string(id)}

  setup do
    owner = person("roster_owner")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "roster-" <> nonce())
    {:ok, owner: owner, ws_id: ws.workspace_id}
  end

  describe "departures announce MemberRemove (one path for people and machines)" do
    test "deleting a bot removes it from every roster its grant reached", %{owner: owner, ws_id: ws_id} do
      {:ok, ws2} = Workspaces.create_workspace(owner.user_id, "roster-two-" <> nonce())
      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, "Hermes " <> nonce())
      watch(ws_id)
      watch(ws2.workspace_id)

      resp = delete(conn_for(owner), "/api/v1/bots/#{bot.user_id}")
      assert resp.status == 204

      assert Enum.sort_by(removes(), & &1["workspace_id"]) ==
               Enum.sort_by([remove(ws_id, bot.user_id), remove(ws2.workspace_id, bot.user_id)], & &1["workspace_id"])

      # …and the roster agrees: a lookup no longer names it.
      assert Workspaces.roster_entry(ws_id, bot.user_id) == nil
    end

    test "deleting an UN-granted bot announces nothing (it was never listed)", %{owner: owner, ws_id: ws_id} do
      {:ok, bot} = Cytale.Accounts.Principals.mint(owner.user_id, :bot, "Quiet " <> nonce())
      watch(ws_id)

      assert delete(conn_for(owner), "/api/v1/bots/#{bot.user_id}").status == 204
      assert removes(300) == []
    end

    test "a kick removes the person AND the machines whose membership rode on theirs", %{
      owner: owner,
      ws_id: ws_id
    } do
      member = person("roster_member")
      :ok = Workspaces.add_member(ws_id, member.user_id, owner.user_id)
      {:ok, bot} = AgentGrants.mint_all(member.user_id, :bot, "Kicked bot " <> nonce())
      watch(ws_id)

      resp = delete(conn_for(owner), "/api/v1/workspaces/#{ws_id}/members/#{member.user_id}")
      assert resp.status == 200

      assert Enum.sort_by(removes(), & &1["user_id"]) ==
               Enum.sort_by([remove(ws_id, member.user_id), remove(ws_id, bot.user_id)], & &1["user_id"])
    end

    test "an account deletion leaves every roster live, with its machines", %{owner: owner, ws_id: ws_id} do
      member = person("roster_leaver")
      :ok = Workspaces.add_member(ws_id, member.user_id, owner.user_id)
      {:ok, bot} = AgentGrants.mint_all(member.user_id, :bot, "Leaver bot " <> nonce())
      watch(ws_id)

      :ok = Deletion.delete_account(member.user_id, sync: true)

      assert Enum.sort_by(removes(), & &1["user_id"]) ==
               Enum.sort_by([remove(ws_id, member.user_id), remove(ws_id, bot.user_id)], & &1["user_id"])

      # A resumed sweep finds nothing left to announce.
      :ok = Deletion.run_sweep(member.user_id)
      assert removes(300) == []
    end

    test "a webhook is never a roster member, so its deletion has nothing to announce", %{
      owner: owner,
      ws_id: ws_id
    } do
      {:ok, channel} = Workspaces.create_channel(ws_id, "hooks")
      {:ok, hook} = Cytale.Webhooks.create_webhook(channel.channel_id, "Deploys " <> nonce(), owner.user_id)
      assert Workspaces.roster_entry(ws_id, hook.id) == nil
      assert CytaleWeb.MemberEvents.departures(hook.id) == []
    end
  end
end
