defmodule CytaleWeb.Calls.MediaKillSwitchGatewayTest do
  @moduledoc """
  Ticket #124 — the media master switch at the gateway: the modified-client
  proof. A raw op-22 client that skips every UI affordance still cannot
  start or join on a media-off instance (the gate lives in `Cytale.Calls`,
  the chokepoint the ops route through) — the refusal is counted with its
  own `[:cytale, :calls, :op_error]` telemetry (`reason: :media_disabled`)
  while the wire stays silent per the non-oracle doctrine: clients learn
  the state DECLARATIVELY, from READY's `media_enabled` (pinned here both
  default-true and flipped-false on a fresh Identify). The standing-call
  edge is pinned at the wire too: a call started before the flip stays live,
  its participant's leg intact, while a NEW join refuses.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Calls
  alias Cytale.Workspaces

  setup do
    port = start_gateway!()

    # Real fan-out for call events (the :test default Publish.Log only logs —
    # the gateway_ops_test setup verbatim).
    old_publish = Application.get_env(:cytale, Cytale.Publish)

    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    old_media = Application.get_env(:cytale, :media)

    on_exit(fn ->
      case old_publish do
        nil -> Application.delete_env(:cytale, Cytale.Publish)
        v -> Application.put_env(:cytale, Cytale.Publish, v)
      end

      case old_media do
        nil -> Application.delete_env(:cytale, :media)
        v -> Application.put_env(:cytale, :media, v)
      end
    end)

    {:ok, port: port}
  end

  # -- fixtures (the gateway_ops_test shapes) -------------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()
  defp run_token, do: "cytale_m124_" <> run_nonce() <> String.duplicate("o", 8)
  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  defp workspace!(token_a, extra_tokens, channel_names) do
    uid_a = stub_uid(token_a)

    {:ok, ws} = Workspaces.create_workspace(uid_a, "m124-" <> run_nonce())

    for token <- extra_tokens do
      :ok = Workspaces.add_member(ws.workspace_id, stub_uid(token), uid_a, [])
    end

    channels =
      Map.new(channel_names, fn name ->
        {:ok, ch} = Workspaces.create_channel(ws.workspace_id, name)
        {String.to_atom(name), ch.channel_id}
      end)

    {ws, channels}
  end

  defp identify_on(port, token) do
    conn = connect!(port)
    ready = identify!(conn, token)
    drain_pending!(conn)
    {conn, ready}
  end

  defp drain_pending!(conn) do
    case next_frame(conn, 250) do
      {:ok, _json} -> drain_pending!(conn)
      {:closed, _code} -> :ok
    end
  rescue
    ExUnit.AssertionError -> :ok
  end

  defp call_op!(conn, action, channel_id, extra \\ %{}) do
    send_frame!(conn, 22, Map.merge(%{"channel_id" => Integer.to_string(channel_id), "action" => action}, extra))
  end

  defp attach_telemetry!(id, event_name) do
    test_pid = self()

    :ok =
      :telemetry.attach(
        id,
        event_name,
        fn _e, _m, meta, _c -> send(test_pid, {:telemetry, event_name, meta}) end,
        nil
      )

    on_exit(fn -> :telemetry.detach(id) end)
  end

  defp set_media(enabled?), do: Application.put_env(:cytale, :media, enabled: enabled?)

  # -- the declarative seam ---------------------------------------------------------

  test "READY carries media_enabled: true by default (the client's boot-time seam)", %{
    port: port
  } do
    token = run_token()
    conn = connect!(port)
    # identify!/3 returns the READY `d` payload directly.
    ready = identify!(conn, token)

    assert ready["media_enabled"] == true
  end

  test "a fresh Identify after the flip reports media_enabled: false", %{port: port} do
    set_media(false)
    token = run_token()
    conn = connect!(port)
    ready = identify!(conn, token)

    assert ready["media_enabled"] == false
  end

  # -- the modified-client gate ------------------------------------------------------

  test "media off: a raw op-22 client cannot start — no CallStart, media_disabled telemetry", %{
    port: port
  } do
    token_a = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [], ["general"])
    {conn_a, _} = identify_on(port, token_a)

    attach_telemetry!(:m124_start_refused, [:cytale, :calls, :op_error])
    set_media(false)

    call_op!(conn_a, "start", ch_id, %{"ring" => true})

    # No CallStart reaches anyone; the refusal is COUNTED, specifically.
    refute_next_event!(conn_a, "CallStart", 1_000)

    assert_receive {:telemetry, [:cytale, :calls, :op_error], %{op: "start", reason: :media_disabled}},
                   5_000

    assert is_nil(Calls.room_pid(ch_id))
  end

  test "media off: a raw op-22 client cannot join — no joined CallUpdate, media_disabled telemetry", %{
    port: port
  } do
    token_a = run_token()
    token_b = run_token()
    {_ws, %{general: ch_id}} = workspace!(token_a, [token_b], ["general"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # The call exists (started while media was on).
    call_op!(conn_a, "start", ch_id)
    assert next_event!(conn_a, "CallStart", 5_000)

    # B must see the whole start burst before the refute window opens: the
    # starter's own joined CallUpdate is also a CallUpdate, and a quiet-gap
    # drain can return before it lands, leaving it to trip the refute below.
    assert next_event!(conn_b, "CallStart", 5_000)
    assert next_event!(conn_b, "CallUpdate", 5_000)["d"]["state"] == "joined"
    drain_pending!(conn_b)

    attach_telemetry!(:m124_join_refused, [:cytale, :calls, :op_error])
    set_media(false)

    call_op!(conn_b, "join", ch_id)

    refute_next_event!(conn_b, "CallUpdate", 1_000)

    assert_receive {:telemetry, [:cytale, :calls, :op_error], %{op: "join", reason: :media_disabled}},
                   5_000

    # The standing-call edge: the call is NOT torn down; the starter keeps
    # the live room and their leg.
    starter_uid = stub_uid(token_a)
    assert %{participants: participants} = Calls.live_call(ch_id)
    assert [%{user_id: ^starter_uid}] = participants
  end
end
