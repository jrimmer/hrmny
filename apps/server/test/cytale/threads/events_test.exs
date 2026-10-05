defmodule Cytale.Threads.EventsTest do
  @moduledoc """
  The thread lifecycle payloads carry the thread's ANCHOR — the seed message
  it hangs off — as a wire snowflake string.

  Without it, a client that did not create the thread (a bot, a webhook,
  another person, another device of the same user) could not place the reply
  indicator on the seed message: the replies stayed invisible until a reload
  refetched the roster, and approval prompts posted into such threads timed
  out unanswered. The roster read has always carried `parent_message_id`;
  these pin the live events to the same shape. DB-free: the builders are pure.
  """

  use ExUnit.Case, async: true

  alias Cytale.Threads.Events

  defp thread(overrides \\ %{}) do
    Map.merge(
      %{
        thread_id: 99_576_051_658_653_696,
        channel_id: 97_588_707_502_063_616,
        parent_message_id: 99_576_051_000_000_001,
        name: "approval",
        created_by: 12_345,
        archived: false,
        member_count: 0,
        message_count: 0,
        latest_reply_id: nil,
        latest_reply_at: nil,
        created_at: ~U[2026-10-02 12:00:00.000Z]
      },
      overrides
    )
  end

  describe "thread_create/1" do
    test "carries the anchor as a decimal string (Integer.to_string, never a JSON number)" do
      payload = Events.thread_create(thread())

      assert payload["parent_message_id"] == Integer.to_string(99_576_051_000_000_001)
      assert payload["parent_message_id"] == "99576051000000001"
      assert payload["id"] == "99576051658653696"
      assert payload["channel_id"] == "97588707502063616"
    end

    test "a standalone thread states its absent anchor as null — the key is always present" do
      payload = Events.thread_create(thread(%{parent_message_id: nil}))

      assert Map.has_key?(payload, "parent_message_id")
      assert payload["parent_message_id"] == nil
    end

    test "survives JSON exactly as the wire carries it" do
      decoded = thread() |> Events.thread_create() |> Jason.encode!() |> Jason.decode!()
      assert decoded["parent_message_id"] == "99576051000000001"
    end
  end

  describe "thread_update/2" do
    test "restates the anchor, so a client that missed the create still places the chip" do
      payload = Events.thread_update(thread(), %{archived: true})

      assert payload["parent_message_id"] == "99576051000000001"
      assert payload["archived"] == true
      assert payload["channel_id"] == "97588707502063616"
    end

    test "a standalone thread's update carries a null anchor" do
      assert %{"parent_message_id" => nil} = Events.thread_update(thread(%{parent_message_id: nil}), %{})
    end
  end

  describe "thread_list_sync/2" do
    test "each entry is a ThreadCreate payload — anchor included — plus member_state" do
      member = %{notify: true, last_read_id: 7}
      %{"threads" => [entry]} = Events.thread_list_sync(1, [{thread(), member}])

      assert Map.delete(entry, "member_state") == Events.thread_create(thread())
      assert entry["parent_message_id"] == "99576051000000001"
      assert entry["member_state"] == %{"notify" => true, "last_read_id" => "7"}
    end
  end
end
