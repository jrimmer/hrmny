defmodule CytaleWeb.Compat.ClientContractTest do
  @moduledoc """
  The compat wire's REQUIRED-KEY contract, taken from the client library
  itself rather than from our own docs (#64's lesson).

  Why this exists: #61, #63 and #64 were all the same failure shape — a
  payload that is schema-valid and documented, but missing a key a client
  indexes UNGUARDED (`data['k']`, not `data.get('k')`). Such a `KeyError`
  propagates out of discord.py's state parser and ends `Client.connect()`,
  so the bot looks connected (READY fired) and processes nothing — the
  quietest possible failure. Documenting a shape is not the same as the
  shape being consumable.

  The key sets below were extracted mechanically from **discord.py 2.7.1**
  (`/tmp/dpy`, the pinned library from #64's probe) with an AST walk that
  reports only subscripts NOT protected by an `if 'k' in data` / `.get` /
  `try` guard. Each row cites the class whose `__init__`/`_update` reads them.
  Note the shape of the asserts: presence AND type, because the parsers run
  `int(...)`/`parse_time(...)` on these — a `null` is as fatal as an absent
  key (`int(None)` → TypeError, `parse_time(None)` → AttributeError).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias CytaleWeb.Compat.MessageCodec

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  # Fails with the MISSING KEYS named, not just "assertion failed" — the whole
  # point is that a reader diagnoses in one line.
  defp assert_keys!(object, required, client_class) do
    missing = Enum.reject(required, &Map.has_key?(object, &1))

    assert missing == [],
           "#{client_class} indexes these UNGUARDED; missing from our payload: " <>
             "#{inspect(missing)}\npayload: #{inspect(object)}"

    assert is_map(object)
  end

  describe "user objects (discord.py BaseUser._update)" do
    test "every user object carries id/username/discriminator/avatar" do
      user = MessageCodec.user_object(%{user_id: 7, username: "someone"})

      assert_keys!(user, ["id", "username", "discriminator", "avatar"], "BaseUser._update")
      assert is_binary(user["id"])
      assert is_binary(user["username"])
      assert is_binary(user["discriminator"])
    end
  end

  describe "channel objects" do
    test "text channels (TextChannel.__init__ + _update)" do
      ch =
        MessageCodec.channel(%{
          channel_id: 7,
          workspace_id: 9,
          name: "general",
          type: 0,
          position: 2,
          last_message_id: nil
        })

      assert_keys!(ch, ["id", "type", "name", "position"], "TextChannel")
      assert is_integer(ch["type"])
      assert is_integer(ch["position"])
      assert is_binary(ch["id"]) and is_binary(ch["name"])
    end

    test "categories (CategoryChannel._update)" do
      ch =
        MessageCodec.channel(%{
          channel_id: 7,
          workspace_id: 9,
          name: "cat",
          type: 1,
          position: 0,
          last_message_id: nil
        })

      assert_keys!(ch, ["id", "name", "position"], "CategoryChannel")
      assert is_integer(ch["position"])
    end

    test "DM channels (DMChannel.__init__)" do
      dm = MessageCodec.channel(%{channel_id: 7, type: :dm, user_ids: [], last_message_id: nil}, 1)

      assert_keys!(dm, ["id"], "DMChannel")
    end
  end

  describe "thread objects" do
    # The full row a client gets from the REST thread routes / GUILD_CREATE.
    defp thread do
      %{
        thread_id: 11,
        channel_id: 22,
        name: "a thread",
        created_by: 33,
        archived: false,
        member_count: 2,
        message_count: 5,
        latest_reply_at: ~U[2026-09-10 12:00:00Z],
        created_at: ~U[2026-09-09 12:00:00Z]
      }
    end

    test "Thread._from_data's unguarded set" do
      t = MessageCodec.thread_channel(thread(), "42")

      assert_keys!(
        t,
        ["id", "type", "name", "parent_id", "owner_id", "message_count", "member_count", "thread_metadata"],
        "Thread._from_data"
      )

      assert is_integer(t["message_count"]) and is_integer(t["member_count"])
      assert is_binary(t["owner_id"]) and is_binary(t["parent_id"])
    end

    test "Thread._unroll_metadata's unguarded set (parsed, not just present)" do
      meta = MessageCodec.thread_channel(thread(), "42")["thread_metadata"]

      assert_keys!(meta, ["archived", "auto_archive_duration", "archive_timestamp"], "Thread._unroll_metadata")

      assert is_boolean(meta["archived"])
      assert is_integer(meta["auto_archive_duration"])
      # `parse_time(data['archive_timestamp'])` — must be a parseable ISO 8601
      # string, so a bare null would be as fatal as an absent key.
      assert {:ok, _, _} = DateTime.from_iso8601(meta["archive_timestamp"])
    end

    test "a thread row with nothing but the required columns still renders" do
      # No latest_reply_at / created_at: `archive_timestamp` must STILL be a
      # parseable string, because the subscript is unguarded. `create_timestamp`
      # may be null — discord.py reads it with `.get()` and `parse_time/1`
      # returns None for a falsy value — so null there is contract-legal.
      sparse = %{thread_id: 11, channel_id: 22, name: "sparse", created_by: 33, archived: false}
      t = MessageCodec.thread_channel(sparse, "42")

      assert is_binary(t["owner_id"])
      assert is_integer(t["message_count"]) and is_integer(t["member_count"])
      assert {:ok, _, _} = DateTime.from_iso8601(t["thread_metadata"]["archive_timestamp"])

      created = t["thread_metadata"]["create_timestamp"]
      assert is_nil(created) or match?({:ok, _, _}, DateTime.from_iso8601(created))
    end
  end

  describe "member and role objects" do
    test "Member.__init__'s unguarded set" do
      {:ok, owner} = User.create(run_unique("cc_owner"), run_unique("cc_owner@example.com"), "password-123")
      {:ok, ws} = Cytale.Workspaces.create_workspace(owner.user_id, run_unique("cc"))
      self = %{id: owner.user_id, username: owner.username, kind: :bot}

      guild = MessageCodec.guild(ws, [], [], self, [])
      member = Enum.find(guild["members"], &(&1["user"]["id"] == Integer.to_string(owner.user_id)))

      assert_keys!(member, ["user", "roles", "flags"], "Member.__init__")
      assert is_integer(member["flags"])
      assert is_list(member["roles"])
      # Discord: a member's FIRST role is @everyone — the value the silent
      # `member.roles` permission sums read.
      assert hd(member["roles"]) == guild["id"]
    end

    test "Role.__init__/_update's unguarded set" do
      {:ok, owner} = User.create(run_unique("cc_role"), run_unique("cc_role@example.com"), "password-123")
      {:ok, ws} = Cytale.Workspaces.create_workspace(owner.user_id, run_unique("ccr"))

      guild = MessageCodec.guild(ws)
      [role] = guild["roles"]

      assert_keys!(role, ["id", "name"], "Role.__init__/_update")
      # Discord identifies @everyone by id == guild id.
      assert role["id"] == guild["id"]
    end
  end

  describe "attachment objects (Attachment.__init__)" do
    test "the four ids/urls plus proxy_url" do
      # proxy_url was the #64-class gap found by the same audit: EVERY message
      # carrying a file killed the client, because discord.py indexes it
      # unguarded and we did not send it.
      att = MessageCodec.attachment(%{"id" => "5", "filename" => "a.png", "size" => 12, "url" => "https://x/a.png"})

      assert_keys!(att, ["id", "filename", "size", "url", "proxy_url"], "Attachment.__init__")
      assert is_integer(att["size"])
      assert is_binary(att["url"]) and is_binary(att["proxy_url"])
    end
  end

  describe "message objects (Message.__init__)" do
    test "id/type/content survive the native translation" do
      {:ok, owner} = User.create(run_unique("cc_msg"), run_unique("cc_msg@example.com"), "password-123")

      msg =
        MessageCodec.message_from_native(
          %{
            "id" => "1234",
            "channel_id" => 99,
            "author_id" => owner.user_id,
            "content" => "hello",
            "thread_id" => nil,
            "reply_to_id" => nil,
            "created_at" => "2026-09-10T12:00:00.000Z",
            "edited_at" => nil,
            "attachments" => [],
            "embeds" => []
          },
          "42"
        )

      assert_keys!(msg, ["id", "type", "content"], "Message.__init__")
      assert is_integer(msg["type"])
      assert is_binary(msg["content"])
    end
  end

  # Verified COMPLETE against the same AST audit (listed so a future reader
  # knows these were checked rather than skipped):
  #
  #   * User            BaseUser._update: id, username, discriminator, avatar
  #   * Member          Member.__init__: user, roles, flags
  #   * Role            Role.__init__/_update: id, name
  #   * Message         Message.__init__: id, type, content
  #   * Attachment      Attachment.__init__: id, filename, size, url, proxy_url
  #   * AppInfo         the eight keys /oauth2/applications/@me must carry —
  #                     pinned by application_controller_test.exs (route-level)
  #   * Presence        RawPresenceUpdateEvent: user.id, status, client_status,
  #                     activities — pinned by gateway_wire_contract_test.exs
  #   * READY           parse_ready: user, guilds (+ shard, AutoSharded client)
  #                     — pinned by gateway_wire_contract_test.exs
  #
  # Two audited keys are deliberately NOT emitted, because the objects they
  # belong to are only built from payloads we never send: `MessageInteraction`
  # (id/type/name) is constructed from a MESSAGE's `interaction` field and
  # component type-3 interactions carry no name; `MessageSnapshot` is the
  # forwarded-message shape and Cytale has no forwarding.
end
