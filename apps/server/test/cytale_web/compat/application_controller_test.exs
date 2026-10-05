defmodule CytaleWeb.Compat.ApplicationControllerTest do
  @moduledoc """
  Bots plan U8 — application-command registration over the compat
  applications routes (KTD13): PUT bulk upsert + POST single create, the
  self-application binding (`{bot_id}` must equal the authenticated
  principal), the workspace-rights gate (resolver non-zero rights — the
  out-of-membership 403), CHAT_INPUT name validation (Discord regex,
  lowercase), and the stored-array response shape. #133 adds the READ half —
  GET the stored set — with the writes' gates mirrored exactly (the
  cross-principal 404 10002 and the out-of-membership 403 50001), the
  read-after-write round trip (the GET object IS the PUT echo object), the
  empty registration reading as `[]`, and the (workspace, application)
  projection (a sibling bot's rows are invisible).

  The foreign-bot_id and out-of-membership cases are the unit's P1 authz-gap
  closures — pinned here first.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Interactions
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp bot_conn(token) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bot " <> token)
  end

  setup do
    {:ok, owner} = User.create(run_unique("u8a_owner"), run_unique("u8a_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u8a-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Slash Bot"))
    {:ok, ws: ws, ch: ch, bot: bot, conn: bot_conn(bot.token)}
  end

  defp bulk_path(bot_id, ws_id), do: "/api/v10/applications/#{bot_id}/guilds/#{ws_id}/commands"

  # ---------------------------------------------------------------------------
  # Registration happy paths
  # ---------------------------------------------------------------------------

  # A PUT body is a bare JSON ARRAY — Phoenix.ConnTest treats list bodies as
  # params, so raw-array requests encode explicitly (the content-type header
  # is already application/json from bot_conn/1).
  defp put_commands(conn, path, commands),
    do: put(conn, path, Jason.encode!(commands))

  test "PUT bulk upsert stores the array and echoes the Discord command objects", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    conn =
      put_commands(conn, bulk_path(bot.user_id, ws.workspace_id), [
        %{"name" => "echo", "description" => "Echo text", "options" => [%{"name" => "text", "type" => 3}]},
        %{"name" => "roll", "description" => "Roll dice"}
      ])

    assert conn.status == 200
    stored = Jason.decode!(conn.resp_body)
    assert [%{"name" => "echo"} = echo, %{"name" => "roll"}] = Enum.sort_by(stored, & &1["name"])

    assert %{
             "id" => id,
             "type" => 1,
             "application_id" => app_id,
             "guild_id" => guild_id,
             "name" => "echo",
             "description" => "Echo text"
           } = echo

    assert is_binary(id)
    assert app_id == Integer.to_string(bot.user_id)
    assert guild_id == Integer.to_string(ws.workspace_id)
    assert echo["options"] == [%{"name" => "text", "type" => 3}]
  end

  test "POST single create returns 201 with the object", %{conn: conn, ws: ws, bot: bot} do
    conn =
      post(conn, bulk_path(bot.user_id, ws.workspace_id), %{
        "name" => "ping",
        "description" => "Ping the bot"
      })

    assert conn.status == 201
    assert %{"name" => "ping", "application_id" => app_id} = Jason.decode!(conn.resp_body)
    assert app_id == Integer.to_string(bot.user_id)
  end

  test "re-PUT replaces the set (removed names disappear from the composer list)", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    put_commands(conn, bulk_path(bot.user_id, ws.workspace_id), [
      %{"name" => "echo", "description" => "d"},
      %{"name" => "roll", "description" => "d"}
    ])

    conn =
      put_commands(conn, bulk_path(bot.user_id, ws.workspace_id), [
        %{"name" => "roll", "description" => "d"}
      ])

    assert conn.status == 200
    names = ws.workspace_id |> Interactions.list_commands() |> Enum.map(& &1.name)
    assert names == ["roll"]
  end

  # ---------------------------------------------------------------------------
  # The P1 authz gaps (registration binding + workspace rights)
  # ---------------------------------------------------------------------------

  test "registration under a FOREIGN bot_id is rejected (404 unknown application)", %{
    ws: ws,
    bot: bot,
    conn: conn
  } do
    # A second bot minted by the same owner: authenticated as bot A, writing
    # bot B's command set must not fly.
    {:ok, other} = AgentGrants.mint_all(bot.parent_user_id, :bot, run_unique("Other Bot"))

    conn =
      put_commands(conn, bulk_path(other.user_id, ws.workspace_id), [
        %{"name" => "evil", "description" => "d"}
      ])

    assert conn.status == 404
    assert Jason.decode!(conn.resp_body)["code"] == 10_002
    # Nothing was stored under the foreign application.
    assert [] = Enum.filter(Interactions.list_commands(ws.workspace_id), &(&1.application_id == other.user_id))
  end

  test "registration in a workspace the bot's parent is NOT a member of is rejected (403)", %{
    bot: bot,
    conn: conn
  } do
    # A workspace owned by someone else; the bot's parent has no membership.
    {:ok, stranger} = User.create(run_unique("u8a_stranger"), run_unique("u8a_stranger@example.com"), "password-123")
    {:ok, foreign_ws} = Workspaces.create_workspace(stranger.user_id, run_unique("u8a-foreign"))

    conn =
      put_commands(conn, bulk_path(bot.user_id, foreign_ws.workspace_id), [
        %{"name" => "sneak", "description" => "d"}
      ])

    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["code"] == 50_001
    assert [] = Interactions.list_commands(foreign_ws.workspace_id)
  end

  test "registration against an unknown workspace is 404, unknown bot_id shape is 404", %{
    bot: bot,
    conn: conn
  } do
    conn =
      put_commands(conn, bulk_path(bot.user_id, 999_999_999_999), [%{"name" => "x", "description" => "d"}])

    assert conn.status == 404

    conn =
      put_commands(bot_conn(bot.token), bulk_path(999_999_999_999, 999_999_999_999), [
        %{"name" => "x", "description" => "d"}
      ])

    assert conn.status == 404
  end

  # ---------------------------------------------------------------------------
  # Validation
  # ---------------------------------------------------------------------------

  test "invalid CHAT_INPUT names (spaces / uppercase / 33 chars) are 400 50035", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    for bad <- ["has space", "Upper", String.duplicate("a", 33)] do
      conn = put_commands(conn, bulk_path(bot.user_id, ws.workspace_id), [%{"name" => bad, "description" => "d"}])
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["code"] == 50_035
    end

    assert [] = Interactions.list_commands(ws.workspace_id)
  end

  test "non-array PUT body is 400", %{conn: conn, ws: ws, bot: bot} do
    conn = put(conn, bulk_path(bot.user_id, ws.workspace_id), %{"name" => "not-a-list"})
    assert conn.status == 400
  end

  # ---------------------------------------------------------------------------
  # The command-list read (#133) — GET the stored set
  # ---------------------------------------------------------------------------

  test "GET returns the stored set as the exact PUT-echo objects (read-after-write round trip)", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    echo =
      conn
      |> put_commands(bulk_path(bot.user_id, ws.workspace_id), [
        %{"name" => "echo", "description" => "Echo text", "options" => [%{"name" => "text", "type" => 3}]},
        %{"name" => "roll", "description" => "Roll dice"}
      ])
      |> Map.fetch!(:resp_body)
      |> Jason.decode!()
      |> Map.new(&{&1["name"], &1})

    res = get(conn, bulk_path(bot.user_id, ws.workspace_id))

    assert res.status == 200
    # The GET body IS the echo body (order aside): same ids — surviving names
    # keep them — same fields. This is the load-bearing safe-sync property:
    # fetch must see exactly what the write returned, or every diff looks
    # stale.
    got = res.resp_body |> Jason.decode!() |> Map.new(&{&1["name"], &1})
    assert got == echo

    # Spell out the Discord object's load-bearing fields anyway, so a
    # serializer regression fails HERE and not in a library somewhere.
    assert %{
             "id" => id,
             "type" => 1,
             "application_id" => app_id,
             "guild_id" => guild_id,
             "name" => "echo",
             "description" => "Echo text",
             "version" => "1",
             "options" => [%{"name" => "text", "type" => 3}]
           } = got["echo"]

    assert is_binary(id)
    assert app_id == Integer.to_string(bot.user_id)
    assert guild_id == Integer.to_string(ws.workspace_id)
  end

  test "GET on an empty registration reads as [] (not a 404, not a bare body)", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    res = get(conn, bulk_path(bot.user_id, ws.workspace_id))
    assert res.status == 200
    assert Jason.decode!(res.resp_body) == []
  end

  test "the read is mounted on BOTH compat prefixes (v10 and bare /api)", %{conn: conn, ws: ws, bot: bot} do
    for prefix <- ["/api/v10", "/api"] do
      path = "#{prefix}/applications/#{bot.user_id}/guilds/#{ws.workspace_id}/commands"

      put_commands(conn, path, [%{"name" => "ping", "description" => "d"}])
      res = get(conn, path)

      assert res.status == 200, "#{prefix} → #{res.status}"
      assert [%{"name" => "ping", "version" => "1"}] = Jason.decode!(res.resp_body)
    end
  end

  test "the read is the (workspace, application) pair — a sibling bot's rows are invisible", %{
    conn: conn,
    ws: ws,
    bot: bot
  } do
    {:ok, other} = AgentGrants.mint_all(bot.parent_user_id, :bot, run_unique("Sibling Bot"))

    put_commands(conn, bulk_path(bot.user_id, ws.workspace_id), [%{"name" => "mine", "description" => "d"}])

    put_commands(bot_conn(other.token), bulk_path(other.user_id, ws.workspace_id), [
      %{"name" => "theirs", "description" => "d"}
    ])

    mine = get(conn, bulk_path(bot.user_id, ws.workspace_id))
    assert mine.status == 200
    assert [%{"name" => "mine"}] = Jason.decode!(mine.resp_body)

    theirs = get(bot_conn(other.token), bulk_path(other.user_id, ws.workspace_id))
    assert theirs.status == 200
    assert [%{"name" => "theirs"}] = Jason.decode!(theirs.resp_body)
  end

  # The rejections are asserted as LITERAL mirrors of the write path's
  # response on the same URL — the anti-oracle property (a read leaks nothing
  # the write does not) is the spec, not just a status code.

  test "reading a FOREIGN bot_id mirrors the write rejection (404 10002)", %{conn: conn, ws: ws, bot: bot} do
    {:ok, other} = AgentGrants.mint_all(bot.parent_user_id, :bot, run_unique("Other Bot"))

    write = put_commands(conn, bulk_path(other.user_id, ws.workspace_id), [%{"name" => "evil", "description" => "d"}])
    read = get(conn, bulk_path(other.user_id, ws.workspace_id))

    assert write.status == 404
    assert read.status == write.status
    assert Jason.decode!(read.resp_body) == Jason.decode!(write.resp_body)
    assert Jason.decode!(read.resp_body)["code"] == 10_002
    # Nothing under the foreign application was exposed or created.
    assert [] = Enum.filter(Interactions.list_commands(ws.workspace_id), &(&1.application_id == other.user_id))
  end

  test "reading a workspace the bot's parent is NOT a member of mirrors the write rejection (403 50001)", %{
    bot: bot,
    conn: conn
  } do
    {:ok, stranger} = User.create(run_unique("u8a_stranger"), run_unique("u8a_stranger@example.com"), "password-123")
    {:ok, foreign_ws} = Workspaces.create_workspace(stranger.user_id, run_unique("u8a-foreign"))

    write =
      put_commands(conn, bulk_path(bot.user_id, foreign_ws.workspace_id), [%{"name" => "sneak", "description" => "d"}])

    read = get(conn, bulk_path(bot.user_id, foreign_ws.workspace_id))

    assert write.status == 403
    assert read.status == write.status
    assert Jason.decode!(read.resp_body) == Jason.decode!(write.resp_body)
    assert Jason.decode!(read.resp_body)["code"] == 50_001
  end

  test "reading an unknown workspace is the writes' bare 404", %{bot: bot, conn: conn} do
    write = put_commands(conn, bulk_path(bot.user_id, 999_999_999_999), [%{"name" => "x", "description" => "d"}])
    read = get(conn, bulk_path(bot.user_id, 999_999_999_999))

    assert write.status == 404
    assert read.status == write.status
    assert Jason.decode!(read.resp_body)["code"] == 0
  end

  # ---------------------------------------------------------------------------
  # The application object (#61 item 2)
  # ---------------------------------------------------------------------------

  # `Client.login()` fetches this BEFORE it opens a socket: discord.py via the
  # /oauth2/ form, discord.js via the bare one — a missing route is a 404 on
  # login, which is how this was found.
  describe "GET applications/@me" do
    @application_paths [
      "/api/v10/applications/@me",
      "/api/v10/oauth2/applications/@me",
      "/api/applications/@me",
      "/api/oauth2/applications/@me"
    ]

    test "every spelling serves the application object", %{conn: conn, bot: bot} do
      for path <- @application_paths do
        res = get(conn, path)
        assert res.status == 200, "#{path} → #{res.status}"

        body = Jason.decode!(res.resp_body)

        # Exactly the keys `discord.appinfo.AppInfo.__init__` indexes with
        # `data[...]` — it does not use `.get`, so an absent key is the same
        # login failure as the 404 this route fixed.
        for key <- ~w(id name description icon bot_public bot_require_code_grant owner verify_key) do
          assert Map.has_key?(body, key), "#{path} is missing required key #{key}"
        end

        assert body["id"] == Integer.to_string(bot.user_id)
        # The application name is the credential's TAG (its unique handle).
        assert body["name"] == bot.username
        assert body["description"] == ""
        assert body["icon"] == nil
        assert body["bot_public"] == true
        assert body["bot_require_code_grant"] == false
        # #112: the advertised capability flags — entitled to the Message
        # Content intent (1 << 18), never the LIMITED variant.
        assert body["flags"] == 262_144
        assert body["team"] == nil

        # `owner` is a full user object: the parent human.
        assert body["owner"]["id"] == Integer.to_string(bot.parent_user_id)
        assert is_binary(body["owner"]["username"])

        # `verify_key` is Discord's Ed25519 key for interaction-request
        # signatures. Cytale signs nothing (no X-Signature-Ed25519 is ever
        # sent), so it is a fixed placeholder — 64 hex chars, Discord's shape,
        # stable across releases — pinned as a divergence in compat.md.
        assert is_binary(body["verify_key"])
        assert String.length(body["verify_key"]) == 64
      end
    end

    test "an unknown token is the uniform 401 (no route-specific oracle)" do
      conn = bot_conn("cytbot_bogus")
      res = get(conn, "/api/v10/oauth2/applications/@me")
      assert res.status == 401
      assert Jason.decode!(res.resp_body) == %{"message" => "401: Unauthorized", "code" => 0}
    end
  end
end
