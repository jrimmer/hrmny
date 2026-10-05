defmodule Cytale.Accounts.WebAuthn.ChallengeStore do
  @moduledoc """
  Single-use WebAuthn challenge store (ticket #36) — the server-side half of
  every ceremony's replay protection.

  The flow: `Cytale.Accounts.WebAuthn` mints a `%Wax.Challenge{}` (which
  embeds the random bytes, the allowed origins, the RP ID, and its own issue
  time + timeout), this store keeps it under an opaque `challenge_id`, the
  client echoes that id on the verify call, and `consume/1` returns the
  challenge ATOMICALLY while deleting it (`:ets.take/2` — two concurrent
  verifies of one id cannot both win). Wax re-checks the challenge bytes and
  expiry against the client data during verification, so the id is only a
  lookup handle: knowing it without signing the matching ceremony proves
  nothing.

  Expiry is belt-and-braces: wax refuses an expired challenge itself; the
  sweeper just keeps the table bounded. TTL comes from
  `Cytale.Accounts.WebAuthn.challenge_timeout_s/0` (5 minutes — one browser
  prompt's lifetime, a cross-device phone confirmation included).

  Registration challenges are bound to the enrolling account (`user_id`);
  login challenges are pre-auth and carry `user_id: nil`. The verify path
  cross-checks the binding, so one user cannot spend another's registration
  ceremony.

  Single-node posture (ticket decision): ETS, not a Scylla table — a
  challenge outliving the node is worthless anyway.
  """

  use GenServer

  @table __MODULE__
  @sweep_interval_ms 15_000

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner (application tree child)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Store `challenge` under a fresh opaque id. `user_id` binds a REGISTRATION
  challenge to its enrolling account; `nil` marks an (anonymous) LOGIN
  challenge. Returns the id.
  """
  @spec put(Wax.Challenge.t(), integer() | nil) :: String.t()
  def put(%Wax.Challenge{} = challenge, user_id) do
    challenge_id = Base.url_encode64(:crypto.strong_rand_bytes(24), padding: false)
    expires_at_ms = System.system_time(:millisecond) + ttl_ms()

    true = :ets.insert(table(), {challenge_id, challenge, user_id, expires_at_ms})
    challenge_id
  end

  @doc """
  Atomically consume the challenge stored under `challenge_id`:
  `{:ok, %{challenge: %Wax.Challenge{}, user_id: integer() | nil}}` on the
  first use, `{:error, :not_found}` ever after (unknown, expired-and-swept,
  or already spent — the caller renders one uniform refusal either way).
  An expired-but-unswept row is removed and refused.
  """
  @spec consume(String.t()) :: {:ok, %{challenge: Wax.Challenge.t(), user_id: integer() | nil}} | {:error, :not_found}
  def consume(challenge_id) when is_binary(challenge_id) do
    case :ets.take(table(), challenge_id) do
      [{^challenge_id, %Wax.Challenge{} = challenge, user_id, expires_at_ms}] ->
        if System.system_time(:millisecond) <= expires_at_ms do
          {:ok, %{challenge: challenge, user_id: user_id}}
        else
          {:error, :not_found}
        end

      [] ->
        {:error, :not_found}
    end
  end

  def consume(_), do: {:error, :not_found}

  @doc "Live row count (tests/ops)."
  @spec size() :: non_neg_integer()
  def size, do: :ets.info(table(), :size) || 0

  # -- GenServer -------------------------------------------------------------------

  @impl true
  def init(:ok) do
    # The table is addressed by `@table` everywhere else in this module, so it
    # must be registered as a NAMED table — the option is `:named_table`
    # (`:named` is not an ets option and crashes the boot).
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
      |> Enum.filter(fn {_id, _challenge, _user_id, expires_at_ms} -> expires_at_ms <= now end)

    Enum.each(expired, fn {id, _challenge, _user_id, _exp} -> :ets.delete(table, id) end)

    :ets.safe_fixtable(table, false)
    schedule_sweep()
    {:noreply, table}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)

  defp ttl_ms, do: Cytale.Accounts.WebAuthn.challenge_timeout_s() * 1000

  defp table, do: @table
end
