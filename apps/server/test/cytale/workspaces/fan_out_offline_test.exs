defmodule Cytale.Workspaces.FanOutOfflineTest do
  @moduledoc """
  The durable offline buffer (hardening plan 4.2, owner decision (a)).

  Before this, a publication during a session's resume window reached nobody,
  stamped no seq and consumed nothing — so `Session.replay_complete?/2` was
  satisfied and the client resumed believing it was current, with those events
  gone for good. Now the disconnect path HOLDS the session's route keys
  (`PushRegistry.hold_session/2`) and the fan-out appends later events to the
  disconnected record, which the resume replay then delivers.

  These tests drive the production functions only — `PushRegistry`,
  `SessionStore` and `FanOut.buffer_offline/3`/`deliver_user_keys/2` — so the
  seam under test is the one the socket and the workspace process use.
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.{PushRegistry, Session, SessionStore}
  alias Cytale.Workspaces.FanOut

  defp unique, do: System.unique_integer([:positive, :monotonic])

  defp now_ms, do: System.system_time(:millisecond)

  # A stored NATIVE session, disconnected, and held for `routes` — exactly the
  # shape terminate/2 leaves behind.
  defp dropped do
    user_id = "#{9_000_000_000 + unique()}"
    session_id = "s#{unique()}"

    {:ok, %Session{} = session} =
      SessionStore.put(
        Session.new(
          %{id: user_id, username: "offline-#{user_id}"},
          session_id: session_id,
          now_ms: System.system_time(:millisecond)
        )
      )

    # The disconnect stamp terminate/2 writes before it holds the routes.
    session = Session.mark_disconnected(session, System.system_time(:millisecond))
    :ok = SessionStore.update(session)

    routes = [PushRegistry.user_key(user_id), PushRegistry.channel_key("c#{unique()}")]
    :ok = PushRegistry.hold_session(session_id, routes)

    on_exit(fn ->
      PushRegistry.release_held(session_id)
      SessionStore.delete(session_id)
    end)

    %{session: session, session_id: session_id, user_id: user_id, routes: routes}
  end

  defp payload, do: %{"id" => "9#{unique()}", "channel_id" => "c1", "content" => "while away"}

  defp stored!(session_id) do
    case SessionStore.get(session_id) do
      %Session{} = rec -> rec
      nil -> flunk("session record vanished")
    end
  end

  describe "buffer_offline/3" do
    test "a held session's disconnected record gains the event, in seq order" do
      %{session_id: sid, user_id: uid, routes: [user_key | _]} = dropped()
      before = stored!(sid)

      assert :ok = FanOut.buffer_offline(user_key, {"MessageCreate", payload()})
      Cytale.Gateway.SessionStore.await_offline_appends()

      rec = stored!(sid)
      assert rec.seq == before.seq + 1

      # What the client actually gets on Resume: everything above the seq it
      # last processed, re-encoded from the stored payload.
      assert [%{op: 0, s: seq, t: "MessageCreate", d: %{"content" => "while away"}}] =
               Session.buffered_after(rec, before.seq)

      assert seq == before.seq + 1
      assert rec.phase == :disconnected
      assert uid == rec.user.id
    end

    test "the production delivery path reaches the held session, not just the helper" do
      # `deliver_user_keys/2` is what the profile, DM and read-ack origins call:
      # it resolves the user key's LIVE subscribers (none — the socket is gone)
      # and then the offline half. This is the end-to-end proof that a publish
      # during the resume window is no longer dropped on the floor.
      %{session_id: sid, user_id: uid} = dropped()
      before = stored!(sid)

      assert FanOut.deliver_user_keys([String.to_integer(uid)], {"MessageAck", payload()}) == 0
      Cytale.Gateway.SessionStore.await_offline_appends()

      assert stored!(sid).seq == before.seq + 1
    end

    test "a COMPAT session is never written (the documented residual)" do
      # A compat record's buffer is fed by the socket's translated dispatch path
      # and re-filtered at replay; appending a native payload there would put
      # native shapes on the Discord wire. Compat keeps Invalid Session + a REST
      # full sync on reconnect instead.
      user_id = "u#{unique()}"
      sid = "s#{unique()}"

      {:ok, %Session{}} =
        SessionStore.put(Session.new(%{id: user_id, username: "bot"}, session_id: sid, mode: :compat))

      :ok = PushRegistry.hold_session(sid, [PushRegistry.user_key(user_id)])
      before = stored!(sid)

      on_exit(fn ->
        PushRegistry.release_held(sid)
        SessionStore.delete(sid)
      end)

      assert :ok = FanOut.buffer_offline(PushRegistry.user_key(user_id), {"MessageCreate", payload()})
      Cytale.Gateway.SessionStore.await_offline_appends()

      assert stored!(sid).seq == before.seq
      assert stored!(sid).events == []
    end

    test "a LIVE record is never written, even under a stale hold" do
      # The live socket is the record's single writer (it stamps seq through
      # `SessionStore.update_local/2`); a buffered copy from the fan-out would
      # stamp the SAME event a second seq and deliver it twice.
      %{session_id: sid, user_id: uid} = dropped()
      before = stored!(sid)
      :ok = SessionStore.update(Session.mark_connected(before))

      assert :ok = FanOut.buffer_offline(PushRegistry.user_key(uid), {"MessageCreate", payload()})
      Cytale.Gateway.SessionStore.await_offline_appends()

      assert stored!(sid).seq == before.seq
    end

    test "events the resume tail re-derives, or that are ephemeral, are skipped" do
      # Buffering `PresenceUpdate` would replay the departing session's OWN
      # offline presence after the fresh snapshot says it is online; typing is
      # meaningless late; CALL_* is visibility-filtered at the live fan-out
      # (AM9) and re-synced by `emit_call_sync/1`.
      %{session_id: sid, user_id: uid} = dropped()
      before = stored!(sid)

      for event <-
            ~w(PresenceUpdate ReadStateSync TypingStart CallStart CallUpdate CallEnd CallRing CallSignal CallSync) do
        :ok = FanOut.buffer_offline(PushRegistry.user_key(uid), {event, payload()})
        Cytale.Gateway.SessionStore.await_offline_appends()
      end

      assert stored!(sid).seq == before.seq
      assert stored!(sid).events == []
    end

    test "the {:user, id} exclusion applies to held sessions too" do
      %{session_id: sid, user_id: uid} = dropped()
      before = stored!(sid)

      :ok =
        FanOut.buffer_offline(
          PushRegistry.user_key(uid),
          {"MessageCreate", payload()},
          {:user, uid}
        )

      Cytale.Gateway.SessionStore.await_offline_appends()

      assert stored!(sid).seq == before.seq

      :ok =
        FanOut.buffer_offline(
          PushRegistry.user_key(uid),
          {"MessageCreate", payload()},
          {:user, "someone-else"}
        )

      Cytale.Gateway.SessionStore.await_offline_appends()

      assert stored!(sid).seq == before.seq + 1
    end

    test "a hold whose record is gone is released, not written" do
      # The expiry sweep releases explicitly; this is the defensive half — a
      # record deleted by another path must not leave a hold that every later
      # fan-out on that route keeps looking up.
      sid = "s#{unique()}"
      key = PushRegistry.user_key("u#{unique()}")
      :ok = PushRegistry.hold_session(sid, [key])

      assert PushRegistry.held_sessions(key) == [sid]
      assert :ok = FanOut.buffer_offline(key, {"MessageCreate", payload()})
      Cytale.Gateway.SessionStore.await_offline_appends()
      assert PushRegistry.held_sessions(key) == []
    end

    test "many held sessions on one route all receive the event" do
      # `SessionStore.append_offline/4` groups the held ids by their owning shard
      # so a mass disconnect cannot turn one publish into one blocking shard call
      # per offline member. Grouping must not lose anybody, and each record keeps
      # its own seq.
      channel = PushRegistry.channel_key("c#{unique()}")

      ids =
        for n <- 1..4 do
          id = "s#{unique()}"
          uid = "#{9_000_000_000 + unique()}"

          {:ok, %Session{} = rec} =
            SessionStore.put(Session.new(%{id: uid, username: "held#{n}"}, session_id: id, now_ms: now_ms()))

          :ok = SessionStore.update(Session.mark_disconnected(rec, now_ms()))
          :ok = PushRegistry.hold_session(id, [channel])
          id
        end

      on_exit(fn ->
        for id <- ids do
          PushRegistry.release_held(id)
          SessionStore.delete(id)
        end
      end)

      assert :ok = FanOut.buffer_offline(channel, {"MessageCreate", payload()})
      Cytale.Gateway.SessionStore.await_offline_appends()

      for id <- ids do
        rec = SessionStore.get(id)
        assert rec.seq == 1, "session #{id} did not receive the buffered event"
        assert [%{t: "MessageCreate", s: 1}] = Session.buffered_after(rec, 0)
      end
    end

    test "routes with no hold cost one empty lookup" do
      assert FanOut.buffer_offline(PushRegistry.channel_key("nobody"), {"MessageCreate", payload()}) ==
               :ok
    end
  end

  describe "the hold index" do
    test "hold replaces, release retires, and both directions agree" do
      sid = "s#{unique()}"
      a = PushRegistry.channel_key("a#{unique()}")
      b = PushRegistry.user_key("b#{unique()}")

      :ok = PushRegistry.hold_session(sid, [a])
      assert PushRegistry.held_sessions(a) == [sid]

      # A re-drop after a resume replaces the set: the old route must not keep
      # answering for a session that no longer holds it.
      :ok = PushRegistry.hold_session(sid, [b])
      assert PushRegistry.held_sessions(a) == []
      assert PushRegistry.held_sessions(b) == [sid]

      # Idempotent: the same hold twice is still one row per route.
      :ok = PushRegistry.hold_session(sid, [b])
      assert PushRegistry.held_sessions(b) == [sid]

      held_before = PushRegistry.held_count()
      :ok = PushRegistry.release_held(sid)
      assert PushRegistry.held_sessions(b) == []
      assert PushRegistry.held_count() == held_before - 1
    end

    test "a session with no routes is not held at all" do
      sid = "s#{unique()}"
      held_before = PushRegistry.held_count()
      :ok = PushRegistry.hold_session(sid, [])
      assert PushRegistry.held_count() == held_before
    end

    test "releasing an unknown session is a no-op" do
      assert PushRegistry.release_held("never-held-#{unique()}") == :ok
    end
  end
end
