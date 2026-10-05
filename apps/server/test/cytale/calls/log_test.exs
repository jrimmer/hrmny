defmodule Cytale.Calls.LogTest do
  @moduledoc """
  Voice plan U3 (KTD5/R4) — the standing call-log thread: created lazily on
  first call, anchorless, system-named, mapped in `call_threads`, and
  REUSED by every later call in the channel.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Calls.Log
  alias Cytale.Threads.Thread

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  test "thread_id is nil before any call created one (lazy)" do
    channel_id = Cytale.Snowflake.next()
    assert Log.thread_id(channel_id) == nil
  end

  test "ensure_thread lazily creates an anchorless Call log thread + mapping" do
    channel_id = Cytale.Snowflake.next()
    starter = Cytale.Snowflake.next()

    {:ok, thread_id} = Log.ensure_thread(channel_id, starter)

    assert %{} = t = Thread.get(thread_id)
    assert t.channel_id == channel_id
    assert t.parent_message_id == nil
    assert t.name == Log.log_name()
    assert t.name == "Call log"
    assert t.created_by == starter

    assert Log.thread_id(channel_id) == thread_id
  end

  test "ensure_thread reuses the mapping — no duplicate thread on later calls" do
    channel_id = Cytale.Snowflake.next()
    first_starter = Cytale.Snowflake.next()
    later_starter = Cytale.Snowflake.next()

    {:ok, first} = Log.ensure_thread(channel_id, first_starter)
    {:ok, second} = Log.ensure_thread(channel_id, later_starter)

    assert second == first

    # Exactly one call-log thread exists in the channel.
    logs = Thread.list_in_channel(channel_id) |> Enum.filter(&(&1.name == "Call log"))
    assert [%{thread_id: ^first}] = logs

    # A user-named thread in the same channel never collides — the mapping
    # is keyed by channel, not by name.
    {:ok, user_thread} = Thread.start(channel_id, nil, run_nonce() <> " standup", later_starter)
    {:ok, ^first} = Log.ensure_thread(channel_id, first_starter)
    assert user_thread.thread_id != first
  end
end
