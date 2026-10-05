defmodule CytaleWeb.DisplayNamesTest do
  @moduledoc """
  #168 — a person's account display name rides every member payload.

  `users.display_name` was stored but never sent with a roster row, so every
  client fell back to the username: the people page, the `?ids=` lookup, the
  members list, `MemberAdd`, DM recipients and the compat author/roster
  objects all named people by their handle. Each now carries the display name
  (`user.display_name`; the compat `global_name`), and name search matches it.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.MessageCodec

  @endpoint CytaleWeb.Endpoint

  defp nonce, do: "d" <> Cytale.TestNonce.get()

  defp person(base, display_name \\ nil) do
    {:ok, user} = User.create(base <> nonce(), base <> nonce() <> "@example.com", "password-123")
    if display_name, do: :ok = User.update_profile!(user.user_id, display_name, nil)
    user
  end

  defp conn_for(user) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp id(user), do: Integer.to_string(user.user_id)

  setup do
    owner = person("dn_owner")
    liddy = person("dn_liddy", "G. Gordon Liddy")
    plain = person("dn_plain")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "names-" <> nonce())
    :ok = Workspaces.add_member(ws.workspace_id, liddy.user_id, owner.user_id)
    :ok = Workspaces.add_member(ws.workspace_id, plain.user_id, owner.user_id)
    {:ok, owner: owner, liddy: liddy, plain: plain, ws_id: ws.workspace_id}
  end

  test "the people page carries each member's display name (null when unset)", ctx do
    %{"people" => rows} =
      conn_for(ctx.owner) |> get("/api/v1/workspaces/#{ctx.ws_id}/people") |> json_response(200)

    by_id = Map.new(rows, &{&1["user"]["id"], &1})
    assert by_id[id(ctx.liddy)]["user"]["display_name"] == "G. Gordon Liddy"
    assert Map.has_key?(by_id[id(ctx.plain)]["user"], "display_name")
    assert by_id[id(ctx.plain)]["user"]["display_name"] == nil
  end

  test "the ?ids= lookup and the members list carry it too", ctx do
    %{"people" => [row]} =
      conn_for(ctx.owner)
      |> get("/api/v1/workspaces/#{ctx.ws_id}/people?ids=#{id(ctx.liddy)}")
      |> json_response(200)

    assert row["user"]["display_name"] == "G. Gordon Liddy"

    %{"members" => members} =
      conn_for(ctx.owner) |> get("/api/v1/workspaces/#{ctx.ws_id}/members") |> json_response(200)

    assert Enum.find(members, &(&1["user_id"] == id(ctx.liddy)))["display_name"] == "G. Gordon Liddy"
  end

  test "name search matches the display name, not only the nickname and handle", ctx do
    %{"people" => rows} =
      conn_for(ctx.owner)
      |> get("/api/v1/workspaces/#{ctx.ws_id}/people?query=gordon%20lid")
      |> json_response(200)

    assert Enum.map(rows, & &1["user"]["id"]) == [id(ctx.liddy)]
  end

  test "a granted bot's row carries its label as the display name", ctx do
    {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

    %{"people" => [row]} =
      conn_for(ctx.owner)
      |> get("/api/v1/workspaces/#{ctx.ws_id}/people?ids=#{bot.user_id}")
      |> json_response(200)

    assert String.starts_with?(row["user"]["display_name"], "Tape Deck ")
    # A bot's workspace nickname is its own setting (#169), not its label.
    assert row["nickname"] == nil
  end

  test "MemberAdd renders through the same wire row, display name included", ctx do
    entry = Workspaces.roster_entry(ctx.ws_id, ctx.liddy.user_id)
    assert Workspaces.roster_entry_wire(entry)["user"]["display_name"] == "G. Gordon Liddy"
  end

  test "a DM's recipient summary carries the peer's display name", ctx do
    body =
      conn_for(ctx.owner)
      |> post("/api/v1/users/#{id(ctx.liddy)}/channels", %{})
      |> json_response(201)

    assert [%{"id" => peer_id, "display_name" => "G. Gordon Liddy"}] = body["channel"]["recipients"]
    assert peer_id == id(ctx.liddy)
  end

  describe "compat (Discord's global_name)" do
    test "an author with a display name has it as global_name; without one, the username", ctx do
      assert MessageCodec.author_object(ctx.liddy.user_id)["global_name"] == "G. Gordon Liddy"
      assert MessageCodec.author_object(ctx.liddy.user_id)["username"] == ctx.liddy.username
      assert MessageCodec.author_object(ctx.plain.user_id)["global_name"] == ctx.plain.username
    end

    test "a bot author's global_name is its label; its username stays the tag", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())
      author = MessageCodec.author_object(bot.user_id)
      assert String.starts_with?(author["global_name"], "Tape Deck ")
      refute author["username"] == author["global_name"]
      assert author["bot"] == true
    end
  end
end
