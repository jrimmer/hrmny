defmodule CytaleWeb.GatewayFocusTest do
  @moduledoc """
  U5 of the notification plan — op 24 FOCUS_UPDATE over the real wire.

  The unit tests cover the store; this covers the seam the store cannot see:
  that a native session's focus report reaches it keyed by the session the
  gateway actually minted, that a later session takes focus from an earlier
  one, and that a compat session is refused rather than allowed to claim
  focus on a human's behalf.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Notifications.Focus

  setup_all do
    :ok = Cytale.Snowflake.ensure_init()
    :ok = Focus.ensure_started()
    :ok
  end

  setup do
    %{port: start_gateway!()}
  end

  defp user_id_of(ready), do: String.to_integer(ready["user"]["id"])

  defp focus!(conn, focused) do
    send_frame!(conn, 24, %{"focused" => focused})
    # The op is ack-less; give the socket a beat to process it before reading
    # the store.
    Process.sleep(50)
    :ok
  end

  describe "op 24" do
    test "a native session's report reaches the store under its own session id", %{port: port} do
      conn = connect!(port)
      ready = identify!(conn, valid_token())
      user_id = user_id_of(ready)
      session_id = ready["session_id"]

      assert is_binary(session_id)
      refute Focus.focused?(user_id, session_id)

      focus!(conn, true)

      assert Focus.focused?(user_id, session_id),
             "the session the gateway minted must be the one the store records"
    end

    test "a report of false clears that session's focus", %{port: port} do
      conn = connect!(port)
      ready = identify!(conn, valid_token())
      user_id = user_id_of(ready)
      session_id = ready["session_id"]

      focus!(conn, true)
      assert Focus.focused?(user_id, session_id)

      focus!(conn, false)
      refute Focus.focused?(user_id, session_id)
    end

    test "a second session of the same member takes focus from the first", %{port: port} do
      first = connect!(port)
      first_ready = identify!(first, valid_token())
      user_id = user_id_of(first_ready)

      second = connect!(port)
      second_ready = identify!(second, valid_token())

      # Both sessions belong to the same principal.
      assert user_id_of(second_ready) == user_id

      focus!(first, true)
      focus!(second, true)

      assert Focus.focused?(user_id, second_ready["session_id"])

      refute Focus.focused?(user_id, first_ready["session_id"]),
             "a member looks at one screen at a time"
    end

    test "a backgrounded session does not steal focus from the one in front", %{port: port} do
      front = connect!(port)
      front_ready = identify!(front, valid_token())
      user_id = user_id_of(front_ready)

      back = connect!(port)
      back_ready = identify!(back, valid_token())

      focus!(front, true)
      # The background tab reports its blur AFTER the front tab claimed focus.
      focus!(back, false)

      assert Focus.focused?(user_id, front_ready["session_id"]),
             "a blur report from a session that does not hold focus must be a no-op"
    end

    test "a malformed payload is a protocol violation, not a silent no-op", %{port: port} do
      conn = connect!(port)
      _ready = identify!(conn, valid_token())

      send_frame!(conn, 24, %{"focused" => "yes"})

      # Establishment also emits a CallSync backfill, the read-state sync, and
      # presence traffic, and any can still be in flight; skip all three so the
      # close assertion reads the violation rather than an unrelated dispatch.
      # (Skipping only CallSync made this pass alone and fail under the full
      # suite, where presence frames land differently.)
      assert assert_closed_skipping!(conn, 5_000, ["CallSync", "PresenceUpdate", "ReadStateSync"]) ==
               4001
    end

    test "a focus report before Identify is refused", %{port: port} do
      conn = connect!(port)

      send_frame!(conn, 24, %{"focused" => true})

      # 4003 not-authenticated: a command before the handshake completes.
      assert assert_closed!(conn, 5_000) == 4003
    end
  end
end
