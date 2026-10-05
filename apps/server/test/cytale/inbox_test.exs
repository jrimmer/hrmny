defmodule Cytale.InboxTest do
  @moduledoc """
  #117 — the durable mention backlog, at the storage seam.

  Two properties carry the ticket, and both are asserted here WITHOUT a
  session in the picture:

    * **durability** — a mention is recorded by the MESSAGE WRITE, for every
      member it addresses, connected or not. "The member was away" is
      therefore not a special case: there is no session to miss it, which is
      exactly what the session-local slice could not say;
    * **one read state** — answering a mention deletes an event row and never
      moves a watermark; an acknowledgement deletes the rows it covers and is
      the only thing that moves the watermark.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Inbox
  alias Cytale.Messages
  alias Cytale.Messages.ReadState
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  defp unique(base), do: base <> Cytale.TestNonce.get()

  # A workspace with `author` and `member` in it, one channel, and the ids the
  # assertions need. Real user rows: the visibility resolver reads membership.
  defp fixture do
    {:ok, author} = User.create(unique("inb_a"), unique("inb_a@example.com"), "password-123")
    {:ok, member} = User.create(unique("inb_b"), unique("inb_b@example.com"), "password-123")

    {:ok, ws} = Workspaces.create_workspace(author.user_id, unique("inb-ws"))
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "inb-ch")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, author.user_id)

    %{author: author, member: member, ws: ws, channel: channel}
  end

  defp send_message(f, content, opts \\ []) do
    {:ok, message} =
      Messages.create_message(
        %{
          channel_id: f.channel.channel_id,
          author_id: f.author.user_id,
          content: content
        }
        |> Map.merge(Map.new(opts))
      )

    message
  end

  # A thread off a real root message (the thread row requires one).
  defp thread_for(f, name) do
    root = send_message(f, "root for #{name}")
    {:ok, thread} = Thread.create(f.channel.channel_id, root.id, name, f.author.user_id)
    thread
  end

  describe "record_mentions/1 — the write side" do
    test "a mention is recorded for the mentioned member with no session anywhere" do
      f = fixture()

      # The member has never connected and never acknowledged anything: this is
      # the "away" case, and the row must still exist for their next hydrate.
      assert {[], nil} = Inbox.list_for_user(f.member.user_id)

      send_message(f, "hey <@#{f.member.user_id}> can you look at this?")

      {items, _oldest} = Inbox.list_for_user(f.member.user_id)
      assert [item] = items
      assert item["author_id"] == Integer.to_string(f.author.user_id)
      assert item["channel_id"] == Integer.to_string(f.channel.channel_id)
      assert item["kind"] == "mention"
      assert item["excerpt"] =~ "can you look at this?"
      assert item["author_username"] =~ "inb_a"
    end

    test "a message with no mention token records nothing" do
      f = fixture()

      send_message(f, "just talking to myself")

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end

    test "the author's own mention of themselves is not an inbox row" do
      f = fixture()

      send_message(f, "note to self <@#{f.author.user_id}>")

      assert {[], nil} = Inbox.list_for_user(f.author.user_id)
    end

    test "a mention of a non-member is not recorded (visibility is re-checked)" do
      f = fixture()
      {:ok, stranger} = User.create(unique("inb_s"), unique("inb_s@example.com"), "password-123")

      send_message(f, "hi <@#{stranger.user_id}>")

      assert {[], nil} = Inbox.list_for_user(stranger.user_id)
    end

    test "a thread reply carries the parent channel and the thread" do
      f = fixture()
      thread = thread_for(f, "inb-thread")

      send_message(f, "in here <@#{f.member.user_id}>", thread_id: thread.thread_id)

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["thread_id"] == Integer.to_string(thread.thread_id)
      assert item["channel_id"] == Integer.to_string(f.channel.channel_id)
    end

    test "the stored excerpt is capped" do
      f = fixture()
      long = String.duplicate("x", Inbox.excerpt_chars() + 100)

      send_message(f, "<@#{f.member.user_id}> " <> long)

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert String.length(item["excerpt"]) == Inbox.excerpt_chars()
    end
  end

  # Owner direction 2026-09-27: "Mentions only" includes @everyone/@here for
  # delivery AND for the mention badge — and the badge is a projection of
  # these rows, so a broadcast must leave one per addressed member.
  describe "record_mentions/1 — broadcasts" do
    test "@everyone records a broadcast row for every member who can see the channel" do
      f = fixture()

      send_message(f, "@everyone standup in 5")

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["kind"] == "broadcast"
      assert item["excerpt"] =~ "standup"
      # Never the author's own broadcast.
      assert {[], nil} = Inbox.list_for_user(f.author.user_id)
    end

    test "@here records like @everyone" do
      f = fixture()

      send_message(f, "@here anyone around?")

      assert {[%{"kind" => "broadcast"}], _} = Inbox.list_for_user(f.member.user_id)
    end

    test "a bounded token only: @heretical is ordinary prose" do
      f = fixture()

      send_message(f, "@heretical thought")

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end

    test "a member named AND broadcast to gets one row, the direct one" do
      f = fixture()

      send_message(f, "@everyone and especially <@#{f.member.user_id}>")

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["kind"] == "mention"
    end

    test "a member who suppresses broadcasts in the workspace gets no row" do
      f = fixture()
      :ok = Cytale.Notifications.Preferences.set_suppress_broadcasts(f.member.user_id, f.ws.workspace_id, true)

      send_message(f, "@everyone standup in 5")

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end

    test "suppression never hides a DIRECT mention" do
      f = fixture()
      :ok = Cytale.Notifications.Preferences.set_suppress_broadcasts(f.member.user_id, f.ws.workspace_id, true)

      send_message(f, "@everyone and <@#{f.member.user_id}>")

      assert {[%{"kind" => "mention"}], _} = Inbox.list_for_user(f.member.user_id)
    end

    test "another workspace's switch does not apply here" do
      f = fixture()
      :ok = Cytale.Notifications.Preferences.set_suppress_broadcasts(f.member.user_id, f.ws.workspace_id + 1, true)

      send_message(f, "@everyone standup")

      assert {[%{"kind" => "broadcast"}], _} = Inbox.list_for_user(f.member.user_id)
    end

    test "a broadcast counts in the channel's unread mention count, unless suppressed" do
      f = fixture()

      send_message(f, "@everyone one")
      send_message(f, "plain chatter")

      assert {:ok, counts} = ReadState.unread_mention_counts(f.member.user_id, %{})
      assert Map.get(counts, f.channel.channel_id) == 1

      :ok = Cytale.Notifications.Preferences.set_suppress_broadcasts(f.member.user_id, f.ws.workspace_id, true)
      send_message(f, "@here two")

      # The switch is forward-looking: the earlier broadcast stays counted
      # until it is read, and the suppressed one never counts.
      assert {:ok, counts} = ReadState.unread_mention_counts(f.member.user_id, %{})
      assert Map.get(counts, f.channel.channel_id) == 1
    end
  end

  # Security tier 1 #8: `@everyone`/`@here` REACH people only when the author
  # holds `mention_everyone` in the channel. The text survives either way.
  describe "record_mentions/1 — the broadcast is permission-gated" do
    test "a plain member's @everyone records no broadcast row (and says so on the message)" do
      f = fixture()

      message =
        Messages.create_message(%{
          channel_id: f.channel.channel_id,
          author_id: f.member.user_id,
          content: "@everyone free pizza"
        })
        |> elem(1)

      assert message.content == "@everyone free pizza"
      assert message.mention_everyone == false
      assert {[], nil} = Inbox.list_for_user(f.author.user_id)
    end

    test "a member granted mention_everyone by a role broadcasts" do
      f = fixture()

      {:ok, role} =
        Workspaces.create_role(f.ws.workspace_id, unique("Announcers"),
          permissions: Cytale.Permissions.Bitfield.bit(:mention_everyone),
          position: 1
        )

      :ok = Workspaces.grant_role(f.ws.workspace_id, f.member.user_id, role.role_id)

      {:ok, message} =
        Messages.create_message(%{
          channel_id: f.channel.channel_id,
          author_id: f.member.user_id,
          content: "@here standup"
        })

      assert message.mention_everyone == true
      assert {[%{"kind" => "broadcast"}], _} = Inbox.list_for_user(f.author.user_id)
    end

    test "a direct mention in the same message still lands without the bit" do
      f = fixture()

      Messages.create_message(%{
        channel_id: f.channel.channel_id,
        author_id: f.member.user_id,
        content: "@everyone but mostly <@#{f.author.user_id}>"
      })

      assert {[%{"kind" => "mention"}], _} = Inbox.list_for_user(f.author.user_id)
    end

    test "a caller-supplied verdict of false (a webhook's allowed_mentions) wins" do
      f = fixture()
      send_message(f, "@everyone quiet please", mention_everyone: false)
      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end
  end

  describe "mark_done/2 and mark_all_done/1 — answering without reading" do
    test "done removes the row and leaves the channel's read state alone" do
      f = fixture()
      message = send_message(f, "<@#{f.member.user_id}> ping")

      # The member HAS read the channel up to an older point.
      :ok = ReadState.write(f.member.user_id, f.channel.channel_id, %{last_read_id: 42})

      :ok = Inbox.mark_done(f.member.user_id, message.id)

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
      assert %{last_read_id: 42, unread_floor: nil} = ReadState.get(f.member.user_id, f.channel.channel_id)
    end

    test "done is idempotent and never touches another member's row" do
      f = fixture()
      {:ok, other} = User.create(unique("inb_o"), unique("inb_o@example.com"), "password-123")
      :ok = Workspaces.add_member(f.ws.workspace_id, other.user_id, f.author.user_id)
      message = send_message(f, "<@#{f.member.user_id}> and <@#{other.user_id}>")

      :ok = Inbox.mark_done(f.member.user_id, message.id)
      :ok = Inbox.mark_done(f.member.user_id, message.id)

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
      assert {[_item], _} = Inbox.list_for_user(other.user_id)
    end

    test "the bulk sweep clears only the caller's backlog" do
      f = fixture()
      {:ok, other} = User.create(unique("inb_p"), unique("inb_p@example.com"), "password-123")
      :ok = Workspaces.add_member(f.ws.workspace_id, other.user_id, f.author.user_id)

      send_message(f, "<@#{f.member.user_id}> and <@#{other.user_id}>")
      send_message(f, "again <@#{f.member.user_id}> and <@#{other.user_id}>")

      assert Inbox.mark_all_done(f.member.user_id) == 2
      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
      assert {[_, _], _} = Inbox.list_for_user(other.user_id)
    end
  end

  describe "mark_done_through/3 — the ack answers the mentions it covers" do
    test "an ack clears the rows at or below its watermark and keeps newer ones" do
      f = fixture()
      first = send_message(f, "<@#{f.member.user_id}> one")
      second = send_message(f, "<@#{f.member.user_id}> two")

      assert Inbox.mark_done_through(f.member.user_id, f.channel.channel_id, first.id) == 1

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["message_id"] == Integer.to_string(second.id)
    end

    test "a CHANNEL ack does not answer a THREAD mention" do
      f = fixture()
      thread = thread_for(f, "inb-thread2")
      thread_message = send_message(f, "in here <@#{f.member.user_id}>", thread_id: thread.thread_id)

      # Reading the channel timeline is not reading the thread (the timeline
      # hides replies, and the thread has its own watermark).
      assert Inbox.mark_done_through(f.member.user_id, f.channel.channel_id, thread_message.id) == 0
      assert {[_], _} = Inbox.list_for_user(f.member.user_id)

      # The thread's own ack answers it.
      assert Inbox.mark_done_through(f.member.user_id, thread.thread_id, thread_message.id) == 1
      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end

    test "the sweep is scoped to the acknowledged channel" do
      f = fixture()
      {:ok, other_channel} = Workspaces.create_channel(f.ws.workspace_id, "inb-ch2")
      here = send_message(f, "<@#{f.member.user_id}> here")

      {:ok, elsewhere} =
        Messages.create_message(%{
          channel_id: other_channel.channel_id,
          author_id: f.author.user_id,
          content: "<@#{f.member.user_id}> there"
        })

      assert Inbox.mark_done_through(f.member.user_id, f.channel.channel_id, here.id) == 1
      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["message_id"] == Integer.to_string(elsewhere.id)
    end

    test "a hand-set unread floor outranks the ack's watermark" do
      f = fixture()
      message = send_message(f, "<@#{f.member.user_id}> keep me unread")

      # The member acknowledged past the mention AND said this message is
      # unread by hand (`unread_floor` is EXCLUSIVE-inclusive: it and
      # everything after it is unread). The ack must not answer it.
      :ok = ReadState.write(f.member.user_id, f.channel.channel_id, %{last_read_id: message.id})
      :ok = ReadState.write(f.member.user_id, f.channel.channel_id, %{unread_floor: message.id})

      assert Inbox.mark_done_through(f.member.user_id, f.channel.channel_id, message.id) == 0
      assert {[_], _} = Inbox.list_for_user(f.member.user_id)
    end
  end

  describe "list_for_user/2" do
    test "rows come back newest-first with a paging cursor" do
      f = fixture()
      first = send_message(f, "<@#{f.member.user_id}> one")
      second = send_message(f, "<@#{f.member.user_id}> two")
      third = send_message(f, "<@#{f.member.user_id}> three")

      {items, oldest} = Inbox.list_for_user(f.member.user_id, limit: 2)

      assert Enum.map(items, & &1["message_id"]) == [
               Integer.to_string(third.id),
               Integer.to_string(second.id)
             ]

      assert oldest == Integer.to_string(second.id)

      # `before` is the cursor: strictly OLDER than it.
      {page2, oldest2} = Inbox.list_for_user(f.member.user_id, before: second.id, limit: 2)
      assert Enum.map(page2, & &1["message_id"]) == [Integer.to_string(first.id)]
      assert oldest2 == Integer.to_string(first.id)
    end

    test "a row whose channel the member can no longer see is dropped" do
      f = fixture()
      send_message(f, "<@#{f.member.user_id}> ping")
      assert {[_], _} = Inbox.list_for_user(f.member.user_id)

      # Membership revoked: the row is still stored, and must not be readable.
      Cytale.Repo.execute!(
        "DELETE FROM #{Cytale.Repo.keyspace()}.workspace_members WHERE workspace_id = ? AND user_id = ?",
        [{"bigint", f.ws.workspace_id}, {"bigint", f.member.user_id}]
      )

      assert {[], nil} = Inbox.list_for_user(f.member.user_id)
    end

    test "a deleted message's row vanishes from the backlog (and from storage)" do
      f = fixture()
      message = send_message(f, "<@#{f.member.user_id}> secret plan, delete me")
      keep = send_message(f, "<@#{f.member.user_id}> still here")
      assert {[_, _], _} = Inbox.list_for_user(f.member.user_id)

      :ok = Messages.delete_message(f.channel.channel_id, message.id)

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["message_id"] == Integer.to_string(keep.id)
      refute item["excerpt"] =~ "secret plan"

      # The stale row itself is gone, so the mention badge stops counting it.
      rows =
        Cytale.Repo.execute!(
          "SELECT message_id FROM #{Cytale.Repo.keyspace()}.mention_events WHERE user_id = ?",
          [{"bigint", f.member.user_id}]
        )
        |> Enum.map(& &1["message_id"])

      assert rows == [keep.id]
    end

    test "an edited message's excerpt follows the edit" do
      f = fixture()
      message = send_message(f, "<@#{f.member.user_id}> the password is hunter2")

      :ok = Messages.edit_message(f.channel.channel_id, message.id, "<@#{f.member.user_id}> [redacted]")

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert item["excerpt"] =~ "[redacted]"
      refute item["excerpt"] =~ "hunter2"
    end

    test "an edit past the excerpt cap is still capped" do
      f = fixture()
      message = send_message(f, "<@#{f.member.user_id}> short")
      long = "<@#{f.member.user_id}> " <> String.duplicate("y", Inbox.excerpt_chars() + 50)
      :ok = Messages.edit_message(f.channel.channel_id, message.id, long)

      assert {[item], _} = Inbox.list_for_user(f.member.user_id)
      assert String.length(item["excerpt"]) == Inbox.excerpt_chars()
    end
  end
end
