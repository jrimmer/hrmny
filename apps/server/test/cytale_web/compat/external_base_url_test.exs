defmodule CytaleWeb.Compat.ExternalBaseUrlTest do
  @moduledoc """
  C-5b — the `cytale, :external_base_url` app env: when set, EVERY
  externally-constructed URL carries the configured origin verbatim instead
  of the request's host/scheme/port:

    * `/gateway/bot`'s `url` (the shared `CytaleWeb.Compat.GatewayUrl`
      builder — the same one the compat READY's resume_gateway_url uses);
    * the webhook capability URLs (create/list/PATCH responses — the
      execute/info path integrators POST).

  When unset (the default) today's conn-derived behavior is unchanged.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User, Verification}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.GatewayUrl

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp conn_with(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  setup do
    # Verified owner: webhook minting rides the content_mutation pipeline.
    {:ok, owner} = User.create(run_unique("url_owner"), run_unique("url_owner@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(owner.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("url-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, %{token: token}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Url Bot"))
    jwt = Auth.issue_access_token(owner.user_id, owner.username, true)

    # Every test in this module runs with the override SET; the env-unset
    # leg asserts below first (the default in config.exs is nil).
    Application.put_env(:cytale, :external_base_url, "https://chat.example.com")

    on_exit(fn -> Application.put_env(:cytale, :external_base_url, nil) end)

    {:ok, owner: owner, ws_id: ws.workspace_id, ch_id: ch.channel_id, token: token, jwt: jwt}
  end

  defp jwt_conn(jwt) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> jwt)
  end

  test "env unset → conn-derived (unchanged default)" do
    Application.put_env(:cytale, :external_base_url, nil)

    on_exit(fn -> Application.put_env(:cytale, :external_base_url, nil) end)

    conn = %{Phoenix.ConnTest.build_conn() | scheme: :https, host: "internal.example.com", port: 8443}

    # The conn's origin, ws-mapped: https + non-default port → wss + :8443.
    assert GatewayUrl.websocket_url(conn) == "wss://internal.example.com:8443/gateway/websocket?v=10&encoding=json"
  end

  test "env set → /gateway/bot carries the configured origin regardless of request headers", %{token: token} do
    # ConnTest dispatches with host www.example.com — the configured origin
    # replaces it verbatim (ws mapping + suffix still apply).
    conn = get(conn_with("Bot " <> token), "/api/v10/gateway/bot")
    assert conn.status == 200

    assert Jason.decode!(conn.resp_body)["url"] == "wss://chat.example.com/gateway/websocket?v=10&encoding=json"
  end

  test "env set → webhook create/list capability URLs carry the configured origin", %{
    ch_id: ch_id,
    jwt: jwt
  } do
    created = post(jwt_conn(jwt), "/api/v1/channels/#{ch_id}/webhooks", %{"name" => "Origin Hook"})
    assert created.status == 201

    %{"id" => id, "url" => url} = Jason.decode!(created.resp_body)
    expected = "https://chat.example.com/api/webhooks/#{id}/#{Cytale.Webhooks.get_webhook(String.to_integer(id)).token}"
    assert url == expected

    # The LIST is the governance read: it deliberately OMITS the capability
    # URL (its reader is a channel manager who is not necessarily the creator,
    # so the token is not theirs to see — WebhookController.index). The
    # origin-carrying URL is owned by the CREATE response, asserted above.
    listed = get(jwt_conn(jwt), "/api/v1/channels/#{ch_id}/webhooks")
    assert [%{"id" => ^id} = hook] = Jason.decode!(listed.resp_body)["webhooks"]
    refute Map.has_key?(hook, "url")
  end

  test "a trailing slash on the configured base never doubles in the webhook URL", %{ch_id: ch_id, jwt: jwt} do
    Application.put_env(:cytale, :external_base_url, "https://chat.example.com/")

    on_exit(fn -> Application.put_env(:cytale, :external_base_url, nil) end)

    created = post(jwt_conn(jwt), "/api/v1/channels/#{ch_id}/webhooks", %{"name" => "Slash Hook"})
    assert created.status == 201

    %{"url" => url} = Jason.decode!(created.resp_body)
    refute url =~ "//api/webhooks"
    assert url =~ ~r{^https://chat\.example\.com/api/webhooks/}
  end
end
