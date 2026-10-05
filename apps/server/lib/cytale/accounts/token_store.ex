defmodule Cytale.Accounts.TokenStore do
  @moduledoc """
  ScyllaDB storage for refresh tokens (U8) — keyed hashes only, never raw.

  The `refresh_tokens` table is keyed `(user_id), token_hash` with the 30-day
  expiry stamped per row (`expires_at`, plus a write TTL to the same instant
  so expired rows self-evict). Rotation is materialized by the caller
  (`Cytale.Accounts.Auth`): issue-new → store → delete-old, so a replayed old
  refresh token misses the store and is rejected.

  All queries use typed Xandra param tuples ({"bigint", ...}, {"text", ...},
  {"timestamp", ...}) — bare values raise FunctionClauseError in Xandra 0.20.
  """

  alias Cytale.Repo

  @typedoc "A stored refresh-token row (hash only — the raw token never lands)."
  @type stored :: %{
          user_id: integer(),
          token_hash: String.t(),
          expires_at: DateTime.t()
        }

  @doc "Store a refresh token by SHA-256 hash with a write TTL to its expiry."
  @spec put(integer(), String.t(), DateTime.t()) :: :ok
  def put(user_id, token_hash, expires_at) when is_integer(user_id) and is_binary(token_hash) do
    ttl_seconds = max(1, DateTime.diff(expires_at, DateTime.utc_now(), :second))

    Repo.execute!(
      "INSERT INTO {{KEYSPACE}}.refresh_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?) USING TTL ?",
      [{"bigint", user_id}, {"text", token_hash}, {"timestamp", expires_at}, {"int", ttl_seconds}]
    )

    :ok
  end

  @doc "True when `token_hash` exists for `user_id` (not expired — TTL evicts)."
  @spec valid?(integer(), String.t()) :: boolean()
  def valid?(user_id, token_hash) do
    case Repo.execute(
           "SELECT token_hash FROM {{KEYSPACE}}.refresh_tokens WHERE user_id = ? AND token_hash = ?",
           [{"bigint", user_id}, {"text", token_hash}]
         ) do
      {:ok, page} -> Enum.to_list(page) != []
      {:error, _} -> false
    end
  end

  @doc "Delete one refresh token (rotation) or every token for the user (revocation)."
  @spec delete(integer(), String.t()) :: :ok
  def delete(user_id, token_hash) do
    Repo.execute!(
      "DELETE FROM {{KEYSPACE}}.refresh_tokens WHERE user_id = ? AND token_hash = ?",
      [{"bigint", user_id}, {"text", token_hash}]
    )

    :ok
  end

  @spec delete_all_for_user(integer()) :: :ok
  def delete_all_for_user(user_id) do
    Repo.execute!(
      "DELETE FROM {{KEYSPACE}}.refresh_tokens WHERE user_id = ?",
      [{"bigint", user_id}]
    )

    :ok
  end

  @doc """
  Record that the token stored under `token_hash` was ROTATED away (kept to
  `expires_at`). Only a rotated token's reappearance is a replay; an unknown
  token is not (see `Cytale.Accounts.Auth.rotate_refresh_token/2`).
  """
  @spec mark_rotated(integer(), String.t(), DateTime.t()) :: :ok
  def mark_rotated(user_id, token_hash, expires_at) when is_integer(user_id) and is_binary(token_hash) do
    ttl_seconds = max(1, DateTime.diff(expires_at, DateTime.utc_now(), :second))

    Repo.execute!(
      "INSERT INTO {{KEYSPACE}}.refresh_token_rotations (user_id, token_hash) VALUES (?, ?) USING TTL ?",
      [{"bigint", user_id}, {"text", token_hash}, {"int", ttl_seconds}]
    )

    :ok
  end

  @doc "True when `token_hash` is a tombstone of a token rotated for `user_id`."
  @spec rotated?(integer(), String.t()) :: boolean()
  def rotated?(user_id, token_hash) do
    case Repo.execute(
           "SELECT token_hash FROM {{KEYSPACE}}.refresh_token_rotations WHERE user_id = ? AND token_hash = ?",
           [{"bigint", user_id}, {"text", token_hash}]
         ) do
      {:ok, page} -> Enum.to_list(page) != []
      {:error, _} -> false
    end
  end

  @doc "List stored hashes for a user (verification + tests)."
  @spec list(integer()) :: [stored()]
  def list(user_id) do
    case Repo.execute(
           "SELECT user_id, token_hash, expires_at FROM {{KEYSPACE}}.refresh_tokens WHERE user_id = ?",
           [{"bigint", user_id}]
         ) do
      {:ok, page} ->
        Enum.map(Enum.to_list(page), fn row ->
          %{
            user_id: row["user_id"],
            token_hash: row["token_hash"],
            expires_at: row["expires_at"]
          }
        end)

      {:error, _} ->
        []
    end
  end
end
