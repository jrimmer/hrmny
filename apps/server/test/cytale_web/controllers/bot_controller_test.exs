defmodule CytaleWeb.Controllers.BotControllerTest do
  @moduledoc """
  U4 (bots plan) — machine-credential lifecycle REST over HTTP, on the AGENTS
  surface only.

  Machine credentials are ALWAYS user-owned (owner decision 2026-09-12): the
  workspace-scoped `/workspaces/{id}/bots` routes are retired, so `/api/v1/bots`
  is the only provisioning path — any verified human mints for themselves, with
  no permission gate. This suite covers one-field creates (`cytbot_` token,
  parent = caller), metadata-only lists (never tokens), regeneration, PATCH
  semantics (name = metadata; restrictions/access = profile), revocation
  (204 → next REST 401), the human-only-minter 403, cross-owner 404 id
  protection, @me's kind/parent growth, and the migration guarantee that a
  `:bot`-kind row minted under the retired route is still listed, grantable and
  private. Live-socket teardown (4004 / op-6 Reconnect) is proven wire-level in
  GatewayPrincipalTeardownTest.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Access
  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # A FRESH conn with this suite's auth headers: recycle/1 would drop the
  # multipart body upload/4 stamps into conn private, and re-posting on a
  # spent conn raises AlreadySent.
  defp fresh_auth_conn(conn) do
    auth = conn |> get_req_header("authorization") |> List.first()

    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("authorization", auth)
  end

  defp run_unique(base), do: base <> run_nonce()

  import Cytale.UploadHelpers

  defp auth_conn(authorization) when is_binary(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  defp conn_for(user, verified? \\ true) when is_map(user) do
    auth_conn("Bearer " <> Auth.issue_access_token(user.user_id, user.username, verified?))
  end

  setup do
    {:ok, owner} = User.create(run_unique("bot_owner"), run_unique("bot_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("bots-ws"))

    {:ok, conn: conn_for(owner), owner: owner, ws_id: ws.workspace_id}
  end

  # ---------------------------------------------------------------------------
  # Happy paths
  # ---------------------------------------------------------------------------

  describe "creates (the bots surface)" do
    test "one-field mint → 201 %{id, token} in cytbot_ shape; parent = caller", %{
      conn: conn,
      owner: owner
    } do
      conn = post(conn, "/api/v1/bots", %{"name" => "Deploy Agent"})
      assert conn.status == 201

      assert %{"id" => id, "token" => token} = Jason.decode!(conn.resp_body)
      assert {:ok, agent_id} = snowflake(id)
      assert String.starts_with?(token, "cytbot_")
      assert byte_size(String.trim_leading(token, "cytbot_")) >= 43

      principal = Principals.get(agent_id)
      assert principal.kind == :bot
      assert principal.parent_user_id == owner.user_id
      # The minted credential authenticates the machine principal (U2 path).
      assert Principals.get_by_token(token).user_id == agent_id
    end

    test "agent mint by a plain verified human → 201; no permission gate", %{
      conn: conn
    } do
      # A plain member of NOTHING (no workspace at all) can still mint agents.
      {:ok, plain} = User.create(run_unique("plain"), run_unique("plain@example.com"), "password-123")
      plain_conn = conn_for(plain)

      created = post(plain_conn, "/api/v1/bots", %{"name" => "My Agent"})
      assert created.status == 201

      assert %{"id" => id, "token" => token} = Jason.decode!(created.resp_body)
      assert {:ok, agent_id} = snowflake(id)
      assert principal = Principals.get(agent_id)
      assert principal.kind == :bot
      assert principal.parent_user_id == plain.user_id
      assert String.starts_with?(token, "cytbot_")

      # The owner's surface is untouched by the plain user's agent.
      agents = resp_json(get(conn, "/api/v1/bots"))["bots"]
      refute id in Enum.map(agents, & &1["id"])
    end

    test "missing name → 400", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "validation_failed"
    end

    # B6g: the parent's machine-principal budget renders the native
    # principal_cap key (all kinds combined — bots AND agents count).
    test "agent mint past the parent cap → 400 with the principal_cap native key", %{conn: conn, owner: owner} do
      cap = Principals.principal_cap()

      for i <- 1..(cap - 1) do
        assert {:ok, _} = AgentGrants.mint_all(owner.user_id, :agent, "Seed #{i}")
      end

      # The cap-th mint still fits (201)...
      last = post(conn, "/api/v1/bots", %{"name" => "The Last"})
      assert last.status == 201

      # ...the next one is the 400 cap with the native error key.
      over = post(conn, "/api/v1/bots", %{"name" => "One Too Many"})
      assert over.status == 400
      assert Jason.decode!(over.resp_body)["error"]["key"] == "principal_cap"
    end
  end

  describe "lists (metadata only)" do
    test "list: id/name/kind/created_at (and the access policy) — NEVER tokens", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Listed Agent"})
      assert conn.status == 201
      agent_id = Jason.decode!(conn.resp_body)["id"]

      list = get(conn, "/api/v1/bots")
      assert list.status == 200

      agents = Jason.decode!(list.resp_body)["bots"]

      assert [%{"id" => ^agent_id, "name" => "Listed Agent", "kind" => "bot", "created_at" => created} | _] =
               Enum.filter(agents, &(&1["id"] == agent_id))

      assert is_binary(created)

      # The list is where an owner SEES the grant: the access document rides
      # along (it is a policy, not a secret).
      assert Enum.all?(agents, &is_map(&1["access"]))

      # No token material anywhere in the list payload.
      refute Jason.encode!(agents) =~ "cytbot_"
      Enum.each(agents, fn a -> refute Map.has_key?(a, "token") end)
    end

    test "bot list: the caller's bots only", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Mine"})
      assert conn.status == 201
      mine = Jason.decode!(conn.resp_body)["id"]

      # Another user's agent must not leak into the caller's list.
      {:ok, other} = User.create(run_unique("other"), run_unique("other@example.com"), "password-123")
      other_conn = conn_for(other)
      assert other_conn |> post("/api/v1/bots", %{"name" => "Theirs"}) |> Map.get(:status) == 201

      mine_list = Jason.decode!(get(conn, "/api/v1/bots").resp_body)["bots"]
      assert mine in Enum.map(mine_list, & &1["id"])
      Enum.each(mine_list, fn a -> assert a["kind"] == "bot" end)
      refute Jason.encode!(mine_list) =~ "cytbot_"
    end
  end

  describe "PATCH" do
    test "name change → 200, metadata updated, no session effect", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Before"})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      conn = patch(conn, "/api/v1/bots/#{agent_id}", %{"name" => "After"})
      assert conn.status == 200

      assert %{"id" => ^agent_id, "name" => "After", "kind" => "bot"} = Jason.decode!(conn.resp_body)

      listed = resp_json(get(conn, "/api/v1/bots"))["bots"]
      assert Enum.find(listed, &(&1["id"] == agent_id))["name"] == "After"
    end

    test "restrictions change → 200, policy persisted", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Scoped"})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      conn =
        patch(conn, "/api/v1/bots/#{agent_id}", %{
          "restrictions" => %{"actions" => ["read"], "channels" => ["123"]}
        })

      assert conn.status == 200

      assert Jason.decode!(conn.resp_body)["restrictions"] == %{
               "actions" => ["read"],
               "channels" => ["123"]
             }

      assert Principals.get(String.to_integer(agent_id)).restrictions == %{
               "actions" => ["read"],
               "channels" => ["123"]
             }
    end

    test "restrictions: null clears the policy (unrestricted)", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Nully", "restrictions" => %{"actions" => ["read"]}})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      conn = patch(conn, "/api/v1/bots/#{agent_id}", %{"restrictions" => nil})
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["restrictions"] == nil
      assert Principals.get(String.to_integer(agent_id)).restrictions == nil
    end

    test "no fields → 400", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Untouched"})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      conn = patch(conn, "/api/v1/bots/#{agent_id}", %{})
      assert conn.status == 400
    end

    test "invalid restrictions payload → 400 invalid_restrictions", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Bad Policy"})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      for bad <- [
            %{"actions" => ["read", "delete"]},
            %{"channels" => ["not-an-id"]},
            %{"unknown" => true}
          ] do
        conn = patch(conn, "/api/v1/bots/#{agent_id}", %{"restrictions" => bad})
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body)["error"]["key"] == "invalid_restrictions"
      end

      # Mint-time validation shares the key.
      conn = post(conn, "/api/v1/bots", %{"name" => "X", "restrictions" => %{"actions" => ["fly"]}})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "invalid_restrictions"
    end

    test "invalid access document → 400 invalid_access, nothing written", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Bad Grant"})
      agent_id = Jason.decode!(conn.resp_body)["id"]

      for bad <- [
            # `:all` must NAME the level it cascades at.
            %{"v" => 1, "workspaces" => %{"mode" => "all"}},
            %{"v" => 1, "dms" => "sometimes"},
            %{"v" => 1, "workspaces" => %{"mode" => "sideways"}},
            %{"v" => 99}
          ] do
        conn = patch(conn, "/api/v1/bots/#{agent_id}", %{"access" => bad})
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body)["error"]["key"] == "invalid_access"
      end

      # Refused BEFORE anything is persisted: the row still holds the all-none
      # default, never a half-applied or fail-closed-by-accident document.
      assert Principals.get(String.to_integer(agent_id)).access == Access.default()
    end
  end

  describe "regenerate" do
    test "new once-only token; old token 401s the next REST call", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Rotating"})
      %{"id" => agent_id, "token" => old_token} = Jason.decode!(conn.resp_body)

      conn = post(conn, "/api/v1/bots/#{agent_id}/regenerate")
      assert conn.status == 201

      %{"token" => new_token} = Jason.decode!(conn.resp_body)
      assert new_token != old_token
      assert String.starts_with?(new_token, "cytbot_")

      # Old credential dead; new one live; same principal id.
      assert get(auth_conn("Bot " <> old_token), "/api/v1/users/@me").status == 401

      me = get(auth_conn("Bot " <> new_token), "/api/v1/users/@me")
      assert me.status == 200
      assert Jason.decode!(me.resp_body)["user"]["id"] == agent_id
    end

    test "a legacy :bot-kind row rotates through the agents surface", %{conn: conn, owner: owner} do
      {:ok, %{user_id: bot_id, token: old_token}} = Principals.mint(owner.user_id, :bot, "Rotate Bot", nil)
      bot_id = Integer.to_string(bot_id)

      conn = post(conn, "/api/v1/bots/#{bot_id}/regenerate")
      assert conn.status == 201
      %{"token" => new_token} = Jason.decode!(conn.resp_body)

      assert get(auth_conn("Bot " <> old_token), "/api/v1/users/@me").status == 401
      assert get(auth_conn("Bot " <> new_token), "/api/v1/users/@me").status == 200
    end
  end

  describe "delete (full removal)" do
    test "DELETE agent → 204; token 401 next call; re-delete → 404, provenance rows gone", %{
      conn: conn
    } do
      conn = post(conn, "/api/v1/bots", %{"name" => "Doomed"})
      %{"id" => agent_id, "token" => token} = Jason.decode!(conn.resp_body)

      assert delete(conn, "/api/v1/bots/#{agent_id}").status == 204
      assert get(auth_conn("Bot " <> token), "/api/v1/users/@me").status == 401

      # DELETE is full removal (credential + provenance rows — the users row
      # stays for attribution), so a re-delete is the scoped 404, and the
      # liveness filter hides any application commands the agent owned.
      assert delete(conn, "/api/v1/bots/#{agent_id}").status == 404
      assert Principals.get(String.to_integer(agent_id)) == nil
    end

    test "a legacy :bot-kind row deletes through the agents surface → 204 + dead token", %{
      conn: conn,
      owner: owner
    } do
      {:ok, %{user_id: bot_id, token: token}} = Principals.mint(owner.user_id, :bot, run_unique("Doomed Bot"), nil)
      bot_id = Integer.to_string(bot_id)

      assert delete(conn, "/api/v1/bots/#{bot_id}").status == 204
      assert get(auth_conn("Bot " <> token), "/api/v1/users/@me").status == 401
      assert Principals.get(String.to_integer(bot_id)) == nil
    end
  end

  # ---------------------------------------------------------------------------
  # Edge: minter identity + cross-owner protection
  # ---------------------------------------------------------------------------

  describe "only :human principals may mint (R5)" do
    test "an agent's token on POST /agents → 403", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "First"})
      %{"token" => agent_token} = Jason.decode!(conn.resp_body)

      conn = post(auth_conn("Bot " <> agent_token), "/api/v1/bots", %{"name" => "Nested"})
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"
    end

    test "a legacy :bot-kind token on POST /agents → 403 (the rule is kind-agnostic)", %{
      conn: conn,
      owner: owner
    } do
      assert {:ok, %{token: bot_token}} = Principals.mint(owner.user_id, :bot, run_unique("Parent Bot"), nil)

      # A machine credential never mints another, whichever machine kind it is.
      conn = post(auth_conn("Bot " <> bot_token), "/api/v1/bots", %{"name" => "Nested"})
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"
    end
  end

  describe "cross-owner id protection" do
    test "another user's agent id → 404 agent_not_found on PATCH and DELETE", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Not Yours"})
      %{"id" => agent_id, "token" => token} = Jason.decode!(conn.resp_body)

      {:ok, other} = User.create(run_unique("thief"), run_unique("thief@example.com"), "password-123")
      other_conn = conn_for(other)

      conn = patch(other_conn, "/api/v1/bots/#{agent_id}", %{"name" => "Hijack"})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "bot_not_found"

      assert delete(other_conn, "/api/v1/bots/#{agent_id}").status == 404

      # Neither attempt touched the credential: the name is unchanged and the
      # token still authenticates its real owner.
      assert Principals.get(String.to_integer(agent_id)).label == "Not Yours"
      assert get(auth_conn("Bot " <> token), "/api/v1/users/@me").status == 200
    end
  end

  describe "verification gate (agents surface)" do
    test "unverified human → 403 account_unverified", %{conn: conn} do
      {:ok, unverified} = User.create(run_unique("unv"), run_unique("unv@example.com"), "password-123")
      unv_conn = conn_for(unverified, false)

      conn = post(unv_conn, "/api/v1/bots", %{"name" => "Early Agent"})
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "account_unverified"
    end
  end

  # ---------------------------------------------------------------------------
  # Migration guarantee: rows minted under the retired workspace route stay
  # reachable through the user-owned surface
  # ---------------------------------------------------------------------------

  describe "a stray :agent-kind row (minted before the kinds were unified)" do
    test "is still listed and manageable by its parent", %{conn: conn, owner: owner} do
      # `:bot` and `:agent` are one kind now (production mints `:bot`), but rows
      # minted while both existed must keep working: the ownership rule is "the
      # caller is the parent", independent of kind. Minted at the data layer
      # because nothing mints this kind any more.
      assert {:ok, stray} = Principals.mint(owner.user_id, :agent, "Stray Agent", nil)
      stray_id = Integer.to_string(stray.user_id)

      listed = resp_json(get(conn, "/api/v1/bots"))["bots"]
      assert Enum.any?(listed, &(&1["id"] == stray_id))

      renamed = patch(conn, "/api/v1/bots/#{stray_id}", %{"name" => "Renamed"})
      assert renamed.status == 200
      assert Jason.decode!(renamed.resp_body)["name"] == "Renamed"
    end
  end

  describe "legacy :bot-kind credentials" do
    test "listed, grantable and private through the agents surface", %{conn: conn, owner: owner, ws_id: ws_id} do
      # The data layer is the only way to mint the retired kind now — exactly
      # how such a row came to exist before 2026-09-12.
      assert {:ok, legacy} = Principals.mint(owner.user_id, :bot, "Legacy Bot", nil)
      legacy_id = Integer.to_string(legacy.user_id)

      # (a) GET /agents LISTS it — the list is kind-agnostic over machine kinds.
      listed = resp_json(get(conn, "/api/v1/bots"))["bots"]
      assert [row] = Enum.filter(listed, &(&1["id"] == legacy_id))
      assert row["kind"] == "bot"
      assert row["name"] == "Legacy Bot"

      # (b) PATCH /agents/:id writes its access document — the grant the old
      # route could not express.
      document = %{
        "v" => 1,
        "dms" => "read",
        "workspaces" => %{
          "mode" => "custom",
          "grants" => %{Integer.to_string(ws_id) => %{"level" => "read_write"}}
        }
      }

      conn = patch(conn, "/api/v1/bots/#{legacy_id}", %{"access" => document})
      assert conn.status == 200

      assert Jason.decode!(conn.resp_body)["access"] == %{
               "v" => 1,
               "server" => "read",
               "account" => %{"agent" => "read"},
               "dms" => "read",
               # The counterparty policy rides the document both ways; absent
               # reads as the default (owner direction 2026-09-15).
               "dm_support" => "humans",
               "workspaces" => %{
                 "mode" => "custom",
                 "level" => nil,
                 "grants" => %{
                   Integer.to_string(ws_id) => %{"level" => "read_write", "channels" => %{}}
                 }
               }
             }

      assert Principals.get(legacy.user_id).access == Access.parse!(document)

      # (c) ...and it is still the owner's alone: parent == caller is the only
      # ownership rule there is, so another user gets the scoped 404.
      {:ok, other} = User.create(run_unique("legacy_other"), run_unique("legacy_other@example.com"), "password-123")
      other_conn = conn_for(other)

      conn = patch(other_conn, "/api/v1/bots/#{legacy_id}", %{"name" => "Hijack"})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "bot_not_found"
    end
  end

  # ---------------------------------------------------------------------------
  # @me kind/parent growth (U4)
  # ---------------------------------------------------------------------------

  describe "GET /users/@me kind surface" do
    test "human caller: plain kind, no parent key", %{conn: conn, owner: owner} do
      user = Jason.decode!(get(conn, "/api/v1/users/@me").resp_body)["user"]
      assert user["kind"] == "human"
      refute Map.has_key?(user, "parent_user_id")
      assert user["id"] == Integer.to_string(owner.user_id)
    end

    test "bot sub-identity: kind bot + parent_user_id", %{conn: _conn, owner: owner} do
      assert {:ok, %{user_id: bot_id, token: token}} = Principals.mint(owner.user_id, :bot, "Me Bot", nil)

      user = Jason.decode!(get(auth_conn("Bot " <> token), "/api/v1/users/@me").resp_body)["user"]
      assert user["kind"] == "bot"
      assert user["parent_user_id"] == Integer.to_string(owner.user_id)
      assert user["id"] == Integer.to_string(bot_id)
    end

    test "agent sub-identity: the internal kind + parent_user_id", %{conn: conn, owner: owner} do
      conn = post(conn, "/api/v1/bots", %{"name" => "Me Agent"})
      %{"id" => agent_id, "token" => token} = Jason.decode!(conn.resp_body)

      user = Jason.decode!(get(auth_conn("Bot " <> token), "/api/v1/users/@me").resp_body)["user"]
      assert user["kind"] == "bot"
      assert user["parent_user_id"] == Integer.to_string(owner.user_id)
      assert user["id"] == agent_id
    end
  end

  # ---------------------------------------------------------------------------
  # My integrations rollup (settings gear surface)
  # ---------------------------------------------------------------------------

  describe "my integrations rollup" do
    test "GET /users/@me/integrations — caller's bots + agents, metadata + online, never tokens; other parents isolated",
         %{conn: conn, owner: owner} do
      assert {:ok, _} = AgentGrants.mint_all(owner.user_id, :bot, "Rollup Bot")
      assert {:ok, _} = AgentGrants.mint_all(owner.user_id, :agent, "Rollup Agent")

      # Another parent's principal must not leak into the caller's rollup.
      {:ok, other} = User.create(run_unique("rollup_other"), run_unique("rollup_other@example.com"), "password-123")
      assert {:ok, _} = AgentGrants.mint_all(other.user_id, :bot, "Someone Else")

      integrations = resp_json(get(conn, "/api/v1/users/@me/integrations"))["integrations"]

      names = integrations |> Enum.map(& &1["name"]) |> Enum.sort()
      assert names == ["Rollup Agent", "Rollup Bot"]

      kinds = integrations |> Enum.map(& &1["kind"]) |> Enum.sort()
      assert kinds == ["bot", "bot"]

      # Liveness renders (no live sockets in this test) and the payload is
      # metadata only — no token material anywhere.
      assert Enum.all?(integrations, &(&1["online"] == false))
      assert Enum.all?(integrations, &(not Map.has_key?(&1, "token")))

      # …and every row carries `access`, with the grant actually in force. This
      # is the pin whose absence let the readout rot: the client's one-word
      # emptiness test had an inverted `all` arm, so an agent holding "All
      # workspaces · Read-write" — which is exactly what `mint_all` grants, and
      # why this fixture is the right one — read as "No access yet" in the
      # settings rollup while the agents pane (which renders the raw document)
      # showed the correct level. Two surfaces disagreeing about one row is
      # only possible when the row itself is untested.
      assert Enum.all?(integrations, &is_map(&1["access"]))

      granted = Enum.find(integrations, &(&1["name"] == "Rollup Bot"))
      assert granted["access"]["workspaces"]["mode"] == "all"
      assert granted["access"]["workspaces"]["level"] == "read_write"
    end

    test "unauthenticated → 401" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")

      assert get(conn, "/api/v1/users/@me/integrations").status == 401
    end
  end

  defp snowflake(bin) do
    case Integer.parse(bin) do
      {int, ""} when int > 0 -> {:ok, int}
      _ -> :error
    end
  end

  defp resp_json(conn), do: Jason.decode!(conn.resp_body)

  describe "avatar (#126)" do
    test "upload sets avatar_url atomically; rename does not clobber it", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => run_unique("Avatar Bot")})
      assert %{"id" => bot_id} = Jason.decode!(conn.resp_body)

      conn = fresh_auth_conn(conn)
      conn = upload(conn, "bot.png", "image/png", Cytale.UploadHelpers.png_1x1())
      conn = post(conn, "/api/v1/bots/#{bot_id}/avatar", conn.private[:plug_upload_body])
      assert conn.status == 200

      %{"bot" => %{"avatar_url" => url, "name" => unchanged}} = Jason.decode!(conn.resp_body)
      assert url != nil and url != ""
      assert unchanged =~ "Avatar Bot"

      # A rename writes back the CURRENT avatar — it must not wipe the image.
      renamed = patch(conn, "/api/v1/bots/#{bot_id}", %{"name" => "Renamed Bot"})
      assert %{"avatar_url" => ^url} = Jason.decode!(renamed.resp_body)
    end

    test "clear → avatar_url nil", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => run_unique("Clear Bot")})
      %{"id" => bot_id} = Jason.decode!(conn.resp_body)

      conn = fresh_auth_conn(conn)
      conn = upload(conn, "bot.png", "image/png", Cytale.UploadHelpers.png_1x1())
      assert post(conn, "/api/v1/bots/#{bot_id}/avatar", conn.private[:plug_upload_body]).status == 200

      cleared = delete(fresh_auth_conn(conn), "/api/v1/bots/#{bot_id}/avatar")
      assert cleared.status == 200
      assert %{"bot" => %{"avatar_url" => nil}} = Jason.decode!(cleared.resp_body)
    end

    test "a non-parent gets the anti-enumeration 404", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => run_unique("Mine Bot")})
      %{"id" => bot_id} = Jason.decode!(conn.resp_body)

      {:ok, other} = Cytale.Accounts.User.create(run_unique("other"), run_unique("o@example.com"), "password-123")
      other_access = Cytale.Accounts.Auth.issue_access_token(other.user_id, other.username, true)

      other_conn =
        fresh_auth_conn(conn)
        |> put_req_header("authorization", "Bearer " <> other_access)
        |> upload("bot.png", "image/png", Cytale.UploadHelpers.png_1x1())

      conn = post(other_conn, "/api/v1/bots/#{bot_id}/avatar", other_conn.private[:plug_upload_body])
      assert conn.status == 404
      assert %{"error" => %{"key" => "bot_not_found"}} = Jason.decode!(conn.resp_body)
    end

    test "no file → 400 validation_failed", %{conn: conn} do
      conn = post(conn, "/api/v1/bots", %{"name" => run_unique("NoFile Bot")})
      %{"id" => bot_id} = Jason.decode!(conn.resp_body)

      conn = post(conn, "/api/v1/bots/#{bot_id}/avatar", %{})
      assert conn.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
    end
  end

  # ---------------------------------------------------------------------------
  # Membership by association is announced (bot attribution, 2026-10-02)
  # ---------------------------------------------------------------------------

  # A viewer's client names authors from its roster, kept live by MemberAdd. A
  # person's join always announced one; a machine's GRANT did not, so a bot
  # granted after a viewer hydrated posted — and started threads — as its raw
  # snowflake. The grant now announces exactly like a join, in the people row's
  # shape (label, avatar, kind, owner).
  describe "a grant announces membership like a join" do
    alias Cytale.Gateway.PushRegistry

    defp grant_all(conn, bot_id, level) do
      patch(conn, "/api/v1/bots/#{bot_id}", %{
        "access" => %{
          "v" => 1,
          "dms" => "none",
          "dm_support" => "humans",
          "workspaces" => %{"mode" => if(level == "none", do: "none", else: "all"), "level" => level, "grants" => %{}}
        }
      })
    end

    test "granting a workspace fans MemberAdd with the bot's name, kind and owner; revoking fans MemberRemove",
         %{conn: conn, owner: owner, ws_id: ws_id} do
      ws = Integer.to_string(ws_id)
      :ok = PushRegistry.subscribe(PushRegistry.workspace_key(ws), "viewer-live-session")

      name = run_unique("Hermes ")
      created = post(conn, "/api/v1/bots", %{"name" => name})
      assert created.status == 201
      %{"id" => bot_id} = Jason.decode!(created.resp_body)

      # Minting grants nothing — nothing to announce yet.
      refute_receive {:cytale_gateway_push, _, {"MemberAdd", _}, _}, 200

      granted = grant_all(fresh_json_conn(conn), bot_id, "read_write")
      assert granted.status == 200

      assert_receive {:cytale_gateway_push, _from, {"MemberAdd", payload}, _fragment}, 1_000
      assert payload["workspace_id"] == ws
      assert payload["user"]["id"] == bot_id
      # The label is the display name (#168); the nickname is unset (#169).
      assert payload["user"]["display_name"] == name
      assert payload["nickname"] == nil
      assert payload["kind"] == "bot"
      assert payload["parent_user_id"] == Integer.to_string(owner.user_id)
      assert Map.has_key?(payload["user"], "avatar_url")

      # The same row a reload's people page reads.
      people = get(fresh_json_conn(conn), "/api/v1/workspaces/#{ws}/people")
      row = Enum.find(Jason.decode!(people.resp_body)["people"] || [], &(&1["user"]["id"] == bot_id))

      assert Map.take(row, ["nickname", "kind", "parent_user_id", "user"]) ==
               Map.take(payload, ["nickname", "kind", "parent_user_id", "user"])

      # A re-grant at another level changes no association: no second add.
      assert grant_all(fresh_json_conn(conn), bot_id, "read").status == 200
      refute_receive {:cytale_gateway_push, _, {"MemberAdd", _}, _}, 200

      assert grant_all(fresh_json_conn(conn), bot_id, "none").status == 200
      assert_receive {:cytale_gateway_push, _from, {"MemberRemove", removed}, _fragment}, 1_000
      assert removed == %{"workspace_id" => ws, "user_id" => bot_id}
    end

    test "Workspaces.roster_entry/2: a person by membership, a machine by grant, nil otherwise",
         %{conn: conn, owner: owner, ws_id: ws_id} do
      name = run_unique("Hermes ")
      created = post(conn, "/api/v1/bots", %{"name" => name})
      assert created.status == 201
      %{"id" => bot_id} = Jason.decode!(created.resp_body)
      bot = String.to_integer(bot_id)

      assert %{kind: :human, user_id: owner_id} = Workspaces.roster_entry(ws_id, owner.user_id)
      assert owner_id == owner.user_id
      assert Workspaces.roster_entry(ws_id, bot) == nil

      assert grant_all(fresh_json_conn(conn), bot_id, "read_write").status == 200

      assert %{kind: :bot, display_name: ^name, nickname: nil, parent_user_id: parent} =
               Workspaces.roster_entry(ws_id, bot)

      assert parent == owner.user_id
    end
  end

  defp fresh_json_conn(conn), do: conn |> fresh_auth_conn() |> put_req_header("content-type", "application/json")
end
