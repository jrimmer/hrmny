defmodule CytaleWeb.Controllers.ChannelCreateWireTest do
  @moduledoc """
  The `ChannelCreate` fan-out must carry what its READER needs.

  It did not. The payload was a hand-built subset — id, workspace_id, name,
  position, created_at — with no `type` and no `parent_id`, and every gateway
  Channel event omits `type` by design (`ChannelTypeWire`), so a client had
  nothing to normalize and hardcoded `'text'`. A CATEGORY created mid-session
  therefore rendered as a text channel, and a channel created inside one lost
  its grouping, until a reload replaced the row with the REST reading.

  This is the SEAM test: a real gateway session, the real controller action,
  and the frame the client actually receives. The reading half is pinned in
  packages/state's reconcile suite — together they hold the contract from both
  ends, which is the only way a wire shape stays honest.

  The action is called directly rather than through the endpoint, and the
  identity is the gateway stub's. In `:test` the socket authenticates with
  `Cytale.Gateway.Authenticator.Stub` (token → a synthetic uid) while the REST
  plugs resolve real JWTs, so one connection cannot be both — and the socket
  side is the one being asserted.
  """

  use Cytale.ScyllaCase, async: false

  import Cytale.GatewayCase, only: [connect!: 1, identify!: 2, next_event!: 3, next_frame: 2]

  import Phoenix.ConnTest
  import Plug.Conn

  alias Cytale.Workspaces
  alias CytaleWeb.ChannelController

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  defp endpoint_port, do: Application.fetch_env!(:cytale, CytaleWeb.Endpoint)[:http][:port]

  # The same mapping the stub authenticator uses, so the socket's identity and
  # the account the controller acts as are the same account.
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp run_token, do: "cytale_chwire_" <> run_nonce() <> String.duplicate("x", 8)

  # Swallow queued join announces so the next assertion starts from a
  # deterministic mailbox (the gateway_fanout pattern).
  defp drain!(conn) do
    case next_frame(conn, 300) do
      {:ok, _json} -> drain!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  setup do
    # The real fan-out path (config/test.exs pins the Log impl by default).
    original = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      if original == nil,
        do: Application.delete_env(:cytale, Cytale.Publish),
        else: Application.put_env(:cytale, Cytale.Publish, original)
    end)

    token = run_token()
    uid = stub_uid(token)
    {:ok, workspace} = Workspaces.create_workspace(uid, "chwire-#{run_nonce()}")

    %{token: token, uid: uid, workspace: workspace}
  end

  defp create!(workspace_id, uid, params) do
    build_conn()
    |> assign(:current_user, %{user_id: uid, username: "wire", verified: true})
    |> ChannelController.create(Map.merge(%{"workspace_id" => Integer.to_string(workspace_id)}, params))
  end

  test "a created CATEGORY is announced as a category", %{
    token: token,
    uid: uid,
    workspace: workspace
  } do
    conn = connect!(endpoint_port())
    _ready = identify!(conn, token)
    drain!(conn)

    reply = create!(workspace.workspace_id, uid, %{"name" => "Engineering", "type" => "category"})
    assert reply.status == 201
    category_id = Jason.decode!(reply.resp_body)["channel"]["id"]

    payload = next_event!(conn, "ChannelCreate", 5_000)["d"]
    assert payload["id"] == category_id
    # Without this the client types every new channel as text, so a category
    # renders as a text channel until a reload.
    assert payload["type"] == 1
    assert payload["parent_id"] == nil
  end

  test "a channel created INSIDE a category is announced with its parent", %{
    token: token,
    uid: uid,
    workspace: workspace
  } do
    {:ok, category} = Workspaces.create_channel(workspace.workspace_id, "Engineering", type: 1)

    conn = connect!(endpoint_port())
    _ready = identify!(conn, token)
    drain!(conn)

    reply =
      create!(workspace.workspace_id, uid, %{
        "name" => "general",
        "parent_id" => Integer.to_string(category.channel_id)
      })

    assert reply.status == 201
    channel_id = Jason.decode!(reply.resp_body)["channel"]["id"]

    payload = next_event!(conn, "ChannelCreate", 5_000)["d"]
    assert payload["id"] == channel_id
    # The two fields the client cannot derive, which is why they are here.
    assert payload["type"] == 0
    assert payload["parent_id"] == Integer.to_string(category.channel_id)
  end
end
