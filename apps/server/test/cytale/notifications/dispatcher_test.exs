defmodule Cytale.Notifications.DispatcherTest do
  @moduledoc """
  U4 of the notification plan — the policy reaches the fan-out (R1, R4, R16,
  R21).

  The dispatcher is the seam between "the message was delivered" and "the
  member was told". Delivery to a member's live sessions is NOT this module's
  concern and must not be disturbed by it: a notification decision that
  blocked, slowed, or altered in-app fan-out would trade a missed
  notification for a missed message, which is strictly worse.

  What it owns is turning a delivered event into per-recipient verdicts, and
  holding back the device that is already looking at the thing.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Notifications.{Dispatcher, Focus, Preferences}

  setup do
    :ok = Focus.ensure_started()
    :ok
  end

  defp user_id, do: String.to_integer("2#{Cytale.TestNonce.get()}")
  defp entity_id, do: String.to_integer("1#{Cytale.TestNonce.get()}")

  defp message_event(attrs) do
    Map.merge(
      %{
        "id" => Integer.to_string(entity_id()),
        "channel_id" => Integer.to_string(entity_id()),
        "author_id" => "999",
        "content" => "hello",
        "thread_id" => nil
      },
      Map.new(attrs)
    )
  end

  defp recipients(user_ids), do: Enum.map(user_ids, fn uid -> {{self(), uid}, uid} end)

  describe "verdicts per recipient" do
    test "an ordinary channel message badges a default member" do
      uid = user_id()

      verdicts = Dispatcher.verdicts("MessageCreate", message_event(%{}), recipients([uid]))

      assert [{^uid, resolved}] = verdicts
      assert resolved.verdict == :badge
      assert resolved.rule == :channel_message
    end

    test "a mention pushes the mentioned member and badges the rest" do
      mentioned = user_id()
      other = user_id()

      event = message_event(%{"content" => "hey <@#{mentioned}> look"})

      verdicts = Dispatcher.verdicts("MessageCreate", event, recipients([mentioned, other]))
      by_user = Map.new(verdicts)

      assert by_user[mentioned].verdict == :push
      assert by_user[mentioned].rule == :direct_mention
      assert by_user[other].verdict == :badge
    end

    test "a muted member is not notified even by a mention" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :channel, ch, "mute")

      event = message_event(%{"channel_id" => Integer.to_string(ch), "content" => "<@#{uid}>"})

      assert [{^uid, resolved}] = Dispatcher.verdicts("MessageCreate", event, recipients([uid]))
      assert resolved.verdict == :none
      assert resolved.rule == :muted
    end

    test "each recipient is decided by their OWN preferences" do
      all_activity = user_id()
      default = user_id()
      ch = entity_id()
      ws = entity_id()

      :ok = Preferences.set_level(all_activity, :workspace, ws, "all")

      event = message_event(%{"channel_id" => Integer.to_string(ch), "content" => "fyi"})

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          event,
          recipients([all_activity, default]),
          workspace_id: ws
        )

      by_user = Map.new(verdicts)
      assert by_user[all_activity].verdict == :push
      assert by_user[all_activity].decided_by == :workspace
      assert by_user[default].verdict == :badge
    end
  end

  describe "the audience is MEMBERSHIP, not presence" do
    # The regression this fixes: the audience was the live subscriber list, so a
    # member with the app closed had no live session, was never a recipient, and
    # push could only reach people already connected — making push redundant
    # with the thing it exists to back up.
    test "a member with NO live session is still decided on" do
      offline = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(offline, :channel, ch, "all")

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          message_event(%{"channel_id" => Integer.to_string(ch)}),
          [],
          members: [offline],
          subscribed: MapSet.new([offline])
        )

      assert [{^offline, resolved}] = verdicts
      assert resolved.verdict == :push
    end

    test "a member with no session and no subscription is still decided on" do
      member = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(member, :channel, ch, "all")

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          message_event(%{"channel_id" => Integer.to_string(ch)}),
          [],
          members: [member],
          subscribed: MapSet.new()
        )

      assert [{^member, resolved}] = verdicts
      assert resolved.verdict == :push
    end

    test "a live member who never subscribed is decided on once, not twice" do
      member = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(member, :channel, ch, "all")

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          message_event(%{"channel_id" => Integer.to_string(ch)}),
          recipients([member]),
          members: [member]
        )

      assert length(verdicts) == 1, "membership and liveness must not double-count"
    end

    test "a member in both the membership and the subscribed set is decided on once" do
      member = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(member, :channel, ch, "all")

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          message_event(%{"channel_id" => Integer.to_string(ch)}),
          recipients([member]),
          members: [member],
          subscribed: MapSet.new([member])
        )

      assert length(verdicts) == 1
    end

    test "the author is not a recipient of their own message" do
      author = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(author, :channel, ch, "all")

      verdicts =
        Dispatcher.verdicts(
          "MessageCreate",
          message_event(%{"channel_id" => Integer.to_string(ch), "author_id" => Integer.to_string(author)}),
          [],
          members: [author],
          subscribed: MapSet.new([author])
        )

      assert [{^author, resolved}] = verdicts
      assert resolved.verdict == :none
      assert resolved.rule == :own_message
    end
  end

  describe "the focused device (R16)" do
    test "a member focused in some session is not pushed to at all" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :channel, ch, "all")
      :ok = Focus.report(uid, "sess-focused", true)

      event = message_event(%{"channel_id" => Integer.to_string(ch)})

      assert [{^uid, resolved}] = Dispatcher.verdicts("MessageCreate", event, recipients([uid]))
      assert resolved.verdict == :none
      assert resolved.rule == :focused
    end

    test "an unfocused member is decided normally" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :channel, ch, "all")

      event = message_event(%{"channel_id" => Integer.to_string(ch)})

      assert [{^uid, resolved}] = Dispatcher.verdicts("MessageCreate", event, recipients([uid]))
      assert resolved.verdict == :push
    end

    test "one member's focus does not silence another" do
      focused = user_id()
      other = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(focused, :channel, ch, "all")
      :ok = Preferences.set_level(other, :channel, ch, "all")
      :ok = Focus.report(focused, "sess-1", true)

      event = message_event(%{"channel_id" => Integer.to_string(ch)})

      by_user =
        Dispatcher.verdicts("MessageCreate", event, recipients([focused, other])) |> Map.new()

      assert by_user[focused].verdict == :none
      assert by_user[other].verdict == :push
    end
  end

  describe "scope of the hook" do
    test "only message creation is considered" do
      uid = user_id()

      assert Dispatcher.verdicts("MessageDelete", message_event(%{}), recipients([uid])) == []
      assert Dispatcher.verdicts("TypingStart", message_event(%{}), recipients([uid])) == []
      assert Dispatcher.verdicts("PresenceUpdate", message_event(%{}), recipients([uid])) == []
    end

    test "a member is decided once however many sessions they have" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :channel, ch, "all")

      event = message_event(%{"channel_id" => Integer.to_string(ch)})
      # The same member, three live sessions.
      sessions = [{{self(), uid}, uid}, {{spawn(fn -> :ok end), uid}, uid}, {{self(), uid}, uid}]

      verdicts = Dispatcher.verdicts("MessageCreate", event, sessions)

      assert length(verdicts) == 1,
             "one event must not produce one decision per session"

      assert [{^uid, _resolved}] = verdicts
    end

    test "no recipients means no work and no verdicts" do
      assert Dispatcher.verdicts("MessageCreate", message_event(%{}), []) == []
    end

    test "a member whose preference read is unavailable still gets the default" do
      uid = user_id()

      # No stored preferences at all — the default must still apply rather
      # than the recipient being skipped.
      assert [{^uid, resolved}] =
               Dispatcher.verdicts("MessageCreate", message_event(%{}), recipients([uid]))

      assert resolved.level == "mentions"
      assert resolved.explicit? == false
    end
  end
end
