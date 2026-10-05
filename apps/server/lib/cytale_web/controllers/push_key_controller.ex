defmodule CytaleWeb.PushKeyController do
  @moduledoc """
  The VAPID public key, so a browser can subscribe (notifications plan U6).

  `pushManager.subscribe()` needs the server's public key as
  `applicationServerKey`, and it has to come from the server: the key belongs
  to the instance, and a client with a baked-in copy would subscribe against a
  key this deployment cannot sign with — producing a subscription that fails on
  every send, silently.

  ## Why this route is unauthenticated

  It is a PUBLIC key by construction; that is what makes it publishable. It
  authorizes nothing: it lets a browser ask the push service to create a
  subscription, and the server still decides what to send to it. Requiring a
  credential would only mean the subscribe flow fails on the day the credential
  expires.

  Returns 503 rather than an empty key when push is unconfigured, so a client
  can tell "this instance does not do push" apart from "the key is blank" —
  the first is a fact to render, the second would produce a broken
  subscription.
  """

  use CytaleWeb, :controller

  @doc "GET /api/v1/push/vapid-public-key"
  def show(conn, _params) do
    case public_key() do
      nil ->
        conn
        |> put_status(503)
        |> json(%{
          "error" => %{
            "key" => "push_unavailable",
            "code" => 50_301,
            "message" => "web push is not configured on this instance"
          }
        })

      key ->
        json(conn, %{"key" => key})
    end
  end

  # Absent keys mean push is off (see runtime.exs): the instance boots fine and
  # simply has nothing to offer here.
  defp public_key do
    :web_push_ex
    |> Application.get_env(:vapid, [])
    |> Keyword.get(:public_key)
  end
end
