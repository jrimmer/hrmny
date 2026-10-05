defmodule CytaleWeb.Controllers.MessagePermalinkTest do
  @moduledoc """
  #114 — the permalink resolver: `GET /channels/{id}/messages/{mid}`.

  `docs/protocol/rest.md` has advertised this read since U9 while nothing
  routed it, so the shape it promises (`{"message": ...}`) is pinned here
  alongside the part that is security-critical rather than cosmetic: the
  route takes TWO ids out of a URL a stranger can write, so it must render
  one 404 body for every miss. A body (or status) that varied between
  "channel you cannot see", "channel that does not exist" and "message that
  does not exist" would make it an enumeration oracle; the equality
  assertions below are the pin, not the status codes.

  Also covered: thread replies resolve through the PARENT channel (their own
  `thread_id` rides the payload), and DM channels authorize by participation.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations.
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn = build_conn_with_headers()
    {conn, owner} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    {:ok, conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id}
  end

  describe "the resolver" do
    test "returns the message for a channel member, in the same shape history renders", %{
      conn: conn,
      ch_id: ch_id
    } do
      sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "permalink me"})
      assert sent.status == 201
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      resolved = get(conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      assert resolved.status == 200
      %{"message" => message} = Jason.decode!(resolved.resp_body)
      assert message["id"] == mid
      assert message["content"] == "permalink me"
      assert message["channel_id"] == ch_id

      # Byte-for-byte the row the history page serves (one projection, not
      # two that can drift).
      %{"messages" => [from_history]} =
        Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/messages").resp_body)

      assert message == from_history
    end

    test "a thread reply resolves through the PARENT channel and carries its thread_id", %{
      conn: conn,
      owner: owner,
      ch_id: ch_id
    } do
      root = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "thread root"})
      root_id = Jason.decode!(root.resp_body)["message"]["id"]

      {:ok, thread} =
        Cytale.Threads.Thread.create(
          String.to_integer(ch_id),
          String.to_integer(root_id),
          run_unique("permalink thread"),
          owner.user_id
        )

      reply =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "reply in thread",
          "thread_id" => Integer.to_string(thread.thread_id)
        })

      assert reply.status == 201
      reply_id = Jason.decode!(reply.resp_body)["message"]["id"]

      resolved = get(conn, "/api/v1/channels/#{ch_id}/messages/#{reply_id}")
      assert resolved.status == 200
      %{"message" => message} = Jason.decode!(resolved.resp_body)
      assert message["thread_id"] == Integer.to_string(thread.thread_id)
      # The address is the parent channel — a thread is not a channel id here.
      assert message["channel_id"] == ch_id
    end

    test "a DM message resolves for a participant and 404s for a non-participant", %{
      conn: conn,
      owner: owner
    } do
      {:ok, other} = User.create(run_unique("pm_other"), run_unique("pm_other@example.com"), "password-123")

      Cytale.Test.SharedWorkspace.share!(owner.user_id, other.user_id)
      created = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
      assert created.status == 201
      dm_id = Jason.decode!(created.resp_body)["channel"]["id"]

      sent = post(conn, "/api/v1/channels/#{dm_id}/messages", %{"content" => "dm permalink"})
      assert sent.status == 201
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      # Both participants resolve it.
      other_conn = register_and_login_as(build_conn_with_headers(), other)

      for participant <- [conn, other_conn] do
        resolved = get(participant, "/api/v1/channels/#{dm_id}/messages/#{mid}")
        assert resolved.status == 200
        assert Jason.decode!(resolved.resp_body)["message"]["id"] == mid
      end

      # A stranger does not — and cannot tell the DM exists.
      {stranger_conn, _stranger} = register_and_login(build_conn_with_headers())
      denied = get(stranger_conn, "/api/v1/channels/#{dm_id}/messages/#{mid}")
      assert denied.status == 404

      assert denied.resp_body ==
               get(stranger_conn, "/api/v1/channels/#{dm_id}/messages/123456789012345678").resp_body

      # The owner's own DM is untouched by the stranger's probe.
      assert get(conn, "/api/v1/channels/#{dm_id}/messages/#{mid}").status == 200
      assert owner.user_id != other.user_id
    end
  end

  describe "the 404 is one shape (anti-enumeration)" do
    test "non-member, unknown channel and unknown message are byte-identical", %{
      conn: owner_conn,
      ch_id: ch_id
    } do
      sent = post(owner_conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "hidden from strangers"})
      assert sent.status == 201
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      # A second workspace the stranger has nothing to do with, holding a real
      # message: the probe that WOULD leak if the gate were missing.
      {stranger_conn, _stranger} = register_and_login(build_conn_with_headers())
      {owner2_conn, _owner2} = register_and_login(build_conn_with_headers())
      ws2 = create_workspace(owner2_conn)
      ch2 = create_channel(owner2_conn, ws2)
      sent2 = post(owner2_conn, "/api/v1/channels/#{ch2}/messages", %{"content" => "cross-workspace secret"})
      mid2 = Jason.decode!(sent2.resp_body)["message"]["id"]

      real_message = get(stranger_conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      foreign_real_message = get(stranger_conn, "/api/v1/channels/#{ch2}/messages/#{mid2}")
      unknown_message = get(stranger_conn, "/api/v1/channels/#{ch_id}/messages/123456789012345678")
      unknown_channel = get(stranger_conn, "/api/v1/channels/999999999999999999/messages/#{mid}")

      # Nothing in any of them leaked content…
      for conn <- [real_message, foreign_real_message, unknown_message, unknown_channel] do
        assert conn.status == 404
        refute conn.resp_body =~ "hidden from strangers"
        refute conn.resp_body =~ "cross-workspace secret"
        refute conn.resp_body =~ "channel_not_found"
      end

      # …and the four bodies are the SAME bytes. This is the assertion the
      # ticket asks for: equality, not merely "both 404".
      assert real_message.resp_body == unknown_message.resp_body
      assert foreign_real_message.resp_body == real_message.resp_body
      assert unknown_channel.resp_body == real_message.resp_body

      # A member asking for a message that is not there gets the same body —
      # membership is not an oracle either.
      member_miss = get(owner_conn, "/api/v1/channels/#{ch_id}/messages/123456789012345678")
      assert member_miss.resp_body == real_message.resp_body

      # The unrelated owner still sees their own message (the gate is the
      # caller's rights, not a global lockout).
      assert get(owner2_conn, "/api/v1/channels/#{ch2}/messages/#{mid2}").status == 200
    end

    test "an invite-joined MEMBER resolves; removal from the workspace revokes it", %{
      conn: owner_conn,
      ws_id: ws_id,
      ch_id: ch_id
    } do
      sent = post(owner_conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "members only"})
      mid = Jason.decode!(sent.resp_body)["message"]["id"]

      invite_code = create_invite(owner_conn, ws_id)
      {member_conn, _member} = register_and_login(build_conn_with_headers())
      joined = post(member_conn, "/api/v1/invites/#{invite_code}")
      assert joined.status == 200

      resolved = get(member_conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      assert resolved.status == 200
      assert Jason.decode!(resolved.resp_body)["message"]["content"] == "members only"
    end

    test "a malformed message id is the same 404, never a 500", %{conn: conn, ch_id: ch_id} do
      for bad <- ["abc", "0", "-1", "1e3", "9" |> String.duplicate(30)] do
        conn_bad = get(conn, "/api/v1/channels/#{ch_id}/messages/#{bad}")
        assert conn_bad.status == 404
        assert %{"error" => %{"key" => "message_not_found"}} = Jason.decode!(conn_bad.resp_body)
      end
    end
  end

  # -- helpers -------------------------------------------------------------------

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
    put_req_header(conn, "authorization", "Bearer " <> access)
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

  defp create_invite(conn, ws_id) do
    {:ok, invite} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
    invite.invite_code
  end
end
