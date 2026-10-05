defmodule Cytale.ApplicationTest do
  use ExUnit.Case, async: false

  describe "supervision tree" do
    test "application starts with an intact supervision tree" do
      assert Process.whereis(Cytale.Supervisor) |> is_pid()
      assert Cytale.Supervisor |> Supervisor.which_children() |> is_list()
    end

    # A5: the rate-limit ETS tables must be owned by the LONG-LIVED
    # CytaleWeb.Compat.RateTables GenServer (app tree) — they were formerly
    # lazily created by whichever Bandit connection process hit them first,
    # dying (and resetting every bucket) when that process recycled.
    #
    # #90 extended this to the NATIVE plug's table, which was still created on
    # first use by a request process: per-account budgets and per-IP ceilings
    # reset with that process (or its keep-alive connection), so a 429 fired
    # only by accident of connection reuse.
    test "rate-limit tables are owned by the long-lived RateTables owner, not request processes" do
      owner = Process.whereis(CytaleWeb.Compat.RateTables)
      assert owner |> is_pid()

      for table <-
            [
              CytaleWeb.Compat.RateTables.compat_table(),
              CytaleWeb.Compat.RateTables.webhook_table(),
              CytaleWeb.Compat.RateTables.preauth_table(),
              CytaleWeb.Compat.RateTables.native_table()
            ] do
        assert :ets.whereis(table) != :undefined, "expected #{inspect(table)} to exist"
        assert :ets.info(table, :owner) == owner
        # The owner is NOT the calling (request-stand-in) process.
        refute :ets.info(table, :owner) == self()
      end

      # A request process only READS/WRITES the public table (no create).
      table = CytaleWeb.Compat.RateTables.compat_table()

      {count, _window_end} =
        CytaleWeb.Compat.RateLimit.consume(table, {:owner_probe, self()}, 5, 10_000, System.system_time(:millisecond))

      assert count == 1
      true = :ets.delete(table, {:owner_probe, self()})
      assert :ets.info(table, :owner) == owner
    end

    # A6: the account-deletion sweep runs as a supervised task.
    test "the deletion sweep supervisor is a supervised child of the app tree" do
      children = Supervisor.which_children(Cytale.Supervisor)

      assert {Cytale.Accounts.Deletion.SweepSupervisor, pid, :supervisor, _} =
               List.keyfind(children, Cytale.Accounts.Deletion.SweepSupervisor, 0)

      assert Process.alive?(pid)
    end

    test "supervision tree contains registry, dynamic supervisor and endpoint, all alive" do
      children = Supervisor.which_children(Cytale.Supervisor)
      names = Enum.map(children, fn {id, _pid, _type, _mods} -> id end)

      # Required children present (U10 legitimately adds gateway services to
      # the tree: SessionStore, AdmissionLimiter, PushRegistry) — superset
      # assertion, not exact equality.
      required = [Cytale.WorkspaceRegistry, Cytale.WorkspaceSupervisor, CytaleWeb.Endpoint]

      assert Enum.all?(required, &(&1 in names)),
             "expected required children in tree, got: #{inspect(names)}"

      for {id, pid, :worker, _} <- children do
        assert Process.alive?(pid), "expected #{inspect(id)} to be alive"
      end

      # Liveness proxy for the registry itself (no per-registry :id meta exists).
      assert Process.alive?(Process.whereis(Cytale.WorkspaceRegistry))
    end

    test "WorkspaceRegistry and WorkspaceSupervisor are available by name" do
      assert Process.whereis(Cytale.WorkspaceRegistry) |> is_pid()
      assert Process.whereis(Cytale.WorkspaceSupervisor) |> is_pid()

      # DynamicSupervisor accepts children on demand.
      {:ok, task} =
        DynamicSupervisor.start_child(Cytale.WorkspaceSupervisor, %{
          id: {:test_probe, System.unique_integer()},
          start: {Task, :start_link, [fn -> Process.sleep(:infinity) end]},
          restart: :temporary
        })

      assert Process.alive?(task)

      # Unique-key registration and lookup round-trip.
      assert {:ok, owner} = Registry.register(Cytale.WorkspaceRegistry, :test_key, :sentinel)
      assert is_pid(owner)

      assert [{key_owner, :sentinel}] = Registry.lookup(Cytale.WorkspaceRegistry, :test_key)
      assert is_pid(key_owner)
    end
  end

  describe "endpoint / health check" do
    # The shared CytaleTest.Finch pool outlives the endpoint-crash test: its
    # connections die with the listener, and the next pooled request returns
    # {:error, :closed} (observed ~1-in-4 full-suite runs). Idempotent GETs —
    # retry a stale-connection failure once.
    defp get!(path, port) do
      req = Finch.build(:get, "http://127.0.0.1:#{port}#{path}")

      case Finch.request(req, CytaleTest.Finch) do
        {:error, %Finch.TransportError{reason: :closed}} ->
          Process.sleep(50)
          Finch.request(Finch.build(:get, "http://127.0.0.1:#{port}#{path}"), CytaleTest.Finch)

        result ->
          result
      end
    end

    test "GET /health responds 200 over HTTP with JSON status payload" do
      port = endpoint_port()

      assert {:ok, %Finch.Response{status: 200}} = get!("/health", port)

      assert {:ok, %Finch.Response{status: 200, body: body}} = get!("/health?probe=live", port)
      assert %{"status" => "ok"} = Jason.decode!(body)
    end

    test "unknown routes produce a well-formed error envelope" do
      port = endpoint_port()

      assert {:ok, %Finch.Response{status: 404}} = get!("/api/v1/does-not-exist", port)
    end

    test "endpoint recovers after a crash (supervision restarts it)" do
      port = endpoint_port()
      old_endpoint = Process.whereis(CytaleWeb.Endpoint)

      # Every process of the OLD instance — the listener, its acceptors, the
      # open connection handlers, the config table's owner. A :kill reaches
      # the supervisor alone; its children die by link signal, one by one,
      # AFTER the supervisor's own DOWN. Until the last of them is gone, the
      # old listener can still accept and answer: a probe it answered 200
      # (while its config table still stood) declared "recovered" while the
      # restart had barely begun, and the NEXT test's request met the dying
      # handler — `:ets.lookup(CytaleWeb.Endpoint, …)` raising on a table that
      # was already gone, which Bandit answers `500, connection: close` — or
      # nothing listening at all (:econnrefused). CI red twice, 2026-10.
      old_tree = Enum.map(process_tree(old_endpoint), &{&1, Process.monitor(&1)})

      # Hard-kill: supervisors trap exits, so only :kill (untrappable) takes
      # the endpoint down; the root :one_for_one then restarts it.
      Process.exit(old_endpoint, :kill)

      for {pid, ref} <- old_tree do
        assert_receive {:DOWN, ^ref, :process, ^pid, _reason}, 10_000
      end

      # Recovery is polled over HTTP with a deadline that COVERS THE WHOLE
      # RESTART (under load the Bandit rebind has raced a 30s budget), and
      # :econnrefused during the rebind is "not yet", never fatal. With the
      # old instance fully gone, only the NEW one can answer this probe.
      recovered = wait_until(30_000, fn -> health_ok?(port) end)
      assert recovered, "endpoint did not recover after crash"
      assert Process.whereis(CytaleWeb.Endpoint) not in [nil, old_endpoint]
    end

    test "an endpoint (re)start waits out a port still held by the old listener, and the app stays up" do
      # The deterministic form of the CI collapse (runs 2752 and a two-suite
      # reproduction): a restart that meets `:eaddrinuse` used to fail at once,
      # and a burst of such failures spent the root restart budget and shut the
      # whole application down. Hold the port ourselves for 300 ms across a
      # restart: the start must wait for it rather than fail.
      port = endpoint_port()
      :ok = Supervisor.terminate_child(Cytale.Supervisor, CytaleWeb.Endpoint)

      # Whatever happens below, the shared endpoint is running again before the
      # next test — a failure here must not cascade into every later request.
      on_exit(fn -> Supervisor.restart_child(Cytale.Supervisor, CytaleWeb.Endpoint) end)

      # The stopped listener can itself hold the port for a moment (the very
      # race under test), so take the port with the same patience.
      holder = listen_when_free(port, 5_000)
      releaser = Task.async(fn -> Process.sleep(300) && :gen_tcp.close(holder) end)
      # The listen socket is owned by this process; hand it to the releaser so
      # closing it from there is legal.
      :ok = :gen_tcp.controlling_process(holder, releaser.pid)

      started_at = System.monotonic_time(:millisecond)
      assert {:ok, _pid} = Supervisor.restart_child(Cytale.Supervisor, CytaleWeb.Endpoint)
      assert System.monotonic_time(:millisecond) - started_at >= 250, "the bind was not actually contended"
      Task.await(releaser)

      assert Process.whereis(Cytale.Supervisor) |> is_pid()
      assert wait_until(10_000, fn -> health_ok?(port) end), "endpoint did not serve after the contended restart"
    end
  end

  describe "runtime config surface" do
    test "resume window constants are honored (5min target, 10min floor)" do
      assert Cytale.Config.resume_window_target_ms() == 5 * 60 * 1000
      assert Cytale.Config.resume_window_floor_ms() == 10 * 60 * 1000
    end

    test "auth token TTLs are exposed (15min access, 30d refresh)" do
      assert Cytale.Config.access_token_ttl_ms() == 15 * 60 * 1000
      assert Cytale.Config.refresh_token_ttl_ms() == 30 * 24 * 60 * 60 * 1000
    end

    test "search commit interval defaults to 500ms inside the clamp range" do
      interval = Cytale.Config.search_commit_interval_ms()
      assert interval == 500
      assert interval in 100..2000
    end

    test "scylla connection config carries LOCAL_QUORUM default consistency" do
      assert Cytale.Config.scylla_default_consistency() == :local_quorum
      assert Cytale.Config.scylla_nodes() != []
      assert Cytale.Config.scylla_pool_size() >= 1
    end

    test "search index root points at priv/search" do
      assert String.contains?(Cytale.Config.search_index_root(), "priv/search")
    end

    test "snowflake worker id resolves into 0..1023 (single node defaults to 0)" do
      assert Cytale.Config.snowflake_worker_id() in 0..1023
    end

    test "fail-fast validation rejects out-of-range SNOWFLAKE_WORKER_ID (boot-time)" do
      env_key = "SNOWFLAKE_WORKER_ID"
      original = System.get_env(env_key)

      System.put_env(env_key, "4096")

      assert_raise ArgumentError, ~r/must be an integer between 0 and 1023/, fn ->
        CytaleRuntime.worker_id!()
      end

      System.put_env(env_key, "not-a-number")

      assert_raise ArgumentError, ~r/must be an integer/, fn ->
        CytaleRuntime.worker_id!()
      end

      restore_env(env_key, original)
    end

    test "fail-fast validation accepts worker id 0 (single-node launch default)" do
      env_key = "SNOWFLAKE_WORKER_ID"
      original = System.get_env(env_key)

      System.delete_env(env_key)
      assert CytaleRuntime.worker_id!() == 0

      restore_env(env_key, original)
    end

    test "fail-fast validation requires SECRET_KEY_BASE of >= 32 chars in prod" do
      original = System.get_env("SECRET_KEY_BASE")

      System.put_env("SECRET_KEY_BASE", "short")

      assert_raise ArgumentError, ~r/at least 32 characters/, fn ->
        CytaleRuntime.require_secret!("SECRET_KEY_BASE")
      end

      restore_env("SECRET_KEY_BASE", original)
    end
  end

  # ---- helpers ---------------------------------------------------------------

  defp listen_when_free(port, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    Stream.repeatedly(fn -> :gen_tcp.listen(port, [:binary, ip: {127, 0, 0, 1}, reuseaddr: true, active: false]) end)
    |> Enum.find_value(fn
      {:ok, socket} ->
        socket

      {:error, :eaddrinuse} ->
        if System.monotonic_time(:millisecond) > deadline, do: flunk("port #{port} never freed")
        Process.sleep(20)
        nil
    end)
  end

  # A supervisor and every process under it (workers and nested supervisors),
  # read top-down before anything is killed.
  defp process_tree(pid) when is_pid(pid) do
    children =
      try do
        Supervisor.which_children(pid)
      catch
        :exit, _ -> []
      end

    [
      pid
      | Enum.flat_map(children, fn
          {_id, child, :supervisor, _} when is_pid(child) -> process_tree(child)
          {_id, child, :worker, _} when is_pid(child) -> [child]
          _ -> []
        end)
    ]
  end

  defp endpoint_port do
    Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]
  end

  defp get_health(port) do
    Finch.request(Finch.build(:get, "http://127.0.0.1:#{port}/health"), CytaleTest.Finch)
  end

  # The recovery probe: 200 means recovered; ANY error (connection refused
  # during listener rebind, timeout under load, closed) means "not yet" —
  # the poll loop keeps trying until the deadline.
  defp health_ok?(port) do
    case get_health(port) do
      {:ok, %Finch.Response{status: 200}} -> true
      _ -> false
    end
  end

  defp wait_until(timeout, fun) do
    deadline = System.monotonic_time(:millisecond) + timeout
    repeat(fun, deadline)
  end

  defp repeat(fun, deadline) do
    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) >= deadline do
        false
      else
        Process.sleep(50)
        repeat(fun, deadline)
      end
    end
  end

  # Restore on EXIT, not at the end of the body: an assertion failing midway
  # left `SNOWFLAKE_WORKER_ID` set to whatever the test had put there, and a
  # later test in the same run that boots runtime.exs in a subprocess inherited
  # it — surfacing as an unrelated file's failure ("must be an integer (got:
  # \"not-a-number\")") with nothing pointing back here.
  defp restore_env(key, value) do
    on_exit(fn ->
      if value === nil do
        System.delete_env(key)
      else
        System.put_env(key, value)
      end
    end)

    :ok
  end
end
