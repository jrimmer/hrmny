defmodule Cytale.Gateway.AuthorCacheTest do
  @moduledoc """
  PERF-2 (B3b) — the per-socket author-resolution cache: ONE resolver read
  per author per TTL (not per event), TTL expiry re-reads, and the cap
  clears on full. Pure map transitions with an INJECTED clock — the counting
  resolver stands in for `MessageCodec.resolve_author/1` (the production
  resolver's Principals/Users reads are exactly what the counters assert).
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.AuthorCache

  # A resolver that counts its reads (stands in for the codec's
  # Principals/User point reads).
  defp new_resolver do
    counter = :counters.new(1, [:write_concurrency])

    resolver =
      fn author_id ->
        :counters.add(counter, 1, 1)
        {%{"id" => Integer.to_string(author_id), "username" => "u#{author_id}"}, :human}
      end

    {counter, resolver}
  end

  defp reads(counter), do: :counters.get(counter, 1)

  test "two events from one author within the TTL → ONE resolver read" do
    {counter, resolver} = new_resolver()

    {cache, entry_a} = AuthorCache.resolve(%{}, 42, 1_000, resolver)
    {cache, entry_b} = AuthorCache.resolve(cache, 42, 1_000 + AuthorCache.ttl_ms() - 1, resolver)

    assert entry_a == entry_b
    assert entry_a == {%{"id" => "42", "username" => "u42"}, :human}

    # THE assertion: one read served two events.
    assert reads(counter) == 1
    assert map_size(cache) == 1
  end

  test "TTL expiry → re-read (a rename surfaces within one TTL)" do
    {counter, resolver} = new_resolver()

    {cache, _} = AuthorCache.resolve(%{}, 42, 1_000, resolver)

    # One ms past the expiry: the next fetch re-resolves and re-caches.
    {cache, _entry} = AuthorCache.resolve(cache, 42, 1_000 + AuthorCache.ttl_ms(), resolver)

    assert reads(counter) == 2
    assert map_size(cache) == 1
  end

  test "distinct authors resolve independently (one read each)" do
    {counter, resolver} = new_resolver()

    {cache, _} = AuthorCache.resolve(%{}, 1, 0, resolver)
    {cache, _} = AuthorCache.resolve(cache, 2, 0, resolver)
    {cache, _} = AuthorCache.resolve(cache, 1, 1, resolver)
    {cache, _} = AuthorCache.resolve(cache, 2, 1, resolver)

    assert reads(counter) == 2
    assert map_size(cache) == 2
  end

  test "at the cap the cache clears on full (bounded memory, hot set re-warms)" do
    {counter, resolver} = new_resolver()

    cache =
      Enum.reduce(1..AuthorCache.cap(), %{}, fn id, acc ->
        acc |> AuthorCache.resolve(id, 0, resolver) |> elem(0)
      end)

    assert map_size(cache) == AuthorCache.cap()

    # The FULL map resets to admit author cap+1 (clear-on-full).
    {cache, _} = AuthorCache.resolve(cache, AuthorCache.cap() + 1, 1, resolver)
    assert map_size(cache) == 1
    assert reads(counter) == AuthorCache.cap() + 1
  end

  test "a fresh entry serves right up to (but not including) its expiry" do
    {counter, resolver} = new_resolver()
    {cache, _} = AuthorCache.resolve(%{}, 7, 100, resolver)
    {^cache, _} = AuthorCache.resolve(cache, 7, 100 + AuthorCache.ttl_ms() - 1, resolver)
    assert reads(counter) == 1
  end
end
