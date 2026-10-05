defmodule Cytale.Notifications.PreferencesTest do
  @moduledoc """
  U2 of the notification plan — the preference hierarchy (R5, R6, R7).

  Two properties carry the weight. First, an ABSENT row means inherit: writing
  nothing for a defaulted channel is what makes "what did this member actually
  choose" answerable without reconstructing a cascade. Second, the three
  layers are stored in one partition so the per-message decision costs one
  read, and a workspace id can never be mistaken for a channel id.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Notifications.Preferences

  defp user_id, do: String.to_integer("7#{Cytale.TestNonce.get()}")

  defp entity_id, do: String.to_integer("6#{Cytale.TestNonce.get()}")

  defp raw_rows(user_id) do
    Cytale.Repo.execute!(
      "SELECT scope, entity_id, level FROM #{Cytale.Repo.keyspace()}.notification_preferences WHERE user_id = ?",
      [{"bigint", user_id}]
    )
    |> Enum.to_list()
  end

  describe "set_level/4 and get/2" do
    test "an account-level level round-trips" do
      uid = user_id()

      assert :ok = Preferences.set_level(uid, :account, 0, "mentions")
      assert Preferences.get(uid, :account, 0) == "mentions"
    end

    test "workspace and channel levels round-trip independently" do
      uid = user_id()
      ws = entity_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :workspace, ws, "all")
      :ok = Preferences.set_level(uid, :channel, ch, "mute")

      assert Preferences.get(uid, :workspace, ws) == "all"
      assert Preferences.get(uid, :channel, ch) == "mute"
    end

    test "a member with no overrides reads as having written nothing" do
      uid = user_id()

      assert Preferences.get(uid, :account, 0) == nil
      assert Preferences.get(uid, :channel, entity_id()) == nil
      assert Preferences.all(uid) == %{}
      assert raw_rows(uid) == []
    end

    test "an id can be a workspace in one layer and not collide with a channel" do
      uid = user_id()
      # The same numeric id used at two scopes must stay two rows.
      shared = entity_id()

      :ok = Preferences.set_level(uid, :workspace, shared, "all")
      :ok = Preferences.set_level(uid, :channel, shared, "mute")

      assert Preferences.get(uid, :workspace, shared) == "all"
      assert Preferences.get(uid, :channel, shared) == "mute"
      assert length(raw_rows(uid)) == 2
    end

    test "writing a level twice replaces rather than duplicates" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :channel, ch, "all")
      :ok = Preferences.set_level(uid, :channel, ch, "mentions")

      assert Preferences.get(uid, :channel, ch) == "mentions"
      assert length(raw_rows(uid)) == 1
    end
  end

  describe "all/1" do
    test "returns every override keyed by scope and entity" do
      uid = user_id()
      ws = entity_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :account, 0, "mentions")
      :ok = Preferences.set_level(uid, :workspace, ws, "all")
      :ok = Preferences.set_level(uid, :channel, ch, "mute")

      all = Preferences.all(uid)

      assert all[%{scope: :account, entity_id: 0}] == "mentions"
      assert all[%{scope: :workspace, entity_id: ws}] == "all"
      assert all[%{scope: :channel, entity_id: ch}] == "mute"
    end

    test "one member's overrides never appear in another's" do
      a = user_id()
      b = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(a, :channel, ch, "mute")

      assert Preferences.all(b) == %{}
    end
  end

  describe "clear/3" do
    test "clearing returns the entity to inherit and removes the row" do
      uid = user_id()
      ws = entity_id()

      :ok = Preferences.set_level(uid, :workspace, ws, "all")
      :ok = Preferences.clear(uid, :workspace, ws)

      assert Preferences.get(uid, :workspace, ws) == nil
      assert raw_rows(uid) == []
    end

    test "clearing one layer leaves the others alone" do
      uid = user_id()
      ch = entity_id()

      :ok = Preferences.set_level(uid, :account, 0, "mentions")
      :ok = Preferences.set_level(uid, :channel, ch, "mute")
      :ok = Preferences.clear(uid, :channel, ch)

      assert Preferences.get(uid, :channel, ch) == nil
      assert Preferences.get(uid, :account, 0) == "mentions"
    end

    test "is safe when nothing was set" do
      assert :ok = Preferences.clear(user_id(), :channel, entity_id())
    end
  end

  describe "clear_all/1" do
    test "removes every layer for one member and leaves another member intact" do
      uid = user_id()
      other = user_id()

      :ok = Preferences.set_level(uid, :account, 0, "mentions")
      :ok = Preferences.set_level(uid, :channel, entity_id(), "mute")
      :ok = Preferences.set_level(other, :account, 0, "all")

      :ok = Preferences.clear_all(uid)

      assert Preferences.all(uid) == %{}
      assert Preferences.get(other, :account, 0) == "all"
    end
  end

  describe "validation" do
    test "an unknown level is refused rather than stored" do
      uid = user_id()

      assert {:error, :invalid_level} = Preferences.set_level(uid, :account, 0, "sometimes")
      assert Preferences.all(uid) == %{}
    end

    test "an unknown scope is refused rather than stored" do
      uid = user_id()

      assert {:error, :invalid_scope} = Preferences.set_level(uid, :nonsense, 0, "all")
      assert Preferences.all(uid) == %{}
    end

    test "a level is required" do
      assert {:error, :invalid_level} = Preferences.set_level(user_id(), :account, 0, nil)
    end
  end
end
