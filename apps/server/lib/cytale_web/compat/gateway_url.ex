defmodule CytaleWeb.Compat.GatewayUrl do
  @moduledoc """
  The ONE compat websocket-URL builder (maint-004): `/gateway/bot`'s `url`
  and the compat READY's `resume_gateway_url` must agree byte-for-byte, so
  the scheme mapping (`https → wss`, `http → ws` — Discord's contract serves
  a WEBSOCKET url; libraries hand it straight to a WS client), host/port
  normalization, and the `?v=10&encoding=json` suffix live here and nowhere
  else.

  When the `cytale, :external_base_url` app env is set (C-5b), its origin
  replaces the conn-derived one: the builder consumes the configured
  scheme/host/port VERBATIM (the websocket scheme mapping and the query
  suffix still apply) — a deployment behind a proxy with a different public
  origin advertises that origin regardless of the request's headers.
  """

  @gateway_path "/gateway/websocket"
  @query "?v=10&encoding=json"

  @doc """
  The full bootstrap/resume URL for a request's origin:
  `ws(s)://<host>[:<port>]#{@gateway_path}#{@query}`. The port is omitted on
  the scheme's default port (80/443) and whenever the host already carries
  one (IPv6 literals). `cytale, :external_base_url` (when set) supplies the
  origin instead of the conn's.
  """
  @spec websocket_url(Plug.Conn.t()) :: String.t()
  def websocket_url(conn) do
    case Cytale.Config.external_base_url() do
      nil -> ws_url(conn.scheme, conn.host, conn.port)
      base -> base_ws_url(base)
    end
  end

  @doc "The URL from raw parts (the gateway socket keeps the upgrade request's scheme/host/port)."
  @spec ws_url(:http | :https, String.t() | nil, :inet.port_number()) :: String.t()
  def ws_url(scheme, host, port) do
    host = host || "localhost"

    host =
      if is_integer(port) and port != default_port(scheme) and not String.contains?(host, ":") do
        "#{host}:#{port}"
      else
        host
      end

    # Discord's contract: map the request scheme onto its websocket
    # counterpart (http → ws, https → wss) — never hand back http(s).
    ws_scheme = if scheme == :https, do: "wss", else: "ws"
    "#{ws_scheme}://#{host}#{@gateway_path}#{@query}"
  end

  # The configured origin replaces the conn's — scheme/host/port verbatim,
  # then the same ws mapping + suffix as the conn-derived path.
  defp base_ws_url(base) when is_binary(base) do
    uri = URI.parse(base)

    unless is_binary(uri.scheme) and is_binary(uri.host) and uri.host != "" do
      raise ArgumentError,
            "cytale :external_base_url must be an absolute origin " <>
              "(e.g. https://chat.example.com) — got: #{inspect(base)}"
    end

    ws_url(String.to_existing_atom(uri.scheme), uri.host, uri.port)
  end

  defp default_port(:https), do: 443
  defp default_port(_), do: 80
end
