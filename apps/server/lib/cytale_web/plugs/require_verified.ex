defmodule CytaleWeb.Plugs.RequireVerified do
  @moduledoc """
  THE single server-side choke point for the view-only gate (U8): every
  content-producing mutation (message/thread create — U9/U11 wires it) flows
  through here, so "verified AND permitted" is enforced exactly once, never
  scattered across handlers.

  Unverified (or unauthenticated) accounts attempting a content mutation get
  HTTP 403 with the distinct machine key `account_unverified` in the standard
  error envelope.

  U9 note: this plug mounts on the content-mutation pipeline. U7 permission
  evaluation wraps in the SAME pipeline (the plan's `verified AND permitted`
  ordering: verification first — an unverified account must not learn
  permission state), then `RequirePermitted` (U9) evaluates U7.
  """

  @behaviour Plug

  import Plug.Conn

  @error_key "account_unverified"

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    # CYTALE_REQUIRE_VERIFIED=false lifts the gate entirely (deploys with no
    # working mailer) — including for already-issued unverified tokens.
    if Cytale.Config.require_verified_email?() do
      verify_gate(conn)
    else
      conn
    end
  end

  defp verify_gate(conn) do
    case current_user_claims(conn) do
      %{verified: true} ->
        conn

      %{verified: false} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(403, Jason.encode!(error_envelope()))
        |> halt()

      _ ->
        # Not authenticated at all — auth failure is a 401-class concern and
        # is owned by the RequireAuthenticated plug (U9). Here we treat the
        # absence of claims as unverified to fail closed.
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(403, Jason.encode!(error_envelope()))
        |> halt()
    end
  end

  # The authenticated-identity accessor U9 standardizes; reads the claims the
  # auth plug stashes on the conn. Direct helper delegation here so the key
  # and status live in exactly one module.
  defp current_user_claims(conn) do
    case conn.assigns[:current_user] do
      %{user_id: _, username: _, verified: _} = claims -> claims
      _ -> nil
    end
  end

  defp error_envelope do
    %{
      "error" => %{
        "key" => @error_key,
        "code" => 40_303,
        "message" =>
          "Your account is view-only until you complete email verification. Check your inbox for the verification link."
      }
    }
  end
end
