defmodule CytaleWeb.Controllers.MessageControllerTest do
  @moduledoc """
  U9 — message surface integration tests (the plan's core chain):
  workspace → channel → send → cursor-paginated history (newest-first),
  Idempotency-Key replay, account_unverified choke point, permission denial,
  and the Publish fan-out seam (capture_log on Cytale.Publish.Log).
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Permissions.Bitfield

  @endpoint CytaleWeb.Endpoint

  # Runtime (NOT compile-time) nonce: a module attribute freezes at compile
  # time and collides across `mix test` invocations (observed).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, user} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    {:ok, conn: conn, user: user, ws_id: ws_id, ch_id: ch_id}
  end

  describe "send → history (the plan's happy path)" do
    test "send 3 messages → history newest-first → before-cursor page", %{conn: conn, ch_id: ch_id} do
      ids =
        for i <- 1..3 do
          conn =
            post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "msg #{i}"})

          assert conn.status == 201
          body = Jason.decode!(conn.resp_body)
          assert body["message"]["content"] == "msg #{i}"
          body["message"]["id"]
        end

      # Newest-first history
      conn = get(conn, "/api/v1/channels/#{ch_id}/messages")
      assert conn.status == 200
      %{"messages" => msgs, "oldest_id" => oldest} = Jason.decode!(conn.resp_body)
      got = Enum.map(msgs, & &1["id"])
      assert got == Enum.reverse(ids)
      # oldest_id = the OLDEST message in the page = first-sent id.
      assert oldest == List.first(ids)

      # Cursor page: strictly older than the second-newest.
      cursor = Enum.at(ids, 1)
      conn = get(conn, "/api/v1/channels/#{ch_id}/messages?before=#{cursor}")
      assert conn.status == 200
      %{"messages" => older} = Jason.decode!(conn.resp_body)
      assert Enum.map(older, & &1["id"]) == [List.first(ids)]
    end

    test "empty content → 400; unknown channel → 404", %{conn: conn, ch_id: ch_id} do
      conn = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => ""})
      assert conn.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)

      conn = post(conn, "/api/v1/channels/123456789012345678/messages", %{"content" => "x"})
      assert conn.status == 404
      assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn.resp_body)
    end

    test "send publishes through the Cytale.Publish seam (fan-out invoked)", %{conn: conn, ch_id: ch_id} do
      log =
        capture_log(fn ->
          conn = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "fanout probe"})
          assert conn.status == 201
        end)

      assert log =~ "[publish]"
      assert log =~ "MessageCreate"
      assert log =~ "fanout probe"
    end
  end

  describe "call-log thread visibility (R5)" do
    test "call-log rows: hidden on the channel timeline, returned by the thread read", %{
      conn: conn,
      ch_id: ch_id,
      user: user
    } do
      ch = String.to_integer(ch_id)
      {:ok, thread_id} = Cytale.Calls.Log.ensure_thread(ch, user.user_id)

      conn = post(conn, "/api/v1/channels/#{ch}/messages", %{"content" => "timeline msg"})
      assert conn.status == 201

      {:ok, _log_wire} =
        Cytale.Messages.Message.send_message(%{
          channel_id: ch,
          author_id: user.user_id,
          content: "call-log entry",
          thread_id: thread_id
        })

      # The CHANNEL timeline excludes the call-log row.
      conn = get(conn, "/api/v1/channels/#{ch}/messages")
      assert conn.status == 200
      %{"messages" => channel_msgs} = Jason.decode!(conn.resp_body)
      assert Enum.map(channel_msgs, & &1["content"]) == ["timeline msg"]

      # The THREAD's own history returns it (the exclusion is a
      # channel-timeline rule, not a thread-read rule).
      conn = get(conn, "/api/v1/threads/#{thread_id}/messages")
      assert conn.status == 200
      %{"messages" => thread_msgs} = Jason.decode!(conn.resp_body)
      assert Enum.map(thread_msgs, & &1["content"]) == ["call-log entry"]
    end
  end

  describe "idempotency" do
    # One mechanism for sends: the pipeline's durable dedupe reads the header
    # (the in-memory replay steps aside for send routes), so a retry is the
    # ORIGINAL message with a 200 — nothing was created by it.
    test "same Idempotency-Key replay returns the ORIGINAL message, not a duplicate", %{
      conn: conn,
      ch_id: ch_id
    } do
      key = run_unique("idem-")

      conn1 =
        conn
        |> put_req_header("idempotency-key", key)
        |> post("/api/v1/channels/#{ch_id}/messages", %{"content" => "exactly once"})

      assert conn1.status == 201
      body1 = conn1.resp_body

      conn2 =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", get_req_header(conn1, "authorization") |> hd())
        |> put_req_header("idempotency-key", key)
        |> post("/api/v1/channels/#{ch_id}/messages", %{"content" => "exactly once"})

      assert conn2.status == 200
      assert get_resp_header(conn2, "idempotency-replayed") == []
      assert Jason.decode!(conn2.resp_body)["message"]["id"] == Jason.decode!(body1)["message"]["id"]

      # Same key + DIFFERENT body → 409 idempotency_conflict.
      conn3 =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", get_req_header(conn1, "authorization") |> hd())
        |> put_req_header("idempotency-key", key)
        |> post("/api/v1/channels/#{ch_id}/messages", %{"content" => "different body"})

      assert conn3.status == 409
      assert %{"error" => %{"key" => "idempotency_conflict"}} = Jason.decode!(conn3.resp_body)

      # And only ONE message exists.
      conn = get(conn, "/api/v1/channels/#{ch_id}/messages")
      %{"messages" => msgs} = Jason.decode!(conn.resp_body)
      assert Enum.count(msgs, &(&1["content"] == "exactly once")) == 1
    end
  end

  # ---------------------------------------------------------------------------
  # Components (components plan U1: R1 native-ignore + R2 read join)
  # ---------------------------------------------------------------------------

  describe "components (components plan U1)" do
    test "native create with components → dropped silently (key absent from stored read, no error)", %{
      conn: conn,
      ch_id: ch_id
    } do
      conn =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "human message",
          "components" => [
            %{
              "type" => 1,
              "components" => [%{"type" => 2, "style" => 1, "label" => "B", "custom_id" => "b"}]
            }
          ]
        })

      # R1: the native human create IGNORES the key entirely — 201, no error,
      # nothing stored ("components ⇒ machine author" holds by construction).
      assert conn.status == 201
      body = Jason.decode!(conn.resp_body)
      refute Map.has_key?(body["message"], "components")

      conn = get(conn, "/api/v1/channels/#{ch_id}/messages")
      %{"messages" => msgs} = Jason.decode!(conn.resp_body)
      assert [%{"content" => "human message"} = only] = msgs
      refute Map.has_key?(only, "components")

      # The data layer proves nothing was stored (not just projected away).
      channel_id = String.to_integer(ch_id)
      assert [%{components: []}] = Cytale.Messages.history(channel_id, limit: 1)
    end

    test "stored components (bot-authored) ride the native history + single-message projections", %{
      conn: conn,
      ch_id: ch_id
    } do
      # Seed through the data layer exactly as the compat bot surface does.
      components = [
        %{
          "type" => 1,
          "components" => [
            %{"type" => 2, "style" => 1, "label" => "Approve", "custom_id" => "approve"},
            %{"type" => 2, "style" => 5, "label" => "Docs", "url" => "https://docs.example.com/x"}
          ]
        }
      ]

      {:ok, msg} =
        Cytale.Messages.create_message(%{
          channel_id: String.to_integer(ch_id),
          author_id: Cytale.Snowflake.next(),
          content: "seeded card",
          thread_id: nil,
          components: components
        })

      conn = get(conn, "/api/v1/channels/#{ch_id}/messages")
      %{"messages" => msgs} = Jason.decode!(conn.resp_body)
      assert [%{"components" => ^components}] = msgs

      # The single-message read path (get_message — the same join `show`
      # and the reply-reference snapshot render through).
      assert %{} = stored = Cytale.Messages.get_message(String.to_integer(ch_id), msg.id)
      assert stored.components == components
    end
  end

  describe "the view-only gate (account_unverified)" do
    test "unverified account: reads OK, content-producing POST → 403 account_unverified", %{
      conn: conn
    } do
      # A fresh UNVERIFIED account.
      username = "unv#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
      {:ok, _user} = User.create(username, "#{username}@example.com", "password-123")

      access =
        Auth.issue_access_token(
          Cytale.Accounts.User.get_by_identifier(username).user_id,
          username,
          false
        )

      unverified =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> access)

      # Workspace create is behind the verified choke point now (S-P2-13: an
      # unverified account must not mint itself an owner role) — the gate
      # answers account_unverified before anything else.
      conn_ws = post(unverified, "/api/v1/workspaces", %{"name" => run_unique("sandbox")})
      assert conn_ws.status == 403
      assert %{"error" => %{"key" => "account_unverified"}} = Jason.decode!(conn_ws.resp_body)

      # Verification is the FIRST gate (before any membership/permission
      # resolution), so a channel POST into an id the account could not
      # possibly reach still answers account_unverified — the same contract
      # as before, without the self-owned sandbox.
      arbitrary_snowflake = 906_000_000_000_000_00 + System.unique_integer([:positive])

      conn_ch =
        post(unverified, "/api/v1/channels/#{arbitrary_snowflake}/messages", %{
          "content" => "blocked"
        })

      # Channel create IS a content-producing mutation → choke point.
      assert conn_ch.status == 403
      assert %{"error" => %{"key" => "account_unverified"}} = Jason.decode!(conn_ch.resp_body)

      # Reads stay open to unverified accounts (view-only).
      conn_list = get(unverified, "/api/v1/users/@me/workspaces")
      assert conn_list.status == 200
    end
  end

  describe "permission gate" do
    test "role-less member inherits @everyone view+send and CAN post", %{
      conn: owner_conn,
      ws_id: ws_id,
      ch_id: ch_id
    } do
      # Second user joins via an invite.
      invite_code = create_invite(owner_conn, ws_id)

      {conn2, _u2} = register_and_login(build_conn_with_headers())
      conn2 = post(conn2, "/api/v1/invites/#{invite_code}")
      assert conn2.status == 200

      # Invites carry no explicit roles; @everyone is the base (view + send —
      # a role-less member must not be mute-by-default, role creation is
      # admin-only and would never intersect). Denial needs an explicit
      # deny overwrite/role (not yet wired).
      conn2 = post(conn2, "/api/v1/channels/#{ch_id}/messages", %{"content" => "hello all"})
      assert conn2.status == 201
    end
  end

  describe "channel overwrites gate sending (the denial story)" do
    test "member deny overwrite → 403; delete the row → send works again", %{
      conn: owner_conn,
      ws_id: ws_id,
      ch_id: ch_id
    } do
      invite_code = create_invite(owner_conn, ws_id)

      {conn2, u2} = register_and_login(build_conn_with_headers())
      conn2 = post(conn2, "/api/v1/invites/#{invite_code}")
      assert conn2.status == 200

      # Baseline: the role-less member sends on the @everyone base.
      ok = post(conn2, "/api/v1/channels/#{ch_id}/messages", %{"content" => "before deny"})
      assert ok.status == 201

      # Owner denies send_messages for that member on this channel.
      put_conn =
        put(owner_conn, "/api/v1/channels/#{ch_id}/overwrites", %{
          "target_type" => "member",
          "target_id" => Integer.to_string(u2.user_id),
          "allow" => [],
          "deny" => ["send_messages"]
        })

      assert put_conn.status == 200

      # GET round-trips the row with permission names.
      get_conn = get(owner_conn, "/api/v1/channels/#{ch_id}/overwrites")
      rows = Jason.decode!(get_conn.resp_body)["overwrites"]
      row = Enum.find(rows, &(&1["target_id"] == Integer.to_string(u2.user_id)))
      assert row != nil
      assert row["deny"] == ["send_messages"] and row["allow"] == []
      assert row["target_type"] == "member"

      denied = post(conn2, "/api/v1/channels/#{ch_id}/messages", %{"content" => "muted"})
      assert denied.status == 403
      assert %{"error" => %{"key" => "forbidden"}} = Jason.decode!(denied.resp_body)

      # Deleting the row restores the base.
      del_conn = delete(owner_conn, "/api/v1/channels/#{ch_id}/overwrites/#{u2.user_id}")
      assert del_conn.status == 200

      restored = post(conn2, "/api/v1/channels/#{ch_id}/messages", %{"content" => "back"})
      assert restored.status == 201
    end
  end

  # Review #19: the gate's resolve is memoized per {user, channel} under the
  # workspace's RightsEpoch. These drive the mutations through the DATA LAYER
  # (not the controllers, which bumped some paths already), because the bump
  # now lives there — every caller of a rights write invalidates, not just the
  # routes that remembered to. Each step warms the memo first, so a stale
  # entry would be SERVED if invalidation failed.
  describe "permission memo invalidation (review #19)" do
    setup %{conn: owner_conn, ws_id: ws_id} do
      invite_code = create_invite(owner_conn, ws_id)
      {member, u2} = register_and_login(build_conn_with_headers())
      assert post(member, "/api/v1/invites/#{invite_code}").status == 200
      %{member: member, u2: u2}
    end

    test "an overwrite written and removed at the data layer flips the very next send",
         %{member: member, u2: u2, ch_id: ch_id} do
      assert send_status(member, ch_id, "warm") == 201
      assert send_status(member, ch_id, "warm again") == 201

      :ok = deny_send(ch_id, u2.user_id)
      assert send_status(member, ch_id, "denied") == 403

      :ok = Cytale.Workspaces.delete_overwrite(String.to_integer(ch_id), u2.user_id)
      assert send_status(member, ch_id, "restored") == 201
    end

    test "a role grant and revoke flip the very next send", %{member: member, u2: u2, ws_id: ws_id, ch_id: ch_id} do
      ws = String.to_integer(ws_id)
      {:ok, role} = Cytale.Workspaces.create_role(ws, run_unique("muted"))

      :ok =
        Cytale.Workspaces.put_overwrite(String.to_integer(ch_id), :role, role.role_id, 0, Bitfield.bit(:send_messages))

      # Not holding the role yet: still sends (and warms the memo).
      assert send_status(member, ch_id, "unmuted") == 201

      :ok = Cytale.Workspaces.grant_role(ws, u2.user_id, role.role_id)
      assert send_status(member, ch_id, "muted") == 403

      :ok = Cytale.Workspaces.revoke_role(ws, u2.user_id, role.role_id)
      assert send_status(member, ch_id, "unmuted again") == 201
    end

    test "a kick refuses the very next send", %{member: member, u2: u2, ws_id: ws_id, ch_id: ch_id} do
      assert send_status(member, ch_id, "before kick") == 201

      :ok = Cytale.Workspaces.remove_member(String.to_integer(ws_id), u2.user_id)
      # Not a member any more: the channel reads as not found (Tier 3 B, 11).
      assert send_status(member, ch_id, "after kick") == 404
    end

    test "a deleted channel stops accepting sends even with its route cached", %{conn: conn, ch_id: ch_id} do
      assert send_status(conn, ch_id, "route warm") == 201

      :ok = Cytale.Workspaces.delete_channel(String.to_integer(ch_id))
      assert send_status(conn, ch_id, "into the void") == 404
    end
  end

  # Review #24: the durable nonce reservation. The body `nonce` is what the web
  # client reuses on retry; no Idempotency-Key header is sent here, so the
  # in-memory replay plug is NOT what answers — this is the path that survives
  # a restart, a 5xx and a retry racing the first POST.
  describe "durable send dedupe (message_nonces)" do
    test "a retry with the same nonce answers 200 with the ORIGINAL message; nothing is duplicated",
         %{conn: conn, ch_id: ch_id} do
      nonce = "n-" <> run_nonce()
      body = %{"content" => "exactly once", "nonce" => nonce}

      first = post(conn, "/api/v1/channels/#{ch_id}/messages", body)
      assert first.status == 201
      %{"message" => %{"id" => id}} = Jason.decode!(first.resp_body)

      retry = post(conn, "/api/v1/channels/#{ch_id}/messages", body)
      assert retry.status == 200
      assert %{"message" => %{"id" => ^id, "content" => "exactly once"}} = Jason.decode!(retry.resp_body)

      history = Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/messages").resp_body)["messages"]
      assert Enum.count(history, &(&1["content"] == "exactly once")) == 1
    end

    test "a reservation whose write never landed is RE-DRIVEN under the reserved id",
         %{conn: conn, user: user, ch_id: ch_id} do
      # The first attempt died between claiming the nonce and inserting the
      # row (the crash window the reservation must survive).
      nonce = "n-" <> run_nonce()
      reserved = Cytale.Snowflake.next()
      assert :claimed = Cytale.Messages.Nonces.claim(user.user_id, nonce, String.to_integer(ch_id), reserved)

      retry = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "recovered", "nonce" => nonce})
      assert retry.status == 201
      assert %{"message" => %{"id" => id}} = Jason.decode!(retry.resp_body)
      assert id == Integer.to_string(reserved)

      assert %{content: "recovered"} = Cytale.Messages.get_message(String.to_integer(ch_id), reserved)
    end

    test "the same nonce in another channel is a 409, not a cross-channel replay",
         %{conn: conn, ws_id: ws_id, ch_id: ch_id} do
      other = create_channel(conn, ws_id)
      nonce = "n-" <> run_nonce()

      assert post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "here", "nonce" => nonce}).status == 201

      clash = post(conn, "/api/v1/channels/#{other}/messages", %{"content" => "there", "nonce" => nonce})
      assert clash.status == 409
      assert %{"error" => %{"key" => "idempotency_conflict"}} = Jason.decode!(clash.resp_body)
    end

    test "the POST's latency lands on the metrics surface (review #23)", %{conn: conn, ch_id: ch_id} do
      before = Cytale.Telemetry.Stats.snapshot().message_post_ms.count

      assert post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "timed send"}).status == 201

      assert Cytale.Telemetry.Stats.snapshot().message_post_ms.count > before
      assert CytaleWeb.MetricsController.exposition() =~ ~s(cytale_message_post_ms{stat="samples"})
      assert CytaleWeb.MetricsController.exposition() =~ ~s(cytale_message_deliver_ms{stat="samples"})
      assert CytaleWeb.MetricsController.exposition() =~ ~s(cytale_delivery_events_total{event="publish_failed"})
    end

    test "a publish that raises AFTER the write is still a 201 (never a retry-inviting 500)",
         %{conn: conn, ch_id: ch_id} do
      previous = Application.get_env(:cytale, Cytale.Publish)
      Application.put_env(:cytale, Cytale.Publish, CytaleWeb.Controllers.MessageControllerTest.RaisingPublish)
      on_exit(fn -> Application.put_env(:cytale, Cytale.Publish, previous) end)

      before = Cytale.Telemetry.DeliveryCounters.snapshot()["publish_failed"]

      capture_log(fn ->
        sent = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "stored anyway"})
        assert sent.status == 201
        %{"message" => %{"id" => id}} = Jason.decode!(sent.resp_body)
        assert Cytale.Messages.get_message(String.to_integer(ch_id), String.to_integer(id))
      end)

      assert Cytale.Telemetry.DeliveryCounters.snapshot()["publish_failed"] == before + 1
    end
  end

  describe "inline replies (Discord message_reference)" do
    test "reply echoes reply_to_id and embeds the referenced snapshot", %{conn: conn, ch_id: ch_id} do
      orig = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "the original message"})
      orig_id = Jason.decode!(orig.resp_body)["message"]["id"]

      reply =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "a reply",
          "reply_to_id" => orig_id
        })

      assert reply.status == 201
      body = Jason.decode!(reply.resp_body)["message"]
      assert body["reply_to_id"] == orig_id
      assert body["referenced"]["message_id"] == orig_id
      assert body["referenced"]["content"] == "the original message"
      assert is_binary(body["referenced"]["author_username"])
    end

    test "dangling reference is a validation failure, not a 404 oracle", %{conn: conn, ch_id: ch_id} do
      reply =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "reply to nothing",
          "reply_to_id" => "123456789012345678"
        })

      assert reply.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(reply.resp_body)
    end
  end

  describe "attachments (upload-first metadata)" do
    test "create accepts attachment descriptors and echoes them in the message JSON", %{
      conn: conn,
      ch_id: ch_id
    } do
      conn =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "with a file",
          "attachments" => [
            %{
              "url" => "/api/v1/attachments/abc123",
              "filename" => "cat.png",
              "content_type" => "image/png",
              "size" => 2048
            }
          ]
        })

      assert conn.status == 201

      %{"message" => %{"attachments" => [att]}} = Jason.decode!(conn.resp_body)
      assert att["url"] == "/api/v1/attachments/abc123"
      assert att["filename"] == "cat.png"
      assert att["content_type"] == "image/png"
      # Persistence stringifies every value; the native wire types the
      # numeric descriptor fields back as integers (the domain contract).
      assert att["size"] == 2048
      # A non-image descriptor carries no dimensions — absent, never null.
      refute Map.has_key?(att, "width")
      refute Map.has_key?(att, "height")
    end

    test "sniffed image dimensions ride the message wire as integers", %{conn: conn, ch_id: ch_id} do
      sent =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "a photo",
          "attachments" => [
            %{
              "url" => "/api/v1/attachments/img1",
              "filename" => "photo.png",
              "content_type" => "image/png",
              "size" => 4096,
              "width" => 640,
              "height" => 480
            }
          ]
        })

      assert sent.status == 201
      %{"message" => %{"id" => id, "attachments" => [att]}} = Jason.decode!(sent.resp_body)
      assert %{"width" => 640, "height" => 480, "size" => 4096} = att

      # …and the history read (a stored row, all values text) renders the same.
      history = get(conn, "/api/v1/channels/#{ch_id}/messages")
      %{"messages" => messages} = Jason.decode!(history.resp_body)
      stored = Enum.find(messages, &(&1["id"] == id))
      assert %{"width" => 640, "height" => 480, "size" => 4096} = hd(stored["attachments"])
    end

    test "a non-scalar attachment value is a 400, never a 500", %{conn: conn, ch_id: ch_id} do
      conn =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "bad shape",
          "attachments" => [%{"url" => %{"nested" => "map"}}]
        })

      assert conn.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
    end

    # #136: a fieldless entry ({} — or a map none of whose keys are descriptor
    # fields) passed the all-scalar check vacuously and stored the empty-map
    # stub every reader then rendered as a phantom attachment. A descriptor
    # with no usable field is a 400; nothing is stored.
    test "a fieldless or unknown-keyed attachment entry is a 400, no stub stored", %{
      conn: conn,
      ch_id: ch_id
    } do
      for attachments <- [[%{}], [%{"x" => 1}]] do
        conn =
          post(conn, "/api/v1/channels/#{ch_id}/messages", %{
            "content" => "no phantom attachments",
            "attachments" => attachments
          })

        assert conn.status == 400,
               "expected 400 for attachments=#{inspect(attachments)}, got #{conn.status}"

        assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn.resp_body)
      end

      # The rejection happened at the create gate: no message row — stub or
      # otherwise — was written for either body.
      history = get(conn, "/api/v1/channels/#{ch_id}/messages?limit=100")
      assert %{"messages" => messages} = Jason.decode!(history.resp_body)

      assert messages == [],
             "no stored message may carry an attachment stub, got: #{inspect(messages)}"
    end
  end

  # A7: the thread-reply wire carries author_id as a DECIMAL STRING like
  # every other id (events.md pins strings; the store's reconcile compares
  # strictly) — the REST echo here (message_json), the dual fan-out in
  # messages/message_test (to_wire).
  describe "thread reply wire ids" do
    test "a thread-scoped create echoes string author_id (and fans out the same shape)", %{
      conn: conn,
      user: user,
      ch_id: ch_id
    } do
      user_id = user.user_id
      channel_int = String.to_integer(ch_id)

      {:ok, root} =
        Cytale.Messages.create_message(%{channel_id: channel_int, author_id: user_id, content: "root"})

      {:ok, thread} = Cytale.Threads.Thread.create(channel_int, root.id, run_unique("a7-thread"), user_id)

      log =
        capture_log(fn ->
          reply =
            post(conn, "/api/v1/channels/#{ch_id}/messages", %{
              "content" => "thread reply",
              "thread_id" => Integer.to_string(thread.thread_id)
            })

          assert reply.status == 201

          echo = Jason.decode!(reply.resp_body)["message"]
          assert echo["author_id"] == Integer.to_string(user_id)
          assert echo["thread_id"] == Integer.to_string(thread.thread_id)
          assert echo["channel_id"] == ch_id
        end)

      assert log =~ "event=MessageCreate"
      assert log =~ "\"author_id\" => \"#{Integer.to_string(user_id)}\""
    end
  end

  defp drain_statements(ref, acc \\ []) do
    receive do
      {:stmt, ^ref, statement} -> drain_statements(ref, [statement | acc])
    after
      0 -> Enum.reverse(acc)
    end
  end

  describe "typing REST fallback" do
    test "typing returns ok and 404s for unknown channels", %{conn: conn, ch_id: ch_id} do
      conn_t = post(conn, "/api/v1/channels/#{ch_id}/typing", %{})
      assert conn_t.status == 200
      assert %{"ok" => true} = Jason.decode!(conn_t.resp_body)

      conn_404 = post(conn, "/api/v1/channels/123456789012345678/typing", %{})
      assert conn_404.status == 404
    end

    # Plan 5.2's gate: an ordinary channel's typing signal must not read
    # `dm_channels` at all. The route already gate-accepted a workspace channel, so
    # the fan-out is told the kind instead of asking the table — this is the
    # hottest fan-out there is (every keystroke in every channel), and it was
    # paying a partition read per signal to learn the channel is not a DM.
    test "a non-DM typing signal issues NO dm_channels read", %{conn: conn, ch_id: ch_id} do
      parent = self()
      ref = make_ref()
      handler_id = "typing-dm-read-#{System.unique_integer([:positive])}"

      :ok =
        :telemetry.attach(
          handler_id,
          [:xandra, :execute_query, :start],
          fn _event, _measurements, metadata, ^parent ->
            # Only this request's statements (the test process or a task it
            # spawned): the handler is global, so another process's query in the
            # window counted too (#174's sibling flake, "scaled with rows: 18 vs 16").
            if self() == parent or parent in Process.get(:"$callers", []) do
              send(parent, {:stmt, ref, metadata.query.statement})
            end
          end,
          parent
        )

      result = post(conn, "/api/v1/channels/#{ch_id}/typing", %{})
      Process.sleep(50)
      statements = drain_statements(ref)
      :ok = :telemetry.detach(handler_id)

      assert result.status == 200
      assert statements != [], "no statements captured — the capture is not measuring"

      refute Enum.any?(statements, &String.contains?(&1, ".dm_channels")),
             "the typing path read dm_channels: #{inspect(Enum.filter(statements, &String.contains?(&1, ".dm_channels")))}"
    end

    # A9: typing fans out through the SAME uniform channel gate the compat
    # surface uses — a channel the caller cannot view "does not exist" on
    # this route (the identical 404 anti-enumeration shape, never a 403
    # oracle).
    test "typing on an out-of-profile channel is the channel-shaped 404 (anti-enumeration)",
         %{conn: conn, user: user, ws_id: ws_id, ch_id: ch_id} do
      {:ok, other} = Cytale.Workspaces.create_channel(String.to_integer(ws_id), run_unique("typing-hidden"))

      {:ok, agent} =
        Cytale.Test.AgentGrants.mint_all(user.user_id, :agent, run_unique("Typing Scoped"), %{
          actions: ["read", "post"],
          channels: [ch_id]
        })

      agent_conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bot " <> agent.token)

      # In-profile (allowlist): the signal fans out.
      in_profile = post(agent_conn, "/api/v1/channels/#{ch_id}/typing", %{})
      assert in_profile.status == 200

      # Out-of-profile: the IDENTICAL 404 the unknown-channel leg renders.
      out = post(agent_conn, "/api/v1/channels/#{other.channel_id}/typing", %{})
      assert out.status == 404
      assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(out.resp_body)

      # The workspace-owner caller (this suite's conn) still sees both.
      assert post(conn, "/api/v1/channels/#{other.channel_id}/typing", %{}).status == 200
    end
  end

  describe "agent read-state isolation (bots plan U5, R4)" do
    setup %{user: user} do
      {:ok, %{user_id: agent_id, token: token}} =
        Cytale.Test.AgentGrants.mint_all(user.user_id, :agent, run_unique("Ack Agent"))

      agent_conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bot " <> token)

      {:ok, agent_conn: agent_conn, agent_id: agent_id}
    end

    test "agent ack writes the AGENT's read_state row; the parent's never moves", %{
      conn: conn,
      user: user,
      ch_id: ch_id,
      agent_conn: agent_conn,
      agent_id: agent_id
    } do
      seeded = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "seed for ack"})
      assert seeded.status == 201
      message_id = Jason.decode!(seeded.resp_body)["message"]["id"]

      ack = post(agent_conn, "/api/v1/channels/#{ch_id}/ack", %{"message_ids" => [message_id]})
      assert ack.status == 200
      assert Jason.decode!(ack.resp_body)["acknowledged"] == message_id

      # read_state is keyed by user: the AGENT holds its own row…
      channel_int = String.to_integer(ch_id)

      assert [%{"last_read_id" => last_read}] = read_state_rows(agent_id, channel_int)
      assert last_read == String.to_integer(message_id)

      # …and the parent holds NONE — an agent's acks never move the parent's
      # unread (per-principal read-state, R4).
      assert read_state_rows(user.user_id, channel_int) == []
    end

    test "a NON-STRING message id is answered, not crashed", %{conn: conn, ch_id: ch_id} do
      # Hardening plan 4.12. `max_snowflake/1` walks the list element by element,
      # and `snowflake/1` had no catch-all — so `%{"message_ids" => [123]}`,
      # JSON numbers being a spelling this route's docs describe as accepted,
      # raised FunctionClauseError and the request answered 500. It now reaches
      # the handler's malformed-id answer: 404, the same one every other bad id
      # gets (the anti-enumeration posture — NOT the 400 the plan wording
      # assumed).
      ack = post(conn, "/api/v1/channels/#{ch_id}/ack", %{"message_ids" => [123]})

      assert ack.status == 404
    end

    test "typing accepts the agent token (REST fallback)", %{ch_id: ch_id, agent_conn: agent_conn} do
      typing = post(agent_conn, "/api/v1/channels/#{ch_id}/typing", %{})
      assert typing.status == 200
      assert %{"ok" => true} = Jason.decode!(typing.resp_body)
    end
  end

  describe "read/edit/delete one" do
    test "author edit → PATCH; author delete → DELETE; non-author → 403", %{
      conn: conn,
      ch_id: ch_id
    } do
      conn = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "original"})
      mid = Jason.decode!(conn.resp_body)["message"]["id"]

      # Edit by author.
      conn = patch(conn, "/api/v1/channels/#{ch_id}/messages/#{mid}", %{"content" => "edited"})
      assert conn.status == 200

      assert %{"message" => %{"content" => "edited", "edited_at" => edited_at}} =
               Jason.decode!(conn.resp_body)

      refute is_nil(edited_at)

      # Delete by author.
      conn = delete(conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      assert conn.status == 200
      conn = get(conn, "/api/v1/channels/#{ch_id}/messages/#{mid}")
      assert conn.status == 404
    end
  end

  describe "embeds in native message JSON (bots plan U10, KTD11)" do
    setup %{user: user} do
      # Compat-created embeds (the only accepting surface in U10) read back
      # through the NATIVE projections.
      {:ok, %{token: token}} = Cytale.Test.AgentGrants.mint_all(user.user_id, :bot, run_unique("Embed Bot"))

      bot_conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bot " <> token)

      {:ok, bot_conn: bot_conn}
    end

    test "compat-created embeds surface in native history; no embeds → key ABSENT", %{
      conn: conn,
      bot_conn: bot_conn,
      ch_id: ch_id
    } do
      embeds = [
        %{
          "title" => "Native View",
          "description" => "seen by the app",
          "fields" => [%{"name" => "n", "value" => "v"}]
        },
        %{"title" => "Second", "totally_unknown_key" => [1, 2]}
      ]

      created =
        post(bot_conn, "/api/v10/channels/#{ch_id}/messages", %{"content" => "with embeds", "embeds" => embeds})

      assert created.status == 201
      mid = Jason.decode!(created.resp_body)["id"]

      plain = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "plain"})
      assert plain.status == 201

      # History: embeds array present (decoded objects, order preserved) on
      # the embed message; ABSENT on embed-less messages.
      %{"messages" => history} = Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/messages").resp_body)

      with_embeds = Enum.find(history, &(&1["id"] == mid))
      assert with_embeds["embeds"] == embeds

      without = Enum.find(history, &(&1["content"] == "plain"))
      refute Map.has_key?(without, "embeds")

      # Every other field of the embed-less message is unchanged (additive
      # growth only — the native shape did not move).
      assert without["attachments"] == []
      assert is_binary(without["created_at"])
    end

    test "embed-only compat message is visible natively with empty content and its embeds", %{
      conn: conn,
      bot_conn: bot_conn,
      ch_id: ch_id
    } do
      created =
        post(bot_conn, "/api/v10/channels/#{ch_id}/messages", %{
          "embeds" => [%{"title" => "Embed Only"}]
        })

      assert created.status == 201
      mid = Jason.decode!(created.resp_body)["id"]

      %{"messages" => history} = Jason.decode!(get(conn, "/api/v1/channels/#{ch_id}/messages").resp_body)
      found = Enum.find(history, &(&1["id"] == mid))
      assert found["content"] == ""
      assert found["embeds"] == [%{"title" => "Embed Only"}]
    end
  end

  # -- helpers -------------------------------------------------------------------

  describe "body thread_id is scoped to the path channel (security tier 1 #3)" do
    test "a thread in another channel is refused and never receives the message",
         %{conn: conn, ws_id: ws_id, ch_id: ch_id, user: user} do
      other = String.to_integer(create_channel(conn, ws_id))
      {:ok, root} = Cytale.Messages.create_message(%{channel_id: other, author_id: user.user_id, content: "root"})
      {:ok, thread} = Cytale.Threads.Thread.create(other, root.id, "elsewhere", user.user_id)

      resp =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "injected",
          "thread_id" => Integer.to_string(thread.thread_id)
        })

      assert resp.status == 400
      assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(resp.resp_body)

      history = get(conn, "/api/v1/threads/#{thread.thread_id}/messages")
      assert history.status == 200
      refute Enum.any?(Jason.decode!(history.resp_body)["messages"], &(&1["content"] == "injected"))

      # An unknown thread id is refused the same way.
      resp = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "x", "thread_id" => "123456789012345678"})
      assert resp.status == 400
    end

    test "a thread of THIS channel still accepts the body thread_id (tui/mobile path)",
         %{conn: conn, ch_id: ch_id, user: user} do
      ch = String.to_integer(ch_id)
      {:ok, root} = Cytale.Messages.create_message(%{channel_id: ch, author_id: user.user_id, content: "root"})
      {:ok, thread} = Cytale.Threads.Thread.create(ch, root.id, "here", user.user_id)

      resp =
        post(conn, "/api/v1/channels/#{ch_id}/messages", %{
          "content" => "in thread",
          "thread_id" => Integer.to_string(thread.thread_id)
        })

      assert resp.status == 201
      assert Jason.decode!(resp.resp_body)["message"]["thread_id"] == Integer.to_string(thread.thread_id)

      history = get(conn, "/api/v1/threads/#{thread.thread_id}/messages")
      assert Enum.any?(Jason.decode!(history.resp_body)["messages"], &(&1["content"] == "in thread"))
    end
  end

  describe "no VIEW means no channel rights (security tier 1 #5)" do
    test "send allowed but view denied: a reply POST is refused and leaks no referenced message",
         %{conn: owner, ws_id: ws_id, ch_id: ch_id} do
      invite_code = create_invite(owner, ws_id)
      {member, u2} = register_and_login(build_conn_with_headers())
      assert post(member, "/api/v1/invites/#{invite_code}").status == 200

      secret = post(owner, "/api/v1/channels/#{ch_id}/messages", %{"content" => "top secret words"})
      secret_id = Jason.decode!(secret.resp_body)["message"]["id"]

      :ok =
        Cytale.Workspaces.put_overwrite(
          String.to_integer(ch_id),
          :member,
          u2.user_id,
          Bitfield.bit(:send_messages),
          Bitfield.bit(:view_channel)
        )

      resp = post(member, "/api/v1/channels/#{ch_id}/messages", %{"content" => "probe", "reply_to_id" => secret_id})
      assert resp.status in [403, 404]
      refute resp.resp_body =~ "top secret words"

      history = get(owner, "/api/v1/channels/#{ch_id}/messages")
      refute Enum.any?(Jason.decode!(history.resp_body)["messages"], &(&1["content"] == "probe"))
    end
  end

  def build_conn_with_headers do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp register_and_login(conn) do
    username = "u#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
    {:ok, user} = User.create(username, "#{username}@example.com", "password-123")

    {:ok, raw, _hash} = Auth.issue_single_use_token(user.user_id, "verify_email")
    :ok = Cytale.Accounts.Verification.complete_email_verification(raw)

    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("ws")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  # Raw read_state partition read — the U5 isolation pins assert table state,
  # not just the REST response.
  defp read_state_rows(user_id, channel_id) do
    Cytale.Repo.execute!(
      "SELECT user_id, channel_id, last_read_id, mention_count, unread_count FROM #{Cytale.Repo.keyspace()}.read_state WHERE user_id = ? AND channel_id = ?",
      [{"bigint", user_id}, {"bigint", channel_id}]
    )
    |> Enum.to_list()
  end

  defp create_invite(conn, ws_id) do
    # Invites are created through the Workspaces layer here (the admin-tier
    # invite-create route is exercised in the invite test file); the code is
    # what the join flow needs.
    {:ok, invite} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
    invite.invite_code
  end

  defp send_status(conn, ch_id, content),
    do: post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => content}).status

  defmodule RaisingPublish do
    @moduledoc false
    @behaviour Cytale.Publish
    @impl true
    def publish(_channel_id, _event), do: raise("fan-out unavailable")
    @impl true
    def publish_user_update(_user_id, _event), do: :ok
  end

  # Bitfield reference (kept for the deny-overwrite variant):
  defp deny_send(channel_id, user_id) do
    Cytale.Workspaces.put_overwrite(
      String.to_integer(channel_id),
      :member,
      user_id,
      0,
      Bitfield.bit(:send_messages)
    )
  end
end
