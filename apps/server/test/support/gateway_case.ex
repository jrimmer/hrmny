defmodule Cytale.GatewayCase do
  @moduledoc """
  ExUnit case for U10 gateway wire tests: boots a REAL Bandit HTTP listener
  with `GET /gateway/websocket` upgraded to `CytaleWeb.GatewaySocket` on a
  per-module OS-assigned port, and provides envelope helpers speaking the U2
  gateway protocol exactly as the U15 TypeScript client does (TEXT frames
  when uncompressed, BINARY one-shot-compressed frames when compressed).

  The production Endpoint is NOT involved — it already binds :4001 for the
  whole test run. Each gateway listener is fully isolated.
  """

  use ExUnit.CaseTemplate

  using do
    quote do
      # Excluded from a no-database run (test_helper.exs).
      @moduletag :scylla

      import ExUnit.Assertions

      import Cytale.GatewayCase,
        only: [
          start_gateway!: 0,
          connect!: 1,
          connect!: 2,
          identify!: 2,
          identify!: 3,
          send_frame!: 3,
          send_frame!: 4,
          send_transport_binary!: 3,
          send_raw!: 2,
          send_close!: 2,
          next_frame: 2,
          next_json!: 2,
          next_event!: 3,
          next_op!: 3,
          refute_next_event!: 3,
          assert_closed!: 2,
          assert_closed!: 3,
          assert_closed_skipping!: 3,
          valid_token: 0,
          invalid_token: 0
        ]

      alias Cytale.Gateway.{Opcode, Session, SessionStore}
    end
  end

  @valid_token "cytale_" <> String.duplicate("a", 16)
  @invalid_token "notcytale_" <> String.duplicate("b", 16)

  def valid_token, do: @valid_token
  def invalid_token, do: @invalid_token

  @doc """
  Boots an isolated Bandit listener serving only the gateway upgrade route.
  Call once per test module (setup); returns the OS-assigned port. Listener
  processes are kept under the ExUnit supervisor-owned run so they die with
  the run.
  """
  def start_gateway! do
    # Gateway suites share one client IP; their combined Identify volume
    # legitimately exceeds the production burst cap within the window.
    Cytale.Gateway.AdmissionLimiter.reset()

    {:ok, sup} =
      Bandit.start_link(
        scheme: :http,
        port: 0,
        ip: {127, 0, 0, 1},
        plug: Cytale.GatewayCase.TestPlug
      )

    {:ok, {_ip, port}} = ThousandIsland.listener_info(sup)
    # No explicit teardown: the listener is linked to the test process and
    # dies with it.
    port
  end

  @doc """
  Opens a raw gateway WebSocket and waits for the Hello frame. Opts:

    * `:compress` — requested PAYLOAD compression mode (`"zlib_stream"`, `"zstd_stream"`)
    * `:v` — connection-URL version (`?v=N` — the compat arrival path via
      `/gateway/bot`; Hello echoes it back)
    * `:query` — extra raw query string appended (`"compress=zlib-stream&encoding=json"`)
    * `:transport_compress` — `?compress=zlib-stream` TRANSPORT compression:
      every frame (Hello included) rides the shared zlib stream, so the
      client speaks binary from the first byte and sends its Identify
      compressed too
  """
  def connect!(port, opts \\ []) do
    ws_mode =
      case Keyword.get(opts, :compress) do
        "zstd_stream" -> :zstd_stream
        "zlib_stream" -> :zlib_stream
        _ -> nil
      end

    transport? = Keyword.get(opts, :transport_compress, false)

    ws_mode =
      if transport? do
        if ws_mode, do: raise("transport_compress and compress are mutually exclusive")
        # The TRANSPORT stream is zlib-wrapped (#61 item 3): its own contract
        # inflater, distinct from the payload `zlib_stream` (raw DEFLATE).
        :zlib_stream_transport
      else
        ws_mode
      end

    query =
      [
        Keyword.get(opts, :v) && "v=#{Keyword.get(opts, :v)}",
        transport? && "compress=zlib-stream",
        Keyword.get(opts, :query)
      ]
      |> Enum.reject(&is_nil/1)
      |> case do
        [] -> ""
        parts -> "?" <> Enum.join(parts, "&")
      end

    {:ok, pid} =
      Cytale.Test.WSClient.start_link(
        {127, 0, 0, 1},
        port,
        "/gateway/websocket" <> query,
        ws_mode
      )

    hello =
      case recv_json(pid, 5_000) do
        {:ok, json} -> json
        :closed -> flunk!("connection closed before Hello")
      end

    unless is_map(hello) and hello["op"] == 10 do
      flunk!("expected Hello (op 10) after connect, got: #{inspect(hello)}")
    end

    %{
      port: port,
      pid: pid,
      hello: hello,
      compress: Keyword.get(opts, :compress),
      transport_compress: transport?
    }
  end

  @doc """
  Performs the Identify handshake on `conn` and waits for the READY dispatch
  (native `Ready` or compat `READY`). Returns the READY `d` payload. Opts:
  `:token`, `:v`, `:raw_d` (verbatim `d`), `:intents` (compat).
  """
  def identify!(conn, token_or_opts \\ [], opts \\ [])

  def identify!(conn, token, opts) when is_binary(token) do
    do_identify(conn, token, opts)
  end

  def identify!(conn, opts, _extra) when is_list(opts), do: do_identify(conn, valid_token(), opts)

  defp do_identify(conn, token, opts) do
    d =
      case Keyword.get(opts, :raw_d) do
        nil ->
          # Handshake rides plaintext; compression starts AFTER negotiation
          # (transport-compressed connections excepted — their whole wire is
          # the zlib stream).
          %{
            "token" => token,
            "v" => Keyword.get(opts, :v, 1),
            "compress" => conn.compress,
            "properties" => %{"os" => "test", "browser" => "gateway_case", "device" => "test"}
          }
          |> maybe_intents(opts)

        raw ->
          raw
      end

    send_frame!(conn, 2, d)

    case next_frame(conn, 5_000) do
      {:ok, %{"op" => 0, "t" => ready_t, "s" => 0, "d" => ready}}
      when ready_t in ["Ready", "READY"] ->
        ready

      {:ok, other} ->
        flunk!("expected READY dispatch after Identify, got: #{inspect(other)}")

      # `next_frame/2` reports a close as `{:closed, code}` — and the code can be
      # the ATOM `:tcp_closed`, not a number. Matching the bare `:closed` here
      # turned an actual closed connection into a bare CaseClauseError that hid
      # the cause.
      {:closed, code} ->
        flunk!("connection closed during Identify (#{inspect(code)})")
    end
  end

  defp maybe_intents(d, opts) do
    case Keyword.get(opts, :intents) do
      nil -> d
      intents -> Map.put(d, "intents", intents)
    end
  end

  @doc """
  Sends an envelope frame as a plain JSON TEXT frame. Client frames are
  always uncompressed: payload compression is server→client only, and
  transport compression does not change that (#61 item 4 — no client library
  compresses outbound, discord.py has no compressor at all). A
  `?compress=zlib-stream` connection therefore still receives Identify and
  every other command as TEXT.

  `send_transport_binary!/3` covers the other case (a compressed client frame
  riding the transport stream), which no shipped library does but the wire
  accepts.
  """
  def send_frame!(conn, op, d, extra \\ nil) do
    frame = %{"op" => op, "d" => d}
    frame = if extra, do: Map.merge(frame, extra), else: frame
    push(conn, Jason.encode!(frame))
  end

  @doc """
  Sends one frame as a BINARY member of the transport zlib stream.
  """
  def send_transport_binary!(conn, op, d) do
    json = Jason.encode!(%{"op" => op, "d" => d})
    Cytale.Test.WSClient.send_binary(conn.pid, transport_deflate(json))
    :ok
  end

  @doc "Sends a raw string frame (for malformed-input tests)."
  def send_raw!(conn, json) when is_binary(json), do: push(conn, json)

  @doc "Sends a websocket-level close frame with `code`."
  def send_close!(conn, code), do: Cytale.Test.WSClient.close(conn.pid, code)

  defp push(conn, json) do
    Cytale.Test.WSClient.send_text(conn.pid, json)
    :ok
  end

  defp transport_deflate(json) do
    # The CLIENT's contract for a compressed member: a zlib stream (window
    # bits 15) — what a conformant library would send, built here rather than
    # by importing the server's codec (see ws_client's contract-inflater
    # note). Sync-flushed so the server's persistent inflater stays alive
    # across frames (a terminated member would end the shared stream).
    z = :zlib.open()
    :ok = :zlib.deflateInit(z, 6, :deflated, 15, 8, :default)
    data = IO.iodata_to_binary(:zlib.deflate(z, json, :sync))
    :zlib.close(z)
    data
  end

  @doc """
  Awaits the next gateway message:
    `{:ok, decoded}` | `:closed`.
  Flunks on timeout.
  """
  def next_frame(conn, timeout) do
    case Cytale.Test.WSClient.recv(conn.pid, timeout) do
      {:text, data} -> {:ok, Jason.decode!(data)}
      {:binary, data} -> {:ok, Jason.decode!(one_shot_decompress(conn.compress, data))}
      {:closed, code} -> {:closed, code}
      {:error, :timeout} -> flunk!("timed out after #{timeout}ms waiting for a gateway frame")
    end
  end

  # Non-flunking variant for wait-or-absence assertions (refute_next_event!,
  # deadline checks in next_event!/next_op!): `:timeout` is a value here.
  defp next_frame_soft(conn, timeout) do
    case Cytale.Test.WSClient.recv(conn.pid, timeout) do
      {:text, data} -> {:ok, Jason.decode!(data)}
      {:binary, data} -> {:ok, Jason.decode!(one_shot_decompress(conn.compress, data))}
      {:closed, code} -> {:closed, code}
      {:error, :timeout} -> :timeout
    end
  end

  @doc "Awaits the next frame and returns its decoded JSON (flunks if closed)."
  def next_json!(conn, timeout) do
    case next_frame(conn, timeout) do
      {:ok, json} -> json
      {:closed, code} -> flunk!("expected a frame, connection closed (#{inspect(code)})")
    end
  end

  @doc """
  Awaits a frame whose `t` equals `event`, skipping unrelated interleaved
  dispatches (presence/typing fan-outs from other fixtures have no wire
  ordering guarantee against the event under test). Flunks on close or when
  the deadline passes without the event.
  """
  def next_event!(conn, event, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_next_event(conn, event, deadline)
  end

  defp do_next_event(conn, event, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case next_frame_soft(conn, remaining) do
      {:ok, %{"t" => ^event} = json} ->
        json

      {:ok, _interleaved} ->
        do_next_event(conn, event, deadline)

      {:closed, code} ->
        flunk!("expected #{event}, connection closed (#{inspect(code)})")

      :timeout ->
        flunk!("expected #{event}, but no frame arrived within the deadline")
    end
  end

  @doc """
  Awaits a frame with the given `op`, skipping interleaved dispatches.
  """
  def next_op!(conn, op, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_next_op(conn, op, deadline)
  end

  defp do_next_op(conn, op, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case next_frame_soft(conn, remaining) do
      {:ok, %{"op" => ^op} = json} ->
        json

      {:ok, _interleaved} ->
        do_next_op(conn, op, deadline)

      {:closed, code} ->
        flunk!("expected op #{op}, connection closed (#{inspect(code)})")

      :timeout ->
        flunk!("expected op #{op}, but no frame arrived within the deadline")
    end
  end

  @doc """
  Asserts NO frame with `t` == `event` arrives within `timeout`. Interleaved
  frames of other types are consumed and ignored — the pinned property is
  the event's absence, not wire silence.
  """
  def refute_next_event!(conn, event, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_refute_next_event(conn, event, deadline)
  end

  defp do_refute_next_event(conn, event, deadline) do
    remaining = max(deadline - System.monotonic_time(:millisecond), 1)

    case next_frame_soft(conn, remaining) do
      :timeout ->
        :ok

      {:closed, _code} ->
        :ok

      {:ok, %{"t" => ^event} = frame} ->
        flunk!("expected no #{event}, got: #{inspect(frame)}")

      {:ok, _interleaved} ->
        do_refute_next_event(conn, event, deadline)
    end
  end

  @doc """
  Awaits frames until the connection closes, asserting the close code.
  `allowed` (optional list of decoded envelopes) permits specific frames to
  precede the close; anything else flunks.
  """
  def assert_closed!(conn, timeout, allowed \\ nil) do
    case next_frame(conn, timeout) do
      {:closed, code} ->
        code

      {:ok, frame} when is_list(allowed) ->
        unless frame in allowed do
          flunk!("unexpected frame before close: #{inspect(frame)}")
        end

        assert_closed!(conn, timeout, allowed)

      {:ok, frame} ->
        flunk!("expected close, got frame: #{inspect(frame)}")
    end
  end

  @doc """
  Awaits the close code, skipping frames that `skip_events` matches.

  A skip entry is either a dispatch event name (`"PresenceUpdate"` — matched
  against the frame's `t`) or a frame SUBSET map (`%{"op" => 9, "d" => false}`),
  which is how an interleaved OP frame is skipped: the retryable-refusal
  contract sends op 9 before the close, and that frame has no `t` at all.
  """
  def assert_closed_skipping!(conn, timeout, skip_events) when is_list(skip_events) do
    case next_frame_soft(conn, timeout) do
      {:closed, code} ->
        code

      :timeout ->
        flunk!("expected close, nothing arrived within #{timeout}ms")

      {:ok, frame} ->
        if skip_frame?(frame, skip_events) do
          assert_closed_skipping!(conn, timeout, skip_events)
        else
          flunk!("expected close, got frame: #{inspect(frame)}")
        end
    end
  end

  defp skip_frame?(frame, skip_events) do
    Enum.any?(skip_events, fn
      event when is_binary(event) -> frame["t"] == event
      %{} = subset -> Enum.all?(subset, fn {key, value} -> frame[key] == value end)
    end)
  end

  # -- inbound (server→client) one-shot per-frame decompression ----

  # Payload `zlib_stream` is RAW DEFLATE (window bits -15, the native decision
  # #27) — `:zlib.unzip/1` expects a zlib header and fails on every frame of
  # it, so this arm was written from the wrong contract. (Unreachable today:
  # ws_client decodes compressed frames through its persistent contract
  # inflater and delivers them as text. Fixed anyway — it is a trap for
  # whoever makes it reachable.)
  defp one_shot_decompress("zlib_stream", data) do
    z = :zlib.open()
    :ok = :zlib.inflateInit(z, -15)
    out = IO.iodata_to_binary(:zlib.inflate(z, data))
    :zlib.close(z)
    out
  end

  defp one_shot_decompress("zstd_stream", data), do: :ezstd.decompress(data)
  defp one_shot_decompress(nil, data), do: data

  defp recv_json(pid, timeout) do
    case Cytale.Test.WSClient.recv(pid, timeout) do
      {:text, data} -> {:ok, Jason.decode!(data)}
      {:binary, data} -> {:ok, Jason.decode!(data)}
      {:closed, _} -> :closed
      {:error, :timeout} -> flunk!("timeout waiting for first frame")
    end
  end

  defp flunk!(msg), do: ExUnit.Assertions.flunk(msg)

  # -- embedded upgrade plug -----------------------------------------------------

  defmodule TestPlug do
    @moduledoc false
    def init(opts), do: opts

    def call(conn, _opts) do
      CytaleWeb.GatewaySocket.upgrade(conn)
    end
  end
end
