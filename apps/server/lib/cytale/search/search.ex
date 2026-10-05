defmodule Cytale.Search do
  @moduledoc """
  The search seam facade (U13/U14). Callers depend on this module, never on a
  concrete implementation — it delegates to the configured impl (default
  `Cytale.Search.TantivyImpl`), mirroring the `Cytale.Publish` seam pattern.

  The account-deletion cascade (U14) consumes `delete_by_author/2` here so
  the Tantivy step rides the seam, not a hard-coded implementation.
  """

  alias Cytale.Search.{IndexWriter, Partition}

  require Logger

  @doc "Configured implementation module (default: the Tantivy-backed impl)."
  @spec impl() :: module()
  def impl do
    Application.get_env(:cytale, __MODULE__, Cytale.Search.TantivyImpl)
  end

  @doc "Delete every indexed message by an author in a workspace (U14 cascade)."
  @spec delete_by_author(integer(), integer()) :: :ok
  def delete_by_author(workspace_id, author_id) when is_integer(workspace_id) and is_integer(author_id) do
    impl().delete_by_author(workspace_id, author_id)
  end

  @doc "Remove ONE message's document from its workspace index (#76)."
  @spec delete_message(integer(), integer()) :: :ok
  def delete_message(workspace_id, message_id)
      when is_integer(workspace_id) and is_integer(message_id) do
    impl().delete_message(workspace_id, message_id)
  end

  @doc """
  Delete every indexed DM message by an author — the account-deletion
  cascade's DM leg (U14). DM messages live in PER-PARTICIPANT indexes
  (`{:dm_user, user_id}`), so the author's messages sit in every
  counterpart's index as well as their own:

    * each counterpart's index (every other participant of every DM the
      author belonged to) loses the author's documents by the `author_id`
      term — the writer is started for the purpose when its index exists on
      disk (an idle index is still searchable the next time its owner asks);
    * the author's OWN DM index is dropped outright (writer stopped,
      directory + watermark removed): nobody can query it any more, and what
      it held includes the counterparts' messages, which must not outlive the
      account on disk.

  Best-effort: a failure on one index is logged and the walk continues —
  tombstoning already succeeded (search degrades, chat persists).
  """
  @spec delete_by_author_dm(integer()) :: :ok
  def delete_by_author_dm(author_id) when is_integer(author_id) do
    counterparts =
      author_id
      |> Cytale.Workspaces.dms_of_user()
      |> Enum.flat_map(&(&1.user_ids || []))
      |> Enum.uniq()
      |> Enum.reject(&(&1 == author_id))

    Enum.each(counterparts, fn user_id ->
      best_effort("delete_by_author_dm(#{author_id}) in #{user_id}'s index", fn ->
        key = {:dm_user, user_id}

        if IndexWriter.whereis(key) != nil or File.dir?(Partition.dir_for(key)) do
          {:ok, _pid} = IndexWriter.ensure_started(key)
          # Flush first: a still-buffered add is invisible to a term delete
          # and would be committed AFTER it, resurrecting the document.
          :ok = IndexWriter.commit_now(key)
          :ok = IndexWriter.delete_by_author(key, author_id)
        end
      end)
    end)

    best_effort("drop #{author_id}'s own DM index", fn -> IndexWriter.drop({:dm_user, author_id}) end)

    :ok
  end

  @doc """
  Re-index ONE DM message in every participant's index after an edit, so DM
  search never matches (or shows) the pre-edit text. The DM twin of the
  workspace fan-out's `MessageUpdate` reindex: DM writes index on the write
  seam (`Cytale.Messages`), so edits do too. A workspace channel (no DM row)
  is a no-op; the index write is an upsert keyed by message_id. Best-effort.
  """
  @spec reindex_dm_message(integer(), integer()) :: :ok
  def reindex_dm_message(channel_id, message_id) when is_integer(channel_id) and is_integer(message_id) do
    best_effort("reindex_dm_message(#{channel_id}, #{message_id})", fn ->
      with %{user_ids: user_ids} when is_list(user_ids) <- Cytale.Workspaces.get_dm(channel_id),
           %{} = message <- Cytale.Messages.get_message(channel_id, message_id) do
        Enum.each(user_ids, &Cytale.Search.TantivyImpl.index_dm_message(&1, message))
      end
    end)
  end

  defp best_effort(label, fun) do
    fun.()
    :ok
  rescue
    e ->
      Logger.warning("search: #{label} failed: #{Exception.message(e)}")
      :ok
  catch
    :exit, reason ->
      Logger.warning("search: #{label} exited: #{inspect(reason)}")
      :ok
  end

  @doc """
  Report drift between a workspace's index and its `messages` table (#89).

  Rides the seam so the maintenance surface follows the same implementation
  as indexing and querying. See `Cytale.Search.Drift.check/2`.
  """
  @spec drift(integer(), keyword()) :: map()
  def drift(workspace_id, opts \\ []) when is_integer(workspace_id) do
    impl().drift(workspace_id, opts)
  end

  @doc "Unindex a set of message ids — the surgical orphan repair (#89)."
  @spec repair_orphans(integer(), [integer()]) :: %{unindexed: non_neg_integer(), ids: [integer()]}
  def repair_orphans(workspace_id, message_ids) when is_integer(workspace_id) do
    impl().repair_orphans(workspace_id, message_ids)
  end

  @doc "Re-index a workspace from its messages table (#89)."
  @spec rebuild(integer(), keyword()) :: {:ok, map()}
  def rebuild(workspace_id, opts \\ []) when is_integer(workspace_id) do
    impl().rebuild(workspace_id, opts)
  end
end
