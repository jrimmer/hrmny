defmodule CytaleWeb.Controllers.MediaKillSwitchIceTest do
  @moduledoc """
  Ticket #124 — the ICE/TURN mint gate: with `media.enabled` off,
  GET /api/v1/calls/ice refuses with the SPECIFIC `media_disabled` envelope
  (the registration_closed 403 precedent — not a generic forbidden), so no
  client can obtain relay credentials on a media-off instance. Default
  (true) serves the ICE config exactly as today; flipping back restores it
  live (the same in-process hot-apply the editor save performs).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  setup do
    saved = Application.get_env(:cytale, :media)

    on_exit(fn ->
      case saved do
        nil -> Application.delete_env(:cytale, :media)
        value -> Application.put_env(:cytale, :media, value)
      end
    end)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, user} =
      User.create("ice_" <> Cytale.TestNonce.get(), "ice-" <> Cytale.TestNonce.get() <> "@example.com", "password-123")

    access = Auth.issue_access_token(user.user_id, user.username, true)
    {:ok, conn: put_req_header(conn, "authorization", "Bearer " <> access)}
  end

  test "default (enabled): the ICE config serves as today", %{conn: conn} do
    assert %{status: 200} = resp = get(conn, "/api/v1/calls/ice")
    assert %{"ice_servers" => servers} = Jason.decode!(resp.resp_body)
    assert is_list(servers)
  end

  test "disabled: the mint refuses with the specific media_disabled envelope", %{conn: conn} do
    Application.put_env(:cytale, :media, enabled: false)

    conn = get(conn, "/api/v1/calls/ice")
    assert conn.status == 403

    assert %{"error" => %{"key" => "media_disabled", "code" => code, "message" => message}} =
             Jason.decode!(conn.resp_body)

    assert is_binary(message) and message != ""
    assert code == 40_301
  end

  test "re-enabling restores the mint live (same VM, no restart)", %{conn: conn} do
    Application.put_env(:cytale, :media, enabled: false)
    assert %{status: 403} = get(conn, "/api/v1/calls/ice")

    Application.put_env(:cytale, :media, enabled: true)
    assert %{status: 200} = get(conn, "/api/v1/calls/ice")
  end
end
