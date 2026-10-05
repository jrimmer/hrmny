defmodule Cytale.Messages.EventsTest do
  @moduledoc """
  The message event builders' wire shapes (`Cytale.Messages.Events`). Pure
  functions, so this stays async and DB-less; the channel-anchor guard that
  INVOKES them lives in `Cytale.Gateway.PayloadsTest` (#110).
  """

  use ExUnit.Case, async: true

  alias Cytale.Messages.Events

  # An integer-native message row (`Cytale.Messages.t/0`) — what the delete
  # routes hold after `Messages.get_message/2`.
  @message %{
    id: 7_300_000_000_000_001,
    channel_id: 7_300_000_000_000_002,
    thread_id: nil,
    author_id: 7_300_000_000_000_003,
    content: "gone",
    created_at: ~U[2026-09-14 00:00:00Z],
    edited_at: nil,
    attachments: []
  }

  describe "message_delete/1" do
    test "emits exactly the three identity keys, snowflakes as decimal strings" do
      # Deletion is terminal: identity fields only, and this exact map is the
      # byte-for-byte shape the three former inline copies published.
      assert Events.message_delete(@message) == %{
               "id" => "7300000000000001",
               "channel_id" => "7300000000000002",
               "thread_id" => nil
             }
    end

    test "carries the thread scope when the deleted row was a thread reply" do
      payload = Events.message_delete(%{@message | thread_id: 7_300_000_000_000_004})

      assert payload == %{
               "id" => "7300000000000001",
               "channel_id" => "7300000000000002",
               "thread_id" => "7300000000000004"
             }
    end
  end
end
