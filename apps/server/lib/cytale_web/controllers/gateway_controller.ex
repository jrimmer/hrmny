defmodule CytaleWeb.GatewayController do
  @moduledoc """
  Tiny plug forwarding the WS upgrade request to `CytaleWeb.GatewaySocket`.
  Router verbs need a controller module; the socket owns the actual behaviour.
  """

  alias CytaleWeb.GatewaySocket

  def init(options), do: options

  def call(conn, _opts), do: GatewaySocket.upgrade(conn)
end
