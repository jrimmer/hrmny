defmodule CytaleWeb.Controllers.AttachmentControllerTest do
  @moduledoc """
  U21a — attachment upload surface: multipart upload → descriptor, size cap,
  mime allowlist, view-only gate (account_unverified), and blob serving.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  import Cytale.UploadHelpers

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, user} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    {:ok, conn: conn, user: user, ws_id: ws_id, ch_id: ch_id}
  end

  # -- helpers -------------------------------------------------------------------

  defp register_and_login(conn) do
    username = "u#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")

    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  # -- tests ---------------------------------------------------------------------

  test "upload an image → descriptor returned (happy path)", %{conn: conn, ch_id: ch_id} do
    blob = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4>>
    conn = upload(conn, "pic.png", "image/png", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201

    %{"attachment" => att} = Jason.decode!(conn.resp_body)
    assert att["filename"] == "pic.png"
    assert att["content_type"] == "image/png"
    assert att["size"] == byte_size(blob)
    assert String.starts_with?(att["url"], "/api/v1/attachments/")
  end

  # C-3: PNG/GIF/JPEG uploads carry sniffed width/height on the descriptor
  # AND the .meta sidecar; other types (and unparseable bytes) omit them.
  test "image uploads carry sniffed width/height (PNG/GIF/JPEG); non-images omit them", %{
    conn: conn,
    ch_id: ch_id
  } do
    for {filename, content_type, blob} <- [
          {"pic.png", "image/png", png_1x1()},
          {"pic.gif", "image/gif", gif_1x1()},
          {"pic.jpg", "image/jpeg", jpeg_1x1()}
        ] do
      conn = upload(conn, filename, content_type, blob)

      conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
      assert conn.status == 201

      %{"attachment" => att} = Jason.decode!(conn.resp_body)
      assert att["width"] == 1
      assert att["height"] == 1
      assert att["size"] == byte_size(blob)

      # The sidecar carries the same dims (hash from the served URL path).
      hash = URI.parse(att["url"]).path |> String.split("/") |> List.last()
      assert {:ok, %{"width" => 1, "height" => 1}} = Cytale.Attachments.Store.get_meta(hash)
    end

    conn = upload(conn, "note.txt", "text/plain", "hello")
    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201

    %{"attachment" => att} = Jason.decode!(conn.resp_body)
    refute Map.has_key?(att, "width")
    refute Map.has_key?(att, "height")
  end

  test "truncated/garbage image bytes → dims absent, never a crash", %{conn: conn, ch_id: ch_id} do
    for bad <- [
          # PNG signature + IHDR tag but the width/height bytes are cut off.
          binary_part(png_1x1(), 0, 16),
          # Random bytes labeled image/png.
          <<1, 2, 3, 4, 5, 6, 7, 8, 9, 10>>,
          # JPEG whose only segment is a truncated DHT (no SOF at all).
          <<0xFF, 0xD8, 0xFF, 0xC4, 0, 2>>,
          # JPEG with a valid SOF but the frame header cut mid-width.
          <<0xFF, 0xD8, 0xFF, 0xC0, 0, 17, 8, 0, 1>>
        ] do
      conn = upload(conn, "bad.png", "image/png", bad)

      conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
      assert conn.status == 201

      %{"attachment" => att} = Jason.decode!(conn.resp_body)
      refute Map.has_key?(att, "width"), "expected no width for #{inspect(bad)}"
      refute Map.has_key?(att, "height"), "expected no height for #{inspect(bad)}"
    end
  end

  test "oversized file → 413 file_too_large", %{conn: conn, ch_id: ch_id} do
    # 26 MB blob exceeds the 25 MB cap.
    blob = :binary.copy(<<0>>, 26 * 1024 * 1024)
    conn = upload(conn, "big.bin", "application/octet-stream", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 413
    assert %{"error" => %{"key" => "file_too_large"}} = Jason.decode!(conn.resp_body)
  end

  test "disallowed mime → 415 unsupported_media_type", %{conn: conn, ch_id: ch_id} do
    blob = "#!/bin/sh\necho hi"
    conn = upload(conn, "evil.sh", "application/x-sh", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 415
    assert %{"error" => %{"key" => "unsupported_media_type"}} = Jason.decode!(conn.resp_body)
  end

  test "unverified account → 403 account_unverified", %{ch_id: ch_id} do
    # A fresh UNVERIFIED account.
    username = "unv#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, _user} = User.create(username, "#{username}@example.com", "password-123")

    access =
      Auth.issue_access_token(
        Cytale.Accounts.User.get_by_identifier(username).user_id,
        username,
        false
      )

    unverified =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)

    unverified = upload(unverified, "a.txt", "text/plain", "hello")

    conn =
      post(unverified, "/api/v1/channels/#{ch_id}/attachments", unverified.private[:plug_upload_body])

    assert conn.status == 403
    assert %{"error" => %{"key" => "account_unverified"}} = Jason.decode!(conn.resp_body)
  end

  test "stored blob is served back by its content-addressed URL", %{conn: conn, ch_id: ch_id} do
    blob = "the quick brown fox"
    conn = upload(conn, "note.txt", "text/plain", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201
    url = Jason.decode!(conn.resp_body)["attachment"]["url"]

    # Serve it back through the SIGNED url (Tier 2 #4): cacheable privately
    # for no longer than the signature lives — never `public, immutable`,
    # which is reserved for avatar/icon blobs.
    conn = get(conn, url)
    assert conn.status == 200
    assert conn.resp_body == blob
    assert [cache] = get_resp_header(conn, "cache-control")
    assert cache =~ ~r/^private, max-age=\d+$/
  end

  test "serving sets the stored content-type and INLINE disposition for images", %{
    conn: conn,
    ch_id: ch_id
  } do
    blob = <<0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 1, 2, 3, 4>>
    conn = upload(conn, "pic.png", "image/png", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201
    url = Jason.decode!(conn.resp_body)["attachment"]["url"]

    conn = get(conn, url)
    assert conn.status == 200
    assert conn.resp_body == blob
    assert get_resp_header(conn, "content-type") == ["image/png"]
    assert get_resp_header(conn, "content-disposition") == ["inline; filename=\"pic.png\""]
  end

  test "non-image types serve with their type and an attachment disposition", %{conn: conn, ch_id: ch_id} do
    blob = "line one\nline two\n"
    conn = upload(conn, "notes.txt", "text/plain", blob)

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201
    url = Jason.decode!(conn.resp_body)["attachment"]["url"]

    conn = get(conn, url)
    assert conn.status == 200
    assert get_resp_header(conn, "content-type") == ["text/plain"]
    assert get_resp_header(conn, "content-disposition") == ["attachment; filename=\"notes.txt\""]
  end

  # #65: with the filename deciding a generic header, a script-bearing
  # extension resolves to its REAL type (application/x-sh — outside the
  # allowlist) instead of hiding behind the part's `text/plain` claim. The old
  # exact comparison admitted this; the gate now sees what the file is.
  test "a script-bearing extension is refused however the part is labelled", %{conn: conn, ch_id: ch_id} do
    conn = upload(conn, "run.sh", "text/plain", "#!/bin/sh\necho hi")

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 415
    assert %{"error" => %{"key" => "unsupported_media_type"}} = Jason.decode!(conn.resp_body)
  end

  # ...and the library shape is ADMITTED: every discord.py upload labels its
  # part application/octet-stream whatever the file is, so the filename must be
  # the signal or no bot can send anything (#65).
  test "an octet-stream part with an image filename is admitted as that image", %{conn: conn, ch_id: ch_id} do
    conn = upload(conn, "pixel.png", "application/octet-stream", Cytale.UploadHelpers.png_1x1())

    conn = post(conn, "/api/v1/channels/#{ch_id}/attachments", conn.private[:plug_upload_body])
    assert conn.status == 201

    att = Jason.decode!(conn.resp_body)["attachment"]
    assert att["content_type"] == "image/png"
    # The resolved type is an image, so the sniffed dimensions ride along.
    assert att["width"] == 1 and att["height"] == 1
  end

  test "a non-hash path segment is a 404, never a filesystem probe", %{conn: conn} do
    conn = get(conn, "/api/v1/attachments/notahashvalue")
    assert conn.status == 404
    assert %{"error" => %{"key" => "attachment_not_found"}} = Jason.decode!(conn.resp_body)
  end
end
