defmodule Cytale.Search.TestWriters do
  @moduledoc """
  Cleanup for tests that point the search root at a temp dir and start
  per-workspace index writers in it.

  Writers are globally registered and outlive the test, so each test must
  stop the ones it started before deleting the temp dir. The tracking list
  cannot live in the test's process dictionary: `on_exit` callbacks run in a
  different process, where that dictionary is empty. Tracking there meant no
  writer was ever stopped, and a live writer's commit or merge could add a
  file while `File.rm_rf!` walked the dir, which raised "file already exists"
  (the Linux ENOTEMPTY from rmdir). The list lives in an unlinked Agent
  instead, which the `on_exit` callback can still reach.

      tracker = TestWriters.tracker!()
      on_exit(fn -> TestWriters.stop_all(tracker); ...; TestWriters.rm_rf(tmp) end)
      TestWriters.track(workspace_id)
  """

  alias Cytale.Search.IndexWriter

  @doc "Starts the tracker for this test (call from `setup`, in the test process)."
  def tracker! do
    {:ok, pid} = Agent.start(fn -> [] end)
    Process.put(__MODULE__, pid)
    pid
  end

  @doc "Records a workspace whose writer must be stopped at exit. Returns the id."
  def track(workspace_id) do
    case Process.get(__MODULE__) do
      nil -> raise "Cytale.Search.TestWriters.tracker!/0 was not called in setup"
      pid -> Agent.update(pid, &[workspace_id | &1])
    end

    workspace_id
  end

  @doc "Stops every tracked writer and the tracker itself. Synchronous."
  def stop_all(tracker) do
    for w <- Agent.get(tracker, & &1) |> Enum.uniq() do
      case IndexWriter.whereis({:workspace, w}) do
        nil -> :ok
        pid -> DynamicSupervisor.terminate_child(Cytale.Search.IndexWriterSupervisor, pid)
      end
    end

    Agent.stop(tracker)
  end

  @doc """
  Removes the temp root. A stopped writer's native index can still finish a
  background merge for a moment after its process exits, so this retries for
  up to about 2s. If the dir still won't go, it is left behind, since a stray
  temp dir is harmless and failing the test for it would be noise.
  """
  def rm_rf(dir, attempts \\ 40) do
    case File.rm_rf(dir) do
      {:ok, _} ->
        :ok

      {:error, _reason, _path} when attempts > 1 ->
        Process.sleep(50)
        rm_rf(dir, attempts - 1)

      {:error, _reason, _path} ->
        :ok
    end
  end
end
