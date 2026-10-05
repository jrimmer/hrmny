defmodule Cytale.Accounts.AttemptGuard do
  @moduledoc """
  The per-account brute-force dam (audit S3).

  The router's `:auth` pipeline is IP-keyed only — one budget shared by every
  credential behind a NAT, and a different budget per attacking IP. This dam
  is the second axis: it counts FAILURES keyed by the ATTEMPTED identifier, so
  one attacker with many addresses cannot try ten passwords a minute against
  one account forever.

  Keys (all minted by this module's helpers):

    * LOGIN is two keys, both on what the caller SUBMITTED (trimmed +
      downcased, the exact normalization `User.get_by_identifier/1` applies),
      minted together by `login_keys/2` (security Tier 2 #2 — the lockout
      DoS: keyed on the identifier alone, ten wrong guesses from ANYONE locked
      the account's OWNER out for 15 minutes, on repeat, forever):
        - `{:identifier_ip, normalized, ip}` — the HARD lock, per identifier
          PER CLIENT NETWORK (`ip` is the rate-limit ip key: IPv4 exact, IPv6
          by /64). Ten failures lock that network out of that account; the
          owner on any other network is untouched.
        - `{:identifier, normalized}` — the GLOBAL dam across every network,
          at a much higher threshold (`attempt_guard_identifier_max_failures`,
          100 per window): the brake on a distributed guesser. Even when it
          trips it does not lock out the owner's KNOWN networks — a network
          that logged in successfully to this identifier within
          `attempt_guard_known_ip_ttl_ms` (`{:known_ip, normalized, ip}`,
          written on success) passes the global dam and answers only to its
          own per-network lock.
      Nonexistent accounts are counted too: the 401 they get is byte-identical
      to a wrong-password 401, and this way the dam cannot become an
      enumeration oracle by locking only real accounts.
    * `{:totp, user_id}` — 2FA verify failures, keyed by the (grant-proven)
      account.
    * `{:password_reset, normalized}` — password-reset REQUESTS. The endpoint
      is anti-enumeration (always 200), so the request count is the only thing
      that can stop a mail-out flood; there each request IS the counted event.

  Semantics: a FIXED window — `attempt_guard_max_failures` failures inside
  `attempt_guard_window_ms` lock the key for `attempt_guard_lock_ms`. The lock
  is not extended by failures during it, and a window whose end has passed
  restarts from one. `clear/1` on success (the dam must never punish the
  account's owner).

  Posture: supervised ETS with an in-process sweep — the same
  not-worth-a-table posture as the 2FA grants and the WebAuthn challenge
  store. Losing the table to a restart costs an attacker their accumulated
  count, not the system anything durable; a dam is a rate, not a record.

  The lock's response is the house 429 (`rate_limited`, 42901, with
  `retry-after`) via `CytaleWeb.API.Error.rate_limited/2` — the same shape the
  RateLimit plug answers with, so clients need one rate-limit handling path.
  """

  use GenServer

  alias Cytale.Config

  @table __MODULE__
  @sweep_interval_ms 15_000

  @typedoc "A dam key. Always built by `login_keys/2`, `identifier_key/1`, `totp_key/1`, `password_reset_key/1`."
  @type key ::
          {:identifier, String.t()}
          | {:identifier_ip, String.t(), term()}
          | {:known_ip, String.t(), term()}
          | {:totp, integer()}
          | {:password_reset, String.t()}

  @typedoc "The login key set (`login_keys/2`)."
  @type login_keys :: %{ip: key(), global: key(), known: key()}

  # Row shape: {key, window_end_ms, failures_in_window, locked_until_ms}
  # (locked_until_ms is 0 while the key is unlocked — `:ets` rows want a
  # uniform shape and 0 is cleanly "never").

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner (application tree child)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @doc """
  The normalization for identifier keys — EXACTLY the rule
  `User.get_by_identifier/1` applies, so the dam key and the lookup cannot
  disagree about what "the same account" means.
  """
  @spec normalized_identifier(String.t()) :: String.t()
  def normalized_identifier(raw) when is_binary(raw),
    do: raw |> String.trim() |> String.downcase()

  @doc "Login dam key for a submitted identifier."
  @spec identifier_key(String.t()) :: key()
  def identifier_key(raw), do: {:identifier, normalized_identifier(raw)}

  @doc """
  The login key set for a submitted identifier and the client's network
  (`ip` — already the rate-limit ip key, `CytaleWeb.Compat.RateLimit.ip_key/1`).
  """
  @spec login_keys(String.t(), term()) :: login_keys()
  def login_keys(raw, ip) do
    normalized = normalized_identifier(raw)

    %{
      ip: {:identifier_ip, normalized, ip},
      global: {:identifier, normalized},
      known: {:known_ip, normalized, ip}
    }
  end

  @doc """
  The login pre-check: the per-network hard lock first, then the global dam —
  which a known network (one that has logged in to this identifier recently)
  passes.
  """
  @spec check_login(login_keys()) :: :ok | {:error, :locked, non_neg_integer()}
  def check_login(%{ip: ip_key, global: global, known: known}) do
    with :ok <- check(ip_key) do
      if known?(known), do: :ok, else: check(global)
    end
  end

  @doc "Record one failed login: the per-network count AND the global count."
  @spec fail_login(login_keys()) :: :ok
  def fail_login(%{ip: ip_key, global: global}) do
    :ok = fail(ip_key)
    fail(global, Config.attempt_guard_identifier_max_failures())
  end

  @doc """
  A successful login: clear this network's count and remember the network as
  known for this identifier. The GLOBAL count is left alone — clearing it
  would hand a distributed guesser a fresh 100 every time the owner signs in,
  and the owner's own networks pass it anyway.
  """
  @spec succeed_login(login_keys()) :: :ok
  def succeed_login(%{ip: ip_key, known: known}) do
    :ok = clear(ip_key)
    true = :ets.insert(table(), {known, now_ms() + Config.attempt_guard_known_ip_ttl_ms(), 0, 0})
    :ok
  end

  defp known?(known) do
    case :ets.lookup(table(), known) do
      [{^known, expires_at, _, _}] -> expires_at > now_ms()
      _ -> false
    end
  end

  @doc "Password-reset dam key for a submitted email."
  @spec password_reset_key(String.t()) :: key()
  def password_reset_key(raw), do: {:password_reset, normalized_identifier(raw)}

  @doc "2FA dam key for a (grant-proven) account."
  @spec totp_key(integer()) :: key()
  def totp_key(user_id) when is_integer(user_id), do: {:totp, user_id}

  @doc """
  The pre-check, run BEFORE any credential work. `:ok` while the key is
  unlocked; `{:error, :locked, retry_ms}` once the dam has tripped —
  `retry_ms` feeds the `retry-after` header.
  """
  @spec check(key()) :: :ok | {:error, :locked, non_neg_integer()}
  def check(key) do
    now = now_ms()

    case :ets.lookup(table(), key) do
      [{^key, _window_end, _count, locked_until}] when locked_until > now ->
        {:error, :locked, locked_until - now}

      _ ->
        :ok
    end
  end

  @doc """
  Record one failed attempt (on the password-reset surface: one REQUEST — see
  the moduledoc). The threshold failure starts the lock; further failures
  during a lock change nothing (fixed window, not a sliding one — the lock
  ends when it ends).
  """
  @spec fail(key(), pos_integer()) :: :ok
  def fail(key, max_failures \\ Config.attempt_guard_max_failures()) do
    now = now_ms()

    case :ets.lookup(table(), key) do
      [{^key, _window_end, _count, locked_until}] when locked_until > now ->
        # Locked: nothing to count, nothing to extend.
        :ok

      [{^key, window_end, count, _locked_until}] when window_end > now ->
        count = count + 1

        locked_until =
          if count >= max_failures,
            do: now + Config.attempt_guard_lock_ms(),
            else: 0

        true = :ets.insert(table(), {key, window_end, count, locked_until})
        :ok

      _ ->
        # No row, or the window has rolled: a fresh window starts at one.
        true = :ets.insert(table(), {key, now + Config.attempt_guard_window_ms(), 1, 0})
        :ok
    end
  end

  @doc """
  Clear the key's history — on SUCCESS (the granted login, the verified code).
  The dam counts failures; a success must never leave weight behind for the
  account's owner to trip over later.
  """
  @spec clear(key()) :: :ok
  def clear(key) do
    :ets.delete(table(), key)
    :ok
  end

  @doc "Live row count (tests/ops)."
  @spec size() :: non_neg_integer()
  def size, do: :ets.info(table(), :size) || 0

  # -- GenServer -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    table = :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    schedule_sweep()
    {:ok, table}
  end

  @impl true
  def handle_info(:sweep, table) do
    now = System.system_time(:millisecond)

    :ets.safe_fixtable(table, true)

    expired =
      table
      |> :ets.tab2list()
      |> Enum.filter(fn {_key, window_end, _count, locked_until} ->
        # A row is garbage once its window AND its lock have both passed —
        # before that it is still the dam's memory.
        window_end <= now and locked_until <= now
      end)

    Enum.each(expired, fn {key, _window_end, _count, _locked_until} -> :ets.delete(table, key) end)

    :ets.safe_fixtable(table, false)
    schedule_sweep()
    {:noreply, table}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)
  defp now_ms, do: System.system_time(:millisecond)
  defp table, do: @table
end
