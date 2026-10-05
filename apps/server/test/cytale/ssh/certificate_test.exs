defmodule Cytale.SSH.CertificateTest do
  @moduledoc """
  U1's signer, checked at the byte level.

  Everything here runs against in-memory ed25519 key pairs and the deterministic
  seam (`:nonce`, `:now`, `:serial`), so no OpenSSH binary and no database is
  needed for the properties themselves — the suite still boots the repo helper
  (and therefore ScyllaDB) like every other module, per `AGENTS.md`.

  The real proof of the format is `certificate_interop_test.exs`, which
  authenticates against a real `sshd`; this module is the fast, precise half.
  """

  use ExUnit.Case, async: false

  alias Cytale.SSHFixtures, as: F
  alias Cytale.SSH.{CA, Certificate}

  @cert_algorithm "ssh-ed25519-cert-v01@openssh.com"
  @ed25519_oid {1, 3, 101, 112}
  @fixed_now 1_800_000_000
  @fixed_nonce :binary.copy(<<0xAB>>, 32)
  @fixed_serial 42
  @principal "jordan"
  @ttl_ms 24 * 60 * 60 * 1000
  @server_root Path.expand("../../..", __DIR__)

  setup do
    {ca_pub, ca_priv} = :crypto.generate_key(:eddsa, :ed25519)
    ca = CA.from_raw(ca_priv, ca_pub)

    {pub, _priv} = :crypto.generate_key(:eddsa, :ed25519)
    blob = public_key_blob(pub)

    subject = %{
      point: pub,
      blob: blob,
      line: "ssh-ed25519 " <> Base.encode64(blob) <> " subject@example.com\n"
    }

    {:ok, ca: ca, subject: subject}
  end

  describe "determinism (the signing seam)" do
    test "a fixed nonce and clock produce identical bytes twice", ctx do
      first = issue!(ctx.ca, ctx.subject)
      second = issue!(ctx.ca, ctx.subject)

      assert first.line == second.line
      assert first.payload == second.payload
      assert first.line |> String.ends_with?("\n")
      assert first.nonce == @fixed_nonce
    end

    test "without a pinned nonce two issuances differ", ctx do
      opts = [ca: ctx.ca, principal: @principal, serial: @fixed_serial, now: @fixed_now]

      assert {:ok, first} = Certificate.issue(ctx.subject.line, opts)
      assert {:ok, second} = Certificate.issue(ctx.subject.line, opts)

      refute first.nonce == second.nonce
      refute first.payload == second.payload
    end

    test "the window is exactly the configured TTL from the caller's clock", ctx do
      issued = issue!(ctx.ca, ctx.subject)

      assert issued.valid_after == @fixed_now
      assert issued.valid_before == @fixed_now + 86_400
      assert Cytale.Config.ssh_certificate_ttl_ms() == @ttl_ms
    end

    test "a shorter injected TTL shrinks the window and nothing else", ctx do
      issued = issue!(ctx.ca, ctx.subject, ttl_ms: 60_000)

      assert issued.valid_before - issued.valid_after == 60
    end
  end

  describe "principals (R4)" do
    test "a request with no principal is refused before emission", ctx do
      assert {:error, :missing_principal} = Certificate.issue(ctx.subject.line, ca: ctx.ca)
      assert {:error, :missing_principal} = Certificate.issue(ctx.subject.line, ca: ctx.ca, principal: nil)
    end

    test "a principal that is not a username is refused", ctx do
      # An empty principals list is a WILDCARD to a verifier, so "" must not
      # ride through as one principal whose bytes happen to be empty.
      for bad <- ["", " ", "j", "jordan\n", "jordan jordan", "a@b", String.duplicate("x", 33), :jordan] do
        assert {:error, :invalid_principal} = Certificate.issue(ctx.subject.line, ca: ctx.ca, principal: bad),
               "expected #{inspect(bad)} to be refused as a principal"
      end
    end

    test "the certificate carries exactly the one principal requested", ctx do
      issued = issue!(ctx.ca, ctx.subject)

      assert principal_entries(parse(issued.payload).principals) == [@principal]
    end
  end

  describe "the submitted public key" do
    test "a full OpenSSH line and its bare base64 body agree", ctx do
      from_line = issue!(ctx.ca, ctx.subject)
      from_base64 = issue!(ctx.ca, %{ctx.subject | line: Base.encode64(ctx.subject.blob)})

      assert from_line.payload == from_base64.payload
    end

    test "a malformed or truncated key is an error, never a raise", ctx do
      inputs = [
        nil,
        42,
        "",
        "ssh-ed25519",
        "not-a-key",
        "ssh-ed25519 !!!!",
        "ssh-ed25519 " <> Base.encode64(<<1, 2, 3>>),
        Base.encode64(binary_part(ctx.subject.blob, 0, 20)),
        <<0, 1, 2, 3>>
      ]

      for input <- inputs do
        assert {:error, reason} = Certificate.issue(input, ca: ctx.ca, principal: @principal),
               "expected #{inspect(input)} to be refused"

        assert reason in [:invalid_public_key, :unsupported_key_type]
      end
    end

    test "another key type is refused by name", ctx do
      # Algorithm-shaped, not a real RSA key: the algorithm string is what
      # classifies the blob, and this is the ssh-rsa shape OpenSSH sends.
      rsa_blob = ssh_string("ssh-rsa") <> ssh_string(<<0>>) <> ssh_string(<<1, 0, 1>>)

      assert {:error, :unsupported_key_type} =
               Certificate.issue("ssh-rsa " <> Base.encode64(rsa_blob), ca: ctx.ca, principal: @principal)
    end

    test "an emitted certificate is not accepted back as a subject key", ctx do
      issued = issue!(ctx.ca, ctx.subject)

      assert {:error, reason} = Certificate.issue(issued.line, ca: ctx.ca, principal: @principal)
      assert reason in [:invalid_public_key, :unsupported_key_type]
    end
  end

  describe "the emitted certificate body" do
    test "fields appear in the documented order and values", ctx do
      parsed = parse(issue!(ctx.ca, ctx.subject).payload)

      assert parsed.algorithm == @cert_algorithm
      assert byte_size(parsed.nonce) == 32
      assert parsed.nonce == @fixed_nonce
      assert parsed.subject_field == ssh_string(ctx.subject.point)
      assert parsed.ca_blob == ctx.ca.public_blob
      assert parsed.serial == @fixed_serial
      assert parsed.type == 1
      assert parsed.key_id == @principal
      assert parsed.valid_after == @fixed_now
      assert parsed.valid_before == @fixed_now + 86_400
    end

    test "the subject field is the raw point, not a key blob with an algorithm", ctx do
      # OpenSSH writes the TYPE-SPECIFIC public serialization for the subject
      # (`string(point)` for ed25519) while the CA field is the full blob. A
      # subject field carrying the algorithm prefix is what makes ssh-keygen
      # and sshd answer "invalid key: invalid format".
      parsed = parse(issue!(ctx.ca, ctx.subject).payload)

      assert parsed.subject == ctx.subject.point
      assert parsed.subject_field == ssh_string(ctx.subject.point)
      assert byte_size(parsed.subject_field) == 4 + 32
      refute parsed.subject == ctx.subject.blob

      assert parsed.ca_blob == ctx.ca.public_blob
      assert byte_size(parsed.ca_blob) == 4 + 11 + 4 + 32
    end

    test "critical options are empty — the host rejects any it does not act on (R10)", ctx do
      parsed = parse(issue!(ctx.ca, ctx.subject).payload)

      assert parsed.critical_options == ""
      assert parsed.extensions == ""
      assert parsed.reserved == ""
    end

    test "the signature is a nested string over the body through the CA key field", ctx do
      issued = issue!(ctx.ca, ctx.subject)
      parsed = parse(issued.payload)
      ca = ctx.ca

      assert parsed.signature_algorithm == "ssh-ed25519"
      assert byte_size(parsed.signature) == 64

      assert :public_key.verify(
               parsed.signed,
               :none,
               parsed.signature,
               {{:ECPoint, ca.public_key}, {:namedCurve, @ed25519_oid}}
             )

      # The signed range ends at the CA key field: the trailing signature field
      # is the ONLY thing after it.
      assert byte_size(parsed.signed) + 4 + byte_size(parsed.signature_field) == byte_size(issued.payload)
    end

    test "the CA key field is inside the signed range", ctx do
      issued = issue!(ctx.ca, ctx.subject)
      parsed = parse(issued.payload)

      # Flip the last byte of the signed range — the tail of the CA public-key
      # blob. If it were not signed, the signature would still verify.
      flip_at = byte_size(parsed.signed) - 1
      <<head::binary-size(^flip_at), last>> = parsed.signed
      tampered = <<head::binary, Bitwise.bxor(last, 1)>>

      refute :public_key.verify(
               tampered,
               :none,
               parsed.signature,
               {{:ECPoint, ctx.ca.public_key}, {:namedCurve, @ed25519_oid}}
             )

      assert tampered != parsed.signed

      assert binary_part(tampered, 0, byte_size(parsed.ca_blob)) ==
               binary_part(parsed.signed, 0, byte_size(parsed.ca_blob))
    end

    test "the default serial comes from Snowflake, and rises", ctx do
      first = issue!(ctx.ca, ctx.subject, serial: nil)
      second = issue!(ctx.ca, ctx.subject, serial: nil)

      assert first.serial > Cytale.Snowflake.epoch_ms()
      assert second.serial > first.serial
    end
  end

  describe "the emitted line" do
    test "names the certificate algorithm and carries the key id as its comment", ctx do
      issued = issue!(ctx.ca, ctx.subject)

      assert String.starts_with?(issued.line, @cert_algorithm <> " ")
      assert String.ends_with?(issued.line, " " <> @principal <> "\n")
      assert issued.key_id == @principal
      assert [_alg, b64, _comment] = String.split(issued.line, " ", parts: 3)
      assert Base.decode64!(b64) == issued.payload
    end

    test "an explicit key id and comment are used verbatim", ctx do
      issued = issue!(ctx.ca, ctx.subject, key_id: "cytale-u1", comment: "cytale key cytale-u1")

      assert issued.key_id == "cytale-u1"
      assert String.ends_with?(issued.line, " cytale key cytale-u1\n")
      assert parse(issued.payload).key_id == "cytale-u1"
    end
  end

  describe "CA custody (R3)" do
    test "a malformed key file raises with the path and never the file's bytes" do
      path = Path.join(F.tmp_dir!("cytale-ssh-ca"), "ca")
      File.write!(path, "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRETKEYMATERIALMARKER\n")
      File.chmod!(path, 0o600)

      error = assert_raise CA.Error, fn -> CA.load!(path) end

      assert error.message =~ path
      refute error.message =~ "SECRETKEYMATERIALMARKER"
      assert error.reason == :unsupported
    end

    test "a truncated ed25519 openssh key is refused by name, not coerced" do
      path = Path.join(F.tmp_dir!("cytale-ssh-ca"), "ca")

      File.write!(
        path,
        "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n" <>
          "-----END OPENSSH PRIVATE KEY-----\n"
      )

      assert {:error, :malformed} = CA.load(path)
    end

    test "a missing key is refused by name" do
      path = Path.join(F.tmp_dir!("cytale-ssh-ca"), "absent")

      assert {:error, :missing} = CA.load(path)
      assert assert_raise(CA.Error, fn -> CA.load!(path) end).reason == :missing
    end

    test "an unreadable key is refused by name" do
      # A directory reads as :eisdir whatever the effective uid, so this
      # exercises the branch without assuming the runner is not root.
      dir = F.tmp_dir!("cytale-ssh-ca")

      assert {:error, :unreadable} = CA.load(dir)
      assert assert_raise(CA.Error, fn -> CA.load!(dir) end).reason == :unreadable
    end

    test "a raw pair is validated against itself" do
      {pub, priv} = :crypto.generate_key(:eddsa, :ed25519)
      assert %CA{} = CA.from_raw(priv, pub)

      {other_pub, _} = :crypto.generate_key(:eddsa, :ed25519)
      error = assert_raise CA.Error, fn -> CA.from_raw(priv, other_pub) end
      assert error.reason == :mismatched

      assert_raise CA.Error, fn -> CA.from_raw(<<1, 2, 3>>, pub) end
    end

    test "public_line/2 is the same key the certificate is signed with" do
      {pub, priv} = :crypto.generate_key(:eddsa, :ed25519)
      ca = CA.from_raw(priv, pub)

      ["ssh-ed25519", b64 | _] = String.split(CA.public_line(ca, "cytale-test-ca"), " ")
      assert Base.decode64!(b64) == ca.public_blob
      assert CA.fingerprint(ca) =~ ~r/^SHA256:[A-Za-z0-9+\/]+$/
    end
  end

  describe "the surface switch (runtime.exs posture)" do
    setup do
      original = Application.get_env(:cytale, :ssh)
      on_exit(fn -> Application.put_env(:cytale, :ssh, original) end)
      :ok
    end

    test "with the surface off, issuance is inert and no CA path is required", ctx do
      Application.put_env(:cytale, :ssh, enabled: false, ca_key_path: nil, certificate_ttl_ms: @ttl_ms)

      refute Cytale.SSH.enabled?()
      assert Cytale.Config.ssh_ca_key_path() == nil
      assert {:error, :disabled} = Cytale.SSH.issue_user_certificate(ctx.subject.line, principal: @principal)
    end

    test "with the surface on, a bad CA key fails with the path and no key bytes", ctx do
      path = Path.join(F.tmp_dir!("cytale-ssh-ca"), "ca")
      File.write!(path, "SECRETKEYMATERIALMARKER\n")
      Application.put_env(:cytale, :ssh, enabled: true, ca_key_path: path, certificate_ttl_ms: @ttl_ms)

      error =
        assert_raise CA.Error, fn ->
          Cytale.SSH.issue_user_certificate(ctx.subject.line, principal: @principal)
        end

      assert error.message =~ path
      refute error.message =~ "SECRETKEYMATERIALMARKER"
    end

    test "the boot fails fast on a missing CA key only when the surface is on" do
      missing = Path.join(System.tmp_dir!(), "cytale-ssh-absent-#{System.unique_integer([:positive])}")

      {enabled_out, enabled_status} =
        boot([{"CYTALE_SSH_CERTIFICATES_ENABLED", "true"}, {"CYTALE_SSH_CA_KEY_PATH", missing}])

      assert enabled_status != 0, "a boot with the SSH surface on and no CA key must not succeed"
      assert enabled_out =~ "CYTALE_SSH_CA_KEY_PATH"
      assert enabled_out =~ missing
      refute enabled_out =~ "boot_ok"

      {off_out, off_status} = boot([{"CYTALE_SSH_CERTIFICATES_ENABLED", "false"}])
      assert off_status == 0, "a boot with the SSH surface off must not require a CA key:\n#{off_out}"
      assert off_out =~ "boot_ok"
    end
  end

  # ---------------------------------------------------------------------------
  # helpers
  # ---------------------------------------------------------------------------

  # A nil override is dropped so the certificate's own default applies (that is
  # how `serial: nil` reaches Snowflake).
  defp issue!(ca, subject, overrides \\ []) do
    opts =
      [ca: ca, principal: @principal, serial: @fixed_serial, now: @fixed_now, nonce: @fixed_nonce]
      |> Keyword.merge(overrides)
      |> Enum.reject(fn {_key, value} -> is_nil(value) end)

    assert {:ok, issued} = Certificate.issue(subject.line, opts)
    issued
  end

  # Configuration is evaluated at BOOT, so the honest way to assert the boot
  # posture is to boot: `mix run --no-compile --no-start` re-evaluates
  # config/runtime.exs without starting the app (so it touches neither the
  # endpoint nor ScyllaDB).
  defp boot(env) do
    mix = System.find_executable("mix") || raise "mix is not on PATH"

    # `--no-deps-check` (with `--no-compile`) keeps this boot out of the shared
    # build directory: it only has to evaluate config/runtime.exs, and writing
    # _build while the suite that spawned it is still running makes the boot
    # fail for a reason that has nothing to do with the CA key.
    System.cmd(
      mix,
      ["run", "--no-compile", "--no-deps-check", "--no-start", "-e", ~s{IO.puts("boot_ok")}],
      cd: @server_root,
      stderr_to_stdout: true,
      # The inherited environment is PINNED rather than trusted. This boot's
      # subject is the CA-key posture, and sibling suites deliberately write
      # invalid values into these to exercise their validators
      # (application_test sets the worker id to "not-a-number", ice_test sets
      # the media port range to a malformed string). An inherited bad value
      # fails THIS boot first and reports a cause belonging to another file —
      # which is exactly how both were first seen. `env` entries win over the
      # inherited values.
      env:
        [
          {"MIX_ENV", "test"},
          {"SNOWFLAKE_WORKER_ID", "0"},
          {"CYTALE_MEDIA_UDP_PORT_RANGE", "50000-50999"}
        ] ++ env
    )
  end

  defp parse(payload) do
    {algorithm, r1} = take_string(payload)
    {nonce, r2} = take_string(r1)
    {subject, r3} = take_string(r2)
    <<serial::64, r4::binary>> = r3
    <<type::32, r5::binary>> = r4
    {key_id, r6} = take_string(r5)
    {principals, r7} = take_string(r6)
    <<valid_after::64, r8::binary>> = r7
    <<valid_before::64, r9::binary>> = r8
    {critical_options, r10} = take_string(r9)
    {extensions, r11} = take_string(r10)
    {reserved, r12} = take_string(r11)
    {ca_blob, r13} = take_string(r12)
    {signature_field, <<>>} = take_string(r13)
    {signature_algorithm, sig_rest} = take_string(signature_field)
    {signature, <<>>} = take_string(sig_rest)

    %{
      algorithm: algorithm,
      nonce: nonce,
      subject: subject,
      subject_field: ssh_string(subject),
      serial: serial,
      type: type,
      key_id: key_id,
      principals: principals,
      valid_after: valid_after,
      valid_before: valid_before,
      critical_options: critical_options,
      extensions: extensions,
      reserved: reserved,
      ca_blob: ca_blob,
      signature_field: signature_field,
      signature_algorithm: signature_algorithm,
      signature: signature,
      signed: binary_part(payload, 0, byte_size(payload) - 4 - byte_size(signature_field))
    }
  end

  defp take_string(<<length::32, rest::binary>>) do
    <<value::binary-size(^length), tail::binary>> = rest
    {value, tail}
  end

  defp ssh_string(binary), do: <<byte_size(binary)::32, binary::binary>>

  defp public_key_blob(point), do: ssh_string("ssh-ed25519") <> ssh_string(point)

  defp principal_entries(principals) do
    principals
    |> Stream.unfold(fn
      <<>> -> nil
      bin -> take_string(bin)
    end)
    |> Enum.to_list()
  end
end
