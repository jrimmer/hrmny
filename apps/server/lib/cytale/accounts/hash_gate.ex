defmodule Cytale.Accounts.HashGate do
  @moduledoc """
  A concurrency gate for Argon2 work (Tier 3 B, finding 8).

  Each argon2id hash or verify allocates its full memory cost (tens of MB with
  the pinned OWASP parameters) for the length of the computation. With no
  bound, a burst of logins, registrations or password resets multiplies that
  by the burst size — enough to OOM a 1 GB container. The gate admits at most
  `Cytale.Config.argon2_max_concurrency/0` computations at once (default 4);
  a caller over the limit waits up to `Cytale.Config.argon2_queue_ms/0`
  (default 2 s) for a slot and then gets `Cytale.Accounts.HashGate.Busy`,
  which the router's error handler renders as `503` + `Retry-After`.

  The count is one `:counters` cell (atomic add/sub, no process in the path),
  created once on first use (under a node-local lock) and kept in
  `:persistent_term`. Admission is
  add-then-check: a caller that pushes the count past the limit backs its
  increment out and retries, so the limit is never exceeded.
  """

  defmodule Busy do
    @moduledoc "Raised when no Argon2 slot frees up within the queue window."
    defexception message: "password hashing is at capacity; retry shortly", plug_status: 503
  end

  @key {__MODULE__, :counter}
  @poll_ms 10

  @doc "Run `fun` holding one Argon2 slot; raises `Busy` when none frees in time."
  @spec run((-> result)) :: result when result: term()
  def run(fun) when is_function(fun, 0) do
    ref = counter()
    deadline = System.monotonic_time(:millisecond) + Cytale.Config.argon2_queue_ms()
    acquire!(ref, Cytale.Config.argon2_max_concurrency(), deadline)

    try do
      fun.()
    after
      :counters.sub(ref, 1, 1)
    end
  end

  @doc "Slots currently held (diagnostics and tests)."
  @spec in_use() :: non_neg_integer()
  def in_use, do: :counters.get(counter(), 1)

  defp acquire!(ref, max, deadline) do
    :counters.add(ref, 1, 1)

    if :counters.get(ref, 1) <= max do
      :ok
    else
      :counters.sub(ref, 1, 1)

      if System.monotonic_time(:millisecond) >= deadline do
        :telemetry.execute([:cytale, :accounts, :argon2_busy], %{count: 1}, %{})
        raise Busy
      else
        Process.sleep(@poll_ms)
        acquire!(ref, max, deadline)
      end
    end
  end

  # The cell is created ONCE, under a node-local lock: two first callers must
  # not each create (and count on) a cell of their own. After that it is a
  # plain `:persistent_term` read.
  defp counter do
    case :persistent_term.get(@key, nil) do
      nil -> :global.trans({@key, self()}, &create_counter/0, [node()])
      ref -> ref
    end
  end

  defp create_counter do
    case :persistent_term.get(@key, nil) do
      nil ->
        ref = :counters.new(1, [:atomics])
        :persistent_term.put(@key, ref)
        ref

      ref ->
        ref
    end
  end
end
