defmodule CytaleWeb.Compat.UsersControllerTest do
  @moduledoc """
  U6 (bots plan) — GET /users/@me on both compat prefixes: the machine
  principal as a Discord user object (bot: true, discriminator "0",
  global_name, id decimal string). KTD7.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  setup do
    {:ok, owner} = User.create(run_unique("me_owner"), run_unique("me_owner@example.com"), "password-123")

    {:ok, %{user_id: bot_id, token: token, username: bot_username}} =
      AgentGrants.mint_all(owner.user_id, :bot, run_unique("Me Bot"))

    {:ok, owner: owner, bot_id: bot_id, bot_username: bot_username, token: token}
  end

  test "versioned prefix: Discord user object, no envelope wrapper", %{
    bot_id: bot_id,
    bot_username: bot_username,
    token: token
  } do
    conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) == %{
             "id" => Integer.to_string(bot_id),
             "username" => bot_username,
             "discriminator" => "0",
             "global_name" => bot_username,
             "avatar" => nil,
             "bot" => true
           }
  end

  test "bare alias /api/users/@me answers identically", %{bot_id: bot_id, token: token} do
    conn = get(conn_with("Bot " <> token), "/api/users/@me")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["id"] == Integer.to_string(bot_id)
    assert Jason.decode!(conn.resp_body)["bot"] == true
  end

  test "agent principal carries the same user-object shape", %{owner: owner} do
    {:ok, %{user_id: agent_id, token: token, username: agent_username}} =
      AgentGrants.mint_all(owner.user_id, :agent, run_unique("Me Agent"))

    conn = get(conn_with("Bot " <> token), "/api/v10/users/@me")
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["id"] == Integer.to_string(agent_id)
    assert body["bot"] == true
    # The wire carries the credential's TAG, not its label.
    assert body["username"] == agent_username
  end

  describe "GET /users/@me/guilds + GET /guilds/{id} (discord.py fetch_guilds / fetch_guild)" do
    # Fixtures: an owner in TWO workspaces; one bot granted only the first; one
    # bot granted nothing.
    defp fixtures do
      nonce = run_unique("glds")
      {:ok, owner} = User.create(run_unique("glds_owner"), run_unique("glds_owner@example.com"), "password-123")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, "Guilds WS " <> nonce)
      {:ok, dark_ws} = Workspaces.create_workspace(owner.user_id, "Dark WS " <> nonce)

      {:ok, granted} = Principals.mint(owner.user_id, :bot, "Guilds Bot " <> nonce, nil)

      :ok =
        Principals.update_access(granted.user_id, %{
          version: 1,
          dms: :none,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants: %{ws.workspace_id => %{level: :read, channels: %{}}}
          }
        })

      {:ok, dark} = Principals.mint(owner.user_id, :bot, "Dark Bot " <> nonce, nil)

      %{
        owner: owner,
        ws: ws,
        dark_ws: dark_ws,
        granted: %{user_id: granted.user_id, token: granted.token, username: granted.username},
        dark: %{user_id: dark.user_id, token: dark.token, username: dark.username}
      }
    end

    test "fetch_guilds: a BARE array of the safe-minimum partial guild; query params never 400" do
      %{ws: ws, granted: granted} = fixtures()

      # EXACT shape: the safe minimum discord.py's Guild._from_data needs (only
      # "id" is unguarded on the client). A key added here is a shape commitment
      # — this assert fails in both directions.
      expected = [
        %{
          "id" => Integer.to_string(ws.workspace_id),
          "name" => ws.name,
          "icon" => nil,
          "owner_id" => Integer.to_string(ws.owner_id),
          "features" => [],
          "unavailable" => false
        }
      ]

      for prefix <- ["/api/v10", "/api"] do
        conn = get(conn_with("Bot " <> granted.token), prefix <> "/users/@me/guilds")
        assert conn.status == 200
        assert Jason.decode!(conn.resp_body) == expected

        # fetch_guilds() sends limit (default 200) and before/after cursors.
        conn = get(conn_with("Bot " <> granted.token), prefix <> "/users/@me/guilds?limit=200&before=&after=")
        assert conn.status == 200
        assert Jason.decode!(conn.resp_body) == expected
      end
    end

    test "fetch_guilds cost is flat in the workspace count (plan 5.10)" do
      # The login-time guild fetch resolved each workspace ONE AT A TIME on top of
      # listing them, so a credential in ten guilds paid ten permission resolutions
      # before the client got its first byte. The membership index already proves
      # membership and the access document is the grant, so the fetch is now the
      # batched index read (5.8) plus the document filter.
      %{owner: owner, granted: granted, ws: ws} = fixtures()

      {_guilds, one} =
        statements_of(fn ->
          get(conn_with("Bot " <> granted.token), "/api/v10/users/@me/guilds")
        end)

      # Four more workspaces the SAME grant does not name (so the doc filter drops
      # them) and four more it does (so they are resolved, not skipped).
      :ok =
        Principals.update_access(granted.user_id, %{
          version: 1,
          dms: :none,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants:
              Map.new(1..4, fn i ->
                {:ok, w} = Workspaces.create_workspace(owner.user_id, run_unique("flat-ws-#{i}"))
                {w.workspace_id, %{level: :read, channels: %{}}}
              end)
              |> Map.put(ws.workspace_id, %{level: :read, channels: %{}})
          }
        })

      {guilds, five} =
        statements_of(fn ->
          get(conn_with("Bot " <> granted.token), "/api/v10/users/@me/guilds")
        end)

      assert length(Jason.decode!(guilds.resp_body)) == 5
      assert length(five) == length(one), "the guild fetch scaled with workspaces: #{length(one)} → #{length(five)}"
    end

    # Every statement the REQUEST executes while `fun` runs, as text. ConnTest
    # runs the endpoint in this process, so the request's statements come from
    # here or from a task it spawned (which lists this process in `$callers`).
    # Counting every statement on the node let any other process's work that
    # landed in the window change the count (CI saw 9 → 7 once).
    defp statements_of(fun) do
      parent = self()
      ref = make_ref()
      handler_id = "compat-users-stmts-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, metadata, ^parent ->
            if self() == parent or parent in Process.get(:"$callers", []) do
              send(parent, {:stmt, ref, statement_text(metadata.query)})
            end
          end,
          parent
        )

      result = fun.()
      stmts = drain_statements(ref)
      :ok = :telemetry.detach(handler_id)
      {result, stmts}
    end

    defp drain_statements(ref) do
      receive do
        {:stmt, ^ref, text} -> [text | drain_statements(ref)]
      after
        50 -> []
      end
    end

    defp statement_text(%Xandra.Batch{queries: queries}),
      do: Enum.map_join(queries, "; ", &Map.get(&1, :statement, ""))

    defp statement_text(query), do: Map.get(query, :statement)

    test "only ASSOCIATED workspaces appear (membership by inclusion)" do
      %{ws: ws, dark_ws: dark_ws, granted: granted} = fixtures()

      conn = get(conn_with("Bot " <> granted.token), "/api/v10/users/@me/guilds")
      guilds = Jason.decode!(conn.resp_body)
      ids = Enum.map(guilds, & &1["id"])

      assert Integer.to_string(ws.workspace_id) in ids
      # The parent belongs to this workspace; the credential was never granted
      # it, so it is NOT a member of it.
      refute Integer.to_string(dark_ws.workspace_id) in ids
    end

    test "an un-granted credential lists NOTHING" do
      %{dark: dark} = fixtures()

      conn = get(conn_with("Bot " <> dark.token), "/api/v10/users/@me/guilds")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == []
    end

    test "fetch_guild: associated → 200; with_counts (sent by default) adds the approximations" do
      %{ws: ws, granted: granted} = fixtures()
      id = Integer.to_string(ws.workspace_id)

      conn = get(conn_with("Bot " <> granted.token), "/api/v10/guilds/#{id}")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["id"] == id
      refute Map.has_key?(body, "approximate_member_count")

      # discord.py sends with_counts=1 BY DEFAULT on fetch_guild.
      conn = get(conn_with("Bot " <> granted.token), "/api/v10/guilds/#{id}?with_counts=1")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["id"] == id
      assert body["approximate_member_count"] >= 1
      assert body["approximate_presence_count"] >= 0
    end

    test "fetch_channels: ws-level read lists every channel; channel-level grants narrow it" do
      nonce = run_unique("gldsch")
      {:ok, owner} = User.create(run_unique("gldsch_owner"), run_unique("gldsch_owner@example.com"), "password-123")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, "Channels WS " <> nonce)
      {:ok, ch_a} = Workspaces.create_channel(ws.workspace_id, "alpha")
      {:ok, ch_b} = Workspaces.create_channel(ws.workspace_id, "bravo")

      # Workspace level NONE with ONE visible channel: the listing must narrow
      # to exactly that channel (the enforcement point is the SAME
      # visible-set computation the gateway dispatch filter uses).
      {:ok, bot} = Principals.mint(owner.user_id, :bot, "Channels Bot " <> nonce, nil)

      :ok =
        Principals.update_access(bot.user_id, %{
          version: 1,
          dms: :none,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants: %{
              ws.workspace_id => %{
                level: :none,
                channels: %{ch_a.channel_id => :read}
              }
            }
          }
        })

      conn = get(conn_with("Bot " <> bot.token), "/api/v10/guilds/#{ws.workspace_id}/channels")
      assert conn.status == 200

      channels = Jason.decode!(conn.resp_body)
      assert Enum.map(channels, & &1["id"]) == [Integer.to_string(ch_a.channel_id)]

      # The discord.py requirements are present on the object: type is
      # unguarded in the factory, and TextChannel needs id/name/position (#64).
      assert channels |> hd() |> Map.fetch!("type") == 0
      assert channels |> hd() |> Map.fetch!("name") == "alpha"
      assert is_integer(channels |> hd() |> Map.fetch!("position"))

      # A ws-level READ lift lists every text channel.
      :ok =
        Principals.update_access(bot.user_id, %{
          version: 1,
          dms: :none,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants: %{ws.workspace_id => %{level: :read, channels: %{}}}
          }
        })

      conn = get(conn_with("Bot " <> bot.token), "/api/v10/guilds/#{ws.workspace_id}/channels")
      ids = Jason.decode!(conn.resp_body) |> Enum.map(& &1["id"])
      assert Integer.to_string(ch_a.channel_id) in ids
      assert Integer.to_string(ch_b.channel_id) in ids
    end

    test "fetch_channels: ungranted or unknown guild → compat 404 10004" do
      %{ws: ws, dark: dark} = fixtures()

      conn = get(conn_with("Bot " <> dark.token), "/api/v10/guilds/#{ws.workspace_id}/channels")
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"code" => 10_004, "message" => "Unknown Guild"}

      conn = get(conn_with("Bot " <> dark.token), "/api/v10/guilds/not-a-snowflake/channels")
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"code" => 10_004, "message" => "Unknown Guild"}
    end

    test "fetch_guild: ungranted or unknown → compat 404 10004, so the client raises NotFound" do
      %{ws: ws, dark: dark} = fixtures()

      for path <- ["/api/v10/guilds/#{ws.workspace_id}", "/api/guilds/#{ws.workspace_id}"] do
        conn = get(conn_with("Bot " <> dark.token), path)
        assert conn.status == 404

        # The compat shape — NOT the native error envelope, which would crash
        # discord.py on a route it thought existed.
        assert Jason.decode!(conn.resp_body) == %{"code" => 10_004, "message" => "Unknown Guild"}
      end

      # A garbage id answers the same shape (no oracle for id validity).
      conn = get(conn_with("Bot " <> dark.token), "/api/v10/guilds/not-a-snowflake")
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body) == %{"code" => 10_004, "message" => "Unknown Guild"}
    end
  end
end
