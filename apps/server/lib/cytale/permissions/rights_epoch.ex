defmodule Cytale.Permissions.RightsEpoch do
  @moduledoc """
  KTD4 (bots plan U3) — the per-workspace rights epoch: the instant
  propagation half behind every rights/membership mutation (R9).

  This GenServer (started under the root supervision tree — the
  long-lived-owner rule) owns a named, public `:set` ETS table mapping
  `workspace_id → monotonic integer`. Every role, overwrite, or membership
  mutation calls `bump/1` for its workspace; consumers that memoize rights —
  the U7 gateway visibility memo, keyed `(workspace_id, principal_id) →
  {epoch, visible_channel_set}` — compare their memo's epoch against
  `current/1` and recompute whenever it has moved. There is no cache to
  clear and no fan-out to walk: the very next check after a mutation sees
  fresh rights.

  `bump/1` is serialized through the owner (a per-node total order per
  workspace); `current/1` is a lock-free ETS read safe to call on every
  check. A never-bumped workspace reads epoch `0`; the first bump moves it
  to `1`. Epoch values are only ever COMPARED for change, never interpreted.

  Voice plan U4 (AM3): every bump also NOTIFIES the workspace's live
  subscribers (`subscribe/1` — the call rooms) with
  `{:rights_epoch_bumped, workspace_id, epoch}` so mid-call permission
  revocations evict immediately instead of waiting for the next op. The
  subscriber index is a lock-free public ETS bag beside the epochs table —
  subscribing is an insert, unsubscribing a delete, and the bump path
  notifies (and opportunistically prunes dead pids) under the owner's
  serialization.
  """

  use GenServer

  @typedoc "A workspace snowflake id."
  @type workspace_id :: integer()

  @table __MODULE__.Epochs
  @subs __MODULE__.Subscribers
  @perm_cache __MODULE__.PermCache

  # Expired permission-memo entries are reaped on this cadence (the TTL makes
  # them misses already; this only returns their memory).
  @cache_sweep_ms 60_000

  # -- client API ------------------------------------------------------------

  @doc "Starts the epoch owner (named `#{inspect(__MODULE__)}` by default)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: Keyword.get(opts, :name, __MODULE__))
  end

  @doc """
  Advance (or initialize) `workspace_id`'s epoch; returns the new value.
  Call at EVERY rights/membership mutation for the affected workspace.
  Every live subscriber of the workspace (see `subscribe/1`) is notified
  with `{:rights_epoch_bumped, workspace_id, epoch}` before the reply.
  """
  @spec bump(workspace_id()) :: pos_integer()
  def bump(workspace_id) when is_integer(workspace_id) do
    GenServer.call(owner(), {:bump, workspace_id})
  end

  @doc """
  The permission memo's table (`Cytale.Permissions.Cache`), owned by this
  process so it dies with the epochs it is versioned by. `nil` when the owner
  is not running — callers then resolve uncached.
  """
  @spec perm_cache() :: atom() | nil
  def perm_cache do
    if :ets.whereis(@perm_cache) == :undefined, do: nil, else: @perm_cache
  end

  @doc """
  `current/1` for callers that must not raise when the owner is absent: `nil`
  means "no epoch is knowable, do not cache".
  """
  @spec current_or_nil(workspace_id()) :: non_neg_integer() | nil
  def current_or_nil(workspace_id) when is_integer(workspace_id) do
    current(workspace_id)
  rescue
    ArgumentError -> nil
  end

  @doc """
  `bump/1` for DATA-LAYER mutation sites: never raises. A rights write is
  committed by the time it bumps, so an absent owner (a hermetic boot, its
  restart window — during which the memo table is gone too) must not turn a
  committed write into an error.
  """
  @spec bump_quietly(workspace_id()) :: :ok
  def bump_quietly(workspace_id) when is_integer(workspace_id) do
    _ = bump(workspace_id)
    :ok
  catch
    :exit, _reason -> :ok
  end

  @doc "The current epoch for `workspace_id` (`0` when never bumped)."
  @spec current(workspace_id()) :: non_neg_integer()
  def current(workspace_id) when is_integer(workspace_id) do
    case :ets.lookup(@table, workspace_id) do
      [{^workspace_id, epoch}] when is_integer(epoch) -> epoch
      _ -> 0
    end
  end

  @doc """
  Subscribe `pid` (default `self()`) to `workspace_id`'s epoch bumps (AM3 —
  the call rooms' mid-call eviction feed). Lock-free: a direct insert into
  the public subscriber bag; unsubscribe on stop, dead pids pruned at the
  next bump.
  """
  @spec subscribe(workspace_id(), pid()) :: :ok
  def subscribe(workspace_id, pid \\ self()) when is_integer(workspace_id) and is_pid(pid) do
    true = :ets.insert(@subs, {workspace_id, pid})
    :ok
  end

  @doc "Drop `pid`'s subscription for `workspace_id` (rooms call this at call end)."
  @spec unsubscribe(workspace_id(), pid()) :: :ok
  def unsubscribe(workspace_id, pid \\ self()) when is_integer(workspace_id) and is_pid(pid) do
    true = :ets.delete_object(@subs, {workspace_id, pid})
    :ok
  end

  # -- GenServer ---------------------------------------------------------------

  @impl true
  def init(:ok) do
    # The owner creates the tables (they die with the owner, never with a
    # request process); :public + read_concurrency lets every check read
    # epochs without touching the owner — only bumps pay the call.
    :ets.new(@table, [:set, :named_table, :public, read_concurrency: true])
    :ets.new(@subs, [:bag, :named_table, :public])

    # The permission memo (review #19): public so request processes read and
    # fill it directly; owned HERE so it can never outlive the epochs.
    :ets.new(@perm_cache, [:set, :named_table, :public, read_concurrency: true, write_concurrency: true])
    Process.send_after(self(), :sweep_perm_cache, @cache_sweep_ms)
    {:ok, %{}}
  end

  @impl true
  def handle_info(:sweep_perm_cache, state) do
    now = System.monotonic_time(:millisecond)

    :ets.select_delete(@perm_cache, [
      {{:_, :_, :_, :"$1"}, [{:is_integer, :"$1"}, {:<, :"$1", now}], [true]}
    ])

    Process.send_after(self(), :sweep_perm_cache, @cache_sweep_ms)
    {:noreply, state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call({:bump, workspace_id}, _from, state) do
    next =
      case :ets.lookup(@table, workspace_id) do
        [{^workspace_id, epoch}] when is_integer(epoch) -> epoch + 1
        _ -> 1
      end

    true = :ets.insert(@table, {workspace_id, next})
    notify_subscribers(workspace_id, next)
    {:reply, next, state}
  end

  # The AM3 broadcast: every LIVE subscriber of the workspace hears the
  # bump (message order against the ETS write is the owner's serialization;
  # a subscriber that checks `current/1` on receipt always sees >= next).
  # Dead pids (crashed rooms that never unsubscribed) are pruned here.
  defp notify_subscribers(workspace_id, epoch) do
    for {^workspace_id, pid} = entry <- :ets.lookup(@subs, workspace_id) do
      if Process.alive?(pid) do
        send(pid, {:rights_epoch_bumped, workspace_id, epoch})
      else
        true = :ets.delete_object(@subs, entry)
      end
    end

    :ok
  end

  # The owner is registered under the module name (application tree); tests
  # may run a supervised copy under the same name when the app is absent.
  defp owner, do: __MODULE__
end
