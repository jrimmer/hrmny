defmodule Cytale.Attachments.SignedUrlTest do
  @moduledoc "Security Tier 2 #4 — the signing primitive, DB-free."

  use ExUnit.Case, async: true

  alias Cytale.Attachments.SignedUrl

  @hash String.duplicate("ab", 32)
  @path "/api/v1/attachments/" <> @hash
  @now 1_800_000_000

  defp parts(url) do
    %URI{path: path, query: query} = URI.parse(url)
    {path, URI.decode_query(query || "")}
  end

  test "signs relative and absolute attachment URLs; round-trips through verify" do
    {path, %{"e" => e, "s" => s}} = parts(SignedUrl.sign(@path, @now))
    assert path == @path
    assert {:ok, left} = SignedUrl.verify(@hash, e, s, @now)
    ttl = Cytale.Config.attachment_url_ttl_seconds()
    assert left > ttl and left <= ttl + 3_600

    abs = SignedUrl.sign("https://chat.example" <> @path, @now)
    assert String.starts_with?(abs, "https://chat.example" <> @path <> "?e=")
  end

  test "re-signing replaces an old signature (idempotent shape) and canonical strips it" do
    signed = SignedUrl.sign(@path <> "?e=1&s=old&retry=2", @now)
    assert [_, _] = String.split(signed, "?")
    refute signed =~ "old"
    assert SignedUrl.canonical(signed) == @path
    assert SignedUrl.canonical_attachment(%{"url" => signed, "filename" => "x"}) == %{"url" => @path, "filename" => "x"}
  end

  test "renders inside one hour mint the same URL (cacheable)" do
    base = div(@now, 3_600) * 3_600
    assert SignedUrl.sign(@path, base + 1) == SignedUrl.sign(@path, base + 3_500)
  end

  test "tampered, foreign-hash, malformed and expired signatures are refused" do
    {_, %{"e" => e, "s" => s}} = parts(SignedUrl.sign(@path, @now))
    other_hash = String.duplicate("cd", 32)

    assert SignedUrl.verify(@hash, e, s <> "x", @now) == :invalid
    assert SignedUrl.verify(other_hash, e, s, @now) == :invalid
    assert SignedUrl.verify(@hash, Integer.to_string(String.to_integer(e) + 3_600), s, @now) == :invalid
    assert SignedUrl.verify(@hash, "soon", s, @now) == :invalid
    assert SignedUrl.verify(@hash, nil, nil, @now) == :invalid
    assert SignedUrl.verify(@hash, e, s, String.to_integer(e)) == :expired
  end

  test "non-attachment URLs and non-strings pass through untouched" do
    for url <- ["https://example.com/cat.png", "/api/v1/attachments/nothex", nil, 42] do
      assert SignedUrl.sign(url, @now) == url
      assert SignedUrl.canonical(url) == url
    end
  end
end

