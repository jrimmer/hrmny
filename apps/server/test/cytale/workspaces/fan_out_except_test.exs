defmodule Cytale.Workspaces.FanOutExceptTest do
  @moduledoc """
  Hardening plan 7.14 — an unrecognized `:except` shape must fail CLOSED.

  `excluded?/3`'s catch-all used to answer "exclude nobody", so a caller that
  passed a shape the seam did not understand got silent OVER-delivery with no
  signal — the reverse of the documented fail-closed posture. The shape is now
  validated before any routing happens, so the caller learns immediately.
  """

  use ExUnit.Case, async: true

  alias Cytale.Workspaces.FanOut

  # A channel route the caller already resolved: no Scylla read, no `dm_targets`
  # lookup — the validation under test is the only thing in the path.
  defp resolved_channel, do: System.unique_integer([:positive])

  describe "unrecognized :except shapes" do
    test "raise, naming the offending shape" do
      assert_raise ArgumentError, ~r/unrecognized :except shape :everyone/, fn ->
        FanOut.deliver(resolved_channel(), {"TypingStart", %{}}, except: :everyone, resolved: :channel)
      end

      assert_raise ArgumentError, ~r/\{:channel, "1"\}/, fn ->
        FanOut.deliver(resolved_channel(), {"TypingStart", %{}}, except: {:channel, "1"}, resolved: :channel)
      end

      assert_raise ArgumentError, ~r/unrecognized :except shape \[\]/, fn ->
        FanOut.deliver(resolved_channel(), {"TypingStart", %{}}, except: [], resolved: :channel)
      end
    end

    test "a list of pids is not a documented shape and is refused, not silently ignored" do
      # The near-miss that motivated the raise: `[pid]` reads like an exclusion
      # set, but the seam never accepted one — it excluded nobody.
      assert_raise ArgumentError, ~r/unrecognized :except shape \[#PID/, fn ->
        FanOut.deliver(resolved_channel(), {"TypingStart", %{}}, except: [self()], resolved: :channel)
      end
    end
  end

  describe "documented :except shapes" do
    test ":none, a pid and {:user, id} still route (no raise)" do
      # No live subscribers on these unique channel keys, so each attempt is a
      # no-op that returns 0 — what matters is that validation lets them past.
      # `TypingStart` is offline-superseded, so the attempt touches no store.
      for except <- [:none, self(), {:user, "1"}, {:user, 42}] do
        assert FanOut.deliver(
                 resolved_channel(),
                 {"TypingStart", %{}},
                 except: except,
                 resolved: :channel
               ) == 0
      end
    end
  end
end
