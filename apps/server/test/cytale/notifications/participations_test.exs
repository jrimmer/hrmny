defmodule Cytale.Notifications.ParticipationsTest do
  @moduledoc """
  U11 of the notification plan — the participation index (R11).

  The rule this serves is the one the whole design was justified by: a member
  who muted a noisy channel must still be told when somebody replies to them
  there. Discord and Slack both lose that reply silently, and it is the single
  most-cited "I missed something addressed to me" cause.

  Deliberately a small dedicated index rather than a read of the author
  message table: that partition can hold thousands of rows for an active
  member, and the notification decision runs per message per recipient, so
  scanning it would put an unbounded read on the hot path.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Notifications.Participations

  defp user_id, do: String.to_integer("4#{Cytale.TestNonce.get()}")
  defp channel_id, do: String.to_integer("3#{Cytale.TestNonce.get()}")

  test "a member who has never posted has not participated" do
    refute Participations.participated?(user_id(), channel_id())
  end

  test "recording a post makes the member a participant in that channel" do
    uid = user_id()
    cid = channel_id()

    :ok = Participations.record(uid, cid)

    assert Participations.participated?(uid, cid)
  end

  test "recording the same channel twice is idempotent" do
    uid = user_id()
    cid = channel_id()

    :ok = Participations.record(uid, cid)
    :ok = Participations.record(uid, cid)

    assert Participations.channels_for_user(uid) == [cid]
  end

  test "participation does not leak between channels" do
    uid = user_id()
    posted = channel_id()
    other = channel_id()

    :ok = Participations.record(uid, posted)

    assert Participations.participated?(uid, posted)
    refute Participations.participated?(uid, other)
  end

  test "participation does not leak between members" do
    uid = user_id()
    other = user_id()
    cid = channel_id()

    :ok = Participations.record(uid, cid)

    assert Participations.participated?(uid, cid)
    refute Participations.participated?(other, cid)
  end

  test "a thread id recorded as a channel behaves like any other entity" do
    uid = user_id()
    tid = channel_id()

    :ok = Participations.record(uid, tid)

    assert Participations.participated?(uid, tid)
  end
end
