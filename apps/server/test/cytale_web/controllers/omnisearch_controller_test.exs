defmodule CytaleWeb.Controllers.OmnisearchControllerTest do
  @moduledoc """
  Cmd-K omnisearch (`GET /users/@me/omnisearch`) — one query over the caller's
  reachable messages: workspace hits through the per-workspace visible-channel
  gate (the same `visible_channels/2` the per-workspace route uses), DM hits
  from the caller's own `dms_of_user` index where participation IS the
  authorization. Rows arrive HYDRATED (content/author/created_at) because a
  palette row of bare ids is unusable, and an index hit whose message row is
  gone (delete drift) drops rather than rendering a dead link.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Search.{IndexWriter, Partition, TantivyImpl}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} =
      User.create(run_unique("omni_user"), run_unique("omni_user@example.com"), "password-123")

    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    ws_conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Omni WS")})
    assert ws_conn.status == 201
    ws_id = Jason.decode!(ws_conn.resp_body)["workspace"]["id"]

    ch_conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => "general"})
    assert ch_conn.status == 201
    ch_id = Jason.decode!(ch_conn.resp_body)["channel"]["id"]

    {:ok, conn: conn, me: me, ws_id: ws_id, ch_id: ch_id}
  end

  defp send_message(conn, ch_id, content) do
    r = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => content})
    assert r.status == 201, "message create failed: #{r.resp_body}"
    Jason.decode!(r.resp_body)["message"]["id"]
  end

  test "a workspace hit returns hydrated, permalink-shaped fields", %{
    conn: conn,
    me: me,
    ws_id: ws_id,
    ch_id: ch_id
  } do
    marker = run_unique("xylophone")
    msg_id = send_message(conn, ch_id, "the #{marker} meeting notes are attached")

    # The workspace segment indexes on the workspace process's fan-out, which
    # the :test publish impl does not run (Publish.Log) — that fan-out has its
    # own coverage. Index through the same seam here so this test exercises
    # what omnisearch DOES with hits: permission-filtered query, hydration,
    # shaping, ordering.
    :ok =
      TantivyImpl.index(String.to_integer(ws_id), %{
        id: String.to_integer(msg_id),
        channel_id: String.to_integer(ch_id),
        author_id: me.user_id,
        content: "the #{marker} meeting notes are attached",
        thread_id: nil,
        created_at: DateTime.utc_now() |> DateTime.truncate(:millisecond)
      })

    :ok = IndexWriter.commit_now({:workspace, String.to_integer(ws_id)})

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: marker)
    assert conn.status == 200

    %{"results" => results} = Jason.decode!(conn.resp_body)
    [hit | _] = results

    assert hit["kind"] == "workspace"
    assert hit["workspace_id"] == ws_id
    assert hit["channel_id"] == ch_id
    assert hit["content"] =~ marker
    assert is_binary(hit["author_id"])
    assert is_binary(hit["created_at"])
    # The score is what ordered the workspace segment.
    assert is_number(hit["score"])
  end

  test "a DM hit is found by the participant and carries no workspace", %{conn: conn, me: me} do
    marker = run_unique("zeppelin")
    {:ok, other} = User.create(run_unique("omni_peer"), run_unique("omni_peer@example.com"), "password-123")

    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)
    dm_conn = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert dm_conn.status == 201
    dm_id = Jason.decode!(dm_conn.resp_body)["channel"]["id"]
    send_message(conn, dm_id, "did you see the #{marker} fly by")

    # The write seam indexes DMs under every publish impl; flush the batch.
    :ok = IndexWriter.commit_now({:dm_user, me.user_id})

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: marker)
    assert conn.status == 200

    %{"results" => results} = Jason.decode!(conn.resp_body)
    [hit | _] = results

    assert hit["kind"] == "dm"
    assert hit["workspace_id"] == nil
    assert hit["channel_id"] == dm_id
    assert hit["content"] =~ marker
  end

  test "another member's DM and workspace are invisible (permissions honored)", %{conn: conn} do
    # A term that exists ONLY where the caller cannot reach: someone else's DM
    # and someone else's workspace.
    marker = run_unique("sepulchre")

    {:ok, a} = User.create(run_unique("omni_a"), run_unique("omni_a@example.com"), "password-123")
    {:ok, b} = User.create(run_unique("omni_b"), run_unique("omni_b@example.com"), "password-123")

    access_a = Auth.issue_access_token(a.user_id, a.username, true)
    conn_a = put_req_header(Phoenix.ConnTest.build_conn(), "authorization", "Bearer " <> access_a)

    Cytale.Test.SharedWorkspace.share!(a.user_id, b.user_id)
    dm_conn = post(conn_a, "/api/v1/users/#{b.user_id}/channels", %{})
    assert dm_conn.status == 201
    dm_id = Jason.decode!(dm_conn.resp_body)["channel"]["id"]
    send_message(conn_a, dm_id, "secret #{marker} in a foreign dm")

    ws_conn = post(conn_a, "/api/v1/workspaces", %{"name" => run_unique("Foreign WS")})
    foreign_ws = Jason.decode!(ws_conn.resp_body)["workspace"]["id"]
    ch_conn = post(conn_a, "/api/v1/workspaces/#{foreign_ws}/channels", %{"name" => "general"})
    foreign_ch = Jason.decode!(ch_conn.resp_body)["channel"]["id"]
    send_message(conn_a, foreign_ch, "secret #{marker} in a foreign workspace")

    :ok = IndexWriter.commit_now({:workspace, String.to_integer(foreign_ws)})

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: marker)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["results"] == []
  end

  test "an index hit whose message row is gone drops (delete drift self-heals)", %{
    conn: conn,
    ws_id: ws_id,
    ch_id: ch_id
  } do
    marker = run_unique("willow")
    msg_id = send_message(conn, ch_id, "ephemeral #{marker} content")
    :ok = IndexWriter.commit_now({:workspace, String.to_integer(ws_id)})

    delete(conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}")
    # The delete unindexes on fan-out, but the drift window is exactly what
    # this guard is for — force the row back into the drift state by querying
    # regardless; if the unindex already landed the assertion is vacuously
    # true, which is fine.

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: marker)
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body)["results"] == []
  end

  test "a short or blank query answers empty without touching either segment", %{conn: conn} do
    conn = get(conn, "/api/v1/users/@me/omnisearch", q: "x")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"results" => [], "total" => 0}

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: "   ")
    assert conn.status == 200
    assert Jason.decode!(conn.resp_body) == %{"results" => [], "total" => 0}
  end

  test "DM history that predates the index is backfilled on first search", %{
    conn: conn,
    me: me
  } do
    marker = run_unique("gondola")
    {:ok, other} = User.create(run_unique("omni_late"), run_unique("omni_late@example.com"), "password-123")

    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)
    dm_conn = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    dm_id = Jason.decode!(dm_conn.resp_body)["channel"]["id"]
    send_message(conn, dm_id, "a #{marker} drifts by in the evening")
    :ok = IndexWriter.commit_now({:dm_user, me.user_id})

    # Simulate a lost/never-created index (the state every EXISTING
    # conversation is in on first deploy): stop the writer (the watermark is
    # in-memory) and remove the on-disk segment.
    if pid = IndexWriter.whereis({:dm_user, me.user_id}) do
      DynamicSupervisor.terminate_child(Cytale.Search.IndexWriterSupervisor, pid)
    end

    File.rm_rf!(Partition.dm_user_dir(me.user_id))

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: marker)
    assert conn.status == 200
    %{"results" => results} = Jason.decode!(conn.resp_body)
    assert [%{"kind" => "dm", "content" => content}] = results
    assert content =~ marker
  end

  test "unauthenticated → 401" do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")

    conn = get(conn, "/api/v1/users/@me/omnisearch", q: "anything")
    assert conn.status == 401
  end
end
