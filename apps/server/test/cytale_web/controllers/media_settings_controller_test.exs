defmodule CytaleWeb.Controllers.MediaSettingsControllerTest do
  @moduledoc """
  Calls V2 plan U8 (R16/R17) — the media-settings REST surface:

    * GET/PUT /workspaces/{id}/media-settings — owner/admin tier (the
      can_manage_workspace pipeline, exactly PATCH /workspaces/{id}'s);
      plain members 403, non-members keep the 404 oracle.
    * GET/PUT /channels/{id}/media-override — manage-channels tier through
      the UNIFORM channel gate: foreign channels render the identical 404
      anti-enumeration shape, DM channels 404 (no override surface), a
      viewing member without the bit gets the real 403, and a PUT against
      an overrides-disallowed workspace is the 409 `overrides_not_allowed`
      state conflict.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, owner} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    {:ok, conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id}
  end

  defp register_and_login(conn) do
    {:ok, user} = User.create(run_unique("ms_user"), run_unique("ms@example.com"), "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Media WS")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  # A second member joined via the invite surface (the REST-shaped path a
  # non-owner human takes).
  defp member_conn(ctx) do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, user} = register_and_login(conn)

    invite = post(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/invites", %{})
    assert invite.status == 201
    code = Jason.decode!(invite.resp_body)["invite"]["code"]

    joined = post(conn, "/api/v1/invites/#{code}", %{})
    assert joined.status in [200, 201]

    {conn, user}
  end

  # -- workspace master settings ---------------------------------------------------

  test "GET renders the defaults before any write", %{conn: conn, ws_id: ws_id} do
    conn = get(conn, "/api/v1/workspaces/#{ws_id}/media-settings")
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) == %{
             "media_settings" => %{
               "calls" => true,
               "video" => true,
               "screenshare" => true,
               "overrides_allowed" => false
             }
           }
  end

  test "owner PUT round-trips and echoes the merged settings", %{conn: conn, ws_id: ws_id} do
    conn = put(conn, "/api/v1/workspaces/#{ws_id}/media-settings", %{"video" => false})
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body)["media_settings"] == %{
             "calls" => true,
             "video" => false,
             "screenshare" => true,
             "overrides_allowed" => false
           }

    conn = get(conn, "/api/v1/workspaces/#{ws_id}/media-settings")
    assert Jason.decode!(conn.resp_body)["media_settings"]["video"] == false
  end

  test "PUT with a non-boolean value is a 400 validation failure", %{conn: conn, ws_id: ws_id} do
    conn = put(conn, "/api/v1/workspaces/#{ws_id}/media-settings", %{"calls" => "yes"})
    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
  end

  test "non-admin member: GET/PUT 403 (the pipeline's forbidden envelope)", ctx do
    {member_conn, _member} = member_conn(ctx)

    conn = get(member_conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings")
    assert conn.status == 403
    assert %{"error" => %{"key" => "forbidden"}} = Jason.decode!(conn.resp_body)

    conn = put(member_conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"video" => false})
    assert conn.status == 403
    assert %{"error" => %{"key" => "forbidden"}} = Jason.decode!(conn.resp_body)
  end

  test "unknown workspace keeps the 404 oracle on the settings routes", %{conn: conn} do
    bogus = "9" |> String.duplicate(18)

    conn = get(conn, "/api/v1/workspaces/#{bogus}/media-settings")
    assert conn.status == 404

    conn = put(conn, "/api/v1/workspaces/#{bogus}/media-settings", %{"video" => false})
    assert conn.status == 404
  end

  # -- channel overrides -----------------------------------------------------------

  test "owner GET: all-null override + master + overrides_allowed", ctx do
    conn = get(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override")
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body) == %{
             "override" => %{"calls" => nil, "video" => nil, "screenshare" => nil},
             "overrides_allowed" => false,
             "master" => %{
               "calls" => true,
               "video" => true,
               "screenshare" => true,
               "overrides_allowed" => false
             }
           }
  end

  test "PUT rejected 409 while overrides are disallowed; allowed after the flag flips", ctx do
    conn = put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"video" => false})
    assert conn.status == 409

    assert %{"error" => %{"key" => "overrides_not_allowed"}} = Jason.decode!(conn.resp_body)

    # Flip the master flag, retry: the same PUT lands.
    conn = put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => true})
    assert conn.status == 200

    conn = put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"video" => false})
    assert conn.status == 200

    body = Jason.decode!(conn.resp_body)
    assert body["override"]["video"] == false
    assert body["overrides_allowed"] == true
    assert body["master"]["overrides_allowed"] == true
  end

  test "explicit null resets that capability to inherit (tri-state wire)", ctx do
    put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => true})
    put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"calls" => false, "video" => true})

    conn = put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"calls" => nil})
    assert conn.status == 200

    body = Jason.decode!(conn.resp_body)
    assert body["override"]["calls"] == nil
    assert body["override"]["video"] == true
  end

  test "plain member: GET/PUT the override surface is the real 403", ctx do
    {member_conn, _member} = member_conn(ctx)
    put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => true})

    conn = get(member_conn, "/api/v1/channels/#{ctx.ch_id}/media-override")
    assert conn.status == 403
    assert %{"error" => %{"key" => "forbidden"}} = Jason.decode!(conn.resp_body)

    conn = put(member_conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"video" => false})
    assert conn.status == 403
  end

  test "foreign channel: the identical 404 channel_not_found (anti-enumeration)", ctx do
    {foreign_conn, _foreign} =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> register_and_login()

    conn = get(foreign_conn, "/api/v1/channels/#{ctx.ch_id}/media-override")
    assert conn.status == 404
    assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn.resp_body)

    conn = put(foreign_conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"video" => false})
    assert conn.status == 404
    assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn.resp_body)
  end

  test "unknown channel id: the same 404", %{conn: conn} do
    bogus = "8" |> String.duplicate(18)

    conn = get(conn, "/api/v1/channels/#{bogus}/media-override")
    assert conn.status == 404
  end

  test "DM channel: no override surface — the uniform 404", %{conn: conn, owner: owner} do
    {_other_conn, other} =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> register_and_login()

    {:ok, dm} = Cytale.Workspaces.open_dm(owner.user_id, other.user_id)

    conn2 = get(conn, "/api/v1/channels/#{dm.channel_id}/media-override")
    assert conn2.status == 404
    assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn2.resp_body)

    conn3 = put(conn, "/api/v1/channels/#{dm.channel_id}/media-override", %{"video" => false})
    assert conn3.status == 404
  end

  test "PUT with a non-tri-state value is a 400 validation failure", ctx do
    put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => true})

    conn = put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"screenshare" => "off"})
    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
  end

  # -- the call REST capabilities field (R17) --------------------------------------

  describe "call REST capabilities" do
    test "GET /channels/{id}/call carries effective capabilities", ctx do
      conn = get(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/call")
      assert conn.status == 200

      assert Jason.decode!(conn.resp_body)["capabilities"] == %{
               "calls" => true,
               "video" => true,
               "screenshare" => true,
               "start" => true
             }

      # Master off → capabilities reflect it.
      put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"screenshare" => false})

      conn = get(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/call")
      assert Jason.decode!(conn.resp_body)["capabilities"]["screenshare"] == false

      # Overrides allowed + channel flips video → effective for the reader.
      put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => true})
      put(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/media-override", %{"video" => false})

      conn = get(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/call")
      assert Jason.decode!(conn.resp_body)["capabilities"]["video"] == false

      # Overrides disallowed again → the row goes inert, master everywhere.
      put(ctx.conn, "/api/v1/workspaces/#{ctx.ws_id}/media-settings", %{"overrides_allowed" => false})

      conn = get(ctx.conn, "/api/v1/channels/#{ctx.ch_id}/call")
      assert Jason.decode!(conn.resp_body)["capabilities"]["video"] == true
    end

    test "DM call REST: capabilities all true (DM calls skip the checks)", %{conn: conn, owner: owner} do
      {_other_conn, other} =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> register_and_login()

      {:ok, dm} = Cytale.Workspaces.open_dm(owner.user_id, other.user_id)

      conn2 = get(conn, "/api/v1/channels/#{dm.channel_id}/call")
      assert conn2.status == 200

      assert Jason.decode!(conn2.resp_body)["capabilities"] == %{
               "calls" => true,
               "video" => true,
               "screenshare" => true,
               "start" => true
             }
    end
  end
end
