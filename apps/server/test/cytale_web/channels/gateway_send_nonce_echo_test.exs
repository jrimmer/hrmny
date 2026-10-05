defmodule CytaleWeb.Channels.GatewaySendNonceEchoTest do
  @moduledoc """
  The send key rides the echo (send reliability B1).

  The web draws a pending row keyed by the send's `nonce` and settles it when
  its own `MessageCreate` / `ThreadMessageCreate` echo arrives. The echo used
  to carry no key, so the client matched by author + content — a heuristic
  that cannot tell two identical in-flight messages apart. The create's wire
  now carries `nonce` (Discord's MESSAGE_CREATE field) whenever the send
  carried one: the 201 and every emission are built from ONE map, so they
  cannot disagree.

  Visibility, decided and pinned here: the key rides to EVERY recipient,
  exactly as Discord sends it. One payload is built per create and fanned out
  unchanged (no per-session variant on the hot path or in the resume
  buffers), and the key is a random per-message token scoped to its author —
  the dedupe reservation and the Idempotency-Key replay are both keyed on
  (author, key) — so another member holding it can do nothing with it.

  Covered end to end over REAL sockets and REAL REST routes: the native
  channel send, the native thread reply (key from the Idempotency-Key
  header, as the web's thread composer sends it), the compat channel send
  and the compat thread reply; native and compat sessions both.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User, Verification}
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Threads.Thread
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

    author = verified_user!("echo_a")
    member = verified_user!("echo_b")

    {:ok, ws} = Workspaces.create_workspace(author.user_id, run_unique("echo-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, author.user_id)
    {:ok, agent} = AgentGrants.mint_all(author.user_id, :agent, run_unique("Echo Agent"))

    {:ok, root} = Messages.create_message(%{channel_id: general.channel_id, author_id: author.user_id, content: "root"})
    {:ok, thread} = Thread.create(general.channel_id, root.id, "echo thread", author.user_id)

    author_access = Auth.issue_access_token(author.user_id, author.username, true)
    member_access = Auth.issue_access_token(member.user_id, member.username, true)

    a = native_session!(port, author_access, general.channel_id)
    b = native_session!(port, member_access, general.channel_id)
    bot = compat_session!(port, agent.token)

    %{
      author: author,
      author_access: author_access,
      agent: agent,
      channel_id: general.channel_id,
      thread_id: thread.thread_id,
      a: a,
      b: b,
      bot: bot
    }
  end

  # -- fixtures ------------------------------------------------------------------

  defp verified_user!(base) do
    {:ok, user} = User.create(run_unique(base), run_unique(base) <> "@echo.example.com", "password-123")
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

  defp compat_session!(port, token) do
    conn = connect!(port, v: 10)

    identify!(conn, token,
      raw_d: %{
        "token" => token,
        "v" => 10,
        "intents" => CytaleWeb.GatewaySocket.supported_intents(),
        "compress" => nil,
        "properties" => %{"$os" => "linux", "$browser" => "discord.js", "$device" => "discord.js"}
      }
    )

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

  # The `event` dispatch for message `id`, skipping everything else (the
  # other leg of a dual emission, presence, typing).
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

  defp key, do: "echo-" <> Cytale.TestNonce.get()

  # -- native --------------------------------------------------------------------

  describe "native channel send" do
    test "the 201 and every session's MessageCreate carry the send's nonce", fx do
      nonce = key()

      resp =
        post(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages", %{
          "content" => "twin",
          "nonce" => nonce
        })

      assert resp.status == 201
      %{"message" => %{"id" => id} = created} = Jason.decode!(resp.resp_body)
      assert created["nonce"] == nonce

      # The author's own session: the echo its pending row settles by.
      assert %{"nonce" => ^nonce, "content" => "twin"} = event_for!(fx.a, "MessageCreate", id)
      # Another member still receives the message — with the key (see the
      # moduledoc: one payload for every recipient, as Discord sends it).
      assert %{"nonce" => ^nonce, "content" => "twin"} = event_for!(fx.b, "MessageCreate", id)
      # A compat session gets Discord's MESSAGE_CREATE `nonce`.
      assert %{"nonce" => ^nonce} = event_for!(fx.bot, "MESSAGE_CREATE", id)
    end

    test "a retry answers the ORIGINAL message with the same nonce", fx do
      nonce = key()
      body = %{"content" => "once", "nonce" => nonce}

      first = post(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages", body)
      assert first.status == 201
      %{"message" => %{"id" => id}} = Jason.decode!(first.resp_body)

      retry = post(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages", body)
      assert retry.status == 200
      assert %{"message" => %{"id" => ^id, "nonce" => ^nonce}} = Jason.decode!(retry.resp_body)
    end

    test "a send without a key has no nonce anywhere, and history never carries one", fx do
      resp = post(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages", %{"content" => "keyless"})
      assert resp.status == 201
      %{"message" => %{"id" => id} = created} = Jason.decode!(resp.resp_body)
      refute Map.has_key?(created, "nonce")
      refute Map.has_key?(event_for!(fx.b, "MessageCreate", id), "nonce")

      nonce = key()

      post(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages", %{
        "content" => "keyed",
        "nonce" => nonce
      })

      history = Jason.decode!(get(api(fx.author_access), "/api/v1/channels/#{fx.channel_id}/messages").resp_body)
      refute Enum.any?(history["messages"], &Map.has_key?(&1, "nonce"))
    end
  end

  describe "native thread reply" do
    test "the key from Idempotency-Key rides the 201 and BOTH legs", fx do
      nonce = key()

      resp =
        fx.author_access
        |> api()
        |> put_req_header("idempotency-key", nonce)
        |> post("/api/v1/threads/#{fx.thread_id}/messages", %{"content" => "in thread"})

      assert resp.status == 201
      %{"message" => %{"id" => id} = created} = Jason.decode!(resp.resp_body)
      assert created["nonce"] == nonce

      thread_id = Integer.to_string(fx.thread_id)

      for conn <- [fx.a, fx.b] do
        assert %{"nonce" => ^nonce, "thread_id" => ^thread_id} = event_for!(conn, "MessageCreate", id)
        assert %{"nonce" => ^nonce} = event_for!(conn, "ThreadMessageCreate", id)
      end

      # Compat: the thread leg renders as MESSAGE_CREATE on the thread id.
      assert %{"nonce" => ^nonce, "channel_id" => ^thread_id} = event_for!(fx.bot, "MESSAGE_CREATE", id)
    end
  end

  # -- compat --------------------------------------------------------------------

  describe "compat sends" do
    test "a channel send's nonce reaches native and compat sessions", fx do
      nonce = key()

      resp =
        post(api(fx.agent.token, "Bot"), "/api/v10/channels/#{fx.channel_id}/messages", %{
          "content" => "from a bot",
          "nonce" => nonce
        })

      assert resp.status == 201
      %{"id" => id} = created = Jason.decode!(resp.resp_body)
      assert created["nonce"] == nonce

      assert %{"nonce" => ^nonce} = event_for!(fx.a, "MessageCreate", id)
      assert %{"nonce" => ^nonce} = event_for!(fx.bot, "MESSAGE_CREATE", id)
    end

    test "a thread reply's nonce rides the 201 and both native legs", fx do
      nonce = key()

      resp =
        post(api(fx.agent.token, "Bot"), "/api/v10/channels/#{fx.thread_id}/messages", %{
          "content" => "bot in thread",
          "nonce" => nonce
        })

      assert resp.status == 201
      %{"id" => id} = created = Jason.decode!(resp.resp_body)
      assert created["nonce"] == nonce

      assert %{"nonce" => ^nonce} = event_for!(fx.a, "MessageCreate", id)
      assert %{"nonce" => ^nonce} = event_for!(fx.a, "ThreadMessageCreate", id)
      assert %{"nonce" => ^nonce} = event_for!(fx.bot, "MESSAGE_CREATE", id)
    end
  end
end
