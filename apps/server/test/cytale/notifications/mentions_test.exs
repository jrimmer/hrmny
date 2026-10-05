defmodule Cytale.Notifications.MentionsTest do
  @moduledoc """
  U3 of the notification plan — the server-side mention signal.

  Until this module, the ONLY server-side mention parsing lived in a private
  function inside the Discord-compat codec, and the member-facing message shape
  carried no mention information at all. The policy cannot decide "did this
  reach the member" without it, and the compat projection and the client's
  unread accrual had already drifted apart on which token forms count.

  One tokenizer serves every caller, so the two surfaces cannot disagree again.
  """

  use ExUnit.Case, async: true

  alias Cytale.Notifications.Mentions

  describe "user_ids/1" do
    test "extracts a plain mention token" do
      assert Mentions.user_ids("hey <@123456789> look") == [123_456_789]
    end

    test "extracts the nickname form, which the client's regex missed" do
      assert Mentions.user_ids("hey <@!123456789> look") == [123_456_789]
    end

    test "extracts several mentions in order and de-duplicates" do
      assert Mentions.user_ids("<@111> and <@222> and <@111>") == [111, 222]
    end

    test "a bare @name is not a mention — only the id token is" do
      assert Mentions.user_ids("hey @mia are you there") == []
    end

    test "a token longer than a snowflake is not a mention" do
      assert Mentions.user_ids("<@12345678901234567890>") == []
    end

    test "a token with no digits is not a mention" do
      assert Mentions.user_ids("<@>") == []
      assert Mentions.user_ids("<@abc>") == []
    end

    test "content with no tokens yields nothing" do
      assert Mentions.user_ids("just a sentence") == []
      assert Mentions.user_ids("") == []
      assert Mentions.user_ids(nil) == []
    end

    test "an email address does not look like a mention" do
      assert Mentions.user_ids("write to me at a@b.com") == []
    end
  end

  describe "mentions_user?/2" do
    test "true when the member's id appears" do
      assert Mentions.mentions_user?("ping <@42>", 42)
    end

    test "true for the nickname form" do
      assert Mentions.mentions_user?("ping <@!42>", 42)
    end

    test "false when a different id appears" do
      refute Mentions.mentions_user?("ping <@43>", 42)
    end

    test "false when the name matches but the id does not" do
      refute Mentions.mentions_user?("ping @jordan", 42)
    end
  end

  describe "everyone?/1 and here?/1" do
    test "each recognizes its own token" do
      assert Mentions.everyone?("heads up @everyone")
      refute Mentions.everyone?("heads up @here")
      assert Mentions.here?("heads up @here")
      refute Mentions.here?("heads up @everyone")
    end

    test "neither fires on a name that merely starts with the token" do
      refute Mentions.everyone?("@everyoneelse should see this")
      refute Mentions.here?("@heretical")
    end

    test "a broadcast token is not a user id" do
      assert Mentions.user_ids("@everyone") == []
    end
  end
end
