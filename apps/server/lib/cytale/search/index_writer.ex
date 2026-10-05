defmodule Cytale.Search.IndexWriter do
  @moduledoc """
  Per-workspace index writer (U13 slice 2) — a GenServer that owns the
  muninn index reference for one workspace, batches document adds, and
  commits on a ~500ms timer (the plan's batched-commit freshness window:
  a message becomes searchable within ~1s of send).

  Tantivy allows exactly one `IndexWriter` per directory, so each workspace
  gets its own writer process (strong physical tenant isolation). The writer
  is started lazily on first `index/2` through `Cytale.Search.IndexWriterSupervisor`
  and reconstructs its muninn index from the on-disk directory on restart.

  Watermark: the writer tracks the last-committed `message_id` so
  `Cytale.Search.TantivyImpl.reconcile/1` can self-heal against ScyllaDB
  (replay the delta between the watermark and the workspace's latest message
  via idempotent upserts keyed by message_id).

  That idempotency is maintained HERE and is not free: Tantivy's
  `add_document` appends, so each document is written as delete-then-add by
  `message_id` (Tantivy's documented upsert). Without the delete, re-indexing a
  message leaves two documents for it — and every replay of an already-indexed
  message (a rebuild, or a reconcile after a writer restart, since the
  watermark is in-memory) would then inflate the index (#89).
  """

  use GenServer

  alias Cytale.Search.Partition

  @typedoc "One index's identity: a workspace's messages, or one user's DMs."
  @type index_key :: {:workspace, integer()} | {:dm_user, integer()}

  # Guard for a valid index key (see `t:index_key/0`).
  defguard is_elem_key(key)
           when is_tuple(key) and tuple_size(key) == 2 and elem(key, 0) in [:workspace, :dm_user] and
                  is_integer(elem(key, 1))

  require Logger

  @doc "The muninn schema for a Cytale message index."
  @spec schema() :: Muninn.Schema.t()
  def schema do
    Muninn.Schema.new()
    |> Muninn.Schema.add_u64_field("message_id", stored: true)
    |> Muninn.Schema.add_u64_field("channel_id", stored: true)
    |> Muninn.Schema.add_u64_field("author_id", stored: true)
    |> Muninn.Schema.add_u64_field("created_at", stored: true)
    |> Muninn.Schema.add_u64_field("thread_id", stored: true)
    |> Muninn.Schema.add_text_field("content", stored: true)
  end

  @doc "Start a writer for `index_key` (via DynamicSupervisor)."
  @spec start_link(index_key()) :: GenServer.on_start()
  def start_link(index_key) when is_elem_key(index_key) do
    GenServer.start_link(__MODULE__, index_key, name: via(index_key))
  end

  @doc "Child spec for the DynamicSupervisor (the index key as the arg)."
  def child_spec(index_key) when is_elem_key(index_key) do
    %{
      id: {__MODULE__, index_key},
      start: {__MODULE__, :start_link, [index_key]},
      restart: :transient,
      type: :worker
    }
  end

  @doc "Registry via-tuple for an index's writer."
  @spec via(index_key()) :: {:via, Registry, {module(), index_key()}}
  def via(index_key) when is_elem_key(index_key) do
    {:via, Registry, {Cytale.Search.IndexWriterRegistry, index_key}}
  end

  @doc "Look up a live writer pid for an index, or nil."
  @spec whereis(index_key()) :: pid() | nil
  def whereis(index_key) when is_elem_key(index_key) do
    case Registry.whereis_name({Cytale.Search.IndexWriterRegistry, index_key}) do
      :undefined -> nil
      pid -> pid
    end
  end

  @doc "Ensure a writer is running for `index_key` (idempotent)."
  @spec ensure_started(index_key()) :: {:ok, pid()} | {:error, term()}
  def ensure_started(index_key) when is_elem_key(index_key) do
    case whereis(index_key) do
      pid when is_pid(pid) ->
        {:ok, pid}

      nil ->
        child = {__MODULE__, index_key}

        case DynamicSupervisor.start_child(Cytale.Search.IndexWriterSupervisor, child) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, :already_present} -> {:ok, whereis(index_key)}
          {:error, reason} -> {:error, reason}
        end
    end
  end

  @doc "Queue a message for indexing (fire-and-forget; batched commit)."
  @spec index(integer(), Cytale.Search.Behaviour.message()) :: :ok
  def index(index_key, message) when is_elem_key(index_key) and is_map(message) do
    case ensure_started(index_key) do
      {:ok, pid} ->
        GenServer.cast(pid, {:index, message})
        :ok

      {:error, reason} ->
        Logger.warning("index_writer: #{inspect(index_key)} could not start: #{inspect(reason)}")
        :ok
    end
  end

  @doc "The muninn index reference for a workspace (for querying)."
  @spec index_ref(integer()) :: reference() | nil
  def index_ref(index_key) when is_elem_key(index_key) do
    case whereis(index_key) do
      nil -> nil
      pid -> GenServer.call(pid, :index_ref)
    end
  end

  @doc "The last-committed message_id watermark for a workspace."
  @spec watermark(integer()) :: integer() | nil
  def watermark(index_key) when is_elem_key(index_key) do
    case whereis(index_key) do
      nil -> nil
      pid -> GenServer.call(pid, :watermark)
    end
  end

  @doc "Flush + commit immediately (tests / reconcile)."
  @spec commit_now(integer()) :: :ok
  def commit_now(index_key) when is_elem_key(index_key) do
    case whereis(index_key) do
      nil -> :ok
      pid -> GenServer.call(pid, :commit_now)
    end
  end

  @doc "Delete every indexed message by an author (U14 cascade)."
  @spec delete_by_author(integer(), integer()) :: :ok
  def delete_by_author(index_key, author_id) when is_elem_key(index_key) and is_integer(author_id) do
    case whereis(index_key) do
      nil -> :ok
      pid -> GenServer.call(pid, {:delete_by_author, author_id})
    end
  end

  @doc """
  Remove one message's document by its `message_id` term (#76), then commit so
  the removal is visible. Best-effort: the row is already gone from ScyllaDB,
  so a failure here degrades to the ghost the reader now skips.
  """
  @spec delete_message(index_key(), integer()) :: :ok
  def delete_message(index_key, message_id) when is_elem_key(index_key) and is_integer(message_id) do
    case whereis(index_key) do
      nil -> :ok
      pid -> GenServer.call(pid, {:delete_message, message_id})
    end
  end

  @doc """
  `delete_message/2` as a CAST (review #21): for the fan-out handler, which
  must not wait on the writer's commit. No writer running means nothing is
  indexed for the key, so there is nothing to delete.
  """
  @spec delete_message_async(index_key(), integer()) :: :ok
  def delete_message_async(index_key, message_id) when is_elem_key(index_key) and is_integer(message_id) do
    case whereis(index_key) do
      nil -> :ok
      pid -> GenServer.cast(pid, {:delete_message, message_id})
    end

    :ok
  end

  @doc """
  Drop an index entirely: stop its writer (if running) and remove its
  directory and watermark file. Used when the index's owner is gone (account
  deletion drops the user's own DM index) — nothing is left to query it and
  its contents must not outlive the account. Idempotent.
  """
  @spec drop(index_key()) :: :ok
  def drop(index_key) when is_elem_key(index_key) do
    case whereis(index_key) do
      nil -> :ok
      pid -> _ = DynamicSupervisor.terminate_child(Cytale.Search.IndexWriterSupervisor, pid)
    end

    File.rm_rf!(Partition.dir_for(index_key))
    _ = File.rm(watermark_path(index_key))
    :ok
  end

  @doc """
  Remove a SET of documents by `message_id` term in one commit (#89) — the
  surgical orphan repair.

  `delete_message/2` commits per id, which is right for the fan-out (one
  delete, immediately visible) and wrong for a repair of hundreds: this is the
  batch form, same terms, same visibility, one commit. Ids absent from the
  index are a no-op, so a repair is safe to repeat.
  """
  @spec discard(index_key(), [integer()]) :: :ok
  def discard(index_key, message_ids)
      when is_elem_key(index_key) and is_list(message_ids) do
    case {whereis(index_key), Enum.filter(message_ids, &is_integer/1)} do
      {nil, _} -> :ok
      {_, []} -> :ok
      {pid, ids} -> GenServer.call(pid, {:discard, ids}, 30_000)
    end
  end

  # -- GenServer ----------------------------------------------------------------

  defstruct key: nil, index: nil, buffer: [], watermark: nil, timer: nil, reconciling?: false

  # The self-heal's first run, after the writer starts (review #24): long
  # enough that a boot's burst of writer starts does not stampede ScyllaDB
  # with replays, short enough that a gap left by a crash closes promptly.
  @first_reconcile_ms 5_000

  @impl true
  def init(index_key) do
    dir = Partition.dir_for(index_key)
    Partition.ensure_key_dir(index_key)

    {index, watermark} =
      case Muninn.Index.create(dir, schema()) do
        {:ok, index} ->
          # A FRESH index holds nothing, whatever a leftover watermark file
          # says (the directory was lost or wiped): start from nil, so the
          # self-heal and the DM backfill replay everything.
          _ = File.rm(watermark_path(index_key))
          {index, nil}

        {:error, _} ->
          # Directory already holds an index — open it, with the watermark it
          # last committed.
          case Muninn.Index.open(dir) do
            {:ok, index} -> {index, read_watermark(index_key)}
            {:error, reason} -> raise "muninn index open failed for #{dir}: #{inspect(reason)}"
          end
      end

    timer = schedule_commit()
    schedule_reconcile(index_key, @first_reconcile_ms)

    # Review #24: the watermark is recovered from disk. It was in-memory only,
    # so every restart reset it to nil and a reconcile (had anything run one)
    # would have replayed the workspace from its first message.
    {:ok, %__MODULE__{key: index_key, index: index, timer: timer, watermark: watermark}}
  end

  # Review #24: `TantivyImpl.reconcile/1` — replay the messages between the
  # committed watermark and the workspace's latest — existed and was never
  # called, so an index write that was lost (a crash between the fan-out and
  # the commit, a shed task, a writer restart) stayed missing from search
  # forever. It now runs shortly after the writer starts and then on a timer.
  # Workspace indexes only (the DM segment catches up on query through
  # `ensure_dm_current/1`); disabled when the interval is 0.
  defp schedule_reconcile({:workspace, _id}, delay_ms) do
    if Cytale.Config.search_reconcile_interval_ms() > 0,
      do: Process.send_after(self(), :reconcile, delay_ms)

    :ok
  end

  defp schedule_reconcile(_dm_key, _delay_ms), do: :ok

  # The watermark rides a sibling file of the index directory (never inside
  # it — the directory is Tantivy's), written after each successful commit.
  defp watermark_path(index_key), do: Partition.dir_for(index_key) <> ".watermark"

  defp read_watermark(index_key) do
    case File.read(watermark_path(index_key)) do
      {:ok, text} ->
        case Integer.parse(String.trim(text)) do
          {id, ""} when id > 0 -> id
          _ -> nil
        end

      {:error, _} ->
        nil
    end
  end

  defp write_watermark(_index_key, nil), do: :ok

  defp write_watermark(index_key, watermark) do
    path = watermark_path(index_key)
    tmp = path <> ".tmp"

    with :ok <- File.write(tmp, Integer.to_string(watermark)),
         :ok <- File.rename(tmp, path) do
      :ok
    else
      {:error, reason} ->
        Logger.warning("index_writer: watermark persist failed for #{inspect(index_key)}: #{inspect(reason)}")
        :ok
    end
  end

  @impl true
  def handle_cast({:index, message}, state) do
    {:noreply, %{state | buffer: [message | state.buffer]}}
  end

  # The cast twin of the `{:delete_message, id}` call (review #21 — the
  # workspace fan-out unindexes inline and must not wait on a commit). A
  # document for the same id still sitting in the buffer is dropped too: the
  # term delete below cannot see an add that has not been flushed yet, and
  # the flush would otherwise resurrect the deleted message as a ghost hit.
  def handle_cast({:delete_message, message_id}, state) do
    buffer = Enum.reject(state.buffer, &(&1.id == message_id))

    case Muninn.IndexWriter.delete_term(state.index, "message_id", message_id) do
      :ok -> Muninn.IndexWriter.commit(state.index)
      {:error, reason} -> Logger.warning("index_writer: delete_message failed: #{inspect(reason)}")
    end

    {:noreply, %{state | buffer: buffer}}
  end

  @impl true
  def handle_info(:commit, state) do
    state = flush_and_commit(state)
    {:noreply, %{state | timer: schedule_commit()}}
  end

  # One reconcile at a time per writer: the replay runs in a supervised task
  # (it calls back into THIS process — `watermark/1`, `index/2`,
  # `commit_now/1` — so it cannot run inside it), and the next run is
  # scheduled only when this one reports back.
  def handle_info(:reconcile, %{reconciling?: true} = state), do: {:noreply, state}

  def handle_info(:reconcile, %{key: {:workspace, workspace_id}} = state) do
    writer = self()

    started =
      Task.Supervisor.start_child(Cytale.Search.RebuildTaskSupervisor, fn ->
        result =
          try do
            Cytale.Search.TantivyImpl.reconcile(workspace_id)
          rescue
            e -> {:error, e}
          end

        send(writer, {:reconcile_done, result})
      end)

    case started do
      {:ok, _pid} ->
        {:noreply, %{state | reconciling?: true}}

      {:error, reason} ->
        Logger.warning("index_writer: reconcile not started for #{workspace_id}: #{inspect(reason)}")
        schedule_reconcile(state.key, Cytale.Config.search_reconcile_interval_ms())
        {:noreply, state}
    end
  end

  def handle_info({:reconcile_done, result}, state) do
    case result do
      {:ok, n} when is_integer(n) and n > 0 ->
        Logger.info("index_writer: reconcile re-indexed #{n} message(s) for #{inspect(state.key)}")

      {:error, reason} ->
        Logger.warning("index_writer: reconcile failed for #{inspect(state.key)}: #{inspect(reason)}")

      _ ->
        :ok
    end

    schedule_reconcile(state.key, Cytale.Config.search_reconcile_interval_ms())
    {:noreply, %{state | reconciling?: false}}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:index_ref, _from, state), do: {:reply, state.index, state}

  def handle_call(:watermark, _from, state), do: {:reply, state.watermark, state}

  def handle_call(:commit_now, _from, state) do
    state = flush_and_commit(state)
    {:reply, :ok, state}
  end

  def handle_call({:delete_by_author, author_id}, _from, state) do
    # Delete by author_id term, then commit so the delete is visible.
    case Muninn.IndexWriter.delete_term(state.index, "author_id", author_id) do
      :ok ->
        Muninn.IndexWriter.commit(state.index)
        :ok

      {:error, reason} ->
        Logger.warning("index_writer: delete_by_author failed: #{inspect(reason)}")
        :ok
    end

    {:reply, :ok, state}
  end

  def handle_call({:delete_message, message_id}, _from, state) do
    case Muninn.IndexWriter.delete_term(state.index, "message_id", message_id) do
      :ok ->
        Muninn.IndexWriter.commit(state.index)
        :ok

      {:error, reason} ->
        Logger.warning("index_writer: delete_message failed: #{inspect(reason)}")
        :ok
    end

    {:reply, :ok, state}
  end

  def handle_call({:discard, message_ids}, _from, state) do
    deleted =
      Enum.reduce(message_ids, 0, fn message_id, acc ->
        case Muninn.IndexWriter.delete_term(state.index, "message_id", message_id) do
          :ok ->
            acc + 1

          {:error, reason} ->
            Logger.warning("index_writer: discard failed for #{message_id}: #{inspect(reason)}")
            acc
        end
      end)

    # One commit for the whole set — the repair's visibility point.
    if deleted > 0 do
      case Muninn.IndexWriter.commit(state.index) do
        :ok -> :ok
        {:error, reason} -> Logger.warning("index_writer: discard commit failed: #{inspect(reason)}")
      end
    end

    {:reply, :ok, state}
  end

  # -- internals ---------------------------------------------------------------

  defp schedule_commit do
    Process.send_after(self(), :commit, Cytale.Config.search_commit_interval_ms())
  end

  defp flush_and_commit(state) do
    docs = Enum.reverse(state.buffer)

    if docs == [] do
      state
    else
      Enum.each(docs, &upsert_document(state.index, &1))

      case Muninn.IndexWriter.commit(state.index) do
        :ok ->
          # Watermark = the max message_id committed in this batch.
          new_watermark =
            Enum.reduce(docs, state.watermark, fn m, acc ->
              max(acc || 0, m.id)
            end)

          if new_watermark != state.watermark, do: write_watermark(state.key, new_watermark)
          %{state | buffer: [], watermark: new_watermark}

        {:error, reason} ->
          Logger.warning("index_writer: commit failed: #{inspect(reason)}")
          state
      end
    end
  end

  # A REAL upsert, because Tantivy's `add_document` appends: two adds of the
  # same `message_id` leave two documents, and every replay of an already
  # indexed message then inflates the index (#89 found this the moment a
  # rebuild ran twice: 5 messages, 12 documents). Delete-then-add is the
  # documented Tantivy upsert — the delete is applied by opstamp, so the
  # document added after it in this same commit is the one that survives.
  #
  # This also makes `Cytale.Search.TantivyImpl.reconcile/1`'s contract true:
  # the writer's watermark is in-memory, so after a restart a reconcile
  # replays from 0, which previously duplicated the whole index.
  defp upsert_document(index, message) do
    case Muninn.IndexWriter.delete_term(index, "message_id", message.id) do
      :ok -> :ok
      {:error, reason} -> Logger.warning("index_writer: upsert delete failed: #{inspect(reason)}")
    end

    case Muninn.IndexWriter.add_document(index, to_doc(message)) do
      :ok -> :ok
      {:error, reason} -> Logger.warning("index_writer: add_document failed: #{inspect(reason)}")
    end
  end

  # muninn doc map (string keys, u64 fields; thread_id 0 = nil).
  defp to_doc(message) do
    %{
      "message_id" => message.id,
      "channel_id" => message.channel_id,
      "author_id" => message.author_id,
      "created_at" => DateTime.to_unix(message.created_at, :millisecond),
      "thread_id" => message.thread_id || 0,
      "content" => message.content
    }
  end
end
