defmodule CytaleWeb.Socket do
  @moduledoc """
  Gateway WebSocket transport placeholder.

  The gateway protocol (Hello/Identify/READY/heartbeat/resume) and its session
  machinery are implemented in U9/U10. This module only fixes the mount point
  (`socket "/gateway/websocket", CytaleWeb.Socket`) so later units attach the
  real handler here.
  """

  use Phoenix.Socket

  # channel "gateway:*", CytaleWeb.GatewayChannel  # attached in U9/U10

  @impl true
  def id(_socket), do: nil
end
