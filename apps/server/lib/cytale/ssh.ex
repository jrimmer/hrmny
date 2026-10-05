defmodule Cytale.SSH do
  @moduledoc """
  The SSH certificate surface (U1): CA custody plus user-certificate issuance.

  Directory-plus-context, like `Cytale.Messages` over `messages/`
  (`Cytale.SSH.CA` and `Cytale.SSH.Certificate` are the parts; this is the
  front door callers use). What lives behind it:

    * `Cytale.SSH.CA` — the CA keypair, loaded from a configured path.
    * `Cytale.SSH.Certificate` — the OpenSSH certificate encoder and signer.

  ## The CA is loaded once and only when it is needed

  The signing key is read from `Cytale.Config.ssh_ca_key_path/0` and cached in
  `:persistent_term` for the node's life (keyed by the path, so a config change
  reloads it). Nothing here is required for the other three clients to work:
  this app serves every client from one process, so an unprovisioned deploy
  must not lose chat because the terminal's CA is missing. Two gates enforce
  that — `Cytale.Config.ssh_certificates_enabled?/0` (the surface switch) and
  the boot-time path check in `config/runtime.exs`, which fails fast ONLY when
  the switch is on.

  When the surface is off, `issue_user_certificate/2` returns
  `{:error, :disabled}` without touching the filesystem. When it is on and the
  key is missing, unreadable, malformed or not an unencrypted ed25519
  `openssh-key-v1` key, the raise names the path and the reason and carries no
  key material (`Cytale.SSH.CA` documents that posture).
  """

  alias Cytale.SSH.{CA, Certificate}

  @typedoc "Why issuance was refused."
  @type issue_error :: :disabled | Certificate.issue_error()

  @doc """
  Whether the SSH certificate surface is enabled on this node
  (`CYTALE_SSH_CERTIFICATES_ENABLED`, default false).
  """
  @spec enabled?() :: boolean()
  def enabled?, do: Cytale.Config.ssh_certificates_enabled?()

  @doc """
  The node's loaded CA keypair. Loaded on first use from the configured path,
  then cached; raises `Cytale.SSH.CA.Error` (redacted) when the key cannot be
  loaded.
  """
  @spec ca() :: CA.t()
  def ca do
    case Cytale.Config.ssh_ca_key_path() do
      nil ->
        raise CA.Error,
          message: "no SSH CA key path configured (CYTALE_SSH_CA_KEY_PATH); a certificate cannot be signed",
          reason: :missing,
          path: nil

      path ->
        cache_key = {__MODULE__, :ca}

        case :persistent_term.get(cache_key, nil) do
          %CA{source: ^path} = ca ->
            ca

          _other ->
            ca = CA.load!(path)
            :persistent_term.put(cache_key, ca)
            ca
        end
    end
  end

  @doc """
  Issue a user certificate for `public_key`, with the CA's signature.

  The principal is the member's Cytale username and is REQUIRED: an empty
  principals list is a wildcard to a verifier, so a request without one is
  refused rather than issued as valid-for-all (R4). `opts` are
  `Cytale.SSH.Certificate.issue/2`'s; production callers pass only
  `:principal` (the serial, clock and nonce default sensibly).

  Returns `{:error, :disabled}` when the surface is off — before any CA load.
  """
  @spec issue_user_certificate(binary(), keyword()) :: {:ok, Certificate.issued()} | {:error, issue_error()}
  def issue_user_certificate(public_key, opts \\ []) do
    if enabled?() do
      Certificate.issue(public_key, Keyword.put(opts, :ca, ca()))
    else
      {:error, :disabled}
    end
  end
end
