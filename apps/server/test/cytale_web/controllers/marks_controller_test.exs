defmodule CytaleWeb.MarksControllerTest do
  @moduledoc """
  #54 U3 — the marks route family: set/list/cancel for the owner, gated
  exactly as strongly as reading the target, and invisible to everyone else.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  defp conn_for(user) do
    access = Auth.issue_access_token(user.user_id, user.username, true)

    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
    |> put_req_header("authorization", "Bearer " <> access)
  end

  defp body(conn), do: Jason.decode!(conn.resp_body)
  defp in_hours(h), do: DateTime.utc_now() |> DateTime.add(h * 3600, :second) |> DateTime.to_iso8601()
  defp path(ch, msg, kind \\ "snooze"), do: "/api/v1/users/@me/marks/#{kind}/channels/#{ch}/messages/#{msg}"

  setup do
    {:ok, owner} = User.create(run_unique("mk"), run_unique("mk@example.com"), "password-123")
    conn = conn_for(owner)
    ws_id = body(post(conn, "/api/v1/workspaces", %{"name" => run_unique("WS")}))["workspace"]["id"]

    ch_id =
      body(post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("chan")}))["channel"]["id"]

    msg_id = body(post(conn, "/api/v1/channels/#{ch_id}/messages", %{"content" => "come back to me"}))["message"]["id"]
    %{conn: conn, owner: owner, ws_id: ws_id, ch_id: ch_id, msg_id: msg_id}
  end

  test "set, list and cancel round-trip for the owner", %{conn: conn, ch_id: ch, msg_id: msg} do
    due = in_hours(2)
    res = put(conn, path(ch, msg), %{"due_at" => due})
    assert res.status == 200
    assert %{"kind" => "snooze", "channel_id" => ^ch, "message_id" => ^msg, "state" => "pending"} = body(res)["mark"]

    assert [%{"message_id" => ^msg, "due_at" => listed_due}] = body(get(conn, "/api/v1/users/@me/marks"))["marks"]
    {:ok, a, _} = DateTime.from_iso8601(listed_due)
    {:ok, b, _} = DateTime.from_iso8601(due)
    assert DateTime.diff(a, b, :millisecond) == 0

    assert delete(conn, path(ch, msg)).status == 204
    assert body(get(conn, "/api/v1/users/@me/marks"))["marks"] == []
    # A second cancel reveals nothing new.
    assert delete(conn, path(ch, msg)).status == 404
  end

  test "a re-set moves the due time instead of adding a mark", %{conn: conn, ch_id: ch, msg_id: msg} do
    assert put(conn, path(ch, msg), %{"due_at" => in_hours(1)}).status == 200
    assert put(conn, path(ch, msg), %{"due_at" => in_hours(5)}).status == 200
    assert [_one] = body(get(conn, "/api/v1/users/@me/marks"))["marks"]
  end

  test "validation: missing, malformed and past due_at; an unknown kind", %{conn: conn, ch_id: ch, msg_id: msg} do
    for due <- [nil, "tomorrow-ish", in_hours(-1)] do
      res = put(conn, path(ch, msg), %{"due_at" => due})
      assert res.status == 400, inspect(due)
      assert body(res)["error"]["key"] == "validation_failed"
    end

    res = put(conn, path(ch, msg, "pin-everything"), %{"due_at" => in_hours(1)})
    assert res.status == 400
  end

  test "one 404 for a missing channel, a missing message, and a message the caller cannot read", %{
    conn: conn,
    ch_id: ch,
    msg_id: msg
  } do
    {:ok, outsider} = User.create(run_unique("out"), run_unique("out@example.com"), "password-123")
    outsider_conn = conn_for(outsider)
    missing = Integer.to_string(Cytale.Snowflake.next())

    responses = [
      put(conn, path(missing, msg), %{"due_at" => in_hours(1)}),
      put(conn, path(ch, missing), %{"due_at" => in_hours(1)}),
      put(outsider_conn, path(ch, msg), %{"due_at" => in_hours(1)})
    ]

    assert Enum.map(responses, & &1.status) == [404, 404, 404]
    assert responses |> Enum.map(&body/1) |> Enum.uniq() |> length() == 1
    assert body(get(outsider_conn, "/api/v1/users/@me/marks"))["marks"] == []
  end

  test "privacy: another member's list never shows the owner's marks", %{
    conn: conn,
    owner: owner,
    ws_id: ws_id,
    ch_id: ch,
    msg_id: msg
  } do
    {:ok, peer} = User.create(run_unique("peer"), run_unique("peer@example.com"), "password-123")
    :ok = Cytale.Workspaces.add_member(String.to_integer(ws_id), peer.user_id, owner.user_id)

    assert put(conn, path(ch, msg), %{"due_at" => in_hours(1)}).status == 200
    assert body(get(conn_for(peer), "/api/v1/users/@me/marks"))["marks"] == []
    # And the peer cannot cancel the owner's mark (it is not theirs to find).
    assert delete(conn_for(peer), path(ch, msg)).status == 404
    assert [_] = body(get(conn, "/api/v1/users/@me/marks"))["marks"]
  end

  test "a restricted agent is refused through the shared gate; in-profile it keeps its own marks", %{
    owner: owner,
    ws_id: ws_id,
    ch_id: ch,
    msg_id: msg
  } do
    {:ok, other} = Cytale.Workspaces.create_channel(String.to_integer(ws_id), run_unique("hidden"))

    {:ok, hidden} =
      Cytale.Messages.create_message(%{
        channel_id: other.channel_id,
        author_id: owner.user_id,
        content: "hidden",
        thread_id: nil
      })

    {:ok, agent} =
      Cytale.Test.AgentGrants.mint_all(owner.user_id, :agent, run_unique("Mark Scoped"), %{
        actions: ["read", "post"],
        channels: [ch]
      })

    agent_conn =
      build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> put_req_header("authorization", "Bot " <> agent.token)

    out =
      put(agent_conn, path(Integer.to_string(other.channel_id), Integer.to_string(hidden.id)), %{
        "due_at" => in_hours(1)
      })

    assert out.status == 404
    assert put(agent_conn, path(ch, msg), %{"due_at" => in_hours(1)}).status == 200
    assert [%{"message_id" => ^msg}] = body(get(agent_conn, "/api/v1/users/@me/marks"))["marks"]
  end

  test "the list drops a mark whose channel the caller can no longer read", %{
    owner: owner,
    ws_id: ws_id,
    ch_id: ch,
    msg_id: msg
  } do
    {:ok, peer} = User.create(run_unique("leaver"), run_unique("leaver@example.com"), "password-123")
    ws = String.to_integer(ws_id)
    :ok = Cytale.Workspaces.add_member(ws, peer.user_id, owner.user_id)
    peer_conn = conn_for(peer)

    assert put(peer_conn, path(ch, msg), %{"due_at" => in_hours(1)}).status == 200
    assert [_] = body(get(peer_conn, "/api/v1/users/@me/marks"))["marks"]

    :ok = Cytale.Workspaces.remove_member(ws, peer.user_id)
    assert body(get(peer_conn, "/api/v1/users/@me/marks"))["marks"] == []
  end
end
