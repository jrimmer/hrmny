defmodule CytaleWeb.Compat.SearchControllerTest do
  @moduledoc """
  The compat search surface (bots plan B-4, CYTALE EXTENSION): the
  {"results": [Discord message objects], "total": n} contract, channel +
  thread scoping (results restricted to the gated channel), agent
  restrictions (out-of-profile → the identical 10003), the before/limit
  pagination, empty matches (`results: []`, never 404), and the DM search
  leg (recipient gate, bounded in-memory scan). Tantivy indexing is driven
  manually (the test Publish impl is the logger — the workspace fan-out
  hook indexes in production).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Search.{IndexWriter, TantivyImpl}

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    # Temp search root — tests never touch the real priv/search.
    tmp = Path.join(System.tmp_dir!(), "cytale_compat_search_#{System.unique_integer([:positive])}")
    original = Application.get_env(:cytale, Cytale.Config)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(original || [], :search_index_root, tmp))

    tracker = Cytale.Search.TestWriters.tracker!()

    on_exit(fn ->
      Cytale.Search.TestWriters.stop_all(tracker)

      if original == nil do
        Application.delete_env(:cytale, Cytale.Config)
      else
        Application.put_env(:cytale, Cytale.Config, original)
      end

      Cytale.Search.TestWriters.rm_rf(tmp)
    end)

    {owner_conn, owner} = register_and_login()
    ws_id = create_workspace(owner_conn)
    ch_id = create_channel(owner_conn, ws_id)
    other_id = create_channel(owner_conn, ws_id)

    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Search Bot"))
    bot_conn = bot_conn(bot.token)

    ws_int = String.to_integer(ws_id)
    ch_int = String.to_integer(ch_id)
    other_int = String.to_integer(other_id)

    # Seed + index: hit/miss in the gated channel, a hit in the OTHER
    # channel (must never leak), and a thread-scoped message.
    hit = seed_message(ch_int, owner.user_id, "deploy finished on time")
    miss = seed_message(ch_int, owner.user_id, "lunch plans?")
    other_hit = seed_message(other_int, owner.user_id, "deploy happened elsewhere")
    thread_hit = seed_message(ch_int, owner.user_id, "deploy inside the thread", thread_id: hit.id)

    for msg <- [hit, miss, other_hit, thread_hit] do
      :ok = TantivyImpl.index(ws_int, indexed(msg))
    end

    :ok = IndexWriter.commit_now({:workspace, ws_int})
    Cytale.Search.TestWriters.track(ws_int)

    {:ok,
     owner: owner,
     owner_conn: owner_conn,
     ws_id: ws_id,
     ws_int: ws_int,
     ch_id: ch_id,
     other_id: other_id,
     hit: hit,
     miss: miss,
     other_hit: other_hit,
     thread_hit: thread_hit,
     bot: bot,
     bot_conn: bot_conn}
  end

  describe "GET /channels/{cid}/messages/search" do
    test "matches are restricted to the gated channel; Discord message objects", %{
      ch_id: ch_id,
      hit: hit,
      miss: miss,
      other_hit: other_hit,
      thread_hit: thread_hit,
      bot_conn: bot_conn
    } do
      conn = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?q=deploy")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      # The other channel's hit never leaks; the thread message rides the
      # same channel partition (channel scope v1).
      assert body["total"] == 2
      ids = Enum.map(body["results"], &String.to_integer(&1["id"]))
      assert Enum.sort(ids) == Enum.sort([hit.id, thread_hit.id])
      assert miss.id not in ids
      assert other_hit.id not in ids

      obj = hd(body["results"])
      assert obj["channel_id"] == ch_id
      assert obj["author"]["id"] != nil
      assert is_map_key(obj, "content")
    end

    test "thread id scope: only that thread's messages", %{
      ch_id: ch_id,
      hit: hit,
      thread_hit: thread_hit,
      bot_conn: bot_conn
    } do
      # The U12 hot-path fixture shape (thread_id == the anchor message id —
      # the indexed thread message carries exactly that thread_id).
      {:ok, thread} = Cytale.Threads.Thread.create(String.to_integer(ch_id), hit.id, "scoped", 1)

      conn = get(bot_conn, "/api/v10/channels/#{thread.thread_id}/messages/search?q=deploy")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["total"] == 1
      assert [%{"id" => id}] = body["results"]
      assert String.to_integer(id) == thread_hit.id
    end

    test "empty q matches everything in the channel; before/limit paginate", %{
      ch_id: ch_id,
      hit: hit,
      miss: miss,
      bot_conn: bot_conn
    } do
      all = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search")
      body = Jason.decode!(all.resp_body)
      assert body["total"] == 3

      # limit=1 → newest first (the thread message was seeded last).
      page = Jason.decode!(get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?limit=1").resp_body)
      assert length(page["results"]) == 1
      assert page["total"] == 3

      # before= the newest id excludes it.
      newest = hd(page["results"])["id"]

      older =
        Jason.decode!(get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?before=#{newest}").resp_body)

      refute newest in Enum.map(older["results"], & &1["id"])
      assert older["total"] == 3

      assert hit.id != miss.id
    end

    test "no matches → {results: [], total: 0}, never 404; unknown channel → 10003", %{
      ch_id: ch_id,
      bot_conn: bot_conn
    } do
      conn = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?q=nonexistentterm")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body) == %{"results" => [], "total" => 0}

      bogus = Integer.to_string(Cytale.Snowflake.next())
      miss404 = get(bot_conn, "/api/v10/channels/#{bogus}/messages/search?q=x")
      assert miss404.status == 404
      assert %{"code" => 10_003} = Jason.decode!(miss404.resp_body)
    end

    test "#76: a hit with no row is SKIPPED, never a 500", %{
      ws_int: ws_int,
      ch_id: ch_id,
      hit: hit,
      bot_conn: bot_conn
    } do
      ch_int = String.to_integer(ch_id)

      # A ghost: an index document whose ScyllaDB row does not exist. That is
      # what every deleted message used to leave behind, and one of them took
      # out the whole request — for every input, on every query shape — because
      # the render handed `nil` to the message codec.
      ghost_id = Cytale.Snowflake.next()

      :ok =
        TantivyImpl.index(ws_int, %{
          id: ghost_id,
          channel_id: ch_int,
          author_id: hit.author_id,
          content: "deploy ghost that has no row",
          thread_id: nil,
          created_at: DateTime.utc_now()
        })

      :ok = IndexWriter.commit_now({:workspace, ws_int})

      conn = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?q=deploy")
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)

      # The real match still arrives; the ghost is simply absent.
      assert Enum.any?(body["results"], &(&1["id"] == Integer.to_string(hit.id)))
      refute Enum.any?(body["results"], &(&1["id"] == Integer.to_string(ghost_id)))

      # ...and the match-all shape (no q) — the one the ticket saw 500 — answers.
      all = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search")
      assert all.status == 200
      refute Enum.any?(Jason.decode!(all.resp_body)["results"], &(&1["id"] == Integer.to_string(ghost_id)))
    end

    test "#76: deleting a message REMOVES its index document", %{
      ws_int: ws_int,
      ch_id: ch_id,
      bot_conn: bot_conn
    } do
      ch_int = String.to_integer(ch_id)

      # The delete half of the index seam. Without it the document above IS the
      # ghost, and this is the end-to-end version of that: a bot deletes its own
      # message and the index stops returning it.
      posted =
        post(bot_conn, "/api/v10/channels/#{ch_id}/messages", %{"content" => "unindex me please"})

      assert posted.status == 201
      msg_id = Jason.decode!(posted.resp_body)["id"]
      msg_int = String.to_integer(msg_id)

      :ok =
        TantivyImpl.index(ws_int, %{
          id: msg_int,
          channel_id: ch_int,
          author_id: 1,
          content: "unindex me please",
          thread_id: nil,
          created_at: DateTime.utc_now()
        })

      :ok = IndexWriter.commit_now({:workspace, ws_int})

      found = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?q=unindex")
      assert found.status == 200
      assert Enum.any?(Jason.decode!(found.resp_body)["results"], &(&1["id"] == msg_id))

      :ok = Cytale.Search.delete_message(ws_int, msg_int)

      gone = get(bot_conn, "/api/v10/channels/#{ch_id}/messages/search?q=unindex")
      assert gone.status == 200
      refute Enum.any?(Jason.decode!(gone.resp_body)["results"], &(&1["id"] == msg_id))
    end

    test "restricted agent: out-of-profile channel → the identical 10003", %{
      owner: owner,
      ch_id: ch_id,
      other_id: other_id,
      bot_conn: bot_conn
    } do
      {:ok, agent} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Scoped Searcher"), %{
          actions: ["read", "post"],
          channels: [ch_id]
        })

      scoped = bot_conn(agent.token)

      in_profile = get(scoped, "/api/v10/channels/#{ch_id}/messages/search?q=deploy")
      assert in_profile.status == 200

      out = get(scoped, "/api/v10/channels/#{other_id}/messages/search?q=deploy")
      assert out.status == 404
      assert %{"code" => 10_003, "message" => "Unknown Channel"} = Jason.decode!(out.resp_body)
    end
  end

  describe "GET /users/@me/channels/{dm_id}/messages/search (DM leg)" do
    setup %{owner: owner, bot: bot} do
      {:ok, dm} = Cytale.Workspaces.open_dm(bot.user_id, owner.user_id)

      {:ok, dm_hit} =
        Cytale.Messages.create_message(%{
          channel_id: dm.channel_id,
          author_id: owner.user_id,
          content: "dm deploy notes"
        })

      {:ok, dm_miss} =
        Cytale.Messages.create_message(%{channel_id: dm.channel_id, author_id: owner.user_id, content: "groceries"})

      {:ok, dm: dm, dm_hit: dm_hit, dm_miss: dm_miss}
    end

    test "recipient-gated scan: matches in shape, stranger 10003, empty not 404", %{
      owner: owner,
      dm: dm,
      dm_hit: dm_hit,
      dm_miss: dm_miss,
      bot_conn: bot_conn
    } do
      conn = get(bot_conn, "/api/v10/users/@me/channels/#{dm.channel_id}/messages/search?q=deploy")
      assert conn.status == 200

      body = Jason.decode!(conn.resp_body)
      assert body["total"] == 1
      assert [%{"id" => id, "content" => "dm deploy notes"}] = body["results"]
      assert String.to_integer(id) == dm_hit.id

      # The channel-scoped search route accepts the DM id too (same gate).
      via_channel = get(bot_conn, "/api/v10/channels/#{dm.channel_id}/messages/search?q=deploy")
      assert Jason.decode!(via_channel.resp_body)["total"] == 1

      # Empty match set: {results: [], total: 0}.
      empty = get(bot_conn, "/api/v10/users/@me/channels/#{dm.channel_id}/messages/search?q=zzz")
      assert empty.status == 200
      assert Jason.decode!(empty.resp_body) == %{"results" => [], "total" => 0}

      # A stranger's machine principal: the identical 10003.
      {_conn, stranger} = register_and_login()
      {:ok, stranger_agent} = AgentGrants.mint_all(stranger.user_id, :agent, run_unique("Dm Search Stranger"))

      denied =
        get(bot_conn(stranger_agent.token), "/api/v10/users/@me/channels/#{dm.channel_id}/messages/search?q=deploy")

      assert denied.status == 404
      assert %{"code" => 10_003} = Jason.decode!(denied.resp_body)

      assert owner.user_id > 0
      assert dm_miss.id != dm_hit.id
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp seed_message(channel_id, author_id, content, opts \\ []) do
    {:ok, msg} =
      Cytale.Messages.create_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: content,
        thread_id: Keyword.get(opts, :thread_id)
      })

    msg
  end

  defp indexed(msg) do
    %{
      id: msg.id,
      channel_id: msg.channel_id,
      author_id: msg.author_id,
      content: msg.content,
      thread_id: msg.thread_id,
      created_at: msg.created_at
    }
  end

  defp bot_conn(token) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bot " <> token)
  end

  defp register_and_login do
    username = "cs#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
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

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("ch")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end
end
