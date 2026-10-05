defmodule CytaleWeb.Controllers.DmControllerTest do
  @moduledoc """
  U9 slice 3 — DM surface: list my DM channels, create a DM with a user.
  B-1 (bots): the `dms_of_user` index backs the list; the open paths are
  principal-aware (machine recipients work, machine↔machine is a 400,
  dedupe returns the SAME channel).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} = User.create(run_unique("dm_me"), run_unique("dm_me@example.com"), "password-123")
    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    {:ok, conn: conn, me: me}
  end

  test "create a DM with another user → 201 with channel id", %{conn: conn, me: me} do
    {:ok, other} = User.create(run_unique("dm_other"), run_unique("dm_other@example.com"), "password-123")

    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)
    conn = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert conn.status == 201

    body = Jason.decode!(conn.resp_body)
    assert body["channel"]["id"] != nil
  end

  test "listed DM channels include one just created; re-open returns the SAME channel", %{conn: conn, me: me} do
    {:ok, other} = User.create(run_unique("dm_other2"), run_unique("dm_other2@example.com"), "password-123")
    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)

    conn = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert conn.status == 201
    ch_id = Jason.decode!(conn.resp_body)["channel"]["id"]

    # The dms_of_user index backs the list (B-1): the participant sees it.
    conn = get(conn, "/api/v1/users/@me/channels")
    assert conn.status == 200
    list = Jason.decode!(conn.resp_body)["channels"]
    assert %{"id" => ^ch_id, "user_ids" => user_ids} = Enum.find(list, &(&1["id"] == ch_id))
    assert Enum.sort(user_ids) == Enum.sort([Integer.to_string(me.user_id), Integer.to_string(other.user_id)])

    # Re-open (either direction) fetches, not mints.
    reopened = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert reopened.status == 200
    assert Jason.decode!(reopened.resp_body)["channel"]["id"] == ch_id
  end

  test "a human can open a DM with a machine principal (B-1)", %{conn: conn, me: me} do
    {:ok, bot} = AgentGrants.mint_all(me.user_id, :bot, run_unique("Dm Target Bot"))

    conn = post(conn, "/api/v1/users/#{bot.user_id}/channels", %{})
    assert conn.status == 201
    assert Jason.decode!(conn.resp_body)["channel"]["id"] != nil
  end

  test "machine ↔ machine DM is refused unless BOTH agents accept everyone", %{conn: conn, me: me} do
    {:ok, bot} = AgentGrants.mint_all(me.user_id, :bot, run_unique("Dm Bot"))
    {:ok, agent} = AgentGrants.mint_all(me.user_id, :agent, run_unique("Dm Agent"))

    conn = post(conn, "/api/v1/users/#{bot.user_id}/channels", %{})
    assert conn.status == 201
    bot_dm = Jason.decode!(conn.resp_body)["channel"]["id"]

    # The BOT opens a DM with another machine principal via the native
    # surface (its own Bearer credential is the parent's JWT; use the
    # parent's token with the AGENT as recipient and the bot as opener via
    # the compat path instead — here assert the guard on open_dm directly).
    # The pair guard is now the DM-support policy (owner direction 2026-09-15):
    # both sides default to :humans, so two machines still cannot message each
    # other — the refusal is a policy one, not a kind error.
    assert {:error, :dm_not_permitted} = Cytale.Workspaces.open_dm(bot.user_id, agent.user_id)

    assert is_binary(bot_dm)
  end

  test "two agents at :everyone may open a DM with each other", %{me: me} do
    {:ok, bot} = AgentGrants.mint_all(me.user_id, :bot, run_unique("Everyone Bot"))
    {:ok, agent} = AgentGrants.mint_all(me.user_id, :agent, run_unique("Everyone Agent"))

    AgentGrants.grant(bot, %{AgentGrants.all_access() | dm_support: :everyone})
    AgentGrants.grant(agent, %{AgentGrants.all_access() | dm_support: :everyone})

    assert {:ok, %{created?: true}} = Cytale.Workspaces.open_dm(bot.user_id, agent.user_id)
  end

  test "an agent at :none refuses a human's DM with 403", %{conn: conn, me: me} do
    {:ok, bot} = AgentGrants.mint_all(me.user_id, :bot, run_unique("Closed Bot"))
    AgentGrants.grant(bot, %{AgentGrants.all_access() | dm_support: :none})

    conn = post(conn, "/api/v1/users/#{bot.user_id}/channels", %{})
    assert conn.status == 403
    assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "does not accept direct messages"
  end

  test "an agent at :everyone accepts a human's DM", %{conn: conn, me: me} do
    {:ok, bot} = AgentGrants.mint_all(me.user_id, :bot, run_unique("Open Bot"))
    AgentGrants.grant(bot, %{AgentGrants.all_access() | dm_support: :everyone})

    conn = post(conn, "/api/v1/users/#{bot.user_id}/channels", %{})
    assert conn.status == 201
  end

  test "create DM with unknown user → 404", %{conn: conn} do
    conn = post(conn, "/api/v1/users/123456789012345678/channels", %{})
    assert conn.status == 404
  end

  test "unauthenticated list → 401", %{me: me} do
    anon = Phoenix.ConnTest.build_conn() |> put_req_header("accept", "application/json")
    conn = get(anon, "/api/v1/users/@me/channels")
    assert conn.status == 401

    assert me.user_id > 0
  end

  # #94's permission-denied state: opening a DM MINTS a conversation, so the
  # write gate (RequireVerified on :content_mutation) refuses an unverified
  # caller before the handler ever runs — the picker surfaces this envelope.
  test "unverified caller cannot open a DM → 403 account_unverified", %{me: me} do
    {:ok, other} = User.create(run_unique("dm_unv"), run_unique("dm_unv@example.com"), "password-123")
    unverified = Auth.issue_access_token(me.user_id, me.username, false)

    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bearer " <> unverified)
      |> post("/api/v1/users/#{other.user_id}/channels", %{})

    assert conn.status == 403
    assert %{"error" => %{"key" => "account_unverified"}} = Jason.decode!(conn.resp_body)
  end

  # Recipients widening (avatar render pass): DM payloads carry the OTHER
  # participant as a full user summary so the DM column renders peer
  # identity + avatar with no roster dependency.
  test "create + list carry recipients (peer summary with avatar_url)", %{conn: conn, me: me} do
    {:ok, other} = User.create(run_unique("dm_peer"), run_unique("dm_peer@example.com"), "password-123")

    :ok =
      Cytale.Accounts.User.update_profile!(other.user_id, nil, "/api/v1/attachments/deadbeef")

    Cytale.Test.SharedWorkspace.share!(me.user_id, other.user_id)

    conn = post(conn, "/api/v1/users/#{other.user_id}/channels", %{})
    assert conn.status == 201

    body = Jason.decode!(conn.resp_body)
    ch_id = body["channel"]["id"]

    assert [%{"id" => id, "username" => username, "avatar_url" => avatar}] = body["channel"]["recipients"]

    assert id == Integer.to_string(other.user_id)
    assert username == other.username
    assert avatar == "/api/v1/attachments/deadbeef"

    # The list view carries the same shape (and never includes the viewer).
    listed = get(conn, "/api/v1/users/@me/channels")
    assert listed.status == 200

    [%{"recipients" => listed_recipients}] = Jason.decode!(listed.resp_body)["channels"]
    assert [%{"id" => id2}] = listed_recipients
    assert id2 == Integer.to_string(other.user_id)
    refute id2 == Integer.to_string(me.user_id)

    # GET /channels/:id (participant view) carries it too.
    shown = get(conn, "/api/v1/channels/#{ch_id}")
    assert shown.status == 200
    assert [%{"id" => ^id2, "username" => ^username}] = Jason.decode!(shown.resp_body)["channel"]["recipients"]
  end
end
