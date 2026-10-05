defmodule Cytale.Gateway.SessionTest do
  @moduledoc """
  Pure session-record transitions (U10): identity binding, sequence/buffer
  accounting, heartbeat-deadline math, resume-window expiry, and control-frame
  builders. No sockets, no ETS, no timers — wall-clock time is injected.
  """

  use ExUnit.Case, async: true

  alias Cytale.Gateway.{Opcode, Session}

  @user %{id: "42", username: "janet"}
  @window 10 * 60 * 1000

  defp new_session(opts \\ []) do
    Session.new(@user, Keyword.merge([now_ms: 1_000], opts))
  end

  # ---------------------------------------------------------------------------
  # Construction / identity binding
  # ---------------------------------------------------------------------------

  describe "new/2" do
    test "binds the authenticated identity and mints opaque secrets" do
      session = new_session()

      assert session.user == @user
      assert session.seq == 0
      assert session.events == []
      assert session.created_at_ms == 1_000
      assert session.phase == :connected
      assert String.length(session.session_id) == 21
      assert String.starts_with?(session.session_id, "s")
      assert String.length(session.resume_token) == 32
    end

    test "session ids and resume tokens are unique across mints" do
      ids = for _ <- 1..500, do: new_session().session_id
      assert length(Enum.uniq(ids)) == 500

      tokens = for _ <- 1..500, do: new_session().resume_token
      assert length(Enum.uniq(tokens)) == 500
    end

    test "forced ids/tokens are honored (test support)" do
      session = Session.new(@user, session_id: "sFIXED", resume_token: "tok", now_ms: 1)
      assert session.session_id == "sFIXED"
      assert session.resume_token == "tok"
    end

    test "compress mode is carried" do
      assert new_session(compress: :zstd_stream).compress == :zstd_stream
      assert new_session(compress: :none).compress == :none
    end
  end

  describe "phase transitions" do
    test "mark_disconnected anchors the resume window on the drop" do
      session = new_session(now_ms: 100)
      dropped = Session.mark_disconnected(session, 500)

      assert dropped.phase == :disconnected
      assert dropped.last_disconnect_at_ms == 500
      refute Session.live?(dropped)
    end

    test "mark_connected revives a dropped session" do
      dropped = Session.mark_disconnected(new_session(now_ms: 100), 500)
      revived = Session.mark_connected(dropped)

      assert Session.live?(revived)
      # The disconnect stamp survives; expiry anchor remains the LAST drop.
      assert revived.last_disconnect_at_ms == 500
    end
  end

  describe "resume-window expiry (5min target / 10min hard floor)" do
    test "a never-dropped record expires by age alone (sweepable)" do
      session = new_session(now_ms: 0)
      assert Session.expired?(session, @window * 10, @window)
      refute Session.expired?(session, div(@window, 2), @window)
    end

    test "expired exactly at the window boundary is still resumable" do
      session = new_session(now_ms: 0) |> Session.mark_disconnected(1_000)
      refute Session.expired?(session, 1_000 + @window, @window)
    end

    test "expired just past the window (anchor = disconnect)" do
      session = new_session(now_ms: 0) |> Session.mark_disconnected(1_000)
      assert Session.expired?(session, 1_000 + @window + 1, @window)
    end

    test "a long-lived session that just dropped gets the FULL window" do
      # Live for an hour, drop, then check shortly after the drop.
      session =
        new_session(now_ms: 0)
        |> Session.mark_connected()
        |> Session.mark_disconnected(60 * 60 * 1000)

      refute Session.expired?(session, 60 * 60 * 1000 + div(@window, 2), @window)
    end

    test "records without any anchor never expire (defensive)" do
      session = %{new_session() | created_at_ms: nil}
      refute Session.expired?(session, 999_999_999, @window)
    end
  end

  # ---------------------------------------------------------------------------
  # Sequence-numbered resume buffer
  # ---------------------------------------------------------------------------

  describe "buffer_event/3" do
    test "assigns monotonic per-session sequence numbers" do
      {s1, env1} = Session.buffer_event(new_session(), "MessageCreate", %{"x" => 1})
      {s2, env2} = Session.buffer_event(s1, "TypingStart", %{"x" => 2})

      assert env1.op == 0 and env1.s == 1 and env1.t == "MessageCreate"
      assert env2.op == 0 and env2.s == 2 and env2.t == "TypingStart"
      assert s2.seq == 2
      assert Session.buffered_count(s2) == 2
    end

    test "buffered_after/2 returns everything past seq, oldest-first (the replay)" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})
      {s, _} = Session.buffer_event(s, "B", %{})
      {s, _} = Session.buffer_event(s, "C", %{})

      replay = Session.buffered_after(s, 1)
      assert Enum.map(replay, & &1.t) == ["B", "C"]
      assert Enum.map(replay, & &1.s) == [2, 3]
    end

    test "buffered_after/2 with the high-water mark returns nothing" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})
      assert Session.buffered_after(s, s.seq) == []
    end

    test "peek_buffered/2 finds a stored envelope by seq" do
      {s, env} = Session.buffer_event(new_session(), "A", %{"k" => "v"})
      assert Session.peek_buffered(s, env.s).d == %{"k" => "v"}
      assert Session.peek_buffered(s, 99) == nil
    end

    test "trim_to_seq/2 drops up to and including seq" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})
      {s, _} = Session.buffer_event(s, "B", %{})
      s = Session.trim_to_seq(s, 1)

      assert Session.buffered_count(s) == 1
      assert hd(Session.buffered_after(s, 0)).t == "B"
    end

    test "trim_to_seq/2 beyond the high-water mark raises (caller bug)" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})

      assert_raise ArgumentError, ~r/exceeds recorded high-water-mark/, fn ->
        Session.trim_to_seq(s, 5)
      end
    end

    # B1: the buffer is BOUNDED — a flood of dispatches never grows it past
    # the cap, and eviction always drops the OLDEST envelopes.
    test "buffer_event/3 bounds the buffer at buffer_cap under a flood (oldest evicted)" do
      cap = Session.buffer_cap()
      flood = cap + 25

      {s, _} = Session.buffer_event(new_session(), "E1", %{})
      s = Enum.reduce(2..flood, s, fn i, acc -> acc |> Session.buffer_event("E#{i}", %{}) |> elem(0) end)

      assert Session.buffered_count(s) == cap
      assert s.seq == flood
      # The retained window is the NEWEST cap seqs: the oldest buffered is
      # flood - cap + 1, and no envelope below the watermark survives.
      assert Session.oldest_buffered_seq(s) == flood - cap + 1
      # A resume from the watermark boundary replays the FULL window...
      assert Session.buffered_after(s, flood - cap) |> length() == cap
      # ...one seq below it is a gap (envelope flood - cap was evicted)...
      refute Session.replay_complete?(s, flood - cap - 1)
      assert Session.replay_complete?(s, flood - cap)
      # ...and nothing is buffered past the high-water mark.
      assert Session.buffered_after(s, flood) == []
    end

    test "oldest_buffered_seq/1 is nil on an empty buffer" do
      assert Session.oldest_buffered_seq(new_session()) == nil
    end

    test "replay_complete?/2: inside the retained window replays exactly" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})
      {s, _} = Session.buffer_event(s, "B", %{})
      {s, _} = Session.buffer_event(s, "C", %{})

      assert Session.replay_complete?(s, 0)
      assert Session.replay_complete?(s, 2)
      # The empty buffer is trivially complete (nothing to replay).
      assert Session.replay_complete?(new_session(), 0)
    end

    test "replay_complete?/2: a seq below the eviction watermark is a gap" do
      {s, _} = Session.buffer_event(new_session(), "A", %{})
      {s, _} = Session.buffer_event(s, "B", %{})
      # Drop seq 1 (what oldest-eviction does at cap).
      s = Session.trim_to_seq(s, 1)

      assert Session.replay_complete?(s, 2)
      assert Session.replay_complete?(s, 1)
      # Client still at seq 0 missed evicted envelope 1 — a replay from 0
      # would skip it: NOT complete.
      refute Session.replay_complete?(s, 0)
    end
  end

  # ---------------------------------------------------------------------------
  # Heartbeat accounting
  # ---------------------------------------------------------------------------

  describe "heartbeat accounting" do
    test "fresh session has no armed deadline" do
      assert {:alive, 0} = Session.status(new_session(), 1_000, 30_000)
    end

    test "heartbeat_received resets the miss streak and arms the deadline" do
      session = new_session()
      {:ok, session} = Session.heartbeat_received(session, 10_000)
      assert {:alive, _} = Session.status(session, 20_000, 30_000)
    end

    test "dead exactly after allowed+1 full silent periods (5 missed = dead)" do
      interval = 30_000
      session = new_session()
      {:ok, session} = Session.heartbeat_received(session, 0)

      allowed = Session.max_missed_heartbeats()

      # just under allowed+1 periods of silence: still alive
      {:alive, missed} = Session.status(session, interval * allowed + 1, interval)
      assert missed == allowed

      # at allowed+1 periods: dead
      assert {:dead, dead_missed} = Session.status(session, interval * (allowed + 1), interval)
      assert dead_missed == allowed
      assert allowed == 5
    end

    test "a recovered link resets to alive" do
      interval = 30_000
      session = new_session()
      {:ok, session} = Session.heartbeat_received(session, 0)
      {:alive, _} = Session.status(session, interval * 3, interval)

      {:ok, session} = Session.heartbeat_received(session, interval * 3 + 1)
      assert {:alive, 0} = Session.status(session, interval * 4, interval)
    end

    test "heartbeat_received rejects non-integer time (defensive)" do
      assert Session.heartbeat_received(new_session(), "soon") == {:error, :not_armed}
    end
  end

  # ---------------------------------------------------------------------------
  # Control frames
  # ---------------------------------------------------------------------------

  describe "control-frame builders" do
    test "hello carries the interval and the compression offer" do
      hello = Session.hello_frame(30_000)
      assert hello.op == Opcode.hello()
      assert hello.d.heartbeat_interval == 30_000

      offer = Session.hello_compression_offer()
      assert "zstd_stream" in offer
      assert "zlib_stream" in offer
      refute "brotli" in offer
    end

    test "invalid_session carries the resumable flag as bare d" do
      assert Session.invalid_session_frame(false) == %{op: 9, d: false}
      assert Session.invalid_session_frame(true) == %{op: 9, d: true}
    end

    test "reconnect / heartbeat-ack frames use the mirrored opcodes" do
      assert Session.reconnect_frame() == %{op: 6}
      assert Session.heartbeat_ack_frame() == %{op: 11}
    end

    # A2: the server-pushed Reconnect is DIALECT-AWARE — Discord's opcode
    # map reserves 6 for the client Resume, so a compat session must see 7
    # (a 6 would be a client-to-server op on its wire). Native keeps the
    # mirrored 6 (the native protocol's own numbering: 5 = Resume).
    test "reconnect_frame/1 is dialect-aware: op 6 native / op 7 compat" do
      assert Session.reconnect_frame(:native) == %{op: 6}
      assert Session.reconnect_frame(:compat) == %{op: 7}
    end

    test "opcode mirror matches the U2 protocol package constants" do
      # packages/protocol/src/opcodes.ts values (U2 is the source of truth).
      assert Opcode.dispatch() == 0
      assert Opcode.heartbeat() == 1
      assert Opcode.identify() == 2
      assert Opcode.presence_update() == 3
      assert Opcode.resume() == 5
      assert Opcode.reconnect() == 6
      assert Opcode.invalid_session() == 9
      assert Opcode.hello() == 10
      assert Opcode.heartbeat_ack() == 11
      assert Opcode.typing_start_client() == 20
      assert Opcode.message_ack() == 21
      assert Opcode.call_state_update() == 22
      assert Opcode.call_signal() == 23
      assert Opcode.focus_update() == 24

      # Voice ops stay unassigned forever; 22/23 are the call command pair
      # (calls plan U1); 24 is the focus report (notifications plan U5);
      # 25+ stay reserved-undefined.
      for code <- [4, 7, 8, 12, 19, 25, 30] do
        refute Opcode.known?(code)
      end

      assert 4 in Opcode.unknown_gatekeep_codes()
      assert 8 in Opcode.unknown_gatekeep_codes()
    end
  end
end
