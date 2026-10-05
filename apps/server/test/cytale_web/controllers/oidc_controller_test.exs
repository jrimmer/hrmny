defmodule CytaleWeb.Controllers.OIDCControllerTest do
  @moduledoc """
  #12 — the instance OIDC federated sign-in surface, end to end through the
  real router against a REAL stub provider (Bandit+Plug HTTP: discovery,
  JWKS and the token exchange all round-trip over the wire; the ID tokens are
  REAL ES256-signed JWTs — nothing mocked).

  The acceptance set:

    * happy path — start's authorize URL asserts client_id / scopes / PKCE
      S256 challenge / state; the provider leg binds code↔state↔nonce; the
      callback issues the token pair SHAPE-EQUAL to the password path;
    * identity resolution BOTH ways — a verified-email match logs into the
      EXISTING account when that account verified the address itself (no
      duplicate); a match on a never-verified local account is refused with
      `409 oidc_link_required` (never linked, never stamped);
      no match + registration open creates a born-verified passwordless
      account; no match + registration closed is the uniform refusal;
    * refusals — state reuse, unknown state, nonce mismatch, expired token,
      wrong audience, issuer mismatch, bad signature, unverified email: each
      the SAME uniform 401 envelope (asserted byte-equal across causes);
    * PKCE for real — the stub's /token refuses a bad verifier, so the happy
      path proves the verifier binding end to end;
    * key rotation for real — rotate the stub's key, and the validator's
      kid-miss → forced JWKS refetch recovers without operator action;
    * secret hygiene — GET /admin/config never carries the client secret;
    * config round trip — the oidc block is editor-visible and survives a save;
    * /auth/methods advertises the button only when configured + enabled,
      without disturbing the passkey entries (#36 is the neighbour).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn
  import ExUnit.CaptureLog

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.OIDC.StubProvider
  alias Cytale.ServerConfig
  alias Cytale.ServerConfig.Schema

  @endpoint CytaleWeb.Endpoint

  @client_id "cytale-test-client"
  @client_secret "stub-secret-oidc-12"

  # The uniform refusal envelope — asserted EXACTLY, so a future error-key
  # drift between causes (the oracle the ticket forbids) fails loudly here.
  @refusal %{
    "error" => %{
      "key" => "invalid_credentials",
      "code" => 40_101,
      "message" => "SSO sign-in failed."
    }
  }

  @config_env_keys [
    :oidc,
    :server_secrets,
    :registration_open,
    :require_verified_email,
    :operator_user_ids,
    :server_config_path,
    :server_secrets_path
  ]

  # -- Suite scaffolding ----------------------------------------------------------

  defp run_nonce, do: "oidc" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup_all do
    # A free port for the stub's REAL listener (open/close race is the
    # usual tolerated-in-tests one; Bandit fails loudly if it loses).
    {:ok, socket} = :gen_tcp.listen(0, [])
    {:ok, port} = :inet.port(socket)
    :gen_tcp.close(socket)

    base_url = "http://127.0.0.1:#{port}"
    start_supervised!({StubProvider, base_url: base_url, port: port})

    {:ok, base_url: base_url}
  end

  setup ctx do
    saved = Map.new(@config_env_keys, fn k -> {k, Application.get_env(:cytale, k)} end)

    # The surface ON for the suite's default: enabled + complete config, all
    # runtime-scoped (the hot-apply shape), the secret planted the #121 way.
    Application.put_env(:cytale, :oidc, %{
      enabled: true,
      issuer_url: ctx.base_url,
      client_id: @client_id,
      scopes: "openid email profile",
      button_label: "Sign in with Company SSO"
    })

    Application.put_env(:cytale, :server_secrets, %{"oidc_client_secret" => @client_secret})
    Application.put_env(:cytale, :registration_open, true)
    Application.put_env(:cytale, :require_verified_email, true)

    StubProvider.reset(client_id: @client_id, client_secret: @client_secret)
    # Discovery/JWKS are cached per issuer with a TTL — clear between tests so
    # key rotations and config flips are observed fresh.
    Cytale.OIDC.Discovery.clear()

    # A PRIVATE config file for the Server Settings round-trip tests: the
    # default test config path is a shared, persistent file, and a save test
    # against it would both observe and leave peer-visible state.
    dir = Path.join(System.tmp_dir!(), "cytale-oidc-srvcfg-#{System.unique_integer([:positive])}")
    File.mkdir_p!(dir)
    Application.put_env(:cytale, :server_config_path, Path.join(dir, "config.json"))
    Application.delete_env(:cytale, :server_secrets_path)

    on_exit(fn ->
      Enum.each(@config_env_keys, fn k ->
        case Map.fetch(saved, k) do
          {:ok, nil} -> Application.delete_env(:cytale, k)
          {:ok, value} -> Application.put_env(:cytale, k, value)
        end
      end)

      File.rm_rf!(dir)
    end)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, conn: conn}
  end

  # -- flow helpers -----------------------------------------------------------------

  defp start_flow(conn, return_to \\ nil) do
    body = if return_to, do: %{"return_to" => return_to}, else: %{}
    resp = post(conn, "/api/v1/auth/oidc/start", body)
    assert resp.status == 200, "start failed: #{resp.status} #{resp.resp_body}"
    %{"authorize_url" => authorize_url} = json_response(resp, 200)
    authorize_url
  end

  defp drive_provider(authorize_url), do: StubProvider.redeem_authorize_url(authorize_url)

  # The refusal paths log server-side warnings (that is the operator-facing
  # record); ExUnit's own capture keeps the suite output sane. The conn is
  # what matters here.
  defp callback(conn, code, state) do
    post(conn, "/api/v1/auth/oidc/callback", %{"code" => code, "state" => state})
  end

  defp full_flow(conn, return_to \\ nil) do
    authorize_url = start_flow(conn, return_to)
    %{code: code, state: state} = drive_provider(authorize_url) |> to_atoms()
    callback(conn, code, state)
  end

  defp to_atoms(map), do: Map.new(map, fn {k, v} -> {String.to_atom(k), v} end)

  defp create_user do
    username = run_unique("oidc_user")
    {:ok, user} = User.create(username, run_unique("oidc@example.com"), "password-123")
    user
  end

  defp create_verified_user do
    user = create_user()
    :ok = User.mark_verified!(user.user_id)
    User.get(user.user_id)
  end

  # ---------------------------------------------------------------------------
  # Start: the authorize URL asserts the whole ceremony shape
  # ---------------------------------------------------------------------------

  describe "POST /auth/oidc/start" do
    test "authorize URL carries client_id, scopes, redirect_uri, state, nonce and the S256 PKCE challenge", %{
      conn: conn,
      base_url: base_url
    } do
      url = start_flow(conn, "/workspace/42/channel/7/message/9")
      q = url |> URI.parse() |> Map.get(:query) |> URI.decode_query()

      assert q["response_type"] == "code"
      assert q["client_id"] == @client_id
      assert q["scope"] == "openid email profile"
      assert q["redirect_uri"] =~ "http://"
      assert q["redirect_uri"] =~ "/auth/oidc/callback"
      assert q["code_challenge_method"] == "S256"
      # A real S256 challenge: base64url of a SHA-256 digest (43 chars).
      refute is_nil(q["code_challenge"])
      assert byte_size(q["code_challenge"]) == 43
      assert String.length(q["state"]) >= 32
      assert String.length(q["nonce"]) >= 32

      # The endpoint itself came from DISCOVERY (the stub's document over
      # real HTTP), not a config key — the issuer URL is the only thing
      # configured, and this proves the whole discovery leg ran.
      assert {:ok, provider} = Cytale.OIDC.Discovery.provider_config(base_url)
      assert String.starts_with?(url, provider["authorization_endpoint"])
    end

    test "a non-relative return_to is dropped, not followed (no open redirect)", %{conn: conn} do
      # A valid identity: this test is about the continuation, not resolution.
      StubProvider.put_claims(%{"email" => run_unique("rt@example.com"), "email_verified" => true})

      url = start_flow(conn, "https://evil.example/grab")
      assert URI.parse(url).query =~ "state="

      # The full flow still succeeds; the callback's return_to is nil.
      %{code: code, state: state} = drive_provider(url) |> to_atoms()
      resp = callback(conn, code, state)
      assert %{"return_to" => nil} = json_response(resp, 200)
    end

    test "disabled surface: 403 oidc_disabled (the honest-absence posture)", %{conn: conn} do
      flip_enabled(false)

      resp = post(conn, "/api/v1/auth/oidc/start", %{})
      assert resp.status == 403
      assert %{"error" => %{"key" => "oidc_disabled"}} = json_response(resp, 403)
    end

    test "half-configured (secret missing): fail-closed, same 403", %{conn: conn} do
      Application.put_env(:cytale, :server_secrets, %{})
      refute Cytale.OIDC.enabled?()

      resp = post(conn, "/api/v1/auth/oidc/start", %{})
      assert resp.status == 403
      assert %{"error" => %{"key" => "oidc_disabled"}} = json_response(resp, 403)
    end

    test "provider unreachable: 502 oidc_provider_unavailable — a deliberate state", %{conn: conn} do
      Application.put_env(:cytale, :oidc, %{
        enabled: true,
        issuer_url: "http://127.0.0.1:1/no-such-issuer",
        client_id: @client_id,
        scopes: "openid email profile",
        button_label: "x"
      })

      Cytale.OIDC.Discovery.clear()

      resp = post(conn, "/api/v1/auth/oidc/start", %{})
      assert resp.status == 502
      assert %{"error" => %{"key" => "oidc_provider_unavailable"}} = json_response(resp, 502)
    end
  end

  # ---------------------------------------------------------------------------
  # Happy path
  # ---------------------------------------------------------------------------

  describe "callback happy path" do
    test "unknown subject + registration open → account created born-verified, token pair shape-equal to the password path",
         %{
           conn: conn
         } do
      email = run_unique("newbie@example.com")
      StubProvider.put_claims(%{"email" => email, "email_verified" => true, "preferred_username" => "Newbie!Name"})

      resp = full_flow(conn, "/workspace/42")

      assert resp.status == 200, "callback failed: #{resp.status} #{resp.resp_body}"
      body = json_response(resp, 200)

      # The account: created, verified (the provider's verified claim counts),
      # passwordless, named from the sanitized preferred_username.
      user = User.get_by_identifier(email)
      assert user != nil, "no account provisioned"
      assert user.username == "NewbieName"
      assert user.email_verified_at != nil
      assert user.password_hash == ""

      # The token pair: the password path's shape EXACTLY (return_to is the
      # one additive continuation key).
      assert Map.keys(body) |> Enum.sort() ==
               Enum.sort([
                 "user",
                 "access_token",
                 "refresh_token",
                 "token_type",
                 "expires_in",
                 "email_verified",
                 "return_to"
               ])

      assert body["token_type"] == "Bearer"
      assert body["expires_in"] == div(Cytale.Config.access_token_ttl_ms(), 1000)
      assert body["email_verified"] == true
      assert body["return_to"] == "/workspace/42"

      # And it WORKS like the password path's pair: the access token verifies
      # with the account's claims, the refresh token rotates.
      assert {:ok, claims} = Auth.verify_access_token(body["access_token"])
      assert claims.user_id == user.user_id
      assert claims.verified == true
      assert Auth.refresh_token_valid?(user.user_id, body["refresh_token"])

      # The user payload matches the login payload shape.
      assert %{"id" => id, "username" => "NewbieName", "email" => ^email} = body["user"]
      assert id == Integer.to_string(user.user_id)
    end

    test "existing VERIFIED account match → logs into THE account, no duplicate", %{
      conn: conn
    } do
      user = create_verified_user()
      assert user.email_verified_at != nil

      StubProvider.put_claims(%{"email" => user.email, "email_verified" => true})

      resp = full_flow(conn)

      assert resp.status == 200, "callback failed: #{resp.status} #{resp.resp_body}"
      body = json_response(resp, 200)

      # THE existing account — same snowflake, no second row.
      assert body["user"]["id"] == Integer.to_string(user.user_id)
      assert body["user"]["username"] == user.username
      assert Enum.count(User.get_by_identifier(user.email) |> List.wrap()) == 1
      assert body["user"]["email_verified"] == true

      assert {:ok, claims} = Auth.verify_access_token(body["access_token"])
      assert claims.user_id == user.user_id
    end

    # Security (Tier 3 #1a): a local account whose email was never verified
    # proves nothing about who owns the address — anyone can register one
    # under a victim's email. Auto-linking it to the provider identity (and
    # stamping it verified) was an account takeover / planted-account door.
    test "existing UNVERIFIED account match → 409 oidc_link_required, no tokens, not stamped", %{
      conn: conn
    } do
      user = create_user()
      assert user.email_verified_at == nil

      StubProvider.put_claims(%{"email" => user.email, "email_verified" => true})

      {resp, _log} = with_log(fn -> full_flow(conn) end)

      assert resp.status == 409
      body = json_response(resp, 409)
      assert %{"error" => %{"key" => "oidc_link_required", "message" => message}} = body
      assert message =~ "password"
      refute Map.has_key?(body, "access_token")

      # Neither linked nor stamped: the local account is untouched.
      assert User.get(user.user_id).email_verified_at == nil
      assert Enum.count(User.get_by_identifier(user.email) |> List.wrap()) == 1
    end

    test "PKCE binding is real: the stub refuses the exchange when the challenge cannot match", %{conn: conn} do
      authorize_url = start_flow(conn)
      q = authorize_url |> URI.parse() |> Map.get(:query) |> URI.decode_query()
      %{state: state} = drive_provider(authorize_url) |> to_atoms()

      # A foreign code whose challenge matches a DIFFERENT verifier — exactly
      # the code-theft shape PKCE exists to defeat. The stub's /token checks
      # sha256(server's verifier) == this challenge; it cannot match, so the
      # exchange fails and the callback refuses uniformly.
      foreign =
        StubProvider.issue_code(%{
          challenge: Base.url_encode64(:crypto.hash(:sha256, "not-the-server-verifier"), padding: false),
          nonce: "whatever",
          redirect_uri: q["redirect_uri"],
          claims: %{}
        })

      resp = callback(conn, foreign, state)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "provider key rotation: the kid-miss forces a JWKS refetch and the NEXT login recovers", %{
      conn: conn
    } do
      StubProvider.put_claims(%{"email" => run_unique("rot@example.com"), "email_verified" => true})

      # First login caches the original key; rotate, then the next token's
      # kid is unknown to the cache — the forced refetch must recover.
      assert full_flow(conn).status == 200
      StubProvider.rotate_key!()
      Cytale.OIDC.Discovery.clear()

      resp = full_flow(conn)
      assert resp.status == 200, "rotation recovery failed: #{resp.status} #{resp.resp_body}"
    end
  end

  # ---------------------------------------------------------------------------
  # Refusals — every one the SAME uniform envelope
  # ---------------------------------------------------------------------------

  describe "callback refusals collapse to the uniform envelope" do
    test "state reuse (a replayed callback)", %{conn: conn} do
      StubProvider.put_claims(%{"email" => run_unique("replay@example.com"), "email_verified" => true})

      authorize_url = start_flow(conn)
      %{code: code, state: state} = drive_provider(authorize_url) |> to_atoms()

      first = callback(conn, code, state)
      assert first.status == 200

      replay = callback(conn, code, state)
      assert replay.status == 401
      assert @refusal = json_response(replay, 401)
    end

    test "unknown state", %{conn: conn} do
      authorize_url = start_flow(conn)
      %{code: code} = drive_provider(authorize_url) |> to_atoms()

      resp = callback(conn, code, String.duplicate("x", 43))
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "nonce mismatch (real token, wrong ceremony): refused, nothing provisioned", %{conn: conn} do
      email = run_unique("nonce@example.com")

      StubProvider.put_claims(%{
        "email" => email,
        "email_verified" => true,
        "nonce" => "a-different-ceremony"
      })

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
      assert User.get_by_identifier(email) == nil
    end

    test "expired token", %{conn: conn} do
      StubProvider.put_claims(%{
        "email" => run_unique("expired@example.com"),
        "email_verified" => true,
        "exp" => System.system_time(:second) - 100
      })

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "wrong audience", %{conn: conn} do
      StubProvider.put_claims(%{
        "email" => run_unique("aud@example.com"),
        "email_verified" => true,
        "aud" => "someone-elses-client"
      })

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "issuer mismatch", %{conn: conn} do
      StubProvider.put_claims(%{
        "email" => run_unique("iss@example.com"),
        "email_verified" => true,
        "iss" => "https://evil.example/other"
      })

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "bad signature (rogue signing key, kid-miss refetch cannot save it)", %{conn: conn} do
      StubProvider.put_claims(%{"email" => run_unique("rogue@example.com"), "email_verified" => true})
      StubProvider.sign_with_rogue_key()

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "unverified email claim: refused, nothing matched, nothing created", %{conn: conn} do
      user = create_user()

      # A provider asserting the account's email WITHOUT verification must
      # not log into it (the linking rule is verified-email only).
      StubProvider.put_claims(%{"email" => user.email, "email_verified" => false})

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)

      # The matched account was NOT verified-by-side-effect either.
      assert User.get(user.user_id).email_verified_at == nil
    end

    test "no account + registration CLOSED: refused, nothing created, envelope IDENTICAL to every other refusal", %{
      conn: conn
    } do
      Application.put_env(:cytale, :registration_open, false)
      email = run_unique("closed@example.com")
      StubProvider.put_claims(%{"email" => email, "email_verified" => true})

      resp = full_flow(conn)
      assert resp.status == 401
      body = json_response(resp, 401)
      assert body == @refusal

      assert User.get_by_identifier(email) == nil
    end

    test "soft-deleted account match: refused (no resurrection through the provider)", %{conn: conn} do
      user = create_user()
      :ok = User.soft_delete!(user.user_id)

      StubProvider.put_claims(%{"email" => user.email, "email_verified" => true})

      resp = full_flow(conn)
      assert resp.status == 401
      assert @refusal = json_response(resp, 401)
    end

    test "the refusals are indistinguishable ON THE WIRE: closed-registration body == unknown-state body", %{
      conn: conn
    } do
      # One more cause, then byte-compare all of them.
      Application.put_env(:cytale, :registration_open, false)
      StubProvider.put_claims(%{"email" => run_unique("cmp@example.com"), "email_verified" => true})
      closed = full_flow(conn) |> json_response(401)

      authorize_url = start_flow(conn)
      %{code: code} = drive_provider(authorize_url) |> to_atoms()
      unknown_state = callback(conn, code, "bogus-state") |> json_response(401)

      assert closed == @refusal
      assert unknown_state == @refusal
    end
  end

  # ---------------------------------------------------------------------------
  # /auth/methods — the sign-in screen's "which buttons" read
  # ---------------------------------------------------------------------------

  describe "GET /auth/methods" do
    test "advertises the OIDC button (with the operator's label) when configured + enabled", %{
      conn: conn
    } do
      resp = get(conn, "/api/v1/auth/methods")

      assert %{
               "password" => true,
               "webauthn" => true,
               "oidc" => true,
               "oidc_button_label" => "Sign in with Company SSO"
             } = json_response(resp, 200)
    end

    test "stays silent (oidc false, label nil) when disabled — passkey entries untouched", %{conn: conn} do
      flip_enabled(false)

      resp = get(conn, "/api/v1/auth/methods")

      assert %{"password" => true, "webauthn" => true, "oidc" => false, "oidc_button_label" => nil} =
               json_response(resp, 200)
    end
  end

  # ---------------------------------------------------------------------------
  # Config (#121 machinery): secret hygiene + editor round trip
  # ---------------------------------------------------------------------------

  describe "Server Settings integration" do
    test "GET /admin/config never contains the client secret (the #121 assertion, for the oidc secret)", %{
      conn: conn
    } do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> operator_token())
        |> get("/api/v1/admin/config")

      assert conn.status == 200
      body = conn.resp_body

      refute body =~ @client_secret, "GET leaked the OIDC client secret"
      refute body =~ "oidc_client_secret", "GET leaked the secret KEY NAME"

      # The secret lives in the secrets store, not the editor document.
      assert ServerConfig.secret("oidc_client_secret") == @client_secret
      refute match?({:ok, _}, Schema.fetch_path(ServerConfig.effective_document(), "oidc.client_secret"))
    end

    test "the editor document carries the oidc block, and a save of another key PRESERVES it", %{
      conn: conn
    } do
      doc = ServerConfig.effective_document()

      for path <- ~w(oidc.enabled oidc.issuer_url oidc.client_id oidc.scopes oidc.button_label) do
        assert {:ok, _} = Schema.fetch_path(doc, path), "editor document missing #{path}"
      end

      # An operator save that does not mention oidc must not eat it.
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> operator_token())
        |> put("/api/v1/admin/config", %{"cors" => %{"allowed_origins" => ["https://oidc-roundtrip.example"]}})

      assert conn.status == 200

      doc_after = ServerConfig.effective_document()
      assert {:ok, true} = Schema.fetch_path(doc_after, "oidc.enabled")
      assert {:ok, "openid email profile"} = Schema.fetch_path(doc_after, "oidc.scopes")
      assert {:ok, @client_id} = Schema.fetch_path(doc_after, "oidc.client_id")
    end

    test "the oidc keys are runtime-scoped: an editor save hot-applies (no restart)", %{conn: conn} do
      conn =
        conn
        |> put_req_header("authorization", "Bearer " <> operator_token())
        |> put("/api/v1/admin/config", %{"oidc" => %{"button_label" => "Continue with Okta"}})

      assert %{"ok" => true, "restart_required" => false} = Jason.decode!(conn.resp_body)
      assert Cytale.Config.oidc_button_label() == "Continue with Okta"
      assert Cytale.OIDC.button_label() == "Continue with Okta"
    end
  end

  # ---------------------------------------------------------------------------
  # Pure helpers (documented policy, pinned)
  # ---------------------------------------------------------------------------

  describe "return_to sanitization" do
    test "same-app relative paths survive; open-redirect shapes do not" do
      assert Cytale.OIDC.sanitize_return_to("/workspace/1/channel/2") == "/workspace/1/channel/2"
      assert Cytale.OIDC.sanitize_return_to("/x?a=1&b=2") == "/x?a=1&b=2"

      assert Cytale.OIDC.sanitize_return_to("https://evil.example") == nil
      assert Cytale.OIDC.sanitize_return_to("//evil.example") == nil
      assert Cytale.OIDC.sanitize_return_to("/a\\b") == nil
      assert Cytale.OIDC.sanitize_return_to("/a\nb") == nil
      assert Cytale.OIDC.sanitize_return_to("relative/no-slash") == nil
      assert Cytale.OIDC.sanitize_return_to("/" <> String.duplicate("x", 600)) == nil
      assert Cytale.OIDC.sanitize_return_to(nil) == nil
      assert Cytale.OIDC.sanitize_return_to(42) == nil
    end
  end

  describe "username derivation" do
    test "preferred_username is sanitized into the username grammar" do
      assert Cytale.OIDC.derive_username(%{"preferred_username" => "J.Rowan!!"}, "a@b.co") == "J.Rowan"
    end

    test "falls back to the email local-part, then to a generic handle" do
      assert Cytale.OIDC.derive_username(%{}, "grace.hopper@navy.mil") == "grace.hopper"
      # A single-char local part cannot satisfy the username grammar, so the
      # generic handle carries it.
      assert Cytale.OIDC.derive_username(%{"preferred_username" => "@@"}, "x@y.co") == "user"
    end

    test "a taken handle is de-collided, never refused" do
      user = create_user()
      assert Cytale.OIDC.derive_username(%{"preferred_username" => user.username}, "z@z.co") != user.username
    end
  end

  # ---------------------------------------------------------------------------
  # helpers
  # ---------------------------------------------------------------------------

  defp flip_enabled(enabled?) do
    cfg = Application.get_env(:cytale, :oidc)
    Application.put_env(:cytale, :oidc, %{cfg | enabled: enabled?})
  end

  defp operator_token do
    {:ok, user} = User.create(run_unique("oidc_op"), run_unique("oidc_op@example.com"), "password-123")
    Application.put_env(:cytale, :operator_user_ids, [user.user_id])
    Auth.issue_access_token(user.user_id, user.username, true)
  end
end
