defmodule Cytale.Search.Partition do
  @moduledoc """
  Per-workspace index directory management (U13, R12/R13).

  Tantivy allows exactly one `IndexWriter` per directory, so each workspace
  gets its own index directory (strong physical tenant isolation):

      priv/search/{workspace_id}/

  DM messages have no parent workspace, so they ride a dedicated DM segment
  under `priv/search/_dm/`, partitioned per user-pair (resolved open
  question, 2026-08-27):

      priv/search/_dm/{user_a}_{user_b}/

  This module is pure filesystem — no NIF. The Tantivy-backed writer (slice
  2) consumes these paths.
  """

  @doc "The root directory for all search indexes (from config)."
  @spec root() :: String.t()
  def root, do: Cytale.Config.search_index_root()

  @doc "The per-workspace index directory."
  @spec index_dir(integer()) :: String.t()
  def index_dir(workspace_id) when is_integer(workspace_id) do
    Path.join(root(), Integer.to_string(workspace_id))
  end

  @doc "The DM segment root (no parent workspace)."
  @spec dm_segment_dir() :: String.t()
  def dm_segment_dir, do: Path.join(root(), "_dm")

  @doc "The per-user-pair DM subdirectory (canonical pair ordering)."
  @spec dm_pair_dir(integer(), integer()) :: String.t()
  def dm_pair_dir(user_a, user_b) when is_integer(user_a) and is_integer(user_b) do
    {lo, hi} = if user_a <= user_b, do: {user_a, user_b}, else: {user_b, user_a}
    Path.join(dm_segment_dir(), "#{lo}_#{hi}")
  end

  @doc """
  The PER-USER DM index directory (owner direction 2026-09-15: "DMs should be
  indexed and searchable"): `priv/search/_dmu/{user_id}/`. One index per
  participant, so a DM message is written to both participants' indexes and a
  query over a user's index is permission-correct BY PARTITION — the same
  trust model as the per-workspace indexes (nothing outside the caller's own
  conversations is ever in it). The `_dmu` prefix namespaces these away from
  workspace dirs (both key on snowflakes, so an integer-only path would
  collide) and from the `_dm` pair reservation above.
  """
  @spec dm_user_dir(integer()) :: String.t()
  def dm_user_dir(user_id) when is_integer(user_id) do
    Path.join(Path.join(root(), "_dmu"), Integer.to_string(user_id))
  end

  @doc "The directory an index key owns."
  @spec dir_for({:workspace, integer()} | {:dm_user, integer()}) :: String.t()
  def dir_for({:workspace, workspace_id}), do: index_dir(workspace_id)
  def dir_for({:dm_user, user_id}), do: dm_user_dir(user_id)

  @doc "The directory an index key owns, and ensure it exists."
  @spec ensure_key_dir({:workspace, integer()} | {:dm_user, integer()}) :: :ok
  def ensure_key_dir({:workspace, workspace_id}) do
    ensure_dir(index_dir(workspace_id))
  end

  def ensure_key_dir({:dm_user, user_id}) do
    ensure_dir(dm_user_dir(user_id))
  end

  @doc "Ensure a directory exists (mkdir -p). Returns :ok."
  @spec ensure_dir(String.t()) :: :ok
  def ensure_dir(dir) when is_binary(dir) do
    File.mkdir_p!(dir)
    :ok
  end

  @doc "Ensure the per-workspace index directory exists."
  @spec ensure_workspace_dir(integer()) :: :ok
  def ensure_workspace_dir(workspace_id) when is_integer(workspace_id) do
    ensure_dir(index_dir(workspace_id))
  end

  @doc "Ensure the DM segment + a user-pair subdirectory exist."
  @spec ensure_dm_pair_dir(integer(), integer()) :: :ok
  def ensure_dm_pair_dir(user_a, user_b) when is_integer(user_a) and is_integer(user_b) do
    ensure_dir(dm_pair_dir(user_a, user_b))
  end
end
