defmodule CytaleWeb.Channels.GatewayVisibilityFilterTest do
  @moduledoc """
  #51: a NATIVE session must not receive a channel-scoped dispatch for a
  channel its identity cannot VIEW.

  The REST twin of this gate (`Authorize.channel_gate/2`, #35 P0-1) already
  refuses the read; until this filter existed the socket was a second door
  onto the same data — `fanout_route_keys/2` subscribes a session to every
  channel in every workspace it belongs to (no permission evaluation), the
  workspace fan-out filtered recipients for `Call*` events ONLY
  (`workspace.ex`), and the native dispatch path was an explicit no-op
  ("no filtering, no translation"). The machine (compat) dialect was
  therefore MORE strictly permissioned than the first-party human one —
  backwards, since a bot's visibility derives from its parent human's.

  These pins hold the invariant at the socket, which is the one choke point
  BOTH fan-out producers converge on (`Publish.WorkspaceProcess` →
  `Workspace.fan_out/2`, and `Workspaces.FanOut.deliver/2`).
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Permissions.Bitfield
  alias Cytale.Permissions.RightsEpoch
  alias Cytale.Publish
  alias Cytale.Workspaces
  alias Cytale.Workspaces.FanOut

  setup do
    port = start_gateway!()

    # Real fan-out: the :test default Publish.Log only logs, so the
    # workspace-process impl (the production route) must be configured for
    # the delivery pins below.
    old_publish = Application.get_env(:cytale, Cytale.Publish)
    Application.put_env(:cytale, Cytale.Publish, Cytale.Publish.WorkspaceProcess)

    on_exit(fn ->
      case old_publish do
        nil -> Application.delete_env(:cytale, Cytale.Publish)
        v -> Application.put_env(:cytale, Cytale.Publish, v)
      end
    end)

    {:ok, port: port}
  end

  # -- fixtures -------------------------------------------------------------------

  defp run_nonce, do: "r" <> Cytale.TestNonce.get()

  # Unique token → unique Stub identity (the authenticator's phash2 mapping).
  defp run_token, do: "cytale_s51_" <> run_nonce() <> String.duplicate("s", 8)

  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  # A workspace owned by token_a's identity with `names` channels and every
  # extra token's identity a plain member (@everyone grants view+send).
  defp workspace!(token_a, extra_tokens, channel_names) do
    uid_a = stub_uid(token_a)

    {:ok, ws} = Workspaces.create_workspace(uid_a, "s51-" <> run_nonce())

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

  # The native message projection (what REST posts fan out).
  defp message_payload(channel_id, author_id, content) do
    %{
      "id" => Integer.to_string(Cytale.Snowflake.next()),
      "channel_id" => Integer.to_string(channel_id),
      "author_id" => Integer.to_string(author_id),
      "content" => content,
      "thread_id" => nil,
      "reply_to_id" => nil,
      "created_at" => DateTime.utc_now() |> DateTime.to_iso8601(),
      "edited_at" => nil,
      "attachments" => []
    }
  end

  # Deny one bit for one member on one channel, then bump the parent
  # workspace's epoch the way `ChannelController`'s overwrite handler does —
  # a rights mutation must invalidate every memoized rights consumer.
  defp deny_view!(ws, channel_id, user_id) do
    Workspaces.put_overwrite(channel_id, :member, user_id, 0, Bitfield.bit(:view_channel))
    RightsEpoch.bump(ws.workspace_id)
  end

  # -- the leak -------------------------------------------------------------------

  test "a member without VIEW on a channel receives none of its message events; a viewer does",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
    deny_view!(ws, ch.secret, uid_b)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # The owner — who CAN view — receives the restricted channel's message.
    # Asserting this first is what makes the refutation below meaningful: the
    # event demonstrably reached the fan-out, so its absence on B is the
    # filter, not a missing publish.
    assert :ok =
             Publish.publish(
               ch.secret,
               {"MessageCreate", message_payload(ch.secret, uid_a, "classified")}
             )

    assert next_event!(conn_a, "MessageCreate", 5_000)["d"]["content"] == "classified"

    # …and the denied member's socket never sees it (#51's core pin).
    refute_next_event!(conn_b, "MessageCreate", 700)

    # Not a blanket drop: B still receives the channel it CAN view, so a
    # filter that simply muted the session would fail here.
    assert :ok =
             Publish.publish(
               ch.general,
               {"MessageCreate", message_payload(ch.general, uid_a, "hello")}
             )

    assert next_event!(conn_b, "MessageCreate", 5_000)["d"]["content"] == "hello"
  end

  test "the second fan-out producer is gated too (FanOut.deliver → same socket choke point)",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
    deny_view!(ws, ch.secret, uid_b)

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    assert FanOut.deliver(
             ch.secret,
             {"MessageUpdate", message_payload(ch.secret, uid_a, "classified")}
           ) >= 1

    assert next_event!(conn_a, "MessageUpdate", 5_000)["d"]["content"] == "classified"

    refute_next_event!(conn_b, "MessageUpdate", 700)

    assert FanOut.deliver(
             ch.general,
             {"MessageUpdate", message_payload(ch.general, uid_a, "hello")}
           ) >= 1

    assert next_event!(conn_b, "MessageUpdate", 5_000)["d"]["content"] == "hello"
  end

  # -- the epoch: revocation lands without a reconnect ----------------------------

  test "a mid-session revocation stops delivery on the very next dispatch (no reconnect)",
       %{port: port} do
    token_a = run_token()
    token_b = run_token()
    uid_a = stub_uid(token_a)
    uid_b = stub_uid(token_b)

    {ws, ch} = workspace!(token_a, [token_b], ["secret"])

    {conn_a, _} = identify_on(port, token_a)
    {conn_b, _} = identify_on(port, token_b)

    # Visible at connect: both sockets receive.
    assert :ok =
             Publish.publish(
               ch.secret,
               {"MessageCreate", message_payload(ch.secret, uid_a, "before")}
             )

    assert next_event!(conn_b, "MessageCreate", 5_000)["d"]["content"] == "before"
    assert next_event!(conn_a, "MessageCreate", 5_000)["d"]["content"] == "before"

    # Revoke B's VIEW mid-session — the memo must recompute from the bumped
    # epoch, not wait for a reconnect.
    deny_view!(ws, ch.secret, uid_b)

    assert :ok =
             Publish.publish(
               ch.secret,
               {"MessageCreate", message_payload(ch.secret, uid_a, "after")}
             )

    assert next_event!(conn_a, "MessageCreate", 5_000)["d"]["content"] == "after"

    refute_next_event!(conn_b, "MessageCreate", 700)
  end

  # -- #53: the activity + metadata classes ---------------------------------------
  #
  # The remaining half of the asymmetry #51 opened: typing (whose SOURCE gates
  # the sender, never the recipients) and channel/thread lifecycle metadata.
  # Their fan-out seams are replicated from the production callers
  # (`channel_controller` / `thread_controller`) — route key, payload shape, and
  # for channel create the epoch bump the controller performs BEFORE fanning.
  # Those controllers have their own suites; what #53 decides is whether the
  # DISPATCH reaches a session, so these drive the dispatch directly.

  describe "#53 activity and metadata" do
    test "typing recipients are gated: a non-viewer learns nothing of a restricted channel's activity",
         %{port: port} do
      token_a = run_token()
      token_b = run_token()
      uid_a = stub_uid(token_a)
      uid_b = stub_uid(token_b)

      {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
      deny_view!(ws, ch.secret, uid_b)

      {conn_a, ready_a} = identify_on(port, token_a)
      {conn_b, ready_b} = identify_on(port, token_b)

      typing = fn channel_id, uid ->
        %{
          "channel_id" => Integer.to_string(channel_id),
          "thread_id" => nil,
          "user_id" => Integer.to_string(uid),
          "timestamp" => System.system_time(:millisecond)
        }
      end

      # The viewer sees the restricted channel's typing…
      assert FanOut.deliver(ch.secret, {"TypingStart", typing.(ch.secret, uid_a)}) >= 1

      assert next_event!(conn_a, "TypingStart", 5_000)["d"]["channel_id"] ==
               Integer.to_string(ch.secret)

      # …and the denied member sees neither the event nor a trace of it.
      refute_next_event!(conn_b, "TypingStart", 700)

      # Not a blanket mute: B still receives typing on a channel it can view.
      assert FanOut.deliver(ch.general, {"TypingStart", typing.(ch.general, uid_a)}) >= 1

      assert next_event!(conn_b, "TypingStart", 5_000)["d"]["channel_id"] ==
               Integer.to_string(ch.general)

      assert ready_a["user"]["id"] == Integer.to_string(uid_a)
      assert ready_b["user"]["id"] == Integer.to_string(uid_b)
    end

    test "channel + thread metadata is gated: a restricted channel is not advertised to non-viewers",
         %{port: port} do
      token_a = run_token()
      token_b = run_token()
      uid_b = stub_uid(token_b)

      {ws, _ch} = workspace!(token_a, [token_b], ["general"])

      {conn_a, _} = identify_on(port, token_a)
      {conn_b, _} = identify_on(port, token_b)

      # A new RESTRICTED channel, created the way the controller does it: the
      # deny first, then the epoch bump, then the workspace-scoped announce —
      # so every session's memo recomputes and admits the channel only for
      # viewers. (Workspace-keyed, so existing sessions are routed to it
      # without any re-subscription.)
      {:ok, secret} = Workspaces.create_channel(ws.workspace_id, "secret")
      deny_view!(ws, secret.channel_id, uid_b)

      fan_workspace(ws.workspace_id, {
        "ChannelCreate",
        %{
          "id" => Integer.to_string(secret.channel_id),
          "workspace_id" => Integer.to_string(ws.workspace_id),
          "name" => "secret",
          "position" => 0,
          "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
        }
      })

      assert next_event!(conn_a, "ChannelCreate", 5_000)["d"]["id"] ==
               Integer.to_string(secret.channel_id)

      refute_next_event!(conn_b, "ChannelCreate", 700)

      # And a channel B CAN see is still announced to B — the gate is per
      # channel, not a session-wide mute.
      {:ok, open} = Workspaces.create_channel(ws.workspace_id, "open")
      RightsEpoch.bump(ws.workspace_id)

      fan_workspace(ws.workspace_id, {
        "ChannelCreate",
        %{
          "id" => Integer.to_string(open.channel_id),
          "workspace_id" => Integer.to_string(ws.workspace_id),
          "name" => "open",
          "position" => 1,
          "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
        }
      })

      assert next_event!(conn_b, "ChannelCreate", 5_000)["d"]["name"] == "open"
    end

    test "ChannelUpdate on a restricted channel is gated, and the update survives for viewers",
         %{port: port} do
      token_a = run_token()
      token_b = run_token()
      uid_a = stub_uid(token_a)
      uid_b = stub_uid(token_b)

      {ws, ch} = workspace!(token_a, [token_b], ["general", "secret"])
      deny_view!(ws, ch.secret, uid_b)

      {conn_a, _} = identify_on(port, token_a)
      {conn_b, _} = identify_on(port, token_b)

      # The channel exists BEFORE both sessions identify: its channel-key route
      # is in their subscription sets, which is what a rename rides. (A channel
      # created after Identify is a separate, pre-existing native ROUTING gap —
      # see #55 — not a gate question.)
      fan_channel(ch.secret, {
        "ChannelUpdate",
        %{"id" => Integer.to_string(ch.secret), "name" => "secret-renamed"}
      })

      assert next_event!(conn_a, "ChannelUpdate", 5_000)["d"]["name"] == "secret-renamed"
      refute_next_event!(conn_b, "ChannelUpdate", 700)

      # Thread CREATE anchors on the PARENT channel (thread visibility rides
      # the parent's rights) and rides the parent's channel key — same
      # pre-existing-channel requirement as the rename above.
      assert :ok =
               Publish.publish(ch.secret, {
                 "ThreadCreate",
                 %{
                   "id" => Integer.to_string(Cytale.Snowflake.next()),
                   "channel_id" => Integer.to_string(ch.secret),
                   "name" => "a thread",
                   "created_by" => Integer.to_string(uid_a),
                   "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
                 }
               })

      assert next_event!(conn_a, "ThreadCreate", 5_000)["d"]["name"] == "a thread"
      refute_next_event!(conn_b, "ThreadCreate", 700)

      # A thread on a channel B CAN see still reaches B.
      assert :ok =
               Publish.publish(ch.general, {
                 "ThreadCreate",
                 %{
                   "id" => Integer.to_string(Cytale.Snowflake.next()),
                   "channel_id" => Integer.to_string(ch.general),
                   "name" => "an open thread",
                   "created_by" => Integer.to_string(uid_a),
                   "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
                 }
               })

      assert next_event!(conn_b, "ThreadCreate", 5_000)["d"]["name"] == "an open thread"

      # Not a blanket mute: B still hears about a channel it can view.
      fan_channel(ch.general, {
        "ChannelUpdate",
        %{"id" => Integer.to_string(ch.general), "name" => "general-renamed"}
      })

      assert next_event!(conn_b, "ChannelUpdate", 5_000)["d"]["name"] == "general-renamed"
    end

    test "ChannelDelete still reaches VIEWERS — the stale-memo path the controller arranges",
         %{port: port} do
      token_a = run_token()
      token_b = run_token()
      uid_b = stub_uid(token_b)

      {ws, ch} = workspace!(token_a, [token_b], ["secret"])
      deny_view!(ws, ch.secret, uid_b)

      {conn_a, _} = identify_on(port, token_a)
      {conn_b, _} = identify_on(port, token_b)

      # Deleted from the model, and — per the controller's deliberate choice —
      # WITHOUT an epoch bump: the deleted row is gone, so the memo's
      # last-epoch set is the only record that can admit the event. A viewer
      # must still be told the channel is gone, or its sidebar keeps a ghost.
      :ok = Workspaces.delete_channel(ch.secret)

      fan_workspace(ws.workspace_id, {"ChannelDelete", %{"id" => Integer.to_string(ch.secret)}})

      assert next_event!(conn_a, "ChannelDelete", 5_000)["d"]["id"] ==
               Integer.to_string(ch.secret)

      # A non-viewer was never told the channel existed, and is not told it
      # died either.
      refute_next_event!(conn_b, "ChannelDelete", 700)
    end
  end

  # -- #55: a channel created mid-session gets a route ----------------------------
  #
  # The gap this closes is ADDRESSING, not visibility: routes are computed at
  # Identify/Resume only, so a channel created afterwards has no `{:channel, id}`
  # subscription on any live session — and every channel-keyed dispatch about it
  # (a rename, a new thread) is addressed to nobody, viewer included.

  describe "#55 mid-session channel creation" do
    test "a channel created mid-session is routed: its channel-keyed events reach a live session",
         %{port: port} do
      token_a = run_token()
      {ws, _ch} = workspace!(token_a, [], ["general"])

      {conn_a, _} = identify_on(port, token_a)

      # The production sequence for a channel create (`channel_controller.create`):
      # create the channel, bump the epoch, poke the workspace's live sessions to
      # re-join their routes, then announce (workspace-scoped).
      {:ok, fresh} = Workspaces.create_channel(ws.workspace_id, "fresh")
      RightsEpoch.bump(ws.workspace_id)
      CytaleWeb.GatewaySocket.refresh_workspace_routes(ws.workspace_id)

      # The poke is a `send/2` — the socket re-joins in its OWN process — so
      # wait for the subscription to exist rather than assuming it landed.
      # (Production has the same tiny window between a create and a fan-out at
      # the new channel; there the client fetches channel state over REST, so a
      # miss is cosmetic. The test cannot rely on that.)
      wait_for_route!(Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(fresh.channel_id)))

      fan_channel(fresh.channel_id, {
        "ChannelUpdate",
        %{"id" => Integer.to_string(fresh.channel_id), "name" => "fresh-renamed"}
      })

      assert next_event!(conn_a, "ChannelUpdate", 5_000)["d"]["name"] == "fresh-renamed"

      # Thread traffic on the new channel rides the same channel key.
      assert :ok =
               Publish.publish(fresh.channel_id, {
                 "ThreadCreate",
                 %{
                   "id" => Integer.to_string(Cytale.Snowflake.next()),
                   "channel_id" => Integer.to_string(fresh.channel_id),
                   "name" => "a thread",
                   "created_by" => Integer.to_string(stub_uid(token_a)),
                   "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
                 }
               })

      assert next_event!(conn_a, "ThreadCreate", 5_000)["d"]["name"] == "a thread"
    end

    test "the refresh is additive: an existing route is never dropped mid-flight",
         %{port: port} do
      token_a = run_token()
      {ws, ch} = workspace!(token_a, [], ["general"])

      {conn_a, _} = identify_on(port, token_a)

      {:ok, _fresh} = Workspaces.create_channel(ws.workspace_id, "fresh")
      RightsEpoch.bump(ws.workspace_id)
      CytaleWeb.GatewaySocket.refresh_workspace_routes(ws.workspace_id)

      # The pre-existing channel still delivers after the re-sync (the registry
      # inserts before it removes stale keys, so a concurrent fan-out never sees
      # a gap).
      fan_channel(ch.general, {
        "ChannelUpdate",
        %{"id" => Integer.to_string(ch.general), "name" => "still-here"}
      })

      assert next_event!(conn_a, "ChannelUpdate", 5_000)["d"]["name"] == "still-here"
    end
  end

  # The two fan-out seams the lifecycle controllers use, spelled as they do:
  # a workspace-keyed broadcast for create/delete, a channel-keyed one for
  # updates. (`CytaleWeb.GatewaySocket.fan_out/2` is the same public seam the
  # controllers call.)
  defp fan_workspace(workspace_id, {event_name, payload}) do
    CytaleWeb.GatewaySocket.fan_out(
      Cytale.Gateway.PushRegistry.workspace_key(Integer.to_string(workspace_id)),
      {event_name, payload}
    )
  end

  defp fan_channel(channel_id, {event_name, payload}) do
    CytaleWeb.GatewaySocket.fan_out(
      Cytale.Gateway.PushRegistry.channel_key(Integer.to_string(channel_id)),
      {event_name, payload}
    )
  end

  # A route join triggered by a poke is asynchronous (the socket does it in its
  # own process), so a test that fans at a JUST-created channel has to wait for
  # the subscription rather than assume it.
  defp wait_for_route!(route_key, tries \\ 100)

  defp wait_for_route!(_route_key, 0), do: flunk("route never joined")

  defp wait_for_route!(route_key, tries) do
    if Cytale.Gateway.PushRegistry.subscribers(route_key) != [] do
      :ok
    else
      Process.sleep(20)
      wait_for_route!(route_key, tries - 1)
    end
  end
end
