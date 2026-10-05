defmodule CytaleWeb.Controllers.ReactionControllerTest do
  @moduledoc """
  The native reaction surface end-to-end: the six routes, idempotence (no
  event, no count move on re-add), the event seam (capture_log on
  Cytale.Publish.Log), the me-flag in message_json, manage_messages gates
  (403 for members, clears by the owner), the 20-emoji + emoji-validation
  400s, pagination cursors, machine-principal restrictions through the
  channel gate (typing-route seam), and the missing-message 404 oracle.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog
  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, Principals, User}
  alias Cytale.Test.AgentGrants
  alias Cytale.Messages.Reactions

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> Cytale.TestNonce.get()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, owner} = register_and_login(conn)
    ws_id = create_workspace(conn)
    ch_id = create_channel(conn, ws_id)

    msg = send_message(conn, ch_id, "react to me")

    {:ok, conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id, msg_id: msg}
  end

  defp reaction_path(ch_id, msg_id, emoji, suffix \\ "") do
    "/api/v1/channels/#{ch_id}/messages/#{msg_id}/reactions/#{URI.encode(emoji)}#{suffix}"
  end

  describe "add + remove own (PUT/DELETE @me)" do
    test "add → 204, count 1, MessageReactionAdd through the seam", %{
      conn: conn,
      ch_id: ch_id,
      msg_id: msg_id,
      owner: owner
    } do
      log =
        capture_log(fn ->
          assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionAdd"
      assert log =~ "\"emoji\" => \"👍\""
      assert log =~ "\"user_id\" => \"#{Integer.to_string(owner.user_id)}\""
      assert log =~ "\"message_id\" => \"#{msg_id}\""

      assert [%{emoji: "👍", count: 1}] = Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id))
    end

    test "idempotent re-add → 204, NO second event, count still 1", %{conn: conn, ch_id: ch_id, msg_id: msg_id} do
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      log =
        capture_log(fn ->
          assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      refute log =~ "MessageReactionAdd"
      assert [%{emoji: "👍", count: 1}] = Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id))
    end

    test "emoji arrives URL-DECODED (👍 round-trips through the path)", %{conn: conn, ch_id: ch_id, msg_id: msg_id} do
      assert conn |> put(reaction_path(ch_id, msg_id, "🔥", "/@me")) |> status() == 204
      assert [%{emoji: "🔥"}] = Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id))
    end

    test "remove → 204 + MessageReactionRemove; last remove drops the summary entirely", %{
      conn: conn,
      ch_id: ch_id,
      msg_id: msg_id
    } do
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      log =
        capture_log(fn ->
          assert conn |> delete(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionRemove"
      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
    end

    test "remove of an absent reaction → 204, no event", %{conn: conn, ch_id: ch_id, msg_id: msg_id} do
      log =
        capture_log(fn ->
          assert conn |> delete(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      refute log =~ "MessageReactionRemove"
    end
  end

  describe "counts across users + the me-flag in message_json" do
    setup %{conn: conn, owner: owner, ch_id: ch_id, msg_id: msg_id} do
      {:ok, reactor} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Reactor Agent"))
      {:ok, stranger} = AgentGrants.mint_all(owner.user_id, :agent, run_unique("Stranger Agent"))

      reactor_conn = agent_conn(reactor.token)
      stranger_conn = agent_conn(stranger.token)

      # Owner + reactor both add 👍; stranger adds 👀.
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert reactor_conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert stranger_conn |> put(reaction_path(ch_id, msg_id, "👀", "/@me")) |> status() == 204

      {:ok, reactor_conn: reactor_conn, stranger_conn: stranger_conn, reactor: reactor}
    end

    test "message_json reactions vary by viewer: me true for the reactor, false otherwise", %{
      conn: conn,
      stranger_conn: stranger_conn,
      ch_id: ch_id,
      msg_id: msg_id
    } do
      owner_view = history_message(conn, ch_id, msg_id)
      stranger_view = history_message(stranger_conn, ch_id, msg_id)

      assert %{"emoji" => "👍", "count" => 2, "me" => true} = find_reaction(owner_view, "👍")
      assert %{"emoji" => "👍", "count" => 2, "me" => false} = find_reaction(stranger_view, "👍")
      assert %{"emoji" => "👀", "count" => 1, "me" => true} = find_reaction(stranger_view, "👀")
      assert %{"emoji" => "👀", "count" => 1, "me" => false} = find_reaction(owner_view, "👀")
    end

    test "second user's remove → count 1 + event; key ABSENT when the last reaction dies", %{
      conn: conn,
      reactor_conn: reactor_conn,
      stranger_conn: stranger_conn,
      ch_id: ch_id,
      msg_id: msg_id
    } do
      log =
        capture_log(fn ->
          assert reactor_conn |> delete(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
        end)

      assert log =~ "event=MessageReactionRemove"

      view = history_message(conn, ch_id, msg_id)
      assert %{"emoji" => "👍", "count" => 1} = find_reaction(view, "👍")

      assert conn |> delete(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert stranger_conn |> delete(reaction_path(ch_id, msg_id, "👀", "/@me")) |> status() == 204

      refute Map.has_key?(history_message(conn, ch_id, msg_id), "reactions")
    end

    test "reaction-less messages keep the key ABSENT (additive growth only)", %{conn: conn, ch_id: ch_id} do
      plain = send_message(conn, ch_id, "no reactions here")
      refute Map.has_key?(history_message(conn, ch_id, plain), "reactions")
    end
  end

  describe "validation (400s)" do
    test "21st distinct emoji → 400 too_many_emojis; known emoji stays addable", %{
      conn: conn,
      ch_id: ch_id,
      msg_id: msg_id
    } do
      for i <- 0..19 do
        assert conn |> put(reaction_path(ch_id, msg_id, "🙂#{i}", "/@me")) |> status() == 204
      end

      conn21 = conn |> put(reaction_path(ch_id, msg_id, "🎉", "/@me"))
      assert status(conn21) == 400
      assert %{"error" => %{"key" => "too_many_emojis"}} = Jason.decode!(conn21.resp_body)

      # A known emoji is NOT a distinct add.
      assert conn |> put(reaction_path(ch_id, msg_id, "🙂0", "/@me")) |> status() == 204
    end

    test "invalid emoji: custom :name:, >14 bytes → 400 validation_failed", %{
      conn: conn,
      ch_id: ch_id,
      msg_id: msg_id
    } do
      # An EMPTY emoji cannot route at all (an empty path segment matches no
      # route — Phoenix's own 404); the reachable invalid forms render the
      # native 400 envelope. Empty-string validation is pinned at the layer
      # that sees it (Reactions.validate_emoji, context suite).
      for bad <- [":custom:", String.duplicate("🙂", 4)] do
        conn_bad = put(conn, reaction_path(ch_id, msg_id, bad, "/@me"))
        assert status(conn_bad) == 400, "expected 400 for #{inspect(bad)}"
        assert %{"error" => %{"key" => "validation_failed"}} = Jason.decode!(conn_bad.resp_body)
      end

      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
    end
  end

  describe "listing users (GET)" do
    setup %{conn: conn, owner: owner, ch_id: ch_id, msg_id: msg_id} do
      agents = for i <- 1..2, do: elem(AgentGrants.mint_all(owner.user_id, :agent, run_unique("List Agent #{i}")), 1)

      # Owner + two agents react 👍 (ascending user_id order is by snowflake).
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      Enum.each(agents, fn agent ->
        assert agent_conn(agent.token) |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      end)

      {:ok, agents: agents}
    end

    test "full page ascending; ?limit= + ?after= paginate by user_id", %{
      conn: conn,
      ch_id: ch_id,
      msg_id: msg_id,
      owner: owner,
      agents: agents
    } do
      all_ids = [owner.user_id | Enum.map(agents, & &1.user_id)] |> Enum.sort()

      full = conn |> get(reaction_path(ch_id, msg_id, "👍")) |> json()
      assert Enum.map(full["users"], &String.to_integer(&1["id"])) == all_ids
      assert full["next_after"] == nil

      page1 =
        conn
        |> get("/api/v1/channels/#{ch_id}/messages/#{msg_id}/reactions/#{URI.encode("👍")}?limit=2")
        |> json()

      assert length(page1["users"]) == 2
      assert page1["next_after"] == Integer.to_string(Enum.at(all_ids, 1))

      page2 =
        conn
        |> get(
          "/api/v1/channels/#{ch_id}/messages/#{msg_id}/reactions/#{URI.encode("👍")}?limit=2&after=#{page1["next_after"]}"
        )
        |> json()

      assert Enum.map(page2["users"], &String.to_integer(&1["id"])) == [List.last(all_ids)]
      assert page2["next_after"] == nil

      # Users render {id, username, …} entries.
      assert %{"id" => _, "username" => _} = hd(page1["users"])
    end

    test "unknown emoji → empty page", %{conn: conn, ch_id: ch_id, msg_id: msg_id} do
      body = conn |> get(reaction_path(ch_id, msg_id, "👀")) |> json()
      assert body["users"] == []
      assert body["next_after"] == nil
    end
  end

  describe "manage_messages gates (clears)" do
    setup %{conn: conn, ws_id: ws_id} do
      # A plain member (no manage_messages on the @everyone base) + their
      # agent for the machine-principal leg.
      invite_code = create_invite(conn, ws_id)
      {member_conn, member} = register_and_login(build_conn_with_headers())
      assert post(member_conn, "/api/v1/invites/#{invite_code}") |> status() == 200

      {:ok, member_conn: member_conn, member: member}
    end

    test "non-manager: clear-emoji / clear-all / remove-others → 403; manager → 204 with the Discord event split",
         %{conn: conn, member_conn: member_conn, member: member, ch_id: ch_id, msg_id: msg_id} do
      # The MEMBER reacts; the OWNER manages.
      assert member_conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert member_conn |> put(reaction_path(ch_id, msg_id, "👀", "/@me")) |> status() == 204

      # Non-manager denials (uniform 403 envelope).
      assert status(delete(member_conn, reaction_path(ch_id, msg_id, "👍"))) == 403
      assert status(delete(member_conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/reactions")) == 403

      assert status(delete(member_conn, reaction_path(ch_id, msg_id, "👍", "/#{member.user_id}"))) == 403

      # Manager per-user remove: ONE MessageReactionRemove for that user.
      log =
        capture_log(fn ->
          assert status(delete(conn, reaction_path(ch_id, msg_id, "👍", "/#{member.user_id}"))) == 204
        end)

      assert log =~ "event=MessageReactionRemove"
      assert log =~ "\"user_id\" => \"#{Integer.to_string(member.user_id)}\""

      # Manager emoji-clear of a NO-OP emoji: silent 204.
      log2 =
        capture_log(fn ->
          assert status(delete(conn, reaction_path(ch_id, msg_id, "🎉"))) == 204
        end)

      refute log2 =~ "MessageReaction"

      # Manager clear-ALL: exactly ONE MessageReactionRemoveAll.
      log3 =
        capture_log(fn ->
          assert status(delete(conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}/reactions")) == 204
        end)

      assert log3 =~ "event=MessageReactionRemoveAll"
      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
    end

    test "manager emoji-clear emits ONE MessageReactionRemove PER REMOVED USER (Discord's split)",
         %{conn: conn, member_conn: member_conn, member: member, ch_id: ch_id, msg_id: msg_id} do
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204
      assert member_conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      log =
        capture_log(fn ->
          assert status(delete(conn, reaction_path(ch_id, msg_id, "👍"))) == 204
        end)

      # Two users removed → two REMOVE payloads, never a REMOVE_ALL.
      assert log =~ "event=MessageReactionRemove"
      refute log =~ "MessageReactionRemoveAll"
      assert count_occurrences(log, "event=MessageReactionRemove ") == 2
      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
      _ = member
    end
  end

  describe "gates and oracles" do
    test "missing message → 404 message_not_found (consistent with the channel gate)",
         %{conn: conn, ch_id: ch_id} do
      bogus = Integer.to_string(Cytale.Snowflake.next())

      conn_put = put(conn, reaction_path(ch_id, bogus, "👍", "/@me"))
      assert status(conn_put) == 404
      assert %{"error" => %{"key" => "message_not_found"}} = Jason.decode!(conn_put.resp_body)

      conn_del = delete(conn, reaction_path(ch_id, bogus, "👍", "/@me"))
      assert status(conn_del) == 404

      conn404_get = get(conn, reaction_path(ch_id, bogus, "👍"))
      assert status(conn404_get) == 404

      conn404_clear = delete(conn, reaction_path(ch_id, bogus, "👍"))
      assert status(conn404_clear) == 404
    end

    test "unknown channel → 404 channel_not_found", %{conn: conn} do
      bogus_ch = Integer.to_string(Cytale.Snowflake.next())

      conn404 =
        put(conn, "/api/v1/channels/#{bogus_ch}/messages/#{Cytale.Snowflake.next()}/reactions/#{URI.encode("👍")}/@me")

      assert status(conn404) == 404
      assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn404.resp_body)
    end

    test "restricted agent: out-of-profile channel → the identical 404; in-profile → works",
         %{conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id} do
      {:ok, other} = Cytale.Workspaces.create_channel(String.to_integer(ws_id), run_unique("react-hidden"))

      {:ok, agent} =
        AgentGrants.mint_all(owner.user_id, :agent, run_unique("Scoped Reactor"), %{
          actions: ["read", "post"],
          channels: [ch_id]
        })

      scoped = agent_conn(agent.token)

      # In-profile: the add lands (parent fallback + allowlist).
      assert scoped |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      # Out-of-profile: the channel "does not exist" — identical 404 shape.
      other_msg = send_message(conn, Integer.to_string(other.channel_id), "in the other channel")

      out = scoped |> put(reaction_path(Integer.to_string(other.channel_id), other_msg, "👍", "/@me"))
      assert status(out) == 404
      assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(out.resp_body)
    end
  end

  describe "message delete cascades reactions" do
    test "delete message → both reaction tables empty", %{conn: conn, ch_id: ch_id, msg_id: msg_id} do
      assert conn |> put(reaction_path(ch_id, msg_id, "👍", "/@me")) |> status() == 204

      assert status(delete(conn, "/api/v1/channels/#{ch_id}/messages/#{msg_id}")) == 200

      assert Reactions.summary(String.to_integer(ch_id), String.to_integer(msg_id)) == []
      assert Reactions.list_users(String.to_integer(ch_id), String.to_integer(msg_id), "👍", limit: 100) == {[], nil}
    end
  end

  # -- helpers -------------------------------------------------------------------

  defp status(conn), do: conn.status

  defp json(conn), do: Jason.decode!(conn.resp_body)

  defp agent_conn(token) do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> token)
  end

  defp history_message(conn, ch_id, msg_id) do
    %{"messages" => messages} =
      get(conn, "/api/v1/channels/#{ch_id}/messages") |> json()

    Enum.find(messages, &(&1["id"] == msg_id))
  end

  defp find_reaction(message, emoji) do
    Enum.find(message["reactions"], &(&1["emoji"] == emoji))
  end

  defp count_occurrences(log, needle) do
    occurrences(log, needle, 0)
  end

  defp occurrences(log, needle, acc) do
    case :binary.split(log, needle) do
      [_, rest] -> occurrences(rest, needle, acc + 1)
      _ -> acc
    end
  end

  defp build_conn_with_headers do
    Phoenix.ConnTest.build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  defp register_and_login(conn) do
    username = "rx#{System.unique_integer([:positive, :monotonic])}#{System.system_time(:millisecond)}"
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

  defp send_message(conn, ch_id, content) do
    conn = post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => content})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["message"]["id"]
  end

  defp create_invite(conn, ws_id) do
    {:ok, invite} = Cytale.Workspaces.create_invite(String.to_integer(ws_id), 0, max_age_s: 600)
    invite.invite_code
  end
end
