defmodule CytaleWeb.CommandInvocationLoopTest do
  @moduledoc """
  #134 acceptance centerpiece — the click→callback invocation loop, proven
  END TO END at the wire with a test application, over zero context-level
  shortcuts:

    the application REGISTERS its command set (compat PUT, "Bot" auth)
      → the member's palette read (native GET …/commands) reflects the rows
      → the member PICKS one (POST /api/v1/interactions, Bearer auth)
      → the bot's gateway session observes INTERACTION_CREATE (the wire
        frame carrying the callback credential — emit-before-ack)
      → the bot answers via POST /api/v10/interactions/{id}/{token}/callback
        (URL token, NO auth header)
      → the reply EXISTS in the channel as the bot's message.

  The same wire pins the #134 invocation-side gates: every pick demands the
  acting member's channel send right (the @-mention parity), and an
  `invite`-named command additionally demands manage_workspace — enforced
  SERVER-SIDE at invocation (the stored command object has no Discord
  `default_member_permissions` counterpart, so the authority cannot ride
  the registration and is keyed by NAME for any application's rows).
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Interactions.TokenStore
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | GUILD_MESSAGE_TYPING (1<<11).
  @all_supported_intents CytaleWeb.GatewaySocket.supported_intents()

  # The registration the test application PUTs — the production shape an
  # adapter sends over the compat applications routes.
  @ask_def %{
    "name" => "ask",
    "description" => "Ask the workspace agent",
    "options" => [
      %{"name" => "question", "description" => "Your question", "type" => 3, "required" => true}
    ]
  }

  @invite_def %{
    "name" => "invite",
    "description" => "Mint a workspace invite",
    "options" => [
      %{"name" => "user", "description" => "User to invite", "type" => 3, "required" => false}
    ]
  }

  setup do
    port = start_gateway!()

    {:ok, owner} = User.create(run_unique("l134_owner"), run_unique("l134_owner@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("l134_member"), run_unique("l134_member@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("l134-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, locked} = Workspaces.create_channel(ws.workspace_id, "locked")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Loop Bot"))

    {:ok, port: port, ws: ws, general: general, locked: locked, owner: owner, member: member, bot: bot}
  end

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  # -- wire clients -----------------------------------------------------------

  defp conn_for(user) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp bot_api_conn(token) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bot " <> token)
  end

  # The callback carries NO Authorization header — the URL token is the
  # credential (Discord libraries send none there).
  defp anon_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  # The application registers its set over the COMPAT route (what an
  # adapter's sync does) — the registration itself is part of the proven
  # loop, never a context-level backdoor.
  defp register_over_wire!(bot, ws) do
    conn =
      put(
        bot_api_conn(bot.token),
        "/api/v10/applications/#{bot.user_id}/guilds/#{ws.workspace_id}/commands",
        Jason.encode!([@ask_def, @invite_def])
      )

    assert conn.status == 200, "compat registration failed: #{conn.status} #{conn.resp_body}"
    :ok
  end

  # The palette read IS the composer's pick list — the command id invoked
  # below comes FROM this response, exactly as the client does it.
  defp palette!(user, ws) do
    conn = get(conn_for(user), "/api/v1/workspaces/#{ws.workspace_id}/commands")
    assert conn.status == 200
    Jason.decode!(conn.resp_body)["commands"]
  end

  defp command_of(commands, name), do: Enum.find(commands, &(&1["name"] == name))

  defp pick(user, command, channel, options) do
    post(conn_for(user), "/api/v1/interactions", %{
      "command_id" => command["id"],
      "channel_id" => Integer.to_string(channel.channel_id),
      "options" => options
    })
  end

  defp answer(interaction_id, token, content) do
    post(anon_conn(), "/api/v10/interactions/#{interaction_id}/#{token}/callback", %{
      "type" => 4,
      "data" => %{"content" => content}
    })
  end

  defp bot_identify!(conn, token) do
    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => 10,
        "intents" => @all_supported_intents,
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.js", "$device" => "discord.js"}
      }
    )
  end

  # Drain join-time dispatches (GUILD_CREATE etc.) so assertions start from
  # a deterministic mailbox.
  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 250) do
      {:text, _json} -> drain!(conn)
      {:closed, _code} -> :ok
      {:error, :timeout} -> :ok
    end
  end

  # ---------------------------------------------------------------------------
  # THE LOOP
  # ---------------------------------------------------------------------------

  test "the full loop: register → palette → pick → INTERACTION_CREATE → callback → reply", %{
    port: port,
    ws: ws,
    general: general,
    member: member,
    bot: bot
  } do
    register_over_wire!(bot, ws)

    # The native palette reflects the registered rows faithfully: names,
    # definitions, the owning application — the pick list the composer
    # renders.
    commands = palette!(member, ws)
    assert MapSet.new(Enum.map(commands, & &1["name"])) == MapSet.new(["ask", "invite"])

    assert Enum.all?(commands, &(&1["application_id"] == Integer.to_string(bot.user_id)))
    ask = command_of(commands, "ask")
    assert ask["description"] == "Ask the workspace agent"
    assert ask["options"] == @ask_def["options"]

    # The application's compat session — the bot that will receive the
    # interaction and answer it.
    bot_session = connect!(port, v: 10)
    bot_identify!(bot_session, bot.token)
    drain!(bot_session)

    # THE PICK: a member invokes the palette command on a channel they can
    # speak in.
    pick = pick(member, ask, general, %{"question" => "What is this place?"})

    # EMIT-BEFORE-ACK: the interaction reaches the bot's session BEFORE the
    # REST 202 — assert the frame first.
    frame = next_json!(bot_session, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    assert frame["op"] == 0

    d = frame["d"]
    assert d["type"] == 2
    assert d["application_id"] == Integer.to_string(bot.user_id)
    assert d["data"]["name"] == "ask"
    assert d["data"]["options"] == [%{"name" => "question", "value" => "What is this place?"}]
    assert d["channel_id"] == Integer.to_string(general.channel_id)
    assert d["member"]["user"]["id"] == Integer.to_string(member.user_id)
    assert is_binary(d["id"]) and d["id"] != ""
    assert is_binary(d["token"]) and d["token"] != ""

    assert pick.status == 202
    assert Jason.decode!(pick.resp_body)["interaction_id"] == d["id"]

    # THE ANSWER: the bot posts its reply through the callback route with
    # the frame's credential and no auth header.
    cb = answer(d["id"], d["token"], "This is #{ws.name}.")
    # 579ed8f (discord.py leg): typed callbacks answer 200 WITH the
    # envelope (data.interaction.id) — 204 only for followups now.
    assert cb.status == 200
    assert %{"interaction" => %{"id" => _}} = Jason.decode!(cb.resp_body)

    # THE REPLY EXISTS: one message in the channel, BOT attribution.
    assert [%{author_id: author_id, channel_id: channel_id, content: content}] =
             Messages.history(general.channel_id, limit: 1)

    assert author_id == bot.user_id
    assert channel_id == general.channel_id
    assert content == "This is #{ws.name}."
  end

  # ---------------------------------------------------------------------------
  # The invocation-side gates on the same wire
  # ---------------------------------------------------------------------------

  test "an `invite` pick: plain member is 403 with no mint; the owner's pick completes the loop", %{
    port: port,
    ws: ws,
    general: general,
    owner: owner,
    member: member,
    bot: bot
  } do
    register_over_wire!(bot, ws)
    commands = palette!(owner, ws)
    invite = command_of(commands, "invite")

    bot_session = connect!(port, v: 10)
    bot_identify!(bot_session, bot.token)
    drain!(bot_session)

    # The plain member holds the @everyone base (view + send): the pick
    # passes the send right and dies on the workspace authority — 403
    # "forbidden", message naming the command authority, and NO credential
    # minted (a dead pick never reaches any session).
    before = TokenStore.count()

    refused = pick(member, invite, general, %{})
    assert refused.status == 403
    body = Jason.decode!(refused.resp_body)
    assert body["error"]["key"] == "forbidden"
    assert body["error"]["message"] == "You do not have permission to use that command."
    assert TokenStore.count() == before

    # The owner holds manage_workspace: the pick mints, the bot answers,
    # the reply lands — the gated command is usable by the authority it
    # demands, end to end.
    granted = pick(owner, invite, general, %{})
    assert granted.status == 202

    frame = next_json!(bot_session, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    d = frame["d"]
    assert d["data"]["name"] == "invite"
    assert d["member"]["user"]["id"] == Integer.to_string(owner.user_id)

    cb = answer(d["id"], d["token"], "Here is an invite.")
    # 579ed8f (discord.py leg): typed callbacks answer 200 WITH the
    # envelope (data.interaction.id) — 204 only for followups now.
    assert cb.status == 200
    assert %{"interaction" => %{"id" => _}} = Jason.decode!(cb.resp_body)

    assert [%{author_id: author_id, content: "Here is an invite."}] =
             Messages.history(general.channel_id, limit: 1)

    assert author_id == bot.user_id
  end

  test "any pick demands the channel send right — the @-mention parity", %{
    ws: ws,
    general: general,
    locked: locked,
    member: member,
    bot: bot
  } do
    register_over_wire!(bot, ws)
    commands = palette!(member, ws)
    ask = command_of(commands, "ask")

    # The member can pick in `general` (mint lands)…
    assert pick(member, ask, general, %{}).status == 202

    # …and the SAME command in a channel their send is denied in is 403 —
    # invoking asks no more (and no less) than speaking there.
    Workspaces.put_overwrite(locked.channel_id, :member, member.user_id, 0, Bitfield.bit(:send_messages))
    refused = pick(member, ask, locked, %{})

    assert refused.status == 403
    assert Jason.decode!(refused.resp_body)["error"]["key"] == "forbidden"
  end
end
