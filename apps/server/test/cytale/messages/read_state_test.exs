defmodule Cytale.Messages.ReadStateTest do
  @moduledoc """
  U1 of the notification plan — the server can answer "is this message unread
  for this member?" for a channel, and an acknowledgement cannot silently
  erase an explicit unread range.

  The load-bearing property: `last_read_id` is INCLUSIVE, so "everything up to
  and including here is read". Expressing "this message, and everything after
  it, is unread" therefore needs a second, EXCLUSIVE floor — a watermark alone
  cannot say it (moving the watermark TO the marked message leaves it read).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Messages.ReadState

  # Unique per-test identifiers rather than truncate_all!/0: each TRUNCATE
  # costs 1-3s through the cluster pool (see ScyllaCase).
  defp ids do
    n = Cytale.TestNonce.get()
    {String.to_integer("9#{n}"), String.to_integer("8#{n}")}
  end

  defp rows(user_id, channel_id) do
    Cytale.Repo.execute!(
      "SELECT last_read_id, unread_floor FROM #{Cytale.Repo.keyspace()}.read_state WHERE user_id = ? AND channel_id = ?",
      [{"bigint", user_id}, {"bigint", channel_id}]
    )
    |> Enum.to_list()
  end

  describe "write/2" do
    test "acknowledging moves the watermark and leaves the floor untouched" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{unread_floor: 500})
      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 400})

      assert [%{"last_read_id" => 400, "unread_floor" => 500}] = rows(user_id, channel_id)
    end

    test "an acknowledgement that omits the floor cannot erase it" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{unread_floor: 700, last_read_id: 700})
      # The ack path supplies only the columns it owns.
      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 900})

      assert [%{"last_read_id" => 900, "unread_floor" => 700}] = rows(user_id, channel_id)
    end

    test "accepts a string-keyed map, which is how controller params arrive" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{"unread_floor" => 250, "last_read_id" => 100})

      assert [%{"last_read_id" => 100, "unread_floor" => 250}] = rows(user_id, channel_id)
    end

    test "writes are idempotent — a repeated identical write leaves one row" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 42})
      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 42})

      assert [%{"last_read_id" => 42}] = rows(user_id, channel_id)
    end
  end

  describe "get/2" do
    test "returns nil for a member with no read state" do
      {user_id, channel_id} = ids()

      assert ReadState.get(user_id, channel_id) == nil
    end

    test "returns the stored watermark and floor" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 300, unread_floor: 350})

      assert %{last_read_id: 300, unread_floor: 350} = ReadState.get(user_id, channel_id)
    end
  end

  describe "clear_unread_floor/2" do
    test "removes the floor and keeps the watermark in place" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 100, unread_floor: 500})
      :ok = ReadState.clear_unread_floor(user_id, channel_id)

      assert [%{"last_read_id" => 100, "unread_floor" => nil}] = rows(user_id, channel_id)
    end

    test "is safe when no row exists yet" do
      {user_id, channel_id} = ids()

      assert :ok = ReadState.clear_unread_floor(user_id, channel_id)
    end
  end

  describe "unread_since/3" do
    test "everything is unread when no watermark and no floor exist" do
      {user_id, channel_id} = ids()

      assert ReadState.unread_since(user_id, channel_id, 50) == true
    end

    test "an exclusive floor makes the floored message and everything after it unread" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 900, unread_floor: 700})

      assert ReadState.unread_since(user_id, channel_id, 700) == true
      assert ReadState.unread_since(user_id, channel_id, 701) == true
      # …but the range before the floor stays read, despite the floor clearing
      # being expressed by an INCLUSIVE watermark that sits past it.
      assert ReadState.unread_since(user_id, channel_id, 699) == false
    end

    test "the watermark alone is inclusive — a message at the watermark reads" do
      {user_id, channel_id} = ids()

      :ok = ReadState.write(user_id, channel_id, %{last_read_id: 400})

      assert ReadState.unread_since(user_id, channel_id, 400) == false
      assert ReadState.unread_since(user_id, channel_id, 401) == true
    end
  end
end
