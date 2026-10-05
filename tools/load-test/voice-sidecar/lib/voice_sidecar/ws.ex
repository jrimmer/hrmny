defmodule VoiceSidecar.WS do
  @moduledoc """
  Minimal RFC 6455 WebSocket client for the voice sidecar — a ported SUBSET of
  `apps/server/test/support/ws_client.ex` (the doctrine boundary is documented
  in README.md: the TS harness stays codec-authoritative; this client speaks
  just enough framing for a participant signaling leg).

  Differences from the server's test client: no compression (the sidecar
  Identifies with `compress: null`, so the wire is text-only), no frame
  counters, host-by-name connect. Same handshake (Sec-WebSocket-Key/Accept),
  masked client frames, auto-pong, and a receive queue with timeout
  semantics. The socket is owned by this GenServer; the participant's reader
  process blocks in `recv/2`.

  Hardening (S-2/R-3/R-9):

    * TLS — `start_link/4` with `tls: true` dials the gateway over `:ssl`
      with OTP's DEFAULT verification (system cacerts + hostname check; a
      load tool does not get to opt out). Plaintext `:gen_tcp` stays the
      default for the loopback load-test topology; a non-loopback host over
      plaintext still connects but logs one loud warning, because the
      Identify bearer crosses that socket.
    * Frame cap — a frame DECLARING more than `@max_frame_bytes` is refused
      (socket closed, leg demoted to `{:closed, :frame_too_large}`); a buffer
      that grows past the same bound without yielding a frame means the wire
      has desynced and is closed the same way (`:buffer_overflow`).
    * Send safety — every socket write is guarded: a send racing a dead
      socket demotes the leg to the closed state instead of crashing the
      GenServer (the participant's reader learns via `recv/2`).
  """

  use GenServer
  import Bitwise

  require Logger

  @guid "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  # THE inbound frame cap (one source of truth for both the declared-length
  # rejection and the buffer ceiling — S-2/R-9). Not the same constant as the
  # OUTBOUND `@max_size_bytes` in VoiceSidecar (the server's 128 KiB
  # CALL_SIGNAL clamp): inbound signaling frames are capped an order of
  # magnitude above anything the gateway legitimately sends, so an oversize
  # declaration is always a desync or an attack, never real traffic.
  @max_frame_bytes 1_048_576
  # A COMPLETE frame may legitimately occupy 10 header bytes + the cap, so
  # the ceiling fires only once a buffer has grown PAST that bound — i.e.
  # it holds no frame this parser would ever accept.
  @buffer_ceiling @max_frame_bytes + 14

  @op_close 0x8
  @op_ping 0x9
  @op_pong 0xA
  @op_text 0x1

  @enforce_keys [:socket]
  defstruct [:socket, transport: :tcp, buffer: <<>>, queue: :queue.new(), waiters: :queue.new(), closed: nil]

  # -- Client API --------------------------------------------------------------

  @doc "Connect + handshake. Returns {:ok, pid} or {:error, reason}."
  @spec start_link(String.t(), :inet.port_number(), String.t(), keyword()) ::
          {:ok, pid()} | {:error, term()}
  def start_link(host, port, path, opts \\ []) do
    GenServer.start_link(__MODULE__, {host, port, path, opts})
  end

  @doc "Send a TEXT frame (masked)."
  @spec send_text(pid(), iodata()) :: :ok
  def send_text(pid, payload), do: GenServer.cast(pid, {:send, @op_text, payload})

  @doc """
  Next inbound message: `{:text, binary()} | {:closed, code | reason} | {:error, :timeout}`.
  """
  @spec recv(pid(), non_neg_integer()) ::
          {:text, binary()} | {:closed, integer() | atom() | nil} | {:error, :timeout}
  def recv(pid, timeout \\ 5_000) do
    GenServer.call(pid, {:recv, timeout}, timeout + 5_000)
  end

  @doc "Close the socket and stop the client."
  @spec stop(pid()) :: :ok
  def stop(pid) do
    GenServer.stop(pid, :normal)
  catch
    :exit, _ -> :ok
  end

  # -- Server ------------------------------------------------------------------

  @impl true
  def init({host, port, path, opts}) do
    tls? = Keyword.get(opts, :tls, false)
    transport = if tls?, do: :ssl, else: :gen_tcp
    host_charlist = String.to_charlist(host)

    # The Identify bearer crosses this socket. Plaintext is the sanctioned
    # default for the loopback load-test topology; off loopback it is a
    # posture decision someone must have made, so say so — once, at connect.
    if not tls? and not loopback?(host) do
      Logger.warning(
        "voice-sidecar WS: PLAINTEXT gateway connection to non-loopback host " <>
          "#{host}:#{port} (the Identify bearer travels in the clear) — " <>
          "set VOICE_GATEWAY_TLS=1 for TLS"
      )
    end

    with {:ok, socket} <- connect(transport, host_charlist, port),
         {:ok, leftover} <- handshake(transport, socket, path) do
      # The server may pipeline its first frame in the same segment as the
      # 101 response — feed any leftover bytes straight into the parser.
      state = parse_frames(%__MODULE__{socket: socket, transport: transport, buffer: leftover}, nil)
      set_active_once(state)
      {:ok, state}
    else
      {:error, reason} -> {:stop, reason}
    end
  end

  # TLS with OTP's default verification: `:ssl.connect` without verify/cacerts
  # options resolves to verify_peer + the OS trust store + hostname check on
  # current OTP — exactly the posture we want, and it fails LOUDLY on a box
  # with no trust store rather than silently dialing insecurely.
  defp connect(:ssl, host, port) do
    :ssl.connect(host, port, [:binary, packet: :raw, active: false, nodelay: true], 10_000)
  end

  defp connect(:gen_tcp, host, port) do
    :gen_tcp.connect(host, port, [:binary, packet: :raw, active: false, nodelay: true], 10_000)
  end

  defp loopback?(host) do
    host == "localhost" or host == "::1" or String.starts_with?(host, "127.")
  end

  defp handshake(transport, socket, path) do
    key = :crypto.strong_rand_bytes(16) |> Base.encode64()

    request =
      "GET #{path} HTTP/1.1\r\n" <>
        "Host: cytale-sidecar\r\n" <>
        "Upgrade: websocket\r\n" <>
        "Connection: Upgrade\r\n" <>
        "Sec-WebSocket-Key: #{key}\r\n" <>
        "Sec-WebSocket-Version: 13\r\n\r\n"

    :ok = t_send!(transport, socket, request)
    {:ok, header, leftover} = read_http_header(transport, socket, <<>>)

    cond do
      not String.contains?(header, " 101 ") ->
        {:error, {:handshake_failed, header}}

      true ->
        expected = :crypto.hash(:sha, key <> @guid) |> Base.encode64()

        if String.contains?(header, expected) do
          {:ok, leftover}
        else
          {:error, :bad_accept}
        end
    end
  end

  defp read_http_header(transport, socket, buf) do
    case :binary.split(buf, "\r\n\r\n") do
      [header, rest] -> {:ok, header, rest}
      [_] -> read_http_header(transport, socket, buf <> recv_raw(transport, socket))
    end
  end

  defp recv_raw(transport, socket) do
    {:ok, data} = t_recv!(transport, socket)
    data
  end

  @impl true
  def handle_cast({:send, opcode, payload}, state) do
    case t_send(state, encode_frame(opcode, payload)) do
      :ok ->
        {:noreply, state}

      # R-3: a send racing a close (server dropped mid-frame, our own close
      # reply after a refused frame) must demote the leg to the closed state,
      # not crash the GenServer — the participant's reader learns via recv/2.
      {:error, reason} ->
        {:noreply, state |> Map.update!(:closed, &(&1 || reason)) |> flush_waiters()}
    end
  end

  @impl true
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

  # TCP and TLS both deliver `{:proto, socket, data}` / `{:proto_closed, ...}` /
  # `{:proto_error, ...}` — one set of clauses covers both transports.
  @impl true
  def handle_info({proto, socket, data}, %{socket: socket} = state) when proto in [:tcp, :ssl] do
    state = parse_frames(%{state | buffer: state.buffer <> data}, <<>>)
    set_active_once(state)
    {:noreply, state}
  end

  def handle_info({kind, _socket}, state) when kind in [:tcp_closed, :ssl_closed] do
    state = state |> Map.update!(:closed, &(&1 || :tcp_closed)) |> flush_waiters()
    {:noreply, state}
  end

  def handle_info({kind, _socket, reason}, state) when kind in [:tcp_error, :ssl_error] do
    state = state |> Map.update!(:closed, &(&1 || reason)) |> flush_waiters()
    {:noreply, state}
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

  @impl true
  def terminate(_reason, state) do
    t_close(state)
    :ok
  end

  # -- transport helpers (the only transport-specific code in the module) ---------

  # Guarded send (R-3): every runtime write goes through here; a dead socket
  # yields {:error, reason} instead of a crash.
  defp t_send(%__MODULE__{transport: :ssl, socket: socket}, frame), do: :ssl.send(socket, frame)
  defp t_send(%__MODULE__{transport: :tcp, socket: socket}, frame), do: :gen_tcp.send(socket, frame)

  # Strict send for the handshake: a failure here is a CONNECT failure, so it
  # raises out of init (GenServer normalizes that into {:error, reason} from
  # start_link) — there is no live leg to demote to a closed state yet.
  defp t_send!(transport, socket, frame) do
    case apply(transport, :send, [socket, frame]) do
      :ok -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  defp t_recv!(:ssl, socket), do: :ssl.recv(socket, 0, 10_000)
  defp t_recv!(:gen_tcp, socket), do: :gen_tcp.recv(socket, 0, 10_000)

  defp set_active_once(%__MODULE__{transport: :ssl, socket: socket}), do: :ssl.setopts(socket, active: :once)
  defp set_active_once(%__MODULE__{transport: :tcp, socket: socket}), do: :inet.setopts(socket, active: :once)

  defp t_close(%__MODULE__{transport: :ssl, socket: socket}) do
    case :ssl.close(socket) do
      :ok -> :ok
      {:error, _} -> :ok
    end
  end

  defp t_close(%__MODULE__{transport: :tcp, socket: socket}) do
    case :gen_tcp.close(socket) do
      :ok -> :ok
      {:error, _} -> :ok
    end
  end

  # -- internals -----------------------------------------------------------------

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

  # Parse as many complete frames as possible. Bandit never fragments on this
  # wire (the server's test client makes the same assumption); a continuation
  # is tolerated as a text payload.
  defp parse_frames(state, _acc) do
    case parse_one(state.buffer) do
      :incomplete ->
        # S-2/R-9: growth past the ceiling with nothing parseable is a desynced
        # (or hostile) wire — close it cleanly rather than buffering forever.
        if byte_size(state.buffer) > @buffer_ceiling do
          close_now(state, :buffer_overflow)
        else
          state
        end

      :oversize ->
        # S-2: a frame DECLARING more than the cap is refused before a byte of
        # payload is buffered; the socket is closed with a clean reason.
        close_now(state, :frame_too_large)

      {:ok, frame, rest} ->
        state
        |> Map.put(:buffer, rest)
        |> apply_frame(frame, nil)
        |> parse_frames(nil)
    end
  end

  # A socket we closed ourselves: tear down the transport, demote the leg to
  # the closed state (the EXISTING closed machinery — waiters learn via
  # recv/2), and let the pending tcp_closed/ssl_closed be a no-op.
  defp close_now(state, reason) do
    t_close(state)
    state = state |> Map.update!(:closed, &(&1 || reason)) |> flush_waiters()
    %{state | buffer: <<>>}
  end

  defp parse_one(buffer) do
    case buffer do
      <<op_byte::8, len7::8, rest::binary>> when len7 < 126 ->
        take_payload(op_byte, len7, rest)

      <<op_byte::8, 126::8, len16::16, rest::binary>> ->
        # A 16-bit length tops out at 64 KiB — never over the cap.
        take_payload(op_byte, len16, rest)

      <<op_byte::8, 127::8, len64::64, rest::binary>> when len64 <= @max_frame_bytes ->
        take_payload(op_byte, len64, rest)

      <<_op::8, 127::8, _len64::64, _rest::binary>> ->
        :oversize

      _ ->
        :incomplete
    end
  end

  defp take_payload(op_byte, len, rest) do
    if byte_size(rest) >= len do
      payload = binary_part(rest, 0, len)
      tail = binary_part(rest, len, byte_size(rest) - len)
      {:ok, %{opcode: band(op_byte, 0x0F), fin: band(op_byte, 0x80) != 0, payload: payload}, tail}
    else
      :incomplete
    end
  end

  defp apply_frame(state, %{opcode: @op_text, payload: payload}, _acc) do
    deliver(state, {:text, payload})
  end

  defp apply_frame(state, %{opcode: 0x0, payload: payload}, _acc) do
    # Continuation — tolerated as text (the server never fragments).
    deliver(state, {:text, payload})
  end

  defp apply_frame(state, %{opcode: @op_close, payload: payload}, _acc) do
    code =
      case payload do
        <<code::16, _reason::binary>> -> code
        _ -> nil
      end

    # Echo the close (best-effort — the guarded send records a dead socket
    # instead of crashing, same posture as handle_cast({:send, ..})). The
    # close CODE stays the reported reason either way; the peer's own FIN
    # (or WS.stop/1) tears the socket down.
    _ = t_send(state, encode_frame(@op_close, payload))
    state |> Map.update!(:closed, &(&1 || code)) |> deliver({:closed, code})
  end

  defp apply_frame(state, %{opcode: @op_ping, payload: payload}, _acc) do
    case t_send(state, encode_frame(@op_pong, payload)) do
      :ok -> state
      {:error, reason} -> Map.update!(state, :closed, &(&1 || reason))
    end
  end

  defp apply_frame(state, %{opcode: @op_pong}, _acc), do: state
  defp apply_frame(state, _other, _acc), do: state

  # -- frame encoding (client frames are ALWAYS masked) ---------------------------

  defp encode_frame(opcode, payload) when is_binary(payload) do
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

  defp encode_frame(opcode, payload) when is_list(payload) do
    encode_frame(opcode, IO.iodata_to_binary(payload))
  end

  defp mask_payload(<<b, rest::binary>>, mask, i, acc) do
    key = :binary.at(mask, rem(i, 4))
    mask_payload(rest, mask, i + 1, [bxor(b, key) | acc])
  end

  defp mask_payload(<<>>, _mask, _i, acc), do: IO.iodata_to_binary(Enum.reverse(acc))
end
