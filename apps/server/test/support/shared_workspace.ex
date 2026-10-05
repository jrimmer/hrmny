defmodule Cytale.Test.SharedWorkspace do
  @moduledoc """
  Fixture for REST DM tests: a NEW DM may only be opened between users who
  share a workspace (Tier 3 B, finding 9a). `share!/2` creates a throwaway
  workspace owned by `owner_id` with `member_id` in it, so a test whose
  subject is the DM itself can open one through the real route.
  """

  @spec share!(integer(), integer()) :: integer()
  def share!(owner_id, member_id) when is_integer(owner_id) and is_integer(member_id) do
    name = "dm-share-" <> Cytale.TestNonce.get() <> "-" <> Integer.to_string(System.unique_integer([:positive]))
    {:ok, ws} = Cytale.Workspaces.create_workspace(owner_id, name)
    :ok = Cytale.Workspaces.add_member(ws.workspace_id, member_id, owner_id)
    ws.workspace_id
  end
end
