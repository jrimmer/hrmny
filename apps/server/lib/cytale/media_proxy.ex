defmodule Cytale.MediaProxy do
  @moduledoc """
  The media proxy: external images, fetched by the server and served from our
  own origin — Discord's `images-ext-*.discordapp.net` / `proxy_url`, Slack's
  `slack-imgs.com`.

  The app's CSP is `img-src 'self' data: blob:`, so a browser will not load a
  third-party image at all. Rather than loosen it, every external image a
  message shows — an embed's image, thumbnail, author or footer icon, or a
  Markdown `![alt](url)` in the body — reaches the client as a URL on THIS
  origin. A viewer's IP and read timing never reach the image's host (no
  tracking pixels), the image is frozen as first fetched, and its size and
  type are bounded.

  ## One code path, bots and people alike

  A bot's embed image and a person's Markdown image go through the same
  `proxy_url/1`, the same endpoint and the same fetcher; nothing here knows
  who authored the message.

  ## Signed, short-lived URLs (the attachment model)

      /api/v1/media/proxy?u=<base64url(url)>&e=<unix expiry>&s=<HMAC>

  * **Not an open proxy.** The endpoint serves only URLs this server signed,
    and it signs only URLs it found in a message it was RENDERING. `s` is
    HMAC-SHA256 over `"<e>.<url>"` with a key derived from `secret_key_base`
    under its own salt (distinct from the attachment key, so neither
    signature can stand in for the other).
  * **Minted at render, never stored.** The stored message keeps the author's
    URL; every wire render (REST, gateway dispatch, compat) computes the
    proxy URL afresh. A stored proxy URL would expire in the database, and
    would pin today's secret into rows forever.
  * **Expiry = `Cytale.Attachments.SignedUrl`'s.** `e` is rounded up to the
    hour, `attachment_url_ttl_seconds .. + 1h` ahead, so renders within one
    hour mint byte-identical URLs (browser caches and React's unchanged-`src`
    short-circuit keep working) and a URL copied out of the product stops
    working a day later, exactly as an attachment's does.
  * **No bearer auth on the GET.** `<img>` cannot carry one — the same reason
    attachments are signed rather than authenticated. The signature IS the
    capability, and only a viewer who could read the message ever received
    it. What it unlocks is a copy of an image the message's author already
    pointed at the public internet.

  What counts as external: an absolute `http`/`https` URL on a port the
  fetcher allows, that is NOT one of our attachment URLs
  (`/api/v1/attachments/…`, relative or absolute), not on our own external
  origin, and not an `attachment://` reference. Those stay exactly as they
  are, with no proxy key.
  """

  alias Cytale.Attachments.SignedUrl
  alias Cytale.MediaProxy.{Cache, Fetcher, Image, Metrics}

  @path "/api/v1/media/proxy"
  @salt "cytale media proxy url v1"
  @max_content_images 20

  # Our own attachment URLs, relative or absolute — `SignedUrl`'s shape. They
  # are served (and signed) by the attachment route, never proxied.
  @attachment_url ~r"\A(?:https?://[^/?#]+)?/api/v1/attachments/[0-9a-f]{64}(?:\?[^#]*)?\z"

  # Discord's media slots and the key its proxy copy rides under.
  @media_slots [
    {"image", "url", "proxy_url"},
    {"thumbnail", "url", "proxy_url"},
    {"author", "icon_url", "proxy_icon_url"},
    {"footer", "icon_url", "proxy_icon_url"}
  ]

  # `![alt](url)` / `![alt](url "title")`, as `@cytale/markdown`'s IMAGE rule
  # reads it — http(s) sources only. Kept in step with packages/markdown's
  # `IMAGE_AT`; a construct the regex over-matches (inside a code span, say)
  # only mints an unused map entry.
  @markdown_image ~r/!\[(?:[^\[\]\\\n]|\\[^\n])*\]\((https?:\/\/[^)\s]+)(?: "[^"\n]*")?\)/

  @doc "Whether the proxy is on (`Cytale.Config.media_proxy_enabled?/0`)."
  @spec enabled?() :: boolean()
  def enabled?, do: Cytale.Config.media_proxy_enabled?()

  @doc """
  The signed proxy URL for an external image URL, or nil when `url` is not
  external (or the proxy is off).
  """
  @spec proxy_url(term(), integer()) :: String.t() | nil
  def proxy_url(url, now_s \\ System.system_time(:second))

  def proxy_url(url, now_s) when is_binary(url) do
    if enabled?() and external?(url) do
      exp = SignedUrl.expiry(now_s)
      e = Integer.to_string(exp)
      @path <> "?u=" <> Base.url_encode64(url, padding: false) <> "&e=" <> e <> "&s=" <> signature(url, e)
    end
  end

  def proxy_url(_url, _now_s), do: nil

  @doc "True when `url` is an image source the proxy would fetch (see the moduledoc)."
  @spec external?(term()) :: boolean()
  def external?(url) when is_binary(url) do
    match?({:ok, _uri}, Fetcher.parse(url)) and not Regex.match?(@attachment_url, url) and
      not own_origin?(url)
  end

  def external?(_url), do: false

  @doc """
  Verify a request's `u`/`e`/`s`: `{:ok, url, seconds_left}` for a genuine,
  live signature; `:expired` for a genuine stale one; `:invalid` otherwise.
  """
  @spec verify(term(), term(), term(), integer()) :: {:ok, String.t(), pos_integer()} | :expired | :invalid
  def verify(u, e, s, now_s \\ System.system_time(:second))

  def verify(u, e, s, now_s) when is_binary(u) and is_binary(e) and is_binary(s) do
    with {:ok, url} <- Base.url_decode64(u, padding: false),
         {exp, ""} <- Integer.parse(e),
         true <- Plug.Crypto.secure_compare(signature(url, e), s) do
      if exp > now_s, do: {:ok, url, exp - now_s}, else: :expired
    else
      _ -> :invalid
    end
  end

  def verify(_u, _e, _s, _now_s), do: :invalid

  # -- the wire ------------------------------------------------------------------------

  @doc """
  Embeds as they ride every wire: each media slot whose source is external
  gains its proxy key (`image.proxy_url`, `thumbnail.proxy_url`,
  `author.proxy_icon_url`, `footer.proxy_icon_url` — Discord's names). A
  proxy key the PRODUCER sent is always dropped first: the only proxy URL a
  client ever sees is one this server minted. Non-map entries pass through.
  """
  @spec wire_embeds(term()) :: term()
  def wire_embeds(embeds) when is_list(embeds), do: Enum.map(embeds, &wire_embed/1)
  def wire_embeds(other), do: other

  defp wire_embed(%{} = embed) do
    embed =
      case embed do
        %{"video" => %{} = video} -> Map.put(embed, "video", Map.delete(video, "proxy_url"))
        _ -> embed
      end

    Enum.reduce(@media_slots, embed, fn {slot, source_key, proxy_key}, acc ->
      case Map.get(acc, slot) do
        %{} = media ->
          media = Map.delete(media, proxy_key)

          media =
            case proxy_url(Map.get(media, source_key)) do
              nil -> media
              proxied -> Map.put(media, proxy_key, proxied)
            end

          Map.put(acc, slot, media)

        _ ->
          acc
      end
    end)
  end

  defp wire_embed(other), do: other

  @doc """
  `%{source url => proxy url}` for the Markdown images in a message body — at
  most #{@max_content_images}, external sources only. The client looks each
  image node's `src` up here; an image with no entry renders as a plain link.
  """
  @spec content_proxy_urls(term()) :: %{String.t() => String.t()}
  def content_proxy_urls(content) when is_binary(content) do
    if enabled?() and String.contains?(content, "![") do
      @markdown_image
      |> Regex.scan(content, capture: :all_but_first)
      |> Enum.map(fn [url] -> url end)
      |> Enum.uniq()
      |> Enum.take(@max_content_images)
      |> Enum.flat_map(fn url ->
        case proxy_url(url) do
          nil -> []
          proxied -> [{url, proxied}]
        end
      end)
      |> Map.new()
    else
      %{}
    end
  end

  def content_proxy_urls(_content), do: %{}

  @doc """
  The native message wire's `content_proxy_urls`: present ONLY when the body
  has at least one external Markdown image (the optional-key growth `embeds`
  set). Shared by both native renderers (`Cytale.Messages.Message.to_wire/1`
  and `CytaleWeb.MessageController.message_json/3`).
  """
  @spec put_content_proxy_urls(map(), term()) :: map()
  def put_content_proxy_urls(wire, content) do
    case content_proxy_urls(content) do
      map when map_size(map) == 0 -> wire
      map -> Map.put(wire, "content_proxy_urls", map)
    end
  end

  # -- serving -------------------------------------------------------------------------

  @typedoc "Why a proxied image is not served."
  @type failure ::
          :blocked | :unsupported_type | :too_many_pixels | :too_large | :upstream_error | :timeout

  @doc """
  The image for a verified source URL: `{:hit, path, content_type, size}`
  from the disk cache, `{:fetched, body, content_type}` after a fetch (now
  cached), or `{:error, failure}` (now remembered briefly).
  """
  @spec fetch(String.t()) ::
          {:hit, String.t(), String.t(), non_neg_integer()}
          | {:fetched, binary(), String.t()}
          | {:error, failure()}
  def fetch(url) do
    key = Cache.key(url)

    case Cache.lookup(key) do
      {:hit, _path, _ct, _size} = hit ->
        Metrics.request("hit")
        hit

      {:negative, failure} ->
        Metrics.request("negative")
        {:error, failure}

      :miss ->
        Metrics.request("miss")

        case fetch_image(url) do
          {:ok, body, content_type} ->
            Metrics.fetch("ok")
            Metrics.bytes("fetched", byte_size(body))
            Cache.put(key, body, content_type)
            {:fetched, body, content_type}

          {:error, failure} ->
            Metrics.fetch(Atom.to_string(failure))
            Cache.put_negative(key, failure)
            {:error, failure}
        end
    end
  end

  defp fetch_image(url) do
    with {:ok, body} <- Fetcher.get(url, Cytale.Config.media_proxy_max_bytes()) |> classify(),
         {:ok, kind, content_type} <- Image.sniff(body),
         :ok <- Image.check_dimensions(body, kind, Cytale.Config.media_proxy_max_pixels()) do
      {:ok, body, content_type}
    end
  end

  # The fetcher's reasons, folded onto the few a client or a dashboard needs.
  defp classify({:ok, _body} = ok), do: ok

  defp classify({:error, reason}) when reason in [:invalid_url, :scheme, :port, :unresolvable, :blocked_address],
    do: {:error, :blocked}

  defp classify({:error, reason}) when reason in [:too_large, :timeout], do: {:error, reason}
  defp classify({:error, _other}), do: {:error, :upstream_error}

  # -- internals -----------------------------------------------------------------------

  defp own_origin?(url) do
    case Cytale.Config.external_base_url() do
      origin when is_binary(origin) and origin != "" ->
        base = String.trim_trailing(origin, "/")
        url == base or String.starts_with?(url, base <> "/")

      _ ->
        false
    end
  end

  defp signature(url, e) do
    :hmac
    |> :crypto.mac(:sha256, key(), e <> "." <> url)
    |> Base.url_encode64(padding: false)
  end

  # Derived once per secret_key_base and cached (PBKDF2 is deliberately slow;
  # this runs for every external image on every render).
  defp key do
    secret = CytaleWeb.Endpoint.config(:secret_key_base)

    case :persistent_term.get({__MODULE__, :key}, nil) do
      {^secret, key} ->
        key

      _ ->
        key = Plug.Crypto.KeyGenerator.generate(secret, @salt, length: 32)
        :persistent_term.put({__MODULE__, :key}, {secret, key})
        key
    end
  end
end
