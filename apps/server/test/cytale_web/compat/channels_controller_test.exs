defmodule CytaleWeb.Compat.ChannelsControllerTest do
  @moduledoc """
  U6 (bots plan) — GET /channels/{id} on the compat surface: the Discord
  channel object (guild_id = workspace id) and the ANTI-ENUMERATION pin —
  missing, non-member, and out-of-profile channels render the IDENTICAL
  10003 body (R7; restrictions apply through the U3 resolver).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  # A JWT conn for the workspace owner — management capabilities are not
  # grantable to an agent (Cytale.Access.never/0), so the tests that exercise
  # the route's SUCCESS path must authenticate as the human who holds them.
  defp owner_conn(user) do
    access = Cytale.Accounts.Auth.issue_access_token(user.user_id, user.username, true)

    conn_with("Bearer " <> access)
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  setup do
    {:ok, owner} = User.create(run_unique("ch_owner"), run_unique("ch_owner@example.com"), "password-123")

    # The compat write pipeline gates on verification, and the human-authenticated
    # cases below (channel management is human capability) need a verified human.
    {:ok, raw, _hash} = Cytale.Accounts.Auth.issue_single_use_token(owner.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("ch-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, secret} = Workspaces.create_channel(ws.workspace_id, "secret")
    {:ok, %{user_id: bot_id, token: token}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Ch Bot"))

    {:ok,
     owner: owner,
     ws_id: ws.workspace_id,
     ch_id: Integer.to_string(ch.channel_id),
     secret_id: Integer.to_string(secret.channel_id),
     bot_id: bot_id,
     token: token}
  end

  describe "show" do
    test "Discord channel object: guild_id = workspace id, type 0, last_message_id", %{
      ws_id: ws_id,
      ch_id: ch_id,
      token: token
    } do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}")
      assert conn.status == 200

      assert Jason.decode!(conn.resp_body) == %{
               "id" => ch_id,
               "guild_id" => Integer.to_string(ws_id),
               "name" => "general",
               # #75: both are real columns the native surface always served and
               # this projection dropped — Discord sends them for text channels.
               "topic" => nil,
               "parent_id" => nil,
               "type" => 0,
               "position" => 0,
               "last_message_id" => nil
             }
    end

    test "last_message_id tracks the channel's latest message", %{ch_id: ch_id, token: token} do
      # Sent through the compat REST surface so the controller's
      # denormalization (the native POST's touch) applies.
      sent = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "ping"})
      assert sent.status == 201
      message_id = Jason.decode!(sent.resp_body)["id"]

      conn = get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}")
      assert Jason.decode!(conn.resp_body)["last_message_id"] == message_id
    end

    test "bare /api alias answers identically", %{ch_id: ch_id, token: token} do
      conn = get(conn_with("Bot " <> token), "/api/channels/#{ch_id}")
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["id"] == ch_id
    end
  end

  describe "PATCH /channels/{id} (#75) — dormant for CHANNELS, live for THREADS" do
    # Two facts collide on the CHANNEL path, and together they make it
    # unreachable:
    #
    #   1. The compat surface serves MACHINE credentials only (BotAuth: `Bot
    #      cytbot_…`; a human Bearer is the uniform 401, and `Bot <JWT>` too).
    #   2. Channel management is not reachable by ANY grant — `manage_channels`
    #      is in `Cytale.Access.never/0`, so no access document can confer it.
    #
    # So no principal can currently call it for a channel, and its own
    # semantics are therefore unexercised: a machine conn cannot conjure
    # `manage_channels` either, because the gate resolves the grant rather than
    # trusting the connection. The route stays — deleting a documented Discord
    # route is its own decision — and it becomes live the day an admin tier
    # exists. Until then this describe pins the POSTURE, which is the behaviour
    # that matters.
    #
    # A THREAD id branches before any of that (#109, threads_controller_test):
    # archiving needs no `manage_*` bit, because a thread's owner may archive
    # its OWN thread — the one shape a bot can reach, and the one Discord
    # clients actually use.
    test "an agent is refused: no grant can confer channel management", %{
      ch_id: ch_id,
      token: token
    } do
      denied =
        patch(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}", %{"name" => "nope"})

      assert denied.status == 403
      assert Jason.decode!(denied.resp_body)["code"] == 50_001

      # …and nothing was destroyed by the refused call.
      read = Jason.decode!(get(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}").resp_body)
      assert read["name"] == "general"
    end

    test "a human credential is the compat surface's uniform 401, by design", %{
      ch_id: ch_id,
      owner: owner
    } do
      # Not a permission answer — the compat prefix never serves the human path
      # (R7), so a human manages channels on the NATIVE route the app's own UI
      # uses, not here.
      assert patch(owner_conn(owner), "/api/v10/channels/#{ch_id}", %{"name" => "x"}).status == 401
    end

    test "a DM id is not an editable channel here", %{token: token, owner: owner} do
      # A DM needs two distinct humans.
      {:ok, partner} = User.create(run_unique("ch_dm"), run_unique("ch_dm@example.com"), "password-123")
      {:ok, dm} = Workspaces.open_dm(owner.user_id, partner.user_id)

      conn = patch(conn_with("Bot " <> token), "/api/v10/channels/#{dm.channel_id}", %{"name" => "x"})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10_003
    end
  end

  describe "anti-enumeration (identical 10003 shape)" do
    test "missing channel vs non-member parent vs out-of-profile restrictions — byte-identical bodies", %{
      ch_id: ch_id,
      secret_id: secret_id,
      owner: owner
    } do
      # A bot whose parent is NOT a member of the workspace.
      {:ok, stranger} = User.create(run_unique("ch_stranger"), run_unique("ch_stranger@example.com"), "password-123")
      {:ok, %{token: stranger_token}} = AgentGrants.mint_all(stranger.user_id, :bot, run_unique("Outsider"))

      # A read-restricted agent allowlisted to `general` only, hitting `secret`.
      {:ok, %{token: ro_token}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Scoped"), %{
          "actions" => ["read"],
          "channels" => [ch_id]
        })

      missing = get(conn_with("Bot " <> stranger_token), "/api/v10/channels/123456789012345678")
      nonmember = get(conn_with("Bot " <> stranger_token), "/api/v10/channels/#{ch_id}")
      out_of_profile = get(conn_with("Bot " <> ro_token), "/api/v10/channels/#{secret_id}")

      assert missing.status == 404
      assert nonmember.status == 404
      assert out_of_profile.status == 404

      expected = %{"code" => 10003, "message" => "Unknown Channel"}
      assert Jason.decode!(missing.resp_body) == expected
      assert Jason.decode!(nonmember.resp_body) == expected
      assert Jason.decode!(out_of_profile.resp_body) == expected

      # The restricted agent still reaches its in-profile channel.
      in_profile = get(conn_with("Bot " <> ro_token), "/api/v10/channels/#{ch_id}")
      assert in_profile.status == 200
    end

    test "non-snowflake id → 404 10003", %{token: token} do
      conn = get(conn_with("Bot " <> token), "/api/v10/channels/not-an-id")
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10003
    end
  end

  describe "POST /channels/{id}/typing (C-3)" do
    test "in-profile typing → 204 empty (Discord's response)", %{ch_id: ch_id, token: token} do
      conn = post(conn_with("Bot " <> token), "/api/v10/channels/#{ch_id}/typing", %{})
      assert conn.status == 204
      assert conn.resp_body == ""
    end

    test "bare /api alias answers identically", %{ch_id: ch_id, token: token} do
      conn = post(conn_with("Bot " <> token), "/api/channels/#{ch_id}/typing", %{})
      assert conn.status == 204
      assert conn.resp_body == ""
    end

    test "in-profile RESTRICTED agent types on its allowlist; out-of-profile + unknown are 404 10003", %{
      owner: owner,
      ch_id: ch_id,
      secret_id: secret_id
    } do
      {:ok, %{token: ro}} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Typing Scope"), %{
          "actions" => ["read", "post"],
          "channels" => [ch_id]
        })

      ok = post(conn_with("Bot " <> ro), "/api/v10/channels/#{ch_id}/typing", %{})
      assert ok.status == 204
      assert ok.resp_body == ""

      # The identical anti-enumeration 404 for out-of-profile and unknown —
      # never a 403 oracle.
      out = post(conn_with("Bot " <> ro), "/api/v10/channels/#{secret_id}/typing", %{})
      assert out.status == 404
      assert Jason.decode!(out.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}

      unknown = post(conn_with("Bot " <> ro), "/api/v10/channels/123456789012345678/typing", %{})
      assert unknown.status == 404
      assert Jason.decode!(unknown.resp_body) == %{"code" => 10003, "message" => "Unknown Channel"}
    end
  end
end
