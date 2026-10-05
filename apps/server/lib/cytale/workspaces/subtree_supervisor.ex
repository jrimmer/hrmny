defmodule Cytale.Workspaces.SubtreeSupervisor do
  @moduledoc """
  Hardening plan 4.6 — the per-workspace restart budget.

  Before this module every workspace process was a direct child of the single
  `Cytale.WorkspaceSupervisor` DynamicSupervisor, so ALL workspaces shared one
  restart intensity: a workspace crash-looping past the shared budget took the
  supervisor — and every other workspace's live sessions with it — down on its
  way to the root tree. One workspace, one budget: each workspace now sits
  under its own `:one_for_one` supervisor carrying a generous
  `max_restarts`/`max_seconds`, so a crash loop spends only its own.

  When a subtree DOES exhaust its budget, OTP terminates it with `:shutdown`,
  and its child spec under the DynamicSupervisor is `restart: :transient` —
  `:shutdown` is normal for a transient child, so the supervisor is NOT
  restarted. That is the mechanical half of quarantine; the reporting half is
  `Cytale.Workspaces.Quarantine`, which watches this process (see its `init/1`)
  and records/logs the workspace id. `Cytale.Workspaces.Supervisor.ensure_started/1`
  then refuses to start it again.
  """

  use Supervisor

  alias Cytale.Workspaces.Quarantine
  alias Cytale.Workspaces.Workspace

  require Logger

  # Generous relative to OTP's default 3/5: transient blips must not quarantine
  # a tenant. Because the budget is PER SUBTREE, generosity is cheap — one
  # workspace's loop cannot spend another's. The window is deliberately wide
  # enough that a restart loop slowed by a Scylla round trip in `Workspace.init`
  # still counts as a loop, while a genuinely slow one-crash-an-hour tenant
  # never approaches it.
  @max_restarts 20
  @max_seconds 10

  @doc false
  @spec max_restarts() :: pos_integer()
  def max_restarts, do: @max_restarts

  @doc false
  @spec max_seconds() :: pos_integer()
  def max_seconds, do: @max_seconds

  @doc "Child spec for `Cytale.WorkspaceSupervisor` (workspace_id as the arg)."
  def child_spec(workspace_id) when is_integer(workspace_id) do
    %{
      id: {__MODULE__, workspace_id},
      start: {__MODULE__, :start_link, [workspace_id]},
      # `:shutdown` (exhausted budget, or a planned stop) is normal for a
      # transient child, so the outer DynamicSupervisor drops the spec instead
      # of restarting the loop. Abnormal deaths of THIS process (e.g. a killed
      # supervisor) are still restarted with a fresh budget.
      restart: :transient,
      type: :supervisor
    }
  end

  @doc "Start the per-workspace subtree."
  @spec start_link(integer()) :: Supervisor.on_start()
  def start_link(workspace_id) when is_integer(workspace_id) do
    Supervisor.start_link(__MODULE__, workspace_id)
  end

  @impl true
  def init(workspace_id) do
    # Watch BEFORE the workspace child starts: the monitor must exist before
    # the first crash, or a budget-exhausting loop could die unwitnessed and be
    # restarted by `ensure_started/1`.
    #
    # A failure here must NOT take the workspace down with it. This call is the
    # REPORTING half of 4.6; the containment half is this subtree's own budget,
    # which works regardless. If the registry is unregistered (restarting) or
    # slow, the call exits — and letting that exit fail `init/1` would mean one
    # dead registry stops EVERY workspace start on the node, i.e. all realtime,
    # which is a far worse outcome than losing a quarantine mark. Fail open,
    # loudly, and let `Quarantine.init/1` re-attach to whatever is live.
    try do
      :ok = Quarantine.watch(workspace_id, self())
    catch
      kind, reason ->
        Logger.error(
          "workspace #{workspace_id}: quarantine watch failed (#{inspect({kind, reason})}) — " <>
            "starting anyway; a crash loop is still contained by this subtree's own budget, " <>
            "but it will not be reported as quarantined"
        )
    end

    children = [{Workspace, workspace_id}]

    Supervisor.init(children,
      strategy: :one_for_one,
      max_restarts: @max_restarts,
      max_seconds: @max_seconds
    )
  end
end
