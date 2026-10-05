defmodule CytaleWeb.Controllers.PushControllerTest do
  @moduledoc """
  U9 slice 3 — web-push subscription surface (edit #6): create/delete per
  user; endpoint dedup by subscription_hash.
  """

  use Cytale.ScyllaCase, async: false

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Accounts.{Auth, User}

  @endpoint CytaleWeb.Endpoint

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_unique(base), do: base <> run_nonce()

  setup do
    conn =
      Phoenix.ConnTest.build_conn()
      |> put_req_header("accept", "application/json")
      |> put_req_header("content-type", "application/json")

    {:ok, me} = User.create(run_unique("push_user"), run_unique("push_user@example.com"), "password-123")
    access = Auth.issue_access_token(me.user_id, me.username, true)
    conn = put_req_header(conn, "authorization", "Bearer " <> access)

    {:ok, conn: conn, me: me}
  end

  @endpoint_url "https://push.example.com/sub/abc123"

  test "create a subscription → 201 with the stored endpoint", %{conn: conn} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => @endpoint_url,
        "keys" => %{"p256dh" => "k1", "auth" => "a1"}
      })

    assert conn.status == 201
    assert %{"registered" => true} = Jason.decode!(conn.resp_body)
  end

  test "re-creating the same endpoint is idempotent (dedup), not a duplicate", %{conn: conn} do
    for _ <- 1..2 do
      conn =
        post(conn, "/api/v1/users/@me/push-subscriptions", %{
          "endpoint" => @endpoint_url,
          "keys" => %{"p256dh" => "k1", "auth" => "a1"}
        })

      assert conn.status == 201
    end
  end

  test "delete removes the subscription", %{conn: conn} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => @endpoint_url,
        "keys" => %{"p256dh" => "k1", "auth" => "a1"}
      })

    assert conn.status == 201

    conn = delete(conn, "/api/v1/users/@me/push-subscriptions", %{"endpoint" => @endpoint_url})
    assert conn.status == 200
  end

  test "missing endpoint → 400 validation_failed", %{conn: conn} do
    conn = post(conn, "/api/v1/users/@me/push-subscriptions", %{"keys" => %{"p256dh" => "k"}})
    assert conn.status == 400
  end

  # ---------------------------------------------------------------------------
  # S1 — the SSRF guard: a web endpoint is a client-chosen URL that delivery
  # POSTs to verbatim, so it must name a public https push service on 443.
  # The default test resolver (config/test.exs → Cytale.PushResolverStub)
  # answers every name with a public TEST-NET address; refusals are exercised
  # by injecting a resolver that resolves somewhere private (the house
  # put_env + restore pattern) or by IP literals, which never consult DNS.
  # ---------------------------------------------------------------------------

  defmodule LoopbackResolver do
    def resolve(_host), do: {:ok, [{127, 0, 0, 1}]}
  end

  defmodule LinkLocalResolver do
    def resolve(_host), do: {:ok, [{169, 254, 169, 254}]}
  end

  defmodule PrivateResolver do
    def resolve(_host), do: {:ok, [{10, 1, 2, 3}, {192, 0, 2, 10}]}
  end

  defmodule UnresolvableResolver do
    def resolve(_host), do: {:error, :nxdomain}
  end

  test "an http endpoint is refused (scheme), nothing stored", %{conn: conn, me: me} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "http://push.example.com/sub/1",
        "keys" => %{"p256dh" => "k", "auth" => "a"}
      })

    assert conn.status == 400
    assert %{"error" => %{"key" => "validation_failed", "message" => msg}} = Jason.decode!(conn.resp_body)
    assert msg =~ "scheme"
    assert Cytale.Notifications.Subscriptions.list_for_user(me.user_id) == []
  end

  test "a non-443 port is refused (the session-bridge port among them)", %{conn: conn} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "http://127.0.0.1:4100/bridge",
        "keys" => %{"p256dh" => "k", "auth" => "a"}
      })

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "scheme"

    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "https://push.example.com:8443/sub",
        "keys" => %{"p256dh" => "k", "auth" => "a"}
      })

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "port"
  end

  test "a literal loopback endpoint is refused without consulting DNS", %{conn: conn} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "https://127.0.0.1/sub",
        "keys" => %{"p256dh" => "k", "auth" => "a"}
      })

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "blocked_address"
  end

  test "a literal link-local endpoint (the metadata address) is refused", %{conn: conn} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "https://169.254.169.254/latest/meta-data/",
        "keys" => %{"p256dh" => "k", "auth" => "a"}
      })

    assert conn.status == 400
    assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "blocked_address"
  end

  test "a hostname that RESOLVES to loopback is refused", %{conn: conn, me: me} do
    with_resolver(&LoopbackResolver.resolve/1, fn ->
      conn =
        post(conn, "/api/v1/users/@me/push-subscriptions", %{
          "endpoint" => "https://push.example.com/sub/loopback",
          "keys" => %{"p256dh" => "k", "auth" => "a"}
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "blocked_address"
      assert Cytale.Notifications.Subscriptions.list_for_user(me.user_id) == []
    end)
  end

  test "a hostname resolving to the metadata address is refused", %{conn: conn} do
    with_resolver(&LinkLocalResolver.resolve/1, fn ->
      conn =
        post(conn, "/api/v1/users/@me/push-subscriptions", %{
          "endpoint" => "https://push.example.com/sub/metadata",
          "keys" => %{"p256dh" => "k", "auth" => "a"}
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "blocked_address"
    end)
  end

  test "ANY private address in the answer refuses the endpoint (round-robin hostile record)", %{
    conn: conn
  } do
    with_resolver(&PrivateResolver.resolve/1, fn ->
      conn =
        post(conn, "/api/v1/users/@me/push-subscriptions", %{
          "endpoint" => "https://push.example.com/sub/mixed",
          "keys" => %{"p256dh" => "k", "auth" => "a"}
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "blocked_address"
    end)
  end

  test "a host that does not resolve is refused, and a mobile target is never URL-guarded", %{
    conn: conn,
    me: me
  } do
    with_resolver(&UnresolvableResolver.resolve/1, fn ->
      conn =
        post(conn, "/api/v1/users/@me/push-subscriptions", %{
          "endpoint" => "https://push.example.com/sub/gone",
          "keys" => %{"p256dh" => "k", "auth" => "a"}
        })

      assert conn.status == 400
      assert Jason.decode!(conn.resp_body)["error"]["message"] =~ "unresolvable"
    end)

    # A device token is not a URL — the guard must not reject it.
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "target_type" => "mobile",
        "endpoint" => "ExponentPushToken[not-a-url]",
        "keys" => %{"token" => "ExponentPushToken[not-a-url]"}
      })

    assert conn.status == 201
    assert [%{target_type: "mobile"}] = Cytale.Notifications.Subscriptions.list_for_user(me.user_id)
  end

  # The guard's seam takes a `/1` FUN (`resolve/1`'s contract), not a module.
  # Accepts a resolver module or the resolve fun itself: the two shapes met in
  # a merge (callers pass `&Mod.resolve/1`, adf5782; the helper had been
  # narrowed to modules, 08b30b4), and every SSRF case failed on the clause.
  defp with_resolver(resolver, fun) when is_atom(resolver),
    do: with_resolver(&resolver.resolve/1, fun)

  defp with_resolver(resolver, fun) when is_function(resolver, 1) do
    previous = Application.get_env(:cytale, :push_endpoint_resolver)
    Application.put_env(:cytale, :push_endpoint_resolver, resolver)

    try do
      fun.()
    after
      if previous do
        Application.put_env(:cytale, :push_endpoint_resolver, previous)
      else
        Application.delete_env(:cytale, :push_endpoint_resolver)
      end
    end
  end

  # ---------------------------------------------------------------------------
  # notifications plan U9 — the mobile target type.
  #
  # The subscription MODEL accepts a mobile device token (R14) so that when the
  # APNs/FCM senders are built they are an addition rather than a redesign. No
  # mobile delivery exists: the dispatcher reports a mobile target as
  # not-yet-delivered, which is a state rather than a fault.
  # ---------------------------------------------------------------------------
  test "registers a device token as a mobile subscription", %{conn: conn, me: me} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "target_type" => "mobile",
        "endpoint" => "ExponentPushToken[abc123]",
        "keys" => %{"token" => "ExponentPushToken[abc123]"}
      })

    assert conn.status == 201

    assert [%{target_type: "mobile", endpoint: "ExponentPushToken[abc123]"}] =
             Cytale.Notifications.Subscriptions.list_for_user(me.user_id)
  end

  test "a registration with no target_type is stored as web", %{conn: conn, me: me} do
    conn =
      post(conn, "/api/v1/users/@me/push-subscriptions", %{
        "endpoint" => "https://push.example.com/web-default",
        "keys" => %{"p256dh" => "p", "auth" => "a"}
      })

    assert conn.status == 201
    assert [%{target_type: "web"}] = Cytale.Notifications.Subscriptions.list_for_user(me.user_id)
  end

  test "an unknown target_type is refused rather than stored", %{conn: conn, me: me} do
    assert post(conn, "/api/v1/users/@me/push-subscriptions", %{
             "target_type" => "smoke-signal",
             "endpoint" => "https://push.example.com/nope",
             "keys" => %{"p256dh" => "p", "auth" => "a"}
           }).status == 400

    assert Cytale.Notifications.Subscriptions.list_for_user(me.user_id) == []
  end

  test "mobile and web subscriptions coexist for one member", %{conn: conn, me: me} do
    assert post(conn, "/api/v1/users/@me/push-subscriptions", %{
             "target_type" => "mobile",
             "endpoint" => "mobile-token-1",
             "keys" => %{"token" => "mobile-token-1"}
           }).status == 201

    assert post(conn, "/api/v1/users/@me/push-subscriptions", %{
             "endpoint" => "https://push.example.com/web-1",
             "keys" => %{"p256dh" => "p", "auth" => "a"}
           }).status == 201

    types =
      Cytale.Notifications.Subscriptions.list_for_user(me.user_id)
      |> Enum.map(& &1.target_type)
      |> Enum.sort()

    assert types == ["mobile", "web"]
  end
end
