defmodule Cytale.MediaProxy.Image do
  @moduledoc """
  What a fetched body IS, decided from its bytes — never from the origin's
  `Content-Type`, which the origin controls and which is exactly the header a
  content-type-confusion attack lies in.

  Accepted: PNG, JPEG, GIF, WebP and AVIF, each by its magic bytes. Everything
  else — SVG (script-bearing markup), HTML, a gzip-encoded body, a
  truncated file — is `:unsupported_type`. The served `Content-Type` is the
  sniffed type, so the browser (behind `nosniff`) can only ever decode an
  image.

  A cheap pixel-bomb check rides the same bytes: where the format's header
  states the canvas (PNG, GIF, JPEG through `Cytale.Attachments.Store.
  image_dimensions/1`; WebP here) a canvas past `max_pixels`, or past 16384 on
  either side, is refused. AVIF keeps its size in an `ispe` box deep in the
  container; it is bounded by the byte cap alone.
  """

  @max_side 16_384

  @type kind :: :png | :jpeg | :gif | :webp | :avif

  @doc "The sniffed kind and its served content type, or `:unsupported_type`."
  @spec sniff(binary()) :: {:ok, kind(), String.t()} | {:error, :unsupported_type}
  def sniff(<<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, _::binary>>), do: {:ok, :png, "image/png"}
  def sniff(<<0xFF, 0xD8, 0xFF, _::binary>>), do: {:ok, :jpeg, "image/jpeg"}
  def sniff(<<"GIF87a", _::binary>>), do: {:ok, :gif, "image/gif"}
  def sniff(<<"GIF89a", _::binary>>), do: {:ok, :gif, "image/gif"}
  def sniff(<<"RIFF", _size::32, "WEBP", _::binary>>), do: {:ok, :webp, "image/webp"}

  # ISO-BMFF: a `ftyp` box first, whose major brand (or a compatible brand)
  # is `avif`/`avis`.
  def sniff(<<box_size::32, "ftyp", major::binary-size(4), _minor::32, rest::binary>> = _body)
      when box_size >= 16 do
    compatible =
      rest
      |> binary_part(0, min(byte_size(rest), box_size - 16))
      |> brands()

    if major in ["avif", "avis"] or Enum.any?(compatible, &(&1 in ["avif", "avis"])),
      do: {:ok, :avif, "image/avif"},
      else: {:error, :unsupported_type}
  end

  def sniff(_other), do: {:error, :unsupported_type}

  defp brands(<<brand::binary-size(4), rest::binary>>), do: [brand | brands(rest)]
  defp brands(_), do: []

  @doc """
  `:ok` when the stated canvas is within bounds (or not stated in a header
  this module reads), `{:error, :too_many_pixels}` otherwise.
  """
  @spec check_dimensions(binary(), kind(), pos_integer()) :: :ok | {:error, :too_many_pixels}
  def check_dimensions(body, kind, max_pixels) do
    case dimensions(body, kind) do
      {w, h} when w > @max_side or h > @max_side or w * h > max_pixels -> {:error, :too_many_pixels}
      _ -> :ok
    end
  end

  @doc "The canvas `{width, height}` the header states, or nil."
  @spec dimensions(binary(), kind()) :: {pos_integer(), pos_integer()} | nil
  def dimensions(body, :webp), do: webp_dimensions(body)
  def dimensions(_body, :avif), do: nil
  def dimensions(body, _kind), do: Cytale.Attachments.Store.image_dimensions(body)

  # WebP's three chunk layouts (RFC 9649): lossy VP8 (14-bit sizes after the
  # frame tag and start code), lossless VP8L (14-bit sizes, minus one), and
  # the extended VP8X canvas (24-bit sizes, minus one).
  defp webp_dimensions(
         <<"RIFF", _::32, "WEBP", "VP8 ", _len::32, _tag::24, 0x9D, 0x01, 0x2A, w::little-16, h::little-16, _::binary>>
       ),
       do: positive(Bitwise.band(w, 0x3FFF), Bitwise.band(h, 0x3FFF))

  defp webp_dimensions(<<"RIFF", _::32, "WEBP", "VP8L", _len::32, 0x2F, bits::little-32, _::binary>>),
    do: positive(Bitwise.band(bits, 0x3FFF) + 1, Bitwise.band(Bitwise.bsr(bits, 14), 0x3FFF) + 1)

  defp webp_dimensions(<<"RIFF", _::32, "WEBP", "VP8X", _len::32, _flags::32, w::little-24, h::little-24, _::binary>>),
    do: positive(w + 1, h + 1)

  defp webp_dimensions(_), do: nil

  defp positive(w, h) when w > 0 and h > 0, do: {w, h}
  defp positive(_w, _h), do: nil
end
