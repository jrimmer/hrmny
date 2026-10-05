defmodule Cytale.Workspaces.Quarantine do
  @moduledoc """
  Hardening plan 4.6 — the quarantine registry for crash-looping workspaces.

  `Cytale.Workspaces.SubtreeSupervisor` gives every workspace its own restart
  budget, so a workspace crash loop spends only its own budget. When that
  budget is spent the subtree supervisor terminates with `:shutdown` — the
  reason OTP uses when a supervisor gives up restarting. This process watches
  those subtree supervisors (a synchronous watch at subtree start, so no crash
  can slip past the monitor) and, on that `:shutdown`, records the workspace as
  quarantined: it will not be started again, it is logged loudly with its
  workspace id, and a `[:cytale, :workspace, :quarantined]` telemetry event is
  emitted.

  State is a node-local ETS table (`:protected`; the owner writes, everyone
  reads) so `quarantined?/1` — consulted on the workspace start path — is a
  plain table read with no message round trip.

  A `:shutdown` also happens during a graceful application stop. `prep_stop`
  marks the shutdown first (`begin_shutdown/0`), and `handle_info/2` ignores
  subtree deaths while that mark is set — a planned stop is not a quarantine.
  """

  use GenServer

  require Logger

  alias Cytale.Workspaces.SubtreeSupervisor

  @table :cytale_workspace_quarantine
  @shutdown_key {__MODULE__, :shutting_down}

  # -- Client API ---------------------------------------------------------------

  @doc "Start the registry."
  @spec start_link(term()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc """
  Watch a per-workspace subtree supervisor. Called (synchronously) from
  `SubtreeSupervisor.init/1`, so the monitor is in place before the subtree's
  workspace child can start — and long before it can crash-loop. Idempotent per
  pid.
  """
  @spec watch(integer(), pid()) :: :ok
  def watch(workspace_id, pid) when is_integer(workspace_id) and is_pid(pid) do
    GenServer.call(__MODULE__, {:watch, workspace_id, pid})
  end

  @doc "True when `workspace_id` is quarantined (plane ETS read)."
  @spec quarantined?(integer()) :: boolean()
  def quarantined?(workspace_id) when is_integer(workspace_id) do
    :ets.member(@table, workspace_id)
  rescue
    ArgumentError -> false
  end

  @doc """
  Every quarantined workspace, as `%{workspace_id: id, at: ms, reason: reason}`.

  Deliberately a `GenServer.call` (not a table read): the reply is ordered
  after any in-flight quarantine (`init`/`handle_info`) has finished logging
  and emitting telemetry, so callers that observe quarantine here also observe
  its report.
  """
  @spec list() :: [map()]
  def list do
    GenServer.call(__MODULE__, :list)
  end

  @doc """
  Release a quarantined workspace so it may be started again (an operator —
  or a test — that has fixed the underlying fault). `ensure_started/1` will
  then start it a fresh subtree with a full restart budget.
  """
  @spec clear(integer()) :: :ok
  def clear(workspace_id) when is_integer(workspace_id) do
    GenServer.call(__MODULE__, {:clear, workspace_id})
  end

  @doc """
  Mark the node as shutting down (called from `Cytale.Application.prep_stop/1`).
  Subtree deaths after this point are the planned teardown, not a quarantine.
  """
  @spec begin_shutdown() :: :ok
  def begin_shutdown do
    :persistent_term.put(@shutdown_key, true)
    :ok
  end

  @spec shutting_down?() :: boolean()
  defp shutting_down?, do: :persistent_term.get(@shutdown_key, false)

  # -- Server callbacks ---------------------------------------------------------

  @impl true
  def init(:ok) do
    # A restarted registry (or a fresh test boot in the same VM) must not
    # inherit a stale shutdown mark.
    :persistent_term.put(@shutdown_key, false)

    :ets.new(@table, [
      :named_table,
      :protected,
      :set,
      read_concurrency: true
    ])

    # RE-ATTACH to the subtrees that are already running (hardening plan 4.6).
    # Their monitors died with the previous incarnation of this process, so
    # without this a crash loop that begins after a registry restart would still
    # be CONTAINED by its own subtree budget but never reported or refused. On
    # the ordinary boot this finds nothing: the workspace supervisor is started
    # after this process.
    #
    # The quarantine MARKS themselves are node-local and do not survive a
    # restart (documented): a workspace this process has forgotten is startable
    # again, and an operator's `clear/1` is only needed for one it still holds.
    state = %{refs: %{}, pids: %{}}
    {:ok, attach_live_subtrees(state)}
  end

  # Every live child of the workspace DynamicSupervisor is a subtree. A
  # DynamicSupervisor reports `:undefined` as a child's id, so the WORKSPACE id
  # comes from the subtree's own workspace process, which registers itself in
  # `Cytale.WorkspaceRegistry` under that id — `Registry.keys/2` answers from the
  # pid. (A first cut matched on the child-spec id tuple and therefore never
  # attached at all; the re-attach test caught it.)
  defp attach_live_subtrees(state) do
    case Process.whereis(Cytale.WorkspaceSupervisor) do
      pid when is_pid(pid) ->
        pid
        |> DynamicSupervisor.which_children()
        |> Enum.reduce(state, fn
          {_id, subtree, :supervisor, _}, acc when is_pid(subtree) ->
            case workspace_of(subtree) do
              nil -> acc
              workspace_id -> register(workspace_id, subtree, acc)
            end

          _other, acc ->
            acc
        end)

      _ ->
        state
    end
  rescue
    # `which_children` races a supervisor that is going down. Losing the
    # re-attach is not worth failing this process's start over.
    _ -> state
  end

  # The workspace id behind a live subtree: its single workspace child is
  # registered in the workspace Registry, and the registration key carries the
  # id.
  defp workspace_of(subtree) do
    subtree
    |> Supervisor.which_children()
    |> Enum.find_value(fn
      {_id, child, :worker, _} when is_pid(child) ->
        # `Registry.keys/2` answers with the registered KEY, which for a
        # via-registration is the id itself (a bare integer); a `{registry, id}`
        # tuple is accepted too so the shape is not a silent failure mode.
        case Registry.keys(Cytale.WorkspaceRegistry, child) do
          [workspace_id | _] when is_integer(workspace_id) ->
            workspace_id

          [{Cytale.WorkspaceRegistry, workspace_id} | _] when is_integer(workspace_id) ->
            workspace_id

          _ ->
            nil
        end

      _ ->
        nil
    end)
  rescue
    _ -> nil
  end

  @impl true
  def handle_call({:watch, workspace_id, pid}, _from, state) do
    if Map.has_key?(state.pids, pid) do
      {:reply, :ok, state}
    else
      {:reply, :ok, register(workspace_id, pid, state)}
    end
  end

  defp register(workspace_id, pid, state) do
    ref = Process.monitor(pid)

    %{
      state
      | refs: Map.put(state.refs, ref, {workspace_id, pid}),
        pids: Map.put(state.pids, pid, ref)
    }
  end

  def handle_call(:list, _from, state) do
    entries =
      @table
      |> :ets.tab2list()
      |> Enum.map(fn {_id, entry} -> entry end)
      |> Enum.sort_by(& &1.workspace_id)

    {:reply, entries, state}
  end

  def handle_call({:clear, workspace_id}, _from, state) do
    :ets.delete(@table, workspace_id)

    Logger.info(
      "workspace #{workspace_id} quarantine cleared — it may be started again " <>
        "(any live fault is now the caller's responsibility)"
    )

    {:reply, :ok, state}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, pid, reason}, state) do
    case Map.pop(state.refs, ref) do
      {nil, _refs} ->
        {:noreply, state}

      {{workspace_id, ^pid}, refs} ->
        state = %{state | refs: refs, pids: Map.delete(state.pids, pid)}
        {:noreply, maybe_quarantine(state, workspace_id, reason)}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -- Internals ----------------------------------------------------------------

  # `:shutdown` is OTP's reason when a supervisor exhausts its restart
  # intensity. It is ALSO the reason a subtree dies during a planned stop, so
  # the shutdown mark and the live mother supervisor are both required before a
  # death is read as a crash-loop quarantine. Every OTHER reason is a plain
  # crash of the subtree supervisor itself, which the outer DynamicSupervisor
  # restarts normally — not a quarantine.
  defp maybe_quarantine(state, _workspace_id, reason) when reason != :shutdown, do: state

  defp maybe_quarantine(state, workspace_id, :shutdown) do
    cond do
      # A planned stop is not a quarantine.
      shutting_down?() ->
        state

      # The mother supervisor is gone, so the whole tree is coming down.
      not Process.alive?(Process.whereis(Cytale.WorkspaceSupervisor)) ->
        state

      # ...or the workspace is ALREADY being served again. `ensure_started/1`
      # can start a fresh subtree in the window between the crash-looping
      # subtree's death and this DOWN being handled — the workspace process
      # leaves the Registry (which is what `ensure_started/1` checks) before its
      # subtree supervisor finishes exiting. Without this clause that stale DOWN
      # would quarantine a workspace whose sessions are live, and every later
      # `ensure_started/1` would refuse it with `{:error, :quarantined}` while it
      # kept serving. A workspace process that is alive is proof the id is being
      # served; if the NEW subtree crash-loops too, its own DOWN arrives with no
      # live workspace and quarantines normally.
      live_workspace?(workspace_id) ->
        state

      true ->
        quarantine(state, workspace_id)
    end
  end

  # `Registry.whereis/1` can briefly answer with a pid whose process has already
  # died (Registry cleanup is asynchronous), so the pid itself is asked: a stale
  # entry must not read as a served workspace.
  defp live_workspace?(workspace_id) do
    case Cytale.Workspaces.Registry.whereis(workspace_id) do
      pid when is_pid(pid) -> Process.alive?(pid)
      _ -> false
    end
  end

  defp quarantine(state, workspace_id) do
    if :ets.member(@table, workspace_id) do
      state
    else
      entry = %{
        workspace_id: workspace_id,
        at: System.system_time(:millisecond),
        reason: :restart_intensity
      }

      :ets.insert(@table, {workspace_id, entry})

      Logger.error(
        "workspace #{workspace_id} QUARANTINED: its subtree exhausted the per-workspace " <>
          "restart budget (#{SubtreeSupervisor.max_restarts()} restarts / " <>
          "#{SubtreeSupervisor.max_seconds()}s) and is no longer restarted. " <>
          "Other workspaces, sessions and the endpoint are unaffected. " <>
          "Clear with Cytale.Workspaces.Quarantine.clear/1 after fixing the fault."
      )

      :telemetry.execute(
        [:cytale, :workspace, :quarantined],
        %{count: 1},
        %{workspace_id: workspace_id, reason: :restart_intensity}
      )

      state
    end
  end
end
