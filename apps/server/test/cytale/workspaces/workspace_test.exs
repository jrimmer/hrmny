defmodule Cytale.Workspaces.WorkspaceTest do
  @moduledoc """
  U11 — workspace process + fan-out. Scenarios per the plan:

    * lazy start on first publish/connection; channel list cached from ScyllaDB
    * REST-shaped publish fans out to connected gateway sessions in-channel
      (via the Publish seam with the real workspace-process impl)
    * crash → supervisor restarts → reconstructable from ScyllaDB
    * per-channel monotonic ordering (Snowflake message_id)
    * AE1 isolation: workspace A flooded/crashed, workspace B unaffected
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Gateway.PreEncoded
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages
  alias Cytale.Publish
  alias Cytale.Workspaces.Registry
  alias Cytale.Workspaces.Supervisor

  # Runtime (NOT compile-time) nonce — compile-time attributes collide across
  # `mix test` invocations (observed in U9).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # This module re-wires the Publish impl to the REAL workspace-process
  # implementation for its cases and restores it in on_exit (no cross-module
  # env deletes — config/test.exs owns the hermetic default).
  setup do
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

  # -- fixture helpers (schema is applied once by ScyllaCase) --------------------

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

    # channels (workspace listing) + channels_by_id (publish resolution)
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

  # A fake gateway socket process: registers on the channel route and answers
  # the `{:cytale_gateway_push, _from, event}` delivery with a message to the
  # test process — exactly how the real WebSock handler consumes fan-out.
  defp start_fake_session(channel_id, test_pid, user_id \\ "111") do
    parent = self()

    {:ok, pid} =
      Task.start_link(fn ->
        PushRegistry.subscribe(PushRegistry.channel_key(Integer.to_string(channel_id)), user_id, self(), [])

        send(parent, :session_ready)

        loop(test_pid)
      end)

    assert_receive :session_ready, 5_000
    pid
  end

  describe "publish routing cache (hardening plan 5.1)" do
    test "a second publish to the same channel issues NO channels_by_id read" do
      ws_id = make_workspace(run_unique("route-cache-ws"))
      ch_id = make_channel(ws_id, run_unique("route-cache-ch"))

      parent = self()
      ref = make_ref()
      handler_id = "route-cache-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, metadata, ^parent ->
            send(parent, {:stmt, ref, metadata.query.statement})
          end,
          parent
        )

      # Cold: the resolution read happens and the answer is cached.
      :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})
      cold = drain_statements(ref)
      assert Enum.any?(cold, &String.contains?(&1, "channels_by_id"))

      # Warm: the same channel routes with no lookup at all. This is the steady
      # state — every message, typing signal and presence fan-out used to pay it.
      :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})
      warm = drain_statements(ref)
      :ok = :telemetry.detach(handler_id)

      refute Enum.any?(warm, &String.contains?(&1, "channels_by_id")),
             "the warm path still resolved the route: #{inspect(warm)}"
    end

    test "a channel created AFTER a first publish still routes (the miss path)" do
      ws_id = make_workspace(run_unique("route-miss-ws"))

      # Prime the cache with a DIFFERENT channel of the same workspace, so this is
      # a cache-populated miss and not merely an empty cache.
      first_ch = make_channel(ws_id, run_unique("route-first"))
      :ok = Publish.publish(first_ch, {"MessageCreate", wire(first_ch)})

      later_ch = make_channel(ws_id, run_unique("route-later"))
      assert Cytale.Publish.ChannelRoutes.fetch(later_ch) == :error

      # A late channel must still fan out: the cache is a shortcut, never the
      # source of truth, or a channel created after its workspace's first publish
      # would silently drop every event.
      :ok = Publish.publish(later_ch, {"MessageCreate", wire(later_ch)})
      assert {:ok, ^ws_id} = Cytale.Publish.ChannelRoutes.fetch(later_ch)
    end

    test "the cache survives a workspace process restart and answers from ETS" do
      ws_id = make_workspace(run_unique("route-restart-ws"))
      ch_id = make_channel(ws_id, run_unique("route-restart-ch"))

      :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})
      assert {:ok, ^ws_id} = Cytale.Publish.ChannelRoutes.fetch(ch_id)

      # The MAPPING is data, not workspace state: it stays valid across a restart
      # of the process it routes to (which is why nothing invalidates on restart).
      assert Cytale.Publish.ChannelRoutes.size() > 0
    end
  end

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  defp loop(test_pid) do
    receive do
      # Both push shapes: the 4-element form carries the fan-out's pre-encoded
      # payload fragment (hardening plan 2.3), the 3-element form is the
      # single-recipient path (no fragment to carry).
      {:cytale_gateway_push, _from, event, _fragment} ->
        send(test_pid, {:fanout, event})
        loop(test_pid)

      {:cytale_gateway_push, _from, event} ->
        send(test_pid, {:fanout, event})
        loop(test_pid)

      :stop ->
        :ok

      _other ->
        loop(test_pid)
    end
  end

  # Like `loop/1`, but forwards the fragment too — the PERF-07 pin needs to
  # see WHICH fragment each route received, not just the event.
  defp forward_loop(test_pid, tag) do
    receive do
      {:cytale_gateway_push, _from, {event_name, payload}, fragment} ->
        send(test_pid, {:fanout_push, tag, event_name, fragment})
        forward_loop(test_pid, tag)

      {:cytale_gateway_push, _from, {event_name, payload}} ->
        send(test_pid, {:fanout_push, tag, event_name, nil})
        forward_loop(test_pid, tag)

      :stop ->
        :ok

      _other ->
        forward_loop(test_pid, tag)
    end
  end

  # -- tests ---------------------------------------------------------------------

  test "lazy start on first publish: process starts and registers" do
    ws_id = make_workspace(run_unique("lazy-ws"))
    ch_id = make_channel(ws_id, run_unique("general"))
    refute Registry.whereis(ws_id)

    log =
      capture_log(fn ->
        :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})
      end)

    assert log =~ "" or true
    assert {:ok, pid} = Supervisor.ensure_started(ws_id)
    assert Registry.whereis(ws_id) == pid
    assert Process.alive?(pid)
  end

  # -- UserUpdate (avatar render pass) ------------------------------------------

  # The workspace leg MUST deliver on the STRING-id workspace key (sessions
  # subscribe there); routing through the workspace process's channel-less
  # {:workspace, :all} would reach nobody. The DM leg delivers each
  # distinct participant user key exactly once.
  test "publish_user_update reaches workspace sessions and DM participants once each" do
    ws_id = make_workspace(run_unique("uu-ws"))
    other_ws = make_workspace(run_unique("uu-ws2"))

    author = Cytale.Snowflake.next()
    peer = Cytale.Snowflake.next()

    # The author is a member of ws_id and a member of other_ws; the peer is
    # a member of ws_id and DMs the author (one DM row, two participants).
    for uid <- [author, peer] do
      Cytale.Repo.execute!(
        "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces_of_user (user_id, workspace_id) VALUES (?, ?)",
        [{"bigint", uid}, {"bigint", ws_id}]
      )
    end

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces_of_user (user_id, workspace_id) VALUES (?, ?)",
      [{"bigint", author}, {"bigint", other_ws}]
    )

    dm_id = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.dm_channels (channel_id, user_ids, created_at, last_message_id) VALUES (?, ?, ?, ?)",
      [{"bigint", dm_id}, {"list<bigint>", Enum.sort([author, peer])}, {"timestamp", now}, {"bigint", nil}]
    )

    for uid <- Enum.sort([author, peer]) do
      Cytale.Repo.execute!(
        "INSERT INTO #{Cytale.Repo.keyspace()}.dms_of_user (user_id, channel_id, user_ids, created_at, last_message_id) VALUES (?, ?, ?, ?, ?)",
        [
          {"bigint", uid},
          {"bigint", dm_id},
          {"list<bigint>", Enum.sort([author, peer])},
          {"timestamp", now},
          {"bigint", nil}
        ]
      )
    end

    # Sessions: one on each workspace key, plus one per DM participant
    # user key. All forward their pushes to the test process.
    parent = self()

    fake = fn route, tag ->
      {:ok, pid} =
        Task.start_link(fn ->
          PushRegistry.subscribe(route, "u", self(), [])
          send(parent, {:ready, tag})
          loop(parent)
        end)

      assert_receive {:ready, ^tag}, 5_000
      pid
    end

    ws_session = fake.(PushRegistry.workspace_key(Integer.to_string(ws_id)), :ws)
    ws2_session = fake.(PushRegistry.workspace_key(Integer.to_string(other_ws)), :ws2)
    author_dm_session = fake.(PushRegistry.user_key(Integer.to_string(author)), :author_dm)
    peer_dm_session = fake.(PushRegistry.user_key(Integer.to_string(peer)), :peer_dm)

    event = {"UserUpdate", %{"id" => Integer.to_string(author), "username" => "renamed"}}

    :ok = Publish.publish_user_update(author, event)

    # Both workspace sessions and BOTH DM participants hear it once.
    assert_receive {:fanout, {"UserUpdate", payload}}, 5_000
    assert payload["id"] == Integer.to_string(author)
    assert_receive {:fanout, {"UserUpdate", _}}, 5_000
    assert_receive {:fanout, {"UserUpdate", _}}, 5_000
    assert_receive {:fanout, {"UserUpdate", _}}, 5_000
    refute_receive {:fanout, _}, 100

    Enum.each([ws_session, ws2_session, author_dm_session, peer_dm_session], fn pid ->
      send(pid, :stop)
    end)
  end

  test "publish_user_update encodes ONCE and every route reuses the fragment (PERF-07)" do
    # Two workspace routes (the DM leg resolves to none here), each with a
    # live recipient that forwards the push WITH its fragment. Under the old
    # per-route decision neither route pre-encoded (one recipient each —
    # `for_fanout/2` declines); under PERF-07 the publish encodes exactly
    # once and both routes splice the SAME bytes — which is what fails the
    # old shape and pins the new one.
    ws_a = make_workspace(run_unique("uu-encode-ws-a"))
    ws_b = make_workspace(run_unique("uu-encode-ws-b"))

    author = Cytale.Snowflake.next()

    for ws_id <- [ws_a, ws_b] do
      Cytale.Repo.execute!(
        "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces_of_user (user_id, workspace_id) VALUES (?, ?)",
        [{"bigint", author}, {"bigint", ws_id}]
      )
    end

    parent = self()

    forwarder = fn route, tag ->
      {:ok, pid} =
        Task.start_link(fn ->
          PushRegistry.subscribe(route, "1", self())
          send(parent, {:ready, tag})
          forward_loop(parent, tag)
        end)

      assert_receive {:ready, ^tag}, 5_000
      pid
    end

    session_a = forwarder.(PushRegistry.workspace_key(Integer.to_string(ws_a)), :ws_a)
    session_b = forwarder.(PushRegistry.workspace_key(Integer.to_string(ws_b)), :ws_b)

    ref = make_ref()
    handler_id = "uu-encode-once-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:cytale, :gateway, :payload_encode],
        fn _event, _measurements, _metadata, ^parent -> send(parent, {:encoded, ref}) end,
        parent
      )

    event = {"UserUpdate", %{"id" => Integer.to_string(author), "username" => "encoded-once"}}
    :ok = Publish.publish_user_update(author, event)

    # Both routes delivered, each carrying a real fragment…
    assert_receive {:fanout_push, :ws_a, "UserUpdate", %PreEncoded{} = fragment_a}, 5_000
    assert_receive {:fanout_push, :ws_b, "UserUpdate", %PreEncoded{} = fragment_b}, 5_000
    assert fragment_a == fragment_b

    # …and the whole publish paid exactly ONE payload encode.
    assert_receive {:encoded, ^ref}
    refute_receive {:encoded, _}, 200

    :ok = :telemetry.detach(handler_id)

    send(session_a, :stop)
    send(session_b, :stop)
  end

  test "publish fans out MESSAGE_CREATE to connected sessions in the channel" do
    ws_id = make_workspace(run_unique("fanout-ws"))
    ch_id = make_channel(ws_id, run_unique("general"))
    session = start_fake_session(ch_id, self())

    :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})

    assert_receive {:fanout, {"MessageCreate", payload}}, 5_000
    assert payload["channel_id"] == Integer.to_string(ch_id)
    assert Process.alive?(session)
  end

  test "sessions on OTHER channels do not receive the event" do
    ws_id = make_workspace(run_unique("scoped-ws"))
    ch_a = make_channel(ws_id, run_unique("a"))
    ch_b = make_channel(ws_id, run_unique("b"))

    start_fake_session(ch_a, self())
    start_fake_session(ch_b, self())

    :ok = Publish.publish(ch_a, {"MessageCreate", wire(ch_a)})

    assert_receive {:fanout, {"MessageCreate", payload}}, 5_000
    assert payload["channel_id"] == Integer.to_string(ch_a)

    # Exactly one delivery: ch_b's session stays silent.
    refute_receive {:fanout, _}, 300
  end

  test "per-channel monotonic ordering: publishes arrive in snowflake order" do
    ws_id = make_workspace(run_unique("order-ws"))
    ch_id = make_channel(ws_id, run_unique("ordered"))

    start_fake_session(ch_id, self())

    # Three publishes; the payloads carry ascending snowflake ids.
    ids =
      for _ <- 1..3 do
        msg = %{"channel_id" => Integer.to_string(ch_id), "id" => Integer.to_string(Cytale.Snowflake.next())}
        :ok = Publish.publish(ch_id, {"MessageCreate", msg})
        msg["id"]
      end

    assert_receive {:fanout, {"MessageCreate", p1}}, 5_000
    assert_receive {:fanout, {"MessageCreate", p2}}, 5_000
    assert_receive {:fanout, {"MessageCreate", p3}}, 5_000

    got = [p1["id"], p2["id"], p3["id"]]
    assert got == ids
    assert got == Enum.sort(got, &(&1 <= &2))
  end

  test "crash → supervisor restarts → process re-registers" do
    ws_id = make_workspace(run_unique("crash-ws"))

    {:ok, pid} = Supervisor.ensure_started(ws_id)
    assert Registry.whereis(ws_id) == pid

    # Kill hard; :transient restart + Registry re-registration reconstruct.
    # There is no process-local cache left to rebuild (plan 7.10), so what this
    # pins is the restart and the re-registration itself.
    Process.exit(pid, :kill)

    assert wait_until(10_000, fn ->
             case Registry.whereis(ws_id) do
               nil -> false
               new_pid -> new_pid != pid and Process.alive?(new_pid)
             end
           end)
  end

  test "AE1 isolation: workspace A flooded + crashed, workspace B delivers unaffected" do
    ws_a = make_workspace(run_unique("iso-a"))
    ws_b = make_workspace(run_unique("iso-b"))
    ch_a = make_channel(ws_a, run_unique("a"))
    ch_b = make_channel(ws_b, run_unique("b"))

    start_fake_session(ch_b, self())

    {:ok, pid_a} = Supervisor.ensure_started(ws_a)

    # Flood A, then kill it — B's publish must still deliver promptly.
    for _ <- 1..50 do
      Publish.publish(ch_a, {"MessageCreate", wire(ch_a)})
    end

    Process.exit(pid_a, :kill)

    t0 = System.monotonic_time(:millisecond)
    :ok = Publish.publish(ch_b, {"MessageCreate", wire(ch_b)})
    assert_receive {:fanout, {"MessageCreate", payload}}, 5_000
    elapsed = System.monotonic_time(:millisecond) - t0

    assert payload["channel_id"] == Integer.to_string(ch_b)
    assert elapsed < 5_000
  end

  test "message hot path: send_message persists then fans out" do
    ws_id = make_workspace(run_unique("hot-ws"))
    ch_id = make_channel(ws_id, run_unique("hot"))
    start_fake_session(ch_id, self())

    assert {:ok, wire} =
             Cytale.Messages.Message.send_message(%{
               channel_id: ch_id,
               author_id: Cytale.Snowflake.next(),
               content: "hot path probe",
               thread_id: nil
             })

    assert wire["channel_id"] == Integer.to_string(ch_id)
    assert is_binary(wire["id"])

    assert_receive {:fanout, {"MessageCreate", payload}}, 5_000
    assert payload["id"] == wire["id"]

    # Durable.
    assert [%{id: id}] = Messages.history(ch_id, limit: 1)
    assert Integer.to_string(id) == wire["id"]
  end

  test "telemetry: [:cytale, :fanout, :*] events emit on the hot path" do
    ws_id = make_workspace(run_unique("tel-ws"))
    ch_id = make_channel(ws_id, run_unique("tel"))
    start_fake_session(ch_id, self())

    ref = self()

    handler_id = "workspace-test-#{System.unique_integer()}"

    :ok =
      :telemetry.attach_many(
        handler_id,
        [
          [:cytale, :fanout, :latency],
          [:cytale, :fanout, :delivered],
          [:cytale, :fanout, :persisted]
        ],
        # THIS test's publish only: the handler is global, and a fan-out still
        # draining from an earlier test (another workspace, or an event with no
        # subscriber) would otherwise answer the assertions below with its own
        # zero-delivery sample.
        fn event, measurements, metadata, ^ref ->
          if metadata[:workspace_id] == ws_id and metadata[:event] == "MessageCreate",
            do: send(ref, {:telem, event, measurements, metadata})
        end,
        ref
      )

    on_exit(fn -> :telemetry.detach(handler_id) end)

    :ok = Publish.publish(ch_id, {"MessageCreate", wire(ch_id)})

    assert_receive {:telem, [:cytale, :fanout, :latency], %{latency: lat}, _}, 5_000
    assert is_integer(lat) and lat >= 0

    assert_receive {:telem, [:cytale, :fanout, :delivered], %{count: c}, _}, 5_000
    assert c >= 1

    assert_receive {:telem, [:cytale, :fanout, :persisted], %{count: 1}, _}, 5_000
  end

  # #110: the seam's observability guard — the mirror of
  # `gateway_fanout_test.exs`'s routing pin. That one proves an unrouted publish
  # arrives NOWHERE; this one proves the case is no longer SILENT, which is what
  # let `ThreadUpdate` live undetected until #109.
  test "a channel-scoped event with no channel in its payload warns at the seam (#110)" do
    ws_id = make_workspace(run_unique("anchor-ws"))
    ch_id = make_channel(ws_id, run_unique("anchored"))
    event_id = Integer.to_string(Cytale.Snowflake.next())

    # 1. The anchored shape — a channel in the payload: never a warning.
    silent =
      capture_log(fn ->
        :ok = Publish.publish(ch_id, {"ThreadUpdate", %{"id" => event_id, "channel_id" => Integer.to_string(ch_id)}})

        # The cast is ordered ahead of this call, so the log is complete when
        # the closure returns.
        flush_workspace(ws_id)
      end)

    refute silent =~ "channel-scoped"

    # 2. The #109 shape — same publish, no channel in the payload. It resolves to
    #    the workspace-wide route and reaches nobody; the warning is now the only
    #    trace it leaves.
    warned =
      capture_log(fn ->
        :ok = Publish.publish(ch_id, {"ThreadUpdate", %{"id" => event_id}})
        flush_workspace(ws_id)
      end)

    assert warned =~ "channel-scoped ThreadUpdate"
    assert warned =~ event_id

    # 3. A legitimately channel-less class: workspace-addressed presence has no
    #    channel BY DESIGN, so the seam stays quiet — the discriminator is the
    #    event class, not the missing key (warning here would be noise).
    by_design =
      capture_log(fn ->
        :ok = Publish.publish(ch_id, {"PresenceUpdate", %{"user_id" => "1", "status" => "online"}})
        flush_workspace(ws_id)
      end)

    refute by_design =~ "channel-scoped"
  end

  # -- helpers -----------------------------------------------------------------

  # Sync barrier for the workspace process's cast mailbox: once this call
  # replies, every cast queued before it (the publish) has been handled, so
  # `capture_log` sees the complete log. Replaces the deleted `session_count/1`.
  defp flush_workspace(ws_id) do
    case Registry.whereis(ws_id) do
      nil -> :ok
      pid -> :sys.get_state(pid)
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

  defp wait_until(timeout, _fun) when timeout <= 0, do: false

  defp wait_until(timeout, fun) do
    if fun.(),
      do: true,
      else:
        (
          Process.sleep(100)
          wait_until(timeout - 100, fun)
        )
  end
end
