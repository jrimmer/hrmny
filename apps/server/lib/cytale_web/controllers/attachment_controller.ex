defmodule CytaleWeb.AttachmentController do
  @moduledoc """
  U21a — attachment upload (minimal inbound transport).

  `POST /api/v1/channels/{id}/attachments` — multipart upload returning an
  attachment descriptor `{url, filename, content_type, size}` for embedding
  in a message POST. Enforces the 25 MB per-file cap and the fixed mime
  allowlist; the view-only gate applies (content-producing mutation via the
  U9 choke point). Upload-first-then-attach: the client uploads, gets a
  descriptor, and includes it in the message body.
  """

  use CytaleWeb, :controller

  alias Cytale.Attachments.PublicMedia
  alias Cytale.Attachments.SignedUrl
  alias Cytale.Attachments.Store
  alias Cytale.Attachments.Upload
  alias Cytale.Workspaces
  import CytaleWeb.API.Params, only: [snowflake: 1]
  import CytaleWeb.API.Error, only: [error: 4]

  @doc "POST /channels/{id}/attachments — multipart upload."
  def create(conn, %{"channel_id" => id} = params) do
    %{user_id: _user_id} = conn.assigns.current_user

    with {:ok, channel_id} <- snowflake(id),
         true <- Workspaces.get_channel(channel_id) != nil,
         {:ok, upload} <- Upload.extract(params),
         {:ok, descriptor} <- Upload.validate_and_store(upload, :message) do
      # The descriptor's url is SIGNED so the composer can preview the upload
      # (an unsigned message-attachment URL no longer serves); the message
      # write canonicalizes it back before storing (Tier 2 #4).
      conn
      |> put_status(201)
      |> json(%{"attachment" => SignedUrl.sign_attachment(descriptor)})
    else
      {:error, :no_file} -> error(conn, 400, "validation_failed", "A file upload is required.")
      {:error, :too_large} -> error(conn, 413, "file_too_large", "File exceeds the 25 MB cap.")
      {:error, :disallowed_mime} -> error(conn, 415, "unsupported_media_type", "File type is not allowed.")
      {:error, :volume_full} -> error(conn, 507, "storage_full", "Attachment storage is full; try again later.")
      false -> error(conn, 404, "channel_not_found", "No channel with that id")
      _ -> error(conn, 400, "validation_failed", "Invalid upload.")
    end
  end

  def create(conn, _params), do: error(conn, 400, "validation_failed", "channel_id is required")

  @doc """
  GET /attachments/{hash} — serve a stored blob (content-addressed) to a
  SIGNED url (`?e=&s=`, minted per render) or, unsigned, only when the blob
  is public profile media (avatar/icon). The
  response content-type comes from the stored metadata sidecar (written at
  upload time; `application/octet-stream` for pre-sidecar blobs) and the
  VETTED raster set renders `inline` (#35 P0-2); every other type —
  including SVG, dropped from the upload allowlist because inline SVG is
  script-executing on the app origin — rides `attachment` (a navigation
  downloads it; `<img>` still renders by URL).
  """
  @inline_content_types ~w(image/png image/jpeg image/gif image/webp)

  def show(conn, %{"hash" => hash} = params) do
    with true <- valid_hash?(hash),
         {:ok, cache_control} <- authorize_read(hash, params),
         {:ok, blob} <- Store.get(hash) do
      content_type = stored_content_type(hash)
      disposition = if content_type in @inline_content_types, do: "inline", else: "attachment"

      conn
      |> put_resp_content_type(content_type, nil)
      |> put_resp_header("content-disposition", "#{disposition}; filename=\"#{stored_filename(hash)}\"")
      |> put_resp_header("cache-control", cache_control)
      |> send_resp(200, blob)
    else
      :expired -> error(conn, 403, "attachment_url_expired", "This attachment link has expired.")
      _ -> error(conn, 404, "attachment_not_found", "No such attachment.")
    end
  end

  # Who may read a blob (security Tier 2 #4):
  #
  #   * PUBLIC profile media (avatars, workspace icons — `Store.public?/1`)
  #     serve unsigned. The URL is the blob's content hash, so a different
  #     upload is a different URL and the response is immutable forever —
  #     without that, Phoenix's max-age=0 default re-downloads every rendered
  #     avatar on every reload.
  #   * everything else needs a live signature minted by a render
  #     (`SignedUrl`); the response may be cached privately for no longer
  #     than the signature stays valid.
  #
  # An unmarked blob asked for unsigned triggers the one-time legacy marker
  # backfill (`PublicMedia`) before it is refused — the avatars uploaded
  # before the marker existed.
  defp authorize_read(hash, params) do
    cond do
      Store.public?(hash) ->
        {:ok, "public, max-age=31536000, immutable"}

      is_binary(params["s"]) ->
        case SignedUrl.verify(hash, params["e"], params["s"]) do
          {:ok, seconds_left} -> {:ok, "private, max-age=#{seconds_left}"}
          other -> other
        end

      true ->
        PublicMedia.ensure_backfilled()

        if Store.public?(hash),
          do: {:ok, "public, max-age=31536000, immutable"},
          else: :unsigned
    end
  end

  # -- helpers -------------------------------------------------------------------

  # Content-addressed hashes are lowercase SHA-256 hex — anything else is a
  # 404, never a filesystem probe (path-traversal safety).
  defp valid_hash?(hash) when is_binary(hash), do: String.match?(hash, ~r/^[0-9a-f]{64}$/)
  defp valid_hash?(_), do: false

  defp stored_content_type(hash) do
    case Store.get_meta(hash) do
      {:ok, %{"content_type" => ct}} when is_binary(ct) and ct != "" -> ct
      _ -> "application/octet-stream"
    end
  end

  defp stored_filename(hash) do
    case Store.get_meta(hash) do
      {:ok, %{"filename" => name}} when is_binary(name) and name != "" -> sanitize_filename(name)
      _ -> hash
    end
  end

  # Header-safe: quotes, backslashes, and control characters never ride the
  # content-disposition value.
  defp sanitize_filename(name) do
    case name |> String.replace(~r/["\\\r\n]/, "") |> String.slice(0, 200) do
      "" -> "attachment"
      cleaned -> cleaned
    end
  end

  # -- helpers -------------------------------------------------------------------
end
