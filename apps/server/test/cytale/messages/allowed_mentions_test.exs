defmodule Cytale.Messages.AllowedMentionsTest do
  @moduledoc """
  Discord's `allowed_mentions`, parsed and applied once for every sender
  (`Cytale.Messages.AllowedMentions`). Pure: no database.
  """

  use ExUnit.Case, async: true

  alias Cytale.Messages.AllowedMentions

  describe "parse/1" do
    test "absent is the unrestricted default" do
      assert {:ok, nil} = AllowedMentions.parse(nil)
      assert AllowedMentions.everyone?(nil)
      assert AllowedMentions.user_ids(nil, "<@5> hi", 9) == nil
    end

    test "Discord's shapes are accepted; ids as strings or numbers" do
      assert {:ok, %{parse: [], users: [], roles: [], replied_user: false}} = AllowedMentions.parse(%{})

      assert {:ok, %{parse: ["everyone", "users"], replied_user: true}} =
               AllowedMentions.parse(%{"parse" => ["everyone", "users"], "replied_user" => true})

      assert {:ok, %{users: [5, 6], roles: [7]}} =
               AllowedMentions.parse(%{"parse" => [], "users" => ["5", 6], "roles" => ["7"]})
    end

    test "malformed or contradictory objects are refused" do
      for bad <- [
            "everyone",
            %{"parse" => "everyone"},
            %{"parse" => ["channels"]},
            %{"users" => ["x"]},
            %{"users" => Enum.map(1..101, &Integer.to_string/1)},
            %{"replied_user" => "yes"},
            # Discord refuses naming a kind in `parse` AND listing its ids.
            %{"parse" => ["users"], "users" => ["5"]},
            %{"parse" => ["roles"], "roles" => ["7"]}
          ] do
        assert {:error, :invalid_allowed_mentions} = AllowedMentions.parse(bad), inspect(bad)
      end
    end
  end

  describe "applying it" do
    test "parse governs the broadcast half" do
      {:ok, quiet} = AllowedMentions.parse(%{"parse" => ["users"]})
      {:ok, loud} = AllowedMentions.parse(%{"parse" => ["everyone"]})

      refute AllowedMentions.everyone?(quiet)
      assert AllowedMentions.everyone?(loud)
    end

    test "users: every content mention with parse users, else only the listed ones" do
      {:ok, all} = AllowedMentions.parse(%{"parse" => ["users"]})
      {:ok, listed} = AllowedMentions.parse(%{"users" => ["6"]})
      {:ok, none} = AllowedMentions.parse(%{"parse" => []})
      content = "<@5> and <@!6>"

      assert AllowedMentions.user_ids(all, content, nil) == [5, 6]
      assert AllowedMentions.user_ids(listed, content, nil) == [6]
      assert AllowedMentions.user_ids(none, content, nil) == []
      # A listed id that is not in the content notifies nobody.
      assert AllowedMentions.user_ids(listed, "<@5>", nil) == []
    end

    test "replied_user adds the replied-to author, and only then" do
      {:ok, reply_ping} = AllowedMentions.parse(%{"parse" => [], "replied_user" => true})
      {:ok, reply_quiet} = AllowedMentions.parse(%{"parse" => []})

      assert AllowedMentions.user_ids(reply_ping, "thanks", 9) == [9]
      assert AllowedMentions.user_ids(reply_quiet, "thanks", 9) == []
      assert AllowedMentions.user_ids(reply_ping, "thanks", nil) == []
    end

    test "notifies?/2: nil is no restriction" do
      assert AllowedMentions.notifies?(nil, 5)
      assert AllowedMentions.notifies?([5], 5)
      refute AllowedMentions.notifies?([], 5)
    end
  end
end
