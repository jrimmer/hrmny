defmodule CytaleWeb.Controllers.TwoFactorControllerTest do
  @moduledoc """
  #127 — the TOTP two-factor surface, end to end through the real router:
  the forced-enrollment walk (mode on → password login grants, NO tokens →
  enroll → confirm → tokens), the enrolled challenge (grant → verify →
  tokens), every refusal the ticket pins (wrong code, replayed code, spent
  grant, expired grant, skipping), switch hot-apply in both directions, the
  passkey and OIDC bypass lines, password-reset recovery, removal
  re-prompting, and the methods/status seams.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Accounts.{Auth, TOTP, TwoFactor, User, Verification}
  alias Cytale.Accounts.TwoFactor.Grants
  alias Cytale.OIDC.StubProvider
  alias Cytale.WebAuthnFixtures, as: Fixtures

  @endpoint CytaleWeb.Endpoint

  @oidc_client_id "2fa-stub-client"
  @oidc_client_secret "2fa-stub-secret-127"

  @oidc_env_keys [:oidc, :server_secrets, :registration_open, :require_verified_email]

  defp run_nonce, do: "tf" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    saved_auth = Application.get_env(:cytale, :auth)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    on_exit(fn ->
      case saved_auth do
        nil -> Application.delete_env(:cytale, :auth)
        kw when is_list(kw) -> Application.put_env(:cytale, :auth, kw)
      end
    end)

    # The suite's default posture: switch OFF (the shipped default — every
    # "mode on" test flips it explicitly and the setup restore undoes it).
    set_two_factor_mode(false)

    {:ok, conn: conn}
  end

  # The OIDC stub's REAL listener (one per run; the bypass test configures
  # the surface itself and restores the env).
  setup_all do
    {:ok, socket} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)

    base_url = "http://127.0.0.1:#{port}"
    start_supervised!({StubProvider, base_url: base_url, port: port})

    {:ok, base_url: base_url}
  end

  # -- fixtures ------------------------------------------------------------------

  defp set_two_factor_mode(mode) do
    auth = Application.get_env(:cytale, :auth, [])
    Application.put_env(:cytale, :auth, Keyword.put(auth, :two_factor_enabled, mode))
    mode
  end

  defp create_user do
    username = run_unique("tf_user")
    {:ok, user} = User.create(username, run_unique("tf@example.com"), "password-123")
    user
  end

  # An account past the verification choke point (the settings-facing flows
  # in this suite mirror a real verified member; the forced walk needs no
  # verification — it is the LOGIN surface).
  defp create_verified_user do
    user = create_user()
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)
    User.get(user.user_id)
  end

  defp auth_conn(conn, user) do
    put_req_header(conn, "authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp login(conn, user) do
    post(conn, "/api/v1/auth/login", %{"identifier" => user.username, "password" => "password-123"})
  end

  defp assert_uniform_401(resp) do
    assert resp.status == 401
    assert %{"error" => %{"key" => "invalid_credentials"}} = json_response(resp, 401)
  end

  # The middle of the CURRENT 30s step (or the next one when we are within
  # ~5s of the boundary) — the server verifies with ITS clock, so the test
  # aligns to mid-step and stays ≥5s from any boundary: no flaky step flip
  # mid-request.
  # A time inside the CURRENT 30 s step, safely away from its edges. Near the
  # end of a step it waits for the next one rather than returning a time in
  # the future: the server verifies against its own clock, so a "middle of the
  # next step" answer made the ±1 test's `aligned + 30` code two steps ahead of
  # the server — refused whenever the test ran in a step's last 5 s (CI flake).
  defp mid_step do
    unix = System.system_time(:second)
    rem_ = rem(unix, 30)

    if rem_ > 24 do
      Process.sleep((30 - rem_ + 1) * 1000)
      mid_step()
    else
      unix - rem_ + 15
    end
  end

  defp code_at(secret, unix), do: elem(TOTP.code_for(secret, unix), 1)

  # The settings-surface enrollment (Bearer): start → confirm with a valid
  # code. Returns the confirmed secret.
  defp enroll_via_settings(conn, user) do
    resp = post(auth_conn(conn, user), "/api/v1/auth/2fa/enroll/start", %{})
    assert resp.status == 200, "start failed: #{resp.status} #{resp.resp_body}"
    %{"secret" => secret} = json_response(resp, 200)

    confirm = post(auth_conn(conn, user), "/api/v1/auth/2fa/enroll/confirm", %{"code" => code_at(secret, mid_step())})
    assert confirm.status == 200, "confirm failed: #{confirm.status} #{confirm.resp_body}"

    secret
  end

  # ---------------------------------------------------------------------------
  # Mode OFF — the feature is fully absent (the default)
  # ---------------------------------------------------------------------------

  describe "switch off (default)" do
    test "non-enrolled login is IDENTICAL to today: the token pair, no status key", %{conn: conn} do
      user = create_user()

      resp = login(conn, user)
      assert resp.status == 200
      body = json_response(resp, 200)

      assert Map.has_key?(body, "access_token")
      assert Map.has_key?(body, "refresh_token")
      refute Map.has_key?(body, "status")
      refute Map.has_key?(body, "grant")
      assert {:ok, claims} = Auth.verify_access_token(body["access_token"])
      assert claims.user_id == user.user_id
    end

    test "no enrollment surface answers: enroll refuses 403 two_factor_disabled", %{conn: conn} do
      user = create_user()

      # Verify is not switch-gated (an ENROLLED account is challenged with the
      # switch off too); with no live grant it gives the uniform 401.
      assert_uniform_401(post(auth_conn(conn, user), "/api/v1/auth/2fa/verify", %{"grant" => "g", "code" => "123456"}))

      for {path, body} <- [
            {"/api/v1/auth/2fa/enroll/start", %{}},
            {"/api/v1/auth/2fa/enroll/confirm", %{"code" => "123456"}}
          ] do
        resp = post(auth_conn(conn, user), path, body)
        assert resp.status == 403, "#{path} answered #{resp.status}"
        assert %{"error" => %{"key" => "two_factor_disabled"}} = json_response(resp, 403)
      end

      # The grant-only path refuses the same way (no bearer to fall back to).
      resp = post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => "g"})
      assert resp.status == 403
    end

    test "methods reports the switch — the cheap seam both the login page and settings read", %{conn: conn} do
      assert %{"two_factor" => false} = json_response(get(conn, "/api/v1/auth/methods"), 200)

      set_two_factor_mode(true)
      assert %{"two_factor" => true} = json_response(get(conn, "/api/v1/auth/methods"), 200)
    end
  end

  # ---------------------------------------------------------------------------
  # Mode ON, account NOT enrolled — the FORCED walk
  # ---------------------------------------------------------------------------

  describe "forced enrollment (mode on, unenrolled)" do
    test "password verified is NOT enough: enrollment grant + enrollment_required, NO tokens", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)

      resp = login(conn, user)
      assert resp.status == 200
      body = json_response(resp, 200)

      assert body["status"] == "enrollment_required"
      assert is_binary(body["grant"]) and body["grant"] != ""
      assert body["user"]["id"] == Integer.to_string(user.user_id)
      assert body["user"]["username"] == user.username
      # No tokens: the grant cannot reach the shell.
      refute Map.has_key?(body, "access_token")
      refute Map.has_key?(body, "refresh_token")

      # And nothing armed server-side: the account is still not enrolled.
      refute TwoFactor.enrolled?(user.user_id)
    end

    test "skipping is impossible: the enrollment grant is worthless at /verify", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)

      %{"grant" => grant} = json_response(login(conn, user), 200)

      # The only token-minting endpoint refuses the enrollment grant —
      # single-purpose — and any code with it.
      assert_uniform_401(post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => "123456"}))
      assert_uniform_401(post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => "000000"}))
      # And a forged grant id is the same uniform refusal.
      assert_uniform_401(post(conn, "/api/v1/auth/2fa/verify", %{"grant" => "forged", "code" => "123456"}))
    end

    test "the walk: start returns the secret + otpauth URI data (the CLIENT renders the QR)", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)
      %{"grant" => grant} = json_response(login(conn, user), 200)

      resp = post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => grant})
      assert resp.status == 200
      body = json_response(resp, 200)

      assert %{"secret" => secret, "otpauth_uri" => uri, "algorithm" => "SHA1", "digits" => 6, "period" => 30} = body
      assert uri =~ "otpauth://totp/Hrmny%3A#{user.username}"
      assert uri =~ "secret=#{secret}"
      # A real 20-byte base32 secret.
      assert {:ok, raw} = Base.decode32(secret, case: :mixed, padding: false)
      assert byte_size(raw) == 20
    end

    test "a WRONG code refuses the confirm and arms nothing; the walk re-prompts", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)
      %{"grant" => grant} = json_response(login(conn, user), 200)

      start = post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => grant})
      %{"secret" => secret} = json_response(start, 200)

      resp = post(conn, "/api/v1/auth/2fa/enroll/confirm", %{"grant" => grant, "code" => "000000"})
      assert resp.status == 400
      assert %{"error" => %{"key" => "invalid_code"}} = json_response(resp, 400)

      # Confirm-before-persist: the candidate never armed the gate...
      refute TwoFactor.enrolled?(user.user_id)

      # ...and the account still owes enrollment at its next login.
      assert %{"status" => "enrollment_required"} = json_response(login(conn, user), 200)

      _ = secret
    end

    test "the RIGHT code completes the walk: tokens + armed enrollment", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)
      %{"grant" => grant} = json_response(login(conn, user), 200)

      start = post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => grant})
      %{"secret" => secret} = json_response(start, 200)

      resp = post(conn, "/api/v1/auth/2fa/enroll/confirm", %{"grant" => grant, "code" => code_at(secret, mid_step())})
      assert resp.status == 200, "confirm failed: #{resp.status} #{resp.resp_body}"
      body = json_response(resp, 200)

      # The EXACT login token-pair shape, and a pair that WORKS.
      assert MapSet.new(Map.keys(body))
             |> MapSet.subset?(MapSet.new(~w(user access_token refresh_token token_type expires_in email_verified)))

      assert {:ok, claims} = Auth.verify_access_token(body["access_token"])
      assert claims.user_id == user.user_id
      assert Auth.refresh_token_valid?(user.user_id, body["refresh_token"])

      assert TwoFactor.enrolled?(user.user_id)
    end

    test "the grant is spent by the walk's exit — it cannot mint a second pair", %{conn: conn} do
      user = create_user()
      set_two_factor_mode(true)
      %{"grant" => grant} = json_response(login(conn, user), 200)

      %{"secret" => secret} = json_response(post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => grant}), 200)

      assert post(conn, "/api/v1/auth/2fa/enroll/confirm", %{"grant" => grant, "code" => code_at(secret, mid_step())}).status ==
               200

      assert_uniform_401(
        post(conn, "/api/v1/auth/2fa/enroll/confirm", %{"grant" => grant, "code" => code_at(secret, mid_step())})
      )

      assert_uniform_401(post(conn, "/api/v1/auth/2fa/enroll/start", %{"grant" => grant}))
    end
  end

  # ---------------------------------------------------------------------------
  # Mode ON, account ENROLLED — the TOTP challenge at every password login
  # ---------------------------------------------------------------------------

  describe "TOTP challenge (mode on, enrolled)" do
    test "password is not enough either: totp_pending grant, then verify swaps for the pair", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)

      resp = login(conn, user)
      assert resp.status == 200
      body = json_response(resp, 200)

      assert body["status"] == "totp_pending"
      assert is_binary(body["grant"]) and body["grant"] != ""
      refute Map.has_key?(body, "access_token")

      verify = post(conn, "/api/v1/auth/2fa/verify", %{"grant" => body["grant"], "code" => code_at(secret, mid_step())})
      assert verify.status == 200
      pair = json_response(verify, 200)

      assert Map.has_key?(pair, "access_token") and Map.has_key?(pair, "refresh_token")
      refute Map.has_key?(pair, "status")
      assert {:ok, claims} = Auth.verify_access_token(pair["access_token"])
      assert claims.user_id == user.user_id
    end

    test "wrong code: the uniform 401, and the grant is spent (one code shot per password)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)

      %{"grant" => grant} = json_response(login(conn, user), 200)

      assert_uniform_401(post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => "000000"}))

      # Even the CORRECT code can't reuse the spent grant — the walk restarts
      # at the password (the #36 challenge posture, applied to the 2FA step).
      assert_uniform_401(
        post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => code_at(secret, mid_step())})
      )
    end

    test "REPLAYED code refused: used-code tracking (a code can never be accepted twice)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)

      # Login #1: the code verifies and its step is recorded.
      %{"grant" => grant1} = json_response(login(conn, user), 200)
      code = code_at(secret, mid_step())

      assert post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant1, "code" => code}).status == 200

      # Login #2 (fresh password step, fresh grant): the SAME code is refused
      # — the step floor moved onto it, even though it is still inside its
      # own ±1 window.
      %{"grant" => grant2} = json_response(login(conn, user), 200)

      assert_uniform_401(post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant2, "code" => code}))
    end

    test "±1 step window honored in BOTH directions (clock drift tolerance)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)
      aligned = mid_step()

      # Previous step's code (a slightly slow authenticator).
      %{"grant" => g1} = json_response(login(conn, user), 200)
      slow = post(conn, "/api/v1/auth/2fa/verify", %{"grant" => g1, "code" => code_at(secret, aligned - 30)})
      assert slow.status == 200, "prev-step code refused: #{slow.status} #{slow.resp_body}"

      # Next step's code (a slightly fast one) — a FRESH code, not the replay.
      %{"grant" => g2} = json_response(login(conn, user), 200)
      fast = post(conn, "/api/v1/auth/2fa/verify", %{"grant" => g2, "code" => code_at(secret, aligned + 30)})
      assert fast.status == 200, "next-step code refused: #{fast.status} #{fast.resp_body}"

      # Two steps away is outside the window.
      %{"grant" => g3} = json_response(login(conn, user), 200)

      assert_uniform_401(
        post(conn, "/api/v1/auth/2fa/verify", %{"grant" => g3, "code" => code_at(secret, aligned - 60)})
      )
    end

    test "expired grant refused (the uniform refusal, not a crash)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)

      # Hand-plant an already-expired grant (the store's TTL sweep would
      # remove it; consuming it directly is the deterministic path).
      :ets.insert(Grants, {"expired-grant-127", :totp, user.user_id, 0, System.system_time(:millisecond) - 1})

      assert_uniform_401(
        post(conn, "/api/v1/auth/2fa/verify", %{"grant" => "expired-grant-127", "code" => code_at(secret, mid_step())})
      )
    end

    test "verify without the code fields is a 400, not a refusal oracle", %{conn: conn} do
      resp = post(conn, "/api/v1/auth/2fa/verify", %{})
      assert resp.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = json_response(resp, 400)
    end
  end

  # ---------------------------------------------------------------------------
  # Switch hot-apply — enforcement reads at login
  # ---------------------------------------------------------------------------

  describe "switch hot-apply" do
    test "off → on applies at the NEXT login without a restart", %{conn: conn} do
      user = create_user()

      # Off: pair.
      assert Map.has_key?(json_response(login(conn, user), 200), "access_token")

      # Flip ON (the Server Settings save's hot-apply, observed at the seam).
      set_two_factor_mode(true)

      # The NEXT login enforces.
      assert %{"status" => "enrollment_required"} = json_response(login(conn, user), 200)
    end

    test "on → off: an ENROLLED account is still challenged (the switch governs enrolment only)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      secret = enroll_via_settings(conn, user)

      # Enrolled + on: challenged.
      assert %{"status" => "totp_pending"} = json_response(login(conn, user), 200)

      # Flip OFF: the enrollment row SURVIVES and still arms the challenge —
      # turning the switch off must not silently strip a second factor.
      set_two_factor_mode(false)
      assert TwoFactor.enrolled?(user.user_id)
      body = json_response(login(conn, user), 200)
      assert %{"status" => "totp_pending", "grant" => grant} = body
      refute Map.has_key?(body, "access_token")

      # …and the challenge completes with the switch still off.
      # (The next step's code: the enrollment confirm spent the current one.)
      verify = post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => code_at(secret, mid_step() + 30)})
      assert %{"access_token" => _, "refresh_token" => _} = json_response(verify, 200)

      # A never-enrolled account keeps the plain pair with the switch off.
      other = create_user()
      assert Map.has_key?(json_response(login(conn, other), 200), "access_token")

      status = json_response(get(auth_conn(conn, user), "/api/v1/users/@me/two-factor"), 200)
      assert %{"mode_enabled" => false, "enrolled" => true} = status

      # Flip back ON: the retained enrollment re-arms the challenge.
      set_two_factor_mode(true)
      assert %{"status" => "totp_pending"} = json_response(login(conn, user), 200)

      _ = secret
    end
  end

  # ---------------------------------------------------------------------------
  # Passkey + OIDC logins mint tokens DIRECTLY (the documented line)
  # ---------------------------------------------------------------------------

  describe "multifactor login paths are exempt from the gate" do
    test "passkey login mints tokens with mode ON and the account NOT enrolled", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)

      # Enroll a passkey (the settings ceremony) and log in with it.
      authenticator = Fixtures.new()
      conn = auth_conn(conn, user)

      %{challenge_id: challenge_id, options: options} = webauthn_reg_options(conn)
      {att, cdj} = Fixtures.register_response(authenticator, options)

      reg =
        post(conn, "/api/v1/auth/webauthn/register/verify", %{
          "challenge_id" => challenge_id,
          "name" => "2fa bypass key",
          "response" => %{
            "id" => Fixtures.encode_b64url(authenticator.credential_id_raw),
            "rawId" => Fixtures.encode_b64url(authenticator.credential_id_raw),
            "type" => "public-key",
            "response" => %{"clientDataJSON" => cdj, "attestationObject" => att}
          }
        })

      assert reg.status == 200, "passkey enrollment failed: #{reg.status} #{reg.resp_body}"

      %{challenge_id: login_challenge, options: login_options} = webauthn_login_options(conn)
      {auth_data, sig, login_cdj} = Fixtures.assertion(authenticator, login_options)

      login =
        post(
          build_conn()
          |> put_req_header("accept", "application/json")
          |> put_req_header("content-type", "application/json"),
          "/api/v1/auth/webauthn/login/verify",
          %{
            "challenge_id" => login_challenge,
            "response" => %{
              "id" => Fixtures.encode_b64url(authenticator.credential_id_raw),
              "rawId" => Fixtures.encode_b64url(authenticator.credential_id_raw),
              "type" => "public-key",
              "response" => %{
                "clientDataJSON" => login_cdj,
                "authenticatorData" => auth_data,
                "signature" => sig,
                "userHandle" => nil
              }
            }
          }
        )

      assert login.status == 200, "passkey login failed: #{login.status} #{login.resp_body}"
      pair = json_response(login, 200)

      # NO 2FA gate: the token pair, directly — no status/grant branch.
      assert Map.has_key?(pair, "access_token")
      refute Map.has_key?(pair, "status")
      refute Map.has_key?(pair, "grant")
      assert {:ok, claims} = Auth.verify_access_token(pair["access_token"])
      assert claims.user_id == user.user_id
    end
  end

  # -- WebAuthn ceremony helpers (mirroring webauthn_controller_test) ----------

  defp webauthn_reg_options(conn) do
    resp = post(conn, "/api/v1/auth/webauthn/register/options")
    assert resp.status == 200
    %{"challenge_id" => challenge_id, "public_key" => public_key} = json_response(resp, 200)
    %{challenge_id: challenge_id, options: public_key}
  end

  defp webauthn_login_options(conn) do
    resp = post(conn, "/api/v1/auth/webauthn/login/options")
    assert resp.status == 200
    %{"challenge_id" => challenge_id, "public_key" => public_key} = json_response(resp, 200)
    %{challenge_id: challenge_id, options: public_key}
  end

  # ---------------------------------------------------------------------------
  # OIDC — via the REAL stub provider (the #12 suite's machinery)
  # ---------------------------------------------------------------------------

  describe "OIDC bypass" do
    test "OIDC login mints tokens directly with mode ON — provider mediation is the second factor", %{
      conn: conn,
      base_url: base_url
    } do
      saved = Map.new(@oidc_env_keys, fn k -> {k, Application.get_env(:cytale, k)} end)

      Application.put_env(:cytale, :oidc, %{
        enabled: true,
        issuer_url: base_url,
        client_id: @oidc_client_id,
        scopes: "openid email profile",
        button_label: "Sign in with Company SSO"
      })

      Application.put_env(:cytale, :server_secrets, %{"oidc_client_secret" => @oidc_client_secret})
      Application.put_env(:cytale, :registration_open, true)
      Application.put_env(:cytale, :require_verified_email, true)
      StubProvider.reset(client_id: @oidc_client_id, client_secret: @oidc_client_secret)
      Cytale.OIDC.Discovery.clear()

      on_exit(fn ->
        Enum.each(@oidc_env_keys, fn k ->
          case Map.fetch(saved, k) do
            {:ok, nil} -> Application.delete_env(:cytale, k)
            {:ok, value} -> Application.put_env(:cytale, k, value)
          end
        end)
      end)

      set_two_factor_mode(true)

      # A provider identity for an account with NO password and NO enrollment.
      email = run_unique("oidc-127@example.com")

      StubProvider.put_claims(%{
        "email" => email,
        "email_verified" => true,
        "preferred_username" => run_unique("oidc127")
      })

      start = post(conn, "/api/v1/auth/oidc/start", %{})
      assert start.status == 200
      %{"authorize_url" => authorize_url} = json_response(start, 200)

      %{code: code, state: state} =
        StubProvider.redeem_authorize_url(authorize_url)
        |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)

      callback = post(conn, "/api/v1/auth/oidc/callback", %{"code" => code, "state" => state})
      assert callback.status == 200, "oidc callback failed: #{callback.status} #{callback.resp_body}"
      pair = json_response(callback, 200)

      # The gate never fired: tokens, directly.
      assert Map.has_key?(pair, "access_token")
      refute Map.has_key?(pair, "status")
      refute Map.has_key?(pair, "grant")

      user = User.get_by_identifier(email)
      assert user != nil
      refute TwoFactor.enrolled?(user.user_id)
    end

    # Security (Tier 3 #1b): SSO proves the address, not the account's own
    # second factor. An ENROLLED account signing in through the provider owes
    # the same TOTP challenge the password path does.
    test "an ENROLLED account's OIDC login owes the TOTP step: totp_pending + grant, no tokens; verify mints the pair",
         %{
           conn: conn,
           base_url: base_url
         } do
      configure_oidc(base_url)
      set_two_factor_mode(true)

      user = create_verified_user()
      secret = enroll_via_settings(conn, user)
      assert TwoFactor.enrolled?(user.user_id)

      StubProvider.put_claims(%{"email" => user.email, "email_verified" => true})

      start = post(conn, "/api/v1/auth/oidc/start", %{"return_to" => "/channels/42"})
      assert start.status == 200
      %{"authorize_url" => authorize_url} = json_response(start, 200)

      %{code: code, state: state} =
        StubProvider.redeem_authorize_url(authorize_url)
        |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)

      callback = post(conn, "/api/v1/auth/oidc/callback", %{"code" => code, "state" => state})
      assert callback.status == 200, "oidc callback failed: #{callback.status} #{callback.resp_body}"
      body = json_response(callback, 200)

      # The password path's step shape, plus the continuation.
      assert body["status"] == "totp_pending"
      assert is_binary(body["grant"])
      assert body["user"] == %{"id" => Integer.to_string(user.user_id), "username" => user.username}
      assert body["return_to"] == "/channels/42"
      refute Map.has_key?(body, "access_token")
      refute Map.has_key?(body, "refresh_token")

      # The grant is the ordinary :totp grant: /2fa/verify swaps it.
      verify = post(conn, "/api/v1/auth/2fa/verify", %{"grant" => body["grant"], "code" => code_at(secret, mid_step())})
      assert verify.status == 200, "verify failed: #{verify.status} #{verify.resp_body}"
      pair = json_response(verify, 200)
      assert {:ok, claims} = Auth.verify_access_token(pair["access_token"])
      assert claims.user_id == user.user_id
    end

    test "switch OFF: an enrolled account's OIDC login is the plain pair (retention posture)", %{
      conn: conn,
      base_url: base_url
    } do
      configure_oidc(base_url)
      set_two_factor_mode(true)
      user = create_verified_user()
      _secret = enroll_via_settings(conn, user)
      set_two_factor_mode(false)

      StubProvider.put_claims(%{"email" => user.email, "email_verified" => true})

      start = post(conn, "/api/v1/auth/oidc/start", %{})
      %{"authorize_url" => authorize_url} = json_response(start, 200)

      %{code: code, state: state} =
        StubProvider.redeem_authorize_url(authorize_url)
        |> Map.new(fn {k, v} -> {String.to_atom(k), v} end)

      body = json_response(post(conn, "/api/v1/auth/oidc/callback", %{"code" => code, "state" => state}), 200)
      assert Map.has_key?(body, "access_token")
      refute Map.has_key?(body, "status")
    end
  end

  defp configure_oidc(base_url) do
    saved = Map.new(@oidc_env_keys, fn k -> {k, Application.get_env(:cytale, k)} end)

    Application.put_env(:cytale, :oidc, %{
      enabled: true,
      issuer_url: base_url,
      client_id: @oidc_client_id,
      scopes: "openid email profile",
      button_label: "Sign in with Company SSO"
    })

    Application.put_env(:cytale, :server_secrets, %{"oidc_client_secret" => @oidc_client_secret})
    Application.put_env(:cytale, :registration_open, true)
    Application.put_env(:cytale, :require_verified_email, true)
    StubProvider.reset(client_id: @oidc_client_id, client_secret: @oidc_client_secret)
    Cytale.OIDC.Discovery.clear()

    on_exit(fn ->
      Enum.each(@oidc_env_keys, fn k ->
        case Map.fetch(saved, k) do
          {:ok, nil} -> Application.delete_env(:cytale, k)
          {:ok, value} -> Application.put_env(:cytale, k, value)
        end
      end)
    end)
  end

  # ---------------------------------------------------------------------------
  # Recovery + management
  # ---------------------------------------------------------------------------

  describe "password reset clears the enrollment (the recovery line)" do
    test "reset completion drops 2FA; the next login re-prompts enrollment", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      _secret = enroll_via_settings(conn, user)
      assert TwoFactor.enrolled?(user.user_id)

      # The reset: request → the dev mailbox token → complete.
      token =
        Cytale.TestMailbox.capture(
          fn -> Verification.request_password_reset(user.email) end,
          "password_reset",
          user.email
        )

      assert :ok = Verification.complete_password_reset(token, "brand-new-password-99")

      refute TwoFactor.enrolled?(user.user_id)

      # The new password alone is not enough while the switch is on: the
      # account re-prompts enrollment (exactly the recovery contract).
      resp =
        post(conn, "/api/v1/auth/login", %{"identifier" => user.username, "password" => "brand-new-password-99"})

      assert %{"status" => "enrollment_required"} = json_response(resp, 200)
    end
  end

  describe "settings management (the authenticated pair)" do
    test "status reports mode + enrollment; unauthenticated reads are 401", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)

      assert %{"mode_enabled" => true, "enrolled" => false} =
               json_response(get(auth_conn(conn, user), "/api/v1/users/@me/two-factor"), 200)

      secret = enroll_via_settings(conn, user)

      status = json_response(get(auth_conn(conn, user), "/api/v1/users/@me/two-factor"), 200)
      assert %{"mode_enabled" => true, "enrolled" => true, "confirmed_at" => confirmed_at} = status
      assert is_binary(confirmed_at)
      # Never used yet.
      assert status["last_used_at"] == nil

      # A login verify stamps last_used_at.
      %{"grant" => grant} = json_response(login(conn, user), 200)

      assert post(conn, "/api/v1/auth/2fa/verify", %{"grant" => grant, "code" => code_at(secret, mid_step())}).status ==
               200

      status2 = json_response(get(auth_conn(conn, user), "/api/v1/users/@me/two-factor"), 200)
      assert is_binary(status2["last_used_at"])

      assert get(conn, "/api/v1/users/@me/two-factor").status == 401
    end

    test "remove while ON is allowed; the next password login RE-PROMPTS enrollment", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      _secret = enroll_via_settings(conn, user)

      assert delete(auth_conn(conn, user), "/api/v1/users/@me/two-factor").status == 204
      refute TwoFactor.enrolled?(user.user_id)

      # No self-lockout: the removal completed, the re-enrollment happens at
      # the next login.
      assert %{"status" => "enrollment_required"} = json_response(login(conn, user), 200)

      # Idempotent: removing a non-existent enrollment is still a 204.
      assert delete(auth_conn(conn, user), "/api/v1/users/@me/two-factor").status == 204
      assert delete(conn, "/api/v1/users/@me/two-factor").status == 401
    end

    test "enroll/start with a CONFIRMED enrollment refuses 409 (a secret is never silently re-rolled)", %{conn: conn} do
      user = create_verified_user()
      set_two_factor_mode(true)
      _secret = enroll_via_settings(conn, user)

      resp = post(auth_conn(conn, user), "/api/v1/auth/2fa/enroll/start", %{})
      assert resp.status == 409
      assert %{"error" => %{"key" => "already_enrolled"}} = json_response(resp, 409)
    end
  end

  # ---------------------------------------------------------------------------
  # The grant store's own edges (unit-level, through the public API)
  # ---------------------------------------------------------------------------

  describe "grants" do
    test "single-purpose: kinds are checked on peek and consume" do
      user = create_user()
      grant = Grants.put(:enrollment, user.user_id)

      assert {:error, :invalid} = Grants.peek(grant, :totp)
      assert {:error, :invalid} = Grants.consume(grant, :totp)
      assert {:ok, %{user_id: spent_id}} = Grants.consume(grant, :enrollment)
      assert spent_id == user.user_id
      # Spent.
      assert {:error, :invalid} = Grants.consume(grant, :enrollment)
    end

    test "failure budget: bounded wrong codes, then the grant dies" do
      user = create_user()
      grant = Grants.put(:totp, user.user_id)

      for _ <- 1..4, do: assert(:ok = Grants.fail(grant, :totp))
      assert {:ok, _} = Grants.peek(grant, :totp)

      # The fifth wrong code destroys the grant.
      assert :ok = Grants.fail(grant, :totp)
      assert {:error, :invalid} = Grants.peek(grant, :totp)
    end

    test "unknown grants are the one uniform invalid" do
      assert {:error, :invalid} = Grants.consume("no-such-grant", :totp)
      assert {:error, :invalid} = Grants.peek("", :enrollment)
      assert {:error, :invalid} = Grants.fail("no-such-grant", :totp)
    end
  end

  # ---------------------------------------------------------------------------
  # Schema / settings-editor gate for the new key
  # ---------------------------------------------------------------------------

  describe "the auth.two_factor_enabled schema key" do
    test "validates as a runtime boolean; garbage refuses" do
      key = Cytale.ServerConfig.Schema.key("auth.two_factor_enabled")
      assert key != nil
      assert key.scope == :runtime
      assert key.default == false
      assert key.editor

      assert [] = Cytale.ServerConfig.Schema.validate_value(key, true)
      assert [] = Cytale.ServerConfig.Schema.validate_value(key, false)
      refute Cytale.ServerConfig.Schema.validate_value(key, "yes") == []

      assert :ok =
               Cytale.ServerConfig.Schema.validate_document(%{"auth" => %{"two_factor_enabled" => true}})

      assert {:error, [_]} =
               Cytale.ServerConfig.Schema.validate_document(%{"auth" => %{"two_factor_enabled" => "maybe"}})
    end

    test "the settings/editor round trip preserves the new key and hot-applies", %{conn: conn} do
      user = create_user()
      Application.put_env(:cytale, :operator_user_ids, [user.user_id])
      on_exit(fn -> Application.delete_env(:cytale, :operator_user_ids) end)

      dir = Path.join(System.tmp_dir!(), "cytale-2fa-srvcfg-#{System.unique_integer([:positive])}")
      File.mkdir_p!(dir)
      config_path = Path.join(dir, "config.json")
      Application.put_env(:cytale, :server_config_path, config_path)
      Application.delete_env(:cytale, :server_secrets_path)

      on_exit(fn ->
        Application.delete_env(:cytale, :server_config_path)
        File.rm_rf!(dir)
      end)

      # First-boot generation, then the operator's PUT of the new key.
      capture_log(fn -> Cytale.ServerConfig.boot!() end)
      conn = auth_conn(conn, user)

      put =
        put(conn, "/api/v1/admin/config", %{"auth" => %{"two_factor_enabled" => true}})

      assert put.status == 200, "save failed: #{put.status} #{put.resp_body}"

      # Hot-applied NOW (runtime scope) — the enforcement seam reads it.
      assert Cytale.Config.two_factor_enabled?() == true

      # And preserved in the served document.
      get_resp = get(conn, "/api/v1/admin/config")
      assert %{"config" => config} = json_response(get_resp, 200)
      assert get_in(config, ["auth", "two_factor_enabled"]) == true

      set_two_factor_mode(false)
    end
  end
end
