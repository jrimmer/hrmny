defmodule Cytale.SSH.CA do
  @moduledoc """
  Certificate-authority key custody (U1, R3).

  The CA's ed25519 signing keypair is provisioned by an operator at a PATH in
  configuration (`CYTALE_SSH_CA_KEY_PATH`, read through
  `Cytale.Config.ssh_ca_key_path/0`) — never as an environment VALUE and never
  in argv. A value is readable from the environment and from the host's
  `/proc`, and this key mints certificates for every account; the path
  indirection is what keeps the bytes out of both. The key is read once and
  held in memory by `Cytale.SSH.ca/0`; nothing here writes it anywhere, and
  nothing here is ever asked to serialize it back out.

  ## What it loads, and why the container is parsed here

  `openssh-key-v1` — the container `ssh-keygen -t ed25519 -f <path>` writes,
  read as an unencrypted PEM body through `:public_key.pem_decode/1`. The
  container is then walked by hand rather than through OTP's `:ssh_file`
  decoder, and that is a deliberate, verified choice: `:ssh` is not among this
  app's declared applications, so Mix prunes its modules from the code path and
  a runtime `:ssh_file.decode/2` call raises `:ssh_file is not available`
  (reproduced), and an issue-time `:crypto`-only read is what makes the CA
  loader usable from a release. The layout is short and documented, and the
  bytes parsed are exactly the ones `ssh-keygen` wrote:

      "openssh-key-v1\\0"
      string  ciphername            ("none" when unencrypted)
      string  kdfname               ("none")
      string  kdfoptions            (empty)
      uint32  key count
      string  public key blob
      string  private key block

  The private block holds two matching check integers, then
  `string type, string public, string private, string comment` plus padding. For
  ed25519 the private string is 64 bytes — the 32-byte seed followed by the
  public half — and the loader keeps the seed, re-deriving the public half and
  cross-checking it through `from_raw/3`.

  A key in any other shape — a PKCS#8 PEM, an encrypted OpenSSH key, an
  RSA/ECDSA key — is refused with a named reason instead of being coerced.
  An encrypted key is deliberately not prompted for: boot has no console, and
  an operator who encrypts the CA key must provision a decrypted copy for the
  service to read (see `docs/self-hosting.md`).

  ## Redaction

  A failure message names the PATH and the reason, never the key material —
  the same posture `config/runtime.exs` already takes for the TURN
  credentials (`turn_auth!/4`'s "credential: set" markers). Every error path
  here returns an atom or a bare path; no function in this module ever
  interpolates file contents into a message.
  """

  @openssh_magic <<"openssh-key-v1", 0>>

  @typedoc """
  A loaded CA keypair. Both keys are raw 32-byte ed25519 binaries; `public_blob`
  is the SSH wire blob (`string("ssh-ed25519") || string(pubkey)`) that a
  certificate embeds as its CA-key field.
  """
  @type t :: %__MODULE__{
          private_key: <<_::256>>,
          public_key: <<_::256>>,
          public_blob: binary(),
          source: Path.t() | nil
        }

  @typedoc "Why a CA key could not be loaded (no key material, ever)."
  @type load_error :: :missing | :unreadable | :malformed | :unsupported | :mismatched

  defstruct [:private_key, :public_key, :public_blob, :source]

  defmodule Error do
    @moduledoc """
    A CA key problem, carrying a message that names the path and the reason
    only — never key material.
    """
    defexception [:message, :reason, :path]

    @type t :: %__MODULE__{message: String.t(), reason: atom(), path: Path.t() | nil}
  end

  @doc """
  Build a CA from raw 32-byte ed25519 halves.

  The explicit-pair seam: tests use it to stay off the filesystem, and it is
  what a future non-file custodian (an HSM, a secrets agent) would hand back.
  The public half is verified against the private half, so a caller cannot
  pair two unrelated keys by accident.
  """
  @spec from_raw(binary(), binary(), Path.t() | nil) :: t()
  def from_raw(private_key, public_key, source \\ nil)

  def from_raw(private_key, public_key, source)
      when is_binary(private_key) and byte_size(private_key) == 32 and is_binary(public_key) and
             byte_size(public_key) == 32 do
    case :crypto.generate_key(:eddsa, :ed25519, private_key) do
      {^public_key, ^private_key} ->
        %__MODULE__{
          private_key: private_key,
          public_key: public_key,
          public_blob: public_blob(public_key),
          source: source
        }

      _other ->
        raise Error,
          message: "SSH CA key pair does not match (public half is not derived from the private half)",
          reason: :mismatched,
          path: source
    end
  end

  def from_raw(_private_key, _public_key, source) do
    raise Error,
      message:
        "SSH CA keys must be raw 32-byte ed25519 binaries" <>
          if(source, do: " (path: #{source})", else: ""),
      reason: :malformed,
      path: source
  end

  @doc """
  Load the CA keypair from `path` (an unencrypted `openssh-key-v1` private key).

  Returns `{:ok, t}` or `{:error, reason}` — the error side is the named,
  key-material-free reason. `load!/1` is the raising form used on the signing
  path and at boot.
  """
  @spec load(Path.t()) :: {:ok, t()} | {:error, load_error()}
  def load(path) when is_binary(path) do
    case File.read(path) do
      {:ok, pem} ->
        case decode(pem) do
          {:ok, %{private_key: priv, public_key: pub}} -> {:ok, from_raw(priv, pub, path)}
          {:error, reason} -> {:error, reason}
        end

      {:error, :enoent} ->
        {:error, :missing}

      {:error, _other} ->
        {:error, :unreadable}
    end
  rescue
    e in Error -> {:error, e.reason}
  end

  @doc "Raising form of `load/1`; the raised message never contains key material."
  @spec load!(Path.t()) :: t()
  def load!(path) when is_binary(path) do
    case load(path) do
      {:ok, ca} -> ca
      {:error, reason} -> raise Error, message: error_message(reason, path), reason: reason, path: path
    end
  end

  @doc """
  The CA's public key as an `authorized_keys`-style line:
  `ssh-ed25519 <base64 blob> <comment>`. This is what a verifier's trust set
  holds (`TrustedUserCAKeys` for OpenSSH, the host's CA allowlist for U4).
  """
  @spec public_line(t(), String.t()) :: String.t()
  def public_line(%__MODULE__{public_blob: blob}, comment \\ "cytale-ca") do
    "ssh-ed25519 " <> Base.encode64(blob) <> " " <> comment <> "\n"
  end

  @doc "SHA256 fingerprint of the CA public key (`SHA256:<base64>`) — public data, safe to log."
  @spec fingerprint(t()) :: String.t()
  def fingerprint(%__MODULE__{public_blob: blob}) do
    "SHA256:" <> Base.encode64(:crypto.hash(:sha256, blob), padding: false)
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  # `openssh-key-v1` decode, narrowed to the ed25519 pair this module wants.
  # Every failure collapses to a named atom — no decode error term is surfaced,
  # so no fragment of the file can ride a message out of here.
  defp decode(pem) do
    with {:ok, body} <- container(pem),
         {:ok, private_key} <- private_key(body) do
      # The private half is the whole requirement: the public half is derived
      # from it, and `from_raw/3` re-checks the pair before it is trusted.
      {public_key, ^private_key} = :crypto.generate_key(:eddsa, :ed25519, private_key)
      {:ok, %{private_key: private_key, public_key: public_key}}
    end
  end

  defp container(pem) do
    case safe_pem_decode(pem) do
      [{_type, body, :not_encrypted}] when is_binary(body) -> {:ok, body}
      _other -> {:error, :unsupported}
    end
  end

  defp safe_pem_decode(pem) do
    :public_key.pem_decode(pem)
  rescue
    _any -> :error
  end

  defp private_key(<<@openssh_magic::binary, rest::binary>>) do
    with {:ok, cipher, r1} <- take_string(rest),
         {:ok, kdf, r2} <- take_string(r1),
         {:ok, _kdf_options, r3} <- take_string(r2),
         <<_key_count::32, r4::binary>> <- r3,
         {:ok, _public_blob, r5} <- take_string(r4),
         {:ok, block, _r6} <- take_string(r5),
         :ok <- unencrypted(cipher, kdf) do
      ed25519_key(block)
    else
      {:error, reason} -> {:error, reason}
      _other -> {:error, :malformed}
    end
  end

  defp private_key(_other), do: {:error, :unsupported}

  # "none"/"none" is an unencrypted key. A cipher name or a KDF name means the
  # key is passphrase-protected, which boot cannot prompt for.
  defp unencrypted("none", "none"), do: :ok
  defp unencrypted(_cipher, _kdf), do: {:error, :unsupported}

  # The unencrypted private block: two equal check integers (they detect a
  # wrong passphrase), then the key record.
  defp ed25519_key(<<check1::32, check2::32, rest::binary>>) when check1 == check2 do
    with {:ok, "ssh-ed25519", r1} <- take_string(rest),
         {:ok, _embedded_public, r2} <- take_string(r1),
         {:ok, <<seed::binary-size(32), _rest_private::binary>>, _r3} <- take_string(r2) do
      {:ok, seed}
    else
      {:ok, _other_algorithm, _r1} -> {:error, :unsupported}
      _other -> {:error, :malformed}
    end
  end

  defp ed25519_key(_other), do: {:error, :malformed}

  defp take_string(<<length::32, rest::binary>>) do
    case rest do
      <<value::binary-size(^length), tail::binary>> -> {:ok, value, tail}
      _short -> :error
    end
  end

  defp take_string(_other), do: :error

  # The ed25519 public-key wire blob, exactly the bytes OpenSSH expects:
  # `string("ssh-ed25519") || string(raw 32-byte point)`. Built here rather
  # than through OTP's `:ssh_message:ssh2_pubkey_encode/1` for the same reason
  # the container is parsed here — and the OTP shape is worth recording: its
  # curve OID is the TUPLE `{1,3,101,112}` (`?'id-Ed25519'` in
  # `public_key.hrl`), not the atom, so passing `:"id-Ed25519"` raises.
  defp public_blob(public_key) do
    ssh_string("ssh-ed25519") <> ssh_string(public_key)
  end

  defp ssh_string(binary), do: <<byte_size(binary)::32, binary::binary>>

  defp error_message(:missing, path),
    do: "SSH CA key not found at #{path} (CYTALE_SSH_CA_KEY_PATH)"

  defp error_message(:unreadable, path),
    do: "SSH CA key at #{path} is not readable by this process (CYTALE_SSH_CA_KEY_PATH)"

  defp error_message(:unsupported, path),
    do:
      "SSH CA key at #{path} is not an unencrypted ed25519 openssh-key-v1 private key " <>
        "(generate one with: ssh-keygen -t ed25519 -f <path> -N '')"

  defp error_message(:malformed, path),
    do: "SSH CA key at #{path} is malformed: no 32-byte ed25519 key pair in the file"

  defp error_message(:mismatched, path),
    do: "SSH CA key at #{path} is inconsistent: its public half does not derive from its private half"
end
