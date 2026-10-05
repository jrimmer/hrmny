defmodule Cytale.Marks.SweeperTest do
  @moduledoc """
  #54 U4 — the due-time sweep, driven directly (`Sweeper.sweep/2` is a
  function of "now" and a scope), asserting EFFECTS on read state and the
  owner's gateway key rather than return values alone.
  """

  use Cytale.ScyllaCase, async: false

  alias Cytale.Accounts.User
  alias Cytale.Gateway.PushRegistry
  alias Cytale.Marks
  alias Cytale.Marks.Sweeper
  alias Cytale.Messages
  alias Cytale.Messages.ReadState
  alias Cytale.Workspaces

  @minute 60_000
  @hour 60 * @minute

  defp run_unique(base), do: base <> "r" <> Cytale.TestNonce.get()

  setup do
    {:ok, owner} = User.create(run_unique("sw"), run_unique("sw@example.com"), "password-123")
    {:ok, ws} = Workspaces.create_workspace(owner.user_id, run_unique("sw-ws"))
    {:ok, ch} = Workspaces.create_channel(ws.workspace_id, run_unique("sw-ch"))

    # Watch the owner's user key: the fire is user-addressed.
    key = Integer.to_string(owner.user_id)
    :ok = PushRegistry.subscribe(PushRegistry.user_key(key), key)

    %{owner: owner, ws: ws, ch: ch, scope: fn row -> row.user_id == owner.user_id end}
  end

  defp message!(ch, author) do
    {:ok, m} =
      Messages.create_message(%{channel_id: ch.channel_id, author_id: author.user_id, content: "later", thread_id: nil})

    m
  end

  # Set a mark "from the past": `now` is supplied, so due times are relative
  # to it and the sweep can be run at any instant without sleeping.
  defp mark!(owner, msg, due_ms, set_at \\ nil) do
    {:ok, mark} = Marks.set(owner.user_id, "snooze", msg, due_ms, set_at || due_ms - @hour)
    mark
  end

  defp fires_received do
    receive do
      {:cytale_gateway_push, _, {"ReadStateUpdate", _}, _} -> 1 + fires_received()
    after
      300 -> 0
    end
  end

  defp floor(owner, ch), do: (ReadState.get(owner.user_id, ch.channel_id) || %{})[:unread_floor]

  test "boundary: due exactly now fires; 1 ms in the future does not; the past fires next tick", %{
    owner: owner,
    ch: ch,
    scope: scope
  } do
    t = System.system_time(:millisecond)
    early = message!(ch, owner)
    later = message!(ch, owner)
    mark!(owner, early, t)
    mark!(owner, later, t + 1)

    assert %{fired: 1} = Sweeper.sweep(t, scope: scope)
    assert Marks.get(owner.user_id, "snooze", early.id).state == "fired"
    assert Marks.get(owner.user_id, "snooze", later.id).state == "pending"
    assert floor(owner, ch) == early.id

    assert %{fired: 1} = Sweeper.sweep(t + @minute, scope: scope)
    assert Marks.get(owner.user_id, "snooze", later.id).state == "fired"
  end

  test "the fire makes the MARKED message unread (exclusive floor) and tells only the owner's sessions", %{
    owner: owner,
    ws: ws,
    ch: ch,
    scope: scope
  } do
    {:ok, peer} = User.create(run_unique("peer"), run_unique("peer@example.com"), "password-123")
    :ok = Workspaces.add_member(ws.workspace_id, peer.user_id, owner.user_id)
    peer_key = Integer.to_string(peer.user_id)
    :ok = PushRegistry.subscribe(PushRegistry.user_key(peer_key), peer_key)

    msg = message!(ch, owner)
    # The owner had read past it.
    :ok = ReadState.write(owner.user_id, ch.channel_id, %{last_read_id: msg.id})
    t = System.system_time(:millisecond)
    mark!(owner, msg, t)

    Sweeper.sweep(t, scope: scope)

    assert_receive {:cytale_gateway_push, _, {"ReadStateUpdate", payload}, _}, 2_000
    assert payload["channel_id"] == Integer.to_string(ch.channel_id)
    assert payload["unread_floor"] == Integer.to_string(msg.id)
    assert ReadState.unread_since(owner.user_id, ch.channel_id, msg.id)
    # Exactly one delivery, and it was the owner's (both keys route to this
    # test process, so the peer's would have been a second one).
    assert fires_received() == 0
  end

  test "idempotence and catch-up: a second sweep fires nothing again", %{owner: owner, ch: ch, scope: scope} do
    t = System.system_time(:millisecond)
    mark!(owner, message!(ch, owner), t - 10 * @minute)

    assert %{fired: 1} = Sweeper.sweep(t, scope: scope)
    assert %{fired: 0} = Sweeper.sweep(t, scope: scope)
    assert %{fired: 0} = Sweeper.sweep(t + @minute, scope: scope)
  end

  test "a mark older than the lookback resolves missed — never fired late", %{owner: owner, ch: ch, scope: scope} do
    t = System.system_time(:millisecond)
    msg = message!(ch, owner)
    mark!(owner, msg, t - Marks.lookback_ms() - @minute)

    assert %{fired: 0, missed: 1} = Sweeper.sweep(t, scope: scope)
    assert Marks.get(owner.user_id, "snooze", msg.id).state == "missed"
    assert floor(owner, ch) == nil
  end

  test "coalescing: three overdue marks in one channel → one floor move at the earliest, one event", %{
    owner: owner,
    ch: ch,
    scope: scope
  } do
    t = System.system_time(:millisecond)
    [first | _] = msgs = for _ <- 1..3, do: message!(ch, owner)
    Enum.each(msgs, &mark!(owner, &1, t - 5 * @minute))

    assert %{fired: 3} = Sweeper.sweep(t, scope: scope)
    assert floor(owner, ch) == first.id
    assert fires_received() == 1
  end

  test "the fence: cancelled, re-set, and orphaned index rows fire nothing and raise nothing", %{
    owner: owner,
    ch: ch,
    scope: scope
  } do
    t = System.system_time(:millisecond)

    cancelled = message!(ch, owner)
    mark!(owner, cancelled, t - @minute)
    :ok = Marks.cancel(owner.user_id, "snooze", cancelled.id)

    reset = message!(ch, owner)
    mark!(owner, reset, t - @minute, t - @hour)
    {:ok, _} = Marks.set(owner.user_id, "snooze", reset, t + @hour, t - 30 * @minute)

    # An index row with no authoritative row behind it.
    Cytale.Repo.execute!(
      "INSERT INTO {{K}}.message_marks_by_due (due_bucket, due_at, mark_id, user_id, kind, target_id, channel_id, state) VALUES (?, ?, ?, ?, 'snooze', ?, ?, 'pending')",
      [
        {"bigint", Marks.due_bucket(t - @minute)},
        {"timestamp", DateTime.from_unix!(t - @minute, :millisecond)},
        {"bigint", Cytale.Snowflake.next()},
        {"bigint", owner.user_id},
        {"bigint", Cytale.Snowflake.next()},
        {"bigint", ch.channel_id}
      ]
    )

    assert %{fired: 0} = Sweeper.sweep(t, scope: scope)
    assert floor(owner, ch) == nil
    assert Marks.get(owner.user_id, "snooze", reset.id).state == "pending"
    assert fires_received() == 0
  end

  test "a deleted target, or a channel the owner can no longer read, drops the fire — no read-state write", %{
    owner: owner,
    ws: ws,
    ch: ch,
    scope: scope
  } do
    t = System.system_time(:millisecond)
    gone = message!(ch, owner)
    mark!(owner, gone, t - @minute)
    :ok = Messages.delete_message(ch.channel_id, gone.id)

    assert %{fired: 0, missed: 1} = Sweeper.sweep(t, scope: scope)
    assert floor(owner, ch) == nil

    # Access lost: a member who marked a message and then left.
    {:ok, leaver} = User.create(run_unique("leaver"), run_unique("leaver@example.com"), "password-123")
    :ok = Workspaces.add_member(ws.workspace_id, leaver.user_id, owner.user_id)
    kept = message!(ch, owner)
    {:ok, _} = Marks.set(leaver.user_id, "snooze", kept, t + @minute, t)
    :ok = Workspaces.remove_member(ws.workspace_id, leaver.user_id)

    assert %{fired: 0, missed: 1} = Sweeper.sweep(t + 2 * @minute, scope: &(&1.user_id == leaver.user_id))
    assert ReadState.get(leaver.user_id, ch.channel_id) == nil
  end

  test "a burst is processed in bounded batches across ticks", %{owner: owner, ch: ch, scope: scope} do
    t = System.system_time(:millisecond)
    for _ <- 1..5, do: mark!(owner, message!(ch, owner), t - @minute)

    assert %{fired: 2} = Sweeper.sweep(t, scope: scope, batch: 2)
    assert %{fired: 2} = Sweeper.sweep(t, scope: scope, batch: 2)
    assert %{fired: 1} = Sweeper.sweep(t, scope: scope, batch: 2)
    assert %{fired: 0} = Sweeper.sweep(t, scope: scope, batch: 2)
  end

  test "an empty due set does no work", %{scope: scope} do
    assert %{fired: 0, missed: 0, settled: 0} = Sweeper.sweep(System.system_time(:millisecond), scope: scope)
  end
end
