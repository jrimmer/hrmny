defmodule Cytale.Search.PartitionTest do
  @moduledoc """
  U13 slice 1 — per-workspace index directory management. Pure filesystem,
  no NIF. The root is pointed at a temp dir so tests never touch the real
  `priv/search`.
  """

  use ExUnit.Case, async: true

  alias Cytale.Search.Partition

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_search_partition_#{System.unique_integer([:positive])}")
    original = Application.get_env(:cytale, Cytale.Config)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(original || [], :search_index_root, tmp))

    on_exit(fn ->
      # RESTORE, never delete: deleting the whole Cytale.Config env drops
      # scylla_keyspace (test) and makes Repo.keyspace() fall back to the prod
      # default "cytale" — a cross-module race that broke the full suite.
      if original == nil do
        Application.delete_env(:cytale, Cytale.Config)
      else
        Application.put_env(:cytale, Cytale.Config, original)
      end
    end)

    {:ok, tmp: tmp}
  end

  test "index_dir is priv/search/{workspace_id}", %{tmp: tmp} do
    assert Partition.index_dir(123) == Path.join(tmp, "123")
    assert Partition.index_dir(456) == Path.join(tmp, "456")
  end

  test "dm_segment_dir is priv/search/_dm", %{tmp: tmp} do
    assert Partition.dm_segment_dir() == Path.join(tmp, "_dm")
  end

  test "dm_pair_dir canonicalizes the pair ordering", %{tmp: tmp} do
    assert Partition.dm_pair_dir(5, 3) == Path.join(tmp, "_dm/3_5")
    assert Partition.dm_pair_dir(3, 5) == Path.join(tmp, "_dm/3_5")
  end

  test "ensure_dir creates the directory (mkdir -p)", %{tmp: tmp} do
    dir = Path.join(tmp, "nested/a/b")
    assert Partition.ensure_dir(dir) == :ok
    assert File.dir?(dir)
  end

  test "ensure_workspace_dir creates the per-workspace dir", %{tmp: tmp} do
    assert Partition.ensure_workspace_dir(999) == :ok
    assert File.dir?(Path.join(tmp, "999"))
  end

  test "ensure_dm_pair_dir creates the user-pair subdir", %{tmp: tmp} do
    assert Partition.ensure_dm_pair_dir(8, 2) == :ok
    assert File.dir?(Path.join(tmp, "_dm/2_8"))
  end
end
