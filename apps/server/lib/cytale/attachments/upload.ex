defmodule Cytale.Attachments.Upload do
  @moduledoc """
  Shared inbound validation for every upload surface (upload consolidation:
  one cap/mime check + the content-addressed store, parameterized per
  purpose so the entry points can never drift apart).

  Purposes:

    * `:message` — the U21a channel-attachment contract: 25 MB cap, the
      wide mime allowlist (raster images + common document types).
    * `:avatar` — user avatars and workspace icons: 2 MB cap, 4096px max
      dimension, the four raster image types only (SVG stays banned
      everywhere — inline SVG executes script on the app origin).

  Every surface funnels through `validate_and_store/2`: the native channel
  attachment route, the avatar/icon endpoints, and the Discord-compat
  multipart surfaces (which build their wire objects on top of the returned
  descriptor). Size is checked before mime — a file that is both oversized
  and disallowed reports the cap error (the native route's observable
  behavior, which its tests pin). The dimension check rides the sniffed
  header (PNG/GIF/JPEG); WebP and unparseable bytes pass it and are bounded
  by the byte cap alone.
  """

  alias Cytale.Attachments.Store

  @typedoc "Upload purpose: selects the cap + mime allowlist pair."
  @type purpose :: :message | :avatar

  @type error :: :no_file | :too_large | :disallowed_mime | :volume_full | :dimensions_exceeded

  @doc """
  Extract the `Plug.Upload` from multipart params (`file` or `upload` field
  names — every surface accepts both).
  """
  @spec extract(map()) :: {:ok, Plug.Upload.t()} | {:error, :no_file}
  def extract(%{"file" => %Plug.Upload{} = upload}), do: {:ok, upload}
  def extract(%{"upload" => %Plug.Upload{} = upload}), do: {:ok, upload}
  def extract(_), do: {:error, :no_file}

  @doc """
  Validate an upload against the purpose's caps + allowlist and store it
  through `Cytale.Attachments.Store`. Returns the store's descriptor
  (`{url, filename, content_type, size, width?, height?}` — the url is
  relative, `/api/v1/attachments/{hash}`).
  """
  @spec validate_and_store(Plug.Upload.t() | nil, purpose()) ::
          {:ok, map()} | {:error, error()}
  def validate_and_store(nil, _purpose), do: {:error, :no_file}

  def validate_and_store(%Plug.Upload{} = upload, purpose) do
    {cap, allowed} = limits(purpose)

    with :ok <- check_size(upload, cap),
         :ok <- check_mime(upload, allowed) do
      blob = File.read!(upload.path)
      # The RESOLVED type is what gets stored: it is what the descriptor
      # carries, what `GET /attachments/{hash}` serves, and what the snapshot
      # sniffer keys on — so a `.png` part labelled octet-stream is stored AS
      # an image and renders instead of downloading.
      content_type = effective_content_type(upload)

      with :ok <- check_dimensions(blob, purpose) do
        # Avatar-purpose blobs are public profile media (served unsigned);
        # message attachments are served only through signed URLs.
        case Store.put(blob, upload.filename, content_type, public: purpose == :avatar) do
          {:ok, descriptor} -> {:ok, descriptor}
          {:error, :volume_full} -> {:error, :volume_full}
        end
      end
    end
  end

  defp limits(:message) do
    {Cytale.Config.attachment_max_upload_bytes(), Cytale.Config.attachment_allowed_mime_types()}
  end

  defp limits(:avatar) do
    {Cytale.Config.avatar_max_upload_bytes(), Cytale.Config.avatar_allowed_mime_types()}
  end

  # Avatar-purpose images render en masse client-side, so a single
  # multi-thousand-pixel upload taxes every peer's viewport. Sniffed
  # dimensions are header reads (PNG/GIF/JPEG); nil (WebP, truncated
  # bytes) passes — the byte cap bounds those, which is why both limits
  # exist. Message attachments are content, not identity chrome, and are
  # exempt.
  defp check_dimensions(blob, :avatar) do
    max_dim = Cytale.Config.avatar_max_dimension()

    case Store.image_dimensions(blob) do
      {w, h} when w > max_dim or h > max_dim -> {:error, :dimensions_exceeded}
      {_, _} -> :ok
      nil -> :ok
    end
  end

  defp check_dimensions(_blob, :message), do: :ok

  defp check_size(%Plug.Upload{} = upload, cap) do
    case File.stat(upload.path) do
      {:ok, %{size: size}} when size <= cap -> :ok
      {:ok, %{size: _}} -> {:error, :too_large}
      _ -> {:error, :too_large}
    end
  end

  defp check_mime(upload, allowed) do
    if effective_content_type(upload) in allowed, do: :ok, else: {:error, :disallowed_mime}
  end

  # ---------------------------------------------------------------------------
  # Content-type resolution (the part header vs the filename)
  # ---------------------------------------------------------------------------

  # Headers that identify nothing in particular. discord.py — and any library
  # building its own multipart — hardcodes `application/octet-stream` for every
  # `files[n]` part (`discord/http.py`), whatever the file is, so a bot could
  # not send ANY file: the allowlist compared that literal, never matched, and
  # rendered 400 50035. The filename is then the only field left describing
  # what the bytes are (§65).
  @generic_content_types ["application/octet-stream", "binary/octet-stream", "text/plain"]

  @doc """
  The content type an upload is JUDGED and STORED as.

  Authority rule (binding, pinned by tests and recorded in
  docs/protocol/compat.md): a client that names a **specific** type is taken
  at its word — that value is kept, and if the allowlist rejects it the upload
  is rejected without consulting the filename. Only a **generic** header
  (`application/octet-stream`, `binary/octet-stream`, `text/plain`, or absent)
  defers to the filename extension, which is then authoritative because it is
  the only remaining signal:

    * extension maps to a known type → that type (so `.png` sent as
      octet-stream stores as `image/png`, and the served content type, the
      sniffed dimensions and the client's renderer all agree);
    * extension unknown/dotless → the header itself stands, so a `.txt`less
      text part still stores as `text/plain` while an octet-stream part with
      no recognizable extension is rejected.

  Deliberate consequence: `.html`, `.svg`, `.js` sent with a generic header are
  now REJECTED (their real type is known and disallowed) where the old exact
  comparison sometimes let them through as `text/plain`. The filename never
  loosens the gate — it only supplies the type the header failed to state.
  """
  @spec effective_content_type(Plug.Upload.t()) :: String.t()
  def effective_content_type(%Plug.Upload{content_type: ct, filename: filename})
      when is_binary(ct) and is_binary(filename) do
    if ct in @generic_content_types, do: from_filename(filename, ct), else: ct
  end

  def effective_content_type(%Plug.Upload{content_type: ct}) when is_binary(ct), do: ct

  def effective_content_type(%Plug.Upload{filename: filename}) when is_binary(filename),
    do: from_filename(filename, "application/octet-stream")

  def effective_content_type(_), do: "application/octet-stream"

  defp from_filename(filename, fallback) do
    case MIME.from_path(filename) do
      # `MIME.from_path/1` answers here for an unknown or absent extension —
      # there is nothing to infer, so the header stands.
      "application/octet-stream" -> fallback
      inferred -> inferred
    end
  end
end
