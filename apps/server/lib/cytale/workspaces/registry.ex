defmodule Cytale.Workspaces.Registry do
  @moduledoc """
  Thin lookup wrapper over the U4 `Cytale.WorkspaceRegistry` (unique keys).
  The workspace GenServer registers itself under its integer workspace_id;
  `whereis/1` answers "is this workspace process live right now".
  """

  @doc "Registry pid for a live workspace process, or nil."
  @spec whereis(integer()) :: pid() | nil
  def whereis(workspace_id) when is_integer(workspace_id) do
    case Registry.whereis_name({Cytale.WorkspaceRegistry, workspace_id}) do
      :undefined -> nil
      pid -> pid
    end
  end

  @doc "Via-tuple for Registry.register_name in the GenServer start."
  @spec name(integer()) :: {:via, Registry, {module(), integer()}}
  def name(workspace_id) when is_integer(workspace_id) do
    {:via, Registry, {Cytale.WorkspaceRegistry, workspace_id}}
  end
end
