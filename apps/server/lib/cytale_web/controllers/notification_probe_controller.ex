defmodule CytaleWeb.NotificationProbeController do
  @moduledoc """
  Operator-only notification probe: "can this member actually be notified?"

  Exists because answering that question previously required four deploys and a
  remote console session. The failure it diagnoses is the one that looks like
  nothing at all — a member who should be notified, a delivery path that reports
  success, and no notification on any device. Every distinct cause of that
  (no push target, a dead endpoint, a signing problem, a malformed payload) is a
  different fix, and the response names which one this is.

  ## Why it is out of band

  It deliberately bypasses the policy, the focus check and the preference
  ladder. The question is "can the transport reach them", not "should this
  message have notified them" — and a probe that returned "nothing sent"
  because the channel happened to be muted would answer neither.

  ## Why it is operator-gated

  It sends a real notification to a real person's devices. `:operator` is the
  existing allowlist gate (`CYTALE_ADMIN_USER_IDS`, fail-closed when unset), so
  this rides the same boundary as the other admin routes rather than inventing
  one.
  """

  use CytaleWeb, :controller

  alias Cytale.Notifications.Delivery
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  POST /api/v1/admin/notifications/test

  Body: `{"user_id": "<snowflake>", "message": "<optional body>"}`.
  `user_id` defaults to the caller, which is the common case: an operator
  checking whether their own browser is reachable.
  """
  def create(conn, params) do
    case target_user_id(conn, params["user_id"]) do
      {:ok, user_id} -> respond(conn, user_id, params["message"])
      {:error, :invalid_id} -> error(conn, 400, "validation_failed", "user_id must be a snowflake")
      {:error, :not_found} -> error(conn, 404, "user_not_found", "No account with that id")
    end
  end

  defp target_user_id(_conn, nil) do
    # The caller is an operator by the time this runs, so their own id is known
    # to be a real account.
    {:ok, nil}
  end

  defp target_user_id(conn, raw) when is_binary(raw) do
    case Integer.parse(raw) do
      {id, ""} when id > 0 ->
        if Cytale.Accounts.User.get(id), do: {:ok, id}, else: {:error, :not_found}

      _ ->
        {:error, :invalid_id}
    end
  end

  defp target_user_id(_conn, _other), do: {:error, :invalid_id}

  defp respond(conn, nil, message) do
    %{user_id: user_id} = conn.assigns.current_user
    send_probe(conn, user_id, message)
  end

  defp respond(conn, user_id, message), do: send_probe(conn, user_id, message)

  defp send_probe(conn, user_id, message) do
    opts = if is_binary(message) and message != "", do: [message: message], else: []

    result = Delivery.Push.send_probe(user_id, opts)

    json(conn, %{
      "user_id" => Integer.to_string(user_id),
      "targets" => result.targets,
      "sent" => result.sent,
      "outcomes" => Enum.map(result.outcomes, &inspect/1),
      "note" => Map.get(result, :note)
    })
  end
end
