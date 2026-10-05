defmodule Cytale.Notifications.WebPushTest do
  @moduledoc """
  U6 of the notification plan — sending, and the dead-subscription lifecycle
  (R18).

  The load-bearing test here is the gone-endpoint one. A push service answers
  404/410 for a subscription the browser has dropped, and a sender that
  retries it forever fails silently on every subsequent send — that is the
  quiet-failure trap the plan calls out, and it is invisible without a test
  that asserts the row is DELETED, not merely that the send returned an error.

  The HTTP leg is a stub implementation, so no egress happens and the status
  handling is exercised deterministically.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Notifications.Subscriptions
  alias Cytale.Notifications.WebPush
  alias Cytale.Notifications.WebPush.Transport

  # -- the stub transport -------------------------------------------------------

  defmodule StubTransport do
    @behaviour Cytale.Notifications.WebPush.Transport

    @impl true
    def post(request, _opts) do
      case Process.get({:transport, :responses}) do
        [next | rest] ->
          Process.put({:transport, :responses}, rest)
          Process.put({:transport, :last}, request)
          next

        _ ->
          Process.put({:transport, :last}, request)
          {:ok, 201}
      end
    end
  end

  defp user_id, do: String.to_integer("6#{Cytale.TestNonce.get()}")

  defp endpoint, do: "https://push.example.com/sub/#{Cytale.TestNonce.get()}"

  defp keys_blob do
    # A well-formed p256dh/auth pair; the values are opaque to the store.
    Jason.encode!(%{
      "p256dh" => Base.url_encode64(:crypto.strong_rand_bytes(65), padding: false),
      "auth" => Base.url_encode64(:crypto.strong_rand_bytes(16), padding: false)
    })
  end

  setup do
    previous_transport = Application.get_env(:cytale, Transport)
    previous_builder = Application.get_env(:cytale, :web_push_builder)

    Application.put_env(:cytale, Transport, StubTransport)
    # A stand-in for the signing builder. The crypto is the library's property
    # and is verified against a live push service on deploy; what these tests
    # own is what happens to a subscription once the service answers.
    Application.put_env(:cytale, :web_push_builder, &stub_builder/3)

    Process.put({:transport, :responses}, [])

    on_exit(fn ->
      Application.put_env(:cytale, Transport, previous_transport)
      Application.put_env(:cytale, :web_push_builder, previous_builder)
    end)

    :ok
  end

  defp stub_builder(endpoint, keys, message) do
    if Map.has_key?(keys, :p256dh) do
      {:ok,
       %{
         endpoint: endpoint,
         body: message,
         headers: %{
           "Content-Encoding" => "aes128gcm",
           "Content-Type" => "application/octet-stream",
           "Authorization" => "vapid t=stub, k=stub",
           "TTL" => "43200"
         }
       }}
    else
      {:error, :build_failed}
    end
  end

  # -- tests --------------------------------------------------------------------

  describe "send_to/1" do
    test "a live subscription is sent to and reported ok" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())

      assert :ok = WebPush.send_to(%{endpoint: url, keys: keys_blob(), target_type: "web"})
    end

    test "the request carries the endpoint and a signed body" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())

      assert :ok = WebPush.send_to(%{endpoint: url, keys: keys_blob(), target_type: "web"})

      request = Process.get({:transport, :last})
      assert request.endpoint == url
      assert is_binary(request.body)
      assert byte_size(request.body) > 0
    end

    test "a malformed subscription is an error, never a crash" do
      assert {:error, _reason} =
               WebPush.send_to(%{endpoint: "https://push.example.com/x", keys: "not json"})
    end

    # S1: the guard runs at SEND time — a row registered before the guard
    # existed, or whose host re-resolved somewhere private, is retired (the
    # 404/410 path), never POSTed to.
    test "an endpoint that resolves private is retired without a POST" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())

      previous = Application.get_env(:cytale, :push_endpoint_resolver)
      Application.put_env(:cytale, :push_endpoint_resolver, fn _host -> {:ok, [{10, 9, 9, 9}]} end)

      try do
        Process.put({:transport, :last}, nil)

        assert {:gone, {:blocked_endpoint, :blocked_address}} =
                 WebPush.send_to(%{endpoint: url, keys: keys_blob(), target_type: "web"},
                   user_id: uid
                 )

        assert Process.get({:transport, :last}) == nil,
               "a blocked endpoint must not reach the transport"

        assert Subscriptions.list_for_user(uid) == [],
               "the guard's verdict is permanent: the row is retired, not retried"
      after
        if previous do
          Application.put_env(:cytale, :push_endpoint_resolver, previous)
        else
          Application.delete_env(:cytale, :push_endpoint_resolver)
        end
      end
    end
  end

  describe "notification_body/1" do
    # The worker calls `event.data.json()`, so the body must be a JSON STRING.
    # A map handed through would arrive as an object literal the worker cannot
    # parse, silently degrading every notification to its generic-text branch.
    test "encodes title, body, and the routing target as JSON" do
      body =
        WebPush.notification_body(%{
          title: "Hrmny",
          body: "hey there",
          target: %{workspace_id: "1", channel_id: "2", thread_id: nil, message_id: "3"}
        })

      assert is_binary(body)
      decoded = Jason.decode!(body)
      assert decoded["title"] == "Hrmny"
      assert decoded["body"] == "hey there"
      assert decoded["target"]["channel_id"] == "2"
      assert decoded["target"]["message_id"] == "3"
    end

    test "a notification with no target still encodes" do
      body = WebPush.notification_body(%{title: "Hrmny", body: "hello"})
      assert is_binary(body)
      assert Jason.decode!(body)["target"] == %{}
    end
  end

  describe "the dead-subscription lifecycle (R18)" do
    test "a 404 from the push service deletes the row" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())
      Process.put({:transport, :responses}, [{:ok, 404}])

      assert {:gone, _reason} = WebPush.send_to(%{endpoint: url, keys: keys_blob()}, user_id: uid)

      assert Subscriptions.list_for_user(uid) == [],
             "a 404 subscription must be deleted, not retried forever"
    end

    test "a 410 from the push service deletes the row" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())
      Process.put({:transport, :responses}, [{:ok, 410}])

      assert {:gone, _reason} = WebPush.send_to(%{endpoint: url, keys: keys_blob()}, user_id: uid)

      assert Subscriptions.list_for_user(uid) == []
    end

    test "a server error does NOT delete the row — the subscription is still good" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())
      Process.put({:transport, :responses}, [{:ok, 503}])

      assert {:error, _reason} = WebPush.send_to(%{endpoint: url, keys: keys_blob()}, user_id: uid)

      assert length(Subscriptions.list_for_user(uid)) == 1,
             "a transient push-service failure must not unsubscribe the member"
    end

    test "deleting one member's dead endpoint leaves another's intact" do
      a = user_id()
      b = user_id()
      dead = endpoint()
      live = endpoint()

      :ok = Cytale.Workspaces.put_push_subscription(a, dead, keys_blob())
      :ok = Cytale.Workspaces.put_push_subscription(b, live, keys_blob())
      Process.put({:transport, :responses}, [{:ok, 410}])

      assert {:gone, _} = WebPush.send_to(%{endpoint: dead, keys: keys_blob()}, user_id: a)

      assert Subscriptions.list_for_user(a) == []
      assert length(Subscriptions.list_for_user(b)) == 1
    end
  end

  describe "the subscription store" do
    test "lists what was registered" do
      uid = user_id()
      url = endpoint()
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())

      assert [%{endpoint: ^url, target_type: "web"}] = Subscriptions.list_for_user(uid)
    end

    test "re-registering the same endpoint does not duplicate it" do
      uid = user_id()
      url = endpoint()

      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())
      :ok = Cytale.Workspaces.put_push_subscription(uid, url, keys_blob())

      assert length(Subscriptions.list_for_user(uid)) == 1
    end

    test "delete_by_endpoint removes only that subscription" do
      uid = user_id()
      one = endpoint()
      two = endpoint()

      :ok = Cytale.Workspaces.put_push_subscription(uid, one, keys_blob())
      :ok = Cytale.Workspaces.put_push_subscription(uid, two, keys_blob())

      :ok = Subscriptions.delete_by_endpoint(uid, one)

      assert [%{endpoint: ^two}] = Subscriptions.list_for_user(uid)
    end

    test "delete_all_for_user clears the member and leaves others" do
      uid = user_id()
      other = user_id()
      :ok = Cytale.Workspaces.put_push_subscription(uid, endpoint(), keys_blob())
      :ok = Cytale.Workspaces.put_push_subscription(other, endpoint(), keys_blob())

      :ok = Subscriptions.delete_all_for_user(uid)

      assert Subscriptions.list_for_user(uid) == []
      assert length(Subscriptions.list_for_user(other)) == 1
    end

    test "a member with no subscriptions lists none" do
      assert Subscriptions.list_for_user(user_id()) == []
    end
  end
end
