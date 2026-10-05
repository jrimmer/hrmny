defmodule Cytale.Search.IndexWriterTest do
  @moduledoc """
  U13 slice 2 — the per-workspace index writer: batched commits, watermark
  tracking, and reconciliation against ScyllaDB. Uses a temp search root and
  the ScyllaCase DB-backed setup (schema applied once at boot).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Search.{IndexWriter, TantivyImpl}

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_search_writer_#{System.unique_integer([:positive])}")
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

  defp track(w) do
    Cytale.Search.TestWriters.track(w)
    w
  end

  defp ws_id, do: track(:erlang.phash2(Cytale.TestNonce.get(), 999_999) + 1)

  defp seed_workspace_channel(w, ch) do
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces (workspace_id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
      [{"bigint", w}, {"text", "reconcile-ws"}, {"bigint", 1}, {"timestamp", now}]
    )

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.channels (workspace_id, channel_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", w},
        {"bigint", ch},
        {"text", "general"},
        {"int", 0},
        {"bigint", nil},
        {"text", nil},
        {"int", 0},
        {"bigint", 1},
        {"timestamp", now},
        {"bigint", nil}
      ]
    )
  end

  defp msg(id, channel, author, content, opts \\ []) do
    %{
      id: id,
      channel_id: channel,
      author_id: author,
      content: content,
      thread_id: Keyword.get(opts, :thread_id),
      created_at: Keyword.get(opts, :created_at, DateTime.utc_now())
    }
  end

  test "batched commit: messages become searchable after commit_now" do
    w = ws_id()
    ch = 10

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, ch, 100, "deploy finished"))

    # Not yet committed → not searchable.
    assert TantivyImpl.query(w, %{term: "deploy", from: nil, in: nil, after: nil, before: nil}, %{
             visible_channels: [ch],
             members: [],
             channels: []
           }) == []

    :ok = IndexWriter.commit_now({:workspace, w})

    results =
      TantivyImpl.query(w, %{term: "deploy", from: nil, in: nil, after: nil, before: nil}, %{
        visible_channels: [ch],
        members: [],
        channels: []
      })

    assert length(results) == 2
  end

  test "watermark tracks the last committed message_id" do
    w = ws_id()
    ch = 10

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, ch, 100, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    assert IndexWriter.watermark({:workspace, w}) == 2
  end

  test "the watermark survives a writer restart (review #24)" do
    w = ws_id()
    key = {:workspace, w}

    :ok = TantivyImpl.index(w, msg(41, 10, 100, "deploy finished"))
    :ok = IndexWriter.commit_now(key)
    assert IndexWriter.watermark(key) == 41

    :ok = DynamicSupervisor.terminate_child(Cytale.Search.IndexWriterSupervisor, IndexWriter.whereis(key))
    {:ok, _pid} = IndexWriter.ensure_started(key)

    # It was in-memory only: a restart used to read nil, and a reconcile from
    # there replays the workspace from its first message.
    assert IndexWriter.watermark(key) == 41
  end

  test "the writer's own reconcile run heals a message that was never indexed (review #24)" do
    w = ws_id()
    ch = 10
    seed_workspace_channel(w, ch)

    {:ok, lost} =
      Cytale.Messages.create_message(%{channel_id: ch, author_id: 100, content: "healed by reconcile", thread_id: nil})

    {:ok, pid} = IndexWriter.ensure_started({:workspace, w})
    # What the writer's start timer (and then its interval) sends itself.
    send(pid, :reconcile)

    assert Enum.any?(1..100, fn _ ->
             Process.sleep(50)
             :ok = IndexWriter.commit_now({:workspace, w})

             TantivyImpl.query(w, %{term: "healed", from: nil, in: nil, after: nil, before: nil}, %{
               visible_channels: [ch],
               members: [],
               channels: []
             })
             |> Enum.any?(&(&1.message_id == lost.id))
           end),
           "the reconcile run never indexed the lost message"
  end

  test "delete_by_author removes the author's messages (U14 cascade)" do
    w = ws_id()
    ch = 10

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, ch, 200, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    :ok = TantivyImpl.delete_by_author(w, 100)
    :ok = IndexWriter.commit_now({:workspace, w})

    results =
      TantivyImpl.query(w, %{term: "deploy", from: nil, in: nil, after: nil, before: nil}, %{
        visible_channels: [ch],
        members: [],
        channels: []
      })

    assert [%{message_id: 2}] = results
  end

  test "reconcile replays the delta between watermark and ScyllaDB latest" do
    w = ws_id()
    ch = 10

    # Seed a workspace + channel in ScyllaDB.
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.workspaces (workspace_id, name, owner_id, created_at) VALUES (?, ?, ?, ?)",
      [{"bigint", w}, {"text", "reconcile-ws"}, {"bigint", 1}, {"timestamp", now}]
    )

    Cytale.Repo.execute!(
      "INSERT INTO #{Cytale.Repo.keyspace()}.channels (workspace_id, channel_id, name, type, parent_id, topic, position, created_by, created_at, last_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        {"bigint", w},
        {"bigint", ch},
        {"text", "general"},
        {"int", 0},
        {"bigint", nil},
        {"text", nil},
        {"int", 0},
        {"bigint", 1},
        {"timestamp", now},
        {"bigint", nil}
      ]
    )

    # A message persisted in ScyllaDB but never indexed (simulating a lost
    # commit inside the batch window).
    Cytale.Messages.create_message(%{
      channel_id: ch,
      author_id: 100,
      content: "deploy finished",
      thread_id: nil
    })

    # Reconcile: the writer's watermark is 0 (nothing indexed), ScyllaDB has
    # the message → replay it.
    {:ok, replayed} = TantivyImpl.reconcile(w)
    assert replayed >= 1

    :ok = IndexWriter.commit_now({:workspace, w})

    results =
      TantivyImpl.query(w, %{term: "deploy", from: nil, in: nil, after: nil, before: nil}, %{
        visible_channels: [ch],
        members: [],
        channels: []
      })

    assert length(results) >= 1
  end
end
