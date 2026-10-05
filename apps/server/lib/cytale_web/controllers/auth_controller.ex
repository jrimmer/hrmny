defmodule CytaleWeb.AuthController do
  @moduledoc """
  REST auth surface (U8): register, verify-email, resend-verification, login,
  refresh, password-reset request/complete — all under `/api/v1/auth`.

  Response discipline (API Surface Design, binding): the one error envelope
  everywhere — `{"error": {"key", "code", "message"}}` — and Snowflake ids as
  decimal strings. Register returns 201 + tokens with the account still
  VIEW-ONLY (verification pending). Refresh ROTATES the refresh token: the
  presented one dies with the call (replay → 401 `refresh_revoked`).
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.AttemptGuard
  alias Cytale.Accounts.{Auth, TwoFactor, User, Verification}
  alias Cytale.Accounts.TwoFactor.Grants
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces
  import CytaleWeb.API.Error, only: [error: 4, rate_limited: 2]

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/register
  # ---------------------------------------------------------------------------

  # The registration gate runs BEFORE any validation (CYTALE_REGISTRATION_OPEN,
  # runtime.exs): a closed server must not leak whether a username/email is
  # taken — the same anti-oracle posture as the register error mapping below.
  #
  # Invite-gated sign-up (security Tier 2 #5 — closed sign-up is the default
  # until a mailer exists): a CLOSED server still registers a body carrying a
  # valid, unexpired, not-exhausted `invite_code`, and the new account joins
  # that workspace through the normal accept (`Workspaces.accept_invite/2` —
  # the same reserved, max_uses-enforcing seat). An open server honours a
  # valid code the same way and ignores an invalid one (the account still
  # gets made; it just joins nothing). The invite answer comes before any
  # username/email validation too, so a closed server stays a non-oracle for
  # everyone without a live invite — and invite codes are publicly
  # resolvable already (`GET /invites/:code`).
  def register(conn, params) do
    code = invite_code(params)
    invite = code && Workspaces.get_invite(code)

    cond do
      Cytale.Config.registration_open?() ->
        do_register(conn, params, invite && code)

      code == nil ->
        error(conn, 403, "registration_closed", "Registration is disabled on this server")

      invite == nil ->
        error(conn, 403, "invite_invalid", "This invite is invalid, expired or used up.")

      true ->
        do_register(conn, params, code)
    end
  end

  defp invite_code(%{"invite_code" => code}) when is_binary(code) and code != "", do: String.trim(code)
  defp invite_code(_params), do: nil

  defp do_register(conn, %{"username" => u, "email" => e, "password" => p} = params, invite_code)
       when is_binary(u) and is_binary(e) and is_binary(p) do
    case User.create(u, e, p) do
      {:ok, user} ->
        # Issue tokens immediately: the account is usable (view-only) from
        # register. Verification mail goes out on the same path.
        access = Auth.issue_access_token(user.user_id, user.username, false)
        {:ok, refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)
        :ok = Verification.send_verification(user.user_id)

        conn
        |> put_status(201)
        |> json(
          %{
            "user" => user_payload(user),
            "access_token" => access,
            "refresh_token" => refresh,
            "token_type" => "Bearer",
            "expires_in" => div(Cytale.Config.access_token_ttl_ms(), 1000),
            "email_verified" => Cytale.Config.effective_verified?(false)
          }
          |> Map.merge(join_invite(invite_code, user))
        )

      {:error, reason} ->
        register_error(conn, reason, Map.get(params, "email", ""))
    end
  end

  defp do_register(conn, _params, _invite_code) do
    error(conn, 400, "validation_failed", "username, email and password are required")
  end

  # The normal accept for the brand-new account: `accept_invite/2` reserves
  # the seat (the LWT that enforces max_uses) and adds the member; the epoch
  # bump and MemberAdd are what `InviteController.accept/2` announces to the
  # workspace. (The new account has no live session yet, so there is nothing
  # of its own to re-route.) A seat lost to a concurrent accept between the
  # check above and here leaves the account made but unjoined — reported as
  # `invite_accepted: false`, never a crash.
  defp join_invite(nil, _user), do: %{}

  defp join_invite(code, user) do
    case Workspaces.accept_invite(code, user.user_id) do
      {:ok, invite} ->
        RightsEpoch.bump(invite.workspace_id)
        CytaleWeb.MemberEvents.announce_join(invite.workspace_id, user.user_id)

        %{"invite_accepted" => true, "workspace_id" => Integer.to_string(invite.workspace_id)}

      {:error, _} ->
        %{"invite_accepted" => false}
    end
  end

  # S5 (anti-enumeration): username-taken and email-taken are ONE answer —
  # a single 409 code that names neither. On an open-registration server the
  # old split let anyone ask "is this email registered?" for free; the dam
  # (S3) cannot compensate, because a probe is one cheap request. Clients map
  # `taken` to a generic "username or email is already registered" message.
  defp register_error(conn, reason, _email) when reason in [:username_taken, :email_taken],
    do: error(conn, 409, "taken", "That username or email is already registered.")

  defp register_error(conn, :invalid_username, _email),
    do: error(conn, 400, "invalid_username", "Usernames are 2-32 chars: letters, digits, _ . - (no @).")

  defp register_error(conn, :invalid_email, _email),
    do: error(conn, 400, "invalid_email", "That email address does not look valid.")

  defp register_error(conn, :invalid_password, _email),
    do: error(conn, 400, "invalid_password", "Passwords are 8-128 characters.")

  defp register_error(conn, _other, _email),
    do: error(conn, 500, "registration_failed", "Registration failed; try again.")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/verify-email  {token}
  # ---------------------------------------------------------------------------

  def verify_email(conn, %{"token" => token}) when is_binary(token) do
    case Verification.complete_email_verification(token) do
      :ok ->
        json(conn, %{"verified" => true})

      {:error, :consumed_token} ->
        error(conn, 410, "token_consumed", "This verification link was already used.")

      {:error, :invalid_token} ->
        error(conn, 410, "token_invalid", "This verification link is invalid or has expired.")

      {:error, :user_not_found} ->
        error(conn, 410, "token_invalid", "This verification link is invalid or has expired.")
    end
  end

  def verify_email(conn, _params),
    do: error(conn, 400, "validation_failed", "token is required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/resend-verification  {email} (anti-enumeration: always 200)
  # ---------------------------------------------------------------------------

  def resend_verification(conn, %{"email" => email}) when is_binary(email) do
    case User.get_by_identifier(email) do
      %{deleted_at: nil, email_verified_at: nil} = user ->
        :ok = Verification.send_verification(user.user_id)
        json(conn, %{"sent" => true})

      _ ->
        # Same response for verified/unknown/deleted — no account enumeration.
        json(conn, %{"sent" => true})
    end
  end

  def resend_verification(conn, _params),
    do: error(conn, 400, "validation_failed", "email is required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/login  {identifier, password}
  # ---------------------------------------------------------------------------

  def login(conn, %{"identifier" => ident, "password" => password})
      when is_binary(ident) and is_binary(password) do
    # S3 dam pre-check: BEFORE any credential work, including the user-row
    # read. A tripped dam answers the house 429 even for a CORRECT password —
    # the lock releases on the clock, not on a guess. The hard lock is per
    # identifier PER CLIENT NETWORK (security Tier 2 #2), so a stranger's
    # guesses lock the stranger out, never the owner on their own network.
    dam = AttemptGuard.login_keys(ident, CytaleWeb.Compat.RateLimit.ip_key(conn.remote_ip))

    case AttemptGuard.check_login(dam) do
      :ok -> password_step(conn, dam, ident, password)
      {:error, :locked, retry_ms} -> rate_limited(conn, retry_ms)
    end
  end

  def login(conn, _params),
    do: error(conn, 400, "validation_failed", "identifier and password are required")

  # The password gate itself, dam-keyed by the ATTEMPTED identifier. Both
  # refusal branches record a failure — a miss on a NONEXISTENT account
  # counts too, so the dam cannot be turned into an enumeration oracle by
  # only ever locking accounts that exist (the 401 stays uniform either way).
  defp password_step(conn, dam, ident, password) do
    case User.get_by_identifier(ident) do
      # A federated (OIDC-born) account stores "" — no password can answer for
      # it, and it falls to the dummy-verify branch below like an unknown one.
      %{deleted_at: nil, password_hash: hash} = user when is_binary(hash) and hash != "" ->
        if Auth.valid_password?(password, hash) do
          # Success clears the key: the dam is for attackers, not for the
          # account's owner fumbling once.
          :ok = AttemptGuard.succeed_login(dam)

          # Two-factor gate (ticket #127). Passkey logins mint tokens
          # directly (already multifactor); OIDC logins of an ENROLLED
          # account owe the same TOTP step (OIDCController). The switch
          # is READ HERE, at login, so a flip hot-applies to the NEXT login:
          #
          #   * off + NOT enrolled — the plain token pair;
          #   * off + enrolled — still a `:totp` grant (see below);
          #   * on + NOT enrolled — a verified password is not enough: an
          #     `:enrollment` grant + `enrollment_required`; the grant reaches
          #     the enroll ceremony ONLY, never tokens (skipping impossible);
          #   * on + enrolled — a `:totp` grant + `totp_pending`;
          #     POST /auth/2fa/verify swaps it for the pair.
          #
          # The branch responses are 200s with a `status` key — not the error
          # envelope — and carry the account for the client's step display.
          #
          # The switch governs ENROLMENT only: an account that already holds a
          # confirmed enrollment is challenged even with the switch off —
          # turning the switch off must never quietly strip a second factor
          # someone set up (that costs one enrollment read per password login
          # while the switch is off).
          if TwoFactor.enabled?() or TwoFactor.enrolled?(user.user_id) do
            two_factor_step(conn, user)
          else
            issue_login_pair(conn, user)
          end
        else
          :ok = AttemptGuard.fail_login(dam)
          error(conn, 401, "invalid_credentials", "Wrong username/email or password.")
        end

      _ ->
        # No usable account (unknown, tombstoned, or passwordless/federated):
        # burn one dummy Argon2 verification so this branch costs what a real
        # wrong-password check costs. Without it the unknown-user 401 returns
        # in microseconds and the response TIME is an account-existence
        # oracle the uniform body was meant to deny. Through the Argon2 gate
        # like a real verify (`Auth.no_user_verify/0`): bounded, and when the
        # gate is full it answers 503 BEFORE the dam counts a failure.
        _ = Auth.no_user_verify()
        :ok = AttemptGuard.fail_login(dam)
        error(conn, 401, "invalid_credentials", "Wrong username/email or password.")
    end
  end

  # The 2FA branch: mint the grant for whatever step this account owes. The
  # grant is opaque (nothing about the account rides the wire), short-lived
  # (~5 min), single-purpose, and failure-budgeted (see Grants).
  defp two_factor_step(conn, user) do
    if TwoFactor.enrolled?(user.user_id) do
      json(conn, %{
        "status" => "totp_pending",
        "grant" => Grants.put(:totp, user.user_id),
        "user" => step_user_payload(user)
      })
    else
      json(conn, %{
        "status" => "enrollment_required",
        "grant" => Grants.put(:enrollment, user.user_id),
        "user" => step_user_payload(user)
      })
    end
  end

  # The off-mode (and post-2FA-verify) success shape — the identical token
  # pair this endpoint has always returned.
  defp issue_login_pair(conn, user) do
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

  # The 2FA step responses carry a REDUCED account payload (identity for the
  # step display — id + username only; the email is the account owner's
  # business and this response is pre-authentication).
  defp step_user_payload(user) do
    %{"id" => Integer.to_string(user.user_id), "username" => user.username}
  end

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/refresh  {refresh_token}
  # ---------------------------------------------------------------------------

  @doc "POST /auth/logout — revoke the presented refresh token (best-effort)."
  def logout(conn, %{"refresh_token" => raw}) when is_binary(raw) do
    with %{"sub" => sub} <- decode_any_expiry(conn),
         {user_id, ""} <- Integer.parse(sub) do
      :ok = Auth.revoke_refresh_token(user_id, raw)
      json(conn, %{"logged_out" => true})
    else
      _ -> json(conn, %{"logged_out" => true})
    end
  end

  def logout(conn, _params), do: json(conn, %{"logged_out" => true})

  def refresh(conn, %{"refresh_token" => raw}) when is_binary(raw) do
    # The presented token encodes no owner by design; the hash lookup is per
    # user — so the token must first prove which user it belongs to. We hash
    # and search via the stored claims: refresh_tokens are keyed (user_id,
    # token_hash), so we need the user id. The access token (possibly expired)
    # may accompany it; alternatively the raw token embeds no user. Design:
    # the refresh token is presented TOGETHER with an (expired ok) access
    # token. If the client presents only a refresh token, we require the
    # access token's user_id claim — JWT signature still verifies (signature
    # validity ≠ freshness; exp is checked separately and IGNORED here for a
    # refresh, per OAuth2 Bearer semantics).
    with %{"sub" => _} = claims <- decode_any_expiry(conn),
         user_id <- String.to_integer(claims["sub"]) do
      case Auth.rotate_refresh_token(user_id, raw) do
        {:ok, new_refresh, _hash, _exp} ->
          user = User.get(user_id)

          verified = Cytale.Config.effective_verified?(not is_nil(user.email_verified_at))
          access = Auth.issue_access_token(user_id, user.username, verified)

          # The account rides the exchange (lane D #4): the row is already
          # loaded to mint the access token, and a cold boot's restore is
          # exactly "refresh, then who am I" — returning it here drops the
          # `/users/@me` round trip that used to sit between the refresh and
          # the gateway connect.
          json(conn, %{
            "user" => user_payload(user),
            "access_token" => access,
            "refresh_token" => new_refresh,
            "token_type" => "Bearer",
            "expires_in" => div(Cytale.Config.access_token_ttl_ms(), 1000)
          })

        {:error, :revoked} ->
          error(conn, 401, "refresh_revoked", "This refresh token was already used or revoked; log in again.")
      end
    else
      _ ->
        error(conn, 401, "invalid_credentials", "Missing or unusable tokens for refresh.")
    end
  end

  def refresh(conn, _params),
    do: error(conn, 400, "validation_failed", "refresh_token is required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/password-reset/request  {email}
  # ---------------------------------------------------------------------------

  def request_password_reset(conn, %{"email" => email}) when is_binary(email) do
    # Anti-enumeration: always 200; only real accounts receive mail. That
    # same silence is why the S3 dam counts the REQUESTS (keyed by the
    # submitted email): a flood of mail-outs is otherwise indistinguishable
    # from misses, and 10 in a window is nobody's accident.
    dam = AttemptGuard.password_reset_key(email)

    case AttemptGuard.check(dam) do
      :ok ->
        :ok = AttemptGuard.fail(dam)
        :ok = Verification.request_password_reset(email)
        json(conn, %{"sent" => true})

      {:error, :locked, retry_ms} ->
        rate_limited(conn, retry_ms)
    end
  end

  def request_password_reset(conn, _params),
    do: error(conn, 400, "validation_failed", "email is required")

  # ---------------------------------------------------------------------------
  # POST /api/v1/auth/password-reset/complete  {token, new_password}
  # ---------------------------------------------------------------------------

  def complete_password_reset(conn, %{"token" => token, "new_password" => new_password})
      when is_binary(token) and is_binary(new_password) do
    case Verification.complete_password_reset(token, new_password) do
      :ok ->
        json(conn, %{"reset" => true})

      {:error, :invalid_password} ->
        error(conn, 400, "invalid_password", "Passwords are 8-128 characters.")

      {:error, :consumed_token} ->
        error(conn, 410, "token_consumed", "This reset link was already used.")

      {:error, _} ->
        error(conn, 410, "token_invalid", "This reset link is invalid or has expired.")
    end
  end

  def complete_password_reset(conn, _params),
    do: error(conn, 400, "validation_failed", "token and new_password are required")

  # ---------------------------------------------------------------------------
  # Shared
  # ---------------------------------------------------------------------------

  # The token pair carries the account in the `@me` shape (lane D #4): the
  # client adopts it instead of paying a `/users/@me` round trip at login.
  defp user_payload(user), do: CytaleWeb.API.SelfUser.json(user)

  # Refresh: signature-checked, expiry-IGNORED decode of the accompanying
  # (Bearer) access token. An attacker cannot forge it; a legitimately expired
  # access token is precisely the refresh scenario.
  defp decode_any_expiry(conn) do
    with ["Bearer " <> token] <- get_req_header(conn, "authorization") |> Enum.take(1),
         {:ok, claims_map} <- Auth.verify_access_token_ignoring_expiry(token) do
      claims_map
    else
      _ -> nil
    end
  end
end
