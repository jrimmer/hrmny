defmodule CytaleWeb.OIDCController do
  @moduledoc """
  The instance OIDC federated sign-in surface (ticket #12) — the two pre-auth
  routes under `/api/v1/auth`, riding the SAME per-IP `:auth` rate-limit dam
  as the password/passkey surface (both mint session tokens, so both stay
  deliberate).

    * `POST /auth/oidc/start` `{return_to?}` — mint the ceremony, return the
      provider's authorize URL. The deliberate non-happy states: `403
      oidc_disabled` when the surface is off (the login page's honest-absence
      posture — the button does not render, a direct caller is refused) and
      `502 oidc_provider_unavailable` when discovery cannot answer (the user
      is told the provider is down, not that their account failed).
    * `POST /auth/oidc/callback` `{code, state}` — exchange, validate, resolve
      (see `Cytale.OIDC`), then mint the EXACT token pair `POST /auth/login`
      returns (same keys, same claims, same refresh rotation downstream) plus
      one additive key: `return_to`, the sanitized signed-out continuation the
      start carried, for the SPA to restore (#114's pending-route seam).

  THE UNIFORM REFUSAL: every ceremony failure of the callback — unknown or
  replayed state, provider unreachable mid-exchange, bad signature, nonce or
  audience mismatch, expired token, unverified email, closed registration, no
  account — is the SAME `401 invalid_credentials` as the password path's wrong
  password. A failed login must not distinguish "no account" from "bad token",
  and the distinct server-side log lines are where operators look, not
  attackers. Only a structurally malformed request (missing code/state) is a
  `400 validation_failed`, mirroring the WebAuthn controller's split.

  Two deliberate non-uniform answers:

    * `409 oidc_link_required` — the verified provider email matches a local
      account that never verified that address itself; it is NOT auto-linked
      (see `Cytale.OIDC`). The caller already proved control of the address
      at the provider, so naming the next step leaks nothing new.
    * `200 {status: "totp_pending", grant, user, return_to}` — the matched
      account has a confirmed TOTP enrollment and the 2FA switch is on: the
      SAME challenge step the password login returns.
  """

  use CytaleWeb, :controller

  require Logger

  alias Cytale.Accounts.{Auth, TwoFactor}
  alias Cytale.Accounts.TwoFactor.Grants
  import CytaleWeb.API.Error, only: [error: 4]

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/oidc/start
  # ---------------------------------------------------------------------------

  def start(conn, params) do
    case Cytale.OIDC.start_ceremony(conn, params["return_to"]) do
      {:ok, authorize_url} ->
        json(conn, %{"authorize_url" => authorize_url})

      {:error, :disabled} ->
        error(conn, 403, "oidc_disabled", "SSO sign-in is disabled on this server")

      {:error, _provider_unavailable} ->
        error(conn, 502, "oidc_provider_unavailable", "The sign-in provider could not be reached. Try again shortly.")
    end
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/oidc/callback
  # ---------------------------------------------------------------------------

  def callback(conn, %{"code" => code, "state" => state})
      when is_binary(code) and is_binary(state) do
    case Cytale.OIDC.finish_ceremony(code, state) do
      {:ok, user, return_to} ->
        # The provider proves the address, not the account's own second
        # factor: an account with a CONFIRMED TOTP enrollment owes the SAME
        # challenge step the password login does (while the switch is on) —
        # otherwise SSO is a way around the code the owner chose to require.
        if TwoFactor.enabled?() and TwoFactor.enrolled?(user.user_id) do
          totp_step(conn, user, return_to)
        else
          token_pair(conn, user, return_to)
        end

      {:error, :link_required} ->
        Logger.warning("oidc callback: sign-in refused (:link_required)")

        error(
          conn,
          409,
          "oidc_link_required",
          "An account with this email already exists, but its email address was never verified. " <>
            "Sign in with your password and verify your email address; SSO sign-in will then work for that account."
        )

      {:error, reason} ->
        Logger.warning("oidc callback: sign-in refused (#{inspect(reason)})")
        refused(conn)
    end
  end

  def callback(conn, _params),
    do: error(conn, 400, "validation_failed", "code and state are required")

  # The AuthController.login response, byte-for-byte in shape, plus the
  # continuation seam. The gateway's Identify path sees an ordinary
  # freshly-minted pair — nothing here names the provider.
  defp token_pair(conn, user, return_to) do
    verified = Cytale.Config.effective_verified?(not is_nil(user.email_verified_at))
    access = Auth.issue_access_token(user.user_id, user.username, verified)
    {:ok, refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)

    json(conn, %{
      "user" => user_payload(user),
      "access_token" => access,
      "refresh_token" => refresh,
      "token_type" => "Bearer",
      "expires_in" => div(Cytale.Config.access_token_ttl_ms(), 1000),
      "email_verified" => Cytale.Config.effective_verified?(not is_nil(user.email_verified_at)),
      "return_to" => return_to
    })
  end

  # The password login's `totp_pending` shape exactly (status + opaque `:totp`
  # grant + the reduced step identity), plus the continuation seam. The
  # client spends the grant at POST /auth/2fa/verify like any other.
  defp totp_step(conn, user, return_to) do
    json(conn, %{
      "status" => "totp_pending",
      "grant" => Grants.put(:totp, user.user_id),
      "user" => %{"id" => Integer.to_string(user.user_id), "username" => user.username},
      "return_to" => return_to
    })
  end

  # ---------------------------------------------------------------------------
  # Shared
  # ---------------------------------------------------------------------------

  defp refused(conn),
    do: error(conn, 401, "invalid_credentials", "SSO sign-in failed.")

  # The token pair carries the account in the `@me` shape (lane D #4): the
  # client adopts it instead of paying a `/users/@me` round trip at login.
  defp user_payload(user), do: CytaleWeb.API.SelfUser.json(user)
end
