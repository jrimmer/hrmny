defmodule Cytale.RepoRetryTest do
  @moduledoc """
  Hardening R-7 — the read-retry policy inside `Cytale.Repo.execute/3` /
  `execute!/3` / `query/3`.

  Pure and database-free by design: `Repo.with_read_retry/2` takes the
  executor as a function, so the loop's CONTRACT is pinned with a fake —
  only reads retry, only transient reasons retry, only the configured budget
  of retries runs, and the backoff is linear. No test here needs a live
  ScyllaDB (the same reasoning `CytaleWeb.ErrorHandler` records for its pure
  classifier).
  """

  use ExUnit.Case, async: false

  alias Cytale.Repo

  setup do
    # The Config accessor reads app env; save and restore whatever is there so
    # a stubbed retry budget never leaks into another module.
    original = Application.get_env(:cytale, Cytale.Config)

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:cytale, Cytale.Config)
      else
        Application.put_env(:cytale, Cytale.Config, original)
      end
    end)

    :ok
  end

  defp set_retries(n) do
    base = Application.get_env(:cytale, Cytale.Config) || []
    Application.put_env(:cytale, Cytale.Config, Keyword.put(base, :repo_read_retries, n))
  end

  # A counting executor: fails with `{:error, error}` (the executor contract
  # Xandra's `execute/4` honours) for the first `failures` calls, then returns
  # `{:ok, :page}`. Runs in the caller's process (the real
  # executor does too — the retry loop is synchronous by design).
  defp flaky_executor(failures, error) do
    {:ok, counter} = Agent.start_link(fn -> 0 end)

    executor = fn ->
      calls = Agent.get_and_update(counter, fn n -> {n + 1, n + 1} end)

      if calls <= failures do
        {:error, error}
      else
        {:ok, :page}
      end
    end

    {executor, counter}
  end

  defp always_failing_executor(error) do
    {:ok, counter} = Agent.start_link(fn -> 0 end)

    executor = fn ->
      Agent.update(counter, &(&1 + 1))
      {:error, error}
    end

    {executor, counter}
  end

  defp calls(counter), do: Agent.get(counter, & &1)

  describe "with_read_retry/2 — what retries" do
    test "a SELECT that fails transiently is retried, then succeeds" do
      set_retries(2)

      {executor, counter} =
        flaky_executor(2, %Xandra.Error{reason: :read_timeout, message: "injected"})

      assert {:ok, :page} = Repo.with_read_retry("SELECT message_id FROM t WHERE k = ?", executor)
      # Budget 2 retries: 1 + 2 = 3 executions.
      assert calls(counter) == 3
    end

    test "every transient %Xandra.Error reason in the set retries" do
      set_retries(2)

      for reason <- [:read_timeout, :unavailable, :overloaded, :server_error] do
        {executor, counter} = flaky_executor(1, %Xandra.Error{reason: reason, message: "injected"})

        assert {:ok, :page} = Repo.with_read_retry("SELECT 1", executor)
        assert calls(counter) == 2, "#{inspect(reason)} must retry"
      end
    end

    test "ANY %Xandra.ConnectionError retries (the cluster re-routes)" do
      set_retries(2)

      {executor, counter} =
        flaky_executor(1, %Xandra.ConnectionError{action: "checkout", reason: :closed})

      assert {:ok, :page} = Repo.with_read_retry("SELECT 1", executor)
      assert calls(counter) == 2
    end

    test "the read detection is on the TRIMMED, UPCASED statement text" do
      set_retries(2)

      {executor, counter} =
        flaky_executor(1, %Xandra.Error{reason: :read_timeout, message: "injected"})

      assert {:ok, :page} = Repo.with_read_retry("  select 1", executor)
      assert calls(counter) == 2
    end
  end

  describe "with_read_retry/2 — what never retries" do
    test "a write (non-SELECT) is attempted exactly once, even on a transient-shaped failure" do
      {executor, counter} =
        always_failing_executor(%Xandra.Error{reason: :server_error, message: "injected"})

      assert {:error, %Xandra.Error{reason: :server_error}} =
               Repo.with_read_retry("INSERT INTO t (k) VALUES (?)", executor)

      assert calls(counter) == 1
    end

    test "a non-transient Xandra.Error reason is returned untouched" do
      {executor, counter} =
        always_failing_executor(%Xandra.Error{reason: :invalid, message: "injected"})

      assert {:error, %Xandra.Error{reason: :invalid}} =
               Repo.with_read_retry("SELECT 1", executor)

      assert calls(counter) == 1
    end

    test "repo_read_retries: 0 disables the retry" do
      set_retries(0)

      {executor, counter} =
        always_failing_executor(%Xandra.Error{reason: :read_timeout, message: "injected"})

      assert {:error, %Xandra.Error{reason: :read_timeout}} =
               Repo.with_read_retry("SELECT 1", executor)

      assert calls(counter) == 1
    end

    test "the budget is injectable through Cytale.Config" do
      set_retries(1)

      {executor, counter} =
        flaky_executor(1, %Xandra.Error{reason: :unavailable, message: "injected"})

      assert {:ok, :page} = Repo.with_read_retry("SELECT 1", executor)
      assert calls(counter) == 2
    end
  end

  describe "with_read_retry/2 — exhaustion and backoff" do
    test "exhausting the budget returns the LAST error after 1 + retries executions" do
      set_retries(2)

      {executor, counter} =
        always_failing_executor(%Xandra.Error{reason: :read_timeout, message: "injected"})

      start = System.monotonic_time(:millisecond)

      assert {:error, %Xandra.Error{reason: :read_timeout}} =
               Repo.with_read_retry("SELECT 1", executor)

      elapsed = System.monotonic_time(:millisecond) - start

      assert calls(counter) == 3

      # Linear backoff: retry 1 sleeps 50ms, retry 2 sleeps 100ms. Loose lower
      # bound — scheduling jitter may pad it, never shrink it.
      assert elapsed >= 150
    end
  end
end
