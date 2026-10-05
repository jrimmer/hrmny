defmodule CytaleWeb.GatewayWireContractTest do
  @moduledoc """
  #61 + #63 — the compat wire contract, asserted FROM THE CLIENT'S SIDE.

  Every assertion here is written against what a real Discord client library
  does and expects, never by importing the server's own codec: the harness
  inflates with `:zlib.inflateInit(z, 15)` (Discord's zlib stream), sends the
  frame TYPE discord.py sends, and reads the roster values discord.py
  documents as impossible-to-be-absent. That matters because the server-side
  mirror of these assertions is structurally blind to them — a client that
  shares the encoder's code agrees with it by construction — which is how
  raw-DEFLATE transport (#61 item 3) and an opcode-dropping `handle_in`
  (#61 item 4) both shipped green.
  """

  use Cytale.GatewayCase, async: false

  import Bitwise
  import Phoenix.ConnTest

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # GUILDS | GUILD_MESSAGES: a message-reading bot that deliberately does NOT
  # request MESSAGE_CONTENT (1<<15) — the #63 direction pin.
  @without_message_content bor(bsl(1, 0), bsl(1, 9))

  @all_supported_intents CytaleWeb.GatewaySocket.supported_intents()

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

    {:ok, parent} = User.create(run_unique("wc_parent"), run_unique("wc_parent@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(parent.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("wc-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(parent.user_id, :bot, run_unique("Wire Contract Bot"))

    {:ok, port: port, parent: parent, ws: ws, general: general, bot: bot}
  end

  # A compat Identify exactly as a library sends it: the Discord envelope
  # with its own version field, intents, and an explicit `compress: null`.
  defp bot_identify!(conn, token, intents \\ @all_supported_intents) do
    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => 10,
        "intents" => intents,
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.py", "$device" => "discord.py"}
      }
    )
  end

  # GUILD_CREATE follows READY on the compat handshake; consume the frames
  # until it arrives.
  defp await_guild_create!(conn, timeout \\ 5_000) do
    case next_frame(conn, timeout) do
      {:ok, %{"t" => "GUILD_CREATE", "d" => d}} -> d
      other -> flunk("expected GUILD_CREATE, got: #{inspect(other)}")
    end
  end

  # A message through the REAL native payload shape (what the REST seam
  # publishes), so the compat translation runs end to end.
  defp deliver_message!(channel_id, author_id, content) do
    {:ok, msg} = Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: content})
    payload = CytaleWeb.MessageController.message_json(msg)
    {msg, Workspaces.FanOut.deliver(channel_id, {"MessageCreate", payload})}
  end

  # ---------------------------------------------------------------------------
  # #61 item 3 — the transport stream is a ZLIB stream
  # ---------------------------------------------------------------------------

  describe "?compress=zlib-stream transport" do
    test "Hello and every server frame decode through a ZLIB-format inflater",
         %{port: port, bot: bot, parent: parent, general: general} do
      # The harness's transport inflater is `:zlib.inflateInit(z, 15)` — a
      # zlib stream, which is what discord.py's `zlib.decompressobj()` and
      # Node's `zlib.createInflate()` are. Raw DEFLATE (the wire before this
      # fix) fails the handshake right here with `incorrect header check`,
      # which is the failure real clients swallowed into a silent hang.
      conn = connect!(port, transport_compress: true)

      assert conn.hello["op"] == 10
      # ...and the whole wire is binary (no text frame carries server data).
      assert Cytale.Test.WSClient.frame_counts(conn.pid) == %{text: 0, binary: 1}

      assert is_binary(bot_identify!(conn, bot.token)["session_id"])
      _guild = await_guild_create!(conn)

      {_msg, targets} = deliver_message!(general.channel_id, parent.user_id, "zlib stream ping")
      assert targets >= 1

      assert {:ok, %{"t" => "MESSAGE_CREATE"}} = next_frame(conn, 5_000)
      assert Cytale.Test.WSClient.frame_counts(conn.pid).text == 0
    end
  end

  # ---------------------------------------------------------------------------
  # #61 item 4 — the frame opcode decides decoding
  # ---------------------------------------------------------------------------

  describe "inbound frames on a compressed transport" do
    test "a plain TEXT Identify completes the handshake", %{port: port, bot: bot} do
      # The whole of item 4: discord.py sends Identify as a plain TEXT frame
      # on a `?compress=zlib-stream` connection (it has no outbound
      # compressor). Dropping the opcode fed that frame to the transport
      # inflater and closed the socket 4001 before auth ever ran.
      conn = connect!(port, transport_compress: true)
      ready = bot_identify!(conn, bot.token)
      assert is_binary(ready["session_id"])
    end

    test "a junk-token TEXT Identify reaches AUTH (4004), not the decoder (4001)", %{port: port} do
      conn = connect!(port, transport_compress: true)
      send_frame!(conn, 2, %{"token" => invalid_token(), "v" => 10, "intents" => @all_supported_intents})

      # 4004 is auth-failed: proof the frame DECODED and was judged, rather
      # than being mangled by the inflater (4001 = decode error).
      assert assert_closed!(conn, 5_000) == 4004
    end

    test "a BINARY member of the transport stream is still inflated", %{port: port, bot: bot} do
      conn = connect!(port, transport_compress: true)
      ready = bot_identify!(conn, bot.token)
      assert is_binary(ready["session_id"])

      # No shipped library compresses outbound, but the wire accepts it: a
      # zlib member of the shared stream must behave like any other frame.
      send_transport_binary!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
    end
  end

  # ---------------------------------------------------------------------------
  # #63 — the roster bootstrap
  # ---------------------------------------------------------------------------

  describe "GUILD_CREATE roster (#63)" do
    test "carries the self member, one @everyone role, and an integer member_count",
         %{port: port, bot: bot, ws: ws, parent: parent} do
      conn = connect!(port)
      ready = bot_identify!(conn, bot.token)
      guild = await_guild_create!(conn)

      assert is_binary(ready["session_id"])
      assert guild["id"] == Integer.to_string(ws.workspace_id)

      # discord.py resolves `guild.default_role` through an unguarded
      # `get_role(guild.id)` and documents the @everyone role as always
      # present.
      assert [role] = guild["roles"]
      assert role["id"] == guild["id"]
      assert role["name"] == "@everyone"

      # ...and `guild.me` through an unguarded `get_member(self_id)`,
      # commented "the self member is ALWAYS cached" — an empty roster makes
      # every `guild.me.guild_permissions` check raise AttributeError.
      self_member = Enum.find(guild["members"], &(&1["user"]["id"] == Integer.to_string(bot.user_id)))
      assert self_member, "the connecting bot must be in members (guild.me)"
      assert self_member["user"]["bot"] == true
      assert self_member["roles"] == [guild["id"]]
      assert self_member["flags"] == 0

      # SPIRIT (not just the #63 floor): the roster is the REAL member set.
      # The fixture's workspace has the parent human as its owner, and the
      # bot rides in as a principal of that parent — a client can enumerate
      # both, not just itself.
      member_ids = Enum.map(guild["members"], & &1["user"]["id"])
      assert Integer.to_string(parent.user_id) in member_ids
      assert length(member_ids) == guild["member_count"]
      assert Enum.all?(guild["members"], &is_binary(&1["user"]["username"]))

      # `member_count` must be an int (None breaks `len(members) < count`).
      assert is_integer(guild["member_count"])
      assert guild["large"] == false
    end

    test "presences carry the live members (the bootstrap is not an empty list)",
         %{port: port, bot: bot} do
      conn = connect!(port)
      assert is_binary(bot_identify!(conn, bot.token)["session_id"])
      guild = await_guild_create!(conn)

      # Discord sends one presence per member whose status it knows;
      # `Guild._from_data` matches them against members by `user.id`. The
      # session itself is live, so its presence is in the snapshot.
      assert [presence] = guild["presences"]
      assert %{"id" => id} = presence["user"]
      assert is_binary(id)

      # The three keys `RawPresenceUpdateEvent` indexes unguarded.
      assert presence["status"] in ["online", "idle", "dnd", "offline"]
      assert presence["activities"] == []
      assert %{"desktop" => status} = presence["client_status"]
      assert status == presence["status"]
    end

    test "a MESSAGE_CONTENT-less session still receives message content (#63 direction pin)",
         %{port: port, bot: bot, parent: parent, general: general} do
      # The PERMISSIVE direction is deliberate and now pinned: Cytale accepts
      # `1<<15` as a known bit and never gates on it. Discord's gate is an
      # organization-level privileged-intent approval that a self-hosted
      # workspace has no analog for, the workspace membership + restrictions
      # profile is the real privacy boundary here, and the REST surface
      # delivers `content` to the same principal regardless of intents — so
      # gating the gateway alone would be theatre. See compat.md's ledger.
      conn = connect!(port)
      assert is_binary(bot_identify!(conn, bot.token, @without_message_content)["session_id"])
      _guild = await_guild_create!(conn)

      {msg, targets} = deliver_message!(general.channel_id, parent.user_id, "content without the intent")
      assert targets >= 1

      assert {:ok, %{"t" => "MESSAGE_CREATE", "d" => d}} = next_frame(conn, 5_000)
      assert d["id"] == Integer.to_string(msg.id)
      assert d["content"] == "content without the intent"
    end
  end
end
