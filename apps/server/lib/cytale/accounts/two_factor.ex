defmodule Cytale.Accounts.TwoFactor do
  @moduledoc """
  TOTP two-factor enrollment + login verification (ticket #127), governed by
  the single server switch `auth.two_factor_enabled` (default OFF):

    * **off** — the feature is fully absent: `enabled?/0` gates every
      surface; no grants, no enrollments answered, login unchanged;
    * **on** — password-only accounts are FORCED to enroll during their next
      login (the controller refuses to mint tokens off a bare verified
      password and instead issues an `:enrollment` grant), and accounts with
      a CONFIRMED enrollment get a `:totp` grant + code challenge at every
      password login. Passkey and OIDC logins mint tokens directly — they
      are already multifactor (the documented line, revisitable).

  The enrollment ceremony is CONFIRM-BEFORE-PERSIST: `start_enrollment/2`
  writes the candidate secret with `confirmed: false`; only a confirm whose
  code actually verifies (`confirm_enrollment/2`) flips the row armed. An
  unconfirmed secret NEVER satisfies `enrolled?/1`, so an abandoned
  candidate can't lock anyone out.

  One enrollment per account in v1 (multiple methods is explicitly later) —
  the table is one row per account. Removal while the switch is on is
  allowed: the next password login simply re-prompts enrollment, so
  self-inflicted lockout from the shell is impossible (the removal
  completes; the re-enrollment happens at next login).

  Recovery: `clear_enrollment/1` is hooked by password-reset completion —
  email possession is the recovery channel (the standard trade). Account
  deletion cascades the row the same way.

  Replay protection rides `Cytale.Accounts.TOTP.verify/4`'s step floor: the
  account's `last_used_step` advances on every accepted code, so a code —
  including a ±1-window neighbour — can never be accepted twice.
  """

  alias Cytale.Accounts.{TOTP, User}
  alias Cytale.Repo

  @typedoc "The stored enrollment row (plain map, the repo's record shape)."
  @type enrollment :: %{
          user_id: integer(),
          secret: String.t(),
          confirmed: boolean(),
          created_at: DateTime.t() | nil,
          confirmed_at: DateTime.t() | nil,
          last_used_at: DateTime.t() | nil,
          last_used_step: integer() | nil
        }

  # ---------------------------------------------------------------------------
  # Mode
  # ---------------------------------------------------------------------------

  @doc "The server switch (`auth.two_factor_enabled`, default false)."
  @spec enabled?() :: boolean()
  def enabled?, do: Cytale.Config.two_factor_enabled?()

  @doc """
  Whether `user_id` has a CONFIRMED enrollment — the one thing that arms the
  login challenge. A candidate (unconfirmed) row does not count.
  """
  @spec enrolled?(integer()) :: boolean()
  def enrolled?(user_id) when is_integer(user_id) do
    case enrollment(user_id) do
      %{confirmed: true} -> true
      _ -> false
    end
  end

  def enrolled?(_), do: false

  @doc "The account's enrollment row (candidate or confirmed), `nil` when none."
  @spec enrollment(integer()) :: enrollment() | nil
  def enrollment(user_id) when is_integer(user_id) do
    case Repo.execute(
           "SELECT user_id, secret, confirmed, created_at, confirmed_at, last_used_at, last_used_step
            FROM {{K}}.two_factor_enrollments WHERE user_id = ?",
           [{"bigint", user_id}]
         ) do
      {:ok, page} ->
        case Enum.to_list(page) do
          [%{"user_id" => user_id, "secret" => secret, "confirmed" => confirmed} = row]
          when is_binary(secret) and is_boolean(confirmed) ->
            %{
              user_id: user_id,
              secret: secret,
              confirmed: confirmed,
              created_at: row["created_at"],
              confirmed_at: row["confirmed_at"],
              last_used_at: row["last_used_at"],
              last_used_step: row["last_used_step"]
            }

          _ ->
            nil
        end

      {:error, _} ->
        nil
    end
  end

  def enrollment(_), do: nil

  # ---------------------------------------------------------------------------
  # Enrollment ceremony (start → confirm; the client renders the QR)
  # ---------------------------------------------------------------------------

  @doc """
  Start (or restart) an enrollment: generate the secret, persist the
  CANDIDATE row (confirmed: false — never armed), and return
  `%{secret: base32, otpauth_uri: uri}` for the client to render. A fresh
  start replaces any previous candidate; refusing is reserved for a
  CONFIRMED enrollment (`{:error, :already_enrolled}`) — an account with
  working 2FA does not get its secret silently re-rolled by another start
  call. (Removal first, then re-enroll — the settings surface's order.)
  """
  @spec start_enrollment(integer()) ::
          {:ok, %{secret: String.t(), otpauth_uri: String.t()}} | {:error, :already_enrolled}
  def start_enrollment(user_id) when is_integer(user_id) do
    if enrolled?(user_id) do
      {:error, :already_enrolled}
    else
      secret = TOTP.generate_secret()
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      Repo.execute!(
        "INSERT INTO {{K}}.two_factor_enrollments
         (user_id, secret, confirmed, created_at, confirmed_at, last_used_at, last_used_step)
         VALUES (?, ?, ?, ?, ?, ?, ?)",
        [
          {"bigint", user_id},
          {"text", secret},
          {"boolean", false},
          {"timestamp", now},
          {"timestamp", nil},
          {"timestamp", nil},
          {"bigint", nil}
        ]
      )

      username =
        user_id
        |> User.get()
        |> case do
          %{username: u} when is_binary(u) -> u
          _ -> "user-#{user_id}"
        end

      {:ok, %{secret: secret, otpauth_uri: TOTP.otpauth_uri(secret, username)}}
    end
  end

  @doc """
  Confirm the candidate enrollment: `code` must verify against the
  CANDIDATE secret (right now ±1 step) — only then is the row flipped
  `confirmed: true` and the gate armed. A wrong code leaves the candidate
  untouched (`{:error, :invalid_code}`); a missing candidate is
  `{:error, :not_started}`. Both refusals render as one uniform message at
  the controller (the ceremony state is the caller's own, not an oracle).
  """
  @spec confirm_enrollment(integer(), String.t()) ::
          :ok | {:error, :invalid_code | :not_started}
  def confirm_enrollment(user_id, code) when is_integer(user_id) and is_binary(code) do
    case enrollment(user_id) do
      %{confirmed: false, secret: secret} = row ->
        case TOTP.verify(secret, code, DateTime.utc_now(), row.last_used_step) do
          {:ok, _match} ->
            now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

            Repo.execute!(
              "UPDATE {{K}}.two_factor_enrollments
               SET confirmed = ?, confirmed_at = ? WHERE user_id = ?",
              [{"boolean", true}, {"timestamp", now}, {"bigint", user_id}]
            )

            :ok

          {:error, _} ->
            {:error, :invalid_code}
        end

      %{confirmed: true} ->
        {:error, :already_enrolled}

      nil ->
        {:error, :not_started}
    end
  end

  def confirm_enrollment(_, _), do: {:error, :invalid_code}

  # ---------------------------------------------------------------------------
  # Login verification (the TOTP challenge grant's code check)
  # ---------------------------------------------------------------------------

  @doc """
  Verify a login code for the account's CONFIRMED enrollment. Replay
  protection: the accepted step must be strictly beyond the recorded
  `last_used_step`, and acceptance advances it (with `last_used_at`) — a
  code can never be accepted twice even inside its ±1 window.
  `{:error, :not_enrolled}` when there is no confirmed enrollment (the
  controller refuses such a call before reaching here — this is the
  belt-and-braces half).
  """
  @spec verify_login(integer(), String.t()) ::
          :ok | {:error, :invalid_code | :not_enrolled}
  def verify_login(user_id, code) when is_integer(user_id) and is_binary(code) do
    case enrollment(user_id) do
      %{confirmed: true, secret: secret} = row ->
        case TOTP.verify(secret, code, DateTime.utc_now(), row.last_used_step) do
          {:ok, %{step: step}} ->
            now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

            Repo.execute!(
              "UPDATE {{K}}.two_factor_enrollments
               SET last_used_step = ?, last_used_at = ? WHERE user_id = ?",
              [{"bigint", step}, {"timestamp", now}, {"bigint", user_id}]
            )

            :ok

          {:error, _} ->
            {:error, :invalid_code}
        end

      _ ->
        {:error, :not_enrolled}
    end
  end

  def verify_login(_, _), do: {:error, :invalid_code}

  # ---------------------------------------------------------------------------
  # Removal / recovery / cascade
  # ---------------------------------------------------------------------------

  @doc """
  Delete the account's enrollment row (candidate or confirmed). Idempotent:
  deleting a non-existent enrollment succeeds — the caller cannot learn
  whether one existed, and the recovery path never needs a guard.
  """
  @spec clear_enrollment(integer()) :: :ok
  def clear_enrollment(user_id) when is_integer(user_id) do
    Repo.execute!(
      "DELETE FROM {{K}}.two_factor_enrollments WHERE user_id = ?",
      [{"bigint", user_id}]
    )

    :ok
  end

  def clear_enrollment(_), do: :ok

  # -- internals ----------------------------------------------------------------
end
