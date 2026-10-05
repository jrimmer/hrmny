defmodule CytaleWeb.Compat.DmControllerTest do
  @moduledoc """
  The compat DM surface (bots plan B-1, both prefixes): Discord's
  POST/GET /users/@me/channels over the native dm_channels storage — the
  DM channel object shape (type 1, recipients = the OTHER participant), the
  kind guard (bot↔bot 400 50035, unknown recipient 404 10013), messages/
  reactions/typing/ack on DM channel ids through the EXISTING channel
  routes (recipient membership gate; the identical 10003 for
  non-participants), the restrictions BYPASS (a channel-allowlist agent
  still DMs its parent — pinned Discord parity), and last_message_id
  denormalization.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    {owner_conn, owner} = register_and_login()
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Dm Bot"))

    {:ok, owner: owner, owner_conn: owner_conn, bot: bot, bot_conn: bot_conn(bot.token)}
  end

  describe "POST /users/@me/channels" do
    test "opens a DM with the parent → 200 Discord DM channel object", %{
      owner: owner,
      bot: bot,
      bot_conn: bot_conn
    } do
      conn = post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})

      assert conn.status == 200
      ch = Jason.decode!(conn.resp_body)

      assert ch["type"] == 1
      assert ch["id"] != nil
      # recipients = the OTHER participant (the human parent), Discord shape.
      assert [%{"id" => parent_id, "username" => _}] = ch["recipients"]
      assert parent_id == Integer.to_string(owner.user_id)
      refute Map.has_key?(ch, "guild_id")
      assert ch["last_message_id"] == nil

      # Re-open fetches the SAME channel (Discord's create-or-get, 200).
      again = post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})
      assert Jason.decode!(again.resp_body)["id"] == ch["id"]

      # The bare /api prefix serves the identical contract.
      bare = post(bot_conn(bot.token), "/api/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})
      assert Jason.decode!(bare.resp_body)["id"] == ch["id"]

      assert bot.user_id != nil
    end

    test "bot ↔ bot recipient → 403 50007 (the DM-support policy refuses; Discord parity)", %{
      owner: owner,
      bot_conn: bot_conn
    } do
      {:ok, other_bot} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Other Machine"))

      conn = post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(other_bot.user_id)})

      # Two machines are refused by the POLICY, not the kind (owner direction
      # 2026-09-15): both default to with-humans, so the pair cannot open.
      # Discord answers this same case 403 "Cannot send messages to this
      # user" — the 400/50035 mapping now belongs only to malformed bodies.
      assert conn.status == 403
      assert %{"code" => 50_007, "message" => "Cannot send messages to this user"} = Jason.decode!(conn.resp_body)
    end

    test "unknown recipient → 404 10013 Unknown User; missing recipient_id → 50035", %{bot_conn: bot_conn} do
      bogus = post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => "123456789012345678"})

      assert bogus.status == 404
      assert %{"code" => 10_013, "message" => "Unknown User"} = Jason.decode!(bogus.resp_body)

      missing = post(bot_conn, "/api/v10/users/@me/channels", %{})
      assert missing.status == 400
      assert %{"code" => 50_035} = Jason.decode!(missing.resp_body)
    end
  end

  describe "GET /users/@me/channels" do
    test "bare array of the bot's DM channels; recipients exclude the caller", %{
      owner: owner,
      bot: bot,
      bot_conn: bot_conn
    } do
      post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})

      conn = get(bot_conn, "/api/v10/users/@me/channels")
      assert conn.status == 200

      list = Jason.decode!(conn.resp_body)
      assert is_list(list) and length(list) == 1
      assert [%{"id" => _, "type" => 1, "recipients" => [%{"id" => parent_id}]}] = list
      assert parent_id == Integer.to_string(owner.user_id)
    end
  end

  describe "messages ride the channel routes on the DM id" do
    setup %{owner: owner, bot_conn: bot_conn} do
      conn = post(bot_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})
      dm_id = Jason.decode!(conn.resp_body)["id"]
      {:ok, dm_id: dm_id}
    end

    test "send → 201 message object; history bare array; channel GET renders the DM object", %{
      bot_conn: bot_conn,
      dm_id: dm_id,
      owner: owner
    } do
      sent = post(bot_conn, "/api/v10/channels/#{dm_id}/messages", %{"content" => "dm via compat"})
      assert sent.status == 201

      msg = Jason.decode!(sent.resp_body)
      assert msg["channel_id"] == dm_id
      assert msg["author"]["id"] != nil
      assert msg["author"]["bot"] == true

      history = get(bot_conn, "/api/v10/channels/#{dm_id}/messages")
      assert history.status == 200
      assert [%{"id" => id, "channel_id" => ^dm_id}] = Jason.decode!(history.resp_body)
      assert id == msg["id"]

      # The channel route renders the DM channel object with the OTHER
      # participant and the denormalized last_message_id.
      shown = get(bot_conn, "/api/v10/channels/#{dm_id}")
      assert shown.status == 200

      obj = Jason.decode!(shown.resp_body)
      assert obj["type"] == 1
      assert [%{"id" => parent_id}] = obj["recipients"]
      assert parent_id == Integer.to_string(owner.user_id)
      assert obj["last_message_id"] == msg["id"]

      # last_message_id flows to the bot's DM list too.
      list = Jason.decode!(get(bot_conn, "/api/v10/users/@me/channels").resp_body)
      assert Enum.find(list, &(&1["id"] == dm_id))["last_message_id"] == msg["id"]
    end

    test "typing 204 + ack 200 on the DM id; reactions round-trip", %{bot_conn: bot_conn, dm_id: dm_id} do
      assert post(bot_conn, "/api/v10/channels/#{dm_id}/typing") |> status() == 204

      sent = post(bot_conn, "/api/v10/channels/#{dm_id}/messages", %{"content" => "anchor"})
      msg_id = Jason.decode!(sent.resp_body)["id"]

      ack = post(bot_conn, "/api/v10/channels/#{dm_id}/messages/#{msg_id}/ack")
      assert ack.status == 200
      assert Jason.decode!(ack.resp_body) == %{"token" => nil}

      emoji = URI.encode("👍")
      assert put(bot_conn, "/api/v10/channels/#{dm_id}/messages/#{msg_id}/reactions/#{emoji}/@me") |> status() == 204

      users = get(bot_conn, "/api/v10/channels/#{dm_id}/messages/#{msg_id}/reactions/#{emoji}") |> json()
      assert is_list(users) and length(users) == 1
    end

    test "non-participant bot gets the identical 10003 on every DM route", %{
      owner: owner,
      bot_conn: bot_conn,
      dm_id: dm_id
    } do
      # A DIFFERENT human's machine principal (a workspace member of the
      # same workspace even) is not a DM participant — participation is the
      # only key that opens a DM channel.
      {_other_conn, other} = register_and_login()
      {:ok, stranger} = AgentGrants.mint_all(other.user_id, :agent, run_unique("Stranger Agent"))
      stranger_conn = bot_conn(stranger.token)

      for conn <- [
            stranger_conn |> get("/api/v10/channels/#{dm_id}"),
            stranger_conn |> get("/api/v10/channels/#{dm_id}/messages"),
            stranger_conn |> post("/api/v10/channels/#{dm_id}/messages", %{"content" => "intrude"}),
            stranger_conn |> post("/api/v10/channels/#{dm_id}/typing")
          ] do
        assert conn.status == 404
        assert %{"code" => 10_003, "message" => "Unknown Channel"} = Jason.decode!(conn.resp_body)
      end

      assert owner.user_id > 0
    end

    test "native human replies on the DM channel (participation IS authorization on the native path too)", %{
      owner: owner,
      owner_conn: owner_conn,
      bot_conn: bot_conn,
      dm_id: dm_id
    } do
      assert post(bot_conn, "/api/v10/channels/#{dm_id}/messages", %{"content" => "bot opens"}) |> status() == 201

      reply = post(owner_conn, "/api/v1/channels/#{dm_id}/messages", %{"content" => "human replies natively"})
      assert reply.status == 201

      history = Jason.decode!(get(bot_conn, "/api/v10/channels/#{dm_id}/messages").resp_body)
      assert Enum.any?(history, &(&1["content"] == "human replies natively"))

      # A non-participant human is 404 on the native send (anti-enumeration).
      {other_conn, _other} = register_and_login()
      denied = post(other_conn, "/api/v1/channels/#{dm_id}/messages", %{"content" => "nope"})
      assert denied.status == 404

      assert owner.user_id > 0
    end
  end

  describe "restrictions deliberately bypass for DMs (pinned)" do
    test "a channel-allowlist agent can still DM its parent", %{
      owner: owner,
      owner_conn: owner_conn,
      bot: bot,
      bot_conn: bot_conn
    } do
      # The agent's allowlist is workspace-scoped: it cannot read ANY
      # workspace channel — but DMs have no workspace, participation IS
      # authorization (Discord parity, documented in compat.md).
      {:ok, agent} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Lockboxed Agent"), %{
          actions: ["read", "post"],
          channels: []
        })

      # Security tier 1 #9d: DM access is the document's OWN node (`dms`), no
      # longer implied — grant it, leaving the workspace grant as the shim set
      # it. The pinned property stands: the WORKSPACE grant never narrows DMs.
      agent =
        AgentGrants.grant(agent, Map.put(Cytale.Accounts.Principals.get(agent.user_id).access, :dms, :read_write))

      agent_conn = bot_conn(agent.token)

      conn = post(agent_conn, "/api/v10/users/@me/channels", %{"recipient_id" => Integer.to_string(owner.user_id)})
      assert conn.status == 200

      dm_id = Jason.decode!(conn.resp_body)["id"]
      sent = post(agent_conn, "/api/v10/channels/#{dm_id}/messages", %{"content" => "still dmable"})
      assert sent.status == 201

      # The agent (participant) reads its own DM history; the human parent
      # sees the same rows through the NATIVE surface.
      history = Jason.decode!(get(agent_conn, "/api/v10/channels/#{dm_id}/messages").resp_body)
      assert Enum.any?(history, &(&1["content"] == "still dmable"))

      native =
        Jason.decode!(get(owner_conn, "/api/v1/channels/#{dm_id}/messages").resp_body)["messages"]

      assert Enum.any?(native, &(&1["content"] == "still dmable"))
      assert bot.user_id != nil
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
    username = "cdm#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
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
