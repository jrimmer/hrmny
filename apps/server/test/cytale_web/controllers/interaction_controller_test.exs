defmodule CytaleWeb.Controllers.InteractionControllerTest do
  @moduledoc """
  U8 (bots plan) — the native interactions surface over HTTP: the composer's
  command list (member-gated), the invocation endpoint U9's composer calls
  (send-right checked on the target channel, 202 + interaction id), and the
  compat callback `POST /api/v10/interactions/{id}/{token}/callback` (URL
  token is the credential — NO Authorization header; the bot's message
  creation runs through the principal-rights resolver so the bot's own
  restrictions apply).

  The read-only-invocation and channel-restricted-callback cases are the
  unit's P1 authz-gap closures — pinned here first.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Interactions
  alias Cytale.Messages
  alias Cytale.Permissions.Bitfield
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base) do
    base <>
      Integer.to_string(
        :erlang.phash2({System.system_time(:millisecond), System.unique_integer([:positive])}, 1_000_000_000)
      )
  end

  defp auth_conn(authorization) do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end

  defp conn_for(user) do
    auth_conn("Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp plain_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  setup do
    {:ok, owner} = User.create(run_unique("u8n_owner"), run_unique("u8n_owner@example.com"), "password-123")
    {:ok, member} = User.create(run_unique("u8n_member"), run_unique("u8n_member@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("u8n-ws"))
    {:ok, general} = Workspaces.create_channel(ws.workspace_id, "general")
    {:ok, locked} = Workspaces.create_channel(ws.workspace_id, "locked")
    :ok = Workspaces.add_member(ws.workspace_id, member.user_id, owner.user_id)
    {:ok, bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Native Bot"))

    {:ok, [command]} =
      Interactions.upsert_commands(
        ws.workspace_id,
        bot.user_id,
        [
          %{"name" => "echo", "description" => "Echo text"}
        ],
        :replace
      )

    {:ok, ws: ws, general: general, locked: locked, owner: owner, member: member, bot: bot, command: command}
  end

  defp invoke_body(command, channel, options \\ %{}) do
    %{
      "command_id" => Integer.to_string(command.command_id),
      "channel_id" => Integer.to_string(channel.channel_id),
      "options" => options
    }
  end

  # ---------------------------------------------------------------------------
  # Composer list — GET /api/v1/workspaces/:workspace_id/commands
  # ---------------------------------------------------------------------------

  describe "command list" do
    test "any member lists the workspace's commands", %{ws: ws, member: member, bot: bot, command: command} do
      conn = get(conn_for(member), "/api/v1/workspaces/#{ws.workspace_id}/commands")
      assert conn.status == 200

      commands = Jason.decode!(conn.resp_body)["commands"]
      assert [%{"id" => id, "name" => "echo", "description" => "Echo text", "application_id" => app_id}] = commands
      assert id == Integer.to_string(command.command_id)
      assert app_id == Integer.to_string(bot.user_id)
    end

    test "a non-member is 403; an unknown workspace is 404", %{ws: ws} do
      {:ok, stranger} = User.create(run_unique("u8n_stranger"), run_unique("u8n_stranger@example.com"), "password-123")

      conn = get(conn_for(stranger), "/api/v1/workspaces/#{ws.workspace_id}/commands")
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"

      conn = get(conn_for(stranger), "/api/v1/workspaces/999999999999/commands")
      assert conn.status == 404
    end
  end

  # ---------------------------------------------------------------------------
  # Invocation — POST /api/v1/interactions
  # ---------------------------------------------------------------------------

  describe "invocation" do
    test "a member with the send right invokes → 202 with interaction_id", %{
      general: general,
      member: member,
      command: command
    } do
      conn = post(conn_for(member), "/api/v1/interactions", invoke_body(command, general, %{"text" => "hi"}))
      assert conn.status == 202

      assert %{"interaction_id" => id} = Jason.decode!(conn.resp_body)
      assert is_binary(id)
      {interaction_id, ""} = Integer.parse(id)
      assert interaction_id > 0
    end

    test "a non-member invoking is 403 (no membership oracle beyond the deny)", %{
      general: general,
      command: command
    } do
      {:ok, stranger} = User.create(run_unique("u8n_stranger"), run_unique("u8n_stranger@example.com"), "password-123")
      conn = post(conn_for(stranger), "/api/v1/interactions", invoke_body(command, general))
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"
    end

    test "a read-only member (denied send in the channel) invoking is 403", %{
      locked: locked,
      member: member,
      command: command
    } do
      Workspaces.put_overwrite(locked.channel_id, :member, member.user_id, 0, Bitfield.bit(:send_messages))

      conn = post(conn_for(member), "/api/v1/interactions", invoke_body(command, locked))
      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"
    end

    test "unknown command is 404; unknown channel is 404", %{
      general: general,
      member: member,
      command: command
    } do
      conn =
        post(conn_for(member), "/api/v1/interactions", invoke_body(%{command | command_id: 999_999_999_999}, general))

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "command_not_found"

      conn =
        post(conn_for(member), "/api/v1/interactions", invoke_body(command, %{channel_id: 999_999_999_999}))

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "channel_not_found"
    end

    test "missing fields are 400", %{general: general, member: member, command: command} do
      conn = post(conn_for(member), "/api/v1/interactions", %{"channel_id" => Integer.to_string(general.channel_id)})
      assert conn.status == 400

      conn =
        post(conn_for(member), "/api/v1/interactions", %{
          "command_id" => Integer.to_string(command.command_id)
        })

      assert conn.status == 400
    end
  end

  # ---------------------------------------------------------------------------
  # Component click ingress (components plan U2, R3) — the message-keyed body
  # variant of POST /api/v1/interactions
  # ---------------------------------------------------------------------------

  describe "component ingress (components plan U2)" do
    defp button_row(ids),
      do: %{
        "type" => 1,
        "components" => Enum.map(ids, &%{"type" => 2, "style" => 1, "label" => "B#{&1}", "custom_id" => &1})
      }

    defp select_row(id) do
      %{
        "type" => 1,
        "components" => [
          %{
            "type" => 3,
            "custom_id" => id,
            "options" => [
              %{"label" => "One", "value" => "one"},
              %{"label" => "Two", "value" => "two"}
            ]
          }
        ]
      }
    end

    defp card!(channel_id, author_id, components) do
      {:ok, msg} =
        Messages.create_message(%{
          channel_id: channel_id,
          author_id: author_id,
          content: "card",
          thread_id: nil,
          components: components
        })

      msg
    end

    defp click_body(message, custom_id, component_type \\ 2, values \\ nil) do
      base = %{
        "channel_id" => Integer.to_string(message.channel_id),
        "message_id" => Integer.to_string(message.id),
        "custom_id" => custom_id,
        "component_type" => component_type
      }

      if is_nil(values), do: base, else: Map.put(base, "values", values)
    end

    test "a human click on a live button → 202 + interaction_id + one mint", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve", "deny"])])
      before = Cytale.Interactions.TokenStore.count()

      conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "approve"))

      assert conn.status == 202
      assert %{"interaction_id" => id} = Jason.decode!(conn.resp_body)
      assert is_binary(id)
      assert Cytale.Interactions.TokenStore.count() == before + 1
    end

    # The shipped Idempotency plug is honored on the component body variant:
    # a replayed key returns the ORIGINAL interaction (no second mint, no
    # second fan-out — the plug halts before the controller).
    test "Idempotency-Key replay → 202 with the identical interaction_id, no second mint", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      body = click_body(msg, "approve")
      before = Cytale.Interactions.TokenStore.count()

      conn =
        conn_for(member)
        |> put_req_header("idempotency-key", "click-once")
        |> post("/api/v1/interactions", body)

      assert conn.status == 202
      first_id = Jason.decode!(conn.resp_body)["interaction_id"]

      replay =
        conn_for(member)
        |> put_req_header("idempotency-key", "click-once")
        |> post("/api/v1/interactions", body)

      assert replay.status == 202
      assert Jason.decode!(replay.resp_body)["interaction_id"] == first_id
      assert Plug.Conn.get_resp_header(replay, "idempotency-replayed") == ["true"]
      assert Cytale.Interactions.TokenStore.count() == before + 1
    end

    test "forged custom_id → 400 component_unavailable, no mint (TokenStore pinned)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      before = Cytale.Interactions.TokenStore.count()

      conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "forged"))

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "component_unavailable"
      assert Cytale.Interactions.TokenStore.count() == before
    end

    test "disabled component and component-less messages (bot + webhook authored) → 400, no mint", %{
      general: general,
      member: member,
      owner: owner,
      bot: bot
    } do
      rows = [
        %{
          "type" => 1,
          "components" => [%{"type" => 2, "style" => 1, "label" => "D", "custom_id" => "dead", "disabled" => true}]
        }
      ]

      disabled_msg = card!(general.channel_id, bot.user_id, rows)
      plain = card!(general.channel_id, bot.user_id, [])
      {:ok, hook} = AgentGrants.mint_all(owner.user_id, :webhook, run_unique("Hook"))
      webhook_msg = card!(general.channel_id, hook.user_id, [])

      before = Cytale.Interactions.TokenStore.count()

      for msg <- [disabled_msg, plain, webhook_msg],
          custom_id <- ["dead", "anything"] do
        conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, custom_id))
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body)["error"]["key"] == "component_unavailable"
      end

      assert Cytale.Interactions.TokenStore.count() == before
    end

    test "select clicks: values ride verbatim; >4KB / non-list / unknown-option values → 400", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [select_row("model")])
      before = Cytale.Interactions.TokenStore.count()

      conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "model", 3, ["two"]))
      assert conn.status == 202

      for values <- [
            List.duplicate("one", 5_000),
            [String.duplicate("x", 5_000)],
            "one",
            ["gopher"],
            ["one", "two"]
          ] do
        conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "model", 3, values))
        assert conn.status == 400, "expected 400 for values #{inspect(values) |> String.slice(0, 40)}"
        assert Jason.decode!(conn.resp_body)["error"]["key"] == "validation_failed"
      end

      # Only the happy click minted.
      assert Cytale.Interactions.TokenStore.count() == before + 1
    end

    # The kind-guard doctrine (KD2/R3): machine principals cannot click.
    test "a bot token clicking → 403", %{general: general, bot: bot} do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])

      conn =
        build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> bot.token)
        |> post("/api/v1/interactions", click_body(msg, "approve"))

      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "forbidden"
    end

    # The 403 oracle pair: a read-only member and a non-member render the
    # IDENTICAL body — no membership oracle.
    test "read-only clicker and non-member → the identical 403 oracle pair", %{
      ws: ws,
      general: general,
      member: member,
      bot: bot
    } do
      {:ok, locked} = Workspaces.create_channel(ws.workspace_id, "locked")
      Workspaces.put_overwrite(locked.channel_id, :member, member.user_id, 0, Bitfield.bit(:send_messages))
      locked_msg = card!(locked.channel_id, bot.user_id, [button_row(["approve"])])

      {:ok, stranger} = User.create(run_unique("u2n_stranger"), run_unique("u2n_stranger@example.com"), "password-123")
      stranger_msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])

      readonly = post(conn_for(member), "/api/v1/interactions", click_body(locked_msg, "approve"))
      outsider = post(conn_for(stranger), "/api/v1/interactions", click_body(stranger_msg, "approve"))

      assert readonly.status == 403
      assert outsider.status == 403
      assert Jason.decode!(readonly.resp_body) == Jason.decode!(outsider.resp_body)
    end

    test "DM click: participant → 202; non-participant → 404 oracle", %{
      owner: owner,
      member: member,
      bot: bot
    } do
      {:ok, dm} = Workspaces.open_dm(owner.user_id, bot.user_id)
      msg = card!(dm.channel_id, bot.user_id, [button_row(["approve"])])
      body = click_body(msg, "approve")

      conn = post(conn_for(owner), "/api/v1/interactions", body)
      assert conn.status == 202

      conn = post(conn_for(member), "/api/v1/interactions", body)
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "channel_not_found"
    end

    # R8 (ingress half): the DISTINCT dead-button error — 410, never a mint.
    test "dead bot (revoked + deleted) → the distinct dead-button error, no mint", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])

      :ok = Principals.revoke(bot.user_id)
      :ok = Principals.delete_machine_principal!(bot.user_id)

      before = Cytale.Interactions.TokenStore.count()

      conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "approve"))

      assert conn.status == 410
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "component_unavailable"
      assert Cytale.Interactions.TokenStore.count() == before
    end

    test "missing message → 404; unknown component_type → 400; malformed ids → 400", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])

      conn =
        post(conn_for(member), "/api/v1/interactions", %{
          "channel_id" => Integer.to_string(general.channel_id),
          "message_id" => "999999999999",
          "custom_id" => "approve",
          "component_type" => 2
        })

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["error"]["key"] == "message_not_found"

      # Unknown component types never mint (R4: only 2 button / 3 select).
      for type <- [4, 9, "2", nil] do
        conn = post(conn_for(member), "/api/v1/interactions", click_body(msg, "approve", type))
        assert conn.status == 400, "expected 400 for component_type #{inspect(type)}"
      end

      # Malformed snowflakes / missing keys.
      conn =
        post(conn_for(member), "/api/v1/interactions", %{
          "channel_id" => "not-a-snowflake",
          "message_id" => Integer.to_string(msg.id),
          "custom_id" => "approve",
          "component_type" => 2
        })

      assert conn.status == 400
    end
  end

  # ---------------------------------------------------------------------------
  # Callback — POST /api/v10/interactions/{id}/{token}/callback
  # ---------------------------------------------------------------------------

  describe "callback" do
    defp mint!(claims, command, channel) do
      assert {:ok, minted} = Interactions.invoke(claims, command.command_id, channel.channel_id, %{})
      minted
    end

    test "type-4 callback with NO auth header posts the bot's message (204)", %{
      general: general,
      member: member,
      bot: bot,
      command: command
    } do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "pong"}
        })

      assert conn.status == 200
      # typed callbacks answer the interaction envelope (discord.py 2.7 parses it)

      # The message landed with BOT attribution (author_id = the principal).
      [%{author_id: author_id, content: content}] =
        Messages.history(general.channel_id, limit: 1)

      assert author_id == bot.user_id
      assert content == "pong"
    end

    test "a wrong token is 401 (Discord shape); an unknown interaction is 401", %{
      general: general,
      member: member,
      command: command
    } do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token <> "x"}/callback", %{
          "type" => 4,
          "data" => %{"content" => "nope"}
        })

      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"code" => 0, "message" => "401: Unauthorized"}
      assert [] = Messages.history(general.channel_id, limit: 5)

      conn =
        post(plain_conn(), "/api/v10/interactions/999999999999/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "nope"}
        })

      assert conn.status == 401
    end

    # C-1 (Discord parity): the FIRST type-4 response CONSUMES the ack — one
    # reply per token. A replayed type-4 renders Discord's 10063
    # UNKNOWN_INTERACTION shape; followups (no `type` key) still post.
    test "the ack is single-use: replayed type-4 → 400 10063; a followup after the ack still posts", %{
      general: general,
      member: member,
      command: command
    } do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      path = "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback"
      ack = %{"type" => 4, "data" => %{"content" => "pong"}}

      assert post(plain_conn(), path, ack).status == 200

      replay = post(plain_conn(), path, ack)
      assert replay.status == 400
      assert Jason.decode!(replay.resp_body) == %{"code" => 10_063, "message" => "Unknown interaction"}

      # Followups (no type key — Discord's followup message shape) post as
      # the bot via the same token, in both accepted body shapes.
      assert post(plain_conn(), path, %{"data" => %{"content" => "followup wrapped"}}).status == 204
      assert post(plain_conn(), path, %{"content" => "followup bare"}).status == 204

      # Exactly one ack + two followups landed; the replayed ack posted none.
      messages = Messages.history(general.channel_id, limit: 5)
      assert Enum.map(messages, & &1.content) == ["followup bare", "followup wrapped", "pong"]
    end

    # B6f + C-1: the per-pair bucket bounds the token's TOTAL posts — one
    # ack plus followups — for its whole 15-minute life; the 11th post on
    # one pair is the shared Discord 429, and a FRESH interaction's bucket
    # is untouched. The interleaving fresh pair belongs to a SECOND bot —
    # since the components plan U3 (KTD10) the per-APPLICATION bucket
    # aggregates every create leg of one bot (10/5s), so same-bot pairs
    # share that aggregate too; a second bot's pair proves the PAIR bucket
    # in isolation exactly as before.
    test "the 11th post on one {interaction, token} pair 429s; fresh pairs unaffected", %{
      ws: ws,
      general: general,
      member: member,
      command: command,
      owner: owner
    } do
      claims = %{user_id: member.user_id, username: member.username, verified: true, kind: :human}
      minted = mint!(claims, command, general)
      path = "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback"
      ack = %{"type" => 4, "data" => %{"content" => "pong"}}
      followup = %{"content" => "followup"}

      # A different interaction under a DIFFERENT bot (fresh pair AND fresh
      # app bucket) malleably interleaves.
      {:ok, fresh_bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Fresh Pair Bot"))

      {:ok, [other_command]} =
        Interactions.upsert_commands(
          ws.workspace_id,
          fresh_bot.user_id,
          [%{"name" => "echo-#{run_unique("p")}", "description" => "Echo"}],
          :replace
        )

      other = mint!(claims, other_command, general)
      other_path = "/api/v10/interactions/#{other.interaction_id}/#{other.token}/callback"

      statuses =
        for i <- 1..11 do
          body = if i == 1, do: ack, else: followup
          conn = post(plain_conn(), path, body)
          # Interleave a fresh-pair callback mid-flood (they never trip).
          if i == 5 do
            assert post(plain_conn(), other_path, %{"type" => 4, "data" => %{"content" => "pong"}}).status == 200
          end

          conn.status
        end

      # The first 10 posts fit the bucket — the ack answers the interaction
      # envelope (200, discord.py 2.7), the 9 followups stay 204 — and the
      # 11th is the 429.
      assert Enum.count(statuses, &(&1 == 200)) == 1
      assert Enum.count(statuses, &(&1 == 204)) == 9
      assert Enum.count(statuses, &(&1 == 429)) == 1

      over =
        post(plain_conn(), path, followup)

      assert over.status == 429
      assert %{"code" => 0, "global" => false, "retry_after" => retry_after} = Jason.decode!(over.resp_body)
      assert is_float(retry_after)
      assert Plug.Conn.get_resp_header(over, "x-ratelimit-scope") == ["user"]
      assert Plug.Conn.get_resp_header(over, "x-ratelimit-remaining") == ["0"]
    end

    test "an expired token is 401 (short-TTL injection)", %{
      general: general,
      member: member,
      command: command
    } do
      previous = Application.get_env(:cytale, :interactions)
      Application.put_env(:cytale, :interactions, token_ttl_ms: 40)

      on_exit(fn ->
        case previous do
          nil -> Application.delete_env(:cytale, :interactions)
          value -> Application.put_env(:cytale, :interactions, value)
        end
      end)

      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      Process.sleep(60)

      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "late"}
        })

      assert conn.status == 401
      assert [] = Messages.history(general.channel_id, limit: 5)
    end

    test "revoking the bot between invocation and callback → 401, no message", %{
      general: general,
      member: member,
      command: command
    } do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      :ok = Principals.revoke(minted.payload["application_id"] |> String.to_integer())

      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "zombie"}
        })

      assert conn.status == 401
      assert [] = Messages.history(general.channel_id, limit: 5)
    end

    test "a channel-restricted bot's callback into an out-of-profile channel is blocked (no message)", %{
      ws: ws,
      general: general,
      member: member,
      command: command
    } do
      # Re-register the SAME command under a channel-restricted bot whose
      # allowlist names a DIFFERENT channel than the invocation target.
      {:ok, allowed} = Workspaces.create_channel(ws.workspace_id, "bot-allowed")

      {:ok, restricted} =
        AgentGrants.mint_all(command.application_id |> principal_parent!(), :bot, "Restricted Bot", %{
          "actions" => ["read", "post"],
          "channels" => [Integer.to_string(allowed.channel_id)]
        })

      {:ok, [restricted_command]} =
        Interactions.upsert_commands(
          ws.workspace_id,
          restricted.user_id,
          [
            %{"name" => "echo", "description" => "Echo text"}
          ],
          :replace
        )

      minted =
        mint!(
          %{user_id: member.user_id, username: member.username, verified: true, kind: :human},
          restricted_command,
          general
        )

      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "should not land"}
        })

      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["code"] == 50_001
      assert [] = Messages.history(general.channel_id, limit: 5)
    end

    test "other typed bodies and malformed bodies are 400 — and never consume the ack", %{
      general: general,
      member: member,
      command: command
    } do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      # U3 grew the typed surface to 4/5/6/7 — 8 (and everything else) stays
      # out of surface.
      for body <- [
            %{"type" => 8},
            %{"type" => 3, "data" => %{"content" => "x"}},
            %{"type" => 4},
            %{"type" => 4, "data" => %{}},
            %{"type" => 7},
            %{"type" => 7, "data" => %{}},
            %{"data" => %{}},
            %{}
          ] do
        conn = post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", body)
        assert conn.status == 400, "expected 400 for #{inspect(body)}"
        assert Jason.decode!(conn.resp_body)["code"] == 50_035
      end

      assert [] = Messages.history(general.channel_id, limit: 5)

      # None of the malformed acks consumed the slot — a well-formed type-4
      # still answers as THE ack.
      conn =
        post(plain_conn(), "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback", %{
          "type" => 4,
          "data" => %{"content" => "still first"}
        })

      assert conn.status == 200
    end
  end

  # Security (Tier 3 #4): flags & 64 (EPHEMERAL) used to be dropped, so a
  # reply the bot meant for the invoker alone posted into the channel for
  # everyone. With no invoker-only delivery path, it is REFUSED (50035 naming
  # `flags`), before the ack is spent and before anything is posted.
  describe "ephemeral replies (flags & 64) are refused, never posted publicly" do
    test "type 4, type 5, and both followup shapes on the callback route → 50035 flags; ack intact; nothing posted",
         %{general: general, member: member, command: command} do
      minted =
        mint!(%{user_id: member.user_id, username: member.username, verified: true, kind: :human}, command, general)

      path = "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback"

      for body <- [
            %{"type" => 4, "data" => %{"content" => "secret for you", "flags" => 64}},
            # Other bits alongside EPHEMERAL (SUPPRESS_EMBEDS = 4) still refuse.
            %{"type" => 4, "data" => %{"content" => "secret for you", "flags" => 68}},
            %{"type" => 5, "data" => %{"flags" => 64}},
            %{"data" => %{"content" => "secret followup", "flags" => 64}},
            %{"content" => "secret followup", "flags" => 64}
          ] do
        conn = post(plain_conn(), path, body)
        assert conn.status == 400, "expected 400 for #{inspect(body)}"
        decoded = Jason.decode!(conn.resp_body)
        assert decoded["code"] == 50_035
        assert Map.has_key?(decoded["errors"], "flags")
      end

      assert [] = Messages.history(general.channel_id, limit: 5)

      # The ack was never spent: a non-ephemeral type-4 is still THE ack, and
      # a non-ephemeral flag (SUPPRESS_EMBEDS) is unaffected.
      assert post(plain_conn(), path, %{"type" => 4, "data" => %{"content" => "public", "flags" => 4}}).status == 200
      assert [%{content: "public"}] = Messages.history(general.channel_id, limit: 5)
    end

    test "the webhook-route followup with flags & 64 → 50035, nothing posted", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(minted), %{"type" => 5}).status == 200

      for path <- [fu_path(minted), fu_path_bare(minted)] do
        followup = post(plain_conn(), path, %{"content" => "only you can see this", "flags" => 64})
        assert followup.status == 400
        assert Jason.decode!(followup.resp_body)["errors"]["flags"]
      end

      # Only the card itself is in the channel.
      assert [%{id: id}] = Messages.history(general.channel_id, limit: 5)
      assert id == msg.id
    end
  end

  # ---------------------------------------------------------------------------
  # Component callback types 5/6/7 + continuation routes (components plan U3)
  # ---------------------------------------------------------------------------

  describe "component callbacks (components plan U3)" do
    # button_row/1, select_row/1, card!/2 come from the U2 ingress describe
    # above (describe blocks do not scope defs).

    defp human_claims(user),
      do: %{user_id: user.user_id, username: user.username, verified: true, kind: :human}

    defp click_mint!(user, message, custom_id) do
      {:ok, minted} = Interactions.invoke_component(human_claims(user), message.channel_id, message.id, custom_id, 2)
      minted
    end

    defp cb_path(minted),
      do: "/api/v10/interactions/#{minted.interaction_id}/#{minted.token}/callback"

    defp fu_path(minted),
      do: "/api/v10/webhooks/#{minted.payload["application_id"]}/#{minted.token}"

    defp fu_path_bare(minted),
      do: "/api/webhooks/#{minted.payload["application_id"]}/#{minted.token}"

    defp orig_path(minted), do: fu_path(minted) <> "/messages/@original"

    defp resolved_row(custom_id) do
      %{
        "type" => 1,
        "components" => [
          %{"type" => 2, "style" => 2, "label" => "Resolved", "custom_id" => custom_id, "disabled" => true}
        ]
      }
    end

    test "type-7 happy path: ack consumed, wholesale replace + content + embeds + edited_at; replay → 10063", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve", "deny"])])
      minted = click_mint!(member, msg, "approve")

      embed = %{"title" => "Audit trail", "description" => "approved"}

      conn =
        post(plain_conn(), cb_path(minted), %{
          "type" => 7,
          "data" => %{"content" => "approved!", "components" => [resolved_row("approve")], "embeds" => [embed]}
        })

      assert conn.status == 200

      updated = Messages.get_message(general.channel_id, msg.id)
      assert updated.content == "approved!"
      assert updated.components == [resolved_row("approve")]
      assert updated.embeds == [embed]
      assert updated.edited_at != nil

      # The ack is single-use — a replayed type-7 is Discord's 10063.
      replay = post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => []}})
      assert replay.status == 400
      assert Jason.decode!(replay.resp_body) == %{"code" => 10_063, "message" => "Unknown interaction"}
    end

    test "type-7 components-only: content untouched, edited_at still bumps", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      conn =
        post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => [resolved_row("approve")]}})

      assert conn.status == 200

      updated = Messages.get_message(general.channel_id, msg.id)
      assert updated.content == "card"
      assert updated.components == [resolved_row("approve")]
      assert updated.edited_at != nil
    end

    test "type-7 content validation: 4001 bytes → 400 50035; non-string → 400; neither consumes the ack", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      for content <- [String.duplicate("x", 4_001), 12_345] do
        conn = post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"content" => content}})
        assert conn.status == 400
        assert Jason.decode!(conn.resp_body)["code"] == 50_035
      end

      # A well-formed type-7 still owns the ack.
      assert post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => []}}).status == 200
    end

    test "type-7 malformed components → 400 50035, ack intact (R1 caps upstream)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      six_rows = Enum.map(1..6, fn i -> button_row(["b#{i}"]) end)

      conn = post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => six_rows}})
      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["code"] == 50_035

      assert post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => []}}).status == 200
    end

    test "type-4 with data.components → the response message carries the fresh card (stored + rendered)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")
      fresh = [button_row(["next-step"])]

      conn =
        post(plain_conn(), cb_path(minted), %{
          "type" => 4,
          "data" => %{"content" => "done — pick next", "components" => fresh}
        })

      assert conn.status == 200

      assert [%{components: components, author_id: author_id}] =
               Messages.history(general.channel_id, limit: 1)

      assert author_id == bot.user_id
      assert components == fresh
    end

    test "type 5 then followup-POST: the deferred reply posts (full Discord shape) and becomes @original", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      # The defer consumes the ack and posts NOTHING.
      assert post(plain_conn(), cb_path(minted), %{"type" => 5}).status == 200
      assert [%{}] = Messages.history(general.channel_id, limit: 1)

      followup =
        post(plain_conn(), fu_path(minted), %{
          "content" => "the deferred answer",
          "components" => [resolved_row("approve")]
        })

      assert followup.status == 200

      # The institutionalized lesson pin: a FULL Discord message object.
      d = Jason.decode!(followup.resp_body)
      assert is_binary(d["id"])
      assert d["channel_id"] == Integer.to_string(general.channel_id)
      assert d["content"] == "the deferred answer"
      assert d["author"]["bot"] == true
      assert d["author"]["id"] == Integer.to_string(bot.user_id)
      assert d["components"] == [resolved_row("approve")]
      assert is_binary(d["timestamp"])

      # @original now resolves to the deferred reply (reply flow).
      original = get(plain_conn(), orig_path(minted))
      assert original.status == 200
      assert Jason.decode!(original.resp_body)["id"] == d["id"]
    end

    test "type 6 then @original PATCH: the card flips (the deferred update completion)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(minted), %{"type" => 6}).status == 200
      # The defer edited nothing — the original rows are intact.
      assert Messages.get_message(general.channel_id, msg.id).components == [button_row(["approve"])]

      # @original for an UPDATE flow is the CLICK'S message.
      before = get(plain_conn(), orig_path(minted))
      assert before.status == 200
      assert Jason.decode!(before.resp_body)["id"] == Integer.to_string(msg.id)

      patched =
        patch(plain_conn(), orig_path(minted), %{
          "components" => [resolved_row("approve")],
          "content" => "resolved by patch"
        })

      assert patched.status == 200
      assert Jason.decode!(patched.resp_body)["components"] == [resolved_row("approve")]

      updated = Messages.get_message(general.channel_id, msg.id)
      assert updated.components == [resolved_row("approve")]
      assert updated.content == "resolved by patch"
      assert updated.edited_at != nil
    end

    test "@original GET/DELETE work; DELETE unpublishes (404 after)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => [resolved_row("approve")]}}).status ==
               200

      show = get(plain_conn(), orig_path(minted))
      assert show.status == 200
      assert Jason.decode!(show.resp_body)["components"] == [resolved_row("approve")]

      assert delete(plain_conn(), orig_path(minted)).status == 204
      refute Messages.get_message(general.channel_id, msg.id)

      assert get(plain_conn(), orig_path(minted)).status == 404
    end

    test "deferReply materialization: GET @original before the reply posts is 404; the PATCH posts it", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(minted), %{"type" => 5}).status == 200
      assert get(plain_conn(), orig_path(minted)).status == 404

      # discord.js deferReply → editReply hits exactly this route: the PATCH
      # MATERIALIZES the deferred reply.
      patched =
        patch(plain_conn(), orig_path(minted), %{
          "content" => "materialized reply",
          "components" => [resolved_row("approve")]
        })

      assert patched.status == 200
      d = Jason.decode!(patched.resp_body)
      assert d["content"] == "materialized reply"

      assert [%{content: "materialized reply"}] = Messages.history(general.channel_id, limit: 1)
      assert Jason.decode!(get(plain_conn(), orig_path(minted)).resp_body)["id"] == d["id"]
    end

    test "@original PATCH after a type-4 edits the POSTED REPLY (reply-flow original)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(minted), %{"type" => 4, "data" => %{"content" => "first reply"}}).status == 200
      assert [%{id: reply_id}] = Messages.history(general.channel_id, limit: 1)

      patched = patch(plain_conn(), orig_path(minted), %{"content" => "edited reply"})
      assert patched.status == 200
      assert Jason.decode!(patched.resp_body)["id"] == Integer.to_string(reply_id)
      assert Messages.get_message(general.channel_id, reply_id).content == "edited reply"
    end

    test "continuation token errors: wrong/expired token → 401; wrong application id → 401 (as the callback)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      # A tampered token renders the callback's 401 on both continuation
      # shapes (POST the followup, GET the @original — the verbs that exist).
      tampered = String.replace(fu_path(minted), minted.token, minted.token <> "x")
      conn = post(plain_conn(), tampered, %{"content" => "nope"})
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"code" => 0, "message" => "401: Unauthorized"}

      conn = get(plain_conn(), String.replace(orig_path(minted), minted.token, minted.token <> "x"))
      assert conn.status == 401
      assert Jason.decode!(conn.resp_body) == %{"code" => 0, "message" => "401: Unauthorized"}

      # Unknown token (never minted).
      assert post(plain_conn(), "/api/v10/webhooks/#{bot.user_id}/not-a-real-token", %{"content" => "x"}).status == 401

      # Right token, foreign application id in the URL.
      {:ok, other_bot} = AgentGrants.mint_all(principal_parent!(bot.user_id), :bot, "Other Bot")
      foreign = fu_path(minted) |> String.replace(Integer.to_string(bot.user_id), Integer.to_string(other_bot.user_id))
      assert post(plain_conn(), foreign, %{"content" => "x"}).status == 401

      # Expired token (short-TTL injection, the callback's pattern — the
      # mint must happen UNDER the short TTL).
      previous = Application.get_env(:cytale, :interactions)
      Application.put_env(:cytale, :interactions, token_ttl_ms: 40)

      on_exit(fn ->
        case previous do
          nil -> Application.delete_env(:cytale, :interactions)
          value -> Application.put_env(:cytale, :interactions, value)
        end
      end)

      expiring = click_mint!(member, msg, "approve")
      Process.sleep(60)
      assert post(plain_conn(), fu_path(expiring), %{"content" => "late"}).status == 401
    end

    test "type 5 and type 6 consume the ack: a later typed response → 400 10063", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      defer_reply = click_mint!(member, msg, "approve")
      defer_update = click_mint!(member, msg, "approve")

      assert post(plain_conn(), cb_path(defer_reply), %{"type" => 5}).status == 200
      assert post(plain_conn(), cb_path(defer_update), %{"type" => 6}).status == 200

      late4 = post(plain_conn(), cb_path(defer_reply), %{"type" => 4, "data" => %{"content" => "late"}})
      assert late4.status == 400
      assert Jason.decode!(late4.resp_body)["code"] == 10_063

      late7 = post(plain_conn(), cb_path(defer_update), %{"type" => 7, "data" => %{"components" => []}})
      assert late7.status == 400
      assert Jason.decode!(late7.resp_body)["code"] == 10_063

      # Nothing posted from any of the failed legs.
      assert [%{}] = Messages.history(general.channel_id, limit: 1)
    end

    test "type-7 author-pin: a token claiming a message its application did not author → 404 10008, no edit", %{
      general: general,
      member: member,
      owner: owner,
      bot: bot,
      ws: ws
    } do
      # A store-level forgery (the pin is defense-in-depth — the mint can
      # never produce this state): the row is HUMAN-authored, the token
      # claims the bot.
      human_card = card!(general.channel_id, owner.user_id, [button_row(["approve"])])

      interaction_id = Cytale.Snowflake.next()

      :ok =
        Cytale.Interactions.TokenStore.put(interaction_id, "forged-pin-token", %{
          application_id: bot.user_id,
          workspace_id: ws.workspace_id,
          channel_id: general.channel_id,
          message_id: human_card.id,
          custom_id: "approve",
          component_type: 2,
          values: [],
          invoked_by: %{user_id: member.user_id, username: member.username}
        })

      conn =
        post(plain_conn(), "/api/v10/interactions/#{interaction_id}/forged-pin-token/callback", %{
          "type" => 7,
          "data" => %{"components" => [resolved_row("approve")]}
        })

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10_008
      assert Messages.get_message(general.channel_id, human_card.id).content == "card"
    end

    test "type-7 body-retarget is ignored: the TOKEN's target is edited", %{
      ws: ws,
      general: general,
      member: member,
      bot: bot
    } do
      {:ok, other} = Workspaces.create_channel(ws.workspace_id, "other")
      target = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      decoy = card!(other.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, target, "approve")

      conn =
        post(plain_conn(), cb_path(minted), %{
          "type" => 7,
          "channel_id" => Integer.to_string(other.channel_id),
          "message_id" => Integer.to_string(decoy.id),
          "data" => %{
            "channel_id" => Integer.to_string(other.channel_id),
            "message_id" => Integer.to_string(decoy.id),
            "components" => [resolved_row("approve")]
          }
        })

      assert conn.status == 200

      # The TOKEN's target flipped; the decoy is untouched.
      assert Messages.get_message(general.channel_id, target.id).components == [resolved_row("approve")]
      assert Messages.get_message(other.channel_id, decoy.id).components == [button_row(["approve"])]
    end

    test "type-7 rights-death: a bot restricted out of the channel after posting → 50001, no flip", %{
      ws: ws,
      general: general,
      member: member,
      owner: owner
    } do
      {:ok, allowed} = Workspaces.create_channel(ws.workspace_id, "bot-allowed")

      {:ok, restricted} =
        AgentGrants.mint_all(owner.user_id, :bot, run_unique("Restricted Responder"), %{
          "actions" => ["read", "post"],
          "channels" => [Integer.to_string(allowed.channel_id)]
        })

      # The card predates the restriction (modeled by the direct store write
      # the REST gate would now refuse).
      msg = card!(general.channel_id, restricted.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      conn =
        post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => [resolved_row("approve")]}})

      assert conn.status == 403
      assert Jason.decode!(conn.resp_body)["code"] == 50_001
      assert Messages.get_message(general.channel_id, msg.id).components == [button_row(["approve"])]
    end

    test "message deleted between mint and type-7 → 404 10008", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")
      :ok = Messages.delete_message(general.channel_id, msg.id)

      conn = post(plain_conn(), cb_path(minted), %{"type" => 7, "data" => %{"components" => []}})
      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10_008
    end

    test "DM click: type-4 posts into the DM and type-7 flips the DM card (the nil-workspace legs)", %{
      owner: owner,
      bot: bot
    } do
      {:ok, dm} = Workspaces.open_dm(owner.user_id, bot.user_id)
      msg = card!(dm.channel_id, bot.user_id, [button_row(["approve"])])

      reply_mint = click_mint!(owner, msg, "approve")
      assert post(plain_conn(), cb_path(reply_mint), %{"type" => 4, "data" => %{"content" => "dm reply"}}).status == 200
      assert [%{content: "dm reply", author_id: author_id}] = Messages.history(dm.channel_id, limit: 1)
      assert author_id == bot.user_id

      flip_mint = click_mint!(owner, msg, "approve")

      assert post(plain_conn(), cb_path(flip_mint), %{
               "type" => 7,
               "data" => %{"components" => [resolved_row("approve")]}
             }).status == 200

      assert Messages.get_message(dm.channel_id, msg.id).components == [resolved_row("approve")]
    end

    test "DM forgery: a token pointing into a DM its bot is not in → the anti-oracle 404", %{
      owner: owner,
      member: member,
      bot: bot
    } do
      # A DM between two OTHER users; the token claims the bot.
      {:ok, stranger_dm} = Workspaces.open_dm(owner.user_id, member.user_id)

      interaction_id = Cytale.Snowflake.next()

      :ok =
        Cytale.Interactions.TokenStore.put(interaction_id, "forged-dm-token", %{
          application_id: bot.user_id,
          workspace_id: nil,
          channel_id: stranger_dm.channel_id,
          message_id: Cytale.Snowflake.next(),
          custom_id: "approve",
          component_type: 2,
          values: [],
          invoked_by: %{user_id: owner.user_id, username: owner.username}
        })

      conn =
        post(plain_conn(), "/api/v10/interactions/#{interaction_id}/forged-dm-token/callback", %{
          "type" => 7,
          "data" => %{"components" => [resolved_row("approve")]}
        })

      assert conn.status == 404
      assert Jason.decode!(conn.resp_body)["code"] == 10_008
    end

    test "two concurrent type-7s (separate clicks): both 204, final state is EXACTLY one list (LWW, no mix)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      mint_a = click_mint!(member, msg, "approve")
      mint_b = click_mint!(member, msg, "approve")

      # The two payloads have DIFFERENT lengths — a stale-row mix would show
      # up as neither list surviving exactly.
      payload_a = [resolved_row("approve"), button_row(["extra-1"]), button_row(["extra-2"])]
      payload_b = [%{"type" => 1, "components" => [%{"type" => 2, "style" => 4, "custom_id" => "deny"}]}]

      post_a =
        Task.async(fn ->
          post(plain_conn(), cb_path(mint_a), %{"type" => 7, "data" => %{"components" => payload_a}})
        end)

      post_b =
        Task.async(fn ->
          post(plain_conn(), cb_path(mint_b), %{"type" => 7, "data" => %{"components" => payload_b}})
        end)

      assert Task.await(post_a).status == 200
      assert Task.await(post_b).status == 200

      final = Messages.get_message(general.channel_id, msg.id).components
      assert final in [payload_a, payload_b]
    end

    test "KTD10 per-application bucket: webhook-route flood 429s with Retry-After; another bot unaffected; the shared bucket also gates the callback route",
         %{
           general: general,
           member: member,
           owner: owner,
           bot: bot
         } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")
      assert post(plain_conn(), cb_path(minted), %{"type" => 5}).status == 200

      # A second bot interleaves mid-flood — its own bucket never trips.
      {:ok, other_bot} = AgentGrants.mint_all(owner.user_id, :bot, run_unique("Unaffected Bot"))
      other_card = card!(general.channel_id, other_bot.user_id, [button_row(["go"])])
      other_mint = click_mint!(member, other_card, "go")
      assert post(plain_conn(), cb_path(other_mint), %{"type" => 5}).status == 200

      statuses =
        for i <- 1..11 do
          conn = post(plain_conn(), fu_path(minted), %{"content" => "followup #{i}"})

          if i == 5 do
            assert post(plain_conn(), fu_path(other_mint), %{"content" => "other bot #{i}"}).status == 200
          end

          conn.status
        end

      # 10 posts fit the per-application bucket; the 11th is the 429.
      assert Enum.count(statuses, &(&1 == 200)) == 10
      assert Enum.count(statuses, &(&1 == 429)) == 1

      over = post(plain_conn(), fu_path(minted), %{"content" => "over"})
      assert over.status == 429
      assert %{"code" => 0, "global" => false, "retry_after" => retry_after} = Jason.decode!(over.resp_body)
      assert is_float(retry_after)
      assert Plug.Conn.get_resp_header(over, "retry-after") != []

      # The bucket is SHARED per bot across surfaces: a fresh token's type-4
      # from the SAME application is also gated (the other bot is not).
      fresh = click_mint!(member, msg, "approve")
      assert post(plain_conn(), cb_path(fresh), %{"type" => 4, "data" => %{"content" => "gated"}}).status == 429
    end

    test "bare /api alias serves the continuation routes and falls through to webhook execute unchanged", %{
      general: general,
      member: member,
      owner: owner,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")
      assert post(plain_conn(), cb_path(minted), %{"type" => 5}).status == 200

      # The bare alias followup POST (mounted in front of webhook execute).
      conn = post(plain_conn(), fu_path_bare(minted), %{"content" => "bare alias reply"})
      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["content"] == "bare alias reply"

      # @original under the bare alias too.
      original = get(plain_conn(), fu_path_bare(minted) <> "/messages/@original")
      assert original.status == 200

      # A GENUINE webhook pair on the same path shape still executes
      # (the fall-through is byte-identical webhook behavior).
      {:ok, webhook} = Cytale.Webhooks.create_webhook(general.channel_id, "Still Works", owner.user_id)

      hook =
        post(plain_conn(), "/api/webhooks/#{webhook.id}/#{webhook.token}", %{
          "content" => "webhook still executes"
        })

      assert hook.status == 204
      assert [%{content: "webhook still executes"}] = Messages.history(general.channel_id, limit: 1)
    end
  end

  # -- helpers -------------------------------------------------------------------

  describe "modals (#30)" do
    defp modal_data(extra_inputs \\ []) do
      %{
        "custom_id" => "feedback",
        "title" => "Tell us more",
        "components" =>
          [
            %{
              "type" => 1,
              "components" => [
                %{"type" => 4, "custom_id" => "subject", "style" => 1, "label" => "Subject", "max_length" => 20}
              ]
            },
            %{
              "type" => 1,
              "components" => [
                %{"type" => 4, "custom_id" => "details", "style" => 2, "label" => "Details", "required" => false}
              ]
            }
          ] ++ extra_inputs
      }
    end

    defp answers(pairs) do
      Enum.map(pairs, fn {id, value} ->
        %{"type" => 1, "components" => [%{"type" => 4, "custom_id" => id, "value" => value}]}
      end)
    end

    defp submit(user, minted, custom_id, components) do
      post(conn_for(user), "/api/v1/interactions", %{
        "kind" => "modal_submit",
        "interaction_id" => Integer.to_string(minted.interaction_id),
        "custom_id" => custom_id,
        "components" => components
      })
    end

    defp open_modal!(member, msg) do
      :ok =
        PushRegistry.subscribe(
          PushRegistry.user_key(Integer.to_string(member.user_id)),
          Integer.to_string(member.user_id)
        )

      minted = click_mint!(member, msg, "approve")
      conn = post(plain_conn(), cb_path(minted), %{"type" => 9, "data" => modal_data()})
      assert conn.status == 200
      minted
    end

    test "type 9 consumes the ack and delivers the NORMALIZED modal to the invoker's sessions", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = open_modal!(member, msg)

      assert_receive {:cytale_gateway_push, _, {"InteractionModal", modal}, _}, 2_000
      assert modal["interaction_id"] == Integer.to_string(minted.interaction_id)
      assert modal["custom_id"] == "feedback"
      assert modal["title"] == "Tell us more"

      assert [%{"components" => [subject]}, %{"components" => [details]}] = modal["components"]
      # Defaults are filled so the client never has to know Discord's.
      assert subject == %{
               "type" => 4,
               "custom_id" => "subject",
               "style" => 1,
               "label" => "Subject",
               "min_length" => 0,
               "max_length" => 20,
               "required" => true
             }

      assert details["required"] == false and details["max_length"] == 4000

      # The modal WAS the response: the single-use ack is gone.
      replay = post(plain_conn(), cb_path(minted), %{"type" => 4, "data" => %{"content" => "late"}})
      assert Jason.decode!(replay.resp_body)["code"] == 10_063
    end

    test "an invalid modal is 50035 and leaves the ack unspent", %{general: general, member: member, bot: bot} do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = click_mint!(member, msg, "approve")

      two_in_a_row = %{
        "type" => 1,
        "components" => [
          %{"type" => 4, "custom_id" => "a", "style" => 1, "label" => "A"},
          %{"type" => 4, "custom_id" => "b", "style" => 1, "label" => "B"}
        ]
      }

      for bad <- [
            %{modal_data() | "title" => String.duplicate("t", 46)},
            %{modal_data() | "components" => [two_in_a_row]},
            %{modal_data() | "components" => []},
            modal_data([Enum.at(modal_data()["components"], 0)]),
            put_in(modal_data(), ["components", Access.at(0), "components", Access.at(0), "style"], 3),
            put_in(modal_data(), ["components", Access.at(0), "components", Access.at(0), "min_length"], 30)
          ] do
        conn = post(plain_conn(), cb_path(minted), %{"type" => 9, "data" => bad})
        assert Jason.decode!(conn.resp_body)["code"] == 50_035, inspect(bad)
      end

      assert post(plain_conn(), cb_path(minted), %{"type" => 4, "data" => %{"content" => "ok"}}).status == 200
    end

    test "a submit mints MODAL_SUBMIT to the bot, in the modal's order, and its token can update the card", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = open_modal!(member, msg)

      bot_key = Integer.to_string(bot.user_id)
      :ok = PushRegistry.subscribe(PushRegistry.user_key(bot_key), bot_key)

      # Submitted out of order: the payload comes back in the MODAL's order.
      conn = submit(member, minted, "feedback", answers([{"details", ""}, {"subject", "Broken build"}]))
      assert conn.status == 202

      assert_receive {:cytale_gateway_push, _, {"InteractionCreate", %{"kind" => "modal_submit"} = p}, _}, 2_000
      assert p["custom_id"] == "feedback"
      assert p["message_id"] == Integer.to_string(msg.id)
      assert p["components"] == answers([{"subject", "Broken build"}, {"details", ""}])

      # The submit's own token targets the originating card (type 7).
      update =
        post(plain_conn(), "/api/v10/interactions/#{p["id"]}/#{p["token"]}/callback", %{
          "type" => 7,
          "data" => %{"content" => "thanks!"}
        })

      assert update.status == 200
      assert Messages.get_message(general.channel_id, msg.id).content == "thanks!"

      # A modal answers once.
      assert Jason.decode!(submit(member, minted, "feedback", answers([{"subject", "x"}, {"details", ""}])).resp_body)[
               "error"
             ]["key"] == "modal_unavailable"
    end

    test "only the invoker may submit; bad answers are refused WITHOUT burning the modal", %{
      general: general,
      member: member,
      owner: owner,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = open_modal!(member, msg)
      error_key = fn conn -> Jason.decode!(conn.resp_body)["error"]["key"] end

      # Someone else — same answer as an unknown modal (no oracle).
      assert error_key.(submit(owner, minted, "feedback", answers([{"subject", "x"}, {"details", ""}]))) ==
               "modal_unavailable"

      assert error_key.(submit(member, minted, "other-modal", answers([{"subject", "x"}, {"details", ""}]))) ==
               "modal_unavailable"

      for bad <- [
            # required left empty
            answers([{"subject", ""}, {"details", ""}]),
            # over max_length (20)
            answers([{"subject", String.duplicate("s", 21)}, {"details", ""}]),
            # a line break in a SHORT input
            answers([{"subject", "two\nlines"}, {"details", ""}]),
            # a field missing, and a field the modal never had
            answers([{"subject", "x"}]),
            answers([{"subject", "x"}, {"details", ""}, {"extra", "y"}])
          ] do
        conn = submit(member, minted, "feedback", bad)
        assert conn.status == 400
        assert error_key.(conn) == "validation_failed", inspect(bad)
      end

      # Still submittable — the refusals above did not consume it.
      assert submit(member, minted, "feedback", answers([{"subject", "ok"}, {"details", "a\nparagraph"}])).status ==
               202
    end

    test "a modal in answer to a modal submit is refused (Discord parity)", %{
      general: general,
      member: member,
      bot: bot
    } do
      msg = card!(general.channel_id, bot.user_id, [button_row(["approve"])])
      minted = open_modal!(member, msg)
      bot_key = Integer.to_string(bot.user_id)
      :ok = PushRegistry.subscribe(PushRegistry.user_key(bot_key), bot_key)

      assert submit(member, minted, "feedback", answers([{"subject", "x"}, {"details", ""}])).status == 202
      assert_receive {:cytale_gateway_push, _, {"InteractionCreate", %{"kind" => "modal_submit"} = p}, _}, 2_000

      again =
        post(plain_conn(), "/api/v10/interactions/#{p["id"]}/#{p["token"]}/callback", %{
          "type" => 9,
          "data" => modal_data()
        })

      assert Jason.decode!(again.resp_body)["code"] == 50_035
    end
  end

  defp principal_parent!(principal_id) do
    case Principals.get(principal_id) do
      %{parent_user_id: parent} -> parent
      _ -> flunk("principal #{principal_id} has no parent")
    end
  end
end
