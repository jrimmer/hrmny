defmodule Cytale.Accounts.TwoFactor.Grants do
  @moduledoc """
  Single-use two-factor GRANT store (ticket #127) — the short-lived,
  single-purpose tickets that make a verified password "not enough" when the
  server switch is on. The challenge-store pattern (#36): ETS, opaque
  random id, TTL, atomic consume.

  Two grant kinds, and the kind is the PURPOSE:

    * `:totp` — minted by a password login for an account that already has a
      confirmed enrollment. `POST /auth/2fa/verify` (grant + code) is the
      ONLY thing it can reach, and it mints the real token pair.
    * `:enrollment` — minted by a password login for an account with NO
      confirmed enrollment (the forced-enrollment walk). It reaches
      `enroll/start` and `enroll/confirm` ONLY; `confirm` success is what
      consumes it and mints the pair. It can never reach tokens directly —
      skipping is impossible by construction.

  Security posture:

    * an opaque 24-byte id — nothing about the account rides the wire;
    * TTL ~5 minutes (one login walk);
    * `consume/2` is `:ets.take/2` — two concurrent verifies of one id
      cannot both win;
    * failure-budgeted: a wrong code burns one of a bounded number of
      attempts (`@max_attempts`); exhausting the budget destroys the grant,
      so a grant is not an unthrottled code oracle — the attacker is pushed
      back to the password (which is the factor they don't have);
    * the kind is checked on consume: an enrollment grant cannot call
      verify, a totp grant cannot call enroll endpoints (single-purpose).

  Single-node posture (the #36 decision, same here): ETS, not a Scylla
  table — a 5-minute grant outliving the node is worthless anyway.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms 5 * 60 * 1000
  @sweep_interval_ms 15_000
  @max_attempts 5

  @type kind :: :totp | :enrollment

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner (application tree child)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @doc """
  Mint a grant of `kind` for `user_id`. Returns the opaque id the client
  echoes on the follow-up call.
  """
  @spec put(kind(), integer()) :: String.t()
  def put(kind, user_id) when kind in [:totp, :enrollment] and is_integer(user_id) do
    grant_id = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)
    expires_at_ms = System.system_time(:millisecond) + ttl_ms()

    true = :ets.insert(table(), {grant_id, kind, user_id, 0, expires_at_ms})
    grant_id
  end

  @doc """
  Peek a grant WITHOUT consuming it (the enroll/start step must not spend
  the walk). `{:ok, %{user_id: id}}` while valid; `{:error, :invalid}` for
  unknown/expired/wrong-kind.
  """
  @spec peek(String.t(), kind()) :: {:ok, %{user_id: integer()}} | {:error, :invalid}
  def peek(grant_id, kind) when is_binary(grant_id) do
    case :ets.lookup(table(), grant_id) do
      [{^grant_id, ^kind, user_id, _attempts, expires_at_ms}] ->
        if fresh?(expires_at_ms), do: {:ok, %{user_id: user_id}}, else: {:error, :invalid}

      _ ->
        {:error, :invalid}
    end
  end

  def peek(_, _), do: {:error, :invalid}

  @doc """
  Record a FAILED attempt against the grant (wrong code). Burns one attempt;
  at `@max_attempts` the grant is DESTROYED — the walk must restart from the
  password. `:ok` while the grant lives, `{:error, :invalid}` once destroyed
  (or unknown/expired/wrong-kind).
  """
  @spec fail(String.t(), kind()) :: :ok | {:error, :invalid}
  def fail(grant_id, kind) when is_binary(grant_id) do
    # Kind-checked BEFORE the take: a wrong-kind call must never destroy the
    # grant (a totp grant's enrollment attempt, say, would otherwise spend it).
    case :ets.lookup(table(), grant_id) do
      [{^grant_id, ^kind, user_id, attempts, expires_at_ms}] ->
        cond do
          not fresh?(expires_at_ms) ->
            :ets.delete(table(), grant_id)
            {:error, :invalid}

          attempts + 1 >= @max_attempts ->
            # Budget exhausted: gone. (`:ok` — the failure WAS recorded; the
            # grant's death is the consequence the caller sees on the NEXT
            # use as `{:error, :invalid}`.)
            :ets.delete(table(), grant_id)
            :ok

          true ->
            true = :ets.insert(table(), {grant_id, kind, user_id, attempts + 1, expires_at_ms})
            :ok
        end

      _ ->
        {:error, :invalid}
    end
  end

  def fail(_, _), do: {:error, :invalid}

  @doc """
  Atomically consume the grant on SUCCESS: the row is taken (a second use
  finds nothing), the kind must match, expiry enforced. Returns
  `{:ok, %{user_id: id}}` or `{:error, :invalid}` — every refusal is the one
  uniform answer (no oracle between unknown, expired, spent, foreign kind).
  """
  @spec consume(String.t(), kind()) :: {:ok, %{user_id: integer()}} | {:error, :invalid}
  def consume(grant_id, kind) when is_binary(grant_id) do
    # Kind-checked BEFORE the take (the take is by KEY alone): a wrong-kind
    # consume must leave the grant alive, and the read→take window is the
    # same one-winner race the challenge store accepts.
    case :ets.lookup(table(), grant_id) do
      [{^grant_id, ^kind, user_id, _attempts, expires_at_ms}] ->
        case :ets.take(table(), grant_id) do
          [{^grant_id, ^kind, ^user_id, _attempts, exp}] ->
            if fresh?(exp), do: {:ok, %{user_id: user_id}}, else: {:error, :invalid}

          _ ->
            # Lost a concurrent consume — the one uniform refusal.
            {:error, :invalid}
        end

      _ ->
        {:error, :invalid}
    end
  end

  def consume(_, _), do: {:error, :invalid}

  @doc "Live grant count (tests/ops)."
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
      |> Enum.filter(fn {_id, _kind, _user_id, _attempts, expires_at_ms} -> expires_at_ms <= now end)

    Enum.each(expired, fn {id, _kind, _user_id, _attempts, _exp} -> :ets.delete(table, id) end)

    :ets.safe_fixtable(table, false)
    schedule_sweep()
    {:noreply, table}
  end

  defp fresh?(expires_at_ms), do: System.system_time(:millisecond) <= expires_at_ms
  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)
  defp ttl_ms, do: @ttl_ms
  defp table, do: @table
end
