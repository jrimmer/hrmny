defmodule CytaleWeb.PushKeyControllerTest do
  @moduledoc """
  notifications plan U6 — the VAPID public key route.

  The subscribe flow cannot start without this key, and it must come from the
  server: a client with a baked-in copy would subscribe against a key this
  deployment cannot sign with, producing a subscription that fails on every
  send with nothing to show for it.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest

  @endpoint CytaleWeb.Endpoint

  defp conn do
    build_conn() |> put_req_header("accept", "application/json")
  end

  test "serves the configured public key WITHOUT authentication" do
    # No authorization header: the key is public by construction, and gating it
    # would only mean the subscribe flow breaks when a credential expires.
    conn = get(conn(), "/api/v1/push/vapid-public-key")

    assert conn.status == 200
    assert %{"key" => key} = Jason.decode!(conn.resp_body)
    assert is_binary(key)
    assert key != ""
    # A base64url-encoded uncompressed P-256 point decodes to 65 bytes. A key
    # of the wrong shape would produce a subscription the push service rejects.
    assert byte_size(Base.url_decode64!(key, padding: false)) == 65
  end

  test "503 when push is unconfigured, rather than a blank key" do
    previous = Application.get_env(:web_push_ex, :vapid)
    Application.put_env(:web_push_ex, :vapid, [])

    on_exit(fn -> Application.put_env(:web_push_ex, :vapid, previous) end)

    conn = get(conn(), "/api/v1/push/vapid-public-key")

    assert conn.status == 503
    assert %{"error" => %{"key" => "push_unavailable"}} = Jason.decode!(conn.resp_body)
  end
end
