defmodule Cytale.Test.WSClient do
  @moduledoc """
  Minimal RFC 6455 WebSocket client for gateway wire tests.

  Speaks just enough of the protocol to exercise the gateway over a real
  Bandit listener: opening handshake, masked client frames (text/binary),
  server frame parsing (text/binary/close), automatic pong replies, and a
  receive queue with timeout semantics. No TLS; per-frame compression is
  applied by the caller (one-shot), mirroring the server's stream discipline.

  The socket is owned by this GenServer; tests call `recv/2` on the pid.
  """

  use GenServer
  import Bitwise

  @guid "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  @op_continuation 0x0
  @op_text 0x1
  @op_binary 0x2
  @op_close 0x8
  @op_ping 0x9
  @op_pong 0xA

  defstruct [
    :socket,
    :decoder,
    buffer: <<>>,
    queue: :queue.new(),
    waiters: :queue.new(),
    closed: nil,
    counts: %{text: 0, binary: 0},
    # #52 slow-consumer simulation: set by pause/1, cleared by resume/1. While
    # true the socket is left passive (its `active: :once` is spent) so no
    # further data is drained and the peer's writes stop completing.
    paused: false
  ]

  # -- Client API --------------------------------------------------------------

  @doc "Connect + perform the WebSocket handshake. Returns {:ok, pid} or {:error, reason}."
  @spec start_link(:inet.ip_address(), :inet.port_number(), String.t(), term()) ::
          {:ok, pid()} | {:error, term()}
  def start_link(ip, port, path, compress_mode \\ nil, extra_headers \\ []) do
    GenServer.start_link(__MODULE__, {ip, port, path, compress_mode, extra_headers})
  end

  @doc """
  Raw transport frame counters (`%{text: n, binary: n}`) — lets tests pin
  WHICH frames rode the wire as binary (transport compression sends EVERY
  frame binary, payload compression keeps handshake frames text).
  """
  @spec frame_counts(pid()) :: %{text: non_neg_integer(), binary: non_neg_integer()}
  def frame_counts(pid), do: GenServer.call(pid, :frame_counts)

  @doc """
  Stop reading from the socket — the SLOW-CONSUMER simulation (#52).

  The client holds its `active: :once` consumed and never re-arms, so nothing
  drains out of the kernel buffer; the server's writes stop completing and its
  per-session mailbox BECOMES the backlog, exactly as a stalled or hostile
  client does on the wire. Frames already received stay queued and are
  readable after `resume/1`.
  """
  @spec pause(pid()) :: :ok
  def pause(pid), do: GenServer.call(pid, :pause)

  @doc "Re-arm reading after `pause/1`."
  @spec resume(pid()) :: :ok
  def resume(pid), do: GenServer.call(pid, :resume)

  @doc "Send a TEXT frame (masked)."
  def send_text(pid, payload), do: GenServer.cast(pid, {:send, @op_text, payload})

  @doc "Send a BINARY frame (masked)."
  def send_binary(pid, payload), do: GenServer.cast(pid, {:send, @op_binary, payload})

  @doc """
  Next inbound message: `{:text, binary()} | {:binary, binary()} | {:closed, code | nil}`.
  Blocks up to `timeout` ms, then returns {:error, :timeout}.
  """
  @spec recv(pid(), non_neg_integer()) ::
          {:text, binary()}
          | {:binary, binary()}
          | {:closed, integer() | nil}
          | {:error, :timeout}
  def recv(pid, timeout \\ 5_000) do
    GenServer.call(pid, {:recv, timeout}, timeout + 5_000)
  end

  @doc "Initiate the close handshake (masked close frame with `code`)."
  def close(pid, code \\ 1000), do: GenServer.cast(pid, {:close, code})

  @doc "Stop the client and close the TCP socket."
  def stop(pid) do
    GenServer.stop(pid, :normal)
  end

  # -- Server (GenServer) --------------------------------------------------------

  @impl true
  def init({ip, port, path, compress_mode, extra_headers}) do
    with {:ok, socket} <-
           :gen_tcp.connect(
             ip,
             port,
             [:binary, packet: :raw, active: false, nodelay: true],
             5_000
           ),
         {:ok, leftover} <- handshake(socket, path, extra_headers) do
      # The server may pipeline its first frame in the same segment as the
      # 101 response — feed any leftover bytes straight into the parser.
      #
      # Compressed sessions get a PERSISTENT decoder (zstd shared-history /
      # zlib sync-flush streams are meaningless frame-by-frame), built from
      # the WIRE CONTRACT rather than the server's `Cytale.Gateway.Compression`
      # (#61/#63 gate constraint): a harness that inflates with the encoder's
      # own code agrees with the server by construction and cannot observe a
      # wire-format divergence — which is exactly how raw-DEFLATE transport
      # shipped against a zlib-stream contract.
      decoder = compress_mode && open_inflater(compress_mode)

      state =
        parse_frames(%__MODULE__{socket: socket, decoder: decoder, buffer: leftover})

      :inet.setopts(socket, active: :once)
      {:ok, state}
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  defp handshake(socket, path, extra_headers) do
    key =
      :crypto.strong_rand_bytes(16)
      |> Base.encode64()

    request =
      "GET #{path} HTTP/1.1\r\n" <>
        "Host: 127.0.0.1\r\n" <>
        "Upgrade: websocket\r\n" <>
        "Connection: Upgrade\r\n" <>
        "Sec-WebSocket-Key: #{key}\r\n" <>
        "Sec-WebSocket-Version: 13\r\n" <>
        Enum.map_join(extra_headers, fn {name, value} -> "#{name}: #{value}\r\n" end) <>
        "\r\n"

    :ok = :gen_tcp.send(socket, request)
    {:ok, header, leftover} = read_http_header(socket, <<>>)

    cond do
      not String.contains?(header, " 101 ") ->
        {:error, {:handshake_failed, header}}

      true ->
        expected =
          :crypto.hash(:sha, key <> @guid)
          |> Base.encode64()

        if String.contains?(header, expected) do
          {:ok, leftover}
        else
          {:error, :bad_accept}
        end
    end
  end

  defp read_http_header(socket, buf) do
    case :binary.split(buf, "\r\n\r\n") do
      [header, rest] -> {:ok, header, rest}
      [_] -> read_http_header(socket, buf <> recv_raw(socket))
    end
  end

  defp recv_raw(socket) do
    {:ok, data} = :gen_tcp.recv(socket, 0, 5_000)
    data
  end

  @impl true
  def handle_cast({:send, opcode, payload}, state) do
    :ok = :gen_tcp.send(state.socket, encode_frame(opcode, payload))
    {:noreply, state}
  end

  def handle_cast({:close, code}, state) do
    :ok = :gen_tcp.send(state.socket, encode_frame(@op_close, <<code::16>>))
    {:noreply, state}
  end

  @impl true
  def handle_call(:frame_counts, _from, state), do: {:reply, state.counts, state}

  def handle_call(:pause, _from, state), do: {:reply, :ok, %{state | paused: true}}

  def handle_call(:resume, _from, state) do
    state = %{state | paused: false}
    # Re-arm only with a live socket; a paused client may have been closed by
    # the peer meanwhile (which is the point of the bound under test).
    state =
      if (state.socket && is_port(state.socket)) and not state.closed,
        do: activate(state),
        else: state

    {:reply, :ok, state}
  end

  def handle_call({:recv, timeout}, from, state) do
    case :queue.out(state.queue) do
      {{:value, msg}, queue} ->
        {:reply, msg, %{state | queue: queue}}

      {:empty, _} ->
        if state.closed do
          {:reply, {:closed, state.closed}, state}
        else
          Process.send_after(self(), {:recv_timeout, from}, timeout)
          {:noreply, %{state | waiters: :queue.in(from, state.waiters)}}
        end
    end
  end

  @impl true
  def handle_info({:tcp, socket, data}, %{socket: socket} = state) do
    state = parse_frames(%{state | buffer: state.buffer <> data})
    # A paused client does NOT re-arm: the `active: :once` is spent, so the
    # kernel keeps whatever arrives next and the peer's writes stop draining.
    if state.paused, do: {:noreply, state}, else: {:noreply, activate(state)}
  end

  def handle_info({:tcp_closed, _socket}, state) do
    state = %{state | closed: state.closed || :tcp_closed}
    {:noreply, flush_waiters(state)}
  end

  def handle_info({:tcp_error, _socket, reason}, state) do
    state = %{state | closed: state.closed || reason}
    {:noreply, flush_waiters(state)}
  end

  def handle_info({:recv_timeout, from}, state) do
    if :queue.member(from, state.waiters) do
      waiters = :queue.delete(from, state.waiters)
      GenServer.reply(from, {:error, :timeout})
      {:noreply, %{state | waiters: waiters}}
    else
      {:noreply, state}
    end
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def terminate(_reason, state) do
    if state.socket && is_port(state.socket), do: :gen_tcp.close(state.socket)
    :ok
  end

  # -- internals -----------------------------------------------------------------

  defp activate(state) do
    :inet.setopts(state.socket, active: :once)
    state
  end

  defp flush_waiters(state) do
    case :queue.out(state.waiters) do
      {:empty, _} ->
        state

      {{:value, from}, rest} ->
        GenServer.reply(from, {:closed, state.closed})
        flush_waiters(%{state | waiters: rest})
    end
  end

  defp deliver(state, msg) do
    case :queue.out(state.waiters) do
      {:empty, _} ->
        %{state | queue: :queue.in(msg, state.queue)}

      {{:value, from}, rest} ->
        GenServer.reply(from, msg)
        %{state | waiters: rest}
    end
  end

  defp count_frame(state, @op_text),
    do: %{state | counts: Map.update!(state.counts, :text, &(&1 + 1))}

  defp count_frame(state, @op_binary),
    do: %{state | counts: Map.update!(state.counts, :binary, &(&1 + 1))}

  defp count_frame(state, _op), do: state

  # Parse as many complete frames out of the buffer as possible.
  defp parse_frames(%{buffer: buffer} = state) do
    case parse_one(buffer) do
      :incomplete ->
        state

      {:ok, frame, rest} ->
        state
        |> apply_frame(frame)
        |> Map.put(:buffer, rest)
        |> parse_frames()
    end
  end

  defp parse_one(buffer) do
    case buffer do
      <<op_byte::8, len7::8, rest::binary>> when len7 < 126 ->
        take_payload(op_byte, len7, rest)

      <<op_byte::8, 126::8, len16::16, rest::binary>> ->
        take_payload(op_byte, len16, rest)

      <<op_byte::8, 127::8, len64::64, rest::binary>> ->
        take_payload(op_byte, len64, rest)

      _ ->
        :incomplete
    end
  end

  defp take_payload(op_byte, len, rest) do
    case rest do
      <<payload::size(len)-binary, tail::binary>> ->
        {:ok, %{opcode: band(op_byte, 0x0F), fin: band(op_byte, 0x80) != 0, payload: payload}, tail}

      _ ->
        :incomplete
    end
  end

  defp apply_frame(state, %{opcode: op, payload: payload}) do
    state = count_frame(state, op)

    case op do
      @op_text ->
        deliver(state, {:text, payload})

      @op_binary ->
        # Persistent-context decompression through the CONTRACT inflater.
        case client_decode(state.decoder, payload) do
          {:ok, json} -> deliver(state, {:text, json})
          {:error, reason} -> deliver(state, {:decode_error, inspect(reason)})
        end

      @op_close ->
        code =
          case payload do
            <<code::16, _reason::binary>> -> code
            _ -> nil
          end

        # Echo a close back (RFC 6455 §5.5.1) then record the closure.
        :ok = :gen_tcp.send(state.socket, encode_frame(@op_close, payload))
        state = %{state | closed: state.closed || code}
        deliver(state, {:closed, code})

      @op_ping ->
        :ok = :gen_tcp.send(state.socket, encode_frame(@op_pong, payload))
        state

      @op_pong ->
        state

      @op_continuation ->
        # The server never fragments in these tests; treat as text payload.
        deliver(state, {:text, payload})

      _other ->
        state
    end
  end

  # -- contract inflaters --------------------------------------------------------

  # Client-side inflaters, written from the WIRE CONTRACT (never from the
  # server's `Compression` module — see the init/1 note):
  #
  #   * `:zlib_stream` (the payload `d.compress` negotiation) — raw DEFLATE,
  #     the native codec (#27; what the web client's
  #     `DecompressionStream('deflate-raw')` expects).
  #   * `:zlib_stream_transport` (`?compress=zlib-stream` on the URL) — a ZLIB
  #     stream, window bits 15: what Discord sends and what every conformant
  #     library inflates with (discord.py `zlib.decompressobj()`, Node
  #     `zlib.createInflate()`).
  #   * `:zstd_stream` — the `:ezstd` streaming context.
  defp open_inflater(:zlib_stream), do: zlib_inflater(-15)
  defp open_inflater(:zlib_stream_transport), do: zlib_inflater(15)
  defp open_inflater(:zstd_stream), do: {:zstd, :ezstd.create_decompression_context(4096)}

  defp zlib_inflater(window_bits) do
    z = :zlib.open()
    :ok = :zlib.inflateInit(z, window_bits)
    {:zlib, z}
  end

  defp client_decode({:zlib, z}, bin) do
    {:ok, IO.iodata_to_binary(:zlib.inflate(z, bin))}
  catch
    _, reason -> {:error, reason}
  end

  defp client_decode({:zstd, ctx}, bin) do
    case :ezstd.decompress_streaming(ctx, bin) do
      out when is_list(out) -> {:ok, IO.iodata_to_binary(out)}
      out when is_binary(out) -> {:ok, out}
      err -> {:error, err}
    end
  rescue
    e -> {:error, e}
  end

  # -- frame encoding (client frames are ALWAYS masked) ---------------------------

  defp encode_frame(opcode, payload) do
    len = byte_size(payload)
    mask = :crypto.strong_rand_bytes(4)
    masked = mask_payload(payload, mask, 0, [])

    head =
      cond do
        len < 126 -> <<bor(0x80, opcode)::8, bor(0x80, len)::8>>
        len <= 0xFFFF -> <<bor(0x80, opcode)::8, bor(0x80, 126)::8, len::16>>
        true -> <<bor(0x80, opcode)::8, bor(0x80, 127)::8, len::64>>
      end

    IO.iodata_to_binary([head, mask, masked])
  end

  defp mask_payload(<<b, rest::binary>>, mask, i, acc) do
    key = :binary.at(mask, rem(i, 4))
    mask_payload(rest, mask, i + 1, [bxor(b, key) | acc])
  end

  defp mask_payload(<<>>, _mask, _i, acc), do: IO.iodata_to_binary(Enum.reverse(acc))
end
