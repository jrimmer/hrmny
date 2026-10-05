defmodule CytaleWeb.Controllers.WebhookWireTest do
  @moduledoc """
  U11's one wire test: a webhook execute (raw HTTP, no auth header) fans out
  as a native MessageCreate to a subscribed gateway session — author_id is
  the webhook PRINCIPAL, the author_override rides the dispatch, and an
  embed-only post renders through the U10 embeds storage.

  Rides the REAL test endpoint (WS gateway + REST on one port) with the
  Publish seam re-wired to the workspace-process implementation for this
  module (the workspaces_test pattern — restored in on_exit).
  """

  use Cytale.ScyllaCase, async: false

  import Cytale.GatewayCase, only: [connect!: 1, identify!: 2, next_frame: 2]

  alias Cytale.Webhooks
  alias Cytale.Workspaces

  defp run_nonce,
    do:
      "r" <>
        Integer.to_string(
          :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
        )

  defp endpoint_port,
    do: Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]

  defp base_url, do: "http://127.0.0.1:#{endpoint_port()}"

  setup do
    # The real fan-out path (config/test.exs pins the Log impl by default).
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)
    Cytale.Gateway.AdmissionLimiter.reset()

    on_exit(fn ->
      if original == nil,
        do: Application.delete_env(:cytale, Cytale.Publish),
        else: Application.put_env(:cytale, Cytale.Publish, original)
    end)

    # A fresh throwaway identity per run (the Stub maps the token
    # deterministically; a unique token = a unique synthetic user).
    token = "cytale_whw_" <> run_nonce() <> String.duplicate("x", 8)
    {:ok, token: token}
  end

  # Swallow queued join announces until the socket is quiet, so the next
  # assertion starts from a deterministic mailbox (gateway_fanout pattern).
  defp drain!(conn) do
    case next_frame(conn, 300) do
      {:ok, _json} -> drain!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  defp post_json(path, body) do
    req = Finch.build(:post, base_url() <> path, [{"content-type", "application/json"}], Jason.encode!(body))
    {:ok, %Finch.Response{status: status, body: resp_body}} = Finch.request(req, CytaleTest.Finch)
    {status, if(resp_body == "", do: nil, else: Jason.decode!(resp_body))}
  end

  test "webhook execute fans out MessageCreate to a subscribed native session", %{token: token} do
    # Bootstrap: learn the Stub identity BEFORE creating its workspace.
    boot = connect!(endpoint_port())
    ready = identify!(boot, token)
    owner_id = String.to_integer(ready["user"]["id"])

    {:ok, ws} = Workspaces.create_workspace(owner_id, "wh-wire-" <> run_nonce())
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "alerts")

    # The webhook's PARENT is a real human row (the Stub identity is
    # synthetic — mint demands an existing parent; provenance only, the
    # parent needs no membership for execute, KD8).
    {:ok, parent} =
      Cytale.Accounts.User.create(
        "whw_parent" <> run_nonce(),
        "whw_parent" <> run_nonce() <> "@example.com",
        "password-123"
      )

    {:ok, webhook} = Webhooks.create_webhook(ch.channel_id, "Wire Hook", parent.user_id)

    # The observing session identifies AFTER the workspace exists (routes
    # join at READY), then drains the join announces.
    conn = connect!(endpoint_port())
    identify!(conn, token)
    drain!(conn)

    # 1. Bare execute with an override — raw HTTP, NO auth header.
    {204, nil} =
      post_json("/api/webhooks/#{webhook.id}/#{webhook.token}", %{
        "content" => "hello from the wire",
        "username" => "Wire Override"
      })

    dispatch = next_frame(conn, 5_000) |> decode!
    assert dispatch["op"] == 0
    assert dispatch["t"] == "MessageCreate"

    assert dispatch["d"]["content"] == "hello from the wire"
    # Attribution: the webhook PRINCIPAL is the author (native payload keeps
    # the integer author_id shape), with the override riding alongside.
    assert dispatch["d"]["author_id"] == Integer.to_string(webhook.id)
    # (`kind` stamps the message as a webhook's — Tier 3 B, 10b.)
    assert dispatch["d"]["author_override"] == %{"username" => "Wire Override", "kind" => "webhook"}

    # 2. Embed-only post renders via the embeds storage on the wire too.
    embed = %{"title" => "Deploy OK", "description" => "prod is green"}

    {204, nil} =
      post_json("/api/webhooks/#{webhook.id}/#{webhook.token}", %{"embeds" => [embed]})

    dispatch2 = next_frame(conn, 5_000) |> decode!
    assert dispatch2["t"] == "MessageCreate"
    assert dispatch2["d"]["content"] == ""
    assert dispatch2["d"]["embeds"] == [embed]
    refute Map.has_key?(dispatch2["d"], "author_override")
  end

  defp decode!({:ok, json}), do: json
  defp decode!({:closed, code}), do: flunk("connection closed (#{inspect(code)}) waiting for the dispatch")
end
