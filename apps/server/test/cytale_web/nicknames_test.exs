defmodule CytaleWeb.NicknamesTest do
  @moduledoc """
  #169 — per-workspace nicknames for people and bots, one path.

    * your own: CHANGE_NICKNAME, in the @everyone base (a bot's via a
      `read_write` grant, ANDed with its owner's bits);
    * anyone else's: MANAGE_NICKNAMES and a role strictly above theirs; never
      the owner's unless you are the owner;
    * stored per workspace (a person's on the membership row, a bot's in
      `workspace_machine_nicknames`), shown first on the roster, announced as
      `MemberUpdate`;
    * the Discord-compatible `PATCH /guilds/:id/members/@me|:user_id` with
      `nick` is the same path.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Permissions.Bitfield
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp nonce, do: "n" <> Cytale.TestNonce.get()

  defp person(base) do
    {:ok, user} = User.create(base <> nonce(), base <> nonce() <> "@example.com", "password-123")
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

  defp rename(as, ws_id, target, nickname),
    do: conn_for(as) |> patch("/api/v1/workspaces/#{ws_id}/members/#{target}", %{"nickname" => nickname})

  defp roster_nick(ws_id, user_id), do: Workspaces.roster_entry(ws_id, user_id).nickname

  setup do
    owner = person("nk_owner")
    alice = person("nk_alice")
    bob = person("nk_bob")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "nicks-" <> nonce())
    :ok = Workspaces.add_member(ws.workspace_id, alice.user_id, owner.user_id)
    :ok = Workspaces.add_member(ws.workspace_id, bob.user_id, owner.user_id)
    {:ok, owner: owner, alice: alice, bob: bob, ws_id: ws.workspace_id}
  end

  describe "your own nickname (CHANGE_NICKNAME, everyone's by default)" do
    test "a member sets, trims and clears their own; the roster shows it", ctx do
      body = rename(ctx.alice, ctx.ws_id, "@me", "  Gemstone  ") |> json_response(200)
      assert body["nickname"] == "Gemstone"
      assert body["user_id"] == Integer.to_string(ctx.alice.user_id)
      assert roster_nick(ctx.ws_id, ctx.alice.user_id) == "Gemstone"

      assert rename(ctx.alice, ctx.ws_id, "@me", nil) |> json_response(200) |> Map.get("nickname") == nil
      assert roster_nick(ctx.ws_id, ctx.alice.user_id) == nil

      rename(ctx.alice, ctx.ws_id, "@me", "x") |> json_response(200)
      assert rename(ctx.alice, ctx.ws_id, "@me", "   ") |> json_response(200) |> Map.get("nickname") == nil
    end

    test "a nickname belongs to ONE workspace", ctx do
      {:ok, other} = Workspaces.create_workspace(ctx.owner.user_id, "nicks2-" <> nonce())
      :ok = Workspaces.add_member(other.workspace_id, ctx.alice.user_id, ctx.owner.user_id)

      rename(ctx.alice, ctx.ws_id, "@me", "Gemstone") |> json_response(200)
      assert roster_nick(other.workspace_id, ctx.alice.user_id) == nil
    end

    test "33 characters, or a non-string, is refused; nothing changes", ctx do
      assert rename(ctx.alice, ctx.ws_id, "@me", String.duplicate("a", 33)) |> json_response(400)
      assert rename(ctx.alice, ctx.ws_id, "@me", String.duplicate("a", 32)) |> json_response(200)

      assert conn_for(ctx.alice)
             |> patch("/api/v1/workspaces/#{ctx.ws_id}/members/@me", %{"nickname" => 5})
             |> json_response(400)

      assert conn_for(ctx.alice) |> patch("/api/v1/workspaces/#{ctx.ws_id}/members/@me", %{}) |> json_response(400)
    end

    test "a non-member reads it as an unknown workspace", ctx do
      stranger = person("nk_stranger")
      assert rename(stranger, ctx.ws_id, "@me", "Hi") |> json_response(404)
    end

    test "everyone's @everyone base carries CHANGE_NICKNAME, not MANAGE_NICKNAMES", ctx do
      {:ok, bits} =
        Cytale.Permissions.Principal.resolve(ctx.ws_id, %{user_id: ctx.alice.user_id, kind: :human}, nil)

      assert Bitfield.has?(bits, :change_nickname)
      refute Bitfield.has?(bits, :manage_nicknames)
    end
  end

  describe "someone else's nickname (MANAGE_NICKNAMES + hierarchy)" do
    test "a plain member cannot rename another", ctx do
      assert rename(ctx.alice, ctx.ws_id, ctx.bob.user_id, "Bobby") |> json_response(403)
      assert roster_nick(ctx.ws_id, ctx.bob.user_id) == nil
    end

    test "the owner renames anyone; nobody but the owner renames the owner", ctx do
      assert rename(ctx.owner, ctx.ws_id, ctx.bob.user_id, "Bobby") |> json_response(200)
      assert roster_nick(ctx.ws_id, ctx.bob.user_id) == "Bobby"

      {:ok, mod} =
        Workspaces.create_role(ctx.ws_id, nonce() <> "mod", permissions: Bitfield.bit(:manage_nicknames), position: 9)

      :ok = Workspaces.grant_role(ctx.ws_id, ctx.alice.user_id, mod.role_id)
      assert rename(ctx.alice, ctx.ws_id, ctx.owner.user_id, "Boss") |> json_response(403)
    end

    test "MANAGE_NICKNAMES works only on members strictly below you", ctx do
      bits = Bitfield.bit(:manage_nicknames)
      {:ok, high} = Workspaces.create_role(ctx.ws_id, nonce() <> "high", permissions: bits, position: 5)
      {:ok, peer} = Workspaces.create_role(ctx.ws_id, nonce() <> "peer", permissions: 0, position: 5)
      :ok = Workspaces.grant_role(ctx.ws_id, ctx.alice.user_id, high.role_id)

      # bob holds no role: below alice.
      assert rename(ctx.alice, ctx.ws_id, ctx.bob.user_id, "Bobby") |> json_response(200)

      # bob at alice's level: refused.
      :ok = Workspaces.grant_role(ctx.ws_id, ctx.bob.user_id, peer.role_id)
      assert rename(ctx.alice, ctx.ws_id, ctx.bob.user_id, "Robert") |> json_response(403)
      assert roster_nick(ctx.ws_id, ctx.bob.user_id) == "Bobby"
    end

    test "an unknown target is 404", ctx do
      stranger = person("nk_nobody")
      assert rename(ctx.owner, ctx.ws_id, stranger.user_id, "Ghost") |> json_response(404)
    end
  end

  describe "bots, the same path" do
    test "a read_write bot sets its own nickname with its token; the roster shows it beside its label", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

      assert rename(bot, ctx.ws_id, "@me", "The Recorder") |> json_response(200) |> Map.get("nickname") ==
               "The Recorder"

      entry = Workspaces.roster_entry(ctx.ws_id, bot.user_id)
      assert entry.nickname == "The Recorder"
      assert String.starts_with?(entry.display_name, "Tape Deck ")

      assert rename(bot, ctx.ws_id, "@me", nil) |> json_response(200)
      assert roster_nick(ctx.ws_id, bot.user_id) == nil
    end

    test "a read-only bot cannot; a bot can never rename someone else", ctx do
      {:ok, reader} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Reader " <> nonce(), %{actions: ["read"]})
      assert rename(reader, ctx.ws_id, "@me", "Nope") |> json_response(403)

      {:ok, writer} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Writer " <> nonce())
      assert rename(writer, ctx.ws_id, ctx.bob.user_id, "Bobby") |> json_response(403)
    end

    test "a member with MANAGE_NICKNAMES above a bot's position 0 can rename it", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

      {:ok, mod} =
        Workspaces.create_role(ctx.ws_id, nonce() <> "mod", permissions: Bitfield.bit(:manage_nicknames), position: 2)

      :ok = Workspaces.grant_role(ctx.ws_id, ctx.alice.user_id, mod.role_id)

      assert rename(ctx.alice, ctx.ws_id, bot.user_id, "Deck") |> json_response(200)
      assert roster_nick(ctx.ws_id, bot.user_id) == "Deck"
    end
  end

  describe "compat (Discord's Modify Current Member / Modify Guild Member nick)" do
    test "PATCH /guilds/:id/members/@me with nick → the member object with the nick", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

      body =
        conn_for(bot)
        |> patch("/api/v10/guilds/#{ctx.ws_id}/members/@me", %{"nick" => "The Recorder"})
        |> json_response(200)

      assert body["nick"] == "The Recorder"
      assert body["user"]["id"] == Integer.to_string(bot.user_id)
      assert body["user"]["bot"] == true
      assert is_list(body["roles"])
      assert roster_nick(ctx.ws_id, bot.user_id) == "The Recorder"

      assert conn_for(bot)
             |> patch("/api/v10/guilds/#{ctx.ws_id}/members/@me", %{"nick" => nil})
             |> json_response(200)
             |> Map.get("nick") == nil
    end

    test "another member → 50001; an unsupported field → 50035; an unknown member → 10007", ctx do
      {:ok, bot} = AgentGrants.mint_all(ctx.owner.user_id, :bot, "Tape Deck " <> nonce())

      assert %{"code" => 50_001} =
               conn_for(bot)
               |> patch("/api/v10/guilds/#{ctx.ws_id}/members/#{ctx.bob.user_id}", %{"nick" => "Bobby"})
               |> json_response(403)

      assert %{"code" => 50_035} =
               conn_for(bot)
               |> patch("/api/v10/guilds/#{ctx.ws_id}/members/@me", %{"nick" => "x", "mute" => true})
               |> json_response(400)

      stranger = person("nk_ghost")

      assert %{"code" => 10_007} =
               conn_for(bot)
               |> patch("/api/v10/guilds/#{ctx.ws_id}/members/#{stranger.user_id}", %{"nick" => "Ghost"})
               |> json_response(404)
    end
  end

  test "the MemberUpdate payload names the workspace, the member and the nickname", ctx do
    alias Cytale.Gateway.PushRegistry
    :ok = PushRegistry.subscribe(PushRegistry.workspace_key(Integer.to_string(ctx.ws_id)), "nick-live-session")

    rename(ctx.alice, ctx.ws_id, "@me", "Gemstone") |> json_response(200)

    assert_receive {:cytale_gateway_push, _from, {"MemberUpdate", payload}, _fragment}, 2_000

    assert payload == %{
             "workspace_id" => Integer.to_string(ctx.ws_id),
             "user_id" => Integer.to_string(ctx.alice.user_id),
             "nickname" => "Gemstone"
           }
  end
end
