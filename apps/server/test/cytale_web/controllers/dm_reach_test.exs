defmodule CytaleWeb.Controllers.DmReachTest do
  @moduledoc """
  Tier 3 (B) findings 9a and 12a:

    * `POST /users/:id/channels` (and the compat `POST /users/@me/channels`)
      open a NEW DM only between users who share a workspace — or when the DM
      already exists;
    * `Workspaces.accepts?/2` treats ANY other machine kind alike: a bot and an
      agent that both accept `:everyone` may DM (the doubled `_machine` binding
      used to make that pair crash).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp uniq(base), do: base <> "dr" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

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

  describe "a new DM needs a shared workspace (9a)" do
    test "strangers cannot open a DM; sharing a workspace can; an existing DM always reopens" do
      a = create_user()
      b = create_user()

      resp = post(as(a), "/api/v1/users/#{b.user_id}/channels", %{})
      assert %{"error" => %{"key" => "forbidden"}} = json_response(resp, 403)

      {:ok, ws} = Workspaces.create_workspace(a.user_id, uniq("dm-ws"))
      :ok = Workspaces.add_member(ws.workspace_id, b.user_id, a.user_id)

      assert %{"channel" => %{"id" => dm_id}} =
               json_response(post(as(a), "/api/v1/users/#{b.user_id}/channels", %{}), 201)

      # Parting ways does not strand the conversation: the existing DM reopens.
      :ok = Workspaces.remove_member(ws.workspace_id, b.user_id)

      assert %{"channel" => %{"id" => ^dm_id}} =
               json_response(post(as(b), "/api/v1/users/#{a.user_id}/channels", %{}), 200)
    end

    test "the library call without require_shared stays unconditional (fixtures, runtime)" do
      a = create_user()
      b = create_user()
      assert {:ok, _dm} = Workspaces.open_dm(a.user_id, b.user_id)
      assert {:error, :no_shared_workspace} = Workspaces.open_dm(a.user_id, create_user().user_id, require_shared: true)
    end
  end

  describe "machine ↔ machine DM support (12a)" do
    # Before the fix this pair raised FunctionClauseError (no accepts?/2 clause
    # matched a :bot policy against an :agent peer).
    test "a bot and an agent that both accept everyone may DM; a :humans one may not" do
      parent = create_user()
      # Minted directly: `AgentGrants.mint_all/3` folds :agent into :bot (one
      # kind for NEW credentials), but :agent rows exist and are valid kinds.
      [bot, agent] =
        for kind <- [:bot, :agent] do
          {:ok, principal} = Cytale.Accounts.Principals.mint(parent.user_id, kind, uniq("m"))
          assert principal.kind == kind
          principal
        end

      open = fn doc_a, doc_b ->
        AgentGrants.grant(bot, doc_a)
        AgentGrants.grant(agent, doc_b)
        Workspaces.open_dm(bot.user_id, agent.user_id)
      end

      everyone = %{AgentGrants.all_access() | dm_support: :everyone}
      humans_only = AgentGrants.all_access()

      assert {:ok, _dm} = open.(everyone, everyone)
      assert {:error, :dm_not_permitted} = open.(everyone, humans_only)
    end
  end
end
