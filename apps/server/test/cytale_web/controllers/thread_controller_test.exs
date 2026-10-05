defmodule CytaleWeb.ThreadControllerTest do
  @moduledoc """
  Thread roster summary fields + the archived filter (2026-09-10): the
  seed-message indicator renders "N replies · last activity" from the list
  read, and the channel's Threads panel can include archived threads.

  #109 (2026-09-12): archiving — `PATCH /threads/:id`, creator-or-moderator,
  the live `ThreadUpdate`, and the roster/access split (archiving hides a
  thread from the roster without changing who may read it).
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  defp conn_for(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  setup do
    {:ok, alice} = User.create(run_unique("tca"), run_unique("tca@example.com"), "password-123")
    conn = conn_for(alice)

    ws = post(conn, "/api/v1/workspaces", %{"name" => run_unique("WS")})
    ws_id = Jason.decode!(ws.resp_body)["workspace"]["id"]

    ch = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("chan")})
    ch_id = Jason.decode!(ch.resp_body)["channel"]["id"]

    msg = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "seed"})
    msg_id = Jason.decode!(msg.resp_body)["message"]["id"]

    thread =
      post(conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "t"})

    thread_id = Jason.decode!(thread.resp_body)["thread"]["id"]

    %{conn: conn, user: alice, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id, thread_id: thread_id}
  end

  test "the roster carries message_count + latest_reply_at (indicator data)", %{
    conn: conn,
    ch_id: ch_id,
    thread_id: thread_id
  } do
    # A reply bumps both fields.
    reply =
      post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "first reply"})

    assert reply.status in [200, 201]

    conn = get(conn, "/api/v1/channels/#{ch_id}/threads")
    assert conn.status == 200
    [thread] = Jason.decode!(conn.resp_body)["threads"]
    assert thread["id"] == thread_id
    assert thread["message_count"] >= 1
    assert is_binary(thread["latest_reply_at"])
  end

  test "mark unread: explicit null last_read_id clears; absent leaves it alone", %{
    conn: conn,
    user: user,
    thread_id: thread_id
  } do
    user_id = user.user_id

    reply = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "read me"})
    reply_id = Jason.decode!(reply.resp_body)["message"]["id"]
    tid = String.to_integer(thread_id)

    read = patch(conn, "/api/v1/threads/#{thread_id}/members/@me", %{"last_read_id" => reply_id})
    assert read.status == 200
    assert Cytale.Threads.Member.get(tid, user_id).last_read_id == String.to_integer(reply_id)

    # Explicit null clears (Mark Unread).
    cleared = patch(conn, "/api/v1/threads/#{thread_id}/members/@me", %{"last_read_id" => nil})
    assert cleared.status == 200
    assert Cytale.Threads.Member.get(tid, user_id).last_read_id == nil

    # An ABSENT key leaves the cleared state alone (PATCH semantics).
    noop = patch(conn, "/api/v1/threads/#{thread_id}/members/@me", %{"notify" => true})
    assert noop.status == 200
    member = Cytale.Threads.Member.get(tid, user_id)
    assert member.last_read_id == nil
    assert member.notify == true
  end

  # The by-user index is what the followed-thread list (Home's THREADS
  # section, the THREAD_LIST_SYNC payload) reads. A follow set through this
  # route that never reached it would leave the thread missing from that list
  # while the per-thread view said it was followed.
  test "a follow set through the route reaches the by-user index", %{
    conn: conn,
    ws_id: ws_id,
    thread_id: thread_id
  } do
    {member_conn, member} = second_member(ws_id)
    tid = String.to_integer(thread_id)

    # Join the thread, then follow it through the route.
    assert post(member_conn, "/api/v1/threads/#{thread_id}/members").status in [200, 201]

    followed =
      patch(member_conn, "/api/v1/threads/#{thread_id}/members/@me", %{"notify" => true})

    assert followed.status == 200
    assert Cytale.Threads.Member.get(tid, member.user_id).notify == true

    thread_ids =
      Cytale.Threads.Member.followed_threads(member.user_id) |> Enum.map(fn {t, _m} -> t.thread_id end)

    assert tid in thread_ids,
           "a follow set through the route must reach the by-user index, or the followed-thread list drops it"
  end

  test "channel reads exclude thread replies; thread reads return them", %{
    conn: conn,
    ch_id: ch_id,
    thread_id: thread_id
  } do
    reply = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "thread only"})
    assert reply.status in [200, 201]

    channel = get(conn, "/api/v1/channels/#{ch_id}/messages")
    assert channel.status == 200
    contents = Enum.map(Jason.decode!(channel.resp_body)["messages"], & &1["content"])
    refute "thread only" in contents

    thread = get(conn, "/api/v1/threads/#{thread_id}/messages")
    assert thread.status == 200
    thread_contents = Enum.map(Jason.decode!(thread.resp_body)["messages"], & &1["content"])
    assert "thread only" in thread_contents
  end

  describe "a thread reply is a full message (reply reference, attachments)" do
    test "a reply to a message IN the thread carries its reference, live and on reload", %{
      conn: conn,
      thread_id: thread_id
    } do
      first = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "first in thread"})
      first_id = Jason.decode!(first.resp_body)["message"]["id"]

      reply =
        post(conn, "/api/v1/threads/#{thread_id}/messages", %{
          "content" => "answering that",
          "reply_to_id" => first_id
        })

      assert reply.status == 201
      message = Jason.decode!(reply.resp_body)["message"]
      assert message["reply_to_id"] == first_id
      assert message["referenced"]["message_id"] == first_id
      assert message["referenced"]["content"] == "first in thread"

      page = Jason.decode!(get(conn, "/api/v1/threads/#{thread_id}/messages").resp_body)["messages"]
      row = Enum.find(page, &(&1["content"] == "answering that"))
      assert row["reply_to_id"] == first_id
      assert row["referenced"]["message_id"] == first_id
    end

    test "a reply may not reference a message outside this thread", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      other = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "channel timeline"})
      other_id = Jason.decode!(other.resp_body)["message"]["id"]

      refused =
        post(conn, "/api/v1/threads/#{thread_id}/messages", %{
          "content" => "cross-reference",
          "reply_to_id" => other_id
        })

      assert refused.status == 400
      assert Jason.decode!(refused.resp_body)["error"]["message"] =~ "in this thread"

      bogus = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "x", "reply_to_id" => "nope"})
      assert bogus.status == 400
    end

    test "attachments are kept on the reply and on the thread page", %{conn: conn, thread_id: thread_id} do
      att = %{
        "url" => "/api/v1/attachments/thr123",
        "filename" => "cat.png",
        "content_type" => "image/png",
        "size" => 2048
      }

      reply =
        post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "with a file", "attachments" => [att]})

      assert reply.status == 201
      assert [%{"filename" => "cat.png"}] = Jason.decode!(reply.resp_body)["message"]["attachments"]

      page = Jason.decode!(get(conn, "/api/v1/threads/#{thread_id}/messages").resp_body)["messages"]
      row = Enum.find(page, &(&1["content"] == "with a file"))
      assert [%{"url" => "/api/v1/attachments/thr123", "filename" => "cat.png"}] = row["attachments"]

      bad =
        post(conn, "/api/v1/threads/#{thread_id}/messages", %{
          "content" => "bad",
          "attachments" => [%{"url" => %{"nested" => "map"}}]
        })

      assert bad.status == 400
    end

    test "the thread page carries reactions, like a channel page", %{conn: conn, ch_id: ch_id, thread_id: thread_id} do
      reply = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "react to me"})
      reply_id = Jason.decode!(reply.resp_body)["message"]["id"]

      put_resp = put(conn, "/api/v1/channels/#{ch_id}/messages/#{reply_id}/reactions/#{URI.encode("👍")}/@me")
      assert put_resp.status in [200, 204]

      page = Jason.decode!(get(conn, "/api/v1/threads/#{thread_id}/messages").resp_body)["messages"]
      row = Enum.find(page, &(&1["id"] == reply_id))
      assert [%{"count" => 1}] = row["reactions"]
    end
  end

  test "archived threads are excluded by default and included on request", %{
    conn: conn,
    ch_id: ch_id,
    thread_id: thread_id
  } do
    assert patch(conn, "/api/v1/threads/#{thread_id}", %{"archived" => true}).status == 200

    default = get(conn, "/api/v1/channels/#{ch_id}/threads")
    assert Jason.decode!(default.resp_body)["threads"] == []

    with_archived = get(conn, "/api/v1/channels/#{ch_id}/threads?include_archived=true")

    assert [%{"id" => ^thread_id, "archived" => true}] =
             Jason.decode!(with_archived.resp_body)["threads"]
  end

  describe "#109 — archiving a thread" do
    setup %{ws_id: ws_id} do
      {member_conn, member} = second_member(ws_id)
      {:ok, member_conn: member_conn, member: member}
    end

    test "the creator archives: the roster hides it, and it stays directly readable", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      tid = String.to_integer(thread_id)

      log =
        capture_log(fn ->
          res = patch(conn, "/api/v1/threads/#{thread_id}", %{"archived" => true})
          assert res.status == 200
          assert Jason.decode!(res.resp_body)["thread"]["archived"] == true
        end)

      # The write reached both rows, and the live event says so (the seed
      # indicator and an open pane both read the event, not a refetch).
      assert Cytale.Threads.Thread.get(tid).archived == true
      assert log =~ "event=ThreadUpdate"
      assert log =~ "\"archived\" => true"

      # Archive is ROSTER-HIDING, not an access change: the thread is gone from
      # the default listing and every direct read still answers.
      assert Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/threads").resp_body)["threads"] ==
               []

      assert [%{"archived" => true}] =
               Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/threads?include_archived=true").resp_body)["threads"]

      assert get(conn, "/api/v1/threads/#{thread_id}/messages").status == 200
      assert get(conn, "/api/v1/threads/#{thread_id}/messages").status == 200
    end

    test "unarchiving puts it back in the roster", %{conn: conn, ch_id: ch_id, thread_id: thread_id} do
      assert patch(conn, "/api/v1/threads/#{thread_id}", %{"archived" => true}).status == 200
      assert patch(conn, "/api/v1/threads/#{thread_id}", %{"archived" => false}).status == 200

      assert [%{"id" => ^thread_id}] =
               Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/threads").resp_body)["threads"]
    end

    test "a non-creator without a moderator bit is refused (403)", %{
      member_conn: member_conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      res = patch(member_conn, "/api/v1/threads/#{thread_id}", %{"archived" => true})
      assert res.status == 403
      assert Cytale.Threads.Thread.get(String.to_integer(thread_id)).archived == false

      # ...and it is invisible to the roster's default listing for them either
      # way — the refusal is about the WRITE, not about seeing the thread.
      assert [_] = Jason.decode!(get(member_conn, "/api/v1/channels/#{ch_id}/threads").resp_body)["threads"]
    end

    test "a moderator who did not create it may archive", %{
      conn: conn,
      ws_id: ws_id,
      member: member,
      member_conn: member_conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      grant_bit(conn, ws_id, member, :manage_messages)

      res = patch(member_conn, "/api/v1/threads/#{thread_id}", %{"archived" => true})
      assert res.status == 200

      # Hidden for the CREATOR too — archiving is one roster, not one viewer's.
      assert Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/threads").resp_body)["threads"] ==
               []
    end

    test "the manage_threads bit (the compat DELETE route's bit) also qualifies", %{
      conn: conn,
      ws_id: ws_id,
      member: member,
      member_conn: member_conn,
      thread_id: thread_id
    } do
      grant_bit(conn, ws_id, member, :manage_threads)
      assert patch(member_conn, "/api/v1/threads/#{thread_id}", %{"archived" => true}).status == 200
    end

    test "archived is required and must be a boolean", %{conn: conn, thread_id: thread_id} do
      assert patch(conn, "/api/v1/threads/#{thread_id}", %{"archived" => "yes"}).status == 400
      assert patch(conn, "/api/v1/threads/#{thread_id}", %{}).status == 400
      assert Cytale.Threads.Thread.get(String.to_integer(thread_id)).archived == false
    end

    test "an unknown thread is the uniform 404, not an oracle", %{conn: conn} do
      assert patch(conn, "/api/v1/threads/123456789012345678", %{"archived" => true}).status == 404
    end
  end

  # The channel send's durable reservation (review #24), on the thread reply
  # route. The body `nonce` tests send no Idempotency-Key header, so the
  # in-memory replay plug is NOT what answers — this is the path that survives
  # a server restart. The header test drops the plug's entry to stand in for
  # the restart that empties its table.
  describe "durable reply dedupe (message_nonces)" do
    test "a retry with the same nonce answers 200 with the ORIGINAL reply and has no side effects", %{
      conn: conn,
      thread_id: thread_id
    } do
      tid = String.to_integer(thread_id)
      nonce = "tn-" <> run_nonce()
      body = %{"content" => "exactly once", "nonce" => nonce}

      first = post(conn, "/api/v1/threads/#{thread_id}/messages", body)
      assert first.status == 201
      assert %{"message" => %{"id" => id, "nonce" => ^nonce}} = Jason.decode!(first.resp_body)
      count = Cytale.Threads.Thread.get(tid).message_count

      log =
        capture_log(fn ->
          retry = post(conn, "/api/v1/threads/#{thread_id}/messages", body)
          assert retry.status == 200

          assert %{
                   "message" => %{
                     "id" => ^id,
                     "content" => "exactly once",
                     "thread_id" => ^thread_id,
                     "nonce" => ^nonce
                   }
                 } =
                   Jason.decode!(retry.resp_body)
        end)

      # No second dispatch on either leg, no second reply counted, one row.
      refute log =~ "event=ThreadMessageCreate"
      refute log =~ "event=MessageCreate"
      assert Cytale.Threads.Thread.get(tid).message_count == count
      assert thread_contents(conn, thread_id) |> Enum.count(&(&1 == "exactly once")) == 1
    end

    test "an Idempotency-Key retry dedupes durably (no in-memory replay holds send keys)", %{
      conn: conn,
      user: user,
      thread_id: thread_id
    } do
      tid = String.to_integer(thread_id)
      key = "tk-" <> run_nonce()
      keyed = put_req_header(conn, "idempotency-key", key)

      first = post(keyed, "/api/v1/threads/#{thread_id}/messages", %{"content" => "keyed once"})
      assert first.status == 201
      %{"message" => %{"id" => id}} = Jason.decode!(first.resp_body)
      count = Cytale.Threads.Thread.get(tid).message_count

      # Sends never enter the in-memory replay store (the Idempotency plug
      # steps aside for send routes): the durable reservation alone answers
      # the retry, so it behaves the same before and after a restart.
      table = CytaleWeb.Compat.RateTables.idempotency_table()
      assert [] = :ets.lookup(table, {user.user_id, key})

      log =
        capture_log(fn ->
          retry = post(keyed, "/api/v1/threads/#{thread_id}/messages", %{"content" => "keyed once"})
          assert retry.status == 200
          assert get_resp_header(retry, "idempotency-replayed") == []
          assert %{"message" => %{"id" => ^id}} = Jason.decode!(retry.resp_body)
        end)

      refute log =~ "event=ThreadMessageCreate"
      assert Cytale.Threads.Thread.get(tid).message_count == count
      assert thread_contents(conn, thread_id) |> Enum.count(&(&1 == "keyed once")) == 1
    end

    test "a different nonce is a new reply", %{conn: conn, thread_id: thread_id} do
      one = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "twin", "nonce" => "a-" <> run_nonce()})
      two = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "twin", "nonce" => "b-" <> run_nonce()})

      assert one.status == 201
      assert two.status == 201
      refute Jason.decode!(one.resp_body)["message"]["id"] == Jason.decode!(two.resp_body)["message"]["id"]
      assert thread_contents(conn, thread_id) |> Enum.count(&(&1 == "twin")) == 2
    end

    test "another author's reply with the same nonce does not collide", %{
      conn: conn,
      ws_id: ws_id,
      thread_id: thread_id
    } do
      {member_conn, _member} = second_member(ws_id)
      nonce = "shared-" <> run_nonce()

      mine = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "mine", "nonce" => nonce})
      theirs = post(member_conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "theirs", "nonce" => nonce})

      assert mine.status == 201
      assert theirs.status == 201
      assert %{"message" => %{"content" => "theirs"}} = Jason.decode!(theirs.resp_body)
      contents = thread_contents(conn, thread_id)
      assert Enum.count(contents, &(&1 == "mine")) == 1
      assert Enum.count(contents, &(&1 == "theirs")) == 1
    end

    test "a nonce already spent on a channel message is a 409, not that message", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      nonce = "tc-" <> run_nonce()

      assert post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "timeline", "nonce" => nonce}).status ==
               201

      clash = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "reply", "nonce" => nonce})
      assert clash.status == 409
      assert %{"error" => %{"key" => "idempotency_conflict"}} = Jason.decode!(clash.resp_body)
      refute "reply" in thread_contents(conn, thread_id)
    end

    test "a reply's nonce reused for a channel send is a 409, not the reply", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      nonce = "tt-" <> run_nonce()
      body = %{"content" => "in thread", "nonce" => nonce}
      assert post(conn, "/api/v1/threads/#{thread_id}/messages", body).status == 201

      clash = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "timeline", "nonce" => nonce})
      assert clash.status == 409
      assert %{"error" => %{"key" => "idempotency_conflict"}} = Jason.decode!(clash.resp_body)
    end

    test "a reservation whose reply never landed is RE-DRIVEN under the reserved id", %{
      conn: conn,
      user: user,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      tid = String.to_integer(thread_id)
      nonce = "tr-" <> run_nonce()
      reserved = Cytale.Snowflake.next()
      assert :claimed = Cytale.Messages.Nonces.claim(user.user_id, nonce, String.to_integer(ch_id), reserved)

      retry = post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => "recovered", "nonce" => nonce})
      assert retry.status == 201
      assert %{"message" => %{"id" => id}} = Jason.decode!(retry.resp_body)
      assert id == Integer.to_string(reserved)
      assert %{content: "recovered", thread_id: ^tid} = Cytale.Messages.get_message(String.to_integer(ch_id), reserved)
      assert Cytale.Threads.Thread.get(tid).message_count == 1
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp thread_contents(conn, thread_id) do
    Enum.map(Jason.decode!(get(conn, "/api/v1/threads/#{thread_id}/messages").resp_body)["messages"], & &1["content"])
  end

  # A verified, joined second member of the workspace (the non-creator the
  # permission rule is about).
  defp second_member(ws_id) do
    nonce = run_nonce()
    username = "tcb#{:erlang.phash2(nonce, 9_999_999)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")
    {:ok, raw, _hash} = Cytale.Accounts.Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    access = Auth.issue_access_token(user.user_id, user.username, true)

    conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)

    {:ok, invite} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
    assert post(conn, "/api/v1/invites/#{invite.invite_code}").status == 200

    {conn, user}
  end

  # Owner-created role carrying ONE bit, granted to the member.
  defp grant_bit(owner_conn, ws_id, user, bit) do
    permissions = bit |> Cytale.Permissions.Bitfield.bit() |> Integer.to_string()

    created =
      post(owner_conn, "/api/v1/workspaces/#{ws_id}/roles", %{
        "name" => run_unique("mod"),
        "permissions" => permissions
      })

    assert created.status == 201
    role_id = Jason.decode!(created.resp_body)["role"]["id"]

    granted =
      put(owner_conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}/members/#{user.user_id}", %{})

    assert granted.status == 200
  end
end
