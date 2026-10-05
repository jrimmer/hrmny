defmodule CytaleWeb.Controllers.CallControllerTest do
  @moduledoc """
  Voice plan U4 — the REST call surface: GET /channels/:id/call (standing
  thread anchor, live call + roster, recently-ended boundary markers) and
  PATCH /channels/:id/call-notification-mute (AM6's durable ring mute). The
  uniform channel gate renders the identical 404 anti-enumeration shape for
  non-viewers and non-participants; DM channels authorize by participation.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Calls

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {conn, user} = register_and_login(conn)
    ws_id = create_workspace(conn)
    {:ok, conn: conn, user: user, ws_id: ws_id}
  end

  defp register_and_login(conn) do
    {:ok, user} = User.create(run_unique("call_user"), run_unique("call@example.com"), "password-123")
    access = Auth.issue_access_token(user.user_id, user.username, true)
    {put_req_header(conn, "authorization", "Bearer " <> access), user}
  end

  defp create_workspace(conn) do
    conn = post(conn, "/api/v1/workspaces", %{"name" => run_unique("Call WS")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["workspace"]["id"]
  end

  defp create_channel(conn, ws_id) do
    conn = post(conn, "/api/v1/workspaces/#{ws_id}/channels", %{"name" => run_unique("general")})
    assert conn.status == 201
    Jason.decode!(conn.resp_body)["channel"]["id"]
  end

  # A stand-in session process the room monitors (the gateway socket's shape).
  defp spawn_session do
    spawn(fn ->
      receive do
        :stop -> :ok
      end
    end)
  end

  test "a published SOURCE rides the REST read too (plan 6.5)", %{conn: conn, ws_id: ws_id, user: user} do
    # The REST projection used to hand-roll `user_id`/`mute`/`deafen`, so the V2
    # published-source list the CALL_SYNC dispatch carries was invisible to every
    # TypeScript consumer of the REST shape. Both now come from the ONE roster
    # builder (`Cytale.Calls.Events.roster_entry/1`).
    ch_id = create_channel(conn, ws_id)
    channel_id = String.to_integer(ch_id)

    session = spawn_session()
    {:ok, %{action: :started}} = Calls.start_call(channel_id, user.user_id, session)

    {:ok, :ok} = Cytale.Calls.Room.publish(Calls.room_pid(channel_id), user.user_id, :camera)

    conn = get(conn, "/api/v1/channels/#{ch_id}/call")
    assert conn.status == 200

    [entry] = Jason.decode!(conn.resp_body)["live"]["participants"]
    assert entry["user_id"] == Integer.to_string(user.user_id)
    assert [%{"source" => "camera", "since" => since}] = entry["sources"]
    assert is_binary(since)

    # …and a participant with NO published source keeps the V1 three-field shape
    # (the field is additive, never `sources: []`).
    {:ok, :ok} = Cytale.Calls.Room.unpublish(Calls.room_pid(channel_id), user.user_id, :camera)

    conn = get(conn, "/api/v1/channels/#{ch_id}/call")
    [plain] = Jason.decode!(conn.resp_body)["live"]["participants"]
    refute Map.has_key?(plain, "sources")

    :ok = Calls.leave_call(channel_id, user.user_id)
  end

  test "GET before any call: nulls and empty lists, always present", %{conn: conn, ws_id: ws_id} do
    ch_id = create_channel(conn, ws_id)

    conn = get(conn, "/api/v1/channels/#{ch_id}/call")
    assert conn.status == 200
    assert %{"thread_id" => nil, "live" => nil, "recently_ended" => []} = Jason.decode!(conn.resp_body)
  end

  test "GET mid-call: live roster + the standing thread; recently-ended after it closes", %{
    conn: conn,
    ws_id: ws_id,
    user: user
  } do
    ch_id = create_channel(conn, ws_id)
    channel_id = String.to_integer(ch_id)

    session = spawn_session()
    {:ok, %{action: :started}} = Calls.start_call(channel_id, user.user_id, session)

    conn = get(conn, "/api/v1/channels/#{ch_id}/call")
    assert conn.status == 200

    body = Jason.decode!(conn.resp_body)
    assert body["thread_id"]
    thread_id = body["thread_id"]

    assert %{"call_id" => call_id, "started_by" => started_by, "started_at" => _, "participants" => roster} =
             body["live"]

    assert started_by == Integer.to_string(user.user_id)
    assert [%{"user_id" => ^started_by, "mute" => false, "deafen" => false}] = roster

    # End the call (leave + the empty sweep under a short window here) and
    # the boundary marker appears.
    old_calls = Application.get_env(:cytale, :calls)
    Application.put_env(:cytale, :calls, empty_sweep_ms: 200)

    :ok = Calls.leave_call(channel_id, user.user_id)

    deadline = System.monotonic_time(:millisecond) + 5_000

    assert wait_ended(
             fn ->
               conn = get(conn, "/api/v1/channels/#{ch_id}/call")
               body = Jason.decode!(conn.resp_body)
               # U9 (documented contract): the standing-thread anchor is
               # durable — it survives the call's end (idle channels still
               # return it; the mapping, not the live room, is the source).
               body["thread_id"] == thread_id and
                 match?([%{"call_id" => ^call_id, "reason" => "last_left"}], body["recently_ended"])
             end,
             deadline
           )

    Application.put_env(:cytale, :calls, old_calls || [])
  end

  defp wait_ended(fun, deadline) do
    if fun.() do
      true
    else
      if System.monotonic_time(:millisecond) >= deadline do
        false
      else
        Process.sleep(25)
        wait_ended(fun, deadline)
      end
    end
  end

  test "GET 404s for a non-member (anti-enumeration)", %{conn: conn, ws_id: ws_id} do
    ch_id = create_channel(conn, ws_id)

    {conn2, _outsider} =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> register_and_login()

    conn2 = get(conn2, "/api/v1/channels/#{ch_id}/call")
    assert conn2.status == 404
    assert %{"error" => %{"key" => "channel_not_found"}} = Jason.decode!(conn2.resp_body)
  end

  test "DM channel: participant reads nulls (no rows exist); non-participant 404s", %{conn: conn, user: user} do
    {conn2, other} =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> register_and_login()

    {:ok, dm} = Cytale.Workspaces.open_dm(user.user_id, other.user_id)

    conn = get(conn, "/api/v1/channels/#{dm.channel_id}/call")
    assert conn.status == 200
    assert %{"thread_id" => nil, "live" => nil, "recently_ended" => []} = Jason.decode!(conn.resp_body)

    {conn3, _stranger} =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")
      |> register_and_login()

    conn3 = get(conn3, "/api/v1/channels/#{dm.channel_id}/call")
    assert conn3.status == 404
  end

  test "PATCH call-notification-mute sets and clears the durable ring mute", %{conn: conn, ws_id: ws_id, user: user} do
    ch_id = create_channel(conn, ws_id)
    channel_id = String.to_integer(ch_id)

    conn = patch(conn, "/api/v1/channels/#{ch_id}/call-notification-mute", %{"muted" => true})
    assert conn.status == 200
    assert %{"muted" => true} = Jason.decode!(conn.resp_body)
    assert Calls.notification_muted?(user.user_id, channel_id)

    conn = patch(conn, "/api/v1/channels/#{ch_id}/call-notification-mute", %{"muted" => false})
    assert conn.status == 200
    assert %{"muted" => false} = Jason.decode!(conn.resp_body)
    refute Calls.notification_muted?(user.user_id, channel_id)

    # Validation and anti-enumeration shapes.
    conn = patch(conn, "/api/v1/channels/#{ch_id}/call-notification-mute", %{"muted" => "yes"})
    assert conn.status == 400

    conn = patch(conn, "/api/v1/channels/#{Cytale.Snowflake.next()}/call-notification-mute", %{"muted" => true})
    assert conn.status == 404
  end

  describe "GET /calls/ice (voice plan U12 — ICE-config delivery)" do
    test "authenticated: no TURN configured → empty list, always-present key", %{conn: conn} do
      conn = get(conn, "/api/v1/calls/ice")
      assert conn.status == 200
      assert %{"ice_servers" => []} = Jason.decode!(conn.resp_body)
    end

    test "authenticated: minted TURN entry when the secret mode is configured", %{conn: conn} do
      secret = "controller-test-turn-secret-0123456789"
      original = Application.get_env(:cytale, :calls)
      Application.put_env(:cytale, :calls, turn: %{url: "turn:turn.cytale.test:3478", secret: secret})

      conn = get(conn, "/api/v1/calls/ice")
      assert conn.status == 200

      assert %{
               "ice_servers" => [
                 %{
                   "urls" => "turn:turn.cytale.test:3478",
                   "username" => username,
                   "credential" => credential
                 }
               ]
             } = Jason.decode!(conn.resp_body)

      # The client-visible pair is exactly the mint derivation — and the
      # static secret never ships.
      now = System.os_time(:second)
      expiry = String.to_integer(username)
      # ~1h window, mint-on-read
      assert (expiry - now) in 3_000..4_200
      assert credential == Base.encode64(:crypto.mac(:hmac, :sha, secret, username))
      refute conn.resp_body =~ secret

      Application.put_env(:cytale, :calls, original)
    end

    test "unauthenticated → 401 (the ICE config is principal-scoped)" do
      conn =
        Phoenix.ConnTest.build_conn()
        |> put_req_header("accept", "application/json")
        |> get("/api/v1/calls/ice")

      assert conn.status == 401
    end
  end
end
