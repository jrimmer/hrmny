defmodule CytaleWeb.Compat.RestFlowTest do
  @moduledoc """
  U6 (bots plan) — the integration pin: a raw HTTP client (Finch, no
  Phoenix test dispatch) completes mint → GET /users/@me → POST message →
  GET messages → reply using ONLY Discord-shaped knowledge: `Authorization:
  Bot`, Discord route shapes, Discord payload fields — zero Cytale-native
  fields on the wire. (Minting itself is a native admin action, done via the
  domain in setup — Discord libraries receive tokens out-of-band.)
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp base_url do
    port = Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]
    "http://127.0.0.1:#{port}"
  end

  defp request(method, path, token, body \\ nil) do
    headers = [{"authorization", "Bot " <> token}, {"accept", "application/json"}]

    req =
      case body do
        nil ->
          Finch.build(method, base_url() <> path, headers)

        map ->
          Finch.build(method, base_url() <> path, [{"content-type", "application/json"} | headers], Jason.encode!(map))
      end

    {:ok, %Finch.Response{status: status, headers: resp_headers, body: resp_body}} =
      Finch.request(req, finch())

    resp =
      case resp_body do
        "" -> nil
        _ -> Jason.decode!(resp_body)
      end

    {status, Map.new(resp_headers, fn {k, v} -> {String.downcase(k), v} end), resp}
  end

  # Own pool: the shared CytaleTest.Finch's keep-alive connections can race
  # the endpoint-crash recovery test in ApplicationTest — this module never
  # shares sockets with it.
  defp finch do
    if Process.whereis(CytaleTest.FinchCompat) do
      CytaleTest.FinchCompat
    else
      {:ok, _} = Finch.start_link(name: CytaleTest.FinchCompat)
      CytaleTest.FinchCompat
    end
  end

  setup do
    {:ok, owner} = User.create(run_unique("flow_owner"), run_unique("flow_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("flow-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")

    {:ok, %{user_id: bot_id, token: token, username: bot_username}} =
      AgentGrants.mint_all(owner.user_id, :bot, run_unique("Flow Bot"))

    {:ok, ch_id: Integer.to_string(ch.channel_id), bot_id: bot_id, bot_username: bot_username, token: token}
  end

  test "the Discord-only round-trip", %{ch_id: ch_id, bot_id: bot_id, bot_username: bot_username, token: token} do
    # 1. Who am I? (versioned prefix) — the credential's TAG is the wire
    # username now (unique per server), for username AND global_name.
    {200, me_headers, me} = request(:get, "/api/v10/users/@me", token)

    assert me == %{
             "id" => Integer.to_string(bot_id),
             "username" => bot_username,
             "discriminator" => "0",
             "global_name" => bot_username,
             "avatar" => nil,
             "bot" => true
           }

    assert me_headers["content-type"] =~ "application/json"
    assert me_headers["x-ratelimit-bucket"] != nil

    # 2. Gateway bootstrap (library hits this before opening the socket).
    {200, _, gw} = request(:get, "/api/v10/gateway/bot", token)
    assert String.ends_with?(gw["url"], "/gateway/websocket?v=10&encoding=json")
    assert gw["shards"] == 1
    assert gw["session_start_limit"]["max_concurrency"] == 1

    # 3. Channel object via the bare alias (libraries that pin their own base).
    {200, _, channel} = request(:get, "/api/channels/#{ch_id}", token)
    assert channel["id"] == ch_id
    assert channel["type"] == 0
    assert is_binary(channel["guild_id"])

    # 4. Send a message.
    {201, _, sent} =
      request(:post, "/api/v10/channels/#{ch_id}/messages", token, %{"content" => "hello from a bot"})

    assert sent["content"] == "hello from a bot"
    assert sent["author"]["bot"] == true
    assert sent["type"] == 0

    # 5. History: bare array containing it.
    {200, _, history} = request(:get, "/api/v10/channels/#{ch_id}/messages", token)
    assert is_list(history)
    assert sent["id"] in Enum.map(history, & &1["id"])

    # 6. Reply using Discord's message_reference shape.
    {201, _, reply} =
      request(:post, "/api/v10/channels/#{ch_id}/messages", token, %{
        "content" => "replying",
        "message_reference" => %{"message_id" => sent["id"]}
      })

    assert reply["type"] == 19
    assert reply["message_reference"]["message_id"] == sent["id"]
    assert reply["referenced_message"]["id"] == sent["id"]
    assert reply["referenced_message"]["content"] == "hello from a bot"
  end

  test "a wrong-scheme credential never crosses the compat surface", %{token: token} do
    req =
      Finch.build(:get, base_url() <> "/api/v10/users/@me", [{"authorization", "Bearer " <> token}])

    {:ok, %Finch.Response{status: 401, body: body}} = Finch.request(req, finch())
    assert Jason.decode!(body) == %{"message" => "401: Unauthorized", "code" => 0}
  end
end
