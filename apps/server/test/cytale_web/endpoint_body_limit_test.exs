defmodule CytaleWeb.EndpointBodyLimitTest do
  @moduledoc """
  C-5a — the endpoint's JSON body parser cap: JSON requests over 2 MB are
  refused with 413 (Plug.Parsers.RequestTooLargeError renders through the
  endpoint's JSON error view on BOTH the native and the compat surface —
  never an unstyled 500). The legitimate max is ~80 KB of embeds; the cap is
  a flood/abuse bound. Multipart keeps its own cap — attachment uploads are
  unaffected.

  The 413 legs drive the REAL Bandit listener (the in-process ConnTest
  dispatch surfaces Plug's re-raise instead of the wire response).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  @oversized String.duplicate("x", 2_100_000)

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp endpoint_port, do: Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]

  defp base_url, do: "http://127.0.0.1:#{endpoint_port()}"

  defp post_raw_json(path, body) do
    req = Finch.build(:post, base_url() <> path, [{"content-type", "application/json"}], body)
    {:ok, %Finch.Response{status: status, body: resp_body}} = Finch.request(req, CytaleTest.Finch)
    {status, if(resp_body == "", do: nil, else: Jason.decode!(resp_body))}
  end

  defp json_conn do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  setup do
    {:ok, owner} = User.create(run_unique("cap_owner"), run_unique("cap_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("cap-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, %{token: token}} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Cap Bot"))

    {:ok, ch_id: Integer.to_string(ch.channel_id), token: token}
  end

  test "oversized JSON body on a native route → 413 with a sane JSON envelope" do
    {status, body} = post_raw_json("/api/v1/channels/123456789012345678/messages", @oversized)

    assert status == 413
    assert %{"errors" => %{"detail" => detail}} = body
    assert is_binary(detail)
  end

  test "oversized JSON body on a compat route → 413 with a sane JSON envelope" do
    {status, body} = post_raw_json("/api/v10/channels/123456789012345678/messages", @oversized)

    assert status == 413
    assert %{"errors" => %{"detail" => detail}} = body
    assert is_binary(detail)
  end

  test "the cap stays far above the legitimate ceiling: a max-embeds send still passes", %{
    ch_id: ch_id,
    token: token
  } do
    # 10 embeds × ~8 KB — the legitimate maximum (~80 KB) — must clear the
    # 2 MB parser cap comfortably and land as a normal 201.
    embeds = for _ <- 1..10, do: %{"description" => String.duplicate("x", 8_000)}

    conn =
      json_conn()
      |> put_req_header("authorization", "Bot " <> token)
      |> post("/api/v10/channels/#{ch_id}/messages", %{"content" => "embed wall", "embeds" => embeds})

    assert conn.status == 201
    assert length(Jason.decode!(conn.resp_body)["embeds"]) == 10
  end
end
