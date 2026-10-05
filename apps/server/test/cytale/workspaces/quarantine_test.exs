defmodule Cytale.Workspaces.QuarantineTest do
  @moduledoc """
  Hardening plan 4.6 — one shared restart budget, per-subtree quarantine.

  The root supervisor's restart budget is SHARED, so before this change a
  crash-looping workspace spent the whole tree's budget on its own way to
  taking the endpoint and every other tenant down with it. The gate: a
  poison-pill workspace — one whose `handle_*` raises on a message the test can
  send it — burns only ITS OWN per-subtree restart budget, gets quarantined,
  and the root supervisor, the endpoint and every other workspace keep serving.

  The poison shape is deliberate and deterministic: `GenServer.call/3` with a
  request no `handle_call/3` clause matches raises `FunctionClauseError` inside
  the workspace process, which is exactly a crashing handler with no test hook
  in production code.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Publish
  alias Cytale.Workspaces.Registry
  alias Cytale.Workspaces.Supervisor

  # More poison casts than any sane per-subtree budget allows; the loop stops
  # early the moment quarantine is observed.
  @poison_attempts 200

  setup do
    # Same seam `workspace_test.exs` uses: wire the real workspace-process
    # publish impl for this module and restore on exit.
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:cytale, Cytale.Publish)
      else
        Application.put_env(:cytale, Cytale.Publish, original)
      end
    end)

    :ok
  end

  test "a poison-pill workspace is quarantined and the root tree keeps serving" do
    poison_ws = make_workspace("quarantine-poison")
    healthy_ws = make_workspace("quarantine-healthy")
    healthy_ch = make_channel(healthy_ws, "quarantine-healthy-ch")

    # The workspace that keeps serving has a live session BEFORE the poison
    # loop starts, so a root-tree death would take it with it.
    session = start_fake_session(healthy_ch, self())

    parent = self()
    handler_id = "quarantine-test-#{System.unique_integer([:positive])}"

    :telemetry.attach(
      handler_id,
      [:cytale, :workspace, :quarantined],
      fn event, measurements, metadata, _config ->
        send(parent, {:quarantine_event, event, measurements, metadata})
      end,
      nil
    )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    {:ok, poison_pid} = Supervisor.ensure_started(poison_ws)
    assert Registry.whereis(poison_ws) == poison_pid

    # Crash the poison workspace repeatedly. Each call raises inside the
    # workspace process; its own subtree supervisor restarts it until the
    # per-subtree budget is spent.
    log = capture_log(fn -> poison_workspace(poison_ws, @poison_attempts) end)

    # -- the quarantined workspace is stopped and reported ---------------------
    assert {:error, :quarantined} = Supervisor.ensure_started(poison_ws)
    assert Cytale.Workspaces.Quarantine.quarantined?(poison_ws)

    # Stop restarting THIS workspace: no live process, and none comes back.
    refute Registry.whereis(poison_ws)
    Process.sleep(50)
    refute Registry.whereis(poison_ws)

    assert [%{workspace_id: ^poison_ws, reason: :restart_intensity}] =
             Cytale.Workspaces.Quarantine.list()

    # Reported loudly, naming the workspace.
    assert log =~ "workspace #{poison_ws} QUARANTINED"

    assert_receive {:quarantine_event, [:cytale, :workspace, :quarantined], %{count: 1},
                    %{workspace_id: ^poison_ws, reason: :restart_intensity}},
                   5_000

    # -- the root tree, endpoint and healthy tenant survive --------------------
    assert Process.alive?(Process.whereis(Cytale.Supervisor))
    assert Process.alive?(Process.whereis(Cytale.WorkspaceSupervisor))
    assert Process.alive?(Process.whereis(CytaleWeb.Endpoint))
    assert Process.alive?(session)

    # The healthy workspace still delivers: publish through the real seam and
    # receive the fan-out on its live session.
    :ok = Publish.publish(healthy_ch, {"MessageCreate", wire(healthy_ch)})
    assert_receive {:fanout, {"MessageCreate", payload}}, 5_000
    assert payload["channel_id"] == Integer.to_string(healthy_ch)
  end

  # A Quarantine restart used to lose every monitor with its state, so a crash
  # loop that began AFTER the restart was still contained by its own subtree
  # budget but never reported or refused. `init/1` re-attaches to the subtrees
  # that are already running; this proves it end-to-end — restart the registry,
  # then drive a real crash loop and require the quarantine to be recorded.
  test "the registry re-attaches to live subtrees after a restart" do
    ws_id = make_workspace("quarantine-reattach")
    {:ok, _workspace_pid} = Supervisor.ensure_started(ws_id)

    # This test ends with the workspace quarantined, and the registry is
    # node-local: clear it so the sibling tests that assert on the whole list
    # (which used to see at most their own entry) keep meaning what they say.
    on_exit(fn -> Cytale.Workspaces.Quarantine.clear(ws_id) end)

    # Replace the registry exactly as a crash of it would: the root supervisor
    # terminates the child and starts a fresh one whose `init/1` must re-attach.
    # `Elixir.Supervisor` because this file aliases `Cytale.Workspaces.Supervisor`.
    assert :ok = Elixir.Supervisor.terminate_child(Cytale.Supervisor, Cytale.Workspaces.Quarantine)

    assert {:ok, _new_registry} =
             Elixir.Supervisor.restart_child(Cytale.Supervisor, Cytale.Workspaces.Quarantine)

    # Marks are node-local and reset with the registry (documented); the MONITORS
    # are what must be back.
    refute Cytale.Workspaces.Quarantine.quarantined?(ws_id)

    capture_log(fn -> poison_workspace(ws_id, @poison_attempts) end)

    assert Cytale.Workspaces.Quarantine.quarantined?(ws_id),
           "the restarted registry did not re-attach: the crash loop went unreported"

    assert [%{workspace_id: ^ws_id, reason: :restart_intensity}] =
             Cytale.Workspaces.Quarantine.list()
  end

  test "quarantine is releasable: clear/1 lets the workspace start again" do
    ws_id = make_workspace("quarantine-release")
    {:ok, _pid} = Supervisor.ensure_started(ws_id)

    capture_log(fn -> poison_workspace(ws_id, @poison_attempts) end)
    assert Cytale.Workspaces.Quarantine.quarantined?(ws_id)

    assert :ok = Cytale.Workspaces.Quarantine.clear(ws_id)
    refute Cytale.Workspaces.Quarantine.quarantined?(ws_id)

    # The dead subtree's spec is gone too (a `:transient` `:shutdown` child is
    # dropped), so a real, fresh process comes back.
    assert {:ok, pid} = Supervisor.ensure_started(ws_id)
    assert Process.alive?(pid)
    assert Registry.whereis(ws_id) == pid
  end

  # The race the quarantine record must not lose to. `ensure_started/1` can
  # legitimately start a FRESH subtree in the window between the crash-looping
  # subtree's death and `Quarantine` handling its DOWN — the workspace process
  # leaves the Registry (the thing `ensure_started/1` checks) before its subtree
  # supervisor finishes exiting. Recording quarantine from that stale DOWN would
  # refuse every later `ensure_started/1` for a workspace whose sessions are
  # live. Reproduced with a real monitor: `watch/2` the throwaway "old subtree"
  # pid, kill it with `:shutdown`, and assert the serving workspace is untouched.
  test "a stale subtree DOWN does not quarantine a workspace that is serving again" do
    ws_id = make_workspace("quarantine-stale-down")
    {:ok, live} = Supervisor.ensure_started(ws_id)
    assert Registry.whereis(ws_id) == live

    old_subtree = spawn(fn -> Process.sleep(:infinity) end)
    :ok = Cytale.Workspaces.Quarantine.watch(ws_id, old_subtree)

    ref = Process.monitor(old_subtree)
    Process.exit(old_subtree, :shutdown)
    assert_receive {:DOWN, ^ref, :process, ^old_subtree, :shutdown}, 5_000

    # `list/0` is a call, so it is ordered after the DOWN has been handled —
    # this asserts on the settled state, not on a race with the test itself.
    refute Enum.any?(Cytale.Workspaces.Quarantine.list(), &(&1.workspace_id == ws_id)),
           "the stale subtree DOWN quarantined a workspace that is serving again"

    refute Cytale.Workspaces.Quarantine.quarantined?(ws_id)

    # The live process is the one from before, and the gate still hands it back.
    assert Registry.whereis(ws_id) == live
    assert {:ok, ^live} = Supervisor.ensure_started(ws_id)
  end

  # -- helpers -----------------------------------------------------------------

  # Send an unmatched request straight at the live workspace process, every
  # time it comes back. `nil` windows are the restart gap; a tiny sleep lets
  # the supervisor process the exit. Stops early once quarantine is visible
  # (`Quarantine.list/0` is a call, so it is ordered after the quarantine log
  # and telemetry).
  defp poison_workspace(ws_id, attempts) do
    Enum.reduce_while(1..attempts, :ok, fn _, _acc ->
      if Enum.any?(Cytale.Workspaces.Quarantine.list(), &(&1.workspace_id == ws_id)) do
        {:halt, :quarantined}
      else
        case Registry.whereis(ws_id) do
          pid when is_pid(pid) ->
            try do
              GenServer.call(pid, :__poison_pill__, 1_000)
            catch
              :exit, _reason -> :ok
            end

          nil ->
            Process.sleep(2)
        end

        {:cont, :ok}
      end
    end)
  end

  defp make_workspace(name) do
    ws_id = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces (workspace_id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
      [{"bigint", ws_id}, {"text", name}, {"bigint", Cytale.Snowflake.next()}, {"timestamp", now}]
    )

    ws_id
  end

  defp make_channel(ws_id, name) do
    ch_id = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.channels (workspace_id, channel_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", ws_id},
        {"bigint", ch_id},
        {"text", name},
        {"int", 0},
        {"bigint", nil},
        {"text", nil},
        {"int", 0},
        {"bigint", ws_id},
        {"timestamp", now},
        {"bigint", nil}
      ]
    )

    # channels_by_id is the publish-resolution table (there is no MV link).
    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.channels_by_id (channel_id, workspace_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", ch_id},
        {"bigint", ws_id},
        {"text", name},
        {"int", 0},
        {"bigint", nil},
        {"text", nil},
        {"int", 0},
        {"bigint", ws_id},
        {"timestamp", now},
        {"bigint", nil}
      ]
    )

    ch_id
  end

  # A fake gateway socket process: registers on the channel route and forwards
  # fan-out deliveries to the test process.
  defp start_fake_session(channel_id, test_pid) do
    parent = self()

    {:ok, pid} =
      Task.start_link(fn ->
        PushRegistry.subscribe(PushRegistry.channel_key(Integer.to_string(channel_id)), "111", self(), [])

        send(parent, :session_ready)
        loop(test_pid)
      end)

    assert_receive :session_ready, 5_000
    pid
  end

  defp loop(test_pid) do
    receive do
      {:cytale_gateway_push, _from, event, _fragment} ->
        send(test_pid, {:fanout, event})
        loop(test_pid)

      {:cytale_gateway_push, _from, event} ->
        send(test_pid, {:fanout, event})
        loop(test_pid)

      _other ->
        loop(test_pid)
    end
  end

  defp wire(ch_id) do
    %{
      "id" => Integer.to_string(Cytale.Snowflake.next()),
      "channel_id" => Integer.to_string(ch_id),
      "author_id" => "7000000000000001",
      "content" => "probe"
    }
  end
end
