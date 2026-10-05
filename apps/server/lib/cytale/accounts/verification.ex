defmodule Cytale.Accounts.Verification do
  @moduledoc """
  Email verification + password-reset orchestration (U8).

  Flows (all single-use, purpose-scoped tokens from `Cytale.Accounts.Auth`):

    * `send_verification/1` — issue + email a `verify_email` token (register
      and resend share it; resending invalidates the old token because the
      consume path deletes the row for the NEW token only... actually the old
      token stays consumable until TTL — see `invalidate_pending/2`).
    * `complete_email_verification/1` — consume the token, stamp
      `email_verified_at` on the user (lifts the view-only gate).
    * `request_password_reset/1` — always succeeds from the caller's
      perspective (no account enumeration: unknown identifiers silently
      no-op) but only issues a token for an existing, non-deleted user.
    * `complete_password_reset/2` — consume the token, set the new password
      hash, and revoke every session (all refresh tokens deleted — the
      "reset completes → old sessions revoked" scenario).

  Token single-use + purpose scoping is enforced by `Auth.verify_single_use_token/2`;
  resend invalidation is enforced here by deleting any PENDING row for the
  same user+purpose before issuing a new token.

  Delivery is best-effort: issuing the token and mailing it are separate
  outcomes. A mailer failure is logged and counted (telemetry) by the mailer
  seam, and the caller still succeeds — the pending row means a resend can
  deliver later, which is strictly better than failing a request whose
  side effect (the user row, the new password) already happened.
  """

  alias Cytale.Accounts.{Auth, Mailer, TwoFactor, User}
  alias Cytale.Repo

  @typedoc "Orchestration results (controller maps them to HTTP statuses)."
  @type verify_result :: :ok | {:error, :invalid_token | :consumed_token | :user_not_found}
  @type reset_result ::
          :ok | {:error, :invalid_token | :consumed_token | :user_not_found | :invalid_password}

  # ---------------------------------------------------------------------------
  # Email verification
  # ---------------------------------------------------------------------------

  @doc """
  Issue + email a verification token for the user. Deleting any pending
  `verify_email` row first is what makes RESEND invalidate the old token.
  """
  @spec send_verification(integer()) :: :ok | {:error, :user_not_found}
  def send_verification(user_id) do
    case User.get(user_id) do
      %{deleted_at: nil} = user ->
        invalidate_pending(user_id, "verify_email")
        {:ok, raw, hash} = Auth.issue_single_use_token(user_id, "verify_email")
        record_pending(user_id, "verify_email", hash)

        :ok =
          deliver(%{
            kind: :verify_email,
            to: user.email,
            username: user.username,
            token: raw
          })

        :ok

      %{deleted_at: %DateTime{}} ->
        {:error, :user_not_found}

      nil ->
        {:error, :user_not_found}
    end
  end

  @doc "Consume a `verify_email` token and stamp `email_verified_at`."
  @spec complete_email_verification(String.t()) :: verify_result()
  def complete_email_verification(raw_token) when is_binary(raw_token) do
    with {:ok, user_id} <- consume(raw_token, "verify_email"),
         %{} = user <- User.get(user_id),
         false <- not is_nil(user.deleted_at) do
      :ok = User.mark_verified!(user_id)
      :ok
    else
      {:error, reason} -> {:error, reason}
      nil -> {:error, :user_not_found}
      true -> {:error, :user_not_found}
    end
  end

  def complete_email_verification(_), do: {:error, :invalid_token}

  # ---------------------------------------------------------------------------
  # Password reset
  # ---------------------------------------------------------------------------

  @doc """
  Request a password reset. Anti-enumeration: returns `:ok` regardless of
  whether the identifier exists; only a real, non-deleted user receives mail.
  """
  @spec request_password_reset(String.t()) :: :ok
  def request_password_reset(identifier) when is_binary(identifier) do
    case User.get_by_identifier(identifier) do
      %{deleted_at: nil, password_hash: hash} = user when not is_nil(hash) ->
        user_id = user.user_id
        invalidate_pending(user_id, "password_reset")
        {:ok, raw, hash} = Auth.issue_single_use_token(user_id, "password_reset")
        record_pending(user_id, "password_reset", hash)

        :ok =
          deliver(%{
            kind: :password_reset,
            to: user.email,
            username: user.username,
            token: raw
          })

        :ok

      _ ->
        :ok
    end
  end

  def request_password_reset(_), do: :ok

  @doc """
  Consume a `password_reset` token, set the new password, and revoke every
  session for the user (refresh tokens all deleted — password-reset
  revocation scenario).

  Also clears the account's TOTP enrollment (#127): email possession is the
  recovery channel — the standard trade. Losing the authenticator must not
  brick the account; the reset link proves mailbox control, so the second
  factor is dropped along with the first. (The account without an enrollment
  re-enrolls at its next password login when the switch is on.)
  """
  @spec complete_password_reset(String.t(), String.t()) :: reset_result()
  def complete_password_reset(raw_token, new_password)
      when is_binary(raw_token) and is_binary(new_password) do
    if String.length(new_password) < 8 do
      {:error, :invalid_password}
    else
      with {:ok, user_id} <- consume(raw_token, "password_reset"),
           %{} = user <- User.get(user_id),
           false <- not is_nil(user.deleted_at) do
        :ok = User.update_password_hash!(user_id, Auth.hash_password(new_password))
        :ok = Auth.revoke_all_sessions(user_id)
        :ok = TwoFactor.clear_enrollment(user_id)
        :ok
      else
        {:error, reason} -> {:error, reason}
        nil -> {:error, :user_not_found}
        true -> {:error, :user_not_found}
      end
    end
  end

  def complete_password_reset(_, _), do: {:error, :invalid_token}

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  # Mail is best-effort by design: the PENDING ROW written above is what makes
  # the token real, so a mail failure degrades to "the user must resend once
  # the sink is fixed" — never to a failed register/password-reset request.
  # The result is deliberately dropped: the mailer logs the failure and emits
  # success: 0 on the delivery telemetry (the operator's signal).
  defp deliver(message) do
    Mailer.deliver(message)
    :ok
  end

  # Consume = verify signature + purpose + storage row (single-use inside Auth).
  defp consume(raw, purpose) do
    case Auth.verify_single_use_token(raw, purpose) do
      {:ok, user_id} -> {:ok, user_id}
      {:error, :consumed} -> {:error, :consumed_token}
      {:error, _} -> {:error, :invalid_token}
    end
  end

  # Delete any PENDING (unconsumed) token rows for the user+purpose so an old
  # emailed link stops working the moment a fresh one is issued (resend
  # invalidates old — plan scenario).
  defp invalidate_pending(user_id, purpose) do
    case Repo.execute(
           "SELECT token_hash FROM {{K}}.verification_tokens_by_user WHERE user_id = ? AND purpose = ?",
           [{"bigint", user_id}, {"text", purpose}]
         ) do
      {:ok, page} ->
        Enum.each(Enum.to_list(page), fn %{"token_hash" => hash} ->
          Repo.execute!("DELETE FROM {{K}}.verification_tokens WHERE token_hash = ?", [
            {"text", hash}
          ])
        end)

        # The holder partition itself is reset (fresh token re-records it).
        Repo.execute!(
          "DELETE FROM {{K}}.verification_tokens_by_user WHERE user_id = ? AND purpose = ?",
          [{"bigint", user_id}, {"text", purpose}]
        )

        :ok

      {:error, _} ->
        :ok
    end
  end

  # Maintain the holder-side lookup row (see verification_tokens_by_user).
  defp record_pending(user_id, purpose, hash) do
    Repo.execute!(
      "INSERT INTO {{K}}.verification_tokens_by_user (user_id, purpose, token_hash) VALUES (?, ?, ?)",
      [{"bigint", user_id}, {"text", purpose}, {"text", hash}]
    )

    :ok
  end

  # The anti-enumeration mail composition path resolves user fields once.
end
