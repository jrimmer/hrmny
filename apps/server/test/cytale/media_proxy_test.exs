defmodule Cytale.MediaProxyTest do
  @moduledoc """
  The media proxy, DB-free: URL signing, the wire rewrites (embeds and the
  Markdown image map), and the fetch path against a LOCAL origin
  (`Cytale.MediaProxyStub`) — the SSRF refusals, the image-only gate, the
  size cap, and the cache.
  """

  # Application env (the proxy's seams) and the node-wide cache are shared.
  use ExUnit.Case, async: false

  alias Cytale.MediaProxy
  alias Cytale.MediaProxy.{Cache, Fetcher, Image, Metrics}
  alias Cytale.MediaProxyStub, as: Stub

  @now 1_800_000_000
  @ext "https://images.example.org/cat.png"
  @hash String.duplicate("ab", 32)

  defp query(url) do
    %URI{path: "/api/v1/media/proxy", query: q} = URI.parse(url)
    URI.decode_query(q)
  end

  describe "signing" do
    test "an external URL gets a signed same-origin proxy URL that verifies back to it" do
      proxied = MediaProxy.proxy_url(@ext, @now)
      assert String.starts_with?(proxied, "/api/v1/media/proxy?u=")
      %{"u" => u, "e" => e, "s" => s} = query(proxied)

      assert {:ok, @ext, left} = MediaProxy.verify(u, e, s, @now)
      ttl = Cytale.Config.attachment_url_ttl_seconds()
      assert left > ttl and left <= ttl + 3_600
    end

    test "renders inside one hour mint the same URL; a later hour mints a new one" do
      base = div(@now, 3_600) * 3_600
      assert MediaProxy.proxy_url(@ext, base + 1) == MediaProxy.proxy_url(@ext, base + 3_500)
      refute MediaProxy.proxy_url(@ext, base + 1) == MediaProxy.proxy_url(@ext, base + 3_601)
    end

    test "no signature, a tampered one, a swapped URL and an expired one are all refused" do
      %{"u" => u, "e" => e, "s" => s} = query(MediaProxy.proxy_url(@ext, @now))
      other = Base.url_encode64("https://evil.example/x.png", padding: false)

      assert MediaProxy.verify(u, e, nil, @now) == :invalid
      assert MediaProxy.verify(nil, nil, nil, @now) == :invalid
      assert MediaProxy.verify(u, e, s <> "x", @now) == :invalid
      assert MediaProxy.verify(other, e, s, @now) == :invalid
      assert MediaProxy.verify(u, Integer.to_string(String.to_integer(e) + 3_600), s, @now) == :invalid
      assert MediaProxy.verify("%%%", e, s, @now) == :invalid
      assert MediaProxy.verify(u, e, s, String.to_integer(e)) == :expired
    end

    test "an attachment signature can never stand in for a proxy signature (separate keys)" do
      signed = Cytale.Attachments.SignedUrl.sign("/api/v1/attachments/" <> @hash, @now)
      %{"e" => e, "s" => s} = URI.decode_query(URI.parse(signed).query)
      assert MediaProxy.verify(Base.url_encode64(@hash, padding: false), e, s, @now) == :invalid
    end

    test "internal and non-fetchable URLs get no proxy URL" do
      for url <- [
            "/api/v1/attachments/" <> @hash,
            "/api/v1/attachments/" <> @hash <> "?e=1&s=x",
            "https://chat.example/api/v1/attachments/" <> @hash,
            "attachment://chart.png",
            "/relative/path.png",
            "javascript:alert(1)",
            "data:image/png;base64,AAAA",
            "ftp://files.example/x.png",
            "https://user:pw@images.example.org/x.png",
            "https://images.example.org:22/x.png",
            "https://",
            nil,
            42
          ] do
        assert MediaProxy.proxy_url(url, @now) == nil, "expected no proxy for #{inspect(url)}"
      end
    end

    test "our own external origin is not proxied" do
      saved = Application.get_env(:cytale, :external_base_url)
      Application.put_env(:cytale, :external_base_url, "https://chat.example")
      on_exit(fn -> Application.put_env(:cytale, :external_base_url, saved) end)

      assert MediaProxy.proxy_url("https://chat.example/brand.png", @now) == nil
      assert MediaProxy.proxy_url("https://chat.example.evil/x.png", @now) != nil
    end

    test "off means no proxy URLs anywhere" do
      saved = Application.get_env(:cytale, :media_proxy)
      Application.put_env(:cytale, :media_proxy, enabled: false)
      on_exit(fn -> restore(:media_proxy, saved) end)

      assert MediaProxy.proxy_url(@ext, @now) == nil
      assert MediaProxy.content_proxy_urls("![a](#{@ext})") == %{}
      assert [%{"image" => %{"url" => @ext} = image}] = MediaProxy.wire_embeds([%{"image" => %{"url" => @ext}}])
      refute Map.has_key?(image, "proxy_url")
    end
  end

  describe "embeds on the wire" do
    test "every external media slot gains its Discord-named proxy key" do
      [embed] =
        MediaProxy.wire_embeds([
          %{
            "title" => "card",
            "image" => %{"url" => @ext, "width" => 10, "height" => 10},
            "thumbnail" => %{"url" => "https://images.example.org/t.jpg"},
            "author" => %{"name" => "a", "icon_url" => "https://images.example.org/a.png"},
            "footer" => %{"text" => "f", "icon_url" => "https://images.example.org/f.png"},
            "fields" => [%{"name" => "n", "value" => "v"}]
          }
        ])

      assert embed["image"]["url"] == @ext
      assert %{"u" => u} = query(embed["image"]["proxy_url"])
      assert Base.url_decode64!(u, padding: false) == @ext
      assert embed["image"]["width"] == 10
      assert embed["thumbnail"]["proxy_url"] =~ "/api/v1/media/proxy?"
      assert embed["author"]["proxy_icon_url"] =~ "/api/v1/media/proxy?"
      assert embed["footer"]["proxy_icon_url"] =~ "/api/v1/media/proxy?"
      assert embed["fields"] == [%{"name" => "n", "value" => "v"}]
    end

    test "attachment URLs and attachment:// refs stay exactly as stored (no proxy key)" do
      stored = [
        %{
          "image" => %{"url" => "/api/v1/attachments/" <> @hash},
          "thumbnail" => %{"url" => "attachment://thumb.png"},
          "footer" => %{"text" => "no icon"}
        }
      ]

      assert MediaProxy.wire_embeds(stored) == stored
    end

    test "a proxy key the PRODUCER sent is dropped, never echoed" do
      [embed] =
        MediaProxy.wire_embeds([
          %{
            "image" => %{"url" => "attachment://x.png", "proxy_url" => "https://tracker.example/p.gif"},
            "author" => %{"name" => "a", "proxy_icon_url" => "/api/v1/whatever"},
            "video" => %{"url" => "https://v.example/v.mp4", "proxy_url" => "https://tracker.example/v"}
          }
        ])

      refute Map.has_key?(embed["image"], "proxy_url")
      refute Map.has_key?(embed["author"], "proxy_icon_url")
      refute Map.has_key?(embed["video"], "proxy_url")
    end

    test "junk entries and junk slots pass through" do
      assert MediaProxy.wire_embeds([1, "x", %{"image" => "not a map"}]) == [1, "x", %{"image" => "not a map"}]
      assert MediaProxy.wire_embeds(nil) == nil
    end
  end

  describe "the Markdown image map" do
    test "maps each external image source to its proxy URL" do
      content = "look ![a cat](#{@ext}) and ![](https://images.example.org/d.gif \"title\") again ![a cat](#{@ext})"
      map = MediaProxy.content_proxy_urls(content)

      assert Map.keys(map) |> Enum.sort() == Enum.sort([@ext, "https://images.example.org/d.gif"])
      assert %{"u" => u} = query(map[@ext])
      assert Base.url_decode64!(u, padding: false) == @ext
    end

    test "links, bare URLs, non-http sources and attachment images mint nothing" do
      for content <- [
            "[not an image](#{@ext})",
            @ext,
            "![x](ftp://files.example/a.png)",
            "![x](/api/v1/attachments/#{@hash})",
            "![x](javascript:alert(1))",
            "plain text"
          ] do
        assert MediaProxy.content_proxy_urls(content) == %{}, content
      end
    end

    test "put_content_proxy_urls adds the key only when there is an image" do
      assert MediaProxy.put_content_proxy_urls(%{"content" => "hi"}, "hi") == %{"content" => "hi"}

      assert %{"content_proxy_urls" => %{@ext => _}} =
               MediaProxy.put_content_proxy_urls(%{}, "![x](#{@ext})")
    end

    test "at most 20 images per message" do
      content = Enum.map_join(1..30, " ", &"![#{&1}](https://images.example.org/#{&1}.png)")
      assert map_size(MediaProxy.content_proxy_urls(content)) == 20
    end
  end

  describe "sniffing" do
    test "accepts the raster set by magic bytes and refuses everything else" do
      assert {:ok, :png, "image/png"} = Image.sniff(Stub.png())
      assert {:ok, :jpeg, "image/jpeg"} = Image.sniff(<<0xFF, 0xD8, 0xFF, 0xE0, 0, 16>>)
      assert {:ok, :gif, "image/gif"} = Image.sniff("GIF89a" <> <<1, 0, 1, 0>>)
      assert {:ok, :webp, "image/webp"} = Image.sniff("RIFF" <> <<0::32>> <> "WEBPVP8 ")
      assert {:ok, :avif, "image/avif"} = Image.sniff(<<24::32, "ftypavif", 0::32, "mif1", "avif">>)
      assert {:ok, :avif, _} = Image.sniff(<<24::32, "ftypmif1", 0::32, "mif1", "avif">>)

      for body <- [
            "<svg xmlns=\"http://www.w3.org/2000/svg\"><script>alert(1)</script></svg>",
            "<?xml version=\"1.0\"?><svg/>",
            "<!doctype html><html></html>",
            <<0x1F, 0x8B, 8, 0>>,
            <<24::32, "ftypisom", 0::32, "isommp41">>,
            ""
          ] do
        assert Image.sniff(body) == {:error, :unsupported_type}
      end
    end

    test "a stated canvas past the pixel cap or 16384 a side is refused" do
      assert Image.check_dimensions(Stub.png_header(100, 100), :png, 50_000_000) == :ok
      assert Image.check_dimensions(Stub.png_header(10_000, 10_000), :png, 50_000_000) == {:error, :too_many_pixels}
      assert Image.check_dimensions(Stub.png_header(20_000, 10), :png, 50_000_000) == {:error, :too_many_pixels}

      vp8x = "RIFF" <> <<0::32>> <> "WEBPVP8X" <> <<10::little-32, 0::32, 29_999::little-24, 29_999::little-24>>
      assert Image.dimensions(vp8x, :webp) == {30_000, 30_000}
      assert Image.check_dimensions(vp8x, :webp, 50_000_000) == {:error, :too_many_pixels}
    end
  end

  describe "fetching (a local origin, no internet)" do
    setup do
      {:ok, Stub.start!()}
    end

    test "a PNG is fetched once, served with its sniffed type, then answered from the cache", %{base: base} do
      # The origin LIES about its type: the sniffed type is what is served.
      Stub.route("/cat.png", {200, [{"content-type", "text/html"}], Stub.png()})
      url = base <> "/cat.png"

      assert {:fetched, body, "image/png"} = MediaProxy.fetch(url)
      assert body == Stub.png()
      assert Stub.hits("/cat.png") == 1

      assert {:hit, path, "image/png", size} = MediaProxy.fetch(url)
      assert File.read!(path) == Stub.png()
      assert size == byte_size(Stub.png())
      assert Stub.hits("/cat.png") == 1, "a cache hit must not fetch again"
      assert Cache.total_bytes() >= size
    end

    test "SVG, HTML and a gzip-encoded body are refused as non-images", %{base: base} do
      Stub.route("/x.svg", {200, [{"content-type", "image/svg+xml"}], "<svg xmlns=\"http://www.w3.org/2000/svg\"/>"})
      Stub.route("/x.html", {200, [{"content-type", "image/png"}], "<html><body>hi</body></html>"})

      Stub.route(
        "/x.gz",
        {200, [{"content-type", "image/png"}, {"content-encoding", "gzip"}], :zlib.gzip(Stub.png())}
      )

      for p <- ["/x.svg", "/x.html", "/x.gz"] do
        assert MediaProxy.fetch(base <> p) == {:error, :unsupported_type}, p
      end
    end

    test "a pixel bomb's header is refused before it could ever be decoded", %{base: base} do
      Stub.route("/bomb.png", {200, [], Stub.png_header(50_000, 50_000) <> :binary.copy(<<0>>, 64)})
      assert MediaProxy.fetch(base <> "/bomb.png") == {:error, :too_many_pixels}
    end

    test "a body over the cap is refused — declared or streamed", %{base: base} do
      saved = Application.get_env(:cytale, :media_proxy)
      Application.put_env(:cytale, :media_proxy, Keyword.put(saved, :max_bytes, 1_000))

      Stub.route("/big.png", {200, [], Stub.png(:binary.copy(<<0>>, 5_000))})
      # Chunked: no Content-Length to trust, the stream is cut at the cap.
      Stub.route("/stream.png", {200, [], [Stub.png() | List.duplicate(:binary.copy(<<0>>, 400), 20)]})

      assert MediaProxy.fetch(base <> "/big.png") == {:error, :too_large}
      assert MediaProxy.fetch(base <> "/stream.png") == {:error, :too_large}
    end

    test "a private address is refused without a single request — literal, DNS, or mixed", %{port: port} do
      # The REAL guard, even for the stub's own loopback address.
      Application.put_env(:cytale, :media_proxy_address_allowed?, &Cytale.Net.AddressGuard.public?/1)
      Stub.route("/cat.png", {200, [], Stub.png()})
      assert Fetcher.get("http://127.0.0.1:#{port}/cat.png", 10_000) == {:error, :blocked_address}
      assert Fetcher.get("http://[::1]:#{port}/cat.png", 10_000) == {:error, :blocked_address}
      assert Fetcher.get("http://[::ffff:127.0.0.1]:#{port}/cat.png", 10_000) == {:error, :blocked_address}
      assert Fetcher.get("http://169.254.169.254/latest/meta-data/", 10_000) == {:error, :blocked_address}

      # A name that resolves private, and a round-robin with one private answer.
      assert Fetcher.get("http://private.test/cat.png", 10_000) == {:error, :blocked_address}
      assert Fetcher.get("http://mixed.test/cat.png", 10_000) == {:error, :blocked_address}
      assert Fetcher.get("http://nowhere.test/cat.png", 10_000) == {:error, :unresolvable}

      assert Stub.hits("/cat.png") == 0
      assert MediaProxy.fetch("http://private.test/cat.png") == {:error, :blocked}
    end

    test "a redirect into a private address is refused at the hop", %{base: base} do
      for {path, target} <- [
            {"/r1", "http://10.0.0.7/cat.png"},
            {"/r2", "http://169.254.169.254/latest/meta-data/"},
            {"/r3", "http://private.test/cat.png"},
            {"/r4", "http://[::ffff:127.0.0.2]/x.png"},
            {"/r5", "file:///etc/passwd"}
          ] do
        Stub.route(path, {302, [{"location", target}], ""})
        assert MediaProxy.fetch(base <> path) == {:error, :blocked}, "#{path} → #{target}"
      end
    end

    test "a public redirect is followed (relative Location too), a loop is cut off", %{base: base} do
      Stub.route("/old.png", {301, [{"location", "/new.png"}], ""})
      Stub.route("/new.png", {200, [], Stub.png()})
      assert {:fetched, _, "image/png"} = MediaProxy.fetch(base <> "/old.png")

      Stub.route("/loop", {302, [{"location", "/loop"}], ""})
      assert Fetcher.get(base <> "/loop", 10_000) == {:error, :too_many_redirects}
      assert Stub.hits("/loop") == 4
    end

    test "a failure is remembered briefly: the second view makes no request", %{base: base} do
      Stub.route("/gone.png", {404, [], "nope"})
      assert MediaProxy.fetch(base <> "/gone.png") == {:error, :upstream_error}
      assert MediaProxy.fetch(base <> "/gone.png") == {:error, :upstream_error}
      assert Stub.hits("/gone.png") == 1
    end

    test "the counters move", %{base: base} do
      before = Metrics.snapshot()
      Stub.route("/m.png", {200, [], Stub.png()})
      MediaProxy.fetch(base <> "/m.png")
      MediaProxy.fetch(base <> "/m.png")
      MediaProxy.fetch("http://private.test/m.png")

      after_ = Metrics.snapshot()
      delta = fn key -> after_[key] - before[key] end
      assert delta.({:request, "miss"}) == 2
      assert delta.({:request, "hit"}) == 1
      assert delta.({:fetch, "ok"}) == 1
      assert delta.({:fetch, "blocked"}) == 1
      assert delta.({:bytes, "fetched"}) == byte_size(Stub.png())
      assert Metrics.exposition() =~ ~s(cytale_media_proxy_requests_total{result="hit"})
      assert Metrics.exposition() =~ "cytale_media_proxy_cache_bytes "
    end

    test "the cache evicts least-recently-used entries past its cap", %{base: base} do
      for n <- 1..3 do
        Stub.route("/#{n}.png", {200, [], Stub.png(:binary.copy(<<n>>, 1_000))})
        assert {:fetched, _, _} = MediaProxy.fetch(base <> "/#{n}.png")
        # Distinct mtimes (second resolution) so recency is unambiguous.
        path = Cytale.Config.media_proxy_cache_dir() |> Path.join("**/" <> Cache.key(base <> "/#{n}.png"))
        [file] = Path.wildcard(path)
        File.touch!(file, System.os_time(:second) - 100 + n)
      end

      # Lower the cap only now, so no eviction races the setup above.
      saved = Application.get_env(:cytale, :media_proxy)
      Application.put_env(:cytale, :media_proxy, Keyword.put(saved, :cache_max_bytes, 2_500))
      Cache.sweep()
      assert Cache.total_bytes() <= 2_500
      # The oldest went; the newest stayed.
      assert Cache.lookup(Cache.key(base <> "/1.png")) == :miss
      assert {:hit, _, _, _} = Cache.lookup(Cache.key(base <> "/3.png"))
    end

    test "an expired entry is a miss and is fetched again", %{base: base} do
      Stub.route("/old.png", {200, [], Stub.png()})
      assert {:fetched, _, _} = MediaProxy.fetch(base <> "/old.png")

      saved = Application.get_env(:cytale, :media_proxy)
      Application.put_env(:cytale, :media_proxy, Keyword.put(saved, :cache_ttl_seconds, -1))
      assert {:fetched, _, _} = MediaProxy.fetch(base <> "/old.png")
      assert Stub.hits("/old.png") == 2
    end
  end

  defp restore(key, nil), do: Application.delete_env(:cytale, key)
  defp restore(key, value), do: Application.put_env(:cytale, key, value)
end
