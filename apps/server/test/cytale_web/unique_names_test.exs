defmodule CytaleWeb.UniqueNamesTest do
  @moduledoc """
  A shown name is unique in a workspace (owner decision 2026-10-04).

  The name a member CHOOSES — a workspace nickname, an account display name, a
  bot's label — is refused when another member of the workspace is already
  shown by it: their nickname, display name or username, people and bots
  alike. The comparison ignores case and folds Unicode compatibility forms
  (full-width letters), so look-alikes collide. Your own names never collide
  with you, and clearing is always allowed.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp nonce, do: "u" <> Cytale.TestNonce.get()

  defp person(base, display_name \\ nil) do
    {:ok, user} = User.create(base <> nonce(), base <> nonce() <> "@example.com", "password-123")
    if display_name, do: :ok = User.update_profile!(user.user_id, display_name, nil)
    user
  end

  defp conn_for(%{token: "cytbot_" <> _ = token}), do: base_conn() |> put_req_header("authorization", "Bot " <> token)

  defp conn_for(user),
    do:
      base_conn()
      |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

  defp base_conn do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp nick(as, ws, nickname),
    do: conn_for(as) |> patch("/api/v1/workspaces/#{ws}/members/@me", %{"nickname" => nickname})

  defp display(as, name), do: conn_for(as) |> patch("/api/v1/users/@me", %{"display_name" => name})

  setup do
    owner = person("un_owner")
    liddy = person("un_liddy", "G. Gordon Liddy")
    hunt = person("un_hunt")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "Plumbers " <> nonce())
    :ok = Workspaces.add_member(ws.workspace_id, liddy.user_id, owner.user_id)
    :ok = Workspaces.add_member(ws.workspace_id, hunt.user_id, owner.user_id)
    {:ok, owner: owner, liddy: liddy, hunt: hunt, ws_id: ws.workspace_id, ws_name: ws.name}
  end

  describe "a nickname" do
    test "cannot be another member's display name, username or nickname — case and look-alikes included", ctx do
      assert %{"error" => %{"key" => "name_taken"}} = nick(ctx.hunt, ctx.ws_id, "g. gordon liddy") |> json_response(409)
      assert nick(ctx.hunt, ctx.ws_id, ctx.liddy.username) |> json_response(409)
      # Full-width letters fold to the same name (NFKC).
      assert nick(ctx.hunt, ctx.ws_id, "Ｇ. Gordon Liddy") |> json_response(409)

      nick(ctx.liddy, ctx.ws_id, "Gemstone") |> json_response(200)
      assert nick(ctx.hunt, ctx.ws_id, " GEMSTONE ") |> json_response(409)
    end

    test "can be your own username or display name, and can always be cleared", ctx do
      assert nick(ctx.liddy, ctx.ws_id, "g. gordon liddy") |> json_response(200)
      assert nick(ctx.hunt, ctx.ws_id, ctx.hunt.username) |> json_response(200)
      assert nick(ctx.hunt, ctx.ws_id, nil) |> json_response(200)
    end

    test "only collides inside its own workspace", ctx do
      {:ok, other} = Workspaces.create_workspace(ctx.owner.user_id, "Elsewhere " <> nonce())
      :ok = Workspaces.add_member(other.workspace_id, ctx.hunt.user_id, ctx.owner.user_id)
      # Liddy is not a member there.
      assert nick(ctx.hunt, other.workspace_id, "G. Gordon Liddy") |> json_response(200)
    end

    test "cannot be a granted bot's label", ctx do
      {:ok, _bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck")
      assert nick(ctx.hunt, ctx.ws_id, "tape deck") |> json_response(409)
    end

    test "compat: a bot's nick that collides is a 50035 on nick", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Recorder " <> nonce())

      assert %{"code" => 50_035} =
               conn_for(bot)
               |> patch("/api/v10/guilds/#{ctx.ws_id}/members/@me", %{"nick" => "G. Gordon Liddy"})
               |> json_response(400)
    end
  end

  describe "a display name" do
    test "cannot be a name already shown in any of your workspaces; the error names the workspace", ctx do
      body = display(ctx.hunt, "G. GORDON LIDDY") |> json_response(409)
      assert body["error"]["key"] == "name_taken"
      assert body["error"]["message"] =~ ctx.ws_name
      assert User.get(ctx.hunt.user_id).display_name == nil
    end

    test "is free when nobody you share a workspace with uses it; keeping or clearing yours is fine", ctx do
      assert display(ctx.hunt, "E. Howard Hunt") |> json_response(200)
      assert display(ctx.hunt, "E. Howard Hunt") |> json_response(200)
      assert display(ctx.liddy, nil) |> json_response(200)

      loner = person("un_loner")
      assert display(loner, "G. Gordon Liddy") |> json_response(200)
    end
  end

  describe "a bot's label (its display name — bots and people, one rule)" do
    test "a rename that collides in a workspace the bot belongs to is refused", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

      body =
        conn_for(ctx.owner)
        |> patch("/api/v1/bots/#{bot.user_id}", %{"name" => "g. gordon liddy"})
        |> json_response(409)

      assert body["error"]["key"] == "name_taken"

      assert conn_for(ctx.owner)
             |> patch("/api/v1/bots/#{bot.user_id}", %{"name" => "Oval Recorder " <> nonce()})
             |> json_response(200)
    end

    test "granting a bot into a workspace where its label is already taken is refused", ctx do
      # Minted with no access: it belongs nowhere, so no name check yet.
      {:ok, bot} = Cytale.Accounts.Principals.mint(ctx.owner.user_id, :bot, "G. Gordon Liddy")

      grant = %{
        "access" => %{
          "v" => 1,
          "dms" => "none",
          "dm_support" => "humans",
          "workspaces" => %{"mode" => "all", "level" => "read_write", "grants" => %{}}
        }
      }

      body = conn_for(ctx.owner) |> patch("/api/v1/bots/#{bot.user_id}", grant) |> json_response(409)
      assert body["error"]["key"] == "name_taken"
      assert Workspaces.roster_entry(ctx.ws_id, bot.user_id) == nil

      # A unique label, granted the same way: in.
      assert conn_for(ctx.owner)
             |> patch("/api/v1/bots/#{bot.user_id}", Map.put(grant, "name", "Tape Deck " <> nonce()))
             |> json_response(200)

      assert Workspaces.roster_entry(ctx.ws_id, bot.user_id) != nil
    end
  end
end
