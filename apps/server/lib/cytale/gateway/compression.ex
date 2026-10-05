defmodule Cytale.Gateway.Compression do
  @moduledoc """
  Gateway payload compression (U10) — the two directions get separate machines:

    * **Outbound** (`init/1` + `encode/2`): a persistent per-connection
      compressor. `:zstd_stream` holds one `:ezstd` streaming compression
      context so successive frames build on shared history (the whole point
      of the `-stream` modes); `:zlib_stream` holds a persistent raw-deflate
      (:sync-flushed) encoder and `:zlib_stream_transport` the same machine
      over a zlib-WRAPPED stream (the compat transport, see the window-bit
      note below); `:none` passes plain JSON text.
    * **Inbound** (`decoder_init/1` + `decoder_feed/2`): the matching
      incremental decoder. Zstd frames concatenate legitimately, so a
      persistent streaming decompress context accepts any mix of independent
      one-shot frames and true stream output. Symmetric for zlib.

  Modes are negotiated at Identify (`compress`: `"zstd_stream"` |
  `"zlib_stream"` | null = none) and mirror U2's `CompressionMode` exactly.
  Structs are owned by one connection process and driven sequentially;
  decoder halves are additionally reused by tests and diagnostics.
  """

  defstruct [:mode, :zstd_ctx, :zctx, :zstd_dctx]

  @typedoc """
  Codec. `:zstd_stream` / `:zlib_stream` / `:none` are the client-negotiable
  payload modes (Identify's `compress`); `:zlib_stream_transport` is the
  URL-opted TRANSPORT stream (`?compress=zlib-stream`, zlib-wrapped) and is
  never negotiable — it exists as its own variant precisely so the native
  payload codec can stay raw DEFLATE.
  """
  @type mode :: :zstd_stream | :zlib_stream | :zlib_stream_transport | :none

  @typedoc "Persistent outbound compressor owned by one connection."
  @type t :: %__MODULE__{
          mode: mode(),
          zstd_ctx: reference() | nil,
          zctx: :zlib.zhandle() | nil
        }

  defmodule Decoder do
    @moduledoc "Persistent inbound decoder (mirror of the outbound machine)."
    defstruct [:mode, :zstd_dctx, :zctx]

    @type t :: %__MODULE__{
            mode: Cytale.Gateway.Compression.mode(),
            zstd_dctx: reference() | nil,
            zctx: :zlib.zhandle() | nil
          }
  end

  # zstd streaming NIF scratch buffers (bytes)
  @zstd_buffer_size 4096

  # The two zlib window-bit settings, deliberately DISTINCT (#61 item 3):
  #
  #   * -15 = raw DEFLATE, no zlib header. The NATIVE codec, both for the
  #     payload `zlib_stream` negotiation and the transport path's original
  #     implementation — a recorded native decision (#27: the web client
  #     inflates it with `DecompressionStream('deflate-raw')`).
  #   * 15 = a ZLIB stream (header + trailer, `00 00 ff ff` sync-flush
  #     members). What Discord's `?compress=zlib-stream` TRANSPORT actually
  #     is, and what every conformant library inflates it with — discord.py
  #     `zlib.decompressobj()`, Node `zlib.createInflate()`. The comment that
  #     used to sit here ("raw DEFLATE … matches the zlib-stream wire
  #     convention") was simply wrong about the transport, and that error is
  #     why a real client buffered our Hello, saw `incorrect header check`,
  #     swallowed it, and hung.
  @zlib_window_bits -15
  @zlib_transport_window_bits 15

  # ---------------------------------------------------------------------------
  # Negotiation
  # ---------------------------------------------------------------------------

  @doc "Codec names offered to clients in Hello."
  @spec supported_modes() :: [String.t()]
  def supported_modes, do: ["zstd_stream", "zlib_stream"]

  @doc "Parse the raw wire `compress` field into a mode atom."
  @spec parse_mode(term()) :: {:ok, mode()} | :error
  def parse_mode(nil), do: {:ok, :none}
  # Discord client libraries send BOOLEANS in Identify's payload-compression
  # field (false = off, true = zlib) — accept both alongside the native
  # string forms (U7 compat sessions).
  def parse_mode(false), do: {:ok, :none}
  def parse_mode(true), do: {:ok, :zlib_stream}
  def parse_mode("zstd_stream"), do: {:ok, :zstd_stream}
  # Both spellings of the zlib wire value: the native protocol's
  # "zlib_stream" and Discord's "zlib-stream" (client libraries send the
  # dash form in Identify's payload-compression field, U7 compat).
  def parse_mode("zlib_stream"), do: {:ok, :zlib_stream}
  def parse_mode("zlib-stream"), do: {:ok, :zlib_stream}
  def parse_mode(_), do: :error

  @doc "Is `value` one of the accepted wire mode strings (incl. null/none)?"
  @spec valid_wire_mode?(term()) :: boolean()
  def valid_wire_mode?(value), do: parse_mode(value) != :error

  @doc "Current mode of a compressor/decoder."
  @spec mode(t() | Decoder.t()) :: mode()
  def mode(%__MODULE__{mode: m}), do: m
  def mode(%Decoder{mode: m}), do: m

  @doc "Does this compressor carry a real stream codec?"
  @spec active?(t()) :: boolean()
  def active?(%__MODULE__{mode: mode}), do: mode != :none

  # ---------------------------------------------------------------------------
  # Lifecycle: releasing a stream context (hardening plan 5.13)
  # ---------------------------------------------------------------------------

  # The small observable the re-handshake gate counts (plan 5.13): one event
  # per `close/1` call. `close/1` is deliberately the ONLY seam that emits it,
  # so a test can assert "every handshake released exactly one context"
  # without reaching into process memory.
  @closed_event [:cytale, :gateway, :compression_closed]

  @doc """
  Release the stream contexts this compressor (or decoder) holds.

  Called wherever a codec is REPLACED and from the socket's `terminate/2`.
  Dispatches on the struct's actual fields:

    * **zlib** (`:zlib_stream` / `:zlib_stream_transport`): `:zlib.close/1`
      frees the NIF-held deflate/inflate state. `:zlib.close/1` is NOT itself
      idempotent — a second close raises `:not_initialized` — so idempotency
      is provided here: the raise is absorbed and the call returns `:ok`.
      A `nil` handle (never opened, or a `:none` codec) is a no-op.
    * **zstd**: `:ezstd` exposes **no context-free function**. Verified against
      the vendored source (`deps/ezstd/src/ezstd.erl`): its exports are
      `create_compression_context/1` / `create_decompression_context/1`,
      `reset_compression_context/2` / `reset_decompression_context/2` and the
      dictionary/streaming calls — there is no `destroy`/`close`/`free`. The
      context is an Erlang NIF resource whose destructor
      (`zstd_nif_compression_context_destructor`, `c_src/ezstd_nif.cc`) runs
      when the reference becomes unreachable, i.e. under the GC. So for zstd
      the only release available is DROPPING the reference — which the caller
      does by discarding/replacing the struct this function was handed (the
      socket's `terminate/2` and codec-replacement sites do exactly that). No
      explicit free is invented here.

  Returns `:ok` in every case.
  """
  @spec close(t() | Decoder.t()) :: :ok
  def close(%__MODULE__{mode: mode} = compressor) do
    if release_zlib(compressor.zctx), do: emit_closed(mode), else: :ok
  end

  def close(%Decoder{mode: mode} = decoder) do
    if release_zlib(decoder.zctx), do: emit_closed(mode), else: :ok
  end

  # True when a zlib handle was actually released. A `:none` codec never had
  # one, and a second close finds it already gone — neither is a release, so
  # neither emits: the counter then measures contexts freed rather than calls
  # made, and a compression-off deployment pays no telemetry work per
  # disconnect. (zstd holds a GC-managed NIF reference with no explicit free,
  # so it reports false too — dropping the reference is all `close/1` can do.)
  defp release_zlib(nil), do: false

  defp release_zlib(zctx) do
    :zlib.close(zctx)
    true
  rescue
    # Already closed (`:not_initialized`) — the idempotent second call.
    _ -> false
  catch
    _, _ -> false
  end

  defp emit_closed(mode) do
    :telemetry.execute(@closed_event, %{count: 1}, %{mode: mode, pid: self()})
    :ok
  end

  # ---------------------------------------------------------------------------
  # Outbound: server -> client
  # ---------------------------------------------------------------------------

  @doc "Build a fresh outbound compressor for `mode`."
  @spec init(mode()) :: t()
  def init(:none), do: %__MODULE__{mode: :none}

  def init(:zstd_stream) do
    %__MODULE__{mode: :zstd_stream, zstd_ctx: :ezstd.create_compression_context(@zstd_buffer_size)}
  end

  def init(:zlib_stream) do
    zctx = :zlib.open()

    case :zlib.deflateInit(zctx, 6, :deflated, @zlib_window_bits, 8, :default) do
      :ok -> %__MODULE__{mode: :zlib_stream, zctx: zctx}
      other -> raise "zlib deflateInit failed: #{inspect(other)}"
    end
  end

  def init(:zlib_stream_transport) do
    zctx = :zlib.open()

    case :zlib.deflateInit(zctx, 6, :deflated, @zlib_transport_window_bits, 8, :default) do
      :ok -> %__MODULE__{mode: :zlib_stream_transport, zctx: zctx}
      other -> raise "zlib deflateInit failed: #{inspect(other)}"
    end
  end

  @doc """
  JSON-encode + compress one outbound payload, folded through the persistent
  stream context. Returns the complete wire-ready frame body.
  """
  @spec encode(t(), term()) :: binary()
  def encode(%__MODULE__{mode: :none}, payload), do: Jason.encode!(payload)

  def encode(%__MODULE__{mode: :zstd_stream, zstd_ctx: ctx}, payload) do
    json = Jason.encode!(payload)

    case :ezstd.compress_streaming(ctx, json) do
      out when is_list(out) -> IO.iodata_to_binary(out)
      out when is_binary(out) -> out
      err -> raise "ezstd compress_streaming failed: #{inspect(err)}"
    end
  end

  def encode(%__MODULE__{mode: :zlib_stream, zctx: zctx}, payload), do: zlib_encode(zctx, payload)

  def encode(%__MODULE__{mode: :zlib_stream_transport, zctx: zctx}, payload),
    do: zlib_encode(zctx, payload)

  # One sync-flushed member per frame (the `00 00 ff ff` boundary clients
  # split on) — the window bits are the context's, so the two zlib modes
  # differ only in how they were initialized.
  defp zlib_encode(zctx, payload) do
    json = Jason.encode!(payload)
    IO.iodata_to_binary(:zlib.deflate(zctx, json, :sync))
  end

  # ---------------------------------------------------------------------------
  # Inbound: client -> server
  # ---------------------------------------------------------------------------

  @doc "Build a fresh inbound decoder for `mode`."
  @spec decoder_init(mode()) :: Decoder.t()
  def decoder_init(:none), do: %Decoder{mode: :none}

  def decoder_init(:zstd_stream) do
    %Decoder{mode: :zstd_stream, zstd_dctx: :ezstd.create_decompression_context(@zstd_buffer_size)}
  end

  def decoder_init(:zlib_stream) do
    zctx = :zlib.open()

    case :zlib.inflateInit(zctx, @zlib_window_bits) do
      :ok -> %Decoder{mode: :zlib_stream, zctx: zctx}
      other -> raise "zlib inflateInit failed: #{inspect(other)}"
    end
  end

  def decoder_init(:zlib_stream_transport) do
    zctx = :zlib.open()

    case :zlib.inflateInit(zctx, @zlib_transport_window_bits) do
      :ok -> %Decoder{mode: :zlib_stream_transport, zctx: zctx}
      other -> raise "zlib inflateInit failed: #{inspect(other)}"
    end
  end

  @doc """
  Feed one inbound wire frame (or fragment); returns the decoded bytes it
  yielded. Callers treat the concatenation of all returned bytes since the
  last successful message as the current message's JSON.
  """
  @spec decoder_feed(Decoder.t(), binary()) :: {:ok, binary()} | {:error, term()}
  def decoder_feed(%Decoder{mode: :none}, bin), do: {:ok, bin}

  def decoder_feed(%Decoder{mode: :zstd_stream, zstd_dctx: ctx}, bin) do
    case :ezstd.decompress_streaming(ctx, bin) do
      out when is_list(out) -> {:ok, IO.iodata_to_binary(out)}
      out when is_binary(out) -> {:ok, out}
      err -> {:error, err}
    end
  rescue
    e -> {:error, e}
  end

  def decoder_feed(%Decoder{mode: :zlib_stream, zctx: zctx}, bin), do: zlib_decode(zctx, bin)

  def decoder_feed(%Decoder{mode: :zlib_stream_transport, zctx: zctx}, bin), do: zlib_decode(zctx, bin)

  # Security Tier 2 #3 — the zlib bomb. `:zlib.inflate/2` returns the WHOLE
  # output of a frame, and a ~1 MB frame (the socket's max_frame_size) of
  # deflated zeros inflates to ~1 GB before anything can refuse it: one
  # unauthenticated connection could take the node. `safeInflate/2` yields the
  # output in bounded chunks instead, so the loop stops the moment the frame's
  # output passes the cap — having allocated at most the cap plus one chunk.
  # The cap equals the socket's max_frame_size: a compressed frame may carry
  # no more than an uncompressed one could. The caller closes 4001.
  @max_inflated_bytes 1_000_000

  @doc "The largest decoded output one inbound frame may inflate to."
  @spec max_inflated_bytes() :: pos_integer()
  def max_inflated_bytes, do: @max_inflated_bytes

  defp zlib_decode(zctx, bin) do
    safe_inflate(zctx, :zlib.safeInflate(zctx, bin), [], 0)
  catch
    _, reason -> {:error, reason}
  end

  defp safe_inflate(zctx, {status, out}, acc, size) when status in [:continue, :finished] do
    size = size + IO.iodata_length(out)

    cond do
      size > @max_inflated_bytes -> {:error, :inflated_frame_too_large}
      status == :finished -> {:ok, IO.iodata_to_binary(Enum.reverse([out | acc]))}
      true -> safe_inflate(zctx, :zlib.safeInflate(zctx, []), [out | acc], size)
    end
  end

  defp safe_inflate(_zctx, other, _acc, _size), do: {:error, other}
end
