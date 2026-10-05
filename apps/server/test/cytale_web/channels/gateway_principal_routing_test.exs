defmodule CytaleWeb.GatewayPrincipalRoutingTest do
  @moduledoc """
  U5 (bots plan) — machine principals on the gateway wire, mirroring the
  human presence/routing contract (R4): a `cytbot_` Identify resolves the
  parent's workspaces (R1 membership derivation) so the agent socket joins
  the parent's fan-out routes — observable as a MessageCreate arriving on a
  channel of the parent's workspace — and the agent's presence transitions
  (online on join, offline on last-socket close) reach the roster exactly
  like a human's. Deep event filtering is U7; this pins the routing only.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # Per-run Stub identity for the observing member (the human gateway path
  # rides the deterministic Stub in tests; the AGENT path resolves its real
  # cytbot_ credential through the composite authenticator). Memoized per
  # test process — the token string IS the identity, so a fresh nonce would
  # silently identify as a different user.
  defp observer_token do
    key = {:cytale_u5_observer_token}
    token = Process.get(key)

    if token do
      token
    else
      token = "cytale_u5obs_" <> run_nonce() <> String.duplicate("o", 8)
      Process.put(key, token)
      token
    end
  end

  setup do
    port = start_gateway!()

    # Real verified parent — machine principals mint only under real humans,
    # and the REST message post below needs a working JWT.
    {:ok, parent} = User.create(run_unique("u5_parent"), run_unique("u5_parent@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(parent.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(parent.user_id, run_unique("u5-ws"))
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "general")

    {:ok, %{user_id: agent_id, token: agent_token}} =
      AgentGrants.mint_all(parent.user_id, :agent, run_unique("Wire Agent"))

    %{
      port: port,
      parent: parent,
      ws_id: ws.workspace_id,
      ch_id: channel.channel_id,
      agent_id: agent_id,
      agent_token: agent_token
    }
  end

  # Swallow queued dispatches until quiet — the next assertion starts from a
  # deterministic empty mailbox (mirrors gateway_fanout_test's drain).
  defp drain_pending!(conn) do
    case next_frame(conn, 300) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  defp wait_closed(conn) do
    case next_frame(conn, 5_000) do
      {:closed, code} -> code
      {:ok, _json} -> wait_closed(conn)
    end
  end

  # U7: cytbot_ sessions are compat sessions — events ride intents. The
  # routing pin below needs GUILD_MESSAGES (1<<9); the full supported set
  # (GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_TYPING) reads cleaner.
  # The socket's ONE definition (GUILDS | GUILD_MESSAGES | GUILD_MESSAGE_TYPING).
  @supported_intents CytaleWeb.GatewaySocket.supported_intents()

  test "a cytbot_ Identify subscribes to the parent's workspace routes: MessageCreate reaches the agent",
       %{port: port, ch_id: ch_id, agent_id: agent_id, agent_token: agent_token, parent: parent} do
    conn = connect!(port)
    ready = identify!(conn, agent_token, intents: @supported_intents, v: 10)

    # READY speaks the machine principal's identity (U2 composite); U7 makes
    # it the Discord-shaped compat READY.
    assert ready["user"]["id"] == Integer.to_string(agent_id)
    assert ready["user"]["bot"] == true
    # Swallow the join self-announce (the agent is itself a ws subscriber).
    drain_pending!(conn)

    # A channel event on the parent's workspace reaches the agent socket:
    # proof the workspace/channel keys were joined through the parent's
    # memberships (workspaces_of_user parent fallback). Payload is the
    # native message projection shape (what REST posts fan out).
    now_iso = DateTime.utc_now() |> DateTime.to_iso8601()

    assert Cytale.Workspaces.FanOut.deliver(
             ch_id,
             {"MessageCreate",
              %{
                "id" => "123",
                "channel_id" => ch_id,
                "author_id" => parent.user_id,
                "content" => "routing pin",
                "thread_id" => nil,
                "reply_to_id" => nil,
                "created_at" => now_iso,
                "edited_at" => nil,
                "attachments" => []
              }}
           ) >= 1

    dispatch = next_json!(conn, 5_000)
    assert dispatch["op"] == 0
    # U7: compat sessions hear the SCREAMING translation of the same event.
    assert dispatch["t"] == "MESSAGE_CREATE"
    assert dispatch["d"]["id"] == "123"
    assert dispatch["d"]["content"] == "routing pin"
  end

  test "an agent's live socket produces human-identical presence transitions",
       %{port: port, parent: parent, ws_id: ws_id, agent_id: agent_id, agent_token: agent_token} do
    agent_str = Integer.to_string(agent_id)

    # Learn the observer's Stub identity BEFORE writing its membership, then
    # reconnect so it actually holds the workspace route (fanout-test dance).
    boot = connect!(port)
    ready_obs = identify!(boot, observer_token())
    observer_id = ready_obs["user"]["id"]
    send_close!(boot, 1000)
    _ = wait_closed(boot)

    :ok = Workspaces.add_member(ws_id, String.to_integer(observer_id), parent.user_id)

    observer = connect!(port)
    identify!(observer, observer_token())
    drain_pending!(observer)

    # Agent joins: the roster sees the agent ONLINE, keyed by the agent id.
    agent_conn = connect!(port)
    ready_agent = identify!(agent_conn, agent_token)
    assert ready_agent["user"]["id"] == agent_str

    online = next_json!(observer, 5_000)
    assert online["op"] == 0 and online["t"] == "PresenceUpdate"
    assert online["d"]["user_id"] == agent_str
    assert online["d"]["status"] == "online"
    assert online["d"]["last_seen_at"]

    # Agent's last socket drops: OFFLINE, same as a human's.
    drain_pending!(agent_conn)
    send_close!(agent_conn, 1000)
    assert wait_closed(agent_conn) == 1000

    offline = next_json!(observer, 5_000)
    assert offline["t"] == "PresenceUpdate"
    assert offline["d"]["user_id"] == agent_str
    assert offline["d"]["status"] == "offline"
  end
end
