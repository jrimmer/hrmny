defmodule CytaleWeb do
  @moduledoc """
  The entrypoint for defining the Cytale web surface (endpoint, router, plugs).
  """

  def controller do
    quote do
      use Phoenix.Controller, formats: [:json]

      import Plug.Conn

      unquote(verified_routes())
    end
  end

  def router do
    quote do
      use Phoenix.Router, helpers: false

      import Plug.Conn
      import Phoenix.Controller
    end
  end

  def verified_routes do
    quote do
      use Phoenix.VerifiedRoutes, endpoint: CytaleWeb.Endpoint, router: CytaleWeb.Router
    end
  end

  @doc """
  Convenience helper for grouping related functionality ("contexts") and
  controllers/routers/views.
  """
  defmacro __using__(which) when is_atom(which) do
    apply(__MODULE__, which, [])
  end
end
