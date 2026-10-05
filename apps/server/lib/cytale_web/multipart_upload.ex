defmodule CytaleWeb.MultipartUpload do
  @moduledoc """
  Discord's multipart file model — `files[n]` binary parts + a
  `payload_json` part — shared by the two surfaces that accept it:

    * webhook execute (`POST /api/webhooks/{id}/{token}[/slack|/github]`);
    * compat message create (`POST /api/v10|/api/channels/{id}/messages`).

  A multipart request carries the usual JSON body inside the `payload_json`
  part (plain string field or a file part — libraries differ) and one binary
  part per file named `files[0]`, `files[1]`, …. Plug parses the parts:
  fields land in `body_params` as strings, file parts as `%Plug.Upload{}`
  (the bracket notation nests under `body_params["files"][index]`).

  Files store through the SAME path as the native upload
  (`Cytale.Attachments.Store` — content-addressed, 25 MB per-file cap, fixed
  mime allowlist) and come back as Discord attachment objects: fresh
  snowflake `id`, ABSOLUTE `url` (the `CytaleWeb.ExternalUrl` origin —
  `external_base_url` verbatim ∥ conn-derived), part filename/byte
  size/content-type. Over-cap and disallowed-mime files reject the whole
  batch (`:too_large` / `:disallowed_mime`) — the surfaces render both as
  Discord's `400 50035`.
  """

  alias Cytale.Snowflake
  alias CytaleWeb.ExternalUrl

  import Plug.Conn, only: [get_req_header: 2]

  @attachment_base "/api/v1/attachments"

  @type upload_error :: :invalid_form_body | :too_large | :disallowed_mime | :volume_full

  @doc "True when the request carries a `multipart/form-data` body."
  @spec multipart?(Plug.Conn.t()) :: boolean()
  def multipart?(conn) do
    case get_req_header(conn, "content-type") do
      [ct | _] ->
        match?({:ok, "multipart", "form-data", _}, Plug.Conn.Utils.content_type(ct))

      _ ->
        false
    end
  end

  @doc """
  The request's JSON body: `conn.body_params` verbatim for JSON requests;
  the decoded `payload_json` part for multipart ones (missing part, invalid
  JSON, or a non-object payload is `:invalid_form_body`).
  """
  @spec payload(Plug.Conn.t()) :: {:ok, map()} | {:error, :invalid_form_body}
  def payload(conn) do
    if multipart?(conn) do
      case conn.body_params["payload_json"] do
        raw when is_binary(raw) -> decode_payload(raw)
        %Plug.Upload{} = part -> decode_payload(File.read!(part.path))
        _ -> {:error, :invalid_form_body}
      end
    else
      {:ok, conn.body_params}
    end
  end

  defp decode_payload(raw) when is_binary(raw) do
    case Jason.decode(raw) do
      {:ok, %{} = payload} -> {:ok, payload}
      _ -> {:error, :invalid_form_body}
    end
  end

  @doc """
  The `files[n]` binary parts in index order — `[]` for JSON requests. A
  non-index or non-file entry in the `files` structure is
  `:invalid_form_body` (a bare unindexed `files` upload is tolerated).
  """
  @spec files(Plug.Conn.t()) :: {:ok, [Plug.Upload.t()]} | {:error, :invalid_form_body}
  def files(conn) do
    if multipart?(conn) do
      case conn.body_params["files"] do
        nil ->
          {:ok, []}

        %Plug.Upload{} = upload ->
          {:ok, [upload]}

        parts when is_map(parts) ->
          if Enum.all?(parts, fn {k, v} -> index?(k) and match?(%Plug.Upload{}, v) end) do
            {:ok, parts |> Enum.sort_by(fn {k, _} -> String.to_integer(k) end) |> Enum.map(&elem(&1, 1))}
          else
            {:error, :invalid_form_body}
          end

        _ ->
          {:error, :invalid_form_body}
      end
    else
      {:ok, []}
    end
  end

  @doc """
  Store every upload through the shared content-addressed store and build
  the Discord attachment objects. All-or-nothing: the first over-cap or
  disallowed file aborts the batch with `:too_large` / `:disallowed_mime`;
  a full store is `:volume_full`.
  """
  @spec store(Plug.Conn.t(), [Plug.Upload.t()]) :: {:ok, [map()]} | {:error, upload_error()}
  def store(_conn, []), do: {:ok, []}

  def store(conn, uploads) do
    uploads
    |> Enum.reduce_while({:ok, []}, fn upload, {:ok, acc} ->
      case store_one(conn, upload) do
        {:ok, attachment} -> {:cont, {:ok, [attachment | acc]}}
        {:error, _} = err -> {:halt, err}
      end
    end)
    |> case do
      {:ok, attachments} -> {:ok, Enum.reverse(attachments)}
      {:error, _} = err -> err
    end
  end

  defp store_one(conn, %Plug.Upload{} = upload) do
    case Cytale.Attachments.Upload.validate_and_store(upload, :message) do
      {:ok, descriptor} ->
        # The compat wire object: Discord attachment shape with an ABSOLUTE
        # url (the descriptor's is relative) and a fresh snowflake id.
        hash = String.replace_prefix(descriptor["url"], @attachment_base <> "/", "")

        {:ok,
         %{
           "id" => Snowflake.to_string(Snowflake.next()),
           "url" => ExternalUrl.build(conn, "#{@attachment_base}/#{hash}"),
           "filename" => descriptor["filename"],
           "size" => descriptor["size"],
           "content_type" => descriptor["content_type"]
         }
         |> maybe_dimensions(descriptor)}

      {:error, _} = err ->
        err
    end
  end

  # The store already sniffed the image's dimensions (PNG/GIF/JPEG headers) —
  # the message codec's attachment objects carry them, and dropping them here
  # left libraries without the size hint they lay placeholders out from.
  # Absent keys when the bytes do not parse, never null (the documented rule).
  defp maybe_dimensions(object, descriptor) do
    Enum.reduce(["width", "height"], object, fn key, acc ->
      case descriptor[key] do
        nil -> acc
        value -> Map.put(acc, key, value)
      end
    end)
  end

  defp index?(bin) when is_binary(bin) do
    case Integer.parse(bin) do
      {n, ""} when n >= 0 -> true
      _ -> false
    end
  end

  defp index?(_), do: false
end
