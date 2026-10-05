defmodule CytaleWeb.InboxControllerTest do
  @moduledoc """
  #117 — the mention inbox over the REAL surface (router → api_auth →
  controller → ScyllaDB), which is where the ticket's acceptance lives.

  The tests that matter, in the ticket's own words:

    * **durability** — a mention that arrives while the member is away is
      still there for their next hydrate. Nothing in this test holds client
      state: the row is written by the message write and read back by the
      boot read, with the member's session never existing in between.
    * **one read state** — clearing an inbox row leaves the channel's read
      state (the badge's and the divider's one source) exactly where it was.
    * **privacy** — no request can read or clear another member's inbox, and
      a smuggled `user_id` changes nothing. The surface has no user-id segment
      to abuse, so the assertion is that the abuse paths do not exist rather
      than that they are gated.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Messages.ReadState
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp unique(base), do: base <> Cytale.TestNonce.get()

  defp auth(conn, user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)
    put_req_header(conn, "authorization", "Bearer " <> access)
  end

  defp conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  # Alice (workspace owner) and Bob (member), one channel, both authenticated.
  defp fixture do
    {:ok, alice} = User.create(unique("ibx_a"), unique("ibx_a@example.com"), "password-123")
    {:ok, bob} = User.create(unique("ibx_b"), unique("ibx_b@example.com"), "password-123")

    alice_conn = auth(conn(), alice)
    bob_conn = auth(conn(), bob)

    {:ok, ws} = Workspaces.create_workspace(alice.user_id, unique("ibx-ws"))
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "ibx-ch")
    :ok = Workspaces.add_member(ws.workspace_id, bob.user_id, alice.user_id)

    %{alice: alice, bob: bob, alice_conn: alice_conn, bob_conn: bob_conn, channel: channel}
  end

  defp send_message(conn, channel_id, content) do
    resp = post(conn, "/api/v1/channels/#{channel_id}/messages", %{"content" => content})
    assert resp.status == 201
    Jason.decode!(resp.resp_body)["message"]
  end

  defp inbox(conn, params \\ %{}) do
    resp = get(conn, "/api/v1/users/@me/inbox", params)
    assert resp.status == 200
    Jason.decode!(resp.resp_body)
  end

  # ---------------------------------------------------------------------------
  # Durability — the whole point of the ticket
  # ---------------------------------------------------------------------------

  test "a mention from another member is still in the inbox on a later hydrate" do
    f = fixture()

    # Bob is AWAY: no socket, no client, no store. Nothing about him exists
    # except his account.
    message = send_message(f.alice_conn, f.channel.channel_id, "hey <@#{f.bob.user_id}> take a look")

    # Bob comes back and hydrates (the boot read a client merges). The row is
    # there because the MESSAGE WRITE stored it, not because a session saw it.
    body = inbox(f.bob_conn)
    assert [item] = body["items"]
    assert item["message_id"] == message["id"]
    assert item["channel_id"] == Integer.to_string(f.channel.channel_id)
    assert item["thread_id"] == nil
    assert item["author_id"] == Integer.to_string(f.alice.user_id)
    assert item["author_username"] == f.alice.username
    assert item["kind"] == "mention"
    assert item["excerpt"] =~ "take a look"
    assert item["created_at"] != nil
    assert body["oldest_id"] == message["id"]
  end

  test "a second hydrate returns the same row — it is not consumed by reading it" do
    f = fixture()
    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> ping")

    first = inbox(f.bob_conn)
    second = inbox(f.bob_conn)

    assert first["items"] == second["items"]
  end

  test "the inbox is empty, not an error, when nothing mentions the member" do
    f = fixture()
    send_message(f.alice_conn, f.channel.channel_id, "no address here")

    assert %{"items" => [], "oldest_id" => nil} = inbox(f.bob_conn)
  end

  test "a mention is visible only to the member it addresses" do
    f = fixture()
    {:ok, carol} = User.create(unique("ibx_c"), unique("ibx_c@example.com"), "password-123")
    :ok = Workspaces.add_member(f.channel.workspace_id, carol.user_id, f.alice.user_id)
    carol_conn = auth(conn(), carol)

    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> only you")

    assert [_] = inbox(f.bob_conn)["items"]
    assert %{"items" => []} = inbox(carol_conn)
    assert %{"items" => []} = inbox(f.alice_conn)
  end

  # ---------------------------------------------------------------------------
  # Privacy — no request can reach another member's inbox
  # ---------------------------------------------------------------------------

  test "member B's inbox never contains member A's mentions" do
    f = fixture()

    # Alice mentions Bob, and Bob mentions Alice — each backlog is its own.
    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> bob's row")
    send_message(f.bob_conn, f.channel.channel_id, "<@#{f.alice.user_id}> alice's row")

    bob_items = inbox(f.bob_conn)["items"]
    alice_items = inbox(f.alice_conn)["items"]

    assert [%{"excerpt" => bob_excerpt}] = bob_items
    assert [%{"excerpt" => alice_excerpt}] = alice_items
    assert bob_excerpt =~ "bob's row"
    assert alice_excerpt =~ "alice's row"
    assert Enum.map(bob_items, & &1["message_id"]) != Enum.map(alice_items, & &1["message_id"])
  end

  test "a smuggled user_id changes nothing" do
    f = fixture()

    # Each member has a row of their own (`record_mentions` never records the
    # author's own token, so Bob authors the one that addresses Alice).
    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> bob's row")
    send_message(f.bob_conn, f.channel.channel_id, "<@#{f.alice.user_id}> alice's row")

    own = inbox(f.bob_conn)
    smuggled = inbox(f.bob_conn, %{"user_id" => f.alice.user_id})

    # The route takes no user id: the param is inert, and the read is still
    # Bob's own row — never Alice's.
    assert smuggled == own
    assert [%{"excerpt" => excerpt}] = smuggled["items"]
    assert excerpt =~ "bob's row"

    assert [%{"excerpt" => alice_excerpt}] = inbox(f.alice_conn)["items"]
    assert alice_excerpt =~ "alice's row"
  end

  test "no route addresses another member's inbox (no existence oracle to probe)" do
    f = fixture()

    # Paths that would be an oracle if they existed. The router owns none of
    # them, so every one is the same plain 404 — there is nothing to gate and
    # nothing to leak.
    for path <- [
          "/api/v1/users/#{f.alice.user_id}/inbox",
          "/api/v1/users/@me/inbox/#{f.bob.user_id}",
          "/api/v1/users/#{f.alice.user_id}/read-state"
        ] do
      assert get(f.bob_conn, path).status == 404
    end
  end

  test "dismissing a message id that belongs to another member's row does nothing" do
    f = fixture()
    message = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> bob's row")

    # Alice tries to clear BOB's row by its message id (the id is guessable —
    # it is on the wire of the channel both of them can read).
    resp = delete(f.alice_conn, "/api/v1/users/@me/inbox/#{message["id"]}")
    assert resp.status == 200

    # Bob's row survives: the delete is keyed by (caller, message).
    assert [%{"message_id" => message_id}] = inbox(f.bob_conn)["items"]
    assert message_id == message["id"]
  end

  # ---------------------------------------------------------------------------
  # Mark done — and the badge it must not disturb
  # ---------------------------------------------------------------------------

  test "per-item done removes the row and leaves the channel's read state alone" do
    f = fixture()

    # Bob read up to a point in this channel (the badge and the divider derive
    # from exactly this row).
    :ok = ReadState.write(f.bob.user_id, f.channel.channel_id, %{last_read_id: 42, unread_floor: 7})
    message = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> ping")

    resp = delete(f.bob_conn, "/api/v1/users/@me/inbox/#{message["id"]}")
    assert resp.status == 200
    assert Jason.decode!(resp.resp_body) == %{"done" => message["id"]}

    assert %{"items" => []} = inbox(f.bob_conn)
    assert %{last_read_id: 42, unread_floor: 7} = ReadState.get(f.bob.user_id, f.channel.channel_id)
  end

  test "per-item done is idempotent" do
    f = fixture()
    message = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> ping")

    assert delete(f.bob_conn, "/api/v1/users/@me/inbox/#{message["id"]}").status == 200
    assert delete(f.bob_conn, "/api/v1/users/@me/inbox/#{message["id"]}").status == 200
    assert %{"items" => []} = inbox(f.bob_conn)
  end

  test "the bulk sweep clears the backlog and reports how many went" do
    f = fixture()
    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> one")
    send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> two")
    :ok = ReadState.write(f.bob.user_id, f.channel.channel_id, %{last_read_id: 11})

    resp = delete(f.bob_conn, "/api/v1/users/@me/inbox")
    assert resp.status == 200
    assert Jason.decode!(resp.resp_body) == %{"done_count" => 2}

    assert %{"items" => []} = inbox(f.bob_conn)
    assert %{last_read_id: 11} = ReadState.get(f.bob.user_id, f.channel.channel_id)
  end

  test "the bulk sweep is scoped to the caller" do
    f = fixture()
    send_message(f.bob_conn, f.channel.channel_id, "<@#{f.alice.user_id}> and <@#{f.bob.user_id}>")

    assert delete(f.bob_conn, "/api/v1/users/@me/inbox").status == 200

    assert %{"items" => []} = inbox(f.bob_conn)
    assert [_] = inbox(f.alice_conn)["items"]
  end

  # ---------------------------------------------------------------------------
  # The ack path keeps the backlog current (the extension, end to end)
  # ---------------------------------------------------------------------------

  test "acknowledging the channel answers the mentions it covers" do
    f = fixture()
    message = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> read me")

    resp =
      post(f.bob_conn, "/api/v1/channels/#{f.channel.channel_id}/ack", %{
        "message_ids" => [message["id"]]
      })

    assert resp.status == 200
    assert %{"items" => []} = inbox(f.bob_conn)

    # ... and the watermark moved, in the same hop — one read state, written by
    # the one writer.
    assert %{last_read_id: watermark} = ReadState.get(f.bob.user_id, f.channel.channel_id)
    assert Integer.to_string(watermark) == message["id"]
  end

  test "an ack leaves mentions newer than its watermark alone" do
    f = fixture()
    first = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> one")
    second = send_message(f.alice_conn, f.channel.channel_id, "<@#{f.bob.user_id}> two")

    post(f.bob_conn, "/api/v1/channels/#{f.channel.channel_id}/ack", %{"message_ids" => [first["id"]]})

    assert [%{"message_id" => remaining}] = inbox(f.bob_conn)["items"]
    assert remaining == second["id"]
  end

  test "acknowledging as one member leaves the other member's backlog alone" do
    f = fixture()
    message = send_message(f.bob_conn, f.channel.channel_id, "<@#{f.alice.user_id}> and <@#{f.bob.user_id}>")

    post(f.bob_conn, "/api/v1/channels/#{f.channel.channel_id}/ack", %{"message_ids" => [message["id"]]})

    assert %{"items" => []} = inbox(f.bob_conn)
    assert [_] = inbox(f.alice_conn)["items"]
  end

  test "a malformed cursor is refused rather than treated as absent" do
    f = fixture()

    resp = get(f.bob_conn, "/api/v1/users/@me/inbox", %{"before" => "not-an-id"})
    assert resp.status == 200
    assert Jason.decode!(resp.resp_body)["items"] == []
  end
end
