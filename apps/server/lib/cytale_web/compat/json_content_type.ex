defmodule CytaleWeb.Compat.JsonContentType do
  @moduledoc """
  Compat responses carry EXACTLY `application/json` — no charset parameter.

  discord.py decides whether to parse a body as JSON by exact string
  comparison (`discord/http.py`: `response.headers['content-type'] ==
  'application/json'`), while Phoenix's default rendering appends
  `; charset=utf-8` (`Phoenix.Controller.json/2` →
  `put_resp_content_type/3`, whose charset default is `"utf-8"`). Every
  compat body then arrives as raw text and login dies in the user parser:
  `TypeError: string indices must be integers`. Discord itself sends the
  bare type, and `docs/protocol/compat.md` promises byte-compatibility
  "wherever a third-party library is watching" — the response header is one
  of those places.

  The rewrite rides `register_before_send/2` so it covers whatever wrote the
  header: the controllers' `json/2` AND `CytaleWeb.Compat.Errors`' explicit
  `put_resp_content_type/2`, i.e. success and error bodies alike. A response
  with NO content type (204s and other bodyless replies) is left untouched —
  this rewrites framing, it never invents a body type.
  """

  @behaviour Plug

  import Plug.Conn

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    register_before_send(conn, fn conn ->
      case get_resp_header(conn, "content-type") do
        [] -> conn
        _ -> put_resp_content_type(conn, "application/json", nil)
      end
    end)
  end
end
