defmodule CytaleWeb.TwoFactorController do
  @moduledoc """
  TOTP two-factor surface (ticket #127), under `/api/v1/auth/2fa/` plus the
  settings-management pair on `/users/@me/two-factor`.

  Endpoints:

    * `POST /auth/2fa/verify` — PRE-AUTH, the enrolled account's login step:
      `{grant, code}` swaps a `:totp` challenge grant for the EXACT token
      pair `POST /auth/login` returns (same keys, same claims, same refresh
      rotation machinery downstream).
    * `POST /auth/2fa/enroll/start` — the ceremony's first half: generates
      the secret and returns base32 + otpauth URI data (the CLIENT renders
      the QR — no server render). Reachable two ways: by an `:enrollment`
      grant (the forced walk at login) or a Bearer token (settings).
    * `POST /auth/2fa/enroll/confirm` — `{code}` against the candidate
      secret; success persists the confirmed enrollment and — for the grant
      path — mints the token pair (the walk's exit into the shell).
    * `GET|DELETE /users/@me/two-factor` — the settings pair: status read
      (mode + enrollment) and removal (allowed while the switch is on; the
      next password login simply re-prompts enrollment).

  Mode gating: with `auth.two_factor_enabled` OFF every endpoint here
  answers the honest `403 two_factor_disabled` and the login path never
  mints grants — the feature is absent, not hidden.

  Response discipline: the one error envelope everywhere, and the verify /
  grant-confirm refusals collapse to the password path's uniform
  `401 invalid_credentials` (no oracle between an unknown grant, a spent
  grant, an exhausted failure budget, and a wrong code). One deliberate
  extra answer (S3): verify attempts past the per-account attempt dam answer
  the house 429 `rate_limited` before the code is even looked at — six
  digits otherwise make an unthrottled verify a million-combination oracle.
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.AttemptGuard
  alias Cytale.Accounts.{Auth, TwoFactor, User}
  alias Cytale.Accounts.TwoFactor.Grants
  import CytaleWeb.API.Error, only: [error: 4, rate_limited: 2]

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/2fa/verify  {grant, code}
  # ---------------------------------------------------------------------------

  @doc """
  The enrolled login's second factor. The grant must be a LIVE `:totp`
  grant (minted by this login's password step); the code must verify against
  the account's confirmed enrollment with replay protection. Success mints
  the EXACT token pair the password login would have.
  """
  def verify(conn, %{"grant" => grant, "code" => code})
      when is_binary(grant) and is_binary(code) do
    # Not gated on the server switch: a `:totp` grant exists only because the
    # password step challenged an ENROLLED account, which it does whether or
    # not the switch is on (the switch governs enrolment, not enrolled users).
    case Grants.consume(grant, :totp) do
      {:ok, %{user_id: user_id}} ->
        # S3 dam: 2FA codes are six digits, so an unthrottled verify is a
        # code oracle with a million combinations. Keyed by the
        # grant-proven user id, checked before the verify, failures counted,
        # success cleared. The refusal below stays the ONE uniform answer —
        # the dam only decides how soon the next try may happen.
        dam = AttemptGuard.totp_key(user_id)

        case AttemptGuard.check(dam) do
          :ok ->
            verify_step(conn, dam, user_id, code)

          {:error, :locked, retry_ms} ->
            rate_limited(conn, retry_ms)
        end

      # Uniform refusal (no oracle): unknown/spent/expired grant. The
      # grant is consumed on ANY attempt (the #36 challenge posture — one
      # code shot per password), so every failure sends the caller back
      # to the password with the same one answer.
      _ ->
        invalid_step(conn)
    end
  end

  defp verify_step(conn, dam, user_id, code) do
    case live_user(user_id) do
      %{deleted_at: nil} = user ->
        case TwoFactor.verify_login(user_id, code) do
          :ok ->
            :ok = AttemptGuard.clear(dam)
            token_response(conn, user)

          # Wrong code, replayed code, missing enrollment: a counted failure
          # and the uniform refusal.
          _failure ->
            :ok = AttemptGuard.fail(dam)
            invalid_step(conn)
        end

      _ ->
        :ok = AttemptGuard.fail(dam)
        invalid_step(conn)
    end
  end

  defp invalid_step(conn),
    do:
      error(
        conn,
        401,
        "invalid_credentials",
        "That code didn't match, or this sign-in step expired. Sign in again."
      )

  def verify(conn, _params),
    do: error(conn, 400, "validation_failed", "grant and code are required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/2fa/enroll/start   (enrollment grant OR Bearer)
  # ---------------------------------------------------------------------------

  @doc """
  Generate the candidate secret. `200` carries `secret` (base32 — the
  manual-entry string), `otpauth_uri` (the string the client renders as a
  QR), and the parameters spelled out for the app.
  """
  def enroll_start(conn, params) do
    if TwoFactor.enabled?() do
      with {:ok, user_id, _origin} <- caller(conn, params),
           {:ok, %{secret: secret, otpauth_uri: uri}} <- TwoFactor.start_enrollment(user_id) do
        json(conn, %{
          "secret" => secret,
          "otpauth_uri" => uri,
          "algorithm" => "SHA1",
          "digits" => 6,
          "period" => 30
        })
      else
        {:error, :already_enrolled} ->
          error(
            conn,
            409,
            "already_enrolled",
            "This account already has two-factor authentication. Remove it first to re-enroll."
          )

        _refused ->
          # Unknown/spent/expired grant or a bad Bearer: one uniform shape.
          error(conn, 401, "invalid_credentials", "This enrollment session is not valid. Sign in again.")
      end
    else
      disabled(conn)
    end
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/2fa/enroll/confirm  {code, grant?}
  # ---------------------------------------------------------------------------

  @doc """
  Verify `code` against the CANDIDATE secret; only success flips the
  enrollment armed. The grant path's success CONSUMES the grant and mints
  the real token pair — the forced walk's only exit into the shell. The
  settings (Bearer) path's success confirms without minting anything.
  """
  def enroll_confirm(conn, %{"code" => code} = params) when is_binary(code) do
    if TwoFactor.enabled?() do
      grant = Map.get(params, "grant")

      case caller(conn, params) do
        {:ok, user_id, origin} -> confirm_with_caller(conn, user_id, origin, grant, code)
        _refused -> grant_refused(conn)
      end
    else
      disabled(conn)
    end
  end

  def enroll_confirm(conn, _params),
    do: error(conn, 400, "validation_failed", "code is required")

  # The confirm's three outcomes, per caller kind:
  #   * success  — grant: consume + mint the pair (the walk's exit);
  #                bearer: confirm without minting anything.
  #   * bad code — an enrollment grant burns one attempt (bounded oracle);
  #                the refusal itself is one uniform 400.
  #   * dead call — deleted account or a grant that died between peek and
  #                consume: the uniform 401.
  defp confirm_with_caller(conn, user_id, origin, grant, code) do
    user = live_user(user_id)

    cond do
      is_nil(user) ->
        grant_refused(conn)

      true ->
        case TwoFactor.confirm_enrollment(user_id, code) do
          :ok when origin == :grant ->
            # The walk's exit: consume the grant, mint the pair. A grant that
            # died between peek and consume stays the uniform refusal.
            case Grants.consume(grant, :enrollment) do
              {:ok, %{user_id: ^user_id}} -> token_response(conn, user)
              _ -> grant_refused(conn)
            end

          :ok ->
            json(conn, %{"enrolled" => true})

          {:error, :already_enrolled} ->
            error(conn, 409, "already_enrolled", "This account already has two-factor authentication.")

          {:error, _} ->
            # Wrong code (or no candidate started): burn one grant attempt so
            # the grant is not an unthrottled code oracle; an exhausted
            # budget surfaces as the uniform 401 on the NEXT call.
            if origin == :grant, do: Grants.fail(grant, :enrollment)

            error(conn, 400, "invalid_code", "That code didn't match. Check your authenticator app and try again.")
        end
    end
  end

  # ---------------------------------------------------------------------------
  # GET /api/v1/users/@me/two-factor — the settings read
  # ---------------------------------------------------------------------------

  def status(conn, _params) do
    user_id = conn.assigns.current_user.user_id

    case TwoFactor.enrollment(user_id) do
      %{confirmed: true} = row ->
        json(conn, %{
          "mode_enabled" => TwoFactor.enabled?(),
          "enrolled" => true,
          "confirmed_at" => iso8601(row.confirmed_at),
          "last_used_at" => iso8601(row.last_used_at)
        })

      _ ->
        json(conn, %{"mode_enabled" => TwoFactor.enabled?(), "enrolled" => false})
    end
  end

  # ---------------------------------------------------------------------------
  # DELETE /api/v1/users/@me/two-factor
  # ---------------------------------------------------------------------------

  @doc """
  Remove the enrollment. Allowed while the switch is on BY DESIGN: the
  removal completes, and the next password login re-prompts enrollment —
  self-inflicted lockout from the shell is impossible. (The recovery copy
  in settings states the other half: a password reset also clears 2FA.)
  """
  def delete(conn, _params) do
    :ok = TwoFactor.clear_enrollment(conn.assigns.current_user.user_id)
    send_resp(conn, 204, "")
  end

  # ---------------------------------------------------------------------------
  # Shared
  # ---------------------------------------------------------------------------

  # The enroll endpoints answer to TWO credentials: an `:enrollment` grant
  # (the forced walk at login — no session exists yet) or a Bearer token
  # (settings). A body grant wins; the Bearer is the fallback. Only
  # `:enrollment` grants reach these endpoints — a `:totp` grant is for
  # verify/2 alone (single-purpose).
  defp caller(conn, params) do
    case Map.get(params, "grant") do
      grant when is_binary(grant) ->
        case Grants.peek(grant, :enrollment) do
          {:ok, %{user_id: user_id}} -> {:ok, user_id, :grant}
          {:error, :invalid} -> {:error, :invalid_grant}
        end

      _ ->
        case bearer_user_id(conn) do
          {:ok, user_id} -> {:ok, user_id, :bearer}
          :error -> {:error, :invalid_grant}
        end
    end
  end

  defp bearer_user_id(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization") |> Enum.take(1),
         {:ok, %{user_id: user_id}} <- Auth.verify_access_token(token) do
      {:ok, user_id}
    else
      _ -> :error
    end
  end

  defp live_user(user_id) do
    case User.get(user_id) do
      %{deleted_at: nil} = user -> user
      _ -> nil
    end
  end

  # The token-pair response — the template contract of AuthController.login/2
  # (same keys, same claims, same effective-verification rule). The forced
  # walk and the TOTP challenge both exit through here and nowhere else.
  defp token_response(conn, user) do
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
  end

  # The token pair carries the account in the `@me` shape (lane D #4): the
  # client adopts it instead of paying a `/users/@me` round trip at login.
  defp user_payload(user), do: CytaleWeb.API.SelfUser.json(user)

  defp iso8601(nil), do: nil
  defp iso8601(%DateTime{} = dt), do: DateTime.to_iso8601(dt)

  defp disabled(conn),
    do: error(conn, 403, "two_factor_disabled", "Two-factor authentication is disabled on this server")

  defp grant_refused(conn),
    do:
      error(
        conn,
        401,
        "invalid_credentials",
        "This enrollment session is not valid. Sign in again."
      )
end
