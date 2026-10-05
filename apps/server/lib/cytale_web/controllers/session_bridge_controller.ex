defmodule CytaleWeb.SessionBridgeController do
  @moduledoc """
  The bridge's mint handler (R7/R9): one action, one body shape.

  Request (`POST /internal/ssh/session`, header `x-cytale-bridge-credential`):

      {"serial": "…", "principal": "…", "fingerprint": "SHA256:…",
       "nonce": "…", "asserted_at": 1757800000}

  Response (`200`):

      {"access_token": "…", "token_type": "Bearer", "expires_in": 900}

  ACCESS ONLY — there is no refresh token field and there never will be (R9).
  A session that outlives its access token re-mints through the same route with
  a fresh nonce (the plan's KTD8 renewal loop).

  Refusals carry the machine-readable reason so the session host can log why a
  member's session ended and, where applicable, name the remedy to them
  (R19a's vocabulary starts here):

    * `400` — the request shape is wrong (`invalid_serial`, `invalid_nonce`,
      `invalid_asserted_at`, …);
    * `403` — a well-shaped assertion this server will not honour
      (`unknown_serial`, `certificate_expired`, `principal_mismatch`,
      `fingerprint_mismatch`, `account_deleted`, `unverified`,
      `credential_epoch_moved`, `replayed_assertion`, `stale_assertion`, …).

  Every one of those is audited by `Cytale.SessionBridge` (or, for the
  credential itself, by the plug) before the response is rendered.
  """

  use CytaleWeb, :controller

  alias Cytale.SessionBridge

  @doc "POST /internal/ssh/session — exchange an assertable identity for a token."
  def mint(conn, params) do
    case SessionBridge.mint(params) do
      {:ok, minted} ->
        json(conn, %{
          "access_token" => minted.access_token,
          "token_type" => minted.token_type,
          "expires_in" => minted.expires_in,
          # The resolved username rides back so the host can start the client
          # already knowing who it is, rather than the client re-resolving an
          # identity the host has just proven.
          "username" => minted.username
        })

      {:error, reason} ->
        error(conn, status_for(reason), reason)
    end
  end

  # A malformed request is the caller's bug (400); a well-formed assertion this
  # server declines is an authorization refusal (403).
  defp status_for(reason)
       when reason in [
              :invalid_serial,
              :invalid_principal,
              :invalid_fingerprint,
              :invalid_nonce,
              :invalid_asserted_at
            ],
       do: 400

  defp status_for(_reason), do: 403

  defp error(conn, status, reason) do
    conn
    |> put_status(status)
    |> json(%{
      "error" => %{
        "key" => "bridge_refused",
        "reason" => to_string(reason),
        "message" => message_for(reason)
      }
    })
  end

  # The reason vocabulary the session host renders (R19a). Kept short and
  # member-facing: the host owns the wording of the session-end message, this
  # owns the cause.
  defp message_for(:unknown_serial),
    do: "This certificate was not issued by this server."

  defp message_for(:certificate_expired),
    do: "This certificate has expired. Issue a new one and reconnect."

  defp message_for(:principal_mismatch),
    do: "The certificate's principal does not match this connection."

  defp message_for(:fingerprint_mismatch),
    do: "The certificate's public key does not match the stored key."

  defp message_for(:unknown_account), do: "No account for this certificate."

  defp message_for(:account_deleted), do: "This account has been deleted."

  defp message_for(:machine_account), do: "Bot and agent accounts cannot open a terminal session."

  defp message_for(:unverified),
    do: "This account is not verified for terminal access."

  defp message_for(:credential_epoch_moved),
    do: "This account's credentials were reset. Sign in again to continue."

  defp message_for(:replayed_assertion),
    do: "This assertion was already used."

  defp message_for(:stale_assertion),
    do: "This assertion is outside its acceptance window."

  defp message_for(:mint_failed),
    do: "The server could not issue a token right now."

  defp message_for(_other), do: "The bridge refused this request."
end
