defmodule CytaleWeb.NotificationSelfTestControllerTest do
  @moduledoc """
  The member-scoped notification self-test — the settings surface's "send me a
  test notification" button.

  Two properties carry the whole design and both are asserted here: there is NO
  target parameter (so a member cannot notify anyone but themselves), and the
  response is a TRANSPORT report rather than a delivery verdict (the three
  failure modes have three different fixes, so they must stay distinguishable).
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}
  alias Cytale.Notifications.Delivery

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp auth(conn, user) do
    put_req_header(
      conn,
      "authorization",
      "Bearer " <> Auth.issue_access_token(user.user_id, user.username, true)
    )
  end

  defp base_conn do
    build_conn()
    |> put_req_header("accept", "application/json")
    |> put_req_header("content-type", "application/json")
  end

  setup do
    name = "selftest#{run_nonce()}"
    {:ok, user} = User.create(name, "#{name}@example.com", "password-123")
    %{user: user}
  end

  # No operator allowlist is configured in this suite, and none is needed:
  # being authenticated as yourself is the whole authorization.
  test "needs no operator gate — the member is the subject", %{user: user} do
    conn = base_conn() |> auth(user) |> post("/api/v1/users/@me/notifications/test", %{})

    assert conn.status == 200
  end

  test "an unauthenticated caller is refused" do
    assert post(base_conn(), "/api/v1/users/@me/notifications/test", %{}).status == 401
  end

  test "reports zero targets as a state, not an error", %{user: user} do
    conn = base_conn() |> auth(user) |> post("/api/v1/users/@me/notifications/test", %{})

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["targets"] == 0
    assert body["sent"] == 0
    assert body["note"] =~ "no push target"
  end

  test "sends to the caller's own registered target", %{user: user} do
    :ok =
      Cytale.Workspaces.put_push_subscription(
        user.user_id,
        "https://push.example.com/selftest",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    conn = base_conn() |> auth(user) |> post("/api/v1/users/@me/notifications/test", %{})

    assert conn.status == 200
    body = Jason.decode!(conn.resp_body)
    assert body["targets"] == 1
    assert is_list(body["outcomes"])
  end

  test "takes no target: a supplied user_id is ignored", %{user: user} do
    {:ok, other} = User.create("other#{run_nonce()}", "other#{run_nonce()}@example.com", "password-123")

    :ok =
      Cytale.Workspaces.put_push_subscription(
        other.user_id,
        "https://push.example.com/other",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    conn =
      base_conn()
      |> auth(user)
      |> post("/api/v1/users/@me/notifications/test", %{
        "user_id" => Integer.to_string(other.user_id)
      })

    assert conn.status == 200
    # The other member HAS a target, so a route that honoured `user_id` would
    # report 1. Zero proves the field is not read — which is the privacy
    # property, not an oversight.
    assert Jason.decode!(conn.resp_body)["targets"] == 0
    refute Map.has_key?(Jason.decode!(conn.resp_body), "user_id")
  end

  test "an empty or absent message falls back to the transport default", %{user: user} do
    for body <- [%{}, %{"message" => ""}] do
      conn = base_conn() |> auth(user) |> post("/api/v1/users/@me/notifications/test", body)
      assert conn.status == 200
    end
  end

  describe "the probe path itself" do
    # The transport report's shape is what the surface renders its three
    # different sentences from, so the keys are pinned here rather than only
    # through the controller.
    test "a member with no target gets a note and no outcomes" do
      result = Delivery.Push.send_probe(987_654_321_000_002)

      assert result.sent == 0
      assert result.targets == 0
      assert result.outcomes == []
      assert result.note =~ "no push target"
    end
  end
end
