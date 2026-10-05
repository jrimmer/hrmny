defmodule CytaleWeb.Channels.GatewayTypingTest do
  @moduledoc """
  #80 — a native session's own `TYPING_START` must not be delivered back to
  the typing user's OTHER sessions.

  The op used to fan out with `except: self()`: the ORIGIN SOCKET was skipped,
  which read as "the typist never hears their own signal" while nothing
  rendered typing. `e1414b1` mounted the indicator (#79) and the gap became
  visible: the typist's second device received a `TYPING_START` carrying the
  VIEWER'S OWN user id, and `useTyping` — which applies no self-filter —
  rendered "Jordan is typing…" to Jordan.

  Discord's rule, and the one the compat dialect already applies on its own
  dispatch path (`self_typing?/3`, #77): a typing signal is for everyone
  EXCEPT the user who is typing, "not even your other sessions". The native
  op now says the same thing at the shared fan-out seam
  (`Cytale.Workspaces.FanOut.deliver/3`, `except: {:user, id}`), so the rule
  lives in one place and both wires inherit it.

  Scope is BY USER, not by socket — which is why the pin needs a user with
  TWO live sessions: excluding the origin device alone leaves the bug.
  """

  use Cytale.GatewayCase, async: false

  alias Cytale.Gateway.PushRegistry
  alias Cytale.Workspaces
  alias Cytale.Workspaces.FanOut

  @typing_op 20

  setup_all do
    :ok = Cytale.Snowflake.ensure_init()
    :ok
  end

  setup do
    {:ok, port: start_gateway!()}
  end

  # -- fixtures -------------------------------------------------------------

  # Unique token → unique Stub identity (`Authenticator.Stub`:
  # `phash2(token, 900_000) + 100_000`).
  defp run_token, do: "cytale_t80_" <> Cytale.TestNonce.get() <> String.duplicate("t", 8)

  defp stub_uid(token), do: :erlang.phash2(token, 900_000) + 100_000

  # A workspace the typing identity owns, with `watcher_token`'s identity a
  # plain member (@everyone grants view) — so BOTH principals pass the
  # typing gate and both have channel routes at Identify time.
  defp typing_channel!(typer_id, watcher_id) do
    {:ok, ws} = Workspaces.create_workspace(typer_id, "t80-#{System.unique_integer()}")
    :ok = Workspaces.add_member(ws.workspace_id, watcher_id, typer_id)
    {:ok, channel} = Workspaces.create_channel(ws.workspace_id, "typing")
    channel
  end

  # Consume everything already queued (the membership join announces) so the
  # assertions below start from a quiet wire.
  defp drain!(conn) do
    case Cytale.Test.WSClient.recv(conn.pid, 300) do
      {:text, _} -> drain!(conn)
      {:binary, _} -> drain!(conn)
      _other -> :ok
    end
  end

  # -- the wire pin: one user, two live sessions ----------------------------

  test "typing reaches other users' sessions only: neither the origin device nor the same user's second device",
       %{port: port} do
    typer_token = run_token()
    watcher_token = run_token()
    typer_id = stub_uid(typer_token)

    channel = typing_channel!(typer_id, stub_uid(watcher_token))
    channel_str = Integer.to_string(channel.channel_id)

    # THREE live sockets: the typist's two devices and one other member.
    typer_a = connect!(port)
    typer_b = connect!(port)
    watcher = connect!(port)

    ready_a = identify!(typer_a, typer_token)
    ready_b = identify!(typer_b, typer_token)
    _watcher_ready = identify!(watcher, watcher_token)

    # The premise of the ticket: ONE user, TWO live sessions.
    assert ready_a["user"]["id"] == ready_b["user"]["id"]
    assert ready_a["user"]["id"] == Integer.to_string(typer_id)
    assert ready_a["session_id"] != ready_b["session_id"]

    drain!(typer_a)
    drain!(typer_b)
    drain!(watcher)

    send_frame!(typer_a, @typing_op, %{"channel_id" => channel_str, "thread_id" => nil})

    # 1. A DIFFERENT user's session receives it. Asserted FIRST so the
    #    refutations below are the exclusion, not a fan-out that never ran.
    frame = next_event!(watcher, "TypingStart", 5_000)
    assert frame["d"]["channel_id"] == channel_str
    assert frame["d"]["user_id"] == ready_a["user"]["id"]

    # 2. The origin device hears nothing (the old `except: self()` behaviour,
    #    still true).
    refute_next_event!(typer_a, "TypingStart", 700)

    # 3. …and neither does the typist's OTHER device. This is the ticket:
    #    excluding the origin process alone left this socket receiving its
    #    own user's TypingStart, which the mounted indicator rendered as
    #    "you are typing" back at the typist.
    refute_next_event!(typer_b, "TypingStart", 700)
  end

  test "the mirror holds: typing from the SECOND device excludes the first",
       %{port: port} do
    typer_token = run_token()
    watcher_token = run_token()
    typer_id = stub_uid(typer_token)

    channel = typing_channel!(typer_id, stub_uid(watcher_token))

    typer_a = connect!(port)
    typer_b = connect!(port)
    watcher = connect!(port)

    identify!(typer_a, typer_token)
    identify!(typer_b, typer_token)
    identify!(watcher, watcher_token)

    drain!(typer_a)
    drain!(typer_b)
    drain!(watcher)

    # The OTHER device this time — the exclusion follows the IDENTITY, not
    # the socket that happened to send.
    send_frame!(typer_b, @typing_op, %{
      "channel_id" => Integer.to_string(channel.channel_id),
      "thread_id" => nil
    })

    assert next_event!(watcher, "TypingStart", 5_000)["d"]["user_id"] ==
             Integer.to_string(typer_id)

    refute_next_event!(typer_a, "TypingStart", 700)
    refute_next_event!(typer_b, "TypingStart", 700)
  end

  # -- the shared mechanism the REST origins use too ------------------------
  #
  # The gateway op hands the registry's WIRE (string) id; both REST typing
  # origins hand the claims' INTEGER id (`Payloads.typing_start/3` stringifies
  # only the payload). The exclusion therefore compares id forms, and this
  # pins that — it is the one part of the rule no wire test can reach, since
  # the test gateway authenticates with the Stub while the REST surfaces
  # authenticate real accounts.

  describe "FanOut except: {:user, id}" do
    test "skips every session of that principal, in either id form, and only that principal" do
      channel_id = 900_000_000_000_000 + System.unique_integer([:positive])
      key = PushRegistry.channel_key(Integer.to_string(channel_id))

      typer_id = 700_000_000 + System.unique_integer([:positive])
      other_id = 800_000_000 + System.unique_integer([:positive])

      typer_dev1 = relay()
      typer_dev2 = relay()
      stranger = relay()

      # Registered under the WIRE (string) id, like every socket session.
      :ok = PushRegistry.subscribe(key, Integer.to_string(typer_id), typer_dev1)
      :ok = PushRegistry.subscribe(key, Integer.to_string(typer_id), typer_dev2)
      :ok = PushRegistry.subscribe(key, Integer.to_string(other_id), stranger)

      on_exit(fn ->
        PushRegistry.unsubscribe(key, typer_dev1)
        PushRegistry.unsubscribe(key, typer_dev2)
        PushRegistry.unsubscribe(key, stranger)
      end)

      # The INTEGER form is what `MessageController.typing/2` and
      # `Compat.ChannelsController.typing/2` pass.
      assert FanOut.deliver(
               channel_id,
               {"TypingStart", %{"channel_id" => channel_id}},
               except: {:user, typer_id}
             ) == 1

      # The relayed push carries the fan-out's pre-encoded fragment as a 4th
      # element (hardening plan 2.3); `nil` when a fan-out had nothing to
      # amortise. This asserts the internal message, so it tracks that shape.
      assert_receive {:relayed, ^stranger, {:cytale_gateway_push, _from, {"TypingStart", _payload}, _fragment}},
                     1_000

      refute_receive {:relayed, ^typer_dev1, _}, 100
      refute_receive {:relayed, ^typer_dev2, _}, 100
    end

    test "a pid exclusion still skips exactly the one socket (the pre-#80 contract)" do
      channel_id = 900_000_000_000_000 + System.unique_integer([:positive])
      key = PushRegistry.channel_key(Integer.to_string(channel_id))
      user_id = Integer.to_string(700_000_000 + System.unique_integer([:positive]))

      # Same user, TWO sockets: the pid form skips one socket, never the
      # identity (so the widened option did not change the old contract).
      origin = self()
      sibling = relay()
      :ok = PushRegistry.subscribe(key, user_id, origin)
      :ok = PushRegistry.subscribe(key, user_id, sibling)

      on_exit(fn ->
        PushRegistry.unsubscribe(key, origin)
        PushRegistry.unsubscribe(key, sibling)
      end)

      assert FanOut.deliver(channel_id, {"TypingStart", %{}}, except: origin) == 1

      assert_receive {:relayed, ^sibling, {:cytale_gateway_push, _from, {"TypingStart", _}, _fragment}},
                     1_000

      refute_receive {:cytale_gateway_push, _from, _event}, 100
      refute_receive {:cytale_gateway_push, _from, _event, _fragment}, 100
    end
  end

  # A subscriber that forwards everything to the test process, so
  # `assert_receive`/`refute_receive` can attest what the fan-out did.
  defp relay do
    parent = self()

    spawn_link(fn ->
      receive_loop = fn receive_loop ->
        receive do
          msg ->
            send(parent, {:relayed, self(), msg})
            receive_loop.(receive_loop)
        end
      end

      receive_loop.(receive_loop)
    end)
  end
end
