defmodule CytaleWeb.Controllers.SearchControllerTest do
  @moduledoc """
  U9 slice 3 — search route contract: handlers answer 501 with a stable
  `search_not_available` key until U13's Tantivy NIF lands. Clients
  feature-detect on the key.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} = User.create(run_unique("search_user"), run_unique("search_user@example.com"), "password-123")
    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    ws_conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Search WS")})
    assert ws_conn.status == 201
    ws_id = get_in(Jason.decode!(ws_conn.resp_body), ["workspace", "id"]) || Jason.decode!(ws_conn.resp_body)["id"]

    {:ok, conn: conn, ws_id: ws_id}
  end

  test "workspace search → 200 with results (U13 fills the handler)", %{conn: conn, ws_id: ws_id} do
    conn = get(conn, "/api/v1/workspaces/#{ws_id}/search?q=anything")
    assert conn.status == 200
    assert %{"results" => results} = Jason.decode!(conn.resp_body)
    assert is_list(results)
  end

  test "the visibility computation does not scale with the channel count (plan 5.9)", %{
    conn: conn
  } do
    # The workspace search gate resolves VIEW_CHANNEL once for the whole channel
    # set. It used to resolve the member's roles and then read the channel's
    # OVERWRITES once per channel — a 50-channel workspace paid 50 reads before
    # Tantivy was even consulted — and it listed the channels twice per request.
    #
    # The searcher is a NON-OWNER member: an owner's bits short-circuit before
    # any overwrite is read, which would make this gate vacuous.
    {:ok, owner} = User.create(run_unique("search_owner"), run_unique("search_owner@example.com"), "password-123")
    me = user_of(conn)

    {:ok, ws} = Cytale.Workspaces.create_workspace(owner.user_id, run_unique("Search Gates WS"))
    :ok = Cytale.Workspaces.add_member(ws.workspace_id, me, owner.user_id)
    {:ok, _first} = Cytale.Workspaces.create_channel(ws.workspace_id, "probe-0")
    ws_id = Integer.to_string(ws.workspace_id)

    {_body, one} = statements_of(fn -> get(conn, "/api/v1/workspaces/#{ws_id}/search?q=probe") end)

    for i <- 1..11 do
      {:ok, _ch} = Cytale.Workspaces.create_channel(ws.workspace_id, "probe-#{i}")
    end

    {_body, twelve} = statements_of(fn -> get(conn, "/api/v1/workspaces/#{ws_id}/search?q=probe") end)

    overwrites_one = Enum.count(one, &String.contains?(&1, "channel_overwrites"))
    overwrites_twelve = Enum.count(twelve, &String.contains?(&1, "channel_overwrites"))

    assert overwrites_one == 1 and overwrites_twelve == 1,
           "the overwrites read scaled with channels: #{overwrites_one} → #{overwrites_twelve}"

    # The whole request is bounded too: one channel and twelve cost the same
    # number of statements (the channels LIST is one read either way).
    assert length(twelve) == length(one),
           "the search request scaled with channels: #{length(one)} → #{length(twelve)}"

    # …and the channels really were created (so the comparison is not vacuous).
    assert length(Cytale.Workspaces.list_channels(ws.workspace_id)) == 12
  end

  # The authenticated user's id, from the token the setup minted.
  defp user_of(conn) do
    [_, token] = conn.req_headers |> Enum.find(&(elem(&1, 0) == "authorization")) |> elem(1) |> String.split(" ")
    {:ok, claims} = Auth.verify_access_token(token)
    claims.user_id
  end

  # Every statement THIS request executes while `fun` runs, as text: issued by
  # the test process (ConnTest runs the request in it) or a task it spawned
  # (`$callers`). The handler is global, so without the filter a query from
  # any other process landing in the window counted too (#171: "scaled with
  # channels: 11 → 9", fewer statements for twelve channels than for one).
  defp statements_of(fun) do
    parent = self()
    ref = make_ref()
    handler_id = "search-test-stmts-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler_id,
        [:xandra, :execute_query, :start],
        fn _event, _measurements, metadata, ^parent ->
          if self() == parent or parent in (Process.get(:"$callers") || []) do
            send(parent, {:stmt, ref, statement_text(metadata.query)})
          end
        end,
        parent
      )

    result = fun.()
    stmts = drain_statements(ref)
    :ok = :telemetry.detach(handler_id)
    {result, stmts}
  end

  defp drain_statements(ref) do
    receive do
      {:stmt, ^ref, text} -> [text | drain_statements(ref)]
    after
      50 -> []
    end
  end

  defp statement_text(%Xandra.Batch{queries: queries}),
    do: Enum.map_join(queries, "; ", &Map.get(&1, :statement, ""))

  defp statement_text(query), do: Map.get(query, :statement)

  test "dm search → 501 search_not_available (DM segment not yet wired)", %{conn: conn} do
    conn = get(conn, "/api/v1/dm/search?q=anything")
    assert conn.status == 501
    assert %{"error" => %{"key" => "search_not_available"}} = Jason.decode!(conn.resp_body)
  end
end
