defmodule CytaleWeb.InteractionSuccessTest do
  @moduledoc """
  The clicker learns, exactly, that the bot answered (Discord's
  INTERACTION_SUCCESS, native `InteractionSuccess`).

  Before this, the server told the person who clicked nothing at all: the web
  client inferred an answer from the store (the card flipping, a new message
  by the bot) and fell back to "No response yet" after 10s. A deferred ack
  (type 5 or 6) changes nothing in the store, so a bot that deferred and then
  took a while always tripped the fallback.

  Pinned here, for a card in a channel AND a card in a thread, through the
  real ingress (the bot learns its token from its own InteractionCreate):

    * every legitimate answer — 4, 5 (+ followup), 6 (+ @original PATCH),
      7, 9, a followup without an ack (callback and webhook routes) — sends
      ONE InteractionSuccess to the clicker's sessions, carrying the
      interaction id, the client's nonce, the message, the custom_id, and
      the channel and thread;
    * nothing is sent before the bot answers, and nothing reaches anyone
      but the clicker;
    * the nonce is optional and validated.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Interactions
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

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

  defp user_conn(user),
    do:
      json_conn()
      |> put_req_header("authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))

  defp subscribe(user_id) do
    key = Integer.to_string(user_id)
    :ok = PushRegistry.subscribe(PushRegistry.user_key(key), key)
  end

  setup do
    {:ok, owner} = User.create(run_unique("is_owner"), run_unique("is_owner@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("is_member"), run_unique("is_member@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("is-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Hermes"))

    {:ok, root} =
      Messages.create_message(%{channel_id: general.channel_id, author_id: owner.user_id, content: "deploy talk"})

    {:ok, thread} = Thread.create(general.channel_id, root.id, "deploy", owner.user_id)

    # This test process stands in for the bot's gateway session (it reads
    # its token from the InteractionCreate) AND the clicker's.
    subscribe(bot.user_id)
    subscribe(member.user_id)

    {:ok, owner: owner, member: member, ws: ws, general: general, bot: bot, thread: thread}
  end

  defp approve_row(disabled \\ false) do
    %{
      "type" => 1,
      "components" => [
        %{"type" => 2, "style" => 3, "label" => "Allow Once", "custom_id" => "once", "disabled" => disabled}
      ]
    }
  end

  # The card, in the channel (thread nil) or in the thread.
  defp card!(general, bot, thread) do
    {:ok, msg} =
      Messages.create_message(%{
        channel_id: general.channel_id,
        author_id: bot.user_id,
        content: "Hermes wants to run a command that needs your OK",
        thread_id: thread && thread.thread_id,
        components: [approve_row()]
      })

    msg
  end

  # The web's click, through the real ingress. Returns what the bot's
  # InteractionCreate carried (id + token) and the 202's interaction id.
  defp click!(member, general, card, body \\ %{"nonce" => "n-" <> run_unique("")}) do
    conn =
      post(
        user_conn(member),
        "/api/v1/interactions",
        Map.merge(
          %{
            "channel_id" => Integer.to_string(general.channel_id),
            "message_id" => Integer.to_string(card.id),
            "custom_id" => "once",
            "component_type" => 2
          },
          body
        )
      )

    assert conn.status == 202, conn.resp_body
    id = Jason.decode!(conn.resp_body)["interaction_id"]
    assert_receive {:cytale_gateway_push, _, {"InteractionCreate", %{"id" => ^id} = created}, _}, 2_000
    %{id: id, token: created["token"], app: created["application_id"], nonce: body["nonce"]}
  end

  defp cb(i), do: "/api/v10/interactions/#{i.id}/#{i.token}/callback"
  defp webhook(i), do: "/api/v10/webhooks/#{i.app}/#{i.token}"

  # The one InteractionSuccess for interaction `i`, then silence.
  defp assert_success(i, card, general, thread, response_type) do
    id = i.id
    assert_receive {:cytale_gateway_push, _, {"InteractionSuccess", %{"interaction_id" => ^id} = s}, _}, 2_000

    assert s == %{
             "interaction_id" => id,
             "nonce" => i.nonce,
             "application_id" => i.app,
             "channel_id" => Integer.to_string(general.channel_id),
             "thread_id" => thread && Integer.to_string(thread.thread_id),
             "message_id" => Integer.to_string(card.id),
             "custom_id" => "once",
             "response_type" => response_type
           }

    refute_receive {:cytale_gateway_push, _, {"InteractionSuccess", _}, _}, 150
    s
  end

  for where <- [:channel, :thread] do
    describe "a #{where} card" do
      setup %{general: general, bot: bot, thread: thread} do
        thread = if unquote(where) == :thread, do: thread, else: nil
        {:ok, card: card!(general, bot, thread), where_thread: thread}
      end

      test "nothing is sent before the bot answers", %{member: member, general: general, card: card} do
        _i = click!(member, general, card)
        refute_receive {:cytale_gateway_push, _, {"InteractionSuccess", _}, _}, 200
      end

      test "type 4 (reply) → one InteractionSuccess, after the reply was published",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)
        assert post(json_conn(), cb(i), %{"type" => 4, "data" => %{"content" => "Approved"}}).status == 200
        assert_success(i, card, general, thread, 4)
      end

      test "type 5 then a followup → one InteractionSuccess, at the defer",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)
        assert post(json_conn(), cb(i), %{"type" => 5}).status == 200
        assert_success(i, card, general, thread, 5)

        assert post(json_conn(), webhook(i), %{"content" => "done"}).status == 200
        refute_receive {:cytale_gateway_push, _, {"InteractionSuccess", _}, _}, 150
      end

      test "type 6 then an @original PATCH (deferred update, then the edit) → one InteractionSuccess",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)
        assert post(json_conn(), cb(i), %{"type" => 6}).status == 200
        assert_success(i, card, general, thread, 6)

        conn = patch(json_conn(), webhook(i) <> "/messages/@original", %{"components" => [approve_row(true)]})
        assert conn.status == 200
        refute_receive {:cytale_gateway_push, _, {"InteractionSuccess", _}, _}, 150
      end

      test "type 7 (update the card) → one InteractionSuccess",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)

        conn =
          post(json_conn(), cb(i), %{
            "type" => 7,
            "data" => %{"content" => "Approved by you", "components" => [approve_row(true)]}
          })

        assert conn.status == 200
        assert_success(i, card, general, thread, 7)
      end

      test "type 9 (a modal) → one InteractionSuccess beside the InteractionModal",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)

        modal = %{
          "custom_id" => "why",
          "title" => "Why?",
          "components" => [
            %{"type" => 1, "components" => [%{"type" => 4, "custom_id" => "reason", "style" => 1, "label" => "Reason"}]}
          ]
        }

        assert post(json_conn(), cb(i), %{"type" => 9, "data" => modal}).status == 200
        assert_receive {:cytale_gateway_push, _, {"InteractionModal", _}, _}, 2_000
        assert_success(i, card, general, thread, 9)
      end

      test "a followup with no ack (webhook route) answers too",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)
        assert post(json_conn(), webhook(i), %{"content" => "on it"}).status == 200
        assert_success(i, card, general, thread, 4)
      end

      test "a followup with no ack (type-less callback) answers too",
           %{member: member, general: general, card: card, where_thread: thread} do
        i = click!(member, general, card)
        assert post(json_conn(), cb(i), %{"content" => "on it"}).status == 204
        assert_success(i, card, general, thread, 4)
      end
    end
  end

  describe "who hears it, and the nonce" do
    test "only the clicker's sessions; another member hears nothing", %{
      owner: owner,
      member: member,
      general: general,
      bot: bot
    } do
      # The owner's session: its own process, reporting what it hears.
      test_pid = self()

      owner_session =
        spawn_link(fn ->
          subscribe(owner.user_id)
          send(test_pid, :owner_listening)

          receive_loop = fn loop ->
            receive do
              {:cytale_gateway_push, _, event, _} ->
                send(test_pid, {:owner_heard, event})
                loop.(loop)
            end
          end

          receive_loop.(receive_loop)
        end)

      assert_receive :owner_listening, 1_000

      card = card!(general, bot, nil)
      i = click!(member, general, card)
      assert post(json_conn(), cb(i), %{"type" => 6}).status == 200

      assert_success(i, card, general, nil, 6)
      refute_receive {:owner_heard, {"InteractionSuccess", _}}, 150
      Process.unlink(owner_session)
      Process.exit(owner_session, :kill)
    end

    test "without a nonce the signal still names the interaction (nonce null)", %{
      member: member,
      general: general,
      bot: bot
    } do
      card = card!(general, bot, nil)
      i = click!(member, general, card, %{})
      assert post(json_conn(), cb(i), %{"type" => 6}).status == 200
      assert %{"nonce" => nil} = assert_success(i, card, general, nil, 6)
    end

    test "a malformed nonce is a 400 and mints nothing", %{member: member, general: general, bot: bot} do
      card = card!(general, bot, nil)

      for nonce <- [String.duplicate("x", 65), "", 12_345] do
        conn =
          post(user_conn(member), "/api/v1/interactions", %{
            "channel_id" => Integer.to_string(general.channel_id),
            "message_id" => Integer.to_string(card.id),
            "custom_id" => "once",
            "component_type" => 2,
            "nonce" => nonce
          })

        assert conn.status == 400
        assert Jason.decode!(conn.resp_body)["error"]["key"] == "validation_failed"
      end

      refute_receive {:cytale_gateway_push, _, {"InteractionCreate", _}, _}, 150
    end

    test "a slash command's answer reaches its invoker, with no message or custom_id", %{
      ws: ws,
      member: member,
      general: general,
      bot: bot
    } do
      {:ok, [command]} =
        Interactions.upsert_commands(
          ws.workspace_id,
          bot.user_id,
          [%{"name" => "echo", "description" => "Echo"}],
          :replace
        )

      conn =
        post(user_conn(member), "/api/v1/interactions", %{
          "command_id" => Integer.to_string(command.command_id),
          "channel_id" => Integer.to_string(general.channel_id),
          "options" => %{},
          "nonce" => "cmd-1"
        })

      assert conn.status == 202
      id = Jason.decode!(conn.resp_body)["interaction_id"]
      assert_receive {:cytale_gateway_push, _, {"InteractionCreate", %{"id" => ^id, "token" => token}}, _}, 2_000

      assert post(json_conn(), "/api/v10/interactions/#{id}/#{token}/callback", %{
               "type" => 4,
               "data" => %{"content" => "echo"}
             }).status == 200

      assert_receive {:cytale_gateway_push, _, {"InteractionSuccess", success}, _}, 2_000

      assert success == %{
               "interaction_id" => id,
               "nonce" => "cmd-1",
               "application_id" => Integer.to_string(bot.user_id),
               "channel_id" => Integer.to_string(general.channel_id),
               "thread_id" => nil,
               "message_id" => nil,
               "custom_id" => nil,
               "response_type" => 4
             }
    end
  end
end
