defmodule Cytale.Gateway.PushRegistry do
  @moduledoc """
  Tracks which sessions are currently attached to which channels (U10 fan-out
  target bookkeeping), plus per-user multi-session addressability.

  Built on a public named ETS bag of `{channel_key, session_pid, user_id}`
  entries plus a companion registry for O(1) liveness-true reverse lookups.
  Entry insertion/removal is done by the owning socket process; readers fold
  the bag. Process-alive filtering happens at read time.

  Later units (U11 presence/fan-out) will grow this into its final shape —
  the accessor surface here is what survives.
  """

  use GenServer

  @doc "Starts the owner (idempotent)."
  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(_opts \\ []) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @typedoc "Fan-out keys: per-user, per-channel, or per-workspace routing."
  @type route_key ::
          {:user, String.t()} | {:channel, String.t()} | {:workspace, String.t()}

  @doc "Route key for all of a user's live sockets."
  @spec user_key(String.t()) :: {:user, String.t()}
  def user_key(user_id), do: {:user, user_id}

  @doc "Route key for one channel's subscriber sockets."
  @spec channel_key(String.t()) :: {:channel, String.t()}
  def channel_key(channel_id), do: {:channel, channel_id}

  @doc "Route key for one workspace's member sockets (presence scope)."
  @spec workspace_key(String.t()) :: {:workspace, String.t()}
  def workspace_key(workspace_id), do: {:workspace, workspace_id}

  @doc """
  Attach `session_pid` (user `user_id`) to a route key; `alias_keys` mirrors the
  same registration under extra keys in one insert.
  """
  @spec subscribe(route_key(), String.t(), pid(), [route_key()]) :: :ok
  def subscribe(route_key, user_id, pid \\ self(), alias_keys \\ []) when is_list(alias_keys) do
    keys = Enum.uniq([route_key | alias_keys])
    entries = for key <- keys, do: {key, pid, user_id}
    # No `true =` match (hardening plan 7.10): `:ets.insert/2` returns true or
    # raises, so the assert pinned nothing.
    :ets.insert(table(), entries)
    index_add(pid, Enum.map(keys, &{&1, user_id}))
    :ok
  end

  @doc "Detach one specific socket process."
  @spec unsubscribe(route_key(), pid()) :: :ok
  def unsubscribe(route_key, pid) do
    case Enum.find(index_pairs(pid) || [], fn {key, _user} -> key == route_key end) do
      {_key, user_id} ->
        :ets.delete_object(table(), {route_key, pid, user_id})

      nil ->
        # Not indexed (a row written before this index existed, or an index that
        # was lost): fall back to the bucket scan rather than leaving a stale row.
        table()
        |> :ets.lookup(route_key)
        |> Enum.filter(fn {_key, member, _user} -> member == pid end)
        |> Enum.each(&:ets.delete_object(table(), &1))
    end

    index_remove(pid, [route_key])
    :ok
  end

  @doc """
  Drop every registration belonging to `pid`.

  The reverse index (hardening plan 5.4) makes this proportional to the PID'S OWN
  routes: each `{key, user_id}` pair it holds is removed by a keyed
  `delete_object/2`, where this used to be a `match_delete` over every
  registration on the node — the disconnect path paid for the whole instance's
  registry.

  A pid with no index entry still falls back to that full scan, so a row written
  before the index existed (or an index lost with a crashed owner) cannot leak.
  """
  @spec drop_session(pid()) :: :ok
  def drop_session(pid) do
    case index_pairs(pid) do
      nil ->
        :ets.match_delete(table(), {:_, pid, :_})

      pairs ->
        Enum.each(pairs, fn {key, user_id} -> :ets.delete_object(table(), {key, pid, user_id}) end)
    end

    index_write(fn -> :ets.delete(sessions(), pid) end)
    :ok
  end

  @doc """
  Reconcile `pid`'s registrations to EXACTLY `desired` (the user key rides
  along implicitly). Missing entries are inserted FIRST, then entries under
  keys outside the desired set are removed — an additive refresh (a parent
  joining a workspace, KTD4's rejoin path) never exposes a gap to a
  concurrent fan-out reader, unlike drop_session + re-subscribe.
  """
  @spec sync_session(pid(), String.t(), [route_key()]) :: :ok
  def sync_session(pid, user_id, desired) when is_pid(pid) and is_list(desired) do
    wanted = Enum.uniq([user_key(user_id) | desired])
    current = session_keys(pid)

    missing = wanted -- current

    if missing != [] do
      :ets.insert(table(), Enum.map(missing, fn key -> {key, pid, user_id} end))
    end

    # Stale keys go by their INDEXED identity, so this is a keyed delete per route
    # rather than a bucket lookup per route (hardening plan 5.4).
    indexed = Map.new(index_pairs(pid) || [], fn {key, user} -> {key, user} end)

    for key <- current -- wanted do
      case Map.get(indexed, key) do
        nil ->
          table()
          |> :ets.lookup(key)
          |> Enum.filter(fn {_k, member, _u} -> member == pid end)
          |> Enum.each(&:ets.delete_object(table(), &1))

        indexed_user ->
          :ets.delete_object(table(), {key, pid, indexed_user})
      end
    end

    index_put(pid, Enum.map(wanted, &{&1, user_id}))
    :ok
  end

  @doc """
  Route keys `pid` is currently registered under — the reverse index when it has
  one (hardening plan 5.4), the `select/2` scan otherwise.

  The scan is why the plan flagged this function: it was a full-table
  `:ets.select` on EVERY route refresh, so a session's own sync paid for every
  other session's registrations. The index answers in O(1) plus the pid's own key
  count; the fallback keeps the answer right for rows the index does not know
  about (see `drop_session/1`).
  """
  @spec session_keys(pid()) :: [route_key()]
  def session_keys(pid) when is_pid(pid) do
    case index_pairs(pid) do
      nil ->
        match = [{{:"$1", :"$2", :_}, [{:==, :"$2", pid}], [:"$1"]}]
        :ets.select(table(), match) |> Enum.uniq()

      pairs ->
        pairs |> Enum.map(&elem(&1, 0)) |> Enum.uniq()
    end
  rescue
    # The owner is not running: behave like every other reader here and answer
    # "no routes" instead of raising. The callers include a socket's terminate/2
    # and the shard sweeper, where a raise would skip the disconnect stamp, the
    # offline hold, the claim release AND the drop — turning a missing registry
    # into a leaked session.
    ArgumentError -> []
  end

  @doc """
  Live subscriber sockets for a route key as `{pid, user_id}` pairs.

  Dead processes are filtered out AND their ROUTE ROWS reclaimed (hardening plan
  5.4): a socket that died without running its terminate (a kill, a supervisor
  timeout) left its rows behind for good, so every later read — and every
  fan-out — walked them again. The reverse index makes the reclaim a keyed delete
  per route rather than the full-table sweep a `match_delete` would be, which is
  what lets it happen here, on the read path.

  The dead pid's INDEX entry is deliberately left standing (`drop_routes/1`, not
  `drop_session/1`): the offline buffer (4.2) needs those routes to hold them for
  the session's resume window, and the shard sweeper reads them within a second
  and retires the entry with `drop_session/1` (`SessionStore.Shard`'s
  `hold_recovered/2`). Without this, the first fan-out after an untrappable death
  reclaimed the routes and the recovery held an EMPTY route set — the silent
  message loss this whole item exists to close.
  """
  @spec subscribers(route_key()) :: [{pid(), String.t()}]
  def subscribers(route_key) do
    case :ets.lookup(table(), route_key) do
      [] ->
        []

      entries ->
        {live, dead} = Enum.split_with(entries, fn {_key, pid, _user} -> Process.alive?(pid) end)

        dead |> Enum.map(&elem(&1, 1)) |> Enum.uniq() |> Enum.each(&drop_routes/1)

        live
        |> Enum.map(fn {_key, pid, user_id} -> {pid, user_id} end)
        |> Enum.uniq()
    end
  end

  @doc """
  Reclaim a dead pid's ROUTE ROWS but keep its reverse-index entry.

  Used by `subscribers/1`'s read-path reclaim: the routes are still needed by the
  sweep's orphan recovery (see `subscribers/1`), and the entry is cheap — one row,
  retired by the next sweep, at most a second later.
  """
  @spec drop_routes(pid()) :: :ok
  def drop_routes(pid) when is_pid(pid) do
    case index_pairs(pid) do
      nil ->
        :ets.match_delete(table(), {:_, pid, :_})

      pairs ->
        Enum.each(pairs, fn {key, user_id} -> :ets.delete_object(table(), {key, pid, user_id}) end)
    end

    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Route registrations currently held (tests and diagnostics)."
  @spec size() :: non_neg_integer()
  def size do
    if :ets.whereis(table()) == :undefined, do: 0, else: :ets.info(table(), :size)
  end

  # -- The offline route hold (hardening plan 4.2) --------------------------
  #
  # A dropped-but-resumable session keeps its routes HERE, so the fan-out can
  # still ADDRESS it: `FanOut.buffer_offline/3` appends the event to the
  # disconnected record's resume buffer instead of dropping it on the floor.
  # Before this, a publication during the resume window reached nobody, stamped
  # no seq and consumed nothing — so `replay_complete?/2` was satisfied and the
  # client resumed believing it was current, with the events gone for good.
  #
  # Keyed by SESSION ID rather than pid: the socket that held these routes is
  # already gone when the hold is written (terminate/2), and a dead pid is
  # exactly what `subscribers/1` reclaims. Two tables, one per direction —
  # `held_routes/0` is read once per fan-out ROUTE (the hot direction) and
  # `held/0` answers release/replace by session id.
  #
  # Held rows are short-lived by construction: the resume path releases on
  # adoption and the expiry sweep releases when it deletes the record, so the
  # tables stay proportional to the sessions currently inside their resume
  # window — not to every session ever dropped.

  @doc """
  Keep `session_id` addressable under `routes` while it is disconnected.

  Replaces any previous hold (a second drop after a resume, or a re-hold with a
  narrower route set), so calling it twice is idempotent. Best-effort in the
  same spirit as the reverse index: without the owner the registry is already
  degraded, and raising here would turn a terminating socket's bookkeeping into
  a crash.
  """
  @spec hold_session(String.t(), [route_key()]) :: :ok
  def hold_session(session_id, []) when is_binary(session_id), do: :ok

  def hold_session(session_id, routes) when is_binary(session_id) and is_list(routes) do
    index_write(fn ->
      release_held(session_id)
      keys = Enum.uniq(routes)
      :ets.insert(held_routes(), Enum.map(keys, &{&1, session_id}))
      :ets.insert(held(), {session_id, keys})
    end)

    :ok
  end

  @doc """
  Session ids held for `route_key` — the offline half of `subscribers/1`: the
  sessions that WOULD be subscribed if their socket were still alive.
  """
  @spec held_sessions(route_key()) :: [String.t()]
  def held_sessions(route_key) do
    held_routes()
    |> :ets.lookup(route_key)
    |> Enum.map(&elem(&1, 1))
    |> Enum.uniq()
  rescue
    ArgumentError -> []
  end

  @doc "The routes `session_id` is currently held under, or `:error` when it holds none."
  @spec held_routes_of(String.t()) :: {:ok, [route_key()]} | :error
  def held_routes_of(session_id) when is_binary(session_id) do
    case :ets.lookup(held(), session_id) do
      [{^session_id, routes}] -> {:ok, routes}
      [] -> :error
    end
  rescue
    ArgumentError -> :error
  end

  @doc """
  Drop `session_id`'s hold: the session was adopted by a resume, its record was
  deleted or swept, or a fan-out found the record gone (a stale hold).
  """
  @spec release_held(String.t()) :: :ok
  def release_held(session_id) when is_binary(session_id) do
    case :ets.lookup(held(), session_id) do
      [{^session_id, routes}] ->
        :ets.delete(held(), session_id)
        Enum.each(routes, &:ets.delete_object(held_routes(), {&1, session_id}))

      [] ->
        :ok
    end

    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Sessions currently held for offline delivery (tests and diagnostics)."
  @spec held_count() :: non_neg_integer()
  def held_count do
    if :ets.whereis(held()) == :undefined, do: 0, else: :ets.info(held(), :size)
  end

  @doc "Sessions currently indexed (tests and diagnostics)."
  @spec indexed_sessions() :: non_neg_integer()
  def indexed_sessions do
    if :ets.whereis(sessions()) == :undefined, do: 0, else: :ets.info(sessions(), :size)
  end

  # -- the reverse index (hardening plan 5.4) ------------------------------
  #
  # `{pid, [{route_key, user_id}]}`: which routes a session holds, so releasing it
  # is proportional to its OWN registrations instead of to the node's. The pairs
  # (not just the keys) matter: `:ets.delete_object/2` needs the full row to be a
  # keyed delete, and looking the user id up in the bucket would put the scan back.

  @doc false
  def sessions, do: :"#{__MODULE__}.Sessions"

  @doc false
  def held, do: :"#{__MODULE__}.Held"

  @doc false
  def held_routes, do: :"#{__MODULE__}.HeldRoutes"

  defp index_add(pid, pairs) do
    index_put(pid, Enum.uniq((index_pairs(pid) || []) ++ pairs))
  end

  defp index_remove(pid, keys) do
    remaining = Enum.reject(index_pairs(pid) || [], fn {key, _user} -> key in keys end)

    case remaining do
      [] -> index_write(fn -> :ets.delete(sessions(), pid) end)
      pairs -> index_put(pid, pairs)
    end
  end

  defp index_put(pid, pairs), do: index_write(fn -> :ets.insert(sessions(), {pid, pairs}) end)

  # nil (not an empty list) is "no index entry", so an empty registration set is
  # never confused with a missing index.
  defp index_pairs(pid) do
    case :ets.lookup(sessions(), pid) do
      [{^pid, pairs}] -> pairs
      [] -> nil
    end
  rescue
    # The owner is not running (a hermetic test boot): behave as unindexed, which
    # every caller answers correctly through its scan fallback.
    ArgumentError -> nil
  end

  # Best-effort in the same spirit: without the owner the registry is already
  # degraded to scan-only, and a raise here would turn a degraded read into a crash.
  defp index_write(fun) do
    fun.()
  rescue
    ArgumentError -> :ok
  end

  # -- GenServer -----------------------------------------------------------

  @impl true
  def init(:ok) do
    :ets.new(table(), [:bag, :named_table, :public])
    :ets.new(sessions(), [:set, :named_table, :public, read_concurrency: true])
    # Held routes are read by every fan-out; the bag's duplicate_bag lets one
    # lookup answer a route without a scan (see `hold_session/2`).
    :ets.new(held_routes(), [:duplicate_bag, :named_table, :public, read_concurrency: true])
    :ets.new(held(), [:set, :named_table, :public, read_concurrency: true])
    {:ok, %{}}
  end

  defp table, do: __MODULE__
end
