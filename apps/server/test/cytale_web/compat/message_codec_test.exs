defmodule CytaleWeb.Compat.MessageCodecTest do
  @moduledoc """
  U6 (bots plan) — the ONE shared compat codec (KTD10): native rows and
  claims → Discord message/user/channel/attachment shapes. Pure-shape pins
  plus the author-resolution layer (bounded point reads, never HTTP).
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.{Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.MessageCodec

  defp run_unique(base) do
    # Collision-proof fixture nonce, unique WITHIN a run (monotonic unique)
    # and ACROSS runs (wall-clock ms — the persistent test keyspace keeps
    # rows from previous runs, so a per-VM counter alone collides).
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp msg(attrs) do
    Map.merge(
      %{
        id: 11,
        channel_id: 2,
        author_id: 1,
        content: "hello",
        thread_id: nil,
        reply_to_id: nil,
        created_at: DateTime.utc_now() |> DateTime.truncate(:millisecond),
        edited_at: nil,
        attachments: []
      },
      Map.new(attrs)
    )
  end

  setup do
    {:ok, owner} = User.create(run_unique("codec_owner"), run_unique("codec_owner@example.com"), "password-123")
    bot_label = run_unique("Codec Bot")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, bot_label)
    {:ok, owner: owner, bot_id: bot.user_id, bot_username: bot.username}
  end

  # ---------------------------------------------------------------------------
  # User objects
  # ---------------------------------------------------------------------------

  describe "user_object/1" do
    test "machine claims → Discord bot user (id decimal string, discriminator \"0\")", %{bot_id: bot_id} do
      assert MessageCodec.user_object(%{
               user_id: bot_id,
               username: "Codec Bot",
               kind: :bot,
               parent_user_id: nil,
               restrictions: nil
             }) == %{
               "id" => Integer.to_string(bot_id),
               "username" => "Codec Bot",
               "discriminator" => "0",
               "global_name" => "Codec Bot",
               "avatar" => nil,
               "bot" => true
             }
    end

    test "human claims → no bot key, discriminator \"0\", global_name set" do
      obj = MessageCodec.user_object(%{user_id: 55, username: "alice", kind: :human})
      assert obj["id"] == "55"
      assert obj["username"] == "alice"
      assert obj["discriminator"] == "0"
      assert obj["global_name"] == "alice"
      assert obj["avatar"] == nil
      refute Map.has_key?(obj, "bot")
    end
  end

  describe "author_object/1" do
    test "machine principal → bot: true, username from the credential's tag", %{
      bot_id: bot_id,
      bot_username: bot_username
    } do
      expected_id = Integer.to_string(bot_id)

      assert %{"bot" => true, "username" => ^bot_username, "id" => ^expected_id} =
               MessageCodec.author_object(bot_id)
    end

    test "human author → username, no bot key", %{owner: owner} do
      obj = MessageCodec.author_object(owner.user_id)
      assert obj["username"] == owner.username
      assert obj["discriminator"] == "0"
      refute Map.has_key?(obj, "bot")
    end

    test "unknown id degrades to a tombstone object, never a crash" do
      assert %{"id" => "99", "discriminator" => "0"} = MessageCodec.author_object(99)
    end
  end

  # ---------------------------------------------------------------------------
  # Message objects
  # ---------------------------------------------------------------------------

  describe "message/2" do
    test "plain message → type 0, Discord field set, no reference keys", %{bot_id: bot_id} do
      out = MessageCodec.message(msg(id: 42, author_id: bot_id))

      assert out["id"] == "42"
      assert out["channel_id"] == "2"
      assert out["author"]["id"] == Integer.to_string(bot_id)
      assert out["author"]["bot"] == true
      assert out["content"] == "hello"
      assert out["timestamp"] =~ ~r/^\d{4}-\d{2}-\d{2}T/
      assert out["edited_timestamp"] == nil
      assert out["tts"] == false
      assert out["mention_everyone"] == false
      assert out["mentions"] == []
      assert out["mention_roles"] == []
      assert out["attachments"] == []
      assert out["embeds"] == []
      assert out["pinned"] == false
      assert out["type"] == 0
      refute Map.has_key?(out, "message_reference")
      refute Map.has_key?(out, "referenced_message")
      refute Map.has_key?(out, "webhook_id")
    end

    test "reply → type 19 + message_reference + depth-1 referenced_message", %{bot_id: bot_id} do
      orig = msg(id: 10, author_id: bot_id, content: "original")
      reply = msg(id: 11, author_id: bot_id, reply_to_id: 10)

      out = MessageCodec.message(reply, orig)

      assert out["type"] == 19
      assert out["message_reference"] == %{"message_id" => "10", "channel_id" => "2"}
      assert out["referenced_message"]["id"] == "10"
      assert out["referenced_message"]["content"] == "original"
      assert out["referenced_message"]["author"]["bot"] == true
      # Depth-1: the snapshot never nests its own referenced_message.
      refute Map.has_key?(out["referenced_message"], "referenced_message")
    end

    test "dangling reply → message_reference present, referenced_message absent", %{bot_id: bot_id} do
      out = MessageCodec.message(msg(reply_to_id: 999, author_id: bot_id), nil)
      assert out["type"] == 19
      assert out["message_reference"]["message_id"] == "999"
      refute Map.has_key?(out, "referenced_message")
    end

    test "webhook author → message carries webhook_id; author still bot-flagged" do
      {:ok, owner2} = User.create(run_unique("wh_owner"), run_unique("wh_owner@example.com"), "password-123")
      # A webhook has NO tag, so the codec serves its LABEL — unique per run.
      label = run_unique("Hooky")
      {:ok, %{user_id: wh_id}} = AgentGrants.mint_all(owner2.user_id, :webhook, label)

      out = MessageCodec.message(msg(author_id: wh_id))
      assert out["webhook_id"] == Integer.to_string(wh_id)
      assert out["author"]["bot"] == true
      assert out["author"]["username"] == label
    end

    test "stored embeds render as the Discord embed array (store-and-forward, unknown keys intact)" do
      embeds = [
        %{
          "title" => "Deploy OK",
          "description" => "prod is green",
          "fields" => [%{"name" => "commit", "value" => "abc123", "inline" => true}]
        },
        # Arbitrary non-core keys ride untouched (KTD11).
        %{"title" => "Custom", "totally_unknown_key" => %{"nested" => [1, 2, %{"deep" => true}]}}
      ]

      out = MessageCodec.message(msg(embeds: embeds))
      assert out["embeds"] == embeds
      # Order preserved.
      assert Enum.map(out["embeds"], & &1["title"]) == ["Deploy OK", "Custom"]
    end

    test "message_from_native OMITS guild_id on DM anchors — null breaks discord.py (2026-09-23)",
         %{bot_id: bot_id} do
      out =
        MessageCodec.message_from_native(
          %{
            "id" => 61,
            "channel_id" => 62,
            "author_id" => bot_id,
            "content" => "dm hello",
            "created_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
            "attachments" => []
          },
          nil
        )

      # Key ABSENT, not null: discord.py's _get_guild_channel does
      # int(data['guild_id']) on key presence and dies on nil, silently
      # dropping every DM MESSAGE_CREATE.
      refute Map.has_key?(out, "guild_id")
      assert out["content"] == "dm hello"
    end

    test "no stored embeds → embeds [] (the codec contract keeps the key)" do
      assert MessageCodec.message(msg([]))["embeds"] == []
      assert MessageCodec.message(msg(embeds: []))["embeds"] == []
    end

    test "stored components render verbatim; absent when the message stored none (components plan U1, R2)" do
      components = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 1, "label" => "Approve", "custom_id" => "approve", "disabled" => true},
            %{"type" => 2, "style" => 5, "label" => "Docs", "url" => "https://docs.example.com/x"}
          ]
        },
        %{
          "type" => 1,
          "components" => [
            %{
              "type" => 3,
              "custom_id" => "model",
              "options" => [%{"label" => "GLM", "value" => "glm"}]
            }
          ]
        }
      ]

      out = MessageCodec.message(msg(components: components))
      assert out["components"] == components

      # The optional-key growth: ABSENT when none (never []).
      refute Map.has_key?(MessageCodec.message(msg([])), "components")
      refute Map.has_key?(MessageCodec.message(msg(components: [])), "components")
    end
  end

  describe "interaction_from_native/1 (type 3 — the component-click wire)" do
    test "workspace click carries the FULL member — roles and flags are unguarded reads in discord.py 2.7" do
      out =
        MessageCodec.interaction_from_native(%{
          "id" => "991",
          "token" => "tok",
          "application_id" => 981,
          "kind" => "component",
          "channel_id" => 971,
          "workspace_id" => "961",
          "user" => %{"id" => 951, "username" => "jordan"},
          "custom_id" => "model_provider_select",
          "component_type" => 3,
          "values" => ["anthropic"],
          "message_id" => 941,
          "message" => nil,
          "app_permissions" => 0
        })

      assert out["type"] == 3
      assert out["data"]["custom_id"] == "model_provider_select"
      assert out["data"]["values"] == ["anthropic"]
      assert out["guild_id"] == "961"

      # The Hermes crash (2026-09-23): discord.py 2.7.1's Member.__init__
      # reads data['roles'] and data['flags'] with NO default, so the thin
      # %{"user" => …} member this branch once shipped KeyErrored inside the
      # interaction constructor and killed the bot's process on every select
      # click. The FULL member/3 shape (roles = the @everyone/guild id,
      # flags 0) is load-bearing — the offline negative control against the
      # pinned library proved the thin shape crashes exactly there.
      assert out["member"]["user"]["id"] == "951"
      assert out["member"]["roles"] == ["961"]
      assert out["member"]["flags"] == 0
      assert out["member"]["deaf"] == false
      assert out["member"]["mute"] == false
    end

    test "chat-input (type 2) carries attachment_size_limit — discord.py bare-reads it" do
      out =
        MessageCodec.interaction_from_native(%{
          "id" => "993",
          "token" => "tok",
          "application_id" => 983,
          "command" => %{"id" => 93, "name" => "ping"},
          "options" => %{},
          "channel_id" => 973,
          "workspace_id" => 963,
          "user" => %{"id" => 953, "username" => "jordan"}
        })

      # discord.py 2.7.1's Interaction constructor sets filesize_limit on
      # EVERY interaction; the type-2 branch once lacked the field and a
      # chat-input invocation crashed the library (discord.py leg, 2026-09-23).
      assert out["attachment_size_limit"] == 26_214_400
      assert out["type"] == 2
    end

    test "DM click keeps the user-only shape (no member, no guild_id)" do
      out =
        MessageCodec.interaction_from_native(%{
          "id" => "992",
          "token" => "tok",
          "application_id" => 982,
          "kind" => "component",
          "channel_id" => 972,
          "workspace_id" => nil,
          "user" => %{"id" => 952, "username" => "jordan"},
          "custom_id" => "go",
          "component_type" => 2,
          "message_id" => 942,
          "message" => nil,
          "app_permissions" => 0
        })

      refute Map.has_key?(out, "member")
      refute Map.has_key?(out, "guild_id")
      assert out["user"]["id"] == "952"
      assert out["authorizing_integration_owners"] == %{"1" => "952"}
    end

    test "a modal submit is Discord's type 5 — the modal custom_id and its text-input rows (#30)" do
      rows = [%{"type" => 1, "components" => [%{"type" => 4, "custom_id" => "subject", "value" => "hi"}]}]

      out =
        MessageCodec.interaction_from_native(%{
          "id" => "994",
          "token" => "tok",
          "application_id" => 984,
          "kind" => "modal_submit",
          "channel_id" => 974,
          "workspace_id" => "964",
          "user" => %{"id" => 954, "username" => "jordan"},
          "custom_id" => "feedback",
          "components" => rows,
          "app_permissions" => 0
        })

      assert out["type"] == 5
      assert out["data"] == %{"custom_id" => "feedback", "components" => rows}
      # The same human-interaction shape as a click (the #73 member lesson).
      assert out["member"]["roles"] == ["964"]
      assert out["entitlements"] == []
      # A submit that did not come from a message carries none.
      refute Map.has_key?(out, "message")
    end
  end

  # ---------------------------------------------------------------------------
  # Attachments / channels
  # ---------------------------------------------------------------------------

  describe "attachments/1" do
    test "native descriptor (stringified) → Discord shape with integer size" do
      assert [
               %{
                 "id" => id,
                 "filename" => "a.png",
                 "content_type" => "image/png",
                 "size" => 123,
                 "url" => "/api/v1/attachments/abc"
               }
             ] =
               MessageCodec.attachments([
                 %{
                   "filename" => "a.png",
                   "content_type" => "image/png",
                   "size" => "123",
                   "url" => "/api/v1/attachments/abc"
                 }
               ])

      assert is_binary(id)
    end

    test "nil/non-list → []" do
      assert MessageCodec.attachments(nil) == []
      assert MessageCodec.attachments(:junk) == []
    end
  end

  describe "channel/1" do
    test "text channel → type 0, guild_id = workspace id string" do
      assert MessageCodec.channel(%{
               channel_id: 7,
               workspace_id: 9,
               name: "general",
               type: 0,
               position: 3,
               last_message_id: nil
             }) ==
               %{
                 "id" => "7",
                 "guild_id" => "9",
                 "name" => "general",
                 "type" => 0,
                 "topic" => nil,
                 "parent_id" => nil,
                 "position" => 3,
                 "last_message_id" => nil
               }

      assert MessageCodec.channel(%{channel_id: 7, workspace_id: 9, name: "c", type: 0, last_message_id: 55})[
               "last_message_id"
             ] == "55"
    end

    # #64 item 1: `position` is REQUIRED by the client parsers
    # (`TextChannel._update` / `CategoryChannel._update` index it unguarded),
    # so it must be an int on EVERY channel object — categories included —
    # and a row without one still renders a usable object rather than a null.
    test "every channel object carries an integer position" do
      for type <- [0, 1] do
        ch =
          MessageCodec.channel(%{
            channel_id: 7,
            workspace_id: 9,
            name: "x",
            type: type,
            position: 12,
            last_message_id: nil
          })

        assert is_integer(ch["position"]) and ch["position"] == 12
      end

      # A missing/nil position degrades to 0, never nil.
      base = %{channel_id: 7, workspace_id: 9, name: "x", type: 0, last_message_id: nil}

      assert MessageCodec.channel(base)["position"] == 0
      assert MessageCodec.channel(Map.put(base, :position, nil))["position"] == 0
    end

    test "native category (1) maps to Discord GUILD_CATEGORY (4)" do
      assert MessageCodec.channel(%{channel_id: 7, workspace_id: 9, name: "cat", type: 1, last_message_id: nil})["type"] ==
               4
    end

    # DM channels are a different object in Discord (DMChannel reads only
    # `id`), and Discord sends no `position`/`guild_id` for them — so the
    # guild-shaped keys must NOT leak into this shape.
    test "DM channels keep the DM shape (no position, no guild_id)" do
      dm = MessageCodec.channel(%{channel_id: 5, type: :dm, user_ids: [11], last_message_id: nil}, 11)

      assert dm["type"] == 1
      refute Map.has_key?(dm, "position")
      refute Map.has_key?(dm, "guild_id")
    end
  end

  # ---------------------------------------------------------------------------
  # U7: guild objects + gateway dispatch payload translation
  # ---------------------------------------------------------------------------

  describe "guild/2 + guild_stub/1 (U7 GUILD_CREATE)" do
    test "workspace + channels → Discord guild object" do
      ws = %{workspace_id: 42, name: "Engineering", owner_id: 7}

      channels = [
        %{channel_id: 100, workspace_id: 42, name: "general", type: 0, position: 0, last_message_id: nil}
      ]

      assert MessageCodec.guild(ws, channels) == %{
               "id" => "42",
               "name" => "Engineering",
               "owner_id" => "7",
               "unavailable" => false,
               "channels" => [
                 %{
                   "id" => "100",
                   "guild_id" => "42",
                   "name" => "general",
                   "type" => 0,
                   "topic" => nil,
                   "parent_id" => nil,
                   "position" => 0,
                   "last_message_id" => nil
                 }
               ],
               "threads" => [],
               "members" => [],
               "roles" => [%{"id" => "42", "name" => "@everyone"}],
               "presences" => [],
               "member_count" => 0,
               "large" => false,
               "voice_states" => [],
               "emojis" => [],
               "stickers" => [],
               "features" => []
             }
    end

    test "guild object carries the array fields third-party libraries iterate unconditionally" do
      ws = %{workspace_id: 42, name: "Engineering", owner_id: 7}
      guild = MessageCodec.guild(ws)

      for field <- ["members", "roles", "presences", "voice_states", "emojis", "stickers", "features", "threads"] do
        assert is_list(guild[field]), "GUILD_CREATE.#{field} must be a list — real client libraries iterate it"
      end
    end

    # #63: the three client-document-locked invariants. A schema-valid
    # GUILD_CREATE with empty `members`/`roles` left a conformant client in a
    # state its own docs call impossible: `guild.me` (an unguarded
    # `get_member(self_id)`), `guild.default_role` (unguarded `get_role(id)`)
    # and `guild.member_count` all None — the first two raising AttributeError
    # inside any standard permission check.
    test "the connecting principal is its own member, with @everyone first" do
      ws = %{workspace_id: 42, name: "Engineering", owner_id: 7}
      self = %{id: "777", username: "cytalebot", kind: :bot}

      guild = MessageCodec.guild(ws, [], [], self)

      member = Enum.find(guild["members"], &(&1["user"]["id"] == "777"))
      assert member, "the connecting principal must be in members (guild.me resolves through it)"
      assert member["user"]["username"] == "cytalebot"
      assert member["user"]["bot"] == true
      # Discord: a member's FIRST role is always the @everyone role, whose id
      # IS the guild id — the value `default_role` resolves through.
      assert member["roles"] == [guild["id"]]
      assert member["flags"] == 0

      assert [role] = guild["roles"]
      assert role == %{"id" => guild["id"], "name" => "@everyone"}
    end

    # The SPIRIT of the roster (the #63 review's minimum was the floor):
    # GUILD_CREATE is Discord's roster bootstrap, so `members` carries the
    # workspace's REAL members — not one entry and not an empty array. The
    # read is bounded (@roster_cap) and `large` marks the cap.
    test "members carries the real roster, with usernames resolved" do
      {:ok, owner} = User.create(run_unique("roster_owner"), run_unique("roster_owner@example.com"), "password-123")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("roster"))
      {:ok, mate} = User.create(run_unique("roster_mate"), run_unique("roster_mate@example.com"), "password-123")
      :ok = Workspaces.add_member(ws.workspace_id, mate.user_id, mate.user_id, [])

      guild = MessageCodec.guild(ws)
      ids = Enum.map(guild["members"], & &1["user"]["id"])

      assert Integer.to_string(owner.user_id) in ids
      assert Integer.to_string(mate.user_id) in ids
      assert length(guild["members"]) == 2

      # Names are resolved (the client renders them), and every member carries
      # the fields discord.py's Member.__init__ indexes unguarded.
      for member <- guild["members"] do
        assert is_binary(member["user"]["username"])
        assert member["roles"] == [guild["id"]]
        assert member["flags"] == 0
      end

      assert guild["member_count"] == 2
    end

    # The connecting principal must survive a capped roster: discord.py
    # resolves `guild.me` through an UNGUARDED lookup, so if a cap truncated
    # the bot's own row the client would raise rather than see a big guild.
    test "an identity outside the roster is appended, never dropped by the cap" do
      ws = %{workspace_id: 42, name: "Engineering", owner_id: 7}
      self = %{id: "999", username: "not-a-roster-row", kind: :agent}

      guild = MessageCodec.guild(ws, [], [], self)

      assert Enum.any?(guild["members"], &(&1["user"]["id"] == "999"))
      # ...and it is not double-counted when it IS a roster row (the DB-backed
      # case above covers that; here the roster is empty, so 1 + 0).
      assert guild["member_count"] == 0
    end

    test "member_count is an integer for a workspace with members" do
      {:ok, owner} = User.create(run_unique("counted_owner"), run_unique("counted_owner@example.com"), "password-123")
      {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("counted"))
      {:ok, member} = User.create(run_unique("counted_member"), run_unique("counted@example.com"), "password-123")
      :ok = Workspaces.add_member(ws.workspace_id, member.user_id, member.user_id, [])

      guild = MessageCodec.guild(ws)

      # owner + member.
      assert guild["member_count"] == 2
      assert guild["large"] == false
    end

    test "guild_stub → unavailable stub" do
      assert MessageCodec.guild_stub(42) == %{"id" => "42", "unavailable" => true}
      assert MessageCodec.guild_stub(%{workspace_id: 42}) == %{"id" => "42", "unavailable" => true}
    end
  end

  describe "message_from_native/2 (U7 MESSAGE_CREATE translation)" do
    test "native message_json payload → Discord message object with guild_id", %{owner: owner} do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      native = %{
        "id" => "1234",
        "channel_id" => 99,
        "author_id" => owner.user_id,
        "content" => "wire hello",
        "thread_id" => nil,
        "reply_to_id" => nil,
        "referenced" => nil,
        "created_at" => DateTime.to_iso8601(now),
        "edited_at" => nil,
        "attachments" => []
      }

      d = MessageCodec.message_from_native(native, "42")

      assert d["id"] == "1234"
      assert d["channel_id"] == "99"
      assert d["guild_id"] == "42"
      assert d["content"] == "wire hello"
      assert d["author"]["id"] == Integer.to_string(owner.user_id)
      assert d["author"]["bot"] == nil
      assert d["mentions"] == []
      assert d["embeds"] == []
      assert d["type"] == 0
      assert d["timestamp"] == DateTime.to_iso8601(now)
    end

    # #66: a mention is a TOKEN plus an ARRAY. Cytale stores the same token
    # Discord uses (`<@id>` — the composer's reply-ping path writes it, the
    # shared markdown parser reads it), but the compat projection sent
    # `mentions: []`, so `client.user in message.mentions` was False for a real
    # tag and every `require_mention` bot concluded it was not addressed.
    test "a mention token projects into Discord's mentions array", %{owner: owner} do
      {:ok, mentioned} =
        User.create(run_unique("mentioned"), run_unique("mentioned@example.com"), "password-123")

      native =
        native_message(owner.user_id, "hey <@#{mentioned.user_id}> take a look", "1")

      d = MessageCodec.message_from_native(native, "42")

      # The token stays in content (Discord's wire form — clients render it).
      assert d["content"] == "hey <@#{mentioned.user_id}> take a look"
      assert [user] = d["mentions"]
      assert user["id"] == Integer.to_string(mentioned.user_id)
      assert user["username"] == mentioned.username

      # The full user object, since discord.py's User._update indexes `avatar`
      # unguarded — the same class of requirement as the #64 field gaps.
      for key <- ["id", "username", "discriminator", "avatar"] do
        assert Map.has_key?(user, key), "mention object is missing #{key}"
      end
    end

    test "the nick form, duplicates and unknown ids all behave", %{owner: owner} do
      {:ok, mentioned} = User.create(run_unique("nickform"), run_unique("nickform@example.com"), "password-123")
      id = mentioned.user_id

      # `<@!id>` is Discord's nickname-form token and its regexes accept it;
      # a repeated mention yields ONE entry; an id with no row degrades to the
      # tombstone author rather than crashing the dispatch.
      d =
        MessageCodec.message_from_native(
          native_message(owner.user_id, "<@!#{id}> and <@#{id}> again, plus <@999999999999>", "2"),
          "42"
        )

      ids = Enum.map(d["mentions"], & &1["id"])
      assert ids == [Integer.to_string(id), "999999999999"]
      assert Enum.uniq(ids) == ids
    end

    test "plain text that looks like a tag is NOT a mention (#66's boundary)", %{owner: owner} do
      # The ticket's live example: a human typed `@mia` and no id was ever
      # recorded, so there is nothing to project. The fix must not invent a
      # mention by matching names — that is what the reporter's table rules out
      # (a name match fires on `@miaine`, on emails, and on prose).
      d = MessageCodec.message_from_native(native_message(owner.user_id, "@mia Are you here?", "3"), "42")

      assert d["mentions"] == []
      assert d["content"] == "@mia Are you here?"
      assert d["mention_everyone"] == false
    end

    test "a malformed/oversized token never reaches a query", %{owner: owner} do
      # 20 digits exceeds int64 — it must be ignored, not passed to Scylla.
      d = MessageCodec.message_from_native(native_message(owner.user_id, "<@99999999999999999999> hi", "4"), "42")

      assert d["mentions"] == []
    end

    test "native payload carrying components → the Discord object carries them; absent when none (R2)",
         %{owner: owner} do
      now = DateTime.utc_now() |> DateTime.truncate(:millisecond)

      components = [
        %{
          "type" => 1,
          "components" => [%{"type" => 2, "style" => 1, "label" => "Approve", "custom_id" => "approve"}]
        }
      ]

      base = %{
        "id" => "1237",
        "channel_id" => 99,
        "author_id" => owner.user_id,
        "content" => "card",
        "thread_id" => nil,
        "reply_to_id" => nil,
        "referenced" => nil,
        "created_at" => DateTime.to_iso8601(now),
        "edited_at" => nil,
        "attachments" => []
      }

      assert MessageCodec.message_from_native(Map.put(base, "components", components), "42")["components"] ==
               components

      refute Map.has_key?(MessageCodec.message_from_native(base, "42"), "components")
    end

    test "native reply payload → type 19 + message_reference + depth-1 referenced_message",
         %{owner: owner, bot_id: bot_id} do
      {:ok, orig} =
        Cytale.Messages.create_message(%{channel_id: 77, author_id: owner.user_id, content: "the original"})

      native = %{
        "id" => "1235",
        "channel_id" => 77,
        "author_id" => bot_id,
        "content" => "the reply",
        "thread_id" => nil,
        "reply_to_id" => Integer.to_string(orig.id),
        "referenced" => %{},
        "created_at" => DateTime.to_iso8601(DateTime.utc_now()),
        "edited_at" => nil,
        "attachments" => []
      }

      d = MessageCodec.message_from_native(native, "42")

      assert d["type"] == 19
      assert d["message_reference"]["message_id"] == Integer.to_string(orig.id)
      assert d["referenced_message"]["content"] == "the original"
      assert d["referenced_message"]["referenced_message"] == nil
      assert d["author"]["bot"] == true
    end

    # PERF-2 (B3b): the caller's pre-resolved author map rides into the
    # codec — a hit is served WITHOUT any Principals/Users read, and the
    # output is otherwise byte-identical to the fallback path.
    test "a pre-resolved author cache hit skips the resolution read entirely", %{owner: owner} do
      native = %{
        "id" => "1236",
        "channel_id" => 99,
        "author_id" => owner.user_id,
        "content" => "cached author",
        "thread_id" => nil,
        "reply_to_id" => nil,
        "referenced" => nil,
        "created_at" => DateTime.to_iso8601(DateTime.utc_now() |> DateTime.truncate(:millisecond)),
        "edited_at" => nil,
        "attachments" => []
      }

      # An author id with NO row anywhere: the fallback would render the
      # tombstone; the pre-resolved entry wins — proof the read never ran.
      ghost_id = Cytale.Snowflake.next()
      native = %{native | "author_id" => ghost_id}

      cached = {%{"id" => Integer.to_string(ghost_id), "username" => "Ghost", "bot" => true}, :bot}

      d = MessageCodec.message_from_native(native, "42", %{ghost_id => cached})
      assert d["author"] == elem(cached, 0)

      # Without the cache the same id degrades to the tombstone (the
      # fallback contract, unchanged).
      d2 = MessageCodec.message_from_native(native, "42")
      assert d2["author"]["username"] == "deleted-user"

      # Referenced-message authors ride the same cache (a self-reply hit).
      {:ok, orig} =
        Cytale.Messages.create_message(%{channel_id: 99, author_id: ghost_id, content: "ghost original"})

      reply = %{native | "reply_to_id" => Integer.to_string(orig.id)}
      d3 = MessageCodec.message_from_native(reply, "42", %{ghost_id => cached})
      assert d3["referenced_message"]["author"]["username"] == "Ghost"
    end
  end

  describe "typing_from_native/2 (U7 TYPING_START translation)" do
    # A13: Discord's TYPING_START timestamp is Unix epoch SECONDS (discord.js
    # multiplies by 1000); the native event carries milliseconds — the codec
    # converts. Realistic epoch-ms fixture → its seconds value.
    @typing_ms 1_792_022_400_000

    test "string-keyed REST shape and atom-keyed socket shape both translate, ms → seconds" do
      assert MessageCodec.typing_from_native(
               %{"channel_id" => "99", "user_id" => "7", "timestamp" => @typing_ms},
               "42"
             ) == %{"channel_id" => "99", "guild_id" => "42", "user_id" => "7", "timestamp" => 1_792_022_400}

      assert MessageCodec.typing_from_native(
               %{channel_id: "99", thread_id: nil, user_id: "7", timestamp: @typing_ms},
               "42"
             )["timestamp"] == 1_792_022_400
    end

    test "a degenerate non-integer timestamp passes through untouched (never crashes)" do
      assert MessageCodec.typing_from_native(
               %{"channel_id" => "99", "user_id" => "7", "timestamp" => nil},
               "42"
             )["timestamp"] == nil
    end
  end

  # The native `message_json` projection the gateway/REST seams publish, with
  # content varied per test (#66).
  defp native_message(author_id, content, id) do
    %{
      "id" => id,
      "channel_id" => 99,
      "author_id" => author_id,
      "content" => content,
      "thread_id" => nil,
      "reply_to_id" => nil,
      "referenced" => nil,
      "created_at" => DateTime.to_iso8601(DateTime.utc_now() |> DateTime.truncate(:millisecond)),
      "edited_at" => nil,
      "attachments" => []
    }
  end
end
