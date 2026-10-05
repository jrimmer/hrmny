defmodule CytaleWeb.Compat.MentionProjectionTest do
  @moduledoc """
  #66 — the `mentions` projection, verified WITHOUT a database.

  The codec takes an injectable author cache (`resolved`: `author_id =>
  {user_object, kind}`, the gateway's PERF-2 snapshot). Populating it by hand
  makes the projection testable in isolation: no Scylla, no fixtures, and the
  assertions run in milliseconds.

  This suite exists because the DB-backed codec suite could not run while the
  local Scylla was down — the projection is pure shape work, so it deserves a
  home that does not depend on a cluster being up.
  """

  use ExUnit.Case, async: true

  alias CytaleWeb.Compat.MessageCodec

  @author_id 8_100_000_000_000_001
  @mentioned_id 8_100_000_000_000_002

  defp user(user_id, username),
    do: MessageCodec.user_object(%{user_id: user_id, username: username})

  # The cache the gateway would hold: one snapshot per distinct id.
  defp resolved do
    %{
      @author_id => {user(@author_id, "author_user"), :human},
      @mentioned_id => {user(@mentioned_id, "mentioned_user"), :human}
    }
  end

  defp native(content) do
    %{
      "id" => "1234",
      "channel_id" => 99,
      "author_id" => @author_id,
      "content" => content,
      "thread_id" => nil,
      "reply_to_id" => nil,
      "referenced" => nil,
      "created_at" => "2026-09-10T12:00:00Z",
      "edited_at" => nil,
      "attachments" => []
    }
  end

  test "a mention token projects into Discord's mentions array" do
    d =
      MessageCodec.message_from_native(
        native("hey <@#{@mentioned_id}> take a look"),
        "42",
        resolved()
      )

    # The token stays in content (Discord's wire form — clients render it)...
    assert d["content"] == "hey <@#{@mentioned_id}> take a look"

    # ...and the array carries the full user object.
    assert [user] = d["mentions"]
    assert user["id"] == Integer.to_string(@mentioned_id)
    assert user["username"] == "mentioned_user"

    # discord.py's `User._update` indexes `avatar` unguarded, so the object
    # must carry the whole set (the #64 field class).
    for key <- ["id", "username", "discriminator", "avatar"] do
      assert Map.has_key?(user, key), "mention object is missing #{key}"
    end
  end

  test "the nickname token form is accepted, and duplicates collapse to one entry" do
    d =
      MessageCodec.message_from_native(
        native("<@!#{@mentioned_id}> and <@#{@mentioned_id}> again"),
        "42",
        resolved()
      )

    assert [user] = d["mentions"]
    assert user["id"] == Integer.to_string(@mentioned_id)
  end

  test "a message with no token carries an empty array" do
    d = MessageCodec.message_from_native(native("no mentions here"), "42", resolved())

    assert d["mentions"] == []
    # `mention_roles` has no Cytale syntax and `mention_everyone` has no
    # concept — the permission base is not a ping.
    assert d["mention_roles"] == []
    assert d["mention_everyone"] == false
  end

  test "plain text that LOOKS like a tag is not a mention" do
    # The ticket's live example: a human typed `@mia`, no id was ever
    # recorded, so there is nothing to project. Name-matching is explicitly
    # NOT the answer (it fires on `@miaine`, emails and prose).
    for content <- [
          "@mia Are you here?",
          "ask @mia about the deploy",
          "I emailed me@miacorp.com"
        ] do
      d = MessageCodec.message_from_native(native(content), "42", resolved())
      assert d["mentions"] == [], "#{content} must not resolve to a mention"
    end
  end

  test "a malformed or oversized id never reaches a lookup" do
    # 20 digits overflows int64: dropped rather than handed to Scylla.
    for content <- ["<@99999999999999999999> hi", "<@> hi", "<@abc> hi", "<@0> hi"] do
      d = MessageCodec.message_from_native(native(content), "42", resolved())
      assert d["mentions"] == [], "#{content} must not resolve to a mention"
    end
  end

  test "mentions inside a sentence and after a line break both project" do
    d =
      MessageCodec.message_from_native(
        native("first line\ncc <@#{@mentioned_id}> ok"),
        "42",
        resolved()
      )

    assert d["mentions"] |> Enum.map(& &1["id"]) == [Integer.to_string(@mentioned_id)]
  end
end
