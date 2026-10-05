defmodule Cytale.Messages.AckWriterTest do
  @moduledoc """
  Review #20: the gateway read-ack's storage leg runs in per-user ordered
  writer partitions, off the socket. The #117 contract must hold there
  exactly as it did inline: the watermark never regresses, and an ack
  answers the mentions it covers.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Messages.{AckWriter, ReadState}

  defp id, do: Cytale.Snowflake.next()

  test "acks for one member apply in order and the watermark never regresses" do
    user = id()
    scope = id()
    [low, mid, high] = Enum.sort([id(), id(), id()])

    # A device that read further, then one that opened a short page.
    :ok = AckWriter.persist(user, scope, mid)
    :ok = AckWriter.persist(user, scope, high)
    :ok = AckWriter.persist(user, scope, low)
    :ok = AckWriter.await()

    assert %{last_read_id: ^high} = ReadState.get(user, scope)
  end

  test "an ack answers the member's mentions it covers — and only those" do
    user = id()
    author = id()
    # A real channel the mentioned member can view (mentions are recorded only
    # for workspace channels, and only for members who can see them).
    {:ok, ws} = Cytale.Workspaces.create_workspace(author, "ackw-#{System.unique_integer([:positive])}")
    {:ok, ch} = Cytale.Workspaces.create_channel(ws.workspace_id, "ackw")
    :ok = Cytale.Workspaces.add_member(ws.workspace_id, user, author)
    channel = ch.channel_id

    {:ok, covered} =
      Cytale.Messages.create_message(%{channel_id: channel, author_id: author, content: "<@#{user}> first"})

    {:ok, later} =
      Cytale.Messages.create_message(%{channel_id: channel, author_id: author, content: "<@#{user}> second"})

    assert {[_, _], _} = Cytale.Inbox.list_for_user(user)

    :ok = AckWriter.persist(user, channel, covered.id)
    :ok = AckWriter.await()

    assert {[remaining], _} = Cytale.Inbox.list_for_user(user)
    assert to_string(remaining["message_id"]) == Integer.to_string(later.id)
  end
end
