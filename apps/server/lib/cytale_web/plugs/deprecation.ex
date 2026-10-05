defmodule CytaleWeb.Plugs.Deprecation do
  @moduledoc """
  U29 — REST deprecation headers (IETF `Deprecation` + `Sunset` drafts).

  A deprecated endpoint (or path prefix) is declared in config:

      config :cytale, :deprecated_routes,
        [
          {"/api/v1/example", sunset: ~U[2028-12-31 23:59:59Z]}
        ]

  * `Deprecation: version="v1"` — semantic version of the surface carrying
    the deprecated resource (the draft also allows `@<unix timestamp>`).
  * `Sunset: <HTTP-date>` — the removal date. The route keeps working until
    that date; removal happens at a major version boundary, never earlier.

  The registry is empty at launch (no deprecated surface exists yet); U9
  endpoints opt in by adding an entry, and the header machinery is exercised
  by `CytaleWeb.Plugs.DeprecationTest` so the first real deprecation cannot
  ship untested.
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case matching_deprecation(conn.path_info) do
      nil ->
        conn

      {api_version, sunset} ->
        conn
        |> put_resp_header("deprecation", ~s(version="#{api_version}"))
        |> put_resp_header("sunset", format_http_date(sunset))
    end
  end

  # Longest-prefix match: the most specific (longest) registered path wins.
  defp matching_deprecation(path_info) do
    path = "/" <> Enum.join(path_info, "/")

    case Enum.filter(Application.get_env(:cytale, :deprecated_routes, []), fn {prefix, _opts} ->
           String.starts_with?(path, prefix)
         end) do
      [] ->
        nil

      matches ->
        {prefix, opts} = Enum.max_by(matches, fn {p, _opts} -> String.length(p) end)
        _ = prefix
        {Keyword.get(opts, :api_version, "v1"), Keyword.fetch!(opts, :sunset)}
    end
  end

  defp format_http_date(%DateTime{} = dt) do
    dt
    |> DateTime.shift_zone!("Etc/UTC")
    |> Calendar.strftime("%a, %d %b %Y %H:%M:%S GMT")
  end
end
