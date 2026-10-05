defmodule Cytale.Search.RebuildTest do
  @moduledoc """
  #89 — the drift check, the surgical repair, and the rebuild.

  The round trip this file exists for is the honest one: index a workspace,
  poison it two ways on purpose (rows the index never saw, and a document whose
  row is gone — the #76 ghost class), then prove that

    1. the drift check reports the right COUNTS and names the right IDS,
    2. the surgical repair clears the orphans WITHOUT a rebuild (the still-
       missing documents are the proof),
    3. a rebuild converges (the check reports zero drift and a search finds the
       message), and
    4. the scan pages: a small page size over more rows than one page sees
       every row exactly once — while the unpaged read it replaces does not.

  Uses a temp search root so tests never touch the real `priv/search`.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Search.{Drift, IndexWriter, Query, Rebuild, Scan, TantivyImpl}
  alias Cytale.{Messages, Workspaces}

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_rebuild_#{System.unique_integer([:positive])}")
    original = Application.get_env(:cytale, Cytale.Config)
    Application.put_env(:cytale, Cytale.Config, Keyword.put(original || [], :search_index_root, tmp))

    tracker = Cytale.Search.TestWriters.tracker!()

    on_exit(fn ->
      Cytale.Search.TestWriters.stop_all(tracker)

      if original == nil do
        Application.delete_env(:cytale, Cytale.Config)
      else
        Application.put_env(:cytale, Cytale.Config, original)
      end

      Cytale.Search.TestWriters.rm_rf(tmp)
    end)

    {:ok, tmp: tmp}
  end

  defp workspace_with_channel do
    {:ok, ws} = Workspaces.create_workspace(1, "Rebuild " <> Cytale.TestNonce.get())
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    track(ws.workspace_id)
    {ws.workspace_id, ch.channel_id}
  end

  defp track(workspace_id) do
    Cytale.Search.TestWriters.track(workspace_id)
    workspace_id
  end

  defp seed(channel_id, n, content \\ "deploy") do
    for i <- 1..n do
      {:ok, m} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: 1,
          content: "#{content} #{i}"
        })

      m
    end
  end

  defp filters(channel_id), do: %{visible_channels: [channel_id], members: [], channels: []}

  test "a healthy index reports exact counts and zero drift" do
    {ws, ch} = workspace_with_channel()
    msgs = seed(ch, 5)
    last_id = List.last(msgs).id

    assert {:ok, %{pages: 1, messages: 5}} = Rebuild.rebuild(ws)

    report = Drift.check(ws)

    assert report.documents == %{index: 5, messages: 5, delta: 0}
    assert report.missing.count == 0
    assert report.missing.ids == []
    assert report.orphaned.count == 0
    assert report.orphaned.ids == []
    assert report.content.mismatched_count == 0
    assert report.content.checked == 5
    assert report.content.truncated == false
    assert report.index_state.latest_message_id == last_id
    assert report.index_state.watermark == last_id
    assert report.clean
  end

  test "the drift check names the poisoned documents, and the repair clears the ghosts without a rebuild" do
    {ws, ch} = workspace_with_channel()
    seed(ch, 5)
    assert {:ok, _} = Rebuild.rebuild(ws)

    # Poison 1 — rows the index never saw: the index is fed by the fan-out, so
    # a message written while it lagged is simply absent from the index.
    late_ids = seed(ch, 2, "deploy late") |> Enum.map(& &1.id)

    # Poison 2 — a document whose row is gone: the #76 ghost class, indexed by
    # hand to stand in for a delete that reached ScyllaDB but never the index.
    ghost_id = 999_999_999_999_999

    :ok =
      TantivyImpl.index(ws, %{
        id: ghost_id,
        channel_id: ch,
        author_id: 1,
        content: "ghost deploy",
        thread_id: nil,
        created_at: DateTime.utc_now()
      })

    :ok = IndexWriter.commit_now({:workspace, ws})

    report = Drift.check(ws)

    assert report.documents == %{index: 6, messages: 7, delta: -1}
    assert report.missing.count == 2
    assert Enum.sort(report.missing.ids) == Enum.sort(late_ids)
    assert report.missing.truncated == false
    assert report.missing.order == :newest_first
    assert report.orphaned.count == 1
    assert report.orphaned.ids == [ghost_id]
    assert report.orphaned.order == :ascending_message_id
    refute report.clean

    # The surgical repair: the ids the check just named, unindexed directly.
    assert %{unindexed: 1, ids: [^ghost_id]} =
             Cytale.Search.repair_orphans(ws, report.orphaned.ids)

    repaired = Drift.check(ws)

    assert repaired.orphaned.count == 0
    assert repaired.orphaned.ids == []
    # Gone from SEARCH, not merely hidden by the reader's ghost guard.
    assert TantivyImpl.query(ws, Query.parse("ghost"), filters(ch)) == []
    # NO REBUILD HAPPENED: the two late documents are still missing, which is
    # exactly the proof — a rebuild would have swept them in.
    assert repaired.documents.index == 5
    assert Enum.sort(repaired.missing.ids) == Enum.sort(late_ids)

    # …and now the rebuild, which is the part that repairs what is missing.
    assert {:ok, %{messages: 7}} = Rebuild.rebuild(ws)

    final = Drift.check(ws)

    assert final.documents == %{index: 7, messages: 7, delta: 0}
    assert final.missing.ids == []
    assert final.orphaned.ids == []
    assert final.clean

    # The ticket's convergence guarantee: a search for a known message returns
    # it, and the drift report is zero.
    assert length(TantivyImpl.query(ws, Query.parse("deploy"), filters(ch))) == 7
  end

  test "the scan pages through the table instead of reading the first driver page" do
    {ws, ch} = workspace_with_channel()
    msgs = seed(ch, 7)
    expected = msgs |> Enum.map(& &1.id) |> Enum.sort()

    # Page size 2 over 7 rows = four pages, every row, ascending, no repeats.
    {stats, ids} =
      Scan.each_message_page(ws, [direction: :asc, page_size: 2], [], fn page, acc ->
        acc ++ Enum.map(page, & &1["message_id"])
      end)

    assert stats.pages == 4
    assert stats.rows == 7
    assert stats.budget_hit == false
    assert ids == expected
    assert ids == Enum.uniq(ids)

    # THE TRAP, demonstrated on these same rows: a single unpaged read with a
    # small driver page hands back ONE row — that is what a rebuild built on
    # execute!/3 would have indexed, silently leaving six messages unsearchable.
    bucket = Messages.bucket_for(System.system_time(:millisecond))
    keyspace = Cytale.Repo.keyspace()

    statement =
      "SELECT message_id FROM #{keyspace}.messages WHERE channel_id = ? AND bucket = ?"

    first_page =
      Cytale.Repo.execute!(statement, [{"bigint", ch}, {"int", bucket}], page_size: 1)
      |> Enum.to_list()

    assert length(first_page) == 1

    # The paged read the rebuild actually uses follows the paging state to the
    # end: same statement, same page size, every row.
    every_row =
      Cytale.Repo.stream_rows!(statement, [{"bigint", ch}, {"int", bucket}], page_size: 1)
      |> Enum.to_list()

    assert length(every_row) == 7

    # And the rebuild really indexes all of them when the page is tiny, with
    # progress reported once per page.
    Process.put(:progress, [])

    assert {:ok, stats} =
             Rebuild.rebuild(ws,
               page_size: 2,
               on_page: fn page_stats -> Process.put(:progress, [page_stats | Process.get(:progress)]) end
             )

    assert stats.pages == 4
    assert stats.messages == 7

    assert Process.get(:progress) |> Enum.reverse() == [
             %{pages: 1, messages: 2},
             %{pages: 2, messages: 4},
             %{pages: 3, messages: 6},
             %{pages: 4, messages: 7}
           ]

    assert Drift.check(ws).clean
  end

  test "a bounded sample reports truncation instead of claiming clean" do
    {ws, ch} = workspace_with_channel()
    seed(ch, 7)
    assert {:ok, _} = Rebuild.rebuild(ws)

    # One more row, never indexed, so the newest-first db sample holds it.
    [late] = seed(ch, 1, "deploy late")

    report = Drift.check(ws, sample_limit: 3)

    # The counts stay exact at any sample size…
    assert report.documents == %{index: 7, messages: 8, delta: -1}
    # …the missing id is still named exactly (a point lookup decides, because
    # the index walk did not cover the whole index)…
    assert report.missing.ids == [late.id]
    assert report.missing.count == 1
    assert report.missing.sampled == 3
    assert report.missing.sample_limit == 3
    assert report.missing.truncated == true
    # …and the samples say so rather than implying the workspace is fine.
    assert report.orphaned.sampled == 3
    assert report.orphaned.truncated == true
    assert report.content.truncated == true
    refute report.clean

    # Widen the sample and the same workspace is provably drifted by exactly
    # one missing document: nothing truncated, nothing orphaned.
    wide = Drift.check(ws, sample_limit: 500)

    assert wide.missing.ids == [late.id]
    assert wide.missing.truncated == false
    assert wide.orphaned.truncated == false
    refute wide.clean

    assert {:ok, _} = Rebuild.rebuild(ws)
    assert Drift.check(ws).clean
  end

  test "an edited row is named as a content mismatch, and the rebuild heals it" do
    {ws, ch} = workspace_with_channel()
    [first | _] = seed(ch, 2)
    assert {:ok, _} = Rebuild.rebuild(ws)

    :ok = Messages.edit_message(ch, first.id, "edited after indexing")

    report = Drift.check(ws)

    # A stale document is still a document: the counts agree, the text does not.
    assert report.documents.delta == 0
    assert report.content.mismatched_ids == [first.id]
    assert report.content.mismatched_count == 1
    assert report.content.checked == 2
    refute report.clean

    assert {:ok, _} = Rebuild.rebuild(ws)
    assert Drift.check(ws).clean
  end

  test "an empty workspace is a no-op, not an error" do
    {ws, _ch} = workspace_with_channel()

    assert {:ok, %{pages: 0, messages: 0, to: nil, truncated: false}} = Rebuild.rebuild(ws)

    report = Drift.check(ws)
    assert report.documents == %{index: 0, messages: 0, delta: 0}
    assert report.clean
  end

  test "the fan-out's reconcile replays forward through the same path" do
    {ws, ch} = workspace_with_channel()
    seed(ch, 3)

    # No writer yet → watermark 0 → everything replays; the second call has
    # nothing newer than the watermark.
    assert {:ok, 3} = TantivyImpl.reconcile(ws)
    assert {:ok, 0} = TantivyImpl.reconcile(ws)

    seed(ch, 1, "deploy newer")
    assert {:ok, 1} = TantivyImpl.reconcile(ws)

    assert Drift.check(ws).clean
  end

  test "the drift check does not read a 2900-bucket scan for a fresh workspace" do
    {ws, ch} = workspace_with_channel()
    seed(ch, 1)

    # The bucket floor is the workspace's own creation: a fresh workspace
    # spans exactly one 7-day bucket, so the check's per-bucket count is one
    # query per channel, not one per bucket since the epoch.
    assert Scan.latest_message_id(ws) != nil
    assert Scan.count_messages(ws) == 1

    assert Drift.check(ws).documents.messages == 1
  end
end
