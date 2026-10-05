defmodule CytaleWeb.Controllers.WorkspaceControllerTest do
  @moduledoc """
  U9 — workspace surface integration tests: register → login → create
  workspace → channels → message flow over the REAL router/pipeline/ScyllaDB
  stack. Fixtures are run-scoped-unique (ScyllaCase policy) — the keyspace is
  NOT reset between modules.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  import Cytale.UploadHelpers

  @endpoint CytaleWeb.Endpoint

  # Run-scoped unique suffix (ScyllaCase policy — see auth_controller_test).
  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, conn: conn}
  end

  describe "members surface" do
    test "members lists the roster; kick removes and 404s on non-members", %{conn: conn} do
      {owner_conn, owner} = register_and_login(build_conn())
      conn_ws = post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("members ws")})
      ws_id = Jason.decode!(conn_ws.resp_body)["workspace"]["id"]

      # Second member joins via a direct membership write (invite flow is
      # covered in its own suite).
      {:ok, joiner} = User.create(run_unique("mem_join"), run_unique("mem_join@example.com"), "password-123")
      :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), joiner.user_id, owner.user_id)

      listed = get(owner_conn, "/api/v1/workspaces/#{ws_id}/members")
      assert listed.status == 200
      roster = Jason.decode!(listed.resp_body)["members"]
      assert length(roster) == 2

      assert Enum.map(roster, & &1["user_id"]) |> Enum.sort() ==
               Enum.sort([Integer.to_string(owner.user_id), Integer.to_string(joiner.user_id)])

      # Owner kicks the joiner.
      kicked = delete(owner_conn, "/api/v1/workspaces/#{ws_id}/members/#{joiner.user_id}")
      assert kicked.status == 200

      after_kick = get(owner_conn, "/api/v1/workspaces/#{ws_id}/members")
      assert length(Jason.decode!(after_kick.resp_body)["members"]) == 1

      # Kicking a non-member is the workspace-shaped 404 (no oracle).
      again = delete(owner_conn, "/api/v1/workspaces/#{ws_id}/members/#{joiner.user_id}")
      assert again.status == 404
      assert %{"error" => %{"key" => "member_not_found"}} = Jason.decode!(again.resp_body)
    end

    # A8: the roster is membership-gated through the principal-rights
    # resolver — any authenticated credential used to read ANY workspace's
    # members (owner or not). Non-members get the same 404 as an unknown
    # workspace (Tier 3 B, 11); machine principals of a member ride the parent
    # fallback.
    test "members is gated: non-member 404 like an unknown workspace, member + machine-principal-of-member OK",
         %{conn: conn} do
      {owner_conn, owner} = register_and_login(build_conn())
      conn_ws = post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("gate ws")})
      ws_id = Jason.decode!(conn_ws.resp_body)["workspace"]["id"]

      # A member (via direct membership write) may read.
      {:ok, member} = User.create(run_unique("gate_member"), run_unique("gate_member@example.com"), "password-123")
      :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), member.user_id, owner.user_id)

      member_access = Auth.issue_access_token(member.user_id, member.username, true)

      member_conn =
        conn
        |> put_req_header("authorization", "Bearer " <> member_access)
        |> get("/api/v1/workspaces/#{ws_id}/members")

      assert member_conn.status == 200
      assert length(Jason.decode!(member_conn.resp_body)["members"]) == 2

      # A machine principal of the MEMBER reads through the parent fallback.
      {:ok, %{user_id: agent_id, token: agent_token}} =
        Cytale.Test.AgentGrants.mint_all(member.user_id, :agent, run_unique("Roster Agent"))

      agent_conn =
        conn
        |> put_req_header("authorization", "Bot " <> agent_token)
        |> get("/api/v1/workspaces/#{ws_id}/members")

      assert agent_conn.status == 200

      # The roster synthesizes the agent's own entry beside its parent (U5
      # merge principle): owner + member + the agent itself.
      assert Jason.decode!(agent_conn.resp_body)["members"]
             |> Enum.map(& &1["user_id"])
             |> Enum.sort() ==
               Enum.sort([
                 Integer.to_string(owner.user_id),
                 Integer.to_string(member.user_id),
                 Integer.to_string(agent_id)
               ])

      # An unrelated authenticated credential gets the SAME 404 as an unknown
      # workspace (Tier 3 B, 11 — the 403 confirmed the workspace existed).
      {stranger_conn, _stranger} = register_and_login(build_conn())

      forbidden =
        stranger_conn
        |> get("/api/v1/workspaces/#{ws_id}/members")

      assert forbidden.status == 404
      assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(forbidden.resp_body)

      # An unknown workspace keeps the 404 shape for everyone.
      unknown = get(stranger_conn, "/api/v1/workspaces/123456789012345678/members")
      assert unknown.status == 404
      assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(unknown.resp_body)
    end
  end

  describe "roster synthesis (bots plan U5)" do
    test "members + show carry kind/parent_user_id for machine principals beside humans" do
      {owner_conn, owner} = register_and_login(build_conn_with_headers())
      conn_ws = post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("u5 roster ws")})
      ws_id = Jason.decode!(conn_ws.resp_body)["workspace"]["id"]

      {:ok, %{user_id: bot_id, username: bot_username}} =
        Cytale.Test.AgentGrants.mint_all(owner.user_id, :bot, run_unique("Roster Bot"))

      {:ok, %{user_id: agent_id, username: agent_username}} =
        Cytale.Test.AgentGrants.mint_all(owner.user_id, :agent, run_unique("Roster Agent"))

      # GET /workspaces/{id}/members — flat roster entries.
      listed = get(owner_conn, "/api/v1/workspaces/#{ws_id}/members")
      assert listed.status == 200
      roster = Jason.decode!(listed.resp_body)["members"]
      owner_str = Integer.to_string(owner.user_id)

      assert [
               %{"user_id" => ^owner_str, "kind" => "human"},
               %{
                 "user_id" => bot_str,
                 "kind" => "bot",
                 "parent_user_id" => ^owner_str,
                 "username" => ^bot_username,
                 "roles" => []
               },
               %{
                 "user_id" => agent_str,
                 # One internal kind (the UI's word for both is Agent).
                 "kind" => "bot",
                 "parent_user_id" => ^owner_str,
                 "username" => ^agent_username
               }
             ] = roster

      assert bot_str == Integer.to_string(bot_id)
      assert agent_str == Integer.to_string(agent_id)

      # GET /workspaces/{id} — the same attribution rides the show payload.
      shown = get(owner_conn, "/api/v1/workspaces/#{ws_id}")
      assert shown.status == 200
      show_members = Jason.decode!(shown.resp_body)["members"]

      bot_entry = Enum.find(show_members, &(&1["user"]["id"] == bot_str))
      assert bot_entry["kind"] == "bot"
      assert bot_entry["parent_user_id"] == owner_str

      human_entry = Enum.find(show_members, &(&1["user"]["id"] == owner_str))
      assert human_entry["kind"] == "human"
      refute Map.has_key?(human_entry, "parent_user_id")

      # Kicking a machine id is the member 404 — principals hold no member rows.
      kick = delete(owner_conn, "/api/v1/workspaces/#{ws_id}/members/#{bot_str}")
      assert kick.status == 404
    end
  end

  describe "auth gate" do
    test "unauthenticated request → 401 unauthorized envelope", %{conn: conn} do
      conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})

      assert conn.status == 401
      assert %{"error" => %{"key" => "unauthorized"}} = Jason.decode!(conn.resp_body)
    end

    test "garbage bearer token → 401", %{conn: conn} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer not-a-real-token")
        |> post("/api/v1/workspaces", %{"name" => run_unique("ws")})

      assert conn.status == 401
    end
  end

  describe "workspace lifecycle" do
    test "create → show → list mine → rename → delete (owner only)", %{conn: conn} do
      {conn, user} = register_and_login(conn)

      # Create
      name = run_unique("Test Workspace")
      conn = post(conn, "/api/v1/workspaces", %{"name" => name})
      assert conn.status == 201
      ws = Jason.decode!(conn.resp_body)["workspace"]
      assert ws["name"] == name
      assert ws["owner_id"] == Integer.to_string(user.user_id)
      assert ws["icon_url"] == nil
      ws_id = ws["id"]

      # Show (member view) — includes the creator as first member.
      conn = get(conn, "/api/v1/workspaces/#{ws_id}")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["workspace"]["id"] == ws_id
      assert [%{"user" => %{"id" => owner_id}}] = body["members"]
      assert owner_id == Integer.to_string(user.user_id)

      # List mine
      conn = get(conn, "/api/v1/users/@me/workspaces")
      assert conn.status == 200
      assert %{"workspaces" => list} = Jason.decode!(conn.resp_body)
      assert Enum.any?(list, &(&1["id"] == ws_id))

      # Rename
      new_name = run_unique("Renamed")
      conn = patch(conn, "/api/v1/workspaces/#{ws_id}", %{"name" => new_name})
      assert conn.status == 200
      assert %{"workspace" => %{"name" => ^new_name}} = Jason.decode!(conn.resp_body)

      # Delete by a NON-member → 404: the workspace does not exist for them
      # (Tier 3 B, 11). A member who is not the owner gets the 403 (covered in
      # workspace_delete_kick_test).
      {conn2, _user2} = register_and_login(build_conn_with_headers())
      conn2 = delete(conn2, "/api/v1/workspaces/#{ws_id}")
      assert conn2.status == 404

      # Delete by the owner → 200
      conn = delete(conn, "/api/v1/workspaces/#{ws_id}")
      assert conn.status == 200
      assert %{"deleted" => ^ws_id} = Jason.decode!(conn.resp_body)

      # Gone.
      conn = get(conn, "/api/v1/workspaces/#{ws_id}")
      assert conn.status == 404
    end

    test "invalid name → 400 validation_failed", %{conn: conn} do
      {conn, _user} = register_and_login(conn)
      conn = post(conn, "/api/v1/workspaces", %{"name" => "x"})
      assert conn.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
    end

    test "unknown workspace → 404 workspace_not_found", %{conn: conn} do
      {conn, _user} = register_and_login(conn)
      conn = get(conn, "/api/v1/workspaces/123456789012345678")
      assert conn.status == 404
      assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(conn.resp_body)
    end
  end

  describe "workspace icon (upload consolidation)" do
    test "admin uploads → icon_url set + carried on every workspace read; PATCH clears", %{conn: conn} do
      {owner_conn, _owner} = register_and_login(conn)

      ws_id =
        Jason.decode!(post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("icon ws")}).resp_body)["workspace"][
          "id"
        ]

      owner_conn = upload(owner_conn, "logo.png", "image/png", png_1x1())

      uploaded =
        post(owner_conn, "/api/v1/workspaces/#{ws_id}/icon", owner_conn.private[:plug_upload_body])

      assert uploaded.status == 201
      icon_url = Jason.decode!(uploaded.resp_body)["workspace"]["icon_url"]
      assert Regex.match?(~r|^/api/v1/attachments/[0-9a-f]{64}$|, icon_url)

      # Every workspace read carries it.
      shown = get(owner_conn, "/api/v1/workspaces/#{ws_id}")
      assert Jason.decode!(shown.resp_body)["workspace"]["icon_url"] == icon_url

      listed = get(owner_conn, "/api/v1/users/@me/workspaces")

      assert Enum.any?(
               Jason.decode!(listed.resp_body)["workspaces"],
               &(&1["id"] == ws_id and &1["icon_url"] == icon_url)
             )

      # The blob serves through the shared content-addressed path.
      hash = String.replace_prefix(icon_url, "/api/v1/attachments/", "")
      assert get(build_conn(), "/api/v1/attachments/#{hash}").status == 200

      # Explicit-clear PATCH; a non-empty icon_url is refused (uploads go
      # through the icon endpoint only).
      cleared = patch(owner_conn, "/api/v1/workspaces/#{ws_id}", %{"icon_url" => ""})
      assert cleared.status == 200
      assert Jason.decode!(cleared.resp_body)["workspace"]["icon_url"] == nil

      refused = patch(owner_conn, "/api/v1/workspaces/#{ws_id}", %{"icon_url" => "https://evil.example/x.png"})
      assert refused.status == 400

      # Rename alone still works (no icon key → unchanged, here stays nil).
      renamed = patch(owner_conn, "/api/v1/workspaces/#{ws_id}", %{"name" => run_unique("renamed")})
      assert renamed.status == 200
      assert Jason.decode!(renamed.resp_body)["workspace"]["icon_url"] == nil
    end

    test "non-admin member → 403; bad mime → 415; oversized → 413", %{conn: conn} do
      {owner_conn, owner} = register_and_login(conn)

      ws_id =
        Jason.decode!(post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("gate icon")}).resp_body)[
          "workspace"
        ]["id"]

      {:ok, joiner} = User.create(run_unique("icon_join"), run_unique("icon_join@example.com"), "password-123")
      :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), joiner.user_id, owner.user_id)
      joiner_access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

      joiner_conn =
        build_conn_with_headers()
        |> put_req_header("authorization", "Bearer " <> joiner_access)
        |> then(&upload(&1, "logo.png", "image/png", png_1x1()))

      forbidden =
        post(joiner_conn, "/api/v1/workspaces/#{ws_id}/icon", joiner_conn.private[:plug_upload_body])

      assert forbidden.status == 403

      bad_mime = upload(owner_conn, "doc.pdf", "application/pdf", "%PDF-1.4")
      bad_mime = post(bad_mime, "/api/v1/workspaces/#{ws_id}/icon", bad_mime.private[:plug_upload_body])
      assert bad_mime.status == 415

      too_big = upload(owner_conn, "big.png", "image/png", :binary.copy(<<0>>, 2 * 1024 * 1024 + 1))
      too_big = post(too_big, "/api/v1/workspaces/#{ws_id}/icon", too_big.private[:plug_upload_body])
      assert too_big.status == 413
    end

    test "roster + people payloads carry avatar_url", %{conn: conn} do
      {owner_conn, owner} = register_and_login(conn)

      ws_id =
        Jason.decode!(post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("avatar ws")}).resp_body)[
          "workspace"
        ]["id"]

      # Give the owner an avatar through the avatar endpoint.
      avatar_conn = upload(owner_conn, "me.png", "image/png", png_1x1())
      avatar_conn = post(avatar_conn, "/api/v1/users/@me/avatar", avatar_conn.private[:plug_upload_body])
      avatar_url = Jason.decode!(avatar_conn.resp_body)["user"]["avatar_url"]
      assert is_binary(avatar_url)

      # Flat members roster.
      roster = Jason.decode!(get(owner_conn, "/api/v1/workspaces/#{ws_id}/members").resp_body)
      owner_row = Enum.find(roster["members"], &(&1["user_id"] == Integer.to_string(owner.user_id)))
      assert owner_row["avatar_url"] == avatar_url

      # Show's nested member_json.
      shown = Jason.decode!(get(owner_conn, "/api/v1/workspaces/#{ws_id}").resp_body)
      assert [%{"user" => %{"avatar_url" => avatar_url}}] = shown["members"]

      # People directory.
      people = Jason.decode!(get(owner_conn, "/api/v1/workspaces/#{ws_id}/people").resp_body)
      assert [%{"user" => %{"avatar_url" => ^avatar_url}}] = people["people"]
    end
  end

  # -- helpers -------------------------------------------------------------------

  def build_conn_with_headers do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  def register_and_login(conn) do
    nonce = run_unique("")

    username = "u#{:erlang.phash2(nonce, 9_999_999)}#{System.system_time(:millisecond) |> rem(100_000)}"
    email = "#{username}@example.com"
    password = "password-123"

    # Register + verify (accounts stack directly — the verification REST flow
    # is U8's suite's job; here we need a verified, token-holding user).
    {:ok, user} = User.create(username, email, password)
    {:ok, raw, _hash} = Cytale.Accounts.Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    access = Auth.issue_access_token(user.user_id, user.username, true)

    conn = put_req_header(conn, "authorization", "Bearer " <> access)
    {conn, user}
  end

  test "workspace names are unique instance-wide, case-insensitively (owner direction 2026-09-15)", %{conn: _conn} do
    {conn, _user} = register_and_login(build_conn())
    name = run_unique("Unique WS")

    first = post(conn, "/api/v1/workspaces", %{"name" => name})
    assert first.status == 201

    # Same name, same case → taken.
    dup = post(conn, "/api/v1/workspaces", %{"name" => name})
    assert dup.status == 409
    assert %{"error" => %{"key" => "name_taken"}} = Jason.decode!(dup.resp_body)

    # Different case is still the same name.
    upcased = post(conn, "/api/v1/workspaces", %{"name" => String.upcase(name)})
    assert upcased.status == 409

    # A different name still goes through.
    other = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Other WS")})
    assert other.status == 201
  end

  # Hardening plan 4.11 / O2: the claim is instance-wide, so a RENAME has to
  # respect it too. Before this, PATCH renamed onto any name it liked — the
  # uniqueness rule held only at create.
  test "renaming onto a taken name is refused with 409 and leaves both workspaces alone",
       %{conn: _conn} do
    {conn, _user} = register_and_login(build_conn())
    src_name = run_unique("Rename Src")
    dst_name = run_unique("Rename Dst")

    created = post(conn, "/api/v1/workspaces", %{"name" => src_name})
    src_id = Jason.decode!(created.resp_body)["workspace"]["id"]

    assert post(conn, "/api/v1/workspaces", %{"name" => dst_name}).status == 201

    dup = patch(conn, "/api/v1/workspaces/#{src_id}", %{"name" => dst_name})
    assert dup.status == 409
    assert %{"error" => %{"key" => "name_taken"}} = Jason.decode!(dup.resp_body)

    # Refused before anything moved: the workspace keeps its name.
    shown = get(conn, "/api/v1/workspaces/#{src_id}")
    assert Jason.decode!(shown.resp_body)["workspace"]["name"] == src_name

    # A free name renames, and the ORIGINAL name is released rather than held
    # forever by a workspace that no longer answers to it.
    new_name = run_unique("Rename New")
    assert patch(conn, "/api/v1/workspaces/#{src_id}", %{"name" => new_name}).status == 200
    assert post(conn, "/api/v1/workspaces", %{"name" => src_name}).status == 201
  end

  # #111: creating a workspace GRANTS the creator a membership over REST. A
  # gateway session that identified before the workspace existed holds no
  # route for it (READY subscribed it to nothing here), so the create path
  # must poke the creator's live sessions to re-join their routes.
  test "creating a workspace pokes the creator's live sessions for a route refresh", %{conn: _conn} do
    {owner_conn, owner} = register_and_login(build_conn())

    # Stand-in for the creator's live gateway session: every READY'd session
    # implicitly holds its USER key (the channel_controller #55 test's device).
    :ok =
      Cytale.Gateway.PushRegistry.subscribe(
        Cytale.Gateway.PushRegistry.user_key(Integer.to_string(owner.user_id)),
        "creator-live-session"
      )

    conn_ws = post(owner_conn, "/api/v1/workspaces", %{"name" => run_unique("poke ws")})
    assert conn_ws.status == 201

    assert_receive :cytale_refresh_routes, 1_000
  end
end
