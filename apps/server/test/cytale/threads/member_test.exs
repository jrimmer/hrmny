defmodule Cytale.Threads.MemberTest do
  @moduledoc """
  U12 — thread follow state: follow/unfollow, notify flag, last_read_id,
  two-tier unread badges, auto-follow-on-reply (opt-out default), and
  THREAD_LIST_SYNC bulk state.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Messages
  alias Cytale.Threads.Events
  alias Cytale.Threads.Member
  alias Cytale.Threads.Thread

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  # A channel + parent message + thread, returning {channel_id, thread_id}.
  defp seed_thread do
    channel_id = Cytale.Snowflake.next()
    author_id = Cytale.Snowflake.next()

    {:ok, wire} =
      Messages.Message.send_message(%{
        channel_id: channel_id,
        author_id: author_id,
        content: "parent",
        thread_id: nil
      })

    parent_id = String.to_integer(wire["id"])
    {:ok, _t} = Thread.create(channel_id, parent_id, run_unique("t"), author_id)
    {channel_id, parent_id}
  end

  test "follow creates a membership row; unfollow mutes (notify=false, row kept)" do
    {_channel_id, thread_id} = seed_thread()
    user_id = Cytale.Snowflake.next()

    :ok = Member.follow(thread_id, user_id, true)
    assert %{thread_id: ^thread_id, user_id: ^user_id, notify: true} = Member.get(thread_id, user_id)

    :ok = Member.unfollow(thread_id, user_id)
    assert %{notify: false} = Member.get(thread_id, user_id)
  end

  test "unread tiers: notified (notify=true) vs unread (notify=false) vs read" do
    {_channel_id, thread_id} = seed_thread()
    user_a = Cytale.Snowflake.next()
    user_b = Cytale.Snowflake.next()

    :ok = Member.follow(thread_id, user_a, true)
    :ok = Member.follow(thread_id, user_b, false)

    # A reply lands → latest_reply_id set.
    reply_id = Cytale.Snowflake.next()
    :ok = Thread.record_reply(thread_id, reply_id, DateTime.utc_now() |> DateTime.truncate(:millisecond))

    thread = Thread.get(thread_id)

    # Both unread (last_read_id nil), but tiers differ by notify.
    assert Member.unread_tier(Member.get(thread_id, user_a), thread) == :notified
    assert Member.unread_tier(Member.get(thread_id, user_b), thread) == :unread

    # user_a opens the thread → badge clears.
    :ok = Member.mark_read(thread_id, user_a, reply_id)
    assert Member.unread_tier(Member.get(thread_id, user_a), Thread.get(thread_id)) == :read
  end

  test "mark_read never regresses last_read_id" do
    {_channel_id, thread_id} = seed_thread()
    user_id = Cytale.Snowflake.next()
    :ok = Member.follow(thread_id, user_id, true)

    :ok = Member.mark_read(thread_id, user_id, 500)
    # older
    :ok = Member.mark_read(thread_id, user_id, 200)
    assert Member.get(thread_id, user_id).last_read_id == 500
  end

  test "unfollow → notify=false → new replies accrue as unread (gray), not notified" do
    {_channel_id, thread_id} = seed_thread()
    user_id = Cytale.Snowflake.next()

    :ok = Member.follow(thread_id, user_id, true)
    :ok = Member.set_notify(thread_id, user_id, false)

    reply_id = Cytale.Snowflake.next()
    :ok = Thread.record_reply(thread_id, reply_id, DateTime.utc_now() |> DateTime.truncate(:millisecond))

    assert Member.unread_tier(Member.get(thread_id, user_id), Thread.get(thread_id)) == :unread
  end

  test "auto-follow-on-reply: a replying user is followed unless they explicitly unfollowed" do
    {_channel_id, thread_id} = seed_thread()
    user_id = Cytale.Snowflake.next()

    # First reply → auto-followed (notify=true).
    :ok = Member.ensure_followed_on_reply(thread_id, user_id)
    assert %{notify: true} = Member.get(thread_id, user_id)

    # Explicit unfollow → muted row is the sticky opt-out; a later reply does
    # NOT re-follow (stays muted).
    :ok = Member.unfollow(thread_id, user_id)
    :ok = Member.ensure_followed_on_reply(thread_id, user_id)
    assert %{notify: false} = Member.get(thread_id, user_id)
  end

  test "THREAD_LIST_SYNC: followed_threads returns thread+member pairs; payload shape" do
    {_channel_id, thread_id} = seed_thread()
    user_id = Cytale.Snowflake.next()
    :ok = Member.follow(thread_id, user_id, true)

    followed = Member.followed_threads(user_id)
    assert [{thread, member}] = followed
    assert thread.thread_id == thread_id
    assert member.user_id == user_id

    payload = Events.thread_list_sync(1, followed)
    assert payload["workspace_id"] == "1"
    assert [t] = payload["threads"]
    assert t["id"] == Integer.to_string(thread_id)
    assert t["member_state"]["notify"] == true
  end
end
