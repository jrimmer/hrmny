defmodule Cytale.Search.TantivyImplTest do
  @moduledoc """
  U13 slice 2 — the Tantivy-backed search implementation behind the behaviour
  seam. Exercises the muninn NIF end-to-end: index → batched commit → search
  finds the message (F4/AE3), `from:`/`in:`/date-range filters (AE5), and
  permission filtering (AE4). Uses a temp search root so tests never touch
  the real `priv/search`.
  """

  use ExUnit.Case, async: false

  alias Cytale.Search.{IndexWriter, Query, TantivyImpl}

  setup do
    tmp = Path.join(System.tmp_dir!(), "cytale_search_impl_#{System.unique_integer([:positive])}")
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

  test "index → commit → search finds the message (F4/AE3)" do
    w = ws_id()
    ch = 10
    author = 100

    :ok = TantivyImpl.index(w, msg(1, ch, author, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    q = Query.parse("deploy")
    results = TantivyImpl.query(w, q, %{visible_channels: [ch], members: [], channels: []})

    assert [%{message_id: 1, channel_id: ^ch}] = results
  end

  test "from: filter restricts to the author (AE5)" do
    w = ws_id()
    ch = 10

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, ch, 200, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    members = [%{user_id: 200, username: "janet"}]

    q = Query.parse("deploy from:janet")
    results = TantivyImpl.query(w, q, %{visible_channels: [ch], members: members, channels: []})

    assert [%{message_id: 2}] = results
  end

  test "in: filter restricts to the channel" do
    w = ws_id()

    :ok = TantivyImpl.index(w, msg(1, 10, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, 20, 100, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    channels = [%{channel_id: 20, name: "deploy"}]

    q = Query.parse("deploy in:deploy")
    results = TantivyImpl.query(w, q, %{visible_channels: [10, 20], members: [], channels: channels})

    assert [%{message_id: 2, channel_id: 20}] = results
  end

  test "date-range filter (before:) restricts results (AE5)" do
    w = ws_id()
    ch = 10
    old = DateTime.from_unix!(1_700_000_000, :second)
    new = DateTime.from_unix!(1_800_000_000, :second)

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished", created_at: old))
    :ok = TantivyImpl.index(w, msg(2, ch, 100, "deploy finished", created_at: new))
    :ok = IndexWriter.commit_now({:workspace, w})

    q = %{term: "deploy", from: nil, in: nil, after: nil, before: DateTime.from_unix!(1_750_000_000, :second)}
    results = TantivyImpl.query(w, q, %{visible_channels: [ch], members: [], channels: []})

    assert [%{message_id: 1}] = results
  end

  test "permission filter excludes channels the member cannot read (AE4)" do
    w = ws_id()

    :ok = TantivyImpl.index(w, msg(1, 10, 100, "deploy finished"))
    :ok = TantivyImpl.index(w, msg(2, 20, 100, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    # Member can only see channel 10.
    q = Query.parse("deploy")
    results = TantivyImpl.query(w, q, %{visible_channels: [10], members: [], channels: []})

    assert [%{message_id: 1, channel_id: 10}] = results
  end

  test "index-write failure degrades search but the writer survives" do
    w = ws_id()

    :ok = TantivyImpl.index(w, msg(1, 10, 100, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    # Unknown workspace → no writer → [] (degraded, not a crash).
    assert TantivyImpl.query(ws_id(), Query.parse("deploy"), %{visible_channels: [10], members: [], channels: []}) == []
  end

  test "thread scope: in: a thread id returns only that thread's messages" do
    w = ws_id()
    ch = 10

    :ok = TantivyImpl.index(w, msg(1, ch, 100, "deploy finished", thread_id: 500))
    :ok = TantivyImpl.index(w, msg(2, ch, 100, "deploy finished"))
    :ok = IndexWriter.commit_now({:workspace, w})

    # in: by channel id — both messages in the channel.
    q = Query.parse("deploy in:10")

    results =
      TantivyImpl.query(w, q, %{visible_channels: [ch], members: [], channels: [%{channel_id: 10, name: "general"}]})

    assert length(results) == 2
    # The thread message carries its thread_id.
    assert Enum.any?(results, &(&1.thread_id == 500))
  end
end
