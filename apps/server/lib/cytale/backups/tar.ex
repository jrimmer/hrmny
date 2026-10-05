defmodule Cytale.Backups.Tar do
  @moduledoc """
  The minimal POSIX ustar writer behind the server backup archive.

  The backup format is "JSONL plus the attachment blobs", delivered as one
  plain tar so a consumer needs nothing but a tar reader to open it — no
  Cytale schema, no database dump. (Origin: the workspace-export feature's
  writer, which outlived that feature because backups need the same
  primitive.) This module writes exactly the ustar
  subset every reader understands (regular files and directories, octal
  size/mtime/checksum fields, the `ustar\\0` magic) and STREAMS file
  content: an entry's bytes are copied through a fixed-size buffer from a
  file whose size is already known, so an archive is assembled without ever
  holding a whole part in memory.

  Deliberately no dependency and no compression: the parts are JSON text
  (compresses fine downstream) and blobs are stored verbatim anyway; a
  boring, tool-readable format is the contract, and every added transform
  is one more thing the verifying tool must reimplement.
  """

  # ustar names live in a fixed 100-byte field, NUL-terminated. Export names
  # are `messages/<snowflake>.jsonl` and `attachments/<sha256-hex>` (≤ 77
  # chars), so this guard never fires — it exists so a future name change
  # fails loudly here instead of corrupting archives.
  @max_name 99

  @doc """
  Append one entry to an open binary write-mode IO device.

    * `:dir` — a directory entry (zero-size, typeflag `5`).
    * `{:data, iodata}` — small content written directly (the manifest).
    * `{:file, path, size}` — content STREAMED from `path` in fixed chunks;
      `size` must equal the file's size (the caller stat'd it).

  Returns the number of content bytes written. `append_entry/4` takes
  options — `mode:` (octal STRING, default `"644"`) — which the server
  backup (#120) uses to write its credential-bearing entries 0600.
  """
  @spec append_entry(pid() | atom(), String.t(), :dir | {:data, iodata()} | {:file, String.t(), non_neg_integer()}) ::
          non_neg_integer()
  def append_entry(io, name, kind) when byte_size(name) <= @max_name do
    append_entry(io, name, kind, [])
  end

  def append_entry(_io, name, _kind) do
    raise ArgumentError,
          "export tar entry name too long for ustar (#{byte_size(name)} > #{@max_name}): #{name}"
  end

  def append_entry(io, name, kind, opts) when byte_size(name) <= @max_name and is_list(opts) do
    mode = Keyword.get(opts, :mode, "644")

    case kind do
      :dir ->
        write_entry(io, name, ?5, 0, fn _dev -> :ok end, mode)
        0

      {:data, data} ->
        size = IO.iodata_length(data)
        write_entry(io, name, ?0, size, fn dev -> IO.binwrite(dev, data) end, mode)
        size

      {:file, path, size} ->
        write_entry(io, name, ?0, size, fn dev -> stream_file(dev, path) end, mode)
        size
    end
  end

  @stream_chunk 65_536

  # One ustar header + content + NUL padding to the 512-byte block boundary.
  defp write_entry(io, name, typeflag, size, content_fun, mode) do
    IO.binwrite(io, header(name, typeflag, size, mode))
    content_fun.(io)

    case 512 - rem(size, 512) do
      512 -> :ok
      pad -> IO.binwrite(io, :binary.copy(<<0>>, pad))
    end

    :ok
  end

  defp stream_file(dev, path) do
    File.open!(path, [:read, :binary], fn f ->
      f
      |> IO.binstream(@stream_chunk)
      |> Enum.each(&IO.binwrite(dev, &1))
    end)

    :ok
  end

  # The 512-byte ustar header. The checksum is the unsigned byte sum of the
  # whole header with the checksum field itself rendered as eight ASCII
  # spaces — the POSIX definition, so every reader (GNU tar, bsdtar, python
  # tarfile, :erl_tar) verifies it the same way.
  defp header(name, typeflag, size, mode) do
    # checksum placeholder: the field itself, as eight spaces
    unchecked =
      octal_field(name, 100) <>
        octal_field(mode, 8) <>
        octal_field("0", 8) <>
        octal_field("0", 8) <>
        octal_field(Integer.to_string(size, 8), 12) <>
        octal_field(Integer.to_string(unix_now(), 8), 12) <>
        "        " <>
        <<typeflag>> <>
        :binary.copy(<<0>>, 100) <>
        "ustar\0" <>
        "00" <>
        :binary.copy(<<0>>, 32) <>
        :binary.copy(<<0>>, 32) <>
        :binary.copy(<<0>>, 8) <>
        :binary.copy(<<0>>, 8) <>
        :binary.copy(<<0>>, 155) <>
        :binary.copy(<<0>>, 12)

    checksum = unchecked |> :binary.bin_to_list() |> Enum.sum()

    checksum_field =
      checksum |> Integer.to_string(8) |> String.pad_leading(6, "0") |> Kernel.<>(<<0, " ">>)

    binary_part(unchecked, 0, 148) <>
      checksum_field <>
      binary_part(unchecked, 156, 512 - 156)
  end

  # A NUL-terminated text field: the content, then NULs through the field's
  # fixed width (the last byte always NUL).
  defp octal_field(s, width) when is_binary(s) do
    if byte_size(s) >= width do
      raise ArgumentError, "export tar field overflow (#{byte_size(s)} >= #{width}): #{inspect(s)}"
    end

    s <> :binary.copy(<<0>>, width - byte_size(s))
  end

  defp unix_now, do: System.system_time(:second)
end
