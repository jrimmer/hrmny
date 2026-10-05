defmodule CytaleWeb.Plugs.RequireHuman do
  @moduledoc """
  Refuse MACHINE principals (bot/agent/webhook credentials) on identity-scoped
  routes that only a person may drive: joining a workspace through an invite,
  creating a workspace, SSH certificates, and WebAuthn registration.

  A machine principal is a sub-identity of its parent — every workspace it
  reaches, it reaches THROUGH the parent's membership (`Principal.resolve/3`).
  Letting its credential mint memberships, workspaces or login credentials of
  its own gives it an identity outside that intersection: a bot token that
  joins a workspace, owns one, or registers a passkey is no longer bounded by
  the person who minted it, and outlives their revocation of the grant.

  Denial is the uniform 403 `forbidden` envelope (the same shape
  `RequirePermitted` renders).
  """

  @behaviour Plug

  import Plug.Conn

  alias Cytale.Permissions.Principal

  @impl true
  def init(opts), do: opts

  @impl true
  def call(%{assigns: %{current_user: %{kind: kind}}} = conn, _opts) do
    if Principal.machine_kind?(kind), do: forbid(conn), else: conn
  end

  def call(%{assigns: %{current_user: %{}}} = conn, _opts), do: conn
  def call(conn, _opts), do: forbid(conn)

  defp forbid(conn) do
    conn
    |> put_resp_content_type("application/json")
    |> send_resp(
      403,
      Jason.encode!(%{
        "error" => %{
          "key" => "forbidden",
          "code" => 40_003,
          "message" => "This action is not available to bot, agent or webhook credentials."
        }
      })
    )
    |> halt()
  end
end
