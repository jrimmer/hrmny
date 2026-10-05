defmodule CytaleWeb.BridgeServer do
  @moduledoc """
  The bridge's own listener and route table (R8a).

  ## Why this is not a route on the app router

  R8a requires the bridge to be off the public network, and network placement
  alone cannot deliver that: `deploy/Caddyfile` proxies every path on the domain
  to the app listener, so a bridge route in `CytaleWeb.Router` would be reachable
  from the internet no matter which network the container sits on. Phoenix makes
  that unavoidable in a way worth stating, because it is the reason this module
  exists rather than a second bind address: **a route table belongs to the
  ENDPOINT, not to a listener** — a second bind address, a Unix socket, or a
  second `:http` entry on `CytaleWeb.Endpoint` would all still serve the app
  router, the bridge path included, on the listener Caddy proxies.

  So the bridge is a separate plug server (Bandit) running `call/2` below, with
  a route table that has exactly one entry and no access to the app router at
  all. `CytaleWeb.AuthorizationMatrix` declares the bridge route through this
  module's `credential_plug/0` and its suite asserts the bridge path is ABSENT
  from `CytaleWeb.Router.__routes__/0` — absence, not refusal, because a route
  that exists on the proxied listener is a route the edge can reach.

  Placement is then enforceable rather than implied:

    * `bind_ip/0` — the address the listener binds. Loopback by default; a
      Compose deployment sets the internal network's address (or `0.0.0.0` on a
      network nothing is published on).
    * the port is never published to the host (U17's compose work), and the
      edge denial in the Caddyfile is depth, not the control.

  ## Configuration

  One scope, `config :cytale, :session_bridge`, with env fallbacks so the
  bridge is deployable without a rebuild:

      enabled: false                       CYTALE_SESSION_BRIDGE_ENABLED
      bind_ip: {127, 0, 0, 1}              CYTALE_SESSION_BRIDGE_BIND
      port: 4100                           CYTALE_SESSION_BRIDGE_PORT

  Disabled by default, exactly like `Cytale.Config.ssh_certificates_enabled?/0`:
  the bridge needs a credential provisioned before it can do anything, and a
  node without one must lose only the terminal. The credential itself lives with
  the bridge (`Cytale.SessionBridge.credential_source/0`) and is validated at
  boot here, so a misconfigured bridge fails loudly instead of listening and
  refusing every request.
  """

  alias Cytale.SessionBridge

  require Logger

  @behaviour Plug

  @config_scope :session_bridge
  @default_port 4100

  @route %{
    method: "POST",
    path: "/internal/ssh/session",
    controller: CytaleWeb.SessionBridgeController,
    action: :mint
  }

  @parsers_spec [
    parsers: [{:json, length: 2_000_000}],
    pass: ["*/*"],
    json_decoder: Jason
  ]

  # ---------------------------------------------------------------------------
  # The route table
  # ---------------------------------------------------------------------------

  @doc "The bridge's single route."
  @spec route() :: map()
  def route, do: @route

  @doc "The bridge path a public-origin probe must NOT find on the app listener."
  @spec path() :: String.t()
  def path, do: @route.path

  @doc """
  The plug that gates the bridge route: the credential check, and nothing else.
  The authorization matrix asserts THIS plug (and the absence of
  `CytaleWeb.Plugs.Auth`) for the bridge, because a declaration that names a
  pipeline the route does not run asserts nothing.
  """
  @spec credential_plug() :: module()
  def credential_plug, do: CytaleWeb.Plugs.BridgeAuth

  @doc """
  The ordered plugs the bridge route runs: the credential gate first (an
  unauthenticated caller must not get a body parsed for it), then the JSON
  parser the controller's `params` needs.
  """
  @spec pipeline() :: [module() | {module(), keyword()}]
  def pipeline, do: [credential_plug(), {Plug.Parsers, @parsers_spec}]

  # ---------------------------------------------------------------------------
  # Configuration
  # ---------------------------------------------------------------------------

  @doc "Whether this node serves the bridge at all (default false)."
  @spec enabled?() :: boolean()
  def enabled? do
    flag(:enabled, false) || truthy?(System.get_env("CYTALE_SESSION_BRIDGE_ENABLED"))
  end

  @doc """
  The address the bridge listener binds. Loopback by default; a deployment
  binds the internal network's address (see the moduledoc on why binding is not
  the control).
  """
  @spec bind_ip() :: :inet.ip_address()
  def bind_ip do
    case config()[:bind_ip] || System.get_env("CYTALE_SESSION_BRIDGE_BIND") do
      {_, _, _, _} = tuple ->
        tuple

      {_, _, _, _, _, _, _, _} = tuple ->
        tuple

      value when is_binary(value) ->
        case :inet.parse_address(String.to_charlist(value)) do
          {:ok, address} -> address
          {:error, _} -> raise "invalid session bridge bind address: #{inspect(value)}"
        end

      _other ->
        {127, 0, 0, 1}
    end
  end

  @doc "The port the bridge listener binds (default 4100; never published)."
  @spec port() :: :inet.port_number()
  def port do
    value = config()[:port] || System.get_env("CYTALE_SESSION_BRIDGE_PORT")

    case parse_port(value) do
      nil -> @default_port
      port -> port
    end
  end

  # ---------------------------------------------------------------------------
  # Supervision + the plug
  # ---------------------------------------------------------------------------

  @doc "Child spec for the application supervision tree."
  @spec child_spec(keyword()) :: Supervisor.child_spec()
  def child_spec(opts \\ []) do
    %{
      id: __MODULE__,
      start: {__MODULE__, :start_link, [opts]},
      type: :worker
    }
  end

  @doc """
  Start the bridge listener, failing fast on a missing credential (the surface
  is worthless without one, and a silent refusal-everything listener is worse
  than no listener).

  Options override the configured bind address and port — the seam a test uses
  to run the bridge on an ephemeral loopback port.
  """
  @spec start_link(keyword()) :: {:ok, pid()} | {:error, term()}
  def start_link(opts \\ []) do
    :ok = validate_credential!(SessionBridge.credential_hash!())

    ip = Keyword.get(opts, :ip, bind_ip())
    port = Keyword.get(opts, :port, port())

    case Bandit.start_link(plug: {__MODULE__, []}, scheme: :http, ip: ip, port: port) do
      {:ok, pid} ->
        Logger.info(
          "session bridge listening on #{format_ip(ip)}:#{port} — route #{@route.method} #{@route.path} " <>
            "(internal network only; not the listener the public edge proxies)"
        )

        {:ok, pid}

      other ->
        other
    end
  end

  @impl Plug
  def init(opts), do: opts

  @impl Plug
  def call(conn, _opts) do
    conn = run_pipeline(conn, pipeline())

    if conn.halted, do: conn, else: dispatch(conn)
  end

  defp run_pipeline(conn, []), do: conn

  defp run_pipeline(conn, [plug | rest]) do
    {plug, opts} = plug_opts(plug)
    conn = plug.call(conn, plug.init(opts))

    if conn.halted, do: conn, else: run_pipeline(conn, rest)
  end

  defp plug_opts({plug, opts}) when is_atom(plug), do: {plug, opts}
  defp plug_opts(plug) when is_atom(plug), do: {plug, []}

  defp dispatch(%Plug.Conn{method: "POST", request_path: path} = conn)
       when path == @route.path do
    @route.controller.mint(conn, conn.params)
  end

  defp dispatch(conn) do
    conn
    |> Plug.Conn.put_resp_content_type("application/json")
    |> Plug.Conn.send_resp(
      404,
      Jason.encode!(%{
        "error" => %{"key" => "not_found", "message" => "No such bridge route."}
      })
    )
  end

  # ---------------------------------------------------------------------------
  # internals
  # ---------------------------------------------------------------------------

  defp validate_credential!(hash) when is_binary(hash) and byte_size(hash) == 32, do: :ok

  defp validate_credential!(_hash),
    do: raise("session bridge credential is empty; set a non-empty credential")

  defp config do
    case Application.get_env(:cytale, @config_scope, []) do
      list when is_list(list) -> if Keyword.keyword?(list), do: list, else: []
      map when is_map(map) -> Map.to_list(map)
      _other -> []
    end
  end

  defp flag(key, default) do
    case config()[key] do
      value when is_boolean(value) -> value
      _other -> default
    end
  end

  defp parse_port(value) when is_integer(value) and value > 0, do: value

  defp parse_port(value) when is_binary(value) do
    case Integer.parse(value) do
      {port, ""} when port > 0 -> port
      _other -> nil
    end
  end

  defp parse_port(_value), do: nil

  defp truthy?(value) when is_binary(value),
    do: String.downcase(value) in ["1", "true", "yes", "on"]

  defp truthy?(_value), do: false

  defp format_ip({a, b, c, d}), do: "#{a}.#{b}.#{c}.#{d}"

  defp format_ip({a, b, c, d, e, f, g, h}),
    do: Enum.map_join([a, b, c, d, e, f, g, h], ":", &Integer.to_string(&1, 16))

  defp format_ip(other), do: inspect(other)
end
