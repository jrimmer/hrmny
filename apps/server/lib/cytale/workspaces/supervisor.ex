defmodule Cytale.Workspaces.Supervisor do
  @moduledoc """
  Thin wrapper over the U4 `Cytale.WorkspaceSupervisor` DynamicSupervisor.
  Workspace processes start lazily — on first connection or first publish —
  and are reconstructed from ScyllaDB (the source of truth) if they crashed.

  Since hardening plan 4.6 each workspace is started as its OWN subtree — a
  `Cytale.Workspaces.SubtreeSupervisor` holding exactly one workspace process —
  so one crash loop spends one per-subtree restart budget instead of the
  shared one. A workspace whose subtree exhausts that budget is quarantined
  (`Cytale.Workspaces.Quarantine`) and refused here until it is cleared.
  """

  alias Cytale.Workspaces.Quarantine
  alias Cytale.Workspaces.Registry

  @doc """
  Ensure the workspace process for `workspace_id` is running (idempotent —
  a live process short-circuits via the Registry lookup).

  Returns `{:ok, pid}` with a REAL pid, or an error. Never `{:ok, nil}`: the
  `:already_present` case means the spec exists but the name is not yet
  registered, and a nil "ok" there is a crash in the caller's process
  (hardening plan 4.4). A quarantined workspace (hardening plan 4.6) returns
  `{:error, :quarantined}` — the crash-loop is over, and callers already
  handle `{:error, _}` by dropping the best-effort event.
  """
  @spec ensure_started(integer()) :: {:ok, pid()} | {:error, term()}
  def ensure_started(workspace_id) when is_integer(workspace_id) do
    # The quarantine check comes first: a quarantined workspace whose process
    # is somehow still alive must not be handed back to a caller as healthy.
    if Quarantine.quarantined?(workspace_id) do
      {:error, :quarantined}
    else
      case Registry.whereis(workspace_id) do
        pid when is_pid(pid) -> {:ok, pid}
        nil -> start_subtree(workspace_id)
      end
    end
  end

  defp start_subtree(workspace_id) do
    child = {Cytale.Workspaces.SubtreeSupervisor, workspace_id}

    case DynamicSupervisor.start_child(Cytale.WorkspaceSupervisor, child) do
      # The subtree supervisor registers the workspace process before it
      # returns, so the workspace pid is already in the Registry here.
      {:ok, _subtree} ->
        resolve(workspace_id)

      {:error, {:already_started, _subtree}} ->
        resolve(workspace_id)

      {:error, :already_present} ->
        # Restarting: the spec is present, the name may not be back yet.
        # This used to be `{:ok, Registry.whereis(workspace_id)}`, which is
        # `{:ok, nil}` in exactly that window — so callers did
        # `GenServer.cast(nil, ...)` and crashed the REQUESTING process (a
        # message send, a fan-out) instead of dropping one best-effort
        # event. Report not-ready; the callers already handle `{:error, _}`
        # (hardening plan 4.4).
        resolve(workspace_id)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp resolve(workspace_id) do
    case Registry.whereis(workspace_id) do
      pid when is_pid(pid) -> {:ok, pid}
      nil -> {:error, :not_ready}
    end
  end
end
