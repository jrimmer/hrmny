defmodule CytaleWeb.Controllers.ChannelControllerTest do
  @moduledoc """
  U9 — channel surface integration tests: create/list/show/update/delete
  over the real pipeline. Workspace+channel setup rides the REST surface
  itself (the plan's happy-path chain).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, user} = register_and_login(conn)
    ws_id = create_workspace(conn)
    {:ok, conn: conn, user: user, ws_id: ws_id}
  end

  test "create → list → show → update → delete channel", %{conn: conn, ws_id: ws_id} do
    # Create
    name = run_unique("general")
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => name})
    assert conn.status == 201
    ch = Jason.decode!(conn.resp_body)["channel"]
    assert ch["name"] == name
    assert ch["type"] == 0
    ch_id = ch["id"]

    # List
    conn = get(conn, "/api/v1/workspaces/#{ws_id}/channels")
    assert conn.status == 200
    assert %{"channels" => list} = Jason.decode!(conn.resp_body)
    assert Enum.any?(list, &(&1["id"] == ch_id))

    # Show
    conn = get(conn, "/api/v1/channels/#{ch_id}")
    assert conn.status == 200
    assert %{"channel" => %{"id" => ^ch_id}} = Jason.decode!(conn.resp_body)

    # Update
    topic = run_unique("topic-")
    conn = patch(conn, "/api/v1/channels/#{ch_id}", %{"topic" => topic})
    assert conn.status == 200
    assert %{"channel" => %{"topic" => ^topic}} = Jason.decode!(conn.resp_body)

    # Delete
    conn = delete(conn, "/api/v1/channels/#{ch_id}")
    assert conn.status == 200
    conn = get(conn, "/api/v1/channels/#{ch_id}")
    assert conn.status == 404
  end

  test "PATCH is patch-semantic: absent keys survive, explicit null clears", %{
    conn: conn,
    ws_id: ws_id
  } do
    name = run_unique("partial")
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => name})
    ch_id = Jason.decode!(conn.resp_body)["channel"]["id"]

    # Move into a category with a body carrying ONLY parent_id — the name
    # and topic must survive (the live bug: a category move nulled the name).
    conn =
      post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{
        "name" => run_unique("cat"),
        "type" => "category"
      })

    cat_id = Jason.decode!(conn.resp_body)["channel"]["id"]
    conn = patch(conn, "/api/v1/channels/#{ch_id}", %{"parent_id" => cat_id})
    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)["channel"]
    assert body["name"] == name
    assert body["parent_id"] == cat_id

    # Explicit null clears the grouping; the name still survives.
    conn = patch(conn, "/api/v1/channels/#{ch_id}", %{"parent_id" => nil})
    body = Jason.decode!(conn.resp_body)["channel"]
    assert body["parent_id"] == nil
    assert body["name"] == name

    # Explicit null topic clears it (a documented clearing case).
    conn = patch(conn, "/api/v1/channels/#{ch_id}", %{"topic" => "x"})
    assert Jason.decode!(conn.resp_body)["channel"]["topic"] == "x"
    conn = patch(conn, "/api/v1/channels/#{ch_id}", %{"topic" => nil})
    body = Jason.decode!(conn.resp_body)["channel"]
    assert body["topic"] == nil
    assert body["name"] == name
  end

  test "category channel: type round-trips", %{conn: conn, ws_id: ws_id} do
    conn =
      post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{
        "name" => run_unique("Text Channels"),
        "type" => "category"
      })

    assert conn.status == 201
    assert %{"channel" => %{"type" => 1}} = Jason.decode!(conn.resp_body)
  end

  test "channel create in unknown workspace → 404", %{conn: conn} do
    conn = post(conn, "/api/v1/workspaces/123456789012345678/channels", %{"name" => "x"})
    assert conn.status == 404
    assert %{"error" => %{"key" => "workspace_not_found"}} = Jason.decode!(conn.resp_body)
  end

  # -- helpers -------------------------------------------------------------------

  test "the channel list names only channels the caller may VIEW (security tier 1 #6)", %{
    conn: owner,
    ws_id: ws_id
  } do
    open = Jason.decode!(post(owner, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("open")}).resp_body)

    hidden =
      Jason.decode!(post(owner, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("hidden")}).resp_body)

    {member, m} =
      register_and_login(
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
      )

    :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), m.user_id, 0, [])

    :ok =
      Cytale.Workspaces.put_overwrite(
        String.to_integer(hidden["channel"]["id"]),
        :member,
        m.user_id,
        0,
        Cytale.Permissions.Bitfield.bit(:view_channel)
      )

    resp = get(member, "/api/v1/workspaces/#{ws_id}/channels")
    assert resp.status == 200
    ids = Jason.decode!(resp.resp_body)["channels"] |> Enum.map(& &1["id"])
    assert open["channel"]["id"] in ids
    refute hidden["channel"]["id"] in ids
    refute resp.resp_body =~ hidden["channel"]["name"]

    # The owner still sees both.
    owner_ids =
      Jason.decode!(get(owner, "/api/v1/workspaces/#{ws_id}/channels").resp_body)["channels"] |> Enum.map(& &1["id"])

    assert hidden["channel"]["id"] in owner_ids
  end

  defp register_and_login(conn) do
    username =
      "u#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"

    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")

    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  # #55: creating a channel must POKE the workspace's live sessions.
  #
  # Routes are computed at Identify/Resume only, so a session that identified
  # before this channel existed never subscribes to its `{:channel, id}` key —
  # and every channel-keyed dispatch about it (a rename, a new thread) is then
  # addressed to nobody, viewer included. The poke is what re-joins them.
  #
  # The stand-in is the registry itself: its reads are liveness-filtered and
  # address-keyed, so this test process can hold a workspace route without a
  # socket (and without the gateway's test authenticator, whose stub identities
  # cannot also be a REST user).
  test "creating a channel pokes the workspace's live sessions for a route refresh", %{
    conn: conn,
    ws_id: ws_id
  } do
    :ok =
      Cytale.Gateway.PushRegistry.subscribe(
        Cytale.Gateway.PushRegistry.workspace_key(ws_id),
        "test-route-holder"
      )

    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("poked")})
    assert conn.status == 201

    assert_receive :cytale_refresh_routes, 1_000
  end
end
