defmodule Cytale.Calls.Log do
  @moduledoc """
  The standing call-log thread (voice plan U3, KTD5/R4): one lazily-created
  anchorless thread per channel, linked by the `call_threads` mapping row and
  REUSED for every later call in that channel.

  Creation goes through `Cytale.Threads.Thread.start/4` with
  `parent_message_id: nil` (the standalone-thread path) and the fixed system
  name below. The mapping table being the only creation path for that name
  is what keeps system call-log threads from colliding with user-named
  threads — nothing else ever mints this name.

  Call starts are serialized per channel by the room registry's one-live
  invariant (the room process is the only caller of `ensure_thread/2`), so
  find-or-create never races itself on a single channel.
  """

  alias Cytale.Repo
  alias Cytale.Threads.Thread

  @log_name "Call log"

  @doc "The fixed system thread name for standing call logs."
  @spec log_name() :: String.t()
  def log_name, do: @log_name

  @doc """
  Find-or-create the channel's standing call-log thread. Returns
  `{:ok, thread_id}` — the id later calls in the same channel reuse.
  """
  @spec ensure_thread(integer(), integer()) :: {:ok, integer()}
  def ensure_thread(channel_id, created_by)
      when is_integer(channel_id) and is_integer(created_by) do
    case thread_id(channel_id) do
      nil ->
        {:ok, t} = Thread.start(channel_id, nil, @log_name, created_by)
        insert_mapping(channel_id, t.thread_id, created_by)
        {:ok, t.thread_id}

      thread_id ->
        {:ok, thread_id}
    end
  end

  @doc "The channel's standing call-log thread id, or nil when none was created yet."
  @spec thread_id(integer()) :: integer() | nil
  def thread_id(channel_id) when is_integer(channel_id) do
    rows =
      Repo.execute!(
        "SELECT thread_id FROM {{K}}.call_threads WHERE channel_id = ?",
        [{"bigint", channel_id}]
      )
      |> Enum.to_list()

    case rows do
      [%{"thread_id" => thread_id}] -> thread_id
      [] -> nil
    end
  end

  defp insert_mapping(channel_id, thread_id, created_by) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Repo.execute!(
      "INSERT INTO {{K}}.call_threads (channel_id, thread_id, created_by, created_at) VALUES (?, ?, ?, ?)",
      [
        {"bigint", channel_id},
        {"bigint", thread_id},
        {"bigint", created_by},
        {"timestamp", now}
      ]
    )

    :ok
  end
end
