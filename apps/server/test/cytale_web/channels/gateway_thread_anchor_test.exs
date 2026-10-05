defmodule CytaleWeb.Channels.GatewayThreadAnchorTest do
  @moduledoc """
  Invisible threads: the anchor reaches the OTHER member's session.

  A principal other than the viewer — a bot through the compat API, a second
  account through the native API — starts a thread on the viewer's message
  and replies in it. The viewer's open client must learn WHERE the thread
  hangs (`parent_message_id`) from the live `ThreadCreate`, or it cannot draw
  the reply indicator on the seed message and the replies stay invisible until
  a reload refetches the roster. Before this fix the payload carried no anchor
  at all; approval prompts from the owner's bot landed in such threads and
  timed out unanswered.

  Covered end to end over REAL sockets and REAL REST routes: the native start
  (second human), the compat start-from-message (bot token) and the compat
  standalone start (a null anchor), plus `ThreadUpdate` from both archive
  routes — each asserted on the VIEWER's session, never the creator's.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User, Verification}
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    port = start_gateway!()

    # REAL accounts (REST needs them), so the native sockets identify with
    # their JWTs rather than the :test stub.
    old_impl = Application.get_env(:cytale, :human_impl)
    Application.put_env(:cytale, :human_impl, Cytale.Gateway.Authenticator.JWT)

    # The production route (Publish.publish → workspace process → fan-out);
    # the :test default only logs.
    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      Application.put_env(:cytale, :human_impl, old_impl)

      if old_publish,
        do: Application.put_env(:cytale, Cytale.Publish, old_publish),
        else: Application.delete_env(:cytale, Cytale.Publish)
    end)

    viewer = verified_user!("anchor_v")
    other = verified_user!("anchor_o")

    {:ok, ws} = Workspaces.create_workspace(viewer.user_id, run_unique("anchor-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    :ok = Workspaces.add_member(ws.workspace_id, other.user_id, viewer.user_id)
    {:ok, bot} = AgentGrants.mint_all(viewer.user_id, :bot, run_unique("Anchor Bot"))

    # The VIEWER's message is the seed every thread below hangs off.
    {:ok, seed} =
      Messages.create_message(%{channel_id: general.channel_id, author_id: viewer.user_id, content: "approve?"})

    viewer_access = Auth.issue_access_token(viewer.user_id, viewer.username, true)
    other_access = Auth.issue_access_token(other.user_id, other.username, true)

    %{
      channel_id: general.channel_id,
      seed_id: Integer.to_string(seed.id),
      viewer_access: viewer_access,
      other_access: other_access,
      bot: bot,
      v: native_session!(port, viewer_access, general.channel_id)
    }
  end

  # -- fixtures ------------------------------------------------------------------

  defp verified_user!(base) do
    {:ok, user} = User.create(run_unique(base), run_unique(base) <> "@anchor.example.com", "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Verification.complete_email_verification(raw)
    user
  end

  defp native_session!(port, token, channel_id) do
    conn = connect!(port)
    ready = identify!(conn, token)
    user_id = ready["user"]["id"]
    assert [{pid, ^user_id}] = PushRegistry.subscribers(PushRegistry.user_key(user_id))
    wait_for_route!(pid, PushRegistry.channel_key(Integer.to_string(channel_id)), 100)
    drain!(conn)
    conn
  end

  defp wait_for_route!(_pid, _key, 0), do: flunk("route never joined")

  defp wait_for_route!(pid, key, tries) do
    if key in PushRegistry.session_keys(pid) do
      :ok
    else
      Process.sleep(20)
      wait_for_route!(pid, key, tries - 1)
    end
  end

  defp drain!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  # The `event` dispatch about thread/message `id`, skipping everything else.
  defp event_for!(conn, event, id) do
    frame = next_event!(conn, event, 5_000)
    if frame["d"]["id"] == id, do: frame["d"], else: event_for!(conn, event, id)
  end

  defp api(token, scheme \\ "Bearer") do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", scheme <> " " <> token)
  end

  # -- native: a second human starts the thread ------------------------------------

  describe "native start by another member" do
    test "the viewer's ThreadCreate names the seed message as a string snowflake", fx do
      resp =
        post(api(fx.other_access), "/api/v1/channels/#{fx.channel_id}/messages/#{fx.seed_id}/threads", %{
          "name" => "second opinion"
        })

      assert resp.status == 201
      %{"thread" => %{"id" => thread_id} = created} = Jason.decode!(resp.resp_body)
      assert created["parent_message_id"] == fx.seed_id

      d = event_for!(fx.v, "ThreadCreate", thread_id)
      assert d["parent_message_id"] == fx.seed_id
      assert is_binary(d["parent_message_id"])
      assert d["channel_id"] == Integer.to_string(fx.channel_id)

      # The reply the viewer must see the chip count: the thread leg arrives on
      # the viewer's session too.
      reply = post(api(fx.other_access), "/api/v1/threads/#{thread_id}/messages", %{"content" => "lgtm"})
      assert reply.status == 201
      %{"message" => %{"id" => reply_id}} = Jason.decode!(reply.resp_body)
      assert %{"thread_id" => ^thread_id} = event_for!(fx.v, "ThreadMessageCreate", reply_id)
    end

    test "the native archive's ThreadUpdate restates the anchor", fx do
      %{"thread" => %{"id" => thread_id}} =
        api(fx.other_access)
        |> post("/api/v1/channels/#{fx.channel_id}/messages/#{fx.seed_id}/threads", %{"name" => "to archive"})
        |> Map.fetch!(:resp_body)
        |> Jason.decode!()

      _ = event_for!(fx.v, "ThreadCreate", thread_id)

      assert patch(api(fx.other_access), "/api/v1/threads/#{thread_id}", %{"archived" => true}).status == 200

      d = event_for!(fx.v, "ThreadUpdate", thread_id)
      assert d["parent_message_id"] == fx.seed_id
      assert d["archived"] == true
    end
  end

  # -- compat: a bot starts the thread ----------------------------------------------

  describe "compat start by a bot" do
    test "start-from-message: the viewer's native ThreadCreate carries the anchor", fx do
      resp =
        post(api(fx.bot.token, "Bot"), "/api/v10/channels/#{fx.channel_id}/messages/#{fx.seed_id}/threads", %{
          "name" => "approval needed",
          "auto_archive_duration" => 1440
        })

      assert resp.status == 200
      %{"id" => thread_id} = Jason.decode!(resp.resp_body)

      # Compat mints a FRESH thread id, so the anchor is the only link from
      # the thread back to the seed message — nothing can derive it.
      refute thread_id == fx.seed_id

      d = event_for!(fx.v, "ThreadCreate", thread_id)
      assert d["parent_message_id"] == fx.seed_id
      assert is_binary(d["created_by"])

      reply =
        post(api(fx.bot.token, "Bot"), "/api/v10/channels/#{thread_id}/messages", %{"content" => "approve deploy?"})

      assert reply.status in [200, 201]
      %{"id" => reply_id} = Jason.decode!(reply.resp_body)
      assert %{"thread_id" => ^thread_id} = event_for!(fx.v, "ThreadMessageCreate", reply_id)
    end

    test "standalone start: the anchor key is present and null", fx do
      resp =
        post(api(fx.bot.token, "Bot"), "/api/v10/channels/#{fx.channel_id}/threads", %{
          "name" => "standalone",
          "type" => 11
        })

      assert resp.status == 200
      %{"id" => thread_id} = Jason.decode!(resp.resp_body)

      d = event_for!(fx.v, "ThreadCreate", thread_id)
      assert Map.has_key?(d, "parent_message_id")
      assert d["parent_message_id"] == nil
    end

    test "the compat archive's ThreadUpdate restates the anchor", fx do
      %{"id" => thread_id} =
        api(fx.bot.token, "Bot")
        |> post("/api/v10/channels/#{fx.channel_id}/messages/#{fx.seed_id}/threads", %{"name" => "bot archive"})
        |> Map.fetch!(:resp_body)
        |> Jason.decode!()

      _ = event_for!(fx.v, "ThreadCreate", thread_id)

      assert patch(api(fx.bot.token, "Bot"), "/api/v10/channels/#{thread_id}", %{"archived" => true}).status == 200

      d = event_for!(fx.v, "ThreadUpdate", thread_id)
      assert d["parent_message_id"] == fx.seed_id
      assert d["archived"] == true
    end
  end
end
