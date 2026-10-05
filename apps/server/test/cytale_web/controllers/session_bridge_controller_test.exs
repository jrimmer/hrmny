defmodule CytaleWeb.Controllers.SessionBridgeControllerTest do
  @moduledoc """
  U2 session bridge (R7/R8/R8a/R8b/R9/R13a) — driven over real HTTP against the
  bridge's OWN listener, with the assertion built from a certificate the member
  surface actually issued.

  Three properties this suite exists to pin, none of which is visible from
  reading either half alone:

    * **the bridge is not on the app listener.** R8a is an absence, not a
      refusal: `CytaleWeb.Router.__routes__/0` must not carry the bridge path,
      and a POST to the app's own port must 404 — because `deploy/Caddyfile`
      proxies that listener on the public edge.
    * **the serial is the LOOKUP key and the nonce is the REPLAY key.** One
      session re-mints on the same serial every access-token lifetime for up to
      24 hours, so a replay refusal keyed on the serial would kill the first
      renewal. A replayed body is refused; the same serial with a fresh nonce
      still mints.
    * **the epoch is fail-open at authentication and fail-closed at mint.** A
      token minted before the claim existed still authenticates; the bridge
      refuses another once the epoch has moved.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Gateway.Authenticator.JWT, as: JWTAuthenticator
  alias Cytale.SSH.{Audit, CertificateStore}
  alias Cytale.SSHFixtures, as: F
  alias CytaleWeb.BridgeServer

  @endpoint CytaleWeb.Endpoint
  @ttl_ms 24 * 60 * 60 * 1000
  @credential "u2-bridge-test-credential"
  @credential_header "x-cytale-bridge-credential"

  setup_all do
    original_ssh = Application.get_env(:cytale, :ssh)
    original_bridge = Application.get_env(:cytale, :session_bridge)
    on_exit(fn -> Application.put_env(:cytale, :ssh, original_ssh) end)
    on_exit(fn -> Application.put_env(:cytale, :session_bridge, original_bridge) end)

    dir = F.tmp_dir!("cytale-u2-bridge")
    %{path: ca_path} = F.ca!(dir)

    Application.put_env(:cytale, :ssh,
      enabled: true,
      ca_key_path: ca_path,
      certificate_ttl_ms: @ttl_ms
    )

    port = F.free_port()

    Application.put_env(:cytale, :session_bridge,
      enabled: true,
      credential: @credential,
      bind_ip: {127, 0, 0, 1},
      port: port,
      acceptance_window_s: 120
    )

    # The credential hash is cached per source; clear anything a previous module
    # left behind so THIS module's credential is the one in force.
    :persistent_term.erase({Cytale.SessionBridge, :credential_hash})

    start_supervised!(BridgeServer.child_spec(ip: {127, 0, 0, 1}, port: port))

    :ok = Cytale.Snowflake.ensure_init()
    %{dir: dir, bridge_port: port}
  end

  setup do
    {:ok, user} = User.create(unique("bridge"), unique("bridge") <> "@example.com", "password-123")
    :ok = User.mark_verified!(user.user_id)

    {:ok, user: user, conn: auth(build_conn(), user)}
  end

  describe "minting (R7/R9)" do
    test "exchanges a serial this server issued for an access token", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, body} = bridge_post(port, assertion, @credential)
      assert status == 200

      assert is_binary(body["access_token"]) and body["access_token"] != ""
      assert body["token_type"] == "Bearer"
      assert body["expires_in"] == div(Cytale.Config.access_token_ttl_ms(), 1000)

      # R9: access ONLY. Asserted as an absence, so a refresh token cannot be
      # added later without failing here.
      refute Map.has_key?(body, "refresh_token")

      # The token is a real one: it authenticates against the app listener.
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("authorization", "Bearer " <> body["access_token"])
        |> get("/api/v1/users/@me")

      assert conn.status == 200
      # `/users/@me` wraps the profile; the point of this assertion is that the
      # minted token authenticates as the right member on the APP listener.
      assert Jason.decode!(conn.resp_body)["user"]["username"] == user.username
    end

    test "a second mint for the same serial succeeds with a fresh nonce (the renewal path)", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, _body} = bridge_post(port, assertion, @credential)
      assert status == 200

      {status, _headers, body} = bridge_post(port, %{assertion | nonce: nonce()}, @credential)

      assert status == 200,
             "the same serial must re-mint: a session renews on it every access-token lifetime"

      assert is_binary(body["access_token"])
    end
  end

  describe "refusals (R8)" do
    test "a certificate whose account is a MACHINE principal is refused (security tier 1 #9e)", %{
      user: user,
      bridge_port: port
    } do
      {:ok, bot} = Cytale.Accounts.Principals.mint(user.user_id, :bot, unique("bridgebot"))
      tag = Cytale.Accounts.User.get(bot.user_id).username

      assertion = issue_directly(%{user_id: bot.user_id, username: tag})

      {status, _headers, body} = bridge_post(port, assertion, @credential)
      assert status == 403
      assert body["error"]["reason"] == "machine_account"
      refute Map.has_key?(body, "access_token")
    end

    test "an unknown serial is refused and audited", %{bridge_port: port} do
      {status, _headers, body} = bridge_post(port, unresolved(), @credential)
      assert status == 403
      assert body["error"]["reason"] == "unknown_serial"

      audits = Audit.list_for_account(Audit.unknown_account_id(), 1_000)

      assert Enum.any?(audits, &(&1.action == :mint_refused and &1.reason == "unknown_serial")),
             "a refusal must be audited (R8b)"
    end

    test "an expired serial is refused rather than accepted on signature alone", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      # A 1 ms TTL: the certificate and its issuance row are both born expired.
      with_ssh_ttl(1, fn ->
        assertion = issue_and_assert(conn, user)

        {status, _headers, body} = bridge_post(port, assertion, @credential)
        assert status == 403
        assert body["error"]["reason"] == "certificate_expired"
      end)
    end

    test "a removed key is refused (R5a)", %{conn: conn, user: user, bridge_port: port} do
      assertion = issue_and_assert(conn, user)

      {status, _headers, _body} = bridge_post(port, assertion, @credential)
      assert status == 200

      conn = delete(conn, "/api/v1/users/@me/ssh/certificates/#{assertion.key_id}")
      assert conn.status == 204

      {status, _headers, body} = bridge_post(port, assertion, @credential)
      assert status == 403
      assert body["error"]["reason"] == "unknown_serial"
    end

    test "a principal that does not match the serial's row is refused", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, body} =
        bridge_post(port, %{assertion | principal: "someone_else"}, @credential)

      assert status == 403
      assert body["error"]["reason"] == "principal_mismatch"
    end

    test "a fingerprint that does not match is refused", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, body} =
        bridge_post(
          port,
          %{assertion | fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
          @credential
        )

      assert status == 403
      assert body["error"]["reason"] == "fingerprint_mismatch"
    end

    test "an identity resolving to a deleted account is refused", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      :ok = User.soft_delete!(user.user_id)

      {status, _headers, body} = bridge_post(port, assertion, @credential)
      assert status == 403
      assert body["error"]["reason"] == "account_deleted"
    end

    test "an account failing the product's verification gate is refused", %{bridge_port: port} do
      # Issued directly: the member route itself is behind the verification choke
      # point, so an unverified account cannot reach it — this constructs the
      # state the bridge must still refuse ("consulting the same verification
      # gate the rest of the product uses", R8).
      {:ok, unverified} =
        User.create(unique("unv"), unique("unv") <> "@example.com", "password-123")

      assert Cytale.Config.require_verified_email?(),
             "this scenario only means something while the gate is on"

      {status, _headers, body} = bridge_post(port, issue_directly(unverified), @credential)
      assert status == 403
      assert body["error"]["reason"] == "unverified"
    end

    test "a wrongly-shaped request is refused as such", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, body} = bridge_post(port, Map.put(assertion, :nonce, nil), @credential)
      assert status == 400
      assert body["error"]["reason"] == "invalid_nonce"

      {status, _headers, body} =
        bridge_post(port, Map.put(assertion, :asserted_at, nil), @credential)

      assert status == 400
      assert body["error"]["reason"] == "invalid_asserted_at"
    end

    test "an assertion outside its acceptance window is refused", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      stale = issue_and_assert(conn, user) |> Map.put(:asserted_at, System.os_time(:second) - 10_000)

      {status, _headers, body} = bridge_post(port, stale, @credential)
      assert status == 403
      assert body["error"]["reason"] == "stale_assertion"
    end
  end

  describe "the credential (R8)" do
    test "a missing credential is refused", %{conn: conn, user: user, bridge_port: port} do
      {status, _headers, body} = bridge_post(port, issue_and_assert(conn, user), nil)
      assert status == 401
      assert body["error"]["reason"] == "missing_credential"
    end

    test "a credential of the right length but the wrong value is refused", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)
      wrong = "u2-bridge-test-credentiaL"

      assert String.length(wrong) == String.length(@credential)

      {status, _headers, body} = bridge_post(port, assertion, wrong)
      assert status == 401
      assert body["error"]["reason"] == "bad_credential"
    end

    test "a wrong credential never reaches the mint, even for a valid assertion", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      {status, _headers, _body} = bridge_post(port, issue_and_assert(conn, user), "nope")
      assert status == 401
    end
  end

  describe "replay (R8)" do
    test "a replayed assertion body is refused, and a fresh nonce still mints", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, _body} = bridge_post(port, assertion, @credential)
      assert status == 200

      {status, _headers, body} = bridge_post(port, assertion, @credential)
      assert status == 403
      assert body["error"]["reason"] == "replayed_assertion"

      # The SAME serial with a fresh nonce is a renewal, not a replay.
      {status, _headers, _body} = bridge_post(port, %{assertion | nonce: nonce()}, @credential)
      assert status == 200
    end
  end

  describe "the credential epoch (R13a)" do
    test "a mint is refused once the account's epoch has moved", %{
      conn: conn,
      user: user,
      bridge_port: port
    } do
      assertion = issue_and_assert(conn, user)

      {status, _headers, _body} = bridge_post(port, assertion, @credential)
      assert status == 200

      :ok = Auth.revoke_all_sessions(user.user_id)

      {status, _headers, body} = bridge_post(port, %{assertion | nonce: nonce()}, @credential)
      assert status == 403
      assert body["error"]["reason"] == "credential_epoch_moved"
    end

    test "an access token minted before the epoch moved stops authenticating", %{user: user} do
      token = Auth.issue_access_token(user.user_id, user.username, true)

      assert get(bearer(build_conn(), token), "/api/v1/users/@me").status == 200

      :ok = Auth.revoke_all_sessions(user.user_id)

      assert get(bearer(build_conn(), token), "/api/v1/users/@me").status == 401,
             "a moved epoch must reach a live access token"

      assert JWTAuthenticator.verify_token(token) == {:error, :invalid},
             "the gateway authenticator checks the same epoch"
    end

    test "a token minted before the claim existed still authenticates (fail-open)", %{user: user} do
      # Exactly the shape a pre-U2 deploy issued: signed with the app's own
      # secret, no `epoch` claim. Rejecting it would log every live session out
      # for up to one access-token lifetime on the deploy that added the epoch.
      now = System.system_time(:second)

      claims = %{
        "sub" => Integer.to_string(user.user_id),
        "username" => user.username,
        "verified" => true,
        "iat" => now,
        "exp" => now + 900
      }

      {:ok, token, _claims} =
        Joken.encode_and_sign(
          claims,
          Joken.Signer.create("HS256", "test-only-jwt-secret-do-not-ship")
        )

      assert get(bearer(build_conn(), token), "/api/v1/users/@me").status == 200
      assert {:ok, _identity} = JWTAuthenticator.verify_token(token)
    end

    # S7: the fail-open door is ONLY for accounts the epoch never reached.
    # Once an epoch row exists, a claim-less token can never be
    # revocation-proof (pre-migration tokens die at their ≤15-min TTL; after
    # a bump, "no claim" would let any revocation be downgraded away), so it
    # is refused by the plug AND the gateway authenticator.
    test "once the account has an epoch, a token without the claim is refused", %{user: user} do
      :ok = Auth.bump_credential_epoch!(user.user_id)

      now = System.system_time(:second)

      claims = %{
        "sub" => Integer.to_string(user.user_id),
        "username" => user.username,
        "verified" => true,
        "iat" => now,
        "exp" => now + 900
      }

      {:ok, token, _claims} =
        Joken.encode_and_sign(
          claims,
          Joken.Signer.create("HS256", "test-only-jwt-secret-do-not-ship")
        )

      assert Auth.epoch_current?(user.user_id, nil) == false

      assert get(bearer(build_conn(), token), "/api/v1/users/@me").status == 401,
             "a claim-less token must not survive an epoch bump"

      assert JWTAuthenticator.verify_token(token) == {:error, :invalid},
             "the gateway authenticator refuses the same token"
    end
  end

  describe "placement (R8a)" do
    test "the bridge path is absent from the app router", %{bridge_port: port} do
      assert BridgeServer.path() == "/internal/ssh/session"

      refute Enum.any?(CytaleWeb.Router.__routes__(), &(&1.path == BridgeServer.path())),
             "the bridge path must NOT exist on the app listener — Caddy proxies that one"

      # And it is absent over HTTP, not merely refused: a 404 from the app
      # origin, while the SAME path on the bridge's own listener answers.
      {status, _headers, _body} = app_post(BridgeServer.path(), %{}, @credential)
      assert status == 404

      assert {:ok, _socket} = :gen_tcp.connect({127, 0, 0, 1}, port, [:binary, active: false], 2_000)
    end

    test "the bridge runs its credential plug and never the member auth plug" do
      assert BridgeServer.credential_plug() == CytaleWeb.Plugs.BridgeAuth
      assert CytaleWeb.Plugs.BridgeAuth in BridgeServer.pipeline()
      refute CytaleWeb.Plugs.Auth in BridgeServer.pipeline()

      # The declaration the authorization matrix carries for it, asserted here
      # because the bridge is absent from the app router by design and so cannot
      # be resolved through it.
      assert {kind, plugs, _note} =
               CytaleWeb.AuthorizationMatrix.bridge_declarations()[
                 "POST #{BridgeServer.path()}"
               ]

      assert kind == :bridge
      assert CytaleWeb.Plugs.BridgeAuth in plugs
      refute CytaleWeb.Plugs.Auth in plugs
    end
  end

  # ---------------------------------------------------------------------------
  # fixtures + helpers
  # ---------------------------------------------------------------------------

  defp unique(base), do: base <> Cytale.TestNonce.get()

  defp auth(conn, user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)
    bearer(conn, access)
  end

  defp bearer(conn, token) do
    conn
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> token)
  end

  # Issue through the MEMBER route (the real flow) and turn the response into the
  # assertion body a session host would send.
  defp issue_and_assert(conn, user) do
    conn =
      conn
      |> put_req_header("content-type", "application/json")
      |> post(
        "/api/v1/users/@me/ssh/certificates",
        Jason.encode!(%{"public_key" => public_key_line()})
      )

    assert conn.status == 200, "issuance must succeed before the bridge can be asked anything"

    issued = Jason.decode!(conn.resp_body)
    assert issued["principal"] == user.username

    %{
      key_id: issued["key_id"],
      serial: issued["serial"],
      principal: issued["principal"],
      fingerprint: issued["fingerprint"],
      nonce: nonce(),
      asserted_at: System.os_time(:second)
    }
  end

  # The unverified-account fixture: issued without the member route, because the
  # route itself is behind the verification choke point.
  defp issue_directly(user) do
    line = public_key_line()
    {:ok, %{blob: blob}} = Cytale.SSH.Certificate.parse_public_key(line)
    key_id = CertificateStore.key_id(blob)
    fingerprint = CertificateStore.fingerprint(blob)
    serial = Cytale.Snowflake.next()

    {:ok, _key} =
      CertificateStore.put_key(user.user_id,
        key_id: key_id,
        fingerprint: fingerprint,
        public_key: line
      )

    {:ok, issued} =
      Cytale.SSH.issue_user_certificate(line,
        principal: user.username,
        serial: serial,
        key_id: Integer.to_string(serial)
      )

    :ok =
      CertificateStore.record_issuance(user.user_id, key_id, issued,
        fingerprint: fingerprint,
        credential_epoch: Auth.credential_epoch(user.user_id)
      )

    %{
      key_id: key_id,
      serial: Integer.to_string(serial),
      principal: user.username,
      fingerprint: fingerprint,
      nonce: nonce(),
      asserted_at: System.os_time(:second)
    }
  end

  # An assertion for a serial this server never issued.
  defp unresolved do
    %{
      serial: Integer.to_string(Cytale.Snowflake.next()),
      principal: "nobody",
      fingerprint: "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      nonce: nonce(),
      asserted_at: System.os_time(:second)
    }
  end

  defp nonce, do: Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)

  # Exactly the fields a session host sends; a nil override drops the key, which
  # is how a missing field is expressed on the wire.
  defp body_for(assertion) do
    assertion
    |> Map.take([:serial, :principal, :fingerprint, :nonce, :asserted_at])
    |> Enum.reject(fn {_key, value} -> is_nil(value) end)
    |> Map.new()
    |> Jason.encode!()
  end

  defp bridge_post(port, assertion, credential) do
    headers =
      [{"content-type", "application/json"}] ++
        if(credential, do: [{@credential_header, credential}], else: [])

    request =
      Finch.build(:post, "http://127.0.0.1:#{port}#{BridgeServer.path()}", headers, body_for(assertion))

    {:ok, %Finch.Response{status: status, headers: resp_headers, body: raw}} =
      Finch.request(request, finch())

    {status, normalize_headers(resp_headers), decode(raw)}
  end

  # The public edge's view: the APP listener, the one Caddy proxies.
  defp app_post(path, body, credential) do
    request =
      Finch.build(
        :post,
        app_base_url() <> path,
        [{"content-type", "application/json"}, {@credential_header, credential}],
        Jason.encode!(body)
      )

    {:ok, %Finch.Response{status: status, headers: resp_headers, body: raw}} =
      Finch.request(request, finch())

    {status, normalize_headers(resp_headers), decode(raw)}
  end

  defp app_base_url do
    port = Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]
    "http://127.0.0.1:#{port}"
  end

  defp normalize_headers(headers), do: Map.new(headers, fn {k, v} -> {String.downcase(k), v} end)

  defp decode(""), do: nil
  defp decode(raw), do: Jason.decode!(raw)

  defp finch do
    unless Process.whereis(CytaleTest.FinchBridge) do
      {:ok, _} = Finch.start_link(name: CytaleTest.FinchBridge)
    end

    CytaleTest.FinchBridge
  end

  defp with_ssh_ttl(ttl_ms, fun) do
    original = Application.get_env(:cytale, :ssh)

    try do
      Application.put_env(:cytale, :ssh, Keyword.put(original, :certificate_ttl_ms, ttl_ms))
      fun.()
    after
      Application.put_env(:cytale, :ssh, original)
    end
  end

  # A real ed25519 public key line (the certificate controller suite explains why
  # nothing here needs ssh-keygen).
  defp public_key_line do
    {point, _private} = :crypto.generate_key(:eddsa, :ed25519)
    blob = <<11::32, "ssh-ed25519", 32::32, point::binary>>
    "ssh-ed25519 " <> Base.encode64(blob) <> " cytale-u2-bridge-test"
  end
end
