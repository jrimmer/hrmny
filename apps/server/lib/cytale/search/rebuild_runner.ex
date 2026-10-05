defmodule Cytale.Search.RebuildRunner do
  @moduledoc """
  The rebuild job runner (#89) — how a rebuild actually gets started.

  A rebuild walks every message in a workspace and is CPU + disk heavy: run
  inline in an HTTP request it would hold the connection until the walk
  finished and time out long before it answered. So the operator POST accepts
  the work, answers immediately, and this process runs it.

  ## One at a time, in total

  Not one per workspace — ONE, globally. The same box runs ScyllaDB under a
  documented memory confinement and has already been brought down once by
  unconstrained memory use; two rebuilds against two workspaces would contend
  for the same disk and cores with no benefit. A request while a job is
  running is refused with the running job's id (the HTTP layer turns that into
  a 409) rather than queued, because an operator who cannot see what is
  running cannot decide what to do about it.

  ## Progress is part of the deliverable

  `Rebuild.replay_range/4` reports each page through `:on_page`; the runner
  folds those into the job's `pages`/`messages` counters, so
  `GET /admin/search/rebuilds` shows a rebuild moving. A long rebuild with no
  visible progress is indistinguishable from a hang.

  ## Failure is never silent

  The walk runs in a Task under `Cytale.Search.RebuildTaskSupervisor` and
  reports its own outcome (`:finished` / `:failed`), and the runner keeps the
  task's monitor as a second net: whatever a task does — raise, exit, be
  killed — its `:DOWN` lands and the job reaches a terminal state, so a dead
  rebuild can never pin the runner in `:running` forever.

  The job list is in-memory: a runner restart forgets history. That is safe
  because a rebuild is idempotent and the drift check proves the outcome — the
  job list is never the index's only record.
  """

  use GenServer

  alias Cytale.Search.Rebuild

  require Logger

  @name __MODULE__
  @max_jobs 50

  # -- API -----------------------------------------------------------------------

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: @name)
  end

  @doc """
  Accept a rebuild for `workspace_id`.

  Returns `{:ok, job}` (the caller answers 202 + the job id) or
  `{:error, {:in_progress, running_job}}` when a rebuild is already running —
  the running job's id is the answer to "why not, and what is happening".
  """
  @spec request(integer()) :: {:ok, map()} | {:error, {:in_progress, map()}}
  def request(workspace_id) when is_integer(workspace_id) do
    GenServer.call(@name, {:request, workspace_id}, 5_000)
  end

  @doc "Every retained job, newest first (optionally one workspace's jobs)."
  @spec list(keyword()) :: [map()]
  def list(opts \\ []) do
    GenServer.call(@name, {:list, opts})
  end

  @doc "One job by id, or nil."
  @spec get(String.t()) :: map() | nil
  def get(job_id) when is_binary(job_id) do
    GenServer.call(@name, {:get, job_id})
  end

  @doc "The job currently running, or nil."
  @spec running() :: map() | nil
  def running do
    GenServer.call(@name, :running)
  end

  @doc "The most recent job for a workspace, or nil."
  @spec latest_for(integer()) :: map() | nil
  def latest_for(workspace_id) when is_integer(workspace_id) do
    GenServer.call(@name, {:latest_for, workspace_id})
  end

  # -- GenServer -----------------------------------------------------------------

  @impl true
  def init(_opts), do: {:ok, %{jobs: %{}, order: []}}

  @impl true
  def handle_call({:request, workspace_id}, _from, state) do
    case current_running(state) do
      nil ->
        job = new_job(workspace_id)

        case start_job(job) do
          {:ok, ref} ->
            job = %{job | monitor: ref}
            {:reply, {:ok, public(job)}, put_job(state, job)}

          {:error, reason} ->
            {:reply, {:error, {:start_failed, reason}}, state}
        end

      %{status: :running} = running ->
        {:reply, {:error, {:in_progress, public(running)}}, state}
    end
  end

  def handle_call({:list, opts}, _from, state) do
    jobs =
      state.order
      |> Enum.map(&Map.fetch!(state.jobs, &1))
      |> filter_by_workspace(Keyword.get(opts, :workspace_id))
      |> Enum.map(&public/1)

    {:reply, jobs, state}
  end

  def handle_call({:get, job_id}, _from, state) do
    case Map.fetch(state.jobs, job_id) do
      {:ok, job} -> {:reply, public(job), state}
      :error -> {:reply, nil, state}
    end
  end

  def handle_call(:running, _from, state) do
    running = current_running(state)
    {:reply, if(running, do: public(running), else: nil), state}
  end

  def handle_call({:latest_for, workspace_id}, _from, state) do
    job =
      Enum.find_value(state.order, fn id ->
        job = Map.fetch!(state.jobs, id)
        if job.workspace_id == workspace_id, do: job
      end)

    {:reply, if(job, do: public(job), else: nil), state}
  end

  @impl true
  def handle_info({:progress, job_id, %{pages: pages, messages: messages}}, state) do
    {:noreply, update_job(state, job_id, &%{&1 | pages: pages, messages: messages})}
  end

  def handle_info({:finished, job_id, stats}, state) do
    state =
      update_job(state, job_id, fn job ->
        %{
          job
          | status: :ok,
            pages: stats.pages,
            messages: stats.messages,
            finished_at: now(),
            result: stats
        }
      end)

    Logger.info(
      "search rebuild finished: #{stats.messages} message(s) over #{stats.pages} page(s) " <>
        "(workspace #{workspace_of(state, job_id)})"
    )

    {:noreply, state}
  end

  def handle_info({:failed, job_id, reason}, state) do
    state = fail_job(state, job_id, reason)
    Logger.error("search rebuild failed (#{job_id}): #{inspect(reason)}")
    {:noreply, state}
  end

  def handle_info({:DOWN, ref, :process, _pid, reason}, state) do
    # The second net: a task that died without reporting (a hard crash) would
    # otherwise leave its job :running forever with nothing left to finish it.
    case running_job_by_monitor(state, ref) do
      {:ok, job_id, job} when job.status == :running ->
        {:noreply, fail_job(state, job_id, {:task_down, reason})}

      _ ->
        {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  # -- the job -------------------------------------------------------------------

  defp start_job(job) do
    parent = self()

    case Task.Supervisor.start_child(Cytale.Search.RebuildTaskSupervisor, fn ->
           run_rebuild(parent, job)
         end) do
      {:ok, pid} -> {:ok, Process.monitor(pid)}
      {:error, reason} -> {:error, reason}
    end
  end

  # The walk reports progress page by page, then its own outcome. Anything
  # unexpected — a raise from ScyllaDB, a mismatch — is caught here and lands
  # as a terminal job state; the monitor on this task is the second net.
  defp run_rebuild(parent, job) do
    {:ok, stats} =
      Rebuild.rebuild(job.workspace_id,
        on_page: fn stats -> send(parent, {:progress, job.id, stats}) end,
        telemetry_meta: %{job_id: job.id}
      )

    send(parent, {:finished, job.id, stats})
  rescue
    e -> send(parent, {:failed, job.id, Exception.message(e)})
  end

  defp new_job(workspace_id) do
    %{
      id: "rb-" <> Base.url_encode64(:crypto.strong_rand_bytes(9), padding: false),
      workspace_id: workspace_id,
      status: :running,
      pages: 0,
      messages: 0,
      started_at: now(),
      finished_at: nil,
      error: nil,
      result: nil,
      monitor: nil
    }
  end

  defp fail_job(state, job_id, reason) do
    update_job(state, job_id, fn job ->
      %{job | status: :error, error: render_reason(reason), finished_at: now()}
    end)
  end

  defp update_job(state, job_id, fun) do
    case Map.fetch(state.jobs, job_id) do
      {:ok, job} -> %{state | jobs: Map.put(state.jobs, job_id, fun.(job))}
      :error -> state
    end
  end

  defp put_job(state, job) do
    jobs = Map.put(state.jobs, job.id, job)
    order = Enum.take([job.id | state.order], @max_jobs)
    jobs = Map.drop(jobs, state.order -- order)

    %{state | jobs: jobs, order: order}
  end

  defp current_running(state) do
    Enum.find_value(state.order, fn id ->
      job = Map.fetch!(state.jobs, id)
      if job.status == :running, do: job
    end)
  end

  defp running_job_by_monitor(state, ref) do
    Enum.find_value(state.order, :error, fn id ->
      job = Map.fetch!(state.jobs, id)
      if job.monitor == ref, do: {:ok, id, job}
    end)
  end

  defp workspace_of(state, job_id) do
    case Map.fetch(state.jobs, job_id) do
      {:ok, job} -> job.workspace_id
      :error -> :unknown
    end
  end

  defp filter_by_workspace(jobs, nil), do: jobs

  defp filter_by_workspace(jobs, workspace_id),
    do: Enum.filter(jobs, &(&1.workspace_id == workspace_id))

  defp public(job) do
    %{
      id: job.id,
      workspace_id: job.workspace_id,
      status: job.status,
      pages: job.pages,
      messages: job.messages,
      started_at: job.started_at,
      finished_at: job.finished_at,
      duration_ms: duration_ms(job),
      error: job.error,
      result: job.result
    }
  end

  defp duration_ms(%{finished_at: nil} = job) do
    DateTime.diff(DateTime.utc_now(), job.started_at, :millisecond)
  end

  defp duration_ms(job), do: DateTime.diff(job.finished_at, job.started_at, :millisecond)

  defp render_reason(reason) when is_binary(reason), do: reason
  defp render_reason(reason), do: inspect(reason)

  defp now, do: DateTime.utc_now() |> DateTime.truncate(:millisecond)
end
