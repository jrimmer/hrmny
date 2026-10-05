defmodule CytaleWeb.ExternalUrl do
  @moduledoc """
  The ONE absolute-URL origin builder for externally-consumed links (C-5b):
  when the `cytale, :external_base_url` app env is set, that origin is used
  VERBATIM (a trailing slash trimmed so the join never doubles — behind a
  proxy with a different public origin the URL must be the one integrators
  can actually reach); otherwise the origin derives from the request
  (scheme + host + port, standard ports suppressed).

  Consumers: the webhook capability URLs (create/list/PATCH responses) and
  the attachment URLs embedded in Discord attachment objects minted by the
  multipart execute/create surfaces.
  """

  @doc "The configured origin verbatim, or the conn-derived origin."
  @spec origin(Plug.Conn.t()) :: String.t()
  def origin(conn) do
    case Cytale.Config.external_base_url() do
      nil ->
        scheme = to_string(conn.scheme)
        port_suffix = if standard_port?(scheme, conn.port), do: "", else: ":#{conn.port}"
        "#{scheme}://#{conn.host}#{port_suffix}"

      base ->
        # Verbatim origin; a path/schemeless base is operator error — the
        # gateway builder raises on the same misconfiguration.
        String.trim_trailing(base, "/")
    end
  end

  @doc "`origin/1` joined with `path` (path starts with a slash)."
  @spec build(Plug.Conn.t(), String.t()) :: String.t()
  def build(conn, path) when is_binary(path), do: origin(conn) <> path

  defp standard_port?("http", 80), do: true
  defp standard_port?("https", 443), do: true
  defp standard_port?(_, _), do: false
end
