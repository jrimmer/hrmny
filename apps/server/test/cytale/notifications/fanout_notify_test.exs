defmodule Cytale.Notifications.FanoutNotifyTest do
  @moduledoc """
  U4 of the notification plan — the fan-out seam actually reaches delivery.

  The dispatcher's own tests prove the decisions; this proves the wiring, which
  is the part that fails silently. A notification system whose policy is
  perfect and whose hook was never called looks exactly like a system with
  nothing to say.

  The delivery implementation is swapped for the recorder, so no egress is
  attempted and the decision is assertable.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Notifications.{Delivery, Dispatcher, Focus, Preferences}
  alias Cytale.Workspaces

  setup do
    previous = Application.get_env(:cytale, Delivery)
    Application.put_env(:cytale, Delivery, Delivery.Recorder)
    :ok = Delivery.Recorder.start()
    :ok = Focus.ensure_started()

    on_exit(fn ->
      if previous do
        Application.put_env(:cytale, Delivery, previous)
      else
        Application.delete_env(:cytale, Delivery)
      end
    end)

    {:ok, owner} =
      Cytale.Accounts.User.create(
        "notif_owner#{Cytale.TestNonce.get()}",
        "notif_owner#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    {:ok, ws} = Workspaces.create_workspace(owner.user_id, "notif-ws-#{System.unique_integer()}")
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "notif-ch")

    %{ws: ws, channel: channel, owner: owner}
  end

  defp run_token, do: "cytale_notif_" <> Cytale.TestNonce.get()

  defp run_id, do: String.to_integer("8#{Cytale.TestNonce.get()}")

  # Register THIS process as a live session for the channel, which is what the
  # fan-out enumerates — for a real MEMBER of the workspace: the notification
  # audience is the visibility-filtered roster, and a live socket alone is not
  # a right to the content (security tier 1 #2).
  defp subscribe(ws, user_id, channel_id) do
    :ok = Workspaces.add_member(ws.workspace_id, user_id, ws.owner_id, [])
    :ok = PushRegistry.subscribe(PushRegistry.channel_key(Integer.to_string(channel_id)), user_id, self())
    :ok = PushRegistry.subscribe(PushRegistry.user_key(Integer.to_string(user_id)), user_id, self())
  end

  defp message_payload(channel_id, author_id, content, extra \\ %{}) do
    Map.merge(
      %{
        "id" => Integer.to_string(run_id()),
        "channel_id" => Integer.to_string(channel_id),
        "author_id" => Integer.to_string(author_id),
        "content" => content,
        "thread_id" => nil,
        "created_at" => DateTime.utc_now() |> DateTime.to_iso8601()
      },
      extra
    )
  end

  defp fan_out!(ws, channel_id, payload) do
    :ok = Cytale.Workspaces.Workspace.fan_out(ws.workspace_id, {"MessageCreate", payload})
    :ok
  end

  # What the recorder holds for THIS test's workspace. The notification task
  # runs off the fan-out path, so a delivery from an earlier test can land
  # after this test's setup reset the recorder; every test here makes its own
  # workspace, so scoping to it keeps a straggler from counting here.
  defp notifications(ws) do
    Enum.filter(Delivery.Recorder.notifications(), &(&1.payload["workspace_id"] == ws.workspace_id))
  end

  # 200 × 50 ms: the notification task resolves the audience against the
  # database off the fan-out path, and on a loaded CI runner 2 s (the old
  # budget) was not always enough — the wait only runs long when late.
  defp wait_for_notifications(ws, expected, tries \\ 200)

  defp wait_for_notifications(ws, _expected, 0), do: notifications(ws)

  defp wait_for_notifications(ws, expected, tries) do
    current = notifications(ws)

    if length(current) >= expected do
      current
    else
      Process.sleep(50)
      wait_for_notifications(ws, expected, tries - 1)
    end
  end

  defp await_true(fun, tries \\ 200)
  defp await_true(_fun, 0), do: false

  defp await_true(fun, tries) do
    if fun.() do
      true
    else
      Process.sleep(50)
      await_true(fun, tries - 1)
    end
  end

  test "a delivered channel message reaches the delivery seam", %{ws: ws, channel: ch, owner: owner} do
    recipient = run_id()
    :ok = Preferences.set_level(recipient, :channel, ch.channel_id, "all")
    subscribe(ws, recipient, ch.channel_id)

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "hello all"))

    [notification] = wait_for_notifications(ws, 1)
    assert notification.user_id == recipient
    assert notification.event_name == "MessageCreate"
    assert notification.payload["content"] == "hello all"
  end

  test "a mention decides push while plain traffic badges — only push is delivered", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    mentioned = run_id()
    other = run_id()
    subscribe(ws, mentioned, ch.channel_id)
    subscribe(ws, other, ch.channel_id)

    fan_out!(
      ws,
      ch.channel_id,
      message_payload(ch.channel_id, owner.user_id, "hey <@#{mentioned}> look")
    )

    delivered = wait_for_notifications(ws, 1)

    # Only the mentioned member is pushed; the other's badge is in-app state
    # and is not a delivery channel's business.
    assert Enum.map(delivered, & &1.user_id) == [mentioned]
    assert hd(delivered).rule == :direct_mention
  end

  test "a muted member is never delivered to", %{ws: ws, channel: ch, owner: owner} do
    recipient = run_id()
    :ok = Preferences.set_level(recipient, :channel, ch.channel_id, "mute")
    subscribe(ws, recipient, ch.channel_id)

    fan_out!(
      ws,
      ch.channel_id,
      message_payload(ch.channel_id, owner.user_id, "urgent <@#{recipient}>")
    )

    Process.sleep(300)
    assert notifications(ws) == []
  end

  test "a focused member is not interrupted", %{ws: ws, channel: ch, owner: owner} do
    recipient = run_id()
    :ok = Preferences.set_level(recipient, :channel, ch.channel_id, "all")
    :ok = Focus.report(recipient, "sess-focused", true)
    subscribe(ws, recipient, ch.channel_id)

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "seen already"))

    Process.sleep(300)
    assert notifications(ws) == []
  end

  test "the author is never notified about their own message", %{ws: ws, channel: ch} do
    author = run_id()
    :ok = Preferences.set_level(author, :channel, ch.channel_id, "all")
    subscribe(ws, author, ch.channel_id)

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, author, "note to self <@#{author}>"))

    Process.sleep(300)
    assert notifications(ws) == []
  end

  test "a non-message event is not considered", %{ws: ws, channel: ch, owner: owner} do
    recipient = run_id()
    :ok = Preferences.set_level(recipient, :channel, ch.channel_id, "all")
    subscribe(ws, recipient, ch.channel_id)

    :ok =
      Cytale.Workspaces.Workspace.fan_out(
        ws.workspace_id,
        {"MessageDelete", message_payload(ch.channel_id, owner.user_id, "")}
      )

    Process.sleep(300)
    assert notifications(ws) == []
  end

  test "a member who posted in a muted channel is still told about a reply (R11)", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    # The member mutes a noisy channel, then posts in it, then walks away. A
    # reply arrives. Discord and Slack both stop at the mute and lose it with
    # no signal — this is the miss the design was justified by.
    member = run_id()
    :ok = Preferences.set_level(member, :channel, ch.channel_id, "mute")
    subscribe(ws, member, ch.channel_id)

    # They post: the fan-out records that they took part.
    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, member, "my question"))

    assert await_true(fn -> Cytale.Notifications.Participations.participated?(member, ch.channel_id) end),
           "posting in a channel must record participation"

    # Someone replies, with no mention — exactly the case a mute would eat.
    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "an answer for you"))

    delivered = wait_for_notifications(ws, 1) |> Enum.filter(&(&1.user_id == member))

    assert delivered != [],
           "a reply in a channel the member posted in must reach them despite the mute"
  end

  test "a member who never posted in a muted channel still hears nothing", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    bystander = run_id()
    :ok = Preferences.set_level(bystander, :channel, ch.channel_id, "mute")
    subscribe(ws, bystander, ch.channel_id)

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "unrelated chatter"))

    Process.sleep(300)

    assert Enum.filter(notifications(ws), &(&1.user_id == bystander)) == [],
           "the sweep must not defeat a mute for someone who never took part"
  end

  # WHY THIS TEST EXISTS: the owner turned notifications on, was mentioned, and
  # heard nothing. The audience was the fan-out's LIVE subscriber list, so a
  # member whose app was closed had no live session, was never a recipient, and
  # a push could only ever reach someone already connected — which made push
  # redundant with the thing it exists to back up. This drives the real fan-out
  # with NO live session at all.
  test "an OFFLINE member with a subscription is still notified (the audience is membership)", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    # A real member of the workspace, with a real push target, and no session.
    offline = run_id()
    :ok = Cytale.Workspaces.add_member(ws.workspace_id, offline, owner.user_id, [])

    :ok =
      Cytale.Workspaces.put_push_subscription(
        offline,
        "https://push.example.com/offline-#{offline}",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    :ok = Preferences.set_level(offline, :channel, ch.channel_id, "all")

    # No subscribe/2 call: this member has no live socket.
    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "are you there?"))

    delivered =
      wait_for_notifications(ws, 1) |> Enum.filter(&(&1.user_id == offline))

    assert delivered != [],
           "a member with the app closed must be told — that is what push is for"
  end

  test "a mention reaches an offline member even at the default level", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    offline = run_id()
    :ok = Cytale.Workspaces.add_member(ws.workspace_id, offline, owner.user_id, [])

    :ok =
      Cytale.Workspaces.put_push_subscription(
        offline,
        "https://push.example.com/mention-#{offline}",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    # The DEFAULT (mentions) — no explicit preference set at all.
    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "hey <@#{offline}>"))

    delivered = wait_for_notifications(ws, 1) |> Enum.filter(&(&1.user_id == offline))

    assert delivered != [], "a mention must reach an offline member at the default level"
    assert hd(delivered).rule == :direct_mention
  end

  test "a live, subscribed member who cannot VIEW the channel gets no verdict and no push", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    blind = run_id()
    :ok = Workspaces.add_member(ws.workspace_id, blind, owner.user_id, [])
    :ok = Preferences.set_level(blind, :channel, ch.channel_id, "all")

    :ok =
      Cytale.Workspaces.put_push_subscription(
        blind,
        "https://push.example.com/blind-#{blind}",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    Workspaces.put_overwrite(ch.channel_id, :member, blind, 0, Cytale.Permissions.Bitfield.bit(:view_channel))
    # A live socket on the channel's route — what used to earn the verdict.
    :ok = PushRegistry.subscribe(PushRegistry.channel_key(Integer.to_string(ch.channel_id)), blind, self())

    payload = message_payload(ch.channel_id, owner.user_id, "private words <@#{blind}>")

    # The decision layer, given the filtered audience, never names them…
    verdicts =
      Dispatcher.verdicts("MessageCreate", payload, [{self(), blind}],
        workspace_id: ws.workspace_id,
        members: [],
        subscribed: MapSet.new([blind])
      )

    assert verdicts == []

    # …and the real fan-out delivers them no notification.
    fan_out!(ws, ch.channel_id, payload)
    Process.sleep(500)
    assert Enum.filter(notifications(ws), &(&1.user_id == blind)) == []
  end

  test "@everyone from a member without mention_everyone pushes nobody; from the owner it does (security tier 1 #8)",
       %{ws: ws, channel: ch, owner: owner} do
    offline = run_id()
    :ok = Workspaces.add_member(ws.workspace_id, offline, owner.user_id, [])

    :ok =
      Cytale.Workspaces.put_push_subscription(
        offline,
        "https://push.example.com/bcast-#{offline}",
        Jason.encode!(%{"p256dh" => "p", "auth" => "a"})
      )

    {:ok, plain} =
      Cytale.Accounts.User.create(
        "bc_plain#{Cytale.TestNonce.get()}",
        "bc_plain#{Cytale.TestNonce.get()}@example.com",
        "password-123"
      )

    :ok = Workspaces.add_member(ws.workspace_id, plain.user_id, owner.user_id, [])

    # No `mention_everyone` key on the payload: the dispatcher resolves the
    # author itself, fail-closed.
    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, plain.user_id, "@everyone lunch?"))
    Process.sleep(500)
    assert Enum.filter(notifications(ws), &(&1.user_id == offline)) == []

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "@everyone all hands"))
    delivered = wait_for_notifications(ws, 1) |> Enum.filter(&(&1.user_id == offline))
    assert [%{rule: :broadcast_mention}] = delivered
  end

  test "in-app fan-out still happens — a notification decision never costs the message", %{
    ws: ws,
    channel: ch,
    owner: owner
  } do
    recipient = run_id()
    subscribe(ws, recipient, ch.channel_id)

    fan_out!(ws, ch.channel_id, message_payload(ch.channel_id, owner.user_id, "delivered anyway"))

    # The fan-out's pre-encoded fragment rides as a 4th element (plan 2.3).
    assert_receive {:cytale_gateway_push, _from, {"MessageCreate", payload}, _fragment}, 2_000
    assert payload["content"] == "delivered anyway"
  end

  # Hardening plan 1.3. The fan-out now asks `concerned?/1` before computing the
  # audience, because those reads used to be eager keyword arguments: `members`
  # is a full member read plus a per-member permission resolve for a
  # channel-anchored event, and `subscribed` a second member read, and both were
  # paid by EVERY fan-out event — TypingStart, the highest-rate event in the
  # product, included — only for `verdicts/4`'s guard to discard them.
  #
  # This pins the single source of truth so the two cannot drift: the guard in
  # `verdicts/4` and the fan-out's skip both consult `@concerned_events` through
  # this predicate, so a class added for notification can never be skipped, and
  # a class the dispatcher ignores can never be paid for.
  # Review finding #11. The fan-out's notification+index leg used to be a bare
  # `Task.start` per event: unbounded, unsupervised, and invisible. It now rides
  # the supervisor the push leg already uses, which must carry a ceiling — an
  # "intended bound" that was never applied is the failure mode being guarded.
  test "the fan-out's consequence work runs under a bounded supervisor" do
    state = :sys.get_state(Cytale.Notifications.TaskSupervisor)
    assert is_integer(state.max_children) and state.max_children > 0
  end

  test "concerned?/1 agrees with the dispatcher's own discard rule" do
    for event <- ~w(MessageCreate ThreadMessageCreate) do
      assert Dispatcher.concerned?(event), "#{event} must be a notification concern"
    end

    for event <- ~w(TypingStart PresenceUpdate MessageDelete MessageUpdate CallUpdate) do
      refute Dispatcher.concerned?(event), "#{event} must not cost audience work"
    end

    # The guard itself, so the predicate cannot outlive the rule it mirrors.
    assert Dispatcher.verdicts("TypingStart", %{"channel_id" => "1"}, [], []) == []
  end
end
