defmodule CytaleWeb.GatewayDmMemberPresenceTest do
  @moduledoc """
  Bots plan B-1/B-3 wire tests — DM + member/presence delivery to compat
  sessions over the real Bandit wire:

    * DM-anchored events (MESSAGE_CREATE / reactions / typing on a DM
      channel id) deliver to the bot's session on DIRECT_MESSAGES (1<<12),
      DIRECT_MESSAGE_REACTIONS (1<<13), DIRECT_MESSAGE_TYPING (1<<14) —
      recipient-gated (a non-participant agent of the same parent receives
      NOTHING), guild_id nil (Discord's DM shape);
    * the parent's NATIVE session receives its DMs through the same
      user-key fan-out (the pre-B-1 Publish path dropped DM channels);
    * GUILD_MEMBERS (1<<1) → GUILD_MEMBER_ADD/REMOVE on real invite-accept/
      kick flows; GUILD_PRESENCES (1<<8) → PRESENCE_UPDATE on a real
      presence op — and without the bits, nothing.
  """

  use Cytale.GatewayCase, async: false

  import Bitwise
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # DIRECT_MESSAGES | DIRECT_MESSAGE_REACTIONS | DIRECT_MESSAGE_TYPING.
  @dm_intents Bitwise.bor(1 <<< 12, Bitwise.bor(1 <<< 13, 1 <<< 14))
  # GUILD_MEMBERS | GUILD_PRESENCES.
  @member_presence_intents Bitwise.bor(1 <<< 1, 1 <<< 8)

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    port = start_gateway!()

    {:ok, parent} = User.create(run_unique("dmp"), run_unique("dmp@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(parent.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("dm-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Dm Wire Agent"))

    # A NATIVE human session identity: the :test human_impl (Stub) binds the
    # token to a deterministic synthetic id — seed a users row + workspace
    # membership for it so the DM kind guard and the routes accept it as a
    # real participant.
    stub_token = "cytale_dm_wire_stub_#{System.unique_integer([:positive])}"
    stub_id = :erlang.phash2(stub_token, 900_000) + 100_000

    insert_stub_user!(stub_id, "dm-wire-stub")

    {:ok, port: port, parent: parent, ws: ws, general: general, agent: agent, stub_token: stub_token, stub_id: stub_id}
  end

  describe "bot DM delivery (B-1)" do
    setup %{stub_id: stub_id, agent: agent} do
      {:ok, dm} = Workspaces.open_dm(stub_id, agent.user_id)
      {:ok, dm: dm}
    end

    test "MESSAGE_CREATE / reactions / typing deliver on DIRECT_* intents; guild_id nil; native parent receives too",
         %{port: port, agent: agent, stub_token: stub_token, stub_id: stub_id, dm: dm} do
      bot = connect!(port, v: 10)
      bot_identify!(bot, agent.token, @dm_intents)
      drain!(bot)

      parent = connect!(port, v: 1)
      identify!(parent, stub_token)
      drain!(parent)

      {:ok, msg} = Cytale.Messages.create_message(%{channel_id: dm.channel_id, author_id: stub_id, content: "dm hello"})

      assert Cytale.Workspaces.FanOut.deliver(
               dm.channel_id,
               {"MessageCreate", CytaleWeb.MessageController.message_json(msg)}
             ) >= 2

      # The BOT gets the Discord shape on the DM channel (1<<12): guild_id
      # nil (Discord's DM events carry no guild), author resolved.
      frame = next_event!(bot, "MESSAGE_CREATE", 5_000)

      assert frame["d"]["channel_id"] == Integer.to_string(dm.channel_id)
      assert frame["d"]["content"] == "dm hello"
      assert frame["d"]["guild_id"] == nil
      assert frame["d"]["author"]["id"] == Integer.to_string(stub_id)

      # The PARENT's native session receives the same event untranslated
      # (CamelCase native wire, no intents, no translation).
      native_frame = next_event!(parent, "MessageCreate", 5_000)
      assert native_frame["d"]["channel_id"] == Integer.to_string(dm.channel_id)

      # Reactions ride 1<<13: Discord's MESSAGE_REACTION_ADD with member.user.
      reaction =
        CytaleWeb.ReactionController.reaction_payload(dm.channel_id, msg.id, stub_id, "👍")

      :ok = deliver_raw(dm.channel_id, {"MessageReactionAdd", reaction})
      rx = next_event!(bot, "MESSAGE_REACTION_ADD", 5_000)
      assert rx["d"]["guild_id"] == nil
      assert rx["d"]["emoji"] == %{"id" => nil, "name" => "👍"}
      assert rx["d"]["member"]["user"]["id"] == Integer.to_string(stub_id)

      # Typing rides 1<<14 (the REST fallback's payload shape).
      typing_payload = %{
        channel_id: Integer.to_string(dm.channel_id),
        thread_id: nil,
        user_id: Integer.to_string(stub_id),
        timestamp: System.system_time(:millisecond)
      }

      :ok = deliver_raw(dm.channel_id, {"TypingStart", typing_payload})
      ty = next_event!(bot, "TYPING_START", 5_000)
      assert ty["d"]["guild_id"] == nil
    end

    test "a NON-participant agent (same parent!) receives nothing — routing-level isolation",
         %{port: port, parent: parent, stub_id: stub_id, dm: dm} do
      {:ok, bystander} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Bystander Agent"))

      bot = connect!(port, v: 10)
      bot_identify!(bot, bystander.token, @dm_intents)
      drain!(bot)

      {:ok, msg} = Cytale.Messages.create_message(%{channel_id: dm.channel_id, author_id: stub_id, content: "private"})

      # Zero live targets: the DM fan addresses only the participants' user
      # keys — the bystander's session is never even handed the event.
      assert Cytale.Workspaces.FanOut.deliver(
               dm.channel_id,
               {"MessageCreate", CytaleWeb.MessageController.message_json(msg)}
             ) == 0

      refute_next_event!(bot, "MESSAGE_CREATE", 500)
    end

    test "without the DIRECT_* bits the DM events are silent (allow-silent)",
         %{port: port, agent: agent, stub_id: stub_id, dm: dm} do
      # GUILD_MESSAGES only — the guild bits never unlock DM events.
      bot = connect!(port, v: 10)
      bot_identify!(bot, agent.token, 1 <<< 9)
      drain!(bot)

      {:ok, msg} = Cytale.Messages.create_message(%{channel_id: dm.channel_id, author_id: stub_id, content: "hidden"})
      :ok = deliver_raw(dm.channel_id, {"MessageCreate", CytaleWeb.MessageController.message_json(msg)})

      refute_next_event!(bot, "MESSAGE_CREATE", 500)
    end

    # Tier 3 B (12c): the REST DM gate already required the bot's DM grant;
    # the compat gateway filter did not, so a bot whose access document says
    # `dms: :none` still received every DM message over the wire.
    test "a participant bot whose access grants no DMs (dms: :none) receives nothing",
         %{port: port, agent: agent, stub_id: stub_id, dm: dm} do
      _ = AgentGrants.grant(agent, %{AgentGrants.all_access() | dms: :none})

      bot = connect!(port, v: 10)
      bot_identify!(bot, agent.token, @dm_intents)
      drain!(bot)

      {:ok, msg} =
        Cytale.Messages.create_message(%{channel_id: dm.channel_id, author_id: stub_id, content: "no dm grant"})

      :ok = deliver_raw(dm.channel_id, {"MessageCreate", CytaleWeb.MessageController.message_json(msg)})

      refute_next_event!(bot, "MESSAGE_CREATE", 500)
    end
  end

  describe "member + presence events (B-3)" do
    test "invite-accept → GUILD_MEMBER_ADD; kick → GUILD_MEMBER_REMOVE; presence op → PRESENCE_UPDATE; without bits → silence",
         %{port: port, parent: parent, ws: ws, general: general, stub_id: stub_id, stub_token: stub_token} do
      bot = connect!(port, v: 10)
      bot_identify!(bot, session_agent(parent).token, @member_presence_intents)
      drain!(bot)

      # A fresh human joins via the REAL invite flow (native REST through
      # the shared endpoint).
      {joiner_conn, joiner} = register_and_login()

      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, parent.user_id, max_age_s: 600)
      joined = post(joiner_conn, "/api/v1/invites/#{invite.invite_code}")
      assert joined.status == 200

      add = next_event!(bot, "GUILD_MEMBER_ADD", 5_000)
      assert add["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert add["d"]["user"]["id"] == Integer.to_string(joiner.user_id)
      assert is_binary(add["d"]["user"]["username"])
      # #73: the member shape is now shared with the roster, so a new member
      # carries @everyone (whose id IS the guild id) rather than an empty list.
      assert add["d"]["roles"] == [Integer.to_string(ws.workspace_id)]
      assert add["d"]["flags"] == 0

      # Kick → GUILD_MEMBER_REMOVE with the resolved user object.
      kick = delete(owner_conn(parent), "/api/v1/workspaces/#{ws.workspace_id}/members/#{joiner.user_id}")
      assert kick.status == 200

      remove = next_event!(bot, "GUILD_MEMBER_REMOVE", 5_000)
      assert remove["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert remove["d"]["user"]["id"] == Integer.to_string(joiner.user_id)

      # Presence: the stub human is a workspace member with a live NATIVE
      # session; its op-3 presence update announces workspace-wide.
      :ok = Workspaces.add_member(ws.workspace_id, stub_id, parent.user_id, [])

      human = connect!(port, v: 1)
      identify!(human, stub_token)
      drain!(human)

      send_frame!(human, 3, %{"status" => "dnd"})

      # The connect-time announce ("online") may interleave — await the dnd.
      presence = await_presence(bot, "dnd", 5_000)
      assert presence["d"]["user"]["id"] == Integer.to_string(stub_id)
      assert presence["d"]["user"]["username"] == "dm-wire-stub"
      assert presence["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert presence["d"]["activities"] == []
      assert presence["d"]["client_status"] == %{}

      assert general.channel_id > 0
    end

    test "without 1<<1/1<<8 the member/presence events are silent", %{
      port: port,
      parent: parent,
      ws: ws,
      stub_id: stub_id,
      stub_token: stub_token
    } do
      bot = connect!(port, v: 10)
      bot_identify!(bot, session_agent(parent).token, 1 <<< 9)
      drain!(bot)

      {joiner_conn, joiner} = register_and_login()

      {:ok, invite} = Workspaces.create_invite(ws.workspace_id, parent.user_id, max_age_s: 600)
      assert post(joiner_conn, "/api/v1/invites/#{invite.invite_code}") |> status_of() == 200

      :ok = Workspaces.add_member(ws.workspace_id, stub_id, parent.user_id, [])

      human = connect!(port, v: 1)
      identify!(human, stub_token)
      drain!(human)
      send_frame!(human, 3, %{"status" => "idle"})

      refute_next_event!(bot, "GUILD_MEMBER_ADD", 500)
      refute_next_event!(bot, "PRESENCE_UPDATE", 500)
      assert joiner.user_id > 0
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp status_of(conn), do: conn.status

  # Await a PRESENCE_UPDATE with the expected status (the connect-time
  # "online" announce may interleave ahead of the op-3 flip).
  defp await_presence(conn, status, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout

    do_await_presence(conn, status, deadline)
  end

  defp do_await_presence(conn, status, deadline) do
    if System.monotonic_time(:millisecond) >= deadline do
      flunk("expected PRESENCE_UPDATE with status #{inspect(status)}, timed out")
    else
      case next_event!(conn, "PRESENCE_UPDATE", max(deadline - System.monotonic_time(:millisecond), 1)) do
        %{"d" => %{"status" => ^status}} = frame -> frame
        _other -> do_await_presence(conn, status, deadline)
      end
    end
  end

  defp session_agent(parent) do
    # The member/presence legs need a FRESH agent per describe-run to avoid
    # cross-test session cap overlap; mint from the parent.
    {:ok, agent} =
      AgentGrants.mint_all(
        parent.user_id,
        :agent,
        run_unique("Member Wire Agent #{System.unique_integer([:positive])}")
      )

    agent
  end

  defp bot_identify!(conn, token, intents) do
    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => 10,
        "intents" => intents,
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.js", "$device" => "discord.js"}
      }
    )
  end

  # Deliver through the DM-aware seam (Publish's test impl is the logger —
  # the REST paths route through FanOut.deliver in production shape).
  defp deliver_raw(channel_id, event) do
    Cytale.Workspaces.FanOut.deliver(channel_id, event)
    :ok
  end

  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 250) do
      {:text, _} -> drain!(conn)
      {:binary, _} -> drain!(conn)
      {:closed, _} -> :ok
      {:error, :timeout} -> :ok
    end
  end

  defp insert_stub_user!(user_id, username) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO {{K}}.users (user_id, username, email, email_verified_at, password_hash, display_name, avatar_url, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      |> String.replace("{{K}}", Cytale.Repo.keyspace()),
      [
        {"bigint", user_id},
        {"text", username},
        {"text", "#{username}@example.com"},
        {"timestamp", now},
        {"text", nil},
        {"text", nil},
        {"text", nil},
        {"timestamp", now},
        {"timestamp", nil}
      ]
    )

    :ok
  end

  defp owner_conn(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  defp register_and_login do
    username = "gdm#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
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
end
