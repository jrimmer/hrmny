defmodule CytaleWeb.Plugs.OptionalAuth do
  @moduledoc """
  #88 — authenticate when the request carries a credential; continue anyway
  when it does not.

  The client-error ingest must accept UNAUTHENTICATED posts, because the most
  valuable crash to capture happens on the login page — before anyone is
  authenticated. A plain `CytaleWeb.Plugs.Auth` on that route would 401 exactly
  those reports, and would also drop a report produced by a client whose access
  token had just expired (which is what a crash late in a long session looks
  like). Neither is acceptable on the one surface whose whole job is to make a
  failure visible.

  The posture this plug takes is therefore: a missing, malformed, expired or
  revoked credential leaves `conn.assigns.current_user` UNSET and the request
  proceeds ANONYMOUSLY. A valid credential is resolved through the very same
  `CytaleWeb.Plugs.Auth.resolve/1` the gate uses, so the claims shape is
  identical and the report is attributed to the account that produced it
  instead of being filed anonymous (the ticket's anonymous-vs-user tag).

  **This plug grants nothing.** It is an observer, not an authorization
  decision: it never halts, and it must never back a route whose behavior
  depends on identity. `Auth` stays the gate on every other surface.

  ## CORS

  A cross-origin shell that gets a 401 on a POST it sends automatically would
  surface it as a browser console error, so "never responds 401" is also what
  keeps the ingest from generating its own noise.
  """

  @behaviour Plug

  import Plug.Conn

  alias CytaleWeb.Plugs.Auth

  @impl true
  def init(opts), do: opts

  @impl true
  def call(conn, _opts) do
    case Auth.resolve(conn) do
      {:ok, claims} -> assign(conn, :current_user, claims)
      :error -> conn
    end
  end
end
