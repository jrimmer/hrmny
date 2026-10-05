defmodule CytaleWeb.GatewayPrincipalTeardownTest do
  @moduledoc """
  U4 (bots plan) — live-socket teardown over the real gateway wire (KTD6):

    * revocation / regeneration / parent-deletion close the principal's live
      sessions with 4004 (dead credential — non-reconnectable) AND purge the
      stored session records so Resume cannot resurrect them;
    * restriction-profile changes tear down through the RECONNECTABLE
      Reconnect signal instead (a 4004 would brick every live bot client —
      Discord client libraries treat 4004 as fatal), forcing the fresh
      Identify the narrowing depends on: compat sockets see op 7 (Discord's
      server-sent Reconnect; 6 is the client Resume on that wire), and the
      stored records are PURGED so a post-teardown Resume cannot resurrect
      the pre-narrowing profile;
    * SELF-deletion closes the deleting account's OWN sessions with the same
      4004 (the parent-deletion case above only covers the SUB-credentials the
      cascade revokes) — the tombstone and the death of that account's sockets
      are one instant, the teardown is principal-scoped (a peer's socket in the
      same workspace keeps working), and re-deleting is a no-op.

  Teardown is driven through the REST surface exactly as production would
  (DELETE/PATCH the machine principal; delete the parent account) — never by
  poking the store directly.
  """

  use Cytale.GatewayCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Deletion, User}
  alias Cytale.Workspaces
  alias CytaleWeb.Compat.GatewayDialect

  @endpoint CytaleWeb.Endpoint

  setup_all do
    # The gateway suite does not boot through ScyllaCase; the pool + schema
    # are run-wide (test_helper.exs) — only the Snowflake cell needs re-arming
    # in case another module cleared persistent_term.
    :ok = Cytale.Snowflake.ensure_init()
    :ok
  end

  setup do
    port = start_gateway!()

    nonce = Cytale.TestNonce.get()

    {:ok, owner} =
      User.create("teardown_owner#{nonce}", "teardown_owner#{nonce}@example.com", "password-123")

    access = Auth.issue_access_token(owner.user_id, owner.username, true)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> access)

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "teardown-ws-#{nonce}")

    {:ok, port: port, conn: conn, owner: owner, ws_id: ws.workspace_id}
  end

  defp mint_agent!(conn, name) do
    conn = post(conn, "/api/v1/bots", %{"name" => name})
    assert conn.status == 201
    %{"id" => id, "token" => token} = Jason.decode!(conn.resp_body)

    # An agent STARTS with no access (agent model, R6). This suite's subject is
    # session teardown, not permissions, so grant the "everything my owner can
    # reach" document through the API's own write path.
    granted =
      patch(conn, "/api/v1/bots/#{id}", %{
        "access" => %{"v" => 1, "workspaces" => %{"mode" => "all", "level" => "read_write"}}
      })

    assert granted.status == 200
    %{id: id, token: token}
  end

  # U5: a machine principal's Identify now joins the PARENT's workspace
  # routes (R1), so the agent's join self-announce reaches its own socket
  # right after READY — same as a human's. Swallow queued dispatches so the
  # teardown assertions below start from a deterministic empty mailbox.
  defp drain_announces!(conn) do
    case next_frame(conn, 300) do
      {:ok, _json} -> drain_announces!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  describe "revocation teardown (R2 wire-instant)" do
    test "DELETE agent: live socket observes 4004, resume refused, next REST 401", %{
      port: port,
      conn: conn
    } do
      agent = mint_agent!(conn, "Live Agent")

      gw = connect!(port)
      ready = identify!(gw, agent.token)
      assert ready["user"]["id"] == agent.id
      drain_announces!(gw)

      conn = delete(conn, "/api/v1/bots/#{agent.id}")
      assert conn.status == 204

      # The live session closes 4004 (auth failed — non-reconnectable).
      assert assert_closed!(gw, 5_000) == 4004

      # Resume cannot resurrect: the stored record was purged AND the token
      # itself is dead — the resume path authenticates first, so a dead
      # credential gets InvalidSession(false) then close 4000.
      gw2 = connect!(port)

      send_frame!(gw2, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => ready["resume_token"]
      })

      code = assert_closed!(gw2, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000

      # The next REST call with the dead credential is a plain 401.
      dead = authed_conn("Bot " <> agent.token)
      assert get(dead, "/api/v1/users/@me").status == 401
    end

    test "regenerate: old sessions close 4004; the new token works", %{port: port, conn: conn} do
      agent = mint_agent!(conn, "Rotating Agent")

      gw = connect!(port)
      identify!(gw, agent.token)
      drain_announces!(gw)

      conn = post(conn, "/api/v1/bots/#{agent.id}/regenerate")
      assert conn.status == 201
      %{"token" => new_token} = Jason.decode!(conn.resp_body)
      assert new_token != agent.token
      assert String.starts_with?(new_token, "cytbot_")

      # Old credential's live session: closed 4004 immediately.
      assert assert_closed!(gw, 5_000) == 4004

      # The old token no longer authenticates; the new one does.
      assert get(authed_conn("Bot " <> agent.token), "/api/v1/users/@me").status == 401

      me = get(authed_conn("Bot " <> new_token), "/api/v1/users/@me")
      assert me.status == 200
      assert Jason.decode!(me.resp_body)["user"]["id"] == agent.id
    end

    test "in-flight REST request completes across a revocation", %{conn: conn} do
      agent = mint_agent!(conn, "Inflight Agent")

      # A read issued with the still-live credential, then revoked mid-flight:
      # revocation bounds the NEXT action — the in-flight call completes.
      me =
        Task.async(fn ->
          get(authed_conn("Bot " <> agent.token), "/api/v1/users/@me")
        end)

      conn = delete(conn, "/api/v1/bots/#{agent.id}")
      assert conn.status == 204

      assert {:ok, me_conn} = Task.yield(me, 5_000)
      assert me_conn.status in [200]
    end
  end

  describe "restriction-profile teardown (R3 — Reconnect, never 4004)" do
    # A REAL message row through the REAL native projection + fan-out seam —
    # exactly what a REST post delivers in production.
    defp post_message!(channel_id, author_id, content) do
      {:ok, msg} =
        Cytale.Messages.create_message(%{channel_id: channel_id, author_id: author_id, content: content})

      payload = CytaleWeb.MessageController.message_json(msg)
      {msg, Cytale.Workspaces.FanOut.deliver(channel_id, {"MessageCreate", payload})}
    end

    test "PATCH restrictions: compat socket receives op-7 Reconnect (not 4004); Resume refused (records purged); fresh Identify enforces the narrowed profile",
         %{port: port, conn: conn, ws_id: ws_id, owner: owner} do
      # Two channels: `keep` stays in the narrowed profile, `drop` leaves it.
      {:ok, keep} = Workspaces.create_channel(ws_id, "teardown-keep-#{System.unique_integer()}")
      {:ok, drop} = Workspaces.create_channel(ws_id, "teardown-drop-#{System.unique_integer()}")

      # The name carries the run nonce: the mint derives a unique-per-server
      # TAG from it, and other suites also mint a bare "Scoped Agent".
      agent = mint_agent!(conn, "Scoped Agent" <> Cytale.TestNonce.get())

      gw = connect!(port, v: 10)
      # intents: the full supported set — a lifecycle-only (intents 0) compat
      # session would legitimately drop the message events asserted below.
      ready = identify!(gw, agent.token, v: 10, intents: 2561)
      assert ready["user"]["id"] == agent.id
      drain_announces!(gw)

      # Unrestricted profile: both channels' events flow.
      {_, _} = post_message!(keep.channel_id, owner.user_id, "keep before")
      assert next_json!(gw, 5_000)["d"]["content"] == "keep before"
      {_, _} = post_message!(drop.channel_id, owner.user_id, "drop before")
      assert next_json!(gw, 5_000)["d"]["content"] == "drop before"

      # The grant narrows to `keep` only. It rides the access DOCUMENT now —
      # the restrictions column is no longer authoritative for a machine
      # principal (agent model, U2/U5).
      conn =
        patch(conn, "/api/v1/bots/#{agent.id}", %{
          "access" => %{
            "v" => 1,
            "workspaces" => %{
              "mode" => "custom",
              "grants" => %{
                Integer.to_string(ws_id) => %{
                  "level" => "none",
                  "channels" => %{Integer.to_string(keep.channel_id) => "read"}
                }
              }
            }
          }
        })

      assert conn.status == 200

      # The still-valid credential's socket gets the RECONNECTABLE signal —
      # op 7 for a compat session (Discord's wire reserves 6 for the CLIENT
      # Resume; A2) — then a normal close. Never 4004.
      assert next_json!(gw, 5_000) == %{"op" => 7}
      assert assert_closed!(gw, 5_000) == 1000

      # A1(b): the teardown PURGED the stored record — a Resume (even with
      # the unspent token from READY) is refused with Invalid Session
      # (resumable false): the client must re-Identify, never resurrect the
      # pre-narrowing restrictions frozen in the stored record.
      assert SessionStore.get(ready["session_id"]) == nil

      gw_resume = connect!(port, v: 10)

      send_frame!(gw_resume, 5, %{
        "token" => agent.token,
        "session_id" => ready["session_id"],
        "seq" => 0,
        "resume_token" => ready["resume_token"]
      })

      code = assert_closed!(gw_resume, 5_000, [%{"op" => 9, "d" => false}])
      assert code == 4000

      # Fresh Identify with the SAME token works…
      gw2 = connect!(port, v: 10)
      ready2 = identify!(gw2, agent.token, v: 10, intents: 2561)
      assert ready2["user"]["id"] == agent.id

      # …and the narrowed profile is enforced ON THE WIRE: the GUILD_CREATE
      # carries only the in-profile channel…
      guild = next_json!(gw2, 5_000)
      assert guild["t"] == "GUILD_CREATE"

      guild_channel_ids = guild["d"]["channels"] |> Enum.map(& &1["id"]) |> MapSet.new()
      assert Integer.to_string(keep.channel_id) in guild_channel_ids
      refute Integer.to_string(drop.channel_id) in guild_channel_ids

      drain_announces!(gw2)

      # …out-of-profile events never arrive, in-profile ones still do.
      {_, _} = post_message!(drop.channel_id, owner.user_id, "drop after")
      assert {:error, :timeout} == Cytale.Test.WSClient.recv(gw2.pid, 400)

      {_, _} = post_message!(keep.channel_id, owner.user_id, "keep after")
      assert next_json!(gw2, 5_000)["d"]["content"] == "keep after"

      # …and the narrowed profile applies at the permission level. The
      # assertion is CHANNEL-scoped because that is how the grant expresses
      # "this channel only": the workspace level is `none` and the kept channel
      # carries `:read` (the old flat allowlist had no workspace axis).
      claims = %{
        user_id: String.to_integer(agent.id),
        kind: :agent,
        parent_user_id: owner.user_id,
        access: Cytale.Accounts.Principals.get(String.to_integer(agent.id)).access
      }

      {:ok, keep_bits} = Cytale.Permissions.Principal.resolve(ws_id, claims, keep.channel_id)
      assert Cytale.Permissions.Bitfield.has?(keep_bits, :view_channel)
      assert Cytale.Permissions.Bitfield.has?(keep_bits, :read_message_history)
      refute Cytale.Permissions.Bitfield.has?(keep_bits, :send_messages)

      {:ok, drop_bits} = Cytale.Permissions.Principal.resolve(ws_id, claims, drop.channel_id)
      refute Cytale.Permissions.Bitfield.has?(drop_bits, :view_channel)
    end

    # KTD4's passive half. The socket's identity carries the access document
    # AS OF IDENTIFY; a live socket's visible-set memo is refreshed when a
    # rights epoch moves, and it must recompute against the CURRENT document
    # rather than that snapshot — otherwise a grant change would only take
    # effect at the next Identify, and a session that slipped through the
    # teardown's enumeration window would keep its old reach.
    test "KTD4: an epoch move makes a live memo recompute against the CURRENT document",
         %{conn: conn, ws_id: ws_id, owner: owner} do
      {:ok, keep} = Workspaces.create_channel(ws_id, "memo-keep-#{System.unique_integer()}")
      {:ok, drop} = Workspaces.create_channel(ws_id, "memo-drop-#{System.unique_integer()}")

      agent = mint_agent!(conn, "Memo Agent")
      agent_row = Cytale.Accounts.Principals.get(String.to_integer(agent.id))

      # The identity a live session would hold: the granted snapshot, taken
      # here and deliberately NOT updated afterwards.
      identity = %{
        id: agent.id,
        kind: :agent,
        parent_id: owner.user_id,
        access: agent_row.access
      }

      memo = GatewayDialect.refresh_visibility(nil, identity)
      assert channel_visible?(memo, ws_id, keep.channel_id)
      assert channel_visible?(memo, ws_id, drop.channel_id)

      # The same write the PATCH performs: the document narrows to `keep`, then
      # the epoch moves (the write path does both).
      access =
        Cytale.Access.parse!(%{
          "v" => 1,
          "workspaces" => %{
            "mode" => "custom",
            "grants" => %{
              Integer.to_string(ws_id) => %{
                "level" => "none",
                "channels" => %{Integer.to_string(keep.channel_id) => "read"}
              }
            }
          }
        })

      :ok = Cytale.Accounts.Principals.update_access(String.to_integer(agent.id), access)
      Cytale.Permissions.RightsEpoch.bump(ws_id)

      # No re-Identify, no rejoin poke, and the STALE identity: the epoch move
      # alone must be enough for the narrowed document to take force.
      refreshed = GatewayDialect.refresh_visibility(memo, identity)

      assert channel_visible?(refreshed, ws_id, keep.channel_id)
      refute channel_visible?(refreshed, ws_id, drop.channel_id)
    end

    defp channel_visible?(memo, ws_id, channel_id) do
      case Map.get(memo, ws_id) do
        {_epoch, set} -> MapSet.member?(set, channel_id)
        _ -> false
      end
    end

    test "PATCH name only: no session teardown", %{port: port, conn: conn} do
      agent = mint_agent!(conn, "Renamed Agent")

      gw = connect!(port)
      identify!(gw, agent.token)
      drain_announces!(gw)

      conn = patch(conn, "/api/v1/bots/#{agent.id}", %{"name" => "Renamed Again"})
      assert conn.status == 200

      # Name changes never touch sessions: the link stays live and answers
      # heartbeats (silence, not close, is the assertion).
      send_frame!(gw, 1, nil)
      assert next_op!(gw, 11, 5_000)
    end
  end

  describe "parent-deletion cascade (integration)" do
    test "parent delete revokes sub-credentials and closes their live sockets 4004", %{
      port: port,
      conn: conn
    } do
      agent = mint_agent!(conn, "Cascade Agent")

      gw = connect!(port)
      identify!(gw, agent.token)
      drain_announces!(gw)

      conn = delete(conn, "/api/v1/account")
      assert conn.status == 202

      # The sweep is async: the sub-credential dies and its live socket
      # closes 4004 (wire-instant once the cascade runs).
      assert assert_closed!(gw, 10_000) == 4004

      assert get(authed_conn("Bot " <> agent.token), "/api/v1/users/@me").status == 401
    end
  end

  # -- self-deletion: the account's OWN socket -----------------------------------
  #
  # The parent-deletion case above covers the deleting user's SUB-credentials.
  # These cover the deleting user's own principal: `DELETE /api/v1/account`
  # tombstones the account, and the tombstone and the death of that account's
  # live sockets must be the same instant — otherwise a deleted principal keeps
  # a working socket (and keeps receiving dispatches) until it happens to
  # disconnect. Driven through the REST surface exactly as production does.
  describe "self-deletion cascade (the deleting account's OWN sessions)" do
    # The account's own socket carries a REAL human identity: the teardown keys
    # on the account's user id, and the :test default human_impl Stub binds a
    # token to a synthetic phash id — which cannot express "this socket belongs
    # to THIS account". Prod/dev already run the JWT impl (test.exs points
    # :human_impl at the Stub); the per-test swap is the door
    # CytaleWeb.Calls.GatewayOpsTest uses. Every case in this suite is
    # async: false, so the app-env swap cannot race a peer module.
    setup do
      old_impl = Application.get_env(:cytale, :human_impl)
      Application.put_env(:cytale, :human_impl, Cytale.Gateway.Authenticator.JWT)
      on_exit(fn -> Application.put_env(:cytale, :human_impl, old_impl) end)
      :ok
    end

    test "DELETE /api/v1/account closes the account's OWN socket 4004 (record purged, no further dispatch)",
         %{port: port, conn: conn, owner: owner, ws_id: ws_id} do
      {:ok, ch} = Workspaces.create_channel(ws_id, unique("self-delete"))

      gw = connect!(port)
      ready = identify!(gw, access_for(owner))
      assert ready["user"]["id"] == Integer.to_string(owner.user_id)
      drain_announces!(gw)

      # Pre-condition (the control): the account's own session is live AND
      # routed — a real dispatch reaches it. Without this, "no dispatch after
      # deletion" would be indistinguishable from a socket that was never
      # subscribed in the first place.
      {_, _} = post_message!(ch.channel_id, owner.user_id, "before deletion")
      assert next_event!(gw, "MessageCreate", 5_000)["d"]["content"] == "before deletion"

      conn = delete(conn, "/api/v1/account")
      assert conn.status == 202

      # The closure is the DOCUMENTED dead-credential teardown code — 4004, the
      # one revoke/regenerate/parent-delete use — not a bare 1000: the
      # credential is dead and non-reconnectable, so a Discord-shaped client
      # must not reconnect (1000 would tell it to).
      assert assert_closed!(gw, 5_000) == 4004

      # The stored record went with the close, so Resume cannot resurrect the
      # session — the principal index drops the dead socket as its terminate
      # unwinds.
      assert SessionStore.get(ready["session_id"]) == nil
      wait_until(fn -> SessionStore.principal_sessions(owner.user_id) == [] end)

      # And a subsequent dispatch has nowhere to land: the fan-out to the
      # channel the (now deleted) account was subscribed to reaches nothing.
      payload = %{"id" => "9", "channel_id" => Integer.to_string(ch.channel_id)}
      Cytale.Workspaces.FanOut.deliver(ch.channel_id, {"MessageCreate", payload})
      assert {:closed, 4004} = Cytale.Test.WSClient.recv(gw.pid, 400)
    end

    test "deleting twice, and deleting an account with no live session, is a no-op (never raises)",
         %{port: port, conn: conn, owner: owner} do
      gw = connect!(port)
      ready = identify!(gw, access_for(owner))
      drain_announces!(gw)

      assert delete(conn, "/api/v1/account").status == 202
      assert assert_closed!(gw, 5_000) == 4004
      assert SessionStore.get(ready["session_id"]) == nil

      # The same account again, sweep run IN THE CALLER: an already-tombstoned
      # account has nothing left to tear down, so every step — the session
      # teardown included — must be a no-op rather than a raise. The async
      # production path would swallow a raise into the failure counter, which
      # is exactly how "deletion is idempotent" would rot unnoticed.
      assert :ok = Deletion.delete_account(owner.user_id, sync: true)
      assert SessionStore.principal_sessions(owner.user_id) == []

      # And an account that never had a session at all.
      name = unique("no_sessions")
      {:ok, fresh} = User.create(name, name <> "@example.com", "password-123")
      assert :ok = Deletion.delete_account(fresh.user_id, sync: true)
      assert %{deleted_at: %DateTime{}} = User.get(fresh.user_id)
    end

    test "another member's live socket in the same workspace is untouched", %{
      port: port,
      conn: conn,
      owner: owner,
      ws_id: ws_id
    } do
      {:ok, ch} = Workspaces.create_channel(ws_id, unique("collateral"))
      peer = member!(ws_id, owner, "collateral_peer")

      gw_owner = connect!(port)
      identify!(gw_owner, access_for(owner))
      drain_announces!(gw_owner)

      gw_peer = connect!(port)
      ready_peer = identify!(gw_peer, access_for(peer))
      drain_announces!(gw_peer)

      # Both sessions are live and routed on the same channel before the
      # deletion — the same-workspace shape the blast radius is measured in.
      {_, _} = post_message!(ch.channel_id, owner.user_id, "both before")
      assert next_event!(gw_owner, "MessageCreate", 5_000)["d"]["content"] == "both before"
      assert next_event!(gw_peer, "MessageCreate", 5_000)["d"]["content"] == "both before"

      assert delete(conn, "/api/v1/account").status == 202
      assert assert_closed!(gw_owner, 5_000) == 4004

      # The peer is not in the blast radius: the teardown is PRINCIPAL-scoped,
      # so its index row and its stored record survive the neighbouring
      # account's deletion ...
      assert SessionStore.principal_sessions(peer.user_id) != []
      assert SessionStore.get(ready_peer["session_id"]) != nil

      # ... and it still receives dispatches on the wire afterwards.
      {_, _} = post_message!(ch.channel_id, peer.user_id, "both after")
      assert next_event!(gw_peer, "MessageCreate", 5_000)["d"]["content"] == "both after"
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp access_for(user), do: Auth.issue_access_token(user.user_id, user.username, true)

  defp unique(base), do: base <> Cytale.TestNonce.get()

  # A second REAL account in `ws_id` (a plain member — @everyone grants
  # view+send), for the collateral pin.
  defp member!(ws_id, owner, base) do
    name = unique(base)
    {:ok, user} = User.create(name, name <> "@example.com", "password-123")
    :ok = Workspaces.add_member(ws_id, user.user_id, owner.user_id, [])
    user
  end

  # Poll for an effect that is deliberately asynchronous (a socket's terminate
  # unwinding after the close frame is already on the wire).
  defp wait_until(fun, tries \\ 50)
  defp wait_until(_fun, 0), do: flunk("condition not met in time")

  defp wait_until(fun, tries) do
    if fun.() do
      :ok
    else
      Process.sleep(20)
      wait_until(fun, tries - 1)
    end
  end

  defp authed_conn(authorization) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", authorization)
  end
end
