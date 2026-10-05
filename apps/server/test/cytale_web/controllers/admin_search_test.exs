defmodule CytaleWeb.Controllers.AdminSearchTest do
  @moduledoc """
  #89 — the operator surface for search-index maintenance: the drift report,
  the surgical repair, and the operator-triggered rebuild with its job list.

  ## Why some requests here bypass `Router`

  The four routes this surface needs live in `router.ex`, which this unit was
  told NOT to edit (another agent owns the file during this window). So each
  helper below asks the router whether the path is wired: when it is, the
  request goes over real HTTP with the `:operator` pipeline; when it is not,
  the SAME controller action is called directly (identical params, statuses and
  bodies — only the routing layer differs). Wire the reported route block and
  every assertion in this file runs over HTTP unchanged.

  The operator gate is asserted directly on `RequireOperator` in both cases, so
  the fail-closed behavior of this surface is never left untested.
  """

  use Cytale.ScyllaCase, async: false

  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Search.{IndexWriter, Rebuild, RebuildRunner, TantivyImpl}
  alias Cytale.{Messages, Workspaces}
  alias CytaleWeb.AdminController
  alias CytaleWeb.Plugs.RequireOperator

  @status_path "/api/v1/admin/workspaces/:workspace_id/search/status"
  @repair_path "/api/v1/admin/workspaces/:workspace_id/search/repair"
  @rebuild_path "/api/v1/admin/workspaces/:workspace_id/search/rebuild"
  @rebuilds_path "/api/v1/admin/search/rebuilds"

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: Cytale.TestNonce.get()

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_admin_search_#{System.unique_integer([:positive])}")
    original = Application.get_env(:cytale, Cytale.Config)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(original || [], :search_index_root, tmp))

    {:ok, operator} =
      User.create("adm_ops_" <> run_nonce(), "adm_ops_#{run_nonce()}@example.com", "password-123")

    {:ok, outsider} =
      User.create("adm_out_" <> run_nonce(), "adm_out_#{run_nonce()}@example.com", "password-123")

    # The allowlist names the operator only; always restored (global env).
    Application.put_env(:cytale, :operator_user_ids, [operator.user_id])

    tracker = Cytale.Search.TestWriters.tracker!()

    on_exit(fn ->
      Cytale.Search.TestWriters.stop_all(tracker)

      Application.put_env(:cytale, :operator_user_ids, [])

      if original == nil do
        Application.delete_env(:cytale, Cytale.Config)
      else
        Application.put_env(:cytale, Cytale.Config, original)
      end

      Cytale.Search.TestWriters.rm_rf(tmp)
    end)

    {:ok, operator: operator, outsider: outsider}
  end

  # -- fixtures ------------------------------------------------------------------

  defp workspace_with_channel do
    {:ok, ws} = Workspaces.create_workspace(1, "Admin Search " <> run_nonce())
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    Cytale.Search.TestWriters.track(ws.workspace_id)
    {ws.workspace_id, ch.channel_id}
  end

  defp seed(channel_id, n, content \\ "deploy") do
    for i <- 1..n do
      {:ok, m} =
        Messages.create_message(%{channel_id: channel_id, author_id: 1, content: "#{content} #{i}"})

      m
    end
  end

  defp authed_conn(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
    |> assign(:current_user, %{user_id: user.user_id, username: user.username})
  end

  defp put_config(key, value) do
    current = Application.get_env(:cytale, Cytale.Config) || []
    Application.put_env(:cytale, Cytale.Config, Keyword.put(current, key, value))
  end

  # Route-detect: real HTTP once the block is pasted into router.ex, otherwise
  # the controller action directly. See the moduledoc.
  defp wired?(path) do
    Enum.any?(CytaleWeb.Router.__routes__(), &(&1.path == path))
  end

  defp search_status(conn, workspace_id) do
    if wired?(@status_path) do
      Phoenix.ConnTest.get(conn, concrete(@status_path, workspace_id))
    else
      AdminController.search_status(conn, %{"workspace_id" => Integer.to_string(workspace_id)})
    end
  end

  defp search_repair(conn, workspace_id, body) do
    if wired?(@repair_path) do
      Phoenix.ConnTest.post(conn, concrete(@repair_path, workspace_id), body)
    else
      AdminController.search_repair(
        conn,
        Map.put(body, "workspace_id", Integer.to_string(workspace_id))
      )
    end
  end

  defp search_rebuild(conn, workspace_id) do
    if wired?(@rebuild_path) do
      Phoenix.ConnTest.post(conn, concrete(@rebuild_path, workspace_id), %{})
    else
      AdminController.search_rebuild(conn, %{"workspace_id" => Integer.to_string(workspace_id)})
    end
  end

  defp search_rebuilds(conn, query) do
    if wired?(@rebuilds_path) do
      Phoenix.ConnTest.get(conn, "/api/v1/admin/search/rebuilds?" <> URI.encode_query(query))
    else
      AdminController.search_rebuilds(conn, query)
    end
  end

  defp concrete(path, workspace_id), do: String.replace(path, ":workspace_id", Integer.to_string(workspace_id))

  defp body(conn), do: Jason.decode!(conn.resp_body)

  defp wait_for_job(job_id, timeout \\ 20_000) do
    deadline = System.monotonic_time(:millisecond) + timeout
    do_wait(job_id, deadline, [])
  end

  defp do_wait(job_id, deadline, seen) do
    job = RebuildRunner.get(job_id)
    seen = [{job.status, job.pages, job.messages} | seen]

    cond do
      job.status != :running ->
        {job, seen}

      System.monotonic_time(:millisecond) > deadline ->
        flunk("rebuild #{job_id} never finished")

      true ->
        Process.sleep(5)
        do_wait(job_id, deadline, seen)
    end
  end

  # -- the gate ------------------------------------------------------------------

  test "the operator gate is fail-closed for this surface", %{operator: operator, outsider: outsider} do
    # Unlisted account → 403, even authenticated and verified.
    assert %Plug.Conn{halted: true, status: 403} = RequireOperator.call(authed_conn(outsider), [])

    # Listed account → the request proceeds.
    refute RequireOperator.call(authed_conn(operator), []).halted

    # And with no allowlist configured, even the would-be operator is denied.
    Application.put_env(:cytale, :operator_user_ids, [])
    assert %Plug.Conn{halted: true, status: 403} = RequireOperator.call(authed_conn(operator), [])
  end

  # -- the drift report ----------------------------------------------------------

  test "GET search/status reports the counts AND the ids, not just a number", %{operator: operator} do
    {ws, ch} = workspace_with_channel()
    seed(ch, 4)
    assert {:ok, _} = Rebuild.rebuild(ws)

    # Poison: one row the index never saw, one document whose row is gone.
    [late] = seed(ch, 1, "deploy late")
    ghost_id = 999_999_999_999_998
    index_doc(ws, ch, ghost_id, "ghost deploy")
    :ok = IndexWriter.commit_now({:workspace, ws})

    conn = search_status(authed_conn(operator), ws)
    assert conn.status == 200

    report = body(conn)["drift"]

    # Exact counts: the two poisons cancel in the delta, which is exactly why
    # the sampled ids are the deliverable.
    assert report["documents"] == %{"index" => 5, "messages" => 5, "delta" => 0}
    assert report["missing"]["ids"] == [Integer.to_string(late.id)]
    assert report["missing"]["count"] == 1
    assert report["missing"]["order"] == "newest_first"
    assert report["missing"]["truncated"] == false
    assert report["orphaned"]["ids"] == [Integer.to_string(ghost_id)]
    assert report["orphaned"]["count"] == 1
    assert report["orphaned"]["order"] == "ascending_message_id"
    assert report["clean"] == false
    # The index is BEHIND: the last message it holds is the last one the
    # rebuild indexed, and the newest row is not in it (that is the `missing`
    # sample). A watermark equal to the latest id would be a lie here.
    assert report["index_state"]["latest_message_id"] == Integer.to_string(late.id)
    refute report["index_state"]["watermark"] == report["index_state"]["latest_message_id"]

    # A rebuild repairs what is MISSING and never removes orphans (nothing in
    # an upsert walk deletes — the repair endpoint is that half). So after it:
    # no missing ids, the watermark caught up to the newest row, and the ghost
    # still named.
    assert {:ok, _} = Rebuild.rebuild(ws)
    caught_up = body(search_status(authed_conn(operator), ws))["drift"]

    assert caught_up["missing"]["ids"] == []
    assert caught_up["orphaned"]["ids"] == [Integer.to_string(ghost_id)]
    assert caught_up["index_state"]["watermark"] == caught_up["index_state"]["latest_message_id"]
    assert caught_up["clean"] == false
  end

  test "GET search/status on an unknown workspace answers 404", %{operator: operator} do
    conn = search_status(authed_conn(operator), 123_456_789_012_345_678)
    assert conn.status == 404
    assert body(conn)["error"]["key"] == "workspace_not_found"
  end

  # -- the surgical repair -------------------------------------------------------

  test "POST search/repair unindexes the ids the check named — without a rebuild", %{operator: operator} do
    {ws, ch} = workspace_with_channel()
    seed(ch, 3)
    assert {:ok, _} = Rebuild.rebuild(ws)

    ghost_id = 999_999_999_999_997
    index_doc(ws, ch, ghost_id, "ghost deploy")
    :ok = IndexWriter.commit_now({:workspace, ws})

    # Explicit ids (the drift report's `orphaned.ids` are the input).
    conn = search_repair(authed_conn(operator), ws, %{"ids" => [Integer.to_string(ghost_id)]})
    assert conn.status == 200

    repaired = body(conn)
    assert repaired["unindexed"] == 1
    assert repaired["ids"] == [Integer.to_string(ghost_id)]
    # The response carries the verification, not just the action.
    assert repaired["after"]["orphaned"]["ids"] == []
    assert repaired["after"]["documents"]["index"] == 3
    assert repaired["after"]["clean"] == true
  end

  test "POST search/repair with no ids repairs what the check finds right now", %{operator: operator} do
    {ws, ch} = workspace_with_channel()
    seed(ch, 2)
    assert {:ok, _} = Rebuild.rebuild(ws)

    ghost_id = 999_999_999_999_996
    index_doc(ws, ch, ghost_id, "ghost deploy")
    :ok = IndexWriter.commit_now({:workspace, ws})

    conn = search_repair(authed_conn(operator), ws, %{})
    assert conn.status == 200
    assert body(conn)["unindexed"] == 1
    assert body(conn)["after"]["orphaned"]["ids"] == []
  end

  test "POST search/repair rejects a non-numeric id", %{operator: operator} do
    {ws, _ch} = workspace_with_channel()

    conn = search_repair(authed_conn(operator), ws, %{"ids" => ["not-an-id"]})
    assert conn.status == 400
    assert body(conn)["error"]["key"] == "validation_failed"
  end

  # -- the rebuild: 202 + job id, 409 while one runs, progress visible -----------

  test "POST search/rebuild answers 202 with a job id, and the job list shows it finishing", %{
    operator: operator
  } do
    {ws, ch} = workspace_with_channel()
    seed(ch, 9)
    put_config(:search_rebuild_page_size, 2)
    # Deliberately NOT indexed first: the rebuild is the repair.

    conn = search_rebuild(authed_conn(operator), ws)
    assert conn.status == 202

    accepted = body(conn)
    job_id = accepted["job"]["id"]
    assert is_binary(job_id)
    assert accepted["job"]["status"] == "running"
    assert accepted["job"]["workspace_id"] == Integer.to_string(ws)

    {finished, seen} = wait_for_job(job_id)

    # Progress is the deliverable: pages and messages advance while it runs, and
    # the page count matches the configured page size over 9 rows.
    assert finished.status == :ok
    assert finished.pages == 5
    assert finished.messages == 9
    assert finished.pages == Enum.max(Enum.map(seen, fn {_s, pages, _m} -> pages end))

    # An operator watching the list sees the same numbers.
    list_conn = search_rebuilds(authed_conn(operator), %{"workspace_id" => Integer.to_string(ws)})
    assert list_conn.status == 200

    listed = body(list_conn)
    assert listed["running"] == nil
    assert [job | _] = listed["rebuilds"]
    assert job["id"] == job_id
    assert job["status"] == "ok"
    assert job["pages"] == 5
    assert job["messages"] == 9
    assert job["started_at"] != nil
    assert job["finished_at"] != nil

    # And the rebuild actually converged: zero drift, search finds the row.
    assert Cytale.Search.drift(ws).clean
  end

  test "a second rebuild while one runs answers 409 with the running job's id", %{operator: operator} do
    {ws, ch} = workspace_with_channel()
    seed(ch, 100)
    # One message per page keeps the job running long enough to race it, and
    # makes progress observable at a fine grain.
    put_config(:search_rebuild_page_size, 1)

    first = search_rebuild(authed_conn(operator), ws)
    assert first.status == 202
    job_id = body(first)["job"]["id"]

    second = search_rebuild(authed_conn(operator), ws)
    assert second.status == 409

    conflict = body(second)
    assert conflict["error"]["key"] == "rebuild_in_progress"
    assert conflict["error"]["job"]["id"] == job_id

    # One at a time IN TOTAL: a different workspace is refused too.
    {other_ws, _} = workspace_with_channel()
    third = search_rebuild(authed_conn(operator), other_ws)
    assert third.status == 409
    assert body(third)["error"]["job"]["id"] == job_id

    # Progress advances while it runs: the polls see the counters grow.
    {finished, seen} = wait_for_job(job_id)

    running_pages =
      seen
      |> Enum.reverse()
      |> Enum.filter(fn {status, _pages, _messages} -> status == :running end)
      |> Enum.map(&elem(&1, 1))

    assert finished.status == :ok
    assert finished.messages == 100
    assert running_pages != [], "expected to observe the job while it was running"
    assert Enum.uniq(running_pages) |> length() >= 2, "expected progress to advance between polls"
    assert running_pages == Enum.sort(running_pages)
  end

  test "each rebuild page emits telemetry, so /metrics can show the rebuild moving", %{operator: operator} do
    {ws, ch} = workspace_with_channel()
    seed(ch, 5)
    put_config(:search_rebuild_page_size, 2)

    parent = self()

    :telemetry.attach(
      "rebuild-page-test",
      [:cytale, :search, :rebuild, :page],
      &__MODULE__.forward_page_event/4,
      parent
    )

    on_exit(fn -> :telemetry.detach("rebuild-page-test") end)

    conn = search_rebuild(authed_conn(operator), ws)
    assert conn.status == 202
    {finished, _seen} = wait_for_job(body(conn)["job"]["id"])
    assert finished.status == :ok

    events =
      for _ <- 1..finished.pages do
        assert_receive {:telemetry, [:cytale, :search, :rebuild, :page], measurements, metadata}, 2_000
        {measurements, metadata}
      end

    assert length(events) == 3
    assert Enum.all?(events, fn {m, _} -> is_integer(m.count) and m.count > 0 and m.duration_ms >= 0 end)
    assert Enum.all?(events, fn {_, meta} -> meta.workspace_id == ws and is_binary(meta.job_id) end)

    # #87's scrape surface renders `Cytale.Telemetry.Stats.snapshot/0` — the new
    # metric has to be in it for a rebuild to be visible on /metrics.
    assert Map.has_key?(Cytale.Telemetry.Stats.snapshot(), :search_rebuild_page_ms)
  end

  # -- helpers -------------------------------------------------------------------

  @doc false
  def forward_page_event(event, measurements, metadata, pid) do
    send(pid, {:telemetry, event, measurements, metadata})
  end

  defp index_doc(workspace_id, channel_id, message_id, content) do
    TantivyImpl.index(workspace_id, %{
      id: message_id,
      channel_id: channel_id,
      author_id: 1,
      content: content,
      thread_id: nil,
      created_at: DateTime.utc_now()
    })
  end
end
