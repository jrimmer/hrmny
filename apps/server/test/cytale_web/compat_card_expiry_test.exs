defmodule CytaleWeb.CompatCardExpiryTest do
  @moduledoc """
  A bot expires its card with a plain message PATCH, as discord.py does.

  Production, 2026-10-01: Hermes posted an approval card into a thread. Its
  discord.py View timed out after 300s and `on_timeout` ran
  `message.edit(embed=greyed_embed, view=disabled_view)` — a PATCH with
  `embeds` and `components` and no `content`. The compat route was
  content-only and answered 400 50035, so the card kept its live buttons.
  Thirty seconds later the owner clicked "Allow Once" on a card nobody was
  listening to any more, and waited for an answer that could not come.

  Pinned: that PATCH is accepted on a channel and on a thread, replaces the
  embeds and components, keeps the content, reaches live viewers with the
  card, and the disabled buttons refuse further clicks.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

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

    {:ok, owner} = User.create(run_unique("ce_owner"), run_unique("ce_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("ce-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Hermes"))

    {:ok, root} =
      Messages.create_message(%{channel_id: general.channel_id, author_id: owner.user_id, content: "deploy talk"})

    {:ok, thread} = Thread.create(general.channel_id, root.id, "deploy", owner.user_id)
    drain()

    {:ok, owner: owner, general: general, bot: bot, thread: thread}
  end

  defp drain(acc \\ []) do
    receive do
      {:published, channel_id, event} -> drain([{channel_id, event} | acc])
    after
      50 -> Enum.reverse(acc)
    end
  end

  defp published(events, name), do: for({_ch, {^name, payload}} <- events, do: payload)

  defp row(disabled) do
    %{
      "type" => 1,
      "components" =>
        for {label, id, style} <- [{"Allow Once", "once", 3}, {"Deny", "deny", 4}] do
          %{"type" => 2, "style" => style, "label" => label, "custom_id" => id, "disabled" => disabled}
        end
    }
  end

  @content "⚠️ **Hermes wants to run a command that needs your OK**"
  @embed %{"type" => "rich", "title" => "⚠️ Command approval", "color" => 15_105_570}

  # discord.py's Embed.to_dict() after on_timeout greyed it out.
  @expired_embed %{
    "type" => "rich",
    "title" => "⚠️ Command approval",
    "color" => 10_070_709,
    "footer" => %{"text" => "This prompt expired."}
  }

  defp post_card!(bot, target_id) do
    conn =
      post(bot_conn(bot.token), "/api/v10/channels/#{target_id}/messages", %{
        "content" => @content,
        "embeds" => [@embed],
        "components" => [row(false)]
      })

    assert conn.status == 201, conn.resp_body
    drain()
    Jason.decode!(conn.resp_body)
  end

  for where <- [:channel, :thread] do
    test "on a #{where}: the expiry edit (embeds + disabled view, no content) → 200, the card flips", %{
      owner: owner,
      general: general,
      bot: bot,
      thread: thread
    } do
      target = if unquote(where) == :thread, do: thread.thread_id, else: general.channel_id
      card = post_card!(bot, target)

      conn =
        patch(bot_conn(bot.token), "/api/v10/channels/#{target}/messages/#{card["id"]}", %{
          "embeds" => [@expired_embed],
          "components" => [row(true)]
        })

      assert conn.status == 200, conn.resp_body
      body = Jason.decode!(conn.resp_body)
      assert body["channel_id"] == Integer.to_string(target)
      assert body["content"] == @content
      assert body["embeds"] == [@expired_embed]
      assert body["components"] == [row(true)]
      assert body["edited_timestamp"] != nil

      stored = Messages.get_message(general.channel_id, String.to_integer(card["id"]))
      assert stored.content == @content
      assert stored.embeds == [@expired_embed]
      assert stored.components == [row(true)]

      # Live viewers get the card itself, as on a type-7 flip.
      assert [update] = published(drain(), "MessageUpdate")
      assert update["components"] == [row(true)]
      assert update["embeds"] == [@expired_embed]
      if unquote(where) == :thread, do: assert(update["thread_id"] == Integer.to_string(thread.thread_id))

      # The disabled button refuses the click: no interaction is minted for
      # a bot that stopped listening.
      click =
        post(user_conn(owner), "/api/v1/interactions", %{
          "channel_id" => Integer.to_string(general.channel_id),
          "message_id" => card["id"],
          "custom_id" => "once",
          "component_type" => 2
        })

      assert click.status == 400
      assert Jason.decode!(click.resp_body)["error"]["key"] == "component_unavailable"
    end
  end

  test "view=None clears the buttons; content edits keep the card; an empty or bad body changes nothing", %{
    general: general,
    bot: bot
  } do
    card = post_card!(bot, general.channel_id)
    path = "/api/v10/channels/#{general.channel_id}/messages/#{card["id"]}"
    id = String.to_integer(card["id"])

    # Content only: the card is untouched (the shipped behaviour).
    assert patch(bot_conn(bot.token), path, %{"content" => "Approved."}).status == 200
    assert %{content: "Approved.", components: [_], embeds: [@embed]} = Messages.get_message(general.channel_id, id)
    assert [_update] = published(drain(), "MessageUpdate")

    # Nothing to edit, an invalid row, a bad embed list: 400, nothing changes.
    for body <- [%{}, %{"components" => [%{"type" => 9}]}, %{"embeds" => "nope"}, %{"content" => 42}] do
      conn = patch(bot_conn(bot.token), path, body)
      assert conn.status == 400, inspect(body)
      assert Jason.decode!(conn.resp_body)["code"] == 50_035
    end

    assert %{content: "Approved.", components: [_]} = Messages.get_message(general.channel_id, id)

    # discord.py `message.edit(view=None)`: components: [] — an explicit
    # empty card reaches live viewers.
    drain()
    assert patch(bot_conn(bot.token), path, %{"components" => []}).status == 200
    assert %{components: []} = Messages.get_message(general.channel_id, id)
    assert [%{"components" => []}] = published(drain(), "MessageUpdate")
  end
end
