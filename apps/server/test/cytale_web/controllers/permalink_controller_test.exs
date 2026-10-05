defmodule CytaleWeb.Controllers.PermalinkControllerTest do
  @moduledoc """
  #118 — the two ends of an opaque permalink: `POST /api/v1/permalinks` (mint)
  and `GET /api/v1/permalinks/{token}` (resolve).

  ## Why this suite calls the controller actions directly

  `router.ex` belongs to a parallel agent's work in flight (#117), so the two
  routes are handed over as a patch rather than landed here (see the ticket's
  report). The actions are therefore invoked with the params the router would
  pass, and the conn is authenticated by running **the pipeline's own plug**
  (`CytaleWeb.Plugs.Auth`) rather than by hand-building a `current_user` —
  so what is under test is the gate, not a test-only copy of it. The route
  SHAPE this suite depends on is `POST /api/v1/permalinks` and
  `GET /api/v1/permalinks/:token`, both behind `:api_auth`.

  What is pinned:

    * round trip: mint a token, resolve it, get the same ids back — for a
      workspace channel AND for a DM (which no workspace segment could name);
    * **the gate**: a non-member resolving a token for a channel they cannot
      see gets the byte-identical 404 an unknown token gets (equality, not
      merely "both 404"), and minting against that channel is refused too;
    * **tamper**: a mutated token is that same 404, never a different message;
    * opacity is not authorization — a forwarded token checks the READER.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias CytaleWeb.PermalinkController

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations.
  defp run_nonce, do: "p" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn = build_conn_with_headers()
    {conn, owner} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    {:ok, conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id}
  end

  describe "mint → resolve" do
    test "the round trip returns the same ids, and the URL carries the token", %{
      conn: conn,
      ch_id: ch_id
    } do
      mid = send_message(conn, ch_id, "permalink me")

      minted = mint(conn, ch_id, mid)
      assert minted.status == 200
      %{"token" => token, "url" => url} = Jason.decode!(minted.resp_body)

      # The copied URL is path-form and opaque: `/m/<token>`, nothing else.
      assert String.ends_with?(url, "/m/" <> token)
      refute url =~ "workspace"
      refute url =~ "channel/"
      refute url =~ mid

      resolved = resolve(conn, token)
      assert resolved.status == 200

      assert Jason.decode!(resolved.resp_body) == %{
               "channel_id" => ch_id,
               "message_id" => mid
             }
    end

    test "minting is stable: the same message mints the same token twice", %{conn: conn, ch_id: ch_id} do
      mid = send_message(conn, ch_id, "same link please")

      first = Jason.decode!(mint(conn, ch_id, mid).resp_body)["token"]
      second = Jason.decode!(mint(conn, ch_id, mid).resp_body)["token"]

      assert first == second
    end

    test "a DM message works — there is no workspace in a token to be missing", %{
      conn: conn,
      owner: owner
    } do
      {:ok, other} =
        User.create(run_unique("pl_other"), run_unique("pl_other@example.com"), "password-123")

      Cytale.Test.SharedWorkspace.share!(owner.user_id, other.user_id)
      created = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
      assert created.status == 201
      dm_id = Jason.decode!(created.resp_body)["channel"]["id"]

      mid = send_message(conn, dm_id, "dm permalink")

      # Both participants mint and resolve it.
      other_conn = register_and_login_as(build_conn_with_headers(), other)

      for participant <- [conn, other_conn] do
        token = Jason.decode!(mint(participant, dm_id, mid).resp_body)["token"]

        assert Jason.decode!(resolve(participant, token).resp_body) == %{
                 "channel_id" => dm_id,
                 "message_id" => mid
               }
      end

      # A stranger gets the uniform 404, exactly as for a channel that does not
      # exist — the DM's existence is not disclosed.
      {stranger_conn, _stranger} = register_and_login(build_conn_with_headers())
      token = Jason.decode!(mint(conn, dm_id, mid).resp_body)["token"]

      denied = resolve(stranger_conn, token)
      assert denied.status == 404
      assert denied.resp_body == resolve(stranger_conn, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").resp_body
      assert owner.user_id != other.user_id
    end

    test "a token does not have to name a live message", %{conn: conn, ch_id: ch_id} do
      # Deliberate: the mint gate is the CHANNEL (see the controller's moduledoc
      # — checking the message would add a read and an oracle for message ids).
      # The consequence, pinned so nobody "fixes" it by accident: the resolve
      # returns the pair, and #114's message read is what reports the 404.
      unknown_message = "123456789012345678"

      token = Jason.decode!(mint(conn, ch_id, unknown_message).resp_body)["token"]

      assert Jason.decode!(resolve(conn, token).resp_body)["message_id"] == unknown_message
      assert get(conn, "/api/v1/channels/#{ch_id}/messages/#{unknown_message}").status == 404
    end
  end

  describe "the gate — a token is not authorization" do
    test "non-member, unknown token and tampered token are byte-identical 404s", %{
      conn: conn,
      ch_id: ch_id
    } do
      mid = send_message(conn, ch_id, "hidden from strangers")
      token = Jason.decode!(mint(conn, ch_id, mid).resp_body)["token"]

      # A second workspace the stranger has nothing to do with, holding a real
      # message: the probe that WOULD leak if the gate were missing.
      {stranger_conn, _stranger} = register_and_login(build_conn_with_headers())
      {owner2_conn, _owner2} = register_and_login(build_conn_with_headers())
      ws2 = create_workspace(owner2_conn)
      ch2 = create_channel(owner2_conn, ws2)
      mid2 = send_message(owner2_conn, ch2, "cross-workspace secret")
      token2 = Jason.decode!(mint(owner2_conn, ch2, mid2).resp_body)["token"]

      real = resolve(stranger_conn, token)
      foreign_real = resolve(stranger_conn, token2)
      unknown = resolve(stranger_conn, "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")
      tampered = resolve(stranger_conn, tamper(token))

      # Nothing leaked content…
      for response <- [real, foreign_real, unknown, tampered] do
        assert response.status == 404
        refute response.resp_body =~ "hidden from strangers"
        refute response.resp_body =~ "cross-workspace secret"
        # …and no key names the reason: one shape for every miss.
        assert Jason.decode!(response.resp_body)["error"]["key"] == "permalink_not_found"
      end

      # …and the five bodies are the SAME BYTES. This is the ticket's equality
      # assertion: a body that varied between "you may not have this channel"
      # and "no such token" would be an existence oracle for a stranger.
      assert foreign_real.resp_body == real.resp_body
      assert unknown.resp_body == real.resp_body
      assert tampered.resp_body == real.resp_body

      # A member asking for a token that is not theirs to see also gets it —
      # membership is not an oracle either.
      assert resolve(conn, token2).resp_body == real.resp_body

      # The unrelated owner still resolves their own token.
      assert resolve(owner2_conn, token2).status == 200
    end

    test "minting against a channel the caller cannot see is refused the same way", %{
      conn: conn,
      ch_id: ch_id
    } do
      mid = send_message(conn, ch_id, "not for strangers")

      {stranger_conn, _stranger} = register_and_login(build_conn_with_headers())

      denied = mint(stranger_conn, ch_id, mid)
      assert denied.status == 404
      assert Jason.decode!(denied.resp_body)["error"]["key"] == "channel_not_found"
      refute denied.resp_body =~ mid

      # …and a channel that does not exist answers identically, so the mint
      # cannot be used to probe for channels.
      unknown = mint(stranger_conn, "999999999999999999", mid)
      assert unknown.status == 404
      assert unknown.resp_body == denied.resp_body
    end

    test "a tampered token never resolves to a different message", %{conn: conn, ch_id: ch_id} do
      mid = send_message(conn, ch_id, "the real one")
      other_mid = send_message(conn, ch_id, "the other one")
      token = Jason.decode!(mint(conn, ch_id, mid).resp_body)["token"]

      # The HEAD and the TAIL of the token are both tampered with — the payload
      # bytes and the tag bytes lead to different parts of the blob, and one
      # request per candidate is enough at this level (the exhaustive sweep over
      # every single-character mutation is `Cytale.PermalinksTest`'s, where it
      # needs no database).
      chars = String.graphemes(token)
      indexes = Enum.uniq([0, 1, 2, 3, length(chars) - 4, length(chars) - 3, length(chars) - 2, length(chars) - 1])

      for index <- indexes,
          replacement <- ["a", "Z", "9"],
          replacement != Enum.at(chars, index) do
        mutated = List.to_string(List.replace_at(chars, index, replacement))
        response = resolve(conn, mutated)

        assert response.status == 404, "a mutated token resolved: #{mutated}"
        refute response.resp_body =~ other_mid
        refute response.resp_body =~ mid
      end
    end
  end

  describe "malformed requests" do
    test "ids are validated before anything is minted", %{conn: conn, ch_id: ch_id} do
      for body <- [
            %{},
            %{"channel_id" => ch_id},
            %{"channel_id" => "not-an-id", "message_id" => "1"},
            %{"channel_id" => ch_id, "message_id" => "-5"}
          ] do
        response = PermalinkController.create(conn, body)
        assert response.status == 400
        assert Jason.decode!(response.resp_body)["error"]["key"] == "validation_failed"
      end
    end

    test "a non-string token is a 404, not a crash", %{conn: conn} do
      assert resolve(conn, 12_345).status == 404
      assert resolve(conn, "").status == 404
    end

    test "an unauthenticated caller is refused (the route sits behind :api_auth)", %{
      ch_id: ch_id
    } do
      # The pipeline plug is the gate; this suite runs it too, so the shape a
      # missing credential produces is pinned here rather than assumed.
      conn = build_conn_with_headers() |> CytaleWeb.Plugs.Auth.call([])

      assert conn.halted
      assert conn.status == 401
    end
  end

  # -- helpers -------------------------------------------------------------------

  # Invoke the actions the way the router would (see the moduledoc).
  defp mint(conn, channel_id, message_id) do
    PermalinkController.create(conn, %{"channel_id" => channel_id, "message_id" => message_id})
  end

  defp resolve(conn, token), do: PermalinkController.show(conn, %{"token" => token})

  # One character replaced by a different one that is still in the alphabet.
  defp tamper(token) do
    replacement = if :binary.at(token, 0) == ?a, do: "b", else: "a"
    replacement <> binary_part(token, 1, byte_size(token) - 1)
  end

  defp send_message(conn, channel_id, content) do
    sent = post(conn, "/api/v1/channels/#{channel_id}/messages", %{"content" => content})
    assert sent.status == 201
    Jason.decode!(sent.resp_body)["message"]["id"]
  end

  defp build_conn_with_headers do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp register_and_login(conn) do
    username = "u#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    {register_and_login_as(conn, user), user}
  end

  defp register_and_login_as(conn, user) do
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    access = Auth.issue_access_token(user.user_id, user.username, true)

    conn = put_req_header(conn, "authorization", "Bearer " <> access)
    # The pipeline's OWN plug sets `current_user` in production; running it here
    # (rather than hand-building the assign) keeps the gate the real one.
    CytaleWeb.Plugs.Auth.call(conn, [])
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
end
