defmodule CytaleWeb.SendParityTest do
  @moduledoc """
  Send parity: the four send routes — the native channel send, the native
  thread reply, and the compat send on a channel id and on a thread id — go
  through ONE pipeline (`Cytale.Messages.Send`), so a rule that holds on one
  of them holds on all four. Each describe here runs the same assertion over
  every route (`@routes`), so a route that diverges fails its own row.

  The sender is one bot principal on every route (the compat surface is
  Bot-auth only, and the native routes accept the same `Bot` credential), so
  the only thing that varies within a table is the route.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Messages
  alias Cytale.Test.AgentGrants
  alias Cytale.Threads.Thread
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  @routes [:native_channel, :native_thread, :compat_channel, :compat_thread]

  # Every way to post a THREAD REPLY: the native reply route, the native
  # channel send naming the thread in its body, and the compat send on the
  # thread id.
  @thread_routes [:native_thread, :native_channel_thread_id, :compat_thread]

  defp unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  setup do
    {:ok, owner} = User.create(unique("par_o"), unique("par_o@example.com"), "password-123")
    {:ok, raw, _hash} = Auth.issue_single_use_token(owner.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)
    owner_token = Auth.issue_access_token(owner.user_id, owner.username, true)

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, unique("par-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, unique("Parity Bot"))

    thread = seed_thread!(ch.channel_id, owner.user_id)
    other_thread = seed_thread!(ch.channel_id, owner.user_id)

    {:ok,
     owner: owner,
     owner_auth: "Bearer " <> owner_token,
     ws_id: ws.workspace_id,
     ch_id: ch.channel_id,
     thread: thread,
     other_thread: other_thread,
     bot_id: bot.user_id,
     bot_auth: "Bot " <> bot.token}
  end

  # -- route table ------------------------------------------------------------------

  # One send on `route`, spelled in that route's dialect. `opts`:
  #   :content, :nonce, :reply_to (a message id), :embeds, :allowed_mentions,
  #   :attachments, :components, :idempotency_key, :auth (defaults to the bot).
  # Returns the conn.
  defp send_on(route, fx, opts) do
    auth = Keyword.get(opts, :auth, fx.bot_auth)
    {path, body} = route_request(route, fx, opts)

    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", auth)
    |> then(fn conn ->
      case opts[:idempotency_key] do
        nil -> conn
        key -> put_req_header(conn, "idempotency-key", key)
      end
    end)
    |> post(path, body)
  end

  defp route_request(route, fx, opts) do
    body =
      %{}
      |> put_opt("content", Keyword.get(opts, :content, "hello"))
      |> put_opt("nonce", opts[:nonce])
      |> put_opt("embeds", opts[:embeds])
      |> put_opt("allowed_mentions", opts[:allowed_mentions])
      |> put_opt("attachments", opts[:attachments])
      |> put_opt("components", opts[:components])

    case route do
      :native_channel ->
        {"/api/v1/channels/#{fx.ch_id}/messages", put_opt(body, "reply_to_id", id_str(opts[:reply_to]))}

      :native_thread ->
        {"/api/v1/threads/#{fx.thread.thread_id}/messages", put_opt(body, "reply_to_id", id_str(opts[:reply_to]))}

      :native_channel_thread_id ->
        {"/api/v1/channels/#{fx.ch_id}/messages",
         body
         |> put_opt("reply_to_id", id_str(opts[:reply_to]))
         |> Map.put("thread_id", Integer.to_string(Keyword.get(opts, :thread_id, fx.thread.thread_id)))}

      :compat_channel ->
        {"/api/v10/channels/#{fx.ch_id}/messages", put_opt(body, "message_reference", reference(opts[:reply_to]))}

      :compat_thread ->
        {"/api/v10/channels/#{fx.thread.thread_id}/messages",
         put_opt(body, "message_reference", reference(opts[:reply_to]))}
    end
  end

  defp put_opt(map, _key, nil), do: map
  defp put_opt(map, key, value), do: Map.put(map, key, value)

  defp id_str(nil), do: nil
  defp id_str(id), do: Integer.to_string(id)

  defp reference(nil), do: nil
  defp reference(id), do: %{"message_id" => Integer.to_string(id)}

  defp thread_route?(route), do: route in @thread_routes

  # The created/replayed message's id, whichever envelope the dialect uses.
  defp sent_id(conn) do
    case Jason.decode!(conn.resp_body) do
      %{"message" => %{"id" => id}} -> String.to_integer(id)
      %{"id" => id} -> String.to_integer(id)
    end
  end

  # The dialect's 400 for a malformed or refused field: native
  # `validation_failed`, compat `50035`.
  defp validation_failure?(conn) do
    conn.status == 400 and
      case Jason.decode!(conn.resp_body) do
        %{"error" => %{"key" => "validation_failed"}} -> true
        %{"code" => 50_035} -> true
        _ -> false
      end
  end

  # The dialect's refusal of embeds over the caps: native `invalid_embeds`,
  # compat 50035.
  defp invalid_embeds?(conn) do
    case Jason.decode!(conn.resp_body) do
      %{"error" => %{"key" => "invalid_embeds"}} -> true
      %{"code" => 50_035} -> true
      _ -> false
    end
  end

  # The dialect's key-reuse conflict: native 409 `idempotency_conflict`,
  # compat 400 50035 on `nonce`.
  defp nonce_conflict?(route, conn) do
    body = Jason.decode!(conn.resp_body)

    case route do
      r when r in [:native_channel, :native_thread, :native_channel_thread_id] ->
        conn.status == 409 and match?(%{"error" => %{"key" => "idempotency_conflict"}}, body)

      _ ->
        conn.status == 400 and match?(%{"code" => 50_035, "errors" => %{"nonce" => _}}, body)
    end
  end

  defp seed_thread!(channel_id, author_id) do
    {:ok, root} = Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: "root"})
    {:ok, thread} = Thread.create(channel_id, root.id, "parity thread", author_id)
    thread
  end

  defp seed_message!(fx, attrs) do
    {:ok, msg} =
      Messages.create_message(Map.merge(%{channel_id: fx.ch_id, author_id: fx.owner.user_id, content: "seed"}, attrs))

    msg
  end

  # A message in the conversation `route` sends into (the timeline or the
  # thread), and one in a DIFFERENT conversation of the same channel storage.
  defp same_conversation_message!(route, fx) do
    if thread_route?(route),
      do: seed_message!(fx, %{thread_id: fx.thread.thread_id}),
      else: seed_message!(fx, %{})
  end

  # -- gap 3: the reply reference's scope -------------------------------------------

  describe "reply reference scope (one rule: the send's own conversation)" do
    for route <- @routes do
      test "#{route}: a reference in the same conversation is a reply", fx do
        target = same_conversation_message!(unquote(route), fx)
        conn = send_on(unquote(route), fx, reply_to: target.id)

        assert conn.status == 201, conn.resp_body
        assert %{reply_to_id: reply_to} = Messages.get_message(fx.ch_id, sent_id(conn))
        assert reply_to == target.id
      end

      test "#{route}: a dangling reference is a validation failure", fx do
        conn = send_on(unquote(route), fx, content: "dangling", reply_to: Cytale.Snowflake.next())
        assert validation_failure?(conn), conn.resp_body
      end
    end

    for route <- @thread_routes do
      test "#{route}: a reference to another thread's reply is refused", fx do
        elsewhere = seed_message!(fx, %{thread_id: fx.other_thread.thread_id})
        conn = send_on(unquote(route), fx, content: "cross-thread", reply_to: elsewhere.id)

        assert validation_failure?(conn), conn.resp_body
        assert Thread.get(fx.thread.thread_id).message_count == 0
      end

      test "#{route}: a reference to the parent channel's timeline is refused", fx do
        timeline = seed_message!(fx, %{})
        conn = send_on(unquote(route), fx, content: "to the timeline", reply_to: timeline.id)

        assert validation_failure?(conn), conn.resp_body
        assert Thread.get(fx.thread.thread_id).message_count == 0
      end
    end

    test "native_channel_thread_id: a reference in the thread is a reply", fx do
      target = seed_message!(fx, %{thread_id: fx.thread.thread_id})
      conn = send_on(:native_channel_thread_id, fx, reply_to: target.id)

      assert conn.status == 201, conn.resp_body
      assert %{reply_to_id: reply_to} = Messages.get_message(fx.ch_id, sent_id(conn))
      assert reply_to == target.id
    end

    test "a refused reference claims no send key: the same nonce then sends", fx do
      nonce = unique("ref")
      elsewhere = seed_message!(fx, %{thread_id: fx.other_thread.thread_id})

      refused = send_on(:compat_thread, fx, content: "k", nonce: nonce, reply_to: elsewhere.id)
      assert validation_failure?(refused)

      assert send_on(:compat_thread, fx, content: "k", nonce: nonce).status == 201
    end
  end

  # -- gap 1: a thread reply is one thing on every route ------------------------------

  describe "a thread reply's side effects (every route that posts one)" do
    for route <- @thread_routes do
      test "#{route}: dual emission, auto-follow, reply counters, thread wire", fx do
        log =
          capture_log(fn ->
            conn = send_on(unquote(route), fx, content: "a reply")
            assert conn.status == 201, conn.resp_body
            send(self(), {:sent, sent_id(conn)})
          end)

        assert_received {:sent, id}
        assert log =~ "event=MessageCreate"
        assert log =~ "event=ThreadMessageCreate"

        thread = Thread.get(fx.thread.thread_id)
        assert thread.message_count == 1
        assert Cytale.Threads.Member.get(fx.thread.thread_id, fx.bot_id)
        assert %{thread_id: thread_id} = Messages.get_message(fx.ch_id, id)
        assert thread_id == fx.thread.thread_id
      end
    end

    test "native_channel_thread_id: the thread must belong to the path channel", fx do
      {:ok, elsewhere} = Workspaces.create_channel(fx.ws_id, "elsewhere")
      foreign = seed_thread!(elsewhere.channel_id, fx.owner.user_id)

      conn = send_on(:native_channel_thread_id, fx, content: "smuggled", thread_id: foreign.thread_id)

      assert conn.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
      assert Thread.get(foreign.thread_id).message_count == 0
    end

    test "native_channel_thread_id: a retry replays; the key is shared with the reply route", fx do
      nonce = unique("tk")

      first = send_on(:native_channel_thread_id, fx, content: "once", nonce: nonce)
      assert first.status == 201
      # The native reply route is the same kind of message: a retry there is
      # the SAME send, not a cross-use conflict.
      retry = send_on(:native_thread, fx, content: "once", nonce: nonce)
      assert retry.status == 200
      assert sent_id(retry) == sent_id(first)
      assert Thread.get(fx.thread.thread_id).message_count == 1
    end
  end

  # -- gap 4: a publish failure after the write lands ---------------------------------

  defmodule RaisingPublish do
    @moduledoc false
    @behaviour Cytale.Publish
    @impl true
    def publish(_channel_id, _event), do: raise("fan-out unavailable")
    @impl true
    def publish_user_update(_user_id, _event), do: :ok
  end

  describe "a publish that raises after the write landed" do
    setup do
      previous = Application.get_env(:cytale, Cytale.Publish)
      Application.put_env(:cytale, Cytale.Publish, RaisingPublish)
      on_exit(fn -> Application.put_env(:cytale, Cytale.Publish, previous) end)
      :ok
    end

    for route <- @routes ++ [:native_channel_thread_id] do
      test "#{route}: answers success with the stored message, counts it, and a retry does not duplicate", fx do
        nonce = unique("pf")
        before = Cytale.Telemetry.DeliveryCounters.snapshot()["publish_failed"]

        log =
          capture_log(fn ->
            first = send_on(unquote(route), fx, content: "stored anyway", nonce: nonce)
            assert first.status == 201, first.resp_body
            retry = send_on(unquote(route), fx, content: "stored anyway", nonce: nonce)
            assert retry.status == 200, retry.resp_body
            assert sent_id(retry) == sent_id(first)
            send(self(), {:sent, sent_id(first)})
          end)

        assert log =~ "stored but its publish failed"
        assert_received {:sent, id}
        assert %{content: "stored anyway"} = Messages.get_message(fx.ch_id, id)
        # One failure — the first attempt's; the retry is a replay and
        # dispatches nothing.
        assert Cytale.Telemetry.DeliveryCounters.snapshot()["publish_failed"] == before + 1

        # The thread state still moved (once): the fan-out outage costs the
        # live dispatch, not the reply count or the author's follow.
        if thread_route?(unquote(route)) do
          assert Thread.get(fx.thread.thread_id).message_count == 1
          assert Cytale.Threads.Member.get(fx.thread.thread_id, fx.bot_id)
        end
      end
    end
  end

  # -- gap 8: one answer for a reused send key -----------------------------------------

  describe "a reused send key (one mechanism, one answer, every route)" do
    for route <- @routes ++ [:native_channel_thread_id] do
      test "#{route}: an exact retry replays; different content, reply or files conflict", fx do
        nonce = unique("kr")
        target = same_conversation_message!(unquote(route), fx)
        base = [content: "original", nonce: nonce]

        first = send_on(unquote(route), fx, base)
        assert first.status == 201, first.resp_body
        id = sent_id(first)

        # The same request again: the original, 200.
        again = send_on(unquote(route), fx, base)
        assert again.status == 200
        assert sent_id(again) == id

        # The same key on a different message: a conflict, never the original.
        assert nonce_conflict?(unquote(route), send_on(unquote(route), fx, Keyword.put(base, :content, "edited")))
        assert nonce_conflict?(unquote(route), send_on(unquote(route), fx, Keyword.put(base, :reply_to, target.id)))

        files = [%{"url" => "https://files.example.com/a.png", "filename" => "a.png"}]
        assert nonce_conflict?(unquote(route), send_on(unquote(route), fx, Keyword.put(base, :attachments, files)))

        # Nothing else was written under the key.
        assert %{content: "original"} = Messages.get_message(fx.ch_id, id)
      end

      test "#{route}: the Idempotency-Key header is the same key, answered the same way", fx do
        key = unique("hk")

        first = send_on(unquote(route), fx, content: "keyed", idempotency_key: key)
        assert first.status == 201

        retry = send_on(unquote(route), fx, content: "keyed", idempotency_key: key)
        assert retry.status == 200
        assert sent_id(retry) == sent_id(first)
        assert get_resp_header(retry, "idempotency-replayed") == []

        assert nonce_conflict?(unquote(route), send_on(unquote(route), fx, content: "other", idempotency_key: key))
      end
    end

    # The web client's retry: the body nonce AND the same Idempotency-Key, the
    # same content, reply reference and uploaded files — whose URLs carry a
    # fresh signature on the retry. It must replay, not conflict.
    for route <- [:native_channel, :native_thread] do
      test "#{route}: the web client's retry (nonce + header, re-signed file URL) replays", fx do
        nonce = unique("web")
        target = same_conversation_message!(unquote(route), fx)
        hash = String.duplicate("ab", 32)
        file = fn sig -> %{"url" => "/api/v1/attachments/#{hash}?e=1&s=#{sig}", "filename" => "p.png", "size" => 3} end

        post_once = fn sig ->
          send_on(unquote(route), fx,
            auth: fx.owner_auth,
            content: "from the web",
            nonce: nonce,
            idempotency_key: nonce,
            reply_to: target.id,
            attachments: [file.(sig)]
          )
        end

        first = post_once.("one")
        assert first.status == 201, first.resp_body
        retry = post_once.("two")
        assert retry.status == 200, retry.resp_body
        assert sent_id(retry) == sent_id(first)
        assert %{"nonce" => ^nonce} = Jason.decode!(retry.resp_body)["message"]
      end
    end
  end

  # -- gap 5: embeds (and action rows) on every route --------------------------------

  describe "a bot's embeds and action rows (one parser, every route)" do
    for route <- @routes ++ [:native_channel_thread_id] do
      test "#{route}: embeds are accepted, stored and rendered", fx do
        embeds = [%{"title" => "Build green", "description" => "all checks passed", "color" => 3_066_993}]
        conn = send_on(unquote(route), fx, content: "card", embeds: embeds)

        assert conn.status == 201, conn.resp_body
        assert %{embeds: ^embeds} = Messages.get_message(fx.ch_id, sent_id(conn))
      end

      test "#{route}: an embed-only message persists empty content", fx do
        conn = send_on(unquote(route), fx, content: nil, embeds: [%{"title" => "Embed only"}])

        assert conn.status == 201, conn.resp_body
        assert %{content: "", embeds: [%{"title" => "Embed only"}]} = Messages.get_message(fx.ch_id, sent_id(conn))
      end

      test "#{route}: embeds over the shared caps are refused", fx do
        too_many = Enum.map(1..11, &%{"title" => "e#{&1}"})
        conn = send_on(unquote(route), fx, content: "eleven", embeds: too_many)

        assert conn.status == 400
        assert invalid_embeds?(conn), conn.resp_body
      end

      test "#{route}: action rows are accepted from a bot", fx do
        rows = [
          %{"type" => 1, "components" => [%{"type" => 2, "style" => 1, "label" => "Go", "custom_id" => "go"}]}
        ]

        conn = send_on(unquote(route), fx, content: "buttons", components: rows)

        assert conn.status == 201, conn.resp_body
        assert %{components: ^rows} = Messages.get_message(fx.ch_id, sent_id(conn))
      end
    end
  end

  describe "a person's embeds (refused in one place, loudly)" do
    for route <- [:native_channel, :native_thread, :native_channel_thread_id] do
      test "#{route}: 400 embeds_not_allowed, nothing stored", fx do
        count_before = Thread.get(fx.thread.thread_id).message_count

        conn =
          send_on(unquote(route), fx,
            auth: fx.owner_auth,
            content: "my card",
            embeds: [%{"title" => "Totally the real login page"}]
          )

        assert conn.status == 400
        assert %{"error" => %{"key" => "embeds_not_allowed"}} = Jason.decode!(conn.resp_body)
        refute Enum.any?(Messages.history(fx.ch_id, limit: 20), &(&1.content == "my card"))
        assert Thread.get(fx.thread.thread_id).message_count == count_before
      end
    end

    test "an empty embeds list from a person is no embeds, not a refusal", fx do
      conn = send_on(:native_channel, fx, auth: fx.owner_auth, content: "plain", embeds: [])
      assert conn.status == 201
    end
  end

  # -- gap 2: allowed_mentions, for every sender ---------------------------------------

  defp add_member!(fx) do
    {:ok, member} = User.create(unique("par_m"), unique("par_m@example.com"), "password-123")
    :ok = Workspaces.add_member(fx.ws_id, member.user_id, fx.owner.user_id)
    member
  end

  # The kinds of inbox row `user_id` holds for message `id`.
  defp inbox_kinds(user_id, id) do
    {items, _} = Cytale.Inbox.list_for_user(user_id)
    for item <- items, to_string(item["message_id"]) == Integer.to_string(id), do: item["kind"]
  end

  describe "allowed_mentions narrows who a message notifies (every route)" do
    for route <- @routes ++ [:native_channel_thread_id] do
      test "#{route}: parse [] suppresses a user mention; a listed user still gets it", fx do
        member = add_member!(fx)
        content = "<@#{member.user_id}> please review"

        quiet = send_on(unquote(route), fx, content: content, allowed_mentions: %{"parse" => []})
        assert quiet.status == 201, quiet.resp_body
        assert inbox_kinds(member.user_id, sent_id(quiet)) == []

        listed =
          send_on(unquote(route), fx,
            content: content,
            allowed_mentions: %{"parse" => [], "users" => [Integer.to_string(member.user_id)]}
          )

        assert listed.status == 201
        assert inbox_kinds(member.user_id, sent_id(listed)) == ["mention"]

        # Absent: the default, every mention notifies — as before.
        default = send_on(unquote(route), fx, content: content)
        assert inbox_kinds(member.user_id, sent_id(default)) == ["mention"]
      end

      test "#{route}: a malformed allowed_mentions is a validation failure", fx do
        conn = send_on(unquote(route), fx, content: "x", allowed_mentions: %{"parse" => "everyone"})
        assert conn.status == 400
        assert validation_failure?(conn), conn.resp_body
      end
    end

    for route <- [:native_channel, :native_thread] do
      test "#{route}: the create's wire names the users it may notify", fx do
        member = add_member!(fx)

        conn =
          send_on(unquote(route), fx,
            content: "<@#{member.user_id}> hi",
            allowed_mentions: %{"parse" => ["users"]}
          )

        member_id = Integer.to_string(member.user_id)
        assert %{"mention_user_ids" => [^member_id]} = Jason.decode!(conn.resp_body)["message"]

        plain = send_on(unquote(route), fx, content: "<@#{member.user_id}> hi")
        refute Map.has_key?(Jason.decode!(plain.resp_body)["message"], "mention_user_ids")
      end
    end
  end

  # @everyone: the permission gate (e8765002) AND the sender's allowed_mentions.
  # A bot never holds `mention_everyone` (no grant level confers it —
  # `Cytale.Access.never/0`), so the sender that HOLDS the bit here is the
  # workspace owner, a person, on the native routes, and a webhook its owner
  # created; the bot rows prove allowed_mentions cannot WIDEN the gate.
  describe "allowed_mentions and @everyone" do
    for route <- [:native_channel, :native_thread, :native_channel_thread_id] do
      test "#{route}: a sender holding mention_everyone is silenced by parse without everyone", fx do
        member = add_member!(fx)

        quiet =
          send_on(unquote(route), fx,
            auth: fx.owner_auth,
            content: "@everyone deploy at 5",
            allowed_mentions: %{"parse" => ["users"]}
          )

        assert quiet.status == 201, quiet.resp_body
        assert %{"mention_everyone" => false} = Jason.decode!(quiet.resp_body)["message"]
        assert inbox_kinds(member.user_id, sent_id(quiet)) == []

        loud = send_on(unquote(route), fx, auth: fx.owner_auth, content: "@everyone deploy at 5")
        assert %{"mention_everyone" => true} = Jason.decode!(loud.resp_body)["message"]
        assert inbox_kinds(member.user_id, sent_id(loud)) == ["broadcast"]
      end
    end

    for route <- @routes do
      test "#{route}: a bot's parse everyone does not widen the permission gate", fx do
        member = add_member!(fx)

        conn =
          send_on(unquote(route), fx,
            content: "@everyone from a bot",
            allowed_mentions: %{"parse" => ["everyone"]}
          )

        assert conn.status == 201
        assert inbox_kinds(member.user_id, sent_id(conn)) == []
      end
    end

    test "webhook execute: the same allowed_mentions semantics (its creator holds the bit)", fx do
      member = add_member!(fx)
      {:ok, hook} = Cytale.Webhooks.create_webhook(fx.ch_id, "Deploys", fx.owner.user_id)

      {:ok, quiet} =
        Cytale.Webhooks.execute(hook.id, hook.token, %{
          "content" => "@everyone and <@#{member.user_id}>",
          "allowed_mentions" => %{"parse" => []}
        })

      assert quiet.mention_everyone == false
      assert inbox_kinds(member.user_id, quiet.id) == []

      {:ok, loud} = Cytale.Webhooks.execute(hook.id, hook.token, %{"content" => "@everyone ship it"})
      assert loud.mention_everyone == true
      assert inbox_kinds(member.user_id, loud.id) == ["broadcast"]

      assert {:error, :invalid_body} =
               Cytale.Webhooks.execute(hook.id, hook.token, %{"content" => "x", "allowed_mentions" => "none"})
    end
  end

  # -- gap 6: one send budget -----------------------------------------------------------

  # The native dialect's 429: the standard envelope + Retry-After.
  defp native_429?(conn) do
    conn.status == 429 and get_resp_header(conn, "retry-after") != [] and
      match?(%{"error" => %{"key" => "rate_limited", "code" => 42_901}}, Jason.decode!(conn.resp_body))
  end

  # The compat dialect's 429: Discord's body, Retry-After, the scope header.
  defp compat_429?(conn) do
    body = Jason.decode!(conn.resp_body)

    conn.status == 429 and get_resp_header(conn, "retry-after") != [] and
      get_resp_header(conn, "x-ratelimit-scope") == ["user"] and
      get_resp_header(conn, "x-ratelimit-bucket") != [] and
      match?(%{"code" => 0, "global" => false}, body) and is_float(body["retry_after"])
  end

  # Exactly Discord's 429 body — no native field leaks onto the compat surface.
  defp discord_shaped?(conn),
    do: conn.resp_body |> Jason.decode!() |> Map.keys() |> Enum.sort() == ["code", "global", "message", "retry_after"]

  defp limited?(route, conn) when route in [:compat_channel, :compat_thread], do: compat_429?(conn)
  defp limited?(_route, conn), do: native_429?(conn)

  describe "the send budget (one per sender, every route, both dialects)" do
    setup do
      previous = Application.get_env(:cytale, :send_budget)
      Application.put_env(:cytale, :send_budget, conversation: {3, 5_000}, principal: {5, 5_000})
      on_exit(fn -> Application.put_env(:cytale, :send_budget, previous) end)
      :ok
    end

    for route <- @routes do
      test "#{route}: the per-conversation budget trips on the 4th send, in the route's dialect", fx do
        for n <- 1..3 do
          conn = send_on(unquote(route), fx, content: "burst #{n}")
          assert conn.status == 201, conn.resp_body
          assert get_resp_header(conn, "x-ratelimit-limit") == ["3"]
          assert get_resp_header(conn, "x-ratelimit-remaining") == [Integer.to_string(3 - n)]
        end

        tripped = send_on(unquote(route), fx, content: "burst 4")
        assert limited?(unquote(route), tripped), "#{tripped.status} #{tripped.resp_body}"
        refute Enum.any?(Messages.history(fx.ch_id, limit: 20), &(&1.content == "burst 4"))
      end
    end

    test "native and compat share ONE conversation budget (the same counter)", fx do
      assert send_on(:native_channel, fx, content: "n1").status == 201
      assert send_on(:compat_channel, fx, content: "c1").status == 201
      assert send_on(:native_channel, fx, content: "n2").status == 201

      assert compat_429?(send_on(:compat_channel, fx, content: "c2"))
      assert native_429?(send_on(:native_channel, fx, content: "n3"))
    end

    test "the per-sender budget spans conversations and dialects", fx do
      # 3 into the channel + 2 into the thread = the sender's 5.
      for n <- 1..3, do: assert(send_on(:compat_channel, fx, content: "ch #{n}").status == 201)
      for n <- 1..2, do: assert(send_on(:native_thread, fx, content: "th #{n}").status == 201)

      # The thread's own conversation budget has room; the sender's does not.
      tripped = send_on(:compat_thread, fx, content: "th 3")
      assert compat_429?(tripped)
      assert Jason.decode!(tripped.resp_body)["message"] =~ "across all conversations"
    end

    test "a person has the same budget as a bot", fx do
      for n <- 1..3 do
        assert send_on(:native_channel, fx, auth: fx.owner_auth, content: "p#{n}").status == 201
      end

      assert native_429?(send_on(:native_channel, fx, auth: fx.owner_auth, content: "p4"))
      # ...and it is the person's own: the bot's budget in the same channel
      # is untouched.
      assert send_on(:native_channel, fx, content: "bot").status == 201
    end

    # WHICH limit tripped is data in both dialects (the web client holds one
    # conversation or every one by it; Discord clients key queues by bucket).
    test "native: each limit's 429 names its scope in the body and X-RateLimit-Scope", fx do
      for n <- 1..3, do: assert(send_on(:native_channel, fx, content: "c#{n}").status == 201)
      conversation = send_on(:native_channel, fx, content: "c4")
      assert native_429?(conversation)
      assert get_resp_header(conversation, "x-ratelimit-scope") == ["conversation"]
      assert %{"error" => %{"scope" => "conversation", "retry_after_ms" => ms}} = Jason.decode!(conversation.resp_body)
      assert is_integer(ms) and ms >= 1 and ms <= 5_000

      # Two more into the thread spend the sender's 5 (the tripped send above
      # was refused before the sender bucket was consulted); the thread's own
      # conversation budget still has room.
      for n <- 1..2, do: assert(send_on(:native_thread, fx, content: "t#{n}").status == 201)
      sender = send_on(:native_thread, fx, content: "t3")
      assert native_429?(sender)
      assert get_resp_header(sender, "x-ratelimit-scope") == ["sender"]
      assert %{"error" => %{"scope" => "sender", "retry_after_ms" => ms}} = Jason.decode!(sender.resp_body)
      assert is_integer(ms) and ms >= 1 and ms <= 5_000
      assert Jason.decode!(sender.resp_body)["error"]["message"] =~ "across all conversations"
    end

    test "compat: the bucket id names the limit; scope stays Discord's `user`; the body stays Discord's", fx do
      conversation_bucket = CytaleWeb.Compat.RateLimit.bucket("send:send_conversation")
      sender_bucket = CytaleWeb.Compat.RateLimit.bucket("send:send_principal")
      assert conversation_bucket != sender_bucket

      for n <- 1..3, do: assert(send_on(:compat_channel, fx, content: "c#{n}").status == 201)
      conversation = send_on(:compat_channel, fx, content: "c4")
      assert compat_429?(conversation)
      assert get_resp_header(conversation, "x-ratelimit-bucket") == [conversation_bucket]
      assert get_resp_header(conversation, "x-ratelimit-scope") == ["user"]
      assert discord_shaped?(conversation)

      # The same conversation and sender trip it again under the same id.
      again = send_on(:compat_channel, fx, content: "c5")
      assert get_resp_header(again, "x-ratelimit-bucket") == [conversation_bucket]

      for n <- 1..2, do: assert(send_on(:compat_thread, fx, content: "t#{n}").status == 201)
      sender = send_on(:compat_thread, fx, content: "t3")
      assert compat_429?(sender)
      assert get_resp_header(sender, "x-ratelimit-bucket") == [sender_bucket]
      assert get_resp_header(sender, "x-ratelimit-scope") == ["user"]
      assert discord_shaped?(sender)
    end

    test "non-send budgets are unchanged", fx do
      for _ <- 1..4, do: send_on(:compat_channel, fx, content: "fill")

      read =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("authorization", fx.bot_auth)
        |> get("/api/v10/channels/#{fx.ch_id}/messages")

      assert read.status == 200
      assert get_resp_header(read, "x-ratelimit-limit") == ["50"]

      typing =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("authorization", fx.bot_auth)
        |> post("/api/v10/channels/#{fx.ch_id}/typing")

      assert typing.status == 204
      assert get_resp_header(typing, "x-ratelimit-limit") == ["25"]
    end
  end
end
