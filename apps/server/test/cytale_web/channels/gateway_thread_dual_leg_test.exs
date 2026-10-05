defmodule CytaleWeb.Channels.GatewayThreadDualLegTest do
  @moduledoc """
  #142 — the thread dual-leg fan-out at the wire, under concurrency.

  A thread reply publishes TWO legs through the production hot path
  (`Messages.Message.send_message`): a channel-anchored `MessageCreate`
  (thread_id set) and the thread-scoped `ThreadMessageCreate` — both routed by
  the PARENT channel key. The ticket measured a live subscriber's client store
  missing the thread leg for >15s while channel-surface dispatches kept
  flowing; the ordered suspects were (1) the dual-leg fan-out dropping the
  thread leg under concurrency, (2) seq/resume-buffer bookkeeping racing the
  apply path for thread-keyed events, (3) the visibility memo's epoch path
  treating the thread key differently.

  This suite hammers that exact shape against REAL sockets: two long-standing
  members (routes joined before any traffic), one posts thread replies from
  concurrent writers interleaved with parent-channel chatter and typing, and
  the wire each socket receives is tallied off the socket. The pinned
  property is the server half of the contract:

    * every reply's BOTH legs reach every live subscriber, exactly once;
    * the per-session dispatch stream stays gap-free and duplicate-free
      (seq continuity) across the whole storm.

  Whatever the ticket's client probe saw, THIS is the seam that must not
  drop: if these hold across repeated runs, the server delivered and the
  miss lives above the wire.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Gateway.Payloads
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages.Message
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @replies 60
  @concurrency 8

  # The #142 bound: from the LAST publish of the storm, every leg must have
  # been dispatched (present in each subscriber's server-side resume buffer)
  # within this window. The ticket measured a live store waiting >15s; the
  # fan-out's critical path is ETS reads + sends once the notification/index
  # legs stay off it, so even a loaded CI node drains this storm in ~1s.
  @delivery_deadline_ms 10_000
  @drain_poll_ms 100

  setup do
    port = start_gateway!()

    # The production route (Publish.publish → workspace process → fan-out);
    # the :test default only logs.
    old = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      if old,
        do: Application.put_env(:cytale, Cytale.Publish, old),
        else: Application.delete_env(:cytale, Cytale.Publish)
    end)

    %{port: port}
  end

  # -- fixtures (the #111/#109 wire-suite shape) -------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_token(prefix), do: "cytale_t142_" <> prefix <> run_nonce() <> String.duplicate("z", 8)

  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp drain_pending!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  defp wait_for_session_key!(_pid, _key, 0), do: flunk("route never joined")

  defp wait_for_session_key!(pid, key, tries) do
    if key in PushRegistry.session_keys(pid) do
      :ok
    else
      Process.sleep(20)
      wait_for_session_key!(pid, key, tries - 1)
    end
  end

  # Two long-standing members (membership BEFORE identify — both sockets join
  # the full route set, the ticket's "both members subscribed" shape), a
  # channel, a seed message and the thread hanging off it. Returns everything
  # the storm needs.
  defp two_member_thread!(port) do
    a_token = run_token("a")
    b_token = run_token("b")
    a_uid = stub_uid(a_token)

    {:ok, %{workspace_id: ws_id}} = Workspaces.create_workspace(a_uid, "t142-" <> run_nonce())
    {:ok, %{channel_id: ch_id}} = Workspaces.create_channel(ws_id, "general")
    b_uid = stub_uid(b_token)
    :ok = Workspaces.add_member(ws_id, b_uid, a_uid)

    a_conn = connect!(port)
    a_ready = identify!(a_conn, a_token)
    a_pid = ready_pid!(a_ready)

    b_conn = connect!(port)
    b_ready = identify!(b_conn, b_token)
    b_pid = ready_pid!(b_ready)

    ch_key = PushRegistry.channel_key(Integer.to_string(ch_id))
    wait_for_session_key!(a_pid, ch_key, 100)
    wait_for_session_key!(b_pid, ch_key, 100)

    {:ok, seed} =
      Message.send_message(%{
        channel_id: ch_id,
        author_id: a_uid,
        content: "seed row",
        thread_id: nil,
        attachments: []
      })

    {:ok, thread} = Thread.create(ch_id, String.to_integer(seed["id"]), "t142 thread", a_uid)

    drain_pending!(a_conn)
    drain_pending!(b_conn)

    %{
      a_conn: a_conn,
      b_conn: b_conn,
      a_session_id: a_ready["session_id"],
      b_session_id: b_ready["session_id"],
      a_pid: a_pid,
      b_pid: b_pid,
      ch_id: ch_id,
      thread_id: thread.thread_id,
      a_uid: a_uid,
      b_uid: b_uid
    }
  end

  defp ready_pid!(ready) do
    user_id = ready["user"]["id"]
    assert [{pid, ^user_id}] = PushRegistry.subscribers(PushRegistry.user_key(user_id))
    pid
  end

  # -- the storm ----------------------------------------------------------------

  # One reply's full production write: the dual emission plus the interleaved
  # "other channel traffic" the ticket described (parent-channel chatter and
  # thread typing). Runs inside concurrent tasks — concurrent REST writers.
  defp one_iteration!(i, fx) do
    {:ok, reply} =
      Message.send_message(%{
        channel_id: fx.ch_id,
        author_id: fx.b_uid,
        content: "reply-#{i}",
        thread_id: fx.thread_id,
        attachments: []
      })

    {:ok, _chatter} =
      Message.send_message(%{
        channel_id: fx.ch_id,
        author_id: fx.a_uid,
        content: "chatter-#{i}",
        thread_id: nil,
        attachments: []
      })

    :ok =
      Cytale.Publish.publish(
        fx.ch_id,
        {"TypingStart", Payloads.typing_start(fx.ch_id, fx.b_uid, fx.thread_id)}
      )

    String.to_integer(reply["id"])
  end

  # A collector OWNS its conn's recv loop from before the first publish until
  # :stop — tallying every dispatch off the wire (event, message id, seq) in
  # arrival order. This is the instrumentation the verdict hangs on: frames
  # tallied here were encoded and SENT by the server.
  defp start_collector(conn) do
    parent = self()

    spawn_link(fn ->
      collect_loop(conn, parent, %{events: [], seqs: []})
    end)
  end

  defp collect_loop(conn, parent, acc) do
    case Cytale.Test.WSClient.recv(conn.pid, 200) do
      {:text, data} ->
        collect_loop(conn, parent, absorb(Jason.decode!(data), acc))

      {:binary, data} ->
        collect_loop(conn, parent, absorb(Jason.decode!(data), acc))

      {:closed, _code} ->
        send(parent, {:collector_done, self(), acc})

      {:error, :timeout} ->
        receive do
          :stop -> send(parent, {:collector_done, self(), acc})
        after
          0 -> collect_loop(conn, parent, acc)
        end
    end
  end

  defp absorb(%{"op" => 0, "t" => t, "s" => s, "d" => %{} = d}, acc) when is_binary(t) do
    %{acc | events: [{t, d["id"], d["thread_id"]} | acc.events], seqs: [s | acc.seqs]}
  end

  defp absorb(_frame, acc), do: acc

  defp stop_collector!(collector) do
    send(collector, :stop)

    receive do
      {:collector_done, ^collector, acc} -> acc
    after
      5_000 -> flunk("collector never reported")
    end
  end

  defp tally(events) do
    Enum.frequencies_by(events, fn {t, id, _thread} -> {t, id} end)
  end

  # -- the pinned property -------------------------------------------------------

  test "every thread reply's both legs reach every live subscriber exactly once, seq gap-free",
       %{port: port} do
    fx = two_member_thread!(port)

    a_collector = start_collector(fx.a_conn)
    b_collector = start_collector(fx.b_conn)

    reply_ids =
      1..@replies
      |> Task.async_stream(
        fn i -> one_iteration!(i, fx) end,
        max_concurrency: @concurrency,
        timeout: 30_000
      )
      |> Enum.map(fn {:ok, id} -> id end)

    storm_done_at = System.monotonic_time(:millisecond)

    # Drain: wait until BOTH subscribers' server-side buffers hold every leg
    # (the buffers are the fan-out's own bookkeeping — a leg absent there is
    # still sitting in the workspace process's queue, i.e. UNDISPATCHED).
    {drain_ok?, drain_elapsed_ms} =
      drain_until_buffered!(fx, reply_ids, storm_done_at, @delivery_deadline_ms)

    a = stop_collector!(a_collector)
    b = stop_collector!(b_collector)

    # Transport-level frame counters (TCP-level truth at the test client) —
    # discriminates "the frame never left the server" from "the frame arrived
    # but the harness queue lost it".
    transport = %{
      a: Cytale.Test.WSClient.frame_counts(fx.a_conn.pid),
      b: Cytale.Test.WSClient.frame_counts(fx.b_conn.pid)
    }

    problems =
      for {conn_name, session_id, acc} <- [{"A", fx.a_session_id, a}, {"B", fx.b_session_id, b}],
          problem <- audit_legs(conn_name, session_id, acc, reply_ids, fx),
          do: problem

    problems =
      problems ++
        registry_problems(fx) ++
        if drain_ok?,
          do: [],
          else: [
            "fan-out lag: legs still undispatched #{@delivery_deadline_ms}ms after the last " <>
              "publish (drain took #{drain_elapsed_ms}ms) — the #142 delay shape"
          ]

    summary =
      "DIAG drain_ms=#{drain_elapsed_ms} transport=#{inspect(transport)} " <>
        "A_tallied=#{length(a.events)} A_seqs=#{length(a.seqs)} " <>
        "B_tallied=#{length(b.events)} B_seqs=#{length(b.seqs)}"

    assert problems == [], Enum.join(problems, "\n") <> "\n" <> summary
  end

  # Poll the two subscribers' stored session records until every reply's BOTH
  # legs are seq-stamped in each buffer. Returns {complete?, elapsed_ms}.
  defp drain_until_buffered!(fx, reply_ids, storm_done_at, deadline_ms) do
    expected = MapSet.new(reply_ids, &Integer.to_string/1)

    complete? = fn session_id ->
      case SessionStore.get(session_id) do
        nil ->
          false

        rec ->
          got =
            MapSet.new(rec.events, fn
              %{t: t, d: %{"id" => id}} -> {t, id}
              _ -> nil
            end)
            |> MapSet.delete(nil)

          Enum.all?(expected, fn sid ->
            MapSet.member?(got, {"MessageCreate", sid}) and
              MapSet.member?(got, {"ThreadMessageCreate", sid})
          end)
      end
    end

    start = storm_done_at

    loop = fn loop ->
      now = System.monotonic_time(:millisecond)

      cond do
        complete?.(fx.a_session_id) and complete?.(fx.b_session_id) ->
          {true, now - start}

        now - start > deadline_ms ->
          {false, now - start}

        true ->
          Process.sleep(@drain_poll_ms)
          loop.(loop)
      end
    end

    loop.(loop)
  end

  # One audit pass per subscriber: wire legs vs the server's own stored resume
  # buffer for that session. The buffer is the SERVER-SIDE truth of what was
  # seq-stamped for delivery — a leg present in the buffer but missing from
  # the wire tally never left the boundary above the socket; a leg absent from
  # BOTH was dropped at or before the fan-out.
  defp audit_legs(conn_name, session_id, acc, reply_ids, fx) do
    counts = tally(acc.events)

    stored =
      case session_id && SessionStore.get(session_id) do
        nil -> []
        rec -> rec.events |> Enum.reverse()
      end

    stored_ids = MapSet.new(stored, fn env -> {env.t, env.d["id"]} end)

    leg_problems =
      for id <- reply_ids, sid = Integer.to_string(id), leg <- ["MessageCreate", "ThreadMessageCreate"] do
        wire_count = counts[{leg, sid}] || 0
        buffered? = MapSet.member?(stored_ids, {leg, sid})

        cond do
          wire_count == 1 and buffered? ->
            []

          wire_count == 0 and not buffered? ->
            [
              "#{conn_name}: #{leg} for reply #{sid} NEVER DELIVERED (absent from the server's " <>
                "resume buffer too — dropped at/before the fan-out)"
            ]

          wire_count == 0 and buffered? ->
            env_seq =
              Enum.find_value(stored, fn env ->
                if env.t == leg and env.d["id"] == sid, do: env.s
              end)

            [
              "#{conn_name}: #{leg} for reply #{sid} buffered server-side (seq #{inspect(env_seq)}) " <>
                "but never seen on the wire (wire seqs #{inspect(Enum.min(acc.seqs))}..#{inspect(Enum.max(acc.seqs))}, " <>
                "n=#{length(acc.seqs)}) — lost above the socket boundary]"
            ]

          true ->
            ["#{conn_name}: #{leg} for reply #{sid} delivered #{wire_count} times (want exactly 1)"]
        end
      end

    List.flatten(leg_problems) ++ seq_problems(conn_name, acc) ++ thread_scope_problems(conn_name, acc, fx)
  end

  # Was A's route registration still intact at audit time? A transient loss
  # window mid-storm would show as legs missing from the live read while the
  # key is (or was) present here.
  defp registry_problems(fx) do
    ch_key = PushRegistry.channel_key(Integer.to_string(fx.ch_id))
    a_keys = PushRegistry.session_keys(fx.a_pid)
    b_keys = PushRegistry.session_keys(fx.b_pid)

    if(ch_key in a_keys, do: [], else: ["A: channel route key ABSENT from registry keys at audit time"]) ++
      if ch_key in b_keys, do: [], else: ["B: channel route key ABSENT from registry keys at audit time"]
  end

  defp seq_problems(conn_name, acc) do
    case Enum.reverse(acc.seqs) do
      [] ->
        ["#{conn_name}: no dispatches observed at all"]

      seqs ->
        {problems, _prev} =
          Enum.reduce(seqs, {[], nil}, fn s, {probs, prev} ->
            probs =
              if prev != nil and s != prev + 1 do
                [
                  "#{conn_name}: dispatch stream broke at seq #{prev} → #{s} " <>
                    "(gap = lost dispatch, repeat = double send)"
                  | probs
                ]
              else
                probs
              end

            {probs, s}
          end)

        problems
    end
  end

  defp thread_scope_problems(conn_name, acc, fx) do
    bad =
      for {t, _id, thread_id} <- acc.events,
          t == "ThreadMessageCreate",
          thread_id != Integer.to_string(fx.thread_id) do
        thread_id
      end

    if bad == [], do: [], else: ["#{conn_name}: thread legs carried wrong thread_id: #{inspect(bad)}"]
  end
end
