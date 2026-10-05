defmodule CytaleWeb.GatewayInteractionTest do
  @moduledoc """
  U8 (bots plan) — INTERACTION_CREATE gateway delivery over the real wire:
  a bot's compat session receives the interaction (Discord-shaped payload
  carrying the callback token) when a human invokes via the native REST
  endpoint, with the emit-then-verify ordering pin (the ws frame is asserted
  BEFORE the REST response status), and the callback's message lands back on
  the same session as MESSAGE_CREATE with bot attribution.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Interactions
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | GUILD_MESSAGE_TYPING (1<<11) —
  # wired to the socket's ONE definition so a bitmask change moves with it.
  @all_supported_intents CytaleWeb.GatewaySocket.supported_intents()

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  setup do
    port = start_gateway!()

    {:ok, owner} = User.create(run_unique("u8w_owner"), run_unique("u8w_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u8w-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Slash Bot"))

    {:ok, [command]} =
      Interactions.upsert_commands(
        ws.workspace_id,
        bot.user_id,
        [
          %{"name" => "echo", "description" => "Echo text"}
        ],
        :replace
      )

    owner_token = Auth.issue_access_token(owner.user_id, owner.username, true)

    {:ok, port: port, ws: ws, general: general, bot: bot, command: command, owner: owner, owner_token: owner_token}
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

  # Drain join-time dispatches (GUILD_CREATE etc.) so assertions start from a
  # deterministic mailbox.
  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 250) do
      {:text, _json} -> drain!(conn)
      {:closed, _code} -> :ok
      {:error, :timeout} -> :ok
    end
  end

  defp invoke(owner_token, command, channel, options) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> owner_token)
    |> post("/api/v1/interactions", %{
      "command_id" => Integer.to_string(command.command_id),
      "channel_id" => Integer.to_string(channel.channel_id),
      "options" => options
    })
  end

  defp callback(interaction_id, token, content) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> post("/api/v10/interactions/#{interaction_id}/#{token}/callback", %{
      "type" => 4,
      "data" => %{"content" => content}
    })
  end

  test "human invoke → bot session observes INTERACTION_CREATE → callback message lands", %{
    port: port,
    ws: ws,
    general: general,
    bot: bot,
    command: command,
    owner_token: owner_token
  } do
    conn = connect!(port, v: 10)
    bot_identify!(conn, bot.token, @all_supported_intents)
    drain!(conn)

    conn_rest = invoke(owner_token, command, general, %{"text" => "hi"})

    # EMIT-THEN-VERIFY: the interaction was fanned out BEFORE the REST
    # response — assert the ws frame first, the REST status after.
    frame = next_json!(conn, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    assert frame["op"] == 0
    assert is_integer(frame["s"]) and frame["s"] >= 1

    d = frame["d"]
    assert d["application_id"] == Integer.to_string(bot.user_id)
    assert d["type"] == 2
    assert d["data"]["name"] == "echo"
    assert is_binary(d["data"]["id"])
    assert d["data"]["options"] == [%{"name" => "text", "value" => "hi"}]
    assert d["guild_id"] == Integer.to_string(ws.workspace_id)
    assert d["channel_id"] == Integer.to_string(general.channel_id)
    assert d["member"]["user"]["id"] != nil
    # #73: the invoking member is the ONE member shape — a client builds a
    # Member from it and indexes `roles` unguarded.
    assert d["member"]["roles"] == [Integer.to_string(ws.workspace_id)]
    assert is_binary(d["token"]) and d["token"] != ""
    assert d["version"] == 1

    # B7b: the three discord.js-14.27-critical fields (previously pinned only
    # by compat:check — a regression must fail mix test too). data.type must
    # be the CHAT_INPUT literal 1; entitlements.reduce and
    # AuthorizingIntegrationOwners run UNCONDITIONALLY in the library's
    # constructor, so both must always ride (guild-install form: "0" => ws).
    assert d["data"]["type"] == 1
    assert d["entitlements"] == []
    assert d["authorizing_integration_owners"] == %{"0" => Integer.to_string(ws.workspace_id)}

    assert conn_rest.status == 202
    assert Jason.decode!(conn_rest.resp_body)["interaction_id"] == d["id"]

    # The Discord-library flow: POST the callback with the ws-received token,
    # NO Authorization header.
    cb = callback(d["id"], d["token"], "pong")
    # 579ed8f (discord.py leg): typed callbacks answer 200 WITH the
    # envelope (data.interaction.id) — 204 only for followups now.
    assert cb.status == 200
    assert %{"interaction" => %{"id" => _}} = Jason.decode!(cb.resp_body)

    # The message landed with bot attribution (hermetic check through the
    # store — the Publish seam is the Log impl under :test, so socket-side
    # MESSAGE_CREATE delivery is exercised by the fan-out suites).
    assert [%{author_id: author_id, content: "pong"}] =
             Cytale.Messages.history(general.channel_id, limit: 1)

    assert author_id == bot.user_id
  end

  test "INTERACTION_CREATE is application-addressed: delivered even with intents 0", %{
    port: port,
    general: general,
    bot: bot,
    command: command,
    owner_token: owner_token
  } do
    # A lifecycle-only session (intents 0 subscribes to nothing today) still
    # receives its own application's interactions — the documented divergence
    # from the intents ⊗ visible-set filter (docs/protocol/compat.md).
    conn = connect!(port, v: 10)
    bot_identify!(conn, bot.token, 0)
    drain!(conn)

    conn_rest = invoke(owner_token, command, general, %{})

    frame = next_json!(conn, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    assert frame["d"]["data"]["name"] == "echo"
    assert conn_rest.status == 202
  end

  # ---------------------------------------------------------------------------
  # Component clicks (components plan U2, R3/R4) — INTERACTION_CREATE type 3
  # ---------------------------------------------------------------------------

  defp button_row(ids),
    do: %{
      "type" => 1,
      "components" => Enum.map(ids, &%{"type" => 2, "style" => 1, "label" => "B#{&1}", "custom_id" => &1})
    }

  defp select_row(id) do
    %{
      "type" => 1,
      "components" => [
        %{
          "type" => 3,
          "custom_id" => id,
          "options" => [
            %{"label" => "One", "value" => "one"},
            %{"label" => "Two", "value" => "two"}
          ]
        }
      ]
    }
  end

  defp card!(channel_id, author_id, components) do
    {:ok, msg} =
      Cytale.Messages.create_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "card",
        thread_id: nil,
        components: components
      })

    msg
  end

  defp click(owner_token, message, custom_id, component_type \\ 2, values \\ nil) do
    body = %{
      "channel_id" => Integer.to_string(message.channel_id),
      "message_id" => Integer.to_string(message.id),
      "custom_id" => custom_id,
      "component_type" => component_type
    }

    body = if is_nil(values), do: body, else: Map.put(body, "values", values)

    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> owner_token)
    |> post("/api/v1/interactions", body)
  end

  test "human click → bot session observes INTERACTION_CREATE type 3 (the discord.js pins verbatim)",
       %{port: port, ws: ws, general: general, bot: bot, owner_token: owner_token} do
    conn = connect!(port, v: 10)
    bot_identify!(conn, bot.token, @all_supported_intents)
    drain!(conn)

    rows = [button_row(["approve", "deny"])]
    msg = card!(general.channel_id, bot.user_id, rows)

    conn_rest = click(owner_token, msg, "approve")

    # EMIT-THEN-VERIFY: the ws frame is asserted BEFORE the REST response.
    frame = next_json!(conn, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    assert frame["op"] == 0

    d = frame["d"]
    assert d["type"] == 3
    assert d["application_id"] == Integer.to_string(bot.user_id)
    assert d["data"]["custom_id"] == "approve"
    assert d["data"]["component_type"] == 2
    refute Map.has_key?(d["data"], "values")
    assert d["guild_id"] == Integer.to_string(ws.workspace_id)
    assert d["channel_id"] == Integer.to_string(general.channel_id)
    assert is_binary(d["token"]) and d["token"] != ""
    assert d["version"] == 1

    # d.message is REQUIRED for type 3 (discord.js constructs a Message from
    # it): the FULL object round-trips — id/channel_id/components from the
    # stored row, the author as the bot user object.
    m = d["message"]
    assert m["id"] == Integer.to_string(msg.id)
    assert m["channel_id"] == Integer.to_string(general.channel_id)
    assert m["components"] == rows
    assert m["author"]["id"] == Integer.to_string(bot.user_id)
    assert m["author"]["bot"] == true
    assert m["content"] == "card"

    # member (workspace shape) carries the CLICKER.
    assert d["member"]["user"]["id"] == Integer.to_string(ws.owner_id)
    refute Map.has_key?(d, "user")

    # The three discord.js-14.27 unconditional-dereference pins, verbatim:
    # entitlements.reduce and AuthorizingIntegrationOwners indexing run on
    # EVERY interaction incl. type 3.
    assert d["entitlements"] == []
    assert d["authorizing_integration_owners"] == %{"0" => Integer.to_string(ws.workspace_id)}

    # app_permissions: the agent's resolved bitfield as a DECIMAL STRING, in
    # DISCORD's bit layout (#173). The ceiling for a machine principal is its
    # grant — a full read_write grant under the owner parent — so the
    # manage/moderation bits are never present.
    alias CytaleWeb.Compat.Permissions, as: CompatPerms

    assert d["app_permissions"] ==
             Integer.to_string(CompatPerms.to_discord(Cytale.Access.bits(:read_write)))

    app = String.to_integer(d["app_permissions"])
    assert Bitwise.band(app, CompatPerms.discord_bit(:send_messages)) != 0
    assert Bitwise.band(app, CompatPerms.discord_bit(:view_channel)) != 0
    assert Bitwise.band(app, CompatPerms.discord_bit(:administrator)) == 0
    assert Bitwise.band(app, CompatPerms.discord_bit(:manage_channels)) == 0

    assert d["attachment_size_limit"] == 26_214_400

    # NO optional d.channel (the silent-drop hazard — KTD3).
    refute Map.has_key?(d, "channel")

    assert conn_rest.status == 202
    assert Jason.decode!(conn_rest.resp_body)["interaction_id"] == d["id"]
  end

  test "DM click → user-shaped payload (no member, no guild_id, %{\"1\" => clicker} AIO)", %{
    port: port,
    bot: bot,
    owner: owner,
    owner_token: owner_token
  } do
    {:ok, dm} = Workspaces.open_dm(owner.user_id, bot.user_id)
    msg = card!(dm.channel_id, bot.user_id, [select_row("model")])

    conn = connect!(port, v: 10)
    bot_identify!(conn, bot.token, @all_supported_intents)
    drain!(conn)

    conn_rest = click(owner_token, msg, "model", 3, ["one"])

    frame = next_json!(conn, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"

    d = frame["d"]
    assert d["type"] == 3
    assert d["data"]["component_type"] == 3
    assert d["data"]["custom_id"] == "model"
    assert d["data"]["values"] == ["one"]
    assert d["channel_id"] == Integer.to_string(dm.channel_id)

    # The DM shape (KTD3): `user` NOT `member`, NO guild_id, the user-install
    # AIO key carrying the clicker.
    assert d["user"]["id"] == Integer.to_string(owner.user_id)
    refute Map.has_key?(d, "member")
    refute Map.has_key?(d, "guild_id")
    assert d["authorizing_integration_owners"] == %{"1" => Integer.to_string(owner.user_id)}

    # The embedded message rides the DM channel; entitlements still pinned.
    assert d["message"]["id"] == Integer.to_string(msg.id)
    assert d["message"]["channel_id"] == Integer.to_string(dm.channel_id)
    assert d["entitlements"] == []

    assert conn_rest.status == 202
  end

  # Application-addressed delivery bypasses the visibility filter on resume
  # replay too (the shipped event-name-keyed contract) — pinned here against
  # the NEW payload shape.
  test "resume replay delivers the buffered type-3 (application-addressed bypass)", %{
    port: port,
    general: general,
    bot: bot,
    owner_token: owner_token
  } do
    conn = connect!(port, v: 10)
    ready = bot_identify!(conn, bot.token, @all_supported_intents)
    guild = next_json!(conn, 5_000)
    assert guild["t"] == "GUILD_CREATE"
    assert guild["s"] == 1

    msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
    conn_rest = click(owner_token, msg, "approve")
    assert conn_rest.status == 202

    # The interaction was buffered (s: 2) but NOT read; the link drops and the
    # session resumes acknowledging only seq 1.
    send_close!(conn, 1000)
    wait_disconnected!(ready["session_id"])

    conn2 = connect!(port, v: 10)

    send_frame!(conn2, 5, %{
      "token" => bot.token,
      "session_id" => ready["session_id"],
      "seq" => 1,
      "resume_token" => resume_token_of(ready["session_id"])
    })

    resumed = next_json!(conn2, 5_000)
    assert resumed["t"] == "RESUMED"

    replay = next_json!(conn2, 5_000)
    assert replay["t"] == "INTERACTION_CREATE"
    assert replay["s"] == 2
    assert replay["d"]["type"] == 3
    assert replay["d"]["data"]["custom_id"] == "approve"
    assert replay["d"]["message"]["id"] == Integer.to_string(msg.id)
  end

  # ---------------------------------------------------------------------------
  # U3 e2e — the approval-card story in ONE test (components plan U3): the
  # bot posts a card, a human clicks (U2), the bot resolves with a type-7
  # callback (U3), and BOTH a subscribed NATIVE human session and the bot's
  # own compat session observe the flip — MessageUpdate / MESSAGE_UPDATE
  # carrying the new disabled row (R2's critical live-flip pin).
  # ---------------------------------------------------------------------------

  test "click → type-7 → live viewers see the card flip (native + compat sessions)", %{
    port: port,
    ws: ws,
    general: general,
    bot: bot,
    owner: owner,
    owner_token: owner_token
  } do
    # The REAL fan-out path for this test (the webhook_wire pattern —
    # config/test.exs pins the Log impl by default; restored in on_exit).
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      if original == nil,
        do: Application.delete_env(:cytale, Cytale.Publish),
        else: Application.put_env(:cytale, Cytale.Publish, original)
    end)

    # A native human viewer: a Stub identity, bootstrapped then joined as a
    # workspace member (join routes bind at READY, so join BEFORE the real
    # observing session identifies).
    viewer_token = "cytale_u3e_" <> run_unique("viewer")
    boot = connect!(port)
    boot_ready = identify!(boot, viewer_token)
    viewer_id = String.to_integer(boot_ready["user"]["id"])
    :ok = Workspaces.add_member(ws.workspace_id, viewer_id, owner.user_id)
    send_close!(boot, 1000)

    # The native viewer session (identified BEFORE the bot's final drain:
    # its presence announce reaches the bot asynchronously, so the bot's
    # mailbox is quieted last).
    viewer = connect!(port)
    identify!(viewer, viewer_token)
    drain!(viewer)

    # The bot's compat session (v10 arrival path).
    bot_conn = connect!(port, v: 10)
    bot_identify!(bot_conn, bot.token, @all_supported_intents)
    Process.sleep(150)
    drain!(bot_conn)
    # The bot's own presence announce reached the viewer asynchronously —
    # quiet its mailbox too so the first assertion frame is the flip.
    Process.sleep(100)
    drain!(viewer)

    # The card.
    rows = [button_row(["approve", "deny"])]
    msg = card!(general.channel_id, bot.user_id, rows)

    # U2: the click (the bot's session receives the type-3 first —
    # emit-before-ack).
    conn_rest = click(owner_token, msg, "approve")

    frame = next_json!(bot_conn, 5_000)
    assert frame["t"] == "INTERACTION_CREATE"
    d = frame["d"]
    assert d["type"] == 3
    assert d["token"] != nil
    assert conn_rest.status == 202

    # U3: the type-7 resolution — the URL token is the credential (no auth
    # header), the disabled row replaces the card.
    resolved = [
      %{
        "type" => 1,
        "components" => [
          %{"type" => 2, "style" => 2, "label" => "Resolved", "custom_id" => "approve", "disabled" => true}
        ]
      }
    ]

    cb =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> post("/api/v10/interactions/#{d["id"]}/#{d["token"]}/callback", %{
        "type" => 7,
        "data" => %{"components" => resolved}
      })

    # 579ed8f (discord.py leg): typed callbacks answer 200 WITH the
    # envelope (data.interaction.id) — 204 only for followups now.
    assert cb.status == 200
    assert %{"interaction" => %{"id" => _}} = Jason.decode!(cb.resp_body)

    # The compat session sees the translated MESSAGE_UPDATE.
    update = next_json!(bot_conn, 5_000)
    assert update["t"] == "MESSAGE_UPDATE"

    compat_d = update["d"]
    assert compat_d["id"] == Integer.to_string(msg.id)
    assert compat_d["components"] == resolved
    assert compat_d["edited_timestamp"] != nil
    assert compat_d["author"]["id"] == Integer.to_string(bot.user_id)

    # The subscribed NATIVE human session observes MessageUpdate carrying
    # the new row — the critical R2 pin (the flip without a reload).
    native = next_json!(viewer, 5_000)
    assert native["t"] == "MessageUpdate"

    native_d = native["d"]
    assert native_d["id"] == Integer.to_string(msg.id)
    assert native_d["components"] == resolved
    assert native_d["edited_at"] != nil
  end

  defp resume_token_of(session_id) do
    case Cytale.Gateway.SessionStore.get(session_id) do
      %Cytale.Gateway.Session{} = s -> s.resume_token
      nil -> flunk("no stored session #{session_id}")
    end
  end

  defp wait_disconnected!(session_id, tries \\ 100) do
    if match?(%{phase: :disconnected}, Cytale.Gateway.SessionStore.get(session_id)) do
      :ok
    else
      if tries > 1 do
        Process.sleep(20)
        wait_disconnected!(session_id, tries - 1)
      else
        flunk("session never disconnected")
      end
    end
  end
end
