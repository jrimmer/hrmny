defmodule CytaleWeb.Controllers.WebAuthnControllerTest do
  @moduledoc """
  #36 — the passkey surface, end to end through the real router: a SOFTWARE
  authenticator (`Cytale.WebAuthnFixtures` — real ES256 keys, real CBOR, real
  ECDSA) drives the acceptance core (register→login round trip) and every
  refusal the ticket pins: bad signature, stale counter, wrong origin,
  wrong RP ID, challenge reuse, credential removal.
  """

  use Cytale.ScyllaCase, async: false

  import Bitwise

  alias Cytale.Accounts.{Auth, User, WebAuthn}
  alias Cytale.WebAuthnFixtures, as: Fixtures

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "wa" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, conn: conn}
  end

  # -- fixtures ------------------------------------------------------------------

  # An account that may pass the :content_mutation choke point (enrollment is
  # a credential mint, which requires verification).
  defp create_verified_user do
    username = run_unique("wa_user")
    {:ok, user} = User.create(username, run_unique("wa@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    User.get(user.user_id)
  end

  defp auth_conn(conn, user) do
    token = Auth.issue_access_token(user.user_id, user.username, true)
    put_req_header(conn, "authorization", "Bearer " <> token)
  end

  defp register_options(conn) do
    resp = post(conn, "/api/v1/auth/webauthn/register/options")
    assert resp.status == 200
    %{"challenge_id" => challenge_id, "public_key" => public_key} = json_response(resp, 200)
    {challenge_id, public_key}
  end

  defp post_register_verify(conn, challenge_id, attestation_b64, client_data_b64, raw_id, name \\ "Test key") do
    post(conn, "/api/v1/auth/webauthn/register/verify", %{
      "challenge_id" => challenge_id,
      "name" => name,
      "response" => %{
        "id" => Fixtures.encode_b64url(raw_id),
        "rawId" => Fixtures.encode_b64url(raw_id),
        "type" => "public-key",
        "response" => %{
          "clientDataJSON" => client_data_b64,
          "attestationObject" => attestation_b64
        }
      }
    })
  end

  defp enroll(conn, authenticator, name \\ "Test key") do
    {challenge_id, public_key} = register_options(conn)
    {att, cdj} = Fixtures.register_response(authenticator, public_key)

    resp =
      post_register_verify(conn, challenge_id, att, cdj, authenticator.credential_id_raw, name)

    assert resp.status == 200, "enrollment failed: #{resp.status} #{resp.resp_body}"
    json_response(resp, 200)["credential"]
  end

  defp login_options(conn) do
    resp = post(conn, "/api/v1/auth/webauthn/login/options")
    assert resp.status == 200
    %{"challenge_id" => challenge_id, "public_key" => public_key} = json_response(resp, 200)
    {challenge_id, public_key}
  end

  defp post_login_verify(conn, challenge_id, auth_data_b64, sig_b64, cdj_b64, raw_id, user_handle) do
    post(conn, "/api/v1/auth/webauthn/login/verify", %{
      "challenge_id" => challenge_id,
      "response" => %{
        "id" => Fixtures.encode_b64url(raw_id),
        "rawId" => Fixtures.encode_b64url(raw_id),
        "type" => "public-key",
        "response" => %{
          "clientDataJSON" => cdj_b64,
          "authenticatorData" => auth_data_b64,
          "signature" => sig_b64,
          "userHandle" => user_handle
        }
      }
    })
  end

  # The uniform credential refusal: one key, one message, whatever the reason
  # (the message must still tell the member what to do).
  @uniform_message "That passkey couldn't sign you in. It may not be registered on this server. " <>
                     "Sign in with your password, then add the passkey again in Settings → My Account → Passkeys."

  defp assert_uniform_401(resp) do
    assert resp.status == 401

    assert %{"error" => %{"key" => "invalid_credentials", "code" => 40_101, "message" => @uniform_message}} =
             json_response(resp, 401)
  end

  # A response made for another site/RP is refused BEFORE any credential is
  # read: its own key, so the client can say "wrong address" instead of
  # "not registered".
  defp assert_ceremony_400(resp) do
    assert resp.status == 400

    assert %{"error" => %{"key" => "ceremony_failed", "code" => 40_001, "message" => message}} =
             json_response(resp, 400)

    assert message =~ "address"
  end

  # ---------------------------------------------------------------------------
  # GET /auth/methods
  # ---------------------------------------------------------------------------

  test "methods reports the passkey toggle without authenticating", %{conn: conn} do
    resp = get(conn, "/api/v1/auth/methods")
    assert resp.status == 200
    assert %{"password" => true, "webauthn" => true} = json_response(resp, 200)
  end

  # ---------------------------------------------------------------------------
  # Acceptance core: register → login round trip
  # ---------------------------------------------------------------------------

  test "register→login round trip: software authenticator, token pair matches the password path", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)

    # -- enroll ---------------------------------------------------------------
    authenticator = Fixtures.new()
    credential = enroll(authed, authenticator, "MacBook Touch ID")

    assert credential["name"] == "MacBook Touch ID"
    assert credential["last_used_at"] == nil

    # The owner's list shows it, with the wire shape settings renders.
    listed = json_response(get(authed, "/api/v1/users/@me/webauthn/credentials"), 200)

    assert [
             %{
               "id" => id,
               "name" => "MacBook Touch ID",
               "created_at" => created_at,
               "last_used_at" => nil
             }
           ] = listed["credentials"]

    assert id == credential["id"]
    assert created_at

    # -- login (fresh, UNauthenticated conn — the discoverable flow) ------------
    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)

    resp =
      post_login_verify(
        conn,
        challenge_id,
        ad,
        sig,
        cdj,
        authenticator.credential_id_raw,
        WebAuthn.user_handle_encode(user.user_id)
      )

    assert resp.status == 200, "login failed: #{resp.status} #{resp.resp_body}"
    body = json_response(resp, 200)

    # The EXACT token-pair shape POST /auth/login returns.
    assert MapSet.new(Map.keys(body)) ==
             MapSet.new(["user", "access_token", "refresh_token", "token_type", "expires_in", "email_verified"])

    assert body["token_type"] == "Bearer"
    assert body["user"]["id"] == Integer.to_string(user.user_id)
    assert body["user"]["username"] == user.username

    # The access token is the real thing (verifiable claims, correct owner) and
    # the refresh token is a live, rotable credential in the store.
    assert {:ok, claims} = Auth.verify_access_token(body["access_token"])
    assert claims.user_id == user.user_id
    assert claims.username == user.username
    assert Auth.refresh_token_valid?(user.user_id, body["refresh_token"])

    # last_used_at moved.
    listed_after = json_response(get(authed, "/api/v1/users/@me/webauthn/credentials"), 200)
    assert [%{"last_used_at" => last_used}] = listed_after["credentials"]
    assert last_used
  end

  # ---------------------------------------------------------------------------
  # Refusals
  # ---------------------------------------------------------------------------

  test "bad signature refused: a tampered assertion is a uniform 401", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    {challenge_id, public_key} = login_options(conn)
    {ad, sig_b64, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)

    # Flip one bit of the signature.
    <<prefix::binary-size(10), byte, rest::binary>> = Base.url_decode64!(sig_b64, padding: false)
    tampered = Fixtures.encode_b64url(<<prefix::binary, Bitwise.bxor(byte, 0x01), rest::binary>>)

    resp = post_login_verify(conn, challenge_id, ad, tampered, cdj, authenticator.credential_id_raw, nil)

    assert_uniform_401(resp)
  end

  test "stale counter refused (clone detection): a non-monotonic sign count is a uniform 401", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    # First login advances the stored counter to 5.
    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 5)
    assert post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil).status == 200

    # Second login presenting a LOWER counter is refused.
    {challenge_id2, public_key2} = login_options(conn)
    {ad2, sig2, cdj2} = Fixtures.assertion(authenticator, public_key2, counter: 3)

    assert_uniform_401(post_login_verify(conn, challenge_id2, ad2, sig2, cdj2, authenticator.credential_id_raw, nil))
  end

  test "counter=0 edge: an authenticator that never counts may log in repeatedly", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    for _ <- 1..2 do
      {challenge_id, public_key} = login_options(conn)
      {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 0)
      resp = post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil)
      assert resp.status == 200, "counter=0 login failed: #{resp.status} #{resp.resp_body}"
    end
  end

  test "wrong origin refused: an assertion from another site's page is a ceremony_failed 400", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    {challenge_id, public_key} = login_options(conn)

    {ad, sig, cdj} =
      Fixtures.assertion(authenticator, public_key, counter: 1, origin: "https://evil.example")

    assert_ceremony_400(post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil))
  end

  test "wrong rp_id refused: an assertion hashed for another RP is a ceremony_failed 400", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    {challenge_id, public_key} = login_options(conn)

    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1, rp_id: "evil.example")

    assert_ceremony_400(post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil))
  end

  test "challenge reuse refused: the same ceremony cannot verify twice", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)

    body = %{
      "challenge_id" => challenge_id,
      "response" => %{
        "id" => Fixtures.encode_b64url(authenticator.credential_id_raw),
        "rawId" => Fixtures.encode_b64url(authenticator.credential_id_raw),
        "type" => "public-key",
        "response" => %{
          "clientDataJSON" => cdj,
          "authenticatorData" => ad,
          "signature" => sig,
          "userHandle" => nil
        }
      }
    }

    first = post(conn, "/api/v1/auth/webauthn/login/verify", body)
    assert first.status == 200, "first login failed: #{first.status} #{first.resp_body}"

    replay = post(conn, "/api/v1/auth/webauthn/login/verify", body)
    assert replay.status == 400
    assert %{"error" => %{"key" => "challenge_invalid"}} = json_response(replay, 400)
  end

  test "a wrong-origin response is refused even for an UNKNOWN credential — the same 400, no oracle", %{conn: conn} do
    # The ceremony check runs before any credential is read, so a registered
    # and an unregistered credential get the identical answer.
    {challenge_id, public_key} = login_options(conn)
    stranger = Fixtures.new()
    {ad, sig, cdj} = Fixtures.assertion(stranger, public_key, counter: 1, origin: "https://evil.example")

    assert_ceremony_400(post_login_verify(conn, challenge_id, ad, sig, cdj, stranger.credential_id_raw, nil))
  end

  test "expired challenge refused: a ceremony past its lifetime is challenge_invalid, not a credential refusal",
       %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    original = Application.get_env(:cytale, :webauthn)
    Application.put_env(:cytale, :webauthn, Keyword.put(original, :challenge_timeout_s, 1))
    on_exit(fn -> Application.put_env(:cytale, :webauthn, original) end)

    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)
    Process.sleep(1_100)

    resp = post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil)
    assert resp.status == 400

    assert %{"error" => %{"key" => "challenge_invalid", "message" => message}} = json_response(resp, 400)
    assert message =~ "expired"
  end

  test "the default challenge lifetime covers a cross-device (phone) confirmation", %{conn: conn} do
    {_challenge_id, public_key} = login_options(conn)
    assert public_key["timeout"] == 300_000
  end

  test "every refusal is logged with its specific reason, never the credential id", %{conn: conn} do
    {challenge_id, public_key} = login_options(conn)
    stranger = Fixtures.new()
    {ad, sig, cdj} = Fixtures.assertion(stranger, public_key, counter: 1)

    log =
      ExUnit.CaptureLog.capture_log([level: :info], fn ->
        assert_uniform_401(post_login_verify(conn, challenge_id, ad, sig, cdj, stranger.credential_id_raw, nil))
      end)

    assert log =~ "webauthn login refused: unknown_credential"
    refute log =~ Fixtures.encode_b64url(stranger.credential_id_raw)
  end

  test "unknown credential refused: an unenrolled credential id is a uniform 401", %{conn: conn} do
    {challenge_id, public_key} = login_options(conn)
    stranger = Fixtures.new()
    {ad, sig, cdj} = Fixtures.assertion(stranger, public_key, counter: 1)

    assert_uniform_401(post_login_verify(conn, challenge_id, ad, sig, cdj, stranger.credential_id_raw, nil))
  end

  test "deleted account refused: a passkey on a tombstoned account is a uniform 401", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    # Soft-delete tombstone, exactly what the U14 cascade sets first.
    Cytale.Repo.execute!(
      "UPDATE #{Cytale.Repo.keyspace()}.users SET deleted_at = ? WHERE user_id = ?",
      [
        {"timestamp", DateTime.utc_now() |> DateTime.truncate(:millisecond)},
        {"bigint", user.user_id}
      ]
    )

    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)

    assert_uniform_401(post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil))
  end

  test "duplicate credential id refused: re-enrolling the same authenticator is 409", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    enroll(authed, authenticator)

    {challenge_id, public_key} = register_options(authed)
    {att, cdj} = Fixtures.register_response(authenticator, public_key)

    resp = post_register_verify(authed, challenge_id, att, cdj, authenticator.credential_id_raw, "dupe")

    assert resp.status == 409
    assert %{"error" => %{"key" => "credential_duplicate"}} = json_response(resp, 409)
  end

  test "register challenge reuse refused", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()

    {challenge_id, public_key} = register_options(authed)
    {att, cdj} = Fixtures.register_response(authenticator, public_key)

    resp = post_register_verify(authed, challenge_id, att, cdj, authenticator.credential_id_raw)
    assert resp.status == 200, "first enrollment failed: #{resp.status} #{resp.resp_body}"

    # A DIFFERENT authenticator replaying the SPENT challenge.
    stranger = Fixtures.new()
    {att2, cdj2} = Fixtures.register_response(stranger, public_key)

    resp2 = post_register_verify(authed, challenge_id, att2, cdj2, stranger.credential_id_raw, "replay")

    assert resp2.status == 400
    assert %{"error" => %{"key" => "challenge_invalid"}} = json_response(resp2, 400)
  end

  # ---------------------------------------------------------------------------
  # Removal
  # ---------------------------------------------------------------------------

  test "credential removal revokes it: gone from the list, refused at login", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    authenticator = Fixtures.new()
    credential = enroll(authed, authenticator)

    resp = delete(authed, "/api/v1/users/@me/webauthn/credentials/#{credential["id"]}")
    assert resp.status == 204

    assert [] == json_response(get(authed, "/api/v1/users/@me/webauthn/credentials"), 200)["credentials"]

    {challenge_id, public_key} = login_options(conn)
    {ad, sig, cdj} = Fixtures.assertion(authenticator, public_key, counter: 1)

    assert post_login_verify(conn, challenge_id, ad, sig, cdj, authenticator.credential_id_raw, nil).status == 401
  end

  test "removal is owner-scoped: another account's credential id is one 404", %{conn: conn} do
    user = create_verified_user()
    other = create_verified_user()
    authed = auth_conn(conn, user)
    other_authed = auth_conn(conn, other)

    credential = enroll(other_authed, Fixtures.new())

    resp = delete(authed, "/api/v1/users/@me/webauthn/credentials/#{credential["id"]}")
    assert resp.status == 404

    # The other account's credential is untouched.
    listed = json_response(get(other_authed, "/api/v1/users/@me/webauthn/credentials"), 200)
    assert [%{"id" => id}] = listed["credentials"]
    assert id == credential["id"]
  end

  # ---------------------------------------------------------------------------
  # Gates
  # ---------------------------------------------------------------------------

  test "enrollment requires authentication", %{conn: conn} do
    resp = post(conn, "/api/v1/auth/webauthn/register/options")
    assert resp.status == 401
  end

  test "disabled server: 403 on the ceremony endpoints, methods flips", %{conn: conn} do
    original = Application.get_env(:cytale, :webauthn)

    Application.put_env(:cytale, :webauthn, enabled: false, rp_id: "localhost", origins: ["http://localhost:4001"])

    # Restored BEFORE the test returns: the flip is global config, and sibling
    # tests in this module run after it (an on_exit restore would leave the
    # whole rest of the module staring at `enabled: false`).
    try do
      assert %{"webauthn" => false} = json_response(get(conn, "/api/v1/auth/methods"), 200)
      assert post(conn, "/api/v1/auth/webauthn/login/options").status == 403

      user = create_verified_user()
      assert post(auth_conn(conn, user), "/api/v1/auth/webauthn/register/options").status == 403
    after
      Application.put_env(:cytale, :webauthn, original)
    end
  end

  test "excludeCredentials lists already-enrolled credentials at options time", %{conn: conn} do
    user = create_verified_user()
    authed = auth_conn(conn, user)
    credential = enroll(authed, Fixtures.new())

    {_challenge_id, public_key} = register_options(authed)

    assert [%{"type" => "public-key", "id" => credential["id"]}] == public_key["excludeCredentials"]
  end
end
