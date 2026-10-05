defmodule Cytale.Notifications.ResolverTest do
  @moduledoc """
  U3 of the notification plan — the inheritance walk (R6, R7, R8, R9).

  The resolver is the ONE place that answers both "what will reach this
  member" and "which layer decided it". That pairing is the whole point: a
  readout computed separately from the decision would drift, and the member
  would be back to holding a cascade in their head.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Notifications.{Preferences, Resolver}

  defp user_id, do: String.to_integer("5#{Cytale.TestNonce.get()}")
  defp entity_id, do: String.to_integer("4#{Cytale.TestNonce.get()}")

  # The walk is pure over a preference map, so most cases need no storage at
  # all — which is what makes it cheap enough to run per message.
  defp opts(user_id, attrs) do
    Keyword.merge([user_id: user_id, account_entity: Preferences.account_entity()], attrs)
  end

  describe "resolve/2 — the walk" do
    test "a member with no overrides resolves to the default, decided by the account layer" do
      uid = user_id()

      resolved = Resolver.resolve(opts(uid, []))

      assert resolved.level == Resolver.default_level()
      assert resolved.decided_by == :account
      assert resolved.explicit? == false
    end

    test "an account override decides when nothing more specific is set" do
      uid = user_id()
      :ok = Preferences.set_level(uid, :account, 0, "all")

      resolved = Resolver.resolve(opts(uid, []))

      assert resolved.level == "all"
      assert resolved.decided_by == :account
      assert resolved.explicit? == true
    end

    test "a workspace override wins over the account layer" do
      uid = user_id()
      ws = entity_id()
      :ok = Preferences.set_level(uid, :account, 0, "mute")
      :ok = Preferences.set_level(uid, :workspace, ws, "all")

      resolved = Resolver.resolve(opts(uid, workspace_id: ws))

      assert resolved.level == "all"
      assert resolved.decided_by == :workspace
    end

    test "a channel override wins over the workspace layer" do
      uid = user_id()
      ws = entity_id()
      ch = entity_id()
      :ok = Preferences.set_level(uid, :workspace, ws, "mute")
      :ok = Preferences.set_level(uid, :channel, ch, "mentions")

      resolved = Resolver.resolve(opts(uid, workspace_id: ws, channel_id: ch))

      assert resolved.level == "mentions"
      assert resolved.decided_by == :channel
    end

    test "a thread with no level of its own inherits its channel" do
      uid = user_id()
      ch = entity_id()
      th = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "mute")

      resolved = Resolver.resolve(opts(uid, channel_id: ch, thread_id: th))

      assert resolved.level == "mute"
      assert resolved.decided_by == :channel
    end

    test "a thread level wins over its channel, and names the thread as decider" do
      uid = user_id()
      ch = entity_id()
      th = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "mute")
      :ok = Preferences.set_level(uid, :thread, th, "all")

      resolved = Resolver.resolve(opts(uid, channel_id: ch, thread_id: th))

      assert resolved.level == "all"
      assert resolved.decided_by == :thread
    end

    test "a thread level with no channel setting still resolves to the thread" do
      uid = user_id()
      th = entity_id()
      :ok = Preferences.set_level(uid, :thread, th, "mute")

      resolved = Resolver.resolve(opts(uid, thread_id: th))

      assert resolved.level == "mute"
      assert resolved.decided_by == :thread
    end

    test "an absent layer is skipped rather than terminating the walk" do
      uid = user_id()
      ws = entity_id()
      ch = entity_id()
      # Channel and thread unset; the workspace is the most specific that exists.
      :ok = Preferences.set_level(uid, :account, 0, "mentions")
      :ok = Preferences.set_level(uid, :workspace, ws, "all")

      resolved = Resolver.resolve(opts(uid, workspace_id: ws, channel_id: ch))

      assert resolved.level == "all"
      assert resolved.decided_by == :workspace
    end

    test "one member's overrides never decide another's" do
      uid = user_id()
      other = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(other, :channel, ch, "all")

      resolved = Resolver.resolve(opts(uid, channel_id: ch))

      assert resolved.level == Resolver.default_level()
      assert resolved.decided_by == :account
    end
  end

  describe "the participation sweep (R11)" do
    # The rule this whole design was justified by: muting a noisy channel must
    # not silently drop a reply to something you wrote there. Discord and Slack
    # both stop at the mute and lose the reply with no signal.
    test "a mute is raised when the member has posted in the channel" do
      uid = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "mute")
      :ok = Cytale.Notifications.Participations.record(uid, ch)

      resolved = Resolver.resolve(opts(uid, channel_id: ch))

      assert resolved.level == "all"
      assert resolved.decided_by == :participation
    end

    test "a mute stands when the member has not posted there" do
      uid = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "mute")

      resolved = Resolver.resolve(opts(uid, channel_id: ch))

      assert resolved.level == "mute"
      assert resolved.decided_by == :channel
    end

    test "participating somewhere else does not lift this channel's mute" do
      uid = user_id()
      ch = entity_id()
      other = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "mute")
      :ok = Cytale.Notifications.Participations.record(uid, other)

      assert Resolver.resolve(opts(uid, channel_id: ch)).level == "mute"
    end

    test "the sweep never LOWERS a level the member chose" do
      uid = user_id()
      ch = entity_id()
      :ok = Preferences.set_level(uid, :channel, ch, "all")
      :ok = Cytale.Notifications.Participations.record(uid, ch)

      resolved = Resolver.resolve(opts(uid, channel_id: ch))

      assert resolved.level == "all"
      assert resolved.decided_by == :channel
    end

    test "participating in a thread lifts that thread's mute" do
      uid = user_id()
      th = entity_id()
      :ok = Preferences.set_level(uid, :thread, th, "mute")
      :ok = Cytale.Notifications.Participations.record(uid, th)

      resolved = Resolver.resolve(opts(uid, thread_id: th))

      assert resolved.level == "all"
      assert resolved.decided_by == :participation
    end

    test "a thread mute is lifted by participation in the PARENT channel" do
      uid = user_id()
      ch = entity_id()
      th = entity_id()
      :ok = Preferences.set_level(uid, :thread, th, "mute")
      :ok = Cytale.Notifications.Participations.record(uid, ch)

      resolved = Resolver.resolve(opts(uid, channel_id: ch, thread_id: th))

      assert resolved.level == "all"
      assert resolved.decided_by == :participation
    end

    test "a mute inherited from a workspace is lifted by channel participation" do
      uid = user_id()
      ws = entity_id()
      ch = entity_id()
      :ok = Preferences.set_level(uid, :workspace, ws, "mute")
      :ok = Cytale.Notifications.Participations.record(uid, ch)

      resolved = Resolver.resolve(opts(uid, workspace_id: ws, channel_id: ch))

      assert resolved.level == "all"
      assert resolved.decided_by == :participation
    end
  end

  describe "allows?/3 — what a level permits" do
    test "all permits an ordinary message" do
      assert Resolver.allows?("all", %{kind: :message, mentions_me: false}) == :push
    end

    test "mentions permits a message that mentions the member" do
      assert Resolver.allows?("mentions", %{kind: :message, mentions_me: true}) == :push
    end

    test "mentions badges an ordinary message rather than pushing it" do
      assert Resolver.allows?("mentions", %{kind: :message, mentions_me: false}) == :badge
    end

    test "mute permits nothing" do
      assert Resolver.allows?("mute", %{kind: :message, mentions_me: true}) == :none
    end

    test "a direct message pushes at every level except mute" do
      assert Resolver.allows?("mentions", %{kind: :dm, mentions_me: false}) == :push
      assert Resolver.allows?("all", %{kind: :dm, mentions_me: false}) == :push
      assert Resolver.allows?("mute", %{kind: :dm, mentions_me: true}) == :none
    end

    test "a reply to the member's own message pushes at mentions" do
      assert Resolver.allows?("mentions", %{kind: :reply_to_me, mentions_me: false}) == :push
    end
  end
end
