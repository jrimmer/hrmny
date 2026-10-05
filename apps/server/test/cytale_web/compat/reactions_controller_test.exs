defmodule CytaleWeb.Compat.ReactionsControllerTest do
  @moduledoc """
  The compat reaction surface (Discord-shaped, both prefixes): the six
  routes' status codes + bodies, the 10003/50001/10008/50035 error mapping,
  the bare-array users body, the Discord `reactions` array on message
  objects ({count, me, emoji: {id: null, name}}), idempotent re-adds, the
  20-emoji + validation 50035s, restricted-agent 10003 anti-enumeration,
  and the /api bare-prefix alias.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages.Reactions

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    # The OWNER (human) seeds workspace/channel/message; the OWNER's BOT
    # resolves through the parent (full rights — the manager leg).
    {owner_conn, owner} = register_and_login()
    ws_id = create_workspace(owner_conn)
    ch_id = create_channel(owner_conn, ws_id)

    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("React Bot"))
    bot_conn = bot_conn(bot.token)
    msg_id = send_message(bot_conn, ch_id, "react to me via compat")

    {:ok,
     owner: owner, owner_conn: owner_conn, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id, bot: bot, bot_conn: bot_conn}
  end

  defp reaction_path(prefix, ch_id, msg_id, emoji, suffix \\ ""),
    do: "#{prefix}/channels/#{ch_id}/messages/#{msg_id}/reactions/#{URI.encode(emoji)}#{suffix}"

  describe "add / remove own (@me)" do
    test "PUT @me → 204 empty; re-add → 204 with NO second event", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn,
      bot: bot
    } do
      log =
        capture_log(fn ->
          assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionAdd"

      log2 =
        capture_log(fn ->
          assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      refute log2 =~ "MessageReactionAdd"

      assert [%{emoji: "👍", count: 1}] =
               Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id))

      assert bot.user_id != nil
    end

    test "DELETE @me → 204 + MessageReactionRemove; last remove clears storage", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204

      log =
        capture_log(fn ->
          assert bot_conn |> delete(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionRemove"
      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
    end

    test "the bare /api prefix serves the identical contract", %{ch_id: ch_id, msg_id: msg_id, bot_conn: bot_conn} do
      assert bot_conn |> put(reaction_path("/api", ch_id, msg_id, "🔥", "/@me")) |> status() == 204

      body = bot_conn |> get(reaction_path("/api", ch_id, msg_id, "🔥")) |> json()
      assert is_list(body) and length(body) == 1
      assert %{"id" => _, "username" => _} = hd(body)

      assert bot_conn |> delete(reaction_path("/api", ch_id, msg_id, "🔥", "/@me")) |> status() == 204
    end
  end

  describe "GET users (bare array)" do
    test "bare JSON array of Discord user objects, ascending; ?after= paginates", %{
      ch_id: ch_id,
      msg_id: msg_id,
      owner: owner,
      bot_conn: bot_conn,
      bot: bot
    } do
      {:ok, second} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Second Reactor"))
      second_conn = bot_conn(second.token)

      assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert second_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204

      body = bot_conn |> get(reaction_path("/api/v10", ch_id, msg_id, "👍")) |> json()

      assert is_list(body) and length(body) == 2
      ids = Enum.map(body, &String.to_integer(&1["id"])) |> Enum.sort()
      assert Enum.sort([bot.user_id, second.user_id]) == ids

      # Machine principals carry bot: true (the Discord user object).
      bot_entry = Enum.find(body, &(&1["id"] == Integer.to_string(bot.user_id)))
      assert bot_entry["bot"] == true
      assert bot_entry["discriminator"] == "0"

      # after= cursor: only the higher user id remains.
      page =
        bot_conn
        |> get(reaction_path("/api/v10", ch_id, msg_id, "👍") <> "?after=#{Integer.to_string(Enum.at(ids, 0))}")
        |> json()

      assert Enum.map(page, &String.to_integer(&1["id"])) == [Enum.at(ids, 1)]
    end

    test "unknown emoji → empty array (never an envelope)", %{ch_id: ch_id, msg_id: msg_id, bot_conn: bot_conn} do
      assert bot_conn |> get(reaction_path("/api/v10", ch_id, msg_id, "👀")) |> json() == []
    end
  end

  describe "message object reactions (Discord shape)" do
    test "history + create echo carry {count, me, emoji: {id: null, name}}; me tracks the CALLING bot",
         %{ch_id: ch_id, msg_id: msg_id, owner: owner, bot_conn: bot_conn} do
      {:ok, observer} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Observer Agent"))
      observer_conn = bot_conn(observer.token)

      # The bot reacts; the observer did not.
      assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204

      bot_history = bot_conn |> get("/api/v10/channels/#{ch_id}/messages") |> json()
      msg = Enum.find(bot_history, &(&1["id"] == msg_id))

      assert [%{"count" => 1, "me" => true, "emoji" => %{"id" => nil, "name" => "👍"}}] = msg["reactions"]

      observer_history = observer_conn |> get("/api/v10/channels/#{ch_id}/messages") |> json()
      observer_msg = Enum.find(observer_history, &(&1["id"] == msg_id))
      assert [%{"count" => 1, "me" => false, "emoji" => %{"id" => nil, "name" => "👍"}}] = observer_msg["reactions"]

      # Reaction-less messages keep the key ABSENT.
      plain = send_message(bot_conn, ch_id, "no reactions")
      plain_history = bot_conn |> get("/api/v10/channels/#{ch_id}/messages") |> json()
      refute Map.has_key?(Enum.find(plain_history, &(&1["id"] == plain)), "reactions")
    end
  end

  describe "page reaction batching (hardening plan 2.1, compat twin)" do
    test "the compat history page's read count does not scale with its row count", %{
      ch_id: ch_id,
      bot_conn: bot_conn,
      bot: bot
    } do
      channel_id = String.to_integer(ch_id)

      # Seed rows directly (the page's READ is what is under test; 40 compat
      # POSTs would spend the test in the write path). The bot is the author and
      # the viewer, so every row carries its own `me` flag.
      seed = fn count ->
        for i <- 1..count do
          {:ok, msg} =
            Cytale.Messages.create_message(%{
              channel_id: channel_id,
              author_id: String.to_integer(bot.user_id |> to_string()),
              content: "compat page row #{i}"
            })

          :ok = Reactions.add(channel_id, msg.id, String.to_integer(to_string(bot.user_id)), "👍")
          msg.id
        end
      end

      # Fetch each page right after ITS seed set: a page is the NEWEST `limit`
      # rows, so seeding both first would make the "small" page the newest of the
      # large set and the comparison meaningless.
      small = seed.(3)

      {small_stmts, small_body} =
        capture_statements(fn -> bot_conn |> get("/api/v10/channels/#{ch_id}/messages?limit=3") |> json() end)

      large = seed.(30)

      {large_stmts, large_body} =
        capture_statements(fn -> bot_conn |> get("/api/v10/channels/#{ch_id}/messages?limit=30") |> json() end)

      # Both pages carry the Discord shape with the viewer's `me` flag.
      assert [%{"count" => 1, "me" => true, "emoji" => %{"id" => nil, "name" => "👍"}}] =
               Enum.find(small_body, &(&1["id"] == to_string(hd(small))))["reactions"]

      assert length(large_body) == 30
      assert Enum.all?(large, fn id -> Enum.find(large_body, &(&1["id"] == to_string(id)))["reactions"] != nil end)

      # BOUNDED: the same statement count for a 3-row page and a 30-row page — the
      # reaction read is one `IN ?` batch, not two point reads per message.
      assert length(small_stmts) == length(large_stmts),
             "the compat page scaled with rows: #{length(small_stmts)} vs #{length(large_stmts)}"
    end
  end

  # Statement capture over Xandra's query telemetry.
  defp capture_statements(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "compat-reactions-page-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          # Only this request's statements (the test process or a task it
          # spawned): the handler is global, so another process's query in the
          # window counted too (#174's sibling flake, "scaled with rows: 18 vs 16").
          if self() == parent or parent in Process.get(:"$callers", []) do
            send(parent, {:stmt, ref, metadata.query.statement})
          end
        end,
        parent
      )

    result = fun.()
    Process.sleep(50)
    statements = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)
    {statements, result}
  end

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "manage_messages gates" do
    setup %{ws_id: ws_id, owner_conn: owner_conn} do
      # A plain member's agent: the member has no manage_messages on the
      # @everyone base, and the agent resolves through THEM (R1).
      invite_code = create_invite(owner_conn, ws_id)
      {member_conn, member} = register_and_login()
      assert post(member_conn, "/api/v1/invites/#{invite_code}") |> status() == 200

      {:ok, agent} = AgentGrants.mint_all(member.user_id, :agent, run_unique("Member Agent"))
      {:ok, member_agent_conn: bot_conn(agent.token), member: member}
    end

    test "EVERY agent is refused: no grant can confer manage_messages", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn,
      member_agent_conn: member_agent_conn,
      member: member
    } do
      # The manager half of this test used to run as the parent-owner's bot.
      # Under the agent model no machine principal can hold `manage_messages`
      # (`Cytale.Access.never/0`), so the parent-owner's agent is refused
      # exactly like a plain member's — and the manager paths are exercised on
      # the NATIVE route, by the human who can hold the capability
      # (`test/cytale_web/controllers/reaction_controller_test.exs`).
      assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204

      for {label, conn} <- [{"plain member's agent", member_agent_conn}, {"owner's agent", bot_conn}] do
        for path <- [
              reaction_path("/api/v10", ch_id, msg_id, "👍"),
              "/api/v10/channels/#{ch_id}/messages/#{msg_id}/reactions",
              reaction_path("/api/v10", ch_id, msg_id, "👍", "/#{Integer.to_string(member.user_id)}")
            ] do
          conn403 = delete(conn, path)
          assert status(conn403) == 403, "#{label} must be refused on #{path}"
          assert %{"code" => 50_001, "message" => "Missing Permissions"} = Jason.decode!(conn403.resp_body)
        end
      end
    end

    test "21st distinct + invalid emoji → 400 50035", %{ch_id: ch_id, msg_id: msg_id, bot_conn: bot_conn} do
      # C-2: reaction PUTs share the tight 10/5s message_write class — raise
      # it for this 20-reaction flood (class limits are config-overridable
      # by design; a partial override merges over the defaults).
      previous = Application.get_env(:cytale, :compat)

      Application.put_env(
        :cytale,
        :compat,
        Keyword.put(previous || [], :route_class_limits, message_write: {1_000, 5_000})
      )

      on_exit(fn ->
        case previous do
          nil -> Application.delete_env(:cytale, :compat)
          value -> Application.put_env(:cytale, :compat, value)
        end
      end)

      for i <- 0..19 do
        assert bot_conn |> put(reaction_path("/api/v10", ch_id, msg_id, "🙂#{i}", "/@me")) |> status() == 204
      end

      conn21 = put(bot_conn, reaction_path("/api/v10", ch_id, msg_id, "🎉", "/@me"))
      assert status(conn21) == 400
      assert %{"code" => 50_035, "message" => "Invalid Form Body"} = Jason.decode!(conn21.resp_body)

      for bad <- [":custom:", String.duplicate("🙂", 4)] do
        conn_bad = put(bot_conn, reaction_path("/api/v10", ch_id, msg_id, bad, "/@me"))
        assert status(conn_bad) == 400
        assert %{"code" => 50_035} = Jason.decode!(conn_bad.resp_body)
      end
    end

    test "unknown message → 404 10008; unknown channel → 404 10003", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn
    } do
      bogus_msg = Integer.to_string(Cytale.Snowflake.next())

      conn404 = put(bot_conn, reaction_path("/api/v10", ch_id, bogus_msg, "👍", "/@me"))
      assert status(conn404) == 404
      assert %{"code" => 10_008, "message" => "Unknown Message"} = Jason.decode!(conn404.resp_body)

      bogus_ch = Integer.to_string(Cytale.Snowflake.next())

      conn_ch = put(bot_conn, reaction_path("/api/v10", bogus_ch, msg_id, "👍", "/@me"))
      assert status(conn_ch) == 404
      assert %{"code" => 10_003, "message" => "Unknown Channel"} = Jason.decode!(conn_ch.resp_body)
    end

    test "restricted agent: out-of-profile reaction → the identical 10003; in-profile → works",
         %{owner: owner, owner_conn: owner_conn, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id} do
      {:ok, other} = Cytale.Workspaces.create_channel(String.to_integer(ws_id), run_unique("compat-hidden"))

      # Seed the other channel's message over the NATIVE route (the owner's
      # Bearer credential; the compat prefix is Bot-scheme only).
      seeded =
        post(owner_conn, "/api/v1/channels/#{other.channel_id}/messages", %{"content" => "other channel"})

      assert status(seeded) == 201
      other_msg = Jason.decode!(seeded.resp_body)["message"]["id"]

      {:ok, agent} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Scoped Compat Reactor"), %{
          actions: ["read", "post"],
          channels: [ch_id]
        })

      scoped = bot_conn(agent.token)

      assert scoped |> put(reaction_path("/api/v10", ch_id, msg_id, "👍", "/@me")) |> status() == 204

      out = scoped |> put(reaction_path("/api/v10", Integer.to_string(other.channel_id), other_msg, "👍", "/@me"))
      assert status(out) == 404
      assert %{"code" => 10_003, "message" => "Unknown Channel"} = Jason.decode!(out.resp_body)
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp status(conn), do: conn.status

  defp json(conn), do: Jason.decode!(conn.resp_body)

  defp bot_conn(token) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bot " <> token)
  end

  defp register_and_login do
    username = "rc#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
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
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  defp send_message(conn, ch_id, content) do
    conn = post(conn, "/api/v10/channels/#{ch_id}/messages", %{"content" => content})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["id"]
  end

  # -- #83 compat-surface remainder: reactions through a THREAD id --------------
  # (C-2: a thread IS a channel — the routes answered 10003 on a thread id
  # before; storage and events anchor on the PARENT partition, the same
  # anchor a web-initiated reaction on a thread message uses.)

  describe "reactions on a thread message (thread id as channel_id)" do
    test "PUT @me on the thread id stores on the parent, reads back, removes", %{
      ch_id: ch_id,
      msg_id: msg_id,
      bot_conn: bot_conn,
      bot: bot
    } do
      {:ok, thread} =
        Cytale.Threads.Thread.start(String.to_integer(ch_id), String.to_integer(msg_id), "reacted thread", bot.user_id)

      {:ok, reply} =
        Cytale.Messages.create_message(%{
          channel_id: String.to_integer(ch_id),
          author_id: bot.user_id,
          content: "react to me in the thread",
          thread_id: thread.thread_id
        })

      tid = Integer.to_string(thread.thread_id)
      mid = Integer.to_string(reply.id)
      bot_id = Integer.to_string(bot.user_id)

      log =
        capture_log(fn ->
          assert bot_conn |> put(reaction_path("/api/v10", tid, mid, "🔥", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionAdd"

      # Storage anchored on the PARENT partition (the thread id is not part
      # of the reaction key) — the same anchor the native surface uses.
      assert [%{emoji: "🔥", count: 1}] = Reactions.summary(String.to_integer(ch_id), reply.id)

      # Readable again through the thread id; the users body is the bare array.
      users = get(bot_conn, reaction_path("/api/v10", tid, mid, "🔥"))
      assert users.status == 200
      assert [%{"id" => ^bot_id}] = Jason.decode!(users.resp_body)

      assert bot_conn |> delete(reaction_path("/api/v10", tid, mid, "🔥", "/@me")) |> status() == 204

      assert Reactions.summary(String.to_integer(ch_id), reply.id) == []
    end
  end

  defp create_invite(conn, ws_id) do
    {:ok, invite} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
    invite.invite_code
  end
end
