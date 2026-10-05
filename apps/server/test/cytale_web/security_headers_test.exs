defmodule CytaleWeb.SecurityHeadersTest do
  @moduledoc """
  The endpoint-wide header floor (#35 P0-2): nosniff / CSP / frame-deny ride
  EVERY response — SPA assets, API JSON, and attachment blobs alike — so a
  stored blob can neither execute script on the origin nor be MIME-sniffed
  into doing so. Attachment disposition policy (vetted-inline-only) is
  asserted in the attachment controller suite.

  S8: `connect-src` is DERIVED — `'self'`, plus the configured external
  origin's websocket forms, plus the localhost forms in dev. The blanket
  `ws: wss:` wildcards this replaced admitted sockets to any host on any
  port; these tests pin their absence and the derivation's inputs.
  """

  use ExUnit.Case, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  @endpoint CytaleWeb.Endpoint

  # The directives that must NOT move (S8 keeps every non-connect-src
  # directive byte-identical) — the whole static allowlist, spelled out.
  @static_prefix """
                 default-src 'self'; \
                 base-uri 'self'; \
                 object-src 'none'; \
                 frame-ancestors 'none'; \
                 script-src 'self'; \
                 style-src 'self' 'unsafe-inline'; \
                 img-src 'self' data: blob:; \
                 media-src 'self' blob:; \
                 font-src 'self' data:; \
                 """
                 |> String.replace("\n", "")

  @static_tail """
               worker-src 'self' blob:; \
               manifest-src 'self'; \
               form-action 'self'\
               """
               |> String.replace("\n", "")

  setup do
    # connect-src reads runtime config; each test pins its inputs and the
    # module is async: false because this is process-global state.
    previous_base_url = Application.get_env(:cytale, :external_base_url)
    previous_headers = Application.get_env(:cytale, :security_headers)

    on_exit(fn ->
      Application.put_env(:cytale, :external_base_url, previous_base_url)
      Application.put_env(:cytale, :security_headers, previous_headers)
    end)

    :ok
  end

  test "API JSON responses carry the security header floor" do
    Application.put_env(:cytale, :external_base_url, nil)
    Application.delete_env(:cytale, :security_headers)

    conn = get(build_conn(), "/health")

    assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    assert get_resp_header(conn, "x-frame-options") == ["DENY"]
    assert get_resp_header(conn, "referrer-policy") == ["no-referrer"]

    # Byte-identical to the pre-S8 floor: only the connect-src VALUE changed.
    [csp] = get_resp_header(conn, "content-security-policy")
    assert csp == @static_prefix <> "connect-src 'self'; " <> @static_tail

    # The blanket wildcards must stay gone: any host, any port was the S8
    # hole. (`ws:` as a BARE source — `ws://host` sources are the derivation.)
    refute csp =~ ~r/ws:[\s;]/
    refute csp =~ ~r/wss:[\s;]/
  end

  test "unmatched API paths (the JSON error render) carry the same floor" do
    # A GET here would fall through to the SPA fallback's send_file (no
    # static dir in the test build); a POST unmatched route exercises the
    # error-JSON path instead.
    conn = post(build_conn(), "/api/v1/definitely-not-a-route")

    assert get_resp_header(conn, "x-content-type-options") == ["nosniff"]
    assert [_csp] = get_resp_header(conn, "content-security-policy")
  end

  test "a configured external origin adds BOTH websocket host forms" do
    Application.put_env(:cytale, :external_base_url, "https://chat.example.com")
    Application.delete_env(:cytale, :security_headers)

    [csp] = get_resp_header(conn = get(build_conn(), "/health"), "content-security-policy")

    # The Tauri shell loads tauri://localhost, so 'self' does not cover the
    # cross-origin gateway: its host joins over ws AND wss.
    assert csp =~ "connect-src 'self' ws://chat.example.com wss://chat.example.com"
    refute csp =~ "ws://chat.example.com:*"

    assert conn.status == 200
  end

  test "a non-standard port rides along on the websocket forms" do
    Application.put_env(:cytale, :external_base_url, "https://chat.example.com:8443")
    Application.delete_env(:cytale, :security_headers)

    [csp] = get_resp_header(get(build_conn(), "/health"), "content-security-policy")

    assert csp =~ "connect-src 'self' ws://chat.example.com:8443 wss://chat.example.com:8443"
  end

  test "the dev posture adds the localhost websocket forms" do
    Application.put_env(:cytale, :external_base_url, nil)
    Application.put_env(:cytale, :security_headers, localhost_ws_origins: true)

    [csp] = get_resp_header(get(build_conn(), "/health"), "content-security-policy")

    assert csp =~ "connect-src 'self' ws://localhost:* wss://localhost:*"

    # Still no blanket wildcard — `ws://localhost:*` is a scoped grant;
    # bare `ws:` was permission to dial the world.
    refute csp =~ ~r/ws:[\s;]/
    refute csp =~ ~r/wss:[\s;]/
  end
end
