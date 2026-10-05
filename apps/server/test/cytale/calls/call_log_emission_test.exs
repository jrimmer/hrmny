defmodule Cytale.Calls.CallLogEmissionTest do
  @moduledoc """
  Voice plan U4 — R5's server-side emission rule at the dual-emit site: a
  message posted to a channel's standing call-log thread fans out
  ThreadMessageCreate ONLY (the channel-anchored MessageCreate is
  suppressed), and Messages.history for the channel EXCLUDES call-log rows
  via the same `call_threads` mapping (REST hydration cannot leak them into
  the channel timeline). Ordinary thread replies keep the U12 dual emission.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls.Log
  alias Cytale.Messages
  alias Cytale.Messages.Message
  alias Cytale.Threads.Thread

  # Publish recorder: the seam's events land in the test mailbox.
  defmodule RecordingPublish do
    @behaviour Cytale.Publish

    @impl true
    def publish_user_update(_user_id, _event), do: :ok

    @impl true
    def publish(channel_id, event) do
      case :persistent_term.get({__MODULE__, :listener}, nil) do
        nil -> :ok
        pid -> send(pid, {:published, channel_id, event})
      end

      :ok
    end
  end

  setup do
    listener = self()
    :persistent_term.put({RecordingPublish, :listener}, listener)

    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, RecordingPublish)

    on_exit(fn ->
      :persistent_term.erase({RecordingPublish, :listener})

      case old_publish do
        nil -> Application.delete_env(:cytale, Cytale.Publish)
        v -> Application.put_env(:cytale, Cytale.Publish, v)
      end
    end)

    channel_id = Cytale.Snowflake.next()
    author_id = Cytale.Snowflake.next()
    {:ok, channel_id: channel_id, author_id: author_id}
  end

  defp drain_published(ms \\ 100) do
    receive do
      {:published, channel_id, {event, _payload}} ->
        [{event, channel_id} | drain_published(ms)]
    after
      ms -> []
    end
  end

  test "call-log thread message emits ThreadMessageCreate only (R5)", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, thread_id} = Log.ensure_thread(channel_id, author_id)

    assert {:ok, wire} =
             Message.send_message(%{
               channel_id: channel_id,
               author_id: author_id,
               content: "left the call",
               thread_id: thread_id
             })

    assert wire["thread_id"] == Integer.to_string(thread_id)

    events = drain_published()
    assert Enum.any?(events, &match?({"ThreadMessageCreate", ch} when ch == channel_id, &1))
    refute Enum.any?(events, &match?({"MessageCreate", ch} when ch == channel_id, &1))
  end

  test "ordinary thread replies keep the U12 dual emission; channel messages stay single", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, parent_msg} = Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: "root"})
    {:ok, thread} = Thread.start(channel_id, parent_msg.id, "Ordinary thread", author_id)

    assert {:ok, _} =
             Message.send_message(%{
               channel_id: channel_id,
               author_id: author_id,
               content: "reply",
               thread_id: thread.thread_id
             })

    assert {:ok, _} = Message.send_message(%{channel_id: channel_id, author_id: author_id, content: "plain"})

    events = drain_published(400)
    thread_events = for {"ThreadMessageCreate", _} <- events, do: true
    assert thread_events != []

    message_events = for {"MessageCreate", ch} <- events, ch == channel_id, do: ch
    assert length(message_events) == 2
  end

  test "Messages.history excludes call-log rows via the mapping", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, thread_id} = Log.ensure_thread(channel_id, author_id)

    {:ok, _} = Message.send_message(%{channel_id: channel_id, author_id: author_id, content: "timeline one"})

    {:ok, log_wire} =
      Message.send_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "call-log entry",
        thread_id: thread_id
      })

    {:ok, _} = Message.send_message(%{channel_id: channel_id, author_id: author_id, content: "timeline two"})

    history = Messages.history(channel_id, limit: 50)
    assert Enum.map(history, & &1.content) == ["timeline two", "timeline one"]

    # The row itself is intact (the call-log thread's own hydration reads it).
    assert %{content: "call-log entry", thread_id: ^thread_id} =
             Messages.get_message(channel_id, String.to_integer(log_wire["id"]))
  end

  test "thread-scoped history (exclude_call_log: false) keeps the call-log rows", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, thread_id} = Log.ensure_thread(channel_id, author_id)

    {:ok, _} = Message.send_message(%{channel_id: channel_id, author_id: author_id, content: "timeline one"})

    {:ok, _} =
      Message.send_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "call-log entry",
        thread_id: thread_id
      })

    # The thread's OWN read must return its rows — the exclusion is a
    # channel-timeline rule only.
    history = Messages.history(channel_id, limit: 50, exclude_call_log: false)
    assert Enum.map(history, & &1.content) == ["call-log entry", "timeline one"]
  end

  test "channel history counts only timeline-visible rows toward the limit (no underfill)", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, thread_id} = Log.ensure_thread(channel_id, author_id)

    # Raw rows across three 7-day buckets (newest first): the newest holds
    # ONLY a call-log row, the middle mixes one of each, the oldest two
    # ordinary rows. Backdated ids keep snowflake-chronological order.
    now_ms = System.system_time(:millisecond)
    week_ms = 7 * 24 * 3600 * 1000
    id_shift = 22

    for {{weeks_back, log?}, i} <-
          Enum.with_index([{0, true}, {1, true}, {1, false}, {2, false}, {2, false}]) do
      ms = now_ms - weeks_back * week_ms
      id = Bitwise.bsl(ms - Cytale.Snowflake.epoch_ms(), id_shift) + i

      Cytale.Repo.execute!(
        "INSERT INTO #{Cytale.ScyllaCase.keyspace()}.messages (channel_id, bucket, message_id, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          {"bigint", channel_id},
          {"int", div(ms, week_ms)},
          {"bigint", id},
          {"bigint", author_id},
          {"text", "w#{weeks_back}-" <> if(log?, do: "log", else: "ord")},
          {"bigint", if(log?, do: thread_id, else: nil)},
          {"bigint", nil},
          {"timestamp", DateTime.from_unix!(ms, :millisecond)},
          {"timestamp", nil},
          {"list<map<text, text>>", []}
        ]
      )
    end

    # limit 2 with the call-log rows interleaved: the page must still fill
    # with 2 ordinary rows (the scan keeps walking buckets while under
    # limit — not stopping on a raw row count that call-log rows inflated).
    history = Messages.history(channel_id, limit: 2)
    assert Enum.map(history, & &1.content) == ["w1-ord", "w2-ord"]
  end

  test "multi-bucket history page keeps its exact row order (plan 5.14)", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    {:ok, thread_id} = Log.ensure_thread(channel_id, author_id)

    # Rows across three 7-day buckets (newest bucket first), call-log rows
    # interleaved so the page has to reject some and keep walking older buckets.
    # Each entry carries its own timestamp, so ids descend in listed order
    # (id chronology = listing order). This is the fixture the accumulator
    # rewrite (acc ++ -> prepend) must leave byte-identical: it spans buckets,
    # which is exactly where the rewritten accumulation runs.
    now_ms = System.system_time(:millisecond)
    week_ms = 7 * 24 * 3600 * 1000
    id_shift = 22

    fixture = [
      {now_ms, true, "b0-log"},
      {now_ms - week_ms, true, "b1-log"},
      {now_ms - week_ms - 1_000, false, "b1-a"},
      {now_ms - week_ms - 2_000, false, "b1-b"},
      {now_ms - 2 * week_ms, true, "b2-log"},
      {now_ms - 2 * week_ms - 1_000, false, "b2-a"},
      {now_ms - 2 * week_ms - 2_000, false, "b2-b"},
      {now_ms - 2 * week_ms - 3_000, false, "b2-c"}
    ]

    Enum.each(fixture, fn {ms, log?, content} ->
      id = Bitwise.bsl(ms - Cytale.Snowflake.epoch_ms(), id_shift)

      Cytale.Repo.execute!(
        "INSERT INTO #{Cytale.ScyllaCase.keyspace()}.messages (channel_id, bucket, message_id, author_id, content, thread_id, reply_to_id, created_at, edited_at, attachments) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          {"bigint", channel_id},
          {"int", div(ms, week_ms)},
          {"bigint", id},
          {"bigint", author_id},
          {"text", content},
          {"bigint", if(log?, do: thread_id, else: nil)},
          {"bigint", nil},
          {"timestamp", DateTime.from_unix!(ms, :millisecond)},
          {"timestamp", nil},
          {"list<map<text, text>>", []}
        ]
      )
    end)

    # Ids descend b1-a > b1-b > b2-a > b2-b > b2-c (the call-log rows are
    # rejected). A limit-4 page SPANS two buckets — the pre-change expectation
    # derived from the code (bucket walk newest-first, then sort by message_id
    # DESC) — and the list equality is ORDER-SENSITIVE.
    assert Messages.history(channel_id, limit: 4) |> Enum.map(& &1.content) ==
             ["b1-a", "b1-b", "b2-a", "b2-b"]

    # The full page (limit above the visible count) holds the same order.
    assert Messages.history(channel_id, limit: 50) |> Enum.map(& &1.content) ==
             ["b1-a", "b1-b", "b2-a", "b2-b", "b2-c"]

    # Thread-scoped (exclude_call_log: false) keeps the call-log rows and still
    # spans buckets — so the order pin covers both rejection modes.
    assert Messages.history(channel_id, limit: 50, exclude_call_log: false)
           |> Enum.map(& &1.content) ==
             ["b0-log", "b1-log", "b1-a", "b1-b", "b2-log", "b2-a", "b2-b", "b2-c"]
  end

  test "a channel without a call-log mapping filters nothing", %{
    channel_id: channel_id,
    author_id: author_id
  } do
    assert Log.thread_id(channel_id) == nil

    {:ok, _} = Message.send_message(%{channel_id: channel_id, author_id: author_id, content: "only message"})
    assert [%{content: "only message"}] = Messages.history(channel_id, limit: 50)
  end
end
