defmodule CytaleWeb.Controllers.AuthControllerTest do
  @moduledoc """
  U8 — REST auth surface integration tests: real Phoenix router → real
  controller → real accounts stack → real ScyllaDB (per-run cytale_test
  keyspace, hermetic-test policy: module-owned pool, drop/reapply per test).
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Accounts.{Auth, TokenStore, User}

  # Run-scoped unique suffix for fixture identifiers: distinct per `mix test`
  # invocation, so a crashed previous run can never collide (the keyspace is
  # no longer dropped per module — schema apply is too slow to repeat).
  # Run-scoped unique suffix for fixture identifiers: computed once when the
  # test module compiles (i.e., once per `mix test` invocation), so fixtures
  # from a crashed previous run can never collide — the keyspace is not
  # dropped per module because schema apply is too slow to repeat.

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, conn: conn}
  end

  # ---------------------------------------------------------------------------
  # Logout
  # ---------------------------------------------------------------------------

  test "logout revokes the refresh token; subsequent refresh is refused", %{conn: conn} do
    username = run_unique("lo_user")
    {:ok, user} = User.create(username, run_unique("lo@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    # What the client actually holds after login.
    {:ok, refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)

    authed =
      put_req_header(conn, "authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

    out = post(authed, "/api/v1/auth/logout", %{"refresh_token" => refresh})
    assert out.status == 200
    assert %{"logged_out" => true} = Jason.decode!(out.resp_body)

    # The revoked token can no longer rotate.
    ref = post(authed, "/api/v1/auth/refresh", %{"refresh_token" => refresh})
    assert ref.status == 401
  end

  # ---------------------------------------------------------------------------
  # Register
  # ---------------------------------------------------------------------------

  test "register → 201 + tokens + view-only account", %{conn: conn} do
    log =
      capture_log(fn ->
        response =
          post(conn, "/api/v1/auth/register", %{
            "username" => run_unique("gina"),
            "email" => run_unique("gina@example.com"),
            "password" => "super-secret-9"
          })

        assert response.status == 201
        send(self(), {:body, response.resp_body})
      end)

    assert_receive {:body, body}

    assert %{
             "user" => %{"username" => _gina},
             "access_token" => access,
             "refresh_token" => refresh,
             "token_type" => "Bearer",
             "email_verified" => false
           } = Jason.decode!(body)

    assert is_binary(access) and is_binary(refresh)
    assert log =~ "verify_email mail for"
  end

  # The live-box regression (2026-09-10): CYTALE_MAILER=dev with the
  # CWD-relative mailbox on a container whose rootfs is read-only. File.write!
  # raised inside the adapter AFTER User.create had committed, so every
  # register answered 500 for a registration that had in fact succeeded — the
  # username was burned and no token was ever delivered. Register must survive
  # its mail sink, and a resend must still deliver once the sink is fixed.
  test "register → 201 when the mail sink is unwritable; resend still delivers", %{conn: conn} do
    blocker = Path.join(System.tmp_dir!(), "cytale-mailbox-blocker-#{run_nonce()}")
    File.write!(blocker, "")

    username = run_unique("sinkless")
    email = run_unique("sinkless@example.com")

    previous = System.get_env("CYTALE_DEV_MAILBOX")
    on_exit(fn -> restore_mailbox(previous) end)

    with_mailbox(Path.join(blocker, "dev_mailbox.jsonl"), fn ->
      log =
        capture_log(fn ->
          response =
            post(conn, "/api/v1/auth/register", %{
              "username" => username,
              "email" => email,
              "password" => "super-secret-9"
            })

          send(self(), {:register, response.status, response.resp_body})
        end)

      assert_receive {:register, 201, body}
      assert %{"access_token" => _, "email_verified" => false} = Jason.decode!(body)

      # The row is what made the old 500 so bad: it was committed either way,
      # so the client must be able to log in and resend.
      assert %{email_verified_at: nil} = User.get_by_identifier(username)
      assert log =~ "delivery FAILED"
    end)

    # Recovery: with a writable sink the resend delivers a token that works.
    with_mailbox(nil, fn ->
      token =
        Cytale.TestMailbox.capture(
          fn -> assert %{status: 200} = post(conn, "/api/v1/auth/resend-verification", %{"email" => email}) end,
          "verify_email",
          email
        )

      assert %{status: 200, resp_body: resp} = post(conn, "/api/v1/auth/verify-email", %{"token" => token})
      assert Jason.decode!(resp) == %{"verified" => true}
    end)
  end

  test "register duplicate username (case-insensitive) → 409", %{conn: conn} do
    username = run_unique("dupe_user")
    {:ok, _u} = User.create(username, run_unique("dupe1@example.com"), "password-123")

    conn =
      post(conn, "/api/v1/auth/register", %{
        "username" => String.upcase(username),
        "email" => run_unique("dupe2@example.com"),
        "password" => "password-123"
      })

    assert conn.status == 409
    # S5: ONE code for both collisions — it must not say WHICH is taken.
    assert %{"error" => %{"key" => "taken", "message" => message}} = Jason.decode!(conn.resp_body)
    assert message =~ "username or email"
  end

  test "register duplicate email → 409", %{conn: conn} do
    email = run_unique("same@example.com")
    {:ok, _u} = User.create(run_unique("email_dupe"), email, "password-123")

    conn =
      post(conn, "/api/v1/auth/register", %{
        "username" => run_unique("email_dupe2"),
        "email" => String.upcase(email),
        "password" => "password-123"
      })

    assert conn.status == 409
    # Same single code, same message shape — no oracle between the two cases.
    assert %{"error" => %{"key" => "taken", "message" => message}} = Jason.decode!(conn.resp_body)
    assert message =~ "username or email"
  end

  test "register missing fields → 400 validation_failed", %{conn: conn} do
    conn = post(conn, "/api/v1/auth/register", %{"username" => run_unique("onlyname")})
    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
  end

  # CYTALE_REGISTRATION_OPEN=false (config :cytale, registration_open: false —
  # runtime.exs): the gate answers BEFORE any validation, so a fully-valid body
  # gets the same 403 registration_closed as a malformed one (anti-oracle).
  describe "registration gate (CYTALE_REGISTRATION_OPEN)" do
    test "gate closed → 403 registration_closed for a fully-valid body", %{conn: conn} do
      Application.put_env(:cytale, :registration_open, false)
      on_exit(fn -> Application.put_env(:cytale, :registration_open, true) end)

      response =
        post(conn, "/api/v1/auth/register", %{
          "username" => run_unique("closed_gina"),
          "email" => run_unique("closed_gina@example.com"),
          "password" => "super-secret-9"
        })

      assert response.status == 403

      assert %{"error" => %{"key" => "registration_closed", "message" => msg}} =
               Jason.decode!(response.resp_body)

      assert msg == "Registration is disabled on this server"
    end

    test "gate closed → 403 before validation (malformed body still registration_closed)", %{conn: conn} do
      Application.put_env(:cytale, :registration_open, false)
      on_exit(fn -> Application.put_env(:cytale, :registration_open, true) end)

      response = post(conn, "/api/v1/auth/register", %{"username" => run_unique("onlyname")})

      assert response.status == 403
      assert %{"error" => %{"key" => "registration_closed"}} = Jason.decode!(response.resp_body)
    end

    test "gate open → register works (default posture unchanged)", %{conn: conn} do
      Application.put_env(:cytale, :registration_open, true)
      on_exit(fn -> Application.put_env(:cytale, :registration_open, true) end)

      log =
        capture_log(fn ->
          response =
            post(conn, "/api/v1/auth/register", %{
              "username" => run_unique("open_gina"),
              "email" => run_unique("open_gina@example.com"),
              "password" => "super-secret-9"
            })

          assert response.status == 201
          send(self(), {:body, response.resp_body})
        end)

      assert_receive {:body, body}

      assert %{
               "access_token" => access,
               "refresh_token" => refresh,
               "token_type" => "Bearer",
               "email_verified" => false
             } = Jason.decode!(body)

      assert is_binary(access) and is_binary(refresh)
      assert log =~ "verify_email mail for"
    end
  end

  # ---------------------------------------------------------------------------
  # Invite-gated registration (security Tier 2 #5)
  # ---------------------------------------------------------------------------

  defp register_body(name, extra \\ %{}) do
    Map.merge(
      %{
        "username" => run_unique(name),
        "email" => run_unique(name <> "@example.com"),
        "password" => "super-secret-9"
      },
      extra
    )
  end

  describe "invite-gated registration (closed sign-up)" do
    setup do
      Application.put_env(:cytale, :registration_open, false)
      on_exit(fn -> Application.put_env(:cytale, :registration_open, true) end)

      {:ok, owner} = User.create(run_unique("inv_owner"), run_unique("inv_owner@example.com"), "password-123")
      {:ok, ws} = Cytale.Workspaces.create_workspace(owner.user_id, run_unique("inv-ws"))
      {:ok, owner: owner, ws: ws}
    end

    test "a valid invite registers the account AND joins its workspace through the normal accept",
         %{conn: conn, owner: owner, ws: ws} do
      {:ok, invite} = Cytale.Workspaces.create_invite(ws.workspace_id, owner.user_id, max_uses: 1)

      resp = post(conn, "/api/v1/auth/register", register_body("inv_ok", %{"invite_code" => invite.invite_code}))
      assert resp.status == 201
      body = Jason.decode!(resp.resp_body)
      assert body["invite_accepted"] == true
      assert body["workspace_id"] == Integer.to_string(ws.workspace_id)
      assert is_binary(body["access_token"])

      user_id = String.to_integer(body["user"]["id"])
      assert Cytale.Workspaces.get_member(ws.workspace_id, user_id)

      # The seat was consumed: a max_uses: 1 invite is now exhausted.
      assert Cytale.Workspaces.get_invite(invite.invite_code) == nil

      again = post(conn, "/api/v1/auth/register", register_body("inv_two", %{"invite_code" => invite.invite_code}))
      assert again.status == 403
      assert %{"error" => %{"key" => "invite_invalid"}} = Jason.decode!(again.resp_body)
    end

    test "an unknown or expired invite is refused before any account is made", %{conn: conn, owner: owner, ws: ws} do
      unknown = post(conn, "/api/v1/auth/register", register_body("inv_bad", %{"invite_code" => "nope-nope"}))
      assert unknown.status == 403
      assert %{"error" => %{"key" => "invite_invalid"}} = Jason.decode!(unknown.resp_body)

      {:ok, invite} = Cytale.Workspaces.create_invite(ws.workspace_id, owner.user_id, max_age_s: -1)
      body = register_body("inv_exp", %{"invite_code" => invite.invite_code})
      expired = post(conn, "/api/v1/auth/register", body)
      assert expired.status == 403
      assert User.get_by_identifier(body["username"]) == nil
    end

    test "no invite on a closed server is still registration_closed", %{conn: conn} do
      resp = post(conn, "/api/v1/auth/register", register_body("inv_none"))
      assert resp.status == 403
      assert %{"error" => %{"key" => "registration_closed"}} = Jason.decode!(resp.resp_body)
    end

    test "an OPEN server honours a valid invite and ignores an invalid one", %{conn: conn, owner: owner, ws: ws} do
      Application.put_env(:cytale, :registration_open, true)
      {:ok, invite} = Cytale.Workspaces.create_invite(ws.workspace_id, owner.user_id)

      joined = post(conn, "/api/v1/auth/register", register_body("inv_open", %{"invite_code" => invite.invite_code}))
      assert joined.status == 201
      assert Jason.decode!(joined.resp_body)["invite_accepted"] == true

      plain = post(conn, "/api/v1/auth/register", register_body("inv_open2", %{"invite_code" => "nope-nope"}))
      assert plain.status == 201
      refute Map.has_key?(Jason.decode!(plain.resp_body), "invite_accepted")
    end
  end

  # ---------------------------------------------------------------------------
  # Verify email
  # ---------------------------------------------------------------------------

  test "verify-email consumes token, stamps verified, single-use", %{conn: conn} do
    {:ok, user} = User.create(run_unique("verifier"), run_unique("verifier@example.com"), "password-123")
    assert is_nil(User.get(user.user_id).email_verified_at)

    token = captured_verify_token(user.user_id)

    conn = post(conn, "/api/v1/auth/verify-email", %{"token" => token})
    assert conn.status == 200
    refute is_nil(User.get(user.user_id).email_verified_at)

    # Single use: second attempt → 410 token_consumed.
    conn2 =
      post(build_conn() |> put_req_header("content-type", "application/json"), "/api/v1/auth/verify-email", %{
        "token" => token
      })

    assert conn2.status == 410
    assert %{"error" => %{"key" => "token_consumed"}} = Jason.decode!(conn2.resp_body)
  end

  test "verify-email with garbage token → 410", %{conn: conn} do
    conn = post(conn, "/api/v1/auth/verify-email", %{"token" => "not-a-token"})
    assert conn.status == 410
  end

  # ---------------------------------------------------------------------------
  # Login / refresh
  # ---------------------------------------------------------------------------

  test "login with username variants or email; wrong password → 401", %{conn: conn} do
    username = run_unique("login_user")
    email = run_unique("login_user@example.com")
    {:ok, _user} = User.create(username, email, "password-123")

    for ident <- [username, String.upcase(username), email] do
      conn = post(conn, "/api/v1/auth/login", %{"identifier" => ident, "password" => "password-123"})
      assert conn.status == 200

      assert %{"access_token" => access, "refresh_token" => refresh, "email_verified" => false} =
               Jason.decode!(conn.resp_body)

      assert is_binary(access) and is_binary(refresh)
    end

    conn = post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "wrong-pass-1"})

    assert conn.status == 401
    assert %{"error" => %{"key" => "invalid_credentials"}} = Jason.decode!(conn.resp_body)
  end

  # Lane D #4: boot was refresh → GET /users/@me → gateway, one serial round
  # trip too many. The exchange now hands back the account in the @me shape
  # (the SAME builder), so a restoring client adopts it and skips the read.
  test "refresh returns the account in the @me shape", %{conn: conn} do
    {:ok, user} = User.create(run_unique("refresh_me"), run_unique("refresh_me@example.com"), "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, false)
    {:ok, raw_refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_refresh})

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)

    me =
      build_conn()
      |> put_req_header("authorization", "Bearer " <> body["access_token"])
      |> get("/api/v1/users/@me")
      |> Map.fetch!(:resp_body)
      |> Jason.decode!()
      |> Map.fetch!("user")

    assert body["user"] == me
    assert body["user"]["kind"] == "human"
    assert Map.has_key?(body["user"], "is_operator")
  end

  test "login returns the account in the @me shape", %{conn: conn} do
    username = run_unique("login_me")
    {:ok, _user} = User.create(username, run_unique("login_me@example.com"), "password-123")

    conn = post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "password-123"})
    assert conn.status == 200
    user = Jason.decode!(conn.resp_body)["user"]

    assert user["username"] == username
    assert user["kind"] == "human"
    assert Map.has_key?(user, "is_operator")
    assert Map.has_key?(user, "avatar_url")
  end

  test "refresh rotates; replay of the rotated-away token → 401 refresh_revoked", %{conn: conn} do
    {:ok, user} = User.create(run_unique("refresh_user"), run_unique("refresh_user@example.com"), "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, false)
    {:ok, raw_refresh, _hash, _exp} = Auth.issue_refresh_token(user.user_id)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_refresh})

    assert conn.status == 200
    assert %{"access_token" => new_access, "refresh_token" => new_refresh} = Jason.decode!(conn.resp_body)
    assert is_binary(new_access) and new_refresh != raw_refresh

    # Replay the ORIGINAL refresh token → 401 (rotation revoked it).
    conn2 =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_refresh})

    assert conn2.status == 401
    assert %{"error" => %{"key" => "refresh_revoked"}} = Jason.decode!(conn2.resp_body)
  end

  # S6: a replayed (already-rotated) refresh token is not merely refused —
  # the replay SIGNAL kills the whole family, so any token the attacker
  # parallel-stole dies with the probe.
  test "replaying a consumed refresh token revokes the SURVIVING tokens too", %{conn: conn} do
    {:ok, user} = User.create(run_unique("replay_kill"), run_unique("replay_kill@example.com"), "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, false)
    {:ok, raw_a, _hash_a, _exp_a} = Auth.issue_refresh_token(user.user_id)

    conn =
      conn
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_a})

    assert conn.status == 200
    assert %{"refresh_token" => raw_b} = Jason.decode!(conn.resp_body)

    # Replay the consumed token: the client-visible shape is unchanged…
    replay =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_a})

    assert replay.status == 401
    assert %{"error" => %{"key" => "refresh_revoked"}} = Jason.decode!(replay.resp_body)

    # …but the family is gone: the SURVIVING token no longer rotates, and the
    # store is empty (revoke_all_sessions ran — epoch bumped, all hashes dead).
    after_kill =
      build_conn()
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)
      |> post("/api/v1/auth/refresh", %{"refresh_token" => raw_b})

    assert after_kill.status == 401
    assert TokenStore.list(user.user_id) == []
    assert Auth.credential_epoch(user.user_id) >= 1
  end

  test "refresh without usable identity → 401", %{conn: conn} do
    {:ok, _user} = User.create(run_unique("noauth_user"), run_unique("noauth@example.com"), "password-123")

    conn = post(conn, "/api/v1/auth/refresh", %{"refresh_token" => "totally-unknown-token"})

    assert conn.status == 401
  end

  # ---------------------------------------------------------------------------
  # The per-account brute-force dam (S3)
  # ---------------------------------------------------------------------------

  describe "the per-account attempt dam (S3)" do
    test "the threshold of wrong passwords locks the identifier — even for the right one", %{
      conn: conn
    } do
      username = run_unique("dam_user")
      email = run_unique("dam_user@example.com")
      {:ok, _user} = User.create(username, email, "correct-password-9")

      wrong = fn ->
        post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "wrong-pass-1"})
      end

      for _ <- 1..9 do
        assert wrong.().status == 401
      end

      # The threshold failure still gets the honest 401 (the lock starts NOW).
      assert wrong.().status == 401

      # From here the dam answers before any credential work: a CORRECT
      # password is rate-limited too — the lock releases on the clock.
      locked = post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "correct-password-9"})

      assert locked.status == 429

      assert %{"error" => %{"key" => "rate_limited", "code" => 42901}} =
               Jason.decode!(locked.resp_body)

      assert [retry_after] = get_resp_header(locked, "retry-after")
      assert {seconds, ""} = Integer.parse(retry_after)
      assert seconds >= 1

      # A different identifier is untouched: the dam is per-key, not global.
      other =
        post(conn, "/api/v1/auth/login", %{
          "identifier" => email,
          "password" => "correct-password-9"
        })

      assert other.status == 200

      # Case/whitespace variants of a locked identifier are the SAME key (the
      # dam normalizes exactly like the lookup — no re-arm through casing).
      assert post(conn, "/api/v1/auth/login", %{
               "identifier" => "  #{String.upcase(username)} ",
               "password" => "x"
             }).status == 429
    end

    test "an attacker network's failures do not lock the owner out from their own network (Tier 2 #2)",
         %{conn: conn} do
      username = run_unique("dam_dos")
      {:ok, _user} = User.create(username, run_unique("dam_dos@example.com"), "correct-password-9")

      from = fn ip, password ->
        post(%{conn | remote_ip: ip}, "/api/v1/auth/login", %{"identifier" => username, "password" => password})
      end

      attacker = {203, 0, 113, 31}
      owner = {198, 51, 100, 31}

      for _ <- 1..10, do: assert(from.(attacker, "wrong-pass-1").status == 401)

      # The attacker's network is locked — even for the right password…
      assert from.(attacker, "correct-password-9").status == 429
      # …the owner, on another network, signs in.
      assert from.(owner, "correct-password-9").status == 200
    end

    test "a nonexistent identifier is dammed identically (no enumeration oracle)", %{conn: conn} do
      ghost = run_unique("ghost_user")

      for _ <- 1..10 do
        resp = post(conn, "/api/v1/auth/login", %{"identifier" => ghost, "password" => "x"})
        assert resp.status == 401
      end

      assert post(conn, "/api/v1/auth/login", %{"identifier" => ghost, "password" => "x"}).status == 429
    end

    # Security (Tier 3 #2): the unknown-identifier 401 must cost an Argon2
    # verification like a wrong password does — otherwise the response TIME
    # answers "does this account exist?" despite the uniform body. Medians
    # over a few fresh identifiers (no dam interplay); the bound is loose
    # (half) because only the order of magnitude is the oracle.
    test "an unknown identifier costs an Argon2 verify (no timing oracle)", %{conn: conn} do
      time = fn ident ->
        {us, resp} =
          :timer.tc(fn -> post(conn, "/api/v1/auth/login", %{"identifier" => ident, "password" => "wrong-pass-1"}) end)

        assert resp.status == 401
        us
      end

      median = fn xs -> xs |> Enum.sort() |> Enum.at(div(length(xs), 2)) end

      known =
        for i <- 1..5 do
          {:ok, user} = User.create(run_unique("tm_user#{i}"), run_unique("tm#{i}@example.com"), "password-123")
          time.(user.username)
        end

      unknown = for i <- 1..5, do: time.(run_unique("tm_ghost#{i}"))

      assert median.(unknown) * 2 >= median.(known),
             "unknown-user login (#{median.(unknown)}us) is far cheaper than a wrong password (#{median.(known)}us)"
    end

    test "a successful login clears the identifier's history", %{conn: conn} do
      username = run_unique("dam_clear")
      {:ok, user} = User.create(username, run_unique("dam_clear@example.com"), "password-123")
      {:ok, _a, _r, _h, _e} = issue_session(user.user_id)

      for _ <- 1..5 do
        assert post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "nope"}).status == 401
      end

      # Halfway to the lock, one success wipes the count — the owner may
      # fumble without eventually locking themselves out.
      assert post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "password-123"}).status ==
               200

      for _ <- 1..9 do
        assert post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "nope"}).status == 401
      end

      # 9 failures after the clear: below the threshold, still authenticating.
      assert post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "password-123"}).status ==
               200
    end

    test "password-reset requests dam per submitted email", %{conn: conn} do
      email = run_unique("dam_reset@example.com")

      for _ <- 1..10 do
        assert post(conn, "/api/v1/auth/password-reset/request", %{"email" => email}).status == 200
      end

      locked = post(conn, "/api/v1/auth/password-reset/request", %{"email" => email})

      assert locked.status == 429
      assert %{"error" => %{"key" => "rate_limited", "code" => 42901}} = Jason.decode!(locked.resp_body)
      assert get_resp_header(locked, "retry-after") != []
    end
  end

  # ---------------------------------------------------------------------------
  # Password reset
  # ---------------------------------------------------------------------------

  test "password-reset request → complete → sessions revoked → new password logs in", %{conn: conn} do
    username = run_unique("resetter")
    email = run_unique("resetter@example.com")
    {:ok, user} = User.create(username, email, "password-123")
    {:ok, _a, _r, _h, _e} = issue_session(user.user_id)

    token =
      Cytale.TestMailbox.capture(
        fn ->
          resp = post(conn, "/api/v1/auth/password-reset/request", %{"email" => email})
          assert resp.status == 200
        end,
        "password_reset",
        email
      )

    conn =
      post(conn, "/api/v1/auth/password-reset/complete", %{
        "token" => token,
        "new_password" => "brand-new-password-1"
      })

    assert conn.status == 200

    # Old session revoked.
    assert TokenStore.list(user.user_id) == []

    # Old password dead, new password works.
    conn_old = post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "password-123"})

    assert conn_old.status == 401

    conn_new =
      post(conn, "/api/v1/auth/login", %{"identifier" => username, "password" => "brand-new-password-1"})

    assert conn_new.status == 200
  end

  test "password-reset request for unknown email is anti-enumeration 200 (no mail)", %{conn: conn} do
    log =
      capture_log(fn ->
        resp = post(conn, "/api/v1/auth/password-reset/request", %{"email" => "nobody@example.com"})
        assert resp.status == 200
      end)

    refute log =~ "password_reset mail for"
  end

  test "password-reset complete with short password → 400 validation_failed", %{conn: conn} do
    email = run_unique("shortpw@example.com")
    {:ok, user} = User.create(run_unique("shortpw"), email, "password-123")

    token =
      Cytale.TestMailbox.capture(
        fn -> :ok = Cytale.Accounts.Verification.request_password_reset(email) end,
        "password_reset",
        email
      )

    conn =
      post(conn, "/api/v1/auth/password-reset/complete", %{"token" => token, "new_password" => "short"})

    assert conn.status == 400
    assert user.user_id > 0
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  # Re-send verification for an existing user and pull the raw token from
  # the Dev mailer's mailbox file (the dev-mode delivery channel — P0-3
  # removed tokens from the log line).
  defp captured_verify_token(user_id) do
    user = User.get(user_id)

    Cytale.TestMailbox.capture(
      fn -> :ok = Cytale.Accounts.Verification.send_verification(user_id) end,
      "verify_email",
      user.email
    )
  end

  defp issue_session(user_id) do
    access = Auth.issue_access_token(user_id, "x", false)
    {:ok, refresh, hash, exp} = Auth.issue_refresh_token(user_id)
    {:ok, access, refresh, hash, exp}
  end

  # Point the Dev mailer at `path` for the body of `fun` (nil = the
  # CWD-relative default). System.put_env/2 is VM-global, so this suite stays
  # async: false and the caller captures the original value ONCE at the top of
  # the test (restore_mailbox/1) — two nested captures would restore in
  # registration order and could leave the broken path behind for the next
  # module.
  defp with_mailbox(path, fun) do
    if path do
      System.put_env("CYTALE_DEV_MAILBOX", path)
    else
      System.delete_env("CYTALE_DEV_MAILBOX")
    end

    fun.()
  end

  defp restore_mailbox(previous) do
    if previous do
      System.put_env("CYTALE_DEV_MAILBOX", previous)
    else
      System.delete_env("CYTALE_DEV_MAILBOX")
    end
  end
end
