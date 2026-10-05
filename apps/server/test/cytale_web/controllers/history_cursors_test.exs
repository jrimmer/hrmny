defmodule CytaleWeb.HistoryCursorsTest do
  @moduledoc """
  #152 — first-class recovery cursors: a thread read is scoped to the thread
  (dense pages, a short page means "no more"), channel history has a forward
  `after` cursor, and both indexes return explicit `oldest_id` / `newest_id`.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Messages

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  defp conn_for(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  defp body(conn), do: Jason.decode!(conn.resp_body)

  defp say(conn, ch_id, content),
    do: body(post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => content}))["message"]["id"]

  defp reply(conn, thread_id, content),
    do: body(post(conn, "/api/v1/threads/#{thread_id}/messages", %{"content" => content}))["message"]["id"]

  defp contents(page), do: Enum.map(page["messages"], & &1["content"])

  setup do
    {:ok, user} = User.create(run_unique("hc"), run_unique("hc@example.com"), "password-123")
    conn = conn_for(user)
    ws_id = body(post(conn, "/api/v1/workspaces", %{"name" => run_unique("WS")}))["workspace"]["id"]

    ch_id =
      body(post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("chan")}))["channel"]["id"]

    seed = say(conn, ch_id, "seed")

    thread_id =
      body(post(conn, "/api/v1/channels/#{ch_id}/messages/#{seed}/threads", %{"name" => "t"}))["thread"]["id"]

    %{conn: conn, ch_id: ch_id, thread_id: thread_id}
  end

  describe "thread reads are thread-scoped" do
    test "pages are dense on a busy channel, and a short page ends the history", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      # Five replies buried under a busy channel: the old read walked the
      # channel's newest rows and filtered, so a small page came back sparse.
      for i <- 1..5 do
        reply(conn, thread_id, "r#{i}")
        for j <- 1..6, do: say(conn, ch_id, "chatter #{i}.#{j}")
      end

      p1 = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=3"))
      assert contents(p1) == ["r5", "r4", "r3"]
      assert p1["newest_id"] == hd(p1["messages"])["id"]
      assert p1["oldest_id"] == List.last(p1["messages"])["id"]

      p2 = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=3&before=#{p1["oldest_id"]}"))
      # Short page: nothing older exists — the property the walk could not give.
      assert contents(p2) == ["r2", "r1"]

      p3 = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=3&before=#{p2["oldest_id"]}"))
      assert p3 == %{"messages" => [], "oldest_id" => nil, "newest_id" => nil}
    end

    test "after pages forward from an anchor, newest-first, closest rows first", %{
      conn: conn,
      thread_id: thread_id
    } do
      [r1 | _] = for i <- 1..5, do: reply(conn, thread_id, "r#{i}")

      p = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=2&after=#{r1}"))
      assert contents(p) == ["r3", "r2"]

      p = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=2&after=#{p["newest_id"]}"))
      assert contents(p) == ["r5", "r4"]

      p = body(get(conn, "/api/v1/threads/#{thread_id}/messages?limit=2&after=#{p["newest_id"]}"))
      assert contents(p) == []
    end

    test "a deleted reply leaves the thread's pages", %{conn: conn, ch_id: ch_id, thread_id: thread_id} do
      keep = reply(conn, thread_id, "keep")
      gone = reply(conn, thread_id, "gone")
      assert delete(conn, "/api/v1/channels/#{ch_id}/messages/#{gone}").status == 200

      p = body(get(conn, "/api/v1/threads/#{thread_id}/messages"))
      assert Enum.map(p["messages"], & &1["id"]) == [keep]
    end

    test "a stale locator row is skipped, the page refilled, and the row healed", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      r1 = reply(conn, thread_id, "r1")
      r2 = reply(conn, thread_id, "r2")
      # A locator row whose message never existed (a delete that did not know
      # its thread), newer than every real reply.
      ghost = Cytale.Snowflake.next()
      {tid, cid} = {String.to_integer(thread_id), String.to_integer(ch_id)}

      Cytale.Repo.execute!(
        "INSERT INTO {{K}}.thread_messages (thread_id, message_id, channel_id, bucket) VALUES (?, ?, ?, ?)",
        [{"bigint", tid}, {"bigint", ghost}, {"bigint", cid}, {"int", 0}]
      )

      # limit 2 reads the ghost + r2 first; the refill must still reach r1.
      assert Enum.map(Messages.thread_history(tid, limit: 2), &Integer.to_string(&1.id)) == [r2, r1]

      remaining =
        Cytale.Repo.execute!(
          "SELECT message_id FROM {{K}}.thread_messages WHERE thread_id = ? AND message_id = ?",
          [{"bigint", tid}, {"bigint", ghost}]
        )
        |> Enum.to_list()

      assert remaining == []
    end
  end

  describe "the locator backfill" do
    test "an interrupted backfill (marker present) re-indexes replies at the next apply", %{
      conn: conn,
      thread_id: thread_id
    } do
      replies = for i <- 1..3, do: reply(conn, thread_id, "r#{i}")
      tid = String.to_integer(thread_id)
      ks = Cytale.Repo.keyspace()

      # Replies that predate the locator: no rows, and a marker saying the
      # backfill has not completed. (Only THIS thread's rows are touched.)
      Cytale.Repo.execute!("DELETE FROM {{K}}.thread_messages WHERE thread_id = ?", [{"bigint", tid}])
      assert Messages.thread_history(tid) == []
      Cytale.Repo.execute!("CREATE TABLE IF NOT EXISTS #{ks}.thread_messages_backfill (k int PRIMARY KEY)", [])

      :ok = Cytale.Migrations.apply!()

      assert Enum.map(Messages.thread_history(tid), &Integer.to_string(&1.id)) == Enum.reverse(replies)

      marker =
        Cytale.Repo.execute!(
          "SELECT table_name FROM system_schema.tables WHERE keyspace_name = ? AND table_name = ?",
          [{"text", ks}, {"text", "thread_messages_backfill"}]
        )
        |> Enum.to_list()

      assert marker == [], "the marker is dropped once the backfill completes"
    end
  end

  describe "channel history cursors" do
    test "after returns the rows just past the anchor, excludes thread replies", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      [m1, _m2, _m3, _m4, _m5] = for i <- 1..5, do: say(conn, ch_id, "m#{i}")
      reply(conn, thread_id, "a reply is not a channel message")

      p = body(get(conn, "/api/v1/channels/#{ch_id}/messages?limit=2&after=#{m1}"))
      assert contents(p) == ["m3", "m2"]

      p = body(get(conn, "/api/v1/channels/#{ch_id}/messages?limit=2&after=#{p["newest_id"]}"))
      assert contents(p) == ["m5", "m4"]

      p = body(get(conn, "/api/v1/channels/#{ch_id}/messages?after=#{p["newest_id"]}"))
      assert p == %{"messages" => [], "oldest_id" => nil, "newest_id" => nil}
    end

    test "before and after together is a 400, on both indexes", %{
      conn: conn,
      ch_id: ch_id,
      thread_id: thread_id
    } do
      id = say(conn, ch_id, "x")

      assert get(conn, "/api/v1/channels/#{ch_id}/messages?before=#{id}&after=#{id}").status == 400
      assert get(conn, "/api/v1/threads/#{thread_id}/messages?before=#{id}&after=#{id}").status == 400
    end
  end
end
