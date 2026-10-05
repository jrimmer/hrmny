defmodule CytaleWeb.ThreadCardsTest do
  @moduledoc """
  Bot interactive cards in THREADS — parity with channels.

  A bot's card (content + embeds + action rows) posted to a thread id used to
  be refused `400 50035` ("Thread replies do not accept embeds on this
  server"), so every interactive prompt inside a thread degraded to text. The
  pins below hold the thread surface to the channel's, layer by layer:

    * the compat write path stores embeds/components (same caps, embed-only
      allowed) and the 201 matches the live dispatch;
    * the native wire (`ThreadMessageCreate` + the dual emission's
      `MessageCreate` leg) and every read carry them, and the compat
      translation renders them on the thread id;
    * a click on a thread card mints an interaction that names the thread
      (Discord: threads are channels, so `channel_id` IS the thread), and
      every answer — type 4, followups, a deferred reply — lands IN the
      thread, while type-7 / `@original` edits flip the card in place;
    * permissions are unchanged: a principal that cannot see the parent
      channel sees nothing.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Interactions
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Threads.{Member, Thread}
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.{GatewayDialect, MessageCodec}

  @endpoint CytaleWeb.Endpoint

  # GUILD_MESSAGES — the intent the thread's MESSAGE_CREATE rides.
  @guild_messages Bitwise.bsl(1, 9)

  # Publish recorder: every dispatch the seam sees lands in the test mailbox.
  defmodule RecordingPublish do
    @behaviour Cytale.Publish

    @impl true
    def publish_user_update(_user_id, _event), do: :ok

    @impl true
    def publish(channel_id, event) do
      case :persistent_term.get({__MODULE__, :listener}, nil) do
        nil -> :ok
        pid -> send(pid, {:published, channel_id, event})
      end

      :ok
    end
  end

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp json_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp bot_conn(token), do: json_conn() |> put_req_header("authorization", "Bot " <> token)

  defp user_conn(user),
    do:
      json_conn()
      |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

  setup do
    :persistent_term.put({RecordingPublish, :listener}, self())
    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, RecordingPublish)

    on_exit(fn ->
      :persistent_term.erase({RecordingPublish, :listener})

      case old_publish do
        nil -> Application.delete_env(:cytale, Cytale.Publish)
        v -> Application.put_env(:cytale, Cytale.Publish, v)
      end
    end)

    {:ok, owner} = User.create(run_unique("tc_owner"), run_unique("tc_owner@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("tc_member"), run_unique("tc_member@example.com"), "password-123")
    {:ok, outsider} = User.create(run_unique("tc_out"), run_unique("tc_out@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("tc-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, secret} = Workspaces.create_channel(ws.workspace_id, "secret")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Hermes"))

    {:ok, root} =
      Messages.create_message(%{channel_id: general.channel_id, author_id: owner.user_id, content: "deploy talk"})

    {:ok, thread} = Thread.create(general.channel_id, root.id, "deploy", owner.user_id)
    drain()

    {:ok,
     owner: owner,
     member: member,
     outsider: outsider,
     ws: ws,
     general: general,
     secret: secret,
     bot: bot,
     thread: thread,
     tid: Integer.to_string(thread.thread_id)}
  end

  # -- helpers -------------------------------------------------------------------

  defp drain(acc \\ []) do
    receive do
      {:published, channel_id, event} -> drain([{channel_id, event} | acc])
    after
      50 -> Enum.reverse(acc)
    end
  end

  defp published(events, name), do: for({_ch, {^name, payload}} <- events, do: payload)

  @embed %{"title" => "Approve deploy?", "description" => "prod · web · 3 commits", "color" => 5_793_266}

  defp approve_row(ids \\ ["approve", "deny"]) do
    %{
      "type" => 1,
      "components" => Enum.map(ids, &%{"type" => 2, "style" => 1, "label" => String.capitalize(&1), "custom_id" => &1})
    }
  end

  defp resolved_row do
    %{
      "type" => 1,
      "components" => [
        %{"type" => 2, "style" => 2, "label" => "Approved", "custom_id" => "approve", "disabled" => true}
      ]
    }
  end

  # Hermes' card, POSTed to the THREAD id exactly as discord.py sends it.
  defp post_card!(token, tid, body \\ %{}) do
    conn =
      post(
        bot_conn(token),
        "/api/v10/channels/#{tid}/messages",
        Map.merge(%{"content" => "Run the deploy?", "embeds" => [@embed], "components" => [approve_row()]}, body)
      )

    assert conn.status == 201, conn.resp_body
    Jason.decode!(conn.resp_body)
  end

  defp human_claims(user), do: %{user_id: user.user_id, username: user.username, verified: true, kind: :human}

  defp click!(user, card, custom_id) do
    {:ok, minted} =
      Interactions.invoke_component(
        human_claims(user),
        card.channel_id,
        card.id,
        custom_id,
        2
      )

    minted
  end

  defp stored_card(general, card_json), do: Messages.get_message(general.channel_id, String.to_integer(card_json["id"]))

  defp cb_path(minted), do: "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback"
  defp fu_path(minted), do: "/api/v10/webhooks/#{minted.payload["application_id"]}/#{minted.token}"

  defp bot_identity(bot, owner),
    do: %{id: Integer.to_string(bot.user_id), username: bot.username, kind: :bot, parent_id: owner.user_id}

  # ---------------------------------------------------------------------------
  # Server write path + read/echo
  # ---------------------------------------------------------------------------

  describe "compat POST to a thread id: the channel's card surface" do
    test "content + embed + buttons → 201 with both, stored, and every read agrees", %{
      bot: bot,
      member: member,
      tid: tid,
      thread: thread,
      general: general,
      ws: ws
    } do
      body = post_card!(bot.token, tid)

      assert body["channel_id"] == tid
      assert body["guild_id"] == Integer.to_string(ws.workspace_id)
      assert body["content"] == "Run the deploy?"
      assert body["embeds"] == [@embed]
      assert body["components"] == [approve_row()]

      # Stored on the reply row (the embed/component side tables are keyed by
      # message id — a thread reply is the same row as a channel message).
      stored = stored_card(general, body)
      assert stored.thread_id == thread.thread_id
      assert stored.embeds == [@embed]
      assert stored.components == [approve_row()]

      # Compat history on the thread id.
      history = get(bot_conn(bot.token), "/api/v10/channels/#{tid}/messages")
      assert [%{"embeds" => [@embed], "components" => [row], "channel_id" => ^tid}] = Jason.decode!(history.resp_body)
      assert row == approve_row()

      # The native thread page (the web panel's reload path).
      native = get(user_conn(member), "/api/v1/threads/#{tid}/messages")
      assert native.status == 200
      assert [%{"embeds" => [@embed], "components" => [^row]}] = Jason.decode!(native.resp_body)["messages"]

      # The channel timeline still never shows a thread reply.
      channel_page = get(bot_conn(bot.token), "/api/v10/channels/#{general.channel_id}/messages")
      refute Enum.any?(Jason.decode!(channel_page.resp_body), &(&1["id"] == body["id"]))
    end

    test "the ThreadMessageCreate dispatch (and the dual MessageCreate leg) carry the card; " <>
           "the compat translation of the dispatch IS the 201",
         %{
           bot: bot,
           tid: tid,
           ws: ws
         } do
      body = post_card!(bot.token, tid)
      events = drain()

      assert [thread_wire] = published(events, "ThreadMessageCreate")
      assert [channel_leg] = published(events, "MessageCreate")

      for wire <- [thread_wire, channel_leg] do
        assert wire["thread_id"] == tid
        assert wire["embeds"] == [@embed]
        assert wire["components"] == [approve_row()]
      end

      translated = MessageCodec.thread_message_from_native(thread_wire, Integer.to_string(ws.workspace_id))
      assert translated == body
      assert translated["channel_id"] == tid
    end

    test "embed-only (no content) is accepted, as in a channel; persists \"\"", %{bot: bot, tid: tid, general: general} do
      conn =
        post(bot_conn(bot.token), "/api/v10/channels/#{tid}/messages", %{
          "embeds" => [%{"title" => "Clarify: which environment?"}],
          "components" => [approve_row(["staging", "prod"])]
        })

      assert conn.status == 201
      body = Jason.decode!(conn.resp_body)
      assert body["content"] == ""
      assert [%{"title" => "Clarify: which environment?"}] = body["embeds"]
      assert stored_card(general, body).content == ""
    end

    test "thread replies with components alone ride the channel's content rule (no silent card)", %{
      bot: bot,
      tid: tid,
      general: general
    } do
      # The channel answer for the same body is the thread's answer.
      for id <- [Integer.to_string(general.channel_id), tid] do
        conn = post(bot_conn(bot.token), "/api/v10/channels/#{id}/messages", %{"components" => [approve_row()]})
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body) == %{"code" => 50_035, "message" => "Invalid Form Body"}
      end
    end

    test "the channel's caps hold on a thread: 11 embeds, a 9 KB embed, 6 rows, malformed rows → 400 50035; nothing stored",
         %{bot: bot, tid: tid, thread: thread} do
      bodies = [
        %{"content" => "x", "embeds" => Enum.map(1..11, &%{"title" => "e#{&1}"})},
        %{"content" => "x", "embeds" => [%{"description" => String.duplicate("x", 9_000)}]},
        %{"content" => "x", "embeds" => "nope"},
        %{"content" => "x", "components" => Enum.map(1..6, &approve_row(["b#{&1}"]))},
        %{"content" => "x", "components" => [%{"type" => 1}]},
        %{
          "content" => "x",
          "components" => [%{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "label" => "no id"}]}]
        }
      ]

      for body <- bodies do
        conn = post(bot_conn(bot.token), "/api/v10/channels/#{tid}/messages", body)
        assert conn.status == 400, inspect(body)
        assert Jason.decode!(conn.resp_body)["code"] == 50_035
      end

      assert Messages.thread_history(thread.thread_id) == []
      assert drain() == []
    end

    test "PATCH on a thread card edits content and keeps the card (content-only, as in a channel)", %{
      bot: bot,
      tid: tid,
      general: general
    } do
      body = post_card!(bot.token, tid)
      drain()

      edited =
        patch(bot_conn(bot.token), "/api/v10/channels/#{tid}/messages/#{body["id"]}", %{"content" => "Run it now?"})

      assert edited.status == 200
      edited_body = Jason.decode!(edited.resp_body)
      assert edited_body["channel_id"] == tid
      assert edited_body["content"] == "Run it now?"
      assert edited_body["embeds"] == [@embed]
      assert edited_body["components"] == [approve_row()]

      assert [update] = published(drain(), "MessageUpdate")
      assert update["thread_id"] == tid
      assert update["components"] == [approve_row()]
      assert stored_card(general, body).content == "Run it now?"
    end
  end

  # ---------------------------------------------------------------------------
  # Permissions unchanged
  # ---------------------------------------------------------------------------

  describe "permissions: a principal that cannot see the parent sees nothing" do
    test "an agent restricted away from the parent: POST, GET and the live dispatch all miss", %{
      owner: owner,
      bot: bot,
      tid: tid,
      secret: secret,
      ws: ws
    } do
      body = post_card!(bot.token, tid)
      events = drain()
      [thread_wire] = published(events, "ThreadMessageCreate")

      {:ok, ro} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Elsewhere"), %{
          "actions" => ["read", "post"],
          "channels" => [Integer.to_string(secret.channel_id)]
        })

      denied_post =
        post(bot_conn(ro.token), "/api/v10/channels/#{tid}/messages", %{"content" => "x", "embeds" => [@embed]})

      assert denied_post.status == 404
      assert Jason.decode!(denied_post.resp_body)["code"] == 10_003

      denied_get = get(bot_conn(ro.token), "/api/v10/channels/#{tid}/messages")
      assert denied_get.status == 404
      assert Jason.decode!(denied_get.resp_body)["code"] == 10_003

      identity = %{id: Integer.to_string(ro.user_id), username: ro.username, kind: :agent, parent_id: owner.user_id}

      assert {_visible, _cache, :drop} =
               GatewayDialect.filter_dispatch(@guild_messages, nil, %{}, identity, "ThreadMessageCreate", thread_wire)

      # The unrestricted bot DOES receive it — MESSAGE_CREATE on the thread
      # id, card intact, identical to the REST 201.
      assert {_visible, _cache, {"MESSAGE_CREATE", translated}} =
               GatewayDialect.filter_dispatch(
                 @guild_messages,
                 nil,
                 %{},
                 bot_identity(bot, owner),
                 "ThreadMessageCreate",
                 thread_wire
               )

      assert translated["channel_id"] == tid
      assert translated["guild_id"] == Integer.to_string(ws.workspace_id)
      assert translated["embeds"] == [@embed]
      assert translated["components"] == [approve_row()]
      assert translated == body
    end

    test "a non-member human: no native delivery, no thread read, no click", %{
      outsider: outsider,
      bot: bot,
      tid: tid,
      general: general
    } do
      body = post_card!(bot.token, tid)
      [thread_wire] = published(drain(), "ThreadMessageCreate")

      identity = %{id: Integer.to_string(outsider.user_id), username: outsider.username}
      assert {_visible, false} = GatewayDialect.visible_dispatch?(nil, identity, "ThreadMessageCreate", thread_wire)

      assert get(user_conn(outsider), "/api/v1/threads/#{tid}/messages").status == 404

      click =
        post(user_conn(outsider), "/api/v1/interactions", %{
          "channel_id" => Integer.to_string(general.channel_id),
          "message_id" => body["id"],
          "custom_id" => "approve",
          "component_type" => 2
        })

      assert click.status in [403, 404]
      assert published(drain(), "InteractionCreate") == []
    end
  end

  # ---------------------------------------------------------------------------
  # Interactions on a thread card
  # ---------------------------------------------------------------------------

  describe "a click on a thread card" do
    setup %{bot: bot, tid: tid, general: general} do
      body = post_card!(bot.token, tid)
      drain()
      {:ok, card: stored_card(general, body), card_json: body}
    end

    test "the web click ingress (parent channel + message) mints an interaction naming the thread; " <>
           "the compat INTERACTION_CREATE carries the thread as channel_id and d.message",
         %{
           member: member,
           bot: bot,
           card: card,
           tid: tid,
           general: general,
           ws: ws
         } do
      bot_key = Integer.to_string(bot.user_id)
      :ok = Cytale.Gateway.PushRegistry.subscribe(Cytale.Gateway.PushRegistry.user_key(bot_key), bot_key)

      conn =
        post(user_conn(member), "/api/v1/interactions", %{
          "channel_id" => Integer.to_string(general.channel_id),
          "message_id" => Integer.to_string(card.id),
          "custom_id" => "approve",
          "component_type" => 2
        })

      assert conn.status == 202
      assert_receive {:cytale_gateway_push, _, {"InteractionCreate", native}, _}, 2_000

      # Native: the parent stays the anchor, the thread rides beside it.
      assert native["kind"] == "component"
      assert native["channel_id"] == Integer.to_string(general.channel_id)
      assert native["thread_id"] == tid
      assert native["message_id"] == Integer.to_string(card.id)

      # Compat (Discord): threads are channels — channel_id IS the thread,
      # the id Hermes posted the card to; d.message sits on the thread too.
      compat = MessageCodec.interaction_from_native(native)
      assert compat["type"] == 3
      assert compat["channel_id"] == tid
      assert compat["guild_id"] == Integer.to_string(ws.workspace_id)
      assert compat["data"] == %{"custom_id" => "approve", "component_type" => 2}
      assert compat["message"]["id"] == Integer.to_string(card.id)
      assert compat["message"]["channel_id"] == tid
      assert compat["message"]["embeds"] == [@embed]
      assert compat["message"]["components"] == [approve_row()]
    end

    test "type 7 flips the card in place: stored, MessageUpdate carries thread_id + an explicit card, " <>
           "compat MESSAGE_UPDATE lands on the thread",
         %{
           member: member,
           owner: owner,
           bot: bot,
           card: card,
           tid: tid,
           general: general
         } do
      minted = click!(member, card, "approve")
      approved = %{"title" => "Approved by #{member.username}"}

      conn =
        post(json_conn(), cb_path(minted), %{
          "type" => 7,
          "data" => %{"components" => [resolved_row()], "embeds" => [approved]}
        })

      assert conn.status == 200

      updated = Messages.get_message(general.channel_id, card.id)
      assert updated.thread_id == card.thread_id
      assert updated.content == "Run the deploy?"
      assert updated.components == [resolved_row()]
      assert updated.embeds == [approved]
      assert updated.edited_at != nil

      assert [update] = published(drain(), "MessageUpdate")
      assert update["thread_id"] == tid
      assert update["components"] == [resolved_row()]
      assert update["embeds"] == [approved]

      assert {_visible, _cache, {"MESSAGE_UPDATE", translated}} =
               GatewayDialect.filter_dispatch(
                 @guild_messages,
                 nil,
                 %{},
                 bot_identity(bot, owner),
                 "MessageUpdate",
                 update
               )

      assert translated["channel_id"] == tid
      assert translated["embeds"] == [approved]
      assert translated["components"] == [resolved_row()]
    end

    test "type 7 clearing the buttons (components: []) reaches live viewers as an explicit []", %{
      member: member,
      card: card,
      general: general
    } do
      minted = click!(member, card, "deny")

      conn = post(json_conn(), cb_path(minted), %{"type" => 7, "data" => %{"content" => "Denied.", "components" => []}})
      assert conn.status == 200

      assert Messages.get_message(general.channel_id, card.id).components == []
      assert [update] = published(drain(), "MessageUpdate")
      assert update["components"] == []
      # Embeds untouched by this flip, and still explicit.
      assert update["embeds"] == [@embed]
    end

    test "type 4 answers IN the thread: dual emission, thread history, counter, bot follows", %{
      member: member,
      bot: bot,
      card: card,
      tid: tid,
      thread: thread,
      general: general
    } do
      before = Thread.get(thread.thread_id).message_count
      minted = click!(member, card, "approve")

      conn =
        post(json_conn(), cb_path(minted), %{
          "type" => 4,
          "data" => %{"content" => "Deploying…", "components" => [approve_row(["cancel"])]}
        })

      assert conn.status == 200
      reply_id = Jason.decode!(conn.resp_body)["interaction"]["response_message_id"]

      reply = Messages.get_message(general.channel_id, String.to_integer(reply_id))
      assert reply.thread_id == thread.thread_id
      assert reply.author_id == bot.user_id
      assert reply.components == [approve_row(["cancel"])]

      events = drain()
      assert [%{"id" => ^reply_id, "thread_id" => ^tid} = wire] = published(events, "ThreadMessageCreate")
      assert wire["components"] == [approve_row(["cancel"])]
      assert [%{"id" => ^reply_id}] = published(events, "MessageCreate")

      assert Enum.any?(Messages.thread_history(thread.thread_id), &(&1.id == reply.id))
      refute Enum.any?(Messages.history(general.channel_id), &(&1.id == reply.id))
      assert Thread.get(thread.thread_id).message_count == before + 1
      assert %{} = Member.get(thread.thread_id, bot.user_id)
    end

    test "a follow-up lands in the thread and answers on the thread id", %{
      member: member,
      card: card,
      tid: tid,
      thread: thread
    } do
      minted = click!(member, card, "approve")

      # Deferred update first (discord.py `defer()`), then a follow-up.
      assert post(json_conn(), cb_path(minted), %{"type" => 6}).status == 200

      conn = post(json_conn(), fu_path(minted), %{"content" => "Started build #42"})
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["channel_id"] == tid
      assert body["content"] == "Started build #42"

      events = drain()
      assert [%{"thread_id" => ^tid, "content" => "Started build #42"}] = published(events, "ThreadMessageCreate")
      assert Enum.any?(Messages.thread_history(thread.thread_id), &(Integer.to_string(&1.id) == body["id"]))

      # The type-less callback followup lands there too.
      fu = post(json_conn(), cb_path(minted), %{"content" => "…and done"})
      assert fu.status == 204
      assert [%{"thread_id" => ^tid, "content" => "…and done"}] = published(drain(), "ThreadMessageCreate")
    end

    test "type 6 then @original PATCH flips the thread card; GET @original answers on the thread", %{
      member: member,
      card: card,
      tid: tid,
      general: general
    } do
      minted = click!(member, card, "approve")
      assert post(json_conn(), cb_path(minted), %{"type" => 6}).status == 200

      conn =
        patch(json_conn(), fu_path(minted) <> "/messages/@original", %{
          "content" => "Approved",
          "components" => [resolved_row()]
        })

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["channel_id"] == tid
      assert body["components"] == [resolved_row()]
      assert body["embeds"] == [@embed]
      assert Messages.get_message(general.channel_id, card.id).components == [resolved_row()]
      assert [%{"thread_id" => ^tid}] = published(drain(), "MessageUpdate")

      shown = get(json_conn(), fu_path(minted) <> "/messages/@original")
      assert shown.status == 200
      assert Jason.decode!(shown.resp_body)["channel_id"] == tid
    end

    test "type 5 then @original PATCH materializes the deferred reply IN the thread", %{
      member: member,
      card: card,
      tid: tid,
      thread: thread
    } do
      minted = click!(member, card, "approve")
      assert post(json_conn(), cb_path(minted), %{"type" => 5}).status == 200

      conn = patch(json_conn(), fu_path(minted) <> "/messages/@original", %{"embeds" => [%{"title" => "Result"}]})
      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["channel_id"] == tid
      assert body["embeds"] == [%{"title" => "Result"}]

      assert [%{"thread_id" => ^tid, "embeds" => [%{"title" => "Result"}]}] =
               published(drain(), "ThreadMessageCreate")

      assert Enum.any?(Messages.thread_history(thread.thread_id), &(Integer.to_string(&1.id) == body["id"]))
    end

    test "a modal opened from a thread card keeps the thread through the submit", %{
      member: member,
      card: card,
      tid: tid,
      thread: thread
    } do
      minted = click!(member, card, "approve")

      modal = %{
        "custom_id" => "why",
        "title" => "Why?",
        "components" => [
          %{"type" => 1, "components" => [%{"type" => 4, "custom_id" => "reason", "style" => 1, "label" => "Reason"}]}
        ]
      }

      assert post(json_conn(), cb_path(minted), %{"type" => 9, "data" => modal}).status == 200

      {:ok, submitted} =
        Interactions.submit_modal(human_claims(member), minted.interaction_id, "why", [
          %{"type" => 1, "components" => [%{"type" => 4, "custom_id" => "reason", "value" => "ship it"}]}
        ])

      assert submitted.payload["thread_id"] == tid
      assert MessageCodec.interaction_from_native(submitted.payload)["channel_id"] == tid

      reply = post(json_conn(), cb_path(submitted), %{"type" => 4, "data" => %{"content" => "Noted: ship it"}})
      assert reply.status == 200
      assert [%{"thread_id" => ^tid}] = published(drain(), "ThreadMessageCreate")
      assert Enum.any?(Messages.thread_history(thread.thread_id), &(&1.content == "Noted: ship it"))
    end
  end

  describe "channel cards are unchanged" do
    test "a channel card's click carries no thread and its answer stays in the channel", %{
      member: member,
      bot: bot,
      general: general
    } do
      ch = Integer.to_string(general.channel_id)
      body = post_card!(bot.token, ch)
      drain()
      card = stored_card(general, body)
      minted = click!(member, card, "approve")

      refute Map.has_key?(minted.payload, "thread_id")
      assert MessageCodec.interaction_from_native(minted.payload)["channel_id"] == ch

      assert post(json_conn(), cb_path(minted), %{"type" => 4, "data" => %{"content" => "ok"}}).status == 200
      events = drain()
      assert published(events, "ThreadMessageCreate") == []
      assert [%{"thread_id" => nil, "content" => "ok"}] = published(events, "MessageCreate")
    end
  end
end
