defmodule Cytale.SSH.Certificate do
  @moduledoc """
  OpenSSH user-certificate encoder and signer (U1, R2/R3/R4).

  OTP cannot encode or sign an OpenSSH certificate in either direction, and no
  Hex package does, so the format is hand-rolled here (plan A3). On the wire a
  certificate is a length-prefixed byte layout followed by ONE signature over
  a defined prefix, which is all `:crypto.sign/4` and the key codecs need:

    * `string`  — 4-byte big-endian length, then the bytes
    * `uint64`  — bare 8-byte big-endian
    * `uint32`  — bare 4-byte big-endian

  Body field order (the signed range is fields 1-13, i.e. everything through
  the CA public key; the trailing `string signature` field is NOT signed):

    1.  string  algorithm name `"ssh-ed25519-cert-v01@openssh.com"`
    2.  string  32-byte random nonce
    3.  string  subject public key — the TYPE-SPECIFIC serialization, which for
                ed25519 is the raw 32-byte point (see `subject_field/1`; the
                `string("ssh-ed25519")` prefix belongs ONLY to the CA field)
    4.  uint64  serial
    5.  uint32  certificate type — 1 for user
    6.  string  key id
    7.  string  valid principals (a concatenation of `string` entries)
    8.  uint64  valid after (unix seconds)
    9.  uint64  valid before (unix seconds)
    10. string  critical options (empty here)
    11. string  extensions (empty here)
    12. string  reserved (empty)
    13. string  CA public-key blob (the full `ssh-ed25519 || point` blob)

  ## What R4 pins

  The principal is the member's Cytale username and nothing else; the window is
  24 hours from issuance (`Cytale.Config.ssh_certificate_ttl_ms/0`); and the
  certificate carries NO critical options — a verifier that does not implement
  one must refuse the certificate outright, so emitting none is what keeps the
  Go host's "reject any critical option" rule satisfiable (R10).

  An EMPTY principals list is a wildcard to OpenSSH's verifier: it matches any
  login name. A caller that has no principal therefore gets
  `{:error, :missing_principal}` and no certificate at all (R4) — the refusal
  happens before a byte is emitted, not by post-hoc validation.

  ## Determinism

  `issue/2` takes the nonce, the clock and the serial as options, so tests can
  pin all three and compare bytes. Production callers pass none of them: the
  nonce is 32 random bytes, the clock is the system clock, and the serial comes
  from `Cytale.Snowflake` (there is no counter table to coordinate). The
  testability split mirrors `Cytale.Accounts.Auth.sign_single_use_token/2`,
  which is the same shape for the same reason.
  """

  @cert_algorithm "ssh-ed25519-cert-v01@openssh.com"
  @key_algorithm "ssh-ed25519"
  @user_cert_type 1
  @nonce_bytes 32

  # The username charset `Cytale.Accounts.User` already validates (2..32 chars,
  # `[a-zA-Z0-9_.-]`): a principal is a username here, so a value that could
  # not have been a username is refused rather than escaped. That also keeps
  # the emitted comment field on one line. Anchored with \A..\z, not ^..$:
  # `$` also matches before a trailing newline, which would let "jordan\n"
  # through and split the emitted line in two.
  @principal_re ~r/\A[a-zA-Z0-9_.-]{2,32}\z/

  @typedoc "Why a certificate was refused. No reason here is a raise."
  @type issue_error ::
          :missing_principal
          | :invalid_principal
          | :invalid_public_key
          | :unsupported_key_type

  @typedoc """
  An issued certificate: the `-cert.pub` line plus the fields a caller stores
  for listing and auditing (R5, R6a are U2's; the values are produced here).
  """
  @type issued :: %{
          line: String.t(),
          payload: binary(),
          serial: integer(),
          key_id: String.t(),
          principal: String.t(),
          valid_after: integer(),
          valid_before: integer(),
          nonce: binary(),
          public_key_blob: binary()
        }

  @doc """
  Issue a user certificate for `public_key`, signed by `:ca` for `:principal`.

  Options:

    * `:ca` (required) — a `Cytale.SSH.CA.t()`; the signer's key material.
    * `:principal` (required) — the member's username (R4).
    * `:serial` — defaults to `Cytale.Snowflake.next/0`.
    * `:key_id` — defaults to the principal.
    * `:now` — unix seconds; defaults to the system clock. The window starts here.
    * `:ttl_ms` — defaults to `Cytale.Config.ssh_certificate_ttl_ms/0` (24 h).
    * `:nonce` — defaults to 32 random bytes (a test pins it for byte-stability).
    * `:comment` — the trailing comment on the emitted line; defaults to `:key_id`.

  Returns `{:ok, issued}` or `{:error, reason}` — a malformed or truncated
  public key is an error tuple, never an exception.
  """
  @spec issue(binary(), keyword()) :: {:ok, issued()} | {:error, issue_error()}
  def issue(public_key, opts) when is_list(opts) do
    ca = Keyword.fetch!(opts, :ca)

    with {:ok, principal} <- fetch_principal(opts),
         {:ok, key} <- parse_public_key(public_key) do
      serial = Keyword.get(opts, :serial, Cytale.Snowflake.next())
      key_id = Keyword.get(opts, :key_id, principal)
      now = Keyword.get(opts, :now, System.os_time(:second))
      ttl_ms = fetch_ttl_ms(opts)
      nonce = Keyword.get(opts, :nonce, :crypto.strong_rand_bytes(@nonce_bytes))
      comment = Keyword.get(opts, :comment, key_id)
      valid_before = now + div(ttl_ms, 1000)

      body =
        certificate_body(%{
          nonce: nonce,
          subject_point: key.point,
          serial: serial,
          key_id: key_id,
          principal: principal,
          valid_after: now,
          valid_before: valid_before,
          ca_public_blob: ca.public_blob
        })

      signature = :crypto.sign(:eddsa, :none, body, [ca.private_key, :ed25519])
      payload = body <> signature_field(signature)

      {:ok,
       %{
         line: @cert_algorithm <> " " <> Base.encode64(payload) <> " " <> comment <> "\n",
         payload: payload,
         serial: serial,
         key_id: key_id,
         principal: principal,
         valid_after: now,
         valid_before: valid_before,
         nonce: nonce,
         public_key_blob: key.blob
       }}
    end
  end

  # The 24-hour lifetime's single home is config (config/config.exs default,
  # runtime.exs override); a nonsense injected value falls back to it rather
  # than minting an already-expired certificate.
  defp fetch_ttl_ms(opts) do
    case Keyword.get(opts, :ttl_ms, Cytale.Config.ssh_certificate_ttl_ms()) do
      ms when is_integer(ms) and ms > 0 -> ms
      _other -> Cytale.Config.ssh_certificate_ttl_ms()
    end
  end

  @doc """
  Parse a submitted public key into its SSH wire blob and its raw ed25519 point.

  Accepts a full OpenSSH public-key line (`ssh-ed25519 <base64> [comment]`) or
  the bare base64 body. The blob is the identity value a fingerprint and a
  storage row want; the point is what the certificate's subject field holds.
  Anything else — a truncated blob, a certificate line, an RSA key, garbage —
  is `{:error, :invalid_public_key}` or `{:error, :unsupported_key_type}`,
  never a raise.
  """
  @spec parse_public_key(binary()) :: {:ok, %{blob: binary(), point: binary()}} | {:error, issue_error()}
  def parse_public_key(input) when is_binary(input) do
    with {:ok, blob} <- decode_input(input),
         {:ok, point} <- classify(blob) do
      {:ok, %{blob: blob, point: point}}
    end
  end

  def parse_public_key(_input), do: {:error, :invalid_public_key}

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  # A submitted public key is either the full line or its base64 body. The
  # line form is what the web UI posts (R1/R2); the base64 form is what a
  # caller holding only the body has.
  #
  # Any `ssh-*`/`ecdsa-*` algorithm is decoded and then classified, so a
  # member who pastes an RSA or ECDSA key gets "unsupported key type" rather
  # than the less useful "invalid key".
  defp decode_input(input) do
    case String.split(String.trim(input), ~r/\s+/, trim: true) do
      [algorithm, body | _comment] ->
        if algorithm =~ ~r/^(ssh|ecdsa)-/ do
          decode64(body)
        else
          {:error, :invalid_public_key}
        end

      [body] ->
        decode64(body)

      _other ->
        {:error, :invalid_public_key}
    end
  end

  defp decode64(body) do
    case Base.decode64(body) do
      {:ok, decoded} when byte_size(decoded) > 0 -> {:ok, decoded}
      _other -> {:error, :invalid_public_key}
    end
  end

  # The blob must be EXACTLY the ed25519 wire shape. OTP's own decoder accepts
  # several key families (and would happily read a certificate blob's leading
  # fields as a key), so the algorithm string and the 32-byte point are matched
  # structurally here rather than assumed: anything well-formed but different is
  # an unsupported key type, and anything that does not lay out is invalid.
  defp classify(<<11::32, "ssh-ed25519", 32::32, point::binary-size(32), _rest::binary>>) do
    {:ok, point}
  end

  defp classify(<<length::32, _algorithm::binary-size(length), _rest::binary>>)
       when length > 0 and length <= 64 do
    {:error, :unsupported_key_type}
  end

  defp classify(_blob), do: {:error, :invalid_public_key}

  defp fetch_principal(opts) do
    case Keyword.get(opts, :principal) do
      nil ->
        {:error, :missing_principal}

      principal when is_binary(principal) ->
        if Regex.match?(@principal_re, principal),
          do: {:ok, principal},
          else: {:error, :invalid_principal}

      _other ->
        {:error, :invalid_principal}
    end
  end

  defp certificate_body(f) do
    IO.iodata_to_binary([
      ssh_string(@cert_algorithm),
      ssh_string(f.nonce),
      subject_field(f.subject_point),
      <<f.serial::64>>,
      <<@user_cert_type::32>>,
      ssh_string(f.key_id),
      principals_field(f.principal),
      <<f.valid_after::64>>,
      <<f.valid_before::64>>,
      ssh_string(""),
      ssh_string(""),
      ssh_string(""),
      ssh_string(f.ca_public_blob)
    ])
  end

  # The subject key field is the TYPE-SPECIFIC public serialization — for
  # ed25519, `string(raw 32-byte point)` and NOT `string(string("ssh-ed25519")
  # || string(point))`. That asymmetry with the CA field is OpenSSH's, not a
  # shortcut here: `sshkey_certify_custom` calls the key implementation's
  # `serialize_public` for the subject (which for ed25519 is
  # `sshbuf_put_string(b, ed25519_pk, 32)` — see `ssh-ed25519.c`), while the CA
  # field is written from the full `sshkey_to_blob` blob. A subject field
  # carrying the algorithm prefix is rejected by `ssh-keygen`/`sshd` with
  # "invalid key: invalid format" — verified against OpenSSH 10.3p1.
  defp subject_field(point), do: ssh_string(point)

  # One principal: the field is a string containing a concatenation of
  # strings, and there is exactly one entry (R4 — the username, and nothing
  # else). An empty field would be a wildcard, which is why `issue/2` refuses
  # before reaching here.
  defp principals_field(principal), do: ssh_string(ssh_string(principal))

  # The signature field is a nested string: `string(string(algo) ||
  # string(raw 64-byte signature))`.
  defp signature_field(signature) do
    ssh_string(ssh_string(@key_algorithm) <> ssh_string(signature))
  end

  defp ssh_string(binary), do: <<byte_size(binary)::32, binary::binary>>
end
