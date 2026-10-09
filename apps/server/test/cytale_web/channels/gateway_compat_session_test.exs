defmodule CytaleWeb.GatewayCompatSessionTest do
  @moduledoc """
  U7 (bots plan) — `cytbot_` gateway sessions speaking Discord (KTD5), over
  the real Bandit wire:

    * session mode keyed on credential type: cytbot_ → compat dialect
      (Discord READY + synthesized GUILD_CREATE per workspace, SCREAMING
      dispatch names, Discord payload shapes via the shared compat codec,
      `guild_id` on channel/message objects), `cytale_` → native unchanged;
    * the Identify version gate runs AFTER token verification and is keyed
      on the same credential type (bot sessions accept v=10 + the interop
      v=1, native keeps v=1); Hello echoes the connection URL's version;
    * the visibility/security core (intents ⊗ visible-set, epoch narrowing,
      join propagation, resume-replay consistency) lives here too — the
      over-delivery triples are this unit's security core (R9).
  """

  use Cytale.GatewayCase, async: false

  import Bitwise
  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # GUILDS (1<<0) | GUILD_MESSAGES (1<<9) | GUILD_MESSAGE_TYPING (1<<11) —
  # wired to the socket's ONE definition so a bitmask change moves with it.
  @all_supported_intents CytaleWeb.GatewaySocket.supported_intents()

  # Collision-proof fixture nonce: unique WITHIN a run (monotonic unique)
  # and ACROSS runs (wall clock) — the persistent test keyspace keeps rows
  # from previous runs (the B-U3 documented flake source).

  # The workspace a compat test's agent was granted: the parent owns it, and the
  # tests seed exactly one.
  defp ws_id(_agent), do: Process.get(:compat_ws_id)

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

    {:ok, parent} = User.create(run_unique("u7_parent"), run_unique("u7_parent@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(parent.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("u7-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, random} = Workspaces.create_channel(ws.workspace_id, "random")
    {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Wire Agent"))
    Process.put(:compat_ws_id, ws.workspace_id)

    %{
      port: port,
      parent: parent,
      ws: ws,
      general: general,
      random: random,
      agent: agent
    }
  end

  # -- helpers -------------------------------------------------------------------

  defp bot_identify!(conn, token, intents \\ @all_supported_intents, v \\ 10) do
    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => v,
        "intents" => intents,
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.js", "$device" => "discord.js"}
      }
    )
  end

  # Drain join-time dispatches (announces; dropped for compat sessions but
  # drain anyway so assertions start from a deterministic mailbox).
  defp drain!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # A REAL message row through the REAL native projection + fan-out seam —
  # exactly what a REST post delivers in production.
  defp post_message!(channel_id, author_id, content) do
    {:ok, msg} =
      Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: content})

    payload = CytaleWeb.MessageController.message_json(msg)
    {msg, Cytale.Workspaces.FanOut.deliver(channel_id, {"MessageCreate", payload})}
  end

  # A reaction event through the REAL native payload shape — exactly what
  # the reaction REST seam publishes (channel-keyed, decimal-string ids).
  defp deliver_reaction!(channel_id, user_id, event, emoji) do
    {:ok, msg} =
      Messages.create_message(%{channel_id: channel_id, author_id: user_id, content: "reaction anchor"})

    payload = CytaleWeb.ReactionController.reaction_payload(channel_id, msg.id, user_id, emoji)
    {payload, Cytale.Workspaces.FanOut.deliver(channel_id, {event, payload})}
  end

  defp issue_access(user), do: Auth.issue_access_token(user.user_id, user.username, true)

  # A thread reply through the REAL native payload shape (the hot path's
  # thread-scoped ThreadMessageCreate leg of the dual emission).
  defp deliver_thread_reply(channel_id, thread_id, author_id, content) do
    {:ok, msg} =
      Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: content, thread_id: thread_id})

    {msg,
     Cytale.Workspaces.FanOut.deliver(
       channel_id,
       {"ThreadMessageCreate", CytaleWeb.MessageController.message_json(msg)}
     )}
  end

  # Consume replayed GUILD_CREATEs until the buffered THREAD envelope (the
  # MESSAGE_CREATE carrying the thread's channel id) arrives — the replay
  # order is seq order, guilds first.
  defp await_replayed_thread!(conn, thread_id) do
    case next_frame(conn, 5_000) do
      {:ok, %{"t" => "GUILD_CREATE"}} ->
        await_replayed_thread!(conn, thread_id)

      {:ok, %{"t" => "MESSAGE_CREATE", "d" => %{"channel_id" => channel_id}} = frame} ->
        if channel_id == Integer.to_string(thread_id),
          do: frame,
          else: flunk("unexpected replayed MESSAGE_CREATE on #{channel_id}")

      other ->
        flunk("expected the thread envelope replay, got: #{inspect(other)}")
    end
  end

  # Consume replayed GUILD_CREATEs (one per visible workspace) until the
  # wire goes quiet; flunk if anything OTHER than a GUILD_CREATE arrives —
  # the caller asserts the interesting silence afterwards. B-3 growth:
  # buffered PRESENCE_UPDATEs (a member's announce that landed while the
  # link was down) replay too on GUILD_PRESENCES — tolerate them here; the
  # per-event assertions below still pin exactly what they care about.
  defp assert_drained_guild_creates!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 300) do
      {:text, json} ->
        case Jason.decode!(json) do
          %{"t" => "GUILD_CREATE"} -> assert_drained_guild_creates!(conn)
          %{"t" => "PRESENCE_UPDATE"} -> assert_drained_guild_creates!(conn)
          other -> flunk("expected only GUILD_CREATE replays, got: #{inspect(other)}")
        end

      {:binary, _json} ->
        flunk("binary frame on an uncompressed compat session")

      {:closed, _code} ->
        :ok

      {:error, :timeout} ->
        :ok
    end
  end

  defp wait_until(fun, tries \\ 50)
  defp wait_until(_fun, 0), do: flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.(), do: :ok, else: Process.sleep(20) && wait_until(fun, tries - 1)
  end

  defp lookup(sid) do
    case Cytale.Gateway.SessionStore.get(sid) do
      %Session{} = s -> {:ok, s}
      nil -> {:error, :not_found}
    end
  end

  # ---------------------------------------------------------------------------
  # Compat handshake: Discord READY + GUILD_CREATE
  # ---------------------------------------------------------------------------

  describe "compat READY + GUILD_CREATE" do
    test "Identify(v10, intents, $os properties) → Discord READY then GUILD_CREATE carrying channels",
         %{port: port, ws: ws, general: general, agent: agent} do
      conn = connect!(port, v: 10)

      # Hello echoes the URL-requested version (KTD5: compat clients arrive
      # via /gateway/bot's ?v=10 URL).
      assert conn.hello["d"]["v"] == 10

      ready = bot_identify!(conn, agent.token)

      assert ready["v"] == 10
      assert ready["user"]["id"] == Integer.to_string(agent.user_id)
      assert ready["user"]["bot"] == true
      assert ready["user"]["discriminator"] == "0"
      # The identity username is the credential's TAG (unique per server);
      # global_name mirrors it on the Discord shape.
      assert ready["user"]["global_name"] == agent.username
      assert ready["user"]["username"] == agent.username
      assert is_binary(ready["session_id"]) and ready["session_id"] != ""
      # Cytale extension on the Discord shape: the Resume secret rides here
      # (compat RESUMED replays depend on it).
      assert is_binary(ready["resume_token"]) and ready["resume_token"] != ""
      # A10: the resume URL is a WEBSOCKET url (http request → ws scheme),
      # built by the SAME shared builder /gateway/bot serves.
      assert ready["resume_gateway_url"] =~ ~r{^ws://}
      assert ready["resume_gateway_url"] =~ ~r{/gateway/websocket\?v=10&encoding=json$}
      assert ready["application"]["id"] == Integer.to_string(agent.user_id)
      # #112: the READY application advertises Message Content entitlement.
      assert ready["application"]["flags"] == 262_144
      assert ready["guilds"] == [%{"id" => Integer.to_string(ws.workspace_id), "unavailable" => true}]

      guild = next_json!(conn, 5_000)
      assert guild["t"] == "GUILD_CREATE"
      assert guild["s"] == 1
      assert guild["d"]["id"] == Integer.to_string(ws.workspace_id)
      assert guild["d"]["name"] == ws.name
      assert guild["d"]["owner_id"] == Integer.to_string(ws.owner_id)
      assert guild["d"]["unavailable"] == false

      channel_ids = guild["d"]["channels"] |> Enum.map(& &1["id"]) |> MapSet.new()
      assert MapSet.new([Integer.to_string(general.channel_id)]) |> MapSet.subset?(channel_ids)

      general_ch = Enum.find(guild["d"]["channels"], &(&1["id"] == Integer.to_string(general.channel_id)))
      assert general_ch["name"] == "general"
      assert general_ch["type"] == 0
      assert general_ch["guild_id"] == Integer.to_string(ws.workspace_id)

      # The mode + intents ride the stored record (resume round-trip).
      assert {:ok, %Session{mode: :compat, intents: @all_supported_intents}} = lookup(ready["session_id"])
    end

    test "GUILD_CREATE consumes seqs and replays on Resume", %{
      port: port,
      agent: agent
    } do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      guild = next_json!(conn, 5_000)
      assert guild["s"] == 1

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      conn2 = connect!(port, v: 10)

      send_frame!(conn2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => resume_token_of(ready)
      })

      resumed = next_json!(conn2, 5_000)
      assert resumed["t"] == "RESUMED"
      assert resumed["s"] == 0

      replay = next_json!(conn2, 5_000)
      assert replay["t"] == "GUILD_CREATE"
      assert replay["s"] == 1
    end

    # The native READY's resume_token key does not exist on the compat READY
    # (Discord shape) — dig it off the stored record instead.
    defp resume_token_of(ready) do
      {:ok, %Session{} = stored} = lookup(ready["session_id"])
      stored.resume_token
    end
  end

  # ---------------------------------------------------------------------------
  # Version gate (post-auth, keyed on credential type)
  # ---------------------------------------------------------------------------

  describe "version gate" do
    test "cytbot_ Identify with v=1 rides the interop window", %{port: port, agent: agent} do
      conn = connect!(port)
      ready = bot_identify!(conn, agent.token, @all_supported_intents, 1)
      assert is_binary(ready["session_id"])
      assert ready["v"] == 10
    end

    test "cytbot_ Identify with an absent v is accepted (Discord libraries carry it in the URL)",
         %{port: port, agent: agent} do
      conn = connect!(port, v: 10)

      identify!(conn, agent.token,
        raw_d: %{
          "token" => agent.token,
          "intents" => @all_supported_intents,
          "compress" => nil,
          "properties" => %{"os" => "linux", "browser" => "discord.js", "device" => "discord.js"}
        }
      )

      # (READY already asserted; reaching here means the handshake accepted.)
    end

    test "cytbot_ Identify with v=99 → close 4012", %{port: port, agent: agent} do
      conn = connect!(port)

      send_frame!(conn, 2, %{
        "token" => agent.token,
        "v" => 99,
        "intents" => 0,
        "compress" => nil,
        "properties" => %{"os" => "linux", "browser" => "x", "device" => "x"}
      })

      code = assert_closed!(conn, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4012
    end
  end

  # ---------------------------------------------------------------------------
  # Dispatch translation (SCREAMING names + Discord payloads via the codec)
  # ---------------------------------------------------------------------------

  describe "dispatch translation" do
    test "MessageCreate arrives as MESSAGE_CREATE with a Discord message object incl. guild_id",
         %{port: port, ws: ws, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {msg, targets} = post_message!(general.channel_id, parent.user_id, "hello from the human")
      assert targets >= 1

      dispatch = next_json!(conn, 5_000)
      assert dispatch["op"] == 0
      assert dispatch["t"] == "MESSAGE_CREATE"
      assert dispatch["s"] == 2

      d = dispatch["d"]
      assert d["id"] == Integer.to_string(msg.id)
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["content"] == "hello from the human"
      # The HUMAN author resolves through the codec (no bot flag, discriminator 0).
      assert d["author"]["id"] == Integer.to_string(parent.user_id)
      assert d["author"]["bot"] == nil
      assert d["author"]["discriminator"] == "0"
      assert d["mentions"] == []
      assert d["embeds"] == []
      assert d["type"] == 0
      assert String.ends_with?(d["timestamp"], "Z") or d["timestamp"] != nil
    end

    test "bot-authored MessageCreate renders the machine author with bot: true",
         %{port: port, general: general, agent: agent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_msg, _} = post_message!(general.channel_id, agent.user_id, "agent writes")

      d = next_json!(conn, 5_000)["d"]
      assert d["author"]["id"] == Integer.to_string(agent.user_id)
      assert d["author"]["bot"] == true
      # The message author object resolves through the shared codec, which
      # serves the machine principal's LABEL (the tag lives on @me/READY).
      # The author object carries the tag (one handle everywhere).
      assert d["author"]["username"] == agent.username
    end

    test "TypingStart arrives as TYPING_START with guild_id", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "TypingStart",
        %{
          "channel_id" => Integer.to_string(general.channel_id),
          # A THIRD PARTY typing: the actor's own typing is NOT echoed back to
          # it (#77, Discord's rule) — see the exclusion test in the op-20
          # describe below.
          "user_id" => Integer.to_string(parent.user_id),
          # A13: the native payload carries epoch MILLISECONDS; the compat
          # wire carries SECONDS (discord.js multiplies by 1000).
          "timestamp" => 1_792_022_401_234
        }
      })

      d = next_json!(conn, 5_000)["d"]
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["user_id"] == Integer.to_string(parent.user_id)
      assert d["timestamp"] == 1_792_022_401
    end

    test "ChannelCreate arrives as CHANNEL_CREATE with a Discord channel object",
         %{port: port, ws: ws, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "fresh-#{run_nonce()}", created_by: parent.user_id)

      # The REST create path bumps the epoch BEFORE its fan-out (the
      # visibility memo must recompute to admit the new channel) — mirror it.
      Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)

      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.workspace_key(Integer.to_string(ws.workspace_id)),
        {"ChannelCreate",
         %{
           "id" => Integer.to_string(ch.channel_id),
           "workspace_id" => ws.workspace_id,
           "name" => ch.name,
           "position" => ch.position,
           "created_at" => DateTime.to_iso8601(ch.created_at)
         }}
      )

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == Integer.to_string(ch.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["name"] == ch.name
      assert d["type"] == 0
    end

    test "MessageDelete arrives as MESSAGE_DELETE", %{port: port, ws: ws, general: general, agent: agent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "MessageDelete",
        %{"id" => "999", "channel_id" => general.channel_id, "thread_id" => nil}
      })

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == "999"
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
    end

    # B7a: the six dispatch translations that had zero coverage — each pins
    # the LIVE translation shape incl. guild_id (the anchor-resolved owning
    # workspace), following the MESSAGE_DELETE pattern above.

    test "MessageUpdate arrives as MESSAGE_UPDATE with the full message object", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {msg, _} = post_message!(general.channel_id, parent.user_id, "before edit")
      # Consume the create's MESSAGE_CREATE first (the socket is subscribed).
      assert next_json!(conn, 5_000)["t"] == "MESSAGE_CREATE"

      :ok = Messages.edit_message(general.channel_id, msg.id, "after edit")
      updated = Messages.get_message(general.channel_id, msg.id)

      Cytale.Workspaces.FanOut.deliver(
        general.channel_id,
        {"MessageUpdate", CytaleWeb.MessageController.message_json(updated)}
      )

      dispatch = next_json!(conn, 5_000)
      assert dispatch["t"] == "MESSAGE_UPDATE"

      d = dispatch["d"]
      assert d["id"] == Integer.to_string(msg.id)
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["content"] == "after edit"
      assert d["edited_timestamp"] != nil
      assert d["author"]["id"] == Integer.to_string(parent.user_id)
    end

    test "ChannelUpdate arrives as CHANNEL_UPDATE with the channel object", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # The channel_controller PATCH flow: the row updates FIRST, then the
      # fan-out (the translation re-reads the row for the channel object).
      :ok = Workspaces.update_channel(general.channel_id, %{name: "renamed", topic: "the topic"})

      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(general.channel_id)),
        {"ChannelUpdate",
         %{
           "id" => Integer.to_string(general.channel_id),
           "name" => "renamed",
           "topic" => "the topic",
           "position" => 0
         }}
      )

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["name"] == "renamed"
      assert d["type"] == 0
    end

    test "ThreadCreate arrives as THREAD_CREATE (type 11, parent_id, guild_id)", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "launch-thread", parent.user_id)

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "ThreadCreate",
        %{
          "id" => Integer.to_string(thread.thread_id),
          "channel_id" => general.channel_id,
          "name" => thread.name,
          "created_by" => parent.user_id,
          "created_at" => DateTime.to_iso8601(thread.created_at)
        }
      })

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == Integer.to_string(thread.thread_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["parent_id"] == Integer.to_string(general.channel_id)
      assert d["name"] == "launch-thread"
      assert d["type"] == 11
      assert d["owner_id"] == Integer.to_string(parent.user_id)
    end

    test "ThreadUpdate arrives as THREAD_UPDATE (thread-row anchor resolves parent + guild)", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "archiving-soon", parent.user_id)

      # The Events.thread_update payload carries NO channel_id — the anchor
      # resolves through the thread row (thread_parent fallback).
      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "ThreadUpdate",
        %{"id" => Integer.to_string(thread.thread_id), "name" => "archived-name", "archived" => true}
      })

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == Integer.to_string(thread.thread_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["parent_id"] == Integer.to_string(general.channel_id)
      assert d["name"] == "archived-name"
      assert d["type"] == 11

      # The update reports its own change in the ONLY place the shared shape
      # carries `archived` (#69: a top-level key here is exactly the field-set
      # divergence the ticket closed).
      assert d["thread_metadata"]["archived"] == true

      # #71: `newly_created` belongs to the CREATE event alone — an update is
      # not a creation, and Discord's THREAD_UPDATE has no such field.
      refute Map.has_key?(d, "newly_created")

      # ...and reports it on a COMPLETE object: the row fills everything the
      # payload does not state, so an update cannot hand a client the thin
      # shape that killed its gateway task.
      for key <- ["owner_id", "message_count", "member_count", "thread_metadata"] do
        assert Map.has_key?(d, key), "THREAD_UPDATE is missing #{key}"
      end

      assert is_integer(d["message_count"])
      assert is_binary(d["owner_id"])
    end

    test "ThreadDelete arrives as THREAD_DELETE (id, guild_id, parent_id)", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "doomed-thread", parent.user_id)

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "ThreadDelete",
        %{"id" => Integer.to_string(thread.thread_id), "channel_id" => general.channel_id}
      })

      d = next_json!(conn, 5_000)["d"]
      assert d["id"] == Integer.to_string(thread.thread_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["parent_id"] == Integer.to_string(general.channel_id)
    end

    test "ThreadMessageCreate arrives as MESSAGE_CREATE ON the thread channel", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "reply-thread", parent.user_id)

      {msg, targets} = deliver_thread_reply(general.channel_id, thread.thread_id, parent.user_id, "a thread reply")
      assert targets >= 1

      # The thread was made after Identify without a THREAD_CREATE, so the
      # session first hears about it (2026-10-08 Hermes fix).
      announced = next_json!(conn, 5_000)
      assert announced["t"] == "THREAD_CREATE"
      assert announced["d"]["id"] == Integer.to_string(thread.thread_id)

      dispatch = next_json!(conn, 5_000)
      assert dispatch["t"] == "MESSAGE_CREATE"

      d = dispatch["d"]
      assert d["id"] == Integer.to_string(msg.id)
      # The message rides the THREAD channel id, not the parent's.
      assert d["channel_id"] == Integer.to_string(thread.thread_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["content"] == "a thread reply"
      assert d["author"]["id"] == Integer.to_string(parent.user_id)
    end

    test "heartbeats + RESUMED cycle intact on a compat session", %{port: port, agent: agent} do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      conn2 = connect!(port, v: 10)
      {:ok, %Session{} = stored} = lookup(ready["session_id"])

      send_frame!(conn2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => stored.seq,
        "resume_token" => stored.resume_token
      })

      resumed = next_json!(conn2, 5_000)
      assert resumed["t"] == "RESUMED"
      # Nothing buffered past the acked seq — heartbeats still flow.
      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)
    end
  end

  # ---------------------------------------------------------------------------
  # Visibility security core (R9 — written RED-FIRST: these pin that a
  # compat session never receives events outside parent∩restrictions, live
  # OR on resume replay, and that rights changes propagate without reconnect)
  # ---------------------------------------------------------------------------

  describe "visibility triple (security core)" do
    setup %{port: port, parent: parent, ws: ws, general: general, random: random} do
      # A SECOND member-owned workspace arrangement: owner owns the ws,
      # `parent` is a plain member, and the agent rides the parent. Overwrite
      # + kick mutations below act on the member — the owner path is
      # exempt-proof by design.
      {:ok, scoped} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Scoped Agent"), %{
          actions: ["read"],
          channels: [Integer.to_string(general.channel_id)]
        })

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, scoped.token)
      drain!(conn)

      %{
        conn: conn,
        ready: ready,
        scoped: scoped,
        general_id: general.channel_id,
        random_id: random.channel_id
      }
    end

    test "GUILD_CREATE carries ONLY in-profile channels", %{
      port: port,
      parent: parent,
      general: general,
      random: random
    } do
      # Fresh restricted session (the setup one already drained its guild).
      {:ok, scoped} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Scoped2"), %{
          actions: ["read"],
          channels: [Integer.to_string(general.channel_id)]
        })

      conn = connect!(port, v: 10)
      bot_identify!(conn, scoped.token)

      guild = next_json!(conn, 5_000)
      ids = guild["d"]["channels"] |> Enum.map(& &1["id"])
      assert Integer.to_string(general.channel_id) in ids
      refute Integer.to_string(random.channel_id) in ids
    end

    test "in-profile channel events arrive; out-of-profile events NEVER (live)", %{
      conn: conn,
      parent: parent,
      general_id: general_id,
      random_id: random_id
    } do
      {_, targets} = post_message!(general_id, parent.user_id, "in profile")
      assert targets >= 1
      assert next_json!(conn, 5_000)["d"]["content"] == "in profile"

      {_, _} = post_message!(random_id, parent.user_id, "out of profile")

      # Silence: nothing else arrives (heartbeat round-trip proves liveness
      # while no dispatch landed).
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end

    test "typing on an out-of-profile channel is dropped identically", %{
      conn: conn,
      random_id: random_id,
      scoped: scoped
    } do
      Cytale.Workspaces.FanOut.deliver(random_id, {
        "TypingStart",
        %{
          "channel_id" => Integer.to_string(random_id),
          "user_id" => Integer.to_string(scoped.user_id),
          "timestamp" => 1
        }
      })

      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end
  end

  describe "epoch narrowing without reconnect (member parent)" do
    setup %{parent: parent} do
      # A workspace the setup-parent does NOT own: a fresh owner + member
      # arrangement so role/overwrite/kick mutations bite the parent.
      {:ok, owner} = User.create(run_unique("u7_owner"), run_unique("u7_owner@example.com"), "password-123")
      {:ok, raw, _hash} = Auth.issue_single_use_token(owner.user_id, "verify_email")
      :ok = Verification.complete_email_verification(raw)
      access = issue_access(owner)

      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u7-ws2"))
      {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
      {:ok, random} = Workspaces.create_channel(ws.workspace_id, "random")
      :ok = Workspaces.add_member(ws.workspace_id, parent.user_id, owner.user_id)

      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Member Agent"))

      port = start_gateway!()
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      drain!(conn)

      %{
        port: port,
        conn: conn,
        ready: ready,
        agent: agent,
        owner: owner,
        owner_access: access,
        ws: ws,
        general: general,
        random: random,
        parent: parent
      }
    end

    test "parent loses a role-view mid-session → epoch bump → next dispatch narrows WITHOUT reconnect",
         %{conn: conn, parent: parent, general: general, random: random} do
      # Baseline: both channels visible (plain member, @everyone base).
      {_, _} = post_message!(general.channel_id, parent.user_id, "visible")
      assert next_json!(conn, 5_000)["d"]["content"] == "visible"

      # Narrow: member overwrite deny view on `random` for the parent (a
      # rights mutation — the same path the REST overwrite route drives).
      deny = Bitfield.bit(:view_channel) ||| Bitfield.bit(:send_messages)
      Workspaces.put_overwrite(random.channel_id, :member, parent.user_id, 0, deny)

      Cytale.Permissions.RightsEpoch.bump(random.workspace_id)

      # The SAME live session (no reconnect) narrows: `random` events drop,
      # `general` keeps flowing.
      {_, _} = post_message!(random.channel_id, parent.user_id, "now hidden")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)

      {_, _} = post_message!(general.channel_id, parent.user_id, "still visible")
      assert next_json!(conn, 5_000)["d"]["content"] == "still visible"
    end

    test "resume replay is filtered-consistent (buffered event on a channel that narrowed while down)",
         %{port: port, parent: parent, random: random} do
      # UNRESTRICTED member agent: sees both channels live; buffer an event
      # on `random`; narrow the parent via a member overwrite deny while the
      # link is DOWN; resume must NOT replay the buffered event.
      {:ok, plain} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Plain Agent"))

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, plain.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {msg, _} = post_message!(random.channel_id, parent.user_id, "buffered before narrowing")
      assert next_json!(conn, 5_000)["d"]["content"] == "buffered before narrowing"

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      # Narrow the parent while the session is down: member overwrite DENY
      # view_channel on `random` for the parent (rights mutation → epoch bump).
      deny = Bitfield.bit(:view_channel) ||| Bitfield.bit(:send_messages)
      Workspaces.put_overwrite(random.channel_id, :member, parent.user_id, 0, deny)

      Cytale.Permissions.RightsEpoch.bump(Workspaces.get_channel(random.channel_id).workspace_id)

      conn2 = connect!(port, v: 10)
      {:ok, %Session{} = stored} = lookup(ready["session_id"])

      send_frame!(conn2, 5, %{
        "token" => plain.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      resumed = next_json!(conn2, 5_000)
      assert resumed["t"] == "RESUMED"

      # GUILD_CREATE replays still flow (the workspaces themselves stay
      # visible — the parent belongs to both the owner ws and this ws2);
      # the buffered `random` MESSAGE does NOT.
      assert_drained_guild_creates!(conn2)

      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)

      # The property under test is the BUFFERED MESSAGE, not wire silence — and
      # the two windows above say so: `assert_drained_guild_creates!` already
      # tolerates PRESENCE_UPDATEs, because a resume legitimately emits presence
      # snapshots for the workspace's other live users. Demanding absolute
      # silence in THIS window flaked whenever one landed a beat later than the
      # drain, which is a scheduling race, not a filtering defect.
      refute_next_event!(conn2, "MESSAGE_CREATE", 400)
      # (msg referenced for clarity: the row whose dispatch is absent)
      _ = msg
    end

    test "parent kicked → that workspace's keys stop delivering (live session, no reconnect)",
         %{conn: conn, parent: parent, ws: ws, general: general} do
      {_, _} = post_message!(general.channel_id, parent.user_id, "before kick")
      assert next_json!(conn, 5_000)["d"]["content"] == "before kick"

      :ok = Workspaces.remove_member(ws.workspace_id, parent.user_id)
      Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)

      {_, _} = post_message!(general.channel_id, parent.user_id, "after kick")

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end
  end

  describe "join propagation (KTD4 consumer clause)" do
    setup %{parent: parent} do
      {:ok, owner} = User.create(run_unique("u7_jowner"), run_unique("u7_jowner@example.com"), "password-123")
      {:ok, raw, _hash} = Auth.issue_single_use_token(owner.user_id, "verify_email")
      :ok = Verification.complete_email_verification(raw)
      access = issue_access(owner)

      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u7-ws3"))
      {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "joined-later")

      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Joining Agent"))

      port = start_gateway!()
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      drain!(conn)

      %{
        port: port,
        conn: conn,
        agent: agent,
        owner: owner,
        owner_access: access,
        ws: ws,
        channel: channel,
        parent: parent
      }
    end

    test "parent joins a workspace mid-session → live agent's subscriptions grow without reconnect",
         %{conn: conn, owner: owner, owner_access: owner_access, ws: ws, channel: channel, parent: parent} do
      # Before the join: the workspace's events do not reach the agent.
      {_, _} = post_message!(channel.channel_id, owner.user_id, "not yet joined")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)

      # The parent joins through the REAL production path (invite accept):
      # bump + principal-route refresh are the invite controller's clauses.
      conn_owner =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> owner_access)

      invite =
        Phoenix.ConnTest.post(conn_owner, "/api/v1/workspaces/#{ws.workspace_id}/invites", %{})

      code = Jason.decode!(invite.resp_body)["invite"]["code"]

      parent_access = issue_access(parent)

      conn_parent =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> parent_access)

      Phoenix.ConnTest.post(conn_parent, "/api/v1/invites/#{code}", %{})

      # The poke lands asynchronously: the socket re-runs its join
      # computation and re-subscribes the new workspace's channel routes.
      # The registry IS the rendezvous — wait for the channel route to
      # name this socket before firing the event.
      ch_key = Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(channel.channel_id))

      wait_until(fn ->
        Cytale.Gateway.PushRegistry.subscribers(ch_key) != []
      end)

      # Same live session: the new workspace's events now arrive.
      {_, _} = post_message!(channel.channel_id, owner.user_id, "after join")
      assert next_json!(conn, 5_000)["d"]["content"] == "after join"
    end
  end

  describe "intents edges" do
    test "unknown intent bit (1<<26) → close 4013 (terminal)", %{port: port, agent: agent} do
      conn = connect!(port, v: 10)

      send_frame!(conn, 2, %{
        "token" => agent.token,
        "v" => 10,
        "intents" => Bitwise.bsl(1, 26),
        "compress" => nil,
        "properties" => %{"os" => "linux", "browser" => "x", "device" => "x"}
      })

      code = assert_closed!(conn, 5_000)
      assert code == 4013
    end

    test "negative intents → close 4013", %{port: port, agent: agent} do
      conn = connect!(port, v: 10)

      send_frame!(conn, 2, %{
        "token" => agent.token,
        "v" => 10,
        "intents" => -1,
        "compress" => nil,
        "properties" => %{"os" => "linux", "browser" => "x", "device" => "x"}
      })

      assert assert_closed!(conn, 5_000) == 4013
    end

    test "non-integer intents → close 4001 decode error", %{port: port, agent: agent} do
      conn = connect!(port, v: 10)

      send_frame!(conn, 2, %{
        "token" => agent.token,
        "v" => 10,
        "intents" => "many",
        "compress" => nil,
        "properties" => %{"os" => "linux", "browser" => "x", "device" => "x"}
      })

      assert assert_closed!(conn, 5_000) == 4001
    end

    test "intents = 0 → connects, lifecycle only", %{port: port, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token, 0)
      assert is_binary(ready["session_id"])
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_, _} = post_message!(general.channel_id, parent.user_id, "not delivered")

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end

    test "known-but-unsupported intent (GUILD_MEMBERS 1<<1) connects and delivers nothing",
         %{port: port, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token, Bitwise.bsl(1, 1))
      assert is_binary(ready["session_id"])
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_, _} = post_message!(general.channel_id, parent.user_id, "silent")

      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end

    test "partial intents: GUILD_MESSAGES without TYPING delivers messages but not typing",
         %{port: port, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token, Bitwise.bsl(1, 9))
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "TypingStart",
        %{"channel_id" => Integer.to_string(general.channel_id), "user_id" => "1", "timestamp" => 1}
      })

      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)

      {_, _} = post_message!(general.channel_id, parent.user_id, "messages only")
      assert next_json!(conn, 5_000)["t"] == "MESSAGE_CREATE"
    end

    test "partial intents: GUILD_MESSAGES without GUILD_MESSAGE_REACTIONS (1<<10) delivers messages but not reactions",
         %{port: port, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token, Bitwise.bsl(1, 9))
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_, _} =
        deliver_reaction!(general.channel_id, parent.user_id, "MessageReactionAdd", "👍")

      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)

      {_, _} = post_message!(general.channel_id, parent.user_id, "messages still flow")
      assert next_json!(conn, 5_000)["t"] == "MESSAGE_CREATE"
    end

    test "post-only agent connects (allow-silent) and receives no read events",
         %{port: port, parent: parent, general: general, random: random} do
      # The old "post-only" case (write without read) is NOT expressible in the
      # access model: `:read_write` implies `:read`. The equivalent edge is an
      # agent with NO grant at all — it connects, and sees nothing.
      {:ok, poster} = Principals.mint(parent.user_id, :agent, run_unique("Poster"))

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, poster.token)
      assert is_binary(ready["session_id"])
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # Zero granted channels → zero GUILD_CREATE channels carried.
      assert _guild["d"]["channels"] == []

      {_, _} = post_message!(general.channel_id, parent.user_id, "unreadable")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
      _ = random
    end
  end

  # ---------------------------------------------------------------------------
  # Reaction events (Discord dialect, GUILD_MESSAGE_REACTIONS 1<<10): the
  # payload shapes the REST seam emits, translated over the real listener —
  # MESSAGE_REACTION_ADD (with member.user) / MESSAGE_REACTION_REMOVE /
  # MESSAGE_REACTION_REMOVE_ALL, gated on the intent bit.
  # ---------------------------------------------------------------------------

  describe "reaction events (intent bit 1<<10 + Discord translation)" do
    test "ADD carries member.user + the null-id emoji object; REMOVE drops member; REMOVE_ALL is identity-only",
         %{port: port, ws: ws, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token, @all_supported_intents)
      guild = next_json!(conn, 5_000)["d"]
      drain!(conn)

      {:ok, msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "react wire"})

      add_payload = CytaleWeb.ReactionController.reaction_payload(general.channel_id, msg.id, parent.user_id, "👍")
      remove_payload = CytaleWeb.ReactionController.reaction_payload(general.channel_id, msg.id, parent.user_id, "👍")

      # ADD: Discord's shape with member.user for the reacting human.
      Cytale.Workspaces.FanOut.deliver(general.channel_id, {"MessageReactionAdd", add_payload})

      add = next_json!(conn, 5_000)
      assert add["t"] == "MESSAGE_REACTION_ADD"

      d = add["d"]
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["message_id"] == Integer.to_string(msg.id)
      assert d["user_id"] == Integer.to_string(parent.user_id)
      assert d["emoji"] == %{"id" => nil, "name" => "👍"}
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["member"]["user"]["id"] == Integer.to_string(parent.user_id)
      refute Map.has_key?(d["member"]["user"], "bot")

      # #72: `type` is indexed unguarded by discord.py's
      # `RawReactionActionEvent`, so a missing one killed the client's gateway
      # task — and a bot that acks with a reaction disconnected itself on every
      # inbound message. 0 = NORMAL; the burst variant is not ours to send.
      assert d["type"] == 0

      # #73: the `member` is the ONE member shape, and `roles` is the field a
      # client indexes unguarded when it builds a Member from it. The ticket's
      # durable guard is parity with the roster (the same class has landed three
      # times now: roster member #63, thread object #69, reaction member here),
      # so compare against the roster entry for the same user instead of
      # asserting presence alone.
      member = d["member"]
      assert member["roles"] == [Integer.to_string(ws.workspace_id)]
      roster_member = Enum.find(guild["members"], &(&1["user"]["id"] == Integer.to_string(parent.user_id)))
      assert roster_member, "the reactor rides the roster, so parity is checkable"
      assert member |> Map.keys() |> Enum.sort() == roster_member |> Map.keys() |> Enum.sort()
      assert member["user"] == roster_member["user"]

      # REMOVE: same shape minus member.
      Cytale.Workspaces.FanOut.deliver(general.channel_id, {"MessageReactionRemove", remove_payload})

      remove = next_json!(conn, 5_000)
      assert remove["t"] == "MESSAGE_REACTION_REMOVE"
      assert remove["d"]["emoji"] == %{"id" => nil, "name" => "👍"}
      assert remove["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert remove["d"]["type"] == 0
      refute Map.has_key?(remove["d"], "member")

      # REMOVE_ALL: identity fields only.
      Cytale.Workspaces.FanOut.deliver(
        general.channel_id,
        {"MessageReactionRemoveAll", CytaleWeb.ReactionController.remove_all_payload(general.channel_id, msg.id)}
      )

      all = next_json!(conn, 5_000)
      assert all["t"] == "MESSAGE_REACTION_REMOVE_ALL"

      assert all["d"] == %{
               "channel_id" => Integer.to_string(general.channel_id),
               "message_id" => Integer.to_string(msg.id),
               "guild_id" => Integer.to_string(ws.workspace_id)
             }
    end

    test "a reaction on an out-of-profile channel never reaches the wire (fail closed)",
         %{port: port, general: general, random: random, agent: agent, parent: parent} do
      {:ok, scoped} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Scoped Reactor Wire"), %{
          actions: ["read", "post"],
          channels: [Integer.to_string(general.channel_id)]
        })

      conn = connect!(port, v: 10)
      bot_identify!(conn, scoped.token, @all_supported_intents)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_, _} = deliver_reaction!(random.channel_id, parent.user_id, "MessageReactionAdd", "👍")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end

    test "the intents = 0 lifecycle-only session receives no reaction events either",
         %{port: port, general: general, agent: agent, parent: parent} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token, 0)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {_, _} = deliver_reaction!(general.channel_id, parent.user_id, "MessageReactionAdd", "👍")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn.pid, 400)
    end
  end

  # ---------------------------------------------------------------------------
  # Client typing gate (A9): the op-20 fan-out consults the resolver per
  # signal; out-of-profile channels are silently dropped, never an oracle.
  # ---------------------------------------------------------------------------

  describe "client typing gate (op 20, resolver consult)" do
    test "in-profile typing fans out as TYPING_START with epoch-SECONDS timestamps; out-of-profile is silently dropped",
         %{port: port, ws: ws, general: general, random: random, parent: parent} do
      # A restricted SENDER (allowlist: general only) and an unrestricted
      # OBSERVER both hold live compat sessions on the same channel routes.
      {:ok, scoped} =
        AgentGrants.mint_all(parent.user_id, :agent, run_unique("Scoped Typing"), %{
          actions: ["read", "post"],
          channels: [Integer.to_string(general.channel_id)]
        })

      {:ok, observer} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Typing Observer"))

      sender = connect!(port, v: 10)
      bot_identify!(sender, scoped.token)
      _guild = next_json!(sender, 5_000)
      drain!(sender)

      obs = connect!(port, v: 10)
      bot_identify!(obs, observer.token)
      _obs_guild = next_json!(obs, 5_000)
      drain!(obs)

      # In-profile: the observer receives the translated TYPING_START…
      send_frame!(sender, 20, %{
        "channel_id" => Integer.to_string(general.channel_id),
        "thread_id" => nil
      })

      frame = next_json!(obs, 5_000)
      assert frame["t"] == "TYPING_START"

      d = frame["d"]
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["user_id"] == Integer.to_string(scoped.user_id)

      # …with Discord's timestamp unit: epoch SECONDS (discord.js multiplies
      # by 1000; the native event carries milliseconds — the codec converts).
      assert_in_delta d["timestamp"], System.system_time(:second), 5

      # #77: …and NOT back to the user who is typing, not even their own
      # session (a typing indicator is for other people). The observer above
      # proves the event itself fans out, so this is the exclusion, not a
      # delivery failure.
      #
      # The drain comes BEFORE the typing frame below: draining after it would
      # swallow the very frame under test and make this assertion pass on
      # nothing (which it did, once).
      drain!(sender)

      # The sender types again — and its own session still receives nothing.
      send_frame!(sender, 20, %{
        "channel_id" => Integer.to_string(general.channel_id),
        "thread_id" => nil
      })

      assert {:error, :timeout} == Cytale.Test.WSClient.recv(sender.pid, 400)

      # Out-of-profile: the restricted sender signals on `random` — nothing
      # fans out and the sender's link stays alive (silent drop, no oracle).
      #
      # The observer is drained FIRST: the repeat above is only throttled while
      # the ~900 ms window holds, so a loaded run can let a SECOND in-profile
      # TYPING_START through — and leaving it queued would make the assertion
      # below pass or fail on scheduling rather than on the out-of-profile drop.
      drain!(obs)

      send_frame!(sender, 20, %{"channel_id" => Integer.to_string(random.channel_id)})
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(obs.pid, 400)

      send_frame!(sender, 1, nil)
      assert next_op!(sender, 11, 5_000)
    end
  end

  # ---------------------------------------------------------------------------
  # Compat push crash isolation (A4): a raising translate+buffer is dropped
  # for the compat session only — logged, counted, never a socket crash; a
  # native sibling is untouched (no translation, no reads on that path).
  # ---------------------------------------------------------------------------

  describe "compat push crash isolation" do
    test "a raising translation is dropped + counted; compat and native sockets survive",
         %{port: port, general: general, parent: parent, agent: agent, ws: ws} do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # A native (human-dialect) sibling on the same listener — and, because
      # #51 gates native delivery on VIEW of the anchor channel, a MEMBER of
      # the workspace owning `general`: the sibling has to be a legitimate
      # recipient for the payload below to reach it at all. (Its identity is
      # the Stub authenticator's phash2 mapping.)
      native_uid = :erlang.phash2(valid_token(), 900_000) + 100_000
      :ok = Workspaces.add_member(ws.workspace_id, native_uid, parent.user_id, [])

      native = connect!(port)
      native_ready = identify!(native, valid_token())

      :telemetry.attach(
        "compat-push-error-test",
        [:cytale, :gateway, :compat_push_error],
        fn _event, _measurements, _metadata, pid -> send(pid, :push_error) end,
        self()
      )

      # The poison: a valid anchor (general IS visible) but a degenerate
      # attachments list whose non-map entry makes the shared codec raise
      # (FunctionClauseError in MessageCodec.attachment/2).
      poison = {
        "MessageCreate",
        %{
          "id" => "1",
          "channel_id" => Integer.to_string(general.channel_id),
          "author_id" => Integer.to_string(parent.user_id),
          "content" => "poison",
          "attachments" => ["not-a-map"]
        }
      }

      compat_pid =
        Cytale.Gateway.PushRegistry.user_key(Integer.to_string(agent.user_id))
        |> Cytale.Gateway.PushRegistry.subscribers()
        |> List.first()
        |> then(fn {pid, _uid} -> pid end)

      native_pid =
        Cytale.Gateway.PushRegistry.user_key(native_ready["user"]["id"])
        |> Cytale.Gateway.PushRegistry.subscribers()
        |> List.first()
        |> then(fn {pid, _uid} -> pid end)

      send(compat_pid, {:cytale_gateway_push, self(), poison})
      send(native_pid, {:cytale_gateway_push, self(), poison})

      # The compat failure is observable (telemetry counter)…
      assert_receive :push_error, 3_000

      # …and the compat session survives with the event DROPPED (fail
      # closed — heartbeat round-trip proves the live link; the poison's
      # MessageCreate never arriving proves the non-delivery. Interleaved
      # presence/other dispatches are legal and skipped).
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      refute_next_event!(conn, "MessageCreate", 400)

      # The native sibling is unaffected by the compat failure: the SAME
      # payload passes through verbatim (no translation) and its link lives.
      frame = next_event!(native, "MessageCreate", 5_000)
      assert frame["d"]["attachments"] == ["not-a-map"]

      send_frame!(native, 1, nil)
      assert next_op!(native, 11, 5_000)
    after
      :telemetry.detach("compat-push-error-test")
    end
  end

  # ---------------------------------------------------------------------------
  # Replay re-filter anchors (A3): the buffered envelopes below arrive only
  # when CURRENT visibility admits their anchor — MESSAGE_UPDATE on its
  # channel, thread envelopes on the PARENT channel — and unknown buffered
  # shapes fail CLOSED (dropped), never replayed on trust.
  # ---------------------------------------------------------------------------

  describe "replay re-filter anchors" do
    setup %{parent: parent} do
      # A member-parent arrangement: owner owns the ws, `parent` is a plain
      # member, the agent rides the parent (narrowing/kick acts on the member).
      {:ok, owner} = User.create(run_unique("a3_owner"), run_unique("a3_owner@example.com"), "password-123")
      {:ok, raw, _hash} = Auth.issue_single_use_token(owner.user_id, "verify_email")
      :ok = Verification.complete_email_verification(raw)

      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("a3-ws"))
      {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
      {:ok, random} = Workspaces.create_channel(ws.workspace_id, "random")
      :ok = Workspaces.add_member(ws.workspace_id, parent.user_id, owner.user_id)

      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("Replay Agent"))

      {:ok, %{ws: ws, general: general, random: random, agent: agent, parent: parent, owner: owner}}
    end

    test "buffered MESSAGE_UPDATE replayed to a kicked session is dropped",
         %{port: port, general: general, agent: agent, parent: parent, ws: ws} do
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # A REAL message + a REAL MessageUpdate through the fan-out seam — both
      # delivered live AND buffered for replay.
      {msg, _} = post_message!(general.channel_id, parent.user_id, "to be edited")
      assert next_json!(conn, 5_000)["d"]["content"] == "to be edited"

      updated = Map.merge(msg, %{content: "edited", edited_at: DateTime.utc_now()})

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "MessageUpdate",
        CytaleWeb.MessageController.message_json(updated)
      })

      assert next_json!(conn, 5_000)["d"]["content"] == "edited"

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      # Kick the parent while the link is down: the workspace's keys stop
      # admitting the agent entirely.
      :ok = Workspaces.remove_member(ws.workspace_id, parent.user_id)
      Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)

      conn2 = connect!(port, v: 10)
      {:ok, %Session{} = stored} = lookup(ready["session_id"])

      send_frame!(conn2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      assert next_json!(conn2, 5_000)["t"] == "RESUMED"

      # The parent still OWNS the outer setup's ws (the kick only removed
      # the a3-ws membership), so that workspace's GUILD_CREATE legitimately
      # replays — but NOTHING else: not the a3-ws guild, not the buffered
      # MESSAGE_CREATE/MESSAGE_UPDATE (both anchored on the kicked-out ws).
      assert_drained_guild_creates!(conn2)

      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn2.pid, 400)
    end

    test "buffered thread message replays when in-profile; drops when the parent channel narrowed",
         %{port: port, general: general, agent: agent, parent: parent, ws: ws} do
      # Seed a parent message + a real thread on `general`.
      {parent_msg, _} = post_message!(general.channel_id, parent.user_id, "thread root")

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, run_unique("replay-thread"), parent.user_id)

      # IN-PROFILE direction — buffer a thread reply, drop, resume WITHOUT
      # narrowing: the buffered envelope replays (its channel_id is the
      # THREAD id; the re-filter resolves the PARENT channel for the test).
      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {replay, _} = deliver_thread_reply(general.channel_id, thread.thread_id, parent.user_id, "thread reply")

      live = next_json!(conn, 5_000)
      assert live["t"] == "MESSAGE_CREATE"
      assert live["d"]["channel_id"] == Integer.to_string(thread.thread_id)
      assert live["d"]["id"] == Integer.to_string(replay.id)

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      conn2 = connect!(port, v: 10)
      {:ok, %Session{} = stored} = lookup(ready["session_id"])

      send_frame!(conn2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      assert next_json!(conn2, 5_000)["t"] == "RESUMED"

      # Guild replays flow for every still-visible workspace (the parent
      # also owns the outer setup's ws); the buffered THREAD envelope
      # replays after them — its channel_id is the THREAD id, admitted by
      # resolving the PARENT channel for the membership test.
      replayed = await_replayed_thread!(conn2, thread.thread_id)
      assert replayed["t"] == "MESSAGE_CREATE"
      assert replayed["d"]["channel_id"] == Integer.to_string(thread.thread_id)
      assert replayed["d"]["content"] == "thread reply"

      # OUT-OF-PROFILE direction — a FRESH cycle (resume tokens are
      # single-use): buffer another reply, deny the parent view on the
      # PARENT channel while down, resume: the thread envelope drops.
      conn_b = connect!(port, v: 10)
      ready_b = bot_identify!(conn_b, agent.token)
      _guild_b = next_json!(conn_b, 5_000)
      drain!(conn_b)

      {_reply_b, _} = deliver_thread_reply(general.channel_id, thread.thread_id, parent.user_id, "thread reply b")
      assert next_json!(conn_b, 5_000)["d"]["content"] == "thread reply b"

      send_close!(conn_b, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready_b["session_id"])) end)

      deny = Bitfield.bit(:view_channel) ||| Bitfield.bit(:send_messages)
      Workspaces.put_overwrite(general.channel_id, :member, parent.user_id, 0, deny)
      Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)

      conn_c = connect!(port, v: 10)
      {:ok, %Session{} = stored_c} = lookup(ready_b["session_id"])

      send_frame!(conn_c, 5, %{
        "token" => agent.token,
        "session_id" => ready_b["session_id"],
        "seq" => 0,
        "resume_token" => stored_c.resume_token
      })

      assert next_json!(conn_c, 5_000)["t"] == "RESUMED"

      # The guild still replays (workspace membership intact), but the
      # thread envelope — anchored on the now-invisible PARENT channel —
      # never reaches the wire.
      assert_drained_guild_creates!(conn_c)

      send_frame!(conn_c, 1, nil)
      assert next_op!(conn_c, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn_c.pid, 400)
    end
  end

  # ---------------------------------------------------------------------------
  # Resume identity re-derivation (A1a): a Resume adopts the identity the
  # token verifies to AT RESUME TIME — never the restrictions frozen in the
  # stored record — when the record itself survives (an out-of-band
  # restrictions write that skipped the REST teardown's purge).
  # ---------------------------------------------------------------------------

  describe "resume re-derives the identity from the token" do
    test "restrictions narrowed out-of-band while down bind the resumed session (no resurrect)",
         %{port: port, general: general, random: random, parent: parent} do
      {:ok, agent} = AgentGrants.mint_all(parent.user_id, :agent, run_unique("OutOfBand Agent"))

      conn = connect!(port, v: 10)
      ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # Unrestricted: `random` events flow and are buffered.
      {_, _} = post_message!(random.channel_id, parent.user_id, "buffered on random")
      assert next_json!(conn, 5_000)["d"]["content"] == "buffered on random"

      send_close!(conn, 1000)
      wait_until(fn -> match?({:ok, %Session{phase: :disconnected}}, lookup(ready["session_id"])) end)

      # Out-of-band narrowing (the principals ROW itself — no REST PATCH, so no
      # teardown and the stored record survives): the grant shrinks to
      # `general` only. It must be the ACCESS document — the resolver no longer
      # consults the legacy restrictions column for machine principals.
      :ok =
        Principals.update_access(agent.user_id, %{
          version: 1,
          dms: :none,
          workspaces: %{
            mode: :custom,
            level: nil,
            grants: %{
              ws_id(agent) => %{
                level: :none,
                channels: %{general.channel_id => :read}
              }
            }
          }
        })

      conn2 = connect!(port, v: 10)
      {:ok, %Session{} = stored} = lookup(ready["session_id"])

      send_frame!(conn2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => stored.resume_token
      })

      assert next_json!(conn2, 5_000)["t"] == "RESUMED"

      # The re-filter ran under the FRESHLY VERIFIED identity: guild replays
      # still flow (membership intact), the buffered `random` event does NOT.
      assert_drained_guild_creates!(conn2)

      send_frame!(conn2, 1, nil)
      assert next_op!(conn2, 11, 5_000)
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn2.pid, 400)

      # And the LIVE session stays narrowed: out-of-profile drops, in-profile
      # delivers — both under the resumed (re-derived) identity.
      {_, _} = post_message!(random.channel_id, parent.user_id, "still narrowed")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(conn2.pid, 400)

      {_, _} = post_message!(general.channel_id, parent.user_id, "in profile after resume")
      assert next_json!(conn2, 5_000)["d"]["content"] == "in profile after resume"
    end
  end

  describe "per-principal session cap (KTD15)" do
    test "9th concurrent session on one principal is refused at Identify (4008); the 8 survive",
         %{port: port, agent: agent} do
      conns =
        for _ <- 1..8 do
          c = connect!(port, v: 10)
          ready = bot_identify!(c, agent.token)
          assert is_binary(ready["session_id"])
          drain!(c)
          c
        end

      # The cap counts LIVE sockets of the principal (index entries).
      assert length(Cytale.Gateway.SessionStore.principal_sessions(agent.user_id)) >= 8

      ninth = connect!(port, v: 10)

      send_frame!(ninth, 2, %{
        "token" => agent.token,
        "v" => 10,
        "intents" => 2561,
        "compress" => nil,
        "properties" => %{"os" => "linux", "browser" => "x", "device" => "x"}
      })

      # Discord has no dedicated cap close code; 4008 (rate limited) carries
      # the semantics — documented in docs/protocol/gateway.md.
      code = assert_closed!(ninth, 5_000)
      assert code == 4008

      # The surviving 8 still beat hearts.
      for c <- conns do
        send_frame!(c, 1, nil)
        assert next_op!(c, 11, 5_000)
      end
    end

    test "dropping one session frees a slot", %{port: port, agent: agent} do
      conns =
        for _ <- 1..8 do
          c = connect!(port, v: 10)
          bot_identify!(c, agent.token)
          drain!(c)
          c
        end

      send_close!(List.last(conns), 1000)
      wait_until(fn -> length(Cytale.Gateway.SessionStore.principal_sessions(agent.user_id)) <= 7 end)

      ninth = connect!(port, v: 10)
      ready = bot_identify!(ninth, agent.token)
      assert is_binary(ready["session_id"])
    end

    test "native sessions are exempt (a human's 9th device still connects)", %{port: port} do
      for _ <- 1..9 do
        conn = connect!(port)
        ready = identify!(conn, valid_token())
        assert is_binary(ready["session_id"])
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Voice ops (calls plan U1: the compat wire stays voice-free)
  # ---------------------------------------------------------------------------

  describe "voice ops 22/23" do
    test "a compat session sending op 22 creates no room, delivers no CALL_*, stays alive", %{
      port: port,
      general: general,
      agent: agent
    } do
      conn = connect!(port, v: 10)
      _ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # The bot CAN view the channel (workspace member) — so the drop below
      # is mode-gated, not permission-gated.
      send_frame!(conn, 22, %{
        "channel_id" => Integer.to_string(general.channel_id),
        "action" => "start",
        "ring" => true
      })

      # Frames process in order: the op-11 ACK proves the op 22 above was
      # already handled (as a silent no-op) — no room ever existed.
      send_frame!(conn, 1, nil)
      assert next_op!(conn, 11, 5_000)
      assert Cytale.Calls.room_pid(general.channel_id) == nil

      # No CALL_* ever rides the compat wire.
      refute_next_event!(conn, "CALL_START", 500)
    end
  end

  describe "#55 mid-session channel creation (compat)" do
    test "a channel created mid-session is routed to live compat sessions too",
         %{port: port, ws: ws, parent: parent, agent: agent} do
      conn = connect!(port, v: 10)
      _ready = bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # Created AFTER this bot identified, so the fan-out keys it computed at
      # Identify hold no `{:channel, id}` entry for it. The poke used to refresh
      # only the compat MEMO, never its routes, so a bot missed renames — and
      # new threads — on any channel created after it connected.
      {:ok, fresh} =
        Workspaces.create_channel(ws.workspace_id, run_unique("fresh"), created_by: parent.user_id)

      :ok = Workspaces.update_channel(fresh.channel_id, %{name: "fresh-renamed"})
      Cytale.Permissions.RightsEpoch.bump(ws.workspace_id)
      CytaleWeb.GatewaySocket.refresh_workspace_routes(ws.workspace_id)

      # The poke is a `send/2`; wait for the route before fanning at it.
      wait_until(fn ->
        Cytale.Gateway.PushRegistry.subscribers(
          Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(fresh.channel_id))
        ) != []
      end)

      Cytale.Workspaces.FanOut.deliver(fresh.channel_id, {
        "ChannelUpdate",
        %{"id" => Integer.to_string(fresh.channel_id), "name" => "fresh-renamed"}
      })

      # CHANNEL_UPDATE's translation re-reads the channel row, so the wire
      # object carries the rename.
      frame = next_event!(conn, "CHANNEL_UPDATE", 5_000)
      assert frame["d"]["id"] == Integer.to_string(fresh.channel_id)
      assert frame["d"]["name"] == "fresh-renamed"
    end
  end

  # ---------------------------------------------------------------------------
  # #67 — client-initiated RESUME (Discord op 6) and the refusal contract
  # ---------------------------------------------------------------------------

  describe "compat resume (op 6)" do
    test "a Discord client resumes with op 6 and gets RESUMED (never 4002)", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn1 = connect!(port, v: 10)
      ready = bot_identify!(conn1, agent.token)
      sid = ready["session_id"]
      assert is_binary(sid)

      # The socket drops (a deploy, a restart, a blip).
      Cytale.Test.WSClient.stop(conn1.pid)

      # Discord's recovery is client-initiated: op 6 with the SAME token, the
      # session id, and the last seq it processed. This used to close 4002
      # ("reconnect is server-to-client only") — a code Discord clients treat
      # as RESUMABLE, so they retried forever and never reached Identify.
      conn2 = connect!(port, v: 10)
      send_frame!(conn2, 6, %{"token" => agent.token, "session_id" => sid, "seq" => 0})

      resumed = next_json!(conn2, 5_000)
      assert resumed["op"] == 0
      assert resumed["t"] == "RESUMED"
      assert resumed["d"]["replayed_events"] >= 1
      assert resumed["d"]["heartbeat_interval"] > 0

      # The subscription survived: a message posted now reaches THIS socket
      # (the ticket's stronger assertion — the handshake is not the point,
      # delivery is).
      {_msg, targets} = post_message!(general.channel_id, parent.user_id, "after resume")
      assert targets >= 1

      dispatch = next_event!(conn2, "MESSAGE_CREATE", 5_000)
      assert dispatch["d"]["guild_id"] == Integer.to_string(ws.workspace_id)
      assert dispatch["d"]["content"] == "after resume"
    end

    test "an unresumable session closes with the RETRYABLE signal (op 9 d:false, 4000)", %{port: port, agent: agent} do
      conn = connect!(port, v: 10)

      # A session id this server has never seen: the client must be told to
      # Identify again — not handed a code it will retry Resume on forever.
      send_frame!(conn, 6, %{"token" => agent.token, "session_id" => "sNOSUCHSESSION", "seq" => 0})

      code = assert_closed_skipping!(conn, 5_000, [%{"op" => 9, "d" => false}])

      assert code == 4000
      refute code in [4002, 4004]
    end

    test "a native session still refuses op 6 (its resume is op 5)", %{port: port} do
      conn = connect!(port)
      _ready = identify!(conn, valid_token())

      # The dialect is a property of the credential: op 6 means RESUME only
      # for a `cytbot_` credential. A native session sending it is still a
      # protocol violation.
      Cytale.Test.WSClient.stop(conn.pid)

      conn2 = connect!(port)
      send_frame!(conn2, 6, %{"token" => valid_token(), "session_id" => "sWHATEVER", "seq" => 0})

      assert assert_closed!(conn2, 5_000) == 4002
    end
  end

  # ---------------------------------------------------------------------------
  # #68 — ThreadCreate must survive the translator with a STRING channel id
  # ---------------------------------------------------------------------------

  describe "ThreadCreate with the payload the controllers actually publish" do
    test "the compat ThreadCreate shape (string channel_id) reaches THREAD_CREATE", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "string-id-thread", parent.user_id)

      # EXACTLY what `publish_thread_create/1` emits on the compat route:
      # `Integer.to_string(thread.channel_id)`. The former arity-1
      # `thread_object/1` fed that binary to `Integer.to_string/1`, so the
      # dispatch raised inside the translator and was dropped for every
      # session — no client ever learned the thread existed. The older test
      # passed an INTEGER here, which is why the bug shipped.
      log =
        capture_log(fn ->
          Cytale.Workspaces.FanOut.deliver(general.channel_id, {
            "ThreadCreate",
            %{
              "id" => Integer.to_string(thread.thread_id),
              "channel_id" => Integer.to_string(thread.channel_id),
              "name" => thread.name,
              "created_by" => thread.created_by,
              "created_at" => thread.created_at && DateTime.to_iso8601(thread.created_at)
            }
          })

          d = next_json!(conn, 5_000)["d"]
          send(self(), {:thread, d})
        end)

      assert_receive {:thread, d}

      assert d["id"] == Integer.to_string(thread.thread_id)
      assert d["name"] == "string-id-thread"
      assert d["type"] == 11
      # Discord requires decimal STRINGS, so the projection must emit strings
      # for both ids whatever the payload's native typing was.
      assert d["parent_id"] == Integer.to_string(general.channel_id)
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["owner_id"] == Integer.to_string(parent.user_id)

      refute log =~ "translate error"
    end
  end

  # ---------------------------------------------------------------------------
  # #69 — ONE shape per object: the dispatch projection and the handshake
  # inventory must not drift apart
  # ---------------------------------------------------------------------------

  describe "dispatch/handshake shape parity (#69)" do
    # #64 fixed the GUILD_CREATE `threads[]` inventory and left the DISPATCH
    # projection thin. The gap was invisible while #68 dropped every
    # ThreadCreate; the first dispatch that reached a real client killed its
    # gateway task on `KeyError: 'message_count'`. Both now come from the
    # codec's one builder, and these assertions pin that.
    test "THREAD_CREATE and GUILD_CREATE.threads[] agree on the same thread", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent,
      parent: parent
    } do
      # Create the thread BEFORE connecting, so the handshake inventory has it.
      {:ok, parent_msg} =
        Messages.create_message(%{channel_id: general.channel_id, author_id: parent.user_id, content: "parity root"})

      {:ok, thread} =
        Cytale.Threads.Thread.create(general.channel_id, parent_msg.id, "parity-thread", parent.user_id)

      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      guild = next_json!(conn, 5_000)["d"]
      drain!(conn)

      from_inventory = Enum.find(guild["threads"], &(&1["id"] == Integer.to_string(thread.thread_id)))
      assert from_inventory, "the thread must ride the GUILD_CREATE inventory"

      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "ThreadCreate",
        %{
          "id" => Integer.to_string(thread.thread_id),
          "channel_id" => Integer.to_string(thread.channel_id),
          "name" => thread.name,
          "created_by" => thread.created_by,
          "created_at" => DateTime.to_iso8601(thread.created_at)
        }
      })

      from_dispatch = next_event!(conn, "THREAD_CREATE", 5_000)["d"]

      # The ticket's durable guard: the two are generated by different paths,
      # so assert the FIELD SETS agree — modulo the ONE key that is event
      # metadata rather than thread state (#71). `newly_created` rides
      # THREAD_CREATE because discord.py reads it to decide between
      # `thread_create` and `thread_join`; a handshake inventory entry is not a
      # create, so it must not carry it, and the assertion says so explicitly
      # rather than loosening to a subset check.
      assert from_dispatch |> Map.keys() |> Enum.sort() ==
               from_inventory |> Map.keys() |> List.insert_at(-1, "newly_created") |> Enum.sort()

      # ...and, because they now share one builder, that they agree outright
      # once the event-only key is set aside.
      assert Map.delete(from_dispatch, "newly_created") == from_inventory

      # #71: the flag that makes a stock discord.py client dispatch
      # `thread_create` at all. Without it the library's `if not has_thread`
      # branch reads it as falsy and emits `thread_join` instead — a silent
      # wrong-event-name bug, so pin the VALUE, not just the key's presence.
      assert from_dispatch["newly_created"] == true

      # The three fields discord.py indexes unguarded, explicitly (a parity of
      # two thin objects would satisfy the assertion above and still crash a
      # client).
      for key <- ["owner_id", "message_count", "member_count", "thread_metadata"] do
        assert Map.has_key?(from_dispatch, key), "THREAD_CREATE is missing #{key}"
      end

      assert %{
               "archived" => archived,
               "auto_archive_duration" => auto_archive_duration,
               "archive_timestamp" => archive
             } = from_dispatch["thread_metadata"]

      assert is_boolean(archived)
      assert is_integer(auto_archive_duration)
      assert {:ok, _, _} = DateTime.from_iso8601(archive)
      assert is_integer(from_dispatch["message_count"])
      assert is_integer(from_dispatch["member_count"])
      assert is_binary(from_dispatch["owner_id"])
      assert from_dispatch["guild_id"] == Integer.to_string(ws.workspace_id)
    end

    test "CHANNEL_UPDATE and GUILD_CREATE.channels[] agree on the same channel", %{
      port: port,
      general: general,
      agent: agent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      guild = next_json!(conn, 5_000)["d"]
      drain!(conn)

      from_inventory = Enum.find(guild["channels"], &(&1["id"] == Integer.to_string(general.channel_id)))
      assert from_inventory

      # The channel_controller PATCH flow: row first, then the fan-out.
      :ok = Workspaces.update_channel(general.channel_id, %{name: "renamed-parity", topic: "t"})

      CytaleWeb.GatewaySocket.fan_out(
        Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(general.channel_id)),
        {"ChannelUpdate",
         %{
           "id" => Integer.to_string(general.channel_id),
           "name" => "renamed-parity",
           "topic" => "t",
           "position" => 0
         }}
      )

      from_dispatch = next_json!(conn, 5_000)["d"]

      assert from_dispatch |> Map.keys() |> Enum.sort() == from_inventory |> Map.keys() |> Enum.sort()
      assert Map.has_key?(from_dispatch, "position"), "a client indexes `position` unguarded (#64)"
      assert from_dispatch["position"] == from_inventory["position"]
      assert from_dispatch["name"] == "renamed-parity"
    end

    # #70: the dispatch reports the EVENT's change. The projection re-reads the
    # channel row, and that second read can disagree with the payload the
    # controller built from the same row (observed in the full-suite run: a
    # rename fan-out went out carrying the channel's creation name). Here the
    # disagreement is constructed deliberately — the row is NOT renamed — so
    # the assertion pins the rule instead of depending on which read wins.
    test "CHANNEL_UPDATE reports the payload's stated change, not a stale row read", %{
      port: port,
      ws: ws,
      general: general,
      agent: agent
    } do
      conn = connect!(port, v: 10)
      bot_identify!(conn, agent.token)
      _guild = next_json!(conn, 5_000)
      drain!(conn)

      # The row still says whatever it always said; the event says otherwise.
      Cytale.Workspaces.FanOut.deliver(general.channel_id, {
        "ChannelUpdate",
        %{
          "id" => Integer.to_string(general.channel_id),
          "name" => "renamed-anyway",
          "position" => 7
        }
      })

      d = next_event!(conn, "CHANNEL_UPDATE", 5_000)["d"]
      assert d["name"] == "renamed-anyway"
      assert d["position"] == 7

      # ...while everything the event does not state still comes from the row,
      # so the object stays complete (the #64/#69 shape guarantee).
      assert d["guild_id"] == Integer.to_string(ws.workspace_id)
      assert d["type"] == 0
      assert Map.has_key?(d, "last_message_id")
    end
  end
end
