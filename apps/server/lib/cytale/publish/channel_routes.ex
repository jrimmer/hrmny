defmodule Cytale.Publish.ChannelRoutes do
  @moduledoc """
  Cached `channel_id → workspace_id` for the publish routing seam (hardening plan
  5.1).

  `Publish.publish/2` resolves a channel to its workspace process with a point
  read of `channels_by_id` — on EVERY publish: every message, every typing signal,
  every presence fan-out. The mapping is IMMUTABLE (a channel is created in a
  workspace and never moves), so a cached entry cannot go stale while this owner
  lives.

  A channel DELETED after being cached is tombstoned by the delete path
  (`forget/1`): the REST permission gate reads this cache too (review #19), and
  there a stale entry would not be inert — it would keep the channel writable.

  Only HITS are cached. Caching the "not a workspace channel" answer would be safe
  too (an id never becomes a channel later), but the DM path needs its own row
  regardless — see `FanOut.deliver/3`'s `resolved:` — and this cache exists to
  remove the steady-state read, not to re-route DMs.

  If this owner is not running (a hermetic test boot, or the crash window before
  the supervisor restarts it), `fetch/1` answers `:error` and the caller runs the
  query: correct, just slower. A missing cache must never be a correctness
  problem — the same posture as `Cytale.Repo.Statements`.
  """

  use GenServer

  @table __MODULE__

  @doc "Starts the cache owner."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc "The public, named cache table (tests and diagnostics)."
  @spec table() :: atom()
  def table, do: @table

  @doc "`{:ok, workspace_id}` when cached; `:error` on a miss or without the owner."
  @spec fetch(integer()) :: {:ok, integer()} | :error
  def fetch(channel_id) when is_integer(channel_id) do
    case :ets.lookup(@table, channel_id) do
      [{^channel_id, workspace_id}] when is_integer(workspace_id) -> {:ok, workspace_id}
      # A deleted channel's tombstone (see `forget/1`) reads as a miss.
      _miss_or_tombstone -> :error
    end
  rescue
    # The table is gone (owner not running): a miss, never an error.
    ArgumentError -> :error
  end

  @doc """
  Remember a channel's workspace. Never overwrites an existing entry — in
  particular not a `forget/1` tombstone: a reader that fetched the row just
  before a delete must not re-plant the route after it.
  """
  @spec put(integer(), integer()) :: :ok
  def put(channel_id, workspace_id) when is_integer(channel_id) and is_integer(workspace_id) do
    _ = :ets.insert_new(@table, {channel_id, workspace_id})
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc """
  Retire a DELETED channel's route. Since the REST permission gate began
  reading this cache as its channel→workspace lookup (review #19), a stale
  entry would keep a deleted channel writable — so the delete path now
  leaves a tombstone (ids are never reused, so it can never shadow a live
  channel) that `fetch/1` reads as a miss and `put/2` cannot overwrite.
  """
  @spec forget(integer()) :: :ok
  def forget(channel_id) when is_integer(channel_id) do
    true = :ets.insert(@table, {channel_id, :deleted})
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Cached entries (tests and diagnostics)."
  @spec size() :: non_neg_integer()
  def size do
    if :ets.whereis(@table) == :undefined, do: 0, else: :ets.info(@table, :size)
  end

  @impl true
  def init(:ok) do
    :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    {:ok, :ok}
  end
end
