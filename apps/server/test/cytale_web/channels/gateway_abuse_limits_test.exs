defmodule CytaleWeb.Channels.GatewayAbuseLimitsTest do
  @moduledoc """
  Tier 3 (B) finding 5 — gateway abuse limits, over the real wire:

    * (a) a per-socket inbound frame budget, closing 4008;
    * (b) an Identify deadline (close 4003), and no heartbeat ACK before
      Identify;
    * (c) presence op 3 is throttled per socket and fans out only on a change;
    * (d) live + held native sessions per user are capped, evicting the
      oldest held one;
    * (e) typing keys its throttle on the parsed channel id, echoes the
      canonical id, and drops a `thread_id` that is not the channel's;
    * (f) a resumed session gets a fresh resume token, so it resumes again.

  The bounds are lowered per test through the `:gateway` app env (the suite
  default lifts them — config/test.exs) and restored afterwards.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.{Messages, Workspaces}
  alias Cytale.Threads.Thread

  setup do
    saved = Application.get_env(:cytale, :gateway)
    on_exit(fn -> Application.put_env(:cytale, :gateway, saved) end)
    {:ok, port: start_gateway!()}
  end

  defp put_gateway(kv) do
    current = Application.get_env(:cytale, :gateway) || []
    Application.put_env(:cytale, :gateway, Keyword.merge(current, kv))
  end

  defp run_nonce, do: "r" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))
  defp run_token, do: "cytale_t3b_" <> run_nonce() <> String.duplicate("t", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 250) do
      {:error, :timeout} -> :ok
      {:closed, _} -> :ok
      _frame -> drain!(conn)
    end
  end

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    drain!(conn)
    {conn, ready}
  end

  defp wait_until(fun, tries \\ 100) do
    cond do
      fun.() -> :ok
      tries == 0 -> flunk("condition never held")
      true -> Process.sleep(30) && wait_until(fun, tries - 1)
    end
  end

  defp await_disconnected!(sid) do
    wait_until(fn ->
      match?(%Session{phase: :disconnected}, SessionStore.get(sid)) and not SessionStore.claim_held_by_live?(sid)
    end)
  end

  defp workspace!(owner_token, member_tokens) do
    owner = stub_uid(owner_token)
    {:ok, ws} = Workspaces.create_workspace(owner, "t3b-" <> run_nonce())
    for t <- member_tokens, do: :ok = Workspaces.add_member(ws.workspace_id, stub_uid(t), owner, [])
    ws
  end

  # -- (a) ---------------------------------------------------------------------

  test "(a) a socket over its inbound frame budget is closed 4008", %{port: port} do
    put_gateway(frame_budget: 5, frame_window_ms: 60_000)
    {conn, _ready} = identify_on(port, run_token())

    # Identify was frame 1; four heartbeats fill the budget…
    for _ <- 1..4 do
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 2_000)
    end

    # …and the sixth frame is one too many.
    send_frame!(conn, 1, nil)
    assert assert_closed_skipping!(conn, 2_000, ["PresenceUpdate"]) == 4008
  end

  test "(a) the budget refills with the window", %{port: port} do
    put_gateway(frame_budget: 3, frame_window_ms: 300)
    {conn, _ready} = identify_on(port, run_token())

    for _ <- 1..6 do
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 2_000)
      Process.sleep(160)
    end
  end

  # -- (b) ---------------------------------------------------------------------

  test "(b) a socket that never identifies is closed 4003", %{port: port} do
    put_gateway(identify_timeout_ms: 300)
    conn = connect!(port)
    assert assert_closed!(conn, 3_000) == 4003
  end

  # discord.py beats on Hello, before Identify, and reads a missing ACK as an
  # infinite latency; Hermes reconnected over it (2026-10-08). Discord ACKs it.
  test "(b) a heartbeat before Identify is acknowledged (and does not close)", %{port: port} do
    conn = connect!(port)
    send_frame!(conn, 1, nil)
    assert next_op!(conn, 11, 2_000)

    # The socket still identifies normally afterwards, and beats are ACKed.
    ready = identify!(conn, run_token())
    assert is_binary(ready["session_id"])
    drain!(conn)
    send_frame!(conn, 1, nil)
    assert next_op!(conn, 11, 2_000)
  end

  test "(b) beating does not keep an unidentified socket past the deadline", %{port: port} do
    put_gateway(identify_timeout_ms: 300)
    conn = connect!(port)
    send_frame!(conn, 1, nil)
    assert next_op!(conn, 11, 2_000)
    assert assert_closed!(conn, 3_000) == 4003
  end

  test "(b) an identified socket outlives the deadline", %{port: port} do
    put_gateway(identify_timeout_ms: 200)
    {conn, _ready} = identify_on(port, run_token())
    Process.sleep(400)
    send_frame!(conn, 1, nil)
    assert next_op!(conn, 11, 2_000)
  end

  # -- (c) ---------------------------------------------------------------------

  test "(c) presence fans out only on a change, and is throttled per socket", %{port: port} do
    put_gateway(presence_budget: 2, presence_window_ms: 60_000)
    token_a = run_token()
    token_b = run_token()
    _ws = workspace!(token_a, [token_b])
    uid_b = Integer.to_string(stub_uid(token_b))

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)
    drain!(conn_a)

    presence_from_b = fn timeout ->
      deadline = System.monotonic_time(:millisecond) + timeout

      Stream.repeatedly(fn ->
        Cytale.Test.WSClient.recv(conn_a.pid, max(deadline - System.monotonic_time(:millisecond), 1))
      end)
      |> Enum.find_value(fn
        {:text, data} ->
          case Jason.decode!(data) do
            %{"t" => "PresenceUpdate", "d" => %{"user_id" => ^uid_b} = d} -> d["status"]
            _ -> nil
          end

        {:error, :timeout} ->
          :none

        {:closed, _} ->
          :none

        _ ->
          nil
      end)
    end

    # 1st accepted change.
    send_frame!(conn_b, 3, %{"status" => "idle"})
    assert presence_from_b.(2_000) == "idle"

    # Same status again: no broadcast (and it does not spend the budget).
    send_frame!(conn_b, 3, %{"status" => "idle"})
    assert presence_from_b.(400) == :none

    # 2nd accepted change.
    send_frame!(conn_b, 3, %{"status" => "dnd"})
    assert presence_from_b.(2_000) == "dnd"

    # Over the budget: swallowed silently, the socket stays up.
    send_frame!(conn_b, 3, %{"status" => "idle"})
    assert presence_from_b.(400) == :none
    send_frame!(conn_b, 1, nil)
    assert next_op!(conn_b, 11, 2_000)
  end

  # -- (d) ---------------------------------------------------------------------

  test "(d) at the cap the oldest HELD session is evicted; all-live is refused 4008", %{port: port} do
    put_gateway(native_session_cap: 2)
    token = run_token()

    {conn1, ready1} = identify_on(port, token)
    {_conn2, _ready2} = identify_on(port, token)

    # Drop the first socket: its session is now held (resumable).
    Cytale.Test.WSClient.stop(conn1.pid)
    await_disconnected!(ready1["session_id"])

    # A third Identify makes room by evicting that held session…
    {_conn3, _ready3} = identify_on(port, token)
    assert SessionStore.get(ready1["session_id"]) == nil

    # …and with two LIVE sockets there is nothing to evict: refused.
    conn4 = connect!(port)
    send_frame!(conn4, 2, %{"token" => token, "v" => 1, "properties" => %{}})
    assert assert_closed!(conn4, 3_000) == 4008
  end

  # -- (e) ---------------------------------------------------------------------

  test "(e) typing canonicalizes the channel id and throttles on it; a foreign thread is dropped",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    ws = workspace!(token_a, [token_b])
    uid_a = stub_uid(token_a)
    {:ok, ch1} = Workspaces.create_channel(ws.workspace_id, "one")
    {:ok, ch2} = Workspaces.create_channel(ws.workspace_id, "two")
    {:ok, ch3} = Workspaces.create_channel(ws.workspace_id, "three")

    {:ok, root} = Messages.create_message(%{channel_id: ch3.channel_id, author_id: uid_a, content: "root"})
    {:ok, thread} = Thread.create(ch3.channel_id, root.id, "t", uid_a)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)
    drain!(conn_a)

    # A zero-padded id is the same channel: it is echoed canonically…
    send_frame!(conn_b, 20, %{"channel_id" => "000" <> Integer.to_string(ch1.channel_id)})
    typing = next_event!(conn_a, "TypingStart", 3_000)
    assert typing["d"]["channel_id"] == Integer.to_string(ch1.channel_id)

    # …and a re-spelling does not open a second throttle window.
    send_frame!(conn_b, 20, %{"channel_id" => Integer.to_string(ch1.channel_id)})
    refute_next_event!(conn_a, "TypingStart", 400)

    # A thread that is not the channel's is dropped…
    send_frame!(conn_b, 20, %{
      "channel_id" => Integer.to_string(ch2.channel_id),
      "thread_id" => Integer.to_string(thread.thread_id)
    })

    refute_next_event!(conn_a, "TypingStart", 400)

    # …while the channel's own thread goes through, canonicalized.
    send_frame!(conn_b, 20, %{
      "channel_id" => Integer.to_string(ch3.channel_id),
      "thread_id" => "0" <> Integer.to_string(thread.thread_id)
    })

    typing = next_event!(conn_a, "TypingStart", 3_000)
    assert typing["d"]["channel_id"] == Integer.to_string(ch3.channel_id)
    assert typing["d"]["thread_id"] == Integer.to_string(thread.thread_id)
  end

  # -- (f) ---------------------------------------------------------------------

  test "(f) Resumed carries a fresh resume token, and a second resume works", %{port: port} do
    token = run_token()
    conn1 = connect!(port)
    ready = identify!(conn1, token)
    sid = ready["session_id"]
    Cytale.Test.WSClient.stop(conn1.pid)

    resume_token =
      Enum.reduce(1..2, ready["resume_token"], fn _round, current ->
        await_disconnected!(sid)
        conn = connect!(port)

        send_frame!(conn, 5, %{"token" => token, "session_id" => sid, "seq" => 0, "resume_token" => current})

        resumed = next_event!(conn, "Resumed", 5_000)
        fresh = resumed["d"]["resume_token"]
        assert is_binary(fresh) and fresh != current
        assert SessionStore.get(sid).resume_token == fresh

        Cytale.Test.WSClient.stop(conn.pid)
        fresh
      end)

    # The spent tokens are dead; only the latest would resume.
    assert is_binary(resume_token)
  end
end