defmodule CytaleWeb.Controllers.AttachmentSignedUrlTest do
  @moduledoc """
  Security Tier 2 #4 — attachment blobs are served to a live signature, and
  only public profile media (avatars/icons) serve unsigned.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn
  import Cytale.UploadHelpers

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Attachments.{PublicMedia, SignedUrl, Store}

  @endpoint CytaleWeb.Endpoint

  defp nonce, do: "r" <> Cytale.TestNonce.get() <> Integer.to_string(System.unique_integer([:positive]))

  # A PNG no other test uploads (a shared fixture blob could be someone's
  # avatar, which would make it public).
  defp unique_png, do: png_1x1() <> :crypto.strong_rand_bytes(24)

  setup do
    conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    username = "sg" <> String.slice(nonce(), 0, 20)
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    conn =
      put_req_header(conn, "authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

    ws = post(conn, "/api/v1/workspaces", %{"name" => "ws" <> nonce()})
    ws_id = Jason.decode!(ws.resp_body)["workspace"]["id"]
    ch = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => "c" <> nonce()})
    ch_id = Jason.decode!(ch.resp_body)["channel"]["id"]

    {:ok, conn: conn, user: user, ch_id: ch_id}
  end

  defp upload_attachment(conn, ch_id, blob) do
    conn = upload(conn, "pic.png", "image/png", blob)
    resp = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert resp.status == 201
    Jason.decode!(resp.resp_body)["attachment"]
  end

  defp fetch(url), do: get(build_conn(), url)

  test "signed → 200 (privately cacheable); unsigned, tampered → 404; expired → 403", %{conn: conn, ch_id: ch_id} do
    blob = unique_png()
    att = upload_attachment(conn, ch_id, blob)
    hash = Store.hash(blob)

    # The upload response is signed (the composer previews it).
    assert att["url"] =~ ~r|^/api/v1/attachments/#{hash}\?e=\d+&s=[A-Za-z0-9_-]+$|

    ok = fetch(att["url"])
    assert ok.status == 200
    assert ok.resp_body == blob
    [cache] = get_resp_header(ok, "cache-control")
    assert cache =~ ~r/^private, max-age=\d+$/
    refute cache =~ "public"

    # The web client's cache-busting retry param does not break the signature.
    assert fetch(att["url"] <> "&retry=1").status == 200

    assert fetch("/api/v1/attachments/#{hash}").status == 404
    assert fetch(String.replace(att["url"], ~r/s=.{4}/, "s=AAAA")).status == 404

    expired = SignedUrl.sign("/api/v1/attachments/#{hash}", System.system_time(:second) - 3 * 86_400)
    resp = fetch(expired)
    assert resp.status == 403
    assert %{"error" => %{"key" => "attachment_url_expired"}} = Jason.decode!(resp.resp_body)
  end

  test "messages store the canonical URL and every render re-signs it", %{conn: conn, ch_id: ch_id} do
    blob = unique_png()
    att = upload_attachment(conn, ch_id, blob)
    hash = Store.hash(blob)

    sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "look", "attachments" => [att]})
    assert sent.status in [200, 201]
    msg = Jason.decode!(sent.resp_body)
    msg = msg["message"] || msg

    # Stored unsigned…
    [stored] = Cytale.Messages.get_message(String.to_integer(ch_id), String.to_integer(msg["id"])).attachments
    assert stored["url"] == "/api/v1/attachments/#{hash}"

    # …rendered signed, and the rendered URL serves.
    list = get(conn, "/api/v1/channels/#{ch_id}/messages")
    body = Jason.decode!(list.resp_body)
    messages = if is_list(body), do: body, else: body["messages"]
    [rendered] = Enum.find(messages, &(&1["id"] == msg["id"]))["attachments"]
    assert rendered["url"] =~ "?e="
    assert fetch(rendered["url"]).status == 200
  end

  test "avatars are public profile media: unsigned 200, publicly cacheable", %{conn: conn} do
    blob = unique_png()
    conn = upload(conn, "me.png", "image/png", blob)
    resp = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert resp.status == 201
    avatar_url = Jason.decode!(resp.resp_body)["user"]["avatar_url"]
    assert avatar_url == "/api/v1/attachments/" <> Store.hash(blob)

    served = fetch(avatar_url)
    assert served.status == 200
    assert get_resp_header(served, "cache-control") == ["public, max-age=31536000, immutable"]
  end

  test "legacy avatars (stored before the public marker) are backfilled on first unsigned miss", %{user: user} do
    blob = unique_png()
    {:ok, %{"url" => url}} = Store.put(blob, "old.png", "image/png")
    :ok = User.update_profile!(user.user_id, nil, url)
    refute Store.public?(Store.hash(blob))

    File.rm(Path.join([Store.root(), ".public", "backfill-v1.done"]))
    PublicMedia.reset_cache()
    on_exit(fn -> PublicMedia.reset_cache() end)

    assert fetch(url).status == 200
    assert Store.public?(Store.hash(blob))
    assert File.exists?(Path.join([Store.root(), ".public", "backfill-v1.done"]))
  end

  test "the metadata sidecar is first-writer-wins" do
    blob = :crypto.strong_rand_bytes(64)
    hash = Store.hash(blob)
    {:ok, _} = Store.put(blob, "original.pdf", "application/pdf")
    {:ok, _} = Store.put(blob, "evil.html", "text/html")

    assert {:ok, %{"filename" => "original.pdf", "content_type" => "application/pdf"}} = Store.get_meta(hash)
    on_exit(fn -> Store.delete(hash) end)
  end
end
