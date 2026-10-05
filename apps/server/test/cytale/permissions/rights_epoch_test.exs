defmodule Cytale.Permissions.RightsEpochTest do
  @moduledoc """
  U3 (bots plan, KTD4) — the rights-epoch primitive: a long-lived GenServer
  owning a named ETS :set (`workspace_id → monotonic int`), with a bump wired
  at EVERY rights/membership mutation site — role create/update/delete +
  grant/revoke, channel overwrite put/delete, member kick, workspace delete,
  invite accept (member add), and the account-deletion membership cascade
  (bump per affected workspace). Consumers (U7's visibility memo, later)
  compare memoized epochs against `current/1` and recompute on any move.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Deletion, User}
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Workspaces

  @endpoint CytaleWeb.Endpoint

  # make_ref() makes every nonce call-unique (the time-only nonce used
  # elsewhere can collide within a time bucket — never contribute to that).
  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup_all do
    # The app tree owns the epoch GenServer; start a supervised one only for
    # standalone runs of this file.
    if is_nil(GenServer.whereis(RightsEpoch)) do
      start_supervised!(RightsEpoch)
    end

    :ok
  end

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, owner} =
      User.create(run_unique("ep_owner"), run_unique("ep_owner@example.com"), "password-123")

    access = Auth.issue_access_token(owner.user_id, owner.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Epoch WS")})
    assert conn.status == 201
    ws_id = Jason.decode!(conn.resp_body)["workspace"]["id"]

    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    ch_id = Jason.decode!(conn.resp_body)["channel"]["id"]

    {:ok, conn: conn, ws_id: ws_id, ch_id: ch_id, owner: owner}
  end

  describe "the epoch primitive" do
    test "bump increments monotonically per workspace and current/1 reads it back" do
      ws = Cytale.Snowflake.next()

      a = RightsEpoch.bump(ws)
      b = RightsEpoch.bump(ws)
      c = RightsEpoch.bump(ws)

      assert a < b and b < c
      assert RightsEpoch.current(ws) == c
    end

    test "epochs are independent per workspace" do
      ws_a = Cytale.Snowflake.next()
      ws_b = Cytale.Snowflake.next()

      a0 = RightsEpoch.current(ws_a)
      b0 = RightsEpoch.current(ws_b)

      bumped = RightsEpoch.bump(ws_b)

      assert bumped > b0
      assert RightsEpoch.current(ws_b) == bumped
      assert RightsEpoch.current(ws_a) == a0
    end

    test "current/1 of a never-bumped workspace reads 0" do
      assert RightsEpoch.current(Cytale.Snowflake.next()) == 0
    end

    test "bump notifies subscribers (voice plan U4, AM3) with the new epoch" do
      ws = Cytale.Snowflake.next()
      :ok = RightsEpoch.subscribe(ws, self())

      epoch = RightsEpoch.bump(ws)
      assert_receive {:rights_epoch_bumped, ^ws, ^epoch}, 1_000

      # Unrelated workspaces' bumps are not delivered to this subscriber…
      other_ws = Cytale.Snowflake.next()
      RightsEpoch.bump(other_ws)
      refute_receive {:rights_epoch_bumped, ^other_ws, _}, 100

      # …and unsubscribe stops the feed.
      :ok = RightsEpoch.unsubscribe(ws, self())
      RightsEpoch.bump(ws)
      refute_receive {:rights_epoch_bumped, ^ws, _}, 100
    end

    test "a dead subscriber is pruned at the next bump without erroring" do
      ws = Cytale.Snowflake.next()
      dead = spawn(fn -> receive(do: (:stop -> :ok)) end)
      :ok = RightsEpoch.subscribe(ws, dead)
      :ok = RightsEpoch.subscribe(ws, self())
      ref = Process.monitor(dead)
      send(dead, :stop)

      receive do
        {:DOWN, ^ref, :process, _, _} -> :ok
      end

      # The bump prunes the dead entry and still notifies the live one.
      assert RightsEpoch.bump(ws) > 0
      assert_receive {:rights_epoch_bumped, ^ws, _}, 1_000
    end
  end

  describe "mutation sites bump their workspace epoch" do
    test "role create → update → delete each bump", %{conn: conn, ws_id: ws_id} do
      ws = String.to_integer(ws_id)
      before = RightsEpoch.current(ws)

      conn = post(conn, "/api/v1/workspaces/#{ws_id}/roles", %{"name" => run_unique("Epoch Role")})
      assert conn.status == 201
      after_create = RightsEpoch.current(ws)
      assert after_create > before
      role_id = Jason.decode!(conn.resp_body)["role"]["id"]

      conn = patch(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}", %{"name" => run_unique("Renamed")})
      assert conn.status == 200
      after_update = RightsEpoch.current(ws)
      assert after_update > after_create

      conn = delete(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role_id}")
      assert conn.status == 200
      assert RightsEpoch.current(ws) > after_update
    end

    test "role grant → revoke → re-grant each bump", %{conn: conn, ws_id: ws_id, owner: owner} do
      ws = String.to_integer(ws_id)
      {:ok, role} = Workspaces.create_role(ws, run_unique("Grantable"), permissions: 0, position: 1)
      before = RightsEpoch.current(ws)

      conn =
        put(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role.role_id}/members/#{owner.user_id}", %{})

      assert conn.status == 200
      after_grant = RightsEpoch.current(ws)
      assert after_grant > before

      conn = delete(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role.role_id}/members/#{owner.user_id}")
      assert conn.status == 200
      after_revoke = RightsEpoch.current(ws)
      assert after_revoke > after_grant

      # Re-grant bumps again.
      conn =
        put(conn, "/api/v1/workspaces/#{ws_id}/roles/#{role.role_id}/members/#{owner.user_id}", %{})

      assert conn.status == 200
      assert RightsEpoch.current(ws) > after_revoke
    end

    test "overwrite put → delete each bump", %{conn: conn, ws_id: ws_id, ch_id: ch_id, owner: owner} do
      ws = String.to_integer(ws_id)
      before = RightsEpoch.current(ws)

      conn =
        put(conn, "/api/v1/channels/#{ch_id}/overwrites", %{
          "target_type" => "member",
          "target_id" => Integer.to_string(owner.user_id),
          "allow" => [],
          "deny" => ["send_messages"]
        })

      assert conn.status == 200
      after_put = RightsEpoch.current(ws)
      assert after_put > before

      conn = delete(conn, "/api/v1/channels/#{ch_id}/overwrites/#{owner.user_id}")
      assert conn.status == 200
      assert RightsEpoch.current(ws) > after_put
    end

    test "invite accept (member add) bumps; kick bumps again", %{conn: conn, ws_id: ws_id} do
      ws = String.to_integer(ws_id)
      {:ok, invite} = Workspaces.create_invite(ws, 0, max_age_s: 600)

      {:ok, joiner} =
        User.create(run_unique("ep_join"), run_unique("ep_join@example.com"), "password-123")

      access = Auth.issue_access_token(joiner.user_id, joiner.username, true)

      join_conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> put_req_header("content-type", "application/json")
        |> put_req_header("authorization", "Bearer " <> access)

      before = RightsEpoch.current(ws)
      join_conn = post(join_conn, "/api/v1/invites/#{invite.invite_code}")
      assert join_conn.status == 200
      after_join = RightsEpoch.current(ws)
      assert after_join > before

      conn = delete(conn, "/api/v1/workspaces/#{ws_id}/members/#{joiner.user_id}")
      assert conn.status == 200
      assert RightsEpoch.current(ws) > after_join
    end

    test "workspace delete (membership sweep) bumps", %{conn: conn} do
      conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Doomed")})
      assert conn.status == 201
      ws_id = Jason.decode!(conn.resp_body)["workspace"]["id"]
      ws = String.to_integer(ws_id)

      before = RightsEpoch.current(ws)
      conn = delete(conn, "/api/v1/workspaces/#{ws_id}")
      assert conn.status == 200
      assert RightsEpoch.current(ws) > before
    end

    test "account-deletion cascade bumps EVERY affected workspace" do
      {:ok, doomed} =
        User.create(run_unique("ep_doomed"), run_unique("ep_doomed@example.com"), "password-123")

      {:ok, ws1} = Workspaces.create_workspace(doomed.user_id, run_unique("Owns"))

      {:ok, other} =
        User.create(run_unique("ep_other"), run_unique("ep_other@example.com"), "password-123")

      {:ok, ws2} = Workspaces.create_workspace(other.user_id, run_unique("Hosts"))
      :ok = Workspaces.add_member(ws2.workspace_id, doomed.user_id, other.user_id, [])

      before1 = RightsEpoch.current(ws1.workspace_id)
      before2 = RightsEpoch.current(ws2.workspace_id)

      # run_sweep is the cascade body (delete_account spawns it); calling the
      # body directly keeps the bump assertion deterministic.
      :ok = Deletion.run_sweep(doomed.user_id)

      assert RightsEpoch.current(ws1.workspace_id) > before1
      assert RightsEpoch.current(ws2.workspace_id) > before2
    end
  end
end
