defmodule Cytale.Search.IndexWriterRegistry do
  @moduledoc """
  Registry for per-workspace search index writers (U13 slice 2). Mirrors the
  workspace-process registry pattern: unique keys per integer workspace_id.
  """

  @doc "Registry pid for a live writer, or nil."
  @spec whereis(integer()) :: pid() | nil
  def whereis(workspace_id) when is_integer(workspace_id) do
    case Registry.whereis_name({__MODULE__, workspace_id}) do
      :undefined -> nil
      pid -> pid
    end
  end

  @doc "Via-tuple for Registry.register_name in the writer start."
  @spec name(integer()) :: {:via, Registry, {module(), integer()}}
  def name(workspace_id) when is_integer(workspace_id) do
    {:via, Registry, {__MODULE__, workspace_id}}
  end
end

defmodule Cytale.Search.IndexWriterSupervisor do
  @moduledoc """
  DynamicSupervisor for per-workspace search index writers (U13 slice 2).
  Writers start lazily on first `index/2`; a writer crash restarts it and it
  reconstructs its muninn index from the on-disk directory (Tantivy's
  one-writer-per-directory constraint is satisfied by one writer per
  workspace).
  """

  @doc "Ensure a writer is running for `workspace_id` (idempotent)."
  @spec ensure_started(integer()) :: {:ok, pid()} | {:error, term()}
  def ensure_started(workspace_id) when is_integer(workspace_id) do
    case Cytale.Search.IndexWriterRegistry.whereis(workspace_id) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        child = {Cytale.Search.IndexWriter, workspace_id}

        case DynamicSupervisor.start_child(Cytale.Search.IndexWriterSupervisor, child) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, :already_present} -> {:ok, Cytale.Search.IndexWriterRegistry.whereis(workspace_id)}
          {:error, reason} -> {:error, reason}
        end
    end
  end
end
