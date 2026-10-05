defmodule Cytale.Notifications.DeliveryPushTest do
  @moduledoc """
  U9 of the notification plan — a mobile target is a state, not a fault.

  The mobile subscription MODEL exists (R14) so the APNs/FCM senders are an
  addition rather than a redesign. What must NOT happen in the meantime is a
  mobile row being treated like a broken web one: a subscriber that looks
  configured and silently never delivers is exactly the failure this feature
  exists to remove, so the path reports itself explicitly.
  """

  use Cytale.ScyllaCase, async: false

  import ExUnit.CaptureLog

  alias Cytale.Notifications.{Delivery, Subscriptions, WebPush}

  defp user_id, do: String.to_integer("9#{Cytale.TestNonce.get()}")

  defp notification(user_id) do
    %{
      user_id: user_id,
      verdict: :push,
      rule: :direct_message,
      level: "mentions",
      decided_by: :account,
      event_name: "MessageCreate",
      payload: %{
        "id" => "1000",
        "channel_id" => "2000",
        "workspace_id" => 3000,
        "content" => "hello"
      }
    }
  end

  setup do
    previous = Application.get_env(:cytale, Cytale.Notifications.WebPush.Transport)
    Application.put_env(:cytale, Cytale.Notifications.WebPush.Transport, StubOk)

    on_exit(fn -> Application.put_env(:cytale, Cytale.Notifications.WebPush.Transport, previous) end)
    :ok
  end

  defmodule StubOk do
    @behaviour Cytale.Notifications.WebPush.Transport

    @impl true
    def post(_request, _opts), do: {:ok, 201}
  end

  # Sends run off the fan-out path in a supervised task, so a test must wait
  # for it — asserting immediately reads an empty log and passes for the wrong
  # reason (which is exactly how the negative assertion below once did).
  defp deliver_and_settle(notifications) do
    log =
      capture_log(fn ->
        Delivery.Push.deliver(notifications)
        settle()
      end)

    to_string(log)
  end

  defp settle(tries \\ 40)
  defp settle(0), do: :ok

  defp settle(tries) do
    case Task.Supervisor.children(Cytale.Notifications.TaskSupervisor) do
      [] ->
        Process.sleep(20)
        settle(tries - 1)

      _busy ->
        Process.sleep(20)
        settle(tries - 1)
    end
  end

  # A web row is ROUTED to the web sender — it must not fall into the
  # no-sender branch. Whether the send then succeeds is web_push_test's
  # concern, and asserting it here would make this file depend on VAPID key
  # material it has no business owning.
  test "a web subscription is routed to the web sender, not the no-sender branch" do
    uid = user_id()

    :ok =
      Cytale.Workspaces.put_push_subscription(uid, "https://push.example.com/a", "{\"p256dh\":\"p\",\"auth\":\"a\"}")

    log = deliver_and_settle([notification(uid)])

    refute log =~ "no sender yet"
  end

  # The whole point of U9's reporting half: a mobile row must not look like a
  # delivered notification, and must not look like a crash either.
  test "a mobile target reports itself as not yet deliverable" do
    uid = user_id()

    :ok =
      Cytale.Workspaces.put_push_subscription(
        uid,
        "ExponentPushToken[abc]",
        "{\"token\":\"ExponentPushToken[abc]\"}",
        "mobile"
      )

    log = deliver_and_settle([notification(uid)])

    assert log =~ "no sender yet",
           "a mobile subscription with no sender must say so rather than fail silently"

    assert log =~ "mobile"
  end

  test "a member with no subscriptions is a no-op" do
    uid = user_id()

    # Assert on THIS module's logging, not log emptiness: background work from
    # other suites (search-rebuild index writers, whose commits fire on timers
    # after their test has ended) can legitimately appear in a capture window
    # and is noise here (seen as a full-suite-ordering failure, 2026-09-14).
    log = deliver_and_settle([notification(uid)])

    refute log =~ "[error]"
    refute log =~ "Cytale.Notifications"
  end

  test "delivering nothing is a no-op" do
    assert Delivery.Push.deliver([]) == :ok
  end

  test "the notification body carries the routing target the click handler needs" do
    body =
      WebPush.notification_body(%{
        title: "Hrmny",
        body: "hello",
        target: %{workspace_id: 3000, channel_id: "2000", thread_id: nil, message_id: "1000"}
      })

    decoded = Jason.decode!(body)
    assert decoded["target"]["workspace_id"] == 3000
    assert decoded["target"]["channel_id"] == "2000"
    assert decoded["target"]["message_id"] == "1000"
  end

  test "a mobile row does not appear as a web target" do
    uid = user_id()

    :ok =
      Cytale.Workspaces.put_push_subscription(
        uid,
        "ExponentPushToken[xyz]",
        "{\"token\":\"ExponentPushToken[xyz]\"}",
        "mobile"
      )

    assert [%{target_type: "mobile"}] = Subscriptions.list_for_user(uid),
           "the row must be addressable as mobile so no web sender picks it up"
  end
end
