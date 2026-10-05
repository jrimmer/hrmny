defmodule CytaleWeb.Plugs.CORS do
  @moduledoc """
  Config-gated CORS for first-party clients served from another origin
  (`Cytale.Config.cors_allowed_origins/0` — the Tauri desktop shells).

  The deployed web client never triggers this: the endpoint serves the SPA,
  REST and gateway from one origin, so no browser preflight ever happens and
  responses need no `Access-Control-Allow-Origin`. The desktop shell does —
  it loads the SPA from `tauri://localhost` / `http://tauri.localhost` and
  calls the API cross-origin.

  Two behaviors, both driven by an exact-match allowlist (`"*"` is never
  honored):

    * actual requests — `Access-Control-Allow-Origin: <origin>` plus
      `Vary: Origin` are attached in a `before_send` callback, so the header
      lands on whatever the downstream router/controller produced;
    * preflight (`OPTIONS` + `Access-Control-Request-Method`) — answered
      here with `204`, the method/header allowlists, and a max-age, and
      halted before the router (a preflighted route must never 404 on
      `OPTIONS`).

  `Vary` is MERGED, not replaced: `Plug.Static` sets `Vary: accept-encoding`
  for its gzip variant, and losing it would poison shared caches.
  """

  @behaviour Plug

  import Plug.Conn

  @allow_methods "GET, POST, PUT, PATCH, DELETE, OPTIONS"
  # Idempotency-Key is on every api-client write (POST /messages et al) — a
  # header missing here fails the preflight and the browser reports the whole
  # request as a network error, which is how the packaged shell lost sends.
  @allow_headers "Authorization, Content-Type, Idempotency-Key"
  # Content-Disposition: attachment downloads read its filename.
  # X-Request-Id (#88): the cross-origin shell must be able to READ the
  # request id off a failed call, or a desktop crash report would be the one
  # kind that cannot be traced into the server logs — a header that is set but
  # not EXPOSED is invisible to JS under CORS. Same-origin web needs neither
  # list; this is purely for the packaged clients.
  @expose_headers "Content-Disposition, X-Request-Id"
  @max_age "600"

  @impl true
  def init(_opts), do: :ok

  @impl true
  def call(conn, _opts) do
    origin = conn |> get_req_header("origin") |> List.first()
    allowed = Cytale.Config.cors_allowed_origins()

    cond do
      is_nil(origin) or origin not in allowed ->
        conn

      preflight?(conn) ->
        conn
        |> put_resp_header("access-control-allow-origin", origin)
        |> put_resp_header("access-control-allow-methods", @allow_methods)
        |> put_resp_header("access-control-allow-headers", @allow_headers)
        |> put_resp_header("access-control-max-age", @max_age)
        |> merge_vary("Origin")
        |> send_resp(204, "")
        |> halt()

      true ->
        register_before_send(conn, fn conn ->
          conn
          |> put_resp_header("access-control-allow-origin", origin)
          |> put_resp_header("access-control-expose-headers", @expose_headers)
          |> merge_vary("Origin")
        end)
    end
  end

  defp preflight?(conn) do
    conn.method == "OPTIONS" and get_req_header(conn, "access-control-request-method") != []
  end

  defp merge_vary(conn, value) do
    existing =
      conn
      |> get_resp_header("vary")
      |> Enum.flat_map(&String.split(&1, ",", trim: true))
      |> Enum.map(&String.trim/1)

    if Enum.any?(existing, &(String.downcase(&1) == String.downcase(value))) do
      conn
    else
      put_resp_header(conn, "vary", Enum.join(existing ++ [value], ", "))
    end
  end
end
