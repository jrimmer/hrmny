defmodule CytaleWeb.Compat.GuildThreadsTest do
  @moduledoc """
  Compat parity adds over the real gateway wire:

    * C-1 — the GUILD_CREATE `threads` inventory: the compat handshake lists
      the workspace's threads whose PARENT channel is in the session's
      visible set, as Discord type-11 thread channel objects (discord.js
      builds its thread cache from it at connect); a thread under a
      non-visible parent is omitted;
    * C-3 — the compat typing route triggers the NATIVE fan-out: a live
      NATIVE session observes TypingStart when a bot POSTs
      /api/v10/channels/{id}/typing (identical payload shape to the native
      REST fallback);
    * C-5b — `cytale, :external_base_url` feeds the SHARED gateway URL
      builder: the compat READY's resume_gateway_url carries the configured
      origin regardless of the upgrade request's host.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_nonce do
    "r" <>
      Integer.to_string(
        :erlang.phash2(
          {System.system_time(:millisecond), System.unique_integer([:positive, :monotonic])},
          1_000_000_000
        )
      )
  end

  defp run_unique(base), do: base <> run_nonce()

  setup do
    port = start_gateway!()

    {:ok, parent} = User.create(run_unique("gt_parent"), run_unique("gt_parent@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(parent.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("gt-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, hidden} = Workspaces.create_channel(ws.workspace_id, "hidden")

    {:ok, ws2} = Workspaces.create_workspace(parent.user_id, run_unique("gt-ws2"))
    {:ok, ch2} = Workspaces.create_channel(ws2.workspace_id, "second")

    %{
      port: port,
      parent: parent,
      ws: ws,
      general: general,
      hidden: hidden,
      ws2: ws2,
      ch2: ch2
    }
  end

  # -- helpers -------------------------------------------------------------------

  defp bot_identify!(conn, token) do
    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => 10,
        "intents" => CytaleWeb.GatewaySocket.supported_intents(),
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.js", "$device" => "discord.js"}
      }
    )
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  # A thread row under `channel` (root message + thread row, the domain path
  # the native controllers drive).
  defp create_thread!(channel_id, creator_id, name) do
    {:ok, root} = Messages.create_message(%{channel_id: channel_id, author_id: creator_id, content: "root"})
    {:ok, thread} = Thread.create(channel_id, root.id, name, creator_id)
    thread
  end

  # The stub identity the :test human_impl binds (deterministic phash of the
  # valid token) — a workspace OWNER it can be, so a native session subscribes
  # to its channels' routes.
  defp stub_user_id do
    :erlang.phash2(valid_token(), 900_000) + 100_000
  end

  # Swallow queued join-time frames (presence sync, guild creates) until the
  # wire is quiet, so the next assertion starts from a deterministic mailbox
  # (the gateway_compat_session pattern).
  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 300) do
      {:text, _} -> drain!(conn)
      {:binary, _} -> drain!(conn)
      {:closed, _code} -> :ok
      {:error, :timeout} -> :ok
    end
  end

  # Await a dispatch by event name, tolerating interleaved noise frames.
  defp await_dispatch!(conn, event, timeout \\ 5_000)

  defp await_dispatch!(_conn, event, timeout) when timeout <= 0 do
    flunk("timed out waiting for a #{inspect(event)} dispatch")
  end

  defp await_dispatch!(conn, event, timeout) do
    t0 = System.monotonic_time(:millisecond)

    case Cytale.Test.WSClient.recv(conn.pid, timeout) do
      {:text, json} ->
        frame = Jason.decode!(json)

        if frame["t"] == event do
          frame
        else
          await_dispatch!(conn, event, timeout - (System.monotonic_time(:millisecond) - t0))
        end

      {:binary, json} ->
        frame = Jason.decode!(json)

        if frame["t"] == event do
          frame
        else
          await_dispatch!(conn, event, timeout - (System.monotonic_time(:millisecond) - t0))
        end

      {:closed, code} ->
        flunk("expected a #{inspect(event)} dispatch, connection closed (#{inspect(code)})")

      {:error, :timeout} ->
        flunk("timed out waiting for a #{inspect(event)} dispatch")
    end
  end

  # ---------------------------------------------------------------------------
  # C-1: GUILD_CREATE threads inventory
  # ---------------------------------------------------------------------------

  describe "GUILD_CREATE threads (C-1)" do
    test "Identify → GUILD_CREATE carries parent-visible threads as type-11 channel objects", %{
      port: port,
      parent: parent,
      ws: ws,
      ws2: ws2,
      general: general,
      hidden: hidden,
      ch2: ch2
    } do
      visible_thread = create_thread!(general.channel_id, parent.user_id, "deploy follow-ups")
      _hidden_thread = create_thread!(hidden.channel_id, parent.user_id, "secret-side-thread")
      _other_ws_thread = create_thread!(ch2.channel_id, parent.user_id, "other-workspace-thread")

      # The agent is allowlisted to `general` ONLY: hidden is out-of-profile,
      # and every ws2 channel is too (that guild arrives with NO channels).
      {:ok, agent} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Thread Agent"), %{
          "actions" => ["read"],
          "channels" => [Integer.to_string(general.channel_id)]
        })

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      assert ready["user"]["bot"] == true

      # Two membership workspaces → two GUILD_CREATEs (arrival order is the
      # membership listing's; index by guild id).
      guilds =
        for _ <- 1..2 do
          frame = next_json!(conn, 5_000)
          assert frame["t"] == "GUILD_CREATE"
          {frame["d"]["id"], frame["d"]}
        end
        |> Map.new()

      guild = Map.fetch!(guilds, Integer.to_string(ws.workspace_id))

      # The visible set: general only — its thread rides, the hidden
      # parent's thread is omitted (thread visibility rides the PARENT
      # channel's rights), and no thread of another workspace leaks.
      assert guild["threads"] == [
               %{
                 "id" => Integer.to_string(visible_thread.thread_id),
                 "guild_id" => Integer.to_string(ws.workspace_id),
                 "parent_id" => Integer.to_string(general.channel_id),
                 "name" => "deploy follow-ups",
                 "type" => 11,
                 # #64 item 2: discord.py reads these three at the top level
                 # unguarded, and the metadata's archived /
                 # auto_archive_duration / archive_timestamp likewise.
                 "owner_id" => Integer.to_string(parent.user_id),
                 "message_count" => 0,
                 "member_count" => 0,
                 "thread_metadata" => %{
                   "archived" => false,
                   "auto_archive_duration" => 1440,
                   "archive_timestamp" =>
                     DateTime.to_iso8601(visible_thread.latest_reply_at || visible_thread.created_at),
                   "locked" => false,
                   "invitable" => true,
                   "create_timestamp" => DateTime.to_iso8601(visible_thread.created_at)
                 }
               }
             ]

      channel_ids = Enum.map(guild["channels"], & &1["id"])
      assert channel_ids == [Integer.to_string(general.channel_id)]

      # ws2 (where the second thread lives) is fully masked for this agent:
      # empty channels, empty threads — no cross-guild thread leak.
      masked = Map.fetch!(guilds, Integer.to_string(ws2.workspace_id))
      assert masked["threads"] == []
      assert masked["channels"] == []
    end

    test "a threadless workspace carries an empty threads array (shape stability)", %{
      port: port,
      parent: parent,
      ws: ws,
      ws2: ws2,
      general: general
    } do
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Bare Agent"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)

      guilds =
        for _ <- 1..2 do
          frame = next_json!(conn, 5_000)
          assert frame["t"] == "GUILD_CREATE"
          {frame["d"]["id"], frame["d"]}
        end
        |> Map.new()

      bare = Map.fetch!(guilds, Integer.to_string(ws.workspace_id))
      assert bare["threads"] == []

      general_id = Integer.to_string(general.channel_id)
      assert Enum.any?(bare["channels"], &match?(%{"id" => ^general_id}, &1))

      bare2 = Map.fetch!(guilds, Integer.to_string(ws2.workspace_id))
      assert bare2["threads"] == []
    end
  end

  # ---------------------------------------------------------------------------
  # 2026-10-08 (Hermes): a bot must know the thread a message comes from
  # ---------------------------------------------------------------------------

  describe "threads a bot was not told about (2026-10-08)" do
    defp guild_threads!(conn, ws) do
      frame = next_json!(conn, 5_000)
      assert frame["t"] == "GUILD_CREATE"
      assert frame["d"]["id"] == Integer.to_string(ws.workspace_id)
      frame["d"]["threads"]
    end

    defp thread_reply!(channel_id, thread_id, author_id, content) do
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: author_id,
          content: content,
          thread_id: thread_id
        })

      assert Cytale.Workspaces.FanOut.deliver(channel_id, {"ThreadMessageCreate", Cytale.Messages.Message.to_wire(msg)}) >=
               1

      msg
    end

    test "the first reply from an unknown thread comes after its THREAD_CREATE, and only the first", %{
      port: port,
      parent: parent,
      ws: ws,
      general: general
    } do
      {:ok, agent} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Late Thread Agent"), %{
          "actions" => ["read"],
          "channels" => [Integer.to_string(general.channel_id)]
        })

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      assert guild_threads!(conn, ws) == []
      drain!(conn)

      # Made without a THREAD_CREATE reaching this session, the shape of a
      # thread the GUILD_CREATE cap left out.
      thread = create_thread!(general.channel_id, parent.user_id, "tunarr")
      tid = Integer.to_string(thread.thread_id)

      msg = thread_reply!(general.channel_id, thread.thread_id, parent.user_id, "still not streaming")

      announced = next_json!(conn, 5_000)
      assert announced["t"] == "THREAD_CREATE"
      assert announced["d"]["id"] == tid
      assert announced["d"]["type"] == 11
      assert announced["d"]["parent_id"] == Integer.to_string(general.channel_id)
      assert announced["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert announced["d"]["name"] == "tunarr"
      # Not new: discord.py files it as a join, not on_thread_create.
      refute Map.has_key?(announced["d"], "newly_created")

      reply = next_json!(conn, 5_000)
      assert reply["t"] == "MESSAGE_CREATE"
      assert reply["d"]["channel_id"] == tid
      assert reply["d"]["id"] == Integer.to_string(msg.id)
      assert reply["s"] == announced["s"] + 1

      thread_reply!(general.channel_id, thread.thread_id, parent.user_id, "and again")
      again = next_json!(conn, 5_000)
      assert again["t"] == "MESSAGE_CREATE"
      assert again["d"]["channel_id"] == tid
    end

    test "a thread from the GUILD_CREATE inventory is not announced again", %{
      port: port,
      parent: parent,
      ws: ws,
      general: general
    } do
      thread = create_thread!(general.channel_id, parent.user_id, "already known")
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Known Thread Agent"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)

      guilds =
        for _ <- 1..2 do
          frame = next_json!(conn, 5_000)
          assert frame["t"] == "GUILD_CREATE"
          {frame["d"]["id"], frame["d"]}
        end
        |> Map.new()

      tid = Integer.to_string(thread.thread_id)
      assert [%{"id" => ^tid}] = Map.fetch!(guilds, Integer.to_string(ws.workspace_id))["threads"]
      drain!(conn)

      thread_reply!(general.channel_id, thread.thread_id, parent.user_id, "a reply")
      reply = next_json!(conn, 5_000)
      assert reply["t"] == "MESSAGE_CREATE"
      assert reply["d"]["channel_id"] == tid
    end

    test "a thread archived after it was announced is announced again on its next reply", %{
      port: port,
      parent: parent,
      ws: ws,
      general: general
    } do
      thread = create_thread!(general.channel_id, parent.user_id, "archived later")
      tid = Integer.to_string(thread.thread_id)
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Archive Agent"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)

      guilds =
        for _ <- 1..2 do
          frame = next_json!(conn, 5_000)
          {frame["d"]["id"], frame["d"]}
        end
        |> Map.new()

      assert [%{"id" => ^tid}] = Map.fetch!(guilds, Integer.to_string(ws.workspace_id))["threads"]
      drain!(conn)

      # discord.py drops a thread from its cache on an archived THREAD_UPDATE,
      # and a reply does not unarchive it here.
      :ok = Thread.set_archived(thread.thread_id, true)

      assert Cytale.Workspaces.FanOut.deliver(
               general.channel_id,
               {"ThreadUpdate", Cytale.Threads.Events.thread_update(thread, %{archived: true})}
             ) >= 1

      update = next_json!(conn, 5_000)
      assert update["t"] == "THREAD_UPDATE"
      assert update["d"]["thread_metadata"]["archived"] == true

      thread_reply!(general.channel_id, thread.thread_id, parent.user_id, "a reply after archiving")

      announced = next_json!(conn, 5_000)
      assert announced["t"] == "THREAD_CREATE"
      assert announced["d"]["id"] == tid

      reply = next_json!(conn, 5_000)
      assert reply["t"] == "MESSAGE_CREATE"
      assert reply["d"]["channel_id"] == tid
    end

    test "the GUILD_CREATE cap keeps open threads, most recently active first", %{
      port: port,
      parent: parent,
      ws: ws,
      general: general,
      hidden: hidden
    } do
      # Spread over two channels so channel order alone would pick wrongly:
      # `hidden` (listed second) holds the newest threads.
      older = for i <- 1..60, do: create_thread!(general.channel_id, parent.user_id, "older #{i}")
      newer = for i <- 1..45, do: create_thread!(hidden.channel_id, parent.user_id, "newer #{i}")
      archived = List.last(newer)
      :ok = Thread.set_archived(archived.thread_id, true)

      {:ok, agent} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Cap Agent"), %{
          "actions" => ["read"],
          "channels" => [Integer.to_string(general.channel_id), Integer.to_string(hidden.channel_id)]
        })

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      ids = Enum.map(guild_threads!(conn, ws), & &1["id"])

      assert length(ids) == 100

      expected =
        (Enum.reverse(newer -- [archived]) ++ Enum.reverse(older))
        |> Enum.take(100)
        |> Enum.map(&Integer.to_string(&1.thread_id))

      assert ids == expected
      refute Integer.to_string(archived.thread_id) in ids
    end
  end

  # ---------------------------------------------------------------------------
  # C-3: the compat typing route fans out to NATIVE sessions
  # ---------------------------------------------------------------------------

  describe "compat typing route → native TypingStart (C-3)" do
    test "in-profile bot typing is observed by a live native session", %{
      port: port,
      parent: parent
    } do
      # The stub identity owns the workspace (a native session therefore
      # subscribes to its channels); the bot's human parent is a MEMBER.
      {:ok, ws} = Workspaces.create_workspace(stub_user_id(), run_unique("typing-ws"))
      :ok = Workspaces.add_member(ws.workspace_id, parent.user_id, stub_user_id())
      {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
      {:ok, %{token: token}} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Typing Bot"))

      native = connect!(port)
      ready = identify!(native, valid_token())
      assert ready["user"]["id"] == Integer.to_string(stub_user_id())

      # Absorb the join-time presence sync so the mailbox is deterministic.
      drain!(native)

      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch.channel_id}/typing", %{})
      assert conn.status == 204
      assert conn.resp_body == ""

      frame = await_dispatch!(native, "TypingStart")

      ch_id = Integer.to_string(ch.channel_id)

      assert %{"channel_id" => ^ch_id, "user_id" => user_id, "timestamp" => ts} = frame["d"]

      assert user_id != Integer.to_string(stub_user_id())
      assert is_integer(ts)
    end

    test "out-of-profile bot typing never reaches the native session", %{
      port: port,
      parent: parent
    } do
      {:ok, ws} = Workspaces.create_workspace(stub_user_id(), run_unique("typing-ws2"))
      :ok = Workspaces.add_member(ws.workspace_id, parent.user_id, stub_user_id())
      {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
      {:ok, other} = Workspaces.create_channel(ws.workspace_id, "other")

      {:ok, %{token: token}} =
        AgentGrants.mint_all(parent.user_id, :bot, run_unique("Scoped Typing Bot"), %{
          "actions" => ["read", "post"],
          "channels" => [Integer.to_string(ch.channel_id)]
        })

      native = connect!(port)
      identify!(native, valid_token())

      # Absorb the join-time presence sync so the mailbox is deterministic.
      drain!(native)

      out = post(conn_with("Bot " <> token), "/api/v10/channels/#{other.channel_id}/typing", %{})
      assert out.status == 404
      assert Jason.decode!(out.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}

      assert {:error, :timeout} == Cytale.Test.WSClient.recv(native.pid, 400)
    end
  end

  # ---------------------------------------------------------------------------
  # #83 compat-surface remainder: the dual emission + thread-anchored
  # message events on the compat wire
  # ---------------------------------------------------------------------------

  describe "thread replies on the compat wire (dual emission)" do
    test "a thread reply arrives ONCE, on the thread id — the parent leg is dropped", %{
      port: port,
      parent: parent,
      ws: ws,
      general: general
    } do
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Dual Leg Agent"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, root} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} = Thread.create(general.channel_id, root.id, "dual-leg", parent.user_id)

      # The production hot path's BOTH legs (Messages.Message.send_message
      # publishes exactly this pair for an ordinary thread reply).
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: general.channel_id,
          author_id: parent.user_id,
          content: "a thread reply",
          thread_id: thread.thread_id
        })

      wire = Cytale.Messages.Message.to_wire(msg)

      assert Cytale.Workspaces.FanOut.deliver(general.channel_id, {"MessageCreate", wire}) >= 1

      assert Cytale.Workspaces.FanOut.deliver(general.channel_id, {"ThreadMessageCreate", wire}) >= 1

      # The thread was made after Identify without a THREAD_CREATE, so the
      # session first hears about it (2026-10-08 Hermes fix).
      announced = next_json!(conn, 5_000)
      assert announced["t"] == "THREAD_CREATE"
      assert announced["d"]["id"] == Integer.to_string(thread.thread_id)

      # Exactly ONE dispatch survives: the thread leg, carried on the THREAD
      # channel id (the parent-anchored copy would render the reply inline in
      # the parent, where no thread marker marks it — Discord never delivers
      # a thread reply to the parent channel).
      dispatch = next_json!(conn, 5_000)
      assert dispatch["t"] == "MESSAGE_CREATE"
      assert dispatch["d"]["channel_id"] == Integer.to_string(thread.thread_id)
      assert dispatch["d"]["id"] == Integer.to_string(msg.id)
      assert dispatch["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert dispatch["d"]["content"] == "a thread reply"

      # The dropped leg consumed no dispatch: the wire goes quiet.
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end

    test "a thread reply's edit and delete land on the THREAD id", %{
      port: port,
      parent: parent,
      general: general
    } do
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Rethread Agent"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, root} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} = Thread.create(general.channel_id, root.id, "rethread", parent.user_id)

      {:ok, msg} =
        Messages.create_message(%{
          channel_id: general.channel_id,
          author_id: parent.user_id,
          content: "to be edited",
          thread_id: thread.thread_id
        })

      # The native edit publish (parent-anchored, message_json carries the
      # thread scope) — the translation re-anchors it onto the thread.
      :ok = Messages.edit_message(general.channel_id, msg.id, "edited in thread")
      updated = Messages.get_message(general.channel_id, msg.id)

      assert Cytale.Workspaces.FanOut.deliver(
               general.channel_id,
               {"MessageUpdate", CytaleWeb.MessageController.message_json(updated)}
             ) >= 1

      edit = next_json!(conn, 5_000)
      assert edit["t"] == "MESSAGE_UPDATE"
      assert edit["d"]["channel_id"] == Integer.to_string(thread.thread_id)
      assert edit["d"]["content"] == "edited in thread"

      # Same rule for the delete (Events.message_delete carries thread_id).
      assert Cytale.Workspaces.FanOut.deliver(
               general.channel_id,
               {"MessageDelete", Cytale.Messages.Events.message_delete(updated)}
             ) >= 1

      deletion = next_json!(conn, 5_000)
      assert deletion["t"] == "MESSAGE_DELETE"
      assert deletion["d"]["channel_id"] == Integer.to_string(thread.thread_id)
      assert deletion["d"]["id"] == Integer.to_string(msg.id)
    end
  end

  # ---------------------------------------------------------------------------
  # #83 compat-surface remainder: typing IN a thread (compat route + dispatch)
  # ---------------------------------------------------------------------------

  describe "typing on a thread id (C-3 on the thread surface)" do
    test "POST /channels/{thread_id}/typing fans a TYPING_START carrying the THREAD id", %{
      port: port,
      parent: parent,
      general: general
    } do
      {:ok, typer} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Thread Typer"))
      {:ok, observer} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Thread Typing Observer"))

      conn = connect!(port, v: 10)
      bot_identify!(conn, observer.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, root} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} = Thread.create(general.channel_id, root.id, "typing thread", parent.user_id)

      posted = post(conn_with("Bot " <> typer.token), "/api/v10/channels/#{thread.thread_id}/typing", %{})
      assert posted.status == 204

      frame = await_dispatch!(conn, "TYPING_START")
      tid = Integer.to_string(thread.thread_id)

      # Discord's shape: the indicator rides the THREAD channel id (the
      # payload's fan-out key stayed the parent), and the typer's own
      # sessions are excluded (#80) — the OBSERVER sees it.
      assert %{"channel_id" => ^tid, "user_id" => user_id, "timestamp" => ts} = frame["d"]
      assert user_id == Integer.to_string(typer.user_id)
      assert is_integer(ts)
    end
  end

  # ---------------------------------------------------------------------------
  # C-5b: external_base_url feeds the SHARED gateway URL builder (READY)
  # ---------------------------------------------------------------------------

  describe "external_base_url → resume_gateway_url (C-5b)" do
    test "the READY's resume_gateway_url carries the configured origin", %{port: port, parent: parent} do
      Application.put_env(:cytale, :external_base_url, "https://chat.example.com")

      on_exit(fn -> Application.put_env(:cytale, :external_base_url, nil) end)

      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Url Agent"))

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)

      # The upgrade request came from 127.0.0.1:<os-port> over http — the
      # configured origin replaces it verbatim (ws mapping + suffix apply).
      assert ready["resume_gateway_url"] ==
               "wss://chat.example.com/gateway/websocket?v=10&encoding=json"
    end
  end
end
