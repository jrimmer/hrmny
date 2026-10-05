defmodule Cytale.Permissions.Cache do
  @moduledoc """
  Versioned permission cache (U7) — ETS-backed, keyed on
  `{user_id, channel_id}` with the computing `role_version` carried in the
  entry.

  Invalidation is LAZY (plan requirement): a workspace `role_version` bump
  never walks the table rewriting entries. Instead:

    * `get_or_compute/5` compares the entry's version against the caller's —
      any mismatch (bump OR stale read) recomputes and overwrites;
    * orphaned entries stay until `sweep/2` drops everything below a version
      floor (invoke opportunistically, e.g. after a bump or on a timer).

  This is what makes AE4 work: a permission change bumps the workspace's
  `role_version`, and the very next permission check for any member
  recomputes — no re-login, no O(users × channels) fan-out writes.

  ## STATE: WIRED (send-path latency, review #19)

  7.10 deleted the workspace process's unused `perm_cache` field and left this
  module as the U7 seam. It is now the live memo behind
  `Cytale.Permissions.Principal.resolve_cached/3` — the resolve every REST
  permission gate (`CytaleWeb.Plugs.RequirePermitted`, the compat
  `Authorize.channel_gate/2`) ran per request, 4–5 reads each time.

    * The table is `Cytale.Permissions.RightsEpoch`'s: the epoch owner creates
      it in its own `init/1`, so the memo can never outlive the epochs it is
      versioned by (an epoch owner that restarted counts from 0 again and
      could re-match an entry stored at a recycled epoch value — dying
      together is what rules that out).
    * The version is the workspace's `RightsEpoch.current/1`, READ BEFORE the
      compute. A mutation writes its rows and THEN bumps, so an entry computed
      from pre-mutation rows is stored under the pre-bump epoch and misses
      from the bump onward; one computed from post-mutation rows is merely an
      early refresh. No window serves stale bits past a bump.
    * Every entry also carries a short TTL (`get_or_compute/6`): a safety net
      for a mutation path that forgot its bump, never the invalidation
      mechanism itself.
  """

  @typedoc "The cache handle: a named table's atom, or an anonymous table's ref."
  @type t :: atom() | :ets.tid()

  @typedoc "Cache key: the member and channel the permission was resolved for."
  @type key :: {term(), term()}

  @doc "Create (or reuse) the cache table. `:named_table` + :public for direct ETS access."
  @spec new(atom()) :: t()
  def new(name) when is_atom(name) do
    if :ets.whereis(name) == :undefined do
      :ets.new(name, [:set, :named_table, :public, read_concurrency: true])
    end

    name
  end

  @doc "Drop the table (tests)."
  @spec teardown(t()) :: true
  def teardown(name) do
    case :ets.whereis(name) do
      :undefined -> true
      _ref -> :ets.delete(name)
    end
  end

  @doc """
  Value of `key` computed at `role_version`, or `fun/0`'s result when absent
  or stale. `fun` runs at most once per stale read; its result is stored with
  the version that requested it.
  """
  @spec get_or_compute(t(), term(), term(), integer(), (-> term())) :: term()
  def get_or_compute(cache, user_id, channel_id, role_version, fun),
    do: get_or_compute(cache, user_id, channel_id, role_version, fun, [])

  @doc """
  `get_or_compute/5` with options:

    * `:ttl_ms` — an entry older than this is a miss even at the right
      version (default: no expiry);
    * `:store?` — a predicate over the computed value; `false` returns the
      value WITHOUT caching it (the resolver does not memoize an unknown
      workspace, say). Default: cache everything.
  """
  @spec get_or_compute(t(), term(), term(), integer(), (-> term()), keyword()) :: term()
  def get_or_compute(cache, user_id, channel_id, role_version, fun, opts)
      when (is_atom(cache) or is_reference(cache)) and is_integer(role_version) do
    key = {user_id, channel_id}
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(cache, key) do
      [{^key, ^role_version, value, expires_at}] when expires_at == :infinity or expires_at > now ->
        # exact-version, unexpired hit
        value

      _stale_or_missing ->
        value = fun.()

        if Keyword.get(opts, :store?, fn _ -> true end).(value) do
          expires_at =
            case Keyword.get(opts, :ttl_ms) do
              nil -> :infinity
              ttl when is_integer(ttl) -> now + ttl
            end

          true = :ets.insert(cache, {key, role_version, value, expires_at})
        end

        value
    end
  end

  @doc """
  Store `value` for `{user_id, channel_id}` at `role_version` unconditionally
  (a caller that recomputed on purpose — a forced refresh — shares its answer).
  """
  @spec put(t(), term(), term(), integer(), term(), keyword()) :: :ok
  def put(cache, user_id, channel_id, role_version, value, opts \\ []) when is_integer(role_version) do
    expires_at =
      case Keyword.get(opts, :ttl_ms) do
        nil -> :infinity
        ttl when is_integer(ttl) -> System.monotonic_time(:millisecond) + ttl
      end

    true = :ets.insert(cache, {{user_id, channel_id}, role_version, value, expires_at})
    :ok
  end

  @doc "Number of live entries (orphaned ones included — they cost memory, never correctness)."
  @spec size(t()) :: non_neg_integer()
  def size(cache), do: :ets.info(cache, :size) || 0

  @doc """
  Drop every entry whose role_version is BELOW `floor` (post-bump janitor —
  optional; correctness never depends on it running). PERF-10 gives it its
  first caller: the workspace process sweeps on `RightsEpoch` bumps — O(table)
  per call, but only on rights mutations, which are rare.
  """
  @spec sweep(t(), integer()) :: :ok
  def sweep(cache, floor) when is_integer(floor) do
    :ets.select_delete(cache, [
      {{:"$1", :"$2", :"$3", :_}, [{:<, :"$2", floor}], [true]}
    ])

    :ok
  end
end
