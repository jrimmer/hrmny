defmodule CytaleWeb.Plugs.BridgeAuth do
  @moduledoc """
  The session bridge's credential gate (R8): the ONLY way a request reaches
  `CytaleWeb.SessionBridgeController.mint/2`.

  This plug is the bridge's `CytaleWeb.Plugs.Auth` counterpart and its
  deliberate opposite: it never reads a member token, never consults
  `:api_auth`, and never assigns `current_user`. The bridge is reached by a
  machine caller holding one shared credential, and the identity it carries is
  an assertion the mint verifies against this server's own issuance records —
  not an authenticated member session.

  Comparison is constant time over SHA-256 hashes
  (`Cytale.SessionBridge.verify_credential/1`), the same
  `Plug.Crypto.secure_compare` shape `Cytale.Webhooks` and the gateway socket
  already use. Hashing both sides first is what makes the lengths equal, so a
  wrong-length credential cannot be distinguished from a wrong one.

  A refusal is a uniform 401 with no oracle — and it is AUDITED (R8b): a
  credential refusal with no account behind it lands in the audit trail's
  unknown-account partition, which is the only place a credential-stuffing
  attempt could be seen at all.
  """

  @behaviour Plug

  import Plug.Conn

  alias Cytale.SessionBridge
  alias Cytale.SSH.Audit

  # A dedicated header, not `Authorization`: the bridge's credential is not a
  # member token, and reusing the member scheme would make a mistake in one
  # surface look like a legitimate call in the other.
  @credential_header "x-cytale-bridge-credential"

  @doc "The request header carrying the bridge credential."
  @spec credential_header() :: String.t()
  def credential_header, do: @credential_header

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    presented = presented_credential(conn)

    if SessionBridge.verify_credential(presented) do
      conn
    else
      reason = if is_binary(presented), do: :bad_credential, else: :missing_credential
      refuse(conn, reason)
    end
  end

  defp presented_credential(conn) do
    case get_req_header(conn, @credential_header) do
      [value | _] when is_binary(value) -> String.trim(value)
      _other -> nil
    end
  end

  defp refuse(conn, reason) do
    :ok =
      Audit.record(%{
        account_id: nil,
        action: :mint_refused,
        outcome: :refused,
        reason: reason
      })

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(401, Jason.encode!(error_envelope(reason)))
    |> halt()
  end

  defp error_envelope(reason) do
    %{
      "error" => %{
        "key" => "bridge_unauthorized",
        "reason" => to_string(reason),
        "message" => "The bridge credential is missing or incorrect."
      }
    }
  end
end
