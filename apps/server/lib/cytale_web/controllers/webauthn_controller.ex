defmodule CytaleWeb.WebAuthnController do
  @moduledoc """
  WebAuthn passkey surface (ticket #36): the four ceremony endpoints under
  `/api/v1/auth/webauthn/` plus the account's credential list/remove and the
  tiny unauth `GET /auth/methods` the login page reads to decide whether the
  bottom button renders at all.

    * `POST /auth/webauthn/register/options` + `/register/verify` —
      AUTHENTICATED (enrollment mints a LOGIN credential, so the verification
      choke point applies, the same rule as SSH-certificate issuance);
    * `POST /auth/webauthn/login/options` + `/login/verify` — PRE-AUTH,
      discoverable (no identifier in, no account-existence oracle out),
      riding the same per-IP `:auth` rate-limit dam as the password surface;
    * `GET|DELETE /users/@me/webauthn/credentials[...]` — the owner's list
      and revocation (deleting the rows IS the revocation).

  Response discipline: the one error envelope everywhere, and — the part the
  ticket pins — `login/verify` mints the EXACT token pair `POST /auth/login`
  returns (same JSON keys, same claims, same refresh rotation machinery
  downstream). Every refusal that reads a credential collapses to the password
  path's uniform `401 invalid_credentials`: no oracle distinguishes an unknown
  credential from a forged assertion from a deleted account. The two refusals
  decided BEFORE any credential is read keep their own keys, because the member
  can act on them: `challenge_invalid` (expired or spent — try again) and
  `ceremony_failed` (the response was made for another address than this
  server's passkey settings name).
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.{Auth, WebAuthn}
  import CytaleWeb.API.Error, only: [error: 4]

  # ---------------------------------------------------------------------------
  # GET /api/v1/auth/methods — the login page's "which buttons" read
  # ---------------------------------------------------------------------------

  @doc """
  Unauthenticated, non-oracle: the auth methods this server offers. The
  password entry is constant (break-glass: it is never removable); the passkey
  and OIDC (ticket #12) entries are present only when their surfaces are
  configured and enabled — an absent method is the honest "not here", and the
  button label rides along so the operator's `oidc.button_label` is what the
  sign-in screen actually says.
  """
  def methods(conn, _params) do
    json(conn, %{
      "password" => true,
      "webauthn" => WebAuthn.available?(),
      "oidc" => Cytale.OIDC.enabled?(),
      "oidc_button_label" => if(Cytale.OIDC.enabled?(), do: Cytale.OIDC.button_label(), else: nil),
      # #127: the TOTP switch — the cheapest seam for BOTH readers (the login
      # page already polls this unauthenticated; the settings section reads
      # the same field). Off = the feature is absent client-side too.
      "two_factor" => Cytale.Accounts.TwoFactor.enabled?()
    })
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/webauthn/register/options  (authenticated)
  # ---------------------------------------------------------------------------

  def register_options(conn, _params) do
    if WebAuthn.available?() do
      %{challenge_id: challenge_id, options: options} =
        WebAuthn.new_registration(conn.assigns.current_user.user_id)

      json(conn, %{"challenge_id" => challenge_id, "public_key" => options})
    else
      disabled(conn)
    end
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/webauthn/register/verify  {challenge_id, name?, response}
  # ---------------------------------------------------------------------------

  def register_verify(conn, %{"challenge_id" => challenge_id, "response" => response})
      when is_binary(challenge_id) and is_map(response) do
    user_id = conn.assigns.current_user.user_id

    # The artifacts live under `response.response` (the AuthenticatorAttestationResponse
    # JSON); a client that flattened them one level up is tolerated too.
    with {:ok, inner} <- inner_response(response),
         attestation_object when is_binary(attestation_object) <-
           resp_field(inner, "attestationObject", "attestation_object"),
         client_data_json when is_binary(client_data_json) <-
           resp_field(inner, "clientDataJSON", "client_data_json") do
      name = if is_binary(conn.body_params["name"]), do: conn.body_params["name"], else: ""

      case WebAuthn.verify_registration(user_id, challenge_id, name, attestation_object, client_data_json) do
        {:ok, credential} ->
          json(conn, %{"credential" => credential_payload(credential)})

        {:error, :challenge_invalid} ->
          error(
            conn,
            400,
            "challenge_invalid",
            "This passkey ceremony was already used, expired, or never existed. Start again."
          )

        {:error, :credential_id_taken} ->
          error(conn, 409, "credential_duplicate", "This passkey is already registered.")

        {:error, _} ->
          error(
            conn,
            400,
            "ceremony_failed",
            "The browser's passkey response was refused (wrong origin, site, or malformed). Start again."
          )
      end
    else
      _ ->
        error(
          conn,
          400,
          "validation_failed",
          "challenge_id and response (clientDataJSON, attestationObject) are required"
        )
    end
  end

  def register_verify(conn, _params),
    do: error(conn, 400, "validation_failed", "challenge_id and response are required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/webauthn/login/options  (pre-auth, no identifier)
  # ---------------------------------------------------------------------------

  def login_options(conn, _params) do
    if WebAuthn.available?() do
      %{challenge_id: challenge_id, options: options} = WebAuthn.new_authentication()
      json(conn, %{"challenge_id" => challenge_id, "public_key" => options})
    else
      disabled(conn)
    end
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/webauthn/login/verify  {challenge_id, response}
  # The token-pair response below is the template contract of AuthController
  # login/2 — same keys, same claims, same effective-verification rule.
  # ---------------------------------------------------------------------------

  def login_verify(conn, %{"challenge_id" => challenge_id, "response" => response})
      when is_binary(challenge_id) and is_map(response) do
    # The artifacts live under `response.response` (the AuthenticatorAssertionResponse
    # JSON); a client that flattened them one level up is tolerated too.
    with {:ok, inner} <- inner_response(response),
         raw_id when is_binary(raw_id) <-
           resp_field(response, "rawId", "raw_id") || resp_field(response, "id", "id"),
         authenticator_data when is_binary(authenticator_data) <-
           resp_field(inner, "authenticatorData", "authenticator_data"),
         signature when is_binary(signature) <- resp_field(inner, "signature", "signature"),
         client_data_json when is_binary(client_data_json) <- resp_field(inner, "clientDataJSON", "client_data_json"),
         user_handle <- resp_field(inner, "userHandle", "user_handle"),
         {:ok, user, _credential_id} <-
           WebAuthn.verify_authentication(
             challenge_id,
             raw_id,
             authenticator_data,
             signature,
             client_data_json,
             user_handle
           ) do
      verified = Cytale.Config.effective_verified?(not is_nil(user.email_verified_at))
      access = Auth.issue_access_token(user.user_id, user.username, verified)

      {:ok, refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)

      json(conn, %{
        "user" => user_payload(user),
        "access_token" => access,
        "refresh_token" => refresh,
        "token_type" => "Bearer",
        "expires_in" => div(Cytale.Config.access_token_ttl_ms(), 1000),
        "email_verified" => Cytale.Config.effective_verified?(not is_nil(user.email_verified_at))
      })
    else
      # Response missing its binary parts → a malformed request, not a
      # credential refusal.
      :error ->
        error(
          conn,
          400,
          "validation_failed",
          "response requires rawId, authenticatorData, signature and clientDataJSON"
        )

      # The three refusal keys are the client's map (apps/web passkeys.ts):
      # each names a different thing the member can DO about it.
      {:error, :challenge_invalid} ->
        error(
          conn,
          400,
          "challenge_invalid",
          "This passkey sign-in request expired or was already used. Try again."
        )

      {:error, :ceremony_failed} ->
        # Decided from the response and the server's own configuration before
        # any credential is read — not an account oracle (WebAuthn.ceremony_matches/3).
        error(
          conn,
          400,
          "ceremony_failed",
          "The passkey response doesn't match this server's address, so it couldn't be verified. " <>
            "Open Hrmny at its usual address and try again."
        )

      _ ->
        # Uniform refusal: unknown credential, bad signature, stale counter,
        # deleted account — one answer, no oracle. It still says what to do.
        error(
          conn,
          401,
          "invalid_credentials",
          "That passkey couldn't sign you in. It may not be registered on this server. " <>
            "Sign in with your password, then add the passkey again in Settings → My Account → Passkeys."
        )
    end
  end

  def login_verify(conn, _params),
    do: error(conn, 400, "validation_failed", "challenge_id and response are required")

  # ---------------------------------------------------------------------------
  # GET /api/v1/users/@me/webauthn/credentials — the account's list
  # ---------------------------------------------------------------------------

  def index(conn, _params) do
    credentials =
      conn.assigns.current_user.user_id
      |> WebAuthn.Credentials.list_for_user()
      |> Enum.map(&credential_payload/1)

    json(conn, %{"credentials" => credentials})
  end

  # ---------------------------------------------------------------------------
  # DELETE /api/v1/users/@me/webauthn/credentials/:credential_id
  # ---------------------------------------------------------------------------

  def delete(conn, %{"credential_id" => credential_id}) do
    user_id = conn.assigns.current_user.user_id

    owned? =
      user_id
      |> WebAuthn.Credentials.list_for_user()
      |> Enum.any?(&(&1.credential_id == credential_id))

    # Not-yours and not-found collapse to one 404 (the id space is not
    # enumerable — the webhook-ownership posture).
    if owned? do
      :ok = WebAuthn.Credentials.delete(user_id, credential_id)
      send_resp(conn, 204, "")
    else
      error(conn, 404, "credential_not_found", "No such passkey on this account.")
    end
  end

  # ---------------------------------------------------------------------------
  # Shared
  # ---------------------------------------------------------------------------

  defp disabled(conn),
    do: error(conn, 403, "passkeys_disabled", "Passkey sign-in is disabled on this server")

  # The browser's PublicKeyCredential JSON uses camelCase (spec names); the
  # controller accepts the snake_case twin too, so a hand-rolled client is
  # never locked out by casing alone.
  # `response.response` — the (AuthenticatorAttestation|Assertion)Response JSON
  # object; `:error` when absent or not a map.
  defp inner_response(response) do
    case response do
      %{"response" => %{} = inner} -> {:ok, inner}
      _ -> :error
    end
  end

  defp resp_field(response, camel, snake) do
    case Map.get(response, camel) || Map.get(response, snake) do
      value when is_binary(value) -> value
      _ -> nil
    end
  end

  defp credential_payload(%{} = credential) do
    %{
      "id" => credential.credential_id,
      "name" => credential.name,
      "created_at" => iso8601(credential.created_at),
      "last_used_at" => iso8601(credential.last_used_at)
    }
  end

  # The token pair carries the account in the `@me` shape (lane D #4): the
  # client adopts it instead of paying a `/users/@me` round trip at login.
  defp user_payload(user), do: CytaleWeb.API.SelfUser.json(user)

  defp iso8601(nil), do: nil
  defp iso8601(%DateTime{} = dt), do: DateTime.to_iso8601(dt)
end
