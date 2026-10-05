defmodule CytaleWeb.Compat.ThreadsControllerTest do
  @moduledoc """
  The compat thread-WRITE surface (bots plan B-2, both prefixes): Discord's
  start-from-message + standalone thread starts (Discord thread channel
  objects, type 11 with thread_metadata), join/leave (204s over the native
  member machinery), the parent-anchored gates (send for starts, view for
  membership; restricted agent out-of-profile parent → the identical
  10003), and the thread's messages flowing through the EXISTING compat
  translation afterwards.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.{Threads, Workspaces}

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    {owner_conn, owner} = register_and_login()
    ws_id = create_workspace(owner_conn)
    ch_id = create_channel(owner_conn, ws_id)

    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Thread Bot"))
    bot_conn = bot_conn(bot.token)
    msg_id = send_message(bot_conn, ch_id, "thread me")

    {:ok,
     owner: owner, owner_conn: owner_conn, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id, bot: bot, bot_conn: bot_conn}
  end

  describe "POST /channels/{cid}/messages/{mid}/threads" do
    test "creates the thread and returns the Discord thread channel object", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      conn =
        post(bot_conn, "/api/v10/channels/#{ch_id}/messages/#{msg_id}/threads", %{
          "name" => "deploy follow-ups",
          "auto_archive_duration" => 1440
        })

      assert conn.status == 200
      thread = Jason.decode!(conn.resp_body)

      assert thread["type"] == 11
      assert thread["name"] == "deploy follow-ups"
      assert thread["guild_id"] == ws_id
      assert thread["parent_id"] == ch_id
      assert is_binary(thread["id"])

      # #64 item 2: the three top-level fields + the metadata keys discord.py
      # indexes UNGUARDED, all from real Cytale data. Asserted by presence AND
      # type, because the client's parser runs `int(...)`/`parse_time(...)` on
      # them — a null is as fatal as an absent key.
      assert is_binary(thread["owner_id"])
      assert is_integer(thread["message_count"])
      assert is_integer(thread["member_count"])

      assert %{
               "archived" => false,
               "auto_archive_duration" => 1440,
               "archive_timestamp" => ts,
               "create_timestamp" => created,
               "locked" => false,
               "invitable" => true
             } = thread["thread_metadata"]

      assert is_binary(ts) and match?({:ok, _, _}, DateTime.from_iso8601(ts))
      assert is_binary(created) and match?({:ok, _, _}, DateTime.from_iso8601(created))

      # The thread row landed through the native machinery.
      assert %{} = Threads.Thread.get(String.to_integer(thread["id"]))

      # The native ThreadCreate announce fired (compat sessions see
      # THREAD_CREATE on GUILDS via the existing translation).
      log =
        capture_log(fn ->
          post(bot_conn, "/api/v10/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "again"})
        end)

      assert log =~ "event=ThreadCreate"
    end

    test "unknown message → 404 10008; invalid name → 400 50035", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      bogus = Integer.to_string(Cytale.Snowflake.next())

      conn = post(bot_conn, "/api/v10/channels/#{ch_id}/messages/#{bogus}/threads", %{"name" => "x"})
      assert conn.status == 404
      assert %{"code" => 10_008, "message" => "Unknown Message"} = Jason.decode!(conn.resp_body)

      for name <- ["", String.duplicate("n", 101), nil] do
        bad = post(bot_conn, "/api/v10/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => name})
        assert bad.status == 400
        assert %{"code" => 50_035} = Jason.decode!(bad.resp_body)
      end
    end
  end

  describe "POST /channels/{cid}/threads (standalone)" do
    test "creates a parentless thread — same object shape, no anchor message", %{
      ws_id: ws_id,
      ch_id: ch_id,
      bot_conn: bot_conn
    } do
      conn = post(bot_conn, "/api/v10/channels/#{ch_id}/threads", %{"name" => "ops", "type" => 11})
      assert conn.status == 200

      thread = Jason.decode!(conn.resp_body)
      assert thread["type"] == 11
      assert thread["parent_id"] == ch_id
      assert thread["guild_id"] == ws_id

      row = Threads.Thread.get(String.to_integer(thread["id"]))
      assert row.parent_message_id == nil

      # The bare /api prefix serves the identical contract.
      bare = post(bot_conn, "/api/channels/#{ch_id}/threads", %{"name" => "ops2"})
      assert bare.status == 200
    end
  end

  describe "PUT/DELETE /channels/{thread_id}/thread-members/@me" do
    test "join → 204 idempotent; leave → 204; membership rows follow", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot: bot,
      bot_conn: bot_conn
    } do
      {:ok, thread} =
        Threads.Thread.start(String.to_integer(ch_id), String.to_integer(msg_id), "membership", bot.user_id)

      tid = Integer.to_string(thread.thread_id)

      assert put(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204
      assert %{} = Threads.Member.get(thread.thread_id, bot.user_id)

      # Idempotent re-join stays 204.
      assert put(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204

      assert delete(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204
      assert Threads.Member.get(thread.thread_id, bot.user_id) == nil

      # Leave with no membership is still 204.
      assert delete(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204

      # Unknown thread → the identical 10003.
      bogus = Integer.to_string(Cytale.Snowflake.next())

      gone = put(bot_conn, "/api/v10/channels/#{bogus}/thread-members/@me")
      assert gone.status == 404
      assert %{"code" => 10_003} = Jason.decode!(gone.resp_body)
    end
  end

  describe "gates: restrictions + anti-enumeration" do
    test "restricted agent: in-profile parent works; out-of-profile parent → the identical 10003",
         %{owner: owner, owner_conn: owner_conn, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id} do
      {:ok, other} = Cytale.Workspaces.create_channel(String.to_integer(ws_id), run_unique("hidden"))

      seeded =
        post(owner_conn, "/api/v1/channels/#{other.channel_id}/messages", %{"content" => "other"})

      assert seeded.status == 201
      other_msg = Jason.decode!(seeded.resp_body)["message"]["id"]

      {:ok, agent} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Scoped Threader"), %{
          actions: ["read", "post"],
          channels: [ch_id]
        })

      scoped = bot_conn(agent.token)

      # In-profile parent: both starts + membership work.
      ok = post(scoped, "/api/v10/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => "scoped"})
      assert ok.status == 200

      tid = Jason.decode!(ok.resp_body)["id"]
      assert put(scoped, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204

      # Out-of-profile parent: every route is the identical 10003.
      for conn <- [
            scoped |> post("/api/v10/channels/#{other.channel_id}/messages/#{other_msg}/threads", %{"name" => "sneak"}),
            scoped |> post("/api/v10/channels/#{other.channel_id}/threads", %{"name" => "sneak"})
          ] do
        assert conn.status == 404
        assert %{"code" => 10_003, "message" => "Unknown Channel"} = Jason.decode!(conn.resp_body)
      end
    end
  end

  describe "the thread's messages flow via the existing translation" do
    test "a native reply surfaces through the compat thread history route", %{
      owner: owner,
      ch_id: ch_id,
      msg_id: msg_id,
      bot: bot,
      bot_conn: bot_conn
    } do
      ch_int = String.to_integer(ch_id)

      {:ok, thread} =
        Threads.Thread.start(ch_int, String.to_integer(msg_id), "flow-check", bot.user_id)

      {:ok, wire} =
        Cytale.Messages.Message.send_message(%{
          channel_id: ch_int,
          author_id: owner.user_id,
          content: "reply inside thread",
          thread_id: thread.thread_id
        })

      history = get(bot_conn, "/api/v10/channels/#{thread.thread_id}/messages")
      assert history.status == 200

      rows = Jason.decode!(history.resp_body)
      assert [%{"channel_id" => thread_id, "content" => "reply inside thread"}] = rows
      assert thread_id == Integer.to_string(thread.thread_id)
      assert wire["id"] != nil
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp status(conn), do: conn.status

  defp bot_conn(token) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bot " <> token)
  end

  defp register_and_login do
    username = "tc#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")

    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    access = Auth.issue_access_token(user.user_id, user.username, true)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)

    {conn, user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  describe "#74 — a created thread is readable, discoverable and deletable" do
    test "GET /channels/{thread_id} returns the thread, verbatim", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "readable")

      read = get(bot_conn, "/api/v10/channels/#{thread["id"]}")
      assert read.status == 200

      # ONE builder serves the create response, this read, the THREAD_CREATE
      # dispatch and the GUILD_CREATE inventory — so the read is byte-identical
      # to the create response rather than a second opinion about the thread.
      assert Jason.decode!(read.resp_body) == thread
      assert thread["type"] == 11
      # `newly_created` is event metadata (#71), never part of the object.
      refute Map.has_key?(thread, "newly_created")
    end

    test "GET /guilds/{guild_id}/threads/active lists it — the reconnect path", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "discoverable")

      listed = get(bot_conn, "/api/v10/guilds/#{ws_id}/threads/active")
      assert listed.status == 200
      body = Jason.decode!(listed.resp_body)

      assert Enum.any?(body["threads"], &(&1["id"] == thread["id"]))
      assert body["has_more"] == false
      assert body["members"] == []

      # A client that never saw the create event finds the SAME object here.
      from_list = Enum.find(body["threads"], &(&1["id"] == thread["id"]))
      assert from_list == thread
    end

    test "an archived thread leaves the active list and appears in the archived one", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "archivable")
      assert patch(bot_conn, "/api/v10/channels/#{thread["id"]}", %{"archived" => true}).status == 200

      active = get(bot_conn, "/api/v10/guilds/#{ws_id}/threads/active")
      refute Enum.any?(Jason.decode!(active.resp_body)["threads"], &(&1["id"] == thread["id"]))

      archived = get(bot_conn, "/api/v10/channels/#{ch_id}/threads/archived/public")
      assert archived.status == 200
      assert Enum.any?(Jason.decode!(archived.resp_body)["threads"], &(&1["id"] == thread["id"]))
    end

    test "DELETE /channels/{thread_id} removes it — the id then 404s", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "deletable")

      deleted = delete(bot_conn, "/api/v10/channels/#{thread["id"]}")
      assert deleted.status == 204

      gone = get(bot_conn, "/api/v10/channels/#{thread["id"]}")
      assert gone.status == 404
      assert Jason.decode!(gone.resp_body)["code"] == 10_003

      listed = get(bot_conn, "/api/v10/guilds/#{ws_id}/threads/active")
      refute Enum.any?(Jason.decode!(listed.resp_body)["threads"], &(&1["id"] == thread["id"]))

      # A thread delete leaves the parent channel alone.
      assert get(bot_conn, "/api/v10/channels/#{ch_id}").status == 200
    end

    test "a member who neither owns the thread nor manages threads gets 403", %{
      owner: owner,
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "not yours")

      {_other_conn, other} = register_and_login()
      # `ws_id` is the JSON form (a string); the row write is integer-native.
      :ok = Workspaces.add_member(String.to_integer(ws_id), other.user_id, owner.user_id, [])
      {:ok, other_bot} = AgentGrants.mint_all(other.user_id, :bot, run_unique("Other Bot"))

      denied = delete(bot_conn(other_bot.token), "/api/v10/channels/#{thread["id"]}")
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["code"] == 50_001

      # ...and the thread survived the attempt.
      assert get(bot_conn, "/api/v10/channels/#{thread["id"]}").status == 200
    end

    test "DELETE on a real CHANNEL is refused rather than destroying it", %{
      ch_id: ch_id,
      bot_conn: bot_conn
    } do
      denied = delete(bot_conn, "/api/v10/channels/#{ch_id}")
      assert denied.status == 403
      assert get(bot_conn, "/api/v10/channels/#{ch_id}").status == 200
    end
  end

  describe "#109 — PATCH /channels/{thread_id} archives (Discord's Modify Channel on a thread)" do
    # A thread IS a channel in Discord, so this is the route every client
    # archives one with — and the bot that OWNS a thread is the case that made
    # the ticket 1.0-relevant: it could clean up (DELETE) but not archive.
    test "the thread's owner archives it: the object says so and the id keeps reading", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "bot tidies up")

      log =
        capture_log(fn ->
          conn = patch(bot_conn, "/api/v10/channels/#{thread["id"]}", %{"archived" => true})
          assert conn.status == 200

          # The SAME builder that serves the read and the create response, so
          # thread_metadata.archived is the object's own truth.
          archived = Jason.decode!(conn.resp_body)
          assert archived["id"] == thread["id"]
          assert archived["thread_metadata"]["archived"] == true
        end)

      # The live dispatch other clients file the thread away with.
      assert log =~ "event=ThreadUpdate"
      assert log =~ "\"archived\" => true"

      # Archived is a ROSTER state, not an access change: the thread still
      # resolves by id, and only the listings move.
      assert get(bot_conn, "/api/v10/channels/#{thread["id"]}").status == 200

      active = get(bot_conn, "/api/v10/guilds/#{ws_id}/threads/active")
      refute Enum.any?(Jason.decode!(active.resp_body)["threads"], &(&1["id"] == thread["id"]))

      archived_list = get(bot_conn, "/api/v10/channels/#{ch_id}/threads/archived/public")
      assert Enum.any?(Jason.decode!(archived_list.resp_body)["threads"], &(&1["id"] == thread["id"]))
    end

    test "unarchiving puts it back in the active list", %{
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "come back")
      assert patch(bot_conn, "/api/v10/channels/#{thread["id"]}", %{"archived" => true}).status == 200

      reopened = patch(bot_conn, "/api/v10/channels/#{thread["id"]}", %{"archived" => false})
      assert reopened.status == 200
      assert Jason.decode!(reopened.resp_body)["thread_metadata"]["archived"] == false

      active = get(bot_conn, "/api/v10/guilds/#{ws_id}/threads/active")
      assert Enum.any?(Jason.decode!(active.resp_body)["threads"], &(&1["id"] == thread["id"]))
    end

    test "an agent that did not create the thread gets 50001, not 10003", %{
      owner: owner,
      ws_id: ws_id,
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "not yours to archive")

      {_other_conn, other} = register_and_login()
      :ok = Workspaces.add_member(String.to_integer(ws_id), other.user_id, owner.user_id, [])
      {:ok, other_bot} = AgentGrants.mint_all(other.user_id, :bot, run_unique("Other Bot"))

      denied = patch(bot_conn(other_bot.token), "/api/v10/channels/#{thread["id"]}", %{"archived" => true})

      # 50001 Missing Permissions: the caller CAN see the channel (10003 would
      # be the anti-enumeration lie) and simply may not archive the thread.
      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["code"] == 50_001

      # The refusal changed nothing.
      assert Jason.decode!(get(bot_conn, "/api/v10/channels/#{thread["id"]}").resp_body)["thread_metadata"][
               "archived"
             ] == false
    end

    test "a non-boolean archived is a 50035 form error, and nothing is written", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      thread = start_thread(bot_conn, ch_id, msg_id, "bad body")

      bad = patch(bot_conn, "/api/v10/channels/#{thread["id"]}", %{"archived" => "yes"})
      assert bad.status == 400
      assert Jason.decode!(bad.resp_body)["code"] == 50_035

      assert Jason.decode!(get(bot_conn, "/api/v10/channels/#{thread["id"]}").resp_body)["thread_metadata"][
               "archived"
             ] == false
    end
  end

  # -- #83 compat-surface remainder: the thread-member ROSTER reads ------------
  # (Discord's fetch_members + the self-membership check; before this the
  # roster was join/leave-only — a client could change its membership but
  # never see it.)

  describe "GET /channels/{thread_id}/thread-members" do
    test "the roster after a join: Discord thread-member objects; empty after leave", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot: bot,
      bot_conn: bot_conn
    } do
      {:ok, thread} =
        Threads.Thread.start(String.to_integer(ch_id), String.to_integer(msg_id), "rostered", bot.user_id)

      tid = Integer.to_string(thread.thread_id)

      # Not a member yet: the collection is empty for everyone, @me is the
      # uniform 10003 (the anti-enumeration answer to "am I in this thread?"
      # — identical to an invisible thread).
      assert get(bot_conn, "/api/v10/channels/#{tid}/thread-members") |> json_response_body() == []

      me = get(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me")
      assert me.status == 404
      assert Jason.decode!(me.resp_body)["code"] == 10_003

      assert put(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204

      listed = get(bot_conn, "/api/v10/channels/#{tid}/thread-members")
      assert listed.status == 200

      assert [
               %{
                 "id" => ^tid,
                 "user_id" => user_id,
                 "join_timestamp" => ts,
                 "flags" => 0
               }
             ] = Jason.decode!(listed.resp_body)

      assert user_id == Integer.to_string(bot.user_id)
      assert match?({:ok, _, _}, DateTime.from_iso8601(ts))

      mine = get(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me")
      assert mine.status == 200
      assert Jason.decode!(mine.resp_body)["user_id"] == Integer.to_string(bot.user_id)

      # Leaving empties the roster again (the membership row is the roster).
      assert delete(bot_conn, "/api/v10/channels/#{tid}/thread-members/@me") |> status() == 204
      assert get(bot_conn, "/api/v10/channels/#{tid}/thread-members") |> json_response_body() == []
    end

    test "an unknown thread is the identical 10003 on both routes", %{bot_conn: bot_conn} do
      bogus = Integer.to_string(Cytale.Snowflake.next())

      for path <- ["/thread-members", "/thread-members/@me"] do
        conn = get(bot_conn, "/api/v10/channels/#{bogus}#{path}")
        assert conn.status == 404
        assert Jason.decode!(conn.resp_body)["code"] == 10_003
      end
    end

    test "the /api bare prefix serves the identical roster contract", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot: bot,
      bot_conn: bot_conn
    } do
      {:ok, thread} =
        Threads.Thread.start(String.to_integer(ch_id), String.to_integer(msg_id), "bare roster", bot.user_id)

      tid = Integer.to_string(thread.thread_id)
      assert put(bot_conn, "/api/channels/#{tid}/thread-members/@me") |> status() == 204
      assert get(bot_conn, "/api/channels/#{tid}/thread-members") |> json_response_body() != []
    end
  end

  defp json_response_body(conn), do: Jason.decode!(conn.resp_body)

  defp start_thread(conn, ch_id, msg_id, name) do
    conn = post(conn, "/api/v10/channels/#{ch_id}/messages/#{msg_id}/threads", %{"name" => name})

    assert conn.status == 200
    Jason.decode!(conn.resp_body)
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  defp send_message(conn, ch_id, content) do
    conn = post(conn, "/api/v10/channels/#{ch_id}/messages", %{"content" => content})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["id"]
  end
end
