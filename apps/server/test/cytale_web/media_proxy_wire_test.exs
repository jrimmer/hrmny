defmodule CytaleWeb.MediaProxyWireTest do
  @moduledoc """
  The media proxy on every message wire: a bot's external embed media gains
  its signed proxy key on the native REST read, the native dispatch, and the
  compat REST read; our own attachment URLs never do; and a person's Markdown
  image rides the native wire's `content_proxy_urls` map — on the create's
  answer, its dispatch, history, and an edit.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
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

  @ext_image "https://images.example.org/deploy.png"
  @ext_icon "https://images.example.org/bot.png"
  @hash String.duplicate("cd", 32)

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

  defp bot_conn(token), do: put_req_header(json_conn(), "authorization", "Bot " <> token)

  defp user_conn(user),
    do:
      put_req_header(
        json_conn(),
        "authorization",
        "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true)
      )

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

    {:ok, owner} = User.create(run_unique("mp_owner"), run_unique("mp_owner@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("mp-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Imager"))

    {:ok, owner: owner, ch_id: Integer.to_string(ch.channel_id), bot: bot}
  end

  defp drain(acc \\ []) do
    receive do
      {:published, _channel_id, event} -> drain([event | acc])
    after
      50 -> Enum.reverse(acc)
    end
  end

  defp proxied_source(proxy_url) do
    %URI{path: "/api/v1/media/proxy", query: q} = URI.parse(proxy_url)
    %{"u" => u, "e" => e, "s" => s} = URI.decode_query(q)
    assert {:ok, url, _left} = Cytale.MediaProxy.verify(u, e, s)
    url
  end

  @card %{
    "title" => "Deploy OK",
    "image" => %{"url" => @ext_image},
    "thumbnail" => %{"url" => "/api/v1/attachments/" <> @hash},
    "author" => %{"name" => "ci", "icon_url" => @ext_icon},
    "footer" => %{"text" => "attached", "icon_url" => "attachment://logo.png"}
  }

  defp assert_proxied_card(embed) do
    assert embed["title"] == "Deploy OK"
    assert embed["image"]["url"] == @ext_image
    assert proxied_source(embed["image"]["proxy_url"]) == @ext_image
    assert embed["author"]["icon_url"] == @ext_icon
    assert proxied_source(embed["author"]["proxy_icon_url"]) == @ext_icon
    # Our own attachment and an attachment:// ref: exactly as stored.
    assert embed["thumbnail"] == %{"url" => "/api/v1/attachments/" <> @hash}
    assert embed["footer"] == %{"text" => "attached", "icon_url" => "attachment://logo.png"}
  end

  test "a bot's external embed media carries proxy keys on native REST, dispatch and compat reads", %{
    owner: owner,
    ch_id: ch_id,
    bot: bot
  } do
    # A producer-supplied proxy key must never survive to a reader.
    sent = put_in(@card, ["image", "proxy_url"], "https://tracker.example/pixel.gif")
    created = post(bot_conn(bot.token), "/api/v10/channels/#{ch_id}/messages", %{"content" => "", "embeds" => [sent]})
    assert created.status == 201
    assert [compat_embed] = Jason.decode!(created.resp_body)["embeds"]
    assert_proxied_card(compat_embed)

    # The live native dispatch.
    [create] = for {"MessageCreate", payload} <- drain(), do: payload
    assert [dispatched] = create["embeds"]
    assert_proxied_card(dispatched)

    # Native history (a member's read).
    native = get(user_conn(owner), "/api/v1/channels/#{ch_id}/messages")
    assert [%{"embeds" => [native_embed]} = msg] = Jason.decode!(native.resp_body)["messages"]
    assert_proxied_card(native_embed)
    refute Map.has_key?(msg, "content_proxy_urls")

    # Compat history.
    history = get(bot_conn(bot.token), "/api/v10/channels/#{ch_id}/messages")
    assert [%{"embeds" => [history_embed]}] = Jason.decode!(history.resp_body)
    assert_proxied_card(history_embed)
  end

  test "a person's Markdown image rides content_proxy_urls on create, dispatch, history and edit", %{
    owner: owner,
    ch_id: ch_id
  } do
    body = "the plan ![whiteboard](#{@ext_image}) and a [link](https://example.org)"
    created = post(user_conn(owner), "/api/v1/channels/#{ch_id}/messages", %{"content" => body})
    assert created.status == 201
    msg = Jason.decode!(created.resp_body)["message"] || Jason.decode!(created.resp_body)
    assert %{@ext_image => proxied} = msg["content_proxy_urls"]
    assert map_size(msg["content_proxy_urls"]) == 1
    assert proxied_source(proxied) == @ext_image

    [create] = for {"MessageCreate", payload} <- drain(), do: payload
    assert %{@ext_image => _} = create["content_proxy_urls"]

    history = get(user_conn(owner), "/api/v1/channels/#{ch_id}/messages")

    assert [%{"content" => ^body, "content_proxy_urls" => %{@ext_image => _}}] =
             Jason.decode!(history.resp_body)["messages"]

    # An edit that drops the image drops the map; one that adds a new image maps it.
    edited = patch(user_conn(owner), "/api/v1/channels/#{ch_id}/messages/#{msg["id"]}", %{"content" => "no image now"})
    assert edited.status == 200
    [update] = for {"MessageUpdate", payload} <- drain(), do: payload
    refute Map.has_key?(update, "content_proxy_urls")

    patch(user_conn(owner), "/api/v1/channels/#{ch_id}/messages/#{msg["id"]}", %{"content" => "![icon](#{@ext_icon})"})
    [update] = for {"MessageUpdate", payload} <- drain(), do: payload
    assert Map.keys(update["content_proxy_urls"]) == [@ext_icon]
  end

  test "an attachment-hosted Markdown image mints no proxy entry", %{owner: owner, ch_id: ch_id} do
    created =
      post(user_conn(owner), "/api/v1/channels/#{ch_id}/messages", %{
        "content" => "![mine](/api/v1/attachments/#{@hash}) ![ftp](ftp://x.example/a.png)"
      })

    assert created.status == 201
    msg = Jason.decode!(created.resp_body)["message"] || Jason.decode!(created.resp_body)
    refute Map.has_key?(msg, "content_proxy_urls")
  end
end
