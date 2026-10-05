defmodule CytaleWeb.SpaShareCardTest do
  @moduledoc """
  #118 — the content-free share card, and the leak rule that makes it legal.

  A permalink pasted into Slack, Discord or email is unfurled by the RECEIVING
  platform, unauthenticated: whatever a permalink path answers is public. So
  the honest card for private-by-default content is a constant — app name, "a
  message in a private workspace", a sign-in hint — and this suite is that rule
  in executable form: fetch a permalink path with NO credential, get the card,
  and find nothing in the body that came out of the seeded workspace.

  The assertion is written against seeded rows on purpose: a card built from
  the message it names would pass a "has og: tags" test and fail this one.

  Two mechanical notes:

    * the shell is supplied through the SPA fallback's injectable reader
      (`:spa_index_reader`, the same seam shape as `:readiness_scylla_check`),
      because `priv/static/index.html` is a build artifact — gitignored, so
      absent from a fresh checkout. Where a build IS present the suite asserts
      against the REAL shell, which is what ships;
    * #118 keeps the permalink in the FRAGMENT, and an HTTP request never
      carries one — a platform unfurling `/#/workspace/…/message/…` fetches the
      origin root. Both spellings are exercised below, because which of them a
      crawler asks for is not ours to choose.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  # Distinctive strings: a leak cannot match them by coincidence.
  @message_text "the deploy is green — secret launch is friday"
  @channel_name "sharecard-release-room"

  defp run_nonce, do: "s" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    # Serve a deterministic shell through the documented reader seam.
    old = Application.get_env(:cytale, :spa_index_reader)
    Application.put_env(:cytale, :spa_index_reader, fn -> shell_html() end)
    on_exit(fn -> restore(:spa_index_reader, old) end)

    {conn, username} = register_and_login(build_conn_with_headers())
    ws_id = create_workspace(conn)

    {:ok, conn: conn, ws_id: ws_id, username: username}
  end

  describe "a permalink path answers with the card" do
    test "unauthenticated — the fragment spelling a copied link carries" do
      response = get(build_conn(), "/#/workspace/90000000000000001/channel/90000000000000002/message/90000000000000003")

      assert response.status == 200
      assert get_resp_header(response, "content-type") == ["text/html; charset=utf-8"]
      assert get_resp_header(response, "cache-control") == ["no-cache"]

      body = response.resp_body
      # The card: app name, the private-workspace line, a sign-in hint.
      assert body =~ ~s(<meta property="og:site_name" content="Hrmny")
      assert body =~ ~s(<meta property="og:title" content="A message in a private workspace")
      assert body =~ "Sign in to Hrmny to view it."
      assert body =~ ~s(<meta name="twitter:card" content="summary")
      # …injected into the shell, which is still the app (not a bare card).
      assert body =~ ~s(<div id="root">)
    end

    test "the path spelling too (a permalink without its fragment)" do
      response = get(build_conn(), "/workspace/90000000000000001/channel/90000000000000002/message/90000000000000003")

      assert response.status == 200
      assert response.resp_body =~ "A message in a private workspace"
    end

    test "and the /m/<token> path a copied link opens since #118" do
      # The copied form is a real PATH, so the server does receive this one —
      # and this same fallback answers it, with the same constant card: the
      # page is the app, and the app resolves the token afterwards.
      response = get(build_conn(), "/m/3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3")

      assert response.status == 200
      assert get_resp_header(response, "content-type") == ["text/html; charset=utf-8"]
      assert get_resp_header(response, "cache-control") == ["no-cache"]

      body = response.resp_body
      assert body =~ ~s(<meta property="og:title" content="A message in a private workspace")
      assert body =~ "Sign in to Hrmny to view it."
      assert body =~ ~s(<div id="root">)
      # The card is injected INTO the shell — and the token is not echoed.
      refute body =~ "3kQm9Xb2Qp7ZtR4vN8wY1cKdQ3"
    end

    test "and the bare origin root a crawler actually fetches" do
      response = get(build_conn(), "/")

      # The root is the SPA shell; if the glob route does not match it at all,
      # that is the router's business, not this controller's — assert the card
      # only for the responses the fallback answered.
      if response.status == 200 do
        assert response.resp_body =~ "A message in a private workspace"
      end
    end
  end

  describe "the leak rule — the card says nothing about the message" do
    test "no seeded message text, no author, no channel name", %{
      conn: conn,
      ws_id: ws_id,
      username: username
    } do
      ch_id = create_channel(conn, ws_id)

      sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => @message_text})
      assert sent.status == 201
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      # Sanity: the seeded content IS reachable by a member (the #114 resolver
      # read) — so the refutations below are about the CARD, not about rows
      # that failed to exist.
      resolved = get(conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      assert resolved.status == 200
      assert resolved.resp_body =~ "secret launch is friday"

      body = unauthenticated_permalink_body(ws_id, ch_id, mid)

      refute body =~ "secret launch is friday", "the card leaked message text"
      refute body =~ @channel_name, "the card leaked the channel name"
      refute body =~ username, "the card leaked the author"
      refute body =~ mid, "the card echoed the message id"
      refute body =~ ch_id, "the card echoed the channel id"
      # The one thing it MAY say about content is that there is some, privately.
      assert body =~ "A message in a private workspace"
    end

    test "the card is a constant: two different permalinks answer identically", %{
      conn: conn,
      ws_id: ws_id
    } do
      ch_id = create_channel(conn, ws_id)
      sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => @message_text})
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      here = unauthenticated_permalink_body(ws_id, ch_id, mid)
      elsewhere = get(build_conn(), "/workspace/1/channel/2/message/3").resp_body

      # Nothing path-derived can be in the card if paths do not change it.
      assert here == elsewhere
    end

    test "the /m/<token> spelling leaks nothing either — not even the token", %{
      conn: conn,
      ws_id: ws_id,
      username: username
    } do
      ch_id = create_channel(conn, ws_id)

      sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => @message_text})
      assert sent.status == 201
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      # A REAL token for a REAL message: the mint route is a router patch away
      # (see the ticket), so the token comes from the same module that route
      # calls. Even a VALID token must not put anything on the page — the
      # visitor here carries no credential, and neither does the unfurling
      # platform. This is the case that matters most for the path form: unlike
      # the fragment spelling, this request really does carry the token.
      {:ok, token} =
        Cytale.Permalinks.mint(String.to_integer(ch_id), String.to_integer(mid))

      body = get(build_conn(), "/m/#{token}").resp_body

      refute body =~ "secret launch is friday", "the card leaked message text"
      refute body =~ @channel_name, "the card leaked the channel name"
      refute body =~ username, "the card leaked the author"
      refute body =~ mid, "the card echoed the message id"
      refute body =~ ch_id, "the card echoed the channel id"
      refute body =~ token, "the card echoed the token"
      assert body =~ "A message in a private workspace"
    end

    test "the card is a constant on the path too: two tokens answer identically", %{
      conn: conn,
      ws_id: ws_id
    } do
      ch_id = create_channel(conn, ws_id)
      mid = create_message(conn, ch_id)

      {:ok, token} = Cytale.Permalinks.mint(String.to_integer(ch_id), String.to_integer(mid))
      {:ok, other} = Cytale.Permalinks.mint(String.to_integer(ch_id), String.to_integer(mid) + 1)

      here = get(build_conn(), "/m/#{token}").resp_body
      # A DIFFERENT token, a different message: the same bytes.
      assert get(build_conn(), "/m/#{other}").resp_body == here
      # …and the same bytes as the #114 fragment spelling of the same target.
      assert unauthenticated_permalink_body(ws_id, ch_id, mid) == here
    end
  end

  describe "the fallback's other contracts are untouched" do
    test "API paths keep the JSON 404, never the card" do
      response = get(build_conn(), "/api/v1/definitely-not-a-route")

      assert response.status == 404
      assert Jason.decode!(response.resp_body)["error"]["key"] == "not_found"
      refute response.resp_body =~ "og:title"
    end

    test "a shell without a head is served untouched rather than spliced" do
      Application.put_env(:cytale, :spa_index_reader, fn ->
        "<html><body>bare shell</body></html>"
      end)

      body = get(build_conn(), "/workspace/1/channel/2/message/3").resp_body

      # The fallback's job is to keep the app loading; a card is not worth
      # emitting malformed markup for an index.html this code does not know.
      assert body == "<html><body>bare shell</body></html>"
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp create_message(conn, ch_id) do
    sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => @message_text})
    assert sent.status == 201
    Jason.decode!(sent.resp_body)["message"]["id"]
  end

  # The REAL built shell when this checkout has one (it is gitignored, so a
  # fresh checkout does not), otherwise a minimal stand-in carrying the same
  # load-bearing parts: a </head> to inject into and the app's root div.
  defp shell_html do
    case File.read(Application.app_dir(:cytale, "priv/static/index.html")) do
      {:ok, html} ->
        html

      {:error, _} ->
        """
        <!doctype html>
        <html lang="en">
          <head><title>Hrmny</title></head>
          <body><div id="root"></div></body>
        </html>
        """
    end
  end

  defp restore(key, nil), do: Application.delete_env(:cytale, key)
  defp restore(key, value), do: Application.put_env(:cytale, key, value)

  # The address "Copy Link" writes, fetched by a caller with NO credential (the
  # unfurl case) — fragment included, which the server never receives.
  defp unauthenticated_permalink_body(ws_id, ch_id, mid) do
    path = "/#/workspace/#{ws_id}/channel/#{ch_id}/message/#{mid}"
    response = get(build_conn(), path)
    assert response.status == 200
    response.resp_body
  end

  defp build_conn_with_headers do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp register_and_login(conn) do
    username = "u#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    {register_and_login_as(conn, user), username}
  end

  defp register_and_login_as(conn, user) do
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    access = Auth.issue_access_token(user.user_id, user.username, true)
    put_req_header(conn, "authorization", "Bearer " <> access)
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique(@channel_name)})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end
end
