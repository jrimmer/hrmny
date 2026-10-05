defmodule Cytale.Gateway.AuthorCache do
  @moduledoc """
  PERF-2 (B3b) — the per-socket author-resolution cache for compat dispatch
  translation: `author_id → {Discord author object, kind}` with a TTL and a
  size cap, so a socket translating a busy channel does ONE
  Principals/Users read per author per TTL instead of one read PER EVENT.

  Pure data transitions over a plain map (the gateway socket owns the map in
  its state; the clock is INJECTED — `now_ms` — so every rule here is
  deterministically unit-testable, mirroring `Cytale.Gateway.Session`):

    * **TTL** — an entry is served from the map until `now >= expires_at`,
      then the next fetch re-resolves through the injected resolver and
      re-caches (renames/label changes surface within one TTL, never
      requiring a reconnect);
    * **cap** — at `cap/0` distinct authors the map CLEARS before the new
      entry lands (clear-on-full: bounded memory, zero bookkeeping; a burst
      of >cap distinct authors in one TTL window simply re-resolves).

  The fallback contract: a miss resolves through the caller's resolver and
  caches EXACTLY what the resolver returned — output is byte-identical to
  resolving per event (`CytaleWeb.Compat.MessageCodec.resolve_author/1` is
  the production resolver).
  """

  @typedoc "A resolved author: the Discord user object plus its kind (for webhook_id)."
  @type entry :: {map(), atom()}

  @typedoc "author_id => {expires_at_ms, entry} — plain map, socket-owned."
  @type t :: %{optional(integer()) => {integer(), entry()}}

  @ttl_ms 30_000
  @cap 256

  @doc "Entry TTL (ms) — one read per author per socket per TTL."
  @spec ttl_ms :: pos_integer()
  def ttl_ms, do: @ttl_ms

  @doc "Distinct-author cap — the map clears on full before the next insert."
  @spec cap :: pos_integer()
  def cap, do: @cap

  @doc """
  Resolve `author_id` through `cache`: a fresh entry is served as-is; a miss
  or an expired entry resolves through `resolver`, re-caches with a fresh
  TTL, and returns `{updated_cache, entry}`. At `cap/0` distinct authors the
  cache clears before the insert (clear-on-full).
  """
  @spec resolve(t(), integer(), integer(), (integer() -> entry())) :: {t(), entry()}
  def resolve(cache, author_id, now_ms, resolver)
      when is_map(cache) and is_integer(author_id) and is_integer(now_ms) and is_function(resolver, 1) do
    case Map.fetch(cache, author_id) do
      {:ok, {expires_at, entry}} when now_ms < expires_at ->
        {cache, entry}

      _ ->
        entry = resolver.(author_id)

        cache =
          cache
          |> maybe_clear_on_full()
          |> Map.put(author_id, {now_ms + @ttl_ms, entry})

        {cache, entry}
    end
  end

  # At the cap the map resets rather than growing unbounded (clear-on-full:
  # zero LRU bookkeeping; the hot set re-warms within one TTL).
  defp maybe_clear_on_full(cache) when map_size(cache) >= @cap, do: %{}
  defp maybe_clear_on_full(cache), do: cache
end
