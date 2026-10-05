defmodule CytaleWeb.PushController do
  @moduledoc """
  U9 — web-push subscription surface (edit #6): register / remove the
  calling user's push subscription. Delivery itself is U10+ (gateway push
  tier); this is the registration store.
  """

  use CytaleWeb, :controller

  alias Cytale.Notifications.PushEndpointGuard
  alias Cytale.Workspaces
  import CytaleWeb.API.Error, only: [error: 4]

  @doc """
  POST /users/@me/push-subscriptions {endpoint, keys, target_type?}.

  `target_type` selects the kind of target: `web` (the default, a browser push
  subscription) or `mobile` (a device token). An unknown type is REFUSED
  rather than stored — a row whose type no sender matches would be a
  subscription that silently never delivers, which is the failure mode this
  whole surface exists to avoid.

  A `web` endpoint passes the SSRF guard (S1,
  `Cytale.Notifications.PushEndpointGuard`) BEFORE it is stored; delivery
  re-checks at send time, so a row whose host turns private later is retired
  rather than posted to.
  """
  def create(conn, %{"endpoint" => endpoint} = params) when is_binary(endpoint) do
    %{user_id: user_id} = conn.assigns.current_user

    case target_type(params["target_type"]) do
      {:ok, target} ->
        case check_endpoint(endpoint, target) do
          :ok ->
            keys = params["keys"] |> Jason.encode!()

            :ok = Workspaces.put_push_subscription(user_id, endpoint, keys, target)

            conn
            |> put_status(201)
            |> json(%{"registered" => true, "target_type" => target})

          {:error, reason} ->
            # S1 (SSRF): the endpoint is a client-chosen URL that delivery
            # POSTs to verbatim, so a web endpoint must name a public https
            # push service. The reason is a stable token (scheme / host /
            # port / unresolvable / blocked_address) a client can match on.
            error(conn, 400, "validation_failed", "invalid push endpoint: #{reason}")
        end

      :error ->
        error(conn, 400, "validation_failed", "target_type must be web or mobile")
    end
  end

  def create(conn, _params),
    do: error(conn, 400, "validation_failed", "endpoint is required")

  # Only WEB endpoints are URLs — a mobile target's endpoint is a device
  # token (e.g. an ExponentPushToken), which the URL guard must never touch.
  defp check_endpoint(_endpoint, "mobile"), do: :ok
  defp check_endpoint(endpoint, "web"), do: PushEndpointGuard.validate(endpoint)

  # Absent means web: the only target type the client sent before this existed,
  # so an older client keeps working unchanged.
  defp target_type(nil), do: {:ok, "web"}
  defp target_type("web"), do: {:ok, "web"}
  defp target_type("mobile"), do: {:ok, "mobile"}
  defp target_type(_other), do: :error

  @doc "DELETE /users/@me/push-subscriptions {endpoint}."
  def delete(conn, %{"endpoint" => endpoint}) when is_binary(endpoint) do
    %{user_id: user_id} = conn.assigns.current_user

    :ok = Workspaces.delete_push_subscription(user_id, endpoint)
    json(conn, %{"deleted" => true})
  end

  def delete(conn, _params), do: error(conn, 400, "validation_failed", "endpoint is required")
end
