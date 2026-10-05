defmodule Cytale.Gateway.SessionStore.Index do
  @moduledoc """
  Long-lived owner of the SessionStore's PRINCIPAL-scoped ETS tables:

    * `PrincipalIndex` (`:bag`) — `principal_id => {principal_id, pid,
      session_id}` live-socket rows (the KTD6 teardown machinery reads it
      to find every live socket of a principal);
    * `PrincipalSlots` (`:set`) — KTD15 session-cap slots in BOTH
      directions: `{principal_id, slot} => holder_pid` (the atomic claim)
      and `holder_pid => {principal_id, slot}` (the reverse row the
      terminate path releases).

  These tables deliberately stay UNIFIED rather than sharding with the
  records: their traffic is per-connection lifecycle (Identify/terminate),
  not per-event, and the pid-keyed release paths (`untrack_principal/1`,
  `release_principal_slots/1` — the caller knows only its own pid) would
  need an all-shard scan if the rows were scattered by principal.
  `write_concurrency: true` keeps concurrent Identifies off each other's
  locks, and per-principal cap exclusivity is `insert_new` atomicity on one
  table — byte-identical semantics to the pre-shard store.

  The GenServer itself does nothing but own the tables (the RateTables
  discipline: a request-process-owned table dies with the process that
  created it — these must never).
  """

  use GenServer

  @doc "The principal→session live-socket bag (KTD6 teardown machinery)."
  def principal_index_table, do: __MODULE__.PrincipalIndex

  @doc "The session-cap slot table ({principal_id, slot} ⇄ holder pid)."
  def principal_slots_table, do: __MODULE__.PrincipalSlots

  @doc false
  def start_link(_opts), do: GenServer.start_link(__MODULE__, :ok, name: __MODULE__)

  @impl true
  def init(:ok) do
    :ets.new(principal_index_table(), [:bag, :named_table, :public, write_concurrency: true])
    :ets.new(principal_slots_table(), [:set, :named_table, :public, write_concurrency: true])
    {:ok, %{}}
  end
end
