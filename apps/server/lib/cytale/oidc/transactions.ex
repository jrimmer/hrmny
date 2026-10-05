defmodule Cytale.OIDC.Transactions do
  @moduledoc """
  Single-use OIDC ceremony transactions (ticket #12) — the server-side half of
  the state/nonce/PKCE replay protection, mirroring
  `Cytale.Accounts.WebAuthn.ChallengeStore` (same ETS-not-Scylla decision: a
  transaction outliving the node is worthless anyway).

  `Cytale.OIDC.start_ceremony/2` mints one row — the browser-visible `state`
  (the provider echoes it back verbatim), the `nonce` (embedded in the ID
  token and cross-checked at validation), and the PKCE `verifier` (whose S256
  challenge went into the authorize URL; only the verifier is stored) — and
  `consume/1` returns it ATOMICALLY while deleting it (`:ets.take/2`, the
  ChallengeStore rule: two concurrent callbacks of one state cannot both win).

  Every miss is the SAME `{:error, :not_found}` — unknown state, expired and
  swept, expired but unswept, or already spent — so the callback can render
  one uniform refusal and the store cannot be used as an oracle about past
  ceremonies.

  TTL is ~10 minutes: several times a real human's round trip through the
  provider, far shorter than anything an attacker could mine. The sweeper only
  keeps the table bounded (an expired-but-unswept row is refused at consume).
  """

  use GenServer

  @table __MODULE__
  @sweep_interval_ms 15_000
  @ttl_ms 10 * 60 * 1000

  @typedoc "One in-flight sign-in ceremony."
  @type t :: %__MODULE__{
          state: String.t(),
          nonce: String.t(),
          verifier: String.t(),
          redirect_uri: String.t(),
          return_to: String.t() | nil,
          created_at_ms: integer(),
          expires_at_ms: integer()
        }

  defstruct [:state, :nonce, :verifier, :redirect_uri, :return_to, :created_at_ms, :expires_at_ms]

  # -- Client API ----------------------------------------------------------------

  @doc "Starts the ETS owner (application tree child)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Mint one ceremony: high-entropy `state` / `nonce` / PKCE `verifier` (each
  32 random bytes, base64url), bound to the `redirect_uri` captured from THIS
  start request (the token exchange must present the same value) and the
  caller's sanitized `return_to`. Returns the whole transaction — the caller
  puts NOTHING unvalidated into it.
  """
  @spec new(String.t(), String.t() | nil) :: t()
  def new(redirect_uri, return_to) do
    tx = %__MODULE__{
      state: random_token(),
      nonce: random_token(),
      verifier: random_token(),
      redirect_uri: redirect_uri,
      return_to: return_to,
      created_at_ms: System.system_time(:millisecond),
      expires_at_ms: System.system_time(:millisecond) + ttl_ms()
    }

    true = :ets.insert(table(), {tx.state, tx})
    tx
  end

  @doc """
  Atomically consume the transaction stored under `state`: `{:ok, tx}` on the
  first use, `{:error, :not_found}` ever after (unknown, expired-and-swept,
  expired-but-unswept, or already spent — the caller renders ONE uniform
  refusal either way).
  """
  @spec consume(String.t()) :: {:ok, t()} | {:error, :not_found}
  def consume(state) when is_binary(state) do
    case :ets.take(table(), state) do
      [{^state, %__MODULE__{} = tx}] ->
        if System.system_time(:millisecond) <= tx.expires_at_ms do
          {:ok, tx}
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

  @doc "The PKCE S256 challenge for a verifier (what the authorize URL carries)."
  @spec s256_challenge(String.t()) :: String.t()
  def s256_challenge(verifier) when is_binary(verifier) do
    Base.url_encode64(:crypto.hash(:sha256, verifier), padding: false)
  end

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
      |> Enum.filter(fn {_state, %__MODULE__{expires_at_ms: exp}} -> exp <= now end)

    Enum.each(expired, fn {state, _tx} -> :ets.delete(table, state) end)

    :ets.safe_fixtable(table, false)
    schedule_sweep()
    {:noreply, table}
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_interval_ms)

  defp random_token, do: Base.url_encode64(:crypto.strong_rand_bytes(32), padding: false)

  defp ttl_ms, do: @ttl_ms

  defp table, do: @table
end
