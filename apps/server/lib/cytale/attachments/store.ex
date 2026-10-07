defmodule Cytale.Attachments.Store do
  @moduledoc """
  U21a — hash-named object store under existing infrastructure.

  Content-addressed paths under `priv/attachments/` (no external service at
  launch): the blob's SHA-256 hex is its filename, so identical content
  dedupes to one file and the URL is stable and cacheable. The descriptor
  returned to the client carries `{url, filename, content_type, size}` —
  plus `width`/`height` when the blob is a parseable PNG/GIF/JPEG (C-3) —
  for embedding in a message POST (the `attachments`
  list<frozen<map<text,text>>> column).

  Volume-level watermarks (resolved open question, 2026-08-27): warn at 75%
  of the configured cap, reject new uploads at 85%. Indefinite retention
  until the account-deletion cascade touches orphaned blobs; no per-user
  byte quota at launch.
  """

  @doc """
  The on-disk root for attachment blobs. Resolved through
  `Cytale.Config.attachments_root/0` so container deploys can point it at the
  mounted volume (the release's own `priv/` is ephemeral in a container).
  """
  @spec root() :: String.t()
  def root, do: Cytale.Config.attachments_root()

  @doc """
  Boot check: log an error when the attachment root cannot be written.

  Warn-only, so it never fails a boot. Without it an unwritable root is
  invisible until someone's upload fails: on 2026-10-06 the production
  container's root filesystem was read-only and its volume was mounted at the
  old release's versioned `priv` path, so after the 1.0.0 deploy every upload
  raised while the server otherwise looked healthy.
  """
  @spec log_root_status() :: :ok
  def log_root_status do
    dir = root()

    case probe_writable(dir) do
      :ok ->
        :ok

      {:error, reason} ->
        require Logger

        Logger.error(
          "attachment storage is not writable at #{dir} (#{:file.format_error(reason)}): " <>
            "uploads will fail. Mount a writable volume there, or point " <>
            "CYTALE_ATTACHMENTS_ROOT at one."
        )
    end
  end

  @doc "Can `dir` be created and written? Writes and removes a probe file."
  @spec probe_writable(String.t()) :: :ok | {:error, File.posix()}
  def probe_writable(dir) do
    probe = Path.join(dir, ".write-probe-#{System.unique_integer([:positive])}")

    with :ok <- File.mkdir_p(dir),
         :ok <- File.write(probe, "") do
      File.rm(probe)
    end
  end

  # Suffix of an in-flight temp file (write-then-rename; excluded from reads and
  # from the byte counter).
  @temp_infix ".tmp-"

  @doc "The content-addressed path for a blob hash."
  @spec path(String.t()) :: String.t()
  def path(hash) when is_binary(hash), do: Path.join(root(), hash)

  @doc "SHA-256 hex of a binary blob (the content address)."
  @spec hash(binary()) :: String.t()
  def hash(blob) when is_binary(blob) do
    :crypto.hash(:sha256, blob) |> Base.encode16(case: :lower)
  end

  @doc """
  Store a blob, returning its descriptor. Idempotent: identical content
  rewrites the same content-addressed file. The `.meta` sidecar is FIRST
  WRITER WINS (security Tier 2 #4): a later upload of the same bytes under a
  different filename/type must not rewrite what the original's URL serves
  (the served content type and download name belong to the first upload).
  `public: true` (avatar/icon uploads) marks the blob as public profile media
  (`public?/1`), served without a signed URL. Image blobs (`image/*` content types) carry sniffed `width`/`height`
  (`image_dimensions/1`) on both the descriptor and the sidecar — absent
  keys when the bytes don't parse. Returns `{:error, :volume_full}` when
  the store is past the reject watermark.
  """
  @spec put(binary(), String.t(), String.t(), keyword()) ::
          {:ok, map()}
          | {:error, :volume_full}
  def put(blob, filename, content_type, opts \\ []) when is_binary(blob) do
    if volume_full?() do
      {:error, :volume_full}
    else
      hash = hash(blob)
      dims = if image_content?(content_type), do: image_dimensions(blob), else: nil

      File.mkdir_p!(root())
      previous = existing_size(path(hash))
      write_atomic!(path(hash), blob)
      write_new_atomic!(meta_path(hash), Jason.encode!(meta_map(filename, content_type, byte_size(blob), dims)))
      if Keyword.get(opts, :public, false), do: mark_public(hash)
      adjust_bytes(byte_size(blob) - previous)
      {:ok, descriptor(hash, filename, content_type, byte_size(blob), dims)}
    end
  end

  @doc "Read a blob by its content hash. `:error` when absent."
  @spec get(String.t()) :: {:ok, binary()} | :error
  def get(hash) when is_binary(hash) do
    case File.read(path(hash)) do
      {:ok, blob} -> {:ok, blob}
      {:error, _} -> :error
    end
  end

  @doc """
  The stored metadata sidecar for a hash (`{content_type, filename, size}`,
  written by `put/3`). `:error` when absent (blobs stored before the
  sidecar existed) or unreadable — callers fall back to a generic type.
  """
  @spec get_meta(String.t()) :: {:ok, %{String.t() => term()}} | :error
  def get_meta(hash) when is_binary(hash) do
    case File.read(meta_path(hash)) do
      {:ok, bin} ->
        case Jason.decode(bin) do
          {:ok, %{} = meta} -> {:ok, meta}
          _ -> :error
        end

      {:error, _} ->
        :error
    end
  end

  # -- public profile media (security Tier 2 #4) --------------------------------------

  # Avatars and workspace icons are PUBLIC: shown to anyone who can see the
  # profile, rendered en masse, stored by URL on the user/workspace row. They
  # keep the unsigned URL; everything else needs a signed one
  # (`Cytale.Attachments.SignedUrl`). The flag is an empty marker file under a
  # dot-directory of the store root (excluded from the byte counter), keyed by
  # hash — a blob that is ALSO someone's avatar is by definition content its
  # uploader chose to publish.
  @public_dir ".public"

  @doc "Mark a stored blob as public profile media (served unsigned)."
  @spec mark_public(String.t()) :: :ok
  def mark_public(hash) when is_binary(hash) do
    File.mkdir_p!(Path.join(root(), @public_dir))
    File.touch!(public_marker(hash))
    :ok
  end

  @doc "True when the blob is public profile media (an avatar or icon)."
  @spec public?(String.t()) :: boolean()
  def public?(hash) when is_binary(hash), do: File.regular?(public_marker(hash))

  defp public_marker(hash), do: Path.join([root(), @public_dir, hash])

  @doc "Delete a blob (account-deletion cascade / orphan sweep)."
  @spec delete(String.t()) :: :ok
  def delete(hash) when is_binary(hash) do
    # Size FIRST: the counter subtracts what was actually stored, and the file is
    # about to stop existing.
    size = existing_size(path(hash))
    File.rm(path(hash))
    File.rm(meta_path(hash))
    File.rm(public_marker(hash))
    adjust_bytes(-size)
    :ok
  end

  @doc """
  Total bytes currently stored (blob files only; `.meta` sidecars and in-flight
  temp files excluded).

  A RUNNING COUNTER, not a directory walk (hardening plan 5.11): admission
  (`volume_full?/0`) runs on every upload, and it used to `File.ls/1` the store
  and `File.stat/1` every file in it — so a store with 100k blobs paid 100k stats
  to admit one small upload. The counter is seeded from ONE scan the first time it
  is needed and then moved by the write and delete paths; `recount/0` re-derives
  it (an operator tool, and what a restore that wrote blobs behind the store's
  back needs).
  """
  @spec volume_usage_bytes() :: non_neg_integer()
  def volume_usage_bytes do
    :atomics.get(counter(), 1)
  end

  @doc "Re-derive the running byte counter from the directory (one scan)."
  @spec recount() :: non_neg_integer()
  def recount do
    total =
      case File.ls(root()) do
        {:ok, files} ->
          files
          |> Enum.reject(&ignored_file?/1)
          |> Enum.reduce(0, fn f, acc ->
            case File.stat(Path.join(root(), f)) do
              {:ok, %{size: size}} -> acc + size
              _ -> acc
            end
          end)

        {:error, _} ->
          0
      end

    :atomics.put(counter(), 1, total)
    total
  end

  # `{Store, :bytes}` holds the atomics ref, minted on first use from the
  # directory's actual contents. `:atomics` (not ETS or `:persistent_term`) is
  # the right home for a hot single integer: add/get are lock-free and allocate
  # nothing, and only the REF is written once.
  defp counter do
    case :persistent_term.get({__MODULE__, :bytes}, nil) do
      nil ->
        ref = :atomics.new(1, signed: false)
        :persistent_term.put({__MODULE__, :bytes}, ref)
        :atomics.put(ref, 1, 0)
        recount()
        ref

      ref ->
        ref
    end
  end

  defp adjust_bytes(delta) when is_integer(delta) and delta != 0 do
    # A negative delta cannot make the counter wrap: `recount/0` seeds it from
    # the real sizes and every delete subtracts a size that was counted. The
    # floor is belt-and-braces for a store modified behind the counter's back.
    current = :atomics.get(counter(), 1)

    if delta < 0 and -delta > current do
      :atomics.put(counter(), 1, 0)
    else
      :atomics.add(counter(), 1, delta)
    end

    :ok
  end

  defp adjust_bytes(_zero), do: :ok

  defp existing_size(file) do
    case File.stat(file) do
      {:ok, %{size: size}} -> size
      _ -> 0
    end
  end

  # Temp files are excluded from the counter and from every read: a crash
  # between the write and the rename leaves one behind, and it must not look
  # like stored bytes (or, for a blob path, like a stored BLOB — the rename is
  # what makes it readable, so a truncated temp is unreachable by hash).
  defp ignored_file?(name),
    do: String.ends_with?(name, ".meta") or String.contains?(name, @temp_infix) or String.starts_with?(name, ".")

  @doc "True when the store is past the reject-new-uploads watermark."
  @spec volume_full?() :: boolean()
  def volume_full? do
    cap = Cytale.Config.attachment_volume_cap_bytes()
    reject = Cytale.Config.attachment_reject_watermark()
    volume_usage_bytes() >= trunc(cap * reject)
  end

  @doc "True when the store is past the warn watermark (operator signal)."
  @spec volume_warn?() :: boolean()
  def volume_warn? do
    cap = Cytale.Config.attachment_volume_cap_bytes()
    warn = Cytale.Config.attachment_warn_watermark()
    volume_usage_bytes() >= trunc(cap * warn)
  end

  @doc """
  Build the descriptor map for a stored blob. When `dims` is a known
  `{width, height}` pair (sniffed at `put/3` time), the descriptor carries
  integer `width`/`height`; `nil` dims (non-images, unparseable/truncated
  bytes) omit both keys.
  """
  @spec descriptor(String.t(), String.t(), String.t(), pos_integer(), {pos_integer(), pos_integer()} | nil) ::
          map()
  def descriptor(hash, filename, content_type, size, dims \\ nil) do
    base = %{
      "url" => "/api/v1/attachments/#{hash}",
      "filename" => filename,
      "content_type" => content_type,
      "size" => size
    }

    case dims do
      {w, h} -> Map.merge(base, %{"width" => w, "height" => h})
      nil -> base
    end
  end

  # -- image dimensions (C-3) --------------------------------------------------------

  @doc """
  Pure-Elixir image dimension sniffing — PNG (IHDR at a fixed offset), GIF
  (logical screen descriptor at a fixed offset), JPEG (an SOF marker walk:
  segment-skip until a frame header, never into entropy data). Returns
  `{width, height}` for a parseable image with non-zero dimensions, `nil`
  for anything else (non-image bytes, unknown formats like WebP, truncated
  headers) — callers OMIT the keys, never store a guess. No deps; no
  validation beyond the header layout (uploads are mime-allowlisted
  upstream and blobs are content-addressed).
  """
  @spec image_dimensions(binary()) :: {pos_integer(), pos_integer()} | nil
  def image_dimensions(blob) when is_binary(blob) do
    case blob do
      # PNG: 8-byte signature, then the (assumed-first) IHDR chunk — 4-byte
      # length + "IHDR" + big-endian width/height.
      <<0x89, "PNG", 0x0D, 0x0A, 0x1A, 0x0A, _ihdr_len::32, "IHDR", w::32, h::32, _::binary>> ->
        positive_dims(w, h)

      # GIF: 6-byte version signature, then the logical screen descriptor's
      # little-endian canvas size.
      <<"GIF87a", w::little-16, h::little-16, _::binary>> ->
        positive_dims(w, h)

      <<"GIF89a", w::little-16, h::little-16, _::binary>> ->
        positive_dims(w, h)

      # JPEG: SOI, then a marker walk.
      <<0xFF, 0xD8, rest::binary>> ->
        jpeg_dimensions(rest)

      _ ->
        nil
    end
  end

  defp positive_dims(w, h) when w > 0 and h > 0, do: {w, h}
  defp positive_dims(_w, _h), do: nil

  # SOF0..SOF15 minus the interleaved non-frame segments (DAC 0xCC, DHT
  # 0xC4, JPG 0xC8). SOF payloads start precision(1) + height(2) + width(2),
  # big-endian — height first.
  @sof_markers Enum.to_list(0xC0..0xCF) -- [0xC4, 0xC8, 0xCC]
  # Standalone markers (TEM, RST0-7, SOI, EOI) carry no length segment.
  @standalone_markers [0x01 | Enum.to_list(0xD0..0xD9)]

  defp jpeg_dimensions(rest), do: jpeg_walk(rest)

  # Byte-stuffing fill (0xFF padding) before a marker: keep ONE 0xFF and
  # drop the surplus (the marker is the LAST 0xFF + its code).
  defp jpeg_walk(<<0xFF, 0xFF, rest::binary>>), do: jpeg_walk(<<0xFF, rest::binary>>)

  # SOS: entropy-coded data follows — no SOF was seen, give up.
  defp jpeg_walk(<<0xFF, 0xDA, _::binary>>), do: nil

  defp jpeg_walk(<<0xFF, marker, rest::binary>>) when marker in @sof_markers do
    case rest do
      <<_length::16, _precision, h::16, w::16, _::binary>> -> positive_dims(w, h)
      _ -> nil
    end
  end

  defp jpeg_walk(<<0xFF, marker, rest::binary>>) when marker in @standalone_markers,
    do: jpeg_walk(rest)

  defp jpeg_walk(<<0xFF, _marker, rest::binary>>) do
    case rest do
      # The 2 length bytes count themselves; the guard proves the skip is
      # in range, so binary_part lands exactly past the segment.
      <<length::16, skipped::binary>> when length >= 2 and byte_size(skipped) >= length - 2 ->
        skip = length - 2
        jpeg_walk(binary_part(skipped, skip, byte_size(skipped) - skip))

      _ ->
        nil
    end
  end

  defp jpeg_walk(_truncated), do: nil

  defp image_content?("image/" <> _), do: true
  defp image_content?(_), do: false

  # The metadata sidecar rides the blob file: `priv/attachments/{hash}.meta`
  # (JSON `{content_type, filename, size, width?, height?}`). The store is
  # content-addressed with no DB row, so serving the right
  # content-type/content-disposition on GET /attachments/{hash} needs this
  # on-disk companion.
  defp meta_path(hash), do: path(hash) <> ".meta"

  defp meta_map(filename, content_type, size, dims) do
    %{"content_type" => content_type, "filename" => filename, "size" => size}
    |> put_dims(dims)
  end

  # Write to a UNIQUE temp beside the target, fsync it, then RENAME it into
  # place (hardening plan 5.11): the rename is atomic within a filesystem, so a
  # reader (or a crash) never observes a partially written blob at the
  # content-addressed path. The old shape `File.write!`d straight to the target
  # and never synced, so a crash mid-write left a TRUNCATED file that
  # content-addressing would then serve forever under its real hash — the hash
  # described bytes that were never fully stored.
  defp write_atomic!(target, bytes) do
    temp = target <> @temp_infix <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

    file = File.open!(temp, [:write, :binary, :raw])

    try do
      :ok = IO.binwrite(file, bytes)
      :ok = :file.sync(file)
    after
      File.close(file)
    end

    case File.rename(temp, target) do
      :ok ->
        :ok

      {:error, reason} ->
        File.rm(temp)
        raise File.Error, reason: reason, action: "rename into place", path: target
    end
  end

  # First writer wins, atomically: the bytes land in a temp, then a HARD LINK
  # publishes them only if the target does not exist yet (link(2) refuses an
  # existing name, so two racing uploads cannot both "win"); the temp goes
  # either way. Readers never see a partial sidecar.
  defp write_new_atomic!(target, bytes) do
    if File.exists?(target) do
      :ok
    else
      temp = target <> @temp_infix <> Integer.to_string(System.unique_integer([:positive, :monotonic]))

      try do
        File.write!(temp, bytes, [:binary, :sync])

        case :file.make_link(temp, target) do
          :ok -> :ok
          {:error, :eexist} -> :ok
          {:error, reason} -> raise File.Error, reason: reason, action: "link into place", path: target
        end
      after
        File.rm(temp)
      end
    end
  end

  defp put_dims(meta, {w, h}), do: Map.merge(meta, %{"width" => w, "height" => h})
  defp put_dims(meta, nil), do: meta
end
