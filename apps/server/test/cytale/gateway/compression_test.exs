defmodule Cytale.Gateway.CompressionTest do
  @moduledoc """
  #61 item 3 — the two zlib codecs are DISTINCT streams, asserted from the
  client's side of the contract:

    * the payload `zlib_stream` (Identify negotiation) is RAW DEFLATE (#27):
      the web client inflates it with `DecompressionStream('deflate-raw')`;
    * the TRANSPORT `?compress=zlib-stream` is a ZLIB stream (window bits 15):
      every Discord library inflates it with a zlib-format inflater
      (discord.py `zlib.decompressobj()`, Node `zlib.createInflate()`).

  Both directions of each claim are pinned — the right inflater succeeds AND
  the wrong one fails — because the mismatch that produced this ticket was
  invisible to every existing gate: a client that shares the encoder's codec
  agrees with it by construction.
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.Compression

  defp payload, do: %{"op" => 10, "d" => %{"heartbeat_interval" => 30_000}}

  test "the transport encoder emits a ZLIB stream (window bits 15)" do
    frame = :zlib_stream_transport |> Compression.init() |> Compression.encode(payload())

    assert {:ok, json} = zlib_inflate(frame, 15)
    assert Jason.decode!(json) == payload()

    # A raw-DEFLATE inflater — the pre-fix wire's contract, and what our own
    # native client uses — must REJECT it. This is the assertion a real
    # library was making when it saw `incorrect header check` and hung.
    assert {:error, _} = zlib_inflate(frame, -15)
  end

  test "the payload encoder still emits raw DEFLATE (#27)" do
    frame = :zlib_stream |> Compression.init() |> Compression.encode(payload())

    assert {:ok, json} = zlib_inflate(frame, -15)
    assert Jason.decode!(json) == payload()

    # The native codec did NOT move to the zlib wrapper.
    assert {:error, _} = zlib_inflate(frame, 15)
  end

  test "the transport decoder accepts a zlib member and rejects raw DEFLATE" do
    member = zlib_deflate(Jason.encode!(payload()), 15)

    assert {:ok, json} = Compression.decoder_feed(Compression.decoder_init(:zlib_stream_transport), member)
    assert Jason.decode!(json) == payload()

    raw = zlib_deflate(Jason.encode!(payload()), -15)

    assert {:error, _} =
             Compression.decoder_feed(Compression.decoder_init(:zlib_stream_transport), raw)
  end

  test "both zlib modes are active, and the transport mode is not client-negotiable" do
    assert Compression.active?(Compression.init(:zlib_stream_transport))
    assert Compression.mode(Compression.init(:zlib_stream_transport)) == :zlib_stream_transport

    # It is armed by the URL (`?compress=zlib-stream`), never by Identify: an
    # Identify naming it is refused as an unknown mode rather than
    # half-configuring a connection.
    assert Compression.parse_mode("zlib_stream_transport") == :error
    refute Compression.valid_wire_mode?("zlib_stream_transport")

    # The negotiable spellings are unchanged.
    assert Compression.parse_mode("zlib_stream") == {:ok, :zlib_stream}
    assert Compression.parse_mode("zlib-stream") == {:ok, :zlib_stream}
    assert Compression.parse_mode(true) == {:ok, :zlib_stream}
    assert Compression.supported_modes() == ["zstd_stream", "zlib_stream"]
  end

  # -- raw :zlib helpers (the CLIENT's contract, never the server's code) -------

  defp zlib_inflate(bin, window_bits) do
    z = :zlib.open()
    :ok = :zlib.inflateInit(z, window_bits)
    out = IO.iodata_to_binary(:zlib.inflate(z, bin))
    :zlib.close(z)
    {:ok, out}
  catch
    _, reason -> {:error, reason}
  end

  describe "zstd transport (the discord.py contract, 2026-09-23)" do
    # discord.py >=2.5 negotiates `?compress=zstd-stream` and feeds EVERY ws
    # message to ONE decompressor instance. Its stdlib path
    # (`compression.zstd.ZstdDecompressor.decompress`) is stateful across
    # calls: independent one-shot frames die on the second message ("Already
    # at the end of a Zstandard frame" — verified against 3.14's stdlib and
    # the pinned 2.7.1). The wire it needs is a PERSISTENT stream whose every
    # message is a flushed chunk — which is what :zstd_stream emits. These
    # pins hold that shape with our own decoder (the mirror machine).
    test "successive transport frames decode through ONE persistent decoder" do
      comp = Compression.init(:zstd_stream)
      dec = Compression.decoder_init(:zstd_stream)

      f1 = Compression.encode(comp, %{"op" => 10, "d" => %{"heartbeat_interval" => 30_000}})
      f2 = Compression.encode(comp, %{"t" => "READY", "d" => %{"session_id" => "s1"}})

      assert {:ok, j1} = Compression.decoder_feed(dec, f1)
      assert {:ok, j2} = Compression.decoder_feed(dec, f2)
      assert Jason.decode!(j1)["op"] == 10
      assert Jason.decode!(j2)["t"] == "READY"
    end
  end

  defp zlib_deflate(json, window_bits) do
    z = :zlib.open()
    :ok = :zlib.deflateInit(z, 6, :deflated, window_bits, 8, :default)
    out = IO.iodata_to_binary(:zlib.deflate(z, json, :sync))
    :zlib.close(z)
    out
  end

  # ---------------------------------------------------------------------------
  # Plan 5.13 — stream contexts are released
  # ---------------------------------------------------------------------------

  describe "close/1 (plan 5.13)" do
    test "releases a zlib handle; a second close is the idempotent no-op" do
      comp = Compression.init(:zlib_stream)

      # The handle works before the close.
      refute Compression.encode(comp, payload()) == nil

      assert Compression.close(comp) == :ok

      # The handle is GONE: encoding through it now raises `:not_initialized`
      # (zlib's closed-handle error), which is the observable proof this was a
      # real release rather than a bookkeeping no-op.
      assert_raise ErlangError, fn -> Compression.encode(comp, payload()) end

      # ...and the second close is a no-op, never a raise. (`:zlib.close/1`
      # itself raises on an already-closed handle; `Compression.close/1`
      # absorbs that, which is what makes it idempotent.)
      assert Compression.close(comp) == :ok
    end

    test "releases a transport zlib handle and a decoder's inflate handle" do
      transport = Compression.init(:zlib_stream_transport)
      refute Compression.encode(transport, payload()) == nil
      assert Compression.close(transport) == :ok
      assert_raise ErlangError, fn -> Compression.encode(transport, payload()) end
      assert Compression.close(transport) == :ok

      member = zlib_deflate(Jason.encode!(payload()), 15)
      decoder = Compression.decoder_init(:zlib_stream_transport)
      assert {:ok, json} = Compression.decoder_feed(decoder, member)
      assert Jason.decode!(json) == payload()

      assert Compression.close(decoder) == :ok

      # The inflate handle is gone: the next feed reports an error (the
      # `decoder_feed/2` contract) instead of silently yielding bytes.
      assert {:error, _} = Compression.decoder_feed(decoder, member)
      assert Compression.close(decoder) == :ok
    end

    test "is safe on a :none codec and does not invent a zstd free" do
      assert Compression.close(Compression.init(:none)) == :ok
      assert Compression.close(Compression.decoder_init(:none)) == :ok

      # `:ezstd` exposes NO context-free function (see `close/1`'s doc): the
      # NIF context is reclaimed by the GC once its reference is dropped. So
      # close/1 must succeed WITHOUT breaking a still-referenced context —
      # proving it did not call some invented destroy.
      zstd = Compression.init(:zstd_stream)
      assert Compression.close(zstd) == :ok
      refute Compression.encode(zstd, payload()) == nil
    end
  end

  # A client-side zlib stream member, sync-flushed (what a conformant
  # transport client sends).
  defp deflate_member(z, data), do: IO.iodata_to_binary(:zlib.deflate(z, data, :sync))

  defp client_stream do
    z = :zlib.open()
    :ok = :zlib.deflateInit(z, 9, :deflated, 15, 8, :default)
    z
  end

  describe "inbound inflate cap (security Tier 2 #3)" do
    test "a bomb frame is refused without allocating its output" do
      z = client_stream()
      # 64 MiB of zeros deflates to ~64 KB — well under max_frame_size.
      bomb = deflate_member(z, :binary.copy(<<0>>, 64 * 1024 * 1024))
      :zlib.close(z)
      assert byte_size(bomb) < 1_000_000

      parent = self()

      # Run the decode under a heap bound that counts refc binaries: an
      # implementation that materializes the full 64 MiB is killed, the capped
      # one returns its error well inside the bound.
      {pid, ref} =
        spawn_monitor(fn ->
          Process.flag(:max_heap_size, %{
            size: div(16 * 1024 * 1024, :erlang.system_info(:wordsize)),
            kill: true,
            error_logger: false,
            include_shared_binaries: true
          })

          decoder = Compression.decoder_init(:zlib_stream_transport)
          send(parent, {:result, Compression.decoder_feed(decoder, bomb)})
        end)

      assert_receive {:result, {:error, :inflated_frame_too_large}}, 10_000
      assert_receive {:DOWN, ^ref, :process, ^pid, :normal}, 10_000
    end

    test "frames at the cap still decode, and the stream carries on" do
      z = client_stream()
      decoder = Compression.decoder_init(:zlib_stream_transport)

      at_cap = :binary.copy("a", Compression.max_inflated_bytes())
      assert {:ok, ^at_cap} = Compression.decoder_feed(decoder, deflate_member(z, at_cap))
      assert {:ok, "{}"} = Compression.decoder_feed(decoder, deflate_member(z, "{}"))
      :zlib.close(z)
    end
  end
end
