defmodule CytaleWeb.SshCertificateController do
  @moduledoc """
  Member certificate surface (U2, R2/R3a/R5/R5a/R6/R6a).

  Four routes, all scoped to the CALLER's own account by construction — the
  path says `@me` and every lookup keys on `conn.assigns.current_user.user_id`,
  so there is no id in the request that could name somebody else's certificate:

      POST   /api/v1/users/@me/ssh/certificates                  issue
      GET    /api/v1/users/@me/ssh/certificates                  list
      POST   /api/v1/users/@me/ssh/certificates/:key_id/reissue  re-issue
      DELETE /api/v1/users/@me/ssh/certificates/:key_id          remove a stored key

  ## The principal is the session's, and only the session's

  R3a is implemented by NOT READING the body's `principal` at all. A client
  that sends `"principal": "someone-else"` gets a certificate for its own
  username, because `conn.assigns.current_user.username` is the only source
  this module consults (the session's identity came from a verified access
  token). A request body cannot reach the signer's principal argument.

  ## What the response carries

  Issue/re-issue return the `-cert.pub` line plus the values a client needs to
  save the right file and to find the row again later: the serial, the
  principal, the OpenSSH fingerprint, the key's route-addressable id, and the
  validity window. The certificate's OpenSSH `key_id` IS its serial, so an
  operator reading an `sshd` log line (`Accepted publickey … ID <key-id>`) can
  match it to exactly one issuance row — the audit trail's whole purpose is
  being able to answer "what was this?".

  List returns every stored key with its certificates, newest first, each
  marked `current` or superseded (R5): certificates are superseded rather than
  revoked, so the older rows stay visible until the retention TTL evicts them.

  ## Refusals are audited

  Every refusal — a malformed key, an unsupported key type, the account's
  stored-key cap, the surface being switched off — is written to
  `Cytale.SSH.Audit` with its reason (R6a) before the error is rendered.
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.Auth
  alias Cytale.SSH
  alias Cytale.SSH.{Audit, Certificate, CertificateStore}
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "POST /api/v1/users/@me/ssh/certificates — issue for a submitted public key."
  def issue(conn, params) do
    %{user_id: account_id, username: principal} = conn.assigns.current_user

    with {:ok, key} <- parse_key(params["public_key"]) do
      case CertificateStore.put_key(account_id,
             key_id: CertificateStore.key_id(key.blob),
             fingerprint: key.fingerprint,
             public_key: key.line,
             comment: key.comment
           ) do
        {:ok, stored} ->
          issue_for(conn, stored, principal)

        {:error, :key_limit_reached} ->
          refuse(conn, 409, "key_limit_reached", limit_message(),
            account_id: account_id,
            principal: principal,
            fingerprint: key.fingerprint,
            reason: :key_limit_reached
          )
      end
    else
      {:error, reason} ->
        refuse(conn, 400, "invalid_public_key", public_key_message(reason),
          account_id: account_id,
          principal: principal,
          reason: reason
        )
    end
  end

  @doc """
  GET /api/v1/users/@me/ssh/certificates — every stored key with its
  certificates. An account with none gets `{"keys": []}`, never an error.
  """
  def index(conn, _params) do
    %{user_id: account_id} = conn.assigns.current_user

    certificates = CertificateStore.list_certificates(account_id)

    keys =
      account_id
      |> CertificateStore.list_keys()
      |> Enum.map(fn key ->
        %{
          "id" => key.key_id,
          "fingerprint" => key.fingerprint,
          "created_at" => iso8601(key.created_at),
          "certificates" =>
            certificates
            |> Enum.filter(&(&1.key_id == key.key_id))
            |> Enum.map(&certificate_json/1)
        }
      end)

    json(conn, %{"keys" => keys})
  end

  @doc """
  POST /api/v1/users/@me/ssh/certificates/:key_id/reissue — a new certificate
  for a key the member already stored (R6). The key is NOT resubmitted; it is
  read back from the caller's own account, so a key id belonging to another
  member is simply not found.
  """
  def reissue(conn, %{"key_id" => key_id}) do
    %{user_id: account_id, username: principal} = conn.assigns.current_user

    case CertificateStore.get_key(account_id, key_id) do
      nil ->
        error(conn, 404, "key_not_found", "No stored SSH key with that id.")

      %{public_key: line} = stored ->
        case parse_key(line) do
          {:ok, _key} ->
            issue_for(conn, stored, principal)

          {:error, reason} ->
            # The stored line is unreadable, which is a server-side inconsistency
            # rather than a bad request: audited, and answered as a conflict so
            # the member's remedy (remove the key, submit it again) is reachable.
            refuse(conn, 409, "key_unusable", "This stored key cannot be used to issue a certificate.",
              account_id: account_id,
              principal: principal,
              fingerprint: stored.fingerprint,
              reason: reason
            )
        end
    end
  end

  @doc """
  DELETE /api/v1/users/@me/ssh/certificates/:key_id — remove a stored key
  (R5a). The key row, its certificates, and the bridge's by-serial rows all go,
  so further issuance AND further mints against that key are impossible — which
  is the only revocation this surface has, and the reason the removal is a
  delete rather than a flag.
  """
  def delete(conn, %{"key_id" => key_id}) do
    %{user_id: account_id, username: principal} = conn.assigns.current_user

    case CertificateStore.get_key(account_id, key_id) do
      nil ->
        error(conn, 404, "key_not_found", "No stored SSH key with that id.")

      key ->
        :ok = CertificateStore.remove_key(account_id, key_id)

        :ok =
          Audit.record(%{
            account_id: account_id,
            action: :key_removed,
            outcome: :ok,
            principal: principal,
            fingerprint: key.fingerprint
          })

        send_resp(conn, 204, "")
    end
  end

  # ---------------------------------------------------------------------------
  # Shared issuance path (issue + re-issue land here)
  # ---------------------------------------------------------------------------

  defp issue_for(conn, %{key_id: key_id, fingerprint: fingerprint, public_key: line}, principal) do
    %{user_id: account_id} = conn.assigns.current_user

    # The certificate's serial is minted here rather than inside the signer so
    # the OpenSSH key id (which IS the serial) and the row can never disagree
    # about which issuance an sshd log line refers to.
    serial = Cytale.Snowflake.next()

    case SSH.issue_user_certificate(line,
           principal: principal,
           serial: serial,
           key_id: Integer.to_string(serial),
           comment: "cytale-#{principal}"
         ) do
      {:ok, issued} ->
        :ok =
          CertificateStore.record_issuance(account_id, key_id, issued,
            fingerprint: fingerprint,
            credential_epoch: Auth.credential_epoch(account_id)
          )

        :ok =
          Audit.record(%{
            account_id: account_id,
            action: :issued,
            outcome: :ok,
            serial: issued.serial,
            principal: issued.principal,
            fingerprint: fingerprint
          })

        json(conn, issued_json(issued, key_id, fingerprint))

      {:error, :disabled} ->
        refuse(conn, 503, "ssh_disabled", "SSH certificate issuance is not enabled on this server.",
          account_id: account_id,
          principal: principal,
          fingerprint: fingerprint,
          reason: :disabled
        )

      {:error, reason} ->
        refuse(conn, 500, "issuance_failed", public_key_message(reason),
          account_id: account_id,
          principal: principal,
          fingerprint: fingerprint,
          reason: reason
        )
    end
  end

  # ---------------------------------------------------------------------------
  # Parsing + rendering
  # ---------------------------------------------------------------------------

  # Accepts the OpenSSH line the web UI posts (R2) or the bare base64 body. The
  # blob is what a fingerprint, a stored row and the signer all work from, so it
  # is parsed exactly once, here.
  defp parse_key(input) when is_binary(input) do
    case Certificate.parse_public_key(input) do
      {:ok, %{blob: blob}} ->
        {:ok,
         %{
           blob: blob,
           line: String.trim(input),
           fingerprint: CertificateStore.fingerprint(blob),
           comment: input_comment(input)
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp parse_key(_input), do: {:error, :invalid_public_key}

  defp input_comment(input) do
    case String.split(input, ~r/\s+/, trim: true) do
      [_algorithm, _body, comment | _rest] -> comment
      _other -> nil
    end
  end

  defp issued_json(issued, key_id, fingerprint) do
    %{
      "certificate" => issued.line,
      "serial" => Integer.to_string(issued.serial),
      "principal" => issued.principal,
      "fingerprint" => fingerprint,
      "key_id" => key_id,
      # The signer's window is unix seconds (the certificate's own encoding),
      # so it is converted here rather than re-derived from a clock.
      "issued_at" => iso8601_unix(issued.valid_after),
      "expires_at" => iso8601_unix(issued.valid_before),
      "current" => true
    }
  end

  defp iso8601_unix(seconds) when is_integer(seconds) do
    seconds |> DateTime.from_unix!() |> iso8601()
  end

  defp certificate_json(cert) do
    %{
      "serial" => Integer.to_string(cert.serial),
      "principal" => cert.principal,
      "issued_at" => iso8601(cert.issued_at),
      "expires_at" => iso8601(cert.valid_before),
      "current" => cert.is_current
    }
  end

  # Scylla `timestamp` columns decode as `DateTime` structs (Xandra's default
  # `timestamp_format: :datetime`), so a row needs no conversion. `nil` only
  # appears when a column is absent, and JSON null is the honest rendering.
  defp iso8601(nil), do: nil

  defp iso8601(%DateTime{} = dt) do
    dt |> DateTime.truncate(:second) |> DateTime.to_iso8601()
  end

  defp limit_message do
    "This account already holds #{CertificateStore.max_keys_per_account()} SSH keys. " <>
      "Remove one before adding another."
  end

  defp public_key_message(:invalid_public_key) do
    "That does not look like an SSH public key. Paste the contents of your key's .pub file."
  end

  defp public_key_message(:unsupported_key_type) do
    "Only ed25519 SSH keys are supported. Generate one with: ssh-keygen -t ed25519"
  end

  defp public_key_message(:missing_principal) do
    "This account cannot be used as a certificate principal."
  end

  defp public_key_message(:invalid_principal) do
    "This account cannot be used as a certificate principal."
  end

  defp public_key_message(_reason) do
    "The certificate could not be issued."
  end

  # One refusal path, so R6a's "every refusal is audited" cannot be forgotten at
  # one of them. `audit_fields` carries the reason and whatever identity the
  # attempt had reached.
  defp refuse(conn, status, key, message, audit_fields) do
    :ok =
      Audit.record(Enum.into(audit_fields, %{action: :issue_refused, outcome: :refused}))

    error(conn, status, key, message)
  end
end
