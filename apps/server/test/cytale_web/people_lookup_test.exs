defmodule CytaleWeb.PeopleLookupTest do
  @moduledoc """
  `GET /workspaces/:id/people?ids=` names members beyond the first people page
  (2026-10-02): a client boots with one page (50) per workspace and looks up
  only the authors it renders, in the people row's shape — people by
  membership, machines by grant, nobody else.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
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

  setup do
    owner = person("roster_owner")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "roster-" <> nonce())
    {:ok, owner: owner, ws_id: ws.workspace_id}
  end

  describe "GET /workspaces/:id/people?ids= (naming members beyond the first page)" do
    test "names members past the first page, people and granted machines, and nobody else", %{
      owner: owner,
      ws_id: ws_id
    } do
      # More people than one page (50): the earliest-joined sit beyond it.
      members =
        for i <- 1..55 do
          m = person("roster_p#{i}_")
          :ok = Workspaces.add_member(ws_id, m.user_id, owner.user_id)
          m
        end

      first_page = get(conn_for(owner), "/api/v1/workspaces/#{ws_id}/people")
      %{"people" => page, "next_before" => cursor} = Jason.decode!(first_page.resp_body)
      assert is_binary(cursor)
      paged = MapSet.new(page, & &1["user"]["id"])
      beyond = Enum.reject(members, &MapSet.member?(paged, Integer.to_string(&1.user_id)))
      assert beyond != []

      {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, "Lookup bot " <> nonce())
      {:ok, ungranted} = Cytale.Accounts.Principals.mint(owner.user_id, :bot, "Ungranted " <> nonce())
      stranger = person("roster_stranger")

      wanted = Enum.map(beyond, & &1.user_id) ++ [bot.user_id, ungranted.user_id, stranger.user_id]
      ids = Enum.map_join(wanted, ",", &Integer.to_string/1)

      resp = get(conn_for(owner), "/api/v1/workspaces/#{ws_id}/people?ids=#{ids},not-a-snowflake")
      assert resp.status == 200
      %{"people" => rows, "next_before" => nil} = Jason.decode!(resp.resp_body)

      assert Enum.map(rows, & &1["user"]["id"]) ==
               Enum.map(Enum.map(beyond, & &1.user_id) ++ [bot.user_id], &Integer.to_string/1)

      far = Enum.find(rows, &(&1["user"]["id"] == Integer.to_string(hd(beyond).user_id)))
      assert far["user"]["username"] == hd(beyond).username
      assert far["kind"] == "human"

      machine = Enum.find(rows, &(&1["user"]["id"] == Integer.to_string(bot.user_id)))
      assert machine["kind"] == "bot"
      assert machine["parent_user_id"] == Integer.to_string(owner.user_id)
    end

    test "more than 100 ids is refused; a non-member caller learns nothing", %{owner: owner, ws_id: ws_id} do
      ids = Enum.map_join(1..101, ",", &Integer.to_string(&1 + 1_000_000))
      resp = get(conn_for(owner), "/api/v1/workspaces/#{ws_id}/people?ids=#{ids}")
      assert resp.status == 400

      outsider = person("roster_outsider")
      resp = get(conn_for(outsider), "/api/v1/workspaces/#{ws_id}/people?ids=#{owner.user_id}")
      assert resp.status == 404
    end
  end
end
