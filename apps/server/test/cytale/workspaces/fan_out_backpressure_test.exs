defmodule Cytale.Workspaces.FanOutBackpressureTest do
  @moduledoc """
  PERF-06 — live-send backpressure: `FanOut` sheds the best-effort event
  classes (`TypingStart`, `PresenceUpdate`) to a live socket whose mailbox is
  over `Cytale.Config.fan_out_shed_threshold/0`, and never sheds anything
  else — message/call/state events are the product.

  Drives the production `FanOut.deliver_user_keys/2` against a REAL registry
  subscriber: the "wedged" socket is a process that never drains its mailbox,
  so its `:message_queue_len` is exactly the number of messages the test put
  there. No mocks — this is the same `Process.info/2` probe the delivery path
  runs.
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces.FanOut

  defp unique, do: System.unique_integer([:positive, :monotonic])

  defp payload, do: %{"channel_id" => "c#{unique()}", "user_id" => "1"}

  # A live subscriber that never reads its mailbox (nothing sends it `:stop`
  # until cleanup), so the delivery probe sees precisely the queue the test
  # built.
  defp start_wedged!(route) do
    parent = self()

    pid =
      spawn(fn ->
        PushRegistry.subscribe(route, "1", self())
        send(parent, {:wedged_ready, self()})

        receive do
          :stop -> :ok
        end
      end)

    assert_receive {:wedged_ready, ^pid}, 1_000

    on_exit(fn ->
      Process.exit(pid, :kill)
      PushRegistry.unsubscribe(route, pid)
    end)

    pid
  end

  defp queue_len(pid) do
    {:message_queue_len, len} = Process.info(pid, :message_queue_len)
    len
  end

  defp push_in_queue?(pid, event_name) do
    {:messages, messages} = Process.info(pid, :messages)

    Enum.any?(messages, fn
      {:cytale_gateway_push, _from, {^event_name, _payload}, _fragment} -> true
      _other -> false
    end)
  end

  test "a socket over the shed threshold misses TypingStart but still gets MessageCreate" do
    threshold = Cytale.Config.fan_out_shed_threshold()
    uid = 9_000_000_000 + unique()
    route = PushRegistry.user_key(Integer.to_string(uid))
    wedged = start_wedged!(route)

    # Park the queue one PAST the line — the check is strictly above it.
    for i <- 1..(threshold + 1), do: send(wedged, {:pad, i})
    assert queue_len(wedged) == threshold + 1

    # Best-effort class over the line: shed — silently, nothing arrives. The
    # target still counts as attempted (it was live).
    assert FanOut.deliver_user_keys([uid], {"TypingStart", payload()}) == 1
    assert queue_len(wedged) == threshold + 1
    refute push_in_queue?(wedged, "TypingStart")

    # The product is never shed, over the line or not.
    assert FanOut.deliver_user_keys([uid], {"MessageCreate", payload()}) == 1
    assert queue_len(wedged) == threshold + 2
    assert push_in_queue?(wedged, "MessageCreate")
  end

  test "at the threshold nothing is shed (the check is strictly above)" do
    threshold = Cytale.Config.fan_out_shed_threshold()
    uid = 9_000_000_000 + unique()
    route = PushRegistry.user_key(Integer.to_string(uid))
    wedged = start_wedged!(route)

    for i <- 1..threshold, do: send(wedged, {:pad, i})
    assert queue_len(wedged) == threshold

    assert FanOut.deliver_user_keys([uid], {"TypingStart", payload()}) == 1
    assert push_in_queue?(wedged, "TypingStart")
  end

  test "PresenceUpdate sheds like TypingStart; a healthy socket is never probed into shedding" do
    threshold = Cytale.Config.fan_out_shed_threshold()
    uid = 9_000_000_000 + unique()
    wedged_route = PushRegistry.user_key(Integer.to_string(uid))
    wedged = start_wedged!(wedged_route)

    for i <- 1..(threshold + 1), do: send(wedged, {:pad, i})
    assert FanOut.deliver_user_keys([uid], {"PresenceUpdate", payload()}) == 1
    refute push_in_queue?(wedged, "PresenceUpdate")

    # An empty-queue subscriber receives the sheddable class as usual: the
    # shed is threshold-conditional, not class-conditional.
    healthy_uid = 9_000_000_000 + unique()
    healthy_route = PushRegistry.user_key(Integer.to_string(healthy_uid))
    healthy = start_wedged!(healthy_route)

    assert FanOut.deliver_user_keys([healthy_uid], {"PresenceUpdate", payload()}) == 1
    assert push_in_queue?(healthy, "PresenceUpdate")
    send(healthy, :stop)
  end
end
