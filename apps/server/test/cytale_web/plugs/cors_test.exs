defmodule CytaleWeb.Plugs.CORSTest do
  @moduledoc """
  Desktop-shell CORS: the allowlist is exact-match and config-driven, actual
  requests get `Access-Control-Allow-Origin` plus a MERGED `Vary`, and
  preflights are answered before the router (a preflighted route must never
  404 on `OPTIONS`). The deployed web client is same-origin and never sees
  any of this.
  """

  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias CytaleWeb.Plugs.CORS

  @endpoint CytaleWeb.Endpoint
  @origin "tauri://localhost"

  setup do
    previous = Application.get_env(:cytale, :cors)
    Application.put_env(:cytale, :cors, allowed_origins: [@origin])

    on_exit(fn ->
      if previous,
        do: Application.put_env(:cytale, :cors, previous),
        else: Application.delete_env(:cytale, :cors)
    end)

    :ok
  end

  defp through_plug(conn) do
    conn
    |> CORS.call(CORS.init([]))
    |> send_resp(200, "ok")
  end

  defp through_endpoint(conn), do: CytaleWeb.Endpoint.call(conn, CytaleWeb.Endpoint.init([]))

  test "an allowed origin gets Access-Control-Allow-Origin and Vary on the response" do
    conn =
      Plug.Test.conn(:get, "/api/v1/users/@me")
      |> put_req_header("origin", @origin)
      |> through_plug()

    assert get_resp_header(conn, "access-control-allow-origin") == [@origin]
    assert get_resp_header(conn, "vary") == ["Origin"]
    # X-Request-Id is on this list for #88: the packaged shell must be able to
    # READ it off a failed call, or a desktop crash report is the one kind that
    # cannot be traced into the server logs.
    assert get_resp_header(conn, "access-control-expose-headers") == [
             "Content-Disposition, X-Request-Id"
           ]
  end

  test "a request with no origin, and unknown origins, get nothing" do
    bare = Plug.Test.conn(:get, "/api/v1/users/@me") |> through_plug()
    assert get_resp_header(bare, "access-control-allow-origin") == []
    assert get_resp_header(bare, "vary") == []

    unknown =
      Plug.Test.conn(:get, "/api/v1/users/@me")
      |> put_req_header("origin", "https://evil.example")
      |> through_plug()

    assert get_resp_header(unknown, "access-control-allow-origin") == []
  end

  test "the wildcard is never honored" do
    Application.put_env(:cytale, :cors, allowed_origins: ["*"])

    conn =
      Plug.Test.conn(:get, "/api/v1/users/@me")
      |> put_req_header("origin", "https://evil.example")
      |> through_plug()

    assert get_resp_header(conn, "access-control-allow-origin") == []
  end

  test "a preflight is answered 204 with the allowlists and halted" do
    conn =
      Plug.Test.conn(:options, "/api/v1/users/@me")
      |> put_req_header("origin", @origin)
      |> put_req_header("access-control-request-method", "GET")
      |> put_req_header("access-control-request-headers", "authorization")
      |> CORS.call(CORS.init([]))

    assert conn.status == 204
    assert conn.halted
    assert get_resp_header(conn, "access-control-allow-origin") == [@origin]

    [methods] = get_resp_header(conn, "access-control-allow-methods")
    assert methods =~ "GET"
    assert methods =~ "PATCH"

    [headers] = get_resp_header(conn, "access-control-allow-headers")
    assert headers =~ "Authorization"
    # Every api-client write carries Idempotency-Key; a preflight that does not
    # allow it fails the whole request in the webview.
    assert headers =~ "Idempotency-Key"

    assert get_resp_header(conn, "access-control-max-age") == ["600"]
    assert get_resp_header(conn, "vary") == ["Origin"]
  end

  test "Vary merges with an existing value instead of replacing it" do
    conn =
      Plug.Test.conn(:get, "/api/v1/users/@me")
      |> put_req_header("origin", @origin)
      |> put_resp_header("vary", "accept-encoding")
      |> through_plug()

    assert get_resp_header(conn, "vary") == ["accept-encoding, Origin"]
  end

  test "the mounted endpoint carries the headers on a real response" do
    conn =
      build_conn()
      |> put_req_header("origin", @origin)
      |> get("/health")

    assert conn.status == 200
    assert get_resp_header(conn, "access-control-allow-origin") == [@origin]
    assert get_resp_header(conn, "vary") == ["Origin"]
  end

  test "the mounted endpoint answers a preflight before the router" do
    conn =
      Plug.Test.conn(:options, "/api/v1/users/@me")
      |> put_req_header("origin", @origin)
      |> put_req_header("access-control-request-method", "POST")
      |> through_endpoint()

    assert conn.status == 204
    assert conn.halted
    assert get_resp_header(conn, "access-control-allow-origin") == [@origin]
  end
end
