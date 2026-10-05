defmodule CytaleWeb.API.Error do
  @moduledoc """
  The REST error envelope: one definition instead of a private copy in every
  controller (hardening plan 3.4 — thirty byte-identical `defp error/4`s).

  The body it writes is the wire contract every REST error has always had:

      %{"error" => %{"key" => key, "code" => status * 100 + 1, "message" => message}}

  with the HTTP status set on the connection. `code` is the stable,
  client-matchable spelling of the status (`404` → `40401`), which is why it is
  derived here rather than passed in: a caller that could pass it could pass a
  mismatched pair.
  """

  import Phoenix.Controller, only: [json: 2]
  import Plug.Conn

  @doc """
  Answer `conn` with the error envelope at `status`.

  The name is `error/4` rather than the plan's suggested `envelope/4` on purpose:
  the call sites already read `error(conn, status, key, message)` in 281 places,
  and importing this function under that name leaves every one of them untouched
  while deleting thirty definitions. `envelope/4` would have been a 281-line
  rename for no behavioural or structural gain — the opposite of what Batch 3 is
  for.
  """
  @spec error(Plug.Conn.t(), pos_integer(), String.t(), String.t()) :: Plug.Conn.t()
  def error(conn, status, key, message) do
    conn
    |> put_status(status)
    |> json(%{"error" => %{"key" => key, "code" => status * 100 + 1, "message" => message}})
  end

  # The envelope code for a 429: the same derivation as above (`status * 100
  # + 1`), so the per-account attempt dam's refusals read exactly like the
  # RateLimit plug's — clients keep ONE rate-limit match.
  @rate_limited_code 42_901

  @doc """
  The 429 rendering for the per-account attempt dam (audit S3): the same
  envelope + code + `retry-after` the `CytaleWeb.Plugs.RateLimit` refusal
  uses, with a message that claims no network scope — the dam is keyed by the
  ATTEMPTED identifier, which is deliberately not proof of whose account it
  is.
  """
  @spec rate_limited(Plug.Conn.t(), non_neg_integer()) :: Plug.Conn.t()
  def rate_limited(conn, retry_ms) do
    retry_s = max(1, div(retry_ms + 999, 1000))

    conn
    # `put_status(429)` is load-bearing, and it was MISSING: without it the
    # dam's refusal went out as `200 OK` with a 429-shaped body, so a client
    # that branches on the status read a locked-out brute-force attempt as a
    # success. The plug's own refusal (`RateLimitPlug.refuse/8`) has always
    # sent 429; this shared helper is the half that did not.
    |> put_status(429)
    |> put_resp_header("retry-after", Integer.to_string(retry_s))
    |> json(%{
      "error" => %{
        "key" => "rate_limited",
        "code" => @rate_limited_code,
        "message" => CytaleWeb.Compat.RateLimit.limit_message(:credentials, 0, 0, retry_ms)
      }
    })
    |> halt()
  end
end
