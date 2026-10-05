defmodule CytaleWeb.AccountController do
  @moduledoc """
  U14 — account surface: `DELETE /api/v1/account` (self-delete). The cascade
  is async and non-blocking — the handler marks the user deleted and spawns
  the sweep, answering 202 Accepted immediately.

  Settings surface addition: `DELETE /api/v1/users/@me/sessions` — whole-
  account sign-out ("sign out everywhere" under the gear).
  """

  use CytaleWeb, :controller

  alias Cytale.Accounts.Auth
  alias Cytale.Accounts.Deletion
  alias Cytale.Gateway.SessionStore

  # Discord-shaped auth-failed close (dead credential, non-reconnectable) —
  # the same code machine-principal revocation uses; a revoked refresh
  # token's socket must not outlive its credentials.
  @close_auth_failed 4004

  @doc "DELETE /api/v1/account — self-delete (async cascade, 202 Accepted)."
  def delete(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    :ok = Deletion.delete_account(user_id)

    conn
    |> put_status(202)
    |> json(%{"deleted" => true, "status" => "accepted"})
  end

  @doc """
  DELETE /api/v1/users/@me/sessions — revoke EVERY refresh token for the
  caller (all devices, this one included — the next access-token expiry ends
  every session) and close live gateway sockets immediately.
  """
  def revoke_all_sessions(conn, _params) do
    %{user_id: user_id} = conn.assigns.current_user

    :ok = Auth.revoke_all_sessions(user_id)
    :ok = SessionStore.close_principal_sessions(user_id, @close_auth_failed)
    # Revoking every session is the member saying "nothing of mine stays live
    # on any device". Stored notification preferences and push subscriptions
    # share that lifetime, so they go too rather than silently re-applying to
    # whatever session signs in next (plan U2/U6, R19).
    #
    # The subscription matters most: it lives in the browser's push manager,
    # NOT in page storage, so signing out does not remove it — a row left
    # behind would deliver this member's notifications to a signed-out browser.
    :ok = Cytale.Notifications.Preferences.clear_all(user_id)
    :ok = Cytale.Notifications.Subscriptions.delete_all_for_user(user_id)
    :ok = Cytale.Notifications.Participations.delete_all_for_user(user_id)

    send_resp(conn, :no_content, "")
  end
end
