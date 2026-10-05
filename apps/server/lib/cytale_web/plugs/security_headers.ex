defmodule CytaleWeb.Plugs.SecurityHeaders do
  @moduledoc """
  Endpoint-wide security headers (#35 P0-2). Mounted FIRST in the endpoint
  (before Plug.Static) so the SPA bundle, the API JSON, and attachment
  blobs all carry the same floor:

    * `x-content-type-options: nosniff` — a served blob is only ever its
      declared type (the MIME-confusion half of the SVG/inline chain).
    * `content-security-policy` — a same-origin script can only come from
      the app bundle, so a stored-XSS payload (an SVG or HTML blob smuggled
      onto the origin) cannot execute. `style-src 'unsafe-inline'` covers
      React's inline style attributes.
    * `x-frame-options: DENY` + `frame-ancestors 'none'` — no clickjacking.
    * `referrer-policy: no-referrer` — capability URLs (webhook tokens,
      attachment hashes) never leak through Referer.

  ## connect-src is DERIVED, not wildcarded (S8)

  The old policy said `connect-src 'self' ws: wss:` — the bare `ws:`/`wss:`
  wildcards admitted sockets to ANY host on ANY port, so one stored-XSS slip
  could exfiltrate to attacker infrastructure over websockets. The directive
  is now derived:

    * `'self'` always (same-origin gateway and fetches);
    * the external origin's `ws://host[:port]` and `wss://host[:port]` when
      `CYTALE_EXTERNAL_BASE_URL` is set — the Tauri shell loads
      `tauri://localhost`, so `'self'` does not cover the cross-origin
      gateway;
    * in dev, `ws://localhost:* wss://localhost:*` (a local gateway on an
      arbitrary port; config/dev.exs opts in).

  Every other directive is byte-identical to the pre-S8 policy.

  HSTS is the proxy's job (the Caddyfile owns it at the TLS edge).
  """

  @behaviour Plug

  import Plug.Conn

  # The directives BEFORE connect-src, byte-identical to the pre-S8 policy.
  @csp_head """
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

  # ...and the directives AFTER it, same discipline.
  @csp_tail """
            worker-src 'self' blob:; \
            manifest-src 'self'; \
            form-action 'self'\
            """
            |> String.replace("\n", "")

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    conn
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("x-frame-options", "DENY")
    |> put_resp_header("referrer-policy", "no-referrer")
    |> put_resp_header(
      "content-security-policy",
      @csp_head <> "connect-src " <> connect_src() <> "; " <> @csp_tail
    )
  end

  # The derived connect-src source list. The external half is read per call
  # (it is runtime config, set from the environment in runtime.exs — a module
  # attribute would freeze whatever the COMPILE machine had).
  defp connect_src do
    (["'self'"] ++ external_gateway_origins() ++ localhost_dev_origins())
    |> Enum.join(" ")
  end

  # The configured external origin over BOTH websocket schemes: a browser on
  # an https origin dials wss, the Tauri shell (tauri://localhost) dials
  # whichever the gateway advertises.
  defp external_gateway_origins do
    case Cytale.Config.external_base_url() do
      nil ->
        []

      base ->
        host = external_host(base)
        ["ws://#{host}", "wss://#{host}"]
    end
  end

  # A base without a host is operator error — the same posture ExternalUrl
  # and the gateway builder take. Fail loudly rather than ship a CSP that
  # silently cannot reach the gateway.
  defp external_host(base) do
    uri = URI.parse(base)

    cond do
      not (is_binary(uri.host) and uri.host != "") ->
        raise ArgumentError,
              "cytale :external_base_url must be an absolute origin with a host — got: #{inspect(base)}"

      # `URI.parse/1` FILLS the scheme's default port (https → 443), so a
      # bare `is_integer` test would pin `:443` onto every origin. Only an
      # explicit, non-default port rides along — a port-less source already
      # matches the scheme's default port.
      is_integer(uri.port) and uri.port != URI.default_port(uri.scheme) ->
        uri.host <> ":#{uri.port}"

      true ->
        uri.host
    end
  end

  defp localhost_dev_origins do
    if Cytale.Config.csp_localhost_ws_origins?(),
      do: ["ws://localhost:*", "wss://localhost:*"],
      else: []
  end
end
