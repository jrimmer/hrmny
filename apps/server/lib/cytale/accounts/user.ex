defmodule Cytale.Accounts.User do
  @moduledoc """
  User records (U8) — creation with Snowflake ids (U5), case-insensitive
  username-or-email lookup via the `users_by_username`/`users_by_email`
  lookup tables, and the soft-delete tombstone (`deleted_at`) that starts
  the U14 cascade.

  Uniqueness discipline (schema comment, binding): usernames and emails are
  unique CASE-INSENSITIVELY, enforced by application-level compare on the
  normalized (lowercased) handle — the lookup tables key the lowercased
  value, and creation rejects a collision with `{:error, :username_taken |
  :email_taken}`.
  """

  alias Cytale.Repo

  @typedoc "A user record as persisted in the `users` table."
  @type t :: %{
          user_id: integer(),
          username: String.t(),
          email: String.t(),
          email_verified_at: DateTime.t() | nil,
          password_hash: String.t(),
          display_name: String.t() | nil,
          avatar_url: String.t() | nil,
          created_at: DateTime.t(),
          deleted_at: DateTime.t() | nil
        }

  @email_re ~r/^[^@\s]+@[^@\s]+\.[^@\s]+$/

  # ---------------------------------------------------------------------------
  # Creation
  # ---------------------------------------------------------------------------

  @doc """
  Register a user. Validates inputs, enforces case-insensitive uniqueness,
  assigns a Snowflake id (U5), and stores the argon2 hash — never a raw
  password. Returns `{:ok, user}` or `{:error, reason}` with reason ∈
  `:username_taken | :email_taken | :invalid_username | :invalid_email |
  :invalid_password`.
  """
  @spec create(String.t(), String.t(), String.t()) ::
          {:ok, t()} | {:error, :username_taken | :email_taken | :invalid_username | :invalid_email | :invalid_password}
  def create(username, email, password)
      when is_binary(username) and is_binary(email) and is_binary(password) do
    username = String.trim(username)
    email = String.trim(email)

    with :ok <- validate_username(username),
         :ok <- validate_email(email),
         :ok <- validate_password(password),
         :ok <- ensure_unique(username, email) do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
      user_id = Cytale.Snowflake.next()

      insert_user(%{
        user_id: user_id,
        username: username,
        email: email,
        email_verified_at: nil,
        password_hash: Cytale.Accounts.Auth.hash_password(password),
        display_name: nil,
        avatar_url: nil,
        created_at: now,
        deleted_at: nil
      })

      {:ok, get(user_id)}
    else
      {:error, _} = err -> err
    end
  end

  def create(_, _, _), do: {:error, :invalid_username}

  @doc """
  Federated sign-in creation (ticket #12): a PASSWORDLESS account for a
  provider-asserted VERIFIED email. Same validation and case-insensitive
  uniqueness as `create/3`, three deliberate differences:

    * `email_verified_at` is stamped NOW — the provider's `email_verified:
      true` claim is the strongest evidence the verification flow could want,
      and refusing it would lock the new account view-only behind a mail
      this flow never sends;
    * `password_hash` is the EMPTY string: no password exists, so the
      password login path can never answer for this account (its guard
      requires a hash and argon2 rejects ""). A password appears only if the
      owner later walks password-reset, which is the break-glass story;
    * the caller (Cytale.OIDC) has already decided `registration_open?` —
      this function is the provisioning step, not the gate.
  """
  @spec create_federated(String.t(), String.t()) ::
          {:ok, t()} | {:error, :username_taken | :email_taken | :invalid_username | :invalid_email}
  def create_federated(username, email) when is_binary(username) and is_binary(email) do
    username = String.trim(username)
    email = String.trim(email)

    with :ok <- validate_username(username),
         :ok <- validate_email(email),
         :ok <- ensure_unique(username, email) do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
      user_id = Cytale.Snowflake.next()

      insert_user(%{
        user_id: user_id,
        username: username,
        email: email,
        email_verified_at: now,
        password_hash: "",
        display_name: nil,
        avatar_url: nil,
        created_at: now,
        deleted_at: nil
      })

      {:ok, get(user_id)}
    else
      {:error, _} = err -> err
    end
  end

  def create_federated(_, _), do: {:error, :invalid_username}

  # ---------------------------------------------------------------------------
  # Lookups
  # ---------------------------------------------------------------------------

  @doc "Fetch by Snowflake id. Soft-deleted users still resolve (tombstone visible)."
  @spec get(integer()) :: t() | nil
  def get(user_id) when is_integer(user_id) do
    row =
      Repo.execute!(
        "SELECT user_id, username, email, email_verified_at, password_hash, display_name, avatar_url, created_at, deleted_at FROM {{K}}.users WHERE user_id = ?",
        [{"bigint", user_id}]
      )

    case Enum.to_list(row) do
      [r] -> row_to_user(r)
      _ -> nil
    end
  end

  @doc """
  Batch fetch by Snowflake ids (PERF-5, B5 — roster synthesis): ONE `IN ?`
  read returning `%{user_id => t()}`; an absent id simply has no entry
  (callers degrade to nil exactly like `get/1`'s miss shape).
  """
  @spec get_many([integer()]) :: %{optional(integer()) => t()}
  def get_many(user_ids) when is_list(user_ids) do
    user_ids = Enum.uniq(user_ids)

    if user_ids == [] do
      %{}
    else
      Repo.execute!(
        "SELECT user_id, username, email, email_verified_at, password_hash, display_name, avatar_url, created_at, deleted_at FROM {{K}}.users WHERE user_id IN ?",
        [{"list<bigint>", user_ids}]
      )
      |> Enum.to_list()
      |> Map.new(fn r -> {r["user_id"], row_to_user(r)} end)
    end
  end

  @doc """
  Lookup by username OR email, case-insensitive (login identifier
  flexibility, Discord/Slack model). Returns the user or nil.
  """
  @spec get_by_identifier(String.t()) :: t() | nil
  def get_by_identifier(identifier) when is_binary(identifier) do
    ident = String.trim(identifier) |> String.downcase()

    cond do
      ident == "" ->
        nil

      String.contains?(ident, "@") ->
        by_email_lower(ident)

      true ->
        by_username_lower(ident)
    end
  end

  def get_by_identifier(_), do: nil

  @doc """
  Reserve `username`'s uniqueness slot for `user_id` (case-insensitive).

  Registration and machine-principal minting both go through here: a credential
  is a user, so its tag must occupy the same space as every human handle — that
  is what makes "unique per server" true rather than aspirational.
  """
  @spec reserve_username!(integer(), String.t()) :: :ok
  def reserve_username!(user_id, username) do
    Repo.execute!(
      "INSERT INTO {{K}}.users_by_username (username_lower, user_id) VALUES (?, ?)",
      [{"text", normalize(username)}, {"bigint", user_id}]
    )

    :ok
  end

  @doc """
  Release `username`'s uniqueness slot — revocation's mirror of
  `reserve_username!/2`. A MACHINE credential's tag returns to the pool when
  the credential is revoked (mint → revoke → re-mint with the same tag is the
  normal operational loop). HUMAN handles are deliberately NOT freed on
  account deletion — "handle not reusable" per the plan — so this is only
  called from the machine revocation path.
  """
  @spec release_username!(String.t()) :: :ok
  def release_username!(username) do
    Repo.execute!(
      "DELETE FROM {{K}}.users_by_username WHERE username_lower = ?",
      [{"text", normalize(username)}]
    )

    :ok
  end

  @doc "Case-insensitive username uniqueness probe."
  @spec username_taken?(String.t()) :: boolean()
  def username_taken?(username) do
    case by_username_lower(normalize(username)) do
      nil -> false
      _ -> true
    end
  end

  @doc "Case-insensitive email uniqueness probe."
  @spec email_taken?(String.t()) :: boolean()
  def email_taken?(email) do
    case by_email_lower(normalize(email)) do
      nil -> false
      _ -> true
    end
  end

  # ---------------------------------------------------------------------------
  # Mutations
  # ---------------------------------------------------------------------------

  @doc "Stamp `email_verified_at` (the view-only gate reads this)."
  @spec mark_verified!(integer()) :: :ok
  def mark_verified!(user_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "UPDATE {{K}}.users SET email_verified_at = ? WHERE user_id = ?",
      [{"timestamp", now}, {"bigint", user_id}]
    )

    :ok
  end

  @doc "Update profile settings (display name / avatar) — PATCH /users/@me."
  @spec update_profile!(integer(), String.t() | nil, String.t() | nil) :: :ok
  def update_profile!(user_id, display_name, avatar_url) do
    Repo.execute!(
      "UPDATE {{K}}.users SET display_name = ?, avatar_url = ? WHERE user_id = ?",
      [{"text", display_name}, {"text", avatar_url}, {"bigint", user_id}]
    )

    :ok
  end

  @doc "Replace the password hash (password-reset completion)."
  @spec update_password_hash!(integer(), String.t()) :: :ok
  def update_password_hash!(user_id, new_hash) do
    Repo.execute!(
      "UPDATE {{K}}.users SET password_hash = ? WHERE user_id = ?",
      [{"text", new_hash}, {"bigint", user_id}]
    )

    :ok
  end

  @doc """
  Soft-delete tombstone (`deleted_at` set; U14 cascade consumes it). The
  username/email are NOT freed — "handle not reusable" per the plan.
  """
  @spec soft_delete!(integer()) :: :ok
  def soft_delete!(user_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "UPDATE {{K}}.users SET deleted_at = ? WHERE user_id = ?",
      [{"timestamp", now}, {"bigint", user_id}]
    )

    :ok
  end

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  defp validate_username(u) do
    if String.length(u) >= 2 and String.length(u) <= 32 and
         String.match?(u, ~r/^[a-zA-Z0-9_.-]+$/) and not String.contains?(u, "@"),
       do: :ok,
       else: {:error, :invalid_username}
  end

  defp validate_email(e) do
    if String.length(e) <= 254 and Regex.match?(@email_re, e),
      do: :ok,
      else: {:error, :invalid_email}
  end

  defp validate_password(p) do
    if String.length(p) >= 8 and String.length(p) <= 128, do: :ok, else: {:error, :invalid_password}
  end

  defp ensure_unique(username, email) do
    cond do
      username_taken?(username) -> {:error, :username_taken}
      email_taken?(email) -> {:error, :email_taken}
      true -> :ok
    end
  end

  defp insert_user(m) do
    Repo.execute!(
      "INSERT INTO {{K}}.users (user_id, username, email, email_verified_at, password_hash, display_name, avatar_url, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", m.user_id},
        {"text", m.username},
        {"text", m.email},
        {"timestamp", m.email_verified_at},
        {"text", m.password_hash},
        {"text", m.display_name},
        {"text", m.avatar_url},
        {"timestamp", m.created_at},
        {"timestamp", m.deleted_at}
      ]
    )

    # Lookup-table rows (lowercased) — login path reads these.
    Repo.execute!(
      "INSERT INTO {{K}}.users_by_username (username_lower, user_id) VALUES (?, ?)",
      [{"text", normalize(m.username)}, {"bigint", m.user_id}]
    )

    Repo.execute!(
      "INSERT INTO {{K}}.users_by_email (email_lower, user_id) VALUES (?, ?)",
      [{"text", normalize(m.email)}, {"bigint", m.user_id}]
    )

    :ok
  end

  defp by_username_lower(lower) do
    case lookup_id("users_by_username", "username_lower", lower) do
      nil -> nil
      id -> get(id)
    end
  end

  defp by_email_lower(lower) do
    case lookup_id("users_by_email", "email_lower", lower) do
      nil -> nil
      id -> get(id)
    end
  end

  defp lookup_id(table, column, value) do
    rows =
      Repo.execute!(
        "SELECT user_id FROM {{K}}.#{table} WHERE #{column} = ?",
        [{"text", value}]
      )

    case Enum.to_list(rows) do
      [%{"user_id" => id}] -> id
      _ -> nil
    end
  end

  defp row_to_user(r) do
    %{
      user_id: r["user_id"],
      username: r["username"],
      email: r["email"],
      email_verified_at: r["email_verified_at"],
      password_hash: r["password_hash"],
      display_name: r["display_name"],
      avatar_url: r["avatar_url"],
      created_at: r["created_at"],
      deleted_at: r["deleted_at"]
    }
  end

  defp normalize(s), do: s |> String.trim() |> String.downcase()
end
