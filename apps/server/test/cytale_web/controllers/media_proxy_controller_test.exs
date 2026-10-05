defmodule CytaleWeb.MediaProxyControllerTest do
  @moduledoc """
  `GET /api/v1/media/proxy` end to end through the router, against a local
  origin (`Cytale.MediaProxyStub`) — no database, no internet.
  """

  use ExUnit.Case, async: false

  import Phoenix.ConnTest

  alias Cytale.MediaProxy
  alias Cytale.MediaProxyStub, as: Stub

  @endpoint CytaleWeb.Endpoint

  setup do
    {:ok, Stub.start!()}
  end

  defp get_image(url), do: get(build_conn() |> Plug.Conn.put_req_header("accept", "image/avif,image/webp,*/*"), url)

  test "a signed URL serves the image with the safe headers; the second view is a cache hit", %{base: base} do
    Stub.route("/cat.png", {200, [{"content-type", "application/octet-stream"}], Stub.png()})
    proxied = MediaProxy.proxy_url(base <> "/cat.png")

    conn = get_image(proxied)
    assert conn.status == 200
    assert conn.resp_body == Stub.png()
    assert Plug.Conn.get_resp_header(conn, "content-type") == ["image/png"]
    assert Plug.Conn.get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    assert Plug.Conn.get_resp_header(conn, "content-disposition") == ["inline"]
    assert [cache] = Plug.Conn.get_resp_header(conn, "cache-control")
    assert cache =~ ~r/^private, max-age=\d+, immutable$/
    assert [csp] = Plug.Conn.get_resp_header(conn, "content-security-policy")
    assert csp =~ "sandbox"

    again = get_image(proxied)
    assert again.status == 200
    assert again.resp_body == Stub.png()
    assert Stub.hits("/cat.png") == 1
  end

  test "the proxy refuses anything it did not sign — before fetching", %{base: base} do
    Stub.route("/cat.png", {200, [], Stub.png()})
    url = base <> "/cat.png"
    %{"u" => u, "e" => e, "s" => s} = URI.decode_query(URI.parse(MediaProxy.proxy_url(url)).query)
    enc = Base.url_encode64(url, padding: false)

    for {path, code} <- [
          {"/api/v1/media/proxy?u=#{enc}", "media_url_invalid"},
          {"/api/v1/media/proxy?u=#{enc}&e=#{e}&s=forged", "media_url_invalid"},
          {"/api/v1/media/proxy?u=#{Base.url_encode64(base <> "/other.png", padding: false)}&e=#{e}&s=#{s}",
           "media_url_invalid"},
          {"/api/v1/media/proxy", "media_url_invalid"}
        ] do
      conn = get_image(path)
      assert conn.status == 403, path
      assert Jason.decode!(conn.resp_body)["error"]["key"] == code
    end

    # A genuine signature past its expiry.
    stale = MediaProxy.proxy_url(url, System.system_time(:second) - 3 * 86_400)
    conn = get_image(stale)
    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["error"]["key"] == "media_url_expired"

    assert Stub.hits("/cat.png") == 0
    assert u == enc
  end

  test "non-images are 415, private targets 404, origin failures 502", %{base: base} do
    Stub.route("/x.svg", {200, [{"content-type", "image/svg+xml"}], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"})
    Stub.route("/down.png", {500, [], "boom"})

    assert get_image(MediaProxy.proxy_url(base <> "/x.svg")).status == 415
    assert get_image(MediaProxy.proxy_url("http://private.test/cat.png")).status == 404
    assert get_image(MediaProxy.proxy_url(base <> "/down.png")).status == 502
  end

  test "off → 404, and nothing is minted", %{base: base} do
    saved = Application.get_env(:cytale, :media_proxy)
    proxied = MediaProxy.proxy_url(base <> "/cat.png")
    Application.put_env(:cytale, :media_proxy, Keyword.put(saved, :enabled, false))

    assert get_image(proxied).status == 404
    assert MediaProxy.proxy_url(base <> "/cat.png") == nil
  end
end
