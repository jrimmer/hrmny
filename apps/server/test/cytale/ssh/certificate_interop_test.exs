defmodule Cytale.SSH.CertificateInteropTest do
  @moduledoc """
  U1's real gate: a certificate this server issues authenticates a REAL client
  against a REAL `sshd` running on an ephemeral port with `TrustedUserCAKeys`
  pointed at the fixture CA.

  `ssh-keygen -L` is here too, but only as the weaker pre-check the plan names:
  it proves the bytes parse, not that OpenSSH's verifier accepts them. The
  authentication below is the gate.

  Two things this module refuses to do:

    * **Skip.** When `sshd` (or `ssh-keygen`, or `ssh`) is missing, the gate
      FAILS with a named reason — the path it looked for and the variable that
      overrides it — because this test is the only real proof of the
      hand-rolled format (the plan's stop condition for U1).
    * **Touch the deployment CA.** Every key here is generated into an
      owner-only (0700) temporary directory that is removed on exit. Nothing
      reads `Cytale.Config.ssh_ca_key_path/0` except the surface switch each
      test points at the fixture's own path.
  """

  use ExUnit.Case, async: false

  alias Cytale.SSHFixtures, as: F

  @ttl_ms 24 * 60 * 60 * 1000

  describe "the weaker pre-check: ssh-keygen parses the emitted certificate" do
    test "type user, the key id, the principal, and a 24-hour window" do
      dir = F.tmp_dir!("cytale-ssh-precheck")
      %{path: ca_path} = F.ca!(dir)
      subject = F.client_key!(dir, "subject_id_ed25519")
      login = F.local_login!()

      issued = issue!(ca_path, subject.public_line, login)

      cert_path = Path.join(dir, "id_ed25519-cert.pub")
      File.write!(cert_path, issued.line)

      {out, status} = F.run(:keygen, ["-L", "-f", cert_path])
      IO.puts("\n----- ssh-keygen -L -f #{cert_path} -----\n" <> out)

      assert status == 0, "ssh-keygen refused the certificate:\n#{out}"
      assert out =~ "Type: ssh-ed25519-cert-v01@openssh.com user certificate"
      assert out =~ ~s(Key ID: "#{issued.key_id}")
      assert out =~ login
      assert out =~ "Critical Options: (none)"

      %{from: from, to: to} = window(out)
      assert NaiveDateTime.diff(to, from) == 86_400
    end
  end

  describe "the gate: real client, real sshd" do
    test "a certificate issued here authenticates against sshd's TrustedUserCAKeys" do
      dir = F.tmp_dir!("cytale-ssh-gate")
      %{path: ca_path, ca: ca} = F.ca!(dir)
      login = F.local_login!()
      client = F.client_key!(dir)
      issued = issue!(ca_path, client.public_line, login)

      # The basename pairing is the point: `ssh -i id_ed25519` presents
      # `id_ed25519-cert.pub` with no extra flags (the names the web UI
      # downloads under).
      File.write!(client.private_path <> "-cert.pub", issued.line)

      sshd = F.start_sshd!(dir, ca)

      {out, status} = ssh(sshd.port, client.private_path, login)
      log = F.sshd_log(sshd)
      IO.puts("\n----- sshd log -----\n" <> log)

      assert status == 0,
             "the certificate did not authenticate (ssh exited #{status}):\n#{out}\n" <>
               "----- sshd -----\n#{sshd.started}#{log}"

      assert out =~ "AUTH_OK"
      assert log =~ "Accepted publickey"
      assert log =~ "ED25519-CERT"
      assert log =~ issued.key_id
    end

    test "the gate's control: the same client key without a certificate is refused" do
      dir = F.tmp_dir!("cytale-ssh-control")
      %{path: ca_path, ca: ca} = F.ca!(dir)
      login = F.local_login!()
      client = F.client_key!(dir)
      _issued = issue!(ca_path, client.public_line, login)

      # A copy with no `-cert.pub` sibling: a plain public key, no certificate.
      plain_key = Path.join(dir, "no_certificate_key")
      File.cp!(client.private_path, plain_key)
      File.chmod!(plain_key, 0o600)

      sshd = F.start_sshd!(dir, ca)

      {out, status} = ssh(sshd.port, plain_key, login)

      assert status != 0, "a key with no certificate must not authenticate:\n#{out}"
      assert out =~ "Permission denied"
      refute F.sshd_log(sshd) =~ "Accepted publickey"
    end
  end

  describe "the gate's failure mode" do
    test "a missing sshd fails the gate with a named reason rather than skipping" do
      original = Application.get_env(:cytale, :ssh)
      on_exit(fn -> Application.put_env(:cytale, :ssh, original) end)
      Application.put_env(:cytale, :ssh, enabled: false, sshd_bin: "/nonexistent/sshd")

      error = assert_raise RuntimeError, fn -> F.bin!(:sshd) end

      assert error.message =~ "OpenSSH interop gate"
      assert error.message =~ "/nonexistent/sshd"
      assert error.message =~ "CYTALE_OPENSSH_SSHD_BIN"
      # It refuses to run, rather than degrading into a parse check or a skip.
      assert error.message =~ "FAILS"
    end

    test "a missing ssh-keygen fails the pre-check with a named reason" do
      original = Application.get_env(:cytale, :ssh)
      on_exit(fn -> Application.put_env(:cytale, :ssh, original) end)
      Application.put_env(:cytale, :ssh, enabled: false, keygen_bin: "/nonexistent/ssh-keygen")

      error = assert_raise RuntimeError, fn -> F.bin!(:keygen) end

      assert error.message =~ "/nonexistent/ssh-keygen"
      assert error.message =~ "CYTALE_OPENSSH_KEYGEN_BIN"
    end
  end

  # ---------------------------------------------------------------------------
  # helpers
  # ---------------------------------------------------------------------------

  # Issuance goes through the PRODUCTION facade: the surface switched on and
  # pointed at the fixture CA path, the fixture key as the subject. The clock
  # is deliberately NOT pinned here — sshd checks the window against the real
  # wall clock, so a pinned clock would issue a certificate that is not yet
  # (or no longer) valid and the gate would fail for the wrong reason. The
  # window's arithmetic is pinned in `certificate_test.exs` instead.
  defp issue!(ca_path, public_key_line, login) do
    original = Application.get_env(:cytale, :ssh)

    on_exit(fn -> Application.put_env(:cytale, :ssh, original) end)

    Application.put_env(:cytale, :ssh,
      enabled: true,
      ca_key_path: ca_path,
      certificate_ttl_ms: @ttl_ms
    )

    assert {:ok, issued} =
             Cytale.SSH.issue_user_certificate(public_key_line,
               principal: login,
               key_id: "cytale-u1-interop"
             )

    issued
  end

  defp ssh(port, private_key, login) do
    # -F /dev/null: ignore the operator's ~/.ssh/config, which could otherwise
    # add an IdentityFile or a ProxyCommand and make this pass for the wrong
    # reason.
    F.run(:ssh, [
      "-F",
      "/dev/null",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "PreferredAuthentications=publickey",
      "-o",
      "LogLevel=ERROR",
      "-i",
      private_key,
      "-p",
      Integer.to_string(port),
      "-l",
      login,
      "127.0.0.1",
      "printf AUTH_OK"
    ])
  end

  defp window(output) do
    [_, from, to] = Regex.run(~r/Valid: from (\S+) to (\S+)/, output)

    %{from: NaiveDateTime.from_iso8601!(from), to: NaiveDateTime.from_iso8601!(to)}
  end
end
