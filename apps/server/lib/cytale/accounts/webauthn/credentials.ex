defmodule Cytale.Accounts.WebAuthn.Credentials do
  @moduledoc """
  ScyllaDB access for stored WebAuthn credentials (ticket #36).

  Two denormalized tables (see the schema file for the full rationale):

    * `webauthn_credentials` — one partition per account: the owner's list
      (settings, excludeCredentials at enrollment).
    * `webauthn_credentials_by_id` — one row per credential, partitioned by
      the base64url credential id: the login path's single point read (the
      discoverable assertion names only the credential). The COSE key and
      sign count ride BOTH rows, so a verify never fans out.

  Writes go by_id-first through a lightweight transaction (`IF NOT EXISTS`)
  — that is where credential-id uniqueness is enforced; the owner-list row
  mirrors the winner. A delete removes both rows: row absence IS revocation
  (the login lookup answers nil and the credential stops authenticating).
  """

  alias Cytale.Accounts.WebAuthn.Credential

  # -- Writes ----------------------------------------------------------------------

  @doc """
  Store a freshly-attested credential: the by_id row first (uniqueness gate),
  then the owner-list mirror. `{:error, :credential_id_taken}` when the id is
  already registered — to ANY account (a credential id is globally unique per
  the WebAuthn spec, so the collision refuses regardless of owner).
  """
  @spec put(Credential.t()) :: :ok | {:error, :credential_id_taken}
  def put(%Credential{} = credential) do
    case insert_by_id(credential) do
      :ok ->
        insert_owner_row(credential)
        :ok

      {:error, _} = error ->
        error
    end
  end

  defp insert_by_id(%Credential{} = c) do
    case Cytale.Repo.execute(
           "INSERT INTO {{K}}.webauthn_credentials_by_id
            (credential_id, user_id, public_key, sign_count, created_at)
            VALUES (?, ?, ?, ?, ?) IF NOT EXISTS",
           [
             {"text", c.credential_id},
             {"bigint", c.user_id},
             {"text", c.public_key_b64},
             {"bigint", c.sign_count},
             {"timestamp", c.created_at}
           ]
         ) do
      {:ok, page} ->
        if applied?(page), do: :ok, else: {:error, :credential_id_taken}

      {:error, _reason} ->
        # A guard the server cannot write is a guard it cannot honour (the
        # session-bridge nonce posture): refuse the enrollment rather than
        # store a credential whose uniqueness was never proven.
        {:error, :credential_id_taken}
    end
  end

  defp insert_owner_row(%Credential{} = c) do
    Cytale.Repo.execute!(
      "INSERT INTO {{K}}.webauthn_credentials
       (user_id, credential_id, public_key, sign_count, backup_eligible, backup_state, name, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", c.user_id},
        {"text", c.credential_id},
        {"text", c.public_key_b64},
        {"bigint", c.sign_count},
        {"boolean", c.backup_eligible},
        {"boolean", c.backup_state},
        {"text", c.name},
        {"timestamp", c.created_at},
        {"timestamp", nil}
      ]
    )

    :ok
  end

  @doc """
  Record a successful authentication: the new (monotonic) sign count and the
  last-used timestamp, on both rows.
  """
  @spec record_usage(integer(), String.t(), non_neg_integer(), DateTime.t()) :: :ok
  def record_usage(user_id, credential_id, sign_count, used_at)
      when is_integer(user_id) and is_binary(credential_id) do
    used_at = DateTime.truncate(used_at, :millisecond)

    Cytale.Repo.execute!(
      "UPDATE {{K}}.webauthn_credentials_by_id SET sign_count = ? WHERE credential_id = ?",
      [{"bigint", sign_count}, {"text", credential_id}]
    )

    Cytale.Repo.execute!(
      "UPDATE {{K}}.webauthn_credentials
       SET sign_count = ?, last_used_at = ? WHERE user_id = ? AND credential_id = ?",
      [{"bigint", sign_count}, {"timestamp", used_at}, {"bigint", user_id}, {"text", credential_id}]
    )

    :ok
  end

  @doc "Revoke a credential: delete both rows. Absence is the revocation."
  @spec delete(integer(), String.t()) :: :ok
  def delete(user_id, credential_id) when is_integer(user_id) and is_binary(credential_id) do
    Cytale.Repo.execute!(
      "DELETE FROM {{K}}.webauthn_credentials_by_id WHERE credential_id = ?",
      [{"text", credential_id}]
    )

    Cytale.Repo.execute!(
      "DELETE FROM {{K}}.webauthn_credentials WHERE user_id = ? AND credential_id = ?",
      [{"bigint", user_id}, {"text", credential_id}]
    )

    :ok
  end

  # -- Reads -----------------------------------------------------------------------

  @doc "The login lookup: credential row by id, `nil` when unknown/revoked."
  @spec get(String.t()) :: %{user_id: integer(), public_key_b64: String.t(), sign_count: non_neg_integer()} | nil
  def get(credential_id) when is_binary(credential_id) do
    case Cytale.Repo.execute(
           "SELECT credential_id, user_id, public_key, sign_count
            FROM {{K}}.webauthn_credentials_by_id WHERE credential_id = ?",
           [{"text", credential_id}]
         ) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [%{"user_id" => user_id, "public_key" => pk, "sign_count" => count}]
          when is_integer(user_id) and is_binary(pk) and is_integer(count) ->
            %{user_id: user_id, public_key_b64: pk, sign_count: count}

          _ ->
            nil
        end

      {:error, _} ->
        nil
    end
  end

  def get(_), do: nil

  @doc "The owner's list, newest first (settings + excludeCredentials)."
  @spec list_for_user(integer()) :: [Credential.t()]
  def list_for_user(user_id) when is_integer(user_id) do
    case Cytale.Repo.execute(
           "SELECT user_id, credential_id, public_key, sign_count, backup_eligible, backup_state,
                   name, created_at, last_used_at
            FROM {{K}}.webauthn_credentials WHERE user_id = ?",
           [{"bigint", user_id}]
         ) do
      {:ok, page} ->
        page
        |> Enum.to_list()
        |> Enum.map(&Credential.from_row/1)
        |> Enum.sort_by(
          &{(&1.created_at && DateTime.to_unix(&1.created_at, :millisecond)) || 0, &1.credential_id},
          :desc
        )

      {:error, _} ->
        []
    end
  end

  def list_for_user(_), do: []

  # -- Internals -------------------------------------------------------------------

  # LWT result shape verified against ScyllaDB (the session-bridge probe):
  # one row, `[applied] = true` on win, `false` + the existing row on loss.
  defp applied?(page) do
    case page |> Enum.to_list() |> List.first() do
      %{"[applied]" => true} -> true
      _other -> false
    end
  end
end
