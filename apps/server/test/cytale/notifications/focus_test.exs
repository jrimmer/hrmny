defmodule Cytale.Notifications.FocusTest do
  @moduledoc """
  U5 of the notification plan — which of a member's sessions is being looked at
  (R16).

  Delivery reads this so one event does not notify every device. Two
  properties carry the weight: staleness resolves toward NOTIFIED (a session
  that stops reporting must never silence the member's other devices forever),
  and the answer is per member, not per session — the question is "is the
  member looking at this anywhere", not "which socket".

  Presence is deliberately not consulted: its `idle` status is one the member
  chooses from a picker, not one the client detects.
  """

  use ExUnit.Case, async: false

  alias Cytale.Notifications.Focus

  setup do
    :ok = Focus.ensure_started()
    :ok
  end

  defp user_id, do: String.to_integer("3#{Cytale.TestNonce.get()}")

  describe "report/2 and focused?/2" do
    test "a member with no report is not focused" do
      refute Focus.focused?(user_id(), "sess-1")
    end

    test "a reported focused session makes that session focused" do
      uid = user_id()

      :ok = Focus.report(uid, "sess-1", true)
      assert Focus.focused?(uid, "sess-1")
    end

    test "a report of false clears focus" do
      uid = user_id()

      :ok = Focus.report(uid, "sess-1", true)
      :ok = Focus.report(uid, "sess-1", false)

      refute Focus.focused?(uid, "sess-1")
    end

    test "reporting a second session takes focus from the first" do
      uid = user_id()

      :ok = Focus.report(uid, "sess-1", true)
      :ok = Focus.report(uid, "sess-2", true)

      assert Focus.focused?(uid, "sess-2")
      refute Focus.focused?(uid, "sess-1")
    end

    test "focus is per member — another member's focus does not leak" do
      a = user_id()
      b = user_id()

      :ok = Focus.report(a, "sess-1", true)

      refute Focus.focused?(b, "sess-1")
      refute Focus.focused?(b, "sess-9")
    end

    test "a session id the member never reported is not focused" do
      uid = user_id()

      :ok = Focus.report(uid, "sess-1", true)

      refute Focus.focused?(uid, "sess-other")
    end
  end

  describe "staleness" do
    test "a report older than the window is treated as unfocused" do
      uid = user_id()

      # Report with an already-stale timestamp rather than sleeping.
      :ok = Focus.report_at(uid, "sess-1", stale_time())

      refute Focus.focused?(uid, "sess-1")
    end

    test "a fresh report inside the window stays focused" do
      uid = user_id()

      :ok = Focus.report_at(uid, "sess-1", fresh_time())

      assert Focus.focused?(uid, "sess-1")
    end
  end

  describe "clear/2" do
    test "clearing a focused session returns the member to unfocused" do
      uid = user_id()

      :ok = Focus.report(uid, "sess-1", true)
      :ok = Focus.clear(uid, "sess-1")

      refute Focus.focused?(uid, "sess-1")
    end

    test "clearing an unfocused session is harmless" do
      assert :ok = Focus.clear(user_id(), "sess-never")
    end

    test "clearing one session leaves another member's focus alone" do
      a = user_id()
      b = user_id()

      :ok = Focus.report(a, "sess-1", true)
      :ok = Focus.report(b, "sess-2", true)
      :ok = Focus.clear(a, "sess-1")

      refute Focus.focused?(a, "sess-1")
      assert Focus.focused?(b, "sess-2")
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp stale_time do
    DateTime.utc_now()
    |> DateTime.add(-(Focus.stale_after_seconds() + 5), :second)
  end

  defp fresh_time, do: DateTime.utc_now()
end
