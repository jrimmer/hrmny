defmodule Cytale.UploadHelpers do
  @moduledoc """
  Shared multipart-upload fixtures (upload consolidation): the 1×1 image
  bytes with parseable headers (PNG IHDR, GIF89a logical screen, JPEG SOF0)
  plus the multipart body builder the attachment, avatar, and workspace-icon
  suites stage uploads with.
  """

  @doc "Real 1×1 PNG — minimal parseable header (the dimension sniffer reads exactly this)."
  @png_1x1 <<
    0x89,
    0x50,
    0x4E,
    0x47,
    0x0D,
    0x0A,
    0x1A,
    0x0A,
    0,
    0,
    0,
    13,
    "IHDR",
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    1,
    8,
    6,
    0,
    0,
    0
  >>

  @gif_1x1 "GIF89a" <> <<1::little-16, 1::little-16, 0x00>>

  @jpeg_1x1 <<0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 17, 8, 0, 1, 0, 1, 3, 0, 0, 0, 1, 0, 11>>

  def png_1x1, do: @png_1x1

  @doc """
  PNG header declaring arbitrary dimensions — the dimension sniffer reads
  exactly this structure (no pixel data). For over-limit tests.
  """
  @spec png_with_dims(pos_integer(), pos_integer()) :: binary()
  def png_with_dims(w, h) do
    <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, "IHDR", w::32, h::32, 8, 6, 0, 0, 0>>
  end

  def gif_1x1, do: @gif_1x1
  def jpeg_1x1, do: @jpeg_1x1

  @doc "Build a real multipart/form-data body with one file field named \"file\"."
  @spec multipart_body(String.t(), String.t(), binary()) :: {binary(), String.t()}
  def multipart_body(filename, content_type, blob) do
    boundary = "cytale-boundary-#{System.unique_integer([:positive])}"

    body =
      "--#{boundary}\r\n" <>
        "Content-Disposition: form-data; name=\"file\"; filename=\"#{filename}\"\r\n" <>
        "Content-Type: #{content_type}\r\n\r\n" <>
        blob <>
        "\r\n--#{boundary}--\r\n"

    {body, "multipart/form-data; boundary=#{boundary}"}
  end

  @doc "Stamp a conn with the multipart headers + body for a POST through ConnTest."
  @spec upload(Plug.Conn.t(), String.t(), String.t(), binary()) :: Plug.Conn.t()
  def upload(conn, filename, content_type, blob) do
    {body, ct} = multipart_body(filename, content_type, blob)

    conn
    |> Plug.Conn.put_req_header("content-type", ct)
    |> Plug.Conn.put_private(:plug_skip_csrf_protection, true)
    |> Plug.Conn.put_private(:plug_upload_body, body)
  end
end
