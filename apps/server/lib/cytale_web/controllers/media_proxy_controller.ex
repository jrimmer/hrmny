defmodule CytaleWeb.MediaProxyController do
  @moduledoc """
  `GET /api/v1/media/proxy?u=&e=&s=` — serve an external image from our
  origin (`Cytale.MediaProxy`).

  No auth pipeline, for the attachment route's reason: `<img>` cannot carry a
  bearer. The request must instead carry a live signature this server minted
  while rendering a message (`Cytale.MediaProxy.proxy_url/1`); anything else
  is refused before a single byte is fetched.

  Answers:

    * 200 — the image, with its SNIFFED `Content-Type`, `nosniff`,
      `Content-Disposition: inline`, and `Cache-Control: private, max-age=<the
      signature's remaining life>, immutable` (the bytes behind one signed URL
      never change, and the URL stops working when the signature does);
    * 403 — no/invalid signature (`media_url_invalid`) or an expired one
      (`media_url_expired`);
    * 404 — the proxy is off, or the source is one the SSRF guard refuses
      (`media_not_found` — no oracle about WHY an address was refused);
    * 415 — the body is not an accepted raster image, or its canvas is too big;
    * 502 — the origin failed: a non-2xx, a timeout, a body over the byte cap.

  Every error is JSON and every one is handled the same way by the web client:
  the image hides quietly, as an unloadable one always has.
  """

  use CytaleWeb, :controller

  alias Cytale.MediaProxy
  alias Cytale.MediaProxy.Metrics
  import CytaleWeb.API.Error, only: [error: 4]

  def show(conn, params) do
    with {:enabled, true} <- {:enabled, MediaProxy.enabled?()},
         {:ok, url, seconds_left} <- MediaProxy.verify(params["u"], params["e"], params["s"]) do
      serve(conn, MediaProxy.fetch(url), seconds_left)
    else
      {:enabled, false} ->
        Metrics.request("refused")
        error(conn, 404, "media_not_found", "The media proxy is not enabled.")

      :expired ->
        Metrics.request("refused")
        error(conn, 403, "media_url_expired", "This image link has expired.")

      :invalid ->
        Metrics.request("refused")
        error(conn, 403, "media_url_invalid", "This image link is not valid.")
    end
  end

  defp serve(conn, {:hit, path, content_type, size}, seconds_left) do
    Metrics.bytes("served", size)

    conn
    |> image_headers(content_type, seconds_left)
    |> send_file(200, path)
  end

  defp serve(conn, {:fetched, body, content_type}, seconds_left) do
    Metrics.bytes("served", byte_size(body))

    conn
    |> image_headers(content_type, seconds_left)
    |> send_resp(200, body)
  end

  defp serve(conn, {:error, :blocked}, _),
    do: error(conn, 404, "media_not_found", "That image cannot be fetched.")

  defp serve(conn, {:error, reason}, _) when reason in [:unsupported_type, :too_many_pixels],
    do: error(conn, 415, "unsupported_media_type", "That is not an image this server serves.")

  defp serve(conn, {:error, _upstream}, _),
    do: error(conn, 502, "media_fetch_failed", "The image could not be fetched.")

  defp image_headers(conn, content_type, seconds_left) do
    conn
    |> put_resp_content_type(content_type, nil)
    |> put_resp_header("content-disposition", "inline")
    |> put_resp_header("x-content-type-options", "nosniff")
    |> put_resp_header("cache-control", "private, max-age=#{seconds_left}, immutable")
    # Belt and braces for a navigation straight to the URL: the body is a
    # sniffed raster image, and even so it gets no script, no subresources,
    # and an opaque origin.
    |> put_resp_header(
      "content-security-policy",
      "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox"
    )
  end
end
