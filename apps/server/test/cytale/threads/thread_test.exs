defmodule Cytale.Threads.ThreadTest do
  @moduledoc """
  U12 — thread lifecycle: create from a channel message, metadata, archive,
  reply bookkeeping (message_count / latest_reply_id / latest_reply_at), and
  the wire event payload builders.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Messages
  alias Cytale.Threads.Events
  alias Cytale.Threads.Thread

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # A channel + a parent message to start a thread from.
  defp seed_channel_message do
    channel_id = Cytale.Snowflake.next()
    author_id = Cytale.Snowflake.next()

    {:ok, wire} =
      Messages.Message.send_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "parent message",
        thread_id: nil
      })

    {channel_id, author_id, String.to_integer(wire["id"])}
  end

  test "create a thread from a channel message → THREAD_CREATE payload + durable row" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    name = run_unique("thread")

    assert {:ok, t} = Thread.create(channel_id, parent_id, name, author_id)
    assert t.thread_id == parent_id
    assert t.channel_id == channel_id
    assert t.parent_message_id == parent_id
    assert t.name == name
    assert t.archived == false
    assert t.member_count == 0
    assert t.message_count == 0
    assert t.latest_reply_id == nil

    # Durable + fetchable by id.
    assert %{thread_id: ^parent_id} = Thread.get(parent_id)

    # Wire payload shape (protocol ThreadCreate).
    payload = Events.thread_create(t)
    assert payload["id"] == Integer.to_string(parent_id)
    assert payload["channel_id"] == Integer.to_string(channel_id)
    assert payload["name"] == name
    assert payload["created_by"] == Integer.to_string(author_id)
    assert is_binary(payload["created_at"])
  end

  test "create from a missing message → :message_not_found" do
    assert {:error, :message_not_found} = Thread.create(Cytale.Snowflake.next(), Cytale.Snowflake.next(), "x", 1)
  end

  test "list threads in a channel (newest-first)" do
    {channel_id, author_id, parent1} = seed_channel_message()
    {:ok, _t1} = Thread.create(channel_id, parent1, run_unique("t1"), author_id)

    # A second parent message → second thread.
    {:ok, wire2} =
      Messages.Message.send_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "parent 2",
        thread_id: nil
      })

    parent2 = String.to_integer(wire2["id"])
    {:ok, _t2} = Thread.create(channel_id, parent2, run_unique("t2"), author_id)

    ids = Thread.list_in_channel(channel_id) |> Enum.map(& &1.thread_id)
    assert parent2 in ids and parent1 in ids
  end

  test "record_reply bumps message_count and sets latest_reply_id (forward only)" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    reply1 = Cytale.Snowflake.next()
    reply2 = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    :ok = Thread.record_reply(parent_id, reply1, now)
    :ok = Thread.record_reply(parent_id, reply2, now)

    t2 = Thread.get(parent_id)
    assert t2.message_count == 2
    assert t2.latest_reply_id == reply2
    assert t2.latest_reply_at != nil

    # A stale (older) reply never regresses latest_reply_id.
    :ok = Thread.record_reply(parent_id, reply1, now)
    assert Thread.get(parent_id).latest_reply_id == reply2
  end

  test "record_reply_removed takes a deleted reply out of both mirrors, floored at zero (#106)" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    reply1 = Cytale.Snowflake.next()
    reply2 = Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)
    :ok = Thread.record_reply(parent_id, reply1, now)
    :ok = Thread.record_reply(parent_id, reply2, now)

    :ok = Thread.record_reply_removed(parent_id)

    in_channel = fn -> Enum.find(Thread.list_in_channel(channel_id), &(&1.thread_id == parent_id)) end
    assert Thread.get(parent_id).message_count == 1
    assert in_channel.().message_count == 1
    # The last activity stands — it happened.
    assert Thread.get(parent_id).latest_reply_id == reply2

    :ok = Thread.record_reply_removed(parent_id)
    :ok = Thread.record_reply_removed(parent_id)
    assert Thread.get(parent_id).message_count == 0
    assert in_channel.().message_count == 0
  end

  test "archive toggles the archived flag" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    :ok = Thread.set_archived(parent_id, true)
    assert Thread.get(parent_id).archived == true

    :ok = Thread.set_archived(parent_id, false)
    assert Thread.get(parent_id).archived == false
  end

  test "member_count bumps and decrements" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    :ok = Thread.bump_member_count(parent_id)
    :ok = Thread.bump_member_count(parent_id)
    assert Thread.get(parent_id).member_count == 2

    :ok = Thread.decrement_member_count(parent_id)
    assert Thread.get(parent_id).member_count == 1
  end

  # -- hardening plan 4.3: the mirrored counters move by optimistic LWT ----------

  test "concurrent replies count exactly once each, in BOTH mirrors" do
    # `record_reply/3` was a read-modify-write over two mirrored rows, so two
    # replies landing together both wrote `n + 1` and the count drifted low for
    # good. The conditional write (`IF message_count = ?`) serializes them: the
    # loser re-reads and re-applies.
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    replies = for _ <- 1..8, do: Cytale.Snowflake.next()
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    replies
    |> Task.async_stream(fn reply -> Thread.record_reply(parent_id, reply, now) end,
      max_concurrency: 8,
      timeout: 60_000
    )
    |> Enum.each(fn {:ok, result} -> assert result == :ok end)

    by_id = Thread.get(parent_id)
    in_channel = Enum.find(Thread.list_in_channel(channel_id), &(&1.thread_id == parent_id))

    assert by_id.message_count == 8, "the by-id mirror lost replies"
    assert in_channel.message_count == 8, "the channel mirror lost replies"
    assert by_id.latest_reply_id == Enum.max(replies)
    assert in_channel.latest_reply_id == Enum.max(replies)
  end

  test "a stale reply delivery never regresses the latest reply" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    newer = Cytale.Snowflake.next()
    older = newer - 1
    now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

    :ok = Thread.record_reply(parent_id, newer, now)
    :ok = Thread.record_reply(parent_id, older, now)

    t = Thread.get(parent_id)
    assert t.latest_reply_id == newer
    assert t.latest_reply_at == now
    # …but the older reply is still a reply: the count and the latest-reply pair
    # are separate concerns (see `record_reply/3`).
    assert t.message_count == 2
  end

  test "concurrent member_count bumps land exactly once each, in BOTH mirrors" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    1..8
    |> Task.async_stream(fn _ -> Thread.bump_member_count(parent_id) end,
      max_concurrency: 8,
      timeout: 60_000
    )
    |> Enum.each(fn {:ok, result} -> assert result == :ok end)

    in_channel = Enum.find(Thread.list_in_channel(channel_id), &(&1.thread_id == parent_id))
    assert Thread.get(parent_id).member_count == 8, "the by-id mirror lost joins"
    assert in_channel.member_count == 8, "the channel mirror lost joins"
  end

  test "event payload builders produce protocol-shaped maps" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)

    upd = Events.thread_update(t, %{archived: true})
    assert upd["id"] == Integer.to_string(parent_id)
    assert upd["archived"] == true

    del = Events.thread_delete(t)
    assert del["id"] == Integer.to_string(parent_id)
    assert del["channel_id"] == Integer.to_string(channel_id)

    add = Events.thread_member_add(parent_id, 42)
    assert add["thread_id"] == Integer.to_string(parent_id)
    assert add["user_id"] == "42"

    rem = Events.thread_member_remove(parent_id, 42)
    assert rem["thread_id"] == Integer.to_string(parent_id)

    tmc =
      Events.thread_message_create(%{
        "id" => "1",
        "channel_id" => Integer.to_string(channel_id),
        "thread_id" => Integer.to_string(parent_id),
        "author_id" => "2",
        "content" => "hi",
        "created_at" => "2026-08-30T00:00:00Z",
        "edited_at" => nil
      })

    assert tmc["thread_id"] == Integer.to_string(parent_id)
    assert tmc["content"] == "hi"
  end

  test "recount rederives a drifted message_count from the reply locator (review #24)" do
    {channel_id, author_id, parent_id} = seed_channel_message()
    {:ok, t} = Thread.create(channel_id, parent_id, run_unique("recount"), author_id)

    for n <- 1..3 do
      {:ok, reply} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: author_id,
          content: "r#{n}",
          thread_id: t.thread_id
        })

      :ok = Thread.record_reply(t.thread_id, reply.id, reply.created_at)
    end

    # The drift an exhausted LWT leaves behind: both mirrors wrong.
    ks = Cytale.Repo.keyspace()

    Cytale.Repo.execute!("UPDATE #{ks}.threads_by_id SET message_count = ? WHERE thread_id = ?", [
      {"bigint", 7},
      {"bigint", t.thread_id}
    ])

    Cytale.Repo.execute!("UPDATE #{ks}.threads SET message_count = ? WHERE channel_id = ? AND thread_id = ?", [
      {"bigint", 1},
      {"bigint", channel_id},
      {"bigint", t.thread_id}
    ])

    assert :ok = Thread.recount(t.thread_id)
    assert %{message_count: 3} = Thread.get(t.thread_id)

    assert [%{message_count: 3}] =
             channel_id |> Thread.list_in_channel() |> Enum.filter(&(&1.thread_id == t.thread_id))

    # Queued through the job: the same repair, driven by the tick.
    Cytale.Repo.execute!("UPDATE #{ks}.threads_by_id SET message_count = ? WHERE thread_id = ?", [
      {"bigint", 0},
      {"bigint", t.thread_id}
    ])

    :ok = Cytale.Maintenance.Recount.mark_thread(t.thread_id)
    assert %{done: done} = Cytale.Maintenance.Recount.run_once()
    assert done >= 1
    assert %{message_count: 3} = Thread.get(t.thread_id)
  end
end
