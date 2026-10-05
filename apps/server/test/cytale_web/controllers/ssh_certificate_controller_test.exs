defmodule CytaleWeb.Controllers.SshCertificateControllerTest do
  @moduledoc """
  U2 member certificate surface (R2/R3a/R5/R5a/R6/R6a) — over real HTTP through
  the real pipeline, with real certificates signed by a fixture CA.

  The scenario that carries the security property is R3a's: a request body
  naming somebody else's principal must still produce a certificate for the
  CALLER, because the controller never reads that field. The certificate is then
  parsed by the real `ssh-keygen`, so "the right principal" is asserted against
  OpenSSH's reading of the bytes rather than against this suite's expectation.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.SSH.{Audit, CertificateStore}
  alias Cytale.SSHFixtures, as: F

  @endpoint CytaleWeb.Endpoint
  @ttl_ms 24 * 60 * 60 * 1000

  setup_all do
    original = Application.get_env(:cytale, :ssh)
    on_exit(fn -> Application.put_env(:cytale, :ssh, original) end)

    dir = F.tmp_dir!("cytale-u2-cert-controller")
    %{path: ca_path} = F.ca!(dir)

    # The fixture CA is the ONLY CA this suite signs with; the deployment key is
    # never read (the path is this test's own temp file).
    Application.put_env(:cytale, :ssh,
      enabled: true,
      ca_key_path: ca_path,
      certificate_ttl_ms: @ttl_ms
    )

    :ok = Cytale.Snowflake.ensure_init()
    %{dir: dir}
  end

  setup do
    {:ok, user} = User.create(unique("sshc"), unique("sshc") <> "@example.com", "password-123")
    :ok = User.mark_verified!(user.user_id)

    {:ok, conn: auth(build_conn(), user), user: user}
  end

  describe "issuing" do
    test "the certificate's principal is the caller's username (R4)", %{conn: conn, user: user} do
      line = public_key_line()

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => line})
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["principal"] == user.username
      assert body["certificate"] =~ "ssh-ed25519-cert-v01@openssh.com "
      assert body["fingerprint"] == expected_fingerprint(line)
      assert body["key_id"] != ""

      # The window is the configured 24 hours, and the OpenSSH key id IS the
      # serial so an sshd log line maps to exactly one issuance row.
      serial = String.to_integer(body["serial"])
      assert_in_delta Cytale.Snowflake.timestamp_ms(serial), System.system_time(:millisecond), 60_000

      {:ok, issued_at, _offset} = DateTime.from_iso8601(body["issued_at"])
      {:ok, expires_at, _offset} = DateTime.from_iso8601(body["expires_at"])
      assert DateTime.diff(expires_at, issued_at, :second) == div(@ttl_ms, 1000)
    end

    test "the emitted certificate parses as a user certificate for that principal", %{
      conn: conn,
      user: user,
      dir: dir
    } do
      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => public_key_line()})
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      cert_path = Path.join(dir, "issued-#{System.unique_integer([:positive])}-cert.pub")
      File.write!(cert_path, body["certificate"])

      {out, status} = F.run(:keygen, ["-L", "-f", cert_path])
      assert status == 0, "ssh-keygen refused the emitted certificate:\n#{out}"

      assert out =~ "Type: ssh-ed25519-cert-v01@openssh.com user certificate"
      assert out =~ user.username
      assert out =~ ~s(Key ID: "#{body["serial"]}")
      assert out =~ "Critical Options: (none)"
    end

    test "listing reports every certificate's expiry and its key fingerprint (R5)", %{
      conn: conn,
      dir: dir
    } do
      line = public_key_line()

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => line})
      assert conn.status == 200
      serial = Jason.decode!(conn.resp_body)["serial"]

      conn = get(conn, "/api/v1/users/@me/ssh/certificates")
      assert conn.status == 200

      assert [key] = Jason.decode!(conn.resp_body)["keys"]
      assert [certificate] = key["certificates"]

      assert certificate["serial"] == serial
      assert certificate["current"] == true
      assert certificate["expires_at"] != nil

      # The fingerprint is the member's way of telling which row matches the key
      # on their disk, so it is asserted against OpenSSH's own reading of the
      # key they submitted — not against this suite's copy of the algorithm.
      pub_path = Path.join(dir, "submitted-#{System.unique_integer([:positive])}.pub")
      File.write!(pub_path, line)

      {out, status} = F.run(:keygen, ["-lf", pub_path])
      assert status == 0, "ssh-keygen could not read the submitted key:\n#{out}"
      assert [ssh_fingerprint] = Regex.run(~r/SHA256:[A-Za-z0-9+\/]+/, out)

      assert key["fingerprint"] == ssh_fingerprint
    end

    test "re-issuing uses the stored key without it being resubmitted (R6)", %{conn: conn} do
      line = public_key_line()

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => line})
      assert conn.status == 200
      first = Jason.decode!(conn.resp_body)

      # No public key in this body at all — the key comes from the account.
      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates/#{first["key_id"]}/reissue", %{})
      assert conn.status == 200
      second = Jason.decode!(conn.resp_body)

      assert second["serial"] != first["serial"]
      assert second["principal"] == first["principal"]
      assert second["fingerprint"] == first["fingerprint"]
      assert second["key_id"] == first["key_id"]

      conn = get(conn, "/api/v1/users/@me/ssh/certificates")
      assert [key] = Jason.decode!(conn.resp_body)["keys"]

      # Both rows are listed: superseded is not revoked (R5), and exactly one is
      # the current issuance.
      assert length(key["certificates"]) == 2
      assert Enum.count(key["certificates"], & &1["current"]) == 1

      current = Enum.find(key["certificates"], & &1["current"])
      assert current["serial"] == second["serial"]
    end

    test "removing a stored key prevents further issuance against it (R5a)", %{conn: conn} do
      line = public_key_line()

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => line})
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      key_id = body["key_id"]

      conn = delete(conn, "/api/v1/users/@me/ssh/certificates/#{key_id}")
      assert conn.status == 204

      conn = get(conn, "/api/v1/users/@me/ssh/certificates")
      assert Jason.decode!(conn.resp_body)["keys"] == []

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates/#{key_id}/reissue", %{})
      assert conn.status == 404

      # And the issuance row is gone from the bridge's lookup too: a removed key
      # is not a hidden key.
      assert CertificateStore.get_by_serial(String.to_integer(body["serial"])) == nil
    end
  end

  describe "the session is the only principal source (R3a)" do
    test "a body naming another account's principal is ignored", %{conn: conn, user: user} do
      {:ok, victim} =
        User.create(unique("sshvictim"), unique("sshvictim") <> "@example.com", "password-123")

      :ok = User.mark_verified!(victim.user_id)

      conn =
        post_json(conn, "/api/v1/users/@me/ssh/certificates", %{
          "public_key" => public_key_line(),
          "principal" => victim.username
        })

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      assert body["principal"] == user.username,
             "the principal must come from the authenticated session, never the body"

      refute body["principal"] == victim.username

      # The victim gained nothing: no key, no certificate.
      assert CertificateStore.list_keys(victim.user_id) == []
    end
  end

  describe "refusals" do
    test "an unauthenticated caller is refused", %{user: user} do
      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => public_key_line()})
      assert conn.status == 401
      assert CertificateStore.list_keys(user.user_id) == []
    end

    test "a malformed public key is refused and audited (R6a)", %{conn: conn, user: user} do
      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => "not-a-key"})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "invalid_public_key"

      events = Audit.list_for_account(user.user_id)

      assert Enum.any?(events, &(&1.action == :issue_refused and &1.reason == "invalid_public_key")),
             "a refusal must be audited with its reason"
    end

    test "a second member cannot list, re-issue, or remove another member's keys", %{
      conn: conn,
      user: user
    } do
      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => public_key_line()})
      assert conn.status == 200
      key_id = Jason.decode!(conn.resp_body)["key_id"]

      {:ok, other} = User.create(unique("sshother"), unique("sshother") <> "@example.com", "password-123")
      :ok = User.mark_verified!(other.user_id)
      other_conn = auth(build_conn(), other)

      # B's own list is empty — A's key is not reachable through an @me route.
      conn_b = get(other_conn, "/api/v1/users/@me/ssh/certificates")
      assert Jason.decode!(conn_b.resp_body)["keys"] == []

      conn_b = post_json(other_conn, "/api/v1/users/@me/ssh/certificates/#{key_id}/reissue", %{})
      assert conn_b.status == 404

      conn_b = delete(other_conn, "/api/v1/users/@me/ssh/certificates/#{key_id}")
      assert conn_b.status == 404

      # A's key survived every one of B's attempts.
      conn = get(conn, "/api/v1/users/@me/ssh/certificates")
      assert [key] = Jason.decode!(conn.resp_body)["keys"]
      assert key["id"] == key_id
      assert CertificateStore.list_keys(user.user_id) != []
    end

    test "the per-account issuance cap is enforced", %{conn: conn} do
      for _i <- 1..CertificateStore.max_keys_per_account() do
        conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => public_key_line()})
        assert conn.status == 200
      end

      conn = post_json(conn, "/api/v1/users/@me/ssh/certificates", %{"public_key" => public_key_line()})

      assert conn.status == 409
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "key_limit_reached"
    end
  end

  describe "an account with no certificates" do
    test "lists an empty result rather than erroring", %{conn: conn} do
      conn = get(conn, "/api/v1/users/@me/ssh/certificates")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"keys" => []}
    end
  end

  # ---------------------------------------------------------------------------
  # helpers
  # ---------------------------------------------------------------------------

  defp unique(base), do: base <> Cytale.TestNonce.get()

  defp auth(conn, user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    conn
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  defp post_json(conn, path, body) do
    conn
    |> recycle()
    |> put_req_header("content-type", "application/json")
    |> post(path, Jason.encode!(body))
  end

  # A real ed25519 public key line, built the way OpenSSH builds one:
  # string("ssh-ed25519") || string(32-byte point), base64-encoded behind the
  # algorithm name. Nothing here needs ssh-keygen — the suite's independent
  # checks run it on the bytes that get emitted.
  defp public_key_line do
    {point, _private} = :crypto.generate_key(:eddsa, :ed25519)
    blob = <<11::32, "ssh-ed25519", 32::32, point::binary>>
    "ssh-ed25519 " <> Base.encode64(blob) <> " cytale-u2-test"
  end

  # The OpenSSH fingerprint, computed here from the submitted line's own bytes so
  # the assertion is over the BLOB the server hashed rather than over the text.
  defp expected_fingerprint(line) do
    [algorithm, body | _rest] = String.split(String.trim(line), ~r/\s+/, trim: true)
    assert algorithm == "ssh-ed25519"
    blob = Base.decode64!(body)
    "SHA256:" <> Base.encode64(:crypto.hash(:sha256, blob), padding: false)
  end
end
