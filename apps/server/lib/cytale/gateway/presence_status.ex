defmodule Cytale.Gateway.PresenceStatus do
  @moduledoc """
  Per-user preferred presence status (U23 polish: manual picker + invisible).

  The routing table answers "is this user connected"; this answers "what do
  they want to broadcast while connected". Single-node launch scope: a named
  public ETS set owned by this GenServer. Statuses are the CLIENT vocabulary
  (:online | :idle | :dnd | :invisible); the wire mapping (invisible →
  "offline") lives here as `wire_status/1` — the gateway socket keeps its own
  private clauses for the native path (a parallel session's WIP occupies that
  file), and `CytaleWeb.GatewayWireContractTest` pins the two mappings equal so
  they cannot drift.

  Lifecycle: set by op-3, consulted by join announces and presence snapshots,
  forgotten when the user's last live socket closes (next connect defaults
  to online unless the client re-declares — which the web client does on
  every fresh session).
  """

  use GenServer

  @table __MODULE__

  @type status :: :online | :idle | :dnd | :invisible

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Record the user's preferred status.

  A MISSING TABLE IS A NO-OP, not a crash (hardening plan 5.5). The table is
  owned by this GenServer, so a restart — a crash, a deploy, a supervisor
  bounce — removes it for the window before the child comes back, and every one
  of these calls used to raise `ArgumentError` straight into the caller: a
  gateway socket handling op-3, or a presence announce fanning out. A client's
  preferred status is a cache; losing a write to it must never take a session
  down.

  The guard is `rescue` rather than `:ets.whereis/1` deliberately: whereis-then-op
  is a TOCTOU (the owner can die between the two calls and the op then raises),
  which is the same reasoning `Cytale.Repo.Statements` records.
  """
  @spec put(String.t(), status()) :: :ok
  def put(user_id, status) when status in [:online, :idle, :dnd, :invisible] do
    # No `true =` match on the insert (hardening plan 7.10): `:ets.insert/2`
    # either returns true or raises, so the assert pinned nothing — the rescue
    # below is what makes a missing table a no-op.
    :ets.insert(@table, {user_id, status})
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Preferred status, or :online when none recorded (also when the table is gone)."
  @spec lookup(String.t()) :: status()
  def lookup(user_id) do
    case :ets.lookup(@table, user_id) do
      [{^user_id, status}] -> status
      [] -> :online
    end
  rescue
    ArgumentError -> :online
  end

  @doc "Forget the preference (user's last live socket closed)."
  @spec forget(String.t()) :: :ok
  def forget(user_id) do
    :ets.delete(@table, user_id)
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc """
  Wire status for a stored status: `:invisible` broadcasts as `"offline"`
  (the whole point of the setting); the rest keep their own name. Discord
  spells these identically, so the compat surface consumes this directly.
  """
  @spec wire_status(status()) :: String.t()
  def wire_status(:invisible), do: "offline"
  def wire_status(:online), do: "online"
  def wire_status(:idle), do: "idle"
  def wire_status(:dnd), do: "dnd"

  # -- GenServer -----------------------------------------------------------

  @impl true
  def init(:ok) do
    :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    {:ok, %{}}
  end
end
