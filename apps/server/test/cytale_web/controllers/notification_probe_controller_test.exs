defmodule CytaleWeb.NotificationProbeControllerTest do
  @moduledoc """
  The operator notification probe.

  Built because answering "can this member be notified at all" previously took
  four deploys and a remote console session. Its value is that it names WHICH of
  the silent failure modes is in play — no target, a dead endpoint, a signing
  problem — because each has a different fix.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Notifications.WebPush.Transport

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp auth(conn, user) do
    put_req_header(conn, "authorization", "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true))
  end

  defp base_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  setup do
    {:ok, user} = User.create("probe#{run_nonce()}", "probe#{run_nonce()}@example.com", "password-123")
    %{user: user}
  end

  describe "the operator gate" do
    # Fail-closed: no allowlist configured means nobody is an operator. This is
    # the same boundary the rest of the admin tier rides, and it is the reason
    # this route does not need its own guard.
    test "an authenticated NON-operator is refused", %{user: user} do
      conn = base_conn() |> auth(user)

      assert post(conn, "/api/v1/admin/notifications/test", %{}).status in [403, 404]
    end

    test "an unauthenticated caller is refused" do
      assert post(base_conn(), "/api/v1/admin/notifications/test", %{}).status == 401
    end
  end

  describe "with the caller as operator" do
    # The allowlist is resolved at boot into app config, so the test sets that
    # rather than an environment variable (which runtime.exs only reads once).
    setup %{user: user} do
      previous = Application.get_env(:cytale, :operator_user_ids)
      Application.put_env(:cytale, :operator_user_ids, [user.user_id])

      on_exit(fn -> Application.put_env(:cytale, :operator_user_ids, previous || []) end)

      :ok
    end

    # The outcome that IS the answer: a member with no push target will never
    # be notified, and that is a diagnosis rather than an error.
    test "reports zero targets rather than failing", %{user: user} do
      conn = base_conn() |> auth(user) |> post("/api/v1/admin/notifications/test", %{})

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["targets"] == 0
      assert body["sent"] == 0
      assert body["note"] =~ "no push target"
    end

    test "sends to a registered target and reports it", %{user: user} do
      :ok =
        Cytale.Workspaces.put_push_subscription(
          user.user_id,
          "https://push.example.com/probe",
          Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
        )

      conn = base_conn() |> auth(user) |> post("/api/v1/admin/notifications/test", %{})

      assert conn.status == 200
      body = Jason.decode!(conn.resp_body)
      assert body["targets"] == 1
      assert body["user_id"] == Integer.to_string(user.user_id)
    end

    test "accepts a target member by id", %{user: user} do
      {:ok, other} = User.create("probeb#{run_nonce()}", "probeb#{run_nonce()}@example.com", "password-123")

      conn =
        base_conn()
        |> auth(user)
        |> post("/api/v1/admin/notifications/test", %{"user_id" => Integer.to_string(other.user_id)})

      assert conn.status == 200
      assert Jason.decode!(conn.resp_body)["user_id"] == Integer.to_string(other.user_id)
    end

    test "an unknown target is a 404 rather than a silent success", %{user: user} do
      conn =
        base_conn()
        |> auth(user)
        |> post("/api/v1/admin/notifications/test", %{"user_id" => "999999999999999999"})

      assert conn.status == 404
    end

    test "a malformed target id is refused", %{user: user} do
      conn =
        base_conn()
        |> auth(user)
        |> post("/api/v1/admin/notifications/test", %{"user_id" => "not-a-snowflake"})

      assert conn.status == 400
    end
  end

  describe "the probe path itself" do
    test "no target is reported as a state, never as an error" do
      result = Cytale.Notifications.Delivery.Push.send_probe(987_654_321_000_001)

      assert result.sent == 0
      assert result.targets == 0
      assert result.note =~ "no push target"
    end
  end
end
