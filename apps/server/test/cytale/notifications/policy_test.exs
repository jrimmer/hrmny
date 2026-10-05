defmodule Cytale.Notifications.PolicyTest do
  @moduledoc """
  U3 of the notification plan — the one function that decides (R1, R2, R4, R9).

  The policy is pure: it takes the event, the message content, and the
  member's already-loaded preference map, and returns a decision with the rule
  and layer that produced it. Purity is what keeps it off the hot path's
  database and makes every combination testable without a socket.

  Every case below asserts the REASON, not only the decision — the reason is
  what the app shows a member who asks why something did or did not reach them,
  so a wrong reason is a visible bug even when the decision is right.
  """

  use ExUnit.Case, async: true

  alias Cytale.Notifications.Policy

  defp prefs(entries \\ []) do
    Map.new(entries, fn {scope, entity_id, level} ->
      {%{scope: scope, entity_id: entity_id}, level}
    end)
  end

  # `broadcast_permitted: true` — the dispatcher's verdict that the author held
  # `mention_everyone` (BroadcastGate). The policy trusts it; the tests below
  # that are about broadcasts assume a permitted author unless they say not.
  defp event(attrs) do
    Map.merge(%{kind: :message, content: "hello", author_id: 1, broadcast_permitted: true}, Map.new(attrs))
  end

  defp decide(recipient_id, event, preferences, opts \\ []) do
    Policy.decide(event, recipient_id, Keyword.merge([preferences: preferences], opts))
  end

  describe "the event taxonomy (R2)" do
    test "a channel message with no mention does not push at the default level" do
      d = decide(42, event(content: "just chatting"), prefs())

      assert d.verdict == :badge
      assert d.rule == :channel_message
    end

    test "a direct mention pushes at the default level" do
      d = decide(42, event(content: "hey <@42> look"), prefs())

      assert d.verdict == :push
      assert d.rule == :direct_mention
    end

    test "a nickname-form mention pushes the same as the plain form" do
      d = decide(42, event(content: "hey <@!42> look"), prefs())

      assert d.verdict == :push
      assert d.rule == :direct_mention
    end

    test "a mention of somebody else does not push" do
      d = decide(42, event(content: "hey <@7> look"), prefs())

      assert d.verdict == :badge
      assert d.rule == :channel_message
    end

    # Owner direction 2026-09-27: "Mentions only" INCLUDES @everyone/@here —
    # a broadcast addresses the member, so at the default level it pushes the
    # way a direct mention does. The per-workspace "Suppress @everyone and
    # @here" switch is the member's way out (its own describe block below).
    test "a broadcast at the default level pushes like a mention" do
      d = decide(42, event(content: "@everyone standup"), prefs())

      assert d.verdict == :push
      assert d.rule == :broadcast_mention
    end

    test "@here pushes at the default level too" do
      d = decide(42, event(content: "@here anyone around?"), prefs())

      assert d.verdict == :push
      assert d.rule == :broadcast_mention
    end

    test "a broadcast pushes a member who asked for all activity" do
      d = decide(42, event(content: "@everyone standup"), prefs([{:account, 0, "all"}]))

      assert d.verdict == :push
      assert d.rule == :broadcast_mention
    end

    test "a reply to the member's own message pushes at the default level" do
      d = decide(42, event(content: "agreed", reply_to_author_id: 42), prefs())

      assert d.verdict == :push
      assert d.rule == :reply_to_me
    end

    test "a reply to somebody else is an ordinary channel message" do
      d = decide(42, event(content: "agreed", reply_to_author_id: 7), prefs())

      assert d.verdict == :badge
      assert d.rule == :channel_message
    end

    test "a direct message pushes regardless of channel configuration" do
      d = decide(42, event(kind: :dm, content: "hi"), prefs([{:channel, 9, "mute"}]))

      assert d.verdict == :push
      assert d.rule == :direct_message
    end

    test "the member's own message never notifies them" do
      d = decide(42, event(content: "hey <@42> reminder to self", author_id: 42), prefs())

      assert d.verdict == :none
      assert d.rule == :own_message
    end

    test "a mention outranks a reply when both are present" do
      d = decide(42, event(content: "hey <@42>", reply_to_author_id: 42), prefs())

      assert d.rule == :direct_mention
    end
  end

  describe "the preference ladder" do
    test "all pushes ordinary channel traffic" do
      d = decide(42, event(content: "fyi"), prefs([{:account, 0, "all"}]))

      assert d.verdict == :push
      assert d.rule == :channel_message
    end

    test "mentions badges ordinary traffic but pushes a mention" do
      p = prefs([{:account, 0, "mentions"}])

      assert decide(42, event(content: "fyi"), p).verdict == :badge
      assert decide(42, event(content: "<@42> fyi"), p).verdict == :push
    end

    # decide/4 reads mutes from the database
    @tag :scylla
    test "mute silences even a direct mention" do
      d = decide(42, event(content: "<@42> urgent"), prefs([{:channel, 9, "mute"}]), channel_id: 9)

      assert d.verdict == :none
      assert d.rule == :muted
    end

    # decide/4 reads mutes from the database
    @tag :scylla
    test "mute silences a reply to the member's own message" do
      d =
        decide(42, event(content: "ok", reply_to_author_id: 42), prefs([{:channel, 9, "mute"}]), channel_id: 9)

      assert d.verdict == :none
      assert d.rule == :muted
    end

    # A DM is not in a thread, so a level set on some other thread cannot reach
    # it. The rules reach a DM only through the entity it actually names.
    # decide/4 reads mutes from the database
    @tag :scylla
    test "a direct message is not silenced by a thread level" do
      p = prefs([{:thread, 5, "mute"}])

      assert decide(42, event(kind: :dm, content: "hi"), p, thread_id: 5).verdict == :push
    end

    # Muting a DM conversation is a legitimate member instruction — it is the
    # only way to quiet a noisy direct message — so an explicit mute silences a
    # DM like anything else. What the DM rule buys is that no level BELOW mute
    # can demote it: "mentions only" never turns a direct message into a badge.
    # decide/4 reads mutes from the database
    @tag :scylla
    test "muting a direct message conversation silences it" do
      p = prefs([{:channel, 9, "mute"}])

      d = decide(42, event(kind: :dm, content: "hi"), p, channel_id: 9)

      assert d.verdict == :none
      assert d.rule == :muted
    end

    test "mentions-only never demotes a direct message to a badge" do
      p = prefs([{:channel, 9, "mentions"}])

      d = decide(42, event(kind: :dm, content: "hi"), p, channel_id: 9)

      assert d.verdict == :push
      assert d.rule == :direct_message
    end
  end

  describe "the participation sweep's reason (R11)" do
    # The resolver lifts a muted level to "mentions" when the member has posted
    # where the event happened. Reporting that decision's rule as ":muted"
    # would be a lie the member can see — they set a mute and got a
    # notification — so the reason has to name what actually decided.
    test "a level raised by participation names that rule" do
      d =
        Policy.decide(event(content: "a reply for you"), 42,
          preferences: prefs([{:channel, 9, "mute"}]),
          channel_id: 9,
          resolved_override: %{level: "mentions", decided_by: :participation, explicit?: true}
        )

      assert d.rule == :participated
      assert d.decided_by == :participation
      assert d.verdict == :badge
    end

    test "a mention raised by participation still reports the mention" do
      d =
        Policy.decide(event(content: "hey <@42>"), 42,
          preferences: prefs([{:channel, 9, "mute"}]),
          channel_id: 9,
          resolved_override: %{level: "mentions", decided_by: :participation, explicit?: true}
        )

      assert d.rule == :direct_mention
      assert d.verdict == :push
    end

    # decide/4 reads mutes from the database
    @tag :scylla
    test "a genuinely muted channel still reports the mute" do
      d =
        Policy.decide(event(content: "unrelated chatter"), 42,
          preferences: prefs([{:channel, 9, "mute"}]),
          channel_id: 9
        )

      assert d.rule == :muted
      assert d.verdict == :none
    end
  end

  describe "provenance (R8, R9)" do
    test "the decision names the layer that decided it" do
      d = decide(42, event(content: "fyi"), prefs([{:workspace, 3, "all"}]), workspace_id: 3)

      assert d.decided_by == :workspace
      assert d.explicit? == true
    end

    test "an unset member reports the default as not explicit" do
      d = decide(42, event(content: "fyi"), prefs())

      assert d.decided_by == :account
      assert d.explicit? == false
    end

    # decide/4 reads mutes from the database
    @tag :scylla
    test "a more specific layer overrides a broader one in the decision" do
      p = prefs([{:account, 0, "all"}, {:channel, 9, "mute"}])
      d = decide(42, event(content: "fyi"), p, channel_id: 9)

      assert d.decided_by == :channel
      assert d.verdict == :none
    end

    test "the reason carries a stable rule name, not a formatted sentence" do
      d = decide(42, event(content: "fyi"), prefs())

      assert is_atom(d.rule)
    end
  end

  describe "edge cases" do
    test "an attachment-only message with no content is not a mention" do
      d = decide(42, event(content: nil), prefs())

      assert d.verdict == :badge
    end

    test "the author of a mention in their own message is not notified by it" do
      d = decide(7, event(content: "cc <@7>", author_id: 7), prefs())

      assert d.verdict == :none
    end

    test "a broadcast pushes a member whose level is mentions-only" do
      d = decide(42, event(content: "@everyone standup"), prefs([{:channel, 9, "mentions"}]), channel_id: 9)

      assert d.verdict == :push
      assert d.rule == :broadcast_mention
    end
  end

  describe "an @everyone from an author without mention_everyone (security tier 1 #8)" do
    test "is ordinary traffic: no push at the default level, rule is channel_message" do
      d = decide(42, event(content: "@everyone standup", broadcast_permitted: false), prefs())

      assert d.verdict == :badge
      assert d.rule == :channel_message
    end

    test "a missing verdict is NOT a permission (fail-closed)" do
      d = decide(42, Map.delete(event(content: "@here anyone?"), :broadcast_permitted), prefs())
      assert d.rule == :channel_message
    end
  end

  describe "Suppress @everyone and @here (per member, per workspace)" do
    test "a suppressing member at mentions-only is badged, not pushed" do
      d =
        decide(42, event(content: "@everyone standup"), prefs([{:broadcasts, 5, "suppress"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.verdict == :badge
      # The rule still names the broadcast so the explainer can say why.
      assert d.rule == :broadcast_mention
    end

    test "suppression is per workspace: another workspace's switch does not apply" do
      d =
        decide(42, event(content: "@here standup"), prefs([{:broadcasts, 6, "suppress"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.verdict == :push
    end

    test "a direct mention still pushes a suppressing member" do
      d =
        decide(42, event(content: "@everyone and <@42> especially"), prefs([{:broadcasts, 5, "suppress"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.verdict == :push
      assert d.rule == :direct_mention
    end

    test "all activity still pushes a suppressed broadcast (it is still activity)" do
      d =
        decide(42, event(content: "@everyone standup"), prefs([{:broadcasts, 5, "suppress"}, {:workspace, 5, "all"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.verdict == :push
    end

    # Reaches the database: the mute branch reads thread participation
    # (Participations.participated?/2), so the DB-free run must exclude it.
    @tag :scylla
    test "a mute still silences a broadcast" do
      d =
        decide(42, event(content: "@everyone standup"), prefs([{:channel, 9, "mute"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.verdict == :none
      assert d.rule == :muted
    end

    test "the switch row never reads as a level" do
      d =
        decide(42, event(content: "just chatting"), prefs([{:broadcasts, 5, "suppress"}]),
          workspace_id: 5,
          channel_id: 9
        )

      assert d.level == "mentions"
      assert d.decided_by == :account
    end
  end

  # The sender's `allowed_mentions`, as the create path put it on the wire
  # (`mention_user_ids`; absent = no restriction).
  describe "a sender's allowed_mentions (mention_user_ids)" do
    test "a suppressed direct mention is ordinary traffic" do
      d = decide(42, event(content: "hey <@42>", mention_user_ids: []), prefs())

      assert d.verdict == :badge
      assert d.rule == :channel_message
    end

    test "an allowed direct mention still pushes" do
      d = decide(42, event(content: "hey <@42>", mention_user_ids: [42]), prefs())

      assert d.verdict == :push
      assert d.rule == :direct_mention
    end

    test "replied_user off: the replied-to author is not told as a reply" do
      d = decide(42, event(content: "agreed", reply_to_author_id: 42, mention_user_ids: []), prefs())
      refute d.rule == :reply_to_me

      d = decide(42, event(content: "agreed", reply_to_author_id: 42, mention_user_ids: [42]), prefs())
      assert d.rule == :reply_to_me
    end
  end
end
