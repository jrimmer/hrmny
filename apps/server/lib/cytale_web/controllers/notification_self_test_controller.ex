defmodule CytaleWeb.NotificationSelfTestController do
  @moduledoc """
  Member-scoped notification self-test: "will a notification actually reach
  ME?"

  This is the question every member asks at least once, and until now the only
  way to answer it was the operator probe — which is the wrong shape for the
  job twice over. It requires an operator (so a member cannot use it), and it
  can name any member (so it is a boundary that should not be opened to
  everyone just to answer a question about yourself).

  So this rides the CALLER's identity and accepts no target at all: the
  partition key IS the caller, exactly as `/users/@me/inbox` works. There is no
  parameter to abuse and no way to notify anyone but yourself.

  ## What it bypasses, and why that is the point

  Policy, focus and the preference ladder are all skipped. The member is
  standing in the settings surface looking at the answer to "is my browser
  reachable" — a probe that returned "nothing sent" because the channel they
  happened to be reading is muted would answer the wrong question and look like
  a broken button. This is a transport check, not a delivery verdict.

  ## What it reports

  The number of registered targets and what happened to each one, because the
  three failure modes (no target registered, an endpoint the push service
  retired, a signing failure) have three different fixes. `sent: 0` with
  `targets: 0` says "this browser was never registered"; `gone` says "that
  registration is dead and was pruned"; an error string says the instance could
  not sign or reach the service.
  """

  use CytaleWeb, :controller

  alias Cytale.Notifications.Delivery

  @doc """
  POST /api/v1/users/@me/notifications/test

  Optional body: `{"message": "<body text>"}` — trimmed, and never more than
  one probe per call.
  """
  def create(conn, params) do
    %{user_id: user_id} = conn.assigns.current_user
    opts = if is_binary(params["message"]) and params["message"] != "", do: [message: params["message"]], else: []

    result = Delivery.Push.send_probe(user_id, opts)

    json(conn, %{
      "targets" => result.targets,
      "sent" => result.sent,
      "outcomes" => Enum.map(result.outcomes, &inspect/1),
      "note" => Map.get(result, :note)
    })
  end
end
