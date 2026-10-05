defmodule CytaleWeb.Compat.GatewayController do
  @moduledoc """
  GET /api/v10/gateway/bot (+ the bare /api alias) — the Discord library
  bootstrap route (bots plan U6): where a bot client points its websocket
  before IDENTIFY. Answers with the shared compat gateway URL
  (`wss://<host>[:<port>]/gateway/websocket?v=10&encoding=json` — built by
  `CytaleWeb.Compat.GatewayUrl`, the SAME builder the compat READY's
  `resume_gateway_url` uses, so the two can never drift), one shard, and a
  generous static session-start budget — the real session cap (8 concurrent
  per principal) is enforced at Identify (U7), not here.
  """

  use CytaleWeb, :controller

  alias CytaleWeb.Compat.GatewayUrl

  @doc "GET /gateway/bot — gateway bootstrap metadata."
  def show(conn, _params) do
    json(conn, %{
      "url" => GatewayUrl.websocket_url(conn),
      "shards" => 1,
      "session_start_limit" => %{
        "total" => 1_000,
        "remaining" => 999,
        "reset_after" => 14_400_000,
        "max_concurrency" => 1
      }
    })
  end
end
