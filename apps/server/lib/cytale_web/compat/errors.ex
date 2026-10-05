defmodule CytaleWeb.Compat.Errors do
  @moduledoc """
  Discord-shaped error rendering for the compat surface (bots plan U6, R7 /
  KTD10): every failure renders a bare `{\"code\": <int>, \"message\": <text>}`
  object with Discord's numeric codes, mapped from the native envelope per
  the documented table (docs/protocol/compat.md):

      native                     HTTP   Discord code   message
      -------------------------  -----  -------------  ------------------------
      401 unauthorized            401   0              401: Unauthorized
      403 forbidden                403   50001          Missing Permissions
      404 channel_not_found *      404   10003          Unknown Channel
      404 message_not_found        404   10008          Unknown Message
      400 ack_consumed **          400   10063          Unknown interaction
      400 validation_failed        400   50035          Invalid Form Body
      429 rate_limited             429   0              + retry_after/global
                                                 (rendered by the RateLimit plug)

  ** a REPLAYED interaction ack (C-1): the type-4 response is single-use,
  so a second one on the same token renders Discord's UNKNOWN_INTERACTION
  shape (the interaction "no longer accepts" an ack from that token's
  perspective).

  * every channel-gate miss — missing row, non-member parent, out-of-profile
  restrictions, no VIEW_CHANNEL — renders the IDENTICAL 10003 body:
  anti-enumeration, the same shape for missing and forbidden.
  """

  import Plug.Conn

  @doc "401 → code 0."
  @spec unauthorized(Plug.Conn.t()) :: Plug.Conn.t()
  def unauthorized(conn), do: render(conn, 401, 0, "401: Unauthorized")

  @doc "403 → 50001 Missing Permissions."
  @spec missing_permissions(Plug.Conn.t()) :: Plug.Conn.t()
  def missing_permissions(conn), do: render(conn, 403, 50_001, "Missing Permissions")

  @doc "404 → 10003 Unknown Channel (the anti-enumeration shape)."
  @spec unknown_channel(Plug.Conn.t()) :: Plug.Conn.t()
  def unknown_channel(conn), do: render(conn, 404, 10_003, "Unknown Channel")

  @doc """
  404 → 10004 Unknown Guild. The thread-DISCOVERY route is guild-scoped (#74),
  and answering it with the channel code would tell a client its guild id was a
  channel id.
  """
  @spec unknown_guild(Plug.Conn.t()) :: Plug.Conn.t()
  def unknown_guild(conn), do: render(conn, 404, 10_004, "Unknown Guild")

  @doc "404 → 10008 Unknown Message."
  @spec unknown_message(Plug.Conn.t()) :: Plug.Conn.t()
  def unknown_message(conn), do: render(conn, 404, 10_008, "Unknown Message")

  @doc """
  404 → 10002 Unknown Application (bots plan U8): the applications surface's
  anti-oracle — a foreign `{bot_id}` in the path renders identically to an
  unknown one.
  """
  @spec unknown_application(Plug.Conn.t()) :: Plug.Conn.t()
  def unknown_application(conn), do: render(conn, 404, 10_002, "Unknown Application")

  @doc "400 → 50035 Invalid Form Body."
  @spec invalid_form_body(Plug.Conn.t()) :: Plug.Conn.t()
  def invalid_form_body(conn), do: render(conn, 400, 50_035, "Invalid Form Body")

  @doc """
  400 → 50035 with Discord's FIELD-LEVEL detail (#155): real Discord's
  Invalid Form Body names the offending field — `{"code": 50035, "message":
  "Invalid Form Body", "errors": {field: {"_errors": [{code, message}]}}}` —
  and without it a stock client (discord.py) can only show the bare code,
  which is what made the thread-reply rejection near-undiagnosable. `field`
  is the wire field name (`"embeds"`, `"components"`, …); `detail` is the
  human message inside `_errors`.
  """
  @spec invalid_form_body(Plug.Conn.t(), String.t(), String.t()) :: Plug.Conn.t()
  def invalid_form_body(conn, field, detail)
      when is_binary(field) and is_binary(detail) do
    body = %{
      "code" => 50_035,
      "message" => "Invalid Form Body",
      "errors" => %{
        field => %{"_errors" => [%{"code" => "INVALID_FORM_BODY", "message" => detail}]}
      }
    }

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(400, Jason.encode!(body))
  end

  @doc """
  400 → 10063 Unknown interaction (C-1): the single-use interaction ACK was
  already consumed — Discord's replayed-ack shape.
  """
  @spec unknown_interaction(Plug.Conn.t()) :: Plug.Conn.t()
  def unknown_interaction(conn), do: render(conn, 400, 10_063, "Unknown interaction")

  @doc "404 → Discord's bare route-level shape (code 0)."
  @spec not_found(Plug.Conn.t()) :: Plug.Conn.t()
  def not_found(conn), do: render(conn, 404, 0, "404: Not Found")

  @doc "Render the bare Discord error object `{code, message}`."
  @spec render(Plug.Conn.t(), pos_integer(), integer(), String.t()) :: Plug.Conn.t()
  def render(conn, status, code, message) when is_binary(message) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(status, Jason.encode!(%{"code" => code, "message" => message}))
  end
end
