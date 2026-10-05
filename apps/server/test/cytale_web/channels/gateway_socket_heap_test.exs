defmodule CytaleWeb.Channels.GatewaySocketHeapTest do
  @moduledoc """
  #52: a gateway socket's memory is BOUNDED, so a client that stops draining
  the wire cannot grow an unbounded mailbox on a node that also hosts every
  workspace, all presence, and (at launch) Scylla's neighbour processes.

  Two properties, deliberately separated because the failure mode lives
  between them:

    * the socket process CARRIES the bound (set at `init/1` from config,
      bytes → the VM's words), and
    * the bound actually FIRES for a stalled session — proven end to end by
      pausing a real client's reads, because a bound that a wedged socket
      silently escapes would be worse than no bound at all (it would look
      like protection).
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces
  alias Cytale.Workspaces.FanOut

  # The VM's unit for max_heap_size is words; config carries bytes.
  @wordsize :erlang.system_info(:wordsize)

  # Small enough to reach by flooding, comfortably above a healthy session's
  # footprint. That footprint is NOT small and NOT stable: `total_heap_size`
  # after Identify measures ~30-300 KB depending on what the handshake left
  # uncollected and how loaded the run is (observed 284 KB in a full-suite run).
  # A bound below that range kills healthy sessions — which is exactly what an
  # earlier 240 KB value did here, failing this suite's own headroom assertion
  # and taking the sibling socket with it. 1 MB leaves real room; the flood
  # below trips it in well under a second.
  @test_bound_bytes 1024 * 1024

  setup do
    port = start_gateway!()
    {:ok, port: port}
  end

  # -- fixtures -------------------------------------------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_s52_" <> run_nonce() <> String.duplicate("h", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp workspace!(token_a, extra_tokens, channel_names) do
    uid_a = stub_uid(token_a)

    {:ok, ws} = Workspaces.create_workspace(uid_a, "s52-" <> run_nonce())

    for token <- extra_tokens do
      :ok = Workspaces.add_member(ws.workspace_id, stub_uid(token), uid_a, [])
    end

    channels =
      Map.new(channel_names, fn name ->
        {:ok, ch} = Workspaces.create_channel(ws.workspace_id, name)
        {String.to_atom(name), ch.channel_id}
      end)

    {ws, channels}
  end

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    {conn, ready}
  end

  defp drain_pending!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # The server-side socket process for a user's live session (the registry is
  # the only handle a test has on it).
  defp session_socket_pid(user_id) do
    PushRegistry.subscribers(PushRegistry.user_key(user_id))
    |> List.first()
    |> case do
      {pid, _uid} -> pid
      nil -> flunk("no live session registered for user #{user_id}")
    end
  end

  defp with_socket_bound(bytes, fun) do
    original = Application.get_env(:cytale, Cytale.Config) || []

    Application.put_env(
      :cytale,
      Cytale.Config,
      Keyword.put(original, :gateway_socket_max_heap_bytes, bytes)
    )

    on_exit(fn -> Application.put_env(:cytale, Cytale.Config, original) end)

    fun.()
  end

  # The exact envelope the fan-out sends (FanOut.deliver_route / Workspace
  # fan_out both `send(pid, {:cytale_gateway_push, self(), event})`), used
  # directly because a rate-shaped flood through the real seam would spend its
  # time in a per-event channel→DM point read, not in the mailbox under test.
  defp flood(pid, count) do
    payload = %{
      "id" => "1",
      "channel_id" => "1",
      "author_id" => "1",
      "content" => String.duplicate("b", 48),
      "attachments" => []
    }

    Enum.each(1..count, fn _ ->
      send(pid, {:cytale_gateway_push, self(), {"MessageCreate", payload}})
    end)
  end

  # -- the contract ---------------------------------------------------------------

  test "an identified session's socket carries the configured bound, in words, with kill",
       %{port: port} do
    with_socket_bound(@test_bound_bytes, fn ->
      token = run_token()
      {_conn, ready} = identify_on(port, token)
      pid = session_socket_pid(ready["user"]["id"])

      assert {:max_heap_size, %{size: size, kill: true}} = Process.info(pid, :max_heap_size)
      assert size == div(@test_bound_bytes, @wordsize)

      # No byte-ratio assertion here on purpose: `total_heap_size` right after
      # Identify swings ~10x with GC timing and run load (see @test_bound_bytes),
      # so a ratio threshold would be a flaky test of the collector rather than
      # of the flag. The property that matters — a bound that does not kill
      # HEALTHY sessions — is pinned behaviourally instead, by the sibling
      # session in the kill test below: it shares this same bound, reads
      # everything it is sent, and must survive the flood.
      assert size > 0
    end)
  end

  test "the default is used when config is absent or unusable", %{port: _port} do
    original = Application.get_env(:cytale, Cytale.Config) || []
    on_exit(fn -> Application.put_env(:cytale, Cytale.Config, original) end)

    for value <- [:garbage, nil, 0, -5] do
      Application.put_env(
        :cytale,
        Cytale.Config,
        Keyword.put(original, :gateway_socket_max_heap_bytes, value)
      )

      assert Cytale.Config.gateway_socket_max_heap_bytes() == 16 * 1024 * 1024
    end
  end

  # The test above proves the ACCESSOR clamps correctly, which is why the #52
  # wiring bug survived it: the accessor was fine, and the env var never reached
  # it. `config/runtime.exs` wrote `:cytale, :gateway, socket_max_heap_bytes`
  # while the accessor read `:cytale, Cytale.Config, :gateway_socket_max_heap_bytes`
  # — a different scope AND a different key name — so GATEWAY_SOCKET_MAX_HEAP_BYTES
  # was inert and every socket kept the compile-time default.
  #
  # runtime.exs does not execute in the test env, so this cannot be behavioural:
  # assert the wiring itself, textually, which is exactly the check that would
  # have failed before the fix.
  test "runtime.exs writes the cap where the accessor reads it", %{port: _port} do
    runtime = File.read!("config/runtime.exs")

    # Executable lines only. The comment above this write names the OLD orphan
    # key to explain the bug, and counting prose would make this assertion fail
    # on its own documentation (observed: 6 vs 5 on the first run).
    code =
      runtime
      |> String.split("\n")
      |> Enum.reject(&String.starts_with?(String.trim_leading(&1), "#"))
      |> Enum.join("\n")

    # `flunk` rather than `assert code =~ ...`: a failed =~ prints the entire
    # runtime.exs as the left-hand side, which buries the actual message.
    unless code =~ "config :cytale, Cytale.Config, gateway_socket_max_heap_bytes:" do
      flunk(
        "config/runtime.exs does not write gateway_socket_max_heap_bytes to " <>
          "Cytale.Config — the scope AND key the accessor reads — so " <>
          "GATEWAY_SOCKET_MAX_HEAP_BYTES would be inert"
      )
    end

    # Every mention of `socket_max_heap_bytes` in CODE must be the PREFIXED key
    # the accessor reads. A bare `socket_max_heap_bytes:` — the orphan this test
    # exists to prevent — fails it, and the substring form keeps the assertion
    # independent of formatting and indentation.
    prefixed = length(Regex.scan(~r/gateway_socket_max_heap_bytes/, code))
    total = length(Regex.scan(~r/socket_max_heap_bytes/, code))

    assert total == prefixed,
           "config/runtime.exs mentions a bare `socket_max_heap_bytes` key " <>
             "(#{total} occurrences vs #{prefixed} prefixed) — the accessor reads " <>
             "`gateway_socket_max_heap_bytes`, so a bare key is dead config"
  end

  # -- the bound actually bounds --------------------------------------------------

  test "a stalled client is killed at the bound, and a sibling session is untouched",
       %{port: port} do
    with_socket_bound(@test_bound_bytes, fn ->
      token_a = run_token()
      token_b = run_token()

      {_ws, ch} = workspace!(token_a, [token_b], ["general"])

      # The sibling reads normally; the stalled session stops reading.
      {sibling, sibling_ready} = identify_on(port, token_a)
      drain_pending!(sibling)

      {stalled, stalled_ready} = identify_on(port, token_b)
      drain_pending!(stalled)

      stalled_pid = session_socket_pid(stalled_ready["user"]["id"])
      ref = Process.monitor(stalled_pid)

      # The client stops draining: its kernel buffers fill, the server's writes
      # stop completing, and the fan-out's sends become the socket's backlog.
      :ok = Cytale.Test.WSClient.pause(stalled.pid)

      flood(stalled_pid, 60_000)

      assert_receive {:DOWN, ^ref, :process, ^stalled_pid, reason}, 15_000

      # `:killed` is the VM's max_heap_size kill, and it is untrappable — which
      # is why terminate/1 does not run on this path and the session's drop
      # goes unrecorded.
      assert reason == :killed

      # Blast radius: the sibling session is still live and still receiving.
      # A message on the same channel reaches it, through the real seam. This is
      # also the pin that the bound does not kill HEALTHY sessions — it shares
      # the same configured bound, read everything it was sent, and was never
      # stalled (the contract test asserts no byte-ratio, which would only test
      # the collector).
      assert Process.alive?(session_socket_pid(sibling_ready["user"]["id"]))

      assert FanOut.deliver(
               ch.general,
               {"MessageUpdate", %{"id" => "9", "channel_id" => Integer.to_string(ch.general)}}
             ) >= 1

      assert next_event!(sibling, "MessageUpdate", 5_000)["d"]["id"] == "9"

      # …and the killed client RECOVERS by resuming, not by re-identifying and
      # full-syncing: the bound costs it its connection, not its session. (The
      # request carries seq 0 — this socket's buffered seqs start at its
      # join-time announces, and replay is `seq`-exclusive.)
      resumed = connect!(port)

      send_frame!(resumed, 5, %{
        "token" => token_b,
        "session_id" => stalled_ready["session_id"],
        "seq" => 0,
        "resume_token" => stalled_ready["resume_token"]
      })

      assert %{"t" => "Resumed"} = next_event!(resumed, "Resumed", 5_000)
    end)
  end
end
