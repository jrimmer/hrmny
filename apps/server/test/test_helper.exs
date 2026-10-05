# Boot the Xandra pool and reset the test keyspace ONCE, before any module
# runs. This is the single schema-reset point: per-module drop/reapply in
# ScyllaCase raced concurrent modules (max_cases 8) and deleted the shared
# keyspace out from under each other. The keyspace persists for the whole
# run; ScyllaCase self-heals drift via verify! and fixtures isolate via
# unique identifiers.
{:ok, _} = Finch.start_link(name: CytaleTest.Finch)

# ScyllaCase TRUNCATES every table in the test keyspace. A run pointed at a
# shared node (scripts/scylla-tunnel.sh) must never be able to name the
# deployed app's keyspace.
if Cytale.Repo.keyspace() == "cytale" do
  raise "refusing to run the suite against keyspace `cytale` (live data) — set a one-off CYTALE_TEST_KEYSPACE"
end

# ----- No-database mode -------------------------------------------------------
# A full ScyllaDB is heavy, and a lot of this suite never touches it. When no
# node answers on the configured contact point (or CYTALE_TEST_NO_DB=1 forces
# it), the run EXCLUDES every test tagged `:scylla` — which ScyllaCase and
# GatewayCase apply to their whole module — and skips the pool boot below. The
# run says so loudly: a green no-DB run is a PARTIAL run, never a full one.
# A module that reaches the database without either case must tag itself
# `@moduletag :scylla`.
scylla_reachable? = fn ->
  Cytale.Config.scylla_nodes()
  |> Enum.any?(fn node ->
    {host, port} =
      case String.split(to_string(node), ":") do
        [h, p] -> {h, String.to_integer(p)}
        [h] -> {h, 9042}
      end

    case :gen_tcp.connect(String.to_charlist(host), port, [:binary, active: false], 1_500) do
      {:ok, socket} ->
        :gen_tcp.close(socket)
        true

      {:error, _} ->
        false
    end
  end)
end

no_db? = System.get_env("CYTALE_TEST_NO_DB") == "1" or not scylla_reachable?.()

if no_db? do
  ExUnit.configure(exclude: [:scylla])

  IO.puts(:stderr, """

  ==============================================================================
   NO-DATABASE RUN — tests tagged :scylla are EXCLUDED (see "excluded" below).
   No ScyllaDB at #{inspect(Enum.map(Cytale.Config.scylla_nodes(), &to_string/1))}#{if System.get_env("CYTALE_TEST_NO_DB") == "1", do: " (forced by CYTALE_TEST_NO_DB=1)", else: ""}.
   This is a PARTIAL run. Point CYTALE_SCYLLA_NODES at a node for the full suite.
  ==============================================================================
  """)
end

unless no_db? do
  Application.ensure_all_started(:xandra)
  {:ok, _} = Cytale.Repo.start_link([])

  defmodule Cytale.TestHelper do
    def wait_connected(0), do: :ok

    def wait_connected(t) do
      if Cytale.Repo.connected?(),
        do: :ok,
        else:
          (
            Process.sleep(200)
            wait_connected(t - 200)
          )
    end

    # Schema reset (DROP + re-apply) is a raft schema round-trip; on a bounded
    # dev node (or through a tunnel) the drop/recreate of the SAME keyspace name
    # can stall past the driver timeout while the raft group settles — and on a
    # wedged group no client retry helps. So the reset is OPT-IN: the keyspace
    # persists for the whole run (and across runs) and ScyllaCase self-heals
    # drift via verify!; fixtures isolate via unique identifiers. Force a clean
    # slate with CYTALE_RESET_SCHEMA=1 when the schema itself changes.
    def reset_keyspace(attempts \\ 5) do
      try do
        Cytale.Repo.execute!("DROP KEYSPACE IF EXISTS cytale_test", [], timeout: 60_000)
        :ok = Cytale.Migrations.apply!()
        :ok
      rescue
        e in [Xandra.Error, Xandra.ConnectionError] ->
          if attempts <= 1, do: raise(e)

          IO.puts(:stderr, "keyspace reset stalled (#{Exception.message(e)}) — retrying")
          Process.sleep(3_000)
          reset_keyspace(attempts - 1)
      end
    end
  end

  Cytale.TestHelper.wait_connected(30_000)

  if System.get_env("CYTALE_RESET_SCHEMA") == "1" do
    Cytale.TestHelper.reset_keyspace()
  else
    # Ensure the keyspace + schema exist (idempotent, IF NOT EXISTS) without
    # the fragile drop/recreate cycle.
    :ok = Cytale.Migrations.apply!()
  end

  # Namespaced runs clean up after themselves.
  #
  # The concurrent-agent convention (AGENTS.md) gives each run its own throwaway
  # keyspace name, but nothing ever dropped them: 76 accumulated into the schema,
  # and since ScyllaDB loads EVERY keyspace's metadata at boot, startup stretched
  # to 4-8 minutes and then died outright with `std::bad_alloc` in
  # `tables_metadata::parallel_for_each_table` (2026-09-11). The node could not
  # boot at all afterwards.
  #
  # The DEFAULT `cytale_test` still persists across runs by design — reapplying
  # the schema to it is a no-op, and the drop/recreate cycle is the expensive
  # path the reset comment above describes. Only one-off names are dropped, and
  # `after_suite` runs while the pool is still alive (an at_exit hook can fire
  # after the supervision tree is gone). A hard kill skips this entirely —
  # `scripts/scylla-reset.sh` is the backstop for that.
  test_keyspace = Cytale.Repo.keyspace()

  if test_keyspace != "cytale_test" and Regex.match?(~r/^[a-z][a-z0-9_]*$/, test_keyspace) do
    ExUnit.after_suite(fn _result ->
      try do
        Cytale.Repo.execute!("DROP KEYSPACE IF EXISTS #{test_keyspace}", [], timeout: 60_000)
        IO.puts("\ndropped namespaced test keyspace #{test_keyspace}")
      rescue
        e ->
          IO.puts(:stderr, "\ncould not drop test keyspace #{test_keyspace}: #{Exception.message(e)}")
      end
    end)
  end
end
