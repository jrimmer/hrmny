defmodule CytaleWeb.Controllers.AvatarControllerTest do
  @moduledoc """
  Avatar upload surface (upload consolidation): multipart image-only upload
  → atomic avatar_url set → UserUpdate dispatch; the tighter 10 MB cap and
  raster-only allowlist; the verification choke point; blob serving through
  the shared content-addressed path.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
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
    {:ok, conn: conn, user: user}
  end

  # -- helpers -------------------------------------------------------------------

  defp register_and_login(conn) do
    username = "av#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond) |> rem(100_000)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  # -- tests ---------------------------------------------------------------------

  test "upload an image → avatar_url set, blob served, UserUpdate dispatched", %{conn: conn, user: user} do
    conn = upload(conn, "me.png", "image/png", png_1x1())

    log =
      capture_log(fn ->
        conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
        assert conn.status == 201

        %{"user" => u} = Jason.decode!(conn.resp_body)
        assert u["id"] == Integer.to_string(user.user_id)
        assert String.starts_with?(u["avatar_url"], "/api/v1/attachments/")
        assert Regex.match?(~r|^/api/v1/attachments/[0-9a-f]{64}$|, u["avatar_url"])
      end)

    # The dispatch seam carried the public profile (no email) to every
    # workspace + DM the user touches.
    assert log =~ "event=UserUpdate"
    assert log =~ "\"avatar_url\" => \"/api/v1/attachments/"
    refute log =~ "@example.com"

    # The blob serves through the shared content-addressed path.
    fetched = User.get(user.user_id)
    hash = String.replace_prefix(fetched.avatar_url, "/api/v1/attachments/", "")
    served = get(build_conn(), "/api/v1/attachments/#{hash}")
    assert served.status == 200
    assert served.resp_body == png_1x1()
  end

  test "PATCH /users/@me profile changes also dispatch UserUpdate", %{conn: conn, user: user} do
    log =
      capture_log(fn ->
        conn = patch(conn, "/api/v1/users/@me", %{"display_name" => "New Name"})
        assert conn.status == 200
        %{"user" => u} = Jason.decode!(conn.resp_body)
        assert u["display_name"] == "New Name"
      end)

    assert log =~ "event=UserUpdate"
    assert log =~ "\"display_name\" => \"New Name\""
    assert log =~ "\"id\" => \"#{Integer.to_string(user.user_id)}\""
  end

  test "volume-full store → 507 storage_full on both avatar-purpose endpoints", %{
    conn: conn
  } do
    original = Application.get_env(:cytale, :attachments)
    # A 1-byte cap with the default watermarks rejects every new upload.
    Application.put_env(:cytale, :attachments, Keyword.put(original || [], :volume_cap_bytes, 1))

    on_exit(fn ->
      if original == nil do
        Application.delete_env(:cytale, :attachments)
      else
        Application.put_env(:cytale, :attachments, original)
      end
    end)

    conn = upload(conn, "me.png", "image/png", png_1x1())
    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 507
    assert %{"error" => %{"key" => "storage_full"}} = Jason.decode!(conn.resp_body)
  end

  test "the alternate `upload` multipart field name is accepted", %{conn: conn} do
    {body, ct} = multipart_body("me.png", "image/png", png_1x1())
    # Swap the field name the builder hardcodes.
    body = String.replace(body, "name=\"file\"", "name=\"upload\"", global: false)

    conn =
      conn
      |> put_req_header("content-type", ct)
      |> Plug.Conn.put_private(:plug_skip_csrf_protection, true)
      |> Plug.Conn.put_private(:plug_upload_body, body)

    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 201
    assert is_map(Jason.decode!(conn.resp_body)["user"])
  end

  test "PATCH /users/@me avatar_url is clear-only (non-empty refused 400)", %{
    conn: conn,
    user: user
  } do
    conn = upload(conn, "me.png", "image/png", png_1x1())
    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 201
    uploaded = Jason.decode!(conn.resp_body)["user"]["avatar_url"]
    assert is_binary(uploaded)

    refused = patch(conn, "/api/v1/users/@me", %{"avatar_url" => "https://evil.example/x.png"})
    assert refused.status == 400
    assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(refused.resp_body)

    # The uploaded avatar survived the refused PATCH.
    assert User.get(user.user_id).avatar_url == uploaded
  end

  test "clearing the avatar via PATCH dispatches UserUpdate with nil avatar_url", %{conn: conn} do
    conn = upload(conn, "me.png", "image/png", png_1x1())
    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 201

    log =
      capture_log(fn ->
        conn = patch(conn, "/api/v1/users/@me", %{"avatar_url" => ""})
        assert conn.status == 200
        %{"user" => u} = Jason.decode!(conn.resp_body)
        assert u["avatar_url"] == nil
      end)

    assert log =~ "event=UserUpdate"
    assert log =~ "\"avatar_url\" => nil"
  end

  test "non-image mime → 415 (the avatar allowlist is raster-only)", %{conn: conn} do
    conn = upload(conn, "notes.txt", "text/plain", "hello")

    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 415
    assert %{"error" => %{"key" => "unsupported_media_type"}} = Jason.decode!(conn.resp_body)
  end

  test "oversized image → 413 (2 MB avatar cap, tighter than message attachments)", %{conn: conn} do
    blob = :binary.copy(<<0>>, 2 * 1024 * 1024 + 1)
    conn = upload(conn, "big.png", "image/png", blob)

    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 413
    assert %{"error" => %{"key" => "file_too_large", "message" => msg}} = Jason.decode!(conn.resp_body)
    assert msg =~ "2 MB"
  end

  test "over-dimension image → 400 (4096px ceiling; avatars render en masse)", %{conn: conn} do
    conn = upload(conn, "huge.png", "image/png", png_with_dims(5000, 100))

    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed", "message" => msg}} = Jason.decode!(conn.resp_body)
    assert msg =~ "4096"
  end

  test "no file → 400", %{conn: conn} do
    conn = post(conn, "/api/v1/users/@me/avatar", %{})
    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
  end

  test "unverified account → 403 account_unverified (verification choke point)", %{conn: _conn} do
    username = run_unique("unv")
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, false)
    conn = put_req_header(build_conn(), "authorization", "Bearer " <> access)

    {body, ct} = multipart_body("me.png", "image/png", png_1x1())

    conn =
      conn
      |> put_req_header("content-type", ct)
      |> Plug.Conn.put_private(:plug_skip_csrf_protection, true)
      |> Plug.Conn.put_private(:plug_upload_body, body)

    conn = post(conn, "/api/v1/users/@me/avatar", conn.private[:plug_upload_body])
    assert conn.status == 403
    assert %{"error" => %{"key" => "account_unverified"}} = Jason.decode!(conn.resp_body)
  end
end
